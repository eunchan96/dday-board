// 마우스로 쓰는 화면(PC): 페이지 스크롤바를 화면 위에 겹쳐 그리는 얇은 막대로 바꾼다.
// 기본 스크롤바는 자리를 차지해서 생기고 없어질 때 화면이 옆으로 밀리거나 오른쪽에 빈 띠가 남기 때문.
// 스크롤할 때 · 오른쪽 끝에 마우스를 가져갈 때만 보이고, 잡고 끌 수 있다.

export function initScrollbar() {
  if (!matchMedia('(pointer: fine)').matches) return;     // 폰 · 태블릿은 원래 겹치는 스크롤바
  document.documentElement.classList.add('ov-scrollbar');
  const track = document.createElement('div');
  track.className = 'ov-track';
  track.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('div');
  thumb.className = 'ov-thumb';
  track.append(thumb);
  document.body.append(track);

  const doc = document.documentElement;
  let hideTimer = null, drag = null;
  const metrics = () => {
    const vh = window.innerHeight, sh = doc.scrollHeight;
    const h = Math.max(36, vh * vh / sh);
    return { vh, sh, h, max: sh - vh, room: vh - h - 4 };
  };
  const place = () => {
    const m = metrics();
    track.hidden = m.max <= 1;
    if (track.hidden) return;
    thumb.style.height = `${m.h}px`;
    thumb.style.transform = `translateY(${2 + (window.scrollY / m.max) * m.room}px)`;
  };
  const show = (ms = 900) => {
    track.classList.add('show');
    clearTimeout(hideTimer);
    if (!drag) hideTimer = setTimeout(() => track.classList.remove('show'), ms);
  };

  window.addEventListener('scroll', () => { place(); show(); }, { passive: true });
  window.addEventListener('resize', place);
  new ResizeObserver(place).observe(document.body);
  // 오른쪽 끝으로 마우스를 가져가면 보임
  document.addEventListener('mousemove', e => { if (e.clientX > window.innerWidth - 18 && !track.hidden) show(1200); }, { passive: true });

  thumb.addEventListener('pointerdown', e => {
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, top: window.scrollY };
    track.classList.add('show', 'drag');
  });
  thumb.addEventListener('pointermove', e => {
    if (!drag) return;
    const m = metrics();
    window.scrollTo(0, drag.top + (e.clientY - drag.y) * (m.max / Math.max(1, m.room)));
  });
  const end = () => { if (!drag) return; drag = null; track.classList.remove('drag'); show(); };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('pointercancel', end);
  place();
}
