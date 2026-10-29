// 목록 / 캘린더 보기

import {
  h, dday, fmtDate, fmtShort, fmtDuration, displayTitle, groupOf, GROUPS, subjectColor,
  startOfDay, addDays, sameDay, dayKey, WEEK, isExam, examOver, timeRange, shortSubject, etcLabel, etcColor, shortLabel, isLecture,
} from './util.js';

const ICON_STAR = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z"/></svg>';
const ICON_EXTERNAL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5L7 9"/></svg>';

function svg(markup) {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

const byDue = (a, b) => new Date(a.due) - new Date(b.due);

// "제출: 보고서.pdf 외 1개" 또는 "제출함"
function submissionLine(t) {
  const files = t.submission?.files || [];
  if (files.length) {
    const more = files.length > 1 ? ` 외 ${files.length - 1}개` : '';
    return h('span', { class: 'sub-files', title: files.map(f => f.name).join('\n') }, `제출: ${files[0].name}${more}`);
  }
  if (t.submittedAt) return h('span', { class: 'sub-files' }, '제출함');
  return null;
}

/* ───── 과제 한 줄 ───── */
export function taskRow(t, ctx, { compact = false } = {}) {
  const now = ctx.now;
  const info = dday(t, now);
  const due = new Date(t.due);
  const exam = isExam(t);
  // 남은 시간은 이틀 안일 때만 (그 밖에는 오른쪽 D-day로 충분)
  let remain = null;
  if (!t.done) {
    if (t.allDay) remain = null;
    else if (exam && info.ms < 0) remain = examOver(t, now) ? null : '지금 시험 중';
    else if (info.ms >= 0 && info.ms < 2 * 864e5) remain = `${fmtDuration(info.ms)} 남음`;
  }

  // D-day 왼쪽: 중요 표시 별 (완료는 제출하면 저절로, 시험은 시간이 지나면 저절로)
  const star = h('button', {
    class: 'star-btn', type: 'button', 'aria-label': t.starred ? '중요 표시 해제' : '중요 표시',
    'aria-pressed': t.starred ? 'true' : 'false', title: t.starred ? '중요 표시 해제' : '중요 표시',
    onclick: () => ctx.onStar(t.id),
  }, svg(ICON_STAR));

  const title = h('div', { class: 'title' },
    h('span', { class: 'title-text' }, displayTitle(t)),
    t.link ? h('a', {
      class: 'lms-link', href: t.link, target: '_blank', rel: 'noopener noreferrer',
      title: '스마트캠퍼스에서 열기', 'aria-label': '스마트캠퍼스에서 열기', onclick: e => e.stopPropagation(),
    }, svg(ICON_EXTERNAL)) : null,
  );

  const meta = h('div', { class: 'meta' },
    exam ? h('span', { class: 'exam-word' }, '시험') : null,
    t.kind === 'todo' && !isLecture(t) ? h('span', { class: 'todo-word' }, '할 일') : null,
    t.kind === 'etc' || isLecture(t) ? h('span', { class: 'etc-word', style: { '--e': etcColor(t) } }, etcLabel(t)) : null,
    !compact && t.subject && displayTitle(t) === t.title ? h('span', { class: 'subj' }, t.subject) : null,
    exam ? h('span', null, `${fmtShort(due, false)} ${timeRange(t)}`) : h('span', null, t.allDay ? `${fmtShort(due, false)} 종일` : fmtShort(due)),
    exam && t.location ? h('span', { class: 'place' }, t.location) : null,
    remain ? h('span', { class: 'remain' }, remain) : null,
    !compact && t.done ? submissionLine(t) : null,
  );

  const main = h('div', {
    class: 'main', role: 'button', tabindex: '0',
    title: '눌러서 자세히 보기',
    onclick: () => ctx.onOpen(t),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.onOpen(t); } },
  }, title, meta);

  const badge = h('div', { class: `dday ${info.level}` }, h('span', null, info.label));

  // 왼쪽 얇은 막대 = 과목 색
  // 끝난 시험도 완료한 과제처럼 줄 긋기
  const finished = t.done || (exam && groupOf(t, now) === 'done');
  return h('li', { class: `row${finished ? ' done' : ''}${exam ? ' exam' : ''}${t.starred ? ' starred' : ''}`, dataset: { id: t.id },
    style: { '--c': subjectColor(t.subject) } },
    main, star, badge);
}

function emptyState(ctx, title, text, withButton = true) {
  return h('div', { class: 'empty' },
    h('strong', null, title),
    h('span', null, text),
    withButton ? h('div', null, h('button', { class: 'btn primary', onclick: () => ctx.onNew() }, '새 과제')) : null,
  );
}

