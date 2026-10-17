// 한 줄 빠른 입력 해석
// 예) "데이터베이스 과제 금요일까지"      → 과목 데이터베이스, 과제, 이번 주 금요일 23:59
//     "운영체제 중간고사 10월 29일 오후 1시" → 과목 운영체제, 시험, 10/29 13:00 (끝 14:00)
//     "소켓 서버 구현 내일 3시"            → 내일 15:00
//     "레포트 11/2"                       → 11월 2일 23:59

import { startOfDay, addDays, startOfWeek, pad } from './util.js';

const DAYS = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const EXAM_RE = /(중간|기말)\s*고사|시험|퀴즈|쪽지\s*시험|test|exam|quiz/i;

function nextWeekday(today, dow) {
  const diff = (dow - today.getDay() + 7) % 7;
  return addDays(today, diff);
}

// 날짜·시간 표현을 찾아 빼고, 남은 글자를 돌려준다
export function parseQuick(input, now = new Date(), subjects = []) {
  let text = ` ${input.trim()} `;
  const today = startOfDay(now);
  let date = null, hour = null, minute = 0;
  const take = (re, fn) => {
    const m = text.match(re);
    if (!m) return false;
    fn(m);
    text = text.replace(m[0], ' ');
    return true;
  };

  // 날짜
  take(/\s(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?(?=\s|일|까지)/, m => { date = new Date(+m[1], +m[2] - 1, +m[3]); })
  || take(/\s(\d{1,2})\s*월\s*(\d{1,2})\s*일/, m => { date = new Date(today.getFullYear(), +m[1] - 1, +m[2]); if (date < addDays(today, -60)) date.setFullYear(date.getFullYear() + 1); })
  || take(/\s(\d{1,2})[./](\d{1,2})(?=\s|까지)/, m => { date = new Date(today.getFullYear(), +m[1] - 1, +m[2]); if (date < addDays(today, -60)) date.setFullYear(date.getFullYear() + 1); })
  || take(/\s(오늘|내일|낼|모레|글피)(?=\s|까지)/, m => { date = addDays(today, { 오늘: 0, 내일: 1, 낼: 1, 모레: 2, 글피: 3 }[m[1]]); })
  || take(/\s(\d{1,2})\s*일\s*(뒤|후)/, m => { date = addDays(today, +m[1]); })
  || take(/\s(\d)\s*주\s*(뒤|후)/, m => { date = addDays(today, +m[1] * 7); })
  || take(/\s(이번\s*주|다음\s*주|담주|다다음\s*주)?\s*([월화수목금토일])\s*요일/, m => {
    const dow = DAYS[m[2]];
    const which = (m[1] || '').replace(/\s/g, '');
    if (!which) { date = nextWeekday(today, dow); return; }
    const weekStart = startOfWeek(today);
    const offset = (dow + 6) % 7;                               // 월요일 시작
    const add = which === '이번주' ? 0 : which === '다다음주' ? 14 : 7;
    date = addDays(weekStart, add + offset);
    if (add === 0 && date < today) date = addDays(date, 7);      // 이번 주 그 요일이 지났으면 다음 주로
  })
  || take(/\s(이번\s*주|주말)(?=\s|까지)/, m => { date = addDays(startOfWeek(today), m[1].startsWith('주말') ? 6 : 4); });

  // 시간
  take(/\s(오전|오후|아침|낮|저녁|밤|새벽)?\s*(\d{1,2})\s*:\s*(\d{2})/, m => {
    hour = +m[2]; minute = +m[3];
    if (/오후|저녁|밤/.test(m[1] || '') && hour < 12) hour += 12;
    if (/오전|새벽|아침/.test(m[1] || '') && hour === 12) hour = 0;
  })
  || take(/\s(오전|오후|아침|낮|저녁|밤|새벽)?\s*(\d{1,2})\s*시\s*(반|(\d{1,2})\s*분)?/, m => {
    hour = +m[2]; minute = m[3] === '반' ? 30 : (m[4] ? +m[4] : 0);
    const ap = m[1] || '';
    if (/오후|저녁|밤|낮/.test(ap) && hour < 12) hour += 12;
    else if (/오전|새벽|아침/.test(ap) && hour === 12) hour = 0;
    else if (!ap && hour >= 1 && hour <= 7) hour += 12;          // "3시"는 보통 오후 3시
  })
  || take(/\s자정/, () => { hour = 23; minute = 59; });
  if (hour != null) hour = Math.min(23, Math.max(0, hour));
  if (minute != null) minute = Math.min(59, Math.max(0, minute));

  text = text.replace(/\s(까지|마감|제출)\s/g, ' ');

  // 과목: 이미 있는 과목 이름이 들어 있으면 (긴 이름 먼저)
  let subject = '';
  for (const s of [...subjects].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const i = text.indexOf(s);
    if (i >= 0) { subject = s; text = text.slice(0, i) + ' ' + text.slice(i + s.length); break; }
  }

  let title = text.replace(/\s+/g, ' ').trim();
  // 처음 보는 과목: "운영체제 중간고사", "자료구조 과제"처럼 끝이 일정 종류면 앞부분을 과목으로
  if (!subject) {
    const m = title.match(/^(\S.{0,30}?)\s+((중간|기말)\s*고사|시험|퀴즈|과제|레포트|보고서)$/);
    if (m) { subject = m[1]; title = m[2]; }
  }
  const kind = EXAM_RE.test(input) ? 'exam' : 'assignment';
  if (!title) title = kind === 'exam' ? '시험' : '과제';

  const time = hour != null ? `${pad(hour)}:${pad(minute)}` : (kind === 'exam' ? '10:30' : '23:59');
  let endTime = null;
  if (kind === 'exam') {
    const [hh, mm] = time.split(':').map(Number);
    endTime = `${pad(Math.min(23, hh + 1))}:${pad(hh + 1 > 23 ? 59 : mm)}`;
  }
  return { title, subject, kind, date, time, endTime, timeGiven: hour != null };
}
