// S-DAY 위젯 (아이폰 · Scriptable 앱)
//
// 위젯은 세 가지예요. 하나씩 따로 넣어요.
//   오늘 공부 · 타이머 · 다가오는 일정 · 캘린더
//
// 넣는 법
//  1) App Store에서 무료 앱 "Scriptable" 설치
//  2) S-DAY 설정 → 위젯 → 아이폰에서 원하는 위젯의 "복사" (주소가 들어간 채로 복사됨)
//  3) Scriptable 열기 → 오른쪽 위 + → 붙여 넣기 → 위쪽 제목을 "S-DAY 공부"처럼
//  4) 홈 화면을 길게 눌러 + → Scriptable → 크기 고르기 → 추가한 위젯을 길게 눌러 "위젯 편집" → Script 고르기
//     (잠금 화면 위젯도 같은 방법으로 넣을 수 있어요)
//  ※ 위젯 편집의 Parameter에 study · timer · upcoming 중 하나를 적으면 같은 스크립트로 다른 위젯도 돼요
//     숫자를 함께 적으면 배경 진하기(%)예요. 예: upcoming 60
//
// 위젯은 15분쯤마다 새로 고쳐지고, 누르면 S-DAY가 열려요.

const WIDGET_URL = '__WIDGET_URL__';
const KIND = '__KIND__';            // study | timer | upcoming | calendar
const OPACITY_SET = '__OPACITY__';  // 배경 진하기 0~100 (%)
const OPACITY = /^\d{1,3}$/.test(OPACITY_SET) ? Number(OPACITY_SET) : 100;
const THEME_SET = '__THEME__';      // system | light | dark (위젯마다 스크립트를 따로 복사하니 위젯별로 정할 수 있음)
const THEME = ['light', 'dark'].includes(THEME_SET) ? THEME_SET : 'system';
const APP_URL = 'https://s-day-board.vercel.app/';
const MODES = { watch: null, p25: { focus: 25, rest: 5 }, p50: { focus: 50, rest: 10 } };