/* ───── 목록 ───── */
export function renderList(root, tasks, ctx) {
  root.replaceChildren();
  if (!ctx.total) {
    root.append(emptyState(ctx, '아직 등록된 일정이 없어요',
      '위 입력칸에 "데이터베이스 과제 금요일까지"처럼 적어 보세요. 설정에서 스마트캠퍼스를 연동하면 과제가 알아서 들어와요.'));
    return;
  }
  if (!tasks.length) {
    root.append(emptyState(ctx, '찾는 일정이 없어요', '검색어를 지우거나 다른 과목을 골라 보세요.', false));
    return;
  }

  const buckets = new Map(GROUPS.map(g => [g.key, []]));
  for (const t of tasks) buckets.get(groupOf(t, ctx.now)).push(t);

  for (const g of GROUPS) {
    const list = buckets.get(g.key);
    if (!list.length) continue;
    const isDone = g.key === 'done';
    list.sort(isDone ? (a, b) => byDue(b, a) : byDue);
    const open = !isDone || ctx.showDone;

    const dayHint = g.key === 'today' ? fmtDate(ctx.now, false)
      : g.key === 'tomorrow' ? fmtDate(addDays(ctx.now, 1), false) : null;
    const head = h('div', { class: `group-head g-${g.key}` },
      h('h3', null, g.name),
      dayHint ? h('span', { class: 'day-hint' }, dayHint) : null,
      h('span', { class: 'count' }, `${list.length}개`),
      isDone ? h('button', {
        class: 'btn ghost', type: 'button', 'aria-expanded': open ? 'true' : 'false',
        onclick: () => ctx.onToggleDoneGroup(),
      }, open ? '접기' : '펼치기') : null,
    );
    const section = h('section', { class: 'group' }, head);
    if (open) section.append(h('ul', { class: 'rows' }, list.map(t => taskRow(t, ctx))));
    root.append(section);
  }
}

/* ───── 캘린더 ───── */
function chevron(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p);
  return svg;
}
export function renderCalendar(root, tasks, ctx) {
  root.replaceChildren();
  const month = ctx.calMonth;                    // 해당 월 1일
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());   // 일요일 시작
  const today = startOfDay(ctx.now);

  const byDay = new Map();
  for (const t of tasks) {
    const k = dayKey(new Date(t.due));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(t);
  }
  for (const list of byDay.values()) list.sort(byDue);

  // 가운데 ‹ 2026년 10월 ›, 오른쪽 끝 오늘
  const head = h('div', { class: 'cal-head' },
    h('span', { class: 'cal-head-side', 'aria-hidden': 'true' }),
    h('div', { class: 'cal-head-mid' },
      h('button', { class: 'btn icon ghost cal-arrow', 'aria-label': '이전 달', title: '이전 달', onclick: () => ctx.onMonth(-1) }, chevron('M12.5 4.5L7 10l5.5 5.5')),
      h('h3', null, `${month.getFullYear()}년 ${month.getMonth() + 1}월`),
      h('button', { class: 'btn icon ghost cal-arrow', 'aria-label': '다음 달', title: '다음 달', onclick: () => ctx.onMonth(1) }, chevron('M7.5 4.5L13 10l-5.5 5.5'))),
    h('button', { class: 'btn cal-today', onclick: () => ctx.onMonth(0) }, '오늘'),
  );

  const grid = h('div', { class: 'cal-grid', role: 'grid' },
    WEEK.map((w, i) => h('div', { class: `cal-dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`, role: 'columnheader' }, w)));

  const weeks = Math.ceil((first.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(gridStart, i);
    const list = byDay.get(dayKey(d)) || [];
    const cls = ['cal-day'];
    if (d.getMonth() !== month.getMonth()) cls.push('other');
    if (sameDay(d, today)) cls.push('today');
    if (d.getDay() === 0) cls.push('sun');
    if (d.getDay() === 6) cls.push('sat');
    if (ctx.selectedDay && sameDay(d, ctx.selectedDay)) cls.push('selected');

    const pending = list.filter(t => !t.done).length;
    const cell = h('button', {
      class: cls.join(' '), type: 'button', role: 'gridcell',
      'aria-label': `${d.getMonth() + 1}월 ${d.getDate()}일, 과제 ${list.length}개${pending ? `, 남은 과제 ${pending}개` : ''}`,
      onclick: () => ctx.onSelectDay(d),
    }, h('span', { class: 'num' }, d.getDate()));

    list.slice(0, 3).forEach(t => {
      // 시험은 시작 시각을 앞에 (폰에서는 좁아서 시각은 빼고), 과목은 줄임말로
      const label = isExam(t) ? [h('span', { class: 'pill-time' }, `${timeRange(t).split('–')[0]} `), shortLabel(t)] : shortLabel(t);
      const etc = t.kind === 'etc' || isLecture(t);
      const tip = [etc ? etcLabel(t) : null, t.subject, t.title, isExam(t) ? timeRange(t) : null, t.location].filter(Boolean).join(' · ');
      const k = isExam(t) ? 'exam' : etc ? 'etc' : t.kind === 'todo' ? 'todo' : 'assignment';
      cell.append(h('span', {
        class: `cal-pill k-${k}${t.done ? ' is-done' : ''}`, title: tip,
        style: etc ? { '--e': etcColor(t) } : null,
        onclick: e => { e.stopPropagation(); ctx.onOpen(t); },
      }, h('span', null, label)));
    });
    if (list.length > 3) cell.append(h('span', { class: 'cal-more' }, `+${list.length - 3}개`));
    grid.append(cell);
  }

  root.append(head, grid);

  // 선택한 날짜의 과제
  const sel = ctx.selectedDay;
  if (sel) {
    const list = byDay.get(dayKey(sel)) || [];
    const box = h('section', { class: 'day-list' },
      h('h3', null,
        `${sel.getMonth() + 1}월 ${sel.getDate()}일 (${WEEK[sel.getDay()]})`,
        h('span', { class: 'msg' }, list.length ? `${list.length}개` : '일정 없음'),
        h('button', { class: 'btn sm', onclick: () => ctx.onNew(sel, 'assignment') }, '이 날 추가')),
    );
    if (list.length) box.append(h('ul', { class: 'rows' }, list.map(t => taskRow(t, ctx))));
    root.append(box);
  }
}
