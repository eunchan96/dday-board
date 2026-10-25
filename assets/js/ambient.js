// 공부할 때 틀어 두는 잔잔한 배경 소리
//
// 음원 파일 없이 브라우저(Web Audio)가 그 자리에서 만들어 낸다.
//  - 빗소리: 걸러 낸 잡음 + 가끔 떨어지는 빗방울
//  - 파도:   낮은 잡음이 천천히 밀려왔다 빠지는 소리
//  - 선율:   부드러운 건반 화음(Cmaj7 · Am7 · Fmaj7 · G6)을 천천히 짚는 로파이풍 연주 + 낮은 베이스 + 울림
//
// 끊기지 않게: 60초짜리 소리를 미리 한 번에 만들어(OfflineAudioContext) 끝과 처음을 겹쳐 이음매 없이 만든 뒤
// 진짜 <audio> 요소로 반복 재생한다. 화면을 끄거나 다른 앱으로 가도(브라우저가 타이머를 늦춰도) 계속 나온다.
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

/* ───── 소리 만들기 (60초, 미리 한 번에) ───── */
const SR = 32000;            // 표본 빠르기 (빗방울 높은 소리까지 충분)
const LEN = 60;              // 반복 길이(초)
const TAIL = 4;              // 끝에서 처음으로 겹쳐 잇는 길이(초)

function noise(ctx, kind, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else { b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12; }
    }
  }
  return buf;
}
function source(ctx, buf) { const s = ctx.createBufferSource(); s.buffer = buf; return s; }

// 노드를 소리 하나마다 만들면 미리 만들기가 아주 느려져서(끝난 노드도 계속 계산됨),
// 빗방울 · 건반 음은 숫자 배열에 직접 그려 넣고 노드는 몇 개만 쓴다.
const TAU = Math.PI * 2;
function dryBuffer(ctx, dur) { return ctx.createBuffer(2, Math.floor(ctx.sampleRate * dur), ctx.sampleRate); }
// 공명 필터(대역 통과) 하나: 잡음을 넣으면 그 높이의 '톡' 소리
function bandpass(f, q, sr) {
  const w = TAU * f / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return { b0: al / a0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0 };
}

function rain(ctx, out, dur) {
  const bed = source(ctx, noise(ctx, 'pink', dur));
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
  const g = ctx.createGain(); g.gain.value = 0.9;
  bed.connect(hp).connect(lp).connect(g).connect(out);
  bed.start(0);
  // 빗방울: 짧게 튀는 높은 잡음을 배열에 직접
  const sr = ctx.sampleRate, drops = dryBuffer(ctx, dur);
  const L = drops.getChannelData(0), R = drops.getChannelData(1);
  for (let t = 0.05; t < dur - 0.3; t += 0.04 + Math.random() * 0.22) {
    const c = bandpass(2000 + Math.random() * 3500, 6, sr);
    const amp = (0.25 + Math.random() * 0.35) * 0.5, decay = 0.06 + Math.random() * 0.08;
    const pan = Math.random() * 1.6 - 0.8, gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    const start = Math.floor(t * sr), n = Math.floor((decay + 0.04) * sr);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.random() * 2 - 1;
      const y = c.b0 * x + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      const tt = i / sr, env = tt < 0.004 ? tt / 0.004 : Math.exp(-(tt - 0.004) * 6.9 / decay);
      const v = y * amp * env;
      L[start + i] += v * gl; R[start + i] += v * gr;
    }
  }
  const ds = source(ctx, drops); ds.connect(out); ds.start(0);
}

function waves(ctx, out, dur) {
  const src = source(ctx, noise(ctx, 'brown', dur));
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
  const g = ctx.createGain(); g.gain.value = 0.55;
  // 10초마다 밀려왔다 빠지는 물결 (60초에 딱 맞아 이음매가 없음): 크기와 밝기를 같이 흔든다
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.1;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.4;
  const lfoFreq = ctx.createGain(); lfoFreq.gain.value = 450;
  lfo.connect(lfoGain).connect(g.gain);
  lfo.connect(lfoFreq).connect(lp.frequency);
  src.connect(lp).connect(g).connect(out);
  src.start(0); lfo.start(0);
}

