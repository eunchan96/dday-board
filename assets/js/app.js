// 앱 시작, 화면 구성, 이벤트 연결

import {
  state, subscribe, setPref, pull, saveTask, toggleDone, toggleStar, removeTask, undoRemove,
  createBoard, connect, disconnect, loadLms, lmsSync, setFeed, setToken, importBackup, exportBackup, canvasImport, storage,
} from './store.js';
import { parseCanvasData, summarize, bookmarkletSource, listenForCanvasData } from './canvas.js';
import { initPickers, setField, refreshPickLabels, setTimePresets, closePicker, pickerOpen, timeLabel } from './picker.js';
import { pushSupport, pushStatus, enablePush, disablePush, setLeads, testPush, LEAD_OPTIONS, DEFAULT_LEADS } from './push.js';
import { errText, api, CALENDAR_FEED_URL } from './api.js';
import {
  $, $$, h, fmtDate, fmtDuration, fmtClock, subjectColor, setSubjects, startOfDay, addDays,
  startOfWeek, toDateInput, toTimeInput, DAY, isExam, groupOf, timeRange, dday,
  semesterOf, semesterKey, semesterLabel, parseSemesterKey, semesterRange, taskSemesterKey, fmtSize, displayTitle,
  setSubjectColors, customColorOf, SUBJECT_PALETTE, setSubjectOrder, orderSubjects,
} from './util.js';
import { renderList, renderCalendar, taskRow } from './views.js';
import {
  groupsSorted, groupById, currentGroupId, currentIds, activeGroupId, inScope, subjectInGroup, membersOf, membershipText, setMembers,
  addGroup, updateGroup, removeGroup, forgetMembers, applyServerGroups, ensureTerms, onGroupsChange, periodText, groupStart, ALL,
  implicitGroupIds, scopeValue, scopeIds, scopeLabel, scopeSub, isInactive, setInactive, setGroupOff,
} from './groups.js';
import { subjectPicker, taskSubjects, rememberSubject, customSubjects, setCustomSubjects, forgetSubject } from './subject-picker.js';
import { initStudy, onShowStudy, render as renderStudy, startFor, timerSummary, handleKey as studyKey, loadStudy, openFriends } from './study.js';

const SYNC_INTERVAL = 30000;

// null/false를 걸러서 붙이기 (DOM의 append는 null을 "null" 글자로 넣는다)
const clean = kids => kids.flat().filter(k => k != null && k !== false);
const add = (el, ...kids) => el.append(...clean(kids));
const fill = (el, ...kids) => el.replaceChildren(...clean(kids));

/* ───── 화면 상태 (기기에만) ───── */
const ui = {
  query: '',
  showDone: false,
  calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDay: startOfDay(new Date()),
  editingId: null,
  kind: 'assignment',
};

const isEmbedded = (() => { try { return window.self !== window.top; } catch { return true; } })();
if (isEmbedded) document.body.classList.add('embed');

/* ───── 테마 ───── */
function applyTheme() {
  const t = state.prefs.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  $$('#themePicker button').forEach(b => b.setAttribute('aria-checked', b.dataset.theme === t ? 'true' : 'false'));
}

/* ───── 묶음 (학기 · 기간 · 넓은 의미의 과목) ───── */
// 묶음만 적용한 과제 (통계, 과목 수, 다음 마감에 사용)
function scopedTasks() {
  const v = scopeValue();
  return v === 'all' ? state.tasks : state.tasks.filter(t => inScope(t, v));
}

function renderSemester() {
  const v = scopeValue();
  const btn = $('#scopeBtn');
  if (!btn) return;
  const sub = v === 'current' ? scopeSub('current') : '';
  fill(btn.querySelector('.scope-label'), h('b', null, scopeLabel(v)), sub && sub !== '모든 일정' ? h('small', null, sub) : null);
  btn.title = scopeSub(v);
  btn.setAttribute('aria-expanded', scopeOpen ? 'true' : 'false');
  const pop = $('#scopePop');
  pop.hidden = !scopeOpen;
  if (scopeOpen) {
    fill(pop,
      h('div', { class: 'scope-list', role: 'listbox', 'aria-label': '보기' }, scopeItems(setScope)),
      h('button', { type: 'button', class: 'scope-manage', onclick: () => { scopeOpen = false; renderSemester(); openSettings('colors'); } }, '분류 관리'));
  }
}

/* ───── 과목 색 (보드에 저장, 기기마다 같게) ───── */
const COLOR_KEY = 'ddayboard.colors';
let colorMap = (() => { try { return JSON.parse(storage.get(COLOR_KEY) || '{}') || {}; } catch { return {}; } })();
setSubjectColors(colorMap);
function applyColors(map) {
  colorMap = map && typeof map === 'object' ? map : {};
  setSubjectColors(colorMap);
  storage.set(COLOR_KEY, JSON.stringify(colorMap));
}
// 과목 순서 (보드에 저장)
const ORDER_KEY = 'ddayboard.subjectOrder';
let subjectOrder = (() => { try { return JSON.parse(storage.get(ORDER_KEY) || '[]') || []; } catch { return []; } })();
setSubjectOrder(subjectOrder);
function applyOrder(list) {
  subjectOrder = Array.isArray(list) ? list : [];
  setSubjectOrder(subjectOrder);
  storage.set(ORDER_KEY, JSON.stringify(subjectOrder));
}
async function loadColors() {
  if (!state.code) return;
  try {
    const prefs = (await api.subjectPrefs(state.code)) || {};
    const map = prefs.colors || {}, order = prefs.order || [];
    // 직접 추가한 과목: 보드 것 + 이 기기에만 있던 것(보드에 저장하기 전 버전에서 추가한 과목)을 합친다
    const server = Array.isArray(prefs.custom) ? prefs.custom : [];
    const local = customSubjects();
    const known = new Set(state.tasks.map(t => t.subject).filter(Boolean));
    const extra = local.filter(n => !server.includes(n) && !known.has(n));
    const custom = [...server, ...extra].slice(-100);
    const changedAny = JSON.stringify(map) !== JSON.stringify(colorMap) || JSON.stringify(order) !== JSON.stringify(subjectOrder)
      || JSON.stringify(custom) !== JSON.stringify(local);
    setCustomSubjects(custom);
    if (extra.length && state.tasks.length) api.setCustomSubjects(state.code, custom).catch(() => {});
    const groupsChanged = applyServerGroups(prefs.groups);
    applyColors(map); applyOrder(order);
    if (changedAny || groupsChanged) { renderAll(); renderColors(); }
  } catch { /* 다음에 다시 */ }
}
// 설정 → 과목 목록: 고른 보기(지금 · 분류 · 전체)의 과목. 순서는 하나로 저장하고 보이는 과목끼리만 바꾼다
let colorScope = undefined;                       // 설정에서 보는 범위 (undefined = 위에서 고른 보기)
const settingsScope = () => (colorScope === undefined ? scopeValue() : colorScope);
function allSubjectNames() {
  const set = new Set(state.tasks.map(t => t.subject).filter(Boolean));
  for (const n of customSubjects()) set.add(n);
  return orderSubjects([...set]);
}
function settingsSubjects() {
  const v = settingsScope();
  // 설정에서는 쓰지 않는 과목도 보여 줌 (다시 켤 수 있게)
  const ids = scopeIds(v);
  const names = allSubjectNames().filter(n => !ids || ids.some(id => subjectInGroup(n, id)));
  return { current: names, old: [] };
}
async function saveOrder(visible, focusName) {
  // 보이는 과목들의 자리에 새 순서를 끼워 넣어 전체 순서를 만든다
  const all = allSubjectNames();
  const set = new Set(visible);
  const queue = [...visible];
  const names = all.map(n => (set.has(n) ? queue.shift() : n));
  const prev = subjectOrder;
  applyOrder(names); renderAll(); renderColors();
  if (focusName) requestAnimationFrame(() => $(`#colorList [data-name="${CSS.escape(focusName)}"] .cr-grip`)?.focus());
  try { applyOrder(await api.setSubjectOrder(state.code, names)); }
  catch (e) { applyOrder(prev); renderAll(); renderColors(); toast(errText(e)); }
}
function moveSubject(name, dir) {
  const names = settingsSubjects().current;
  const i = names.indexOf(name), j = i + dir;
  if (i < 0 || j < 0 || j >= names.length) return;
  [names[i], names[j]] = [names[j], names[i]];
  saveOrder(names, name);
}

