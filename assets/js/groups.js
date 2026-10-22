// 묶음: 학기 · 기간 · 넓은 의미의 과목(토익, 운동 …)을 사용자가 직접 만들고 고친다
//
// 보드에 저장 (dday_subject_prefs.groups / dday_set_groups):
//   groups  [{ id, name, start: 'YYYY-MM-DD'|null, end: 'YYYY-MM-DD'|null, auto }]
//           auto = 마감 날짜로 저절로 만든 학기 (id는 '2026-2' 꼴)
//   members { 과목: [묶음 id …] | ['*'] }   '*' = 모든 묶음에 항상 (예: 운동하기)
//   removed ['2026-1' …]                     지운 자동 학기는 다시 만들지 않음
//
// 일정이 어느 묶음에 보이는지
//   1) 과목이 묶음에 들어 있으면 그 묶음들 (여러 개 가능, '*'면 전부)
//   2) 아니면 마감 날짜가 기간 안에 드는 묶음들

import { state, storage } from './store.js';
import { api } from './api.js';
import { semesterOf, semesterKey, semesterLabel, semesterRange, parseSemesterKey, toDateInput, startOfDay, addDays } from './util.js';

const KEY = 'ddayboard.groups';
export const ALL = '*';

let data = normalize((() => { try { return JSON.parse(storage.get(KEY) || '{}'); } catch { return {}; } })());
const listeners = new Set();
export const onGroupsChange = f => listeners.add(f);

function normalize(d) {
  const o = d && typeof d === 'object' ? d : {};
  const groups = (Array.isArray(o.groups) ? o.groups : [])
    .filter(g => g && typeof g.id === 'string' && typeof g.name === 'string')
    .map(g => ({ id: g.id, name: g.name, start: g.start || null, end: g.end || null, auto: !!g.auto }));
  const members = {};
  for (const [k, v] of Object.entries(o.members && typeof o.members === 'object' ? o.members : {})) {
    if (Array.isArray(v) && v.length) members[k] = v.filter(x => typeof x === 'string');
  }
  const removed = (Array.isArray(o.removed) ? o.removed : []).filter(x => typeof x === 'string');
  return { groups, members, removed };
}

export const groupsData = () => data;

function store() { storage.set(KEY, JSON.stringify(data)); }
let saveTimer = 0;
let serverLoaded = false;       // 보드 값을 한 번 받기 전에는 올리지 않음 (다른 기기에서 만든 묶음을 덮지 않게)
function save() {
  store();
  listeners.forEach(f => f());
  if (!serverLoaded) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!state.code) return;
    const snap = data;
    api.setGroups(state.code, snap).catch(e => listeners.forEach(f => f(e)));
  }, 250);
}

