// 앱 시작, 화면 구성, 이벤트 연결

import {
  state, subscribe, setPref, pull, saveTask, toggleDone, toggleStar, removeTask, undoRemove,
  createBoard, connect, disconnect, loadLms, lmsSync, setFeed, importBackup, exportBackup,
} from './store.js';
import { errText } from './api.js';
import {
  $, $$, h, fmtDate, fmtDuration, fmtClock, subjectColor, setSubjects, startOfDay, addDays,
  startOfWeek, toDateInput, toTimeInput, DAY, isExam, groupOf, timeRange, dday,
} from './util.js';
import { renderList, renderCalendar, renderSubjects } from './views.js';

const SYNC_INTERVAL = 30000;

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

/* ───── 필터 적용 ───── */
function visibleTasks() {
  const q = ui.query.trim().toLowerCase();
  const { subject, hideDone, starredOnly, kind } = state.prefs;
  return state.tasks.filter(t => {
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
  const assignments = state.tasks.filter(t => !isExam(t));
  const pending = assignments.filter(t => !t.done);
  const upcoming = pending.filter(t => new Date(t.due) >= now).sort(byDue);
  const over = pending.length - upcoming.length;
  const weekEnd = addDays(startOfWeek(now), 7);
  const thisWeek = upcoming.filter(t => new Date(t.due) < weekEnd).length;
  const done = state.tasks.filter(t => groupOf(t, now) === 'done').length;
  const nextExam = state.tasks.filter(t => isExam(t) && !t.done && groupOf(t, now) !== 'done').sort(byDue)[0];

  const line = h('p', { class: 'next-line' });
  const next = upcoming[0];
  if (next) {
    const left = new Date(next.due) - now;
    line.append(
      '다음 마감은 ',
      h('button', { type: 'button', onclick: () => openPanel(next) }, next.title),
      next.subject ? h('span', { class: 'muted' }, ` (${next.subject})`) : null,
      `, ${fmtDuration(left)} 남았어요.`,
    );
  } else if (assignments.length) {
    line.append('다가오는 과제 마감이 없어요.', over ? h('span', { class: 'muted' }, ' 마감이 지난 과제만 남아 있어요.') : null);
  } else {
    line.append('과제를 추가하면 가장 가까운 마감을 여기에 알려 드려요.');
  }

  const stats = h('div', { class: 'next-stats' },
    h('span', null, '이번 주 과제 ', h('b', null, thisWeek)),
    h('span', { class: over ? 'warn' : '' }, '마감 지남 ', h('b', null, over)),
    h('span', null, '완료 ', h('b', null, done), ` / ${state.tasks.length}`),
  );
  const parts = [line, stats];
  if (nextExam) {
    const d = new Date(nextExam.due);
    const info = dday(nextExam, now);
    parts.push(h('p', { class: 'next-exam' },
      h('span', { class: 'kind-tag' }, '시험'),
      '다음 시험은 ',
      h('b', null, [nextExam.subject, nextExam.title].filter(Boolean).join(' ')),
      `, ${fmtDate(d, false)} ${timeRange(nextExam)}`,
      nextExam.location ? ` · ${nextExam.location}` : '',
      ` (${info.label})`));
  }
  $('#next').replaceChildren(...parts);
}

/* ───── 왼쪽 필터 ───── */
function subjectsWithCounts() {
  const map = new Map();
  for (const t of state.tasks) {
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
  const pendingAll = state.tasks.filter(t => !t.done).length;

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
    chip('과제만', state.prefs.kind === 'assignment', () => setPref('kind', state.prefs.kind === 'assignment' ? null : 'assignment')),
    chip('시험만', state.prefs.kind === 'exam', () => setPref('kind', state.prefs.kind === 'exam' ? null : 'exam')),
    chip('완료 숨기기', state.prefs.hideDone, () => setPref('hideDone', !state.prefs.hideDone)),
    chip('중요만', state.prefs.starredOnly, () => setPref('starredOnly', !state.prefs.starredOnly)),
  );

  rail.replaceChildren(
    chips,
    h('div', null, h('h3', null, '과목'), list),
    h('div', { class: 'kind-filter' }, h('h3', null, '종류'),
      h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': '종류' },
        [[null, '전체'], ['assignment', '과제'], ['exam', '시험']].map(([k, label]) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': state.prefs.kind === k ? 'true' : 'false',
          onclick: () => setPref('kind', k),
        }, label)))),
    h('div', { class: 'toggles' }, h('h3', null, '보기 옵션'),
      toggle('hideDone', '완료한 과제 숨기기'),
      toggle('starredOnly', '중요한 과제만 보기')),
  );

  $('#subjectList').replaceChildren(...subjects.filter(([n]) => n).map(([n]) => h('option', { value: n })));
}

