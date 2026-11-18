/* HeyQuicky dashboard service worker: install as an app, open offline, phone alerts (web push). */
const SHELL = 'hq-shell-v1';
const ASSETS = 'hq-assets-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/app/', '/app/manifest.webmanifest', '/app/icons/icon-192.png'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (![SHELL, ASSETS].includes(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Pages: network first, the saved shell when offline (the app then shows "You're offline").
// Built assets (hashed file names): cache first. The API is never cached — data is always live.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/app')) return;
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(SHELL);
        cache.put('/app/', res.clone()).catch(() => {});
        return res;
      } catch {
        return (await caches.match('/app/')) || Response.error();
      }
    })());
    return;
  }
  if (url.pathname.startsWith('/app/assets/') || url.pathname.startsWith('/app/icons/')) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(ASSETS)).put(req, res.clone()).catch(() => {});
      return res;
    })());
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  const title = data.title || 'HeyQuicky';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/app/icons/icon-192.png',
    badge: '/app/icons/icon-192.png',
    tag: data.link || undefined,
    data: { link: data.link || '/app' },
  }));
});

// Tapping an alert opens (or focuses) the dashboard on the right page.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = new URL(event.notification.data?.link || '/app', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => c.url.startsWith(`${self.location.origin}/app`));
    if (open) { await open.focus(); return open.navigate(link); }
    return self.clients.openWindow(link);
  })());
});
