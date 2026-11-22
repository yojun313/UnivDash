// Passkeys (WebAuthn): sign in on the login page, and add / rename / remove them in Settings.
// A passkey on a phone can sign in a desktop browser too: the browser shows a QR code and the phone scans it.
// That hand-off is done by the browser and the operating system; this file only starts the request.
(function () {
  'use strict';
  const tr = (text, values) => (window.t ? window.t(text, values) : text);
  const supported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);

  // base64url ⇄ bytes (the server speaks JSON, WebAuthn wants ArrayBuffers)
  const toBytes = (text) => {
    const pad = '='.repeat((4 - (text.length % 4)) % 4);
    const raw = atob((text + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  const toText = (buffer) => {
    let raw = '';
    new Uint8Array(buffer).forEach((b) => { raw += String.fromCharCode(b); });
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  async function post(url, body) {
    const response = await fetch(url, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : tr('요청이 실패했습니다.'));
    return data;
  }

  // The browser's own messages for a dismissed / timed-out prompt are not helpful: say what happened.
  const friendly = (error) => {
    if (error?.name === 'NotAllowedError') return new Error(tr('패스키 확인이 취소되었거나 시간이 지났습니다.'));
    if (error?.name === 'InvalidStateError') return new Error(tr('이 기기에는 이미 등록된 패스키가 있습니다.'));
    if (error?.name === 'SecurityError') return new Error(tr('이 주소에서는 패스키를 사용할 수 없습니다.'));
    return error instanceof Error ? error : new Error(String(error));
  };

  async function register(password, name) {
    if (!supported()) throw new Error(tr('이 브라우저는 패스키를 지원하지 않거나, HTTPS 주소가 아닙니다.'));
    const options = await post('/api/auth/passkeys/options', { password });
    options.challenge = toBytes(options.challenge);
    options.user.id = toBytes(options.user.id);
    (options.excludeCredentials || []).forEach((item) => { item.id = toBytes(item.id); });
    let credential;
    try { credential = await navigator.credentials.create({ publicKey: options }); }
    catch (error) { throw friendly(error); }
    const response = credential.response;
    return post('/api/auth/passkeys', {
      name: name || '',
      credential: {
        id: credential.id,
        rawId: toText(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment || undefined,
        response: {
          clientDataJSON: toText(response.clientDataJSON),
          attestationObject: toText(response.attestationObject),
          transports: response.getTransports ? response.getTransports() : undefined,
        },
        clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
      },
    });
  }

  async function login() {
    if (!supported()) throw new Error(tr('이 브라우저는 패스키를 지원하지 않거나, HTTPS 주소가 아닙니다.'));
    const options = await post('/api/auth/passkey/login/options');
    options.challenge = toBytes(options.challenge);
    (options.allowCredentials || []).forEach((item) => { item.id = toBytes(item.id); });
    let credential;
    try { credential = await navigator.credentials.get({ publicKey: options }); }
    catch (error) { throw friendly(error); }
    const response = credential.response;
    return post('/api/auth/passkey/login', {
      credential: {
        id: credential.id,
        rawId: toText(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment || undefined,
        response: {
          clientDataJSON: toText(response.clientDataJSON),
          authenticatorData: toText(response.authenticatorData),
          signature: toText(response.signature),
          userHandle: response.userHandle ? toText(response.userHandle) : undefined,
        },
        clientExtensionResults: credential.getClientExtensionResults ? credential.getClientExtensionResults() : {},
      },
    });
  }

  window.UnivDashPasskey = { supported, register, login };

  // Login page: the "sign in with a passkey" button
  function bindLoginButton() {
    const button = document.getElementById('passkeyLogin');
    if (!button) return;
    const note = document.getElementById('passkeyNote');
    if (!supported()) { button.closest('[data-passkey-box]')?.remove(); return; }
    button.addEventListener('click', async () => {
      button.disabled = true;
      if (note) { note.textContent = ''; note.hidden = true; }
      try {
        const result = await login();
        location.href = result.redirect || '/';
      } catch (error) {
        if (note) { note.textContent = error.message; note.hidden = false; }
        button.disabled = false;
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindLoginButton);
  else bindLoginButton();
})();
