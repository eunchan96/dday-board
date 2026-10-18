// 공부 모드: 오늘(타이머 · 계획 · 하루 타임라인), 기록(주간 · 월간), 친구
//
// - 하루는 새벽 5시에 바뀐다 (밤새 공부한 시간은 전날로) — 서버(app.study_day)와 같은 기준
// - 타이머는 이 기기에만 저장 (창을 닫았다 열어도 이어짐). 끝낸 공부만 서버에 기록
// - 서버에 못 보낸 기록은 기기에 모아 뒀다가 다음에 다시 보낸다

import { state, storage, subscribe } from './store.js';
import { api, errText } from './api.js';
import {
  $, h, pad, newId, dayKey, addDays, startOfWeek, startOfDay, WEEK, DAY,
  subjectColor, displayTitle, dday, isExam, semesterOf, semesterKey, taskSemesterKey, fmtClock,
} from './util.js';

const KEYS = { timer: 'ddayboard.timer', queue: 'ddayboard.studyQueue' };
const DAY_SHIFT = 5 * 3600 * 1000;           // 새벽 5시
const MIN_SAVE = 60;                          // 1분 미만은 기록하지 않음
const WATCH_MAX = 12 * 3600 * 1000;           // 스톱워치를 켜 둔 채 잊은 경우
const LIVE_EVERY = 5 * 60 * 1000;
const MODES = [
  { key: 'p25', label: '25분', title: '25분 집중 · 5분 휴식', focus: 25, rest: 5 },
  { key: 'p50', label: '50분', title: '50분 집중 · 10분 휴식', focus: 50, rest: 10 },
  { key: 'watch', label: '', title: '스톱워치' },
];
const GOALS = [60, 120, 180, 240, 300, 360, 480, 600];

let ctx = { toast: () => {}, openTask: () => {}, onTimer: () => {} };

/* ───── 날짜 ───── */
const studyDate = (d = new Date()) => startOfDay(new Date(new Date(d).getTime() - DAY_SHIFT));
const studyKey = d => dayKey(studyDate(d));
const dayStart = date => new Date(date.getTime() + DAY_SHIFT);   // 그 공부 날짜가 시작되는 시각

export function fmtSpent(sec, { short = false } = {}) {
  const m = Math.floor(sec / 60);
  const hh = Math.floor(m / 60), mm = m % 60;
  if (short) return hh ? `${hh}h ${pad(mm)}m` : `${mm}m`;
  if (hh && mm) return `${hh}시간 ${mm}분`;
  if (hh) return `${hh}시간`;
  return `${mm}분`;
}

/* ───── 데이터 ───── */
const study = {
  loaded: false,
  loading: false,
  error: null,
  goal: 180,
  sessions: [],
  daily: new Map(),           // 'YYYY-MM-DD' → 초 (서버 집계)
  plans: [],
  profile: null,
  friends: [],
  friendsError: null,
  windowStart: null,          // sessions를 받아 온 시작 시각
  extra: new Map(),           // 기록 탭에서 더 불러온 예전 기록 (id → 기록)
};

function readJSON(k, fallback) {
  try { const v = JSON.parse(storage.get(k) || 'null'); return v ?? fallback; } catch { return fallback; }
}

let queue = readJSON(KEYS.queue, []);        // 아직 서버에 못 보낸 기록
const saveQueue = () => storage.set(KEYS.queue, JSON.stringify(queue));

export async function loadStudy() {
  if (!state.code || study.loading) return;
  study.loading = true;
  const from = dayStart(addDays(studyDate(), -14));
  try {
    await flushQueue();
    const r = await api.study(state.code, from.toISOString());
    study.goal = r.goal || 180;
    // 아직 못 보낸 기록은 화면에 계속 보이게
    const pending = queue.filter(q => !r.sessions.some(s => s.id === q.id));
    study.sessions = [...r.sessions, ...pending];
    study.daily = new Map((r.daily || []).map(d => [d.day, d.seconds]));
    study.plans = r.plans || [];
    study.profile = r.profile || null;
    study.windowStart = from;
    study.loaded = true;
    study.error = null;
  } catch (e) {
    study.error = errText(e);
  } finally {
    study.loading = false;
  }
  render();
  if (study.profile && study.profile.visible) loadFriends();
}

let flushing = null;
function flushQueue() {
  if (flushing) return flushing.then(() => (queue.length ? flushQueue() : undefined));
  if (!queue.length || !state.code) return Promise.resolve();
  flushing = (async () => {
    for (const s of queue.slice()) {
      try {
        await api.studyAdd(state.code, s);
        queue = queue.filter(x => x.id !== s.id);
      } catch (e) {
        // 시간이 너무 지나 서버가 받지 않는 기록은 버린다. 그 밖(네트워크 등)은 다음에 다시
        if (/invalid_session/.test(e.message)) queue = queue.filter(x => x.id !== s.id);
        else break;
      }
    }
    saveQueue();
  })().finally(() => { flushing = null; });
  return flushing;
}

function addSession(s) {
  study.sessions.push(s);
  queue.push(s); saveQueue();
  render();
  flushQueue().then(render);
  autoCompletePlan(s.planId);
}

export async function loadFriends() {
  if (!state.code || !study.profile || !study.profile.visible) return;
  try { study.friends = (await api.friends(state.code)) || []; study.friendsError = null; }
  catch (e) { study.friendsError = errText(e); }
  renderFriends();
}