// 밝게 · 어둡게로 고정했으면 그 색만, 아니면 아이폰 화면 모드를 따라감 (a = 불투명도)
const dyn = (light, dark, a = 1) => THEME === 'light' ? new Color(light, a) : THEME === 'dark' ? new Color(dark, a) : Color.dynamic(new Color(light, a), new Color(dark, a));
const C = {
  bg: dyn('#FFFFFF', '#161B29'),
  ink: dyn('#1C2540', '#E6EAF3'),
  pencil: dyn('#59627C', '#A4ABBF'),
  faint: dyn('#9AA1B5', '#6B7389'),
  rule: dyn('#E2E6EF', '#272E42'),
  pen: dyn('#2C4BD1', '#8EA2FF'),
  green: dyn('#1F8A5B', '#3FBF85'),
  red: dyn('#D23F3F', '#FF7A7A'),
};
// 일정 종류 색(파스텔): 시험 빨강 · 과제 노랑 · 할 일 파랑, 기타는 정한 색
const KIND_HEX = {
  exam: ['#F08A8D', '#F58E91'],
  assignment: ['#F2C55C', '#F2CD6A'],
  todo: ['#7FA2EE', '#8FAAF5'],
};
// 두 색 섞기: t는 a의 비율
function mixHex(a, b, t) {
  const p = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
}
const baseHex = it => {
  if (it.c && /^#[0-9A-Fa-f]{6}$/.test(it.c)) return [it.c, it.c];
  return KIND_HEX[it.kind] || KIND_HEX.assignment;
};
const kindColor = it => { const [l, d] = baseHex(it); return dyn(l, d); };
const pillBg = it => { const [l, d] = baseHex(it); return dyn(mixHex(l, '#FFFFFF', 0.42), mixHex(d, '#161B29', 0.42)); };
const pillInk = it => { const [l, d] = baseHex(it); return dyn(mixHex(l, '#1C2540', 0.5), mixHex(d, '#E6EAF3', 0.5)); };

function setup() {
  const p = ((typeof args !== 'undefined' && args.widgetParameter) || '').trim();
  const words = p.split(/[\s,]+/).filter(Boolean);
  const KINDS = ['study', 'timer', 'upcoming', 'calendar'];
  const kind = words.find(x => KINDS.includes(x)) || (KINDS.includes(KIND) ? KIND : 'upcoming');
  const url = words.find(x => /^https:\/\//.test(x)) || WIDGET_URL;
  const n = words.find(x => /^\d{1,3}%?$/.test(x));
  const opacity = Math.max(0, Math.min(100, n != null ? parseInt(n, 10) : OPACITY));
  return { kind, url, opacity };
}

/* ───── 데이터 (실패하면 마지막으로 받은 걸 보여 줌) ───── */
async function load(url) {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.cacheDirectory(), 's-day-widget.json');
  if (!/^https:\/\//.test(url)) return { error: '설정 → 위젯에서 스크립트를 다시 복사해 주세요' };
  try {
    const r = new Request(url);
    r.timeoutInterval = 12;
    const d = await r.loadJSON();
    if (d && d.error) return { error: d.error === 'not_found' ? '위젯 주소가 바뀌었어요. 스크립트를 다시 복사해 주세요' : '잠시 후 다시 시도해요' };
    fm.writeString(cache, JSON.stringify(d));
    return d;
  } catch (e) {
    if (fm.fileExists(cache)) { const d = JSON.parse(fm.readString(cache)); d.stale = true; return d; }
    return { error: '불러오지 못했어요' };
  }
}

/* ───── 계산 ───── */
const pad = n => String(n).padStart(2, '0');
function spent(sec) {
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), mm = m % 60;
  return h ? (mm ? `${h}시간 ${mm}분` : `${h}시간`) : `${mm}분`;
}
function shortSpent(sec) {
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  return h ? `${h}:${pad(m % 60)}` : `${m}분`;
}
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function dday(t, now) {
  const due = new Date(t.due);
  const ms = due - now;
  if (t.kind === 'exam' && ms < 0) return { text: '시험 중', late: false };
  if (ms < 0) return { text: '지남', late: true };
  if (ms < 24 * 3600e3) {
    const h = Math.floor(ms / 3600e3);
    return { text: h ? `${h}시간` : `${Math.max(1, Math.floor(ms / 60e3))}분`, late: false };
  }
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 864e5);
  return { text: days === 0 ? 'D-DAY' : `D-${days}`, late: false };
}
// 시험은 "중간고사"처럼 이름만 있는 경우가 많아 과목을 앞에 붙임
const titleOf = t => (t.kind === 'exam' && t.subject && !t.title.includes(t.subject) ? `${t.subject} ${t.title}` : t.title);
// 공부 중인 타이머: { label, color, date, countdown, rest }
function liveTimer(d, now) {
  const t = d.study && d.study.timer;
  if (!t || t.phase === 'idle' || !t.running || !t.segStart) return null;
  const mode = MODES[t.mode];
  const elapsed = (t.acc || 0) + (now - t.segStart);
  const label = t.phase === 'rest' ? '쉬는 시간' : (t.label || t.subject || '공부 중');
  const color = t.phase === 'rest' ? C.green : (d.study.timerColor ? new Color(d.study.timerColor) : C.pen);
  if (!mode) return { label, color, date: new Date(now - elapsed), countdown: false, rest: false };
  const len = (t.phase === 'rest' ? mode.rest : mode.focus) * 60e3;
  if (elapsed >= len) return null;                 // 이미 끝남 (앱을 열면 정리됨)
  return { label, color, date: new Date(now + (len - elapsed)), countdown: true, rest: t.phase === 'rest' };
}
function todaySec(d, now) {
  let sec = (d.study && d.study.today) || 0;
  const t = d.study && d.study.timer;
  if (t && t.phase === 'focus' && t.running && t.segStart) sec += Math.floor(((t.acc || 0) + (now - t.segStart)) / 1000);
  return sec;
}

/* ───── 그리기 ───── */
function text(stack, s, size, color, weight = 'semibold') {
  const t = stack.addText(s);
  t.font = weight === 'heavy' ? Font.heavySystemFont(size) : weight === 'bold' ? Font.boldSystemFont(size)
    : weight === 'medium' ? Font.mediumSystemFont(size) : Font.semiboldSystemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  return t;
}
function dot(stack, color, size = 8) {
  const s = stack.addStack(); s.size = new Size(size, size); s.cornerRadius = size / 2; s.backgroundColor = color;
}
const LOCK = ['accessoryCircular', 'accessoryRectangular', 'accessoryInline'];

