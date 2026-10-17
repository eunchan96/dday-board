// 목록 / 캘린더 / 과목별 보기

import {
  h, dday, fmtDate, fmtDuration, groupOf, GROUPS, subjectColor,
  startOfDay, addDays, sameDay, dayKey, WEEK, isExam, examOver, timeRange,
} from './util.js';

const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z"/></svg>';

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
  let remain = null;
  if (!t.done) {
    if (exam && info.ms < 0) remain = examOver(t, now) ? null : '지금 시험 중';
    else remain = info.ms >= 0 ? `${fmtDuration(info.ms)} 남음` : `${fmtDuration(-info.ms)} 지남`;
  }

  const check = h('button', {
    class: 'check', type: 'button',
    'aria-label': t.done ? `${t.title} 완료 취소` : `${t.title} ${exam ? '응시 완료' : '완료'}`,
    'aria-pressed': t.done ? 'true' : 'false',
    onclick: () => ctx.onToggle(t.id),
  }, svg(ICON_CHECK));

  const title = h('div', { class: 'title' },
    // 넓은 화면의 목록에서는 오른쪽 별 버튼으로 보이므로 제목 옆 별은 CSS로 숨긴다
    t.starred ? h('span', { class: compact ? 'star-mark' : 'star-mark title-star', 'aria-label': '중요' }, '★') : null,
    exam ? h('span', { class: 'kind-tag' }, '시험') : null,
    h('span', { class: 'title-text' }, t.title),
    t.link ? h('a', {
      class: 'lms-tag', href: t.link, target: '_blank', rel: 'noopener noreferrer',
      title: '스마트캠퍼스에서 열기', onclick: e => e.stopPropagation(),
    }, 'LMS') : (t.source === 'canvas' ? h('span', { class: 'lms-tag' }, 'LMS') : null),
  );

  const meta = h('div', { class: 'meta' },
    !compact && t.subject ? h('span', null, t.subject) : null,
    exam ? h('span', null, `${fmtDate(due, false)} ${timeRange(t)}`) : h('span', null, fmtDate(due)),
    exam && t.location ? h('span', { class: 'place' }, t.location) : null,
    remain ? h('span', null, remain) : null,
    !compact ? submissionLine(t) : null,
    !compact && t.memo ? h('span', { class: 'memo' }, t.memo.split('\n')[0]) : null,
  );

  const main = h('div', {
    class: 'main', role: 'button', tabindex: '0',
    title: '눌러서 자세히 보기',
    onclick: () => ctx.onOpen(t),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.onOpen(t); } },
  }, title, meta);

  const star = compact ? null : h('button', {
    class: 'star-btn', type: 'button', 'aria-label': '중요 표시', 'aria-pressed': t.starred ? 'true' : 'false',
    title: t.starred ? '중요 표시 해제' : '중요 표시', onclick: () => ctx.onStar(t.id),
  }, svg(ICON_STAR));

  const badge = h('div', { class: `dday ${info.level}` }, h('span', null, info.label));

  return h('li', { class: `row${t.done ? ' done' : ''}${exam ? ' exam' : ''}`, dataset: { id: t.id } },
    check,
    compact ? null : h('i', { class: 'tab', style: { background: subjectColor(t.subject) } }),
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

  const head = h('div', { class: 'cal-head' },
    h('h3', null, `${month.getFullYear()}년 ${month.getMonth() + 1}월`),
    h('button', { class: 'btn icon ghost', 'aria-label': '이전 달', onclick: () => ctx.onMonth(-1) }, '‹'),
    h('button', { class: 'btn', onclick: () => ctx.onMonth(0) }, '오늘'),
    h('button', { class: 'btn icon ghost', 'aria-label': '다음 달', onclick: () => ctx.onMonth(1) }, '›'),
  );

  const grid = h('div', { class: 'cal-grid', role: 'grid' },
    WEEK.map((w, i) => h('div', { class: `cal-dow${i === 0 ? ' sun' : ''}`, role: 'columnheader' }, w)));

  const weeks = Math.ceil((first.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(gridStart, i);
    const list = byDay.get(dayKey(d)) || [];
    const cls = ['cal-day'];
    if (d.getMonth() !== month.getMonth()) cls.push('other');
    if (sameDay(d, today)) cls.push('today');
    if (d.getDay() === 0) cls.push('sun');
    if (ctx.selectedDay && sameDay(d, ctx.selectedDay)) cls.push('selected');

    const pending = list.filter(t => !t.done).length;
    const cell = h('button', {
      class: cls.join(' '), type: 'button', role: 'gridcell',
      'aria-label': `${d.getMonth() + 1}월 ${d.getDate()}일, 과제 ${list.length}개${pending ? `, 남은 과제 ${pending}개` : ''}`,
      onclick: () => ctx.onSelectDay(d),
    }, h('span', { class: 'num' }, d.getDate()));

    list.slice(0, 3).forEach(t => {
      const lv = dday(t, ctx.now).level;
      const label = isExam(t) ? `${timeRange(t).split('–')[0]} ${t.title}` : t.title;
      const tip = [t.subject, t.title, isExam(t) ? timeRange(t) : null, t.location].filter(Boolean).join(' · ');
      cell.append(h('span', {
        class: `cal-pill ${lv}${isExam(t) ? ' exam' : ''}`, title: tip,
        onclick: e => { e.stopPropagation(); ctx.onOpen(t); },
      },
        h('i', { style: { background: subjectColor(t.subject) } }),
        h('span', null, label)));
    });
    if (list.length > 3) cell.append(h('span', { class: 'cal-more' }, `+${list.length - 3}개`));
    if (list.length) {
      cell.append(h('span', { class: 'cal-dots', 'aria-hidden': 'true' },
        list.slice(0, 4).map(t => h('i', { style: { background: t.done ? 'var(--pencil-2)' : subjectColor(t.subject) } }))));
    }
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
        h('button', { class: 'btn', onclick: () => ctx.onNew(sel, 'exam') }, '시험 추가'),
        h('button', { class: 'btn', onclick: () => ctx.onNew(sel, 'assignment') }, '과제 추가')),
    );
    if (list.length) box.append(h('ul', { class: 'rows' }, list.map(t => taskRow(t, ctx))));
    root.append(box);
  }
}

