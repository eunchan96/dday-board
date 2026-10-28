// 앱 상태와 서버 동기화
// - 화면은 먼저 바꾸고(낙관적 업데이트) 서버에 반영, 실패하면 서버 상태로 되돌린다.
// - 다른 기기 변경은 주기적 조회로 받아온다.

import { api, errText } from './api.js';
import { newId } from './util.js';

const KEYS = {
  code: 'ddayboard.code',
  cache: 'ddayboard.cache',
  legacy: 'ddayboard.v1',
  prefs: 'ddayboard.prefs',
};

export const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};

function readJSON(k, fallback) {
  try { const v = JSON.parse(storage.get(k) || 'null'); return v ?? fallback; } catch { return fallback; }
}

const listeners = new Set();
export const state = {
  code: storage.get(KEYS.code),
  tasks: readJSON(KEYS.cache, []),
  inflight: 0,
  lastSync: null,
  syncError: null,
  lms: { connected: false, syncedAt: null, error: null },
  prefs: Object.assign({ view: 'list', mode: 'plan', studyView: 'today', hideDone: false, theme: 'system', subject: null, starredOnly: false, kind: null, semester: 'current' },
                       readJSON(KEYS.prefs, {})),
};
let localVersion = 0;

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what = 'all') { for (const fn of listeners) fn(what); }

export function setPref(key, value) {
  state.prefs[key] = value;
  storage.set(KEYS.prefs, JSON.stringify(state.prefs));
  emit('prefs');
}

function cache() { storage.set(KEYS.cache, JSON.stringify(state.tasks)); }

/* ───── 서버 동기화 ───── */
export async function pull() {
  if (!state.code || state.inflight > 0) return;
  state.inflight++; emit('status');
  const startedAt = localVersion;
  try {
    const data = await api.list(state.code);
    if (startedAt !== localVersion) return;          // 받는 사이 이 기기에서 수정됨
    // 되돌리기 대기 중인 삭제는 화면에서 계속 빼 둔다
    state.tasks = (Array.isArray(data) ? data : []).filter(t => !pendingRemovals.has(t.id));
    cache();
    state.syncError = null;
    state.lastSync = new Date();
    emit('tasks');
  } catch (e) {
    if (e.message === 'invalid_code') { disconnect('이 기기에 저장된 보드 코드가 더 이상 유효하지 않아요'); return; }
    state.syncError = errText(e);
  } finally {
    state.inflight = Math.max(0, state.inflight - 1);
    emit('status');
  }
}

async function push(fn) {
  localVersion++;
  state.inflight++; emit('status');
  let failed = false;
  try {
    await fn();
    state.syncError = null;
    state.lastSync = new Date();
  } catch (e) {
    failed = true;
    state.syncError = errText(e);
  } finally {
    state.inflight = Math.max(0, state.inflight - 1);
    emit('status');
    if (failed) pull();
  }
}

const payload = t => ({
  id: t.id, kind: ['exam', 'todo', 'etc'].includes(t.kind) ? t.kind : 'assignment',
  etcType: t.kind === 'etc' ? t.etcType || null : null,
  subject: t.subject || '', title: t.title, due: t.due, endAt: t.endAt || null,
  location: t.location || '', done: !!t.done, memo: t.memo || '', starred: !!t.starred,
});

export function saveTask(fields, id) {
  let task = id && state.tasks.find(t => t.id === id);
  if (task) Object.assign(task, fields);
  else {
    task = Object.assign({
      id: newId(), kind: 'assignment', done: false, starred: false, memo: '', location: '', endAt: null,
      source: 'manual', link: null,
    }, fields);
    state.tasks.push(task);
  }
  cache(); emit('tasks');
  push(() => api.upsert(state.code, payload(task)));
  return task;
}

export function toggleDone(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? new Date().toISOString() : null;
  cache(); emit('tasks');
  push(() => api.upsert(state.code, payload(t)));
}

export function toggleStar(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  t.starred = !t.starred;
  cache(); emit('tasks');
  push(() => api.upsert(state.code, payload(t)));
}

