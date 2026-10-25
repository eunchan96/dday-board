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
const APP_URL = 'https://dday-board-pink.vercel.app/';
const MODES = { watch: null, p25: { focus: 25, rest: 5 }, p50: { focus: 50, rest: 10 } };

const dyn = (light, dark) => Color.dynamic(new Color(light), new Color(dark));
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
// 일정 종류 색: 시험 빨강 · 과제 노랑 · 할 일 파랑
const KIND_COLOR = {
  exam: dyn('#E5484D', '#FF6B6B'),
  assignment: dyn('#F0B000', '#FFD23F'),
  todo: dyn('#3D6BE0', '#7C9BFF'),
};

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

// 다가오는 일정: 색 막대(종류) · 이름 · D-day 한 줄씩
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
    list.slice(0, fam === 'accessoryInline' ? 1 : 3).forEach(t => text(w, `${dday(t, nowD).text}  ${titleOf(t)}`, 12, Color.white(), 'medium'));
    return;
  }
  const max = fam === 'small' ? 3 : fam === 'medium' ? 3 : 7;
  const items = list.slice(0, max);
  if (!items.length) { w.addSpacer(); text(w, '남은 일정이 없어요', 13, C.faint, 'medium'); w.addSpacer(); return; }
  const size = fam === 'small' ? 12 : 13.5;
  items.forEach((t, i) => {
    if (i) w.addSpacer(fam === 'large' ? 10 : 7);
    // 과제 · 할 일은 과목을 아래 작은 글씨로 (시험은 이름 앞에 이미 있음)
    const sub = t.kind !== 'exam' && t.subject ? t.subject : '';
    const row = w.addStack(); row.centerAlignContent();
    const bar = row.addStack();
    bar.size = new Size(4, sub ? 30 : (fam === 'small' ? 15 : 18)); bar.cornerRadius = 2;
    bar.backgroundColor = KIND_COLOR[t.kind] || KIND_COLOR.assignment;
    row.addSpacer(8);
    const col = row.addStack(); col.layoutVertically();
    text(col, titleOf(t), size, C.ink, 'medium');
    if (sub) { col.addSpacer(1); text(col, sub, size - 2.5, C.faint, 'medium'); }
    row.addSpacer();
    row.addSpacer(6);
    const dd = dday(t, nowD);
    text(row, dd.text, size, dd.late || t.missing ? C.red : C.ink, 'bold');
  });
  w.addSpacer();
}

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
    const days = Object.keys(byDay).filter(k => k >= key(today)).sort().slice(0, 3);
    if (!days.length) { w.addSpacer(); text(w, '이번 달 남은 일정이 없어요', 12, C.faint, 'medium'); w.addSpacer(); return; }
    let lines = 0;
    for (const k of days) {
      if (lines >= 5) break;
      const dt = new Date(`${k}T00:00:00`);
      if (lines) w.addSpacer(5);
      text(w, k === key(today) ? '오늘' : `${dt.getMonth() + 1}/${dt.getDate()} ${W[dt.getDay()]}`, 10, C.pencil, 'bold');
      lines++;
      for (const it of byDay[k]) {
        if (lines >= 5) break;
        w.addSpacer(2);
        const r = w.addStack(); r.centerAlignContent();
        const bar = r.addStack(); bar.size = new Size(3, 12); bar.cornerRadius = 1.5; bar.backgroundColor = KIND_COLOR[it.kind] || KIND_COLOR.assignment;
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
  const CW = 42, CH = big ? Math.floor(270 / weeks) : 46;
  const lines = Math.max(1, Math.floor((CH - 13) / 10));
  text(w, `${today.getMonth() + 1}월`, big ? 14 : 12, C.ink, 'bold');
  w.addSpacer(big ? 5 : 3);
  const head = w.addStack();
  W.split('').forEach((ch, i) => {
    const c = head.addStack(); c.size = new Size(CW, 12); c.centerAlignContent();
    const t = c.addText(ch); t.font = Font.mediumSystemFont(8.5); t.textColor = i === 0 ? C.red : C.faint;
  });
  for (let r = 0; r < weeks; r++) {
    const row = w.addStack();
    for (let i = 0; i < 7; i++) {
      const day = new Date(start); day.setDate(start.getDate() + r * 7 + i);
      const inMonth = !big || day.getMonth() === today.getMonth();
      const isToday = key(day) === key(today);
      const cell = row.addStack(); cell.size = new Size(CW, CH); cell.layoutVertically(); cell.topAlignContent?.();
      cell.setPadding(2, 2, 0, 1);
      const n = cell.addStack(); n.centerAlignContent();
      if (isToday) { n.backgroundColor = C.pen; n.cornerRadius = 6; n.setPadding(0, 3, 0, 3); }
      const t = n.addText(String(day.getDate()));
      t.font = isToday ? Font.boldSystemFont(9) : Font.mediumSystemFont(9);
      t.textColor = isToday ? Color.white() : !inMonth ? C.faint : i === 0 ? C.red : C.ink;
      const items = byDay[key(day)] || [];
      const show = items.length > lines ? lines - 1 : items.length;
      items.slice(0, show).forEach(it => {
        cell.addSpacer(1);
        const l = cell.addStack(); l.centerAlignContent();
        const bar = l.addStack(); bar.size = new Size(2, 8); bar.cornerRadius = 1; bar.backgroundColor = KIND_COLOR[it.kind] || KIND_COLOR.assignment;
        l.addSpacer(2);
        const tt = l.addText(it.title); tt.font = Font.mediumSystemFont(7.5); tt.textColor = inMonth ? C.ink : C.faint; tt.lineLimit = 1;
      });
      if (show < items.length) { cell.addSpacer(1); text(cell, `+${items.length - show}`, 7.5, C.pencil, 'medium'); }
      cell.addSpacer();
    }
  }
}

function build(d, kind, opacity = 100) {
  const w = new ListWidget();
  const a = opacity / 100;
  w.backgroundColor = Color.dynamic(new Color('#FFFFFF', a), new Color('#161B29', a));
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