const hz = midi => 440 * Math.pow(2, (midi - 69) / 12);
function roomVerb(x, sr, spread, mix) {
  const k = sr / 44100;
  const combs = [1116, 1188, 1277, 1356].map(n => ({ buf: new Float32Array(Math.floor((n + spread) * k)), i: 0, last: 0 }));
  const alls = [556, 441].map(n => ({ buf: new Float32Array(Math.floor((n + spread) * k)), i: 0 }));
  const fb = 0.8, damp = 0.3;
  for (let n = 0; n < x.length; n++) {
    const inp = x[n] * 0.18;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.last = o * (1 - damp) + c.last * damp;
      c.buf[c.i] = inp + c.last * fb;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    for (const a of alls) {
      const o = a.buf[a.i];
      a.buf[a.i] = y + o * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      y = o - y;
    }
    x[n] += y * mix;
  }
}

function melody(ctx, out, dur) {
  const sr = ctx.sampleRate, dry = dryBuffer(ctx, dur);
  const L = dry.getChannelData(0), R = dry.getChannelData(1), N = L.length;
  const panGains = p => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];

  // 부드러운 건반: 같은 높이로 살짝 흔드는 FM (로즈 피아노 느낌), 울림이 길게 사라짐
  const key = (t, midi, vel, len = 2.6) => {
    const f = hz(midi), [gl, gr] = panGains((midi - 64) / 40);
    const s0 = Math.floor(t * sr), n = Math.min(Math.floor(len * sr), N - s0);
    let ph = 0, mph = 0;
    for (let i = 0; i < n; i++) {
      const tt = i / sr;
      const idx = 1.6 * Math.exp(-tt * 3.8) + 0.05;            // 처음엔 밝고 점점 둥글게
      mph += TAU * f / sr; ph += TAU * f / sr;
      const v = Math.sin(ph + idx * Math.sin(mph));
      const env = tt < 0.008 ? tt / 0.008 : (0.65 * Math.exp(-tt * 2.1) + 0.35 * Math.exp(-tt * 0.9)) * Math.max(0, 1 - tt / len);
      const x = v * vel * env;
      L[s0 + i] += x * gl; R[s0 + i] += x * gr;
    }
  };
  // 바탕 화음: 천천히 부풀었다 사라지는 부드러운 소리 (사인 두 개로 따뜻하게)
  const pad = (t, tones, len) => {
    const s0 = Math.floor(t * sr), n = Math.min(Math.floor((len + 0.6) * sr), N - s0);
    tones.forEach((m, k) => {
      const f = hz(m - 12) * (1 + (Math.random() - 0.5) * 0.002), [gl, gr] = panGains(k % 2 ? 0.35 : -0.35);
      let ph = Math.random() * TAU;
      for (let i = 0; i < n; i++) {
        const tt = i / sr;
        const env = tt < 1.4 ? tt / 1.4 : tt > len - 1.2 ? Math.max(0, 1 - (tt - (len - 1.2)) / 1.8) : 1;
        ph += TAU * f / sr;
        const x = (Math.sin(ph) + 0.18 * Math.sin(2 * ph)) * 0.018 * env;
        L[s0 + i] += x * gl; R[s0 + i] += x * gr;
      }
    });
  };
  const bass = (t, midi, len) => {
    const f = hz(midi), s0 = Math.floor(t * sr), n = Math.min(Math.floor(len * sr), N - s0);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const tt = i / sr, env = tt < 0.03 ? tt / 0.03 : Math.exp(-tt * 1.3);
      ph += TAU * f / sr;
      const x = Math.sin(ph) * 0.13 * env;
      L[s0 + i] += x; R[s0 + i] += x;
    }
  };

  // 한 마디 3.75초(64bpm), 두 마디씩 Cmaj7 → Am7 → Fmaj7 → G6 (16마디 = 60초)
  const BAR = 3.75, BEAT = BAR / 4;
  const CHORDS = [
    { root: 48, tones: [60, 64, 67, 71] },   // Cmaj7
    { root: 45, tones: [57, 60, 64, 67] },   // Am7
    { root: 41, tones: [57, 60, 64, 65] },   // Fmaj7
    { root: 43, tones: [55, 59, 62, 64] },   // G6
  ];
  const TOP = [72, 74, 76, 79, 81];            // 위쪽 5음계 (도 레 미 솔 라)
  // 끝에서 처음으로 겹쳐 잇기 위해 꼬리 부분은 처음 마디를 한 번 더 친다
  for (let bar = 0; bar * BAR < dur; bar++) {
    const t0 = bar * BAR;
    const ch = CHORDS[Math.floor(bar / 2) % 4];
    if (bar % 2 === 0) pad(t0, ch.tones, BAR * 2);
    bass(t0, ch.root, BAR);
    // 마디마다 조금씩 다른 잔잔한 분산화음 (약간 늦게 · 세기 다르게 쳐서 사람이 치는 느낌)
    const pattern = bar % 4 === 3 ? [0, 1.5, 2, 3] : [0, 1, 1.5, 2.5, 3];
    pattern.forEach((b, i) => {
      if (i > 0 && Math.random() < 0.15) return;
      const m = ch.tones[(i + bar) % ch.tones.length] + (i === pattern.length - 1 && Math.random() < 0.4 ? 12 : 0);
      key(t0 + b * BEAT + Math.random() * 0.03, m, 0.075 + Math.random() * 0.04);
    });
    // 두 마디에 한 번쯤 위에서 한 음씩 노래하듯
    if (bar % 2 === 1 || Math.random() < 0.3) {
      const m = TOP[Math.floor(Math.random() * TOP.length)];
      key(t0 + BEAT * (Math.random() < 0.5 ? 0.5 : 2.5), m, 0.06, 3.4);
    }
  }
  // 방 울림 (가벼운 프리버브: 빗 필터 4개 + 올패스 2개, 좌우 길이를 조금 다르게)
  roomVerb(L, sr, 0, 0.26); roomVerb(R, sr, 23, 0.26);
  // 따뜻하게 (높은 소리 살짝 깎기)
  const src = source(ctx, dry);
  const warm = ctx.createBiquadFilter(); warm.type = 'lowpass'; warm.frequency.value = 3800; warm.Q.value = 0.3;
  src.connect(warm); warm.connect(out);
  src.start(0);
}

