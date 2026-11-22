// UnivDash service worker: handles web push notifications only (no request interception, no cache).
'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data?.text() || '' }; }
  const title = String(data.title || 'UnivDash').slice(0, 120);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(data.body || '').slice(0, 300),
    tag: data.tag || undefined,
    renotify: !!data.tag,
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/icon-192.png',
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;   // only open URLs within this site
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer the main workspace window over separately opened windows (?solo=…)
    const main = windows.find((c) => { const u = new URL(c.url); return u.pathname === '/' && !u.search; })
      || windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (main) {
      try { await main.focus(); } catch (e) { /* focusing not possible in this environment */ }
      main.postMessage({ type: 'univdash-open', url: target.pathname + target.hash });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
