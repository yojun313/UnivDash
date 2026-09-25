// UnivDash 공통 유틸리티 (페이지 스크립트들이 window.UnivDash 로 사용)
(function () {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  async function api(url, options = {}) {
    // 방금 누른 버튼이 이 요청을 시작했다면, 응답이 늦을 때(120ms+) 그 버튼에 '기다리는 중' 표시
    const tap = lastTap && performance.now() - lastTap.t < 80 ? lastTap.el : null;
    if (tap) {
      lastTap = null;
      const timer = setTimeout(() => tap.classList.add('is-busy'), 120);
      try { return await request(url, options); } finally { clearTimeout(timer); tap.classList.remove('is-busy'); }
    }
    return request(url, options);
  }
  let lastTap = null;
  document.addEventListener('click', (event) => {
    if (hapticLabel && hapticLabel.contains(event.target)) return;   // 햅틱용 가짜 클릭은 무시
    const el = event.target.closest?.('button, [role="button"]');
    lastTap = el && !el.closest('.sheet-overlay, #sheetOverlay') ? { el, t: performance.now() } : null;
  }, true);

  async function request(url, options = {}) {
    const init = { ...options, headers: { ...(options.headers || {}) } };
    if (init.body !== undefined && typeof init.body !== 'string') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const response = await fetch(url, init);
    if (response.status === 401) {
      location.href = '/login';
      throw new Error('로그인이 필요합니다.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : '요청이 실패했습니다.';
      throw new Error(detail);
    }
    return data;
  }

  // 레이아웃의 #toastHost 에 app.css 의 .toast 모양으로 띄운다 (Workspace 알림과 같은 모양).
  function toast(message, type = 'info') {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const kind = { success: 'ok', error: 'error', info: 'info', warn: 'warn' }[type] || 'info';
    const icon = { ok: 'fa-circle-check', error: 'fa-circle-exclamation', info: 'fa-circle-info', warn: 'fa-hand' }[kind];
    const item = document.createElement('div');
    item.className = `toast ${kind}`;
    item.innerHTML = `<i class="fas ${icon}"></i><span class="min-w-0 flex-1 whitespace-pre-wrap break-words"></span>`;
    item.querySelector('span').textContent = message;
    host.appendChild(item);
    while (host.children.length > 3) host.firstElementChild.remove();
    setTimeout(() => item.remove(), kind === 'error' ? 6000 : 3500);
  }

  function formatNumber(value) {
    const amount = Number(value || 0);
    if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}B`;
    if (amount >= 1e6) return `${(amount / 1e6).toFixed(amount >= 1e7 ? 1 : 2)}M`;
    if (amount >= 1e3) return `${(amount / 1e3).toFixed(amount >= 1e5 ? 0 : 1)}K`;
    return amount.toLocaleString('ko-KR');
  }

  function relativeTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    const future = seconds < 0;
    const abs = Math.abs(seconds);
    let text;
    if (abs < 60) text = `${abs}초`;
    else if (abs < 3600) text = `${Math.floor(abs / 60)}분`;
    else if (abs < 86400) text = `${Math.floor(abs / 3600)}시간`;
    else text = `${Math.floor(abs / 86400)}일`;
    return future ? `${text} 후` : `${text} 전`;
  }

  function duration(ms) {
    if (ms <= 0) return '곧';
    const minutes = Math.floor(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return `${days}일 ${hours}시간`;
    if (hours > 0) return `${hours}시간 ${mins}분`;
    return `${mins}분`;
  }

  function formatDate(value, withYear = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '—';
    return new Intl.DateTimeFormat('ko-KR', {
      ...(withYear ? { year: '2-digit' } : {}),
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function chartColors() {
    const light = document.documentElement.getAttribute('data-ui-theme-mode') === 'light';
    return light
      ? { grid: 'rgba(15, 23, 42, 0.08)', ticks: '#5a6781', tooltipBg: 'rgba(255,255,255,0.96)', tooltipText: '#101828' }
      : { grid: 'rgba(255, 255, 255, 0.07)', ticks: 'rgba(255, 255, 255, 0.45)', tooltipBg: 'rgba(15,20,36,0.95)', tooltipText: '#e8e9ee' };
  }

  // 단축키용: 지금 글자를 입력하는 중인지 (입력창 · 편집기 · 터미널 · 직접 입력 모드) 또는 시트 · 메뉴가 열려 있는지
  function typingOrBusy(event) {
    const el = event.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest?.('.xterm'))) return true;
    const sheet = document.getElementById('sheetOverlay');
    if (sheet && !sheet.hidden) return true;
    // 열려 있는(보이는) 메뉴만 — 숨겨 둔 메뉴 요소(Git 페이지 등)는 무시
    return [...document.querySelectorAll('.git-menu, .ex-menu')].some((menu) => !menu.classList.contains('hidden') && menu.offsetParent !== null);
  }
  // 한/영 상관없이 같은 자리 키 (w · ㅈ): event.code 로 본다
  function plainKey(event, code) {
    return event.code === code && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.isComposing && !event.repeat;
  }

  // ── 아이폰 앱처럼 누르는 느낌 ────────────────────────────────────────────────
  // 햅틱: 안드로이드는 vibrate, iOS(18+)는 숨긴 스위치 체크박스를 눌러 시스템 햅틱을 낸다.
  // iOS 는 사용자 제스처(click/touchend) 안에서 불러야 울린다 — await 뒤나 타이머 안에서는 조용히 무시된다.
  let hapticLabel = null;
  function haptic(pattern = 8) {
    try {
      if (typeof navigator.vibrate === 'function') { navigator.vibrate(pattern); return; }
      if (!document.body) return;
      if (!hapticLabel) {
        hapticLabel = document.createElement('label');
        hapticLabel.setAttribute('aria-hidden', 'true');
        hapticLabel.style.cssText = 'position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.setAttribute('switch', '');
        box.tabIndex = -1;
        hapticLabel.appendChild(box);
        // 이 가짜 클릭이 "바깥 클릭 → 메뉴 닫기" 같은 처리로 번지지 않게 막는다
        const stop = (event) => event.stopPropagation();
        hapticLabel.addEventListener('click', stop);
        box.addEventListener('click', stop);
        document.body.appendChild(hapticLabel);
      }
      hapticLabel.click();
    } catch (e) { /* noop */ }
  }

  // 눌림 표시: 누르는 순간 바로(0ms) 어두워지고, 뗄 때 천천히(200ms) 돌아온다.
  // - 버튼은 즉시, 목록 줄은 70ms 뒤에 (스크롤하려고 댄 손가락에 줄이 번쩍이지 않게 — UITableView 와 같은 방식)
  // - 손가락이 움직이거나 스크롤이 시작되면 바로 취소
  const PRESSABLE = 'button, [role="button"], a[href], summary, label.check-row, .key-chip, .tab-item, .filter-chip, .win-item, .ex-row, .ex-root, .sheet-action, .wt, .tt-tab, .exv-tab, .fp-row, .folder-head, .org-item, .git-file-row, .git-repo-item';
  const ROW = '.win-item, .ex-row, .ex-root, .sheet-action, .fp-row, .folder-head, .org-item, .git-file-row, .git-repo-item';
  let pressed = null;
  let pressTimer = 0;
  let pressStart = null;
  function release(fade = true) {
    clearTimeout(pressTimer);
    const el = pressed;
    pressed = null;
    if (!el || !el.classList.contains('is-pressed')) return;
    el.classList.remove('is-pressed');
    if (!fade) return;
    el.classList.add('press-release');
    setTimeout(() => el.classList.remove('press-release'), 220);
  }
  document.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    release(false);
    // 줄 안의 작은 버튼(⋯, ✕)을 누르면 줄 전체가 아니라 그 버튼만 (closest 가 가장 안쪽을 고른다)
    const target = event.target.closest?.(PRESSABLE);
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true' || target.closest('.xterm')) return;
    pressed = target;
    pressStart = { x: event.clientX, y: event.clientY };
    if (event.pointerType !== 'mouse' && target.matches(ROW)) pressTimer = setTimeout(() => pressed?.classList.add('is-pressed'), 70);
    else target.classList.add('is-pressed');
  }, { capture: true, passive: true });
  document.addEventListener('pointermove', (event) => {
    if (!pressed || !pressStart) return;
    if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) release(false);
  }, { capture: true, passive: true });
  document.addEventListener('pointerup', () => {
    // 줄을 짧게 톡 친 경우(70ms 전에 뗌)도 눌림을 한 번 보여 준다
    if (pressed && !pressed.classList.contains('is-pressed')) {
      clearTimeout(pressTimer);
      const el = pressed;
      el.classList.add('is-pressed');
      pressTimer = setTimeout(() => { if (pressed === el) release(true); }, 90);
      return;
    }
    release(true);
  }, { capture: true, passive: true });
  document.addEventListener('pointercancel', () => release(false), { capture: true, passive: true });
  document.addEventListener('scroll', () => release(false), { capture: true, passive: true });
  document.addEventListener('dragstart', () => release(false), { capture: true, passive: true });
  // 고르는 동작(모드 전환 · 필터 · 스위치 · 확인)에는 가벼운 햅틱 — UISelectionFeedbackGenerator 자리
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('.ws-switch button, .filter-chip, .pmd-mode-switch, .sheet-form input[type="checkbox"], [data-yes], [data-haptic]')) haptic(6);
  });
  // iOS Safari 는 touchstart 리스너가 하나라도 있어야 :active 를 적용한다 (CSS :active 만 쓰는 곳 대비)
  document.addEventListener('touchstart', () => {}, { passive: true });

  // 오래 걸리는 버튼: 일이 끝날 때까지 흐리게 두고 다시 못 누르게 한다.
  async function busy(button, work) {
    if (!button) return work();
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
    try { return await work(); } finally { button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); }
  }

  window.UnivDash = { escapeHtml, api, toast, formatNumber, relativeTime, duration, formatDate, chartColors, typingOrBusy, plainKey, haptic, busy };
})();
