/* معلمي — Service Worker للإشعارات وذاكرة التخزين
   الاستراتيجية: الشبكة أولًا للملاحة (تحديث دائم)، وذاكرة-أولًا للأصول الثابتة. */
const CACHE = 'mualimi-v4';
// ملفات ثابتة الأسماء في بناء الإنتاج فقط. أصول JS/CSS تحمل أسماءً
// مُجزّأة (hashed) بعد بناء Vite، لذا تُخزَّن وقت التشغيل في معالج fetch
// بدل التخزين المسبق — وإلا سيفشل addAll ويُكسر التخزين كله بصمت.
const CORE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // API responses are always live and must never share a cache entry with
  // another session or mask a server error with stale JSON/HTML.
  if (url.pathname.startsWith('/api/')) return;

  // الملاحة (طلبات HTML): الشبكة أولًا دائمًا — حتى لا تُخدَم نسخة قديمة.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || caches.match('/index.html')))
    );
    return;
  }

  // الأصول الثابتة (من نفس الأصل): ذاكرة أولًا ثم الشبكة.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request)
            .then((res) => {
              const copy = res.clone();
              if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
              return res;
            })
             .catch(() => caches.match(e.request))
      )
    );
  }
});

/* إشعارات المواعيد */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length) { list[0].focus(); return; }
      return clients.openWindow('/');
    })
  );
});

/* مزامنة مواعيد مجدولة */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SHOW_REMINDER') {
    self.registration.showNotification(e.data.title, {
      body: e.data.body,
      icon: 'icons/icon.svg',
      badge: 'icons/icon.svg',
      tag: 'exam-reminder',
    });
  }
});