// 손잡이(⋮⋮)를 잡고 위아래로 끌어서 순서 바꾸기 — 마우스 · 터치 같은 방식 (pointer 이벤트)
function startDrag(e, grip) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  const list = $('#colorList .cr-current');
  const rows = [...list.querySelectorAll(':scope > .color-row')];
  const row = grip.closest('.color-row');
  const from = rows.indexOf(row);
  if (from < 0 || rows.length < 2) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const body = $('#settings .settings-body');
  const items = rows.map(r => ({ el: r, top: r.offsetTop, h: r.offsetHeight }));
  const span = items[from].h;
  const listY = () => list.getBoundingClientRect().top;
  const startY = e.clientY - listY();
  let to = from, lastY = e.clientY, raf = 0;
  row.classList.add('dragging');
  list.classList.add('sorting');

  const layout = () => {
    const dy = (lastY - listY()) - startY;
    const lo = -items[from].top, hi = items[items.length - 1].top + items[items.length - 1].h - items[from].top - span;
    const d = Math.max(lo, Math.min(hi, dy));
    row.style.transform = `translateY(${d}px)`;
    const center = items[from].top + d + span / 2;
    to = 0;
    items.forEach((it, i) => { if (i !== from && it.top + it.h / 2 < center) to++; });
    items.forEach((it, i) => {
      if (i === from) return;
      const shift = from < to && i > from && i <= to ? -span : to < from && i >= to && i < from ? span : 0;
      it.el.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  // 칸 끝에 가까우면 설정 본문을 저절로 스크롤
  const edge = () => {
    raf = 0;
    const r = body.getBoundingClientRect();
    const v = lastY < r.top + 48 ? -8 : lastY > r.bottom - 48 ? 8 : 0;
    if (v) { body.scrollTop += v; layout(); raf = requestAnimationFrame(edge); }
  };
  const move = ev => { lastY = ev.clientY; layout(); if (!raf) raf = requestAnimationFrame(edge); };
  const end = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    cancelAnimationFrame(raf);
    list.classList.remove('sorting');
    row.classList.remove('dragging');
    items.forEach(it => { it.el.style.transform = ''; });
    if (to === from) return;
    const names = rows.map(r => r.dataset.name);
    const [n] = names.splice(from, 1);
    names.splice(to, 0, n);
    saveOrder(names, n);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

async function setColor(name, color) {
  const prev = colorMap;
  const next = { ...colorMap };
  if (color) next[name] = color; else delete next[name];
  applyColors(next); renderAll(); renderColors();
  try { applyColors(await api.setSubjectColor(state.code, name, color)); }
  catch (e) { applyColors(prev); renderAll(); renderColors(); toast(errText(e)); }
}
const RESET_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 9.5a5.5 5.5 0 1 1 1.6 4.4"/><path d="M4 5v4.5h4.5"/></svg>';
const GRIP_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7.5" cy="5.5" r="1.3"/><circle cx="12.5" cy="5.5" r="1.3"/><circle cx="7.5" cy="10" r="1.3"/><circle cx="12.5" cy="10" r="1.3"/><circle cx="7.5" cy="14.5" r="1.3"/><circle cx="12.5" cy="14.5" r="1.3"/></svg>';
const EDIT_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.8 4.2l3 3L7.5 15.5l-3.7.7.7-3.7z"/><path d="M11 6l3 3"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/></svg>';
const iconBtn = (svg, label, onclick, cls = '') => {
  const b = h('button', { type: 'button', class: `btn icon ghost sm-icon ${cls}`, title: label, 'aria-label': label, onclick });
  b.innerHTML = svg;
  return b;
};
let colorOpen = null;                             // 편집 창을 연 과목

// 설정 → 과목: 과목 목록 (손잡이로 순서, 누르면 편집 창)
function renderColors() {
  renderGroupsEditor();
  const scopeSel = $('#colorScope');
  if (scopeSel) {
    scopeSel.replaceChildren(
      h('option', { value: 'current' }, '지금'),
      ...groupsSorted().map(g => h('option', { value: g.id }, g.name)),
      h('option', { value: 'all' }, '전체'));
    scopeSel.value = settingsScope();
  }
  const { current } = settingsSubjects();
  const row = name => {
    const off = isInactive(name);
    let grip = null;
    if (current.length > 1) {
      grip = h('button', {
        type: 'button', class: 'cr-grip', title: '끌어서 순서 바꾸기',
        'aria-label': `${name} 순서 바꾸기 (위 · 아래 화살표 키)`,
        onpointerdown: e => startDrag(e, grip),
        onkeydown: e => {
          if (e.key === 'ArrowUp') { e.preventDefault(); moveSubject(name, -1); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); moveSubject(name, 1); }
        },
      });
      grip.innerHTML = GRIP_SVG;
    }
    return h('div', { class: `set-row stack color-row${off ? ' off' : ''}`, style: { '--c': String(subjectColor(name)) }, dataset: { name } },
      h('div', { class: 'cr-head' },
        grip,
        h('button', { type: 'button', class: 'cr-name', title: '과목 수정', onclick: () => openSubjectEditor(name) },
          h('i', { class: 'cr-dot' }),
          h('span', { class: 'cr-title' }, name),
          h('span', { class: `cr-groups${membersOf(name).length ? '' : ' auto'}` }, off ? '쓰지 않음' : membershipText(name))),
        iconBtn(EDIT_SVG, `${name} 수정`, () => openSubjectEditor(name))));
  };
  fill($('#colorList'),
    current.length ? h('div', { class: 'cr-current' }, current.map(row))
      : h('p', { class: 'help pad' }, '아직 과목이 없어요.'));
  if ($('#subjectDialog')?.open) renderSubjectEditor();
}

/* ───── 과목 편집 창: 색 · 분류 · 쓰기/안 쓰기 · 삭제 ───── */
function openSubjectEditor(name) {
  colorOpen = name;
  renderSubjectEditor();
  const d = $('#subjectDialog');
  if (!d.open) d.showModal();
}
function renderSubjectEditor() {
  const name = colorOpen;
  if (!name) return;
  const cur = String(subjectColor(name)).toUpperCase();
  const members = membersOf(name);
  const always = members.includes(ALL);
  const implicit = members.length ? [] : implicitGroupIds(name);
  const toggleMember = (id, on) => {
    const base = (membersOf(name).length ? membersOf(name) : implicit).filter(x => x !== ALL);
    setMembers(name, on ? [...base, id] : base.filter(x => x !== id));
  };
  const removable = !state.tasks.some(t => t.subject === name) && customSubjects().includes(name);
  const d = $('#subjectDialog');
  d.style.setProperty('--c', cur);
  $('#sdTitle').textContent = name;
  fill($('#sdBody'),
    h('section', { class: 'sd-sec' },
      h('h4', null, '색', customColorOf(name) ? iconBtn(RESET_SVG, '기본 색으로', () => setColor(name, null)) : null),
      h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': `${name} 색` },
        SUBJECT_PALETTE.map(c => h('button', {
          type: 'button', class: 'swatch', role: 'radio', 'aria-checked': cur === c.toUpperCase() ? 'true' : 'false',
          style: { '--s': c }, 'aria-label': `색 ${c}`, onclick: () => setColor(name, c),
        })))),
    h('section', { class: 'sd-sec' },
      h('h4', null, '분류', h('span', { class: 'sd-note' }, members.length ? '' : '날짜로 정해짐')),
      h('div', { class: 'sd-groups' },
        groupsSorted().map(g => h('label', { class: 'sd-check' },
          h('input', { type: 'checkbox', checked: always || members.includes(g.id) || implicit.includes(g.id), disabled: always, onchange: e => toggleMember(g.id, e.target.checked) }),
          h('span', null, g.name), h('small', null, periodText(g)))),
        h('label', { class: 'sd-check always' },
          h('input', { type: 'checkbox', checked: always, onchange: e => setMembers(name, e.target.checked ? [ALL] : []) }),
          h('span', null, '모든 분류에 항상')))),
    h('section', { class: 'sd-sec sd-row' },
      h('div', null, h('h4', null, '쓰는 중'), h('p', { class: 'sd-note' }, '끄면 "지금" 보기와 과목 고르기에서 숨겨요')),
      h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: !isInactive(name), 'aria-label': '쓰는 중', onchange: e => setInactive(name, !e.target.checked) })));
  const del = $('#sdDelete');
  del.hidden = !removable;
  del.onclick = () => {
    forgetSubject(name); forgetMembers(name); applyOrder(subjectOrder.filter(n => n !== name));
    d.close(); renderAll(); renderColors(); toast(`"${name}" 과목을 삭제했어요`);
  };
}

/* ───── 설정 → 과목: 분류 만들기 · 수정 · 삭제 ───── */
let groupEdit = null;                              // { id|null, name, start, end }
function renderGroupsEditor() {
  const box = $('#groupList');
  if (!box) return;
  // '지금'에 들어갈 수 있는 분류(기간이 없거나 오늘이 기간 안)만 켜고 끌 수 있게
  const applicable = g => !g.start && !g.end ? true : (() => { const t = new Date(); return groupStart(g) <= t && t < new Date(new Date(`${g.end}T00:00`).getTime() + 864e5); })();
  const editor = g => {
    const name = h('input', { type: 'text', maxlength: 30, value: g.name || '', placeholder: '이름 (예: 2026년 2학기, ADsP)', 'aria-label': '분류 이름' });
    const start = h('input', { type: 'date', value: g.start || '', 'aria-label': '시작 날짜' });
    const end = h('input', { type: 'date', value: g.end || '', 'aria-label': '끝 날짜' });
    const msg = h('p', { class: 'msg err', role: 'status' });
    const save = () => {
      const n = name.value.trim();
      if (!n) { msg.textContent = '이름을 적어 주세요'; name.focus(); return; }
      if ((start.value && !end.value) || (!start.value && end.value)) { msg.textContent = '기간은 시작 · 끝을 함께 정하거나 둘 다 비워 두세요'; return; }
      if (start.value && end.value < start.value) { msg.textContent = '끝 날짜가 시작보다 빨라요'; return; }
      const f = { name: n, start: start.value || null, end: end.value || null };
      if (g.id) updateGroup(g.id, f); else addGroup(f);
      groupEdit = null; renderAll(); renderColors();
    };
    name.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save(); } });
    requestAnimationFrame(() => name.focus());
    return h('div', { class: 'set-row stack grp-edit' },
      name,
      h('div', { class: 'grp-dates' }, start, h('span', null, '~'), end),
      h('p', { class: 'grp-hint' }, '기간이 없으면 비워 두세요'),
      msg,
      h('div', { class: 'grp-actions' },
        h('button', { type: 'button', class: 'btn sm', onclick: () => { groupEdit = null; renderColors(); } }, '취소'),
        h('button', { type: 'button', class: 'btn sm primary', onclick: save }, g.id ? '저장' : '추가')));
  };
  const rows = groupsSorted().map(g => groupEdit && groupEdit.id === g.id ? editor(groupEdit) : h('div', { class: `set-row grp-row${g.off ? ' off' : ''}` },
    h('div', { class: 'set-text' },
      h('b', null, g.name),
      h('span', { class: 'set-sub' }, periodText(g))),
    applicable(g) ? h('label', { class: 'grp-switch', title: '"지금" 보기에 넣기' },
      h('span', null, '지금'),
      h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: !g.off, 'aria-label': `${g.name} "지금" 보기에 넣기`, onchange: e => setGroupOff(g.id, !e.target.checked) })) : null,
    iconBtn(EDIT_SVG, `${g.name} 수정`, () => { groupEdit = { ...g }; renderColors(); }),
    iconBtn(TRASH_SVG, `${g.name} 삭제`, () => {
      if (!confirmRemove(g)) return;
      removeGroup(g.id); renderAll(); renderColors(); toast(`"${g.name}" 분류를 삭제했어요. 일정은 그대로 있어요`);
    }, 'cr-del')));
  fill(box, rows,
    groupEdit && !groupEdit.id ? editor(groupEdit)
      : h('div', { class: 'set-row grp-add-row' }, h('button', { type: 'button', class: 'btn sm ghost grp-add', onclick: () => { groupEdit = { id: null, name: '', start: '', end: '' }; renderColors(); } }, '+ 분류 추가')));
}
// 삭제 확인은 버튼을 한 번 더 누르게 (브라우저 확인 창 대신)
let removeArm = null;
function confirmRemove(g) {
  if (removeArm === g.id) { removeArm = null; return true; }
  removeArm = g.id;
  toast(`"${g.name}" 분류를 삭제하려면 한 번 더 눌러 주세요`);
  setTimeout(() => { if (removeArm === g.id) removeArm = null; }, 4000);
  return false;
}

