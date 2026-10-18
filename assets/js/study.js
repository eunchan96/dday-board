// 공부 모드: 타이머(뽀모도로 · 스톱워치), 오늘 공부 시간, 공부 계획, 이번 주, 시험까지, 친구
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
  { key: 'p25', label: '25분 집중', focus: 25, rest: 5 },
  { key: 'p50', label: '50분 집중', focus: 50, rest: 10 },
  { key: 'watch', label: '스톱워치' },
];
const GOALS = [60, 120, 180, 240, 300, 360, 480, 600];
const PLAN_MINUTES = [[0, '시간 없이'], [30, '30분'], [60, '1시간'], [90, '1시간 30분'], [120, '2시간'], [180, '3시간']];

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
function sessionsOn(key) {
  return study.sessions.filter(s => studyKey(s.startedAt) === key);
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
function upcomingTasks(limit) {
  const now = new Date();
  return state.tasks
    .filter(t => !t.done && new Date(t.due) > now)
    .sort((a, b) => new Date(a.due) - new Date(b.due))
    .slice(0, limit);
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
function removeSession(s) {
  study.sessions = study.sessions.filter(x => x.id !== s.id);
  queue = queue.filter(x => x.id !== s.id); saveQueue();
  render();
  api.studyRemove(state.code, s.id).catch(e => ctx.toast(errText(e)));
  ctx.toast(`${fmtSpent(s.seconds)} 기록을 지웠어요`, '되돌리기', () => {
    study.sessions.push(s); render();
    api.studyRemove(state.code, s.id, false).catch(e => ctx.toast(errText(e)));
  });
}

/* ───── 화면 ───── */
let built = false;
let showAllSubjects = false;
const el = {};

function subjectSelect(id, value) {
  return h('select', { id, 'aria-label': '과목' },
    h('option', { value: '' }, '과목 없음'),
    currentSubjects().map(n => h('option', { value: n, selected: n === value }, n)));
}

function build(root) {
  el.root = root;
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

  // 오늘
  el.today = h('section', { class: 's-block s-today', 'aria-label': '오늘 공부' });
  el.week = h('section', { class: 's-block s-week' });
  el.exams = h('section', { class: 's-block s-exams' });

  // 친구
  el.friendsBody = h('div', { class: 'friends-body' });
  el.friends = h('section', { class: 's-block s-friends' }, h('h3', null, '친구'), el.friendsBody);

  // 계획
  el.planList = h('ul', { class: 'plan-list' });
  el.planTitle = h('input', { type: 'text', maxlength: 100, placeholder: '오늘 할 공부 (예: 3장 복습)', 'aria-label': '오늘 할 공부' });
  el.planMinutes = h('select', { 'aria-label': '목표 시간' }, PLAN_MINUTES.map(([v, l]) => h('option', { value: v }, l)));
  el.planSubjectWrap = h('span', { class: 'plan-subject' });
  const addPlan = () => {
    const title = el.planTitle.value.trim();
    if (!title) { el.planTitle.focus(); return; }
    const minutes = Number(el.planMinutes.value) || null;
    savePlan({ id: newId(), day: studyKey(), title: title.slice(0, 100), subject: $('#planSubject')?.value || '', minutes, done: false });
    el.planTitle.value = '';
    el.planTitle.focus();
  };
  el.planTitle.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addPlan(); } });
  el.plans = h('section', { class: 's-block s-plans' },
    h('h3', null, '오늘 계획'),
    el.planList,
    h('div', { class: 'plan-add' }, el.planTitle, el.planSubjectWrap, el.planMinutes,
      h('button', { class: 'btn', type: 'button', onclick: addPlan }, '추가')));

  // 기록
  el.recordList = h('ul', { class: 'record-list' });
  el.manualSubjectWrap = h('span');
  el.manualMinutes = h('input', { type: 'number', min: 1, max: 600, step: 5, value: 30, 'aria-label': '공부한 시간(분)', inputmode: 'numeric' });
  el.records = h('section', { class: 's-block s-records' },
    h('h3', null, '오늘 기록'),
    el.recordList,
    h('details', { class: 'more manual' },
      h('summary', null, '타이머 없이 공부한 시간 넣기'),
      h('div', { class: 'plan-add' }, el.manualSubjectWrap, el.manualMinutes, h('span', { class: 'unit' }, '분'),
        h('button', { class: 'btn', type: 'button', onclick: addManual }, '기록'))));

  root.replaceChildren(h('div', { class: 'study-grid' },
    el.timerCard,
    h('div', { class: 'study-side' }, el.today, el.week, el.exams, el.friends),
    el.plans, el.records));
  built = true;
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
  ctx.toast(`${fmtSpent(min * 60)} 기록했어요`);
}

