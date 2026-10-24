// S-DAY 위젯 (아이폰 · Scriptable 앱)
//
// 넣는 법
//  1) App Store에서 무료 앱 "Scriptable" 설치
//  2) S-DAY 설정 → 위젯 → "아이폰 스크립트 복사" (주소가 들어간 채로 복사됨)
//  3) Scriptable 열기 → 오른쪽 위 + → 붙여 넣기 → 위쪽 제목을 "S-DAY"로
//  4) 홈 화면을 길게 눌러 + → Scriptable → 크기 고르기 → 추가한 위젯을 길게 눌러 "위젯 편집" → Script: S-DAY
//     (잠금 화면 위젯도 같은 방법으로 넣을 수 있어요)
//
// 보이는 것: 오늘 공부 시간과 목표, 공부 중이면 타이머(저절로 흘러감), 다가오는 과제 · 시험 · 할 일과 D-day
// 위젯은 15분쯤마다 새로 고쳐지고, 누르면 S-DAY가 열려요.

const WIDGET_URL = '__WIDGET_URL__';
const APP_URL = 'https://dday-board-pink.vercel.app/';
const MODES = { watch: null, p25: { focus: 25, rest: 5 }, p50: { focus: 50, rest: 10 } };

const C = {
  bg: Color.dynamic(new Color('#FFFFFF'), new Color('#161B29')),
  ink: Color.dynamic(new Color('#1C2540'), new Color('#E6EAF3')),
  pencil: Color.dynamic(new Color('#59627C'), new Color('#A4ABBF')),
  faint: Color.dynamic(new Color('#9AA1B5'), new Color('#6B7389')),
  rule: Color.dynamic(new Color('#E2E6EF'), new Color('#272E42')),
  pen: Color.dynamic(new Color('#2C4BD1'), new Color('#8EA2FF')),
  green: Color.dynamic(new Color('#1F8A5B'), new Color('#3FBF85')),
  red: Color.dynamic(new Color('#D23F3F'), new Color('#FF7A7A')),
  exam: Color.dynamic(new Color('#7B4FD6'), new Color('#B79BFF')),
};