/* ───── 과목별 ───── */
export function renderSubjects(root, tasks, ctx) {
  root.replaceChildren();
  if (!ctx.total) {
    root.append(emptyState(ctx, '아직 과제가 없어요', '과제가 생기면 과목별로 진행 상황을 보여 드려요.'));
    return;
  }
  const groups = new Map();
  for (const t of tasks) {
    const k = t.subject || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  if (!groups.size) {
    root.append(emptyState(ctx, '조건에 맞는 과제가 없어요', '검색어나 필터를 바꿔 보세요.', false));
    return;
  }

  const now = ctx.now;
  const cards = [...groups.entries()].map(([name, list]) => {
    const pending = list.filter(t => groupOf(t, now) !== 'done').sort(byDue);
    const done = list.length - pending.length;
    const next = pending.find(t => new Date(t.due) >= now) || pending[0];
    const exams = pending.filter(isExam);
    return { name, list, pending, done, next, exams };
  }).sort((a, b) => {
    // 남은 과제가 있는 과목 먼저, 그 안에서 가까운 마감 순
    if (!!a.next !== !!b.next) return a.next ? -1 : 1;
    if (a.next && b.next) return byDue(a.next, b.next);
    return a.name.localeCompare(b.name, 'ko');
  });

  const wrap = h('div', { class: 'subjects' });
  for (const c of cards) {
    const color = subjectColor(c.name);
    const pct = c.list.length ? Math.round((c.done / c.list.length) * 100) : 0;
    let sub;
    if (!c.pending.length) sub = `일정 ${c.list.length}개 모두 끝냈어요`;
    else {
      const info = dday(c.next, now);
      const tasksLeft = c.pending.length - c.exams.length;
      const parts = [];
      if (tasksLeft) parts.push(`남은 과제 ${tasksLeft}개`);
      if (c.exams.length) parts.push(`다가오는 시험 ${c.exams.length}개`);
      parts.push(`가장 가까운 일정 ${info.label}`);
      sub = parts.join(' · ');
    }
    const shown = c.pending.slice(0, 4);
    const card = h('article', { class: 'subject-card', style: { '--c': color } },
      h('h3', null, c.name || '과목 없음'),
      h('p', { class: 'sub' }, sub),
      h('div', {
        class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct),
        'aria-label': `${c.name || '과목 없음'} 완료율 ${pct}%`,
      }, h('i', { style: { width: `${pct}%` } })),
      h('p', { class: 'sub' }, `끝낸 일정 ${c.done} / 전체 ${c.list.length}`),
      shown.length ? h('ul', { class: 'rows' }, shown.map(t => taskRow(t, ctx, { compact: true }))) : null,
      h('button', { class: 'more', onclick: () => ctx.onShowSubject(c.name) },
        c.pending.length > shown.length ? `남은 일정 ${c.pending.length - shown.length}개 더 보기` : '이 과목만 목록으로 보기'),
    );
    wrap.append(card);
  }
  root.append(wrap);
}