// 삭제는 화면에서 먼저 빼고, 되돌리기 시간이 지나면 서버에 반영
const pendingRemovals = new Map();
export function removeTask(id, delayMs = 5000) {
  const idx = state.tasks.findIndex(t => t.id === id);
  if (idx < 0) return null;
  const [task] = state.tasks.splice(idx, 1);
  cache(); emit('tasks');
  localVersion++;
  const timer = setTimeout(() => {
    pendingRemovals.delete(id);
    push(() => api.remove(state.code, id));
  }, delayMs);
  pendingRemovals.set(id, { task, timer });
  return task;
}
export function undoRemove(id) {
  const p = pendingRemovals.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingRemovals.delete(id);
  state.tasks.push(p.task);
  cache(); emit('tasks');
}
export function flushRemovals() {
  for (const [id, p] of pendingRemovals) {
    clearTimeout(p.timer);
    api.remove(state.code, id).catch(() => {});
  }
  pendingRemovals.clear();
}
export const hasPendingRemovals = () => pendingRemovals.size > 0;

/* ───── 보드 연결 ───── */
function toServerTasks(list) {
  return (Array.isArray(list) ? list : [])
    .filter(t => t && t.title && t.due && !isNaN(new Date(t.due)))
    .map(t => ({
      id: String(t.id || newId()).slice(0, 40),
      subject: String(t.subject || '').slice(0, 40),
      title: String(t.title).slice(0, 200),
      due: new Date(t.due).toISOString(),
      done: !!t.done,
    }));
}

async function migrateLegacy() {
  const list = toServerTasks(readJSON(KEYS.legacy, []));
  if (!list.length) return 0;
  const n = await api.importTasks(state.code, list);
  storage.del(KEYS.legacy);
  return n;
}

export async function importBackup(text) {
  let list;
  try { list = toServerTasks(JSON.parse(text)); } catch { throw new Error('invalid_import'); }
  if (!list.length) throw new Error('invalid_import');
  const n = await api.importTasks(state.code, list);
  await pull();
  return n;
}

export async function createBoard() {
  const code = await api.createBoard();
  state.code = code;
  storage.set(KEYS.code, code);
  await migrateLegacy().catch(() => 0);
  state.tasks = [];
  emit('board');
  await pull();
  return code;
}

export async function connect(input) {
  const code = input.trim().toUpperCase();
  if (code.replace(/[^A-Z0-9]/g, '').length < 20) throw new Error('short_code');
  const data = await api.list(code);
  state.code = code;
  storage.set(KEYS.code, code);
  state.tasks = Array.isArray(data) ? data : [];
  const n = await migrateLegacy().catch(() => 0);
  if (n) state.tasks = await api.list(code);
  cache();
  state.lastSync = new Date(); state.syncError = null;
  emit('board');
  loadLms();
}

export function disconnect(reason) {
  flushRemovals();
  state.code = null; state.tasks = [];
  state.lms = { connected: false, feed: false, token: false, tokenHint: null, syncedAt: null, error: null };
  storage.del(KEYS.code); storage.del(KEYS.cache);
  emit('board');
  if (reason) emit({ type: 'disconnected', reason });
}

/* ───── 스마트캠퍼스 ───── */
export async function loadLms() {
  if (!state.code) return;
  try { state.lms = await api.lmsStatus(state.code); emit('lms'); } catch { /* 다음에 다시 */ }
}

export async function lmsSync() {
  state.inflight++; emit('status');
  try {
    const r = await api.lmsSync(state.code);
    state.syncError = null;
    return r;
  } finally {
    state.inflight = Math.max(0, state.inflight - 1);
    emit('status');
    await pull();
    await loadLms();
  }
}

export async function setFeed(url) {
  state.lms = await api.setFeed(state.code, url);
  emit('lms');
  return state.lms;
}

export async function setToken(token) {
  state.lms = await api.setToken(state.code, token);
  emit('lms');
  return state.lms;
}

export async function setOrigin(origin) {
  state.lms = await api.setOrigin(state.code, origin);
  emit('lms');
  return state.lms;
}

export async function canvasImport(items) {
  const r = await api.canvasImport(state.code, items);
  await pull();
  await loadLms();
  return r;
}

export function exportBackup() {
  return JSON.stringify(state.tasks.map(t => ({
    id: t.id, subject: t.subject, title: t.title, due: t.due, done: t.done,
  })), null, 1);
}