export function render() {
  const root = $('#viewStudy');
  if (!root || root.hidden) return;
  if (!built || el.root !== root) build(root);
  renderTimer(); renderToday(); renderWeek(); renderExams(); renderPlans(); renderRecords(); renderFriends();
}

function renderTimer() {
  const idle = timer.phase === 'idle';
  el.timerCard.style.setProperty('--c', timer.phase === 'rest' ? 'var(--green)' : subjectColor(timer.subject));
  el.timerCard.dataset.phase = timer.phase;
  el.timerCard.classList.toggle('paused', !idle && !timer.running);

  el.modes.replaceChildren(...MODES.map(m => h('button', {
    type: 'button', role: 'radio', 'aria-checked': m.key === timer.mode ? 'true' : 'false', disabled: !idle,
    onclick: () => { timer.mode = m.key; saveTimer(); render(); },
  }, m.label)));

  // 무엇을 공부할지: 가까운 일정 + 과목
  if (idle) {
    const sel = (w, label, extra) => {
      const on = (w.taskId || null) === (timer.taskId || null) && (w.planId || null) === (timer.planId || null)
        && (w.subject || '') === (timer.subject || '');
      return h('button', {
        type: 'button', class: 'chip', 'aria-pressed': on ? 'true' : 'false',
        style: { '--c': subjectColor(w.subject) },
        onclick: () => selectWhat(on ? { subject: '' } : w),
      }, h('i', { class: 'tab' }), label, extra ? h('span', { class: 'chip-sub' }, extra) : null);
    };
    const tasks = upcomingTasks(3);
    const subjects = currentSubjects();
    const shown = showAllSubjects || subjects.length <= 7 ? subjects
      : subjects.slice(0, 6).concat(subjects.includes(timer.subject) && subjects.indexOf(timer.subject) >= 6 ? [timer.subject] : []);
    el.what.replaceChildren(
      ...tasks.map(t => sel({ subject: t.subject, taskId: t.id, label: displayTitle(t) }, displayTitle(t), dday(t).label)),
      ...shown.map(n => sel({ subject: n }, n)),
      ...(shown.length < subjects.length ? [h('button', {
        type: 'button', class: 'chip more-chip', onclick: () => { showAllSubjects = true; renderTimer(); },
      }, `과목 ${subjects.length - shown.length}개 더`)] : []),
    );
    el.what.hidden = !el.what.children.length;
  } else {
    el.what.hidden = false;
    el.what.replaceChildren(h('p', { class: 'timer-now', style: { '--c': subjectColor(timer.subject) } },
      h('i', { class: 'tab' }),
      timer.label || timer.subject || '과목 없이 공부 중',
      timer.label && timer.subject && !timer.label.includes(timer.subject) ? h('span', { class: 'chip-sub' }, timer.subject) : null));
  }

  const b = (label, onclick, cls = '') => h('button', { type: 'button', class: `btn ${cls}`, onclick }, label);
  if (idle) el.controls.replaceChildren(b('시작', start, 'primary big'));
  else if (timer.phase === 'rest') el.controls.replaceChildren(b('쉬는 시간 끝내기', toIdle, 'big'));
  else if (timer.running) el.controls.replaceChildren(b('일시정지', pause, 'big'), b('끝내기', stop, 'big ghost-line'));
  else el.controls.replaceChildren(b('계속', resume, 'primary big'), b('끝내기', stop, 'big ghost-line'));
  renderClock();
}

function renderClock() {
  if (!built || $('#viewStudy')?.hidden) return;
  const idle = timer.phase === 'idle';
  const len = phaseLength();
  const el0 = idle ? 0 : elapsed();
  const shown = isPomo() ? Math.max(0, (idle ? modeOf().focus * 60000 : len) - el0) : el0;
  el.digits.textContent = clock(shown, !isPomo());
  el.phase.textContent = idle ? (timer.label || timer.subject ? `${timer.label || timer.subject}${isPomo() ? ` · ${modeOf().rest}분 쉬고 다시` : ''}` : '무엇을 공부할지 고르고 시작해요')
    : timer.phase === 'rest' ? '쉬는 시간'
    : !timer.running ? '멈춤'
    : `집중 · ${fmtClock(new Date(timer.sessStart || Date.now()))}부터`;
  el.bar.style.width = isPomo() && !idle ? `${Math.min(100, (el0 / len) * 100)}%` : '0%';
  // 오늘 합계도 같이 움직이게
  const t = $('#todayTotal');
  if (t) t.textContent = fmtSpent(todaySeconds());
  const g = $('#todayGoalBar');
  if (g) g.style.width = `${Math.min(100, todaySeconds() / (study.goal * 60) * 100)}%`;
}

