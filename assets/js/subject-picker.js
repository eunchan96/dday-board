// 과목 고르기: 색 점이 붙은 목록 + 찾기 + 새 과목 추가
//
// const pick = subjectPicker({ id: 'fSubject', options: () => [...] });
// form.append(pick.el); pick.set('데이터베이스'); pick.value
// - 숨은 input(id)에 값이 들어가므로 $('#fSubject').value로도 읽을 수 있다
// - 새로 추가한 과목은 이 기기에 기억해 두고 다음에도 목록에 보여 준다

import { h, subjectColor, orderSubjects } from './util.js';
import { state, storage } from './store.js';
import { api } from './api.js';
import { subjectInScope, assignNewSubject } from './groups.js';

const KEY = 'ddayboard.subjects';
const SVGNS = 'http://www.w3.org/2000/svg';
const icon = d => {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.append(p);
  return s;
};

export function customSubjects() {
  try { const v = JSON.parse(storage.get(KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; }
  catch { return []; }
}
// 직접 추가한 과목은 보드에 저장해서 모든 기기에서 같게 (과제 · 시험에 이미 있는 과목은 따로 기억하지 않음)
export function setCustomSubjects(list) {
  storage.set(KEY, JSON.stringify((Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 100)));
}
function pushCustom(list) {
  if (!state.code) return;
  api.setCustomSubjects(state.code, list).catch(() => { /* 다음에 불러올 때 다시 맞춤 */ });
}
export function rememberSubject(name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n) return;
  const cur = customSubjects();
  if (cur.includes(n) || state.tasks.some(t => t.subject === n)) return;
  const list = [...cur, n].slice(-100);
  setCustomSubjects(list);
  pushCustom(list);
  assignNewSubject(n);      // 지금 보고 있는 분류에 넣어 둠
}
// 설정 → 과목 추가 (분류는 따로 정함)
export function addCustomSubject(name) {
  const n = String(name || '').trim().slice(0, 40);
  if (!n || customSubjects().includes(n)) return;
  const list = [...customSubjects(), n].slice(-100);
  setCustomSubjects(list);
  pushCustom(list);
}
export function forgetSubject(name) {
  const list = customSubjects().filter(x => x !== name);
  setCustomSubjects(list);
  pushCustom(list);
}

// 기본 목록: 위에서 고른 보기(지금 · 분류 · 전체)의 과목(남은 일이 많은 순) → 직접 추가한 과목 → 나머지
export function taskSubjects(scope) {
  const now = new Map(), old = new Set();
  for (const t of state.tasks) {
    if (!t.subject) continue;
    if (subjectInScope(t.subject, scope)) now.set(t.subject, (now.get(t.subject) || 0) + (t.done ? 0 : 1));
    else old.add(t.subject);
  }
  const cur = [...now.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'ko')).map(([n]) => n);
  const custom = customSubjects().filter(n => subjectInScope(n, scope));
  return unique([...cur, ...custom, ...[...old].filter(n => !now.has(n)).sort((a, b) => a.localeCompare(b, 'ko'))]);
}
const unique = list => [...new Set(list.filter(Boolean))];

/* ───── 펼친 목록 (화면에 하나만) ───── */
let pop = null, current = null, active = 0, items = [];

function ensurePop() {
  if (pop) return pop;
  const search = h('input', {
    type: 'text', class: 'sp-search', maxlength: 40, placeholder: '찾기 또는 새 과목 이름',
    'aria-label': '과목 찾기 또는 새 과목', autocomplete: 'off', spellcheck: 'false',
  });
  const list = h('ul', { class: 'sp-list', role: 'listbox', 'aria-label': '과목' });
  pop = h('div', { class: 'sp-pop', hidden: true }, h('div', { class: 'sp-search-wrap' }, icon('M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM13 13l4 4'), search), list);
  pop.search = search; pop.list = list;
  search.addEventListener('input', () => { active = 0; renderList(); });
  search.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.pick(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  });
  document.body.append(pop);
  // 바깥을 누르면 닫기
  document.addEventListener('pointerdown', e => {
    if (!current || pop.contains(e.target) || current.button.contains(e.target)) return;
    close(false);
  }, true);
  window.addEventListener('resize', () => current && place());
  window.addEventListener('scroll', e => { if (current && !pop.contains(e.target)) place(); }, true);
  return pop;
}

function move(dir) {
  if (!items.length) return;
  active = (active + dir + items.length) % items.length;
  paintActive();
}
function paintActive() {
  [...pop.list.children].forEach((li, i) => li.classList.toggle('active', i === active));
  pop.list.children[active]?.scrollIntoView({ block: 'nearest' });
}

