// 공부 모드: 오늘(타이머 · 계획 · 하루 타임라인), 기록(주간 · 월간), 친구
//
// - 하루는 새벽 5시에 바뀐다 (밤새 공부한 시간은 전날로) — 서버(app.study_day)와 같은 기준
// - 타이머는 이 기기에만 저장 (창을 닫았다 열어도 이어짐). 끝낸 공부만 서버에 기록
// - 서버에 못 보낸 기록은 기기에 모아 뒀다가 다음에 다시 보낸다

import { state, storage, subscribe } from './store.js';
import { api, errText } from './api.js';
import { subjectPicker, taskSubjects, rememberSubject } from './subject-picker.js';
import { ambientControl } from './ambient.js';
import { inScope } from './groups.js';
import { initPip, togglePip, pipSupported, pipOpen, renderPip } from './pip.js';
import {
  $, h, pad, newId, dayKey, addDays, startOfWeek, startOfDay, WEEK, DAY,
  subjectColor, displayTitle, dday, isExam, semesterOf, semesterKey, taskSemesterKey, fmtClock, orderSubjects,
} from './util.js';

const KEYS = { timer: 'ddayboard.timer', queue: 'ddayboard.studyQueue' };
const DAY_SHIFT = 5 * 3600 * 1000;           // 새벽 5시
const MIN_SAVE = 60;                          // 1분 미만은 기록하지 않음
const WATCH_MAX = 12 * 3600 * 1000;           // 스톱워치를 켜 둔 채 잊은 경우
const LIVE_EVERY = 5 * 60 * 1000;
const MODES = [
  { key: 'watch', label: '', title: '스톱워치' },
  { key: 'p25', label: '25분', title: '25분 집중 · 5분 휴식', focus: 25, rest: 5 },
  { key: 'p50', label: '50분', title: '50분 집중 · 10분 휴식', focus: 50, rest: 10 },
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
  requests: { incoming: [], outgoing: [] },
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
  try {
    const [list, req] = await Promise.all([api.friends(state.code), api.friendRequests(state.code).catch(() => null)]);
    study.friends = list || [];
    if (req) study.requests = { incoming: req.incoming || [], outgoing: req.outgoing || [] };
    study.friendsError = null;
  } catch (e) { study.friendsError = errText(e); }
  renderFriends();
  renderLiveFriends();
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
  const count = new Map();
  for (const t of state.tasks) {
    if (!t.subject || !inScope(t, 'current')) continue;   // '지금' 분류들의 과목
    count.set(t.subject, (count.get(t.subject) || 0) + (t.done ? 0 : 1));
  }
  for (const s of study.sessions) if (s.subject && !count.has(s.subject)) count.set(s.subject, 0);
  return orderSubjects([...count.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'ko')).map(([n]) => n));
}

/* ───── 타이머 ───── */
// 일시정지는 없음: 시작 → 끝내기. 다른 과목으로 바꾸려면 끝내고 다시 시작 (기록은 과목별로 합쳐서 보여 줌)
// 타이머 상태는 기기에 저장하고 서버에도 올려서, 다른 기기에서 열어도 같은 타이머가 이어진다
const timer = Object.assign({
  mode: 'p25', phase: 'idle', running: false, segStart: null, acc: 0, sessStart: null,
  subject: '', taskId: null, planId: null, label: '', updatedAt: 0,
}, readJSON(KEYS.timer, {}));
const saveTimer = () => storage.set(KEYS.timer, JSON.stringify(timer));
const modeOf = () => MODES.find(m => m.key === timer.mode) || MODES[1];
const isPomo = () => timer.mode !== 'watch';
const TIMER_FIELDS = ['mode', 'phase', 'running', 'segStart', 'acc', 'sessStart', 'subject', 'taskId', 'planId', 'label', 'updatedAt'];
const sessionIdOf = startMs => `tm-${Math.round(startMs).toString(36)}`;   // 같은 공부는 어느 기기에서 저장해도 같은 id

function elapsed(now = Date.now()) {
  return timer.acc + (timer.running && timer.segStart ? now - timer.segStart : 0);
}
function phaseLength() {
  const m = modeOf();
  if (!isPomo()) return WATCH_MAX;
  return (timer.phase === 'rest' ? m.rest : m.focus) * 60000;
}

export const timerActive = () => timer.phase !== 'idle';

