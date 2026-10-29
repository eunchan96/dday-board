// 앱 화면 파일만 캐시해서 오프라인에서도 열리게 한다.
// 과제 데이터(Supabase 호출)는 캐시하지 않는다. 항상 네트워크 우선.

const CACHE = 'dday-shell-v61';
const SHELL = [
  './',
  'index.html',
  'assets/style.css',
  'assets/js/app.js',
  'assets/js/api.js',
  'assets/js/store.js',
  'assets/js/util.js',
  'assets/js/views.js',
  'assets/js/canvas.js',
  'assets/js/picker.js',
  'assets/js/push.js',
  'assets/js/study.js',
  'assets/js/subject-picker.js',
  'assets/js/ambient.js',
  'assets/js/groups.js',
  'assets/js/pip.js',
  'assets/js/scrollbar.js',
  'assets/icons/icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))),
  );
});

// 마감 알림 (push-notify가 보냄)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'S-DAY', {
    body: d.body || '',
    tag: d.tag,
    renotify: !!d.tag,
    icon: 'assets/icons/icon-192.png',
    badge: 'assets/icons/badge-96.png',
    lang: 'ko',
    data: { url: d.url || './' },
  }));
});

// 알림을 누르면 열려 있는 창을 앞으로 가져오고, 없으면 새로 연다
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.location.href);
  const id = (url.hash.match(/^#task=(.+)$/) || [])[1];
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === url.origin);
    if (win) {
      await win.focus();
      if (id) win.postMessage({ type: 'open-task', id: decodeURIComponent(id) });
      else if (url.hash === '#study') win.postMessage({ type: 'open-view', view: 'study' });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
