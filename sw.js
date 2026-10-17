// 앱 화면 파일만 캐시해서 오프라인에서도 열리게 한다.
// 과제 데이터(Supabase 호출)는 캐시하지 않는다. 항상 네트워크 우선.

const CACHE = 'dday-shell-v2';
const SHELL = [
  './',
  'index.html',
  'assets/style.css',
  'assets/js/app.js',
  'assets/js/api.js',
  'assets/js/store.js',
  'assets/js/util.js',
  'assets/js/views.js',
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
