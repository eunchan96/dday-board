// 앱 시작, 화면 구성, 이벤트 연결

import {
  state, subscribe, setPref, pull, saveTask, toggleDone, toggleStar, removeTask, undoRemove,
  createBoard, connect, disconnect, loadLms, lmsSync, setFeed, setToken, importBackup, exportBackup, canvasImport,
} from './store.js';
import { parseCanvasData, summarize, bookmarkletSource, listenForCanvasData } from './canvas.js';
import { initPickers, setField, refreshPickLabels, setTimePresets, closePicker, pickerOpen, timeLabel } from './picker.js';
import { pushSupport, pushStatus, enablePush, disablePush, setLeads, testPush, LEAD_OPTIONS, DEFAULT_LEADS } from './push.js';
import { errText, api, CALENDAR_FEED_URL } from './api.js';
import {
  $, $$, h, fmtDate, fmtDuration, fmtClock, subjectColor, setSubjects, startOfDay, addDays,
  startOfWeek, toDateInput, toTimeInput, DAY, isExam, groupOf, timeRange, dday,
  semesterOf, semesterKey, semesterLabel, parseSemesterKey, semesterRange, taskSemesterKey, fmtSize,
} from './util.js';
import { renderList, renderCalendar, taskRow } from './views.js';

const SYNC_INTERVAL = 30000;

// null/false를 걸러서 붙이기 (DOM의 append는 null을 "null" 글자로 넣는다)
const clean = kids => kids.flat().filter(k => k != null && k !== false);
const add = (el, ...kids) => el.append(...clean(kids));
const fill = (el, ...kids) => el.replaceChildren(...clean(kids));

/* ───── 화면 상태 (기기에만) ───── */
const ui = {
  query: '',
  showDone: false,
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDay: startOfDay(new Date()),
  editingId: null,
  kind: 'assignment',
};

const isEmbedded = (() => { try { return window.self !== window.top; } catch { return true; } })();
if (isEmbedded) document.body.classList.add('embed');

/* ───── 테마 ───── */
function applyTheme() {
  const t = state.prefs.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  $$('#themePicker button').forEach(b => b.setAttribute('aria-checked', b.dataset.theme === t ? 'true' : 'false'));
}

/* ───── 학기 ───── */
const currentSemesterKey = () => semesterKey(semesterOf(new Date()));
function activeSemesterKey() {
  const p = state.prefs.semester;
  if (p === 'all') return null;
  return parseSemesterKey(p) ? p : currentSemesterKey();
}
// 학기만 적용한 과제 (통계, 과목 수, 다음 마감에 사용)
function scopedTasks() {
  const key = activeSemesterKey();
  return key ? state.tasks.filter(t => taskSemesterKey(t) === key) : state.tasks;
}

function renderSemester() {
  const sel = $('#semester');
  const cur = currentSemesterKey();
  const keys = new Set(state.tasks.map(taskSemesterKey));
  keys.add(cur);
  const sorted = [...keys].sort().reverse();
  const value = state.prefs.semester === 'all' ? 'all'
    : (parseSemesterKey(state.prefs.semester) && state.prefs.semester !== cur ? state.prefs.semester : 'current');
  sel.replaceChildren(
    ...sorted.map(k => h('option', { value: k === cur ? 'current' : k },
      k === cur ? `${semesterLabel(parseSemesterKey(k))} · 지금` : semesterLabel(parseSemesterKey(k)))),
    h('option', { value: 'all' }, '전체 학기'),
  );
  sel.value = value;
}