// 오늘 공부: 시간 · 목표 막대
function studyWidget(w, d, now, fam) {
  const sec = todaySec(d, now);
  if (fam === 'accessoryCircular') {
    w.addSpacer();
    const t = w.addText(shortSpent(sec)); t.font = Font.boldSystemFont(14); t.centerAlignText();
    w.addSpacer();
    return;
  }
  if (LOCK.includes(fam)) { text(w, `오늘 공부 ${spent(sec)}`, 13, Color.white(), 'bold'); return; }
  w.addSpacer();
  text(w, '오늘 공부', 12, C.pencil);
  w.addSpacer(2);
  text(w, spent(sec), fam === 'small' ? 28 : 32, C.ink, 'heavy');
  w.addSpacer();
}

// 타이머: 공부 중이면 과목과 흘러가는 시간, 아니면 쉬는 중
function timerWidget(w, d, now, fam) {
  const lt = liveTimer(d, now);
  const timerText = (stack, size) => {
    const dt = stack.addDate(lt.date);
    dt.applyTimerStyle();
    dt.font = Font.boldMonospacedSystemFont(size);
    dt.lineLimit = 1;
    return dt;
  };
  if (LOCK.includes(fam)) {
    if (!lt) { text(w, fam === 'accessoryCircular' ? '쉬는 중' : '타이머 · 쉬는 중', 12, Color.white(), 'bold'); return; }
    if (fam !== 'accessoryCircular') text(w, lt.label, 12, Color.white(), 'bold');
    const dt = timerText(w, fam === 'accessoryCircular' ? 13 : 18);
    if (fam === 'accessoryCircular') dt.centerAlignText();
    return;
  }
  w.addSpacer();
  const head = w.addStack(); head.centerAlignContent();
  dot(head, lt ? lt.color : C.rule);
  head.addSpacer(6);
  text(head, lt ? lt.label : '타이머', 12, C.pencil);
  w.addSpacer(2);
  if (lt) {
    const dt = timerText(w, fam === 'small' ? 30 : 36);
    dt.textColor = lt.rest ? C.green : C.ink;
  } else text(w, '쉬는 중', fam === 'small' ? 24 : 28, C.faint, 'heavy');
  w.addSpacer();
}

// 다가오는 일정 (앞으로 2주): 첫 열 요일(같은 날은 한 번만) · 색 막대 · 짧은 이름 한 줄
const W = ['일', '월', '화', '수', '목', '금', '토'];
const labelOf = t => t.label || titleOf(t);
const dayOf = t => t.d || (() => { const x = new Date(t.due); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; })();
function upcomingWidget(w, d, now, fam) {
  const list = d.upcoming || [];
  const nowD = new Date(now);
  if (LOCK.includes(fam)) {
    const n = list[0];
    if (!n) { text(w, '남은 일정 없음', 12, Color.white(), 'medium'); return; }
    if (fam === 'accessoryCircular') {
      w.addSpacer();
      const t = w.addText(dday(n, nowD).text); t.font = Font.boldSystemFont(13); t.centerAlignText();
      w.addSpacer();
      return;
    }
    list.slice(0, fam === 'accessoryInline' ? 1 : 3).forEach(t => {
      const dt = new Date(t.due);
      text(w, `${W[dt.getDay()]}  ${labelOf(t)}`, 12, Color.white(), 'medium');
    });
    return;
  }
  // 첫 줄은 늘 오늘 (오늘 일정이 없으면 "일정이 없어요"), 날짜는 "토 31"처럼 한 줄
  // 위젯은 스크롤이 안 돼서 들어가는 만큼만 (넘치면 맨 아래 +n)
  const lines = fam === 'small' ? 5 : fam === 'medium' ? 5 : 12;
  const size = fam === 'small' ? 12 : 13;
  const todayKey = dayOf({ due: nowD.toISOString() });
  const rows = list.filter(t => dayOf(t) >= todayKey);
  if (!rows.length || dayOf(rows[0]) !== todayKey) rows.unshift({ none: true, d: todayKey });
  let shown = 0, prev = null;
  for (const t of rows) {
    if (shown >= lines - (rows.length > lines ? 1 : 0)) break;
    const k = dayOf(t);
    const first = k !== prev; prev = k;
    if (shown) w.addSpacer(first ? 6 : 3);
    const row = w.addStack(); row.centerAlignContent();
    const col = row.addStack(); col.size = new Size(fam === 'small' ? 34 : 38, 0); col.centerAlignContent(); col.setPadding(0, fam === 'small' ? 2 : 6, 0, 0);
    if (first) {
      const dt = new Date(`${k}T00:00:00`);
      text(col, W[dt.getDay()], size, k === todayKey ? C.pen : dt.getDay() === 0 ? C.red : C.ink, 'bold');
      col.addSpacer(3);
      text(col, String(dt.getDate()), size - 1, C.faint, 'medium');
    }
    col.addSpacer();
    row.addSpacer(2);
    if (t.none) { text(row, '일정이 없어요', size, C.faint, 'medium'); row.addSpacer(); shown++; continue; }
    const bar = row.addStack(); bar.size = new Size(3.5, 15); bar.cornerRadius = 1.75; bar.backgroundColor = kindColor(t);
    row.addSpacer(7);
    text(row, labelOf(t), size, t.missing ? C.red : C.ink, 'medium');
    row.addSpacer();
    shown++;
  }
  if (rows.length > shown) { w.addSpacer(4); text(w, `+${rows.length - shown}개 더`, 10.5, C.faint, 'medium'); }
  w.addSpacer();
}

