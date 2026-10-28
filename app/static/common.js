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

  // ── 이 기기 설정 (설정 창) ─────────────────────────────────────────────
  // 기기마다 다르게 둘 값은 localStorage 에 둔다. 바뀌면 'univdash:settings' 이벤트로 열린 화면에 알린다.
  const SETTING_DEFAULTS = {
    'notify-agents': true, 'notify-desktop': true, 'notify-git': true, haptics: true, 'editor-font': 13,
    // 사이드바: OVERVIEW 숫자 카드, 서버 상태 (sysmon.js)
    'show-overview': true,
    'sysmon-cpu': true, 'sysmon-gpu': true, 'sysmon-mem': true, 'sysmon-disk': true, 'sysmon-net': false, 'sysmon-interval': 2, 'sysmon-detail': false,
  };
  const settings = {
    defaults: SETTING_DEFAULTS,
    get(key) {
      try { const raw = localStorage.getItem(`univdash-set-${key}`); return raw === null ? SETTING_DEFAULTS[key] : JSON.parse(raw); } catch (e) { return SETTING_DEFAULTS[key]; }
    },
    set(key, value) {
      try { localStorage.setItem(`univdash-set-${key}`, JSON.stringify(value)); } catch (e) { /* 저장 불가 환경 */ }
      applySettings();
      window.dispatchEvent(new CustomEvent('univdash:settings', { detail: { key, value } }));
    },
  };
  function applySettings() {
    const font = Number(settings.get('editor-font'));
    document.documentElement.style.setProperty('--editor-font', `${Number.isFinite(font) ? Math.min(20, Math.max(10, font)) : 13}px`);
    document.documentElement.classList.toggle('hide-overview', !settings.get('show-overview'));
  }
  applySettings();
  // 다른 탭에서 바꾼 설정도 바로 따른다
  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith('univdash-')) return;
    applySettings();
    window.dispatchEvent(new CustomEvent('univdash:settings', { detail: { key: event.key.replace(/^univdash-(set-)?/, '') } }));
  });

  // ── 파일 올리기 ────────────────────────────────────────────────────────
  // 32MB 이하는 한 번에, 더 크면 32MB 조각으로 나눠 차례로 보낸다 (프록시의 요청 크기 제한과 상관없이 설정한 최대 크기까지).
  // kind: 'attach'(프롬프트 첨부 · /api/uploads) | 'fs'(파일 탐색기 · dir, rel). onProgress(0~1).
  // 돌려주는 값: { promise, abort } — promise 는 서버 응답(JSON)으로 끝나고, 실패하면 Error(.status, .aborted).
  const UPLOAD_CHUNK = 32 * 1024 * 1024;
  function uploadFile(file, { kind = 'attach', dir = '', rel = '', name = file.name, type = file.type, onProgress } = {}) {
    let current = null;
    let aborted = false;
    let token = null;
    const fail = (message, status = 0) => Object.assign(new Error(message), { status, aborted });
    const send = (method, url, body, headers = {}, progress) => new Promise((resolve, reject) => {
      if (aborted) { reject(fail('업로드를 취소했어요.')); return; }
      const xhr = new XMLHttpRequest();
      current = xhr;
      xhr.open(method, url);
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      if (progress) xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(event.loaded); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* noop */ }
        if (xhr.status === 401) { location.href = '/login'; reject(fail('로그인이 필요합니다.', 401)); return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(fail(typeof data.detail === 'string' ? data.detail : `업로드 실패 (${xhr.status})`, xhr.status), { data }));
      };
      xhr.onerror = () => reject(fail('네트워크 오류'));
      xhr.onabort = () => reject(fail('업로드를 취소했어요.'));
      xhr.send(body);
    });
    const report = (n) => onProgress?.(file.size ? Math.min(1, n / file.size) : 1);
    async function single() {
      const url = kind === 'fs' ? `/api/fs/upload?dir=${encodeURIComponent(dir)}` : '/api/uploads';
      const headers = { 'X-Filename': encodeURIComponent(name), 'Content-Type': (kind === 'attach' && type) || 'application/octet-stream' };
      if (kind === 'fs' && rel) headers['X-Relative-Dir'] = encodeURIComponent(rel);
      return send('POST', url, file, headers, report);
    }
    async function chunked() {
      const json = { 'Content-Type': 'application/json' };
      const started = await send('POST', '/api/uploads/chunked', JSON.stringify({ size: file.size, name, kind, dir, rel }), json);
      token = started.token;
      const size = started.chunk_bytes || UPLOAD_CHUNK;
      let offset = 0;
      let retries = 0;
      while (offset < file.size) {
        const end = Math.min(file.size, offset + size);
        try {
          const done = await send('PUT', `/api/uploads/chunked/${token}?offset=${offset}`, file.slice(offset, end), { 'Content-Type': 'application/octet-stream' }, (n) => report(offset + n));
          offset = done.received;
          retries = 0;
        } catch (error) {
          if (aborted) throw error;
          // 순서가 어긋났으면(409) 서버가 받은 곳부터, 네트워크가 잠깐 끊겼으면 같은 조각을 몇 번 다시 보낸다
          if (error.status === 409 && Number.isFinite(error.data?.received)) { offset = error.data.received; continue; }
          if ((error.status === 0 || error.status >= 500) && retries < 4) { retries += 1; await new Promise((r) => setTimeout(r, 1000 * retries)); continue; }
          throw error;
        }
        report(offset);
      }
      const result = await send('POST', `/api/uploads/chunked/${token}/finish`, null);
      token = null;
      return result;
    }
    const promise = (file.size > UPLOAD_CHUNK ? chunked() : single()).catch((error) => {
      if (token) fetch(`/api/uploads/chunked/${token}`, { method: 'DELETE' }).catch(() => {});   // 남은 조각 정리
      throw error;
    });
    return { promise, abort() { aborted = true; current?.abort(); } };
  }

  // 레이아웃의 #toastHost 에 app.css 의 .toast 모양으로 띄운다 (Workspace 알림과 같은 모양).
  function toast(message, type = 'info', timeout = 0) {
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
    setTimeout(() => item.remove(), timeout || (kind === 'error' ? 6000 : 3500));
  }

  // ── Git 자동 흐름(ruff · AI 커밋 · 푸시) 완료 알림 ─────────────────────────
  // 흐름은 서버에서 별도 프로세스로 돌아서 페이지를 떠나도 계속된다. UnivDash 의 어느 페이지에 있든
  // 도는 작업이 있을 때만 상태를 확인하고(2초), 끝나면 한 번 알린다. 알린 작업 id 는 저장해 두어
  // 다른 페이지 · 탭에서 같은 알림이 또 뜨지 않게 하고, 떠나 있던 사이 끝난 작업(10분 이내)은 돌아왔을 때 알린다.
  const gitWorkflows = (() => {
    const SEEN = 'univdash-git-wf-seen';
    const ACTIVE = 'univdash-git-wf-active';
    const listeners = new Set();
    const later = [];
    let jobs = [];
    let timer = 0;
    let polling = false;
    const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; } };
    const write = (key, value) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 저장 못 해도 동작 */ } };
    function show(job) {
      const where = job.branch ? `${job.repository} (${job.branch})` : job.repository;
      if (job.status === 'done') {
        if (!settings.get('notify-git')) return;
        const subject = (job.message || '').split('\n')[0];
        toast(`${where} 푸시 완료${subject ? `\n${subject}` : ''}`, 'success', 7000);
      } else {
        toast(`${where} 자동 커밋이 멈췄어요: ${job.error || '알 수 없는 오류'}`, 'error', 9000);
      }
    }
    function notify(job) {
      if (document.hidden) later.push(job); else show(job);
    }
    async function poll() {
      if (polling) return;
      polling = true;
      clearTimeout(timer);
      try {
        jobs = (await request('/api/git/workflows')).jobs || [];
      } catch (e) {
        polling = false;
        timer = setTimeout(poll, 8000);
        return;
      }
      polling = false;
      const seen = read(SEEN, []);
      const now = Date.now() / 1000;
      for (const job of jobs) {
        if (job.status === 'running' || seen.includes(job.id)) continue;
        if (now - (job.finished || 0) < 600) notify(job);
        seen.push(job.id);
      }
      write(SEEN, seen.slice(-80));
      const running = jobs.some((job) => job.status === 'running');
      write(ACTIVE, running ? 1 : null);
      listeners.forEach((fn) => { try { fn(jobs); } catch (e) { /* 다른 구독자는 계속 */ } });
      if (running) timer = setTimeout(poll, document.hidden ? 6000 : 2000);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      later.splice(0).forEach(show);
      if (read(ACTIVE, null)) poll();
    });
    // 다른 탭에서 흐름을 시작하면 이 탭도 지켜본다
    window.addEventListener('storage', (event) => { if (event.key === ACTIVE && event.newValue) poll(); });
    const begin = () => { if (document.getElementById('toastHost') && (read(ACTIVE, null) || listeners.size)) poll(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin); else begin();
    return {
      poll,
      jobs: () => jobs,
      started(job) { if (job) jobs = [job, ...jobs.filter((j) => j.id !== job.id)]; write(ACTIVE, 1); poll(); },
      subscribe(fn) { listeners.add(fn); fn(jobs); return () => listeners.delete(fn); },
    };
  })();

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
    if (!settings.get('haptics')) return;
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
  // - 버튼은 즉시, 목록 줄은 50ms 뒤에 (스크롤하려고 댄 손가락에 줄이 번쩍이지 않게 — UITableView 와 같은 방식)
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
    if (event.pointerType !== 'mouse' && target.matches(ROW)) pressTimer = setTimeout(() => pressed?.classList.add('is-pressed'), 50);
    else target.classList.add('is-pressed');
  }, { capture: true, passive: true });
  document.addEventListener('pointermove', (event) => {
    if (!pressed || !pressStart) return;
    if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) release(false);
  }, { capture: true, passive: true });
  document.addEventListener('pointerup', () => {
    // 줄을 짧게 톡 친 경우(50ms 전에 뗌)도 눌림을 한 번 보여 준다
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
  // 탭바 · 사이드바 이동은 손가락이 닿는 순간 시작한다 (iOS 탭바처럼 — 떼기를 기다리는 ~100ms 절약).
  // 선택 표시도 바로 옮겨서 서버 응답 전에 눌린 탭이 켜진다.
  let navTo = '';
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('.tabbar a.tab-item, a.nav-link');
    if (!link || link.getAttribute('aria-current') === 'page' || link.target) return;
    // 사이드바는 휴대폰에서 스크롤되는 서랍이라 터치는 평소처럼 click 에서
    if (event.pointerType !== 'mouse' && !link.closest('.tabbar')) return;
    for (const other of document.querySelectorAll('.tabbar a.tab-item.active')) other.classList.remove('active');
    if (link.classList.contains('tab-item')) link.classList.add('active');
    navTo = link.href;
    location.href = link.href;
  }, { capture: true });
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (link && navTo && link.href === navTo) event.preventDefault();   // 이미 이동 중 — 두 번 이동하지 않게
  }, true);
  window.addEventListener('pageshow', () => { navTo = ''; });

  // iOS Safari 는 touchstart 리스너가 하나라도 있어야 :active 를 적용한다 (CSS :active 만 쓰는 곳 대비)
  document.addEventListener('touchstart', () => {}, { passive: true });

  // 오래 걸리는 버튼: 일이 끝날 때까지 흐리게 두고 다시 못 누르게 한다.
  async function busy(button, work) {
    if (!button) return work();
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
    try { return await work(); } finally { button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); }
  }

  // 수식 (탐색기 마크다운 · 채팅 공용): marked 가 \qquad · _ · \\ 같은 TeX 기호를 망가뜨리므로, 변환 전에 수식을 자리표시(KTXM0Z)로 빼 두고
  // marked → DOMPurify 정리가 끝난 뒤 KaTeX 로 그려 넣는다 (KaTeX 결과는 trust:false 라 링크 · HTML 명령이 막혀 있다).
  // 코드 블록(``` ~~~)과 인라인 코드(`…`) 안의 $ 는 건드리지 않는다.
  // 백슬래시가 이스케이프로 먹힌 TeX 복구 (파이썬 일반 문자열로 쓴 파일: "\boxed" → 백스페이스+"oxed", "\frac" → 폼피드+"rac" …)
  // \a \b \f \v 제어 문자는 글에 올 일이 없어 항상, 탭 · CR 은 TeX 명령 꼬리가 바로 이어질 때만 되돌린다.
  function repairTexEscapes(src) {
    return src
      .replace(/[\x07\x08\x0b\x0c](?=[A-Za-z])/g, (c) => `\\${{ '\x07': 'a', '\x08': 'b', '\x0b': 'v', '\x0c': 'f' }[c]}`)
      .replace(/\t(?=(?:heta|imes|ext|extbf|extit|ilde|au|op|riangle|herefore|frac|o\b))/g, '\\t')
      .replace(/\r(?=(?:ho|ight|angle|ceil|floor|vert|Vert|m\b|m\{))/g, '\\r');
  }
  function extractMath(src) {
    src = repairTexEscapes(src);
    const math = [];
    if (!window.katex || !/\$|\\\(|\\\[/.test(src)) return { text: src, math };
    const put = (tex, display) => { math.push({ tex: tex.trim(), display, nl: (tex.match(/\n/g) || []).length }); return `KTXM${math.length - 1}Z`; };   // nl: 자리표시가 삼킨 줄 수 (미리보기 줄 맞추기)
    const inText = (text) => text
      .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => put(tex, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => put(tex, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => put(tex, false))
      // $…$: 여는 $ 뒤 · 닫는 $ 앞에 공백이 없고, 닫는 $ 뒤가 숫자가 아닐 때만 ($5 와 $10 같은 금액 제외)
      .replace(/(^|[^\\$])\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<!\s)\$(?!\d)/g, (m, pre, tex) => pre + put(tex, false));
    const text = src.split(/(^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$)/m)
      .map((part, i) => (i % 2 ? part : part.split(/(`+[^`\n]*?`+)/).map((piece, j) => (j % 2 ? piece : inText(piece))).join('')))
      .join('');
    return { text, math };
  }
  function renderMath(html, math) {
    if (!math.length) return html;
    return html.replace(/KTXM(\d+)Z/g, (m, index) => {
      const item = math[Number(index)];
      if (!item) return m;
      try {
        return window.katex.renderToString(item.tex, { displayMode: item.display, throwOnError: false, trust: false, strict: 'ignore', maxSize: 50, maxExpand: 1000, output: 'htmlAndMathml' });
      } catch (e) { return `<code>${escapeHtml(item.tex)}</code>`; }
    });
  }

  // 이 브라우저를 구분하는 임의 ID (웹 푸시 구독 · 지금 보고 있는 기기 판단용). 저장이 막힌 환경에서는 탭마다 새로 만든다.
  let deviceIdCache = null;
  function deviceId() {
    if (deviceIdCache) return deviceIdCache;
    try { deviceIdCache = localStorage.getItem('univdash-device-id'); } catch (e) { /* 저장 불가 */ }
    if (!deviceIdCache || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceIdCache)) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      deviceIdCache = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem('univdash-device-id', deviceIdCache); } catch (e) { /* 저장 불가 */ }
    }
    return deviceIdCache;
  }

  // Codex 새 계정 적용(창 끄기 → 업데이트 → 다시 켜기) 진행을 따라가며 알려 준다.
  // 작업 중인 Codex 창이 있으면 서버가 끝날 때까지 기다렸다가 자동으로 한다 — 페이지를 떠나도 서버에서는 계속된다.
  let applyWatch = 0;
  function followCodexApply(first) {
    const my = ++applyWatch;
    const seq = first?.seq;
    let shownWaiting = null;
    let shownApplying = false;
    const step = (status) => {
      if (my !== applyWatch || !status || (seq != null && status.seq !== seq)) return;
      if (status.state === 'waiting' || status.state === 'applying') {
        const waiting = (status.waiting || []).join(', ');
        if (status.state === 'waiting' && waiting && waiting !== shownWaiting) {
          shownWaiting = waiting;
          toast(`작업 중인 Codex 창(${waiting})이 끝나면 자동으로 업데이트하고 새 계정으로 다시 켜요.`, 'info', 7000);
        } else if (status.state === 'applying' && !shownApplying) {
          shownApplying = true;
          toast('Codex 창을 끄고 업데이트한 뒤 같은 대화로 다시 켜는 중…', 'info', 5000);
        }
        setTimeout(() => request('/api/accounts/codex/apply').then(step, () => setTimeout(() => step(status), 4000)), status.state === 'waiting' ? 3000 : 1500);
        return;
      }
      if (status.state === 'error') { toast(status.error || 'Codex 창에 적용하지 못했어요.', 'error', 9000); return; }
      if (status.state === 'done') {
        const r = status.result || {};
        const after = r.after_stop || {};
        const parts = [];
        parts.push(r.relaunched?.length ? `Codex 창 ${r.relaunched.length}개를 같은 대화로 다시 켰어요` : '다시 켤 Codex 창이 없었어요');
        if (after.updated === true) parts.push('Codex 를 최신으로 업데이트했어요');
        else if (after.updated === false) parts.push('업데이트는 실패했어요 (기존 버전으로 켰어요)');
        if (r.skipped?.length) parts.push(`직접 다시 켜야 하는 창: ${r.skipped.join(', ')}`);
        toast(`${parts.join(' · ')}.`, r.skipped?.length || after.updated === false ? 'warn' : 'success', 8000);
        window.dispatchEvent(new CustomEvent('univdash:codex-applied', { detail: status }));
      }
    };
    step(first);
  }

  window.UnivDash = { deviceId, followCodexApply, escapeHtml, api, toast, gitWorkflows, settings, uploadFile, formatNumber, relativeTime, duration, formatDate, chartColors, typingOrBusy, plainKey, haptic, busy, math: { extract: extractMath, render: renderMath } };
})();
