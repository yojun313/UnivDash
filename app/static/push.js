// Web push subscription (this device): the server sends a system notification when an agent finishes or needs an answer.
// Works in Mac, Windows and Android browsers; on iPhone and iPad it works in the app added to the home screen. Toggled by the 'notify-desktop' setting.
(function () {
  'use strict';
  const U = window.UnivDash;
  const SETTING = 'notify-desktop';
  const ASKED = 'univdash-push-asked';

  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  const supported = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function label() {
    const ua = navigator.userAgent;
    const os = ios ? (/iPad/.test(ua) || navigator.maxTouchPoints > 1 && !/iPhone/.test(ua) ? 'iPad' : 'iPhone')
      : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : t('기기');
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    return [os, browser].filter(Boolean).join(' · ');
  }
  const fromB64 = (text) => {
    const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const toB64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  let registration = null;
  async function worker() {
    if (!registration) registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    return registration;
  }

  async function subscribe() {
    const reg = await worker();
    const { key } = await U.api('/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    // Subscribe again if the server key changed (data folder reset, etc.)
    if (sub && sub.options?.applicationServerKey && toB64(sub.options.applicationServerKey) !== key) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64(key) });
    const json = sub.toJSON();
    await U.api('/api/push/subscribe', { method: 'POST', body: { device: U.deviceId(), endpoint: json.endpoint, keys: json.keys, label: label() } });
  }

  async function unsubscribe() {
    if (supported) {
      try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        const sub = await reg?.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch (e) { /* already unsubscribed */ }
    }
    await U.api('/api/push/unsubscribe', { method: 'POST', body: { device: U.deviceId() } }).catch(() => {});
  }

  // Bring the subscription in line with the setting. With ask=true, asks for permission (inside a user gesture).
  async function sync({ ask = false } = {}) {
    if (!supported) return status();
    if (!U.settings.get(SETTING)) { await unsubscribe(); return status(); }
    let permission = Notification.permission;
    if (permission === 'default' && ask) {
      try { localStorage.setItem(ASKED, '1'); } catch (e) { /* storage unavailable */ }
      permission = await Notification.requestPermission();
    }
    if (permission === 'granted') await subscribe();
    return status();
  }

  // Current status shown in the settings window
  async function status() {
    if (!U.settings.get(SETTING)) return { state: 'off', text: t('꺼져 있습니다. 켜면 이 기기로 알림을 받습니다.') };
    if (!window.isSecureContext) return { state: 'unsupported', text: t('HTTPS 주소로 접속해야 알림을 받을 수 있습니다.') };
    if (!supported) {
      return ios && !standalone
        ? { state: 'unsupported', text: t('아이폰 · 아이패드는 Safari 공유 버튼 → "홈 화면에 추가"로 설치한 앱에서 열어야 알림을 받을 수 있습니다 (iOS 16.4 이상).') }
        : { state: 'unsupported', text: t('이 브라우저는 푸시 알림을 지원하지 않습니다.') };
    }
    if (Notification.permission === 'denied') return { state: 'denied', text: t('브라우저에서 이 사이트 알림이 차단돼 있습니다. 주소창 왼쪽 사이트 설정에서 알림을 허용해 주십시오.') };
    if (Notification.permission === 'default') return { state: 'ask', text: t('아직 알림 권한을 허용하지 않았습니다. 「테스트 알림」을 누르면 브라우저가 물어봅니다.') };
    try {
      const { subscribed } = await U.api(`/api/push/status?device=${encodeURIComponent(U.deviceId())}`);
      if (!subscribed) return { state: 'ask', text: t('아직 이 기기가 등록되지 않았습니다. 「테스트 알림」을 눌러 주십시오.') };
    } catch (e) { /* ignore a failed status check */ }
    return { state: 'on', text: t('이 기기({device})로 알림을 받고 있습니다. 대시보드를 보고 있는 동안에는 화면 안 알림만 표시됩니다.', { device: label() }) };
  }

  async function test() {
    await sync({ ask: true });
    await U.api('/api/push/test', { method: 'POST', body: { device: U.deviceId() } });
  }

  window.UnivDashPush = { supported, sync, status, test };

  // When a notification is clicked: open that window (in place on the workspace, otherwise navigate)
  if (supported) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'univdash-open' || typeof event.data.url !== 'string' || !event.data.url.startsWith('/')) return;
      const url = new URL(event.data.url, location.origin);
      if (location.pathname === '/' && url.pathname === '/' && !location.search && url.hash) {
        window.dispatchEvent(new CustomEvent('univdash:open-window', { detail: { key: decodeURIComponent(url.hash.slice(1)) } }));
      } else location.href = url.pathname + url.hash;
    });
  }

  // On by default: with permission, sync the subscription silently; if not asked yet, ask once on the first click
  const start = () => {
    if (!supported || !U.settings.get(SETTING)) return;
    if (Notification.permission === 'granted') { sync().catch(() => {}); return; }
    let asked = false;
    try { asked = localStorage.getItem(ASKED) === '1'; } catch (e) { /* storage unavailable */ }
    if (Notification.permission === 'default' && !asked) {
      document.addEventListener('click', () => { sync({ ask: true }).catch(() => {}); }, { once: true, capture: true });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
