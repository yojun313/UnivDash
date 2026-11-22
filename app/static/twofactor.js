// Two-factor authentication (authenticator app codes), enrolled in the browser.
//  - asks once after sign-in whether to turn it on (later / don't ask again are remembered on the server)
//  - Settings › Signed-in devices has the same switch (window.UnivDashTwoFactor.open)
// The secret is created and checked on the server; the QR code is drawn there too, so nothing leaves the site.
(function () {
  'use strict';
  const U = () => window.UnivDash;
  const ui = () => window.UnivDashUI;
  const esc = (value) => U().escapeHtml(String(value ?? ''));
  const ASKED = 'univdash-2fa-asked';

  const status = () => U().api('/api/auth/totp');

  // Enrolment: QR code / key → the user types the 6-digit code the app shows → on.
  async function enroll(onDone) {
    let data;
    try { data = await U().api('/api/auth/totp/setup', { method: 'POST' }); }
    catch (error) { U().toast(error.message, 'error'); return; }
    ui().infoSheet({
      title: t('이중 인증 등록'),
      subtitle: t('인증 앱(Google Authenticator, 1Password, iOS 암호 앱 등)으로 등록한 뒤, 앱에 표시된 6자리 코드를 입력하십시오.'),
      bodyHtml: `<div class="tfa">
          ${data.qr ? `<div class="tfa-qr">${data.qr}</div>` : ''}
          <ol class="cx-steps">
            <li><span>${t('인증 앱에서 QR 코드를 스캔하거나, 아래 설정 키를 직접 입력하십시오.')}</span>
              <code class="tfa-key">${esc(data.secret)}</code>
              <span class="tfa-links"><button type="button" class="ud-set-btn" data-tfa-copy><i class="fas fa-copy"></i> ${t('키 복사')}</button>
              <a class="ud-set-btn" href="${esc(data.uri)}"><i class="fas fa-arrow-up-right-from-square"></i> ${t('이 기기의 인증 앱으로 열기')}</a></span></li>
            <li><span>${t('앱에 표시된 6자리 코드를 입력하십시오.')}</span>
              <form class="cx-code-form" data-tfa-form><input type="text" class="input-glass" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" placeholder="000000" aria-label="${t('인증 코드')}" required><button type="submit" class="btn-glow">${t('등록')}</button></form></li>
          </ol>
          <p class="cx-note">${t('등록하면 이 브라우저는 로그인 상태를 유지하고, 다른 기기는 모두 로그아웃됩니다. 다음 로그인부터 비밀번호와 함께 코드를 입력해야 합니다.')}</p>
        </div>`,
      onMount(body) {
        body.querySelector('[data-tfa-copy]').addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(data.secret.replace(/\s/g, '')); U().toast(t('설정 키를 복사했습니다.'), 'success'); }
          catch (error) { U().toast(t('복사하지 못했습니다. 키를 직접 선택해 복사하십시오.'), 'error'); }
        });
        const form = body.querySelector('[data-tfa-form]');
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = form.querySelector('button');
          button.disabled = true;
          try {
            await U().api('/api/auth/totp/enable', { method: 'POST', body: { code: form.querySelector('input').value.replace(/\s/g, '') } });
            ui().closeSheet();
            U().toast(t('이중 인증을 켰습니다. 다음 로그인부터 인증 코드를 입력합니다.'), 'success');
            onDone?.();
          } catch (error) {
            U().toast(error.message, 'error');
            button.disabled = false;
            form.querySelector('input').select();
          }
        });
        setTimeout(() => form.querySelector('input').focus(), 60);
      },
    });
  }

  // Turning it off needs the password and a current code.
  function disable(onDone) {
    ui().formSheet({
      title: t('이중 인증 끄기'),
      subtitle: t('비밀번호와 인증 앱의 현재 코드를 입력하십시오. 끄면 비밀번호만으로 로그인할 수 있게 됩니다.'),
      fields: [
        { name: 'password', label: t('비밀번호'), type: 'password', maxlength: 256, autocomplete: 'current-password' },
        { name: 'code', label: t('인증 코드'), maxlength: 7, placeholder: '000000' },
      ],
      submitLabel: t('끄기'),
      async onSubmit(values) {
        await U().api('/api/auth/totp/disable', { method: 'POST', body: { password: values.password || '', code: String(values.code || '').replace(/\s/g, '') } });
        U().toast(t('이중 인증을 껐습니다.'), 'success');
        onDone?.();
      },
    });
  }

  async function open(onDone) {
    let current;
    try { current = await status(); } catch (error) { U().toast(error.message, 'error'); return; }
    if (current.source === 'env') { U().toast(t('이중 인증이 서버 설정(.env)으로 관리되고 있어 여기서 바꿀 수 없습니다.'), 'info'); return; }
    if (current.enabled) disable(onDone); else enroll(onDone);
  }

  // Once per browser session, right after sign-in: offer to turn it on.
  async function ask() {
    try { if (sessionStorage.getItem(ASKED)) return; sessionStorage.setItem(ASKED, '1'); } catch (error) { /* storage unavailable: ask on this page only */ }
    let current;
    try { current = await status(); } catch (error) { return; }
    if (!current.prompt || document.getElementById('sheetOverlay')?.hidden === false) return;   // another dialog is open: ask at the next page
    ui().actionSheet({
      title: t('이중 인증을 등록하시겠습니까?'),
      subtitle: t('비밀번호가 유출되어도 인증 앱의 코드 없이는 로그인할 수 없게 됩니다. 이 대시보드는 터미널에 입력할 수 있으므로 등록을 권장합니다.'),
      actions: [
        { icon: 'fa-shield-halved', label: t('지금 등록'), desc: t('인증 앱으로 QR 코드를 스캔합니다 (1분 정도)'), onClick: () => enroll() },
        { icon: 'fa-clock', label: t('나중에'), desc: t('다음 로그인 때 다시 묻습니다'), onClick: () => {} },
        { icon: 'fa-ban', label: t('다시 묻지 않기'), desc: t('설정 › 로그인 · 보안에서 언제든 등록할 수 있습니다'), onClick: () => { U().api('/api/auth/totp/dismiss', { method: 'POST' }).catch(() => {}); } },
      ],
    });
  }

  window.UnivDashTwoFactor = { open, status };
  if (document.readyState === 'complete') setTimeout(ask, 800);
  else window.addEventListener('load', () => setTimeout(ask, 800));
})();