function renderToday() {
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
  const subj = bySubject(sessionsOn(studyKey()));
  const max = Math.max(1, ...subj.map(([, v]) => v));
  el.today.replaceChildren(
    h('div', { class: 'today-head' },
      h('p', { class: 'today-total', id: 'todayTotal' }, fmtSpent(sec)),
      goalSel),
    h('div', { class: 'goal-bar' }, h('i', { id: 'todayGoalBar', style: { width: `${Math.min(100, sec / (study.goal * 60) * 100)}%` } })),
    subj.length
      ? h('ul', { class: 'subject-bars' }, subj.map(([name, v]) => h('li', { style: { '--c': subjectColor(name) } },
          h('span', { class: 'sb-name' }, name || '과목 없음'),
          h('span', { class: 'sb-bar' }, h('i', { style: { width: `${(v / max) * 100}%` } })),
          h('span', { class: 'sb-time' }, fmtSpent(v)))))
      : h('p', { class: 'muted' }, study.error ? study.error : study.loaded ? '오늘은 아직 공부 기록이 없어요.' : '불러오는 중…'),
  );
}

function renderWeek() {
  const m = dailyMap();
  const today = studyDate();
  const start = startOfWeek(today);
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const vals = days.map(d => m.get(dayKey(d)) || 0);
  const top = Math.max(study.goal * 60, ...vals, 1);
  const total = vals.reduce((a, b) => a + b, 0);
  const n = streak(m);
  el.week.replaceChildren(
    h('div', { class: 's-head' }, h('h3', null, '이번 주'),
      h('span', { class: 's-aside' }, fmtSpent(total), n > 1 ? ` · ${n}일 연속` : '')),
    h('div', { class: 'week-bars', role: 'img', 'aria-label': `이번 주 공부 ${fmtSpent(total)}` },
      days.map((d, i) => h('div', {
        class: `wb${dayKey(d) === dayKey(today) ? ' today' : ''}${d > today ? ' future' : ''}`,
        title: `${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]}) ${fmtSpent(vals[i])}`,
      },
      h('span', { class: 'wb-col' }, h('i', { style: { height: `${(vals[i] / top) * 100}%` } }),
        h('b', { class: 'wb-goal', style: { bottom: `${(study.goal * 60 / top) * 100}%` } })),
      h('span', { class: 'wb-day' }, WEEK[d.getDay()])))),
  );
}

function renderExams() {
  const now = new Date();
  const exams = state.tasks
    .filter(t => isExam(t) && !t.done && new Date(t.due) > now && new Date(t.due) - now < 21 * DAY)
    .sort((a, b) => new Date(a.due) - new Date(b.due)).slice(0, 4);
  el.exams.hidden = !exams.length;
  if (!exams.length) return;
  const since = dayStart(addDays(studyDate(), -13));
  el.exams.replaceChildren(
    h('div', { class: 's-head' }, h('h3', null, '시험까지'), h('span', { class: 's-aside' }, '최근 2주 공부')),
    h('ul', { class: 'exam-study' }, exams.map(t => {
      let sec = study.sessions.filter(s => t.subject && s.subject === t.subject && new Date(s.startedAt) >= since)
        .reduce((a, s) => a + s.seconds, 0);
      if (timer.phase === 'focus' && t.subject && timer.subject === t.subject) sec += runningFocusSec();
      return h('li', { style: { '--c': subjectColor(t.subject) } },
        h('button', { type: 'button', class: 'es-title', onclick: () => ctx.openTask(t) }, displayTitle(t)),
        h('span', { class: 'es-dday' }, dday(t, now).label),
        h('span', { class: 'es-time' }, sec ? fmtSpent(sec) : '아직 없음'),
        timer.phase === 'idle' ? h('button', {
          type: 'button', class: 'btn icon ghost sm-icon', title: '이 시험 공부 시작', 'aria-label': `${displayTitle(t)} 공부 시작`,
          onclick: () => startFor(t),
        }, playIcon()) : null);
    })));
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgIcon(d) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('aria-hidden', 'true');
  for (const path of d) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', path); s.append(p); }
  return s;
}
const playIcon = () => svgIcon(['M7 5.5v9l7.5-4.5z']);
const xIcon = () => svgIcon(['M6 6l8 8M14 6l-8 8']);
const checkIcon = () => svgIcon(['M5.5 10.5l3 3 6-7']);

