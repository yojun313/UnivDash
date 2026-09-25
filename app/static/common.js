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

  window.UnivDash = { escapeHtml, api, toast, formatNumber, relativeTime, duration, formatDate, chartColors, typingOrBusy, plainKey };
})();