const strike = t => [...String(t)].map(ch => ch + '\u0336').join('');

// 캘린더: 날짜 칸마다 그날 일정 이름을 한 줄씩 (시험 빨강 · 과제 노랑 · 할 일 파랑 막대)
//   큰 위젯 = 이번 달, 중간 = 이번 주 · 다음 주, 작은 = 다가오는 날짜별 목록
function calendarWidget(w, d, now, fam) {
  const today = new Date(now);
  const key = x => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const byDay = {};
  for (const m of d.month || []) (byDay[m.d] = byDay[m.d] || []).push(m);
  if (LOCK.includes(fam)) {
    const n = (byDay[key(today)] || [])[0];
    text(w, n ? `오늘 ${n.title}` : `${today.getMonth() + 1}월 ${today.getDate()}일`, 12, Color.white(), 'bold');
    return;
  }
  const W = '일월화수목금토';
  if (fam === 'small') {
    // 오늘부터 일정 있는 날을 차례로
    const open = k => byDay[k].filter(it => !it.done);
    const days = Object.keys(byDay).filter(k => k >= key(today) && open(k).length).sort().slice(0, 3);
    if (!days.length) { w.addSpacer(); text(w, '이번 달 남은 일정이 없어요', 12, C.faint, 'medium'); w.addSpacer(); return; }
    let lines = 0;
    for (const k of days) {
      if (lines >= 5) break;
      const dt = new Date(`${k}T00:00:00`);
      if (lines) w.addSpacer(5);
      text(w, k === key(today) ? '오늘' : `${dt.getMonth() + 1}/${dt.getDate()} ${W[dt.getDay()]}`, 10, C.pencil, 'bold');
      lines++;
      for (const it of open(k)) {
        if (lines >= 5) break;
        w.addSpacer(2);
        const r = w.addStack(); r.centerAlignContent();
        const bar = r.addStack(); bar.size = new Size(3, 12); bar.cornerRadius = 1.5; bar.backgroundColor = kindColor(it);
        r.addSpacer(5);
        text(r, it.title, 11.5, C.ink, 'medium');
        lines++;
      }
    }
    w.addSpacer();
    return;
  }
  const big = fam === 'large';
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  let start, weeks;
  if (big) {
    start = new Date(first); start.setDate(1 - first.getDay());
    weeks = Math.ceil((first.getDay() + new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()) / 7);
  } else {
    start = new Date(today); start.setDate(today.getDate() - today.getDay());
    weeks = 2;
  }
  const BLUE = dyn('#2C6BE0', '#7FA6FF');
  const dayColor = i => (i === 0 ? C.red : i === 6 ? BLUE : C.ink);
  const CW = 42, CH = big ? Math.floor(262 / weeks) : 40;
  const LH = 12;                                   // 일정 한 줄 높이
  const lines = Math.max(1, Math.floor((CH - 16) / (LH + 1)));
  // 머리줄: 가운데 ○월, 오른쪽 + (추가) · 오늘(날짜가 든 네모)
  const head = w.addStack(); head.centerAlignContent(); head.size = new Size(CW * 7, 24);
  head.addSpacer(56);
  head.addSpacer();
  text(head, `${today.getMonth() + 1}월`, big ? 17 : 14, C.ink, 'bold');
  head.addSpacer();
  const add = head.addStack(); add.size = new Size(24, 24); add.centerAlignContent(); add.url = `${APP_URL}#new`;
  text(add, '+', 18, C.ink, 'bold');
  head.addSpacer(6);
  const tb = head.addStack(); tb.size = new Size(24, 22); tb.centerAlignContent(); tb.cornerRadius = 5;
  tb.borderWidth = 1.5; tb.borderColor = C.ink; tb.url = `${APP_URL}#calendar`;
  text(tb, String(today.getDate()), 11, C.ink, 'bold');
  w.addSpacer(big ? 4 : 2);
  const dow = w.addStack();
  W.split('').forEach((ch, i) => {
    const c = dow.addStack(); c.size = new Size(CW, 17); c.centerAlignContent();
    const t = c.addText(ch); t.font = Font.boldSystemFont(11.5); t.textColor = i === 0 ? C.red : i === 6 ? BLUE : C.faint;
  });
  for (let r = 0; r < weeks; r++) {
    const row = w.addStack();
    for (let i = 0; i < 7; i++) {
      const day = new Date(start); day.setDate(start.getDate() + r * 7 + i);
      const inMonth = !big || day.getMonth() === today.getMonth();
      const isToday = key(day) === key(today);
      const cell = row.addStack(); cell.size = new Size(CW, CH); cell.layoutVertically();
      cell.setPadding(2, 1, 0, 1);
      // 날짜: 칸 가운데
      const nr = cell.addStack(); nr.addSpacer();
      const n = nr.addStack(); n.centerAlignContent();
      if (isToday) { n.backgroundColor = C.pen; n.cornerRadius = 8; n.size = new Size(20, 16); }
      const t = n.addText(String(day.getDate()));
      t.font = isToday ? Font.boldSystemFont(11.5) : Font.mediumSystemFont(11.5);
      t.textColor = isToday ? Color.white() : !inMonth ? C.faint : dayColor(i);
      nr.addSpacer();
      // 일정: 한 줄씩, 줄 배경이 종류 색
      const items = byDay[key(day)] || [];
      const show = items.length > lines ? lines - 1 : items.length;
      items.slice(0, show).forEach(it => {
        cell.addSpacer(1);
        const l = cell.addStack(); l.size = new Size(CW - 2, LH); l.cornerRadius = 3; l.setPadding(0, 2, 0, 1); l.centerAlignContent();
        // 지난 일정 · 다른 달도 종류 색(파스텔) 그대로. 끝낸 일정은 흐리게 + 취소선 (글자마다 긋는 선 문자)
        l.backgroundColor = pillBg(it);
        const tt = l.addText(it.done ? strike(it.title) : it.title); tt.font = Font.semiboldSystemFont(8.5); tt.lineLimit = 1;
        tt.textColor = pillInk(it);
        if (it.done) tt.textOpacity = 0.65;
        l.addSpacer();
      });
      if (show < items.length) { cell.addSpacer(1); text(cell, `+${items.length - show}`, 8.5, C.pencil, 'bold'); }
      cell.addSpacer();
    }
  }
}

