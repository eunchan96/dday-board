// 떠 있는 타이머 (다른 앱 · 창 위에 작게)
//
// 1) Document Picture-in-Picture (크롬 · 엣지 PC): 작은 창에 시간 + 과목 + 시작/끝내기 버튼
// 2) 그 밖(안드로이드 크롬 · 사파리 · 아이폰): 캔버스에 그린 시간을 영상으로 띄우는 PiP
//    → 창 안의 재생/일시정지 버튼이 시작/끝내기 (끝내면 기록하고 다시 대기 화면)
//
// study.js가 상태를 넘겨주면(get) 1초마다 다시 그린다.
//   initPip({ get: () => ({ phase, text, label, color, subLabel }), start, stop, endRest })

let api = null;
let docWin = null;                 // Document PiP 창
let video = null, canvas = null, cctx = null, stream = null;
let lastKey = '';

export function initPip(options) { api = options; }

const hasDocPip = () => 'documentPictureInPicture' in window;
function hasVideoPip() {
  const v = document.createElement('video');
  return !!((document.pictureInPictureEnabled && v.requestPictureInPicture)
    || (typeof v.webkitSetPresentationMode === 'function' && v.webkitSupportsPresentationMode?.('picture-in-picture')))
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}
export const pipSupported = () => hasDocPip() || hasVideoPip();
export const pipOpen = () => !!(docWin && !docWin.closed) || !!(video && (document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture'));

export async function togglePip() {
  if (pipOpen()) { closePip(); return true; }
  try {
    if (hasDocPip()) await openDocPip();
    else if (hasVideoPip()) await openVideoPip();
    else return false;
    return true;
  } catch (e) {
    console.warn('pip', e);
    return false;
  }
}

export function closePip() {
  if (docWin && !docWin.closed) docWin.close();
  docWin = null;
  if (video) {
    if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
    else if (video.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode('inline');
  }
}

/* ───── 1) 작은 창 ───── */
const PIP_CSS = `
:root { color-scheme: light dark; --ink: #1C2540; --pencil: #59627C; --sheet: #FFFFFF; --pen: #2C4BD1; --green: #1F8A5B; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ink: #E6EAF3; --pencil: #A4ABBF; --sheet: #161B29; --pen: #8EA2FF; --green: #3FBF85; } }
:root[data-theme="dark"] { --ink: #E6EAF3; --pencil: #A4ABBF; --sheet: #161B29; --pen: #8EA2FF; --green: #3FBF85; }
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body {
  font-family: 'SUIT Variable', 'SUIT', -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
  background: color-mix(in srgb, var(--c, var(--pen)) 10%, var(--sheet)); color: var(--ink);
  display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px;
  box-shadow: inset 4px 0 0 var(--c, var(--pen)); user-select: none;
}
.top { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; color: var(--pencil); }
.top .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c, var(--pen)); flex-shrink: 0; }
.top .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.digits { font-size: clamp(26px, 15vw, 64px); font-weight: 800; letter-spacing: -0.03em; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
button {
  flex-shrink: 0; width: 40px; height: 40px; border-radius: 50%; border: 0; cursor: pointer; padding: 0;
  display: grid; place-items: center; background: var(--pen); color: #fff;
}
button svg { width: 18px; height: 18px; fill: currentColor; }
button.stop { background: var(--ink); color: var(--sheet); }
button.rest { background: var(--green); }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
`;

async function openDocPip() {
  // 작게: 시간 + 과목 한 줄, 오른쪽 둥근 버튼
  docWin = await window.documentPictureInPicture.requestWindow({ width: 250, height: 96 });
  const d = docWin.document;
  d.title = 'S-DAY 타이머';
  const style = d.createElement('style'); style.textContent = PIP_CSS; d.head.append(style);
  const font = document.querySelector('link[href*="SUIT"]');
  if (font) d.head.append(font.cloneNode());
  if (document.documentElement.dataset.theme) d.documentElement.dataset.theme = document.documentElement.dataset.theme;
  d.body.innerHTML = '<div class="main"><div class="top"><i class="dot"></i><span class="what"></span></div><div class="digits"></div></div><button type="button"></button>';
  d.querySelector('button').addEventListener('click', () => {
    const s = api.get();
    if (s.phase === 'idle') api.start(); else if (s.phase === 'rest') api.endRest(); else api.stop();
    renderPip(true);
  });
  docWin.addEventListener('pagehide', () => { docWin = null; api.onChange?.(); });
  lastKey = '';
  renderPip(true);
  api.onChange?.();
}

function paintDoc(s) {
  const d = docWin.document;
  d.body.style.setProperty('--c', s.color);
  d.querySelector('.what').textContent = s.label || '과목 없이 공부';
  d.querySelector('.digits').textContent = s.text;
  const b = d.querySelector('button');
  // ▶ 시작 · ❚❚ 끝내기 · 쉬는 시간이면 ⏭
  const icon = s.phase === 'idle' ? 'M7 5.2v9.6l7.6-4.8z' : s.phase === 'rest' ? 'M5.5 5.2v9.6l6.6-4.8zM13.2 5h2.2v10h-2.2z' : 'M6.5 5h2.6v10H6.5zM10.9 5h2.6v10h-2.6z';
  b.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${icon}"/></svg>`;
  const label = s.phase === 'idle' ? '시작' : s.phase === 'rest' ? '쉬는 시간 끝' : '끝내기';
  b.title = label; b.setAttribute('aria-label', label);
  b.className = s.phase === 'rest' ? 'rest' : s.phase === 'idle' ? '' : 'stop';
}

/* ───── 2) 영상 PiP ───── */
async function openVideoPip() {
  if (!video) {
    canvas = document.createElement('canvas');
    // 가로로 길고 낮은 비율(약 2.4:1): 창 높이가 작아짐 (창 크기는 기기가 정하고, 손가락으로 더 줄일 수 있음)
    canvas.width = 600; canvas.height = 250;
    cctx = canvas.getContext('2d');
    video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.setAttribute('playsinline', '');
    // 화면에는 안 보이게 (PiP는 보이는 요소가 아니어도 됨)
    Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', bottom: '0', right: '0' });
    document.body.append(video);
    drawCanvas(api.get());
    stream = canvas.captureStream(4);
    video.srcObject = stream;
    // 창 안의 버튼(영상은 늘 재생 중이라 ❚❚로 보임)을 누르면: 대기 중이면 시작, 공부 중이면 끝내기
    video.addEventListener('pause', () => {
      if (!pipOpen() || !playArmed) return;
      toggle();
      resume();
    });
    video.addEventListener('leavepictureinpicture', () => api.onChange?.());
    video.addEventListener('webkitpresentationmodechanged', () => api.onChange?.());
  }
  playArmed = false;
  await video.play();
  if (video.requestPictureInPicture && document.pictureInPictureEnabled) await video.requestPictureInPicture();
  else video.webkitSetPresentationMode('picture-in-picture');
  setTimeout(() => { playArmed = true; }, 400);   // 처음 재생은 시작으로 치지 않음
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'S-DAY 타이머', artist: '공부' });
      navigator.mediaSession.setActionHandler('play', () => { if (api.get().phase === 'idle') api.start(); resume(); });
      navigator.mediaSession.setActionHandler('pause', () => { toggle(); resume(); });
    } catch { /* 지원 안 함 */ }
  }
  lastKey = '';
  renderPip(true);
  api.onChange?.();
}
let playArmed = false;
function toggle() {
  const s = api.get();
  if (s.phase === 'idle') api.start(); else if (s.phase === 'rest') api.endRest(); else api.stop();
}
// 끝낸 뒤 영상을 다시 틀어 PiP 창을 살려 둔다 (이 재생은 '시작'으로 치지 않음)
function resume() {
  playArmed = false;
  video.play().catch(() => {}).finally(() => setTimeout(() => { playArmed = true; }, 300));
}

