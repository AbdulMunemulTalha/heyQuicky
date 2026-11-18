/* HeyQuicky dashboard service worker: phone alerts (web push). Offline caching comes with the PWA work (screen 19). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  const title = data.title || 'HeyQuicky';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
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
