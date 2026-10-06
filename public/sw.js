/* غلاف التطبيق والملفات الأساسية فقط؛ بيانات الكتب وواجهات API تتطلب اتصالاً. */
const CACHE = 'mualimi-v6-1';
const CORE = ['/', '/index.html', '/style.css?v=6.1', '/app.js?v=6.1', '/manifest.webmanifest', '/icons/icon.svg'];
const CORE_SET = new Set(CORE);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('mualimi-') && key !== CACHE).map((key) => caches.delete(key)),
  )));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then((response) => {
      if (!response.ok) return caches.match('/index.html').then((cached) => cached || response);
      caches.open(CACHE).then((cache) => cache.put('/index.html', response.clone())).catch(() => {});
      return response;
    }).catch(() => caches.match('/index.html')));
    return;
  }

  if (!CORE_SET.has(`${url.pathname}${url.search}`)) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone())).catch(() => {});
    return response;
  })));
});