/* ───── 기기끼리 맞추기 ───── */
let pushTimerT = null;
function changed() {
  timer.updatedAt = Date.now();
  saveTimer();
  clearTimeout(pushTimerT);
  pushTimerT = setTimeout(pushTimer, 300);
}
async function pushTimer() {
  if (!state.code) return;
  const snap = Object.fromEntries(TIMER_FIELDS.map(k => [k, timer[k]]));
  try { await api.timerSet(state.code, snap); } catch { /* 다음 변경 때 다시 */ }
}
export async function pullTimer() {
  if (!state.code) return;
  let remote;
  try { remote = await api.timer(state.code); } catch { return; }
  if (!remote || typeof remote !== 'object' || !(Number(remote.updatedAt) > (timer.updatedAt || 0))) {
    // 이 기기 쪽이 더 새로우면 올려 둔다 (처음 쓰는 기기 포함)
    if (timer.updatedAt && (!remote || Number(remote.updatedAt) < timer.updatedAt)) pushTimer();
    return;
  }
  const wasFocus = timer.phase === 'focus';
  for (const k of TIMER_FIELDS) if (k in remote) timer[k] = remote[k];
  saveTimer();
  if (wasFocus && timer.phase !== 'focus') loadStudy();          // 다른 기기에서 끝낸 공부 기록 받아 오기
  tick(); render(); ctx.onTimer();
}

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
  changed(); live(true); render(); ctx.onTimer();
}
function finishFocus(endMs, focusMs) {
  const sec = Math.round(focusMs / 1000);
  if (sec >= MIN_SAVE) {
    const startMs = timer.sessStart || endMs - focusMs;
    const id = sessionIdOf(startMs);
    if (!study.sessions.some(s => s.id === id)) {
      addSession({
        id, subject: timer.subject || '', taskId: timer.taskId || null, planId: timer.planId || null,
        startedAt: new Date(startMs).toISOString(), endedAt: new Date(endMs).toISOString(), seconds: sec,
      });
    }
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
  changed(); render(); ctx.onTimer();
}
// 예전 버전에서 일시정지해 둔 타이머: 그때까지를 기록하고 끝냄
if (timer.phase !== 'idle' && !timer.running) {
  if (timer.phase === 'focus' && timer.acc >= MIN_SAVE * 1000) queueMicrotask(() => { finishFocus((timer.sessStart || Date.now()) + timer.acc, timer.acc); toIdle(); });
  else Object.assign(timer, { phase: 'idle', running: false, segStart: null, acc: 0, sessStart: null });
}

// 1초마다: 시간이 다 된 단계를 넘기고 화면 숫자만 바꾼다
function tick() {
  tickLiveFriends();
  if (timer.phase === 'idle') return;
  const now = Date.now();
  let moved = false;
  // 창을 닫아 둔 사이 여러 단계가 지났을 수도 있어서 반복
  for (let guard = 0; guard < 4 && timer.running; guard++) {
    const len = phaseLength();
    const el = elapsed(now);
    if (el < len) break;
    const endMs = timer.segStart + (len - timer.acc);
    moved = true;
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
  // 단계가 넘어간 건 어느 기기에서 계산해도 같으므로 시각을 그 끝 시각으로 (서로 덮어써도 같은 결과)
  if (moved) { changed(); render(); ctx.onTimer(); return; }
  if (timer.phase === 'focus' && timer.running && Date.now() - lastLive > LIVE_EVERY) live(true);
  renderClock();
  renderPip();
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

// 떠 있는 타이머 (PiP)에 넘기는 상태
function pipState() {
  const idle = timer.phase === 'idle';
  const el0 = idle ? 0 : elapsed();
  const shown = isPomo() ? Math.max(0, (idle ? modeOf().focus * 60000 : phaseLength()) - el0) : el0;
  return {
    phase: timer.phase,
    text: clock(shown, !isPomo()),
    label: timer.label || timer.subject || '',
    color: timer.phase === 'rest' ? '#1F8A5B' : subjectColor(timer.subject),
    subLabel: idle ? (isPomo() ? `${modeOf().focus}분 집중` : '스톱워치') : timer.phase === 'rest' ? '쉬는 시간' : '집중 중',
  };
}
initPip({ get: pipState, start, stop, endRest: () => toIdle(), onChange: () => renderTopTimer() });
async function onPipClick() {
  const ok = await togglePip();
  if (!ok) ctx.toast('이 브라우저에서는 타이머를 띄울 수 없어요');
  renderTopTimer();
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
  changed(); render();
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
// 기록 고치기 (같은 id로 다시 저장 → 서버는 덮어씀)
function updateSession(old, fields) {
  const next = { ...old, ...fields };
  const inMain = study.sessions.findIndex(x => x.id === old.id);
  if (inMain >= 0) study.sessions[inMain] = next;
  if (study.extra.has(old.id)) {
    study.extra.set(old.id, next);
    if (inMain < 0) { adjustDaily(old, -1); adjustDaily(next, 1); }
  }
  queue = queue.filter(x => x.id !== old.id);
  queue.push(next); saveQueue();
  render();
  flushQueue().then(render);
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
const plusIcon = () => svgIcon(['M10 4.5v11M4.5 10h11']);
const watchIcon = () => svgIcon(['M10 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM10 8v3l2 1.4M8.3 2.8h3.4M15 5.5l1.2-1.2']);
const copyIcon = () => svgIcon(['M7 7h9v9H7zM4 13V4h9']);
const personIcon = () => svgIcon(['M10 9.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z', 'M3.8 17c.6-3.2 3-5 6.2-5s5.6 1.8 6.2 5']);
const userPlusIcon = () => svgIcon(['M8 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.8 16.5c.6-3 2.6-4.6 5.2-4.6s4.1 1 4.9 3M15.5 10v5M13 12.5h5']);
const xIcon = () => svgIcon(['M6 6l8 8M14 6l-8 8']);
const checkIcon = () => svgIcon(['M5.5 10.5l3 3 6-7']);
const trashIcon = () => svgIcon(['M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6M8.5 9v4M11.5 9v4']);
const prevIcon = () => svgIcon(['M12 5l-5 5 5 5']);
const pipIcon = () => svgIcon(['M3 5.5h14v9H3z', 'M10.5 10h5v3.5h-5z']);
const nextIcon = () => svgIcon(['M8 5l5 5-5 5']);

// 공부 과목 목록: 이번 학기 과목 + 공부 기록·계획에 쓴 과목 + 이 기기에서 추가한 과목 + 예전 과목
const studySubjects = () => [
  ...currentSubjects(), ...study.plans.map(p => p.subject),
  ...taskSubjects('current'),
];
const fmtDay = d => `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;

function build(root) {
  /* 오늘: 타이머 */
  el.modes = h('div', { class: 'segmented timer-modes', role: 'radiogroup', 'aria-label': '타이머 종류' });
  el.phase = h('p', { class: 'timer-phase' });
  el.digits = h('div', { class: 'timer-digits', role: 'timer', 'aria-live': 'off' });
  el.bar = h('i');
  el.what = h('div', { class: 'timer-what' });
  el.timerCard = h('section', { class: 'timer-card', 'aria-label': '타이머' },
    h('div', { class: 'timer-top' }, el.modes, ambientControl()),
    h('div', { class: 'timer-face' }, el.phase, el.digits, h('div', { class: 'timer-bar' }, el.bar)),
    el.what);

  /* 오늘: 계획 */
  el.planList = h('ul', { class: 'plan-list' });
  el.planMemo = h('input', { type: 'text', maxlength: 100, placeholder: '메모 (안 적어도 돼요)', 'aria-label': '메모' });
  el.planPick = subjectPicker({ id: 'planSubject', options: studySubjects, allowNone: false, placeholder: '과목 고르기' });
  el.planSubjectWrap = h('span', { class: 'plan-subject' }, el.planPick.el);
  // 이번 주 보기에서 넣을 날 (모레 ~ 7일 뒤)
  el.planDay = h('select', { class: 'plan-day', 'aria-label': '언제' });
  const addPlan = () => {
    const subject = $('#planSubject')?.value || '';
    const memo = el.planMemo.value.trim();
    if (!subject && !memo) { $('#planSubject')?.focus(); ctx.toast('과목을 골라 주세요'); return; }
    const day = planView === 'today' ? studyKey() : planView === 'tomorrow' ? dayKey(addDays(studyDate(), 1)) : el.planDay.value;
    // 메모가 없으면 과목 이름을 제목으로 (서버는 제목이 꼭 있어야 함)
    savePlan({ id: newId(), day, title: (memo || subject).slice(0, 100), subject, minutes: null, done: false });
    rememberSubject(subject);
    el.planMemo.value = '';
    el.planPick.set('');
    if (planView === 'week') ctx.toast(`${planDayLabel(day)}에 넣었어요`);
  };
  el.planMemo.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addPlan(); } });
  el.liveFriends = h('section', { class: 's-live-friends', 'aria-label': '지금 공부 중인 친구', hidden: true });
  el.planTitle = h('h3', null, '오늘 공부');
  el.planViews = h('div', { class: 'segmented plan-views', role: 'radiogroup', 'aria-label': '언제 할 공부' });
  el.planAddBtn = h('button', { class: 'btn icon primary', type: 'button', onclick: addPlan, title: '추가', 'aria-label': '오늘 공부에 추가' }, plusIcon());
  el.plans = h('section', { class: 's-plans' },
    h('div', { class: 'plan-head' }, el.planTitle, el.planViews),
    el.planList,
    h('div', { class: 'plan-add' }, el.planSubjectWrap, el.planDay, el.planMemo, el.planAddBtn));

  /* 오늘: 타임라인 */
  el.dayHead = h('div', { class: 'tl-head' });
  el.timeline = h('div', { class: 'tl-wrap' });
  el.addBox = makeAddBox('manualSubject');
  el.todaySubj = h('div', { class: 'day-subjects' });

  el.todayRoot = h('div', { class: 'st-today' },
    h('div', { class: 'st-left' }, el.timerCard, el.plans, el.liveFriends),
    h('aside', { class: 'st-right', 'aria-label': '오늘 타임라인' }, el.dayHead, el.timeline, el.addBox.box, el.todaySubj));

  /* 기록 */
  el.recModes = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': '기간' });
  el.recTitle = h('button', { type: 'button', class: 'rec-title', title: '이번 기간으로' });
  el.recPrev = h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': '이전' }, prevIcon());
  el.recNext = h('button', { type: 'button', class: 'btn icon ghost', 'aria-label': '다음' }, nextIcon());
  el.recSummary = h('p', { class: 'rec-summary' });
  el.recMain = h('div', { class: 'rec-main' });
  el.recDay = h('aside', { class: 'rec-day', 'aria-label': '고른 날' });
  el.recAddBox = makeAddBox('recSubject');
  el.recPrev.addEventListener('click', () => shiftPeriod(-1));
  el.recNext.addEventListener('click', () => shiftPeriod(1));
  el.recTitle.addEventListener('click', () => { rec.anchor = studyDate(); rec.day = studyKey(); renderRecords(); });
  // 오른쪽 날짜 칸은 오늘 탭의 타임라인 칸과 같은 자리 · 같은 모양 (탭을 오가도 타임라인이 그대로)
  el.recRoot = h('div', { class: 'st-records' },
    h('div', { class: 'rec-left' },
      h('div', { class: 'rec-bar' }, el.recModes, h('div', { class: 'rec-nav' }, el.recPrev, el.recTitle, el.recNext)),
      el.recSummary,
      el.recMain),
    el.recDay);

  root.replaceChildren(el.todayRoot, el.recRoot);
  builtFor = root;
}

// ▶ · ❚❚ · ■ 는 상단바(친구 버튼 왼쪽)에. 오늘 · 기록 어느 탭에서든 쓸 수 있게
function renderTopTimer() {
  const box = $('#topTimer');
  if (!box) return;
  const idle = timer.phase === 'idle';
  // 상단바의 다른 버튼과 같은 네모 버튼에 글자로
  const b = (text, title, onclick, cls = '') => h('button', { type: 'button', class: `btn tt-btn ${cls}`, onclick, title }, text);
  // 다른 창 위에 작게 띄우기 (지원하는 브라우저만)
  const pip = pipSupported() ? h('button', {
    type: 'button', class: `btn icon ghost tt-pip${pipOpen() ? ' on' : ''}`, onclick: onPipClick,
    title: pipOpen() ? '띄운 타이머 닫기' : '타이머 띄우기 (다른 창 위에)', 'aria-label': pipOpen() ? '띄운 타이머 닫기' : '타이머 띄우기',
    'aria-pressed': pipOpen() ? 'true' : 'false',
  }, pipIcon()) : null;
  const main = idle ? b('시작', '타이머 시작 (Space)', start, 'primary')
    : timer.phase === 'rest' ? b('쉬는 시간 끝', '쉬는 시간 끝내기', toIdle, 'rest')
    : b('끝내기', '끝내고 기록 (Space)', stop, 'primary');
  box.replaceChildren(...[pip, main].filter(Boolean));
}

export function render() {
  renderFriendsBtn();
  renderTopTimer();
  renderPip();
  const root = $('#viewStudy');
  if (!root || root.hidden) return;
  if (builtFor !== root) build(root);
  const v = studyView();
  el.todayRoot.hidden = v !== 'today';
  el.recRoot.hidden = v !== 'records';
  if (v === 'today') { renderTimer(); renderPlans(); renderDay(); renderLiveFriends(); }
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
    onclick: () => { timer.mode = m.key; changed(); render(); },
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

/* ───── 오늘 공부: 내가 넣은 것 + D-7 안의 일정 ─────
   내일 · 이번 주(모레~7일 뒤)로 미리 잡아 둘 수도 있다. 지난 날에 못 한 계획은 오늘로 옮길 수 있게 */
let planView = 'today';
const PLAN_VIEWS = [['today', '오늘'], ['tomorrow', '내일'], ['week', '이번 주']];
function planDayLabel(key) {
  const d = new Date(`${key}T00:00:00`);
  const diff = Math.round((d - studyDate()) / DAY);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === -1) return '어제';
  return `${d.getMonth() + 1}/${d.getDate()} ${WEEK[d.getDay()]}`;
}
function movePlanToday(p) {
  savePlan({ ...p, day: studyKey() });
  ctx.toast(`"${p.title}" 계획을 오늘로 옮겼어요`);
}
const moveIcon = () => svgIcon(['M15.5 10h-11M8.5 6l-4 4 4 4']);

function renderPlanHead() {
  el.planTitle.textContent = planView === 'today' ? '오늘 공부' : planView === 'tomorrow' ? '내일 공부' : '이번 주 공부';
  const base = studyDate();
  const later = study.plans.filter(p => !p.done && p.day > studyKey());
  const count = key => key === 'tomorrow' ? later.filter(p => p.day === dayKey(addDays(base, 1))).length
    : key === 'week' ? later.filter(p => p.day > dayKey(addDays(base, 1))).length : 0;
  el.planViews.replaceChildren(...PLAN_VIEWS.map(([k, label]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': planView === k ? 'true' : 'false',
    onclick: () => { planView = k; renderPlans(); },
  }, label, count(k) ? h('span', { class: 'pv-n' }, count(k)) : null)));
  // 이번 주: 넣을 날 고르기 (모레 ~ 7일 뒤)
  el.planDay.hidden = planView !== 'week';
  el.planDay.parentElement?.classList.toggle('with-day', planView === 'week');
  if (planView === 'week') {
    const keep = el.planDay.value;
    el.planDay.replaceChildren(...Array.from({ length: 6 }, (_, i) => {
      const k = dayKey(addDays(base, i + 2));
      return h('option', { value: k, selected: k === keep }, planDayLabel(k));
    }));
  }
  const where = planView === 'today' ? '오늘' : planView === 'tomorrow' ? '내일' : '이번 주';
  el.planAddBtn.setAttribute('aria-label', `${where} 공부에 추가`);
  el.planMemo.placeholder = planView === 'today' ? '메모 (안 적어도 돼요)' : '메모';
}

// 내일 · 이번 주 · 지난 날의 계획 한 줄: 과목 | 날짜 | (비움) | 오늘로 | x
function laterPlanRow(p, { past = false } = {}) {
  const memo = p.title && p.title !== p.subject ? p.title : '';
  const name = p.subject || memo || '공부';
  return h('li', { class: `plan later${past ? ' past' : ''}`, style: { '--c': subjectColor(p.subject) } },
    h('span', { class: 'plan-name' },
      h('span', { class: 'plan-subj' }, name),
      p.subject && memo ? h('span', { class: 'plan-memo' }, memo) : null),
    h('span', { class: 'plan-dday plan-when' }, planDayLabel(p.day)),
    h('span', { class: 'plan-time' }),
    h('button', { type: 'button', class: 'btn icon ghost sm-icon to-today', title: '오늘로 옮기기', 'aria-label': `${name} 오늘로 옮기기`, onclick: () => movePlanToday(p) }, moveIcon()),
    h('button', { type: 'button', class: 'btn icon ghost sm-icon row-x', title: '지우기', 'aria-label': `${name} 지우기`, onclick: () => removePlan(p) }, xIcon()));
}

function renderPlans() {
  renderPlanHead();
  if (planView !== 'today') {
    const base = studyDate();
    const tomorrow = dayKey(addDays(base, 1));
    const list = study.plans
      .filter(p => planView === 'tomorrow' ? p.day === tomorrow : p.day > tomorrow)
      .sort((a, b) => a.day.localeCompare(b.day) || 0)
      .map(p => laterPlanRow(p));
    fill(el.planList, list, !list.length ? h('li', { class: 'empty' },
      planView === 'tomorrow' ? '내일 할 공부를 미리 넣어 두면 내일 오늘 공부에 나와요.' : '날을 골라 이번 주 공부를 미리 잡아 둘 수 있어요.') : null);
    return;
  }
  const today = studyKey();
  const idle = timer.phase === 'idle';
  const plans = study.plans.filter(p => p.day === today);
  const playBtn = (label, w) => idle ? h('button', {
    type: 'button', class: 'btn icon ghost sm-icon play', title: '공부 시작', 'aria-label': `${label} 공부 시작`,
    onclick: () => { selectWhat(w); start(); },
  }, playIcon()) : h('span', { class: 'sm-icon' });

  const mine = plans.map(p => {
    const memo = p.title && p.title !== p.subject ? p.title : '';
    const spent = planProgress(p);
    const now = !idle && timer.planId === p.id;
    return h('li', { class: `plan${now ? ' now' : ''}`, style: { '--c': subjectColor(p.subject) } },
      h('span', { class: 'plan-name' },
        h('span', { class: 'plan-subj' }, p.subject || memo || '공부'),
        p.subject && memo ? h('span', { class: 'plan-memo' }, memo) : null),
      h('span', { class: 'plan-dday' }),
      h('span', { class: 'plan-time' }, spent ? fmtSpent(spent) : ''),
      playBtn(p.subject || memo, { subject: p.subject, planId: p.id, label: memo ? `${p.subject ? `${p.subject} · ` : ''}${memo}` : '' }),
      h('button', { type: 'button', class: 'btn icon ghost sm-icon row-x', title: '지우기', 'aria-label': `${p.subject || memo} 지우기`, onclick: () => removePlan(p) }, xIcon()));
  });

  // 7일 안의 과제 · 시험: 과목 | 과제 · 시험 이름 | D-day | ▶ (내가 넣은 줄과 같은 칸에 맞춤)
  const now = new Date();
  const soon = state.tasks
    .filter(t => !t.done && new Date(t.due) > now && Math.round((startOfDay(new Date(t.due)) - startOfDay(now)) / DAY) <= 7)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  const upcoming = soon.map(t => {
    const nowT = !idle && timer.taskId === t.id;
    const name = t.title || displayTitle(t);
    return h('li', { class: `plan soon${isExam(t) ? ' exam' : ''}${nowT ? ' now' : ''}`, style: { '--c': subjectColor(t.subject) } },
      h('span', { class: 'plan-name' },
        t.subject ? h('span', { class: 'plan-subj' }, t.subject) : null,
        h('button', { type: 'button', class: `plan-task link${t.subject ? '' : ' solo'}`, title: '눌러서 자세히 보기', onclick: () => ctx.openTask(t) }, name)),
      h('span', { class: 'plan-dday' }, dday(t, now).label),
      h('span', { class: 'plan-time' }),
      playBtn(name, { subject: t.subject, taskId: t.id, label: displayTitle(t) }),
      h('span', { class: 'sm-icon' }));
  });

  // 지난 날(최근 7일)에 넣고 못 한 계획: 끝에 흐리게, 오늘로 옮길 수 있게
  const missed = study.plans
    .filter(p => p.day < today && !p.done && !planProgress(p))
    .sort((a, b) => b.day.localeCompare(a.day))
    .map(p => laterPlanRow(p, { past: true }));

  fill(el.planList, mine, upcoming,
    !mine.length && !upcoming.length ? h('li', { class: 'empty' }, '과목을 골라 넣어 두면 ▶로 바로 시작할 수 있어요.') : null,
    missed.length ? h('li', { class: 'plan-missed-head' }, `지난 계획 ${missed.length}개`) : null,
    missed);
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
  renderTimeline();
}
function renderTimeline() {
  if (!el.timeline) return;
  const today = studyDate();
  el.timeline.replaceChildren(timeline(today, segmentsOn(dayKey(today), true), { showNow: true, editable: true }));
  renderAddBox(el.addBox, dayKey(today));
  fill(el.todaySubj, daySubjects(dayKey(today), true));
}

/* ───── 타임라인에서 직접 기록 넣기 ─────
   마우스: 빈 곳을 끌어서 범위 고르기 / 폰: 누르면 그 시각부터 30분
   고른 범위는 아래 칸에서 시각을 고치고 과목을 골라 기록 */
let sel = null;                                  // { key, start: ms, end: ms }
const SNAP = 5 * 60000;
const snap = t => Math.round(t / SNAP) * SNAP;
const dateOfKey = key => new Date(`${key}T00:00`);

function selLimits(key) {
  const mid = dateOfKey(key).getTime();
  let max = mid + 29 * 3.6e6;                    // 다음 날 새벽 5시
  if (key === studyKey()) max = Math.min(max, Math.floor(Date.now() / 60000) * 60000);
  return { min: mid + 5 * 3.6e6, max };
}
function setSel(key, a, b) {
  const { min, max } = selLimits(key);
  if (Math.min(a, b) >= max - 60000) { ctx.toast('아직 오지 않은 시간이에요'); return false; }
  let start = Math.max(min, Math.min(a, b)), end = Math.min(max, Math.max(a, b));
  if (end - start < SNAP) {
    if (start + SNAP <= max) end = start + SNAP; else start = Math.max(min, end - SNAP);
  }
  if (end <= start) { ctx.toast('아직 오지 않은 시간이에요'); return false; }
  if (end - start > 12 * 3.6e6) start = end - 12 * 3.6e6;
  sel = { key, start, end, editId: sel && sel.key === key ? sel.editId : null };
  return true;
}
function timeAt(ol, e, date) {
  const rows = [...ol.children];
  let row = rows.find(r => { const rc = r.getBoundingClientRect(); return e.clientY >= rc.top && e.clientY < rc.bottom; });
  if (!row) row = e.clientY < rows[0].getBoundingClientRect().top ? rows[0] : rows[rows.length - 1];
  const tr = row.querySelector('.tl-track').getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - tr.left) / tr.width));
  return snap(date.getTime() + (Number(row.dataset.h) + frac) * 3.6e6);
}
// 고른 범위를 타임라인 위에 점선 막대로 (끄는 동안에는 목록을 다시 만들지 않고 이것만)
function paintSel(ol, date) {
  ol.querySelectorAll('.tl-seg.sel').forEach(n => n.remove());
  if (!sel || sel.key !== dayKey(date)) return;
  const mid = date.getTime();
  for (const row of ol.children) {
    const hr = Number(row.dataset.h);
    const a = Math.max((sel.start - mid) / 3.6e6, hr), b = Math.min((sel.end - mid) / 3.6e6, hr + 1);
    if (b <= a) continue;
    row.querySelector('.tl-track').append(h('i', { class: 'tl-seg sel', style: { left: `${(a - hr) * 100}%`, width: `${(b - a) * 100}%` } }));
  }
}
function attachPick(ol, date) {
  const key = dayKey(date);
  let down = null;
  ol.classList.add('editable');
  ol.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.target.closest('.tl-track')) return;
    const recSeg = e.target.closest('.tl-seg.rec');
    down = { x: e.clientX, y: e.clientY, t: timeAt(ol, e, date), type: e.pointerType, dragging: false, editId: recSeg ? recSeg.dataset.id : null };
    if (e.pointerType === 'mouse') { e.preventDefault(); ol.setPointerCapture(e.pointerId); }
  });
  ol.addEventListener('pointermove', e => {
    if (!down || down.type !== 'mouse') return;
    if (down.editId) return;                    // 기록 막대에서 시작한 건 끌기 대신 고치기
    if (!down.dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) return;
    if (!down.dragging && sel && sel.editId) { sel = null; refreshSel(); }
    down.dragging = true;
    const t = timeAt(ol, e, date);
    if (setSel(key, down.t, t === down.t ? t + SNAP : t)) paintSel(ol, date);
  });
  const finish = e => {
    if (!down) return;
    const d = down; down = null;
    if (d.type !== 'mouse' && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;   // 폰에서 스크롤한 것
    if (d.editId) { openEdit(d.editId); return; }
    if (!d.dragging) { sel = null; if (!setSel(key, d.t, d.t + 30 * 60000)) { refreshSel(); return; } }
    refreshSel();
    const box = key === studyKey() && studyView() === 'today' ? el.addBox : el.recAddBox;
    box.pick.button.focus({ preventScroll: true });
  };
  ol.addEventListener('pointerup', finish);
  ol.addEventListener('pointercancel', () => { down = null; });
}
// 기록 고치기: 그 기록의 시각 · 과목으로 아래 칸을 채움
function openEdit(id) {
  const s = allSessions().find(x => x.id === id);
  if (!s) return;
  sel = { key: studyKey(s.startedAt), start: new Date(s.startedAt).getTime(), end: new Date(s.endedAt).getTime(), editId: id, fresh: true };
  refreshSel();
}
function refreshSel() {
  if (studyView() === 'today') renderTimeline(); else renderRecDay();
}

function makeAddBox(id) {
  const toInput = () => h('input', { type: 'time', step: 300, class: 'tl-time' });
  const box = {
    startIn: toInput(), endIn: toInput(),
    len: h('span', { class: 'tl-len' }),
    warn: h('p', { class: 'msg' }),
    pick: subjectPicker({ id, options: studySubjects }),
  };
  const onTime = () => {
    if (!sel) return;
    const mid = dateOfKey(sel.key).getTime();
    const at = v => {
      const [hh, mm] = (v || '').split(':').map(Number);
      if (Number.isNaN(hh)) return null;
      return mid + ((hh < 5 ? hh + 24 : hh) * 60 + mm) * 60000;   // 새벽 0~4시는 다음 날
    };
    const a = at(box.startIn.value), b = at(box.endIn.value);
    if (a == null || b == null) return;
    if (b <= a) { box.warn.className = 'msg err'; box.warn.textContent = '끝나는 시각이 시작보다 빨라요'; return; }
    if (setSel(sel.key, a, b)) refreshSel();
  };
  box.startIn.addEventListener('change', onTime);
  box.endIn.addEventListener('change', onTime);
  const save = () => {
    if (!sel) return;
    const sec = Math.round((sel.end - sel.start) / 1000);
    const range = `${fmtClock(new Date(sel.start))}–${fmtClock(new Date(sel.end))}`;
    if (sel.editId) {
      const old = allSessions().find(x => x.id === sel.editId);
      if (old) {
        updateSession(old, {
          subject: box.pick.value, startedAt: new Date(sel.start).toISOString(), endedAt: new Date(sel.end).toISOString(), seconds: sec,
        });
        ctx.toast(`${range} ${fmtSpent(sec)}로 고쳤어요`);
      }
    } else {
      addSession({
        id: newId(), subject: box.pick.value, taskId: null, planId: null,
        startedAt: new Date(sel.start).toISOString(), endedAt: new Date(sel.end).toISOString(), seconds: sec,
      });
      ctx.toast(`${range} ${fmtSpent(sec)} 기록했어요`);
    }
    rememberSubject(box.pick.value);
    sel = null;
    refreshSel();
  };
  const del = () => {
    const old = sel && sel.editId && allSessions().find(x => x.id === sel.editId);
    sel = null;
    if (old) removeSession(old); else refreshSel();
  };
  box.title = h('p', { class: 'tl-add-title' });
  box.delBtn = h('button', { type: 'button', class: 'btn icon ghost danger', title: '이 기록 지우기', 'aria-label': '이 기록 지우기', onclick: del }, trashIcon());
  box.form = h('div', { class: 'tl-add-form' },
    h('div', { class: 'tl-add-head' }, box.title, box.len),
    h('div', { class: 'tl-add-times' }, box.startIn, h('span', { class: 'tl-dash' }, '–'), box.endIn),
    h('div', { class: 'tl-add-row' }, box.pick.el,
      h('button', { type: 'button', class: 'btn icon primary', title: '저장', 'aria-label': '이 시간 저장', onclick: save }, checkIcon()),
      box.delBtn,
      h('button', { type: 'button', class: 'btn icon ghost', title: '취소', 'aria-label': '취소', onclick: () => { sel = null; refreshSel(); } }, xIcon())),
    box.warn);
  box.hint = h('p', { class: 'tl-hint' }, matchMedia('(pointer: coarse)').matches
    ? '타임라인을 누르면 그 시각부터 공부한 시간을 넣을 수 있어요'
    : '타임라인의 빈 곳을 끌어서 공부한 시간을 넣을 수 있어요');
  box.box = h('div', { class: 'tl-add' }, box.hint, box.form);
  return box;
}
function renderAddBox(box, key) {
  const on = !!sel && sel.key === key;
  box.form.hidden = !on;
  box.hint.hidden = on;
  box.box.classList.toggle('open', on);
  if (!on) return;
  const fmt = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  box.startIn.value = fmt(sel.start);
  box.endIn.value = fmt(sel.end);
  box.len.textContent = fmtSpent(Math.round((sel.end - sel.start) / 1000));
  box.title.textContent = sel.editId ? '기록 고치기' : '공부한 시간 넣기';
  box.delBtn.hidden = !sel.editId;
  if (sel.fresh) {                              // 고치기를 처음 열 때만 과목을 채움 (고르는 중엔 그대로)
    const s = allSessions().find(x => x.id === sel.editId);
    box.pick.set(s ? s.subject : '');
    sel.fresh = false;
  }
  const overlap = sessionsOn(key).some(s => s.id !== sel.editId && new Date(s.startedAt) < sel.end && new Date(s.endedAt) > sel.start);
  box.warn.className = 'msg';
  box.warn.textContent = overlap ? '다른 기록과 겹치는 시간이에요' : '';
}

// 그날 막대들: 기록 + (오늘이면) 지금 돌고 있는 타이머
function segmentsOn(key, withLive) {
  const titleOf = s => {
    if (s.planId) { const p = study.plans.find(x => x.id === s.planId); if (p) return p.title; }
    if (s.taskId) { const t = state.tasks.find(x => x.id === s.taskId); if (t) return displayTitle(t); }
    return s.subject || '과목 없음';
  };
  const segs = sessionsOn(key).filter(s => !(sel && sel.editId === s.id)).map(s => ({
    id: s.id, start: new Date(s.startedAt), end: new Date(s.endedAt), subject: s.subject, title: titleOf(s), seconds: s.seconds,
  }));
  if (withLive && timer.phase === 'focus' && timer.sessStart) {
    const end = timer.running ? Date.now() : timer.sessStart + timer.acc;
    segs.push({ start: new Date(timer.sessStart), end: new Date(end), subject: timer.subject, title: timer.label || timer.subject || '공부 중', live: true });
  }
  return segs;
}

// 한 시간이 한 줄, 줄 안에서 0~60분 위치에 막대
function timeline(date, segs, { showNow = false, editable = false } = {}) {
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
        class: `tl-seg${s.live ? ' live' : ''}${s.id ? ' rec' : ''}`, dataset: s.id ? { id: s.id } : null,
        style: { '--c': subjectColor(s.subject), left: `${(a - hr) * 100}%`, width: `${Math.max(2.5, (b - a) * 100)}%` },
        title: `${s.title} · ${fmtClock(s.start)}–${fmtClock(s.end)}${s.id && editable ? ' · 눌러서 고치기' : ''}`,
      }));
    }
    const now = showNow && nowH >= hr && nowH < hr + 1
      ? h('b', { class: 'tl-now', style: { left: `${(nowH - hr) * 100}%` } }) : null;
    rows.push(h('li', { class: `tl-row${hr % 6 === 0 ? ' dash' : ''}`, dataset: { h: hr } },
      h('span', { class: 'tl-h' }, label(hr)),
      h('span', { class: 'tl-track' }, pieces, now)));
  }
  const ol = h('ol', { class: 'timeline', 'aria-label': `${fmtDay(date)} 공부 타임라인` }, rows);
  if (editable) { attachPick(ol, date); paintSel(ol, date); }
  return ol;
}

// 그날 과목별로 모두 몇 시간 했는지 (기록을 과목별로 합쳐서)
function daySubjects(key, withLive = false) {
  const list = sessionsOn(key);
  const map = new Map();
  for (const x of list) map.set(x.subject || '', (map.get(x.subject || '') || 0) + x.seconds);
  if (withLive && timer.phase === 'focus') map.set(timer.subject || '', (map.get(timer.subject || '') || 0) + runningFocusSec());
  const rows = [...map.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return null;
  const max = Math.max(...rows.map(([, v]) => v));
  return h('ul', { class: 'subject-bars day-sum', 'aria-label': '과목별 공부 시간' }, rows.map(([name, v]) => h('li', { style: { '--c': subjectColor(name) } },
    h('span', { class: 'sb-name' }, name || '과목 없음'),
    h('span', { class: 'sb-bar' }, h('i', { style: { width: `${(v / max) * 100}%` } })),
    h('span', { class: 'sb-time' }, fmtSpent(v)))));
}

/* ───── 기록 ───── */
function period() {
  const a = rec.anchor || studyDate();
  if (rec.mode === 'year') {
    // 이 주를 끝으로 53주 (월요일 시작)
    const end = addDays(startOfWeek(a), 7);
    return { start: addDays(end, -53 * 7), end };
  }
  if (rec.mode === 'month') {
    const start = new Date(a.getFullYear(), a.getMonth(), 1);
    return { start, end: new Date(a.getFullYear(), a.getMonth() + 1, 1) };
  }
  const start = startOfWeek(a);
  return { start, end: addDays(start, 7) };
}
function shiftPeriod(dir) {
  const a = rec.anchor || studyDate();
  rec.anchor = rec.mode === 'month' ? new Date(a.getFullYear(), a.getMonth() + dir, 1)
    : rec.mode === 'year' ? addDays(a, 52 * 7 * dir) : addDays(a, 7 * dir);
  const { start, end } = period();
  const today = studyDate();
  // 고른 날을 새 기간 안으로 (이번 기간이면 오늘, 아니면 마지막 날)
  rec.day = today >= start && today < end ? dayKey(today) : dayKey(addDays(end, -1));
  renderRecords();
}
function periodTitle({ start, end }) {
  if (rec.mode === 'month') return `${start.getFullYear()}년 ${start.getMonth() + 1}월`;
  const last = addDays(end, -1);
  if (rec.mode === 'year') return `${start.getFullYear() % 100}.${start.getMonth() + 1} – ${last.getFullYear() % 100}.${last.getMonth() + 1}`;
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
  // 1년(잔디)은 날짜별 합계만 쓰므로 기록을 더 불러오지 않음
  if (rec.mode !== 'year') ensureRange(p.start, p.end);

  el.recModes.replaceChildren(...[['week', '주간'], ['month', '월간'], ['year', '1년']].map(([k, l]) => h('button', {
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

  if (rec.mode === 'year') {
    fill(el.recSummary,
      h('b', null, fmtSpent(total)),
      h('span', null, `${studied}일 공부`),
      h('span', null, `가장 길게 ${longestStreak(m, past)}일 연속`),
      p.end > today && streak(m) > 1 ? h('span', null, `지금 ${streak(m)}일 연속`) : null);
    fill(el.recMain, yearGrass(p, m, today));
  } else fill(el.recMain, rec.mode === 'month' ? monthGrid(p, m, today) : weekStrips(days, m, today), subjects);
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
function longestStreak(m, days) {
  let best = 0, n = 0;
  for (const d of days) { n = m.get(dayKey(d)) ? n + 1 : 0; best = Math.max(best, n); }
  return best;
}

// 1년 잔디: 세로 = 요일(월~일), 가로 = 주. 진하기는 하루 목표 대비 (달력과 같은 4단계)
function yearGrass({ start, end }, m, today) {
  const goal = study.goal * 60;
  const weeks = [];
  for (let w = start; w < end; w = addDays(w, 7)) weeks.push(w);
  // 그 달 1일이 들어 있는 주에 달 이름 (첫 주 머리말끼리 겹치지 않게)
  const months = weeks.map(w => {
    const d = addDays(w, 6);
    return d.getDate() <= 7 ? `${d.getMonth() + 1}월` : '';
  });
  const cell = d => {
    const key = dayKey(d);
    const sec = m.get(key) || 0;
    const r = sec / goal;
    const lv = !sec ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 1 ? 3 : 4;
    if (d > today) return h('span', { class: 'yg-day future' });
    return h('button', {
      type: 'button', class: `yg-day lv${lv}${key === rec.day ? ' sel' : ''}${key === dayKey(today) ? ' today' : ''}`,
      title: `${fmtDay(d)} · ${sec ? fmtSpent(sec) : '공부 안 함'}`, 'aria-label': `${fmtDay(d)} ${fmtSpent(sec)}`,
      onclick: () => { rec.day = key; renderRecords(); },
    });
  };
  const grid = h('div', { class: 'yg-grid', style: { '--weeks': weeks.length } },
    h('div', { class: 'yg-months', 'aria-hidden': 'true' }, months.map(t => h('span', null, t))),
    h('div', { class: 'yg-wd', 'aria-hidden': 'true' }, ['월', '', '수', '', '금', '', '일'].map(t => h('span', null, t))),
    h('div', { class: 'yg-cells' }, weeks.map(w => Array.from({ length: 7 }, (_, i) => cell(addDays(w, i)))).flat()));
  const legend = h('div', { class: 'yg-legend', 'aria-hidden': 'true' },
    h('span', null, '적게'), [0, 1, 2, 3, 4].map(l => h('i', { class: `yg-day lv${l}` })), h('span', null, `목표(${fmtSpent(goal)}) 이상`));
  const box = h('div', { class: 'year-grass' }, h('div', { class: 'yg-scroll' }, grid), legend);
  // 칸 크기를 폭에 맞추고(10~16px), 그래도 넘치는 좁은 화면에서는 최근 주가 보이게 오른쪽 끝으로
  requestAnimationFrame(() => {
    const sc = box.firstChild;
    const cell = Math.max(10, Math.min(16, Math.floor((sc.clientWidth - 24) / weeks.length) - 3));
    grid.style.setProperty('--cell', `${cell}px`);
    sc.scrollLeft = sc.scrollWidth;
  });
  return box;
}

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
  renderAddBox(el.recAddBox, rec.day);
  const segs = segmentsOn(rec.day, isToday);
  const list = sessionsOn(rec.day).slice().sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const sec = (dailyMap().get(rec.day) || 0);
  const titleOf = s => {
    if (s.planId) { const p = study.plans.find(x => x.id === s.planId); if (p) return p.title; }
    if (s.taskId) { const t = state.tasks.find(x => x.id === s.taskId); if (t) return displayTitle(t); }
    return null;
  };
  fill(el.recDay,
    h('div', { class: 'today-head' },
      h('p', { class: 'today-total' }, fmtSpent(sec)),
      h('span', { class: 'rd-date' }, isToday ? `오늘 · ${fmtDay(date)}`
        : date.getFullYear() !== studyDate().getFullYear() ? `${date.getFullYear()}년 ${fmtDay(date)}` : fmtDay(date))),
    h('div', { class: 'goal-bar' }, h('i', { style: { width: `${Math.min(100, sec / (study.goal * 60) * 100)}%` } })),
    // 40일 안의 날짜는 타임라인에서 직접 기록 넣기 (서버가 그보다 오래된 기록은 받지 않음)
    timeline(date, segs, { showNow: isToday, editable: date >= addDays(studyDate(), -39) }),
    date >= addDays(studyDate(), -39) ? el.recAddBox.box : null,
    daySubjects(rec.day, isToday),
    list.length ? h('ul', { class: 'record-list' }, list.map(s => {
      const what = titleOf(s);
      const editable = date >= addDays(studyDate(), -39);
      return h('li', {
        style: { '--c': subjectColor(s.subject) }, class: editable ? 'editable' : null,
        title: editable ? '눌러서 고치기' : null,
        onclick: editable ? e => { if (!e.target.closest('button')) openEdit(s.id); } : null,
      },
        h('span', { class: 'rec-time' }, `${fmtClock(new Date(s.startedAt))}–${fmtClock(new Date(s.endedAt))}`),
        h('span', { class: 'rec-what' }, what || s.subject || '과목 없음', what && s.subject ? h('span', { class: 'chip-sub' }, s.subject) : null),
        h('span', { class: 'rec-len' }, fmtSpent(s.seconds)),
        h('button', { type: 'button', class: 'btn icon ghost sm-icon row-x', title: '기록 지우기', 'aria-label': '기록 지우기', onclick: () => removeSession(s) }, xIcon()));
    })) : h('p', { class: 'muted' }, sec ? '불러오는 중…' : '이날은 공부 기록이 없어요.'));
}

/* ───── 친구 (위쪽 버튼 → 창) ───── */
let friendMsg = { text: '', err: false };
let friendRange = (() => { try { const v = storage.get('ddayboard.friendRange'); return ['today', 'week', 'month'].includes(v) ? v : 'today'; } catch { return 'today'; } })();
function setFriendMsg(text, err = false) { friendMsg = { text, err }; renderFriends(); }

async function friendAction(fn, ok) {
  try { await fn(); if (ok) setFriendMsg(ok); else renderFriends(); }
  catch (e) { setFriendMsg(errText(e), true); }
}

function renderFriendsBtn() {
  const badge = $('#friendsLive');
  if (!badge) return;
  const vis = study.profile && study.profile.visible;
  const n = vis ? study.friends.filter(f => f.liveSince).length : 0;
  const req = vis ? study.requests.incoming.length : 0;
  badge.hidden = !n && !req;
  badge.textContent = req ? `+${req}` : n;
  badge.classList.toggle('req', !!req);
  const btn = $('#btnFriends');
  if (btn) btn.title = req ? `친구 신청 ${req}개` : n ? `친구 ${n}명 공부 중` : '친구';
}

export async function openFriends() {
  friendMsg = { text: '', err: false };
  renderFriends();
  const d = $('#friendsDialog');
  if (d && !d.open) d.showModal();
  if (!study.loaded) await loadStudy();
  await loadFriends();
}

// 이름 첫 글자 동그라미 (공부 중이면 초록 테두리)
const avatar = (name, live = false, me = false) =>
  h('span', { class: `f-avatar${live ? ' live' : ''}${me ? ' me' : ''}`, 'aria-hidden': 'true' }, [...String(name || '?')][0]);
const liveMinOf = r => (r.liveSince ? Math.max(0, Math.floor((Date.now() - new Date(r.liveSince)) / 60000)) : 0);

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
      h('div', { class: 'f-intro' },
        h('span', { class: 'f-intro-icon' }, userPlusIcon()),
        h('b', null, p ? '지금은 친구에게 공부 시간을 보여 주지 않고 있어요' : '친구와 공부 시간 겨루기'),
        h('p', null, '닉네임을 정하면 친구 코드가 생겨요. 코드로 신청하고 상대가 수락하면 서로 오늘 공부 시간과 지금 공부 중인지 보여요. 과목이나 계획은 보이지 않아요.')),
      h('div', { class: 'inline-form' }, nick, h('button', { type: 'button', class: 'btn primary', onclick: go }, p ? '다시 공개' : '시작하기')),
      msg);
    return;
  }

  // 랭킹: 오늘 · 이번 주 · 이번 달. 지금 공부 중인 시간도 더해서 (친구 쪽은 공부 시작 시각부터)
  const m = dailyMap();
  const sumFrom = key => [...m.entries()].reduce((a, [k, v]) => (k >= key ? a + v : a), 0);
  const today = studyDate();
  const me = {
    me: true, nickname: p.nickname,
    today: todaySeconds(),
    week: sumFrom(dayKey(startOfWeek(today))),
    month: sumFrom(dayKey(new Date(today.getFullYear(), today.getMonth(), 1))),
    liveSince: timer.phase === 'focus' && timer.running ? new Date(timer.sessStart).toISOString() : null,
  };
  const liveSec = r => (r.liveSince ? Math.max(0, Math.floor((Date.now() - new Date(r.liveSince)) / 1000)) : 0);
  const val = r => (r.me ? r[friendRange] || 0 : (r[friendRange] || 0) + liveSec(r));
  const rows = [me, ...study.friends].sort((a, b) => (val(b) - val(a)) || (a.me ? -1 : b.me ? 1 : 0));
  const top = Math.max(1, ...rows.map(val));
  let rank = 0, prev = null;
  const ranks = rows.map((r, i) => { if (val(r) !== prev) { rank = i + 1; prev = val(r); } return rank; });

  const rangeBtns = h('div', { class: 'segmented f-range', role: 'radiogroup', 'aria-label': '기간' },
    [['today', '오늘'], ['week', '이번 주'], ['month', '이번 달']].map(([k, label]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': friendRange === k ? 'true' : 'false',
      onclick: () => { friendRange = k; try { storage.set('ddayboard.friendRange', k); } catch { /* 무시 */ } renderFriends(); },
    }, label)));

  // 받은 신청
  const inc = study.requests.incoming;
  const incoming = inc.length ? h('section', { class: 'f-sec f-requests' },
    h('h4', null, '받은 신청', h('span', { class: 'f-count' }, inc.length)),
    h('ul', { class: 'f-req-list' }, inc.map(r => h('li', null,
      avatar(r.nickname),
      h('span', { class: 'f-req-name' }, r.nickname),
      h('button', { type: 'button', class: 'btn sm primary', onclick: () => friendAction(async () => {
        study.friends = await api.friendAccept(state.code, r.code);
        study.requests.incoming = study.requests.incoming.filter(x => x.code !== r.code);
      }, `${r.nickname} 님과 친구가 됐어요`) }, '수락'),
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => friendAction(async () => {
        await api.friendRemove(state.code, r.code);
        study.requests.incoming = study.requests.incoming.filter(x => x.code !== r.code);
      }, '신청을 거절했어요') }, '거절'))))) : null;

  // 순위
  const ranking = h('section', { class: 'f-sec' },
    h('div', { class: 'f-sec-head' }, h('h4', null, '순위'), rangeBtns),
    h('ol', { class: 'friend-list' }, rows.map((r, i) => {
      const v = val(r);
      return h('li', { class: `${r.me ? 'me' : ''}${r.liveSince ? ' live' : ''}` },
        h('span', { class: `f-rank${ranks[i] <= 3 && v > 0 ? ` r${ranks[i]}` : ''}`, 'aria-label': `${ranks[i]}등` }, ranks[i]),
        avatar(r.nickname, !!r.liveSince, r.me),
        h('span', { class: 'f-main' },
          h('span', { class: 'f-line' },
            h('span', { class: 'f-nick' }, r.nickname, r.me ? h('span', { class: 'f-me' }, '나') : null),
            r.liveSince ? h('span', { class: 'f-live' }, `공부 중 ${liveMinOf(r)}분`) : null),
          h('span', { class: 'f-bar' }, h('i', { style: { width: `${Math.max(v ? 3 : 0, (v / top) * 100)}%` } }))),
        h('span', { class: 'f-time' }, fmtSpent(v)),
        r.me ? h('span', { class: 'f-x' }) : h('button', {
          type: 'button', class: 'btn icon ghost sm-icon f-x', title: '친구 끊기', 'aria-label': `${r.nickname} 친구 끊기`,
          onclick: () => friendAction(async () => { study.friends = await api.friendRemove(state.code, r.code); }, `${r.nickname} 님과 친구를 끊었어요`),
        }, xIcon()));
    })),
    rows.length === 1 ? h('p', { class: 'f-empty' }, '아직 친구가 없어요. 아래에서 친구 코드로 신청해 보세요.') : null);

  // 친구 신청 보내기 + 보낸 신청
  const code = h('input', { type: 'text', maxlength: 12, placeholder: '친구 코드 (예: AB12-CD34)', 'aria-label': '친구 코드', class: 'code-input', autocomplete: 'off', spellcheck: 'false' });
  const add = () => friendAction(async () => {
    if (!code.value.trim()) throw new Error('friend_not_found');
    const before = study.friends.length;
    study.friends = await api.friendAdd(state.code, code.value);
    code.value = '';
    const req = await api.friendRequests(state.code).catch(() => null);
    if (req) study.requests = { incoming: req.incoming || [], outgoing: req.outgoing || [] };
    friendMsg = { text: study.friends.length > before ? '서로 친구가 됐어요' : '신청했어요. 상대가 수락하면 순위에 보여요', err: false };
  });
  code.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) add(); });
  const out = study.requests.outgoing;
  const addSec = h('section', { class: 'f-sec' },
    h('h4', null, '친구 신청'),
    h('div', { class: 'inline-form' }, code, h('button', { type: 'button', class: 'btn primary', onclick: add }, '신청')),
    msg,
    out.length ? h('ul', { class: 'f-out' }, out.map(r => h('li', null,
      h('span', null, r.nickname, h('small', null, ' · 수락 기다리는 중')),
      h('button', { type: 'button', class: 'btn sm ghost', onclick: () => friendAction(async () => {
        await api.friendRemove(state.code, r.code);
        study.requests.outgoing = study.requests.outgoing.filter(x => x.code !== r.code);
      }, '신청을 취소했어요') }, '취소')))) : null);

  // 내 코드 · 관리
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
    friendAction(async () => { study.profile = await api.studyNewCode(state.code); }, '새 코드를 만들었어요. 이전 코드로는 더 이상 신청할 수 없어요');
  });
  const mine = h('section', { class: 'f-sec f-mine' },
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
      h('summary', null, '닉네임 · 공개 설정'),
      h('div', { class: 'inline-form' }, newNick, h('button', {
        type: 'button', class: 'btn sm',
        onclick: () => friendAction(async () => { study.profile = await api.studyProfile(state.code, newNick.value); }, '닉네임을 바꿨어요'),
      }, '닉네임 바꾸기')),
      h('div', { class: 'row-actions start' },
        newCodeBtn,
        h('button', {
          type: 'button', class: 'btn sm danger ghost',
          onclick: () => friendAction(async () => { study.profile = await api.studyProfileHide(state.code); study.friends = []; }, '친구에게 더 이상 보이지 않아요'),
        }, '공개 그만하기'))));

  fill(body, incoming, ranking, addSec, mine);
}

/* ───── 공부 화면 아래: 지금 공부 중인 친구 ───── */
function renderLiveFriends() {
  if (!el.liveFriends) return;
  const vis = study.profile && study.profile.visible;
  const live = vis ? study.friends.filter(f => f.liveSince).sort((a, b) => new Date(a.liveSince) - new Date(b.liveSince)) : [];
  el.liveFriends.hidden = !live.length;
  if (!live.length) { el.liveFriends.replaceChildren(); return; }
  fill(el.liveFriends,
    h('h3', null, '지금 공부 중인 친구', h('span', { class: 'lf-count' }, live.length)),
    h('ul', { class: 'lf-list' }, live.map(f => h('li', null,
      h('span', { class: 'lf-icon', 'aria-hidden': 'true' }, personIcon()),
      h('span', { class: 'lf-name' }, f.nickname),
      h('span', { class: 'lf-today' }, `오늘 ${fmtSpent((f.today || 0) + Math.floor((Date.now() - new Date(f.liveSince)) / 1000))}`),
      h('span', { class: 'lf-timer', dataset: { since: f.liveSince } }, clock(Date.now() - new Date(f.liveSince), true))))));
}
// 1초마다 친구 타이머 숫자만
function tickLiveFriends() {
  if (!el.liveFriends || el.liveFriends.hidden) return;
  for (const t of el.liveFriends.querySelectorAll('.lf-timer')) t.textContent = clock(Math.max(0, Date.now() - new Date(t.dataset.since)), true);
}

/* ───── 시작 ───── */
export function initStudy(options) {
  ctx = { ...ctx, ...options };
  subscribe(what => {
    if (what === 'board') {
      Object.assign(study, { loaded: false, sessions: [], daily: new Map(), plans: [], profile: null, friends: [], requests: { incoming: [], outgoing: [] }, extra: new Map() });
      loadedRanges.clear();
      builtFor = null;
    }
  });
  // 친구 목록은 공부 모드일 때 1분마다 (위쪽 버튼의 "공부 중" 숫자)
  setInterval(() => {
    if (!document.hidden && (!$('#viewStudy')?.hidden || $('#friendsDialog')?.open)) loadFriends();
  }, 60000);
  tick();
  // 다른 기기에서 시작·끝낸 타이머 받아 오기: 처음, 창으로 돌아올 때, 보는 동안 20초마다
  pullTimer();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pullTimer(); });
  setInterval(() => { if (!document.hidden) pullTimer(); }, 20000);
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
    else stop();
    return true;
  }
  return false;
}
