// 날짜·시간 고르기
// - 날짜: 작은 달력
// - 시간: 시계 다이얼 (시 → 분 순서), 자주 쓰는 시간 바로 선택
// 값은 숨은 input(#fDate, #fTime, #fEnd)에 "YYYY-MM-DD", "HH:MM" 형식으로 두고,
// 바뀌면 change 이벤트를 보내 다른 코드가 반응할 수 있게 한다.

import { h, pad, WEEK, startOfDay, addDays, startOfWeek, sameDay, toDateInput } from './util.js';

const $ = id => document.getElementById(id);
const FIELDS = {
  fDate: { type: 'date', button: 'fDateBtn' },
  fTime: { type: 'time', button: 'fTimeBtn' },
  fEnd: { type: 'time', button: 'fEndBtn', optional: true },
};

const parseDate = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const parseTime = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); return m ? { h: +m[1], m: +m[2] } : null; };
export const timeLabel = v => {
  const t = parseTime(v);
  if (!t) return null;
  const ap = t.h < 12 ? '오전' : '오후';
  const hh = t.h % 12 === 0 ? 12 : t.h % 12;
  return `${ap} ${hh}:${pad(t.m)}`;
};
const dateLabel = v => {
  const d = parseDate(v);
  if (!d) return '날짜 고르기';
  const today = startOfDay(new Date());
  const rel = sameDay(d, today) ? ' · 오늘' : sameDay(d, addDays(today, 1)) ? ' · 내일' : '';
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})${rel}`;
};

export function refreshPickLabels() {
  for (const [id, f] of Object.entries(FIELDS)) {
    const v = $(id).value;
    const btn = $(f.button);
    btn.textContent = f.type === 'date' ? dateLabel(v) : (timeLabel(v) || (f.optional ? '없음' : '시간 고르기'));
    btn.classList.toggle('empty', !v);
  }
}

export function setField(id, value) {
  const input = $(id);
  if (input.value === value) { refreshPickLabels(); return; }
  input.value = value;
  refreshPickLabels();
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ───── 팝업 공통 ───── */
let openFor = null;      // 지금 열린 필드 id
let presetsFor = {};     // 필드별 자주 쓰는 시간 (app에서 정함)
export function setTimePresets(id, list) { presetsFor[id] = list; }

function close(returnFocus = true) {
  const box = $('picker');
  if (box.hidden) return;
  box.hidden = true;
  box.replaceChildren();
  const btn = openFor && $(FIELDS[openFor].button);
  if (btn) btn.setAttribute('aria-expanded', 'false');
  if (returnFocus && btn) btn.focus();
  openFor = null;
}
export const closePicker = close;
export const pickerOpen = () => !$('picker').hidden;

function place(box, anchor) {
  const small = window.innerWidth <= 640;
  box.classList.toggle('sheet', small);
  if (small) { box.style.left = ''; box.style.top = ''; return; }
  const r = anchor.getBoundingClientRect();
  const w = box.offsetWidth, hgt = box.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - w - 12);
  let top = r.bottom + 6;
  if (top + hgt > window.innerHeight - 12) top = Math.max(12, r.top - hgt - 6);
  box.style.left = `${Math.max(12, left)}px`;
  box.style.top = `${top}px`;
}

function open(id) {
  if (openFor === id) { close(); return; }
  close(false);
  openFor = id;
  const f = FIELDS[id];
  const box = $('picker');
  const btn = $(f.button);
  btn.setAttribute('aria-expanded', 'true');
  box.hidden = false;
  box.setAttribute('aria-label', f.type === 'date' ? '날짜 고르기' : '시간 고르기');
  if (f.type === 'date') renderDate(box, id); else renderTime(box, id);
  place(box, btn);
  const first = box.querySelector('[data-autofocus]') || box.querySelector('button');
  if (first) first.focus();
}

/* ───── 달력 ───── */
function renderDate(box, id) {
  const selected = parseDate($(id).value) || startOfDay(new Date());
  let month = new Date(selected.getFullYear(), selected.getMonth(), 1);
  const today = startOfDay(new Date());

  const draw = () => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = addDays(first, -first.getDay());
    const days = Math.ceil((first.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7) * 7;
    const grid = h('div', { class: 'pk-grid', role: 'grid' },
      WEEK.map((w, i) => h('span', { class: `pk-dow${i === 0 ? ' sun' : ''}` }, w)));
    for (let i = 0; i < days; i++) {
      const d = addDays(start, i);
      const cls = ['pk-day'];
      if (d.getMonth() !== month.getMonth()) cls.push('other');
      if (sameDay(d, today)) cls.push('today');
      if (sameDay(d, selected)) cls.push('sel');
      if (d.getDay() === 0) cls.push('sun');
      grid.append(h('button', {
        type: 'button', class: cls.join(' '),
        'aria-label': `${d.getMonth() + 1}월 ${d.getDate()}일`,
        'aria-pressed': sameDay(d, selected) ? 'true' : 'false',
        'data-autofocus': sameDay(d, selected) ? '' : null,
        onclick: () => { setField(id, toDateInput(d)); close(); },
      }, d.getDate()));
    }
    const fri = addDays(startOfWeek(today), 4);
    const quick = [
      ['오늘', today], ['내일', addDays(today, 1)],
      [fri > today ? '이번 주 금요일' : '다음 주 금요일', fri > today ? fri : addDays(fri, 7)],
      ['다음 주 월요일', addDays(startOfWeek(today), 7)], ['1주 뒤', addDays(today, 7)],
    ];
    box.replaceChildren(
      h('div', { class: 'pk-head' },
        h('button', { type: 'button', class: 'pk-nav', 'aria-label': '이전 달', onclick: () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); draw(); } }, '‹'),
        h('strong', null, `${month.getFullYear()}년 ${month.getMonth() + 1}월`),
        h('button', { type: 'button', class: 'pk-nav', 'aria-label': '다음 달', onclick: () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); draw(); } }, '›')),
      grid,
      h('div', { class: 'pk-chips' }, quick.map(([label, d]) =>
        h('button', { type: 'button', onclick: () => { setField(id, toDateInput(d)); close(); } }, label))),
    );
  };
  draw();
}

/* ───── 시계 ───── */
const SIZE = 232, C = SIZE / 2, R = 88;
const svgEl = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const polar = (deg, r) => {
  const rad = (deg - 90) * Math.PI / 180;
  return [C + r * Math.cos(rad), C + r * Math.sin(rad)];
};

function renderTime(box, id) {
  const f = FIELDS[id];
  let start = parseTime($(id).value);
  if (!start && id === 'fEnd') {            // 끝나는 시각이 비어 있으면 시작 1시간 뒤부터
    const s = parseTime($('fTime').value) || { h: 10, m: 30 };
    start = { h: Math.min(23, s.h + 1), m: s.m };
  }
  if (!start) start = { h: 23, m: 59 };
  const state = { h: start.h, m: start.m, mode: 'hour' };

  const display = h('div', { class: 'pk-time' });
  const dial = svgEl('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'pk-dial', role: 'img' });

  const draw = () => {
    const isPM = state.h >= 12;
    const h12 = state.h % 12 === 0 ? 12 : state.h % 12;
    display.replaceChildren(
      h('div', { class: 'pk-ampm', role: 'radiogroup', 'aria-label': '오전 오후' },
        ['오전', '오후'].map((label, i) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': (i === 1) === isPM ? 'true' : 'false',
          onclick: () => { if ((i === 1) !== isPM) state.h = (state.h + 12) % 24; draw(); },
        }, label))),
      h('div', { class: 'pk-digits' },
        h('button', { type: 'button', class: state.mode === 'hour' ? 'on' : '', 'aria-label': '시 고르기', onclick: () => { state.mode = 'hour'; draw(); } }, String(h12)),
        h('span', null, ':'),
        h('button', { type: 'button', class: state.mode === 'minute' ? 'on' : '', 'aria-label': '분 고르기', onclick: () => { state.mode = 'minute'; draw(); } }, pad(state.m))),
    );

    dial.replaceChildren();
    dial.append(svgEl('circle', { cx: C, cy: C, r: C - 6, class: 'face' }));
    const value = state.mode === 'hour' ? (h12 % 12) * 30 : state.m * 6;
    const [hx, hy] = polar(value, R);
    dial.append(svgEl('line', { x1: C, y1: C, x2: hx, y2: hy, class: 'hand' }));
    dial.append(svgEl('circle', { cx: C, cy: C, r: 3.5, class: 'pivot' }));
    dial.append(svgEl('circle', { cx: hx, cy: hy, r: 17, class: 'knob' }));
    for (let i = 0; i < 12; i++) {
      const label = state.mode === 'hour' ? String(i === 0 ? 12 : i) : pad(i * 5);
      const [x, y] = polar(i * 30, R);
      const active = state.mode === 'hour' ? (h12 % 12) === i : state.m === i * 5;
      const t = svgEl('text', { x, y, class: active ? 'num on' : 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      t.textContent = label;
      dial.append(t);
    }
    if (state.mode === 'minute' && state.m % 5 !== 0) {
      dial.append(svgEl('circle', { cx: hx, cy: hy, r: 3, class: 'dot' }));
    }
    dial.setAttribute('aria-label', state.mode === 'hour' ? '시계에서 시를 고르세요' : '시계에서 분을 고르세요');
  };

  // 다이얼 누르고 끌기: 시는 12칸, 분은 1분 단위(손을 떼면 5분 단위 근처는 그대로)
  let dragging = false;
  const pick = e => {
    const r = dial.getBoundingClientRect();
    const x = (e.clientX - r.left) * (SIZE / r.width) - C;
    const y = (e.clientY - r.top) * (SIZE / r.height) - C;
    let deg = Math.atan2(y, x) * 180 / Math.PI + 90;
    if (deg < 0) deg += 360;
    if (state.mode === 'hour') {
      const hr = Math.round(deg / 30) % 12;
      state.h = (state.h >= 12 ? 12 : 0) + hr;
    } else {
      state.m = Math.round(deg / 6) % 60;
    }
    draw();
  };
  dial.addEventListener('pointerdown', e => { dragging = true; dial.setPointerCapture(e.pointerId); pick(e); });
  dial.addEventListener('pointermove', e => { if (dragging) pick(e); });
  dial.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    if (state.mode === 'hour') { state.mode = 'minute'; draw(); }
  });

  // 키보드: 화살표로 조절
  dial.tabIndex = 0;
  dial.addEventListener('keydown', e => {
    const step = state.mode === 'hour' ? 1 : (e.shiftKey ? 1 : 5);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      if (state.mode === 'hour') state.h = (state.h + 1) % 24; else state.m = (state.m + step) % 60;
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      if (state.mode === 'hour') state.h = (state.h + 23) % 24; else state.m = (state.m + 60 - step) % 60;
    } else if (e.key === 'Enter') { done(); return; } else return;
    e.preventDefault(); draw();
  });

  const done = () => { setField(id, `${pad(state.h)}:${pad(state.m)}`); close(); };
  const presets = presetsFor[id] || [];
  box.replaceChildren(
    display,
    dial,
    presets.length ? h('div', { class: 'pk-chips' }, presets.map(p => h('button', {
      type: 'button', onclick: () => { setField(id, p); close(); },
    }, timeLabel(p)))) : null,
    h('div', { class: 'pk-foot' },
      f.optional ? h('button', { type: 'button', class: 'btn ghost', onclick: () => { setField(id, ''); close(); } }, '없음') : null,
      h('span', { class: 'pk-spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, '취소'),
      h('button', { type: 'button', class: 'btn primary', 'data-autofocus': '', onclick: done }, '확인')),
  );
  draw();
}

export function initPickers() {
  for (const [id, f] of Object.entries(FIELDS)) {
    $(f.button).setAttribute('aria-expanded', 'false');
    $(f.button).addEventListener('click', () => open(id));
  }
  document.addEventListener('pointerdown', e => {
    if (!pickerOpen()) return;
    // 다이얼은 누르는 순간 다시 그려져 e.target이 문서에서 빠질 수 있어 경로로 확인
    const path = e.composedPath();
    if (path.includes($('picker'))) return;
    if (Object.values(FIELDS).some(f => path.includes($(f.button)))) return;
    close(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && pickerOpen()) { e.stopPropagation(); close(); }
  }, true);
  window.addEventListener('resize', () => close(false));
  document.addEventListener('scroll', e => { if (pickerOpen() && !$('picker').contains(e.target)) close(false); }, true);
  refreshPickLabels();
}
