// UnivDash shared utilities (page scripts use them through window.UnivDash)
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
    // If the button just pressed started this request, mark that button as 'waiting' when the response is slow (120ms+)
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
    if (hapticLabel && hapticLabel.contains(event.target)) return;   // ignore the fake click used for haptics
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
      throw new Error(t('로그인이 필요합니다.'));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : t('요청이 실패했습니다.');
      throw new Error(detail);
    }
    return data;
  }

  // ── This-device settings (settings window) ────────────────────────────
  // Values that differ per device live in localStorage. Changes are announced to open screens with the 'univdash:settings' event.
  const SETTING_DEFAULTS = {
    'notify-agents': true, 'notify-desktop': true, 'notify-git': true, haptics: true, 'editor-font': 13,
    // Sidebar: OVERVIEW number cards, server status (sysmon.js)
    'show-overview': true,
    'sysmon-cpu': true, 'sysmon-gpu': true, 'sysmon-mem': true, 'sysmon-disk': true, 'sysmon-net': false, 'sysmon-interval': 2, 'sysmon-detail': false,
  };
  const settings = {
    defaults: SETTING_DEFAULTS,
    get(key) {
      try { const raw = localStorage.getItem(`univdash-set-${key}`); return raw === null ? SETTING_DEFAULTS[key] : JSON.parse(raw); } catch (e) { return SETTING_DEFAULTS[key]; }
    },
    set(key, value) {
      try { localStorage.setItem(`univdash-set-${key}`, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
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
  // Settings changed in another tab are followed right away
  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith('univdash-')) return;
    applySettings();
    window.dispatchEvent(new CustomEvent('univdash:settings', { detail: { key: event.key.replace(/^univdash-(set-)?/, '') } }));
  });

  // ── File upload ───────────────────────────────────────────────────────
  // Up to 32MB goes in one request; larger files are sent in 32MB chunks in order (up to the configured maximum, regardless of the proxy's request size limit).
  // kind: 'attach' (prompt attachment · /api/uploads) | 'fs' (file explorer · dir, rel). onProgress(0~1).
  // Returns { promise, abort } — the promise resolves with the server response (JSON) and rejects with Error(.status, .aborted).
  const UPLOAD_CHUNK = 32 * 1024 * 1024;
  function uploadFile(file, { kind = 'attach', dir = '', rel = '', name = file.name, type = file.type, onProgress } = {}) {
    let current = null;
    let aborted = false;
    let token = null;
    const fail = (message, status = 0) => Object.assign(new Error(message), { status, aborted });
    const send = (method, url, body, headers = {}, progress) => new Promise((resolve, reject) => {
      if (aborted) { reject(fail(t('업로드를 취소했습니다.'))); return; }
      const xhr = new XMLHttpRequest();
      current = xhr;
      xhr.open(method, url);
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      if (progress) xhr.upload.onprogress = (event) => { if (event.lengthComputable) progress(event.loaded); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* noop */ }
        if (xhr.status === 401) { location.href = '/login'; reject(fail(t('로그인이 필요합니다.'), 401)); return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(fail(typeof data.detail === 'string' ? data.detail : t('업로드 실패 ({status})', { status: xhr.status }), xhr.status), { data }));
      };
      xhr.onerror = () => reject(fail(t('네트워크 오류')));
      xhr.onabort = () => reject(fail(t('업로드를 취소했습니다.')));
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
          // Out of order (409): continue from where the server got to; on a brief network drop, resend the same chunk a few times
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
      if (token) fetch(`/api/uploads/chunked/${token}`, { method: 'DELETE' }).catch(() => {});   // clean up leftover chunks
      throw error;
    });
    return { promise, abort() { aborted = true; current?.abort(); } };
  }

  // ── File explorer uploads: one list for the whole site, with a progress panel on every page ──
  // The service worker does the uploading, so an upload carries on when this page goes to another page (the next
  // page shows the same panel). Without a service worker (plain http, very first visit) the page uploads itself;
  // the panel is the same, and leaving the page asks first because the upload would stop.
  // add(file, { dir, rel, name }) → { promise, abort } — like uploadFile.
  const uploads = (() => {
    const local = new Map();    // uploaded by this page
    let remote = [];            // uploaded by the service worker (latest list it sent)
    const lost = new Map();     // worker uploads that vanished (the worker was stopped)
    const waiting = new Map();  // id → { resolve, reject } of uploads this page started
    const known = new Set();    // ids the worker has reported at least once
    let collapsed = false;
    let hideTimer = null;
    let seq = 0;
    const sw = () => (window.isSecureContext && navigator.serviceWorker?.controller) || null;
    const active = (u) => u.status === 'queued' || u.status === 'uploading';
    const all = () => [...remote, ...lost.values(), ...local.values()];
    const size = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
    const failure = (u) => Object.assign(new Error(u.error || (u.status === 'aborted' ? t('업로드를 취소했습니다.') : u.status_code ? t('업로드 실패 ({status})', { status: u.status_code }) : t('네트워크 오류'))), { status: u.status_code || 0, aborted: u.status === 'aborted' });

    function settle(u) {
      const wait = waiting.get(u.id);
      if (!wait || active(u)) return;
      waiting.delete(u.id);
      if (u.status === 'done') wait.resolve(u.result || {}); else wait.reject(failure(u));
    }
    function panel() {
      let el = document.getElementById('uploadPanel');
      if (el) return el;
      el = document.createElement('section');
      el.id = 'uploadPanel';
      el.className = 'upload-panel';
      el.setAttribute('aria-live', 'polite');
      el.addEventListener('click', (event) => {
        const cancel = event.target.closest('[data-up-cancel]');
        if (cancel) { abort(cancel.dataset.upCancel); return; }
        if (event.target.closest('[data-up-close]')) { clear(); return; }
        if (event.target.closest('[data-up-toggle]')) { collapsed = !collapsed; render(); }
      });
      document.body.appendChild(el);
      return el;
    }
    function render() {
      const list = all();
      const el = list.length ? panel() : document.getElementById('uploadPanel');
      if (!el) return;
      if (!list.length) { el.remove(); return; }
      const running = list.filter(active);
      const failed = list.filter((u) => u.status === 'error').length;
      const done = list.filter((u) => u.status === 'done').length;
      const total = list.reduce((sum, u) => sum + (u.size || 0), 0);
      const sent = list.reduce((sum, u) => sum + (u.status === 'done' ? u.size || 0 : u.sent || 0), 0);
      const pct = total ? Math.floor((sent / total) * 100) : 100;
      const title = running.length
        ? t('업로드 중 {done}/{total} · {pct}%', { done, total: list.length, pct })
        : failed ? t('업로드 {done}개 완료 · {failed}개 실패', { done, failed }) : t('업로드 {done}개 완료', { done });
      const row = (u) => {
        const ratio = u.status === 'done' ? 100 : u.size ? Math.floor(((u.sent || 0) / u.size) * 100) : 0;
        const state = u.status === 'uploading' ? `${ratio}% · ${size(u.size || 0)}`
          : u.status === 'queued' ? t('업로드 대기 중')
            : u.status === 'done' ? size(u.size || 0)
              : u.status === 'aborted' ? t('취소됨') : (failure(u).message);
        const icon = u.status === 'done' ? '<i class="fas fa-circle-check up-ok"></i>'
          : u.status === 'error' ? '<i class="fas fa-circle-exclamation up-err"></i>'
            : u.status === 'aborted' ? '<i class="fas fa-ban up-off"></i>'
              : `<button type="button" data-up-cancel="${escapeHtml(u.id)}" title="${t('업로드 취소')}" aria-label="${t('업로드 취소')}"><i class="fas fa-xmark"></i></button>`;
        return `<li class="up-row ${u.status}" title="${escapeHtml(`${u.dir || ''}${u.rel ? `/${u.rel}` : ''}/${u.name}`)}">
            <span class="up-name">${escapeHtml(u.name)}</span><span class="up-state">${escapeHtml(state)}</span>${icon}
            <span class="up-bar"><span style="width:${active(u) ? ratio : 0}%"></span></span></li>`;
      };
      // running ones first, then the most recent
      const ordered = [...list].sort((a, b) => Number(active(b)) - Number(active(a)));
      el.classList.toggle('collapsed', collapsed);
      el.innerHTML = `<header><button type="button" data-up-toggle class="up-title"><i class="fas ${running.length ? 'fa-arrow-up-from-bracket' : failed ? 'fa-circle-exclamation up-err' : 'fa-circle-check up-ok'}"></i><span>${escapeHtml(title)}</span><i class="fas fa-chevron-${collapsed ? 'up' : 'down'} up-chev"></i></button>
          ${running.length ? '' : `<button type="button" data-up-close title="${t('닫기')}" aria-label="${t('닫기')}"><i class="fas fa-xmark"></i></button>`}</header>
        <span class="up-bar up-total"><span style="width:${running.length ? pct : 0}%"></span></span>
        <ul>${ordered.slice(0, 60).map(row).join('')}</ul>`;
      clearTimeout(hideTimer);
      // everything went through: the panel goes away by itself (failures stay until closed)
      if (!running.length && !failed) hideTimer = setTimeout(clear, 6000);
    }
    function clear() {
      for (const [id, u] of local) if (!active(u)) local.delete(id);
      lost.clear();
      sw()?.postMessage({ type: 'univdash-upload-clear' });
      remote = remote.filter(active);
      render();
    }
    function abort(id) {
      const mine = local.get(id);
      if (mine) mine.job?.abort(); else sw()?.postMessage({ type: 'univdash-upload-cancel', id });
    }
    function add(file, { dir = '', rel = '', name = file.name } = {}) {
      const id = `${Date.now().toString(36)}-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`;
      const worker = sw();
      if (worker) {
        const promise = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
        remote.push({ id, name, size: file.size, sent: 0, status: 'queued', error: '', dir, rel });
        worker.postMessage({ type: 'univdash-upload-add', items: [{ id, file, name, dir, rel }] });
        render();
        return { promise, abort: () => abort(id) };
      }
      const entry = { id, name, size: file.size, sent: 0, status: 'uploading', error: '', dir, rel };
      local.set(id, entry);
      let last = 0;
      entry.job = uploadFile(file, { kind: 'fs', dir, rel, name, onProgress: (ratio) => {
        entry.sent = Math.round(ratio * file.size);
        if (Date.now() - last > 200) { last = Date.now(); render(); }
      } });
      const promise = entry.job.promise.then((data) => { Object.assign(entry, { status: 'done', sent: file.size }); render(); return data; }, (error) => {
        Object.assign(entry, { status: error.aborted ? 'aborted' : 'error', error: error.aborted ? '' : error.message, status_code: error.status });
        render();
        throw error;
      });
      render();
      return { promise, abort: () => abort(id) };
    }

    if (window.isSecureContext && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type !== 'univdash-uploads' || !Array.isArray(event.data.list)) return;
        const now = new Map(event.data.list.map((u) => [u.id, u]));
        // an upload the worker no longer knows while it was still running: the worker was stopped
        for (const u of remote) if (active(u) && known.has(u.id) && !now.has(u.id) && !lost.has(u.id)) lost.set(u.id, { ...u, status: 'error', error: t('업로드가 중단되었습니다.') });
        // uploads this page has just handed over and the worker has not listed yet stay as they are
        const fresh = remote.filter((u) => !known.has(u.id) && !now.has(u.id));
        event.data.list.forEach((u) => known.add(u.id));
        remote = [...event.data.list, ...fresh];
        remote.forEach(settle);
        lost.forEach(settle);
        render();
      });
      const ping = () => sw()?.postMessage({ type: 'univdash-upload-ping' });
      navigator.serviceWorker.ready.then(ping).catch(() => {});
      navigator.serviceWorker.addEventListener('controllerchange', ping);
      // keeps the worker running while it uploads, and notices if it stopped
      setInterval(() => { if (remote.some(active)) ping(); }, 15000);
    }
    window.addEventListener('beforeunload', (event) => {
      if ([...local.values()].some(active)) { event.preventDefault(); event.returnValue = ''; }
    });
    return { add, active: () => all().some(active) };
  })();

  // Shown in the layout's #toastHost with the .toast look from app.css (same look as Workspace notifications).
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

  // ── Completion notice for the automatic Git flow (ruff · AI commit · push) ──
  // The flow runs as a separate process on the server, so it continues after leaving the page. On any UnivDash page,
  // status is polled (every 2s) only while a job is running, and completion is announced once. Announced job ids are stored
  // so the same notice does not appear again on another page or tab, and jobs that finished while away (within 10 minutes) are announced on return.
  const gitWorkflows = (() => {
    const SEEN = 'univdash-git-wf-seen';
    const ACTIVE = 'univdash-git-wf-active';
    const listeners = new Set();
    const later = [];
    let jobs = [];
    let timer = 0;
    let polling = false;
    const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; } };
    const write = (key, value) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* works even when it cannot be stored */ } };
    function show(job) {
      const where = job.branch ? `${job.repository} (${job.branch})` : job.repository;
      if (job.status === 'done') {
        if (!settings.get('notify-git')) return;
        const subject = (job.message || '').split('\n')[0];
        toast(`${t('{where} 푸시 완료', { where })}${subject ? `\n${subject}` : ''}`, 'success', 7000);
      } else {
        toast(t('{where} 자동 커밋이 멈췄습니다:{error}', { where, error: job.error || t('알 수 없는 오류') }), 'error', 9000);
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
      listeners.forEach((fn) => { try { fn(jobs); } catch (e) { /* other subscribers carry on */ } });
      if (running) timer = setTimeout(poll, document.hidden ? 6000 : 2000);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      later.splice(0).forEach(show);
      if (read(ACTIVE, null)) poll();
    });
    // When a flow starts in another tab, this tab watches it too
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
    return amount.toLocaleString(t.locale);
  }

  function relativeTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    const future = seconds < 0;
    const abs = Math.abs(seconds);
    if (abs < 60) return future ? t('{n}초 후', { n: abs }) : t('{n}초 전', { n: abs });
    if (abs < 3600) { const n = Math.floor(abs / 60); return future ? t('{n}분 후', { n }) : t('{n}분 전', { n }); }
    if (abs < 86400) { const n = Math.floor(abs / 3600); return future ? t('{n}시간 후', { n }) : t('{n}시간 전', { n }); }
    const n = Math.floor(abs / 86400);
    return future ? t('{n}일 후', { n }) : t('{n}일 전', { n });
  }

  function duration(ms) {
    if (ms <= 0) return t('곧');
    const minutes = Math.floor(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return t('{days}일 {hours}시간', { days, hours });
    if (hours > 0) return t('{hours}시간 {mins}분', { hours, mins });
    return t('{mins}분', { mins });
  }

  function formatDate(value, withYear = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '—';
    return new Intl.DateTimeFormat(t.locale, {
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

  // For shortcuts: whether the user is typing right now (input, editor, terminal, direct input mode) or a sheet / menu is open
  function typingOrBusy(event) {
    const el = event.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest?.('.xterm'))) return true;
    const sheet = document.getElementById('sheetOverlay');
    if (sheet && !sheet.hidden) return true;
    // Only open (visible) menus — hidden menu elements (Git page, etc.) are ignored
    return [...document.querySelectorAll('.git-menu, .ex-menu')].some((menu) => !menu.classList.contains('hidden') && menu.offsetParent !== null);
  }
  // The same physical key regardless of Korean/English input (w · ㅈ): judged by event.code
  function plainKey(event, code) {
    return event.code === code && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.isComposing && !event.repeat;
  }

  // ── Press feedback like an iPhone app ───────────────────────────────────────
  // Haptics: Android uses vibrate; iOS (18+) triggers the system haptic by clicking a hidden switch checkbox.
  // On iOS it only fires when called inside a user gesture (click/touchend) — after an await or in a timer it is silently ignored.
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
        // Keep this fake click from spreading into handlers such as "outside click → close menu"
        const stop = (event) => event.stopPropagation();
        hapticLabel.addEventListener('click', stop);
        box.addEventListener('click', stop);
        document.body.appendChild(hapticLabel);
      }
      hapticLabel.click();
    } catch (e) { /* noop */ }
  }

  // Pressed state: darkens the instant it is pressed (0ms) and returns slowly on release (200ms).
  // - Buttons immediately, list rows after 50ms (so rows do not flash under a finger that is about to scroll — the same approach as UITableView)
  // - Cancelled right away when the finger moves or scrolling starts
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
    // Pressing a small button inside a row (⋯, ✕) marks only that button, not the whole row (closest picks the innermost)
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
    // A quick tap on a row (released before 50ms) still shows the pressed state once
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
  // A light haptic for selection actions (mode switch, filter, switch, confirm) — stands in for UISelectionFeedbackGenerator
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('.ws-switch button, .filter-chip, .pmd-mode-switch, .sheet-form input[type="checkbox"], [data-yes], [data-haptic]')) haptic(6);
  });
  // Tab bar / sidebar navigation starts the moment the finger touches (like the iOS tab bar — saves the ~100ms spent waiting for release).
  // The selection mark moves right away too, so the pressed tab lights up before the server responds.
  let navTo = '';
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('.tabbar a.tab-item, a.nav-link');
    if (!link || link.getAttribute('aria-current') === 'page' || link.target) return;
    // On phones the sidebar is a scrolling drawer, so touch navigates on click as usual
    if (event.pointerType !== 'mouse' && !link.closest('.tabbar')) return;
    for (const other of document.querySelectorAll('.tabbar a.tab-item.active')) other.classList.remove('active');
    if (link.classList.contains('tab-item')) link.classList.add('active');
    navTo = link.href;
    location.href = link.href;
  }, { capture: true });
  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]');
    if (link && navTo && link.href === navTo) event.preventDefault();   // already navigating — do not navigate twice
  }, true);
  window.addEventListener('pageshow', () => { navTo = ''; });

  // iOS Safari applies :active only when at least one touchstart listener exists (for places that rely on CSS :active alone)
  document.addEventListener('touchstart', () => {}, { passive: true });

  // Long-running buttons: dimmed and not pressable again until the work finishes.
  async function busy(button, work) {
    if (!button) return work();
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
    try { return await work(); } finally { button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); }
  }

  // Math (shared by explorer markdown and chat): marked mangles TeX symbols such as \qquad · _ · \\, so formulas are pulled out into placeholders (KTXM0Z) before conversion
  // and rendered with KaTeX after marked → DOMPurify cleanup (KaTeX output uses trust:false, so links and HTML commands are blocked).
  // $ inside code blocks (``` ~~~) and inline code (`…`) is left alone.
  // Repairs TeX whose backslash was eaten as an escape (files written with plain Python strings: "\boxed" → backspace+"oxed", "\frac" → form feed+"rac" …)
  // The \a \b \f \v control characters never occur in prose so they are always restored; tab and CR only when a TeX command tail follows directly.
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
    const put = (tex, display) => { math.push({ tex: tex.trim(), display, nl: (tex.match(/\n/g) || []).length }); return `KTXM${math.length - 1}Z`; };   // nl: number of lines the placeholder swallowed (to keep preview lines aligned)
    const inText = (text) => text
      .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => put(tex, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => put(tex, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => put(tex, false))
      // $…$: only when there is no space after the opening $ or before the closing $, and no digit follows the closing $ (excludes amounts like $5 and $10)
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

  // Random ID that identifies this browser (for the web push subscription and for telling which device is being viewed). Where storage is blocked, a new one is made per tab.
  let deviceIdCache = null;
  function deviceId() {
    if (deviceIdCache) return deviceIdCache;
    try { deviceIdCache = localStorage.getItem('univdash-device-id'); } catch (e) { /* storage unavailable */ }
    if (!deviceIdCache || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceIdCache)) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      deviceIdCache = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem('univdash-device-id', deviceIdCache); } catch (e) { /* storage unavailable */ }
    }
    return deviceIdCache;
  }

  // Follows and reports the progress of applying a new Codex account (stop windows → update → restart).
  // If a Codex window is working, the server waits until it finishes and then does it automatically — it continues on the server after leaving the page.
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
          toast(t('작업 중인 Codex 창({waiting})이 끝나면 자동으로 업데이트하고 새 계정으로 다시 켭니다.', { waiting }), 'info', 7000);
        } else if (status.state === 'applying' && !shownApplying) {
          shownApplying = true;
          toast(t('Codex 창을 끄고 업데이트한 뒤 같은 대화로 다시 켜는 중…'), 'info', 5000);
        }
        setTimeout(() => request('/api/accounts/codex/apply').then(step, () => setTimeout(() => step(status), 4000)), status.state === 'waiting' ? 3000 : 1500);
        return;
      }
      if (status.state === 'error') { toast(status.error || t('Codex 창에 적용하지 못했습니다.'), 'error', 9000); return; }
      if (status.state === 'done') {
        const r = status.result || {};
        const after = r.after_stop || {};
        const parts = [];
        parts.push(r.relaunched?.length ? t('Codex 창 {count}개를 같은 대화로 다시 켰습니다', { count: r.relaunched.length }) : t('다시 켤 Codex 창이 없었습니다'));
        if (after.updated === true) parts.push(t('Codex 를 최신으로 업데이트했습니다'));
        else if (after.updated === false) parts.push(t('업데이트는 실패했습니다 (기존 버전으로 켰습니다)'));
        if (r.skipped?.length) parts.push(t('직접 다시 켜야 하는 창: {names}', { names: r.skipped.join(', ') }));
        toast(`${parts.join(' · ')}.`, r.skipped?.length || after.updated === false ? 'warn' : 'success', 8000);
        window.dispatchEvent(new CustomEvent('univdash:codex-applied', { detail: status }));
      }
    };
    step(first);
  }

  window.UnivDash = { deviceId, followCodexApply, escapeHtml, api, toast, gitWorkflows, settings, uploadFile, uploads, formatNumber, relativeTime, duration, formatDate, chartColors, typingOrBusy, plainKey, haptic, busy, math: { extract: extractMath, render: renderMath } };
})();