function renderPlans() {
  const today = studyKey();
  const weekAgo = dayKey(addDays(studyDate(), -7));
  // 오늘 계획 + 지난 7일 중 못 끝낸 계획
  const list = study.plans
    .filter(p => p.day === today || (!p.done && p.day < today && p.day >= weekAgo))
    .sort((a, b) => (b.day === today) - (a.day === today) || a.done - b.done);
  el.planSubjectWrap.replaceChildren(subjectSelect('planSubject', $('#planSubject')?.value ?? timer.subject));
  el.planList.replaceChildren(...(list.length ? list.map(p => {
    const prog = planProgress(p);
    const past = p.day !== today;
    return h('li', { class: `plan${p.done ? ' done' : ''}`, style: { '--c': subjectColor(p.subject) } },
      h('button', {
        type: 'button', class: 'plan-check', 'aria-pressed': p.done ? 'true' : 'false',
        'aria-label': p.done ? '끝낸 계획 되돌리기' : '끝냄으로 표시',
        onclick: () => savePlan({ ...p, done: !p.done }),
      }, checkIcon()),
      h('div', { class: 'plan-main' },
        h('span', { class: 'plan-title' }, p.title),
        h('span', { class: 'plan-meta' },
          past ? h('span', { class: 'plan-past' }, `${Number(p.day.slice(5, 7))}/${Number(p.day.slice(8))}`) : null,
          p.subject ? h('span', null, p.subject) : null,
          p.minutes ? h('span', { class: 'plan-prog' }, `${fmtSpent(prog)} / ${fmtSpent(p.minutes * 60)}`)
            : prog ? h('span', { class: 'plan-prog' }, fmtSpent(prog)) : null),
        p.minutes ? h('span', { class: 'plan-bar' }, h('i', { style: { width: `${Math.min(100, prog / (p.minutes * 60) * 100)}%` } })) : null),
      past && !p.done ? h('button', { type: 'button', class: 'btn sm ghost', onclick: () => savePlan({ ...p, day: today }) }, '오늘로') : null,
      !p.done && timer.phase === 'idle' ? h('button', {
        type: 'button', class: 'btn icon ghost sm-icon', title: '이 계획 공부 시작', 'aria-label': `${p.title} 공부 시작`,
        onclick: () => { selectWhat({ subject: p.subject, planId: p.id, label: p.title }); start(); },
      }, playIcon()) : null,
      h('button', { type: 'button', class: 'btn icon ghost sm-icon row-x', title: '계획 지우기', 'aria-label': `${p.title} 지우기`, onclick: () => removePlan(p) }, xIcon()));
  }) : [h('li', { class: 'empty' }, '오늘 할 공부를 적어 두면 타이머로 바로 시작할 수 있어요.')]));
}

function renderRecords() {
  el.manualSubjectWrap.replaceChildren(subjectSelect('manualSubject', $('#manualSubject')?.value ?? timer.subject));
  const list = sessionsOn(studyKey()).slice().sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const titleOf = s => {
    if (s.planId) { const p = study.plans.find(x => x.id === s.planId); if (p) return p.title; }
    if (s.taskId) { const t = state.tasks.find(x => x.id === s.taskId); if (t) return displayTitle(t); }
    return null;
  };
  el.recordList.replaceChildren(...(list.length ? list.map(s => {
    const what = titleOf(s);
    return h('li', { style: { '--c': subjectColor(s.subject) } },
      h('span', { class: 'rec-time' }, `${fmtClock(new Date(s.startedAt))}–${fmtClock(new Date(s.endedAt))}`),
      h('span', { class: 'rec-what' }, what || s.subject || '과목 없음', what && s.subject ? h('span', { class: 'chip-sub' }, s.subject) : null),
      h('span', { class: 'rec-len' }, fmtSpent(s.seconds)),
      h('button', { type: 'button', class: 'btn icon ghost sm-icon row-x', title: '기록 지우기', 'aria-label': '기록 지우기', onclick: () => removeSession(s) }, xIcon()));
  }) : [h('li', { class: 'empty' }, '타이머를 끝내면 여기에 쌓여요.')]));
}