/* ───── 위쪽 보기 고르기 (지금 · 분류 · 전체) ───── */
function scopeOptions() {
  const now = new Set(currentIds());
  return [
    { value: 'current', label: '지금', sub: scopeSub('current') },
    ...groupsSorted().map(g => ({ value: g.id, label: g.name, sub: periodText(g), now: now.has(g.id) })),
    { value: 'all', label: '전체', sub: '모든 일정' },
  ];
}
function setScope(v) {
  scopeOpen = false;
  setPref('subject', null);
  setPref('semester', v);
  // 캘린더를 그 분류의 첫 달로 (지금이거나 기간이 없으면 이번 달)
  const g = v === 'current' || v === 'all' ? null : groupById(v);
  const s = g && groupStart(g);
  const base = s || new Date();
  ui.calMonth = new Date(base.getFullYear(), base.getMonth(), 1);
  ui.selectedDay = s ? null : startOfDay(new Date());
  renderSemester(); renderView();
}
// 목록 모양 (상단 펼침)
function scopeItems(onPick) {
  const cur = scopeValue();
  return scopeOptions().map(o => {
    const b = h('button', {
      type: 'button', role: 'option', class: `scope-item${o.value === 'current' || o.value === 'all' ? ' special' : ''}`,
      'aria-selected': o.value === cur ? 'true' : 'false', onclick: () => onPick(o.value),
    }, h('span', { class: 'si-text' }, h('b', null, o.label), h('small', null, o.sub)), h('span', { class: 'flt-check' }));
    if (o.value === cur) b.querySelector('.flt-check').innerHTML = CHECK_SVG;
    return b;
  });
}
// 칩 모양 (폰 필터 안)
function scopeChips(onPick) {
  const cur = scopeValue();
  return h('div', { class: 'scope-chip-row' },
    h('div', { class: 'scope-chips', role: 'radiogroup', 'aria-label': '보기' },
      scopeOptions().map(o => h('button', {
        type: 'button', role: 'radio', class: 'scope-chip', 'aria-checked': o.value === cur ? 'true' : 'false', title: o.sub,
        onclick: () => onPick(o.value),
      }, o.label))),
    iconBtn(GEAR_SVG, '분류 관리', () => { fltOpen = false; renderRail(); openSettings('colors'); }, 'scope-gear'));
}
const GEAR_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6h13M3.5 14h13"/><circle cx="7.5" cy="6" r="2" class="fill-sheet"/><circle cx="12.5" cy="14" r="2" class="fill-sheet"/></svg>';
let scopeOpen = false;

/* ───── 검색 ───── */
function openSearch() {
  document.body.classList.add('search-open');
  $('#search').focus();
}
function closeSearch() {
  document.body.classList.remove('search-open');
  if (ui.query) { ui.query = ''; $('#search').value = ''; renderView(); }
  $('#btnSearch').focus();
}