/* ───── 계산 ───── */
function allSessions() {
  if (!study.extra.size) return study.sessions;
  const ids = new Set(study.sessions.map(s => s.id));
  return [...study.sessions, ...[...study.extra.values()].filter(s => !ids.has(s.id))];
}
function sessionsOn(key) {
  return allSessions().filter(s => studyKey(s.startedAt) === key);
}
function runningFocusSec() {
  return timer.phase === 'focus' ? Math.floor(elapsed() / 1000) : 0;
}
function todaySeconds() {
  return sessionsOn(studyKey()).reduce((a, s) => a + s.seconds, 0) + runningFocusSec();
}
// 서버 집계 + (받아 온 기간은) 이 기기의 기록으로 덮어쓰기
function dailyMap() {
  const m = new Map(study.daily);
  if (study.windowStart) {
    const startKey = studyKey(study.windowStart);
    for (const k of [...m.keys()]) if (k >= startKey) m.delete(k);
    for (const s of study.sessions) {
      const k = studyKey(s.startedAt);
      m.set(k, (m.get(k) || 0) + s.seconds);
    }
  }
  const today = studyKey();
  if (runningFocusSec()) m.set(today, (m.get(today) || 0) + runningFocusSec());
  return m;
}
function streak(m) {
  let d = studyDate();
  if (!m.get(dayKey(d))) d = addDays(d, -1);
  let n = 0;
  while (m.get(dayKey(d))) { n++; d = addDays(d, -1); }
  return n;
}
function bySubject(list) {
  const map = new Map();
  for (const s of list) map.set(s.subject || '', (map.get(s.subject || '') || 0) + s.seconds);
  if (timer.phase === 'focus') map.set(timer.subject || '', (map.get(timer.subject || '') || 0) + runningFocusSec());
  return [...map.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}
function planProgress(p) {
  let sec = study.sessions.filter(s => s.planId === p.id).reduce((a, s) => a + s.seconds, 0);
  if (timer.phase === 'focus' && timer.planId === p.id) sec += runningFocusSec();
  return sec;
}
function currentSubjects() {
  const cur = semesterKey(semesterOf(new Date()));
  const count = new Map();
  for (const t of state.tasks) {
    if (!t.subject || taskSemesterKey(t) !== cur) continue;
    count.set(t.subject, (count.get(t.subject) || 0) + (t.done ? 0 : 1));
  }
  for (const s of study.sessions) if (s.subject && !count.has(s.subject)) count.set(s.subject, 0);
  return [...count.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'ko')).map(([n]) => n);
}

/* ───── 타이머 ───── */
const timer = Object.assign({
  mode: 'p25', phase: 'idle', running: false, segStart: null, acc: 0, sessStart: null,
  subject: '', taskId: null, planId: null, label: '',
}, readJSON(KEYS.timer, {}));
const saveTimer = () => storage.set(KEYS.timer, JSON.stringify(timer));
const modeOf = () => MODES.find(m => m.key === timer.mode) || MODES[0];
const isPomo = () => timer.mode !== 'watch';

function elapsed(now = Date.now()) {
  return timer.acc + (timer.running && timer.segStart ? now - timer.segStart : 0);
}
function phaseLength() {
  const m = modeOf();
  if (!isPomo()) return WATCH_MAX;
  return (timer.phase === 'rest' ? m.rest : m.focus) * 60000;
}

export const timerActive = () => timer.phase !== 'idle';

let lastLive = 0;
function live(on) {
  if (!state.code || !study.profile || !study.profile.visible) return;
  lastLive = on ? Date.now() : 0;
  api.studyLive(state.code, on).catch(() => {});
}

function start() {
  if (timer.phase !== 'idle') return;
  timer.phase = 'focus'; timer.running = true; timer.acc = 0;
  timer.segStart = Date.now(); timer.sessStart = timer.segStart;
  saveTimer(); live(true); render(); ctx.onTimer();
}
function pause() {
  if (!timer.running) return;
  timer.acc = elapsed(); timer.running = false; timer.segStart = null;
  saveTimer(); if (timer.phase === 'focus') live(false); render(); ctx.onTimer();
}
function resume() {
  if (timer.running || timer.phase === 'idle') return;
  timer.running = true; timer.segStart = Date.now();
  saveTimer(); if (timer.phase === 'focus') live(true); render(); ctx.onTimer();
}
function finishFocus(endMs, focusMs) {
  const sec = Math.round(focusMs / 1000);
  if (sec >= MIN_SAVE) {
    addSession({
      id: newId(), subject: timer.subject || '', taskId: timer.taskId || null, planId: timer.planId || null,
      startedAt: new Date(timer.sessStart || endMs - focusMs).toISOString(),
      endedAt: new Date(endMs).toISOString(), seconds: sec,
    });
  }
  return sec;
}
function stop() {
  if (timer.phase === 'focus') {
    const sec = finishFocus(Date.now(), elapsed());
    if (sec < MIN_SAVE) ctx.toast('1분이 안 돼서 기록하지 않았어요');
    else ctx.toast(`${timer.label || timer.subject || '공부'} ${fmtSpent(sec)} 기록했어요`);
    live(false);
  }
  toIdle();
}
function toIdle() {
  Object.assign(timer, { phase: 'idle', running: false, segStart: null, acc: 0, sessStart: null });
  saveTimer(); render(); ctx.onTimer();
}

// 1초마다: 시간이 다 된 단계를 넘기고 화면 숫자만 바꾼다
function tick() {
  if (timer.phase === 'idle') return;
  const now = Date.now();
  let changed = false;
  // 창을 닫아 둔 사이 여러 단계가 지났을 수도 있어서 반복
  for (let guard = 0; guard < 4 && timer.running; guard++) {
    const len = phaseLength();
    const el = elapsed(now);
    if (el < len) break;
    const endMs = timer.segStart + (len - timer.acc);
    changed = true;
    if (timer.phase === 'focus' && isPomo()) {
      finishFocus(endMs, len);
      live(false);
      Object.assign(timer, { phase: 'rest', acc: 0, segStart: endMs, sessStart: null });
      alertUser('집중 끝', `${modeOf().rest}분 쉬어요`);
    } else if (timer.phase === 'focus') {
      finishFocus(endMs, len);                // 스톱워치 12시간
      live(false);
      Object.assign(timer, { phase: 'idle', running: false, segStart: null, acc: 0, sessStart: null });
      ctx.toast('스톱워치가 12시간을 넘어서 멈췄어요');
    } else {
      Object.assign(timer, { phase: 'idle', running: false, segStart: null, acc: 0, sessStart: null });
      alertUser('쉬는 시간 끝', '다음 집중을 시작해요');
    }
  }
  if (changed) { saveTimer(); render(); ctx.onTimer(); return; }
  if (timer.phase === 'focus' && timer.running && Date.now() - lastLive > LIVE_EVERY) live(true);
  renderClock();
  ctx.onTimer();
}
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

function beep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach(t => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, ac.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.18);
      o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.2);
    });
    setTimeout(() => ac.close().catch(() => {}), 1200);
  } catch { /* 소리 못 냄 */ }
}
function alertUser(title, body) {
  beep();
  ctx.toast(`${title} · ${body}`);
  try {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
      navigator.serviceWorker.ready.then(reg => reg.showNotification(title, { body, tag: 'study-timer', data: { url: './#study' } })).catch(() => {});
    }
  } catch { /* 무시 */ }
}

// 지금 타이머 상태 (상단 작은 표시용)
export function timerSummary() {
  if (timer.phase === 'idle') return null;
  const el = elapsed();
  const shown = isPomo() ? Math.max(0, phaseLength() - el) : el;
  return {
    text: clock(shown, !isPomo()),
    rest: timer.phase === 'rest',
    paused: !timer.running,
    label: timer.label || timer.subject || '',
  };
}
function clock(ms, withHours) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return withHours || hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

