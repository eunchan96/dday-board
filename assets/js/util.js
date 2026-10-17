// 날짜 계산, 표시 형식, DOM 헬퍼

export const DAY = 86400000;
export const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

export const pad = n => String(n).padStart(2, '0');
export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toDateInput = dayKey;
export const toTimeInput = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// 월요일 시작 주
export function startOfWeek(d) {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}

export function fmtDate(d, withTime = true) {
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
  return withTime ? `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}` : base;
}
export const fmtClock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return mins ? `${hours}시간 ${mins}분` : `${hours}시간`;
  return `${mins}분`;
}

// D-day 라벨과 긴급도
export function dday(task, now = new Date()) {
  const due = new Date(task.due);
  const ms = due - now;
  if (task.done) return { label: '완료', level: 'done', ms };
  if (ms < 0) return { label: '지남', level: 'over', ms };
  const diff = Math.round((startOfDay(due) - startOfDay(now)) / DAY);
  return {
    label: diff === 0 ? 'D-DAY' : `D-${diff}`,
    level: ms <= DAY ? 'urgent' : diff <= 3 ? 'soon' : 'normal',
    ms,
  };
}

// 목록 보기용 묶음
export const GROUPS = [
  { key: 'over', name: '마감 지남' },
  { key: 'today', name: '오늘' },
  { key: 'tomorrow', name: '내일' },
  { key: 'week', name: '이번 주' },
  { key: 'next', name: '다음 주' },
  { key: 'later', name: '그 이후' },
  { key: 'done', name: '완료' },
];

export function groupOf(task, now = new Date()) {
  if (task.done) return 'done';
  const due = new Date(task.due);
  if (due < now) return 'over';
  const today = startOfDay(now);
  const d = startOfDay(due);
  if (sameDay(d, today)) return 'today';
  if (sameDay(d, addDays(today, 1))) return 'tomorrow';
  const weekEnd = addDays(startOfWeek(now), 7);
  if (d < weekEnd) return 'week';
  if (d < addDays(weekEnd, 7)) return 'next';
  return 'later';
}

// 과목별 색 (인덱스 탭 색)
// 보드에 있는 과목을 이름순으로 세워 차례로 색을 줘서, 과목끼리 색이 겹치지 않게 한다.
const SUBJECT_COLORS = ['#3D6BE0', '#E0703D', '#2E9E74', '#9A5BD6', '#C99A12', '#D84C7E', '#1E8FA8', '#7A7F3A', '#B5523B', '#5A6FA8'];
let subjectOrder = new Map();
export function setSubjects(names) {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  subjectOrder = new Map(sorted.map((n, i) => [n, i]));
}
export function subjectColor(name) {
  if (!name) return 'var(--pencil-2)';
  if (subjectOrder.has(name)) return SUBJECT_COLORS[subjectOrder.get(name) % SUBJECT_COLORS.length];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return SUBJECT_COLORS[h % SUBJECT_COLORS.length];
}

// 안전한 DOM 생성: h('div', { class: 'x', onclick: fn }, '텍스트', child)
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val); else el.style[p] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