function drawCanvas(s) {
  const W = canvas.width, H = canvas.height;
  const theme = document.documentElement.dataset.theme;
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  cctx.fillStyle = dark ? '#161B29' : '#FFFFFF';
  cctx.fillRect(0, 0, W, H);
  cctx.fillStyle = s.color; cctx.globalAlpha = 0.12; cctx.fillRect(0, 0, W, H); cctx.globalAlpha = 1;
  cctx.fillRect(0, 0, 12, H);
  const font = "'SUIT Variable', -apple-system, 'Apple SD Gothic Neo', sans-serif";
  // 과목 (위) + 시간 (크게)
  cctx.fillStyle = dark ? '#A4ABBF' : '#59627C';
  cctx.font = `650 34px ${font}`;
  cctx.textBaseline = 'top';
  const what = s.phase === 'rest' ? '쉬는 시간' : (s.label || '과목 없이 공부');
  cctx.fillText(what.length > 16 ? `${what.slice(0, 15)}…` : what, 44, 26);
  cctx.fillStyle = s.phase === 'rest' ? (dark ? '#3FBF85' : '#1F8A5B') : (dark ? '#E6EAF3' : '#1C2540');
  cctx.font = `800 ${s.text.length > 5 ? 132 : 150}px ${font}`;
  cctx.textBaseline = 'alphabetic';
  cctx.fillText(s.text, 38, H - 30);
}

// 1초마다 (study.js의 tick에서) 부른다
export function renderPip(force = false) {
  if (!api) return;
  const open = (docWin && !docWin.closed) || video;
  if (!open) return;
  const s = api.get();
  const key = `${s.phase}|${s.text}|${s.label}|${s.color}|${s.subLabel}`;
  if (!force && key === lastKey) return;
  lastKey = key;
  if (docWin && !docWin.closed) paintDoc(s);
  if (video && cctx) drawCanvas(s);
}