// 과제·시험에서 "이걸로 공부 시작"
export function startFor(task) {
  if (timer.phase !== 'idle') {
    ctx.toast('이미 타이머가 돌고 있어요. 끝내고 다시 시작해 주세요');
    return;
  }
  selectWhat({ subject: task.subject || '', taskId: task.id, planId: null, label: displayTitle(task) });
  start();
}
function selectWhat(w) {
  Object.assign(timer, { subject: w.subject || '', taskId: w.taskId || null, planId: w.planId || null, label: w.label || '' });
  saveTimer(); render();
}

/* ───── 계획 ───── */
async function savePlan(p) {
  const i = study.plans.findIndex(x => x.id === p.id);
  if (i >= 0) study.plans[i] = p; else study.plans.push(p);
  render();
  try { await api.studyPlan(state.code, p); }
  catch (e) { ctx.toast(errText(e)); loadStudy(); }
}
function removePlan(p) {
  study.plans = study.plans.filter(x => x.id !== p.id);
  render();
  api.studyPlanRemove(state.code, p.id).catch(e => ctx.toast(errText(e)));
  ctx.toast(`"${p.title}" 계획을 지웠어요`, '되돌리기', () => {
    study.plans.push(p); render();
    api.studyPlanRemove(state.code, p.id, false).catch(e => ctx.toast(errText(e)));
  });
}
function autoCompletePlan(planId) {
  const p = planId && study.plans.find(x => x.id === planId);
  if (p && !p.done && p.minutes && planProgress(p) >= p.minutes * 60) {
    savePlan({ ...p, done: true });
    ctx.toast(`"${p.title}" 계획을 다 채웠어요`);
  }
}
// 받아 온 기간(최근 2주) 밖의 기록은 서버 날짜별 합계도 같이 고친다
function adjustDaily(s, sign) {
  if (study.windowStart && new Date(s.startedAt) >= study.windowStart) return;
  const k = studyKey(s.startedAt);
  study.daily.set(k, Math.max(0, (study.daily.get(k) || 0) + sign * s.seconds));
}
function removeSession(s) {
  const wasMain = study.sessions.some(x => x.id === s.id);
  study.sessions = study.sessions.filter(x => x.id !== s.id);
  const wasExtra = study.extra.delete(s.id);
  if (wasExtra && !wasMain) adjustDaily(s, -1);
  queue = queue.filter(x => x.id !== s.id); saveQueue();
  render();
  api.studyRemove(state.code, s.id).catch(e => ctx.toast(errText(e)));
  ctx.toast(`${fmtSpent(s.seconds)} 기록을 지웠어요`, '되돌리기', () => {
    if (wasMain) study.sessions.push(s);
    if (wasExtra) { study.extra.set(s.id, s); if (!wasMain) adjustDaily(s, 1); }
    render();
    api.studyRemove(state.code, s.id, false).catch(e => ctx.toast(errText(e)));
  });
}

/* ───── 화면 ─────
   오늘: 왼쪽 = 무엇을 공부할지(타이머, 계획), 오른쪽 = 그날 타임라인
   기록: 주간(요일별 띠) · 월간(달력), 고른 날의 타임라인과 기록 */
let builtFor = null;
const el = {};
const rec = { mode: 'week', anchor: null, day: null };
const loadedRanges = new Set();
const studyView = () => (state.prefs.studyView === 'records' ? 'records' : 'today');

// DOM의 append/replaceChildren은 null을 "null" 글자로 넣으므로 걸러서
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter(k => k != null && k !== false));

const SVGNS = 'http://www.w3.org/2000/svg';
function svgIcon(d, filled = false) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('aria-hidden', 'true');
  if (filled) s.classList.add('filled');
  for (const path of d) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', path); s.append(p); }
  return s;
}
const playIcon = () => svgIcon(['M7 5.2v9.6l7.6-4.8z'], true);
const pauseIcon = () => svgIcon(['M6.5 5h2.2v10H6.5zM11.3 5h2.2v10h-2.2z'], true);
const stopIcon = () => svgIcon(['M5.5 5.5h9v9h-9z'], true);
const skipIcon = () => svgIcon(['M5 5.2v9.6l7-4.8zM13.5 5h2v10h-2z'], true);
const plusIcon = () => svgIcon(['M10 4.5v11M4.5 10h11']);
const watchIcon = () => svgIcon(['M10 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM10 8v3l2 1.4M8.3 2.8h3.4M15 5.5l1.2-1.2']);
const copyIcon = () => svgIcon(['M7 7h9v9H7zM4 13V4h9']);
const userPlusIcon = () => svgIcon(['M8 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.8 16.5c.6-3 2.6-4.6 5.2-4.6s4.1 1 4.9 3M15.5 10v5M13 12.5h5']);
const xIcon = () => svgIcon(['M6 6l8 8M14 6l-8 8']);
const checkIcon = () => svgIcon(['M5.5 10.5l3 3 6-7']);
const prevIcon = () => svgIcon(['M12 5l-5 5 5 5']);
const nextIcon = () => svgIcon(['M8 5l5 5-5 5']);