/* ───── 필터 적용 ───── */
function visibleTasks() {
  const q = ui.query.trim().toLowerCase();
  const { subject, hideDone, starredOnly, kind } = state.prefs;
  return scopedTasks().filter(t => {
    if (hideDone && t.done) return false;
    if (kind === 'exam' && !isExam(t)) return false;
    if (kind === 'assignment' && isExam(t)) return false;
    if (starredOnly && !t.starred) return false;
    if (subject != null && (t.subject || '') !== subject) return false;
    if (q && !`${t.title} ${t.subject || ''} ${t.memo || ''} ${t.location || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/* ───── 다음 마감 한 줄 ───── */
function renderNext() {
  const now = new Date();
  const byDue = (a, b) => new Date(a.due) - new Date(b.due);
  const scoped = scopedTasks();
  const assignments = scoped.filter(t => !isExam(t));
  const pending = assignments.filter(t => !t.done);
  const upcoming = pending.filter(t => new Date(t.due) >= now).sort(byDue);
  const over = pending.length - upcoming.length;
  const nextExam = scoped.filter(t => isExam(t) && !t.done && groupOf(t, now) !== 'done').sort(byDue)[0];

  const line = h('p', { class: 'next-line' });
  const next = upcoming[0];
  if (next) {
    add(line,
      '다음 마감은 ',
      h('button', { type: 'button', onclick: () => openPanel(next) }, next.title),
      `, ${fmtDuration(new Date(next.due) - now)} 남았어요.`,
    );
  } else if (assignments.length) {
    add(line, over ? '마감이 지난 과제만 남아 있어요.' : '남은 과제가 없어요.');
  } else if (state.tasks.length && !scoped.length) {
    add(line, `${scopeValue() === 'all' ? '' : `${scopeLabel()}에는 `}일정이 없어요.`);
  } else {
    add(line, '과제를 추가하면 가장 가까운 마감을 여기에 알려 드려요.');
  }

  const parts = [line];
  // 일주일 안의 시험만 한 줄로
  if (nextExam && new Date(nextExam.due) - now < 7 * 864e5) {
    const d = new Date(nextExam.due);
    parts.push(h('p', { class: 'next-exam' },
      h('span', { class: 'exam-word' }, '시험'),
      h('button', { type: 'button', onclick: () => openPanel(nextExam) },
        displayTitle(nextExam)),
      ` ${fmtDate(d, false)} ${timeRange(nextExam)}`,
      ` · ${dday(nextExam, now).label}`));
  }
  // 토큰이 만료되면 자동 가져오기가 멈추므로 눈에 띄게
  if (state.lms.error === 'token_invalid') {
    parts.push(h('p', { class: 'next-alert' }, '스마트캠퍼스 토큰이 만료돼서 과제를 못 가져오고 있어요. ',
      h('button', { type: 'button', onclick: () => openSettings() }, '새 토큰 넣기')));
  }
  fill($('#next'), parts);
}

/* ───── 왼쪽 필터 ───── */
function subjectsWithCounts() {
  const map = new Map();
  const now = new Date();
  for (const t of scopedTasks()) {
    const k = t.subject || '';
    const v = map.get(k) || { total: 0, pending: 0 };
    v.total++; if (groupOf(t, now) !== 'done') v.pending++;   // 끝난 시험은 남은 일로 세지 않음
    map.set(k, v);
  }
  const sorted = [...map.entries()].sort((a, b) => (b[1].pending - a[1].pending) || a[0].localeCompare(b[0], 'ko'));
  // 설정에서 정한 과목 순서가 있으면 그 순서로 ('과목 없음'은 맨 뒤)
  const order = orderSubjects(sorted.map(([n]) => n).filter(Boolean));
  const byName = new Map(sorted);
  return [...order.map(n => [n, byName.get(n)]), ...(byName.has('') ? [['', byName.get('')]] : [])];
}

function renderRail() {
  const rail = $('#rail');
  const cur = state.prefs.subject;
  const subjects = subjectsWithCounts();
  const now = new Date();
  const pendingAll = scopedTasks().filter(t => groupOf(t, now) !== 'done').length;

  const item = (label, value, count, color) => h('li', null,
    h('button', {
      type: 'button', 'aria-pressed': cur === value ? 'true' : 'false',
      onclick: () => setPref('subject', cur === value && value !== null ? null : value),
    },
    h('i', { class: 'tab', style: { background: color || 'transparent' } }),
    h('span', { class: 'name' }, label),
    h('span', { class: 'count' }, count)));

  const list = h('ul', { class: 'subject-list' },
    item('전체', null, pendingAll, 'var(--ink)'),
    subjects.map(([name, c]) => item(name || '과목 없음', name, c.pending, subjectColor(name))));

  const toggle = (key, label) => h('label', { class: 'check-row' },
    h('input', { type: 'checkbox', checked: !!state.prefs[key], onchange: e => setPref(key, e.target.checked) }),
    h('span', null, label));

  // 좁은 화면: 칩 대신 필터 버튼 하나 → 펼치면 과목 고르기 + 보기 옵션
  const flt = buildFilter(subjects, pendingAll);
  rail.replaceChildren(
    flt,
    h('div', null, list),
    h('div', { class: 'toggles' },
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: state.prefs.kind === 'exam', onchange: e => setPref('kind', e.target.checked ? 'exam' : null) }),
        h('span', null, '시험만')),
      toggle('starredOnly', '중요한 것만'),
      toggle('hideDone', '완료 숨기기')),
  );

}

/* ───── 좁은 화면 필터 ───── */
let fltOpen = false;
const CHECK_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.5l3 3 6-7"/></svg>';
function buildFilter(subjects, pendingAll) {
  const cur = state.prefs.subject;
  const opts = [
    state.prefs.kind === 'exam' ? '시험만' : null,
    state.prefs.starredOnly ? '중요만' : null,
    state.prefs.hideDone ? '완료 숨김' : null,
  ].filter(Boolean);
  // 폰에서는 보기(지금 · 분류 · 전체) 고르기도 이 필터 안에 (상단바가 좁아서)
  const otherSem = scopeValue() !== 'current';
  const semText = otherSem ? scopeLabel() : null;
  const label = [semText, cur === null ? '전체 과목' : (cur || '과목 없음')].filter(Boolean).join(' · ');
  const btn = h('button', {
    type: 'button', class: `flt-btn${cur !== null || opts.length || otherSem ? ' on' : ''}`, 'aria-expanded': fltOpen ? 'true' : 'false',
    'aria-haspopup': 'dialog', style: { '--c': cur === null ? 'var(--ink)' : subjectColor(cur) },
    onclick: () => { fltOpen = !fltOpen; renderRail(); },
  },
  h('svg-slot'),
  h('i', { class: 'flt-dot' }), h('span', { class: 'flt-label' }, label),
  opts.length ? h('span', { class: 'flt-opts' }, opts.join(' · ')) : null);
  btn.querySelector('svg-slot').outerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5h13M6 10h8M8.5 14.5h3"/></svg>';
  const clear = cur !== null || opts.length ? h('button', {
    type: 'button', class: 'btn icon ghost flt-clear', title: '필터 지우기', 'aria-label': '필터 지우기',
    onclick: () => { fltOpen = false; state.prefs.kind = null; state.prefs.starredOnly = false; state.prefs.hideDone = false; setPref('subject', null); },
  }) : null;
  if (clear) clear.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>';

  const subjRow = (name, value, count, color) => {
    const on = cur === value;
    const li = h('li', null, h('button', {
      type: 'button', class: 'flt-item', role: 'radio', 'aria-checked': on ? 'true' : 'false', style: { '--c': color },
      onclick: () => { fltOpen = false; setPref('subject', value); },
    }, h('i', { class: 'flt-dot' }), h('span', { class: 'flt-name' }, name), h('span', { class: 'flt-count' }, count), h('span', { class: 'flt-check' })));
    if (on) li.querySelector('.flt-check').innerHTML = CHECK_SVG;
    return li;
  };
  const toggle = (label, on, onchange) => h('label', { class: 'flt-toggle' },
    h('span', null, label), h('input', { type: 'checkbox', role: 'switch', checked: on, onchange: e => onchange(e.target.checked) }));
  const pop = fltOpen ? h('div', { class: 'flt-pop', role: 'dialog', 'aria-label': '필터' },
    h('div', { class: 'flt-sem' }, scopeChips(v => { fltOpen = false; setScope(v); })),
    h('ul', { class: 'flt-list', role: 'radiogroup', 'aria-label': '과목' },
      subjRow('전체 과목', null, pendingAll, 'var(--ink)'),
      subjects.map(([name, c]) => subjRow(name || '과목 없음', name, c.pending, subjectColor(name)))),
    h('div', { class: 'flt-toggles' },
      toggle('시험만', state.prefs.kind === 'exam', v => setPref('kind', v ? 'exam' : null)),
      toggle('중요한 것만', !!state.prefs.starredOnly, v => setPref('starredOnly', v)),
      toggle('완료 숨기기', !!state.prefs.hideDone, v => setPref('hideDone', v)))) : null;
  return h('div', { class: 'flt-bar' }, h('div', { class: 'flt-row' }, btn, clear), pop);
}
document.addEventListener('pointerdown', e => {
  if (fltOpen && !e.target.closest('.flt-bar')) { fltOpen = false; renderRail(); }
}, true);
document.addEventListener('keydown', e => {
  if (fltOpen && e.key === 'Escape') { fltOpen = false; renderRail(); $('.flt-btn')?.focus(); }
});

/* ───── 본문 ───── */
const ctx = () => ({
  now: new Date(),
  total: scopedTasks().length,
  showDone: ui.showDone,
  calMonth: ui.calMonth,
  selectedDay: ui.selectedDay,
  onToggle: id => {
    const t = state.tasks.find(x => x.id === id);
    toggleDone(id);
    if (t && t.done) toast(`"${t.title}" ${isExam(t) ? '응시 완료로 표시했어요' : '완료했어요'}`, '되돌리기', () => toggleDone(id));
  },
  onStar: id => toggleStar(id),
  onOpen: t => openPanel(t),
  onNew: (d, kind) => openPanel(null, d, kind || 'assignment'),
  onToggleDoneGroup: () => { ui.showDone = !ui.showDone; renderView(); },
  onMonth: dir => {
    if (dir === 0) { const n = new Date(); ui.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); ui.selectedDay = startOfDay(n); }
    else ui.calMonth = new Date(ui.calMonth.getFullYear(), ui.calMonth.getMonth() + dir, 1);
    renderView();
  },
  onSelectDay: d => {
    ui.selectedDay = d;
    if (d.getMonth() !== ui.calMonth.getMonth()) ui.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderView();
  },
  onShowSubject: name => { setPref('subject', name); setView('list'); },
});

let studyShown = false;
const isStudying = () => state.prefs.mode === 'study' && !isCompact;
const studyTab = () => (state.prefs.studyView === 'records' ? 'records' : 'today');
// 지금 화면에 맞는 주소 해시: #list #calendar #study #records
const curHash = () => (isStudying() ? (studyTab() === 'records' ? 'records' : 'study') : state.prefs.view);

function renderView() {
  const view = state.prefs.view;
  // 왼쪽 위 버튼: 일정 ↔ 공부. 탭도 모드에 따라 목록·캘린더 / 오늘·기록
  const studying = isStudying();
  document.body.classList.toggle('study-mode', studying);
  if (studying) document.body.classList.remove('search-open');
  $('#modeLabel').textContent = studying ? '공부' : '일정';
  $('#modeBtn').dataset.mode = studying ? 'study' : 'plan';
  $$('#modeBtn .ms-opt').forEach(o => {
    const on = o.dataset.m === (studying ? 'study' : 'plan');
    o.classList.toggle('on', on);
    o.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $('#planViews').hidden = studying;
  $('#studyViews').hidden = !studying;
  $('#btnFriends').hidden = !studying;
  $$('#planViews button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === view ? 'true' : 'false'));
  $$('#studyViews button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === studyTab() ? 'true' : 'false'));
  $('#viewStudy').hidden = !studying;
  renderTimerChip();
  if (studying) {
    if (!studyShown) { studyShown = true; onShowStudy(); } else renderStudy();
    return;
  }
  studyShown = false;
  const root = $('#view');
  const tasks = visibleTasks();
  if (isCompact) renderCompact(root, tasks);
  else if (view === 'calendar') renderCalendar(root, tasks, ctx());
  else renderList(root, tasks, ctx());
}

/* ───── 노션 임베드용 간단 모드 (?compact) ───── */
// 다가오는 일정 몇 개만 크게. 나머지는 "전체 보기"로 새 창에서.
const isCompact = new URLSearchParams(location.search).has('compact');
if (isCompact) document.body.classList.add('compact');
const COMPACT_LIMIT = 6;
function renderCompact(root, tasks) {
  const now = new Date();
  const open = tasks.filter(t => groupOf(t, now) !== 'done').sort((a, b) => new Date(a.due) - new Date(b.due));
  const full = `${location.origin}${location.pathname}#list`;
  fill(root,
    open.length
      ? h('ul', { class: 'rows compact-rows' }, open.slice(0, COMPACT_LIMIT).map(t => taskRow(t, ctx())))
      : h('p', { class: 'compact-empty' }, '남은 일정이 없어요.'),
    h('p', { class: 'compact-more' },
      open.length > COMPACT_LIMIT ? `외 ${open.length - COMPACT_LIMIT}개 · ` : '',
      h('a', { href: full, target: '_blank', rel: 'noopener' }, '전체 보기')));
}

// 일정 화면에서 타이머가 돌고 있으면 상단에 작게
function renderTimerChip() {
  const chip = $('#timerChip');
  const t = timerSummary();
  const show = !!t && !isStudying() && !isCompact;
  chip.hidden = !show;
  if (!show) return;
  chip.className = `timer-chip${t.rest ? ' rest' : ''}${t.paused ? ' paused' : ''}`;
  // 일정 화면에서는 시간만 (무슨 공부인지는 공부 화면에서)
  chip.replaceChildren(h('i'), h('span', { class: 'tc-time' }, t.text));
  chip.title = t.rest ? '쉬는 시간 · 공부 화면으로' : t.paused ? '멈춤 · 공부 화면으로' : '공부 중 · 공부 화면으로';
}
function onTimer() {
  renderTimerChip();
  const t = timerSummary();
  document.title = t && !t.paused ? `${t.text} ${t.rest ? '휴식' : '집중'} · S-DAY` : 'S-DAY';
}

// v: list | calendar (일정) · study | today | records (공부)
function setView(v) {
  const p = state.prefs;
  if (v === 'study' || v === 'today') { p.mode = 'study'; p.studyView = 'today'; }
  else if (v === 'records') { p.mode = 'study'; p.studyView = 'records'; }
  else { p.mode = 'plan'; p.view = ['list', 'calendar'].includes(v) ? v : 'list'; }
  setPref('studyView', p.studyView || 'today');      // 저장하고 다시 그리기
  const hash = `#${curHash()}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}
function toggleMode() {
  setView(state.prefs.mode === 'study' ? state.prefs.view : studyTab());
}

/* ───── 상태 표시 ───── */
let notice = null, noticeTimer = null;
function renderStatus() {
  const el = $('#status');
  el.className = 'status';
  if (state.inflight > 0) { el.classList.add('busy'); el.textContent = '저장하고 불러오는 중…'; }
  else if (state.syncError) { el.classList.add('err'); el.textContent = `${state.syncError} · 눌러서 다시 시도`; }
  else if (notice) { el.classList.add('ok'); el.textContent = notice; }
  else if (state.lastSync) { el.classList.add('ok'); el.textContent = `저장됨 · ${fmtClock(state.lastSync)}`; }
  else el.textContent = '불러오는 중…';
}

let tokenEditing = false;
function renderLms() {
  const l = state.lms;
  const feed = l.feed ?? (l.connected && !l.token), token = !!l.token;
  $('#btnLmsNow').hidden = !l.connected;
  $('#btnFeedClear').hidden = !feed;
  $('#btnFeedSave').textContent = feed ? '바꾸기' : '연동';
  $('#btnTokenClear').hidden = !token;
  $('#btnTokenChange').hidden = !token || tokenEditing;
  $('#tokenForm').hidden = token && !tokenEditing;
  $('#tokenHelp').hidden = token && !tokenEditing;
  $('#btnTokenSave').textContent = token ? '바꾸기' : '연결';
  $('#tokenSub').textContent = token ? `…${l.tokenHint} 연결됨` : '과제와 제출 파일을 하루 3번 가져와요';
  $('#bookmarkletSection').hidden = token;          // 토큰이 있으면 북마클릿은 필요 없음
  $('#lmsNavDot').hidden = !l.error;
  const st = $('#lmsState');
  st.className = 'set-sub';
  if (!l.connected) st.textContent = '연결 안 됨';
  else if (l.error) { st.classList.add('err'); st.textContent = errText(new Error(l.error)); }
  else {
    st.classList.add('ok');
    const how = token ? '토큰' : '캘린더 피드';
    st.textContent = l.syncedAt ? `${how} · ${fmtAgo(new Date(l.syncedAt))} 가져옴` : `${how} · 아직 가져오기 전`;
  }
}

function fmtAgo(d) {
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간 전`;
  return fmtDate(d, false);
}

/* ───── 스마트캠퍼스 공지 ───── */
const notices = { list: [] };
async function loadNotices() {
  if (!state.code || !state.lms.token) { notices.list = []; renderNoticeBtn(); return; }
  try { notices.list = (await api.notices(state.code)) || []; } catch { /* 다음에 다시 */ }
  renderNoticeBtn();
}
function renderNoticeBtn() {
  const unread = notices.list.filter(n => !n.read).length;
  $('#btnNotices').hidden = !state.lms.token && !notices.list.length;
  $('#noticeDot').hidden = !unread;
  $('#btnNotices').title = unread ? `새 공지 ${unread}개` : '스마트캠퍼스 공지';
}
function openNotices() {
  const list = $('#noticeList');
  fill(list, notices.list.length ? notices.list.map(n => h('li', { class: n.read ? 'notice' : 'notice unread', style: { '--c': subjectColor(n.subject) } },
    h('div', { class: 'notice-meta' }, n.subject ? h('span', null, n.subject) : null, h('span', null, fmtAgo(new Date(n.postedAt)))),
    n.url ? h('a', { class: 'notice-title', href: n.url, target: '_blank', rel: 'noopener noreferrer' }, n.title) : h('b', { class: 'notice-title' }, n.title),
    n.preview ? h('p', { class: 'notice-preview' }, n.preview) : null,
  )) : h('li', { class: 'notice-empty' }, '최근 30일 공지가 없어요.'));
  $('#noticesDialog').showModal();
  if (notices.list.some(n => !n.read)) {
    api.noticesRead(state.code).catch(() => {});
    notices.list = notices.list.map(n => ({ ...n, read: true }));
    renderNoticeBtn();
  }
}

/* ───── 내 캘린더로 보내기 ───── */
let calExists = false, calArmed = false;
async function loadCalendar() {
  $('#calBox').hidden = true; $('#calMsg').textContent = ''; calArmed = false;
  try { calExists = !!(await api.calendarStatus(state.code)); } catch { calExists = false; }
  $('#calSub').textContent = calExists ? '만든 주소가 있어요. 주소를 잃어버렸다면 새로 만드세요' : '구글 · 아이폰 캘린더에 과제와 시험이 함께 떠요';
  $('#btnCalKey').textContent = calExists ? '새로 만들기' : '주소 만들기';
}
async function makeCalendarKey() {
  const btn = $('#btnCalKey'), msg = $('#calMsg');
  if (calExists && !calArmed) {
    calArmed = true; btn.textContent = '한 번 더 누르면 이전 주소는 막혀요'; return;
  }
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '';
  try {
    const key = await api.calendarKey(state.code);
    const url = `${CALENDAR_FEED_URL}?k=${key}`;
    const webcal = url.replace(/^https:/, 'webcal:');
    $('#calUrl').value = url;
    $('#calGoogle').href = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;
    $('#calApple').href = webcal;
    $('#calBox').hidden = false;
    calExists = true; calArmed = false;
    btn.textContent = '새로 만들기';
    $('#calSub').textContent = '구독하면 몇 시간마다 저절로 새로 고쳐져요';
  } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  finally { btn.disabled = false; }
}

/* ───── 마감 알림 ───── */
const push = { subscribed: false, leads: DEFAULT_LEADS.slice(), busy: false };

function renderPush() {
  const support = pushSupport();
  const st = $('#pushState');
  const on = support === 'ok' && push.subscribed;
  st.className = 'set-sub';
  $('#pushOpen').hidden = support !== 'embedded';
  $('#btnPushOn').hidden = support !== 'ok' || on;
  $('#btnPushOff').hidden = !on;
  $('#btnPushTest').hidden = !on;
  $('#btnPushOn').disabled = $('#btnPushOff').disabled = $('#btnPushTest').disabled = push.busy;
  if (support === 'embedded') st.textContent = '노션 안에서는 켤 수 없어요';
  else if (support === 'ios-install') st.textContent = '아이폰은 홈 화면에 추가한 앱에서 켤 수 있어요';
  else if (support === 'unsupported') st.textContent = '이 브라우저는 알림을 지원하지 않아요';
  else if (support === 'denied') { st.classList.add('err'); st.textContent = '브라우저에서 이 사이트 알림이 차단돼 있어요'; }
  else if (on) { st.classList.add('ok'); st.textContent = `켜짐 · ${leadText(push.leads)}`; }
  else st.textContent = '꺼짐';
  $('#pushLeadsRow').hidden = support !== 'ok';
  $('#pushTestRow').hidden = !on && !$('#pushMsg').textContent;
  fill($('#pushLeads'),
    ...LEAD_OPTIONS.map(([min, label]) => h('button', {
      type: 'button', 'aria-pressed': push.leads.includes(min) ? 'true' : 'false',
      disabled: push.busy, onclick: () => toggleLead(min),
    }, label)));
}

function leadText(leads) {
  const names = LEAD_OPTIONS.filter(([m]) => leads.includes(m)).map(([, l]) => l.replace(' 전', ''));
  return names.length ? `${names.join(', ')} 전` : '알림 시점을 골라 주세요';
}

async function pushTask(label, fn, okText) {
  const msg = $('#pushMsg');
  push.busy = true; msg.className = 'msg'; msg.textContent = label; renderPush();
  try { await fn(); msg.className = 'msg ok'; msg.textContent = okText || ''; }
  catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  finally { push.busy = false; renderPush(); }
}

async function loadPush() {
  if (!state.code || pushSupport() !== 'ok') { renderPush(); return; }
  try {
    const st = await pushStatus(state.code);
    push.subscribed = !!st.subscribed;
    if (st.subscribed && Array.isArray(st.leads)) push.leads = st.leads;
  } catch { /* 다음에 다시 */ }
  renderPush();
}

function toggleLead(min) {
  const next = push.leads.includes(min) ? push.leads.filter(m => m !== min) : [...push.leads, min];
  if (!next.length) { const m = $('#pushMsg'); m.className = 'msg err'; m.textContent = '알림 시점을 하나 이상 골라 주세요'; return; }
  push.leads = next.sort((a, b) => b - a);
  if (!push.subscribed) { renderPush(); return; }
  pushTask('저장하는 중…', async () => {
    const r = await setLeads(state.code, push.leads);
    if (r && Array.isArray(r.leads)) push.leads = r.leads;
  }, '알림 시점을 바꿨어요');
}

/* ───── 토스트 ───── */
let toastTimer = null;
function toast(text, action, onAction, ms = 5000) {
  const el = $('#toast');
  el.replaceChildren(h('span', null, text));
  if (action) el.append(h('button', { type: 'button', onclick: () => { onAction(); hideToast(); } }, action));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('#toast').hidden = true; }

/* ───── 과제 상세 패널 ───── */
// 과목: 색 점 목록에서 고르거나 새로 추가
const subjPick = subjectPicker({
  id: 'fSubject', className: 'field-pick',
  options: () => taskSubjects(),
});
$('#fSubjectSlot').replaceWith(subjPick.el);
let lastFocus = null;

const EXAM_NAMES = ['중간고사', '기말고사', '퀴즈', '실기시험'];

// 시험: 시작 시각을 바꾸면 끝나는 시각을 같은 길이만큼 따라 옮긴다 (직접 고친 뒤에는 그대로)
const addMinutes = (hhmm, min) => {
  const [h0, m0] = hhmm.split(':').map(Number);
  const t = Math.min(23 * 60 + 59, h0 * 60 + m0 + min);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const minutesBetween = (a, b) => {
  const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number);
  return bh * 60 + bm - (ah * 60 + am);
};
function autoEnd(min) {
  ui.settingEnd = true;
  setField('fEnd', addMinutes($('#fTime').value || '10:30', min));
  ui.settingEnd = false;
  ui.endAuto = true;
  ui.examLength = min;
}
function renderDurations() {
  const start = $('#fTime').value || '10:30';
  const cur = $('#fEnd').value ? minutesBetween(start, $('#fEnd').value) : null;
  const opts = [[50, '50분'], [60, '1시간'], [75, '1시간 15분'], [90, '1시간 30분'], [120, '2시간']];
  $('#durations').replaceChildren(
    ...opts.map(([min, label]) => h('button', {
      type: 'button', 'aria-pressed': cur === min ? 'true' : 'false',
      onclick: () => { autoEnd(min); renderDurations(); },
    }, label)));
}

// 과제 / 시험 템플릿 전환
function setKind(kind, { isNew }) {
  ui.kind = kind;
  const exam = kind === 'exam';
  $('#panel').classList.toggle('is-exam', exam);
  $$('#kindPicker button').forEach(b => b.setAttribute('aria-checked', b.dataset.kind === kind ? 'true' : 'false'));
  const name = exam ? '시험' : kind === 'todo' ? '할 일' : '과제';
  $('#panelTitle').textContent = isNew ? `새 ${name}` : `${name} 수정`;
  $('#fTitle').placeholder = exam ? '시험 이름' : kind === 'todo' ? '할 일 (예: 3주차 강의 듣기)' : '과제 이름';
  $('#fMemo').placeholder = exam ? '시험 범위, 준비물' : '메모';
  renderDoneBtn();
  // 새로 만들 때 시각 기본값만 템플릿에 맞춤 (사용자가 바꾼 값은 유지)
  setTimePresets('fTime', exam ? ['09:00', '10:30', '12:00', '13:30', '15:00', '16:30'] : ['09:00', '12:00', '18:00', '23:59']);
  if (isNew) {
    const t = $('#fTime').value;
    if (exam && (t === '23:59' || !t)) setField('fTime', '10:30');
    if (!exam && t === '10:30') setField('fTime', '23:59');
  }
  if (exam && !$('#fEnd').value) autoEnd(60);
  renderDurations();
}

function openPanel(task, presetDay, kind) {
  lastFocus = document.activeElement;
  ui.editingId = task ? task.id : null;
  $('#panelSave').textContent = task ? '저장' : '추가';
  $('#panelDelete').hidden = !task;
  $('#panelMsg').textContent = '';
  $('#fTitle').value = task ? task.title : '';
  subjPick.set(task ? task.subject || '' : (state.prefs.subject || ''));
  const due = task ? new Date(task.due) : (presetDay ? new Date(presetDay) : addDays(startOfDay(new Date()), 7));
  $('#fDate').value = toDateInput(due);
  $('#fTime').value = task ? toTimeInput(due) : '23:59';
  ui.endAuto = !(task && task.endAt);
  $('#fStar').checked = !!(task && task.starred);
  $('#fDone').checked = !!(task && task.done);
  $('#fRepeat').value = '0';
  $('#repeatRow').hidden = !!task;
  renderStarBtn();
  $('#fMemo').value = task ? task.memo || '' : '';
  $('#fLocation').value = task ? task.location || '' : '';
  $('#fEnd').value = task && task.endAt ? toTimeInput(new Date(task.endAt)) : '';
  refreshPickLabels();
  setKind(task ? (isExam(task) ? 'exam' : task.kind === 'todo' ? 'todo' : 'assignment') : (kind || 'assignment'), { isNew: !task });
  $('#kindPicker').hidden = !!(task && task.source === 'canvas');   // 스마트캠퍼스 과제는 종류 고정
  $('#fStudyBtn').hidden = !task || !!task.done || groupOf(task) === 'done';
  $('#examNames').replaceChildren(...EXAM_NAMES.map(n => h('button', {
    type: 'button', onclick: () => { $('#fTitle').value = n; $('#fTitle').focus(); },
  }, n)));

  const note = $('#panelNote');
  if (task && task.source === 'canvas') {
    note.hidden = false;
    fill(note, task.kind === 'todo' ? '스마트캠퍼스 강의' : '스마트캠퍼스 과제',
      task.link ? h('a', { href: task.link, target: '_blank', rel: 'noopener noreferrer' }, '열기') : null);
  } else note.hidden = true;

  // 스마트캠퍼스에 제출한 기록
  const sub = $('#panelSubmission');
  if (task && (task.submittedAt || task.submission)) {
    const files = task.submission?.files || [];
    sub.hidden = false;
    fill(sub, 
      h('p', { class: 'sub-head' }, task.submittedAt ? `${fmtDate(new Date(task.submittedAt))} 제출` : '제출함'),
      files.length ? h('ul', null, files.map(f => h('li', null,
        h('span', { class: 'fname' }, f.name), f.size != null ? h('span', { class: 'fsize' }, fmtSize(f.size)) : null))) : null,
      task.submission?.url ? h('p', null, '제출한 링크: ', h('a', { href: task.submission.url, target: '_blank', rel: 'noopener noreferrer' }, task.submission.url)) : null,
      !files.length && task.submission?.type === 'online_text_entry' ? h('p', { class: 'muted' }, '글로 직접 입력해 제출했어요') : null,
    );
  } else sub.hidden = true;

  const meta = [];
  if (task && task.createdAt) meta.push(`만든 날 ${fmtDate(new Date(task.createdAt), false)}`);
  if (task && task.done && task.doneAt) meta.push(`완료한 날 ${fmtDate(new Date(task.doneAt), false)}`);
  $('#panelMeta').textContent = meta.join(' · ');

  $('#scrim').hidden = false;
  $('#panel').hidden = false;
  if (task) $('#panel').focus(); else $('#fTitle').focus();
}

function closePanel() {
  closePicker(false);
  $('#panel').hidden = true;
  $('#scrim').hidden = true;
  ui.editingId = null;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function renderStarBtn() {
  const on = $('#fStar').checked;
  $('#fStarBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#fStarBtn').title = on ? '중요 표시 해제' : '중요 표시';
}

// 과제만: 제출 완료 / 완료 취소 (시험은 시간이 지나면 저절로 끝난 일정으로)
function renderDoneBtn() {
  const btn = $('#fDoneBtn');
  const show = !!ui.editingId && ui.kind !== 'exam';
  btn.hidden = !show;
  if (!show) return;
  const done = $('#fDone').checked;
  btn.classList.toggle('is-done', done);
  const t = state.tasks.find(x => x.id === ui.editingId);
  btn.textContent = done ? '완료 취소' : ((t && t.missing) || ui.kind === 'todo' ? '완료로 표시' : '제출 완료');
}

function savePanel() {
  const title = $('#fTitle').value.trim();
  const msg = $('#panelMsg');
  msg.className = 'msg err';
  if (!title) { msg.textContent = ui.kind === 'exam' ? '시험 이름을 적어 주세요' : ui.kind === 'todo' ? '할 일을 적어 주세요' : '과제명을 적어 주세요'; $('#fTitle').focus(); return; }
  if (!$('#fDate').value) { msg.textContent = '날짜를 골라 주세요'; $('#fDateBtn').focus(); return; }
  const due = new Date(`${$('#fDate').value}T${$('#fTime').value || '23:59'}`);
  if (isNaN(due)) { msg.textContent = '마감 날짜를 다시 확인해 주세요'; return; }
  const isNew = !ui.editingId;
  const exam = ui.kind === 'exam';
  let endAt = null;
  if (exam && $('#fEnd').value) {
    const end = new Date(`${$('#fDate').value}T${$('#fEnd').value}`);
    if (end <= due) { msg.textContent = '끝나는 시각이 시작보다 빨라요'; $('#fEndBtn').focus(); return; }
    endAt = end.toISOString();
  }
  const fields = {
    kind: exam ? 'exam' : ui.kind === 'todo' ? 'todo' : 'assignment',
    title: title.slice(0, 200),
    subject: subjPick.value.slice(0, 40),
    due: due.toISOString(),
    endAt,
    location: exam ? $('#fLocation').value.trim().slice(0, 100) : '',
    starred: $('#fStar').checked,
    memo: $('#fMemo').value.slice(0, 2000),
  };
  if (!isNew) {
    const prev = state.tasks.find(t => t.id === ui.editingId);
    fields.done = $('#fDone').checked;
    if (prev && fields.done !== !!prev.done) fields.doneAt = fields.done ? new Date().toISOString() : null;
  }
  saveTask(fields, ui.editingId);
  rememberSubject(fields.subject);
  // 매주 반복: 같은 요일 · 같은 시각으로 이어서 만든다
  let repeats = 0;
  if (isNew) {
    const r = $('#fRepeat').value;
    // '학기 끝까지': 지금 보는 묶음(없으면 마감이 든 학기)의 끝 날까지
    const g = groupById(activeGroupId() || currentGroupId());
    const until = r === 'end' ? (g && g.end ? new Date(`${g.end}T23:59:59`) : semesterRange(semesterOf(due)).end) : null;
    const count = r === 'end' ? 30 : Number(r) || 0;
    for (let i = 1; i < count; i++) {
      const d = new Date(due.getTime() + 7 * i * DAY);   // 시각 그대로 7일씩 (한국은 서머타임 없음)
      if (until && d > until) break;
      saveTask({ ...fields, due: d.toISOString(), endAt: endAt ? new Date(new Date(endAt).getTime() + 7 * i * DAY).toISOString() : null });
      repeats++;
    }
  }
  closePanel();
  if (isNew) toast(repeats ? `"${title}" ${exam ? '시험을' : '과제를'} 매주 ${repeats + 1}번 추가했어요` : `"${title}" ${exam ? '시험을' : '과제를'} 추가했어요`);
}

function deleteFromPanel() {
  const id = ui.editingId;
  const t = removeTask(id);
  closePanel();
  if (t) toast(`"${t.title}" ${isExam(t) ? '시험을' : '과제를'} 삭제했어요`, '되돌리기', () => undoRemove(id));
}

/* ───── 설정 ───── */
let codeShown = false;
const mask = c => `${c.slice(0, 5)}-•••••-•••••-${c.slice(-5)}`;

// 설정은 탭으로 나눠 한 번에 한 묶음만
function setSettingsTab(tab) {
  if (!['lms', 'push', 'cal', 'colors', 'device'].includes(tab)) tab = 'lms';
  if (tab === 'colors') renderColors();
  $$('#setNav button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'));
  $$('#settings .set-group').forEach(g => { g.hidden = g.dataset.tab !== tab; });
  $('#settings .settings-body').scrollTop = 0;
}
function openSettings(tab = 'lms') {
  colorScope = undefined; groupEdit = null; colorOpen = null;
  setSettingsTab(typeof tab === 'string' ? tab : 'lms');
  codeShown = false;
  $('#codeText').value = mask(state.code);
  $('#btnShowCode').textContent = '보기';
  ['#feedMsg', '#tokenMsg', '#lmsMsg', '#importMsg', '#copyMsg'].forEach(s => { $(s).textContent = ''; });
  $('#pushMsg').textContent = ''; tokenEditing = false;
  renderLms(); renderPush(); applyTheme(); prepareCanvasSettings();
  $('#settings').showModal();
  loadLms(); loadPush(); loadCalendar();
}

async function copyText(text, input, msgEl) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* 노션 안에서는 막힐 수 있음 */ }
  if (!ok) {
    input.value = text; input.focus(); input.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  msgEl.className = ok ? 'msg ok' : 'msg';
  msgEl.textContent = ok ? '복사했어요' : '선택해 뒀어요. Ctrl+C(⌘+C)로 복사하세요';
}

function armTwice(btn, label, confirmLabel, action) {
  let armed = null;
  btn.addEventListener('click', () => {
    if (armed) { clearTimeout(armed); armed = null; btn.textContent = label; action(); return; }
    btn.textContent = confirmLabel;
    armed = setTimeout(() => { armed = null; btn.textContent = label; }, 3000);
  });
}

async function runLmsSync(button, { quiet = false } = {}) {
  if (button) { button.disabled = true; button.classList.add('spinning'); }
  try {
    const r = await lmsSync();
    const parts = [];
    if (r.added) parts.push(`새 과제 ${r.added}개`);
    if (r.updated) parts.push(`바뀐 과제 ${r.updated}개`);
    if (parts.length) toast(`스마트캠퍼스에서 ${parts.join(', ')}를 가져왔어요`);
    else if (!quiet) toast('스마트캠퍼스에 새로운 과제가 없어요');
    else toast('최신 상태예요');
  } catch (e) {
    toast(errText(e));
  } finally {
    if (button) { button.disabled = false; button.classList.remove('spinning'); }
  }
}

/* ───── 스마트캠퍼스 전체 가져오기 ───── */
let pendingImport = null;   // 보드 연결 전에 받은 데이터

function prepareCanvasSettings() {
  $('#bookmarklet').href = bookmarkletSource(location.href.split('#')[0]);
  const r = semesterRange(semesterOf(new Date()));
  const d = x => toDateInput(x);
  $('#plannerUrl').textContent =
    `https://canvas.ssu.ac.kr/api/v1/planner/items?start_date=${d(r.start)}&end_date=${d(r.end)}&per_page=100`;
}

function showImport(items) {
  if (!state.code) {
    pendingImport = items;
    const m = $('#connectMsg'); m.className = 'msg';
    m.textContent = `스마트캠퍼스 과제 ${items.length}개를 받았어요. 보드를 열면 바로 가져올게요.`;
    return;
  }
  pendingImport = items;
  const s = summarize(items, new Set(state.tasks.map(t => t.id)));
  const parts = [`과제 ${s.total}개를 찾았어요`];
  parts.push(s.fresh ? `새로 추가될 과제 ${s.fresh}개` : '모두 이미 있는 과제예요');
  if (s.submitted) parts.push(`제출한 과제 ${s.submitted}개는 완료로 표시해요`);
  if (s.files) parts.push(`제출 파일 ${s.files}개의 이름도 함께 저장해요`);
  $('#importSummary').textContent = parts.join('. ') + '.';
  const now = new Date();
  $('#importPreview').replaceChildren(...items.slice().sort((a, b) => new Date(b.due) - new Date(a.due)).slice(0, 12).map(it =>
    h('li', null,
      h('span', { class: 'ip-title' }, it.title),
      h('span', { class: 'ip-meta' },
        [it.subject, fmtDate(new Date(it.due), false),
         'submitted' in it ? (it.submitted ? '제출함' : (new Date(it.due) < now ? '안 냄' : '아직 안 냄')) : null,
         it.submission?.files?.length ? it.submission.files.map(f => f.name).join(', ') : null,
        ].filter(Boolean).join(' · ')))));
  if (items.length > 12) $('#importPreview').append(h('li', { class: 'ip-more' }, `외 ${items.length - 12}개`));
  $('#importDialogMsg').textContent = '';
  if (!$('#importDialog').open) $('#importDialog').showModal();
}

async function confirmImport() {
  const btn = $('#importConfirm'), msg = $('#importDialogMsg');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '가져오는 중…';
  try {
    const r = await canvasImport(pendingImport);
    pendingImport = null;
    $('#importDialog').close();
    const parts = [];
    if (r.added) parts.push(`새 과제 ${r.added}개`);
    if (r.updated) parts.push(`업데이트 ${r.updated}개`);
    toast(parts.length ? `스마트캠퍼스에서 ${parts.join(', ')}를 반영했어요` : '이미 모두 반영되어 있어요');
    if (location.hash === '#import') history.replaceState(null, '', `#${curHash()}`);
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = errText(e);
  } finally { btn.disabled = false; }
}

function handleCanvasPayload(data) {
  try {
    const items = parseCanvasData(data);
    if (!items.length) { toast('가져올 과제가 없어요. 수강 중인 과목이 있는지 확인해 주세요'); return; }
    showImport(items);
  } catch (e) {
    toast(errText(e));
  }
}

/* ───── 전체 그리기 ───── */
function showScreens() {
  $('#viewConnect').hidden = !!state.code;
  $('#viewApp').hidden = !state.code;
}

function renderAll() {
  showScreens();
  if (!state.code) return;
  setSubjects(state.tasks.map(t => t.subject));
  renderSemester(); renderNext(); renderRail(); renderView(); renderStatus(); renderLms();
}

subscribe(what => {
  if (what && what.type === 'disconnected') {
    const m = $('#connectMsg'); m.className = 'msg err'; m.textContent = what.reason; return;
  }
  if (what === 'status') { renderStatus(); return; }
  if (what === 'board' && state.code && pendingImport) setTimeout(() => showImport(pendingImport), 0);
  if (what === 'board' && state.code) loadColors();
  if (what === 'tasks' || what === 'board') ensureTerms();      // 새 학기 일정이 들어오면 그 학기 묶음을 만든다
  if (what === 'lms') { renderLms(); renderNext(); loadNotices(); return; }
  if (what === 'prefs') { applyTheme(); renderSemester(); renderNext(); renderRail(); renderView(); return; }
  renderAll();
});

// 묶음이 바뀌면 (다른 곳에서 고친 것 포함) 한 번만 다시 그림
let groupsRaf = 0;
onGroupsChange(err => {
  if (err) { toast(errText(err)); return; }
  if (groupsRaf) return;
  groupsRaf = requestAnimationFrame(() => { groupsRaf = 0; if (!state.code) return; renderAll(); if ($('#settings').open) renderColors(); });
});

/* ───── 이벤트 연결 ───── */
function bind() {
  // 연결 화면
  $('#btnCreate').addEventListener('click', async () => {
    const btn = $('#btnCreate'), msg = $('#createMsg');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = '보드를 만드는 중…';
    try {
      const code = await createBoard();
      msg.textContent = '';
      $('#newCodeText').value = code;
      $('#newCodeDialog').showModal();
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = errText(e);
    } finally { btn.disabled = false; }
  });
  const doConnect = async () => {
    const btn = $('#btnConnect'), msg = $('#connectMsg');
    btn.disabled = true; msg.className = 'msg'; msg.textContent = '보드를 여는 중…';
    try { await connect($('#inCode').value); msg.textContent = ''; $('#inCode').value = ''; }
    catch (e) {
      msg.className = 'msg err';
      msg.textContent = e.message === 'short_code' ? '보드 코드 20자를 모두 입력해 주세요' : errText(e);
    } finally { btn.disabled = false; }
  };
  $('#btnConnect').addEventListener('click', doConnect);
  $('#inCode').addEventListener('keydown', e => { if (e.key === 'Enter') doConnect(); });
  $('#btnCopyNew').addEventListener('click', () => copyText(state.code, $('#newCodeText'), $('#copyNewMsg')));
  $('#btnNewCodeOk').addEventListener('click', () => $('#newCodeDialog').close());

  // 상단
  $('#scopeBtn').addEventListener('click', () => { scopeOpen = !scopeOpen; renderSemester(); });
  document.addEventListener('pointerdown', e => {
    if (scopeOpen && !$('#scopeWrap').contains(e.target)) { scopeOpen = false; renderSemester(); }
  }, true);
  $('#scopeWrap').addEventListener('keydown', e => {
    if (e.key === 'Escape' && scopeOpen) { e.stopPropagation(); scopeOpen = false; renderSemester(); $('#scopeBtn').focus(); }
  });
  $$('.views button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $$('#modeBtn .ms-opt').forEach(o => o.addEventListener('click', () => { if ((o.dataset.m === 'study') !== (state.prefs.mode === 'study')) toggleMode(); }));
  $('#btnFriends').addEventListener('click', openFriends);
  $('#friendsClose').addEventListener('click', () => $('#friendsDialog').close());
  $('#search').addEventListener('input', e => { ui.query = e.target.value; renderView(); });
  // 검색은 평소엔 아이콘, 누르면 상단을 덮는 입력 칸
  $('#btnSearch').addEventListener('click', openSearch);
  $('#searchClose').addEventListener('click', closeSearch);
  $('#search').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } });
  $$('#setNav button').forEach(b => b.addEventListener('click', () => setSettingsTab(b.dataset.tab)));
  const presetDay = () => (state.prefs.view === 'calendar' ? ui.selectedDay : null);
  $('#btnNew').addEventListener('click', () => openPanel(null, presetDay(), 'assignment'));
  $$('#kindPicker button').forEach(b => b.addEventListener('click', () => setKind(b.dataset.kind, { isNew: !ui.editingId })));
  // 새로 불러오기: 다른 기기 변경 + (연동돼 있으면) 스마트캠퍼스까지
  $('#btnSync').addEventListener('click', e => {
    if (state.lms.connected) runLmsSync(e.currentTarget, { quiet: true });
    else { pull(); loadLms(); }
  });
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#status').addEventListener('click', () => { if (state.syncError) pull(); });

  // 패널
  $('#panelClose').addEventListener('click', closePanel);
  $('#btnNotices').addEventListener('click', openNotices);
  $('#noticesClose').addEventListener('click', () => $('#noticesDialog').close());
  $('#btnCalKey').addEventListener('click', makeCalendarKey);
  $('#btnCalCopy').addEventListener('click', () => copyText($('#calUrl').value, $('#calUrl'), $('#calMsg')));
  $('#fStarBtn').addEventListener('click', () => { $('#fStar').checked = !$('#fStar').checked; renderStarBtn(); });
  $('#fDoneBtn').addEventListener('click', () => {
    const done = !$('#fDone').checked;
    $('#fDone').checked = done;
    savePanel();
    toast(done ? '제출 완료로 표시했어요' : '완료를 취소했어요');
  });
  $('#scrim').addEventListener('click', closePanel);
  $('#fStudyBtn').addEventListener('click', () => {
    const t = state.tasks.find(x => x.id === ui.editingId);
    closePanel();
    if (!t) return;
    setView('study');
    startFor(t);
  });
  $('#timerChip').addEventListener('click', () => setView('study'));
  $('#panelSave').addEventListener('click', savePanel);
  $('#panelDelete').addEventListener('click', deleteFromPanel);
  ['#fTitle', '#fLocation'].forEach(s =>
    $(s).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); savePanel(); } }));

  // 설정
  $('#settingsClose').addEventListener('click', () => $('#settings').close());
  $('#colorScope').addEventListener('change', e => { colorScope = e.target.value; renderColors(); });
  $('#sdClose').addEventListener('click', () => $('#subjectDialog').close());
  $('#subjectDialog').addEventListener('close', () => { colorOpen = null; });
  $$('.info-btn').forEach(b => b.addEventListener('click', () => { const t = document.getElementById(b.getAttribute('aria-controls')); t.hidden = !t.hidden; b.setAttribute('aria-expanded', t.hidden ? 'false' : 'true'); }));
  $('#btnShowCode').addEventListener('click', () => {
    codeShown = !codeShown;
    $('#codeText').value = codeShown ? state.code : mask(state.code);
    $('#btnShowCode').textContent = codeShown ? '숨기기' : '보기';
  });
  $('#btnCopyCode').addEventListener('click', () => copyText(state.code, $('#codeText'), $('#copyMsg')));
  $$('#themePicker button').forEach(b => b.addEventListener('click', () => setPref('theme', b.dataset.theme)));

  $('#btnFeedSave').addEventListener('click', async () => {
    const url = $('#feedUrl').value.trim(), msg = $('#feedMsg');
    if (!url) { msg.className = 'msg err'; msg.textContent = '캘린더 피드 주소를 붙여 넣어 주세요'; return; }
    msg.className = 'msg'; msg.textContent = '연동하는 중…';
    try {
      await setFeed(url);
      $('#feedUrl').value = '';
      msg.textContent = '';
      await runLmsSync($('#btnFeedSave'));
    } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  });
  $('#btnLmsNow').addEventListener('click', e => runLmsSync(e.currentTarget));
  $('#btnTokenSave').addEventListener('click', async () => {
    const input = $('#tokenInput'), msg = $('#tokenMsg'), btn = $('#btnTokenSave');
    const token = input.value.trim();
    if (!token) { msg.className = 'msg err'; msg.textContent = '스마트캠퍼스에서 만든 토큰을 붙여 넣어 주세요'; return; }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = '연결하고 과제를 불러오는 중…';
    try {
      await setToken(token);
      input.value = ''; tokenEditing = false; renderLms();
      const r = await lmsSync();
      const parts = [];
      if (r.added) parts.push(`새 과제 ${r.added}개`);
      if (r.updated) parts.push(`바뀐 과제 ${r.updated}개`);
      msg.className = 'msg ok';
      msg.textContent = `연결했어요. 과제 ${r.total ?? 0}개를 확인했고${parts.length ? ` ${parts.join(', ')}를 반영했어요` : ' 바뀐 건 없어요'}.`;
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = errText(e);
    } finally { btn.disabled = false; }
  });
  $('#btnTokenChange').addEventListener('click', () => { tokenEditing = true; renderLms(); $('#tokenInput').focus(); });
  $('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) $('#btnTokenSave').click(); });
  armTwice($('#btnTokenClear'), '토큰 해제', '한 번 더 누르면 해제돼요', async () => {
    const msg = $('#tokenMsg');
    try { await setToken(null); msg.className = 'msg'; msg.textContent = '토큰을 지웠어요. 스마트캠퍼스 설정에서도 그 토큰을 삭제해 주세요.'; }
    catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  });
  armTwice($('#btnFeedClear'), '피드 해제', '한 번 더 누르면 해제돼요', async () => {
    try { await setFeed(null); $('#feedMsg').className = 'msg'; $('#feedMsg').textContent = '피드 연동을 해제했어요. 가져온 과제는 남아 있어요.'; }
    catch (e) { $('#feedMsg').className = 'msg err'; $('#feedMsg').textContent = errText(e); }
  });

  $('#btnImport').addEventListener('click', async () => {
    const msg = $('#importMsg');
    msg.className = 'msg'; msg.textContent = '가져오는 중…';
    try {
      const n = await importBackup($('#importText').value);
      msg.className = 'msg ok'; msg.textContent = `과제 ${n}개를 가져왔어요`;
      $('#importText').value = '';
    } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); }
  });
  $('#btnExport').addEventListener('click', () => copyText(exportBackup(), $('#importText'), $('#importMsg')));
  armTwice($('#btnDisconnect'), '이 기기 연결 해제', '한 번 더 누르면 해제돼요', () => {
    $('#settings').close();
    const code = state.code;
    disablePush(code).catch(() => {});   // 이 기기 알림도 함께 끔
    push.subscribed = false;
    disconnect();
  });

  // 마감 알림
  $('#btnPushOn').addEventListener('click', () => pushTask('알림을 켜는 중…', async () => {
    const r = await enablePush(state.code, push.leads);
    push.subscribed = true;
    if (r && Array.isArray(r.leads)) push.leads = r.leads;
  }, '알림을 켰어요. 테스트 알림으로 확인해 보세요'));
  $('#btnPushOff').addEventListener('click', () => pushTask('알림을 끄는 중…', async () => {
    await disablePush(state.code);
    push.subscribed = false;
  }, '이 기기 알림을 껐어요'));
  $('#btnPushTest').addEventListener('click', () => pushTask('보내는 중…', () => testPush(state.code), '보냈어요. 몇 초 안에 알림이 와요'));

  // 스마트캠퍼스 전체 가져오기
  $('#bookmarklet').addEventListener('click', e => {
    e.preventDefault();
    toast('이 버튼은 북마크바로 끌어다 놓은 뒤, 스마트캠퍼스 화면에서 눌러 주세요');
  });
  $('#canvasFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    const msg = $('#canvasFileMsg');
    e.target.value = '';
    if (!file) return;
    try {
      const items = parseCanvasData(await file.text());
      msg.className = 'msg'; msg.textContent = '';
      $('#settings').close();
      showImport(items);
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = '스마트캠퍼스에서 저장한 파일이 아니에요. 안내한 주소를 열어 저장했는지 확인해 주세요';
    }
  });
  $('#importCancel').addEventListener('click', () => { pendingImport = null; $('#importDialog').close(); });
  $('#importConfirm').addEventListener('click', confirmImport);
  let importWait = null;
  listenForCanvasData(data => { clearTimeout(importWait); handleCanvasPayload(data); }, st => {
    if (st.kind === 'progress') toast(`스마트캠퍼스: ${st.text}`, null, null, 20000);
    else {
      clearTimeout(importWait);
      toast(`스마트캠퍼스에서 읽지 못했어요 (${st.text}). 로그인한 스마트캠퍼스 화면에서 다시 눌러 주세요`, null, null, 12000);
    }
  });
  // 북마클릿으로 열린 창: 기다리는 동안 안내
  if (location.hash === '#import' && window.opener) {
    toast('스마트캠퍼스에서 과제를 불러오는 중이에요…', null, null, 30000);
    importWait = setTimeout(() => toast('스마트캠퍼스 창에서 아직 아무것도 받지 못했어요. 그 창에 오류 안내가 떴는지 확인해 주세요', null, null, 15000), 30000);
  }

  // 시간 선택 연동
  $('#fTime').addEventListener('change', () => {
    if (ui.kind === 'exam' && (ui.endAuto || !$('#fEnd').value)) autoEnd(ui.examLength || 60);
    renderDurations();
  });
  $('#fEnd').addEventListener('change', () => {
    if (!ui.settingEnd) ui.endAuto = false;
    renderDurations();
  });

  // 단축키
  document.addEventListener('keydown', e => {
    if (!state.code) return;
    if (e.key === 'Escape' && !$('#panel').hidden) { closePanel(); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#panel').hidden || $('#settings').open) return;
    if ($('#friendsDialog').open || $('#noticesDialog').open) return;
    if (isStudying() && studyKey(e)) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openPanel(null, null, 'assignment'); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); openPanel(null, null, 'exam'); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); openPanel(null, null, 'todo'); }
    else if (e.key === '/' && !isStudying()) { e.preventDefault(); openSearch(); }
    else if (e.key === 's' || e.key === 'S') toggleMode();
    else if (e.key === '1') setView(isStudying() ? 'today' : 'list');
    else if (e.key === '2') setView(isStudying() ? 'records' : 'calendar');
  });

  window.addEventListener('hashchange', () => { if (!openTaskFromHash()) setView(location.hash.slice(1)); });
  // 알림을 눌러 이미 열린 창으로 돌아올 때 (서비스 워커가 보냄)
  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data && e.data.type === 'open-task') { pendingTaskId = e.data.id; openTaskFromHash(); }
    if (e.data && e.data.type === 'open-view') setView(e.data.view);
  });
}

