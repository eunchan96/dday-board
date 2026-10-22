// 공부할 때 틀어 두는 잔잔한 배경 소리
//
// 음원 파일 없이 브라우저(Web Audio)가 그 자리에서 만들어 낸다 → 저작권 걱정 없음, 내려받을 것도 없음
//  - 빗소리: 걸러 낸 잡음 + 가끔 떨어지는 빗방울
//  - 파도:   낮은 잡음이 천천히 밀려왔다 빠지는 소리
//  - 선율:   5음계 음을 띄엄띄엄 치는 피아노풍 소리 + 아주 작은 바탕음
// 고른 소리와 크기는 이 기기에만 기억한다 (자동으로 켜지지는 않음 — 브라우저가 누르기 전 소리를 막음)

import { h } from './util.js';
import { storage } from './store.js';

const KEY = 'ddayboard.ambient';
export const SOUNDS = [
  { key: 'rain', label: '빗소리' },
  { key: 'waves', label: '파도' },
  { key: 'melody', label: '잔잔한 선율' },
];

const pref = (() => {
  try { const v = JSON.parse(storage.get(KEY) || 'null'); if (v && typeof v === 'object') return v; } catch { /* 처음 */ }
  return {};
})();
const prefs = {
  sound: SOUNDS.some(s => s.key === pref.sound) ? pref.sound : 'rain',
  volume: typeof pref.volume === 'number' ? Math.min(1, Math.max(0, pref.volume)) : 0.5,
};
const savePrefs = () => { try { storage.set(KEY, JSON.stringify(prefs)); } catch { /* 저장 못 해도 소리는 남 */ } };

/* ───── 소리 만들기 ───── */
let ac = null, master = null, current = null;   // current = { key, stop() }

function noiseBuffer(kind, seconds = 4) {
  const len = Math.floor(ac.sampleRate * seconds);
  const buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else { // 핑크 잡음 (근사)
        b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
      }
    }
    // 이음매에서 딸깍 소리가 나지 않게 앞뒤를 살짝 겹친다
    const fade = Math.floor(ac.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) { const t = i / fade; d[i] *= t; d[len - 1 - i] *= t; }
  }
  return buf;
}

function loop(buf) {
  const src = ac.createBufferSource();
  src.buffer = buf; src.loop = true;
  return src;
}

function rain(out) {
  const nodes = [];
  const bed = loop(noiseBuffer('pink'));
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400;
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
  const g = ac.createGain(); g.gain.value = 0.9;
  bed.connect(hp).connect(lp).connect(g).connect(out);
  bed.start(); nodes.push(bed);

  // 빗방울: 짧게 튀는 높은 잡음
  const dropBuf = noiseBuffer('pink', 0.3);
  let alive = true;
  const drop = () => {
    if (!alive) return;
    const s = ac.createBufferSource(); s.buffer = dropBuf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2000 + Math.random() * 3500; bp.Q.value = 6;
    const pan = ac.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8;
    const dg = ac.createGain(); const t = ac.currentTime;
    dg.gain.setValueAtTime(0, t); dg.gain.linearRampToValueAtTime(0.25 + Math.random() * 0.35, t + 0.004);
    dg.gain.exponentialRampToValueAtTime(0.001, t + 0.06 + Math.random() * 0.08);
    s.connect(bp).connect(dg).connect(pan).connect(out);
    s.start(t); s.stop(t + 0.2);
    setTimeout(drop, 40 + Math.random() * 220);
  };
  drop();
  return () => { alive = false; nodes.forEach(n => n.stop()); };
}

function waves(out) {
  const src = loop(noiseBuffer('brown', 6));
  const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
  const g = ac.createGain(); g.gain.value = 0.55;
  // 9초쯤마다 밀려왔다 빠지는 물결: 크기와 밝기를 같이 흔든다
  const lfo = ac.createOscillator(); lfo.frequency.value = 0.11;
  const lfoGain = ac.createGain(); lfoGain.gain.value = 0.4;
  const lfoFreq = ac.createGain(); lfoFreq.gain.value = 450;
  lfo.connect(lfoGain).connect(g.gain);
  lfo.connect(lfoFreq).connect(lp.frequency);
  src.connect(lp).connect(g).connect(out);
  src.start(); lfo.start();
  return () => { src.stop(); lfo.stop(); };
}

function melody(out) {
  // 울림: 짧은 메아리 두 갈래 (좌우)
  const wet = ac.createGain(); wet.gain.value = 0.35;
  const dl = ac.createDelay(2); dl.delayTime.value = 0.43;
  const dr = ac.createDelay(2); dr.delayTime.value = 0.61;
  const fb = ac.createGain(); fb.gain.value = 0.42;
  const tone = ac.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 2400;
  const merge = ac.createChannelMerger(2);
  wet.connect(dl); wet.connect(dr);
  dl.connect(tone); dr.connect(tone);
  tone.connect(fb); fb.connect(dl); fb.connect(dr);
  dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
  merge.connect(out);

  // 바탕음: 아주 작게 깔리는 두 음
  const pad = ac.createGain(); pad.gain.value = 0.05;
  const padLp = ac.createBiquadFilter(); padLp.type = 'lowpass'; padLp.frequency.value = 600;
  const oscs = [130.81, 196.0].map(f => { const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = f; o.detune.value = Math.random() * 8 - 4; o.connect(padLp); o.start(); return o; });
  padLp.connect(pad).connect(out);

  // C 장조 5음계 (도 레 미 솔 라), 가운데 두 옥타브
  const scale = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
  let alive = true, prev = 3;
  const note = () => {
    if (!alive) return;
    // 가까운 음으로 걷듯이
    prev = Math.max(0, Math.min(scale.length - 1, prev + Math.round(Math.random() * 4 - 2)));
    const f = scale[prev];
    const t = ac.currentTime;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 3.2);
    const o1 = ac.createOscillator(); o1.type = 'sine'; o1.frequency.value = f;
    const o2 = ac.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2; const g2 = ac.createGain(); g2.gain.value = 0.18;
    o1.connect(g); o2.connect(g2).connect(g);
    g.connect(out); g.connect(wet);
    o1.start(t); o2.start(t); o1.stop(t + 3.4); o2.stop(t + 3.4);
    setTimeout(note, 1400 + Math.random() * 2600);
  };
  setTimeout(note, 300);
  return () => { alive = false; oscs.forEach(o => o.stop()); setTimeout(() => merge.disconnect(), 4000); };
}