function subjectSelect(id, value) {
  return h('select', { id, 'aria-label': '과목' },
    h('option', { value: '' }, '과목 없음'),
    currentSubjects().map(n => h('option', { value: n, selected: n === value }, n)));
}
const fmtDay = d => `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;

function build(root) {
  /* 오늘: 타이머 */
  el.modes = h('div', { class: 'segmented timer-modes', role: 'radiogroup', 'aria-label': '타이머 종류' });
  el.phase = h('p', { class: 'timer-phase' });
  el.digits = h('div', { class: 'timer-digits', role: 'timer', 'aria-live': 'off' });
  el.bar = h('i');
  el.what = h('div', { class: 'timer-what' });
  el.controls = h('div', { class: 'timer-controls' });
  el.timerCard = h('section', { class: 'timer-card', 'aria-label': '타이머' },
    el.modes,
    h('div', { class: 'timer-face' }, el.phase, el.digits, h('div', { class: 'timer-bar' }, el.bar)),
    el.what, el.controls);

  /* 오늘: 계획 */
  el.planList = h('ul', { class: 'plan-list' });
  el.planMemo = h('input', { type: 'text', maxlength: 100, placeholder: '메모 (안 적어도 돼요)', 'aria-label': '메모' });
  el.planSubjectWrap = h('span', { class: 'plan-subject' });
  const addPlan = () => {
    const subject = $('#planSubject')?.value || '';
    const memo = el.planMemo.value.trim();
    if (!subject && !memo) { $('#planSubject')?.focus(); ctx.toast('과목을 골라 주세요'); return; }
    // 메모가 없으면 과목 이름을 제목으로 (서버는 제목이 꼭 있어야 함)
    savePlan({ id: newId(), day: studyKey(), title: (memo || subject).slice(0, 100), subject, minutes: null, done: false });
    el.planMemo.value = '';
  };
  el.planMemo.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addPlan(); } });
  el.plans = h('section', { class: 's-plans' },
    h('h3', null, '오늘 공부'),
    el.planList,
    h('div', { class: 'plan-add' }, el.planSubjectWrap, el.planMemo,
      h('button', { class: 'btn icon primary', type: 'button', onclick: addPlan, title: '추가', 'aria-label': '오늘 공부에 추가' }, plusIcon())));

  /* 오늘: 타임라인 */
  el.dayHead = h('div', { class: 'tl-head' });
  el.timeline = h('div', { class: 'tl-wrap' });
  el.manualSubjectWrap = h('span', { class: 'plan-subject' });
  el.manualMinutes = h('input', { type: 'number', min: 1, max: 600, step: 5, value: 30, 'aria-label': '공부한 시간(분)', inputmode: 'numeric' });
  el.manual = h('details', { class: 'more manual' },
    h('summary', { title: '타이머 없이 공부한 시간 넣기' }, '직접 기록'),
    h('div', { class: 'plan-add' }, el.manualSubjectWrap, el.manualMinutes, h('span', { class: 'unit' }, '분'),
      h('button', { class: 'btn icon primary', type: 'button', onclick: addManual, title: '기록', 'aria-label': '기록' }, checkIcon())));

  el.todayRoot = h('div', { class: 'st-today' },
    h('div', { class: 'st-left' }, el.timerCard, el.plans),
    h('aside', { class: 'st-right', 'aria-label': '오늘 타임라인' }, el.dayHead, el.timeline, el.manual));

  /* 기록 */
  el.recModes = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': '기간' });
  el.recTitle = h('button', { type: 'button', class: 'rec-title', title: '이번 기간으로' });
  el.recPrev = h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': '이전' }, prevIcon());
  el.recNext = h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': '다음' }, nextIcon());
  el.recSummary = h('p', { class: 'rec-summary' });
  el.recMain = h('div', { class: 'rec-main' });
  el.recDay = h('aside', { class: 'rec-day', 'aria-label': '고른 날' });
  el.recPrev.addEventListener('click', () => shiftPeriod(-1));
  el.recNext.addEventListener('click', () => shiftPeriod(1));
  el.recTitle.addEventListener('click', () => { rec.anchor = studyDate(); rec.day = studyKey(); renderRecords(); });
  el.recRoot = h('div', { class: 'st-records' },
    h('div', { class: 'rec-bar' }, el.recModes, h('div', { class: 'rec-nav' }, el.recPrev, el.recTitle, el.recNext)),
    el.recSummary,
    h('div', { class: 'rec-grid' }, el.recMain, el.recDay));

  root.replaceChildren(el.todayRoot, el.recRoot);
  builtFor = root;
}

function addManual() {
  const min = Math.round(Number(el.manualMinutes.value));
  if (!(min >= 1 && min <= 600)) { ctx.toast('1분에서 600분 사이로 적어 주세요'); return; }
  const end = Date.now();
  // 오늘(새벽 5시 이후)에 들어가도록, 너무 길면 시작 시각을 오늘 시작으로
  const start = Math.max(dayStart(studyDate()).getTime(), end - min * 60000);
  addSession({
    id: newId(), subject: $('#manualSubject')?.value || '', taskId: null, planId: null,
    startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(),
    seconds: Math.min(min * 60, Math.round((end - start) / 1000) + 60),
  });
  el.manual.open = false;
  ctx.toast(`${fmtSpent(min * 60)} 기록했어요`);
}

export function render() {
  renderFriendsBtn();
  const root = $('#viewStudy');
  if (!root || root.hidden) return;
  if (builtFor !== root) build(root);
  const v = studyView();
  el.todayRoot.hidden = v !== 'today';
  el.recRoot.hidden = v !== 'records';
  if (v === 'today') { renderTimer(); renderPlans(); renderDay(); }
  else renderRecords();
}

/* ───── 타이머 ───── */
function renderTimer() {
  const idle = timer.phase === 'idle';
  el.timerCard.style.setProperty('--c', timer.phase === 'rest' ? 'var(--green)' : subjectColor(timer.subject));
  el.timerCard.dataset.phase = timer.phase;
  el.timerCard.classList.toggle('paused', !idle && !timer.running);

  el.modes.replaceChildren(...MODES.map(m => h('button', {
    type: 'button', role: 'radio', 'aria-checked': m.key === timer.mode ? 'true' : 'false', disabled: !idle,
    title: m.title, 'aria-label': m.title,
    onclick: () => { timer.mode = m.key; saveTimer(); render(); },
  }, m.key === 'watch' ? watchIcon() : m.label)));

  // 지금 고른 공부 (고르지 않았으면 과목 없이)
  const what = timer.label || timer.subject;
  el.what.hidden = !what && idle;
  fill(el.what, what || !idle ? h('p', { class: 'timer-now', style: { '--c': subjectColor(timer.subject) } },
    h('i', { class: 'tab' }),
    what || '과목 없이 공부 중',
    timer.label && timer.subject && !timer.label.includes(timer.subject) ? h('span', { class: 'chip-sub' }, timer.subject) : null,
    idle ? h('button', {
      type: 'button', class: 'btn icon ghost sm-icon', title: '고른 것 지우기', 'aria-label': '고른 것 지우기',
      onclick: () => selectWhat({ subject: '' }),
    }, xIcon()) : null) : null);

  const b = (icon, label, onclick, cls = '') => h('button', { type: 'button', class: `tc-btn ${cls}`, onclick, title: label, 'aria-label': label }, icon);
  if (idle) el.controls.replaceChildren(b(playIcon(), '시작 (Space)', start, 'main'));
  else if (timer.phase === 'rest') el.controls.replaceChildren(b(skipIcon(), '쉬는 시간 끝내기', toIdle));
  else if (timer.running) el.controls.replaceChildren(b(pauseIcon(), '일시정지 (Space)', pause, 'main'), b(stopIcon(), '끝내기', stop));
  else el.controls.replaceChildren(b(playIcon(), '계속 (Space)', resume, 'main'), b(stopIcon(), '끝내기', stop));
  renderClock();
}

let lastTimelineMin = 0;
function renderClock() {
  if (builtFor == null || $('#viewStudy')?.hidden || studyView() !== 'today') return;
  const idle = timer.phase === 'idle';
  const len = phaseLength();
  const el0 = idle ? 0 : elapsed();
  const shown = isPomo() ? Math.max(0, (idle ? modeOf().focus * 60000 : len) - el0) : el0;
  el.digits.textContent = clock(shown, !isPomo());
  el.phase.textContent = idle ? (isPomo() ? `${modeOf().focus}분 집중 · ${modeOf().rest}분 휴식` : '스톱워치')
    : timer.phase === 'rest' ? '쉬는 시간'
    : !timer.running ? '멈춤'
    : `집중 · ${fmtClock(new Date(timer.sessStart || Date.now()))}부터`;
  el.bar.style.width = isPomo() && !idle ? `${Math.min(100, (el0 / len) * 100)}%` : '0%';
  const t = $('#todayTotal');
  if (t) t.textContent = fmtSpent(todaySeconds());
  const g = $('#todayGoalBar');
  if (g) g.style.width = `${Math.min(100, todaySeconds() / (study.goal * 60) * 100)}%`;
  // 타임라인은 1분마다 (지금 공부 중인 막대가 자라도록)
  const m = Math.floor(Date.now() / 60000);
  if (m !== lastTimelineMin) { lastTimelineMin = m; renderTimeline(); }
}

/* ───── 오늘 공부: 내가 넣은 것 + D-7 안의 일정 ───── */
function renderPlans() {
  const today = studyKey();
  const idle = timer.phase === 'idle';
  const plans = study.plans.filter(p => p.day === today);
  el.planSubjectWrap.replaceChildren(subjectSelect('planSubject', $('#planSubject')?.value ?? ''));
  const playBtn = (label, w) => idle ? h('button', {
    type: 'button', class: 'btn icon ghost sm-icon play', title: '공부 시작', 'aria-label': `${label} 공부 시작`,
    onclick: () => { selectWhat(w); start(); },
  }, playIcon()) : h('span', { class: 'sm-icon' });

  const mine = plans.map(p => {
    const memo = p.title && p.title !== p.subject ? p.title : '';
    const spent = planProgress(p);
    const now = !idle && timer.planId === p.id;
    return h('li', { class: `plan${now ? ' now' : ''}`, style: { '--c': subjectColor(p.subject) } },
      h('span', { class: 'plan-subj' }, p.subject || memo || '공부'),
      h('span', { class: 'plan-memo' }, p.subject ? memo : ''),
      h('span', { class: 'plan-time' }, spent ? fmtSpent(spent) : ''),
      playBtn(p.subject || memo, { subject: p.subject, planId: p.id, label: memo ? `${p.subject ? `${p.subject} · ` : ''}${memo}` : '' }),
      h('button', { type: 'button', class: 'btn icon ghost sm-icon row-x', title: '지우기', 'aria-label': `${p.subject || memo} 지우기`, onclick: () => removePlan(p) }, xIcon()));
  });

  // 7일 안의 과제 · 시험 (최근 2주 그 과목 공부 시간)
  const now = new Date();
  const since = dayStart(addDays(studyDate(), -13));
  const soon = state.tasks
    .filter(t => !t.done && new Date(t.due) > now && Math.round((startOfDay(new Date(t.due)) - startOfDay(now)) / DAY) <= 7)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  const upcoming = soon.map(t => {
    let sec = t.subject ? allSessions().filter(s => s.subject === t.subject && new Date(s.startedAt) >= since).reduce((a, s) => a + s.seconds, 0) : 0;
    if (timer.phase === 'focus' && t.subject && timer.subject === t.subject) sec += runningFocusSec();
    const nowT = !idle && timer.taskId === t.id;
    return h('li', { class: `plan soon${isExam(t) ? ' exam' : ''}${nowT ? ' now' : ''}`, style: { '--c': subjectColor(t.subject) } },
      h('button', { type: 'button', class: 'plan-subj link', onclick: () => ctx.openTask(t) }, displayTitle(t)),
      h('span', { class: 'plan-dday' }, dday(t, now).label),
      h('span', { class: 'plan-time', title: '최근 2주 이 과목 공부' }, sec ? fmtSpent(sec) : ''),
      playBtn(displayTitle(t), { subject: t.subject, taskId: t.id, label: displayTitle(t) }),
      h('span', { class: 'sm-icon' }));
  });

  fill(el.planList, mine, upcoming,
    !mine.length && !upcoming.length ? h('li', { class: 'empty' }, '과목을 골라 넣어 두면 ▶로 바로 시작할 수 있어요.') : null);
}

/* ───── 오늘 타임라인 ───── */
function renderDay() {
  const sec = todaySeconds();
  const goalSel = h('select', {
    class: 'goal-select', 'aria-label': '하루 목표',
    onchange: async e => {
      const v = Number(e.target.value);
      study.goal = v; render();
      try { await api.studyGoal(state.code, v); } catch (err) { ctx.toast(errText(err)); }
    },
  }, [...new Set([...GOALS, study.goal])].sort((a, b) => a - b)
    .map(m => h('option', { value: m, selected: m === study.goal }, `목표 ${fmtSpent(m * 60)}`)));
  fill(el.dayHead,
    h('div', { class: 'today-head' }, h('p', { class: 'today-total', id: 'todayTotal' }, fmtSpent(sec)), goalSel),
    h('div', { class: 'goal-bar' }, h('i', { id: 'todayGoalBar', style: { width: `${Math.min(100, sec / (study.goal * 60) * 100)}%` } })),
    study.error ? h('p', { class: 'msg err' }, study.error) : null);
  el.manualSubjectWrap.replaceChildren(subjectSelect('manualSubject', $('#manualSubject')?.value ?? timer.subject));
  renderTimeline();
}
function renderTimeline() {
  if (!el.timeline) return;
  const today = studyDate();
  el.timeline.replaceChildren(timeline(today, segmentsOn(dayKey(today), true), { showNow: true }));
}

// 그날 막대들: 기록 + (오늘이면) 지금 돌고 있는 타이머
function segmentsOn(key, withLive) {
  const titleOf = s => {
    if (s.planId) { const p = study.plans.find(x => x.id === s.planId); if (p) return p.title; }
    if (s.taskId) { const t = state.tasks.find(x => x.id === s.taskId); if (t) return displayTitle(t); }
    return s.subject || '과목 없음';
  };
  const segs = sessionsOn(key).map(s => ({
    start: new Date(s.startedAt), end: new Date(s.endedAt), subject: s.subject, title: titleOf(s), seconds: s.seconds,
  }));
  if (withLive && timer.phase === 'focus' && timer.sessStart) {
    const end = timer.running ? Date.now() : timer.sessStart + timer.acc;
    segs.push({ start: new Date(timer.sessStart), end: new Date(end), subject: timer.subject, title: timer.label || timer.subject || '공부 중', live: true });
  }
  return segs;
}

// 한 시간이 한 줄, 줄 안에서 0~60분 위치에 막대
function timeline(date, segs, { showNow = false } = {}) {
  const mid = date.getTime();
  const toH = t => (t.getTime() - mid) / 3.6e6;
  let lo = 8, hi = 26;                        // 기본 08시 ~ 다음 날 02시
  for (const s of segs) { lo = Math.min(lo, Math.floor(toH(s.start))); hi = Math.max(hi, Math.ceil(toH(s.end))); }
  const nowH = toH(new Date());
  if (showNow) { lo = Math.min(lo, Math.floor(nowH)); hi = Math.max(hi, Math.floor(nowH) + 1); }
  lo = Math.max(5, lo); hi = Math.min(29, hi);
  const label = hr => (hr < 24 ? String(hr) : hr === 24 ? '24' : pad(hr - 24));
  const rows = [];
  for (let hr = lo; hr < hi; hr++) {
    const pieces = [];
    for (const s of segs) {
      const a = Math.max(toH(s.start), hr), b = Math.min(toH(s.end), hr + 1);
      if (b <= a || (b - a < 1 / 60 && !s.live)) continue;   // 1분도 안 걸친 조각은 점처럼 보여서 생략 (지금 공부 중은 표시)
      pieces.push(h('i', {
        class: `tl-seg${s.live ? ' live' : ''}`,
        style: { '--c': subjectColor(s.subject), left: `${(a - hr) * 100}%`, width: `${Math.max(2.5, (b - a) * 100)}%` },
        title: `${s.title} · ${fmtClock(s.start)}–${fmtClock(s.end)}`,
      }));
    }
    const now = showNow && nowH >= hr && nowH < hr + 1
      ? h('b', { class: 'tl-now', style: { left: `${(nowH - hr) * 100}%` } }) : null;
    rows.push(h('li', { class: `tl-row${hr % 6 === 0 ? ' dash' : ''}` },
      h('span', { class: 'tl-h' }, label(hr)),
      h('span', { class: 'tl-track' }, pieces, now)));
  }
  return h('ol', { class: 'timeline', 'aria-label': `${fmtDay(date)} 공부 타임라인` }, rows);
}

/* ───── 기록 ───── */
function period() {
  const a = rec.anchor || studyDate();
  if (rec.mode === 'month') {
    const start = new Date(a.getFullYear(), a.getMonth(), 1);
    return { start, end: new Date(a.getFullYear(), a.getMonth() + 1, 1) };
  }
  const start = startOfWeek(a);
  return { start, end: addDays(start, 7) };
}
function shiftPeriod(dir) {
  const a = rec.anchor || studyDate();
  rec.anchor = rec.mode === 'month' ? new Date(a.getFullYear(), a.getMonth() + dir, 1) : addDays(a, 7 * dir);
  const { start, end } = period();
  const today = studyDate();
  // 고른 날을 새 기간 안으로 (이번 기간이면 오늘, 아니면 마지막 날)
  rec.day = today >= start && today < end ? dayKey(today) : dayKey(addDays(end, -1));
  renderRecords();
}
function periodTitle({ start, end }) {
  if (rec.mode === 'month') return `${start.getFullYear()}년 ${start.getMonth() + 1}월`;
  const last = addDays(end, -1);
  return start.getMonth() === last.getMonth()
    ? `${start.getMonth() + 1}월 ${start.getDate()}일 – ${last.getDate()}일`
    : `${start.getMonth() + 1}월 ${start.getDate()}일 – ${last.getMonth() + 1}월 ${last.getDate()}일`;
}

// 받아 온 범위(최근 2주)보다 이전이면 서버에서 그 기간 기록을 더 불러온다
async function ensureRange(start, end) {
  if (!state.code || !study.windowStart) return;
  const from = dayStart(start), to = dayStart(end);
  if (from >= study.windowStart) return;
  const key = `${dayKey(start)}~${dayKey(end)}`;
  if (loadedRanges.has(key)) return;
  loadedRanges.add(key);
  try {
    const list = await api.studyRange(state.code, from.toISOString(), to.toISOString());
    for (const s of list || []) study.extra.set(s.id, s);
    renderRecords();
  } catch (e) {
    loadedRanges.delete(key);
    ctx.toast(errText(e));
  }
}

function renderRecords() {
  if (builtFor == null || studyView() !== 'records') return;
  const p = period();
  const today = studyDate();
  if (!rec.day) rec.day = dayKey(today);
  ensureRange(p.start, p.end);

  el.recModes.replaceChildren(...[['week', '주간'], ['month', '월간']].map(([k, l]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': rec.mode === k ? 'true' : 'false',
    onclick: () => { rec.mode = k; rec.anchor = rec.day ? new Date(`${rec.day}T00:00`) : today; renderRecords(); },
  }, l)));
  el.recTitle.textContent = periodTitle(p);
  el.recNext.disabled = p.end > today;

  const m = dailyMap();
  const days = [];
  for (let d = p.start; d < p.end; d = addDays(d, 1)) days.push(d);
  const past = days.filter(d => d <= today);
  const total = past.reduce((a, d) => a + (m.get(dayKey(d)) || 0), 0);
  const studied = past.filter(d => m.get(dayKey(d))).length;
  fill(el.recSummary,
    h('b', null, fmtSpent(total)),
    past.length ? h('span', null, `하루 평균 ${fmtSpent(Math.round(total / past.length))}`) : null,
    h('span', null, `${studied}일 공부`),
    p.end > today && streak(m) > 1 ? h('span', null, `${streak(m)}일 연속`) : null);

  // 기간 안 과목별 시간 (기록을 불러온 경우)
  const inPeriod = allSessions().filter(s => { const k = studyKey(s.startedAt); return k >= dayKey(p.start) && k < dayKey(p.end); });
  const subj = bySubjectOf(inPeriod);
  const max = Math.max(1, ...subj.map(([, v]) => v));
  const subjects = subj.length ? h('ul', { class: 'subject-bars' }, subj.map(([name, v]) => h('li', { style: { '--c': subjectColor(name) } },
    h('span', { class: 'sb-name' }, name || '과목 없음'),
    h('span', { class: 'sb-bar' }, h('i', { style: { width: `${(v / max) * 100}%` } })),
    h('span', { class: 'sb-time' }, fmtSpent(v))))) : null;

  fill(el.recMain, rec.mode === 'month' ? monthGrid(p, m, today) : weekStrips(days, m, today), subjects);
  renderRecDay();
}

function bySubjectOf(list) {
  const map = new Map();
  for (const s of list) map.set(s.subject || '', (map.get(s.subject || '') || 0) + s.seconds);
  return [...map.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}

// 주간: 하루가 한 줄, 새벽 5시 ~ 다음 날 5시 띠 위에 공부한 시간
function weekStrips(days, m, today) {
  const ticks = [6, 9, 12, 15, 18, 21, 24, 27];
  const pos = hr => `${((hr - 5) / 24) * 100}%`;
  return h('div', { class: 'week-strips' },
    h('div', { class: 'ws-axis', 'aria-hidden': 'true' }, h('span'), h('span', { class: 'ws-ticks' },
      ticks.map(t => h('span', { style: { left: pos(t) } }, t <= 24 ? String(t) : pad(t - 24)))), h('span')),
    h('ul', null, days.map(d => {
      const key = dayKey(d);
      const mid = d.getTime();
      const segs = segmentsOn(key, key === dayKey(today));
      const sec = m.get(key) || 0;
      return h('li', null, h('button', {
        type: 'button', class: `ws-row${key === rec.day ? ' sel' : ''}${key === dayKey(today) ? ' today' : ''}${d > today ? ' future' : ''}`,
        disabled: d > today, onclick: () => { rec.day = key; renderRecords(); },
        'aria-label': `${fmtDay(d)} ${fmtSpent(sec)}`,
      },
      h('span', { class: 'ws-day' }, h('b', null, WEEK[d.getDay()]), h('span', null, `${d.getMonth() + 1}/${d.getDate()}`)),
      h('span', { class: 'ws-track' },
        ticks.map(t => h('span', { class: 'ws-grid', style: { left: pos(t) } })),
        segs.map(s => {
          const a = Math.max(5, (s.start - mid) / 3.6e6), b = Math.min(29, (s.end - mid) / 3.6e6);
          return b > a ? h('i', { class: s.live ? 'live' : '', style: { '--c': subjectColor(s.subject), left: pos(a), width: `${Math.max(0.6, ((b - a) / 24) * 100)}%` } }) : null;
        })),
      h('span', { class: 'ws-total' }, sec ? fmtSpent(sec) : '')));
    })));
}

// 월간: 달력, 목표 대비 공부한 만큼 진하게
function monthGrid({ start, end }, m, today) {
  const first = startOfWeek(start);
  const cells = [];
  for (let d = first; d < end || cells.length % 7; d = addDays(d, 1)) cells.push(d);
  const goal = study.goal * 60;
  return h('div', { class: 'month-grid' },
    h('div', { class: 'mg-head' }, ['월', '화', '수', '목', '금', '토', '일'].map(w => h('span', null, w))),
    h('div', { class: 'mg-body' }, cells.map(d => {
      const key = dayKey(d);
      const sec = m.get(key) || 0;
      const r = sec / goal;
      const lv = !sec ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 1 ? 3 : 4;
      const out = d < start || d >= end;
      return h('button', {
        type: 'button', class: `mg-day lv${lv}${out ? ' out' : ''}${key === rec.day ? ' sel' : ''}${key === dayKey(today) ? ' today' : ''}`,
        disabled: d > today, onclick: () => { rec.day = key; if (out) rec.anchor = d; renderRecords(); },
        'aria-label': `${fmtDay(d)} ${fmtSpent(sec)}`,
      }, h('span', { class: 'mg-n' }, d.getDate()), sec ? h('span', { class: 'mg-t' }, fmtSpent(sec, { short: true })) : null);
    })));
}

function renderRecDay() {
  const date = new Date(`${rec.day}T00:00`);
  const isToday = rec.day === studyKey();
  const segs = segmentsOn(rec.day, isToday);
  const list = sessionsOn(rec.day).slice().sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const sec = (dailyMap().get(rec.day) || 0);
  const titleOf = s => {
    if (s.planId) { const p = study.plans.find(x => x.id === s.planId); if (p) return p.title; }
    if (s.taskId) { const t = state.tasks.find(x => x.id === s.taskId); if (t) return displayTitle(t); }
    return null;
  };
  fill(el.recDay,
    h('div', { class: 'rd-head' }, h('h3', null, isToday ? `오늘 · ${fmtDay(date)}` : fmtDay(date)), h('b', null, fmtSpent(sec))),
    timeline(date, segs, { showNow: isToday }),
    list.length ? h('ul', { class: 'record-list' }, list.map(s => {
      const what = titleOf(s);
      return h('li', { style: { '--c': subjectColor(s.subject) } },
        h('span', { class: 'rec-time' }, `${fmtClock(new Date(s.startedAt))}–${fmtClock(new Date(s.endedAt))}`),
        h('span', { class: 'rec-what' }, what || s.subject || '과목 없음', what && s.subject ? h('span', { class: 'chip-sub' }, s.subject) : null),
        h('span', { class: 'rec-len' }, fmtSpent(s.seconds)),
        h('button', { type: 'button', class: 'btn icon ghost sm-icon row-x', title: '기록 지우기', 'aria-label': '기록 지우기', onclick: () => removeSession(s) }, xIcon()));
    })) : h('p', { class: 'muted' }, sec ? '불러오는 중…' : '이날은 공부 기록이 없어요.'));
}

/* ───── 친구 (위쪽 버튼 → 창) ───── */
let friendMsg = { text: '', err: false };
function setFriendMsg(text, err = false) { friendMsg = { text, err }; renderFriends(); }

async function friendAction(fn, ok) {
  try { await fn(); if (ok) setFriendMsg(ok); else renderFriends(); }
  catch (e) { setFriendMsg(errText(e), true); }
}

function renderFriendsBtn() {
  const badge = $('#friendsLive');
  if (!badge) return;
  const n = study.profile && study.profile.visible ? study.friends.filter(f => f.liveSince).length : 0;
  badge.hidden = !n;
  badge.textContent = n;
  const btn = $('#btnFriends');
  if (btn) btn.title = n ? `친구 ${n}명 공부 중` : '친구';
}

export async function openFriends() {
  friendMsg = { text: '', err: false };
  renderFriends();
  const d = $('#friendsDialog');
  if (d && !d.open) d.showModal();
  if (!study.loaded) await loadStudy();
  await loadFriends();
}

function renderFriends() {
  renderFriendsBtn();
  const body = $('#friendsBody');
  if (!body) return;
  const msg = friendMsg.text ? h('p', { class: `msg${friendMsg.err ? ' err' : ' ok'}`, role: 'status' }, friendMsg.text) : null;
  const p = study.profile;

  if (!p || !p.visible) {
    const nick = h('input', { type: 'text', maxlength: 20, placeholder: '닉네임', 'aria-label': '닉네임', value: p ? p.nickname : '' });
    const go = () => friendAction(async () => {
      study.profile = await api.studyProfile(state.code, nick.value);
      await loadFriends();
    }, p ? '다시 공개했어요' : '친구 코드를 만들었어요. 친구에게 알려 주세요');
    nick.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) go(); });
    fill(body,
      h('p', { class: 'help' }, p ? '지금은 친구에게 공부 시간을 보여 주지 않고 있어요.'
        : '닉네임을 정하면 친구 코드가 생겨요. 코드를 주고받으면 서로 오늘 공부한 시간과 지금 공부 중인지 볼 수 있어요. 과목이나 계획은 보이지 않아요.'),
      h('div', { class: 'inline-form' }, nick, h('button', { type: 'button', class: 'btn primary', onclick: go }, p ? '다시 공개' : '시작하기')),
      msg);
    return;
  }

  const me = { me: true, nickname: p.nickname, today: todaySeconds(), liveSince: timer.phase === 'focus' && timer.running ? new Date(timer.sessStart).toISOString() : null };
  const rows = [me, ...study.friends].sort((a, b) => b.today - a.today);
  const top = Math.max(1, ...rows.map(r => r.today));
  const code = h('input', { type: 'text', maxlength: 12, placeholder: '친구 코드', 'aria-label': '친구 코드', class: 'code-input', autocomplete: 'off', spellcheck: 'false' });
  const add = () => friendAction(async () => {
    if (!code.value.trim()) throw new Error('friend_not_found');
    const before = study.friends.length;
    study.friends = await api.friendAdd(state.code, code.value);
    code.value = '';
    friendMsg = { text: study.friends.length === before ? '이미 추가한 친구예요' : '친구를 추가했어요', err: false };
  });
  code.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) add(); });

  const newNick = h('input', { type: 'text', maxlength: 20, value: p.nickname, 'aria-label': '새 닉네임' });
  let armed = null;
  const newCodeBtn = h('button', { type: 'button', class: 'btn sm' }, '코드 새로 만들기');
  newCodeBtn.addEventListener('click', () => {
    if (!armed) {
      newCodeBtn.textContent = '한 번 더 누르면 바뀌어요';
      armed = setTimeout(() => { armed = null; newCodeBtn.textContent = '코드 새로 만들기'; }, 3000);
      return;
    }
    clearTimeout(armed); armed = null;
    friendAction(async () => { study.profile = await api.studyNewCode(state.code); }, '새 코드를 만들었어요. 이전 코드로 나를 추가한 친구는 더 이상 볼 수 없어요');
  });

  fill(body,
    h('div', { class: 'inline-form' }, code, h('button', { type: 'button', class: 'btn icon primary', onclick: add, title: '친구 추가', 'aria-label': '친구 추가' }, userPlusIcon())),
    msg,
    h('ul', { class: 'friend-list' }, rows.map(r => {
      const liveMin = r.liveSince ? Math.max(0, Math.floor((Date.now() - new Date(r.liveSince)) / 60000)) : null;
      return h('li', { class: r.me ? 'me' : '' },
        h('span', { class: `f-dot${r.liveSince ? ' live' : ''}`, title: r.liveSince ? '공부 중' : '' }),
        h('span', { class: 'f-name' }, r.me ? `${r.nickname} (나)` : r.nickname,
          r.liveSince ? h('span', { class: 'f-live' }, `공부 중 ${liveMin}분째`) : null),
        h('span', { class: 'f-bar' }, h('i', { style: { width: `${(r.today / top) * 100}%` } })),
        h('span', { class: 'f-time' }, fmtSpent(r.today)),
        r.me ? h('span', { class: 'f-x' }) : h('button', {
          type: 'button', class: 'btn icon ghost sm-icon row-x f-x', title: '친구 빼기', 'aria-label': `${r.nickname} 친구 빼기`,
          onclick: () => friendAction(async () => {
            study.friends = await api.friendRemove(state.code, r.code);
          }, `${r.nickname} 님을 친구에서 뺐어요`),
        }, xIcon()));
    })),
    rows.length === 1 ? h('p', { class: 'help fine' }, '친구 코드를 넣으면 여기에 오늘 공부 시간이 함께 보여요.') : null,
    h('div', { class: 'my-code' },
      h('span', null, '내 친구 코드'),
      h('b', { class: 'code' }, p.friendCode),
      h('button', {
        type: 'button', class: 'btn icon ghost sm-icon', title: '내 코드 복사', 'aria-label': '내 코드 복사',
        onclick: async () => {
          try { await navigator.clipboard.writeText(p.friendCode); setFriendMsg('내 코드를 복사했어요'); }
          catch { setFriendMsg(`내 코드: ${p.friendCode}`); }
        },
      }, copyIcon())),
    h('details', { class: 'more friend-manage' },
      h('summary', null, '관리'),
      h('div', { class: 'inline-form' }, newNick, h('button', {
        type: 'button', class: 'btn sm',
        onclick: () => friendAction(async () => { study.profile = await api.studyProfile(state.code, newNick.value); }, '닉네임을 바꿨어요'),
      }, '닉네임 바꾸기')),
      h('div', { class: 'row-actions start' },
        newCodeBtn,
        h('button', {
          type: 'button', class: 'btn sm danger ghost',
          onclick: () => friendAction(async () => { study.profile = await api.studyProfileHide(state.code); study.friends = []; }, '친구에게 더 이상 보이지 않아요'),
        }, '공개 그만하기')),
      h('p', { class: 'help fine' }, '친구는 내 코드를 넣은 사람이에요. 코드를 새로 만들면 지금까지 나를 추가한 사람은 더 이상 내 기록을 못 봐요.')),
  );
}

/* ───── 시작 ───── */
export function initStudy(options) {
  ctx = { ...ctx, ...options };
  subscribe(what => {
    if (what === 'board') {
      Object.assign(study, { loaded: false, sessions: [], daily: new Map(), plans: [], profile: null, friends: [], extra: new Map() });
      loadedRanges.clear();
      builtFor = null;
    }
  });
  // 친구 목록은 공부 모드일 때 1분마다 (위쪽 버튼의 "공부 중" 숫자)
  setInterval(() => {
    if (!document.hidden && (!$('#viewStudy')?.hidden || $('#friendsDialog')?.open)) loadFriends();
  }, 60000);
  tick();
}

export function onShowStudy() {
  render();
  loadStudy();
}

export function handleKey(e) {
  if (studyView() !== 'today') return false;
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (timer.phase === 'idle') start();
    else if (timer.phase === 'rest') toIdle();
    else if (timer.running) pause();
    else resume();
    return true;
  }
  return false;
}