/* ───── 알림에서 과제 열기 (#task=<id>) ───── */
let pendingTaskId = null;
function openTaskFromHash() {
  // 알림에서 연 경우: 설정 · 공지
  if ((location.hash === '#settings' || location.hash === '#notices') && state.code) {
    const which = location.hash;
    history.replaceState(null, '', `#${curHash()}`);
    setTimeout(() => { if (which === '#settings') openSettings(); else loadNotices().then(openNotices); }, 0);
    return true;
  }
  // 앱 바로가기: 새 과제 / 새 시험
  if ((location.hash === '#new' || location.hash === '#new-exam') && state.code) {
    const kind = location.hash === '#new' ? 'assignment' : 'exam';
    history.replaceState(null, '', `#${curHash()}`);
    setTimeout(() => openPanel(null, null, kind), 0);
    return true;
  }
  const m = location.hash.match(/^#task=(.+)$/);
  if (m) pendingTaskId = decodeURIComponent(m[1]);
  if (!pendingTaskId) return !!m;
  const t = state.tasks.find(x => x.id === pendingTaskId);
  if (!t) return true;                      // 아직 불러오기 전이면 불러온 뒤 다시 시도
  pendingTaskId = null;
  history.replaceState(null, '', `#${curHash()}`);
  openPanel(t);
  return true;
}
subscribe(what => { if (pendingTaskId && (what === 'tasks' || what === 'board')) setTimeout(openTaskFromHash, 0); });

/* ───── 앱으로 설치 ───── */
let installEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); installEvent = e;
  $('#installRow').hidden = false;
});
window.addEventListener('appinstalled', () => { installEvent = null; $('#installRow').hidden = true; });
$('#btnInstall').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null; $('#installRow').hidden = true;
});

/* ───── 시작 ───── */
bind();
initPickers();
applyTheme();
const hashView = location.hash.slice(1);
// 예전 버전은 공부를 view='study'로 저장했음
if (state.prefs.view === 'study') { state.prefs.view = 'list'; state.prefs.mode = 'study'; }
if (['list', 'calendar'].includes(hashView)) { state.prefs.view = hashView; state.prefs.mode = 'plan'; }
else if (hashView === 'study' || hashView === 'records') { state.prefs.mode = 'study'; state.prefs.studyView = hashView === 'records' ? 'records' : 'today'; }
initStudy({ toast, openTask: t => openPanel(t), onTimer });
renderAll();
if (state.code) { pull(); loadLms(); loadColors(); }
openTaskFromHash();

setInterval(() => {
  if (!state.code) return;
  if ($('#panel').hidden) pull();
  renderNext();                     // 남은 시간 갱신
}, SYNC_INTERVAL);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.code) { pull(); loadLms(); if (isStudying()) loadStudy(); }
});

// 홈 화면에 추가했을 때 오프라인에서도 열리도록
if ('serviceWorker' in navigator && !isEmbedded && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