const MAKERS = { rain, waves, melody };
const LEVEL = { rain: 0.35, waves: 0.5, melody: 0.6 };   // 소리마다 느껴지는 크기를 맞춘다

function ensureContext() {
  if (ac) return true;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ac = new AC();
  master = ac.createGain();
  master.gain.value = 0;
  master.connect(ac.destination);
  return true;
}

const target = () => prefs.volume * prefs.volume * (LEVEL[prefs.sound] ?? 0.5);   // 귀에 맞게 제곱

export function isPlaying() { return !!current; }

export function play(key = prefs.sound) {
  if (!ensureContext()) return false;
  ac.resume?.();
  if (current?.key === key) return true;
  const t = ac.currentTime;
  fadeOut(current);
  prefs.sound = key; savePrefs();
  // 소리마다 따로 통로를 두고 서서히 바꾼다 (끊기는 소리 없이)
  const bus = ac.createGain(); bus.connect(master);
  bus.gain.setValueAtTime(0, t); bus.gain.linearRampToValueAtTime(1, t + 1.5);
  current = { key, bus, stop: MAKERS[key](bus) };
  master.gain.cancelScheduledValues(t);
  master.gain.setTargetAtTime(target(), t, 0.05);
  notify();
  return true;
}

function fadeOut(c, sec = 0.8) {
  if (!c) return;
  const t = ac.currentTime;
  c.bus.gain.cancelScheduledValues(t);
  c.bus.gain.setValueAtTime(c.bus.gain.value, t);
  c.bus.gain.linearRampToValueAtTime(0, t + sec);
  setTimeout(() => { c.stop(); setTimeout(() => c.bus.disconnect(), 4000); }, sec * 1000 + 100);
}

export function stop() {
  if (!current || !ac) return;
  fadeOut(current);
  current = null;
  notify();
}

export function setVolume(v) {
  prefs.volume = Math.min(1, Math.max(0, v)); savePrefs();
  if (ac && current) master.gain.setTargetAtTime(target(), ac.currentTime, 0.1);
}

/* ───── 버튼 + 펼침 ───── */
const listeners = new Set();
const notify = () => listeners.forEach(f => f());

const SVGNS = 'http://www.w3.org/2000/svg';
function icon(paths) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
const ICON_ON = ['M3.5 8h3l4-3.5v11l-4-3.5h-3z', 'M13.5 7.2a4 4 0 0 1 0 5.6', 'M15.6 5a7 7 0 0 1 0 10'];
const ICON_OFF = ['M3.5 8h3l4-3.5v11l-4-3.5h-3z', 'M13.5 8l4 4M17.5 8l-4 4'];

// 타이머 칸 오른쪽 위에 들어가는 '배경 소리' 버튼
export function ambientControl() {
  const btn = h('button', { type: 'button', class: 'btn ghost amb-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false' });
  const list = h('div', { class: 'amb-list', role: 'radiogroup', 'aria-label': '배경 소리' });
  const vol = h('input', { type: 'range', min: 0, max: 100, step: 1, class: 'amb-vol', 'aria-label': '소리 크기', value: Math.round(prefs.volume * 100) });
  const off = h('button', { type: 'button', class: 'btn sm amb-off' }, '끄기');
  const pop = h('div', { class: 'amb-pop', hidden: true },
    list,
    h('label', { class: 'amb-vol-row' }, icon(ICON_ON), vol),
    h('p', { class: 'amb-note' }, '이 기기에서 바로 만들어 내는 소리라 저작권 걱정이 없어요.'),
    off);
  const wrap = h('div', { class: 'amb' }, btn, pop);

  const paint = () => {
    const on = isPlaying();
    btn.replaceChildren(icon(on ? ICON_ON : ICON_OFF), h('span', null, on ? SOUNDS.find(s => s.key === current.key).label : '배경 소리'));
    btn.classList.toggle('on', on);
    btn.title = on ? '배경 소리 바꾸기 · 끄기' : '잔잔한 배경 소리 켜기';
    list.replaceChildren(...SOUNDS.map(s => h('button', {
      type: 'button', role: 'radio', class: 'amb-opt', 'aria-checked': on && current.key === s.key ? 'true' : 'false',
      onclick: () => { play(s.key); },
    }, h('i', { class: 'amb-dot' }), s.label)));
    off.hidden = !on;
  };
  const open = v => {
    pop.hidden = !v; btn.setAttribute('aria-expanded', v ? 'true' : 'false');
    if (v) paint();
  };
  btn.addEventListener('click', () => open(pop.hidden));
  off.addEventListener('click', () => { stop(); open(false); btn.focus(); });
  vol.addEventListener('input', () => setVolume(Number(vol.value) / 100));
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !wrap.contains(e.target)) open(false); }, true);
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) { e.stopPropagation(); open(false); btn.focus(); } });
  listeners.add(paint);
  paint();
  return wrap;
}