/* ───── 친구 ───── */
let friendMsg = { text: '', err: false };
function setFriendMsg(text, err = false) { friendMsg = { text, err }; renderFriends(); }

async function friendAction(fn, ok) {
  try { await fn(); if (ok) setFriendMsg(ok); else renderFriends(); }
  catch (e) { setFriendMsg(errText(e), true); }
}

// DOM의 replaceChildren은 null을 "null" 글자로 넣으므로 걸러서
const fillBody = (node, ...kids) => node.replaceChildren(...kids.flat().filter(k => k != null && k !== false));

function renderFriends() {
  if (!built) return;
  const body = el.friendsBody;
  const msg = friendMsg.text ? h('p', { class: `msg${friendMsg.err ? ' err' : ' ok'}`, role: 'status' }, friendMsg.text) : null;
  const p = study.profile;

  if (!p || !p.visible) {
    const nick = h('input', { type: 'text', maxlength: 20, placeholder: '닉네임', 'aria-label': '닉네임', value: p ? p.nickname : '' });
    const go = () => friendAction(async () => {
      study.profile = await api.studyProfile(state.code, nick.value);
      await loadFriends();
    }, p ? '다시 공개했어요' : '친구 코드를 만들었어요. 친구에게 알려 주세요');
    nick.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) go(); });
    fillBody(body,
      h('p', { class: 'help' }, p ? '지금은 친구에게 공부 시간을 보여 주지 않고 있어요.'
        : '친구 코드를 주고받으면 서로 오늘 공부한 시간과 지금 공부 중인지 볼 수 있어요. 과목이나 계획은 보이지 않아요.'),
      h('div', { class: 'inline-form' }, nick, h('button', { type: 'button', class: 'btn primary', onclick: go }, p ? '다시 공개' : '시작하기')),
      msg);
    return;
  }

  // 나 + 친구들, 오늘 공부한 시간 순
  const me = { me: true, nickname: p.nickname, today: todaySeconds(), liveSince: timer.phase === 'focus' && timer.running ? new Date(timer.sessStart).toISOString() : null };
  const rows = [me, ...study.friends].sort((a, b) => b.today - a.today);
  const top = Math.max(1, ...rows.map(r => r.today));
  const code = h('input', { type: 'text', maxlength: 12, placeholder: '친구 코드', 'aria-label': '친구 코드', class: 'code-input', autocomplete: 'off', spellcheck: 'false' });
  const add = () => friendAction(async () => {
    if (!code.value.trim()) throw new Error('friend_not_found');
    const before = study.friends.length;
    study.friends = await api.friendAdd(state.code, code.value);
    code.value = '';
    if (study.friends.length === before) friendMsg = { text: '이미 추가한 친구예요', err: false };
    else friendMsg = { text: '친구를 추가했어요', err: false };
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

  fillBody(body,
    h('div', { class: 'my-code' },
      h('span', null, '내 코드'),
      h('b', { class: 'code' }, p.friendCode),
      h('button', {
        type: 'button', class: 'btn sm ghost',
        onclick: async () => {
          try { await navigator.clipboard.writeText(p.friendCode); setFriendMsg('복사했어요'); }
          catch { setFriendMsg(`코드: ${p.friendCode}`); }
        },
      }, '복사')),
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
    rows.length === 1 ? h('p', { class: 'help fine' }, '친구 코드를 넣으면 여기에 함께 보여요.') : null,
    h('div', { class: 'inline-form' }, code, h('button', { type: 'button', class: 'btn', onclick: add }, '추가')),
    msg,
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
      Object.assign(study, { loaded: false, sessions: [], daily: new Map(), plans: [], profile: null, friends: [] });
      built = false;
    }
  });
  // 친구 목록은 공부 화면을 보고 있을 때 1분마다
  setInterval(() => {
    if (!document.hidden && !$('#viewStudy')?.hidden) loadFriends();
  }, 60000);
  // 창을 닫으면 "공부 중"을 바로 끄진 못하지만, 일시정지 상태라면 서버는 15분 뒤 저절로 끈다
  tick();
}

export function onShowStudy() {
  built = built && el.root === $('#viewStudy');
  render();
  loadStudy();
}

export function handleKey(e) {
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
