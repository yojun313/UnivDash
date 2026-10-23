// 웹 푸시 알림 구독 (이 기기): 에이전트 작업이 끝나거나 응답이 필요하면 서버가 시스템 알림을 보낸다.
// 맥 · 윈도우 · 안드로이드 브라우저, 아이폰 · 아이패드는 홈 화면에 추가한 앱에서 동작한다. 설정 'notify-desktop' 으로 켜고 끈다.
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
      : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '기기';
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
    // 서버 키가 바뀌었으면(데이터 폴더 초기화 등) 새로 구독
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
      } catch (e) { /* 이미 해지됨 */ }
    }
    await U.api('/api/push/unsubscribe', { method: 'POST', body: { device: U.deviceId() } }).catch(() => {});
  }

  // 설정에 맞춰 구독 상태를 맞춘다. ask=true 면 (사용자 동작 안에서) 권한을 묻는다.
  async function sync({ ask = false } = {}) {
    if (!supported) return status();
    if (!U.settings.get(SETTING)) { await unsubscribe(); return status(); }
    let permission = Notification.permission;
    if (permission === 'default' && ask) {
      try { localStorage.setItem(ASKED, '1'); } catch (e) { /* 저장 불가 */ }
      permission = await Notification.requestPermission();
    }
    if (permission === 'granted') await subscribe();
    return status();
  }

  // 설정 창에 보여 줄 현재 상태
  async function status() {
    if (!U.settings.get(SETTING)) return { state: 'off', text: '꺼져 있어요. 켜면 이 기기로 알림을 받아요.' };
    if (!window.isSecureContext) return { state: 'unsupported', text: 'HTTPS 주소로 접속해야 알림을 받을 수 있어요.' };
    if (!supported) {
      return ios && !standalone
        ? { state: 'unsupported', text: '아이폰 · 아이패드는 Safari 공유 버튼 → "홈 화면에 추가"로 설치한 앱에서 열어야 알림을 받을 수 있어요 (iOS 16.4 이상).' }
        : { state: 'unsupported', text: '이 브라우저는 푸시 알림을 지원하지 않아요.' };
    }
    if (Notification.permission === 'denied') return { state: 'denied', text: '브라우저에서 이 사이트 알림이 차단돼 있어요. 주소창 왼쪽 사이트 설정에서 알림을 허용해 주세요.' };
    if (Notification.permission === 'default') return { state: 'ask', text: '아직 알림 권한을 허용하지 않았어요. 「테스트 알림」을 누르면 브라우저가 물어봐요.' };
    try {
      const { subscribed } = await U.api(`/api/push/status?device=${encodeURIComponent(U.deviceId())}`);
      if (!subscribed) return { state: 'ask', text: '아직 이 기기가 등록되지 않았어요. 「테스트 알림」을 눌러 주세요.' };
    } catch (e) { /* 상태 확인 실패는 무시 */ }
    return { state: 'on', text: `이 기기(${label()})로 알림을 받고 있어요. 대시보드를 보고 있는 동안에는 화면 안 알림만 떠요.` };
  }

  async function test() {
    await sync({ ask: true });
    await U.api('/api/push/test', { method: 'POST', body: { device: U.deviceId() } });
  }

  window.UnivDashPush = { supported, sync, status, test };

  // 알림을 누르면: 해당 창 열기 (워크스페이스면 그 자리에서, 아니면 이동)
  if (supported) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'univdash-open' || typeof event.data.url !== 'string' || !event.data.url.startsWith('/')) return;
      const url = new URL(event.data.url, location.origin);
      if (location.pathname === '/' && url.pathname === '/' && !location.search && url.hash) {
        window.dispatchEvent(new CustomEvent('univdash:open-window', { detail: { key: decodeURIComponent(url.hash.slice(1)) } }));
      } else location.href = url.pathname + url.hash;
    });
  }

  // 기본값 켜짐: 권한이 있으면 조용히 구독을 맞추고, 아직 안 물었으면 첫 클릭 때 한 번 묻는다
  const start = () => {
    if (!supported || !U.settings.get(SETTING)) return;
    if (Notification.permission === 'granted') { sync().catch(() => {}); return; }
    let asked = false;
    try { asked = localStorage.getItem(ASKED) === '1'; } catch (e) { /* 저장 불가 */ }
    if (Notification.permission === 'default' && !asked) {
      document.addEventListener('click', () => { sync({ ask: true }).catch(() => {}); }, { once: true, capture: true });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
