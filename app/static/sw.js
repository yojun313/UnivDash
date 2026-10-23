// UnivDash 서비스 워커: 웹 푸시 알림만 다룬다 (요청 가로채기 · 캐시 없음).
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
  if (target.origin !== self.location.origin) return;   // 같은 사이트 안에서만 연다
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 별도로 띄운 창(?solo=…)보다 메인 워크스페이스 창을 우선
    const main = windows.find((c) => { const u = new URL(c.url); return u.pathname === '/' && !u.search; })
      || windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (main) {
      try { await main.focus(); } catch (e) { /* 포커스 불가 환경 */ }
      main.postMessage({ type: 'univdash-open', url: target.pathname + target.hash });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