const MAKERS = { rain, waves, melody };
const LEVEL = { rain: 0.35, waves: 0.5, melody: 0.75 };   // 소리마다 느껴지는 크기를 맞춘다

// 60초 + 겹칠 꼬리를 만들고, 꼬리를 처음에 겹쳐 이음매 없는 60초로
async function render(key) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(2, SR * (LEN + TAIL), SR);
  const out = ctx.createGain(); out.connect(ctx.destination);
  MAKERS[key](ctx, out, LEN + TAIL);
  const buf = await ctx.startRendering();
  const n = SR * LEN, x = SR * TAIL;
  const chans = [0, 1].map(c => {
    const d = buf.getChannelData(c);
    const o = new Float32Array(n);
    o.set(d.subarray(0, n));
    for (let i = 0; i < x; i++) { const k = i / x; o[i] = d[i] * k + d[n + i] * (1 - k); }
    return o;
  });
  return wav(chans, SR);
}
function wav(chans, rate) {
  const n = chans[0].length, bytes = n * 4;
  const buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, bytes, true);
  // 크기를 고르게 (가장 큰 소리 기준)
  let peak = 0.0001;
  for (const c of chans) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c[i]));
  const gain = 0.9 / peak;
  let o = 44;
  for (let i = 0; i < n; i++) for (const c of chans) { v.setInt16(o, Math.max(-1, Math.min(1, c[i] * gain)) * 32767, true); o += 2; }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
const cache = new Map();                         // key → Promise<blob url>
const loopUrl = key => { if (!cache.has(key)) cache.set(key, render(key).catch(e => { cache.delete(key); throw e; })); return cache.get(key); };

/* ───── 틀기 ───── */
// 아주 짧은 무음 (누른 순간 <audio>를 깨워 두면, 소리를 만든 뒤에 틀어도 브라우저가 막지 않음)
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
let audio = null, current = null, loading = null, fader = null, selfPause = false;
// 아이폰 · 아이패드는 <audio> 소리 크기를 바꿀 수 없음 (기기 소리 버튼으로)
export const volumeSupported = (() => { try { const a = new Audio(); a.volume = 0.5; return Math.abs(a.volume - 0.5) < 0.01; } catch { return false; } })();

