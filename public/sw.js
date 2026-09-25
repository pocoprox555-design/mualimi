/* معلمي 3 — الواجهة قابلة للعمل أثناء ضعف الشبكة، والـ API حي دائما */
const CACHE = 'mualimi-v3-1';
const CORE = ['/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/api/')) return; // حيّ دائمًا
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(CACHE).then((cc) => cc.put(e.request, c)).catch(() => {}); return r; }).catch(() => caches.match('/index.html')));
    return;
  }
  if (u.origin === self.location.origin) {
    e.respondWith(caches.match(e.request).then((h) => h || fetch(e.request).then((r) => { const c = r.clone(); if (r.ok) caches.open(CACHE).then((cc) => cc.put(e.request, c)).catch(() => {}); return r; })));
  }
});