/* ───── 본문 ───── */
const ctx = () => ({
  now: new Date(),
  total: state.tasks.length,
  showDone: ui.showDone,
  calMonth: ui.calMonth,
  selectedDay: ui.selectedDay,
  onToggle: id => toggleDone(id),
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
  if (view === 'calendar') renderCalendar(root, tasks, ctx());
  else if (view === 'subjects') renderSubjects(root, tasks, ctx());
  else renderList(root, tasks, ctx());
}

function setView(v) {
  if (!['list', 'calendar', 'subjects'].includes(v)) v = 'list';
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
  else if (state.lastSync) { el.classList.add('ok'); el.textContent = `모든 기기와 동기화됨 · ${fmtClock(state.lastSync)}`; }
  else el.textContent = '불러오는 중…';
}

function renderLms() {
  const l = state.lms;
  $('#btnLms').hidden = !l.connected;
  $('#btnLmsNow').hidden = !l.connected;
  $('#btnFeedClear').hidden = !l.connected;
  $('#btnFeedSave').textContent = l.connected ? '주소 바꾸기' : '연동하기';
  const st = $('#lmsState');
  st.className = 'lms-state';
  if (!l.connected) st.textContent = '아직 연동하지 않았어요.';
  else if (l.error) { st.classList.add('err'); st.textContent = `연동됨 · 마지막 시도 실패: ${errText(new Error(l.error))}`; }
  else {
    st.classList.add('ok');
    st.textContent = l.syncedAt ? `연동됨 · 마지막으로 가져온 시각 ${fmtDate(new Date(l.syncedAt))}` : '연동됨 · 아직 가져오기 전이에요';
  }
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
function quickDates() {
  const today = startOfDay(new Date());
  const fri = addDays(startOfWeek(today), 4);
  const opts = [
    ['오늘', today], ['내일', addDays(today, 1)],
    [fri > today ? '이번 주 금요일' : '다음 주 금요일', fri > today ? fri : addDays(fri, 7)],
    ['다음 주 월요일', addDays(startOfWeek(today), 7)],
    ['1주 뒤', addDays(today, 7)],
  ];
  $('#quickDates').replaceChildren(...opts.map(([label, d]) =>
    h('button', { type: 'button', onclick: () => { $('#fDate').value = toDateInput(d); } }, label)));
}

const EXAM_NAMES = ['중간고사', '기말고사', '퀴즈', '실기시험'];

// 과제 / 시험 템플릿 전환
function setKind(kind, { isNew }) {
  ui.kind = kind;
  const exam = kind === 'exam';
  $('#panel').classList.toggle('is-exam', exam);
  $$('#kindPicker button').forEach(b => b.setAttribute('aria-checked', b.dataset.kind === kind ? 'true' : 'false'));
  $('#panelTitle').textContent = isNew ? (exam ? '새 시험' : '새 과제') : (exam ? '시험 자세히' : '과제 자세히');
  $('#fTitleLabel').textContent = exam ? '시험 이름' : '과제명';
  $('#fTitle').placeholder = exam ? '예: 중간고사' : '예: HW3 정규화 연습문제';
  $('#fDateLabel').textContent = exam ? '시험 날짜' : '마감 날짜';
  $('#fTimeLabel').textContent = exam ? '시작 시각' : '시각';
  $('#fDoneLabel').textContent = exam ? '응시 완료' : '제출 완료';
  $('#fMemoLabel').textContent = exam ? '시험 범위와 메모' : '메모';
  $('#fMemo').placeholder = exam ? '시험 범위, 준비물(학생증, 계산기), 공부할 것 등을 적어 두세요' : '제출 방법, 참고 자료, 할 일 등을 적어 두세요';
  // 새로 만들 때 시각 기본값만 템플릿에 맞춤 (사용자가 바꾼 값은 유지)
  if (isNew) {
    const t = $('#fTime').value;
    if (exam && (t === '23:59' || !t)) $('#fTime').value = '10:30';
    if (!exam && t === '10:30') $('#fTime').value = '23:59';
  }
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
  $('#fStar').checked = !!(task && task.starred);
  $('#fDone').checked = !!(task && task.done);
  $('#fDoneRow').hidden = !task;
  $('#fMemo').value = task ? task.memo || '' : '';
  $('#fLocation').value = task ? task.location || '' : '';
  $('#fEnd').value = task && task.endAt ? toTimeInput(new Date(task.endAt)) : '';
  setKind(task ? (isExam(task) ? 'exam' : 'assignment') : (kind || 'assignment'), { isNew: !task });
  $('#kindPicker').hidden = !!(task && task.source === 'canvas');   // 스마트캠퍼스 과제는 종류 고정
  $('#examNames').replaceChildren(...EXAM_NAMES.map(n => h('button', {
    type: 'button', onclick: () => { $('#fTitle').value = n; $('#fTitle').focus(); },
  }, n)));

  const note = $('#panelNote');
  if (task && task.source === 'canvas') {
    note.hidden = false;
    note.replaceChildren('스마트캠퍼스에서 가져온 과제예요. 직접 고친 과제명, 과목, 마감은 이후 자동 가져오기에서도 그대로 유지돼요. ',
      task.link ? h('a', { href: task.link, target: '_blank', rel: 'noopener noreferrer' }, '스마트캠퍼스에서 열기') : null);
  } else note.hidden = true;

  const meta = [];
  if (task && task.createdAt) meta.push(`만든 날 ${fmtDate(new Date(task.createdAt), false)}`);
  if (task && task.done && task.doneAt) meta.push(`완료한 날 ${fmtDate(new Date(task.doneAt), false)}`);
  $('#panelMeta').textContent = meta.join(' · ');

  quickDates();
  $('#scrim').hidden = false;
  $('#panel').hidden = false;
  (task ? $('#panelSave') : $('#fTitle')).focus();
  if (!task) $('#fTitle').focus();
}

function closePanel() {
  $('#panel').hidden = true;
  $('#scrim').hidden = true;
  ui.editingId = null;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function savePanel() {
  const title = $('#fTitle').value.trim();
  const msg = $('#panelMsg');
  msg.className = 'msg err';
  if (!title) { msg.textContent = '과제명을 적어 주세요'; $('#fTitle').focus(); return; }
  if (!$('#fDate').value) { msg.textContent = '마감 날짜를 골라 주세요'; $('#fDate').focus(); return; }
  const due = new Date(`${$('#fDate').value}T${$('#fTime').value || '23:59'}`);
  if (isNaN(due)) { msg.textContent = '마감 날짜를 다시 확인해 주세요'; return; }
  const isNew = !ui.editingId;
  const exam = ui.kind === 'exam';
  let endAt = null;
  if (exam && $('#fEnd').value) {
    const end = new Date(`${$('#fDate').value}T${$('#fEnd').value}`);
    if (end <= due) { msg.textContent = '끝나는 시각은 시작 시각보다 늦어야 해요'; $('#fEnd').focus(); return; }
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
  closePanel();
  if (isNew) toast(`"${title}" ${exam ? '시험을' : '과제를'} 추가했어요`);
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
  ['#feedMsg', '#importMsg', '#copyMsg'].forEach(s => { $(s).textContent = ''; });
  renderLms(); applyTheme();
  $('#settings').showModal();
  loadLms();
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

async function runLmsSync(button) {
  if (button) button.disabled = true;
  try {
    const r = await lmsSync();
    const parts = [];
    if (r.added) parts.push(`새 과제 ${r.added}개`);
    if (r.updated) parts.push(`바뀐 과제 ${r.updated}개`);
    toast(parts.length ? `스마트캠퍼스에서 ${parts.join(', ')}를 가져왔어요` : '스마트캠퍼스에 새로운 과제가 없어요');
  } catch (e) {
    toast(errText(e));
  } finally {
    if (button) button.disabled = false;
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
  renderNext(); renderRail(); renderView(); renderStatus(); renderLms();
}

subscribe(what => {
  if (what && what.type === 'disconnected') {
    const m = $('#connectMsg'); m.className = 'msg err'; m.textContent = what.reason; return;
  }
  if (what === 'status') { renderStatus(); return; }
  if (what === 'lms') { renderLms(); return; }
  if (what === 'prefs') { applyTheme(); renderRail(); renderView(); return; }
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
  $$('.views button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#search').addEventListener('input', e => { ui.query = e.target.value; renderView(); });
  const presetDay = () => (state.prefs.view === 'calendar' ? ui.selectedDay : null);
  $('#btnNew').addEventListener('click', () => openPanel(null, presetDay(), 'assignment'));
  $('#btnNewExam').addEventListener('click', () => openPanel(null, presetDay(), 'exam'));
  $$('#kindPicker button').forEach(b => b.addEventListener('click', () => setKind(b.dataset.kind, { isNew: !ui.editingId })));
  $('#btnSync').addEventListener('click', () => { pull(); loadLms(); });
  $('#btnLms').addEventListener('click', e => runLmsSync(e.currentTarget));
  $('#btnSettings').addEventListener('click', openSettings);
  $('#status').addEventListener('click', () => { if (state.syncError) pull(); });

  // 패널
  $('#panelClose').addEventListener('click', closePanel);
  $('#panelCancel').addEventListener('click', closePanel);
  $('#scrim').addEventListener('click', closePanel);
  $('#panelSave').addEventListener('click', savePanel);
  $('#panelDelete').addEventListener('click', deleteFromPanel);
  ['#fTitle', '#fSubject', '#fDate', '#fTime'].forEach(s =>
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
  armTwice($('#btnFeedClear'), '연동 해제', '한 번 더 누르면 해제돼요', async () => {
    try { await setFeed(null); $('#feedMsg').className = 'msg'; $('#feedMsg').textContent = '연동을 해제했어요. 가져온 과제는 남아 있어요.'; }
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
    disconnect();
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
    else if (e.key === '3') setView('subjects');
  });

  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
}

/* ───── 시작 ───── */
bind();
applyTheme();
const hashView = location.hash.slice(1);
if (['list', 'calendar', 'subjects'].includes(hashView)) state.prefs.view = hashView;
renderAll();
if (state.code) { pull(); loadLms(); }

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