function el() {
  if (audio) return audio;
  audio = new Audio();
  audio.loop = true; audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  // 잠금 화면 · 알림의 ❚❚나 전화 등으로 멈추면 끈 것으로 (우리가 멈춘 게 아니면)
  audio.addEventListener('pause', () => { if (!selfPause && current && !loading) { current = null; notify(); } });
  return audio;
}
const target = () => prefs.volume * prefs.volume * (LEVEL[prefs.sound] ?? 0.5);   // 귀에 맞게 제곱
function fadeTo(v, sec, done) {
  clearInterval(fader);
  const a = el(), from = a.volume, steps = Math.max(1, Math.round(sec * 20));
  let i = 0;
  fader = setInterval(() => {
    i++; a.volume = Math.max(0, Math.min(1, from + (v - from) * (i / steps)));
    if (i >= steps) { clearInterval(fader); done?.(); }
  }, 50);
}

export function isPlaying() { return !!current; }
export function isLoading() { return !!loading; }

export function play(key = prefs.sound) {
  const a = el();
  if (current === key && !a.paused) return true;
  prefs.sound = key; savePrefs();
  current = key;
  // 누른 순간에 한 번 틀어 둔다 (브라우저 허락용)
  if (!a.src || a.paused) { a.src = a.src || SILENT; a.play().catch(() => {}); }
  loading = key; notify();
  loopUrl(key).then(url => {
    if (current !== key) return;
    const start = () => {
      selfPause = true; a.src = url; a.volume = 0; a.play().catch(() => {}).finally(() => { selfPause = false; });
      loading = null; notify();
      fadeTo(target(), 1.5);
    };
    if (!a.paused && a.src !== SILENT && a.volume > 0) fadeTo(0, 0.6, start); else start();
    setupMediaSession();
  }).catch(() => { loading = null; current = null; notify(); });
  return true;
}

export function stop() {
  if (!current) return;
  current = null; loading = null; notify();
  fadeTo(0, 0.8, () => { selfPause = true; el().pause(); selfPause = false; });
}

export function setVolume(v) {
  prefs.volume = Math.min(1, Math.max(0, v)); savePrefs();
  if (current && !loading) { clearInterval(fader); el().volume = target(); }
}

function setupMediaSession() {
  // 잠금 화면의 재생 정보 (타이머 PiP가 쓰는 동안은 그쪽이 우선)
  if (!('mediaSession' in navigator) || document.pictureInPictureElement) return;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title: SOUNDS.find(s => s.key === current)?.label || '배경 소리', artist: 'S-DAY' }); } catch { /* 지원 안 함 */ }
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
    volumeSupported ? h('label', { class: 'amb-vol-row' }, icon(ICON_ON), vol) : null,
    off);
  const wrap = h('div', { class: 'amb' }, btn, pop);

  const paint = () => {
    const on = isPlaying();
    const name = on ? SOUNDS.find(s => s.key === current).label : '배경 소리';
    btn.replaceChildren(icon(on ? ICON_ON : ICON_OFF), h('span', null, isLoading() ? `${name} 준비 중…` : name));
    btn.classList.toggle('on', on);
    btn.title = on ? '배경 소리 바꾸기 · 끄기' : '잔잔한 배경 소리 켜기';
    list.replaceChildren(...SOUNDS.map(s => h('button', {
      type: 'button', role: 'radio', class: 'amb-opt', 'aria-checked': on && current === s.key ? 'true' : 'false',
      onclick: () => { play(s.key); },
    }, h('i', { class: 'amb-dot' }), s.label)));
    off.hidden = !on;
  };
  const open = v => {
    pop.hidden = !v; btn.setAttribute('aria-expanded', v ? 'true' : 'false');
    if (v) { paint(); setTimeout(() => loopUrl(prefs.sound).catch(() => {}), 50); }   // 고를 동안 미리 만들어 둠
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

// (점검용) 지금 트는 소리 주소
export const currentSrc = () => audio?.src || '';
