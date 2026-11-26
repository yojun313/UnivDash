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

// ── File explorer uploads ────────────────────────────────────────────────
// Uploads run here, not in the page, so they carry on when the page that started them goes to another page.
// A page hands over the files (univdash-upload-add); every open page gets the progress (univdash-uploads)
// and shows it. Files up to one chunk go in one request, larger ones in chunks (the server keeps the order).
const UP_CHUNK = 4 * 1024 * 1024;
const UP_PARALLEL = 2;
const UP_KEEP_MS = 10 * 60 * 1000;   // finished entries stay listed this long
const ups = new Map();
let upActive = 0;
let upWake = [];
let upTimer = null;
const upBusy = () => [...ups.values()].some((u) => u.status === 'queued' || u.status === 'uploading');
const upPublic = (u) => ({ id: u.id, name: u.name, size: u.size, sent: u.sent, status: u.status, error: u.error, status_code: u.code, dir: u.dir, rel: u.rel, result: u.result });

async function upSend() {
  upTimer = null;
  const now = Date.now();
  for (const [id, u] of ups) if (u.ended && now - u.ended > UP_KEEP_MS) ups.delete(id);
  const list = [...ups.values()].map(upPublic);
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const page of pages) page.postMessage({ type: 'univdash-uploads', list });
}
function upBroadcast(now) {
  if (now) { clearTimeout(upTimer); upSend(); return; }
  if (!upTimer) upTimer = setTimeout(upSend, 250);
}
async function upCall(u, method, url, body, headers) {
  const response = await fetch(url, { method, body, headers, signal: u.ctrl.signal, credentials: 'same-origin' });
  let data = {};
  try { data = await response.json(); } catch (e) { /* no JSON body */ }
  if (!response.ok) throw Object.assign(new Error(typeof data.detail === 'string' ? data.detail : ''), { status: response.status, data });
  return data;
}
async function upRun(u) {
  u.status = 'uploading';
  upBroadcast(true);
  const file = u.file;
  try {
    if (file.size <= UP_CHUNK) {
      const headers = { 'X-Filename': encodeURIComponent(u.name), 'Content-Type': 'application/octet-stream' };
      if (u.rel) headers['X-Relative-Dir'] = encodeURIComponent(u.rel);
      u.result = await upCall(u, 'POST', `/api/fs/upload?dir=${encodeURIComponent(u.dir)}`, file, headers);
    } else {
      const started = await upCall(u, 'POST', '/api/uploads/chunked', JSON.stringify({ size: file.size, name: u.name, kind: 'fs', dir: u.dir, rel: u.rel }), { 'Content-Type': 'application/json' });
      u.token = started.token;
      const size = Math.min(UP_CHUNK, started.chunk_bytes || UP_CHUNK);
      let offset = 0;
      let retries = 0;
      while (offset < file.size) {
        try {
          const done = await upCall(u, 'PUT', `/api/uploads/chunked/${u.token}?offset=${offset}`, file.slice(offset, Math.min(file.size, offset + size)), { 'Content-Type': 'application/octet-stream' });
          offset = done.received;
          retries = 0;
        } catch (error) {
          if (u.ctrl.signal.aborted) throw error;
          // Out of order (409): continue from where the server got to; on a brief network drop, resend the chunk a few times
          if (error.status === 409 && Number.isFinite(error.data?.received)) { offset = error.data.received; continue; }
          if ((!error.status || error.status >= 500) && retries < 5) { retries += 1; await new Promise((r) => setTimeout(r, 1000 * retries)); continue; }
          throw error;
        }
        u.sent = offset;
        upBroadcast(false);
      }
      u.result = await upCall(u, 'POST', `/api/uploads/chunked/${u.token}/finish`, null, {});
      u.token = null;
    }
    u.sent = file.size;
    u.status = 'done';
  } catch (error) {
    u.status = u.ctrl.signal.aborted ? 'aborted' : 'error';
    u.error = error.message || '';
    u.code = error.status || 0;
    if (u.token) fetch(`/api/uploads/chunked/${u.token}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
  } finally {
    u.file = null;
    u.ended = Date.now();
  }
}
function upPump() {
  while (upActive < UP_PARALLEL) {
    const next = [...ups.values()].find((u) => u.status === 'queued');
    if (!next) break;
    upActive += 1;
    upRun(next).finally(() => {
      upActive -= 1;
      upBroadcast(true);
      upPump();
      if (!upBusy()) { upWake.forEach((wake) => wake()); upWake = []; }
    });
  }
}
// The worker is kept alive while a message is being handled: each message (pages send one regularly while
// something is uploading) holds it until the uploads end or a few minutes pass.
const upIdle = () => (upBusy() ? new Promise((resolve) => { upWake.push(resolve); setTimeout(resolve, 4 * 60 * 1000); }) : Promise.resolve());

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (typeof data.type !== 'string' || !data.type.startsWith('univdash-upload-')) return;
  if (data.type === 'univdash-upload-add') {
    for (const item of Array.isArray(data.items) ? data.items : []) {
      if (!item || typeof item.id !== 'string' || !(item.file instanceof Blob) || ups.has(item.id)) continue;
      ups.set(item.id, {
        id: item.id, file: item.file, name: String(item.name || item.file.name || 'file'), size: item.file.size, sent: 0,
        dir: String(item.dir || ''), rel: String(item.rel || ''), status: 'queued', error: '', code: 0, result: null, token: null, ended: 0, ctrl: new AbortController(),
      });
    }
    upPump();
  } else if (data.type === 'univdash-upload-cancel') {
    const u = ups.get(data.id);
    if (u && u.status === 'queued') Object.assign(u, { status: 'aborted', file: null, ended: Date.now() });
    else if (u && u.status === 'uploading') u.ctrl.abort();
  } else if (data.type === 'univdash-upload-clear') {
    for (const [id, u] of ups) if (u.status !== 'queued' && u.status !== 'uploading') ups.delete(id);
  }
  upBroadcast(true);
  event.waitUntil(upIdle());
});