/* ───── 필터 적용 ───── */
function visibleTasks() {
  const q = ui.query.trim().toLowerCase();
  const { subject, hideDone, starredOnly, kind } = state.prefs;
  return scopedTasks().filter(t => {
    if (hideDone && t.done) return false;
    if (kind === 'exam' && !isExam(t)) return false;
    if (kind === 'assignment' && isExam(t)) return false;
    if (starredOnly && !t.starred) return false;
    if (subject != null && (t.subject || '') !== subject) return false;
    if (q && !`${t.title} ${t.subject || ''} ${t.memo || ''} ${t.location || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/* ───── 다음 마감 한 줄 ───── */
function renderNext() {
  const now = new Date();
  const byDue = (a, b) => new Date(a.due) - new Date(b.due);
  const scoped = scopedTasks();
  const assignments = scoped.filter(t => !isExam(t));
  const pending = assignments.filter(t => !t.done);
  const upcoming = pending.filter(t => new Date(t.due) >= now).sort(byDue);
  const over = pending.length - upcoming.length;
  const nextExam = scoped.filter(t => isExam(t) && !t.done && groupOf(t, now) !== 'done').sort(byDue)[0];

  const line = h('p', { class: 'next-line' });
  const next = upcoming[0];
  if (next) {
    add(line,
      '다음 마감은 ',
      h('button', { type: 'button', onclick: () => openPanel(next) }, next.title),
      `, ${fmtDuration(new Date(next.due) - now)} 남았어요.`,
    );
  } else if (assignments.length) {
    add(line, over ? '마감이 지난 과제만 남아 있어요.' : '남은 과제가 없어요.');
  } else if (state.tasks.length && !scoped.length) {
    add(line, `${state.prefs.semester === 'all' ? '' : semesterLabel(parseSemesterKey(activeSemesterKey())) + '에는 '}일정이 없어요.`);
  } else {
    add(line, '과제를 추가하면 가장 가까운 마감을 여기에 알려 드려요.');
  }

  const parts = [line];
  // 일주일 안의 시험만 한 줄로
  if (nextExam && new Date(nextExam.due) - now < 7 * 864e5) {
    const d = new Date(nextExam.due);
    parts.push(h('p', { class: 'next-exam' },
      h('span', { class: 'kind-tag' }, '시험'),
      h('button', { type: 'button', onclick: () => openPanel(nextExam) },
        [nextExam.subject, nextExam.title].filter(Boolean).join(' ')),
      ` ${fmtDate(d, false)} ${timeRange(nextExam)}`,
      ` · ${dday(nextExam, now).label}`));
  }
  // 토큰이 만료되면 자동 가져오기가 멈추므로 눈에 띄게
  if (state.lms.error === 'token_invalid') {
    parts.push(h('p', { class: 'next-alert' }, '스마트캠퍼스 토큰이 만료돼서 과제를 못 가져오고 있어요. ',
      h('button', { type: 'button', onclick: () => openSettings() }, '새 토큰 넣기')));
  }
  fill($('#next'), parts);
}

/* ───── 왼쪽 필터 ───── */
function subjectsWithCounts() {
  const map = new Map();
  for (const t of scopedTasks()) {
    const k = t.subject || '';
    const v = map.get(k) || { total: 0, pending: 0 };
    v.total++; if (!t.done) v.pending++;
    map.set(k, v);
  }
  return [...map.entries()].sort((a, b) => (b[1].pending - a[1].pending) || a[0].localeCompare(b[0], 'ko'));
}

function renderRail() {
  const rail = $('#rail');
  const cur = state.prefs.subject;
  const subjects = subjectsWithCounts();
  const pendingAll = scopedTasks().filter(t => !t.done).length;

  const item = (label, value, count, color) => h('li', null,
    h('button', {
      type: 'button', 'aria-pressed': cur === value ? 'true' : 'false',
      onclick: () => setPref('subject', cur === value && value !== null ? null : value),
    },
    h('i', { class: 'tab', style: { background: color || 'transparent' } }),
    h('span', { class: 'name' }, label),
    h('span', { class: 'count' }, count)));

  const list = h('ul', { class: 'subject-list' },
    item('전체', null, pendingAll, 'var(--ink)'),
    subjects.map(([name, c]) => item(name || '과목 없음', name, c.pending, subjectColor(name))));

  const toggle = (key, label) => h('label', { class: 'check-row' },
    h('input', { type: 'checkbox', checked: !!state.prefs[key], onchange: e => setPref(key, e.target.checked) }),
    h('span', null, label));

  const chip = (label, pressed, onclick, color) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': pressed ? 'true' : 'false', onclick,
  }, color ? h('i', { class: 'tab', style: { background: color } }) : null, label);

  const chips = h('div', { class: 'chips', role: 'toolbar', 'aria-label': '필터' },
    chip('전체', cur === null, () => setPref('subject', null)),
    subjects.map(([name]) => chip(name || '과목 없음', cur === name,
      () => setPref('subject', cur === name ? null : name), subjectColor(name))),
    chip('시험만', state.prefs.kind === 'exam', () => setPref('kind', state.prefs.kind === 'exam' ? null : 'exam')),
    chip('중요만', state.prefs.starredOnly, () => setPref('starredOnly', !state.prefs.starredOnly)),
    chip('완료 숨기기', state.prefs.hideDone, () => setPref('hideDone', !state.prefs.hideDone)),
  );

  rail.replaceChildren(
    chips,
    h('div', null, list),
    h('div', { class: 'toggles' },
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: state.prefs.kind === 'exam', onchange: e => setPref('kind', e.target.checked ? 'exam' : null) }),
        h('span', null, '시험만')),
      toggle('starredOnly', '중요한 것만'),
      toggle('hideDone', '완료 숨기기')),
  );

  $('#subjectList').replaceChildren(...subjects.filter(([n]) => n).map(([n]) => h('option', { value: n })));
}

/* ───── 본문 ───── */
const ctx = () => ({
  now: new Date(),
  total: scopedTasks().length,
  showDone: ui.showDone,
  calMonth: ui.calMonth,
  selectedDay: ui.selectedDay,
  onToggle: id => {
    const t = state.tasks.find(x => x.id === id);
    toggleDone(id);
    if (t && t.done) toast(`"${t.title}" ${isExam(t) ? '응시 완료로 표시했어요' : '완료했어요'}`, '되돌리기', () => toggleDone(id));
  },
  onStar: id => toggleStar(id),
  onOpen: t => openPanel(t),
  onNew: (d, kind) => openPanel(null, d, kind || 'assignment'),
  onToggleDoneGroup: () => { ui.showDone = !ui.showDone; renderView(); },
  onMonth: dir => {
    if (dir === 0) { const n = new Date(); ui.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); ui.selectedDay = startOfDay(n); }
    else ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() + dir, 1);
    renderView();
  },
  onSelectDay: d => {
    ui.selectedDay = d;
    if (d.getMonth() !== ui.calMonth.getMonth()) ui.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderView();
  },
  onShowSubject: name => { setPref('subject', name); setView('list'); },
});

function renderView() {
  const view = state.prefs.view;
  $$('.views button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === view ? 'true' : 'false'));
  const root = $('#view');
  const tasks = visibleTasks();
  if (isCompact) renderCompact(root, tasks);
  else if (view === 'calendar') renderCalendar(root, tasks, ctx());
  else renderList(root, tasks, ctx());
}

/* ───── 노션 임베드용 간단 모드 (?compact) ───── */
// 다가오는 일정 몇 개만 크게. 나머지는 "전체 보기"로 새 창에서.
const isCompact = new URLSearchParams(location.search).has('compact');
if (isCompact) document.body.classList.add('compact');
const COMPACT_LIMIT = 6;
function renderCompact(root, tasks) {
  const now = new Date();
  const open = tasks.filter(t => groupOf(t, now) !== 'done').sort((a, b) => new Date(a.due) - new Date(b.due));
  const full = `${location.origin}${location.pathname}#list`;
  fill(root,
    open.length
      ? h('ul', { class: 'rows compact-rows' }, open.slice(0, COMPACT_LIMIT).map(t => taskRow(t, ctx())))
      : h('p', { class: 'compact-empty' }, '남은 일정이 없어요.'),
    h('p', { class: 'compact-more' },
      open.length > COMPACT_LIMIT ? `외 ${open.length - COMPACT_LIMIT}개 · ` : '',
      h('a', { href: full, target: '_blank', rel: 'noopener' }, '전체 보기')));
}

function setView(v) {
  if (!['list', 'calendar'].includes(v)) v = 'list';
  setPref('view', v);
  if (location.hash !== `#${v}`) history.replaceState(null, '', `#${v}`);
}

/* ───── 상태 표시 ───── */
let notice = null, noticeTimer = null;
function renderStatus() {
  const el = $('#status');
  el.className = 'status';
  if (state.inflight > 0) { el.classList.add('busy'); el.textContent = '저장하고 불러오는 중…'; }
  else if (state.syncError) { el.classList.add('err'); el.textContent = `${state.syncError} · 눌러서 다시 시도`; }
  else if (notice) { el.classList.add('ok'); el.textContent = notice; }
  else if (state.lastSync) { el.classList.add('ok'); el.textContent = `저장됨 · ${fmtClock(state.lastSync)}`; }
  else el.textContent = '불러오는 중…';
}

let tokenEditing = false;
function renderLms() {
  const l = state.lms;
  const feed = l.feed ?? (l.connected && !l.token), token = !!l.token;
  $('#btnLmsNow').hidden = !l.connected;
  $('#btnFeedClear').hidden = !feed;
  $('#btnFeedSave').textContent = feed ? '바꾸기' : '연동';
  $('#btnTokenClear').hidden = !token;
  $('#btnTokenChange').hidden = !token || tokenEditing;
  $('#tokenForm').hidden = token && !tokenEditing;
  $('#tokenHelp').hidden = token && !tokenEditing;
  $('#btnTokenSave').textContent = token ? '바꾸기' : '연결';
  $('#tokenSub').textContent = token ? `…${l.tokenHint} 연결됨` : '과제와 제출 파일을 하루 3번 가져와요';
  $('#bookmarkletSection').hidden = token;          // 토큰이 있으면 북마클릿은 필요 없음
  const st = $('#lmsState');
  st.className = 'set-sub';
  if (!l.connected) st.textContent = '연결 안 됨';
  else if (l.error) { st.classList.add('err'); st.textContent = errText(new Error(l.error)); }
  else {
    st.classList.add('ok');
    const how = token ? '토큰' : '캘린더 피드';
    st.textContent = l.syncedAt ? `${how} · ${fmtAgo(new Date(l.syncedAt))} 가져옴` : `${how} · 아직 가져오기 전`;
  }
}

function fmtAgo(d) {
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간 전`;
  return fmtDate(d, false);
}

/* ───── 스마트캠퍼스 공지 ───── */
const notices = { list: [] };
async function loadNotices() {
  if (!state.code || !state.lms.token) { notices.list = []; renderNoticeBtn(); return; }
  try { notices.list = (await api.notices(state.code)) || []; } catch { /* 다음에 다시 */ }
  renderNoticeBtn();
}
function renderNoticeBtn() {
  const unread = notices.list.filter(n => !n.read).length;
  $('#btnNotices').hidden = !state.lms.token && !notices.list.length;
  $('#noticeDot').hidden = !unread;
  $('#btnNotices').title = unread ? `새 공지 ${unread}개` : '스마트캠퍼스 공지';
}
function openNotices() {
  const list = $('#noticeList');
  fill(list, notices.list.length ? notices.list.map(n => h('li', { class: n.read ? 'notice' : 'notice unread' },
    h('div', { class: 'notice-meta' }, n.subject ? h('span', null, n.subject) : null, h('span', null, fmtAgo(new Date(n.postedAt)))),
    n.url ? h('a', { class: 'notice-title', href: n.url, target: '_blank', rel: 'noopener noreferrer' }, n.title) : h('b', { class: 'notice-title' }, n.title),
    n.preview ? h('p', { class: 'notice-preview' }, n.preview) : null,
  )) : h('li', { class: 'notice-empty' }, '최근 30일 공지가 없어요.'));
  $('#noticesDialog').showModal();
  if (notices.list.some(n => !n.read)) {
    api.noticesRead(state.code).catch(() => {});
    notices.list = notices.list.map(n => ({ ...n, read: true }));
    renderNoticeBtn();
  }
}

/* ───── 내 캘린더로 보내기 ───── */
let calExists = false, calArmed = false;
async function loadCalendar() {
  $('#calBox').hidden = true; $('#calMsg').textContent = ''; calArmed = false;
  try { calExists = !!(await api.calendarStatus(state.code)); } catch { calExists = false; }
  $('#calSub').textContent = calExists ? '만든 주소가 있어요. 주소를 잃어버렸다면 새로 만드세요' : '구글 · 아이폰 캘린더에 과제와 시험이 함께 떠요';
  $('#btnCalKey').textContent = calExists ? '새로 만들기' : '주소 만들기';
}
async function makeCalendarKey() {
  const btn = $('#btnCalKey'), msg = $('#calMsg');
  if (calExists && !calArmed) {
    calArmed = true; btn.textContent = '한 번 더 누르면 이전 주소는 막혀요'; return;
  }
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '';
  try {
    const key = await api.calendarKey(state.code);
    const url = `${CALENDAR_FEED_URL}?k=${key}`;
    const webcal = url.replace(/^https:/, 'webcal:');
    $('#calUrl').value = url;
    $('#calGoogle').href = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
    $('#calApple').href = webcal;
    $('#calBox').hidden = false;
    calExists = true; calArmed = false;
    btn.textContent = '새로 만들기';
    $('#calSub').textContent = '구독하면 몇 시간마다 저절로 새로 고쳐져요';
  } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  finally { btn.disabled = false; }
}

/* ───── 마감 알림 ───── */
const push = { subscribed: false, leads: DEFAULT_LEADS.slice(), busy: false };

function renderPush() {
  const support = pushSupport();
  const st = $('#pushState');
  const on = support === 'ok' && push.subscribed;
  st.className = 'set-sub';
  $('#pushOpen').hidden = support !== 'embedded';
  $('#btnPushOn').hidden = support !== 'ok' || on;
  $('#btnPushOff').hidden = !on;
  $('#btnPushTest').hidden = !on;
  $('#btnPushOn').disabled = $('#btnPushOff').disabled = $('#btnPushTest').disabled = push.busy;
  if (support === 'embedded') st.textContent = '노션 안에서는 켤 수 없어요';
  else if (support === 'ios-install') st.textContent = '아이폰은 홈 화면에 추가한 앱에서 켤 수 있어요';
  else if (support === 'unsupported') st.textContent = '이 브라우저는 알림을 지원하지 않아요';
  else if (support === 'denied') { st.classList.add('err'); st.textContent = '브라우저에서 이 사이트 알림이 차단돼 있어요'; }
  else if (on) { st.classList.add('ok'); st.textContent = `켜짐 · ${leadText(push.leads)}`; }
  else st.textContent = '꺼짐';
  $('#pushLeadsRow').hidden = support !== 'ok';
  $('#pushTestRow').hidden = !on && !$('#pushMsg').textContent;
  fill($('#pushLeads'),
    ...LEAD_OPTIONS.map(([min, label]) => h('button', {
      type: 'button', 'aria-pressed': push.leads.includes(min) ? 'true' : 'false',
      disabled: push.busy, onclick: () => toggleLead(min),
    }, label)));
}

function leadText(leads) {
  const names = LEAD_OPTIONS.filter(([m]) => leads.includes(m)).map(([, l]) => l.replace(' 전', ''));
  return names.length ? `${names.join(', ')} 전` : '알림 시점을 골라 주세요';
}

async function pushTask(label, fn, okText) {
  const msg = $('#pushMsg');
  push.busy = true; msg.className = 'msg'; msg.textContent = label; renderPush();
  try { await fn(); msg.className = 'msg ok'; msg.textContent = okText || ''; }
  catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  finally { push.busy = false; renderPush(); }
}

async function loadPush() {
  if (!state.code || pushSupport() !== 'ok') { renderPush(); return; }
  try {
    const st = await pushStatus(state.code);
    push.subscribed = !!st.subscribed;
    if (st.subscribed && Array.isArray(st.leads)) push.leads = st.leads;
  } catch { /* 다음에 다시 */ }
  renderPush();
}

function toggleLead(min) {
  const next = push.leads.includes(min) ? push.leads.filter(m => m !== min) : [...push.leads, min];
  if (!next.length) { const m = $('#pushMsg'); m.className = 'msg err'; m.textContent = '알림 시점을 하나 이상 골라 주세요'; return; }
  push.leads = next.sort((a, b) => b - a);
  if (!push.subscribed) { renderPush(); return; }
  pushTask('저장하는 중…', async () => {
    const r = await setLeads(state.code, push.leads);
    if (r && Array.isArray(r.leads)) push.leads = r.leads;
  }, '알림 시점을 바꿨어요');
}

/* ───── 토스트 ───── */
let toastTimer = null;
function toast(text, action, onAction, ms = 5000) {
  const el = $('#toast');
  el.replaceChildren(h('span', null, text));
  if (action) el.append(h('button', { type: 'button', onclick: () => { onAction(); hideToast(); } }, action));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('#toast').hidden = true; }

/* ───── 과제 상세 패널 ───── */
let lastFocus = null;

const EXAM_NAMES = ['중간고사', '기말고사', '퀴즈', '실기시험'];

// 시험: 시작 시각을 바꾸면 끝나는 시각을 같은 길이만큼 따라 옮긴다 (직접 고친 뒤에는 그대로)
const addMinutes = (hhmm, min) => {
  const [h0, m0] = hhmm.split(':').map(Number);
  const t = Math.min(23 * 60 + 59, h0 * 60 + m0 + min);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const minutesBetween = (a, b) => {
  const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number);
  return bh * 60 + bm - (ah * 60 + am);
};
function autoEnd(min) {
  ui.settingEnd = true;
  setField('fEnd', addMinutes($('#fTime').value || '10:30', min));
  ui.settingEnd = false;
  ui.endAuto = true;
  ui.examLength = min;
}
function renderDurations() {
  const start = $('#fTime').value || '10:30';
  const cur = $('#fEnd').value ? minutesBetween(start, $('#fEnd').value) : null;
  const opts = [[50, '50분'], [60, '1시간'], [75, '1시간 15분'], [90, '1시간 30분'], [120, '2시간']];
  $('#durations').replaceChildren(
    ...opts.map(([min, label]) => h('button', {
      type: 'button', 'aria-pressed': cur === min ? 'true' : 'false',
      onclick: () => { autoEnd(min); renderDurations(); },
    }, label)));
}

// 과제 / 시험 템플릿 전환
function setKind(kind, { isNew }) {
  ui.kind = kind;
  const exam = kind === 'exam';
  $('#panel').classList.toggle('is-exam', exam);
  $$('#kindPicker button').forEach(b => b.setAttribute('aria-checked', b.dataset.kind === kind ? 'true' : 'false'));
  $('#panelTitle').textContent = isNew ? (exam ? '새 시험' : '새 과제') : (exam ? '시험 수정' : '과제 수정');
  $('#fTitle').placeholder = exam ? '시험 이름' : '과제 이름';
  $('#fMemo').placeholder = exam ? '시험 범위, 준비물' : '메모';
  renderDoneBtn();
  // 새로 만들 때 시각 기본값만 템플릿에 맞춤 (사용자가 바꾼 값은 유지)
  setTimePresets('fTime', exam ? ['09:00', '10:30', '12:00', '13:30', '15:00', '16:30'] : ['09:00', '12:00', '18:00', '23:59']);
  if (isNew) {
    const t = $('#fTime').value;
    if (exam && (t === '23:59' || !t)) setField('fTime', '10:30');
    if (!exam && t === '10:30') setField('fTime', '23:59');
  }
  if (exam && !$('#fEnd').value) autoEnd(60);
  renderDurations();
}

function openPanel(task, presetDay, kind) {
  lastFocus = document.activeElement;
  ui.editingId = task ? task.id : null;
  $('#panelSave').textContent = task ? '저장' : '추가';
  $('#panelDelete').hidden = !task;
  $('#panelMsg').textContent = '';
  $('#fTitle').value = task ? task.title : '';
  $('#fSubject').value = task ? task.subject || '' : (state.prefs.subject || '');
  const due = task ? new Date(task.due) : (presetDay ? new Date(presetDay) : addDays(startOfDay(new Date()), 7));
  $('#fDate').value = toDateInput(due);
  $('#fTime').value = task ? toTimeInput(due) : '23:59';
  ui.endAuto = !(task && task.endAt);
  $('#fStar').checked = !!(task && task.starred);
  $('#fDone').checked = !!(task && task.done);
  $('#fRepeat').value = '0';
  $('#repeatRow').hidden = !!task;
  renderStarBtn();
  $('#fMemo').value = task ? task.memo || '' : '';
  $('#fLocation').value = task ? task.location || '' : '';
  $('#fEnd').value = task && task.endAt ? toTimeInput(new Date(task.endAt)) : '';
  refreshPickLabels();
  setKind(task ? (isExam(task) ? 'exam' : 'assignment') : (kind || 'assignment'), { isNew: !task });
  $('#kindPicker').hidden = !!(task && task.source === 'canvas');   // 스마트캠퍼스 과제는 종류 고정
  $('#examNames').replaceChildren(...EXAM_NAMES.map(n => h('button', {
    type: 'button', onclick: () => { $('#fTitle').value = n; $('#fTitle').focus(); },
  }, n)));

  const note = $('#panelNote');
  if (task && task.source === 'canvas') {
    note.hidden = false;
    fill(note, '스마트캠퍼스 과제',
      task.link ? h('a', { href: task.link, target: '_blank', rel: 'noopener noreferrer' }, '열기') : null);
  } else note.hidden = true;

  // 스마트캠퍼스에 제출한 기록
  const sub = $('#panelSubmission');
  if (task && (task.submittedAt || task.submission)) {
    const files = task.submission?.files || [];
    sub.hidden = false;
    fill(sub, 
      h('p', { class: 'sub-head' }, task.submittedAt ? `${fmtDate(new Date(task.submittedAt))} 제출` : '제출함'),
      files.length ? h('ul', null, files.map(f => h('li', null,
        h('span', { class: 'fname' }, f.name), f.size != null ? h('span', { class: 'fsize' }, fmtSize(f.size)) : null))) : null,
      task.submission?.url ? h('p', null, '제출한 링크: ', h('a', { href: task.submission.url, target: '_blank', rel: 'noopener noreferrer' }, task.submission.url)) : null,
      !files.length && task.submission?.type === 'online_text_entry' ? h('p', { class: 'muted' }, '글로 직접 입력해 제출했어요') : null,
    );
  } else sub.hidden = true;

  const meta = [];
  if (task && task.createdAt) meta.push(`만든 날 ${fmtDate(new Date(task.createdAt), false)}`);
  if (task && task.done && task.doneAt) meta.push(`완료한 날 ${fmtDate(new Date(task.doneAt), false)}`);
  $('#panelMeta').textContent = meta.join(' · ');

  $('#scrim').hidden = false;
  $('#panel').hidden = false;
  if (task) $('#panel').focus(); else $('#fTitle').focus();
}

function closePanel() {
  closePicker(false);
  $('#panel').hidden = true;
  $('#scrim').hidden = true;
  ui.editingId = null;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function renderStarBtn() {
  const on = $('#fStar').checked;
  $('#fStarBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#fStarBtn').title = on ? '중요 표시 해제' : '중요 표시';
}

// 과제만: 제출 완료 / 완료 취소 (시험은 시간이 지나면 저절로 끝난 일정으로)
function renderDoneBtn() {
  const btn = $('#fDoneBtn');
  const show = !!ui.editingId && ui.kind !== 'exam';
  btn.hidden = !show;
  if (!show) return;
  const done = $('#fDone').checked;
  btn.classList.toggle('is-done', done);
  const t = state.tasks.find(x => x.id === ui.editingId);
  btn.textContent = done ? '완료 취소' : (t && t.missing ? '완료로 표시' : '제출 완료');
}

function savePanel() {
  const title = $('#fTitle').value.trim();
  const msg = $('#panelMsg');
  msg.className = 'msg err';
  if (!title) { msg.textContent = '과제명을 적어 주세요'; $('#fTitle').focus(); return; }
  if (!$('#fDate').value) { msg.textContent = '날짜를 골라 주세요'; $('#fDateBtn').focus(); return; }
  const due = new Date(`${$('#fDate').value}T${$('#fTime').value || '23:59'}`);
  if (isNaN(due)) { msg.textContent = '마감 날짜를 다시 확인해 주세요'; return; }
  const isNew = !ui.editingId;
  const exam = ui.kind === 'exam';
  let endAt = null;
  if (exam && $('#fEnd').value) {
    const end = new Date(`${$('#fDate').value}T${$('#fEnd').value}`);
    if (end <= due) { msg.textContent = '끝나는 시각이 시작보다 빨라요'; $('#fEndBtn').focus(); return; }
    endAt = end.toISOString();
  }
  const fields = {
    kind: exam ? 'exam' : 'assignment',
    title: title.slice(0, 200),
    subject: $('#fSubject').value.trim().slice(0, 40),
    due: due.toISOString(),
    endAt,
    location: exam ? $('#fLocation').value.trim().slice(0, 100) : '',
    starred: $('#fStar').checked,
    memo: $('#fMemo').value.slice(0, 2000),
  };
  if (!isNew) {
    const prev = state.tasks.find(t => t.id === ui.editingId);
    fields.done = $('#fDone').checked;
    if (prev && fields.done !== !!prev.done) fields.doneAt = fields.done ? new Date().toISOString() : null;
  }
  saveTask(fields, ui.editingId);
  // 매주 반복: 같은 요일 · 같은 시각으로 이어서 만든다
  let repeats = 0;
  if (isNew) {
    const r = $('#fRepeat').value;
    const until = r === 'end' ? semesterRange(semesterOf(due)).end : null;
    const count = r === 'end' ? 30 : Number(r) || 0;
    for (let i = 1; i < count; i++) {
      const d = new Date(due.getTime() + 7 * i * DAY);   // 시각 그대로 7일씩 (한국은 서머타임 없음)
      if (until && d > until) break;
      saveTask({ ...fields, due: d.toISOString(), endAt: endAt ? new Date(new Date(endAt).getTime() + 7 * i * DAY).toISOString() : null });
      repeats++;
    }
  }
  closePanel();
  if (isNew) toast(repeats ? `"${title}" ${exam ? '시험을' : '과제를'} 매주 ${repeats + 1}번 추가했어요` : `"${title}" ${exam ? '시험을' : '과제를'} 추가했어요`);
}

function deleteFromPanel() {
  const id = ui.editingId;
  const t = removeTask(id);
  closePanel();
  if (t) toast(`"${t.title}" ${isExam(t) ? '시험을' : '과제를'} 삭제했어요`, '되돌리기', () => undoRemove(id));
}

/* ───── 설정 ───── */
let codeShown = false;
const mask = c => `${c.slice(0, 5)}-•••••-•••••-${c.slice(-5)}`;

function openSettings() {
  codeShown = false;
  $('#codeText').value = mask(state.code);
  $('#btnShowCode').textContent = '보기';
  ['#feedMsg', '#tokenMsg', '#lmsMsg', '#importMsg', '#copyMsg'].forEach(s => { $(s).textContent = ''; });
  $('#pushMsg').textContent = ''; tokenEditing = false;
  renderLms(); renderPush(); applyTheme(); prepareCanvasSettings();
  $('#settings').showModal();
  loadLms(); loadPush(); loadCalendar();
}

async function copyText(text, input, msgEl) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* 노션 안에서는 막힐 수 있음 */ }
  if (!ok) {
    input.value = text; input.focus(); input.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  msgEl.className = ok ? 'msg ok' : 'msg';
  msgEl.textContent = ok ? '복사했어요' : '선택해 뒀어요. Ctrl+C(⌘+C)로 복사하세요';
}

function armTwice(btn, label, confirmLabel, action) {
  let armed = null;
  btn.addEventListener('click', () => {
    if (armed) { clearTimeout(armed); armed = null; btn.textContent = label; action(); return; }
    btn.textContent = confirmLabel;
    armed = setTimeout(() => { armed = null; btn.textContent = label; }, 3000);
  });
}

async function runLmsSync(button, { quiet = false } = {}) {
  if (button) { button.disabled = true; button.classList.add('spinning'); }
  try {
    const r = await lmsSync();
    const parts = [];
    if (r.added) parts.push(`새 과제 ${r.added}개`);
    if (r.updated) parts.push(`바뀐 과제 ${r.updated}개`);
    if (parts.length) toast(`스마트캠퍼스에서 ${parts.join(', ')}를 가져왔어요`);
    else if (!quiet) toast('스마트캠퍼스에 새로운 과제가 없어요');
    else toast('최신 상태예요');
  } catch (e) {
    toast(errText(e));
  } finally {
    if (button) { button.disabled = false; button.classList.remove('spinning'); }
  }
}

/* ───── 스마트캠퍼스 전체 가져오기 ───── */
let pendingImport = null;   // 보드 연결 전에 받은 데이터

function prepareCanvasSettings() {
  $('#bookmarklet').href = bookmarkletSource(location.href.split('#')[0]);
  const r = semesterRange(semesterOf(new Date()));
  const d = x => toDateInput(x);
  $('#plannerUrl').textContent =
    `https://canvas.ssu.ac.kr/api/v1/planner/items?start_date=${d(r.start)}&end_date=${d(r.end)}&per_page=100`;
}

function showImport(items) {
  if (!state.code) {
    pendingImport = items;
    const m = $('#connectMsg'); m.className = 'msg';
    m.textContent = `스마트캠퍼스 과제 ${items.length}개를 받았어요. 보드를 열면 바로 가져올게요.`;
    return;
  }
  pendingImport = items;
  const s = summarize(items, new Set(state.tasks.map(t => t.id)));
  const parts = [`과제 ${s.total}개를 찾았어요`];
  parts.push(s.fresh ? `새로 추가될 과제 ${s.fresh}개` : '모두 이미 있는 과제예요');
  if (s.submitted) parts.push(`제출한 과제 ${s.submitted}개는 완료로 표시해요`);
  if (s.files) parts.push(`제출 파일 ${s.files}개의 이름도 함께 저장해요`);
  $('#importSummary').textContent = parts.join('. ') + '.';
  const now = new Date();
  $('#importPreview').replaceChildren(...items.slice().sort((a, b) => new Date(b.due) - new Date(a.due)).slice(0, 12).map(it =>
    h('li', null,
      h('span', { class: 'ip-title' }, it.title),
      h('span', { class: 'ip-meta' },
        [it.subject, fmtDate(new Date(it.due), false),
         'submitted' in it ? (it.submitted ? '제출함' : (new Date(it.due) < now ? '안 냄' : '아직 안 냄')) : null,
         it.submission?.files?.length ? it.submission.files.map(f => f.name).join(', ') : null,
        ].filter(Boolean).join(' · ')))));
  if (items.length > 12) $('#importPreview').append(h('li', { class: 'ip-more' }, `외 ${items.length - 12}개`));
  $('#importDialogMsg').textContent = '';
  if (!$('#importDialog').open) $('#importDialog').showModal();
}

async function confirmImport() {
  const btn = $('#importConfirm'), msg = $('#importDialogMsg');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '가져오는 중…';
  try {
    const r = await canvasImport(pendingImport);
    pendingImport = null;
    $('#importDialog').close();
    const parts = [];
    if (r.added) parts.push(`새 과제 ${r.added}개`);
    if (r.updated) parts.push(`업데이트 ${r.updated}개`);
    toast(parts.length ? `스마트캠퍼스에서 ${parts.join(', ')}를 반영했어요` : '이미 모두 반영되어 있어요');
    if (location.hash === '#import') history.replaceState(null, '', `#${state.prefs.view}`);
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = errText(e);
  } finally { btn.disabled = false; }
}

function handleCanvasPayload(data) {
  try {
    const items = parseCanvasData(data);
    if (!items.length) { toast('가져올 과제가 없어요. 수강 중인 과목이 있는지 확인해 주세요'); return; }
    showImport(items);
  } catch (e) {
    toast(errText(e));
  }
}

/* ───── 전체 그리기 ───── */
function showScreens() {
  $('#viewConnect').hidden = !!state.code;
  $('#viewApp').hidden = !state.code;
}

function renderAll() {
  showScreens();
  if (!state.code) return;
  setSubjects(state.tasks.map(t => t.subject));
  renderSemester(); renderNext(); renderRail(); renderView(); renderStatus(); renderLms();
}

subscribe(what => {
  if (what && what.type === 'disconnected') {
    const m = $('#connectMsg'); m.className = 'msg err'; m.textContent = what.reason; return;
  }
  if (what === 'status') { renderStatus(); return; }
  if (what === 'board' && state.code && pendingImport) setTimeout(() => showImport(pendingImport), 0);
  if (what === 'lms') { renderLms(); renderNext(); loadNotices(); return; }
  if (what === 'prefs') { applyTheme(); renderSemester(); renderNext(); renderRail(); renderView(); return; }
  renderAll();
});

/* ───── 이벤트 연결 ───── */
function bind() {
  // 연결 화면
  $('#btnCreate').addEventListener('click', async () => {
    const btn = $('#btnCreate'), msg = $('#createMsg');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = '보드를 만드는 중…';
    try {
      const code = await createBoard();
      msg.textContent = '';
      $('#newCodeText').value = code;
      $('#newCodeDialog').showModal();
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = errText(e);
    } finally { btn.disabled = false; }
  });
  const doConnect = async () => {
    const btn = $('#btnConnect'), msg = $('#connectMsg');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = '보드를 여는 중…';
    try { await connect($('#inCode').value); msg.textContent = ''; $('#inCode').value = ''; }
    catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message === 'short_code' ? '보드 코드 20자를 모두 입력해 주세요' : errText(e);
    } finally { btn.disabled = false; }
  };
  $('#btnConnect').addEventListener('click', doConnect);
  $('#inCode').addEventListener('keydown', e => { if (e.key === 'Enter') doConnect(); });
  $('#btnCopyNew').addEventListener('click', () => copyText(state.code, $('#newCodeText'), $('#copyNewMsg')));
  $('#btnNewCodeOk').addEventListener('click', () => $('#newCodeDialog').close());

  // 상단
  $('#semester').addEventListener('change', e => {
    const v = e.target.value;
    setPref('subject', null);
    setPref('semester', v);
    // 캘린더를 그 학기의 첫 달로 (이번 학기면 이번 달)
    const s = v === 'current' || v === 'all' ? null : parseSemesterKey(v);
    const base = s ? semesterRange(s).start : new Date();
    ui.calMonth = new Date(base.getFullYear(), base.getMonth(), 1);
    ui.selectedDay = s ? null : startOfDay(new Date());
    renderView();
  });
  $$('.views button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#search').addEventListener('input', e => { ui.query = e.target.value; renderView(); });
  const presetDay = () => (state.prefs.view === 'calendar' ? ui.selectedDay : null);
  $('#btnNew').addEventListener('click', () => openPanel(null, presetDay(), 'assignment'));
  $$('#kindPicker button').forEach(b => b.addEventListener('click', () => setKind(b.dataset.kind, { isNew: !ui.editingId })));
  // 새로 불러오기: 다른 기기 변경 + (연동돼 있으면) 스마트캠퍼스까지
  $('#btnSync').addEventListener('click', e => {
    if (state.lms.connected) runLmsSync(e.currentTarget, { quiet: true });
    else { pull(); loadLms(); }
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#status').addEventListener('click', () => { if (state.syncError) pull(); });

  // 패널
  $('#panelClose').addEventListener('click', closePanel);
  $('#btnNotices').addEventListener('click', openNotices);
  $('#noticesClose').addEventListener('click', () => $('#noticesDialog').close());
  $('#btnCalKey').addEventListener('click', makeCalendarKey);
  $('#btnCalCopy').addEventListener('click', () => copyText($('#calUrl').value, $('#calUrl'), $('#calMsg')));
  $('#fStarBtn').addEventListener('click', () => { $('#fStar').checked = !$('#fStar').checked; renderStarBtn(); });
  $('#fDoneBtn').addEventListener('click', () => {
    const done = !$('#fDone').checked;
    $('#fDone').checked = done;
    savePanel();
    toast(done ? '제출 완료로 표시했어요' : '완료를 취소했어요');
  });
  $('#scrim').addEventListener('click', closePanel);
  $('#panelSave').addEventListener('click', savePanel);
  $('#panelDelete').addEventListener('click', deleteFromPanel);
  ['#fTitle', '#fSubject', '#fLocation'].forEach(s =>
    $(s).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); savePanel(); } }));

  // 설정
  $('#settingsClose').addEventListener('click', () => $('#settings').close());
  $('#btnShowCode').addEventListener('click', () => {
    codeShown = !codeShown;
    $('#codeText').value = codeShown ? state.code : mask(state.code);
    $('#btnShowCode').textContent = codeShown ? '숨기기' : '보기';
  });
  $('#btnCopyCode').addEventListener('click', () => copyText(state.code, $('#codeText'), $('#copyMsg')));
  $$('#themePicker button').forEach(b => b.addEventListener('click', () => setPref('theme', b.dataset.theme)));

  $('#btnFeedSave').addEventListener('click', async () => {
    const url = $('#feedUrl').value.trim(), msg = $('#feedMsg');
    if (!url) { msg.className = 'msg err'; msg.textContent = '캘린더 피드 주소를 붙여 넣어 주세요'; return; }
    msg.className = 'msg'; msg.textContent = '연동하는 중…';
    try {
      await setFeed(url);
      $('#feedUrl').value = '';
      msg.textContent = '';
      await runLmsSync($('#btnFeedSave'));
    } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  });
  $('#btnLmsNow').addEventListener('click', e => runLmsSync(e.currentTarget));
  $('#btnTokenSave').addEventListener('click', async () => {
    const input = $('#tokenInput'), msg = $('#tokenMsg'), btn = $('#btnTokenSave');
    const token = input.value.trim();
    if (!token) { msg.className = 'msg err'; msg.textContent = '스마트캠퍼스에서 만든 토큰을 붙여 넣어 주세요'; return; }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = '연결하고 과제를 불러오는 중…';
    try {
      await setToken(token);
      input.value = ''; tokenEditing = false; renderLms();
      const r = await lmsSync();
      const parts = [];
      if (r.added) parts.push(`새 과제 ${r.added}개`);
      if (r.updated) parts.push(`바뀐 과제 ${r.updated}개`);
      msg.className = 'msg ok';
      msg.textContent = `연결했어요. 과제 ${r.total ?? 0}개를 확인했고${parts.length ? ` ${parts.join(', ')}를 반영했어요` : ' 바뀐 건 없어요'}.`;
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = errText(e);
    } finally { btn.disabled = false; }
  });
  $('#btnTokenChange').addEventListener('click', () => { tokenEditing = true; renderLms(); $('#tokenInput').focus(); });
  $('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) $('#btnTokenSave').click(); });
  armTwice($('#btnTokenClear'), '토큰 해제', '한 번 더 누르면 해제돼요', async () => {
    const msg = $('#tokenMsg');
    try { await setToken(null); msg.className = 'msg'; msg.textContent = '토큰을 지웠어요. 스마트캠퍼스 설정에서도 그 토큰을 삭제해 주세요.'; }
    catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  });
  armTwice($('#btnFeedClear'), '피드 해제', '한 번 더 누르면 해제돼요', async () => {
    try { await setFeed(null); $('#feedMsg').className = 'msg'; $('#feedMsg').textContent = '피드 연동을 해제했어요. 가져온 과제는 남아 있어요.'; }
    catch (e) { $('#feedMsg').className = 'msg err'; $('#feedMsg').textContent = errText(e); }
  });

  $('#btnImport').addEventListener('click', async () => {
    const msg = $('#importMsg');
    msg.className = 'msg'; msg.textContent = '가져오는 중…';
    try {
      const n = await importBackup($('#importText').value);
      msg.className = 'msg ok'; msg.textContent = `과제 ${n}개를 가져왔어요`;
      $('#importText').value = '';
    } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  });
  $('#btnExport').addEventListener('click', () => copyText(exportBackup(), $('#importText'), $('#importMsg')));
  armTwice($('#btnDisconnect'), '이 기기 연결 해제', '한 번 더 누르면 해제돼요', () => {
    $('#settings').close();
    const code = state.code;
    disablePush(code).catch(() => {});   // 이 기기 알림도 함께 끔
    push.subscribed = false;
    disconnect();
  });

  // 마감 알림
  $('#btnPushOn').addEventListener('click', () => pushTask('알림을 켜는 중…', async () => {
    const r = await enablePush(state.code, push.leads);
    push.subscribed = true;
    if (r && Array.isArray(r.leads)) push.leads = r.leads;
  }, '알림을 켰어요. 테스트 알림으로 확인해 보세요'));
  $('#btnPushOff').addEventListener('click', () => pushTask('알림을 끄는 중…', async () => {
    await disablePush(state.code);
    push.subscribed = false;
  }, '이 기기 알림을 껐어요'));
  $('#btnPushTest').addEventListener('click', () => pushTask('보내는 중…', () => testPush(state.code), '보냈어요. 몇 초 안에 알림이 와요'));

  // 스마트캠퍼스 전체 가져오기
  $('#bookmarklet').addEventListener('click', e => {
    e.preventDefault();
    toast('이 버튼은 북마크바로 끌어다 놓은 뒤, 스마트캠퍼스 화면에서 눌러 주세요');
  });
  $('#canvasFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    const msg = $('#canvasFileMsg');
    e.target.value = '';
    if (!file) return;
    try {
      const items = parseCanvasData(await file.text());
      msg.className = 'msg'; msg.textContent = '';
      $('#settings').close();
      showImport(items);
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = '스마트캠퍼스에서 저장한 파일이 아니에요. 안내한 주소를 열어 저장했는지 확인해 주세요';
    }
  });
  $('#importCancel').addEventListener('click', () => { pendingImport = null; $('#importDialog').close(); });
  $('#importConfirm').addEventListener('click', confirmImport);
  let importWait = null;
  listenForCanvasData(data => { clearTimeout(importWait); handleCanvasPayload(data); }, st => {
    if (st.kind === 'progress') toast(`스마트캠퍼스: ${st.text}`, null, null, 20000);
    else {
      clearTimeout(importWait);
      toast(`스마트캠퍼스에서 읽지 못했어요 (${st.text}). 로그인한 스마트캠퍼스 화면에서 다시 눌러 주세요`, null, null, 12000);
    }
  });
  // 북마클릿으로 열린 창: 기다리는 동안 안내
  if (location.hash === '#import' && window.opener) {
    toast('스마트캠퍼스에서 과제를 불러오는 중이에요…', null, null, 30000);
    importWait = setTimeout(() => toast('스마트캠퍼스 창에서 아직 아무것도 받지 못했어요. 그 창에 오류 안내가 떴는지 확인해 주세요', null, null, 15000), 30000);
  }

  // 시간 선택 연동
  $('#fTime').addEventListener('change', () => {
    if (ui.kind === 'exam' && (ui.endAuto || !$('#fEnd').value)) autoEnd(ui.examLength || 60);
    renderDurations();
  });
  $('#fEnd').addEventListener('change', () => {
    if (!ui.settingEnd) ui.endAuto = false;
    renderDurations();
  });

  // 단축키
  document.addEventListener('keydown', e => {
    if (!state.code) return;
    if (e.key === 'Escape' && !$('#panel').hidden) { closePanel(); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#panel').hidden || $('#settings').open) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openPanel(null, null, 'assignment'); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); openPanel(null, null, 'exam'); }
    else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    else if (e.key === '1') setView('list');
    else if (e.key === '2') setView('calendar');
  });

  window.addEventListener('hashchange', () => { if (!openTaskFromHash()) setView(location.hash.slice(1)); });
  // 알림을 눌러 이미 열린 창으로 돌아올 때 (서비스 워커가 보냄)
  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data && e.data.type === 'open-task') { pendingTaskId = e.data.id; openTaskFromHash(); }
  });
}