/* ───── 데이터 (실패하면 마지막으로 받은 걸 보여 줌) ───── */
async function load() {
  const url = ((typeof args !== 'undefined' && args.widgetParameter) || '').trim() || WIDGET_URL;
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
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function dday(t, now) {
  const due = new Date(t.due);
  const ms = due - now;
  if (t.kind === 'exam' && ms < 0) return { text: '시험 중', color: C.exam };
  if (ms < 0) return { text: '지남', color: C.red };
  if (ms < 24 * 3600e3) {
    const h = Math.floor(ms / 3600e3);
    return { text: h ? `${h}시간` : `${Math.max(1, Math.floor(ms / 60e3))}분`, color: C.red };
  }
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 864e5);
  return { text: days === 0 ? 'D-DAY' : `D-${days}`, color: days <= 3 ? C.red : C.pencil };
}
function dueText(t) {
  const d = new Date(t.due);
  const w = '일월화수목금토'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${w}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
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
function studyBlock(stack, d, now, big) {
  const sec = todaySec(d, now), goal = (d.study && d.study.goal) || 0;
  text(stack, '오늘 공부', 11, C.pencil);
  stack.addSpacer(2);
  text(stack, spent(sec), big ? 24 : 20, C.ink, 'heavy');
  if (goal) {
    stack.addSpacer(5);
    const bar = stack.addStack();
    bar.size = new Size(big ? 130 : 110, 5);
    bar.cornerRadius = 3;
    bar.backgroundColor = C.rule;
    const fill = bar.addStack();
    fill.size = new Size(Math.max(2, Math.min(1, sec / goal) * (big ? 130 : 110)), 5);
    fill.backgroundColor = C.green;
    fill.cornerRadius = 3;
    bar.addSpacer();
    stack.addSpacer(3);
    text(stack, `목표 ${spent(goal)}`, 10, C.faint, 'medium');
  }
  const lt = liveTimer(d, now);
  if (lt) {
    stack.addSpacer(8);
    const row = stack.addStack();
    row.centerAlignContent();
    const dot = row.addStack(); dot.size = new Size(7, 7); dot.cornerRadius = 4; dot.backgroundColor = lt.color;
    row.addSpacer(5);
    text(row, lt.label, 11, C.pencil);
    const dt = stack.addDate(lt.date);
    dt.applyTimerStyle();
    dt.font = Font.boldMonospacedSystemFont(big ? 22 : 18);
    dt.textColor = lt.rest ? C.green : C.ink;
    dt.lineLimit = 1;
  }
}
function taskRow(stack, t, now, compact) {
  const row = stack.addStack();
  row.centerAlignContent();
  const bar = row.addStack();
  bar.size = new Size(3, compact ? 16 : 26);
  bar.cornerRadius = 2;
  bar.backgroundColor = t.color ? new Color(t.color) : C.faint;
  row.addSpacer(7);
  const col = row.addStack();
  col.layoutVertically();
  const title = (t.kind === 'exam' && t.subject && !t.title.includes(t.subject)) ? `${t.subject} ${t.title}` : t.title;
  text(col, (t.kind === 'exam' ? '시험 · ' : t.kind === 'todo' ? '할 일 · ' : '') + title, compact ? 12 : 13, C.ink);
  if (!compact) text(col, [t.subject, dueText(t)].filter(Boolean).join(' · '), 10, C.faint, 'medium');
  row.addSpacer();
  const dd = dday(t, now);
  text(row, dd.text, compact ? 11 : 12, t.missing ? C.red : dd.color, 'bold');
}

function build(d) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = APP_URL;
  const now = Date.now();
  const nowD = new Date(now);
  const fam = config.widgetFamily || 'medium';
  const next = new Date(now + 15 * 60e3);

  if (d.error) {
    w.setPadding(14, 14, 14, 14);
    text(w, 'S-DAY', 12, C.pencil, 'bold');
    w.addSpacer(6);
    const t = w.addText(d.error); t.font = Font.mediumSystemFont(12); t.textColor = C.ink;
    w.refreshAfterDate = next;
    return w;
  }
  const list = d.upcoming || [];
  const lt = liveTimer(d, now);
  // 타이머가 끝나는 때에 맞춰 다시 그리기
  w.refreshAfterDate = lt && lt.countdown && lt.date < next ? lt.date : next;

  // 잠금 화면
  if (fam === 'accessoryCircular') {
    w.addSpacer();
    const t = w.addText(shortSpent(todaySec(d, now))); t.font = Font.boldSystemFont(13); t.centerAlignText();
    w.addSpacer();
    return w;
  }
  if (fam === 'accessoryRectangular' || fam === 'accessoryInline') {
    const n = list[0];
    if (lt) {
      const r = w.addStack(); text(r, `${lt.label} `, 12, Color.white(), 'bold');
      const dt = w.addDate(lt.date); dt.applyTimerStyle(); dt.font = Font.boldMonospacedSystemFont(15);
    } else text(w, `오늘 공부 ${spent(todaySec(d, now))}`, 12, Color.white(), 'bold');
    if (n && fam === 'accessoryRectangular') text(w, `${dday(n, nowD).text} ${n.title}`, 12, Color.white(), 'medium');
    return w;
  }

  w.setPadding(14, 14, 14, 14);
  if (fam === 'small') {
    studyBlock(w, d, now, false);
    w.addSpacer();
    const n = list[0];
    if (n) {
      const dd = dday(n, nowD);
      const r = w.addStack(); r.centerAlignContent();
      text(r, dd.text, 13, n.missing ? C.red : dd.color, 'heavy');
      r.addSpacer(5);
      text(r, n.title, 11, C.ink, 'medium');
    } else text(w, '남은 일정 없음', 11, C.faint, 'medium');
    return w;
  }

  const top = w.addStack();
  if (fam === 'medium') {
    const left = top.addStack(); left.layoutVertically(); left.size = new Size(120, 0);
    studyBlock(left, d, now, false);
    left.addSpacer();
    top.addSpacer(12);
    const right = top.addStack(); right.layoutVertically();
    const items = list.slice(0, lt ? 4 : 4);
    if (!items.length) text(right, '남은 일정이 없어요', 12, C.faint, 'medium');
    items.forEach((t, i) => { if (i) right.addSpacer(6); taskRow(right, t, nowD, true); });
    right.addSpacer();
    return w;
  }
  // 큰 위젯
  top.layoutVertically();
  const head = top.addStack();
  const hl = head.addStack(); hl.layoutVertically();
  studyBlock(hl, d, now, true);
  head.addSpacer();
  text(head, 'S-DAY', 12, C.faint, 'bold');
  w.addSpacer(12);
  const items = list.slice(0, 6);
  if (!items.length) text(w, '남은 일정이 없어요', 13, C.faint, 'medium');
  items.forEach((t, i) => { if (i) w.addSpacer(8); taskRow(w, t, nowD, false); });
  w.addSpacer();
  if (d.stale) text(w, '오프라인 · 마지막으로 받은 내용', 9, C.faint, 'medium');
  return w;
}

async function main() {
  const d = await load();
  const w = build(d);
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentMedium();
  Script.complete();
}
main();