// 서버 값을 받아 반영 (처음이면 날짜로 학기를 만들어 올림)
export function applyServerGroups(raw) {
  serverLoaded = true;
  const next = normalize(raw);
  const empty = !next.groups.length && !Object.keys(next.members).length && !next.removed.length;
  if (empty && data.groups.length) {             // 이 기기에서 먼저 만든 게 있으면 그걸 올림
    save();
    return true;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(data);
  data = next;
  store();
  const added = ensureTerms();
  return changed || added;
}

/* ───── 날짜 ───── */
const dayStr = d => toDateInput(d);
const parseDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
export const groupStart = g => parseDay(g.start);
export const groupEndExclusive = g => { const e = parseDay(g.end); return e ? addDays(e, 1) : null; };
export const isDated = g => !!(g.start || g.end);
export function contains(g, date) {
  if (!isDated(g)) return false;
  const d = new Date(date);
  const s = groupStart(g), e = groupEndExclusive(g);
  return (!s || d >= s) && (!e || d < e);
}
export function periodText(g) {
  if (!isDated(g)) return '기간 없음';
  const f = s => { const d = parseDay(s); return d ? `${d.getFullYear() % 100}.${d.getMonth() + 1}.${d.getDate()}` : ''; };
  return `${f(g.start)} ~ ${f(g.end)}`;
}

/* ───── 자동 학기 ───── */
function termGroup(key) {
  const s = parseSemesterKey(key);
  const r = semesterRange(s);
  return { id: key, name: semesterLabel(s), start: dayStr(r.start), end: dayStr(addDays(r.end, -1)), auto: true };
}
// 일정이 있는 학기와 이번 학기는 묶음이 없으면 만든다 (사용자가 지운 학기는 빼고)
export function ensureTerms() {
  const keys = new Set(state.tasks.map(t => semesterKey(semesterOf(t.due))));
  keys.add(semesterKey(semesterOf(new Date())));
  let added = false;
  for (const k of keys) {
    if (data.groups.some(g => g.id === k) || data.removed.includes(k)) continue;
    data.groups.push(termGroup(k));
    added = true;
  }
  if (added) save();
  return added;
}

/* ───── 읽기 ───── */
export function groupsSorted() {
  const dated = data.groups.filter(isDated).sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')) || a.name.localeCompare(b.name, 'ko'));
  const free = data.groups.filter(g => !isDated(g)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return [...dated, ...free];
}
export const groupById = id => data.groups.find(g => g.id === id) || null;

// 오늘이 들어 있는 묶음 (여러 개면 자동 학기 → 짧은 기간 순)
export function currentGroupId(now = new Date()) {
  const hits = data.groups.filter(g => contains(g, now));
  if (!hits.length) return null;
  const len = g => (groupEndExclusive(g) || new Date(8.64e15)) - (groupStart(g) || new Date(-8.64e15));
  hits.sort((a, b) => (b.auto - a.auto) || (len(a) - len(b)));
  return hits[0].id;
}

// 위에서 고른 묶음 ('all'이면 null = 전체)
export function activeGroupId() {
  const p = state.prefs.semester;
  if (p === 'all') return null;
  if (p && p !== 'current' && groupById(p)) return p;
  return currentGroupId();
}

export const membersOf = name => data.members[name] || [];
const memberIds = name => membersOf(name).filter(id => id === ALL || groupById(id));

// 이 일정이 보이는 묶음 id들 (ALL이면 전부)
export function taskGroupIds(t) {
  const m = t.subject ? memberIds(t.subject) : [];
  if (m.includes(ALL)) return [ALL];
  if (m.length) return m;
  return data.groups.filter(g => contains(g, t.due)).map(g => g.id);
}
export function inGroup(t, gid) {
  if (!gid) return true;
  const ids = taskGroupIds(t);
  return ids.includes(ALL) || ids.includes(gid);
}
// 과목이 이 묶음에 속하는지: 직접 넣었거나, 소속을 안 정했으면 그 과목 일정이 기간 안에 있을 때
// (일정도 소속도 없는 과목 = 직접 추가만 한 과목은 어디서나 보임)
export function subjectInGroup(name, gid) {
  if (!gid) return true;
  const m = memberIds(name);
  if (m.length) return m.includes(ALL) || m.includes(gid);
  const tasks = state.tasks.filter(t => t.subject === name);
  if (!tasks.length) return true;
  const g = groupById(gid);
  return !!g && tasks.some(t => contains(g, t.due));
}
// 소속을 안 정한 과목이 마감 날짜로 들어가는 묶음들
export function implicitGroupIds(name) {
  const ids = new Set();
  for (const t of state.tasks) if (t.subject === name) for (const g of data.groups) if (contains(g, t.due)) ids.add(g.id);
  return [...ids];
}
// 과목이 어디 속하는지 짧게 (설정 화면용)
export function membershipText(name) {
  const m = memberIds(name);
  if (m.includes(ALL)) return '모든 묶음';
  if (m.length) return m.map(id => groupById(id)?.name).filter(Boolean).join(' · ');
  const ids = new Set();
  for (const t of state.tasks) if (t.subject === name) for (const g of data.groups) if (contains(g, t.due)) ids.add(g.id);
  return ids.size ? `날짜로 · ${[...ids].map(id => groupById(id).name).join(' · ')}` : '날짜로';
}

/* ───── 고치기 ───── */
export function setMembers(name, ids) {
  const n = String(name || '').trim();
  if (!n) return;
  const clean = ids.includes(ALL) ? [ALL] : [...new Set(ids)].filter(id => groupById(id));
  if (clean.length) data.members = { ...data.members, [n]: clean };
  else { const { [n]: _, ...rest } = data.members; data.members = rest; }
  save();
}
// 새 과목을 만들면 지금 보고 있는 묶음에 넣어 둔다 (나중에 설정에서 바꿀 수 있음)
export function assignNewSubject(name) {
  const gid = activeGroupId();
  if (gid && !membersOf(name).length) setMembers(name, [gid]);
}

const newGroupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
export function addGroup({ name, start, end }) {
  const g = { id: newGroupId(), name: String(name).trim().slice(0, 30), start: start || null, end: end || null, auto: false };
  data.groups = [...data.groups, g];
  save();
  return g;
}
export function updateGroup(id, { name, start, end }) {
  data.groups = data.groups.map(g => g.id === id
    ? { ...g, name: String(name).trim().slice(0, 30), start: start || null, end: end || null } : g);
  save();
}
export function removeGroup(id) {
  const g = groupById(id);
  if (!g) return;
  data.groups = data.groups.filter(x => x.id !== id);
  if (g.auto && !data.removed.includes(id)) data.removed = [...data.removed, id];
  const members = {};
  for (const [k, v] of Object.entries(data.members)) {
    const rest = v.filter(x => x !== id);
    if (rest.length) members[k] = rest;
  }
  data.members = members;
  if (state.prefs.semester === id) state.prefs.semester = 'current';
  save();
}
// 과목 이름이 바뀌거나 지워졌을 때 소속도 정리
export function forgetMembers(name) {
  if (!data.members[name]) return;
  const { [name]: _, ...rest } = data.members;
  data.members = rest;
  save();
}

export const todayStr = () => dayStr(startOfDay(new Date()));