/* ───── 알림에서 과제 열기 (#task=<id>) ───── */
let pendingTaskId = null;
function openTaskFromHash() {
  // 알림에서 연 경우: 설정 · 공지
  if ((location.hash === '#settings' || location.hash === '#notices') && state.code) {
    const which = location.hash;
    history.replaceState(null, '', `#${state.prefs.view}`);
    setTimeout(() => { if (which === '#settings') openSettings(); else loadNotices().then(openNotices); }, 0);
    return true;
  }
  // 앱 바로가기: 새 과제 / 새 시험
  if ((location.hash === '#new' || location.hash === '#new-exam') && state.code) {
    const kind = location.hash === '#new' ? 'assignment' : 'exam';
    history.replaceState(null, '', `#${state.prefs.view}`);
    setTimeout(() => openPanel(null, null, kind), 0);
    return true;
  }
  const m = location.hash.match(/^#task=(.+)$/);
  if (m) pendingTaskId = decodeURIComponent(m[1]);
  if (!pendingTaskId) return !!m;
  const t = state.tasks.find(x => x.id === pendingTaskId);
  if (!t) return true;                      // 아직 불러오기 전이면 불러온 뒤 다시 시도
  pendingTaskId = null;
  history.replaceState(null, '', `#${state.prefs.view}`);
  openPanel(t);
  return true;
}
subscribe(what => { if (pendingTaskId && (what === 'tasks' || what === 'board')) setTimeout(openTaskFromHash, 0); });

/* ───── 앱으로 설치 ───── */
let installEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); installEvent = e;
  $('#installRow').hidden = false;
});
window.addEventListener('appinstalled', () => { installEvent = null; $('#installRow').hidden = true; });
$('#btnInstall').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null; $('#installRow').hidden = true;
});

/* ───── 시작 ───── */
bind();
initPickers();
applyTheme();
const hashView = location.hash.slice(1);
if (['list', 'calendar'].includes(hashView)) state.prefs.view = hashView;
renderAll();
if (state.code) { pull(); loadLms(); }
openTaskFromHash();

setInterval(() => {
  if (!state.code) return;
  if ($('#panel').hidden) pull();
  renderNext();                     // 남은 시간 갱신
}, SYNC_INTERVAL);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.code) { pull(); loadLms(); } });

// 홈 화면에 추가했을 때 오프라인에서도 열리도록
if ('serviceWorker' in navigator && !isEmbedded && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