function renderList() {
  const q = pop.search.value.trim();
  const ql = q.toLowerCase();
  const names = current.options().filter(n => !ql || n.toLowerCase().includes(ql));
  const exact = current.options().some(n => n.toLowerCase() === ql);
  items = [];
  const row = (name, label, opts = {}) => {
    const selected = !opts.isNew && current.value === name;
    const li = h('li', {
      role: 'option', 'aria-selected': selected ? 'true' : 'false',
      class: `${opts.isNew ? 'sp-new' : ''}${opts.none ? ' sp-none' : ''}`,
      style: { '--c': name ? subjectColor(name) : 'var(--pencil-2)' },
      onpointerdown: e => e.preventDefault(),         // 입력 칸 포커스 유지
      onclick: () => item.pick(),
      onpointermove: () => { if (active !== idx) { active = idx; paintActive(); } },
    },
    opts.isNew ? icon('M10 4.5v11M4.5 10h11') : h('i', { class: 'sp-dot' }),
    h('span', { class: 'sp-name' }, label),
    selected ? icon('M5.5 10.5l3 3 6-7') : null);
    const idx = items.length;
    const item = { li, pick: () => choose(name, opts.isNew) };
    items.push(item);
    return li;
  };
  const kids = [];
  if (current.allowNone && !q) kids.push(row('', current.noneLabel, { none: true }));
  for (const n of names) kids.push(row(n, n));
  if (q && !exact) kids.push(row(q.slice(0, 40), `"${q.slice(0, 40)}" 새 과목으로 추가`, { isNew: true }));
  if (!kids.length) kids.push(h('li', { class: 'sp-empty' }, '과목 이름을 적으면 새로 추가할 수 있어요'));
  pop.list.replaceChildren(...kids);
  // 처음 열 때는 지금 고른 과목에 맞춰 둔다
  if (!q) { const i = items.findIndex(it => it.li.getAttribute('aria-selected') === 'true'); active = i >= 0 ? i : 0; }
  active = Math.min(active, Math.max(0, items.length - 1));
  paintActive();
}

function place() {
  const r = current.button.getBoundingClientRect();
  const w = Math.min(Math.max(r.width, 260), innerWidth - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  const ph = Math.min(pop.scrollHeight, 340);
  const below = innerHeight - r.bottom - 8;
  if (below >= Math.min(ph, 220) || below >= r.top) { pop.style.top = `${r.bottom + 4}px`; pop.style.bottom = ''; pop.style.maxHeight = `${Math.min(340, below - 4)}px`; }
  else { pop.style.top = ''; pop.style.bottom = `${innerHeight - r.top + 4}px`; pop.style.maxHeight = `${Math.min(340, r.top - 12)}px`; }
}

function openFor(picker) {
  ensurePop();
  if (current) close(false);
  current = picker;
  picker.button.setAttribute('aria-expanded', 'true');
  pop.search.value = '';
  pop.hidden = false;
  renderList();
  place();
  // 폰에서는 바로 키보드가 올라오지 않게 (목록부터 보이도록)
  if (!matchMedia('(pointer: coarse)').matches) pop.search.focus();
}
function close(refocus) {
  if (!current) return;
  const btn = current.button;
  btn.setAttribute('aria-expanded', 'false');
  pop.hidden = true;
  current = null;
  if (refocus) btn.focus();
}
function choose(name, isNew) {
  const picker = current;
  if (isNew) rememberSubject(name);
  close(true);
  picker.set(name);
  picker.onChange?.(name);
}

/* ───── 버튼 ───── */
export function subjectPicker({ id, value = '', options, allowNone = true, noneLabel = '과목 없음', placeholder = '과목', onChange, className = '' }) {
  const hidden = h('input', { type: 'hidden', id });
  const dot = h('i', { class: 'sp-dot' });
  const label = h('span', { class: 'sp-label' });
  const button = h('button', {
    type: 'button', class: `subject-pick ${className}`, 'aria-haspopup': 'listbox', 'aria-expanded': 'false',
  }, dot, label, icon('M5.5 8l4.5 4.5L14.5 8'));
  const picker = {
    el: h('span', { class: 'sp-wrap' }, hidden, button),
    button, allowNone, noneLabel, onChange,
    options: () => orderSubjects(unique(options())),
    get value() { return hidden.value; },
    set(v) {
      hidden.value = String(v || '').trim();
      const has = !!hidden.value;
      label.textContent = has ? hidden.value : (allowNone ? noneLabel : placeholder);
      button.classList.toggle('empty', !has);
      button.style.setProperty('--c', has ? subjectColor(hidden.value) : 'var(--pencil-2)');
      button.setAttribute('aria-label', `과목: ${has ? hidden.value : noneLabel}`);
    },
  };
  button.addEventListener('click', () => (current === picker ? close(true) : openFor(picker)));
  button.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || (e.key === 'Enter' && current !== picker)) { e.preventDefault(); openFor(picker); }
  });
  picker.set(value);
  return picker;
}
