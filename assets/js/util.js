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
// 시험은 "중간고사"만으로는 무슨 과목인지 모르니 과목명을 앞에 붙인다
export function displayTitle(t, short = false) {
  if (t.kind === 'exam' && t.subject && !t.title.includes(t.subject)) return `${short ? shortSubject(t.subject) : t.subject} ${t.title}`;
  return t.title;
}

// 목록용 짧은 날짜: 10/20 (화) 23:59
export function fmtShort(d, withTime = true) {
  const base = `${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
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

export const isExam = t => t.kind === 'exam';

/* ───── 학기 ─────
   1학기: 3월 2일 ~ 8월 31일 (여름방학 포함)
   2학기: 9월 1일 ~ 다음 해 3월 1일 (겨울방학 포함) */
export function semesterOf(date) {
  const d = new Date(date);
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (m >= 9) return { year: y, term: 2 };
  if (m < 3 || (m === 3 && day < 2)) return { year: y - 1, term: 2 };
  return { year: y, term: 1 };
}
export const semesterKey = s => `${s.year}-${s.term}`;
export const semesterLabel = s => `${s.year}년 ${s.term}학기`;
export function parseSemesterKey(key) {
  const m = /^(\d{4})-([12])$/.exec(key || '');
  return m ? { year: +m[1], term: +m[2] } : null;
}
export function semesterRange(s) {
  return s.term === 1
    ? { start: new Date(s.year, 2, 2), end: new Date(s.year, 8, 1) }
    : { start: new Date(s.year, 8, 1), end: new Date(s.year + 1, 2, 2) };
}
export const taskSemesterKey = t => semesterKey(semesterOf(t.due));

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 시험이 끝났는지 (끝나는 시각이 없으면 시작 시각 기준)
export function examOver(t, now = new Date()) {
  const end = t.endAt ? new Date(t.endAt) : new Date(t.due);
  return now >= end;
}

// "10:30–12:00" 또는 "10:30"
export function timeRange(t) {
  const s = new Date(t.due);
  const start = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
  if (!t.endAt) return start;
  const e = new Date(t.endAt);
  return `${start}–${pad(e.getHours())}:${pad(e.getMinutes())}`;
}

// D-day 라벨과 긴급도
export function dday(task, now = new Date()) {
  const due = new Date(task.due);
  const ms = due - now;
  if (task.done) return { label: isExam(task) ? '응시함' : '완료', level: 'done', ms };
  if (isExam(task) && ms < 0) {
    return examOver(task, now) ? { label: '끝남', level: 'done', ms } : { label: '시험 중', level: 'urgent', ms };
  }
  if (ms < 0 && task.kind === 'etc') return { label: '지남', level: 'done', ms };   // 기타(휴강 등)는 지나면 끝난 일정
  if (ms < 0) return { label: task.missing ? '미제출' : '지남', level: 'over', ms };
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
  if (isExam(task) && due < now) return examOver(task, now) ? 'done' : 'today';   // 지난 시험은 완료 쪽으로
  if (due < now) return task.kind === 'etc' ? 'done' : 'over';
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
// 설정에서 고를 수 있는 색 (기본 색 + 몇 가지 더)
export const SUBJECT_PALETTE = [...SUBJECT_COLORS, '#D64545', '#4E9A2E', '#8A6A4C', '#6B7280'];
let subjectOrder = new Map();
let subjectOverride = {};                       // 사용자가 바꾼 색 (보드에 저장)
export function setSubjectColors(map) { subjectOverride = map && typeof map === 'object' ? map : {}; }
export const customColorOf = name => subjectOverride[name] || null;
// 사용자가 정한 과목 순서 (설정 → 과목). 정하지 않은 과목은 원래 순서대로 뒤에
let subjectRank = new Map();
export function setSubjectOrder(list) { subjectRank = new Map((Array.isArray(list) ? list : []).map((n, i) => [n, i])); }
export function orderSubjects(names) {
  if (!subjectRank.size) return names;
  const idx = new Map(names.map((n, i) => [n, i]));
  const rank = n => (subjectRank.has(n) ? subjectRank.get(n) : 1e6 + idx.get(n));
  return names.slice().sort((a, b) => rank(a) - rank(b));
}
export function setSubjects(names) {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  subjectOrder = new Map(sorted.map((n, i) => [n, i]));
}
export function subjectColor(name) {
  if (!name) return 'var(--pencil-2)';
  if (subjectOverride[name]) return subjectOverride[name];
  if (subjectOrder.has(name)) return SUBJECT_COLORS[subjectOrder.get(name) % SUBJECT_COLORS.length];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return SUBJECT_COLORS[h % SUBJECT_COLORS.length];
}

// 과목 줄임말 (설정 → 과목에서 정함). 캘린더처럼 좁은 곳에서 과목 이름 대신
let subjectShortMap = {};
export function setSubjectShorts(map) { subjectShortMap = map && typeof map === 'object' ? map : {}; }
export const subjectShortOf = name => (name && subjectShortMap[name]) || '';
export const shortSubject = name => subjectShortOf(name) || name || '';

// '기타' 종류: [{ id, name, color }] (보드에 저장)
// '영상 시청'(id video)은 늘 있는 종류: 스마트캠퍼스 강의 영상이 이 종류로 보인다 (색만 바꿀 수 있음)
let etcList = [];
export const ETC_DEFAULT_COLOR = '#9AA0AA';
export const VIDEO_TYPE = { id: 'video', name: '영상 시청', color: '#2E9E74' };
export function setEtcTypes(list) { etcList = Array.isArray(list) ? list.filter(e => e && e.id && e.name) : []; }
export const savedEtcTypes = () => etcList.slice();
export const etcTypes = () => (etcList.some(e => e.id === VIDEO_TYPE.id) ? etcList.slice() : [...etcList, { ...VIDEO_TYPE }]);
// 스마트캠퍼스에서 가져온 강의 영상 (할 일로 저장되지만 '영상 시청'으로 보여 줌)
export const isLecture = t => !!t && t.kind === 'todo' && t.source === 'canvas';
export const etcTypeOf = t => {
  if (isLecture(t)) return etcTypes().find(e => e.id === VIDEO_TYPE.id);
  return t && t.kind === 'etc' ? etcTypes().find(e => e.id === t.etcType) || null : null;
};
export const etcLabel = t => etcTypeOf(t)?.name || '기타';
export const etcColor = t => etcTypeOf(t)?.color || ETC_DEFAULT_COLOR;
// 캘린더 · 위젯처럼 좁은 곳의 이름 (위젯 서버의 app.widget_label과 같은 규칙)
//  과제: 과목 과제 · 강의 영상: 과목 영상 시청
//  시험 · 기타: 과목 + 이름 (기타 이름을 비워 종류 이름이 됐으면 과목 + 종류 → 데이터베이스 휴강)
//  이름에 과목(줄임말)이 이미 있으면 다시 붙이지 않음, 과목이 없으면 이름 그대로
export function shortLabel(t) {
  if (!t.subject) return t.title;
  const subj = shortSubject(t.subject);
  if (isLecture(t)) return `${subj} ${etcLabel(t)}`;
  if (t.kind === 'exam' || t.kind === 'etc') {
    if (t.kind === 'etc' && t.title === etcLabel(t)) return `${subj} ${t.title}`;
    if (t.title.includes(t.subject)) return t.title.replace(t.subject, subj);
    if (t.title.includes(subj)) return t.title;
    return `${subj} ${t.title}`;
  }
  if (t.kind === 'todo') return t.title;
  return `${subj} 과제`;
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