function build(d, kind, opacity = 100) {
  const w = new ListWidget();
  const a = opacity / 100;
  w.backgroundColor = dyn('#FFFFFF', '#161B29', a);
  w.url = APP_URL + (kind === 'upcoming' ? '#list' : kind === 'calendar' ? '#calendar' : '#study');
  const now = Date.now();
  const fam = config.widgetFamily || (kind === 'upcoming' ? 'medium' : kind === 'calendar' ? 'large' : 'small');
  const next = new Date(now + 15 * 60e3);
  if (!LOCK.includes(fam)) w.setPadding(16, 16, 16, 16);

  if (d.error) {
    text(w, 'S-DAY', 12, C.pencil, 'bold');
    w.addSpacer(6);
    const t = w.addText(d.error); t.font = Font.mediumSystemFont(12); t.textColor = C.ink;
    w.refreshAfterDate = next;
    return w;
  }
  const lt = liveTimer(d, now);
  // 타이머가 끝나는 때에 맞춰 다시 그리기
  w.refreshAfterDate = lt && lt.countdown && lt.date < next ? lt.date : next;
  if (kind === 'study') studyWidget(w, d, now, fam);
  else if (kind === 'timer') timerWidget(w, d, now, fam);
  else if (kind === 'calendar') calendarWidget(w, d, now, fam);
  else upcomingWidget(w, d, now, fam);
  return w;
}

async function main() {
  const { kind, url, opacity } = setup();
  const d = await load(url);
  const w = build(d, kind, opacity);
  if (config.runsInWidget) Script.setWidget(w);
  else if (kind === 'upcoming') await w.presentMedium();
  else if (kind === 'calendar') await w.presentLarge();
  else await w.presentSmall();
  Script.complete();
}
main();
