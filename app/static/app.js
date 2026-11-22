// ============================================================================
// UnivDash client
// - Workspace: window list + terminal screen + prompt/key input (mobile first)
// - Window organization: folders, order (drag), hiding, display names
// Talks to the server in real time over a single /ws; only the organization settings are saved over REST (/api/preferences).
// ============================================================================
(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const page = document.body.dataset.page;
  const desktopQuery = window.matchMedia('(min-width: 1024px)');
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const SOLO = document.documentElement.classList.contains('ws-solo');   // popup window showing a single tab (theme-boot.js)

  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(`univdash-${key}`); return raw === null ? fallback : JSON.parse(raw); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`univdash-${key}`, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    },
  };

  function chatLiveKey(agent) { return agent === 'codex' ? 'chat-live-codex' : 'chat-live'; }
  function chatLiveOpen(agent) { return store.get(chatLiveKey(agent), agent !== 'codex'); }
  function toggleChatLive(agent) { store.set(chatLiveKey(agent), !chatLiveOpen(agent)); }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function timeAgo(epochSeconds) {
    if (!epochSeconds) return '';
    const diff = Math.max(0, Date.now() / 1000 - epochSeconds);
    if (diff < 45) return t('방금');
    if (diff < 3600) return t('{n}분 전', { n: Math.round(diff / 60) });
    if (diff < 86400) return t('{n}시간 전', { n: Math.round(diff / 3600) });
    return t('{n}일 전', { n: Math.round(diff / 86400) });
  }

  // Android vibrates, iPhone uses the system haptic (common.js · fires only inside a user tap)
  const vibrate = (ms = 8) => window.UnivDash.haptic(ms);

  // ── Toast ──────────────────────────────────────────────────────────
  function toast(message, kind = 'info', action = null, timeout = 3200) {
    const host = $('#toastHost');
    if (!host) return;
    const icons = { info: 'fa-circle-info', ok: 'fa-circle-check', error: 'fa-circle-exclamation', warn: 'fa-hand' };
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<i class="fas ${icons[kind] || icons.info}"></i><span class="min-w-0 flex-1">${escapeHtml(message)}</span>`;
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => { el.remove(); action.onClick(); });
      el.appendChild(button);
    }
    host.appendChild(el);
    while (host.children.length > 3) host.firstElementChild.remove();
    setTimeout(() => el.remove(), timeout);
  }

  // ── Viewport: use the actually visible height so the input stays visible when the mobile keyboard is up ──────
  const isEditable = (el) => !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable
    || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file', 'range'].includes(el.type)));
  let lastViewportHeight = 0;

  function syncViewport() {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const typing = coarsePointer && isEditable(document.activeElement);
    const visible = vv ? vv.height : window.innerHeight;
    // Normally use the whole app area (100%). While the keyboard is up (an input is focused or the visible area shrank),
    // iOS keeps the layout size and only shrinks the visible area, so fit to that area to keep the input above the keyboard.
    const keyboard = !!vv && (typing || window.innerHeight - vv.height > 80);
    root.style.setProperty('--app-h', keyboard ? `${Math.round(visible)}px` : '100%');
    root.style.setProperty('--vv-top', keyboard ? `${Math.round(vv.offsetTop)}px` : '0px');
    root.classList.toggle('kb-open', typing);
    // Keep the document itself from scrolling (undo iOS pushing the page up to reveal the input)
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    // When the keyboard shrinks the screen, scroll the focused field into view inside its scroll container
    if (visible < lastViewportHeight && typing) {
      const el = document.activeElement;
      requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
    lastViewportHeight = visible;
  }
  syncViewport();
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  window.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); }, { passive: true });

  // Phone: flag while the keyboard is up (hides the tab bar), block pinch zoom · double-tap zoom
  if (coarsePointer) {
    // resize sometimes does not fire during the keyboard show/hide animation, so measure again a few times
    const resyncSoon = () => [0, 100, 300, 600].forEach((ms) => setTimeout(syncViewport, ms));
    document.addEventListener('focusin', resyncSoon);
    document.addEventListener('focusout', resyncSoon);
    window.addEventListener('orientationchange', resyncSoon);
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => document.addEventListener(type, (event) => event.preventDefault(), { passive: false }));
    // Only block two-finger pinch. Double-tap zoom is blocked by CSS touch-action: manipulation,
    // so quick repeated taps (Esc twice, etc.) still go through.
    document.addEventListener('touchmove', (event) => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
  }
  window.addEventListener('resize', syncViewport);

  // ── Sidebar (mobile slide-in + desktop collapse) ─────────────────────────────
  const sidebar = $('#sidebar');
  const sidebarOverlay = $('#sidebarOverlay');
  const sidebarMenuButton = $('#sidebarMenuButton');
  const mdQuery = window.matchMedia('(min-width: 768px)');
  // Input placeholder: with the window name on wide screens, short on mobile
  const promptPlaceholder = (w) => (w && mdQuery.matches ? t('{name} · 프롬프트 입력', { name: displayName(w) }) : t('프롬프트 입력'));

  function setSidebarOpen(isOpen) {
    sidebar.classList.toggle('-translate-x-full', !isOpen);
    sidebarOverlay.classList.toggle('hidden', !isOpen);
    sidebarMenuButton.setAttribute('aria-expanded', String(isOpen));
  }
  if (store.get('sidebar-collapsed', false)) document.documentElement.classList.add('sidebar-collapsed');
  // Phone: open the drawer with the top ☰ / desktop: collapse to icons with the button at the bottom of the sidebar
  sidebarMenuButton.addEventListener('click', () => setSidebarOpen(true));
  $('#sidebarCollapseBtn')?.addEventListener('click', () => {
    const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
    store.set('sidebar-collapsed', collapsed);
    $('#sidebarCollapseBtn').setAttribute('aria-label', collapsed ? t('사이드바 펼치기') : t('사이드바 접기'));
    requestAnimationFrame(() => terminal?.refit());
  });
  $('#closeSidebarBtn').addEventListener('click', () => setSidebarOpen(false));
  // Shortcut: collapse / expand on desktop, open / close the drawer on phones
  window.UnivDashKeys?.register('app.sidebar', () => {
    if (mdQuery.matches) $('#sidebarCollapseBtn')?.click();
    else setSidebarOpen(sidebarMenuButton.getAttribute('aria-expanded') !== 'true');
  });
  sidebarOverlay.addEventListener('click', () => setSidebarOpen(false));
  $$('.sidebar-link').forEach((link) => link.addEventListener('click', () => { if (!mdQuery.matches) setSidebarOpen(false); }));

  // The sidebar menu order is saved in the server preferences, not the browser, so devices share it.
  // (Found by its items rather than its aria-label, which changes with the interface language.)
  const primaryNav = $('#sidebar nav [data-nav-key]')?.closest('nav');
  if (primaryNav) {
    let draggedNavItem = null;
    let savedNavOrder = [];
    let navOrderSaved = false;
    const currentNavOrder = () => [...primaryNav.querySelectorAll('[data-nav-key]')].map((item) => item.dataset.navKey);
    const persistNavOrder = async (order) => {
      if (state.prefs) state.prefs.nav_order = order;
      const tabbar = document.querySelector('.tabbar');
      if (tabbar) order.forEach((key) => {
        const item = tabbar.querySelector(`[data-nav-key="${CSS.escape(key)}"]`);
        if (item) tabbar.appendChild(item);
      });
      try {
        const saved = await api('PUT', '/api/navigation-order', { order });
        if (state.prefs) state.prefs.nav_order = saved.order;
        toast(t('메뉴 순서를 모든 기기에 저장했습니다.'), 'ok');
      } catch (error) {
        savedNavOrder.forEach((key) => {
          const item = primaryNav.querySelector(`[data-nav-key="${CSS.escape(key)}"]`);
          if (item) primaryNav.appendChild(item);
        });
        if (state.prefs) state.prefs.nav_order = savedNavOrder;
        if (tabbar) savedNavOrder.forEach((key) => {
          const item = tabbar.querySelector(`[data-nav-key="${CSS.escape(key)}"]`);
          if (item) tabbar.appendChild(item);
        });
        toast(t('메뉴 순서를 저장하지 못했습니다:{error}', { error: error.message }), 'error');
      }
    };
    primaryNav.addEventListener('click', (event) => {
      if (event.target.closest('[data-nav-drag-handle]')) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    primaryNav.addEventListener('dragstart', (event) => {
      const handle = event.target.closest('[data-nav-drag-handle]');
      const link = handle?.closest('[data-nav-key]');
      if (!link) { event.preventDefault(); return; }
      draggedNavItem = link;
      savedNavOrder = [...primaryNav.querySelectorAll('[data-nav-key]')].map((item) => item.dataset.navKey);
      navOrderSaved = false;
      link.classList.add('nav-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', link.dataset.navKey);
    });
    primaryNav.addEventListener('dragover', (event) => {
      const target = event.target.closest('[data-nav-key]');
      if (!draggedNavItem || !target || target === draggedNavItem) return;
      event.preventDefault();
      const after = event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
      primaryNav.insertBefore(draggedNavItem, after ? target.nextSibling : target);
    });
    primaryNav.addEventListener('drop', async (event) => {
      if (!draggedNavItem) return;
      event.preventDefault();
      navOrderSaved = true;
      await persistNavOrder(currentNavOrder());
    });
    primaryNav.addEventListener('dragend', async () => {
      draggedNavItem?.classList.remove('nav-dragging');
      const order = currentNavOrder();
      if (!navOrderSaved && order.some((key, index) => key !== savedNavOrder[index])) await persistNavOrder(order);
      draggedNavItem = null;
    });
  }

  // ── Sheet (bottom sheet / modal) ────────────────────────────────────────────
  const sheetOverlay = $('#sheetOverlay');
  let sheetBody = $('#sheetBody');
  let sheetOnClose = null;

  let sheetReturnFocus = null;
  function openSheet(html, onMount, onClose) {
    if (sheetOverlay.hidden) sheetReturnFocus = document.activeElement;   // return focus to where it was on close (so shortcuts keep working)
    // Swap in a fresh element for every sheet — so listeners onMount put on the body do not survive into the next sheet and fire several times per click
    const fresh = sheetBody.cloneNode(false);
    sheetBody.replaceWith(fresh);
    sheetBody = fresh;
    sheetBody.innerHTML = html;
    sheetOverlay.hidden = false;
    sheetOnClose = onClose || null;
    onMount?.(sheetBody);
  }
  function closeSheet() {
    if (sheetOverlay.hidden) return;
    sheetOverlay.hidden = true;
    sheetBody.innerHTML = '';
    const callback = sheetOnClose;
    sheetOnClose = null;
    callback?.();
    const back = sheetReturnFocus;
    sheetReturnFocus = null;
    if (back?.isConnected && sheetOverlay.hidden && !coarsePointer) { try { back.focus({ preventScroll: true }); } catch (e) { /* noop */ } }
  }
  sheetOverlay.addEventListener('click', (event) => { if (event.target === sheetOverlay) closeSheet(); });

  function sheetHead(title, subtitle) {
    return `<div class="sheet-head"><h3>${escapeHtml(title)}</h3>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>`;
  }

  // actions: [{icon, label, sub, danger, current, onClick}] or 'sep'
  function actionSheet({ title, subtitle, actions }) {
    const items = actions.map((action, index) => {
      if (action === 'sep') return '<div class="sheet-sep"></div>';
      const row = `<button type="button" class="sheet-action ${action.danger ? 'danger' : ''} ${action.current ? 'current' : ''}" data-index="${index}">
          <i class="fas ${action.icon || 'fa-circle'} lead"></i><span class="min-w-0 ${action.desc ? 'flex-1' : 'truncate'}">${action.desc
            ? `<span class="block truncate">${escapeHtml(action.label)}</span><span class="block text-[11px] font-medium opacity-55 mt-0.5">${escapeHtml(action.desc)}</span>`
            : escapeHtml(action.label)}</span>
          ${action.sub ? `<span class="sub">${escapeHtml(action.sub)}</span>` : ''}</button>`;
      // side: a separate button at the right of the row (e.g. sign out per account) — { icon, label, onClick }
      if (!action.side) return row;
      return `<div class="sheet-row">${row}<button type="button" class="sheet-side" data-side="${index}" title="${escapeHtml(action.side.label)}" aria-label="${escapeHtml(`${action.label} ${action.side.label}`)}"><i class="fas ${action.side.icon || 'fa-xmark'}"></i><span>${escapeHtml(action.side.label)}</span></button></div>`;
    }).join('');
    openSheet(`${sheetHead(title, subtitle)}<div class="sheet-actions">${items}</div>
      <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>${t('닫기')}</button></div>`, (body) => {
      body.querySelector('[data-close]').addEventListener('click', closeSheet);
      body.querySelectorAll('.sheet-action').forEach((button) => {
        button.addEventListener('click', () => {
          const action = actions[Number(button.dataset.index)];
          closeSheet();
          action.onClick?.();
        });
      });
      body.querySelectorAll('.sheet-side').forEach((button) => {
        button.addEventListener('click', () => {
          const action = actions[Number(button.dataset.side)];
          closeSheet();
          action.side?.onClick?.();
        });
      });
    });
  }

  // fields: [{name, label, value, placeholder, maxlength, autocomplete}]
  function formSheet({ title, subtitle, fields = [], extraHtml = '', submitLabel = t('저장'), onMount, onSubmit }) {
    const inputs = fields.map((field) => `
      <label>${escapeHtml(field.label)}
        <input name="${field.name}" type="${field.type === 'password' ? 'password' : 'text'}" value="${escapeHtml(field.value ?? '')}" placeholder="${escapeHtml(field.placeholder ?? '')}"
          maxlength="${field.maxlength || 100}" autocomplete="${escapeHtml(field.autocomplete || 'off')}" autocapitalize="off" spellcheck="false" ${field.inputmode ? `inputmode="${field.inputmode}"` : ''}>
      </label>`).join('');
    openSheet(`${sheetHead(title, subtitle)}<form class="sheet-form-wrap"><div class="sheet-form">${inputs}${extraHtml}</div>
      <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>${t('취소')}</button><button type="submit" class="btn-glow">${escapeHtml(submitLabel)}</button></div></form>`, (body) => {
      const form = body.querySelector('form');
      body.querySelector('[data-close]').addEventListener('click', closeSheet);
      onMount?.(body);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form).entries());
        const submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
          const keepOpen = await onSubmit(values, body);
          if (!keepOpen) closeSheet();
        } catch (error) {
          toast(error.message || t('처리하지 못했습니다.'), 'error');
        } finally {
          submit.disabled = false;
        }
      });
      const first = body.querySelector('input');
      if (first && !coarsePointer) setTimeout(() => first.focus(), 30);
    });
  }

  // check: given {label, desc, checked}, shows one checkbox row and writes the chosen value to check.checked on confirm
  function confirmSheet({ title, message, confirmLabel = t('확인'), danger = false, check = null }) {
    return new Promise((resolve) => {
      let answered = false;
      let keyHandler = null;
      const checkHtml = check ? `<div class="sheet-form sheet-check"><label class="check-row"><input type="checkbox" data-check${check.checked ? ' checked' : ''}>
          <span>${escapeHtml(check.label)}${check.desc ? `<small>${escapeHtml(check.desc)}</small>` : ''}</span></label></div>` : '';
      openSheet(`${sheetHead(title, message)}${checkHtml}<div class="sheet-buttons">
          <button type="button" class="sheet-cancel" data-no>${t('취소')}</button>
          <button type="button" class="${danger ? 'sheet-danger' : 'btn-glow'}" data-yes>${escapeHtml(confirmLabel)}</button></div>`, (body) => {
        const yes = body.querySelector('[data-yes]');
        body.querySelector('[data-no]').addEventListener('click', () => closeSheet());
        yes.addEventListener('click', () => {
          if (check) check.checked = body.querySelector('[data-check]').checked;
          answered = true; closeSheet(); resolve(true);
        });
        // Enter = confirm · Esc = cancel (focus the confirm button so the keyboard can press it right away)
        keyHandler = (event) => {
          if (event.isComposing || event.repeat) return;
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); yes.click(); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSheet(); }
        };
        document.addEventListener('keydown', keyHandler, true);
        setTimeout(() => yes.focus({ preventScroll: true }), 30);
      }, () => {
        document.removeEventListener('keydown', keyHandler, true);
        if (!answered) resolve(false);
      });
    });
  }

  // Exposed so other page scripts (server.js, etc.) use the same sheets · toasts.
  // A sheet that only shows information (bodyHtml is HTML already escaped by the caller). onMount can fill in values later.
  function infoSheet({ title, subtitle, bodyHtml, onMount, onClose }) {
    openSheet(`${sheetHead(title, subtitle)}<div class="sheet-info">${bodyHtml}</div>
      <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>${t('닫기')}</button></div>`, (body) => {
      body.querySelector('[data-close]').addEventListener('click', closeSheet);
      onMount?.(body);
    }, onClose);
  }
  function codexAccountChanged(limits = null) {
    try { localStorage.setItem('univdash-codex-account-changed', String(Date.now())); } catch (e) { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent('univdash:codex-account-changed', { detail: { limits } }));
  }
  window.addEventListener('storage', (event) => {
    if (event.key === 'univdash-codex-account-changed') {
      window.dispatchEvent(new CustomEvent('univdash:codex-account-changed'));
    }
  });
  window.UnivDashUI = { actionSheet, formSheet, confirmSheet, closeSheet, toast, infoSheet, codexAccountChanged };

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!sheetOverlay.hidden) { closeSheet(); event.preventDefault(); return; }
    if (!mdQuery.matches) setSidebarOpen(false);
  });

  // ── REST ─────────────────────────────────────────────────────────────
  async function api(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (response.status === 401) { location.href = '/login'; throw new Error(t('로그인이 필요합니다.')); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || t('요청이 실패했습니다.'));
    return data;
  }

  // ── State ─────────────────────────────────────────────────────────────
  const STATUS = {
    busy: { label: t('작업 중'), icon: 'fa-circle-notch fa-spin' },
    waiting: { label: t('응답 필요'), icon: 'fa-hand' },
    idle: { label: t('대기'), icon: 'fa-check' },
    shell: { label: t('셸'), icon: 'fa-terminal' },
    dead: { label: t('종료됨'), icon: 'fa-power-off' },
  };
  const FOLDER_COLORS = ['blue', 'purple', 'emerald', 'amber', 'rose', 'cyan', 'slate'];
  // Workspace list sorting. Folder grouping is kept; sorting happens inside each folder (and 'No folder').
  const SORTS = {
    status: { label: t('상태순'), icon: 'fa-bolt', desc: t('안 읽은 답변 → 작업 중 → 응답 필요 → 대기 중 에이전트 → 셸') },
    activity: { label: t('최근 활동순'), icon: 'fa-clock', desc: t('마지막 출력이 최근인 창부터') },
    name: { label: t('이름순'), icon: 'fa-arrow-down-a-z', desc: t('표시 이름 가나다/ABC 순') },
    manual: { label: t('직접 지정'), icon: 'fa-hand-pointer', desc: t('⋯ 메뉴의 위로 · 아래로 이동으로 정한 순서') },
  };
  const STATUS_RANK = { busy: 0, waiting: 1, idle: 2, shell: 3, dead: 4 };
  const sortMode = () => (SORTS[state.prefs.sort] ? state.prefs.sort : 'status');
  const unreadActivity = (w) => w.agent ? (w.reply_activity ?? w.activity) : w.activity;
  // The agent finished its reply (not working) and this window has not been looked at since
  const hasUnreadReply = (w) => !!w.agent && (w.status === 'idle' || w.status === 'waiting')
    && !isWindowVisible(w.key) && unreadActivity(w) > (state.seen[w.key] || 0);

  // Ties keep the manual order (Array.prototype.sort is stable).
  function sortWindows(windows) {
    const mode = sortMode();
    if (mode === 'manual') return windows;
    const sorted = [...windows];
    if (mode === 'status') {
      // Windows whose reply finished (idle · needs answer) but is still unread go on top, most recent first
      const rank = (w) => (hasUnreadReply(w) ? -1 : (STATUS_RANK[w.status] ?? 9));
      sorted.sort((a, b) => rank(a) - rank(b) || (rank(a) === -1 ? b.activity - a.activity : 0));
    }
    else if (mode === 'activity') sorted.sort((a, b) => b.activity - a.activity);
    else if (mode === 'name') sorted.sort((a, b) => displayName(a).localeCompare(displayName(b), 'ko', { numeric: true }));
    return sorted;
  }

  const state = {
    windows: [],
    prefs: { folders: [], order: [], hidden: [], aliases: {}, notes: {}, sort: 'status', nav_order: ['workspace', 'git', 'ai_usage', 'server', 'domains'] },
    filter: store.get('filter', 'all'),
    search: '',
    showHidden: false,
    selectedKey: null,
    paneId: null,
    seen: store.get('seen', {}),
    pendingPane: null,
    dragging: false,
  };

  const byKey = () => new Map(state.windows.map((w) => [w.key, w]));
  // Window description: the hand-written one if any, otherwise the task title set by the agent
  const windowNote = (w) => state.prefs.notes?.[w.key] || w.title || '';
  const displayName = (w) => state.prefs.aliases[w.key] || (w.index === 0 && !state.windows.some((o) => o.session === w.session && o.key !== w.key) ? w.session : `${w.session}:${w.index} ${w.name}`);
  const isHidden = (key) => state.prefs.hidden.includes(key);
  const folderOf = (key) => state.prefs.folders.find((f) => f.items.includes(key)) || null;

  // Folders first → then windows outside folders. includeHidden=false leaves out hidden windows.
  function buildGroups(includeHidden) {
    const map = byKey();
    const placed = new Set();
    const groups = state.prefs.folders.map((folder) => {
      const windows = folder.items.map((key) => map.get(key)).filter(Boolean);
      windows.forEach((w) => placed.add(w.key));
      return { folder, windows };
    });
    const orderIndex = new Map(state.prefs.order.map((key, index) => [key, index]));
    const rest = state.windows.filter((w) => !placed.has(w.key)).sort((a, b) => {
      const ia = orderIndex.has(a.key) ? orderIndex.get(a.key) : 1e6;
      const ib = orderIndex.has(b.key) ? orderIndex.get(b.key) : 1e6;
      return ia - ib || a.session.localeCompare(b.session) || a.index - b.index;
    });
    groups.push({ folder: null, windows: rest });
    if (!includeHidden) groups.forEach((group) => { group.windows = group.windows.filter((w) => !isHidden(w.key)); });
    return groups;
  }

  // ── Saving organization settings ─────────────────────────────────────────────────────
  let saveTimer = null;
  let saveChain = Promise.resolve();
  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const snapshot = JSON.parse(JSON.stringify(state.prefs));
      saveChain = saveChain.then(() => api('PUT', '/api/preferences', snapshot))
        .catch((error) => toast(t('설정 저장 실패: {error}', { error: error.message }), 'error'));
    }, 250);
  }
  function commitPrefs() { savePrefs(); renderAll(true); }

  function existingKeys() { return new Set(state.windows.map((w) => w.key)); }

  function moveToFolder(key, folderId) {
    state.prefs.folders.forEach((folder) => { folder.items = folder.items.filter((k) => k !== key); });
    state.prefs.order = state.prefs.order.filter((k) => k !== key);
    if (folderId) {
      state.prefs.folders.find((f) => f.id === folderId)?.items.push(key);
    } else {
      // Save the current display order of the list outside folders and append at the very end.
      const rootGroup = buildGroups(true).at(-1);
      state.prefs.order = [...rootGroup.windows.map((w) => w.key).filter((k) => k !== key), key, ...state.prefs.order.filter((k) => !existingKeys().has(k))];
    }
    commitPrefs();
  }

  // Freeze the currently shown sort order as the manual order (when moving up/down under another sort)
  function adoptDisplayOrder() {
    if (sortMode() === 'manual') return;
    const exist = existingKeys();
    buildGroups(true).forEach((group) => {
      const keys = sortWindows(group.windows).map((w) => w.key);
      if (group.folder) group.folder.items = [...keys, ...group.folder.items.filter((k) => !exist.has(k))];
      else state.prefs.order = [...keys, ...state.prefs.order.filter((k) => !exist.has(k))];
    });
    state.prefs.sort = 'manual';
    toast(t('정렬 기준을 직접 지정으로 바꿨습니다.'), 'info');
  }

  function moveWithinGroup(key, delta) {
    adoptDisplayOrder();
    const folder = folderOf(key);
    const exist = existingKeys();
    if (folder) {
      const visible = folder.items.filter((k) => exist.has(k));
      const index = visible.indexOf(key);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= visible.length) return;
      [visible[index], visible[target]] = [visible[target], visible[index]];
      folder.items = [...visible, ...folder.items.filter((k) => !exist.has(k))];
    } else {
      const visible = buildGroups(true).at(-1).windows.map((w) => w.key);
      const index = visible.indexOf(key);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= visible.length) return;
      [visible[index], visible[target]] = [visible[target], visible[index]];
      state.prefs.order = [...visible, ...state.prefs.order.filter((k) => !exist.has(k))];
    }
    commitPrefs();
  }

  function toggleHidden(key) {
    const hidden = isHidden(key);
    state.prefs.hidden = hidden ? state.prefs.hidden.filter((k) => k !== key) : [...state.prefs.hidden, key];
    commitPrefs();
    toast(hidden ? t('다시 목록에 표시합니다.') : t('목록에서 숨겼습니다.'), 'ok', hidden ? null : { label: t('되돌리기'), onClick: () => toggleHidden(key) });
  }

  function newFolderId() { return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

  function folderForm({ folder = null, onCreated } = {}) {
    let color = folder?.color || FOLDER_COLORS[state.prefs.folders.length % FOLDER_COLORS.length];
    const swatches = FOLDER_COLORS.map((c) => `<button type="button" class="color-swatch fb-${c} fc-${c} ${c === color ? 'on' : ''}" data-color="${c}" aria-label="${c}"></button>`).join('');
    formSheet({
      title: folder ? t('폴더 편집') : t('새 폴더'),
      fields: [{ name: 'name', label: t('폴더 이름'), value: folder?.name || '', placeholder: t('예: 회사 프로젝트'), maxlength: 40 }],
      extraHtml: `<label>${t('색상')}<div class="color-row">${swatches}</div></label>`,
      submitLabel: folder ? t('저장') : t('만들기'),
      onMount(body) {
        body.querySelectorAll('.color-swatch').forEach((button) => button.addEventListener('click', () => {
          color = button.dataset.color;
          body.querySelectorAll('.color-swatch').forEach((b) => b.classList.toggle('on', b === button));
        }));
      },
      onSubmit(values) {
        const name = values.name.trim();
        if (!name) throw new Error(t('폴더 이름을 입력하십시오.'));
        if (folder) {
          folder.name = name;
          folder.color = color;
        } else {
          const created = { id: newFolderId(), name, color, collapsed: false, items: [] };
          state.prefs.folders.push(created);
          onCreated?.(created);
        }
        commitPrefs();
      },
    });
  }

  // Rename = renaming the actual tmux session. Folder · order · hidden · read marks · drafts move to the new name too.
  function renameForm(w) {
    const siblings = state.windows.filter((o) => o.session === w.session).length;
    formSheet({
      title: t('이름 변경'),
      subtitle: siblings > 1
        ? t('tmux 세션 이름을 바꿉니다 (이 세션의 창 {count}개 모두 적용). 공백 · : · . 은 쓸 수 없습니다.', { count: siblings })
        : t('tmux 세션 이름을 바꿉니다. 공백 · : · . 은 쓸 수 없습니다.'),
      fields: [{ name: 'name', label: t('tmux 세션 이름'), value: w.session, placeholder: w.session, maxlength: 50 }],
      submitLabel: t('변경'),
      onMount(body) {
        const field = body.querySelector('input[name="name"]');
        setTimeout(() => { field.focus(); field.select(); }, 30);
      },
      async onSubmit(values) {
        const name = values.name.trim();
        if (!name || name === w.session) return;
        const result = await api('POST', '/api/sessions/rename', { session: w.session_id, name });
        state.prefs = result.preferences;
        moveSessionKeys(result.old, result.name);
        toast(`${result.old} → ${result.name}`, 'ok');
        await refreshState();
        socket.poke();
      },
    });
  }

  // Change working folder: changes the session's default folder and restarts running Claude · Codex in the new folder with the same conversation
  function moveSessionForm(w) {
    const siblings = state.windows.filter((o) => o.session === w.session);
    const agents = siblings.filter((o) => o.agent).length;
    const busy = siblings.filter((o) => o.agent && (o.status === 'busy' || o.status === 'waiting'));
    formSheet({
      title: t('작업 폴더 바꾸기'),
      subtitle: t('{session} 세션을 다른 폴더로 옮깁니다. 지금 폴더: {path}', { session: w.session, path: w.path }),
      fields: [{ name: 'path', label: t('새 작업 폴더'), value: w.path, placeholder: '~/project', maxlength: 1024 }],
      extraHtml: `${folderPickerHtml()}
        <p class="text-[12px] opacity-70 leading-relaxed">${agents ? `${t('Claude · Codex · Gemini {count}개는 잠깐 꺼졌다가 새 폴더에서 <b>같은 대화</b>로 다시 켜집니다 (입력창에 써 둔 글은 사라질 수 있습니다).', { count: agents })} ` : ''}${t('셸만 있는 창은 새 폴더로 이동만 하고, 서버처럼 다른 프로그램이 돌고 있는 창은 그대로 둡니다. 파일은 옮기지 않습니다.')}</p>
        ${busy.length ? `<p class="text-[12px] text-amber-500"><i class="fas fa-triangle-exclamation mr-1"></i>${t('{names} 이(가) 작업 중이거나 응답을 기다려서 지금은 옮길 수 없습니다.', { names: escapeHtml(busy.map(displayName).join(', ')) })}</p>` : ''}`,
      submitLabel: t('옮기기'),
      onMount(body) {
        const path = body.querySelector('input[name="path"]');
        mountFolderPicker(body, path);
        setTimeout(() => { path.focus(); path.select(); }, 30);
      },
      async onSubmit(values) {
        const target = values.path.trim();
        if (!target || target === w.path) return;
        toast(t('{session} 세션을 옮기는 중…', { session: w.session }), 'info', null, 3000);
        const result = await api('POST', '/api/sessions/move', { session: w.session_id, path: target });
        const parts = [];
        if (result.agents.length) parts.push(t('에이전트 {count}개 다시 켬', { count: result.agents.length }));
        if (result.shells) parts.push(t('셸 {count}개 이동', { count: result.shells }));
        if (result.skipped.length) parts.push(t('그대로 둔 창: {names}', { names: result.skipped.join(', ') }));
        toast(`${result.session} → ${result.path}${parts.length ? ` · ${parts.join(' · ')}` : ''}`, 'ok', null, 6000);
        if (result.failed.length) toast(t('다시 켜지 못한 창: {names}', { names: result.failed.join(' / ') }), 'error', null, 10000);
        await refreshState();
        socket.poke();
      },
    });
  }

  // Write the description under the window name by hand (leaving it empty goes back to the task title set by the agent)
  function noteForm(w) {
    formSheet({
      title: t('설명 변경'),
      subtitle: w.title
        ? t('{name} 아래에 보일 설명입니다. 비워 두면 에이전트가 붙인 작업 제목 ("{title}")을 그대로 보여 줍니다.', { name: displayName(w), title: w.title })
        : t('{name} 아래에 보일 설명입니다. 비워 두면 에이전트가 붙인 작업 제목을 그대로 보여 줍니다.', { name: displayName(w) }),
      fields: [{ name: 'note', label: t('설명'), value: state.prefs.notes?.[w.key] || '', placeholder: w.title || t('예: hw2 풀이 중'), maxlength: 120 }],
      submitLabel: t('저장'),
      onMount(body) {
        const field = body.querySelector('input[name="note"]');
        setTimeout(() => { field.focus(); field.select(); }, 30);
      },
      onSubmit(values) {
        const note = values.note.replace(/\s+/g, ' ').trim().slice(0, 120);
        state.prefs.notes = { ...(state.prefs.notes || {}) };
        if (note) state.prefs.notes[w.key] = note; else delete state.prefs.notes[w.key];
        commitPrefs();
        toast(note ? t('설명을 바꿨습니다.') : t('자동 설명으로 되돌렸습니다.'), 'ok');
      },
    });
  }

  function moveSessionKeys(oldName, newName) {
    const prefix = `${oldName}:`;
    const move = (key) => (typeof key === 'string' && key.startsWith(prefix) ? `${newName}:${key.slice(prefix.length)}` : key);
    for (const key of Object.keys(state.seen)) {
      if (key.startsWith(prefix)) { state.seen[move(key)] = state.seen[key]; delete state.seen[key]; }
    }
    store.set('seen', state.seen);
    if (state.selectedKey) state.selectedKey = move(state.selectedKey);
    store.set('last-window', move(store.get('last-window', null)));
    workspace?.renameKeys(move);
  }

  function folderPicker(w) {
    const current = folderOf(w.key);
    actionSheet({
      title: t('폴더로 이동'),
      subtitle: displayName(w),
      actions: [
        ...state.prefs.folders.map((folder) => ({
          icon: `fa-folder fc-${folder.color}`, label: folder.name, current: current?.id === folder.id,
          sub: current?.id === folder.id ? t('현재') : `${folder.items.length}`,
          onClick: () => moveToFolder(w.key, folder.id),
        })),
        { icon: 'fa-inbox', label: t('폴더 없음'), current: !current, sub: !current ? t('현재') : '', onClick: () => moveToFolder(w.key, null) },
        'sep',
        { icon: 'fa-folder-plus', label: t('새 폴더 만들어 이동'), onClick: () => folderForm({ onCreated: (folder) => { folder.items.push(w.key); } }) },
      ],
    });
  }

  // Folder menu: edit (name · color) · order · collapse · delete (what the old 'window organization' tab did)
  function moveFolder(folder, delta) {
    const list = state.prefs.folders;
    const index = list.indexOf(folder);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    commitPrefs();
  }
  async function deleteFolder(folder) {
    const ok = await confirmSheet({ title: t('폴더 삭제'), message: t("'{name}' 폴더를 삭제합니다. 안에 있던 창은 '폴더 없음'으로 옮겨집니다.", { name: folder.name }), confirmLabel: t('삭제'), danger: true });
    if (!ok) return;
    const rootKeys = buildGroups(true).at(-1).windows.map((x) => x.key);
    state.prefs.order = [...rootKeys, ...folder.items, ...state.prefs.order.filter((k) => !rootKeys.includes(k) && !folder.items.includes(k))];
    state.prefs.folders = state.prefs.folders.filter((f) => f.id !== folder.id);
    commitPrefs();
  }
  function folderMenu(folder) {
    const folders = state.prefs.folders;
    const allCollapsed = folders.length && folders.every((f) => f.collapsed);
    actionSheet({
      title: folder.name, subtitle: t('창 {count}개', { count: folder.items.filter((k) => existingKeys().has(k)).length }),
      actions: [
        { icon: 'fa-pen', label: t('이름 · 색 바꾸기'), onClick: () => folderForm({ folder }) },
        { icon: folder.collapsed ? 'fa-folder-open' : 'fa-folder', label: folder.collapsed ? t('펼치기') : t('접기'), onClick: () => { folder.collapsed = !folder.collapsed; commitPrefs(); } },
        { icon: 'fa-arrow-up', label: t('폴더를 위로'), onClick: () => moveFolder(folder, -1) },
        { icon: 'fa-arrow-down', label: t('폴더를 아래로'), onClick: () => moveFolder(folder, 1) },
        { icon: 'fa-folder-plus', label: t('새 폴더'), onClick: () => folderForm() },
        { icon: 'fa-down-left-and-up-right-to-center', label: allCollapsed ? t('모든 폴더 펼치기') : t('모든 폴더 접기'), onClick: () => { folders.forEach((f) => { f.collapsed = !allCollapsed; }); commitPrefs(); } },
        'sep',
        { icon: 'fa-trash-can', label: t('폴더 삭제'), danger: true, onClick: () => deleteFolder(folder) },
      ],
    });
  }

  // ── Switch agent (Claude ↔ Codex) · start one in a shell-only window ──
  // The server stops the current agent with Ctrl+C and starts another agent in the same shell.
  // With 'hand over the conversation', the current transcript is written to a file that the new agent reads as its first instruction and continues from.
  const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
  const AGENT_IDS = Object.keys(AGENT_NAMES);
  // Agent → executable name shown in tmux (Gemini is the Antigravity CLI · agy)
  const AGENT_BINS = { claude: 'claude', codex: 'codex', gemini: 'agy' };
  const isAgent = (agent) => AGENT_IDS.includes(agent);
  const CARRY_KEY = 'univdash-agent-carry';
  const agentPaneOf = (w) => (w.panes.find((p) => w.agent && p.command === (AGENT_BINS[w.agent] || w.agent)) || w.panes.find((p) => p.active) || w.panes[0])?.id;
  const otherAgents = (agent) => AGENT_IDS.filter((id) => id !== agent);
  function agentSwitchActions(w) {
    if (w.status === 'dead') return [];
    if (!w.agent) {
      if (w.status !== 'shell') return [];
      return AGENT_IDS.map((to) => ({ icon: 'fa-robot', label: t('{agent} 켜기', { agent: AGENT_NAMES[to] }), desc: t('이 창의 셸에서 새 대화로 시작'), onClick: () => switchAgent(w, to) }));
    }
    return [{ icon: 'fa-shuffle', label: t('다른 에이전트로 바꾸기'), desc: t('{from} 를 끄고 {others} 중 하나를 켭니다', { from: AGENT_NAMES[w.agent] || w.agent, others: otherAgents(w.agent).map((id) => AGENT_NAMES[id]).join(' · ') }), onClick: () => pickAgentSwitch(w) }];
  }
  // Pick the agent to switch to from the available choices
  function pickAgentSwitch(w) {
    if (!w?.agent) return;
    const from = AGENT_NAMES[w.agent] || w.agent;
    actionSheet({
      title: t('에이전트 바꾸기'),
      subtitle: t('{name} 창의 {from} 를 끄고 켤 에이전트를 선택하십시오.', { name: displayName(w), from }),
      actions: otherAgents(w.agent).map((to) => ({ icon: 'fa-robot', label: AGENT_NAMES[to], desc: t('{from} 를 끄고 {to} 를 켭니다 (지금 대화를 넘겨줄 수 있습니다)', { from, to: AGENT_NAMES[to] }), onClick: () => switchAgent(w, to) })),
    });
  }
  async function switchAgent(w, to) {
    const from = w.agent ? (AGENT_NAMES[w.agent] || w.agent) : null;
    if (w.status === 'busy') { toast(t('{from} 가 작업 중입니다. 끝난 뒤에 바꿀 수 있습니다.', { from }), 'warn'); return; }
    // Hand over the conversation: remember the last choice
    const check = from ? {
      label: t('지금 {from} 대화를 {to} 에게 넘기기', { from, to: AGENT_NAMES[to] }),
      desc: t('지금까지의 대화 전체를 기록으로 만들어 {to} 가 새 대화에서 읽고 이어 갑니다.', { to: AGENT_NAMES[to] }),
      checked: false,
    } : null;
    if (from) {
      try { check.checked = localStorage.getItem(CARRY_KEY) === '1'; } catch (e) { /* storage unavailable */ }
      const ok = await confirmSheet({
        title: t('{to}로 바꾸기', { to: AGENT_NAMES[to] }),
        message: t('{name} 창의 {from} 를 끄고 {to} 를 켭니다.\n넘기지 않으면 이 창에서 {to} 로 하던 대화를(없으면 이 폴더의 최근 대화를) 이어서 켭니다. 지금 {from} 대화도 기억해 두어, 다시 {from} 로 바꾸면 이어집니다.', { name: displayName(w), from, to: AGENT_NAMES[to] }),
        confirmLabel: t('바꾸기'),
        check,
      });
      if (!ok) return;
      try { localStorage.setItem(CARRY_KEY, check.checked ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    }
    const carry = !!check?.checked;
    const pane = agentPaneOf(w);
    try {
      toast(t('{to} 를 켜는 중…', { to: AGENT_NAMES[to] }), 'info', null, 2000);
      const result = await api('POST', '/api/agent/switch', { pane, to, carry });
      const names = { name: displayName(w), from, to: AGENT_NAMES[to] };
      const done = {
        window: t('{name} · {to} 로 바꿨습니다 (이 창에서 하던 대화를 이어서 켰습니다).', names),
        folder: t('{name} · {to} 로 바꿨습니다 (이 폴더의 최근 대화를 이어서 켰습니다).', names),
        new: t('{name} · {to} 로 바꿨습니다 (새 대화로 켰습니다).', names),
        carried: t('{name} · {to} 로 바꿨습니다 ({from} 대화를 넘겨받은 새 대화로 켰습니다).', names),
      }[result.resumed] || t('{name} · {to} 로 바꿨습니다.', names);
      toast(`${done}${result.resumed === 'new' && to !== 'gemini' ? ` ${t('켜지면 모델 선택이 채팅 아래에 표시됩니다.')}` : ''}`, 'ok', null, 5000);
      window.dispatchEvent(new CustomEvent('univdash:agent-switched', { detail: { pane, to } }));
    } catch (error) { toast(error.message, 'error'); }
  }

  async function killWindow(w) {
    const ok = await confirmSheet({
      title: t('tmux 창 종료'),
      message: w.agent
        ? t('{name} ({target}) 창을 종료합니다. 실행 중인 {agent}도 함께 종료됩니다.', { name: displayName(w), target: `${w.session}:${w.index}`, agent: w.agent })
        : t('{name} ({target}) 창을 종료합니다. 실행 중인 프로그램도 함께 종료됩니다.', { name: displayName(w), target: `${w.session}:${w.index}` }),
      confirmLabel: t('종료'), danger: true,
    });
    if (!ok) return;
    try {
      await api('POST', '/api/windows/kill', { window: w.id });
      toast(t('창을 종료했습니다.'), 'ok');
      if (state.selectedKey === w.key) workspace?.closeTerm();
    } catch (error) { toast(error.message, 'error'); }
  }

  function windowMenu(w) {
    const hidden = isHidden(w.key);
    const folder = folderOf(w.key);
    actionSheet({
      title: displayName(w),
      subtitle: `${w.session}:${w.index} · ${w.path}`,
      actions: [
        ...(page === 'workspace' && state.selectedKey !== w.key ? [{ icon: 'fa-terminal', label: t('열기'), onClick: () => workspace.select(w.key) }] : []),
        { icon: 'fa-pen', label: t('이름 변경 (tmux 세션)'), onClick: () => renameForm(w) },
        { icon: 'fa-comment-dots', label: t('설명 변경'), sub: state.prefs.notes?.[w.key] ? t('직접 적음') : t('자동'), onClick: () => noteForm(w) },
        { icon: 'fa-folder-open', label: t('폴더로 이동'), sub: folder ? folder.name : t('없음'), onClick: () => folderPicker(w) },
        { icon: 'fa-right-left', label: t('작업 폴더 바꾸기'), sub: w.path, onClick: () => moveSessionForm(w) },
        ...(wsFiles ? [{ icon: 'fa-folder-tree', label: t('작업 폴더 파일 보기'), sub: w.path, onClick: () => wsFiles.reveal(w.path) }] : []),
        { icon: 'fa-arrow-up', label: t('위로 이동'), sub: sortMode() === 'manual' ? '' : t('직접 지정으로 전환'), onClick: () => moveWithinGroup(w.key, -1) },
        { icon: 'fa-arrow-down', label: t('아래로 이동'), onClick: () => moveWithinGroup(w.key, 1) },
        ...(folder ? [{ icon: 'fa-sliders', label: t("'{name}' 폴더 관리", { name: folder.name }), onClick: () => folderMenu(folder) }] : []),
        { icon: hidden ? 'fa-eye' : 'fa-eye-slash', label: hidden ? t('다시 표시') : t('목록에서 숨기기'), onClick: () => toggleHidden(w.key) },
        ...(agentSwitchActions(w).length ? ['sep', ...agentSwitchActions(w)] : []),
        'sep',
        { icon: 'fa-eye', label: t('읽기 전용으로 화면 공유'), sub: t('로그인 없이 보기만'), onClick: () => viewShareForm(w) },
        { icon: 'fa-link', label: t('공유 중인 화면 관리'), onClick: () => viewSharesSheet() },
        'sep',
        { icon: 'fa-trash-can', label: t('tmux 창 종료'), danger: true, onClick: () => killWindow(w) },
      ],
    });
  }

  // ── Screen sharing (read-only): whoever gets the link can only watch this window's screen. No input · keys · resizing ──
  const VIEW_TIMES = [[15, t('15분')], [30, t('30분')], [60, t('1시간')], [180, t('3시간')], [720, t('12시간')], [1440, t('1일')], [4320, t('3일')], [10080, t('7일')]];
  const VIEW_HISTORY = [[0, t('지금 화면만')], [300, t('최근 300줄까지')], [2000, t('최근 2000줄까지')]];
  const viewWhen = (epoch) => new Date(epoch * 1000).toLocaleString(t.locale, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  function viewLeft(share) {
    const minutes = Math.max(0, Math.ceil((share.expires * 1000 - Date.now()) / 60000));
    return minutes >= 1440 ? t('{days}일 {hours}시간 남음', { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60) })
      : minutes >= 60 ? t('{hours}시간 {minutes}분 남음', { hours: Math.floor(minutes / 60), minutes: minutes % 60 }) : t('{minutes}분 남음', { minutes });
  }
  async function copyLink(link) {
    try { await navigator.clipboard.writeText(link); toast(t('공유 링크를 복사했습니다.'), 'ok', null, 1500); } catch (e) { toast(t('복사하지 못했습니다. 링크를 길게 눌러 복사하십시오.'), 'error'); }
  }
  function viewShareForm(w) {
    const pane = agentPaneOf(w);
    if (!pane) { toast(t('공유할 화면을 찾지 못했습니다.'), 'error'); return; }
    const opts = (list, value) => list.map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${label}</option>`).join('');
    formSheet({
      title: t('읽기 전용으로 화면 공유'), subtitle: `${displayName(w)} · ${w.session}:${w.index}`, submitLabel: t('링크 만들기'),
      fields: [{ name: 'title', label: t('보는 사람에게 보일 이름'), value: displayName(w), maxlength: 60 }],
      extraHtml: `<label>${t('볼 수 있는 시간')}<select name="minutes">${opts(VIEW_TIMES, 60)}</select></label>
        ${w.agent ? `<label>${t('보여 줄 것')}<select name="chat"><option value="1" selected>${t('채팅 + 터미널 (대화 기록 전체)')}</option><option value="0">${t('터미널만')}</option></select></label>` : ''}
        <label>${t('터미널에 보여 줄 범위')}<select name="history">${opts(VIEW_HISTORY, 0)}</select></label>
        ${w.agent ? `<p class="text-[11px] opacity-60 leading-5"><i class="fas fa-comments mr-1"></i>${t('채팅을 함께 공유하면 이 창의 {agent} 대화 기록을 <b>처음부터 전부</b> 볼 수 있습니다 (프롬프트 · 답변 · 실행한 명령과 결과 · 코드 수정 내용 포함). 첨부한 그림은 보내지 않습니다.', { agent: AGENT_NAMES[w.agent] || 'Claude' })}</p>` : ''}
        <p class="text-[11px] opacity-60 leading-5"><i class="fas fa-key mr-1"></i>${t('링크와 함께 <b>접근 코드</b>가 만들어집니다. 코드를 받은 사람만 볼 수 있습니다 (화면 공유는 코드가 항상 필요합니다).')}</p>
        <p class="text-[11px] opacity-60 leading-5"><i class="fas fa-shield-halved mr-1"></i>${t('링크와 코드를 받은 사람은 로그인 없이 이 창의 화면을 <b>보기만</b> 할 수 있습니다. 입력 · 키 · 창 크기 바꾸기는 아예 할 수 없고, 다른 창이나 파일도 볼 수 없습니다. 화면에 찍힌 API 키 · 토큰 같은 값은 가려서 보내지만 모든 비밀을 알아보지는 못하니, 비밀이 화면에 나오지 않게 조심하십시오. 창을 닫거나 시간이 지나면 링크가 끊깁니다.')}</p>`,
      async onSubmit(values) {
        const result = await api('POST', '/api/view-shares', {
          pane, title: String(values.title || '').trim(), minutes: Number(values.minutes) || 60, history: Number(values.history) || 0,
          chat: !!w.agent && values.chat !== '0',
        });
        setTimeout(() => viewShareResult(result), 0);
        return false;
      },
    });
  }
  function viewShareResult({ url, code, share }) {
    const link = `${location.origin}${url}`;
    infoSheet({
      title: t('화면 공유 링크를 만들었습니다'), subtitle: share.title,
      bodyHtml: `<div class="share-box">${accessCodeHtml(code)}
        <div class="share-link mt-3"><input readonly value="${escapeHtml(link)}" aria-label="${t('공유 링크')}" spellcheck="false">
          <button type="button" class="btn-glow" data-copy><i class="fas fa-copy mr-1"></i>${t('링크 복사')}</button>
          ${navigator.share ? `<button type="button" class="sheet-cancel" data-send><i class="fas fa-share-nodes mr-1"></i>${t('보내기')}</button>` : ''}</div>
        <p class="text-[12px] opacity-75 leading-5 mt-3">${t('{when}까지 볼 수 있습니다', { when: escapeHtml(viewWhen(share.expires)) })} ·${escapeHtml(VIEW_HISTORY.find(([v]) => v === share.history)?.[1] || '')}</p>
        <p class="text-[11px] opacity-60 leading-5 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>${t('링크와 코드는 지금만 표시됩니다. 링크만으로는 열리지 않고 코드가 꼭 있어야 합니다. 코드는 링크와 다른 방법(직접 말하기 · 다른 메신저)으로 볼 사람에게만 전달하십시오. 창 메뉴 › 공유 중인 화면 관리에서 언제든 끊을 수 있습니다.')}</p></div>`,
      onMount(body) {
        const input = body.querySelector('.share-link input');
        input.addEventListener('focus', () => input.select());
        mountAccessCode(body, code);
        body.querySelector('[data-copy]').addEventListener('click', () => copyLink(link));
        // Sharing sends the link only (the code is passed on separately)
        body.querySelector('[data-send]')?.addEventListener('click', () => navigator.share({ title: share.title, url: link }).catch(() => {}));
      },
    });
  }
  // Access code box (shared by screen sharing · file sharing) — explorer.js also uses it through window.UnivDashAccessCode
  function accessCodeHtml(code) {
    return `<div class="access-code"><div class="ac-label"><i class="fas fa-key mr-1"></i>${t('접근 코드')} <span>· ${t('볼 사람에게 직접 전달하십시오')}</span></div>
        <div class="ac-row"><code class="ac-value">${escapeHtml(code)}</code>
        <button type="button" class="sheet-cancel" data-copy-code><i class="fas fa-copy mr-1"></i>${t('코드 복사')}</button></div></div>`;
  }
  function mountAccessCode(body, code) {
    body.querySelector('[data-copy-code]')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); toast(t('접근 코드를 복사했습니다.'), 'ok', null, 1500); } catch (e) { toast(t('복사하지 못했습니다. 코드를 직접 적어 전달하십시오.'), 'error'); }
    });
  }
  window.UnivDashAccessCode = { html: accessCodeHtml, mount: mountAccessCode };
  async function viewSharesSheet() {
    let list;
    try { list = (await api('GET', '/api/view-shares')).shares; } catch (error) { toast(error.message, 'error'); return; }
    const windowOf = (pane) => state.windows.find((w) => w.panes.some((p) => p.id === pane));
    const rows = list.map((s) => {
      const w = windowOf(s.pane);
      const where = w ? displayName(w) : t('닫힌 창');
      const status = !s.pane_alive ? t('창이 닫혀 볼 수 없음') : s.watching ? t('지금 {count}곳에서 보는 중', { count: s.watching }) : t('보는 사람 없음');
      return `<li class="share-row" data-view-share="${escapeHtml(s.id)}">
          <i class="fas ${s.pane_alive ? 'fa-eye' : 'fa-eye-slash'} opacity-70"></i>
          <div class="min-w-0 flex-1"><div class="truncate font-semibold">${escapeHtml(s.title)}${s.chat ? `<span class="share-tag"><i class="fas fa-comments"></i> ${t('채팅 포함')}</span>` : ''}</div>
            <div class="truncate text-[11px] opacity-60">${escapeHtml(where)} · ${escapeHtml(VIEW_HISTORY.find(([v]) => v === s.history)?.[1] || '')}</div>
            <div class="text-[11px] opacity-75">${escapeHtml(viewLeft(s))} · ${escapeHtml(status)} · ${t('{count}번 열림', { count: Number(s.opens) || 0 })}</div></div>
          <button type="button" class="sheet-danger" data-revoke>${t('끊기')}</button></li>`;
    }).join('');
    infoSheet({
      title: t('공유 중인 화면'), subtitle: list.length ? t('{count}개 · 시간이 지나면 저절로 끊깁니다', { count: list.length }) : '',
      bodyHtml: `<div class="share-box">${list.length ? `<ul class="share-list">${rows}</ul>
          <div class="sheet-buttons" style="padding:12px 0 0"><button type="button" class="sheet-danger" data-revoke-all>${t('모두 끊기')}</button></div>`
        : `<p class="opacity-70 text-sm">${t('공유 중인 화면이 없습니다. 창 메뉴 › 읽기 전용으로 화면 공유에서 만들 수 있습니다.')}</p>`}</div>`,
      onMount(body) {
        body.querySelectorAll('[data-revoke]').forEach((button) => button.addEventListener('click', async () => {
          const row = button.closest('[data-view-share]');
          button.disabled = true;
          try {
            await api('DELETE', `/api/view-shares/${encodeURIComponent(row.dataset.viewShare)}`);
            row.remove();
            toast(t('공유를 끊었습니다. 이제 볼 수 없습니다.'), 'ok');
          } catch (error) { button.disabled = false; toast(error.message, 'error'); }
        }));
        const all = body.querySelector('[data-revoke-all]');
        all?.addEventListener('click', async () => {
          all.disabled = true;
          try {
            const { revoked } = await api('DELETE', '/api/view-shares');
            closeSheet();
            toast(t('화면 공유 {count}개를 모두 끊었습니다.', { count: revoked }), 'ok');
          } catch (error) { all.disabled = false; toast(error.message, 'error'); }
        });
      },
    });
  }

  // ── Working folder picker (shared by new session · change working folder) ──
  function folderPickerHtml() {
    return `<div class="fp">
          <div class="fp-actions">
            <button type="button" class="fp-toggle" data-fp-toggle><i class="fas fa-folder-open"></i> ${t('폴더 고르기')}</button>
            ${store.get('recent-session-paths', []).slice(0, 5).map((p) => `<button type="button" class="fp-chip" data-fp-recent="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(p.replace(/\/+$/, '').split('/').pop() || p)}</button>`).join('')}
          </div>
          <div class="fp-panel hidden">
            <div class="fp-head">
              <button type="button" class="fp-btn" data-fp-up title="${t('상위 폴더')}" aria-label="${t('상위 폴더')}"><i class="fas fa-arrow-turn-up"></i></button>
              <button type="button" class="fp-btn" data-fp-home title="${t('홈 폴더')}" aria-label="${t('홈 폴더')}"><i class="fas fa-house"></i></button>
              <span class="fp-where">~</span>
              <button type="button" class="fp-btn" data-fp-dot title="${t('숨김 폴더 보기')}" aria-label="${t('숨김 폴더 보기')}"><i class="fas fa-eye-slash"></i></button>
            </div>
            <div class="fp-search"><i class="fas fa-magnifying-glass"></i><input type="search" data-fp-q placeholder="${t('홈 폴더 아래에서 폴더 찾기 (예: csed/week)')}" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
              <button type="button" class="fp-btn hidden" data-fp-clear title="${t('검색 지우기')}" aria-label="${t('검색 지우기')}"><i class="fas fa-xmark"></i></button></div>
            <div class="fp-list"></div>
            <button type="button" class="fp-pick" data-fp-pick><i class="fas fa-check"></i> <span>${t('이 폴더로')}</span></button>
          </div>
        </div>`;
  }
  // Always starts at home — tap a folder to enter it, or find one by name. The chosen folder goes into the path input.
  function mountFolderPicker(body, path) {
    // ── Working folder picker (always starts at home — tap a folder to enter it, or find one by name) ──
    const panel = body.querySelector('.fp-panel');
    const listEl = body.querySelector('.fp-list');
    let home = '';
    let current = null;
    let showDot = store.get('fp-dot', false);
    const tilde = (p) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
    const setPath = (p) => { path.value = tilde(p); path.dispatchEvent(new Event('input')); };
    const qInput = body.querySelector('[data-fp-q]');
    const clearBtn = body.querySelector('[data-fp-clear]');
    let searchSeq = 0;
    let searchTimer = 0;
    const folderRow = (e, sub = '') => `<div class="fp-row" data-fp-dir="${escapeHtml(e.path)}">
        <i class="fas fa-folder"></i><span class="fp-name">${escapeHtml(e.name)}${sub ? `<small class="fp-sub">${escapeHtml(sub)}</small>` : ''}</span>
        <button type="button" class="fp-use" data-fp-use="${escapeHtml(e.path)}" title="${t('이 폴더 선택')}" aria-label="${t('{name} 선택', { name: escapeHtml(e.name) })}"><i class="fas fa-check"></i></button>
        <i class="fas fa-chevron-right fp-go"></i></div>`;
    async function search(query) {
      const mine = ++searchSeq;
      listEl.innerHTML = `<div class="fp-note"><i class="fas fa-circle-notch fa-spin"></i> ${t('찾는 중…')}</div>`;
      try {
        const data = await api('GET', `/api/fs/search-dirs?root=${encodeURIComponent(home || '~')}&q=${encodeURIComponent(query)}&hidden=${showDot ? 'true' : 'false'}`);
        if (mine !== searchSeq) return;
        const parentOf = (p) => tilde(p.replace(/\/[^/]+$/, '')) || '/';
        listEl.innerHTML = data.results.length
          ? data.results.map((e) => folderRow(e, parentOf(e.path))).join('') + (data.truncated ? `<div class="fp-note">${t('결과가 많아 일부만 표시됩니다. 더 자세히 입력해 보십시오.')}</div>` : '')
          : `<div class="fp-note">${t("'{query}' 폴더를 찾지 못했습니다.", { query: escapeHtml(query) })}</div>`;
      } catch (error) {
        if (mine === searchSeq) listEl.innerHTML = `<div class="fp-note error">${escapeHtml(error.message)}</div>`;
      }
    }
    function clearSearch() {
      searchSeq += 1;
      clearTimeout(searchTimer);
      qInput.value = '';
      clearBtn.classList.add('hidden');
    }
    qInput.addEventListener('input', () => {
      const query = qInput.value.trim();
      clearBtn.classList.toggle('hidden', !qInput.value);
      clearTimeout(searchTimer);
      if (!query.replace(/\//g, '')) { searchSeq += 1; if (current) browse(current.path); return; }
      searchTimer = setTimeout(() => search(query), 250);
    });
    // Inside a form, so keep Enter from pressing 'Create' — with a single result, enter that folder right away
    qInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      const rows = listEl.querySelectorAll('[data-fp-dir]');
      if (rows.length === 1) rows[0].click();
    });
    clearBtn.addEventListener('click', () => { clearSearch(); if (current) browse(current.path); qInput.focus(); });
    async function browse(dir) {
      clearSearch();
      listEl.innerHTML = `<div class="fp-note"><i class="fas fa-circle-notch fa-spin"></i> ${t('불러오는 중…')}</div>`;
      try {
        const data = await api('GET', `/api/fs/list?path=${encodeURIComponent(dir)}`);
        if (!home && dir === '~') home = data.path;
        current = data;
        body.querySelector('.fp-where').textContent = tilde(data.path);
        body.querySelector('[data-fp-up]').disabled = !data.parent;
        body.querySelector('[data-fp-dot]').classList.toggle('on', showDot);
        body.querySelector('.fp-pick span').textContent = t('이 폴더로: {path}', { path: tilde(data.path) });
        const dirs = data.entries.filter((e) => e.type === 'dir' && (showDot || !e.name.startsWith('.')))
          .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }));
        listEl.innerHTML = dirs.length ? dirs.map((e) => folderRow(e)).join('')
          : `<div class="fp-note">${t('하위 폴더가 없습니다.')}</div>`;
      } catch (error) {
        listEl.innerHTML = `<div class="fp-note error">${escapeHtml(error.message)}</div>`;
      }
    }
    body.querySelector('[data-fp-toggle]').addEventListener('click', async () => {
      const open = panel.classList.toggle('hidden') === false;
      if (!open) return;
      await browse('~');   // always start at home
      if (!coarsePointer) qInput.focus();
    });
    body.querySelector('[data-fp-up]').addEventListener('click', () => { if (current?.parent) browse(current.parent); });
    body.querySelector('[data-fp-home]').addEventListener('click', () => browse('~'));
    body.querySelector('[data-fp-dot]').addEventListener('click', () => {
      showDot = !showDot;
      store.set('fp-dot', showDot);
      body.querySelector('[data-fp-dot]').classList.toggle('on', showDot);
      if (qInput.value.trim()) search(qInput.value.trim());
      else if (current) browse(current.path);
    });
    body.querySelector('[data-fp-pick]').addEventListener('click', () => { if (current) { setPath(current.path); panel.classList.add('hidden'); } });
    listEl.addEventListener('click', (event) => {
      const use = event.target.closest('[data-fp-use]');
      if (use) { setPath(use.dataset.fpUse); panel.classList.add('hidden'); return; }
      const row = event.target.closest('[data-fp-dir]');
      if (row) browse(row.dataset.fpDir);
    });
    body.querySelectorAll('[data-fp-recent]').forEach((chip) => chip.addEventListener('click', () => {
      path.value = chip.dataset.fpRecent;
      path.dispatchEvent(new Event('input'));
    }));
  }

  // ── New session ──────────────────────────────────────────────────────────
  // Sidebar folder for the new session: move the created window once it shows up in the list (stored so it survives creating it on another page and navigating)
  const PENDING_GROUP_TTL = 60000;
  function placePendingGroup(windows) {
    const pending = store.get('pending-session-group', null);
    if (!pending) return;
    if (!pending.pane || Date.now() - (pending.at || 0) > PENDING_GROUP_TTL) { store.set('pending-session-group', null); return; }
    const created = windows.find((w) => w.panes.some((p) => p.id === pending.pane));
    if (!created || !state.prefs.folders.some((f) => f.id === pending.folder)) return;
    store.set('pending-session-group', null);
    if (!folderOf(created.key)) moveToFolder(created.key, pending.folder);
  }
  function sessionGroupHtml() {
    const folders = state.prefs.folders;
    if (!folders.length) return '';
    const last = store.get('new-session-group', '');
    return `<label>${t('사이드바 폴더')}<select name="group">
      <option value="">${t('폴더 없음')}</option>
      ${folders.map((f) => `<option value="${escapeHtml(f.id)}" ${f.id === last ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
    </select></label>`;
  }

  function newSessionForm(startPath) {
    // Codex starts with "Full access" permissions (no sandbox · never asks for approval)
    // Gemini starts the Antigravity CLI (agy) without permission prompts
    const presets = { claude: 'claude --dangerously-skip-permissions', codex: 'codex --sandbox danger-full-access --ask-for-approval never', gemini: 'agy --dangerously-skip-permissions', shell: '', custom: '' };
    const permNote = (p) => ({ claude: t('Claude 는 권한 확인 없이 켭니다 (Bypass permissions)'), codex: t('Codex 는 권한 Full access 로 켭니다 (샌드박스 없음 · 승인 묻지 않음)'), gemini: t('Gemini 는 Antigravity CLI 를 권한 확인 없이 켭니다') }[p] || '');
    let preset = store.get('new-session-preset', 'claude');
    if (!(preset in presets)) preset = 'claude';
    formSheet({
      title: t('새 tmux 세션'),
      subtitle: t('분리(detached) 세션을 만들고 시작 명령을 실행합니다.'),
      fields: [
        { name: 'name', label: t('세션 이름'), placeholder: t('예: my-project'), maxlength: 50 },
        { name: 'path', label: t('작업 폴더'), value: typeof startPath === 'string' ? startPath : '~', placeholder: '~/project', maxlength: 1024 },
      ],
      extraHtml: `${folderPickerHtml()}
        ${sessionGroupHtml()}
        <label>${t('시작 명령')}<div class="seg" role="radiogroup">
          ${['claude', 'codex', 'gemini', 'shell', 'custom'].map((p) => `<button type="button" data-preset="${p}" class="${p === preset ? 'on' : ''}">${{ claude: 'Claude', codex: 'Codex', gemini: 'Gemini', shell: t('셸만'), custom: t('직접') }[p]}</button>`).join('')}
        </div></label>
        <p data-codex-note class="text-[11px] opacity-60 -mt-1 ${isAgent(preset) ? '' : 'hidden'}"><i class="fas fa-unlock mr-1"></i><span data-perm-text>${permNote(preset)}</span></p>
        <label data-fork class="hidden">${t('이어받을 대화 (선택)')}<select name="fork"></select></label>
        <p data-fork-note class="text-[11px] opacity-60 -mt-1 hidden"><i class="fas fa-code-branch mr-1"></i><span data-fork-text></span></p>
        <label data-custom class="${preset === 'custom' ? '' : 'hidden'}">${t('명령어')}<input name="command" maxlength="500" placeholder="${t('예: claude --continue')}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`,
      submitLabel: t('만들기'),
      onMount(body) {
        const name = body.querySelector('input[name="name"]');
        const path = body.querySelector('input[name="path"]');
        path.addEventListener('input', () => {
          if (name.dataset.touched) return;
          const base = path.value.replace(/\/+$/, '').split('/').pop() || '';
          name.value = base.replace(/[^\w\-가-힣]/g, '-').slice(0, 50);
        });
        name.addEventListener('input', () => { name.dataset.touched = '1'; });
        if (typeof startPath === 'string') path.dispatchEvent(new Event('input'));

        mountFolderPicker(body, path);

        // Continue another window's conversation: both Claude · Codex windows (same-agent windows first)
        const forkField = body.querySelector('[data-fork]');
        const forkSelect = forkField.querySelector('select');
        const forkNote = body.querySelector('[data-fork-note]');
        const forkSources = () => state.windows
          .filter((w) => isAgent(w.agent) && agentPaneOf(w))
          .sort((a, b) => (b.agent === preset) - (a.agent === preset) || (b.activity || 0) - (a.activity || 0));
        const renderForkNote = () => {
          const source = state.windows.find((w) => agentPaneOf(w) === forkSelect.value);
          forkNote.classList.toggle('hidden', !source);
          if (!source) return;
          // Gemini cannot start from a cloned conversation, so even Gemini → Gemini hands over the transcript
          body.querySelector('[data-fork-text]').textContent = source.agent === preset && preset !== 'gemini'
            ? t('선택한 창의 지금까지 대화를 복사해 시작합니다. 원래 창은 그대로 유지됩니다.')
            : t('선택한 {from} 창의 대화 기록을 파일로 넘겨, 새 {to} 가 읽고 맥락을 정리한 뒤 다음 지시를 기다립니다. 원래 창은 그대로 유지됩니다.', { from: AGENT_NAMES[source.agent], to: AGENT_NAMES[preset] });
        };
        const renderForkSources = () => {
          const sources = forkSources();
          const picked = forkSelect.value;
          forkSelect.innerHTML = `<option value="">${t('새 대화로 시작')}</option>${sources.map((w) => `<option value="${escapeHtml(agentPaneOf(w))}">${escapeHtml(`${w.agent === preset ? '' : `[${AGENT_NAMES[w.agent]}] `}${displayName(w)} (${w.session}:${w.index})`)}</option>`).join('')}`;
          if (sources.some((w) => agentPaneOf(w) === picked)) forkSelect.value = picked;
          forkField.classList.toggle('hidden', !sources.length || !isAgent(preset));
          renderForkNote();
        };
        renderForkSources();
        // Only the conversation is carried over: session name · working folder stay as the user set them, regardless of the source
        forkSelect.addEventListener('change', renderForkNote);
        body.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => {
          preset = button.dataset.preset;
          body.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b === button));
          body.querySelector('[data-custom]').classList.toggle('hidden', preset !== 'custom');
          body.querySelector('[data-codex-note]').classList.toggle('hidden', !isAgent(preset));
          body.querySelector('[data-perm-text]').textContent = permNote(preset);
          renderForkSources();
        }));
      },
      async onSubmit(values) {
        const command = preset === 'custom' ? (values.command || '') : presets[preset];
        const forkPane = isAgent(preset) ? (values.fork || '') : '';
        const result = await api('POST', '/api/sessions', { name: values.name.trim(), path: values.path.trim() || '~', command, ...(forkPane ? { fork_pane: forkPane, fork_agent: preset } : {}) });
        store.set('new-session-path', values.path.trim() || '~');
        const used = values.path.trim() || '~';
        store.set('recent-session-paths', [used, ...store.get('recent-session-paths', []).filter((p) => p !== used)].slice(0, 8));
        store.set('new-session-preset', preset);
        const group = state.prefs.folders.some((f) => f.id === values.group) ? values.group : '';
        if (state.prefs.folders.length) store.set('new-session-group', group);
        store.set('pending-session-group', group && result.pane ? { pane: result.pane, folder: group, at: Date.now() } : null);
        toast(t('{name} 세션을 만들었습니다.', { name: values.name }), 'ok');
        state.pendingPane = result.pane;
        socket.poke();
        if (page !== 'workspace') setTimeout(() => { location.href = '/'; }, 400);
      },
    });
  }
  // "+ New session": a tmux session (for agents) or a Terminal
  function newChooser() {
    actionSheet({
      title: t('새로 열기'),
      actions: [
        { icon: 'fa-layer-group', label: t('tmux 세션'), desc: t('Claude Code · Codex · Gemini 등을 띄워 두고 휴대폰에서도 이어서 쓰기'), onClick: () => newSessionForm() },
        { icon: 'fa-terminal', label: 'Terminal', desc: t('셸 하나를 탭으로 바로 열기 (탭을 닫으면 끝남)'), onClick: () => { if (window.UnivDashWs?.newTerminal) window.UnivDashWs.newTerminal(); else location.href = '/?newterm=1'; } },
        'sep',
        { icon: 'fa-clock-rotate-left', label: t('이전 세션 복구'), desc: t('저장된 시점을 골라 지금 없는 세션을 다시 열기 (에이전트는 이전 대화로)'), onClick: () => openRestore() },
      ],
    });
  }

  // ── Restore previous sessions: from the records the server keeps whenever the session list changes, recreate only the sessions that are missing now ──
  const restoreTime = (epoch) => new Date(epoch * 1000).toLocaleString(t.locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const nameList = (names, max = 6) => (names.length > max
    ? t('{names} 외 {count}개', { names: names.slice(0, max).join(', '), count: names.length - max })
    : names.join(', '));
  async function openRestore() {
    let data;
    try { data = await api('GET', '/api/tmux/snapshots'); } catch (error) { toast(error.message, 'error'); return; }
    if (data.job?.running) { toast(t('지금 세션을 복구하는 중입니다. 잠시만 기다려 주십시오.'), 'info'); return; }
    if (!data.snapshots.length) { toast(t('아직 저장된 세션 기록이 없습니다.'), 'info'); return; }
    actionSheet({
      title: t('이전 세션 복구'),
      subtitle: t('시점을 선택하면 그때 있었고 지금은 없는 세션만 다시 만듭니다. 에이전트는 이전 대화로 이어서 켜집니다.'),
      actions: data.snapshots.slice(0, 20).map((row) => ({
        icon: row.missing.length ? 'fa-clock-rotate-left' : 'fa-circle-check',
        label: t('{when} · 세션 {count}개', { when: restoreTime(row.at), count: row.count }),
        desc: row.missing.length ? t('없는 세션 {count}개: {names}', { count: row.missing.length, names: nameList(row.missing) }) : t('이 시점의 세션은 모두 열려 있습니다'),
        onClick: () => confirmRestore(row),
      })),
    });
  }
  async function confirmRestore(row) {
    if (!row.missing.length) { toast(t('이 시점의 세션은 모두 열려 있습니다.'), 'info'); return; }
    const ok = await confirmSheet({
      title: t('세션 {count}개 복구', { count: row.missing.length }),
      message: `${t('{when} 기록에서 {names}을(를) 다시 만듭니다.', { when: restoreTime(row.at), names: nameList(row.missing, 12) })}${row.missing_agents ? ` ${t('에이전트 {count}개는 이전 대화로 이어서 켜집니다.', { count: row.missing_agents })}` : ''} ${t('지금 열려 있는 세션은 건드리지 않습니다.')}`,
      confirmLabel: t('복구'),
    });
    if (!ok) return;
    try {
      const result = await api('POST', '/api/tmux/snapshots/restore', { id: row.id, sessions: row.missing });
      toast(t('세션 {count}개를 복구하고 있습니다. 에이전트는 차례로 켜집니다.', { count: result.started.length }), 'ok', null, 6000);
      store.set('restore-dismissed', row.id);
      window.dispatchEvent(new CustomEvent('univdash:restore'));
    } catch (error) {
      toast(error.message, 'error');
    }
  }
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-restore-open]')) { event.preventDefault(); openRestore(); return; }
    const dismiss = event.target.closest('[data-restore-dismiss]');
    if (dismiss) { store.set('restore-dismissed', dismiss.dataset.restoreDismiss); window.dispatchEvent(new CustomEvent('univdash:restore')); }
  });
  window.UnivDashUI.openRestore = openRestore;
  $$('[data-new-session]').forEach((button) => button.addEventListener('click', () => { if (!mdQuery.matches) setSidebarOpen(false); newChooser(); }));

  // Shortcuts (keys.js · default: t new Terminal · t t new tmux session)
  function openTerminalShortcut() {
    if (window.UnivDashWs?.newTerminal) window.UnivDashWs.newTerminal();
    else location.href = '/?newterm=1';
  }
  window.UnivDashKeys?.register('app.newTerminal', openTerminalShortcut);
  window.UnivDashKeys?.register('app.newSession', () => newSessionForm());
  window.UnivDashUI.newSession = newSessionForm;

  // ── Live connection ──────────────────────────────────────────────────────
  const socket = (() => {
    let ws = null;
    let retry = 0;
    let seq = 0;
    let reconnectTimer = null;
    const pending = new Map();
    const handlers = {};

    function setConn(status) {
      const text = { live: t('Live · 실시간 연결됨'), connecting: t('연결 중...'), offline: t('연결 끊김 · 재시도 중') }[status];
      $$('.conn-dot').forEach((dot) => { dot.className = `conn-dot h-2 w-2 rounded-full ${status === 'live' ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.6)]' : status === 'connecting' ? 'bg-amber-400' : 'bg-red-500'}`; });
      $$('.conn-label').forEach((label) => { label.textContent = text; });
      $$('.conn-badge').forEach((badge) => {
        badge.textContent = { live: 'LIVE', connecting: 'CONNECTING', offline: 'OFFLINE' }[status];
        badge.className = `conn-badge hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-bold border ${status === 'live' ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' : status === 'connecting' ? 'border-white/10 bg-white/5 text-white/40' : 'border-red-500/25 bg-red-500/10 text-red-400'}`;
      });
      $('#termOffline')?.classList.toggle('hidden', status !== 'offline');
    }

    function connect() {
      clearTimeout(reconnectTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      setConn('connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${protocol}//${location.host}/ws`);
      ws = sock;
      lastRecv = Date.now();
      pingAt = 0;
      ws.onopen = () => { retry = 0; lastRecv = Date.now(); setConn('live'); (handlers.open || []).forEach((fn) => fn()); };
      ws.onmessage = (event) => {
        lastRecv = Date.now();
        let message;
        try { message = JSON.parse(event.data); } catch (e) { return; }
        if ((message.t === 'ack' || message.t === 'error') && message.id != null && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.t === 'ack') entry.resolve(); else entry.reject(new Error(message.message));
          return;
        }
        if (message.t === 'error') { toast(message.message, 'error'); return; }
        (handlers[message.t] || []).forEach((fn) => fn(message));
      };
      ws.onclose = (event) => { if (ws === sock) closed(event); };
    }
    function closed(event) {
      pending.forEach((entry) => { clearTimeout(entry.timer); entry.reject(new Error(t('연결이 끊어졌습니다.'))); });
      pending.clear();
      if (event.code === 1008) { location.href = '/login'; return; }
      setConn('offline');
      retry = Math.min(retry + 1, 5);
      reconnectTimer = setTimeout(connect, [0, 800, 1500, 3000, 6000, 10000][retry]);
    }
    // A connection that is dead without the browser knowing (phone sleep · network switch · proxy dropping it silently): readyState is OPEN
    // but nothing arrives, so chat · progress freeze. When it is quiet send a ping; with no answer, drop it and reconnect.
    let lastRecv = 0;
    let pingAt = 0;
    function checkAlive(now = Date.now()) {
      if (!ws || ws.readyState !== WebSocket.OPEN || document.visibilityState !== 'visible') return;
      if (pingAt && lastRecv < pingAt) {
        if (now - pingAt < PONG_TIMEOUT) return;
        const dead = ws;
        ws = null;
        try { dead.close(); } catch (e) { /* already closed */ }
        retry = 0;
        closed({ code: 0 });
        return;
      }
      pingAt = 0;
      if (now - lastRecv > IDLE_PING) { pingAt = now; ws.send(JSON.stringify({ t: 'ping' })); }
    }
    const IDLE_PING = 5000;
    const PONG_TIMEOUT = 4000;
    setInterval(checkAlive, 2000);

    function send(message, { ack = false } = {}) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (ack) return Promise.reject(new Error(t('서버와 연결되어 있지 않습니다. 잠시 후 다시 시도하십시오.')));
        return Promise.resolve();
      }
      if (!ack) { ws.send(JSON.stringify(message)); return Promise.resolve(); }
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(t('응답 시간이 초과되었습니다.'))); }, 10000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ ...message, id }));
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        retry = 0;
        // On becoming visible again, check right away that the connection is alive (a dead connection can stay OPEN after sleep)
        if (ws && ws.readyState === WebSocket.OPEN) { lastRecv = 0; pingAt = 0; checkAlive(); } else connect();
        refreshState();
      }
    });
    window.addEventListener('online', () => { retry = 0; connect(); });

    return {
      connect, send, on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
      poke() { send({ t: 'ping' }); },
      get open() { return ws && ws.readyState === WebSocket.OPEN; },
    };
  })();

  // ── Shared rendering ──────────────────────────────────────────────────────
  let lastStatuses = new Map();
  const doneTimers = new Map();
  function onWindows(windows) {
    const previous = lastStatuses;
    lastStatuses = new Map(windows.map((w) => [w.key, w.status]));
    state.windows = windows;
    state.windowsLoaded = true;

    // Windows seen for the first time count as read; the selected window keeps being marked read
    windows.forEach((w) => {
      if (state.seen[w.key] == null || isWindowVisible(w.key)) markSeen(w.key, unreadActivity(w));
    });

    // Notify on agent status changes (only for windows not being watched)
    if (previous.size) {
      windows.forEach((w) => {
        const before = previous.get(w.key);
        if (before === 'waiting' && w.status !== 'waiting' && w.key === state.selectedKey && isWindowVisible(w.key)) {
          workspace?.watchCurrentModel(w.key);
        }
        if (!before || before === w.status || isHidden(w.key) || w.starting) return;
        const watching = w.key === state.selectedKey && isTermVisible() && document.visibilityState === 'visible';
        if (watching || !window.UnivDash.settings.get('notify-agents')) return;
        const open = page === 'workspace' ? { label: t('열기'), onClick: () => workspace.select(w.key) } : null;
        if (w.status === 'waiting') { toast(t('{name} · 응답이 필요합니다', { name: displayName(w) }), 'warn', open, 6000); vibrate([20, 60, 20]); }
        else if (before === 'busy' && w.status === 'idle' && !w.compacted) {
          // The log is written a few seconds late: notify if it is still idle a moment later and not merely done compacting
          clearTimeout(doneTimers.get(w.key));
          doneTimers.set(w.key, setTimeout(() => {
            doneTimers.delete(w.key);
            const now = state.windows.find((x) => x.key === w.key);
            if (!now || now.status !== 'idle' || now.compacted) return;
            if (w.key === state.selectedKey && isTermVisible() && document.visibilityState === 'visible') return;
            toast(t('{name} · 작업 완료', { name: displayName(now) }), 'ok', open, 5000); vibrate(15);
          }, 5000));
        }
      });
    }

    placePendingGroup(windows);
    if (state.pendingPane) {
      const created = windows.find((w) => w.panes.some((p) => p.id === state.pendingPane));
      if (created) {
        state.pendingPane = null;
        if (page === 'workspace') workspace.select(created.key);
      }
    }
    renderAll();
  }

  function renderStats() {
    const agents = state.windows.filter((w) => w.agent);
    const busy = state.windows.filter((w) => w.status === 'busy').length;
    const waiting = state.windows.filter((w) => w.status === 'waiting').length;
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set('statWindows', state.windows.length);
    set('statAgents', agents.length);
    set('statBusy', busy);
    set('statWaiting', waiting);
    const attention = state.windows.filter((w) => !isHidden(w.key) && (w.status === 'waiting' || hasUnreadReply(w))).length;
    const badge = document.getElementById('tabBadge');
    if (badge) { badge.textContent = attention > 99 ? '99+' : String(attention); badge.classList.toggle('hidden', !attention); }
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = waiting ? `(${waiting}) ${base}` : base;
  }

  function isTermVisible() {
    return page === 'workspace' && !!state.selectedKey && !document.body.classList.contains('file-open') && (desktopQuery.matches || document.body.classList.contains('term-open'));
  }

  function isWindowVisible(key) {
    if (page !== 'workspace' || document.visibilityState !== 'visible') return false;
    const main = key === state.selectedKey && isTermVisible()
      && !document.body.classList.contains('pty-open') && $('#termView')?.classList.contains('open');
    return !!main || !!window.UnivDashWs?.isVisibleTerm?.(key);
  }

  let lastRenderSignature = '';
  function renderAll(force = false) {
    renderStats();
    const windowsSignature = state.windows.map((w) => [w.key, w.status, windowNote(w), w.path, w.agent, unreadActivity(w) > (state.seen[w.key] || 0), timeAgo(w.activity), w.panes.length]);
    const signature = JSON.stringify([windowsSignature, state.prefs, state.filter, state.search, state.showHidden, state.selectedKey]);
    if (!force && signature === lastRenderSignature) return;
    lastRenderSignature = signature;
    if (page === 'workspace') workspace.renderList();
  }

  // ── Read state: collected on the server and shared by all devices (a window seen on the PC is read on the phone too) ──
  const seenOutbox = {};
  let seenTimer = null;
  function markSeen(key, activity) {
    if (activity == null || (state.seen[key] ?? -Infinity) >= activity) return;
    state.seen[key] = activity;
    store.set('seen', state.seen);
    // Also remove dots already drawn, right away, when a split pane is opened.
    $$('.win-item').forEach((item) => { if (item.dataset.key === key) item.querySelector('.unread-dot')?.remove(); });
    $$('.wt-term').forEach((item) => { if (item.dataset.id === `term:${key}`) item.querySelector('.tt-unread')?.remove(); });
    renderStats();
    seenOutbox[key] = activity;
    clearTimeout(seenTimer);
    seenTimer = setTimeout(flushSeen, 300);
  }
  function flushSeen() {
    if (!Object.keys(seenOutbox).length || !socket.open) return;   // when disconnected, sent on reconnect
    socket.send({ t: 'seen', items: { ...seenOutbox } });
    Object.keys(seenOutbox).forEach((key) => delete seenOutbox[key]);
  }
  function mergeSeen(remote) {
    if (!remote || typeof remote !== 'object') return false;
    let changed = false;
    for (const [key, value] of Object.entries(remote)) {
      if (typeof value === 'number' && value > (state.seen[key] ?? -Infinity)) { state.seen[key] = value; changed = true; }
    }
    // Read marks only this device has (unknown to the server) are uploaded to the server
    for (const [key, value] of Object.entries(state.seen)) {
      if (typeof value === 'number' && value > (remote[key] ?? -Infinity)) seenOutbox[key] = value;
    }
    if (changed) store.set('seen', state.seen);
    return changed;
  }

  async function refreshState() {
    try {
      const data = await api('GET', '/api/state');
      state.prefs = data.preferences;
      mergeSeen(data.seen);
      onWindows(data.windows);
    } catch (error) {
      if (!socket.open) toast(error.message, 'error');
    }
  }

  function statusIcon(w, extra = '') {
    const status = STATUS[w.status] || STATUS.idle;
    return `<span class="status-icon st-${w.status} ${extra}" title="${status.label}"><i class="fas ${status.icon}"></i></span>`;
  }
  function agentPill(w) {
    return w.agent ? `<span class="agent-pill agent-${w.agent}">${escapeHtml(w.agent)}</span>` : '';
  }

  // Long press → menu (implemented by hand because iOS has no contextmenu event)
  function attachLongPress(root, selector, onLongPress) {
    let timer = null;
    let start = null;
    let fired = false;
    root.addEventListener('pointerdown', (event) => {
      const target = event.target.closest(selector);
      // The mouse opens the menu with a right click and press-and-drag is a drag (open as split), so long press is touch only
      if (!target || event.button > 0 || event.target.closest('button') || event.pointerType === 'mouse') return;
      fired = false;
      start = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => { fired = true; vibrate(12); onLongPress(target); }, 520);
    });
    const cancel = () => { clearTimeout(timer); timer = null; };
    root.addEventListener('pointermove', (event) => {
      if (timer && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
    });
    root.addEventListener('pointerup', cancel);
    root.addEventListener('pointercancel', cancel);
    root.addEventListener('dragstart', cancel);
    root.addEventListener('contextmenu', (event) => {
      const target = event.target.closest(selector);
      if (!target) return;
      event.preventDefault();
      if (!fired) onLongPress(target);
      cancel();
    });
    root.addEventListener('click', (event) => {
      if (fired) { event.stopPropagation(); event.preventDefault(); fired = false; }
    }, true);
  }

  // ════════════════════════════════════════════════════════════════════
  // Terminal renderer (ANSI SGR → HTML). In light mode, colors that programs picked assuming a dark background
  // are fixed to stay readable on a light one (like VS Code terminal's 'minimum contrast': too-bright text darker, dark backgrounds lighter).
  // ════════════════════════════════════════════════════════════════════
  const PALETTE = ['#1f2430', '#f07178', '#a6da95', '#eed49f', '#7aa2f7', '#c6a0f6', '#7dcfff', '#cad3f5',
    '#5b6078', '#ff8a92', '#b8f0a8', '#ffe0a8', '#9ab8ff', '#dcb8ff', '#a4e0ff', '#ffffff'];
  let lightTerm = document.documentElement.getAttribute('data-ui-theme-mode') === 'light';
  const DEFAULT_FG = () => (lightTerm ? '#1e293b' : '#d4d8e1');
  const DEFAULT_BG = () => (lightTerm ? '#f8fafc' : '#05070c');
  const adaptCache = new Map();
  function rgbOf(color) {
    if (color.startsWith('#')) {
      const hex = color.length === 4 ? color.slice(1).split('').map((c) => c + c).join('') : color.slice(1);
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    }
    const m = color.match(/\d+/g);
    return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
  }
  const luminance = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    let h = 0; let s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function fromHsl([h, s, l]) {
    if (!s) return [l, l, l].map((v) => Math.round(v * 255));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => Math.round(v * 255));
  }
  // Color correction for light mode (results are cached)
  function adapt(color, kind) {
    if (!lightTerm || !color) return color;
    const key = kind + color;
    if (adaptCache.has(key)) return adaptCache.get(key);
    const rgb = rgbOf(color);
    let [h, s, l] = toHsl(rgb);
    let out = color;
    if (kind === 'fg') {
      const bgLum = luminance(rgbOf('#f8fafc'));
      const contrast = (c) => (bgLum + 0.05) / (luminance(c) + 0.05);
      if (contrast(rgb) < 4.5) {
        l = Math.min(l, 1 - l);                 // flip the lightness of bright colors
        let next = fromHsl([h, s, l]);
        while (contrast(next) < 4.5 && l > 0.05) { l -= 0.04; next = fromHsl([h, s, l]); }   // still too faint → darker
        out = `rgb(${next.join(',')})`;
      }
    } else if (l < 0.45) {
      out = `rgb(${fromHsl([h, Math.min(s, 0.6), Math.max(0.86, 1 - l * 0.5)]).join(',')})`;   // dark background → pale tint of the same hue
    }
    adaptCache.set(key, out);
    return out;
  }
  const CUBE = [0, 95, 135, 175, 215, 255];

  function color256(n) {
    n = Number(n) || 0;
    if (n < 16) return PALETTE[n];
    if (n < 232) { n -= 16; return `rgb(${CUBE[Math.floor(n / 36)]},${CUBE[Math.floor(n / 6) % 6]},${CUBE[n % 6]})`; }
    const v = 8 + 10 * (n - 232);
    return `rgb(${v},${v},${v})`;
  }

  function applySGR(params, st) {
    const codes = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : parseInt(x, 10)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { st.fg = null; st.bg = null; st.b = st.d = st.i = st.u = st.inv = st.s = false; }
      else if (c === 1) st.b = true;
      else if (c === 2) st.d = true;
      else if (c === 3) st.i = true;
      else if (c === 4 || c === 21) st.u = true;
      else if (c === 7) st.inv = true;
      else if (c === 9) st.s = true;
      else if (c === 22) { st.b = false; st.d = false; }
      else if (c === 23) st.i = false;
      else if (c === 24) st.u = false;
      else if (c === 27) st.inv = false;
      else if (c === 29) st.s = false;
      else if (c >= 30 && c <= 37) st.fg = PALETTE[c - 30];
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = PALETTE[c - 40];
      else if (c === 49) st.bg = null;
      else if (c >= 90 && c <= 97) st.fg = PALETTE[c - 82];
      else if (c >= 100 && c <= 107) st.bg = PALETTE[c - 92];
      else if (c === 38 || c === 48 || c === 58) {
        let color = null;
        if (codes[i + 1] === 5) { color = color256(codes[i + 2]); i += 2; }
        else if (codes[i + 1] === 2) { color = `rgb(${codes[i + 2] | 0},${codes[i + 3] | 0},${codes[i + 4] | 0})`; i += 4; }
        if (c === 38) st.fg = color; else if (c === 48) st.bg = color;
      }
    }
  }

  function styleOf(st) {
    let fg = st.fg;
    let bg = st.bg;
    if (st.inv) { const t = fg || DEFAULT_FG(); fg = bg || DEFAULT_BG(); bg = t; }
    fg = adapt(fg, 'fg');
    bg = adapt(bg, 'bg');
    let css = '';
    if (fg) css += `color:${fg};`;
    if (bg) css += `background:${bg};`;
    if (st.b) css += 'font-weight:700;';
    if (st.d) css += 'opacity:.62;';
    if (st.i) css += 'font-style:italic;';
    if (st.u || st.s) css += `text-decoration:${st.u ? 'underline ' : ''}${st.s ? 'line-through' : ''};`;
    return css;
  }

  function isWide(cp) {
    return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff)
      || (cp >= 0x20000 && cp <= 0x3fffd);
  }

  const OTHER_ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g;
  const SGR = /\x1b\[([0-9;:]*)m/g;
  const RULE_LINE = /^\s*[─━═╌┄\-]{12,}\s*$/;

  // One line to HTML. st is the SGR state carried across lines. With cursorCol, the cursor is drawn at that column.
  function renderLine(raw, st, { cursorCol = null, collapseSpaces = false } = {}) {
    const line = raw.replace(OTHER_ESCAPES, '');
    let html = '';
    let col = 0;
    let cursorDone = cursorCol == null;
    let last = 0;
    let match;

    const flush = (text) => {
      if (!text) return;
      const css = styleOf(st);
      const safe = escapeHtml(text);
      html += css ? `<span style="${css}">${safe}</span>` : safe;
    };
    const pushText = (text) => {
      if (collapseSpaces) text = text.replace(/ {12,}/g, '   ');
      if (cursorDone) {
        for (const ch of text) col += isWide(ch.codePointAt(0)) ? 2 : 1;
        flush(text);
        return;
      }
      let run = '';
      for (const ch of text) {
        const width = isWide(ch.codePointAt(0)) ? 2 : 1;
        if (!cursorDone && col <= cursorCol && cursorCol < col + width) {
          flush(run); run = '';
          html += `<span class="cur">${escapeHtml(ch)}</span>`;
          cursorDone = true;
        } else {
          run += ch;
        }
        col += width;
      }
      flush(run);
    };

    SGR.lastIndex = 0;
    while ((match = SGR.exec(line)) !== null) {
      pushText(line.slice(last, match.index));
      applySGR(match[1], st);
      last = SGR.lastIndex;
    }
    pushText(line.slice(last));
    if (!cursorDone) html += `${' '.repeat(Math.max(0, cursorCol - col))}<span class="cur"> </span>`;
    return html;
  }

  const plainText = (raw) => raw.replace(OTHER_ESCAPES, '').replace(SGR, '');
  // Number of terminal cells that fit on screen (to match the tmux window size to the screen being viewed).
  // Character width is measured inside the real terminal element (reflects font fallback · zoom). Padding: 12px left/right · 12px top · 16px bottom
  function termGrid(scrollEl, screenEl, font) {
    const width = scrollEl.clientWidth - 24;
    const height = scrollEl.clientHeight - 28;
    if (width < 100 || height < 80) return null;   // hidden or too small → leave unchanged
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-size:${font}px;line-height:1.38`;
    probe.textContent = 'M'.repeat(100);
    screenEl.appendChild(probe);
    const box = probe.getBoundingClientRect();
    probe.remove();
    const charWidth = box.width / 100;
    const lineHeight = box.height || font * 1.38;
    if (!charWidth) return null;
    return { cols: Math.floor(width / charWidth) - 1, rows: Math.floor(height / lineHeight) };
  }

  // ════════════════════════════════════════════════════════════════════
  // Workspace
  // ════════════════════════════════════════════════════════════════════
  let terminal = null;
  const workspace = page !== 'workspace' ? null : (() => {
    const list = $('#windowList');
    const scroll = $('#termScroll');
    const screenEl = $('#termScreen');
    const inner = $('.term-inner', screenEl);
    const input = $('#promptInput');
    const direct = $('#directInput');
    const sendBtn = $('#sendBtn');
    const jumpBtn = $('#jumpBottomBtn');
    const loadMoreBtn = $('#loadMoreBtn');

    const view = Object.assign({ mode: desktopQuery.matches ? 'fit' : 'wrap', font: coarsePointer ? 11.5 : 12.5 }, store.get('view', {}));
    let scrollback = 400;
    let lastScreen = null;
    let screenDeferred = false;      // lite mode: the hidden terminal screen has not been drawn yet
    window.addEventListener('univdash:litechange', () => {
      if (screenDeferred && lastScreen && !document.documentElement.hasAttribute('data-ui-lite')) { screenDeferred = false; renderScreen(lastScreen); }
    });
    const screenCache = new Map();   // pane → last screen (most recent 12)
    let stickBottom = true;
    let charRatio = 0.6;
    const submit = true;   // sending always includes Enter (the auto-submit toggle was removed)
    const drafts = store.get('drafts', {});
    let draftTimer = null;

    // ── List ──
    function matches(w) {
      const query = state.search.trim().toLowerCase();
      if (query) {
        const haystack = [displayName(w), w.session, w.name, windowNote(w), w.path, w.agent].join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (state.filter === 'busy') return w.status === 'busy';
      if (state.filter === 'waiting') return w.status === 'waiting';
      if (state.filter === 'agent') return !!w.agent;
      return true;
    }

    function itemHtml(w) {
      // Workspace goes by the tab being viewed (while a file tab is shown, no window is marked selected)
      const selected = state.listCurrent === undefined ? w.key === state.selectedKey : w.key === state.listCurrent;
      const unread = !isWindowVisible(w.key) && unreadActivity(w) > (state.seen[w.key] || 0);
      const status = STATUS[w.status] || STATUS.idle;
      const meta = [status.label, w.path, timeAgo(w.activity)].filter(Boolean).join(' · ');
      return `<div class="win-item ${selected ? 'selected' : ''} ${isHidden(w.key) ? 'is-hidden' : ''}" role="button" tabindex="0" ${coarsePointer ? '' : 'draggable="true"'} data-key="${escapeHtml(w.key)}" aria-current="${selected}">
          ${unread ? `<span class="unread-dot" title="${t('새 출력')}"></span>` : ''}
          ${statusIcon(w)}
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2 min-w-0"><span class="truncate text-sm font-bold text-white/90">${escapeHtml(displayName(w))}</span>${agentPill(w)}</span>
            ${windowNote(w) && windowNote(w) !== displayName(w) ? `<span class="block truncate text-xs text-white/60 mt-0.5" title="${escapeHtml(windowNote(w))}">${escapeHtml(windowNote(w))}</span>` : ''}
            <span class="block truncate font-mono text-[10px] text-white/35 mt-0.5">${escapeHtml(meta)}</span>
          </span>
          <button type="button" class="win-more" data-more aria-label="${t('{name} 메뉴', { name: escapeHtml(displayName(w)) })}"><i class="fas fa-ellipsis-vertical"></i></button>
        </div>`;
    }

    // ── tmux window tabs: picking a window opens it as a tab, and tabs switch directly (saved on this device) ──
    const MAX_TERM_TABS = 20;
    let termTabs = store.get('term-tabs', []).filter((k) => typeof k === 'string');
    function saveTermTabs() { store.set('term-tabs', termTabs); }
    function openTermTab(key, after) {
      if (termTabs.includes(key)) return;
      const at = termTabs.indexOf(after);
      termTabs.splice(at < 0 ? termTabs.length : at + 1, 0, key);
      while (termTabs.length > MAX_TERM_TABS) termTabs.splice(termTabs.findIndex((k) => k !== key), 1);
      saveTermTabs();
    }
    // Drawing the tab bar is done by the shared tab bar below (together with file tabs). Only the list is managed here.
    const termTabHooks = [];
    function renderTermTabs() {
      const map = byKey();
      if (state.windows.length) {
        const alive = termTabs.filter((k) => map.has(k));   // windows closed in tmux are dropped from the tabs too
        if (alive.length !== termTabs.length) { termTabs = alive; saveTermTabs(); }
      }
      termTabHooks.forEach((fn) => fn());
    }
    function closeTermTab(key, { activateNext = true } = {}) {
      const index = termTabs.indexOf(key);
      if (index < 0) return;
      termTabs.splice(index, 1);
      saveTermTabs();
      if (key === state.selectedKey) {
        const next = activateNext ? (termTabs[index] || termTabs[index - 1]) : null;
        if (next && byKey().has(next)) { select(next, { pushHistory: false }); return; }
        state.selectedKey = null; state.paneId = null;
        socket.send({ t: 'unsub' });
        socket.send({ t: 'logunsub' });
        $('#termView').classList.remove('open');
        if (desktopQuery.matches || document.body.classList.contains('file-open')) {
          if (!document.body.classList.contains('file-open')) { $('#termEmpty').classList.remove('hidden'); $('#termEmpty').classList.add('lg:flex'); }
          replaceHash(null);
          renderAll(true);
        } else closeTerm();
        return;
      }
      renderTermTabs();
    }
    const termTabApi = {
      list: () => termTabs.filter((k) => byKey().has(k) || !state.windows.length),
      close: closeTermTab,
      add: (key) => { openTermTab(key, state.selectedKey); renderTermTabs(); },
      onChange: (fn) => termTabHooks.push(fn),
    };

    function renderList() {
      renderTermTabs();
      const all = state.windows.filter((w) => state.showHidden || !isHidden(w.key));
      const counts = {
        all: all.length,
        waiting: all.filter((w) => w.status === 'waiting').length,
        busy: all.filter((w) => w.status === 'busy').length,
        agent: all.filter((w) => w.agent).length,
        hidden: state.prefs.hidden.filter((k) => state.windows.some((w) => w.key === k)).length,
      };
      $$('[data-count]').forEach((el) => { el.textContent = counts[el.dataset.count] || ''; });
      $$('[data-filter]').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === state.filter));
      $('#toggleHiddenBtn').setAttribute('aria-pressed', String(state.showHidden));
      $('#sortLabel').textContent = SORTS[sortMode()].label;

      if (state.windows.length !== restoreCheck.count) { restoreCheck.count = state.windows.length; checkRestore(); }
      const banner = restoreBannerHtml();
      if (!state.windows.length) {
        list.innerHTML = `${banner}<div class="px-4 py-12 text-center">
            <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl glass-strong text-lg text-blue-400"><i class="fas fa-terminal"></i></div>
            <p class="mt-4 text-sm font-bold text-white/70">${t('실행 중인 tmux 세션이 없습니다.')}</p>
            <p class="mt-1 text-xs text-white/40">${t('오른쪽 위 + 버튼으로 새 세션을 만들 수 있습니다.')}</p>
            <button type="button" class="restore-empty-btn" data-restore-open><i class="fas fa-clock-rotate-left"></i> ${t('이전 세션 복구')}</button></div>`;
        return;
      }

      const filtering = state.filter !== 'all' || state.search.trim();
      const groups = buildGroups(state.showHidden).map((group) => ({ ...group, windows: sortWindows(group.windows.filter(matches)) }));
      const hasFolders = state.prefs.folders.length > 0;
      let html = '';
      groups.forEach((group) => {
        if (!group.windows.length) return;
        if (group.folder) {
          const collapsed = group.folder.collapsed && !filtering;
          html += `<section class="${collapsed ? 'collapsed' : ''}">
              <button type="button" class="folder-head" data-folder="${escapeHtml(group.folder.id)}" aria-expanded="${!collapsed}">
                <i class="fas fa-chevron-down folder-caret"></i><i class="fas ${collapsed ? 'fa-folder' : 'fa-folder-open'} fc-${group.folder.color}"></i>
                <span class="truncate normal-case tracking-normal text-[12px]">${escapeHtml(group.folder.name)}</span>
                <span class="ml-auto font-mono text-[10px] opacity-70">${group.windows.length}</span>
                ${group.windows.some((w) => w.status === 'waiting') ? '<span class="status-dot waiting"></span>' : ''}
                <span class="folder-more" data-folder-more role="button" aria-label="${t('폴더 메뉴')}"><i class="fas fa-ellipsis"></i></span>
              </button>
              ${collapsed ? '' : `<div class="mt-1 space-y-1">${group.windows.map(itemHtml).join('')}</div>`}
            </section>`;
        } else {
          html += `<section>${hasFolders ? `<p class="folder-head pointer-events-none"><i class="fas fa-inbox text-[10px]"></i><span class="normal-case tracking-normal text-[12px]">${t('폴더 없음')}</span></p>` : ''}
              <div class="${hasFolders ? 'mt-1 ' : ''}space-y-1">${group.windows.map(itemHtml).join('')}</div></section>`;
        }
      });
      list.innerHTML = banner + (html || `<div class="px-4 py-12 text-center text-xs text-white/40">${t('조건에 맞는 창이 없습니다.')}</div>`);
    }
    // When sessions vanish all at once (tmux server died, etc.), show a restore notice above the list
    const restoreCheck = { count: -1, timer: null, alert: null };
    function checkRestore() {
      clearTimeout(restoreCheck.timer);
      restoreCheck.timer = setTimeout(async () => {
        try {
          const data = await api('GET', '/api/tmux/snapshots');
          const row = data.job?.running ? null : data.snapshots.find((r) => r.id === data.alert);
          const before = restoreCheck.alert?.id;
          restoreCheck.alert = row ? { ...row, restoring: false } : (data.job?.running ? { restoring: true } : null);
          if (before !== restoreCheck.alert?.id || data.job?.running) renderList();
          if (data.job?.running) checkRestoreLater();
        } catch (error) { /* try again next time */ }
      }, 1200);
    }
    function checkRestoreLater() { setTimeout(checkRestore, 4000); }
    function restoreBannerHtml() {
      const alert = restoreCheck.alert;
      if (!alert) return '';
      if (alert.restoring) return `<div class="restore-banner busy"><i class="fas fa-circle-notch fa-spin"></i><div><b>${t('세션을 복구하는 중입니다')}</b><span>${t('에이전트는 차례로 켜집니다.')}</span></div></div>`;
      if (store.get('restore-dismissed', '') === alert.id) return '';
      return `<div class="restore-banner"><i class="fas fa-triangle-exclamation"></i>
          <div><b>${t('세션 {count}개가 사라졌습니다', { count: alert.missing.length })}</b><span>${t('{names} · {when} 기록으로 복구할 수 있습니다.', { names: escapeHtml(nameList(alert.missing, 4)), when: escapeHtml(restoreTime(alert.at)) })}</span></div>
          <button type="button" data-restore-open>${t('복구')}</button>
          <button type="button" class="restore-x" data-restore-dismiss="${escapeHtml(alert.id)}" aria-label="${t('닫기')}"><i class="fas fa-xmark"></i></button></div>`;
    }
    window.addEventListener('univdash:restore', () => { renderList(); checkRestore(); });
    setInterval(() => { if (document.visibilityState === 'visible') checkRestore(); }, 60000);

    list.addEventListener('click', (event) => {
      const folderButton = event.target.closest('[data-folder]');
      if (folderButton) {
        const folder = state.prefs.folders.find((f) => f.id === folderButton.dataset.folder);
        if (folder && event.target.closest('[data-folder-more]')) { folderMenu(folder); return; }
        if (folder) { folder.collapsed = !folder.collapsed; commitPrefs(); }
        return;
      }
      const item = event.target.closest('.win-item');
      if (!item) return;
      const w = byKey().get(item.dataset.key);
      if (!w) return;
      if (event.target.closest('[data-more]')) { windowMenu(w); return; }
      if (window.UnivDashWs?.openFromList?.(w.key)) return;
      select(w.key);
    });
    list.addEventListener('keydown', (event) => {
      const item = event.target.closest('.win-item');
      if (item && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (!window.UnivDashWs?.openFromList?.(item.dataset.key)) select(item.dataset.key); }
    });
    attachLongPress(list, '.win-item', (item) => { const w = byKey().get(item.dataset.key); if (w) windowMenu(w); });
    // Shortcuts (keys.js · default: j next window · k previous window) — in the order shown in the list
    [['ws.nextWindow', 1], ['ws.prevWindow', -1]].forEach(([id, step]) => window.UnivDashKeys?.register(id, () => {
      const items = [...list.querySelectorAll('.win-item')].filter((item) => item.getClientRects().length);
      if (!items.length) return false;
      const index = items.findIndex((item) => item.classList.contains('selected'));
      const next = items[index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length];
      next.scrollIntoView({ block: 'nearest' });
      next.click();
      return true;
    }, () => !!list.querySelector('.win-item')));
    attachLongPress(list, '[data-folder]', (head) => { const folder = state.prefs.folders.find((f) => f.id === head.dataset.folder); if (folder) folderMenu(folder); });

    $('#windowSearch').addEventListener('input', (event) => { state.search = event.target.value; renderAll(); });
    $$('[data-filter]').forEach((chip) => chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter; store.set('filter', state.filter); renderAll();
    }));
    $('#toggleHiddenBtn').addEventListener('click', () => { state.showHidden = !state.showHidden; renderAll(); });
    $('#sortBtn').addEventListener('click', () => {
      const current = sortMode();
      actionSheet({
        title: t('정렬 기준'),
        subtitle: t('폴더 안에서 정렬됩니다. 휴대폰·PC 에 같이 적용됩니다.'),
        actions: Object.entries(SORTS).map(([id, sort]) => ({
          icon: sort.icon, label: sort.label, desc: sort.desc, sub: id === current ? '✓' : '', current: id === current,
          onClick: () => { state.prefs.sort = id; commitPrefs(); },
        })),
      });
    });

    // ── Selecting a window / opening the terminal ──
    function currentWindow() { return byKey().get(state.selectedKey) || null; }

    function pickPane(w) {
      if (state.paneId && w.panes.some((p) => p.id === state.paneId)) return state.paneId;
      const agentPane = w.panes.find((p) => p.command === w.agent && w.agent);
      return (agentPane || w.panes.find((p) => p.active) || w.panes[0]).id;
    }

    function select(key, { pushHistory = true, keepFile = false } = {}) {
      const w = byKey().get(key);
      if (!w) return;
      saveDraft();
      const changed = state.selectedKey !== key;
      openTermTab(key, state.selectedKey);
      state.selectedKey = key;
      if (changed) {
        state.paneId = null;
        modelRequest += 1;
        modelState.pane = null;
        modelState.model = null;
        modelState.at = 0;
        lastScreen = null;
        scrollback = 400;
        inner.innerHTML = `<div class="ln term-empty-note">${t('화면을 불러오는 중...')}</div>`;
      }
      state.paneId = pickPane(w);
      // For a window seen before, show its last screen right away and swap in the new one when it arrives
      if (changed && screenCache.has(state.paneId)) renderScreen(screenCache.get(state.paneId));
      store.set('last-window', key);
      stickBottom = true;

      $('#termEmpty').classList.add('hidden');
      $('#termEmpty').classList.remove('lg:flex');
      // keepFile: when restoring after a reload, leave the file being viewed as is and only prepare the terminal behind it
      if (!keepFile && document.body.classList.contains('pty-open')) {
        document.body.classList.remove('pty-open'); $('#ptyView').classList.add('hidden'); $('#ptyView').classList.remove('flex');
        store.set('ws-pty-open', false);
      }
      if (!keepFile || !(document.body.classList.contains('file-open') || document.body.classList.contains('pty-open'))) {
        $('#termView').classList.add('open');
        if (document.body.classList.contains('file-open')) {
          document.body.classList.remove('file-open'); $('#fileView').classList.add('hidden'); $('#fileView').classList.remove('flex');
          store.set('ws-file-open', false);
          $('#wsOpenFiles')?.classList.remove('hidden');
        }
      }
      if (!desktopQuery.matches && !document.body.classList.contains('term-open')) {
        document.body.classList.add('term-open');
        if (pushHistory) pushHash(key);
      } else {
        replaceHash(key);
      }
      if (isWindowVisible(key)) markSeen(key, unreadActivity(w));
      input.value = drafts[key] || '';
      autosize();
      renderHeader();
      refreshModel(true);
      const modelPane = state.paneId;
      if (w.agent) watchModelChange(() => refreshModel(true), () => state.paneId !== modelPane || !!modelState.model, 30000);
      refreshLimits().then(renderUsage);
      renderAttachments();
      log.pane = null;
      applyMode();
      subscribe();
      renderAll(true);
    }

    function watchCurrentModel(key) {
      if (key !== state.selectedKey || !state.paneId) return;
      const pane = state.paneId;
      const before = modelState.model;
      watchModelChange(
        () => { if (state.paneId === pane) refreshModel(true); },
        () => state.paneId !== pane || modelState.model !== before,
        30000,
      );
    }

    function pushHash(key) { try { window.history.pushState({ tdxTerm: key }, '', `#${encodeURIComponent(key)}`); } catch (e) { /* noop */ } }
    function replaceHash(key) { try { window.history.replaceState(window.history.state, '', key ? `#${encodeURIComponent(key)}` : location.pathname); } catch (e) { /* noop */ } }

    function closeTerm(fromPopstate = false) {
      saveDraft();
      exitDirect();
      input.blur();
      clearInterval(log.timer);
      log.timer = null;
      socket.send({ t: 'logunsub' });
      if (document.body.classList.contains('term-open') && !fromPopstate && window.history.state?.tdxTerm) {
        window.history.back();  // popstate finishes closing
        return;
      }
      document.body.classList.remove('term-open');
      if (!desktopQuery.matches) {
        state.selectedKey = null;
        state.paneId = null;
        socket.send({ t: 'unsub' });
        replaceHash(null);
      }
      renderAll(true);
    }
    window.addEventListener('popstate', () => {
      if (document.body.classList.contains('file-open') || document.body.classList.contains('pty-open')) return;  // the file · terminal view closes first (below)
      if (document.body.classList.contains('term-open')) closeTerm(true);
    });
    $('#termBack').addEventListener('click', () => closeTerm());

    function subscribe() {
      if (state.paneId) socket.send({ t: 'sub', pane: state.paneId, history: scrollback });
    }

    // ── Current model (next to ⚡ in the input) · remaining usage (right side of the header) ──
    const modelBtn = $('#modelBtn');
    const usageMini = $('#usageMini');
    const modelState = { pane: null, model: null, at: 0 };
    let modelRequest = 0;
    function prettyModel(id) {
      if (!id) return t('모델');
      if (!id.startsWith('claude-')) return id;
      const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
      const family = parts.shift();
      return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${parts.join('.')}`.trim();
    }
    function renderModel() {
      const w = currentWindow();
      const agent = w && agentOf(w);
      modelBtn.classList.toggle('hidden', !agent);
      $('#agentUpdateBtn')?.classList.toggle('hidden', !agent);
      $('#codexAccountBtn')?.classList.toggle('hidden', !isAgent(agent));
      const switchBtn = $('#agentSwitchBtn');
      if (switchBtn) {
        switchBtn.classList.toggle('hidden', !agent);
        if (agent) switchBtn.textContent = t('에이전트 바꾸기');
      }
      if (!agent) return;
      $('#modelLabel').textContent = prettyModel(modelState.model);
      modelBtn.title = modelState.model ? t('지금 모델: {model} — 눌러서 바꾸기', { model: modelState.model }) : t('모델 바꾸기');
    }
    async function refreshModel(force = false) {
      const request = ++modelRequest;
      const w = currentWindow();
      if (!w || !agentOf(w) || !state.paneId) { renderModel(); return; }
      if (!force && modelState.pane === state.paneId && Date.now() - modelState.at < 1500) return;
      const pane = state.paneId;
      try {
        const data = await api('GET', `/api/agent/model?pane=${encodeURIComponent(pane)}`);
        if (request !== modelRequest || pane !== state.paneId) return;
        modelState.pane = pane;
        modelState.at = Date.now();
        modelState.model = data.model;
      } catch (e) { /* noop */ }
      if (request === modelRequest) renderModel();
    }
    // Right after a model change: check frequently for a short while so it is noticed as soon as Claude logs "Set model to …".
    // After sending /model, check the model every 1.5 s (stops once it changes or 90 s pass)
    function watchModelChange(check, changed, timeout = 90000) {
      const started = Date.now();
      const timer = setInterval(() => {
        if (changed() || Date.now() - started > timeout) { clearInterval(timer); return; }
        check();
      }, 1500);
    }
    // Update button: quit the agent → (update) → start it again in the same conversation (the server does it with Ctrl+C and shell commands)
    function restartAgent({ pane, agent, busy, window: win }) {
      if (!pane || !agent) return;
      const name = { codex: 'Codex', gemini: 'Gemini' }[agent] || 'Claude Code';
      const run = async (update) => {
        if (busy) { toast(t('{name} 가 작업 중입니다. 끝난 뒤에 다시 눌러 주십시오.', { name }), 'warn'); return; }
        toast(update ? t('{name} 업데이트 후 같은 대화로 다시 켜는 중…', { name }) : t('{name} 를 같은 대화로 다시 켜는 중…', { name }), 'info');
        try {
          const result = await api('POST', '/api/agent/restart', { pane, update });
          toast(t('실행함: {command}', { command: result.command }), 'ok');
        } catch (error) { toast(error.message, 'error'); }
      };
      actionSheet({
        title: t('{name} 업데이트', { name }),
        subtitle: t('지금 창의 에이전트를 끄고, 같은 대화를 이어서 다시 켭니다 (/resume). 입력창에 쓰던 글은 사라집니다.'),
        actions: [
          { icon: 'fa-arrow-rotate-right', label: t('업데이트하고 다시 켜기'), desc: t('{bin} update 후 같은 대화로', { bin: AGENT_BINS[agent] || agent }), onClick: () => run(true) },
          { icon: 'fa-power-off', label: t('다시 켜기만'), desc: t('업데이트 없이 같은 대화로 재시작'), onClick: () => run(false) },
          'sep',
          { icon: 'fa-layer-group', label: t('모든 에이전트 창 업데이트'), desc: t('Claude · Codex · Gemini 모두 업데이트 후 창마다 같은 대화로 다시 켜기'), onClick: () => updateAllAgents() },
          ...(win ? ['sep', ...agentSwitchActions(win)] : []),
        ],
      });
    }
    // All agent windows: after `claude update` · `codex update`, the server restarts only the idle windows in the same conversation.
    // Windows where the agent is running (working · waiting for an answer) are left out and not touched.
    async function updateAllAgents() {
      const agents = state.windows.filter((w) => isAgent(w.agent));
      const idle = agents.filter((w) => w.status === 'idle');
      const count = (agent) => idle.filter((w) => w.agent === agent).length;
      const running = agents.length - idle.length;
      const confirmed = await confirmSheet({
        title: t('모든 에이전트 창 업데이트'),
        message: t('Claude Code · Codex · Gemini 를 최신 버전으로 업데이트하고, 쉬고 있는 창({list})을 잠깐 껐다가 같은 대화로 다시 켭니다. 입력창에 쓰던 글은 사라집니다.', { list: AGENT_IDS.map((id) => t('{name} {count}개', { name: AGENT_NAMES[id], count: count(id) })).join(' · ') })
          + (running ? ` ${t('에이전트가 돌아가고 있는 창 {count}개는 제외하고 그대로 둡니다.', { count: running })}` : ''),
        confirmLabel: t('모두 업데이트'),
      });
      if (!confirmed) return;
      let first;
      try { first = await api('POST', '/api/agent/update-all', { claude: true, codex: true, gemini: true }); }
      catch (error) { toast(error.message, 'error'); return; }
      toast(t('Claude Code · Codex · Gemini 를 업데이트하고 다시 켜는 중…'), 'info', null, 6000);
      followUpdateAll(first);
    }
    function followUpdateAll(first) {
      const seq = first.seq;
      const step = (status) => {
        if (!status || status.seq !== seq) return;
        if (status.state === 'running') {
          setTimeout(() => api('GET', '/api/agent/update-all').then(step, () => setTimeout(() => step(status), 4000)), 2000);
          return;
        }
        if (status.state === 'error') { toast(status.error || t('업데이트하지 못했습니다.'), 'error', null, 9000); return; }
        const parts = [];
        let warn = false;
        const running = [];
        const failed = [];
        for (const [name, r] of [['Claude', status.claude], ['Codex', status.codex], ['Gemini', status.gemini]]) {
          if (!r) continue;
          parts.push(t('{name} 창 {count}개 다시 켬', { name, count: r.restarted.length }));
          if (r.updated === false) { parts.push(t('{name} 업데이트 실패 (기존 버전으로 켬)', { name })); warn = true; }
          for (const s of r.skipped) (s.running ? running : failed).push(s);
        }
        if (status.codex?.daemon === 'kept') parts.push(t('Codex 데몬은 돌아가는 창 때문에 그대로 둠'));
        if (running.length) parts.push(t('돌아가고 있어 뺀 창: {windows}', { windows: running.map((s) => s.window).join(', ') }));
        if (failed.length) { parts.push(t('다시 켜지 못한 창: {windows}', { windows: failed.map((s) => `${s.window} (${s.reason})`).join(', ') })); warn = true; }
        toast(`${parts.join(' · ')}.`, warn ? 'warn' : 'ok', null, 10000);
      };
      step(first);
    }
    // Sending a slash command: Codex takes an Enter right after a paste as a line break, so type the characters and press Enter a moment later
    // Gemini (Antigravity CLI) also picks with Enter from the autocomplete list that appears after typing
    async function sendSlash(pane, agent, text, sendFn) {
      if (agent === 'codex' || agent === 'gemini') {
        await sendFn({ t: 'text', pane, text });
        await new Promise((resolve) => setTimeout(resolve, 450));
        await sendFn({ t: 'keys', pane, keys: ['Enter'] });
      } else await sendFn({ t: 'prompt', pane, text, submit: true, attachments: [] });
    }
    // Model button: only sends /model. The picker is answered in the card below the chat (or in the terminal).
    // Check often for a while so the chip changes once the result ("Set model to …") shows up in the transcript.
    async function sendModelCommand() {
      const w = currentWindow();
      const agent = w && agentOf(w);
      if (!state.paneId || !agent) return;
      if (w.status === 'busy') { toast(t('지금 작업 중입니다. 끝난 뒤에 모델을 바꿀 수 있습니다.'), 'warn'); return; }
      const before = modelState.model;
      const watch = () => watchModelChange(() => refreshModel(true), () => modelState.model !== before);
      if (agent === 'gemini') { pickGeminiModel(state.paneId, (message) => socket.send(message, { ack: true }), watch); return; }
      try {
        await sendSlash(state.paneId, agent, '/model', (message) => socket.send(message, { ack: true }));
        watch();
        if (modeFor(w) === 'log') toast(t('모델 목록이 채팅 아래 카드에 표시됩니다.'), 'info', null, 2500);
      } catch (error) { toast(error.message, 'error'); }
    }
    // The model picker of Gemini (Antigravity CLI) has no numbers, so it cannot be turned into a card → fetch the list and send "/model <name>" for the chosen one
    async function pickGeminiModel(pane, sendFn, onSent) {
      let data;
      try { data = await api('GET', '/api/agent/models?agent=gemini'); }
      catch (error) { toast(error.message, 'error'); return; }
      if (!data.models?.length) { toast(t('모델 목록을 받지 못했습니다. 잠시 뒤 다시 시도해 주십시오.'), 'warn'); return; }
      actionSheet({
        title: t('Gemini 모델 선택'),
        subtitle: t('Antigravity CLI 에서 사용할 수 있는 모델입니다.'),
        actions: data.models.map((model) => ({
          icon: 'fa-microchip', label: model.name || model.id, desc: model.id,
          onClick: async () => {
            try {
              await sendSlash(pane, 'gemini', `/model ${model.id}`, sendFn);
              toast(t('{model} 모델로 바꾸는 중입니다.', { model: model.name || model.id }), 'info', null, 2500);
              onSent?.();
            } catch (error) { toast(error.message, 'error'); }
          },
        })),
      });
    }
    modelBtn.addEventListener('pointerdown', (event) => event.preventDefault());
    async function openCodexAccounts() {
      const agent = agentOf(currentWindow());
      if (agent === 'claude') { openClaudeAccounts(); return; }
      if (agent === 'gemini') { openGeminiAccounts(); return; }
      if (agent !== 'codex') return;
      let data;
      try { data = await api('GET', '/api/accounts/codex'); }
      catch (error) { toast(error.message, 'error'); return; }
      actionSheet({
        title: t('Codex 계정 변경'),
        subtitle: t('다른 계정을 고르면 실행 중인 Codex 창이 같은 대화로 다시 켜집니다.'),
        actions: [
          ...data.accounts.map((account) => ({
            icon: 'fa-user', label: account.email || t('이름 없는 계정'),
            current: account.active, sub: account.active ? t('사용 중') : '',
            desc: account.plan ? t('{plan} 요금제', { plan: account.plan }) : '',
            onClick: () => { if (!account.active) switchCodexAccount(account); },
          })),
          ...(data.accounts.length ? ['sep'] : []),
          { icon: 'fa-plus', label: t('계정 추가 · 관리'), desc: t('AI 사용량 페이지에서 다른 계정 로그인'), onClick: () => { location.href = '/ai-usage'; } },
        ],
      });
    }
    async function switchCodexAccount(account) {
      const confirmed = await confirmSheet({
        title: t('Codex 계정 변경'),
        message: t('{email} 계정으로 바꾸시겠습니까? 모든 Codex 창을 잠깐 종료하고 Codex 를 최신으로 업데이트한 뒤, 같은 대화를 이어서 다시 켭니다. 작업 중인 창이 있으면 모두 끝난 뒤 자동으로 합니다.', { email: account.email }),
        confirmLabel: t('계정 변경'),
      });
      if (!confirmed) return;
      try {
        const result = await api('POST', '/api/accounts/codex/switch', { id: account.id });
        toast(t('Codex 계정을 {email}로 변경했습니다.', { email: result.email }), 'ok');
        codexAccountChanged(result.limits);
        if (result.applied) window.UnivDash.followCodexApply(result.applied);
      } catch (error) { toast(error.message, 'error'); }
    }
    // Gemini (Antigravity CLI): swap the login file and restart the idle Gemini windows in the same conversation
    async function openGeminiAccounts() {
      let data;
      try { data = await api('GET', '/api/accounts/gemini'); }
      catch (error) { toast(error.message, 'error'); return; }
      actionSheet({
        title: t('Gemini 계정 변경'),
        subtitle: t('다른 계정을 선택하면 쉬고 있는 Gemini 창이 같은 대화로 다시 켜집니다.'),
        actions: [
          ...data.accounts.map((account) => ({
            icon: 'fa-user', label: account.email || t('이름 없는 계정'),
            current: account.active, sub: account.active ? t('사용 중') : '',
            desc: account.plan ? t('{plan} 요금제', { plan: account.plan }) : '',
            onClick: () => { if (!account.active) switchGeminiAccount(account); },
          })),
          ...(data.accounts.length ? ['sep'] : []),
          { icon: 'fa-plus', label: t('계정 추가 · 관리'), desc: t('AI 사용량 페이지에서 다른 계정 로그인'), onClick: () => { location.href = '/ai-usage'; } },
        ],
      });
    }
    async function switchGeminiAccount(account) {
      const confirmed = await confirmSheet({
        title: t('Gemini 계정 변경'),
        message: account.email
          ? t('{email} 계정으로 바꾸시겠습니까? 쉬고 있는 Gemini 창은 잠깐 껐다가 같은 대화로 다시 켭니다. 작업 중인 창은 그대로 두므로, 끝난 뒤 직접 다시 켜야 새 계정이 적용됩니다.', { email: account.email })
          : t('선택한 계정으로 바꾸시겠습니까? 쉬고 있는 Gemini 창은 잠깐 껐다가 같은 대화로 다시 켭니다. 작업 중인 창은 그대로 두므로, 끝난 뒤 직접 다시 켜야 새 계정이 적용됩니다.'),
        confirmLabel: t('계정 변경'),
      });
      if (!confirmed) return;
      try {
        const result = await api('POST', '/api/accounts/gemini/switch', { id: account.id });
        const skipped = result.windows?.skipped?.length || 0;
        const changedText = result.email ? t('Gemini 계정을 {email}(으)로 변경했습니다.', { email: result.email }) : t('Gemini 계정을 선택한 계정(으)로 변경했습니다.');
        toast(result.changed ? `${changedText}${skipped ? ` ${t('다시 켜지 못한 창 {count}개는 직접 다시 켜 주십시오.', { count: skipped })}` : ''}` : t('이미 그 계정입니다.'), skipped ? 'warn' : 'ok', null, 6000);
        codexAccountChanged();
      } catch (error) { toast(error.message, 'error'); }
    }
    // Claude Code: only the login file is swapped — running windows notice the file changed and continue with the new account
    async function openClaudeAccounts() {
      let data;
      try { data = await api('GET', '/api/accounts/claude'); }
      catch (error) { toast(error.message, 'error'); return; }
      actionSheet({
        title: t('Claude Code 계정 변경'),
        subtitle: t('다른 계정을 고르면 실행 중인 Claude Code 창도 끄지 않고 새 계정으로 이어집니다.'),
        actions: [
          ...data.accounts.map((account) => ({
            icon: 'fa-user', label: account.email || t('이름 없는 계정'),
            current: account.active, sub: account.active ? t('사용 중') : account.expired ? t('만료') : '',
            desc: account.plan ? t('{plan} 요금제', { plan: account.plan }) : '',
            onClick: () => { if (!account.active) switchClaudeAccount(account); },
          })),
          ...(data.accounts.length ? ['sep'] : []),
          { icon: 'fa-plus', label: t('계정 추가 · 관리'), desc: t('AI 사용량 페이지에서 다른 계정 로그인'), onClick: () => { location.href = '/ai-usage'; } },
        ],
      });
    }
    async function switchClaudeAccount(account) {
      const confirmed = await confirmSheet({
        title: t('Claude Code 계정 변경'),
        message: t('{email} 계정으로 바꾸시겠습니까? 실행 중인 Claude Code 창은 끄지 않고, 다음 요청부터 새 계정을 씁니다.', { email: account.email }),
        confirmLabel: t('계정 변경'),
      });
      if (!confirmed) return;
      try {
        const result = await api('POST', '/api/accounts/claude/switch', { id: account.id });
        toast(result.changed ? t('Claude Code 계정을 {email}로 변경했습니다.', { email: result.email }) : t('이미 그 계정입니다.'), 'ok');
        codexAccountChanged();
      } catch (error) { toast(error.message, 'error'); }
    }
    $('#codexAccountBtn')?.addEventListener('click', openCodexAccounts);
    $('#agentSwitchBtn')?.addEventListener('click', () => pickAgentSwitch(currentWindow()));
    $('#agentUpdateBtn')?.addEventListener('click', () => {
      const w = currentWindow();
      restartAgent({ pane: state.paneId, agent: agentOf(w), busy: w?.status === 'busy', window: w });
    });
    modelBtn.addEventListener('click', () => sendModelCommand());

    // Remaining usage: current session · weekly (Claude / Codex, every minute)
    let limits = null;
    let limitsAt = 0;
    let limitsGeneration = 0;
    async function refreshLimits(force = false) {
      if (!force && limits && Date.now() - limitsAt < 60000) return;
      const generation = limitsGeneration;
      try {
        const next = await api('GET', '/api/ai-limits');
        if (generation !== limitsGeneration) return;
        limits = next;
        limitsAt = Date.now();
      } catch (e) { /* noop */ }
    }
    window.addEventListener('univdash:codex-account-changed', (event) => {
      limitsGeneration += 1;
      limits = event.detail?.limits || null;
      limitsAt = limits ? Date.now() : 0;
      renderUsage();
      if (!limits) refreshLimits(true).then(renderUsage);
    });
    function renderUsage() {
      const w = currentWindow();
      const html = usageMarkup(w && agentOf(w));
      usageMini.classList.toggle('hidden', !html);
      if (html) usageMini.innerHTML = html;
    }
    // Remaining-usage gauge HTML (shared by the main and split views). '' when there is none
    function usageMarkup(agent) {
      const key = isAgent(agent) ? agent : 'claude';
      const provider = agent && limits?.[key];
      const all = provider?.windows || [];
      // Gemini limits come per group (Gemini models / Claude · GPT models) → the gauge shows only the Gemini group
      const own = key === 'gemini' ? all.filter((x) => x.group === 'gemini') : [];
      const windows = own.length ? own : all;
      const session = windows.find((x) => x.window_minutes && x.window_minutes <= 360);
      const weekly = windows.find((x) => /weekly_all|seven_day$|codex-secondary/.test(x.id)) || windows.find((x) => x.window_minutes >= 10080);
      const gauges = [[t('세션'), session, false], [t('주간'), weekly, true]].filter(([, x]) => x);
      if (!gauges.length) return '';
      const when = (iso) => (iso ? new Date(iso).toLocaleString(t.locale, { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
      const resetText = (iso) => {
        if (!iso) return '';
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return '';
        const now = new Date();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const day = date.toDateString() === now.toDateString() ? t('오늘')
          : date.toDateString() === tomorrow.toDateString() ? t('내일')
            : `${date.getMonth() + 1}/${date.getDate()}`;
        const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        return `${day} ${time}`;
      };
      const account = limits?.accounts?.[key] || '';
      const name = `${AGENT_NAMES[key]}${provider.plan ? ` · ${escapeHtml(provider.plan)}` : ''}`;
      // Wide screens: the signed-in account email below the plan / narrow screens (the plan cell is hidden): shown as a toast when the gauge is tapped
      return `<span class="um-provider"><span>${name}</span>${account ? `<span class="um-account">${escapeHtml(account)}</span>` : ''}</span>`
        + `<span class="um-who hidden" data-account="${escapeHtml(account)}" data-provider="${escapeHtml(AGENT_NAMES[key])}"></span>` + gauges.map(([name, x, isWeekly]) => {
        // This account has no 5-hour limit (Anthropic does not send the value) → 'No limit' instead of a bar
        if (x.unlimited) return `<div class="um ok" title="${t('이 계정은 지금 5시간(세션) 한도가 적용되지 않습니다. 주간 한도만 있습니다.')}"><span class="um-label">${name}</span><span class="um-val">${t('제한 없음')}</span></div>`;
        const left = Math.round(x.remaining_percent);
        const tone = left > 50 ? 'ok' : left > 20 ? 'mid' : 'low';
        const reset = resetText(x.resets_at);
        const resetClass = isWeekly ? 'um-reset um-reset-week' : 'um-reset';
        const title = x.resets_at
          ? t('{label} {left}% 남음 · {when} 초기화', { label: x.label, left, when: when(x.resets_at) })
          : t('{label} {left}% 남음', { label: x.label, left });
        return `<div class="um ${tone}" title="${escapeHtml(title)}">
            <span class="um-label">${name}</span><span class="um-bar"><i style="width:${left}%"></i></span><span class="um-val">${left}%</span>
            ${reset ? `<span class="${resetClass}"><span class="um-reset-label">${t('초기화')} </span>${escapeHtml(reset)}</span>` : ''}</div>`;
      }).join('');
    }
    setInterval(() => { if (document.visibilityState === 'visible' && state.selectedKey) refreshLimits().then(renderUsage); }, 60000);
    // Tapping the usage gauge tells which account the usage belongs to (for screens such as phones where the account email is not visible)
    document.addEventListener('click', (event) => {
      const box = event.target.closest('#usageMini, .tp-usage');
      const who = box?.querySelector('.um-who');
      if (!who) return;
      toast(who.dataset.account ? t('{provider} 계정: {account}', { provider: who.dataset.provider, account: who.dataset.account }) : t('{provider} 계정 정보를 찾지 못했습니다', { provider: who.dataset.provider }), 'info', null, 3500);
    });
    // Check every 2 seconds in the active window so a model picked directly in the terminal shows up quickly without a refresh.
    setInterval(() => { if (document.visibilityState === 'visible' && state.selectedKey) refreshModel(); }, 2000);

    function renderHeader() {
      const w = currentWindow();
      if (!w) return;
      renderModel();
      renderUsage();
      // When the window status changes (needs answer, …), re-evaluate the card below the chat even if the screen is the same (a Codex picker does not change the screen)
      if (lastScreen && lastScreen.pane === state.paneId) updateChatStatus(lastScreen);
      $('#termTitle').textContent = displayName(w);
      $('#promptInput').placeholder = promptPlaceholder(w);
      $('#termSubtitle').textContent = [STATUS[w.status]?.label, windowNote(w), w.path].filter(Boolean).join(' · ');
      $('#termStatusDot').className = `status-dot flex-shrink-0 ${w.status}`;
      const pill = $('#termAgent');
      pill.className = w.agent ? `agent-pill agent-${w.agent}` : 'agent-pill agent-shell';
      pill.textContent = w.agent || 'shell';
      pill.classList.remove('hidden');
      const tabs = $('#paneTabs');
      if (w.panes.length > 1) {
        tabs.classList.remove('hidden'); tabs.classList.add('flex');
        tabs.innerHTML = w.panes.map((p) => `<button type="button" class="pane-tab ${p.id === state.paneId ? 'active' : ''}" data-pane="${escapeHtml(p.id)}">${p.index} · ${escapeHtml(p.command)}</button>`).join('');
      } else {
        tabs.classList.add('hidden'); tabs.classList.remove('flex');
      }
    }
    $('#paneTabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-pane]');
      if (!tab) return;
      state.paneId = tab.dataset.pane;
      lastScreen = null;
      renderHeader();
      subscribe();
      log.pane = null;
      applyMode();
    });

    // ── Screen ──
    function applyView() {
      screenEl.classList.remove('wrap', 'fit', 'raw');
      screenEl.classList.add(view.mode);
      refit();
    }

    function refit() {
      if (view.mode === 'fit' && lastScreen?.width) {
        const available = scroll.clientWidth - 24;
        const size = Math.max(8, Math.min(15, available / (lastScreen.width * charRatio)));
        screenEl.style.setProperty('--term-font', `${size.toFixed(2)}px`);
      } else {
        screenEl.style.setProperty('--term-font', `${view.font}px`);
      }
    }

    function measureChar() {
      try {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = "100px 'JetBrains Mono', monospace";
        charRatio = ctx.measureText('MMMMMMMMMM').width / 1000 || 0.6;
      } catch (e) { charRatio = 0.6; }
      refit();
    }
    document.fonts?.ready.then(measureChar);

    function atBottom() { return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40; }

    function renderScreen(screen) {
      const firstForPane = !lastScreen || lastScreen.pane !== screen.pane;
      lastScreen = screen;
      if (firstForPane) fitTmux(true);
      // Lite mode: while the terminal is hidden behind the chat view, do not draw and defer it (the last screen is drawn when switching to the terminal)
      if (document.documentElement.hasAttribute('data-ui-lite') && scroll.classList.contains('hidden')) { screenDeferred = true; return; }
      screenDeferred = false;
      const stick = firstForPane || stickBottom || atBottom();
      const lines = screen.content.split('\n');
      const visibleStart = Math.max(0, lines.length - screen.height);
      const cursorLine = screen.cursor.visible && !screen.in_mode ? visibleStart + screen.cursor.y : -1;

      // Trim the empty lines at the bottom of the screen (the cursor line is kept)
      let end = lines.length - 1;
      while (end > cursorLine && end >= 0 && !plainText(lines[end]).trim()) end--;

      const st = { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false, s: false };
      const wrap = view.mode === 'wrap';
      let html = '';
      for (let index = 0; index <= end; index++) {
        const raw = lines[index];
        if (wrap && index !== cursorLine && RULE_LINE.test(plainText(raw))) {
          applySGRAcross(raw, st);
          html += '<div class="t-rule"></div>';
          continue;
        }
        const body = renderLine(raw, st, { cursorCol: index === cursorLine ? screen.cursor.x : null, collapseSpaces: wrap && index !== cursorLine });
        html += `<div class="ln">${body || ' '}</div>`;
      }
      const hint = screen.alternate && agentOf(currentWindow())
        ? `<div class="alt-hint"><i class="fas fa-circle-info"></i><span>${t('전체 화면 모드라 tmux 에 이전 기록이 남지 않습니다.')}</span><button type="button" data-open-log>${t('채팅으로 보기')}</button></div>`
        : '';
      inner.innerHTML = hint + (html || `<div class="ln term-empty-note">${t('(빈 화면)')}</div>`);

      const historyLines = lines.length - screen.height;
      const canLoadMore = historyLines >= scrollback && scrollback < 5000;
      loadMoreBtn.classList.toggle('hidden', !canLoadMore);
      loadMoreBtn.textContent = t('이전 기록 더 보기 (+1000줄)');
      if (canLoadMore) scroll.prepend(loadMoreBtn);

      if (view.mode === 'fit') refit();
      if (stick) { scroll.scrollTop = scroll.scrollHeight; stickBottom = true; }
      jumpBtn.classList.toggle('hidden', stick || atBottom());

      const w = currentWindow();
      if (w && isWindowVisible(w.key)) markSeen(w.key, unreadActivity(w));
    }
    function applySGRAcross(raw, st) {
      let match;
      SGR.lastIndex = 0;
      while ((match = SGR.exec(raw)) !== null) applySGR(match[1], st);
    }

    let autoLoadAt = 0;
    scroll.addEventListener('scroll', () => {
      if (scroll.scrollTop < 60 && !loadMoreBtn.classList.contains('hidden') && Date.now() - autoLoadAt > 1500) {
        autoLoadAt = Date.now();
        loadMoreBtn.click();
      }
      stickBottom = atBottom();
      if (stickBottom) jumpBtn.classList.add('hidden');
    }, { passive: true });
    inner.addEventListener('click', (event) => { if (event.target.closest('[data-open-log]')) setMode('log'); });
    jumpBtn.addEventListener('click', () => {
      const target = activeScroll();
      target.scrollTop = target.scrollHeight;
      stickBottom = true;
      if (target === logScroll) log.follow = true;   // pressing 'Latest' follows again
      jumpBtn.classList.add('hidden');
    });
    loadMoreBtn.addEventListener('click', () => {
      scrollback = Math.min(5000, scrollback + 1000);
      stickBottom = false;
      const fromBottom = scroll.scrollHeight - scroll.scrollTop;
      subscribe();
      const restore = () => { scroll.scrollTop = scroll.scrollHeight - fromBottom; };
      setTimeout(restore, 400);
    });
    window.addEventListener('resize', () => requestAnimationFrame(refit));

    // Fit the tmux window size to this screen — a session created from the dashboard has no attached terminal, so it stays 80x24 and looks small.
    // Sent only in the screen (terminal) view, when a window is opened · the size changes · this device comes back (the size of the last device that looked wins)
    let sizeTimer = 0;
    let sentSize = '';
    function fitTmux(force = false) {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => {
        if (!state.paneId || modeFor(currentWindow()) !== 'screen' || document.visibilityState !== 'visible') return;
        const grid = termGrid(scroll, screenEl, view.font);
        if (!grid) return;
        const signature = `${state.paneId} ${grid.cols}x${grid.rows}`;
        if (!force && signature === sentSize) return;
        if (lastScreen?.pane === state.paneId && lastScreen.width === grid.cols && lastScreen.height === grid.rows) { sentSize = signature; return; }
        sentSize = signature;
        socket.send({ t: 'size', pane: state.paneId, cols: grid.cols, rows: grid.rows });
      }, 250);
    }
    new ResizeObserver(() => fitTmux()).observe(scroll);
    document.addEventListener('visibilitychange', () => fitTmux(true));
    window.addEventListener('focus', () => fitTmux(true));

    socket.on('screen', (screen) => {
      if (screen.pane !== state.paneId) return;
      screenCache.delete(screen.pane);
      screenCache.set(screen.pane, screen);
      if (screenCache.size > 12) screenCache.delete(screenCache.keys().next().value);
      renderScreen(screen);
      updateChatStatus(screen);
    });
    socket.on('gone', (message) => {
      if (message.pane !== state.paneId) return;
      toast(t('창이 닫혔습니다.'), 'info');
      if (desktopQuery.matches) {
        state.selectedKey = null; state.paneId = null;
        $('#termView').classList.remove('open');
        $('#termEmpty').classList.remove('hidden'); $('#termEmpty').classList.add('lg:flex');
      } else {
        closeTerm();
      }
    });

    // View settings
    $('#termViewBtn').addEventListener('click', () => {
      const modes = [['wrap', t('줄바꿈'), 'fa-align-left', t('모바일에서 읽기 편함')], ['fit', t('화면 맞춤'), 'fa-expand', t('가로폭에 맞춰 축소')], ['raw', t('원본'), 'fa-arrows-left-right', t('가로 스크롤')]];
      openSheet(`${sheetHead(t('보기 설정'), t('이 기기에만 저장됩니다.'))}
        <div class="sheet-form">
          <label>${t('표시 방식')}<div class="seg">${modes.map(([id, label]) => `<button type="button" data-mode="${id}" class="${view.mode === id ? 'on' : ''}">${label}</button>`).join('')}</div></label>
          <p data-mode-desc class="text-[11px] opacity-60 -mt-1"></p>
          <label>${t('글자 크기')} <span data-font-label class="font-mono"></span>
            <div class="seg"><button type="button" data-font="-1">A−</button><button type="button" data-font="0">${t('기본')}</button><button type="button" data-font="1">A+</button></div></label>
        </div>
        <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>${t('닫기')}</button></div>`, (body) => {
        const sync = () => {
          body.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === view.mode));
          body.querySelector('[data-mode-desc]').textContent = modes.find((m) => m[0] === view.mode)[3];
          body.querySelector('[data-font-label]').textContent = view.mode === 'fit' ? t('(자동)') : `${view.font}px`;
        };
        sync();
        body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
          view.mode = b.dataset.mode; store.set('view', view); applyView(); if (lastScreen) renderScreen(lastScreen); sync(); fitTmux(true);
        }));
        body.querySelectorAll('[data-font]').forEach((b) => b.addEventListener('click', () => {
          const delta = Number(b.dataset.font);
          view.font = delta === 0 ? (coarsePointer ? 11.5 : 12.5) : Math.max(8, Math.min(20, view.font + delta));
          if (view.mode === 'fit') view.mode = 'wrap';
          store.set('view', view); applyView(); if (lastScreen) renderScreen(lastScreen); sync(); fitTmux(true);
        }));
        body.querySelector('[data-close]').addEventListener('click', closeSheet);
      });
    });

    $('#termMoreBtn').addEventListener('click', () => { const w = currentWindow(); if (w) windowMenu(w); });

    // ── Input: prompt ──
    function autosize() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight + 2, window.innerHeight * 0.38)}px`;
    }
    function saveDraft() {
      if (!state.selectedKey) return;
      if (input.value) drafts[state.selectedKey] = input.value; else delete drafts[state.selectedKey];
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => store.set('drafts', drafts), 300);
    }
    input.addEventListener('input', () => { autosize(); saveDraft(); });

    function syncSubmitToggle() {
      $('#composerHint').textContent = coarsePointer ? t('줄바꿈은 키보드 Enter · 전송은 ➤') : t('Enter 전송 · Shift+Enter 줄바꿈');
    }

    syncSubmitToggle();

    // ── Recalling earlier prompts (↑ / ↓ like a shell; on phones the ⌃ ⌄ buttons below the input) ──
    const history = { index: -1, stash: '' };
    function recallHistory(delta) {
      const list = store.get('recent', []);
      if (!list.length) { toast(t('보낸 프롬프트 기록이 없습니다.'), 'info', null, 1500); return; }
      if (history.index === -1) history.stash = input.value;
      const next = Math.max(-1, Math.min(list.length - 1, history.index + delta));
      if (next === history.index) return;
      history.index = next;
      input.value = next === -1 ? history.stash : list[next];
      autosize();
      saveDraft();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    }
    input.addEventListener('input', () => { history.index = -1; });
    input.addEventListener('keydown', (event) => {
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.isComposing && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        // History is recalled only when the input is empty. While the recalled text is left untouched, ↑↓ keeps browsing;
        // when there is text typed by hand (or the recalled text was edited), ↑↓ only moves the cursor.
        const browsing = history.index !== -1;
        if (event.key === 'ArrowUp' && (browsing || !input.value)) { event.preventDefault(); recallHistory(1); return; }
        if (event.key === 'ArrowDown' && browsing) { event.preventDefault(); recallHistory(-1); return; }
      }
    });
    for (const [id, delta] of [['#histPrev', 1], ['#histNext', -1]]) {
      $(id).addEventListener('pointerdown', (event) => event.preventDefault());  // so the keyboard does not close
      $(id).addEventListener('click', () => { exitDirect(); recallHistory(delta); });
    }

    // ── Collapsing / expanding the special-key row ──
    function applyKeyBar(collapsed) {
      $('#keyBar').classList.toggle('hidden', collapsed);
      const toggle = $('#keyBarToggle');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.innerHTML = collapsed ? `<i class="fas fa-chevron-up"></i> ${t('키 펼치기')}` : `<i class="fas fa-chevron-down"></i> ${t('키 접기')}`;
    }
    applyKeyBar(store.get('keybar-folded', true));
    $('#keyBarToggle').addEventListener('pointerdown', (event) => event.preventDefault());
    $('#keyBarToggle').addEventListener('click', () => {
      const collapsed = !$('#keyBar').classList.contains('hidden');
      store.set('keybar-folded', collapsed);
      applyKeyBar(collapsed);
      refit();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      const send = (event.ctrlKey || event.metaKey) || (!coarsePointer && !event.shiftKey && !event.altKey);
      if (send) { event.preventDefault(); sendPrompt(); }
    });
    $('#composerForm').addEventListener('submit', (event) => { event.preventDefault(); sendPrompt(); });

    // A prompt that looked failed because no reply came may already have reached the server → when the same text is sent again, attach the same cid
    // so the server enters it only once (tmux_routes._send_prompt_once)
    const newCid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    let unsurePrompt = null;   // { pane, text, cid, at }
    function promptCid(pane, text) {
      const u = unsurePrompt;
      return u && u.pane === pane && u.text === text && Date.now() - u.at < 10 * 60 * 1000 ? u.cid : newCid();
    }
    async function sendPromptOnce(pane, text, extra = {}) {
      const cid = promptCid(pane, text);
      try {
        await socket.send({ t: 'prompt', pane, text, submit: true, ...extra, cid }, { ack: true });
      } catch (error) {
        unsurePrompt = { pane, text, cid, at: Date.now() };
        throw error;
      }
      if (unsurePrompt?.cid === cid) unsurePrompt = null;
    }
    async function sendPrompt() {
      if (!state.paneId) return;
      const pane = state.paneId;
      const key = state.selectedKey;
      const list = attachList(key);
      sendBtn.disabled = true;
      vibrate(10);   // at the very moment Send is pressed (iOS haptics do not fire after an await)
      try {
        if (list.some((item) => item.status === 'uploading')) {
          toast(t('첨부 파일 업로드가 끝나면 보냅니다...'), 'info', null, 1800);
          await Promise.all(list.map((item) => item.promise));
          if (state.selectedKey !== key) return;
        }
        if (list.some((item) => item.status === 'error')) {
          throw new Error(t('업로드에 실패한 첨부가 있습니다. ✕ 로 빼거나 다시 첨부하십시오.'));
        }
        const ready = list.filter((item) => item.status === 'done');
        const text = input.value;
        if (!text && !ready.length) {
          await socket.send({ t: 'keys', pane, keys: ['Enter'] }, { ack: true });
        } else {
          input.value = '';
          autosize();
          delete drafts[key];
          store.set('drafts', drafts);
          const sent = addSent(text);
          try {
            await sendPromptOnce(pane, text, { submit, attachments: ready.map((item) => item.id) });
          } catch (error) {
            if (sent) removeSent(sent);
            if (text && !input.value) { input.value = text; autosize(); saveDraft(); }
            throw error;
          }
          if (text) remember(text);
          history.index = -1;
          clearAttachments(key, { deleteOnServer: false });
        }
        stickBottom = true;
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        sendBtn.disabled = false;
      }
    }

    // ── Attachments (photo/file picker, paste, drag and drop) ──
    // Files are uploaded to the server's upload folder, and their paths are pasted into the prompt when it is sent.
    const attachTray = $('#attachTray');
    const fileInput = $('#fileInput');
    const dropOverlay = $('#dropOverlay');
    const attachments = new Map(); // window key → attachment list
    const MAX_ATTACH = 20;
    let attachSeq = 0;

    function attachList(key = state.selectedKey) {
      if (!attachments.has(key)) attachments.set(key, []);
      return attachments.get(key);
    }
    function formatSize(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }
    function fileIcon(item) {
      const name = item.name.toLowerCase();
      if (item.type.startsWith('image/')) return 'fa-image';
      if (item.type === 'application/pdf' || name.endsWith('.pdf')) return 'fa-file-pdf';
      if (item.type.startsWith('video/')) return 'fa-file-video';
      if (item.type.startsWith('audio/')) return 'fa-file-audio';
      if (/\.(zip|tar|gz|tgz|7z|rar)$/.test(name)) return 'fa-file-zipper';
      if (/\.(csv|xlsx?|tsv)$/.test(name)) return 'fa-file-csv';
      if (/\.(py|js|ts|tsx|jsx|json|html|css|md|txt|sh|go|rs|java|c|cpp|h|yml|yaml|toml|sql|log)$/.test(name)) return 'fa-file-code';
      return 'fa-file';
    }

    function addFiles(fileList) {
      const key = state.selectedKey;
      if (!key) { toast(t('먼저 첨부할 창을 선택하십시오.'), 'warn'); return; }
      exitDirect();
      const list = attachList(key);
      let added = 0;
      for (const file of fileList) {
        if (list.length >= MAX_ATTACH) { toast(t('첨부는 한 번에 {max}개까지 가능합니다.', { max: MAX_ATTACH }), 'warn'); break; }
        const type = file.type || '';
        const ext = (type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8);
        const item = {
          local: ++attachSeq, file, type, size: file.size,
          name: file.name && file.name !== 'image.png' ? file.name : `pasted-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.${ext}`,
          url: type.startsWith('image/') ? URL.createObjectURL(file) : null,
          status: 'uploading', progress: 0, id: null, error: '',
        };
        item.promise = upload(item);
        list.push(item);
        added += 1;
      }
      if (added) { renderAttachments(); vibrate(8); }
    }

    function upload(item) {
      const job = window.UnivDash.uploadFile(item.file, {
        kind: 'attach', name: item.name, type: item.type,
        onProgress: (ratio) => { item.progress = ratio; updateChip(item); },
      });
      item.xhr = job;   // pressing remove calls job.abort()
      return job.promise.then((data) => {
        Object.assign(item, { status: 'done', id: data.id, path: data.path, progress: 1 });
        updateChip(item);
        return item;
      }, (error) => {
        if (error.aborted) { item.status = 'aborted'; return item; }
        Object.assign(item, { status: 'error', error: error.message });
        if (error.status) toast(`${item.name}: ${item.error}`, 'error');
        updateChip(item);
        return item;
      });
    }

    function chipSub(item) {
      if (item.status === 'uploading') return `${Math.round(item.progress * 100)}% · ${formatSize(item.size)}`;
      if (item.status === 'error') return item.error;
      return formatSize(item.size);
    }
    function renderAttachments() {
      const list = state.selectedKey ? attachList() : [];
      attachTray.classList.toggle('hidden', !list.length);
      attachTray.innerHTML = list.map((item) => `
        <div class="attach-chip ${item.status}" data-local="${item.local}" title="${escapeHtml(item.name)}">
          ${item.url ? `<img class="attach-thumb" src="${item.url}" alt="">` : `<span class="attach-thumb"><i class="fas ${fileIcon(item)}"></i></span>`}
          <span class="attach-meta"><span class="attach-name">${escapeHtml(item.name)}</span><span class="attach-sub">${escapeHtml(chipSub(item))}</span></span>
          <button type="button" class="attach-remove" data-remove="${item.local}" aria-label="${t('{name} 첨부 취소', { name: escapeHtml(item.name) })}"><i class="fas fa-xmark"></i></button>
          <span class="attach-progress" style="width:${item.status === 'uploading' ? Math.round(item.progress * 100) : 0}%"></span>
        </div>`).join('');
    }
    function updateChip(item) {
      const chip = attachTray.querySelector(`[data-local="${item.local}"]`);
      if (!chip) return;
      chip.className = `attach-chip ${item.status}`;
      chip.querySelector('.attach-sub').textContent = chipSub(item);
      chip.querySelector('.attach-progress').style.width = `${item.status === 'uploading' ? Math.round(item.progress * 100) : 0}%`;
    }
    function discard(item, deleteOnServer) {
      if (item.status === 'uploading') item.xhr?.abort();
      if (deleteOnServer && item.id) api('DELETE', `/api/uploads/${encodeURIComponent(item.id)}`).catch(() => {});
      if (item.url) URL.revokeObjectURL(item.url);
    }
    function clearAttachments(key, { deleteOnServer }) {
      (attachments.get(key) || []).forEach((item) => discard(item, deleteOnServer));
      attachments.delete(key);
      if (key === state.selectedKey) renderAttachments();
    }
    attachTray.addEventListener('pointerdown', (event) => { if (event.target.closest('[data-remove]')) event.preventDefault(); });
    attachTray.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove]');
      if (!button) return;
      const list = attachList();
      const index = list.findIndex((item) => item.local === Number(button.dataset.remove));
      if (index < 0) return;
      discard(list[index], true);
      list.splice(index, 1);
      renderAttachments();
    });

    $('#attachBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { addFiles(Array.from(fileInput.files || [])); fileInput.value = ''; });

    // Paste: files/images on the clipboard such as screenshots — attached only while the cursor is in the chat input
    // (so an image pasted somewhere else, e.g. the file explorer, does not also end up in the chat)
    function pastedFiles(event) {
      const items = Array.from(event.clipboardData?.items || []);
      return items.filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
    }
    input.addEventListener('paste', (event) => {
      const files = pastedFiles(event);
      if (!files.length) return;
      event.preventDefault();
      addFiles(files);
    });

    // Drag and drop: dropped on the terminal area it attaches to the current window, dropped on a window in the list to that window
    let dragDepth = 0;
    const draggingFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    function showDrop(event) {
      if (event.target.closest?.('[data-explorer]') || document.body.classList.contains('file-open')) { dropOverlay.classList.add('hidden'); return; }
      const item = event.target.closest?.('.win-item');
      $$('.win-item.drop-target').forEach((el) => { if (el !== item) el.classList.remove('drop-target'); });
      if (item) { item.classList.add('drop-target'); dropOverlay.classList.add('hidden'); return; }
      if (state.selectedKey && isTermVisible()) {
        const w = currentWindow();
        $('#dropTarget').textContent = w ? t('{name} 창에 첨부', { name: displayName(w) }) : '';
        dropOverlay.classList.remove('hidden');
      }
    }
    function hideDrop() {
      dragDepth = 0;
      dropOverlay.classList.add('hidden');
      $$('.win-item.drop-target').forEach((el) => el.classList.remove('drop-target'));
    }
    document.addEventListener('dragenter', (event) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      showDrop(event);
    });
    document.addEventListener('dragover', (event) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      showDrop(event);
    });
    document.addEventListener('dragleave', (event) => {
      if (!draggingFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) hideDrop();
    });
    document.addEventListener('drop', (event) => {
      if (!draggingFiles(event)) return;
      event.preventDefault();
      const item = event.target.closest?.('.win-item');
      hideDrop();
      if (event.target.closest?.('[data-explorer]') || document.body.classList.contains('file-open')) return;  // uploads in the Files tab are handled by Explorer
      const files = Array.from(event.dataTransfer.files || []);
      if (!files.length) return;
      if (item) select(item.dataset.key);
      // Copy into memory as soon as it is dropped (Yoink and the like delete the original after the drag, so reading later gives a 'network error')
      Promise.all(files.map((file) => (file.size > 512 * 1024 * 1024 ? file
        : file.arrayBuffer().then((buf) => new File([buf], file.name, { type: file.type, lastModified: file.lastModified }))
          .catch(() => { toast(t('{name}: 원본 파일을 읽을 수 없습니다. 끌어온 앱(Yoink 등)이 파일을 옮기거나 지웠을 수 있습니다.', { name: file.name }), 'error'); return null; }))))
        .then((copies) => { const ok = copies.filter(Boolean); if (ok.length) addFiles(ok); });
    });
    window.addEventListener('blur', hideDrop);

    // ── Input: special keys ──
    const keyBar = $('#keyBar');
    // Focus must not be taken on press, or the mobile keyboard closes.
    keyBar.addEventListener('pointerdown', (event) => { if (event.target.closest('.key-chip')) event.preventDefault(); });
    keyBar.addEventListener('mousedown', (event) => { if (event.target.closest('.key-chip')) event.preventDefault(); });
    keyBar.addEventListener('click', async (event) => {
      const chip = event.target.closest('.key-chip');
      if (!chip || !state.paneId) return;
      vibrate(6);
      stickBottom = true;
      try {
        if (chip.dataset.text) await socket.send({ t: 'text', pane: state.paneId, text: chip.dataset.text }, { ack: true });
        else await socket.send({ t: 'keys', pane: state.paneId, keys: chip.dataset.keys.split(' ') }, { ack: true });
      } catch (error) { toast(error.message, 'error'); }
    });

    // ── Input: direct input mode (every key goes straight to the terminal) ──
    const directBtn = $('#directBtn');
    let directQueue = Promise.resolve();
    function queueDirect(message) {
      if (!state.paneId) return;
      stickBottom = true;
      const payload = { ...message, pane: state.paneId };
      directQueue = directQueue.then(() => socket.send(payload)).catch(() => {});
    }
    function enterDirect() {
      document.body.classList.add('direct-mode');
      directBtn.setAttribute('aria-pressed', 'true');
      resetDirect();
      direct.focus({ preventScroll: true });
      toast(t('직접 입력 모드: 누르는 키가 바로 터미널로 전달됩니다.'), 'info', null, 2400);
    }
    function exitDirect() {
      if (!document.body.classList.contains('direct-mode')) return;
      document.body.classList.remove('direct-mode');
      directBtn.setAttribute('aria-pressed', 'false');
      direct.blur();
    }
    directBtn.addEventListener('click', () => (document.body.classList.contains('direct-mode') ? exitDirect() : enterDirect()));
    $('#directBanner').addEventListener('click', () => direct.focus({ preventScroll: true }));
    scroll.addEventListener('click', () => {
      if (document.body.classList.contains('direct-mode') && !window.getSelection()?.toString()) direct.focus({ preventScroll: true });
    });

    const KEYMAP = {
      Enter: 'Enter', Backspace: 'BSpace', Tab: 'Tab', Escape: 'Escape', Delete: 'DC', Insert: 'IC',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    };
    direct.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      let key = null;
      if (event.key === 'Tab' && event.shiftKey) key = 'BTab';
      else if (KEYMAP[event.key]) key = KEYMAP[event.key];
      else if (/^F([1-9]|1[0-2])$/.test(event.key)) key = event.key;
      else if ((event.ctrlKey || event.altKey) && event.key.length === 1) {
        const ch = event.key.toLowerCase();
        if (/^[a-z0-9\[\]\\/_@^]$/.test(ch)) key = `${event.ctrlKey && event.altKey ? 'C-M-' : event.ctrlKey ? 'C-' : 'M-'}${ch}`;
      } else if (!event.metaKey && event.key.length === 1) {
        event.preventDefault();
        queueDirect({ t: 'text', text: event.key });
        return;
      }
      if (key) {
        event.preventDefault();
        if (key === 'Escape' && event.shiftKey) { exitDirect(); return; }
        queueDirect({ t: 'keys', keys: [key] });
      }
    });
    // Mobile keyboards often give only input/composition events instead of keydown, so the input catcher is
    // filled with invisible characters (SENTINEL) and input is detected from the change of its value. When it is
    // empty, Android does not send backspace events.
    const SENTINEL = '\u200b\u200b';
    const banner = $('#directBanner');
    const bannerIdle = banner.innerHTML;
    function resetDirect() {
      direct.value = SENTINEL;
      try { direct.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch (e) { /* noop */ }
    }
    function flushDirect() {
      const value = direct.value;
      if (value.startsWith(SENTINEL)) {
        const text = value.slice(SENTINEL.length);
        text.split('\n').forEach((part, index) => {
          if (index > 0) queueDirect({ t: 'keys', keys: ['Enter'] });
          if (part) queueDirect({ t: 'text', text: part });
        });
      } else if (SENTINEL.startsWith(value) || value.length < SENTINEL.length) {
        const removed = SENTINEL.length - value.length;
        for (let i = 0; i < Math.max(1, removed); i++) queueDirect({ t: 'keys', keys: ['BSpace'] });
      }
      resetDirect();
    }
    direct.addEventListener('focus', resetDirect);
    direct.addEventListener('input', (event) => { if (!event.isComposing) flushDirect(); });
    direct.addEventListener('compositionupdate', (event) => {
      banner.innerHTML = `<i class="fas fa-keyboard"></i> ${t('입력 중: {text}', { text: `<span class="font-mono">${escapeHtml(event.data || '')}</span>` })}`;
    });
    direct.addEventListener('compositionend', () => {
      banner.innerHTML = bannerIdle;
      setTimeout(flushDirect, 0);
    });

    // ── Chat (agent session log) ──
    // Claude Code uses the alternate screen, so there is no tmux scrollback. The session log is read to show the whole conversation.
    const logScroll = $('#logScroll');
    const logList = $('#logList');
    const logOlder = $('#logOlder');
    const LOG_PAGE = 80;
    // follow: whether the view sticks to the bottom following the latest content. Turned off only when the user scrolls up on purpose, and on again when they return to the bottom.
    const log = { pane: null, start: 0, total: 0, rendered: new Map(), timer: null, loading: false, available: true, follow: true };
    // Agent windows default to chat (the old stored value term-mode is ignored; a new key is used)
    let termMode = store.get('term-mode-v2', 'log');

    function agentOf(w) { return w?.agent || null; }
    function modeFor(w) { return agentOf(w) ? termMode : 'screen'; }
    function activeScroll() { return modeFor(currentWindow()) === 'log' ? logScroll : scroll; }

    function applyMode() {
      const w = currentWindow();
      const mode = modeFor(w);
      $('#termModes').classList.toggle('hidden', !agentOf(w));
      $$('#termModes [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
      scroll.classList.toggle('hidden', mode === 'log');
      logScroll.classList.toggle('hidden', mode !== 'log');
      $('#termViewBtn').classList.toggle('hidden', mode === 'log');
      $('#chatSearchBtn').classList.toggle('hidden', mode !== 'log');
      $('#chatUsageBtn').classList.toggle('hidden', mode !== 'log');
      if (mode !== 'log') { hideChatSearch(); window.UnivDashChatUsage?.close(); }
      window.UnivDashChatUsage?.modeChanged();
      // In chat mode the terminal direct-input (⌨) button is hidden
      if (mode === 'log') exitDirect();
      $('#directBtn').classList.toggle('hidden', mode === 'log');
      jumpBtn.classList.add('hidden');
      clearInterval(log.timer);
      log.timer = null;
      if (mode === 'log') {
        if (log.pane !== state.paneId) loadLatestLog();
        else { pollLog(); subscribeLog(); }
        // Live updates are pushed over the WebSocket. Only a slow check remains for when the connection is down.
        log.timer = setInterval(() => { if (document.visibilityState === 'visible' && !socket.open) (log.available ? pollLog() : loadLatestLog()); }, 6000);
      } else {
        socket.send({ t: 'logunsub' });
        fitTmux(true);
        // Draw now the terminal screen that was deferred while the chat was shown in lite mode
        if (screenDeferred && lastScreen && lastScreen.pane === state.paneId) { screenDeferred = false; renderScreen(lastScreen); }
      }
    }
    // The server sends new items as soon as the session log file changes (0.4 s cycle)
    function subscribeLog() {
      // Agent windows whose log has not been found yet (new session · before the first prompt) subscribe too → the server tells us right away when the log appears
      if (state.paneId && log.pane === state.paneId && (log.available || agentOf(currentWindow()))) socket.send({ t: 'logsub', pane: state.paneId, since: log.total });
    }
    function setMode(mode) {
      termMode = mode;
      store.set('term-mode-v2', mode);
      applyMode();
    }
    $$('#termModes [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    function logTime(ts) {
      const date = new Date(ts);
      if (Number.isNaN(date.getTime())) return '';
      const today = new Date().toDateString() === date.toDateString();
      return date.toLocaleString(t.locale, today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    // File · folder paths in an answer → links that open on click. Only absolute paths (/… ~/…), paths starting with ./ ../,
    // and file paths with an extension (app/static/app.js, …:123, …#L12) — "and/or" · "1/2" · web addresses are left alone.
    // Everything works on text that already went through escapeHtml (& " inside a path arrive as &amp; &quot;).
    const PATH_CHAR = String.raw`(?:[\p{L}\p{N}\p{M}_.@+\-]|&amp;)`;
    const LINE_SUFFIX = String.raw`(?::\d+(?:[:-]\d+)?|#L\d+(?:-L?\d+)?)`;
    const PATH_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_/.:~@-])((?:~|\.{1,2})?(?:\/${PATH_CHAR}+)+\/?|${PATH_CHAR}+(?:\/${PATH_CHAR}+)+\/?)(${LINE_SUFFIX})?`, 'gu');
    // A Korean particle attached right after a path ("app.js에서", "/home/yojun/univDash에") is left out of the link
    const FILE_THEN_HANGUL = /^(.*\.[A-Za-z0-9]{1,8})(\p{Script=Hangul}+)$/u;
    const DIR_THEN_PARTICLE = /^(.*[A-Za-z0-9_)\]-])(에서는|에서|에는|에도|으로|에|의|을|를|은|는|이|가|로|와|과|도|만|까지|부터)$/;
    const unescapeHtml = (html) => html.replace(/&(amp|lt|gt|quot|#39);/g, (m, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);
    function lineOf(suffix) {
      const m = String(suffix || '').match(/^(?::|#L)(\d+)/);
      return m ? m[1] : '';
    }
    function pathAnchor(path, suffix, label) {
      const lineNo = lineOf(suffix);
      return `<a class="path-link" role="link" tabindex="0" data-open-path="${path}"${lineNo ? ` data-line="${lineNo}"` : ''} title="${t('눌러서 열기')}">${label}</a>`;
    }
    // Does it look like a path: absolute · ~ · ./, or the last segment has an extension, or a folder ending in /
    function looksLikePath(path) {
      if (!path.includes('/') || /^\d+(\/\d+)+$/.test(path)) return false;
      if (/^(~|\/|\.{1,2}\/)/.test(path)) return true;
      const last = path.replace(/\/$/, '').split('/').pop();
      return /\.[A-Za-z0-9]{1,8}$/.test(last) || path.endsWith('/');
    }
    // Link target → { path, suffix } (cleans up file:// · encodings such as %20 · <…> wrapping). Takes escaped text and returns escaped text.
    function splitTarget(target) {
      let raw = unescapeHtml(target).trim().replace(/^file:\/\//i, '');
      if (/%[0-9A-Fa-f]{2}/.test(raw)) { try { raw = decodeURI(raw); } catch (e) { /* keep as is */ } }
      const m = raw.match(new RegExp(`^(.*?)(${LINE_SUFFIX})?$`, 'u'));
      return { path: escapeHtml(m[1]), suffix: m[2] || '' };
    }
    // Markdown links [name](target) · [name](<target with spaces>): web addresses open in a new tab, file paths become open links
    const MD_LINK = /\[([^\[\]\n]+)\]\((?:&lt;([^\n]+?)&gt;|((?:[^\s()]|\([^\s()]*\))+))\)/g;
    function mdLinks(html) {
      return html.replace(MD_LINK, (whole, label, angled, plain) => {
        const target = angled || plain;
        if (/^https?:\/\//i.test(unescapeHtml(target))) return `<a class="md-link" href="${target}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target)) return whole;  // other schemes such as mailto: are left as they are
        const { path, suffix } = splitTarget(target);
        if (!path || /^#/.test(path)) return whole;
        // Brackets that are not a path, like [x!y!](1/4) in a formula, are not turned into links
        const bare = unescapeHtml(path);
        if (!looksLikePath(bare) && !/^[^/\s]+\.[A-Za-z0-9]{1,8}$/.test(bare)) return whole;
        return pathAnchor(path, suffix, label);
      });
    }
    // When the whole content of `code` is a path (even with spaces), all of it becomes the link
    function codePath(content) {
      const m = content.match(new RegExp(`^(.*?)(${LINE_SUFFIX})?$`, 'u'));
      const path = m[1];
      if (!/ /.test(path) || /^\s|\s$|\s{2}|[`<>]|&quot;|&#39;/.test(path) || !looksLikePath(path)) return null;
      return pathAnchor(path, m[2] || '', content);
    }
    function linkPaths(html) {
      // Only the text parts: the inside of tags (attributes) and parts that are already links (<a>…</a>) are left alone
      let inLink = 0;
      return html.split(/(<[^>]+>)/).map((part) => {
        if (part.startsWith('<')) {
          if (/^<a[\s>]/i.test(part)) inLink += 1;
          else if (/^<\/a>/i.test(part)) inLink = Math.max(0, inLink - 1);
          return part;
        }
        if (inLink) return part;
        return part.replace(PATH_RE, (whole, raw, suffix = '') => {
          let path = raw;
          let tail = '';
          while (/[.,;:!?)]$/.test(path)) { tail = path.slice(-1) + tail; path = path.slice(0, -1); }
          if (tail) suffix = '';  // a shape like "app.js.:12" is not treated as a line number
          const segments = path.split('/');
          const last = segments.pop();
          const cut = last.match(FILE_THEN_HANGUL) || (/^(~|\/)/.test(path) && !suffix ? last.match(DIR_THEN_PARTICLE) : null);
          if (cut) { path = [...segments, cut[1]].join('/'); tail = cut[2] + suffix + tail; suffix = ''; }
          if (!looksLikePath(path)) return whole;
          return pathAnchor(path, suffix, path + suffix) + tail;
        });
      }).join('');
    }
    // Agent answers: light markdown + math ($…$ · $$…$$ · \(…\) · \[…\] → KaTeX, common.js) + path links
    function mdLite(text) {
      return String(text).split('```').map((part, index) => {
        if (index % 2) return `<pre class="md-code">${escapeHtml(part.replace(/^[\w+.-]*\n/, ''))}</pre>`;
        const { text: plain, math } = window.UnivDash.math.extract(part);
        // One line break before and after block math is removed because the math box already takes its own line (so no empty line appears)
        const tidy = plain.replace(/\n?(KTXM(\d+)Z)\n?/g, (m, token, i) => (math[Number(i)]?.display ? token : m));
        return window.UnivDash.math.render(linkPaths(mdTables(tidy)), math);
      }).join('');
    }
    const mdInline = (text) => mdLinks(escapeHtml(text)
      .replace(/`([^`\n]+)`/g, (m, code) => `<code>${codePath(code) || code}</code>`))
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^(#{1,6}) (.+)$/gm, '<span class="md-h">$2</span>');
    // GFM tables: header row + separator row (|---|:--:|) + body rows. Everything else stays line by line (pre-wrap)
    const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    function tableCells(line) {
      let row = line.trim();
      if (row.startsWith('|')) row = row.slice(1);
      if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
      return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
    }
    function mdTables(text) {
      const lines = text.split('\n');
      const out = [];
      let buf = [];
      const flush = () => { if (buf.length) out.push(mdInline(buf.join('\n'))); buf = []; };
      for (let i = 0; i < lines.length; i += 1) {
        const sep = lines[i + 1];
        if (lines[i].includes('|') && sep?.includes('|') && TABLE_SEP.test(sep)) {
          const head = tableCells(lines[i]);
          const aligns = tableCells(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
          if (head.length === aligns.length) {
            let j = i + 2;
            const rows = [];
            while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(tableCells(lines[j++]));
            const cell = (tag, value, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${mdInline(value || '')}</${tag}>`;
            // The table's own margin stands in for the empty lines before and after it
            while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
            flush();
            out.push(`<div class="md-table"><table><thead><tr>${head.map((v, k) => cell('th', v, k)).join('')}</tr></thead><tbody>${
              rows.map((r) => `<tr>${aligns.map((_, k) => cell('td', r[k], k)).join('')}</tr>`).join('')}</tbody></table></div>`);
            i = j - 1;
            while (lines[i + 1] !== undefined && !lines[i + 1].trim()) i += 1;
            continue;
          }
        }
        buf.push(lines[i]);
      }
      flush();
      // No line break right before or after a table block, because the block takes its own line
      return out.reduce((acc, piece) => (acc && !acc.endsWith('</div>') && !piece.startsWith('<div class="md-table">') ? `${acc}\n${piece}` : acc + piece), '');
    }
    const TOOL_ICONS = { run_command: 'fa-terminal', command_status: 'fa-terminal', send_command_input: 'fa-terminal', read_file: 'fa-file-lines', view_file: 'fa-file-lines', write_file: 'fa-file-pen', write_to_file: 'fa-file-pen', edit_file: 'fa-pen', replace_file_content: 'fa-pen', multi_replace_file_content: 'fa-pen', grep_search: 'fa-magnifying-glass', codebase_search: 'fa-magnifying-glass', find_by_name: 'fa-folder-open', list_dir: 'fa-folder-open', search_web: 'fa-globe', read_url_content: 'fa-globe', invoke_subagent: 'fa-robot', browser_subagent: 'fa-robot', Bash: 'fa-terminal', exec_command: 'fa-terminal', shell: 'fa-terminal', Read: 'fa-file-lines', Edit: 'fa-pen', Write: 'fa-file-pen', MultiEdit: 'fa-pen', apply_patch: 'fa-pen', Grep: 'fa-magnifying-glass', Glob: 'fa-folder-open', WebFetch: 'fa-globe', WebSearch: 'fa-globe', Agent: 'fa-robot', Task: 'fa-robot', TodoWrite: 'fa-list-check', spawn_agent: 'fa-robot', SendMessage: 'fa-robot', send_message: 'fa-robot', followup_task: 'fa-robot', list_agents: 'fa-robot' };
    // Subagent-related tools are shown by what they mean instead of by name
    const TOOL_LABELS = { Agent: t('서브에이전트'), Task: t('서브에이전트'), spawn_agent: t('서브에이전트'), SendMessage: t('추가 지시'), send_message: t('서브에이전트에 메시지'), followup_task: t('추가 지시'), list_agents: t('서브에이전트 목록') };
    const SUB_FAILED = new Set(['failed', 'error', 'killed', 'cancelled']);
    function logItemHtml(item) {
      const agentName = AGENT_NAMES[log.agent] || 'Agent';
      if (item.kind === 'user') {
        // Attached images (a cache the server pulled out of the transcript · the name is a content hash, so it stays cached for a long time as is)
        const images = (item.images || []).filter((name) => /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(name))
          .map((name) => `<a class="msg-img" href="/api/transcript/image/${name}" target="_blank" rel="noopener" title="${t('원본 크기로 보기')}"><img src="/api/transcript/image/${name}" alt="${t('첨부한 그림')}" loading="lazy" decoding="async"></a>`).join('');
        return `<div class="msg msg-user"><div class="msg-meta"><button type="button" class="copy-btn" data-copy="${item.id}" title="${t('프롬프트 복사')}" aria-label="${t('프롬프트 복사')}"><i class="far fa-copy"></i></button>${t('나 · {time}', { time: escapeHtml(logTime(item.ts)) })}</div>${images ? `<div class="msg-imgs">${images}</div>` : ''}${item.text ? `<div class="msg-body">${escapeHtml(item.text)}</div>` : ''}</div>`;
      }
      if (item.kind === 'assistant') {
        return `<div class="msg msg-ai"><div class="msg-meta">${agentName} · ${escapeHtml(logTime(item.ts))}<button type="button" class="copy-btn" data-copy="${item.id}" title="${t('답변 복사')}" aria-label="${t('답변 복사')}"><i class="far fa-copy"></i></button></div><div class="msg-body">${mdLite(item.text)}</div></div>`;
      }
      // System lines come from the server in Korean; the known ones (compaction, interrupted) have translations.
      if (item.kind === 'system') return `<div class="msg-system">${escapeHtml(t(item.text || ''))}</div>`;
      if (item.kind === 'subagent') {
        // A subagent's report (finished · interim message): one-line preview, the whole text on click
        const failed = SUB_FAILED.has(item.status);
        const state = item.status === 'message' ? t('메시지') : failed ? t('실패') : t('완료');
        const preview = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        return `<details class="msg-tool msg-sub ${failed ? 'error' : ''}"><summary><i class="fas fa-robot text-[11px]"></i>
          <span class="tool-name">${escapeHtml(item.name || t('서브에이전트'))}</span><span class="sub-badge">${state}</span><span class="tool-sum">${escapeHtml(preview)}</span><span class="sub-time">${escapeHtml(logTime(item.ts))}</span></summary>
          <div class="msg-body sub-body">${item.text ? mdLite(item.text) : t('(내용 없음)')}<button type="button" class="copy-btn" data-copy="${item.id}" aria-label="${t('복사')}"><i class="far fa-copy"></i> ${t('복사')}</button></div></details>`;
      }
      if (Array.isArray(item.diffs) && item.diffs.length) return toolDiffHtml(item);
      const pending = item.output === null || item.output === undefined;
      const stateIcon = pending ? '<i class="fas fa-circle-notch fa-spin text-slate-400"></i>' : item.error ? '<i class="fas fa-xmark"></i>' : '<i class="fas fa-check"></i>';
      const sub = item.agent ? ` data-sub-agent="${escapeHtml(item.agent)}"` : '';
      const auto = item.agent ? '' : ' auto-open';
      return `<details class="msg-tool${auto} ${item.error ? 'error' : ''}" data-item="${item.id}"${sub}${item.agent ? '' : ' open'}><summary><i class="fas ${TOOL_ICONS[item.name] || 'fa-wrench'} text-slate-500 text-[11px]"></i>
          <span class="tool-name" title="${escapeHtml(item.name)}">${escapeHtml(TOOL_LABELS[item.name] || item.name)}</span>${item.running ? `<span class="sub-badge run">${t('작업 중')}</span>` : ''}<span class="tool-sum">${escapeHtml(item.summary || '')}</span><span class="tool-state">${stateIcon}</span></summary>
          ${item.agent ? '<div class="sub-live"></div>' : ''}${pending ? '' : foldedHtml(toolOutputLines(item.output), OUTPUT_FOLD, (shown, rest) => `<pre>${shown.join('\n')}${rest.length ? `<template data-fold>\n${rest.join('\n')}</template>` : ''}</pre>`)}</details>`;
    }
    // Long output · diffs draw only the first part; the rest sits in a <template> (neither rendered nor laid out) and is attached when 'show more' is pressed.
    // No content is thrown away. The inner vertical scroll is removed so the wheel does not steal the chat scroll.
    const OUTPUT_FOLD = 24;
    const DIFF_FOLD = 60;
    function foldedHtml(lines, limit, wrap) {
      // When it overflows only a little (folding would save just a few lines), everything is shown
      const cut = lines.length > limit + 8 ? limit : lines.length;
      const shown = lines.slice(0, cut);
      const rest = lines.slice(cut);
      return wrap(shown, rest) + (rest.length ? `<button type="button" class="fold-more" data-fold-more><i class="fas fa-angles-down"></i> ${t('나머지 {count}줄 더 보기', { count: rest.length })}</button>` : '');
    }
    function unfold(button) {
      const box = button.previousElementSibling;
      const template = box?.querySelector(':scope > template[data-fold]');
      if (template) template.replaceWith(template.content);
      button.closest('.msg-tool')?.setAttribute('data-unfolded', '');
      button.remove();
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-fold-more]');
      if (button) { event.preventDefault(); unfold(button); }
    });
    // Splitting the chat wheel: cards (code · diff · tables) scroll horizontally, but a mostly vertical wheel · trackpad gesture scrolls
    // the whole chat, not the card. The card moves only when the gesture is mostly horizontal (sideways swipe · Shift+wheel).
    // Only wheel events from over a card are blocked (preventDefault); everything else keeps the browser's default scroll → normal scrolling stays smooth.
    const SCROLLS = /(auto|scroll)/;
    function innerScroller(target, chat) {
      for (let el = target instanceof Element ? target : target?.parentElement; el && el !== chat; el = el.parentElement) {
        if (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) continue;
        const style = getComputedStyle(el);
        if (SCROLLS.test(style.overflowX) || SCROLLS.test(style.overflowY)) return { el, style };
      }
      return null;
    }
    function routeChatWheel(chat) {
      chat.addEventListener('wheel', (event) => {
        if (event.ctrlKey || event.defaultPrevented) return;   // pinch zoom
        const inner = innerScroller(event.target, chat);
        if (!inner) return;
        const dx = event.deltaX;
        const dy = event.shiftKey && !dx ? 0 : event.deltaY;
        if (Math.abs(dx) > Math.abs(dy) || (event.shiftKey && !event.deltaX)) return;   // mostly horizontal → the card
        // A box that scrolls vertically (the subagent live transcript) scrolls itself until it reaches its end
        const { el, style } = inner;
        if (SCROLLS.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) {
          if ((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) || (dy < 0 && el.scrollTop > 0)) return;
        }
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? chat.clientHeight : 1;
        chat.scrollTop += dy * unit;
      }, { passive: false });
    }
    window.UnivDashRouteChatWheel = routeChatWheel;
    routeChatWheel(logScroll);
    // Tool output: when it has the shape of a diff, like git diff, each line is coloured as in a terminal (otherwise left as is). A list of HTML lines.
    const DIFF_OUTPUT = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- (?:a\/|\/dev\/null))/m;
    function toolOutputLines(output) {
      const text = output || t('(출력 없음)');
      if (!DIFF_OUTPUT.test(text)) return text.split('\n').map((line) => escapeHtml(line));
      let lang = '';
      return text.split('\n').map((line) => {
        const file = line.match(/^\+\+\+ (?:b\/)?(.+)$/) || line.match(/^diff --git a\/\S+ b\/(.+)$/);
        if (file) lang = diffLang(file[1]);
        if (/^(?:diff --git |index |--- |\+\+\+ )/.test(line)) return `<span class="do-meta">${escapeHtml(line)}</span>`;
        if (line.startsWith('@@')) return `<span class="do-hunk">${escapeHtml(line)}</span>`;
        if (line.startsWith('+')) return `<span class="do-line df-add"><b>+</b>${diffHighlight(line.slice(1), lang)}</span>`;
        if (line.startsWith('-')) return `<span class="do-line df-del"><b>-</b>${diffHighlight(line.slice(1), lang)}</span>`;
        return escapeHtml(line);
      });
    }
    // Diff line highlighting: the language is picked from the file extension and coloured with highlight.js (like Claude Code in the terminal)
    const DIFF_LANG_ALIAS = { mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', tsx: 'typescript', vue: 'xml', svelte: 'xml', jinja: 'xml', j2: 'xml', htm: 'xml', zsh: 'bash', env: 'bash', toml: 'ini', cfg: 'ini', conf: 'nginx', jsonl: 'json' };
    function diffLang(file) {
      const name = String(file || '').split(/[\\/]/).pop().toLowerCase();
      if (name === 'dockerfile') return 'dockerfile';
      if (name === 'makefile') return 'makefile';
      const ext = name.includes('.') ? name.split('.').pop() : '';
      const lang = DIFF_LANG_ALIAS[ext] || ext;
      return lang && window.hljs?.getLanguage(lang) ? lang : '';
    }
    function diffHighlight(text, lang) {
      if (!text) return '';
      if (lang && window.hljs) {
        try { return window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch (e) { /* noop */ }
      }
      return escapeHtml(text);
    }
    // Highlighting the changed part (words): adjacent runs of deleted and added lines are paired in order, and the middle left after removing the common prefix and suffix is marked
    function diffWordRanges(lines) {
      const ranges = new Map();
      for (let i = 0; i < lines.length;) {
        if (lines[i][0] !== '-') { i += 1; continue; }
        let j = i;
        while (j < lines.length && lines[j][0] === '-') j += 1;
        let k = j;
        while (k < lines.length && lines[k][0] === '+') k += 1;
        const pairs = Math.min(j - i, k - j);
        for (let p = 0; p < pairs; p++) {
          const a = lines[i + p].slice(1);
          const b = lines[j + p].slice(1);
          let pre = 0;
          while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
          let suf = 0;
          while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
          const changed = Math.max(a.length - pre - suf, b.length - pre - suf);
          // Lines that changed almost entirely get only the whole-line colour (word highlighting would just be noisy)
          if (!pre && !suf) continue;
          if (changed > Math.max(a.length, b.length) * 0.7) continue;
          ranges.set(i + p, [pre, a.length - suf]);
          ranges.set(j + p, [pre, b.length - suf]);
        }
        i = k > j ? k : j;
      }
      return ranges;
    }
    function diffCodeHtml(text, lang, range) {
      if (!range || range[0] >= range[1]) return diffHighlight(text, lang);
      const [from, to] = range;
      return diffHighlight(text.slice(0, from), lang) + `<span class="df-word">${diffHighlight(text.slice(from, to), lang)}</span>` + diffHighlight(text.slice(to), lang);
    }
    // Code changes (Edit · Write · apply_patch): the changed lines laid out as in a terminal (line numbers · red deletions · green additions)
    function toolDiffHtml(item) {
      const pending = item.output === null || item.output === undefined;
      const stateIcon = pending ? '<i class="fas fa-circle-notch fa-spin text-slate-400"></i>' : item.error ? '<i class="fas fa-xmark"></i>' : '<i class="fas fa-check"></i>';
      const add = item.diffs.reduce((n, d) => n + (d.add || 0), 0);
      const del = item.diffs.reduce((n, d) => n + (d.del || 0), 0);
      const files = item.diffs.map((d) => d.file.split('/').pop()).filter(Boolean);
      const sumValues = { files: escapeHtml(files.slice(0, 3).join(', ')), more: files.length - 3 };
      const many = files.length > 3;
      const summary = item.diffs.every((d) => d.op === 'add') ? (many ? t('{files} 외 {more} 만듦', sumValues) : t('{files} 만듦', sumValues))
        : item.diffs.every((d) => d.op === 'delete') ? (many ? t('{files} 외 {more} 지움', sumValues) : t('{files} 지움', sumValues))
          : (many ? t('{files} 외 {more} 수정', sumValues) : t('{files} 수정', sumValues));
      const body = item.diffs.map((d) => {
        const lang = diffLang(d.file);
        const rows = d.hunks.flatMap((h, index) => {
          let oldNo = h.o ?? null;
          let newNo = h.n ?? null;
          const sep = index > 0 ? ['<div class="df-row df-gap"><span class="df-no"></span><span class="df-sign"></span><span class="df-text">⋯</span></div>'] : [];
          const words = diffWordRanges(h.lines);
          return sep.concat(h.lines.map((line, i) => {
            const sign = line[0];
            const kind = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
            const shownNo = kind === 'del' ? oldNo : newNo;
            if (kind !== 'add' && oldNo !== null) oldNo += 1;
            if (kind !== 'del' && newNo !== null) newNo += 1;
            return `<div class="df-row df-${kind}"><span class="df-no">${shownNo ?? ''}</span><span class="df-sign">${kind === 'ctx' ? '' : sign}</span><span class="df-text">${diffCodeHtml(line.slice(1), lang, words.get(i)) || ' '}</span></div>`;
          }));
        });
        const opLabel = { add: t('새 파일'), delete: t('삭제'), update: '' }[d.op] || '';
        const bodyHtml = d.op === 'delete' && !d.hunks.length ? ''
          : foldedHtml(rows, DIFF_FOLD, (shown, rest) => `<div class="df-body">${shown.join('')}${rest.length ? `<template data-fold>${rest.join('')}</template>` : ''}</div>`);
        return `<div class="df-file"><div class="df-head"><span class="df-path" title="${escapeHtml(d.file)}">${escapeHtml(d.file)}</span>${opLabel ? `<span class="df-op">${opLabel}</span>` : ''}<span class="df-stat"><b class="a">+${d.add || 0}</b> <b class="d">−${d.del || 0}</b></span></div>
          ${bodyHtml}${d.cut ? `<div class="df-cut">${t('… 길어서 일부만 표시됩니다 (터미널 탭에서 전체)')}</div>` : ''}</div>`;
      }).join('');
      const failed = item.error && item.output ? `<pre>${escapeHtml(item.output)}</pre>` : '';
      return `<details class="msg-tool msg-diff auto-open ${item.error ? 'error' : ''}" data-item="${item.id}" open><summary><i class="fas fa-pen text-slate-500 text-[11px]"></i>
          <span class="tool-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name === 'exec' ? 'apply_patch' : item.name)}</span>
          <span class="tool-sum">${summary}</span>
          <span class="df-stat"><b class="a">+${add}</b> <b class="d">−${del}</b></span><span class="tool-state">${stateIcon}</span></summary>${failed}${body}</details>`;
    }
    // When a subagent item is expanded: show that subagent's conversation (its work) and keep refreshing while it stays open
    const SUB_POLL_MS = 1500;
    async function showSubagent(details) {
      const box = details.querySelector(':scope > .sub-live');
      const pane = details.closest('[data-pane]')?.dataset.pane;
      if (!box || !pane || details.dataset.subLoading) return;
      details.dataset.subLoading = '1';
      try {
        const data = await api('GET', `/api/transcript/sub?${new URLSearchParams({ pane, agent: details.dataset.subAgent, limit: 60 })}`);
        if (!details.open || !details.isConnected) return;
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        const sig = `${data.total}:${JSON.stringify(data.items.at(-1) ?? null)}`;
        if (box.dataset.sig !== sig) {
          box.dataset.sig = sig;
          box.innerHTML = !data.available ? `<div class="sub-empty">${t('서브에이전트 기록을 찾지 못했습니다.')}</div>`
            : `${data.start > 0 ? `<div class="sub-empty">${t('앞의 {count}개 생략 · 최근 작업만 표시됩니다', { count: data.start })}</div>` : ''}${data.items.map((item) => logItemHtml(item)).join('') || `<div class="sub-empty">${t('아직 기록이 없습니다.')}</div>`}`;
          box.querySelectorAll('.copy-btn').forEach((b) => b.remove());   // copy buttons are keyed to main-conversation items, so they are removed
          if (atBottom || !box.dataset.shown) box.scrollTop = box.scrollHeight;
          box.dataset.shown = '1';
        }
      } catch (error) {
        box.innerHTML = `<div class="sub-empty">${escapeHtml(error.message)}</div>`;
      } finally {
        delete details.dataset.subLoading;
      }
      clearTimeout(details._subTimer);
      if (details.open && details.isConnected) details._subTimer = setTimeout(() => { if (document.visibilityState === 'visible') showSubagent(details); else details._subTimer = setTimeout(() => showSubagent(details), SUB_POLL_MS); }, SUB_POLL_MS);
    }
    document.addEventListener('toggle', (event) => {
      const details = event.target;
      // Tools · code changes are open by default → once the user collapses one it stays collapsed across redraws
      if (details instanceof HTMLDetailsElement && details.classList.contains('auto-open')) {
        if (details.open) delete details.dataset.userClosed; else details.dataset.userClosed = '1';
      }
      if (!(details instanceof HTMLDetailsElement) || !details.dataset.subAgent) return;
      if (details.open) showSubagent(details); else clearTimeout(details._subTimer);
    }, true);
    function logAtBottom() { return logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 60; }
    function renderLogOlder() {
      logOlder.classList.toggle('hidden', log.start <= 0);
      logOlder.innerHTML = log.loading ? `<i class="fas fa-circle-notch fa-spin"></i> ${t('이전 대화를 불러오는 중')}` : `<button type="button">${t('이전 대화 {count}개 더 보기', { count: log.start })}</button>`;
    }
    // Final answer = the last agent answer between each pair of my prompts (the copy button shows only on prompts and final answers)
    function markFinalAnswers(list) {
      let last = null;
      for (const el of list.children) {
        if (el.classList.contains('msg-user')) { last?.classList.add('final'); last = null; }
        else if (el.classList.contains('msg-ai')) { el.classList.remove('final'); last = el; }
      }
      last?.classList.add('final');
    }
    function upsertLogItems(items, options) {
      upsertLogItemsRaw(items, options);
      markFinalAnswers(logList);
    }
    function upsertLogItemsRaw(items, { prepend = false } = {}) {
      const html = [];
      items.forEach((item) => {
        const key = JSON.stringify(item);
        const existing = log.rendered.get(item.id);
        if (existing) {
          if (existing.key !== key) {
            const open = existing.el.open;
            const tmp = document.createElement('div');
            tmp.innerHTML = logItemHtml(item);
            const el = tmp.firstElementChild;
            if (open) el.open = true;
            else if (existing.el.dataset.userClosed) { el.open = false; el.dataset.userClosed = '1'; }
            // Items expanded with 'show more' stay expanded across redraws
            if (existing.el.hasAttribute('data-unfolded')) el.querySelectorAll('[data-fold-more]').forEach(unfold);
            existing.el.replaceWith(el);
            log.rendered.set(item.id, { key, el, item });
          }
          return;
        }
        html.push([item, key]);
      });
      if (!html.length) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = html.map(([item]) => logItemHtml(item)).join('');
      const nodes = Array.from(tmp.children);
      nodes.forEach((el, index) => log.rendered.set(html[index][0].id, { key: html[index][1], el, item: html[index][0] }));
      if (prepend) { logList.prepend(...nodes); return; }
      // In id order: so an earlier item that arrived late is not appended at the very bottom
      nodes.forEach((el, index) => {
        const id = html[index][0].id;
        let after = null;
        for (const [other, entry] of log.rendered) if (other > id && entry.el.isConnected && (!after || other < after[0])) after = [other, entry.el];
        if (after) logList.insertBefore(el, after[1]); else logList.append(el);
      });
    }
    async function fetchLog(params) {
      const query = new URLSearchParams({ pane: state.paneId, ...params });
      return api('GET', `/api/transcript?${query}`);
    }
    // pane → the first chat page received last. On reopening this is drawn first (instantly) and replaced when new data arrives.
    const chatCache = new Map();
    // When the agent is switched (Claude ↔ Codex), the transcript changes to the new agent's even for the same pane
    window.addEventListener('univdash:agent-switched', (event) => {
      const { pane } = event.detail || {};
      chatCache.delete(pane);
      screenCache.delete(pane);
      if (state.paneId !== pane) return;
      [2500, 6000].forEach((ms) => setTimeout(() => {
        if (state.paneId !== pane) return;
        log.pane = null;
        modelRequest += 1;
        modelState.model = null;
        modelState.at = 0;
        applyMode();
        refreshModel(true);
      }, ms));
    });
    const chatInflight = new Map();   // pane → prefetch request in flight
    function cacheChat(pane, data) {
      chatCache.delete(pane);
      chatCache.set(pane, data);
      if (chatCache.size > 12) chatCache.delete(chatCache.keys().next().value);
    }
    // The chat is prefetched the moment a window in the list starts being pressed (for a mouse, the moment it hovers) — by the time the finger lifts it has already arrived
    function prefetchChat(key) {
      const w = byKey().get(key);
      if (!w || modeFor(w) !== 'log' || key === state.selectedKey) return;
      const pane = (w.panes.find((p) => p.command === w.agent) || w.panes.find((p) => p.active) || w.panes[0])?.id;
      if (!pane || chatCache.has(pane) || chatInflight.has(pane)) return;
      const request = api('GET', `/api/transcript?${new URLSearchParams({ pane, limit: LOG_PAGE })}`)
        .then((data) => { cacheChat(pane, data); return data; })
        .finally(() => chatInflight.delete(pane));
      request.catch(() => {});
      chatInflight.set(pane, request);
    }
    let hoverTimer = 0;
    list.addEventListener('pointerdown', (event) => {
      const item = event.target.closest('.win-item');
      if (item && !event.target.closest('[data-more]')) prefetchChat(item.dataset.key);
    }, { passive: true });
    list.addEventListener('pointerover', (event) => {
      if (event.pointerType !== 'mouse') return;
      const item = event.target.closest('.win-item');
      clearTimeout(hoverTimer);
      if (item) hoverTimer = setTimeout(() => prefetchChat(item.dataset.key), 80);
    });
    function showLatestLog(data) {
      log.rendered.clear();
      log.queued = [];
      log.submitted = [];
      chatPending.innerHTML = '';
      log.available = data.available;
      log.agent = data.agent;
      logList.innerHTML = '';
      if (!data.available) {
        logList.innerHTML = data.agent
          ? `<div class="log-empty">${t('아직 대화가 없습니다.<br>첫 프롬프트를 보내면 여기에 바로 표시됩니다.')}</div>`
          : `<div class="log-empty">${t('이 창의 채팅(에이전트 세션 로그)을 찾지 못했습니다.<br>Claude Code · Codex · Gemini 가 실행 중인 창에서만 볼 수 있습니다.')}</div>`;
        renderPending();
        return;
      }
      log.start = data.start;
      log.total = data.total;
      log.queued = data.queued || [];
      log.submitted = data.submitted || [];
      renderPending();
      if (!data.items.length) logList.innerHTML = `<div class="log-empty">${t('아직 대화가 없습니다.')}</div>`;
      upsertLogItems(data.items);
      renderLogOlder();
      followBottom();
    }
    // Hide the chat search box (when switching windows or going to the terminal view · may be called before the search code below, so it uses only the DOM)
    function hideChatSearch() {
      document.getElementById('chatSearch')?.classList.add('hidden');
      document.getElementById('chatSearchResults')?.classList.add('hidden');
      window.UnivDashChatUsage?.paneChanged();
    }
    async function loadLatestLog() {
      const pane = state.paneId;
      if (!pane) return;
      hideChatSearch();
      logList.dataset.pane = pane;
      log.pane = pane;
      lastStatusKey = '';
      chatStatus.classList.add('hidden');
      logOlder.classList.add('hidden');
      const cached = chatCache.get(pane);
      if (cached) showLatestLog(cached);
      else {
        log.rendered.clear();
        log.queued = [];
        chatPending.innerHTML = '';
        logList.innerHTML = `<div class="log-empty"><i class="fas fa-circle-notch fa-spin"></i> ${t('채팅을 불러오는 중...')}</div>`;
      }
      try {
        const data = await (chatInflight.get(pane) || fetchLog({ limit: LOG_PAGE }));
        cacheChat(pane, data);
        if (pane !== state.paneId || log.pane !== pane) return;
        // When it equals the cache, do not redraw (avoids flicker · scroll jumps)
        const same = cached && cached.available === data.available && cached.start === data.start && cached.total === data.total
          && JSON.stringify(cached.queued || []) === JSON.stringify(data.queued || [])
          && JSON.stringify(cached.submitted || []) === JSON.stringify(data.submitted || [])
          && JSON.stringify(cached.items?.at(-1) ?? null) === JSON.stringify(data.items?.at(-1) ?? null);
        if (!same) showLatestLog(data);
        subscribeLog();
      } catch (error) {
        if (!cached) logList.innerHTML = `<div class="log-empty">${escapeHtml(error.message)}</div>`;
      }
    }
    async function loadOlderLog() {
      if (log.loading || log.start <= 0 || !log.available) return;
      log.loading = true;
      renderLogOlder();
      const pane = state.paneId;
      const newStart = Math.max(0, log.start - LOG_PAGE);
      try {
        const data = await fetchLog({ start: newStart, limit: log.start - newStart });
        if (pane !== state.paneId) return;
        const fromBottom = logScroll.scrollHeight - logScroll.scrollTop;
        logList.querySelector('.log-empty')?.remove();
        upsertLogItems(data.items, { prepend: true });
        log.start = newStart;
        logScroll.scrollTop = logScroll.scrollHeight - fromBottom;  // keep the position being read
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        log.loading = false;
        renderLogOlder();
      }
    }
    // ── Chat search: the server searches only my prompts · the agent's final answers across the whole conversation (including earlier history not loaded yet) ──
    const chatSearch = $('#chatSearch');
    const chatSearchInput = $('#chatSearchInput');
    const chatSearchResults = $('#chatSearchResults');
    const chatSearchCount = $('#chatSearchCount');
    const search = { pane: null, q: '', items: [], index: -1, timer: 0, seq: 0, terms: [], marked: null };
    const searchTerms = (q) => [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
    function markTerms(text, terms) {
      // Find the matching ranges in the original text, then escape each piece and wrap it in <mark>
      const lower = text.toLowerCase();
      const ranges = [];
      terms.forEach((term) => { let at = lower.indexOf(term); while (at >= 0) { ranges.push([at, at + term.length]); at = lower.indexOf(term, at + term.length); } });
      ranges.sort((a, b) => a[0] - b[0]);
      let out = '';
      let pos = 0;
      ranges.forEach(([from, to]) => { if (from < pos) { if (to > pos) { out += `<mark>${escapeHtml(text.slice(pos, to))}</mark>`; pos = to; } return; } out += escapeHtml(text.slice(pos, from)) + `<mark>${escapeHtml(text.slice(from, to))}</mark>`; pos = to; });
      return out + escapeHtml(text.slice(pos));
    }
    function renderSearchCount(data) {
      if (!search.q) { chatSearchCount.textContent = ''; return; }
      if (!data) { chatSearchCount.textContent = t('찾는 중…'); return; }
      const n = search.items.length;
      chatSearchCount.textContent = !n ? t('없음') : search.index >= 0 ? `${search.index + 1}/${n}${data.truncated ? '+' : ''}` : t('{hits}개', { hits: `${n}${data.truncated ? '+' : ''}` });
    }
    function renderSearchResults(data) {
      const agentName = AGENT_NAMES[log.agent] || t('에이전트');
      if (!search.q) { chatSearchResults.classList.add('hidden'); chatSearchResults.innerHTML = ''; return; }
      chatSearchResults.classList.remove('hidden');
      if (!data) { chatSearchResults.innerHTML = `<div class="cs-empty"><i class="fas fa-circle-notch fa-spin"></i> ${t('찾는 중…')}</div>`; return; }
      if (data.available === false) { chatSearchResults.innerHTML = `<div class="cs-empty">${t('이 창의 대화 기록을 찾지 못했습니다.')}</div>`; return; }
      if (!search.items.length) { chatSearchResults.innerHTML = `<div class="cs-empty">${t('맞는 프롬프트 · 답변이 없습니다.')}</div>`; return; }
      chatSearchResults.innerHTML = search.items.map((item, index) => `
        <button type="button" class="cs-item ${index === search.index ? 'on' : ''}" data-cs-index="${index}" role="option" aria-selected="${index === search.index}">
          <span class="cs-who ${item.kind === 'user' ? 'me' : 'ai'}">${item.kind === 'user' ? t('나') : escapeHtml(agentName)}</span>
          <span class="cs-text">${markTerms(item.snippet.replace(/\*\*|`/g, ''), search.terms)}</span>
          <span class="cs-time">${escapeHtml(logTime(item.ts))}</span>
        </button>`).join('') + (data.truncated ? `<div class="cs-empty">${t('최근 {shown}개만 표시됩니다 (전체 {total}개). 낱말을 더 넣어 좁혀 보십시오.', { shown: search.items.length, total: data.matches })}</div>` : '');
    }
    async function runChatSearch() {
      const q = chatSearchInput.value.trim();
      const pane = state.paneId;
      search.q = q;
      search.terms = searchTerms(q);
      search.items = [];
      search.index = -1;
      const seq = ++search.seq;
      if (!q || !pane) { renderSearchResults(null); renderSearchCount(null); return; }
      renderSearchResults(null);
      renderSearchCount(null);
      try {
        const data = await api('GET', `/api/transcript/search?${new URLSearchParams({ pane, q, limit: 100 })}`);
        if (seq !== search.seq || pane !== state.paneId) return;
        search.items = data.items || [];
        search.data = data;
        renderSearchResults(data);
        renderSearchCount(data);
      } catch (error) {
        if (seq !== search.seq) return;
        chatSearchResults.classList.remove('hidden');
        chatSearchResults.innerHTML = `<div class="cs-empty">${escapeHtml(error.message)}</div>`;
        chatSearchCount.textContent = '';
      }
    }
    function unmarkLogItem() {
      const el = search.marked;
      search.marked = null;
      if (!el) return;
      el.classList.remove('msg-hit');
      el.querySelectorAll('mark.cs-mark').forEach((mark) => mark.replaceWith(...mark.childNodes));
      el.querySelectorAll('.msg-body').forEach((body) => body.normalize());
    }
    function markLogItem(el, terms) {
      unmarkLogItem();
      search.marked = el;
      el.classList.add('msg-hit');
      // Mark the search terms in the text inside the bubble (the inside of math · code boxes is left alone)
      const walker = document.createTreeWalker(el.querySelector('.msg-body') || el, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement.closest('.katex, pre, mark, button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((node) => {
        const text = node.nodeValue;
        const lower = text.toLowerCase();
        if (!terms.some((term) => lower.includes(term))) return;
        const span = document.createElement('span');
        span.innerHTML = markTerms(text, terms).replace(/<mark>/g, '<mark class="cs-mark">');
        node.replaceWith(...span.childNodes);
      });
    }
    // When that item is not on screen (earlier history), load up to it step by step and then go to that bubble
    async function jumpToLogItem(id) {
      const pane = state.paneId;
      if (!pane || log.pane !== pane || !log.available) return;
      if (log.loading) { toast(t('이전 대화를 불러오는 중입니다. 잠시 뒤 다시 눌러 주십시오.'), 'info'); return; }
      log.follow = false;   // jumping to a search result: stay where the user is reading even when new content arrives
      const target = Math.max(0, id - 3);
      if (log.start > target) {
        log.loading = true;
        renderLogOlder();
        try {
          while (log.start > target) {
            const from = Math.max(target, log.start - 300);
            const data = await fetchLog({ start: from, limit: log.start - from });
            if (pane !== state.paneId || log.pane !== pane) return;
            logList.querySelector('.log-empty')?.remove();
            upsertLogItems(data.items, { prepend: true });
            log.start = from;
          }
        } catch (error) {
          toast(error.message, 'error');
          return;
        } finally {
          log.loading = false;
          renderLogOlder();
        }
      }
      const el = log.rendered.get(id)?.el;
      if (!el || !el.isConnected) { toast(t('그 메시지를 화면에서 찾지 못했습니다.'), 'error'); return; }
      markLogItem(el, search.terms);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    function pickSearchResult(index) {
      if (!search.items.length) return;
      search.index = (index + search.items.length) % search.items.length;
      renderSearchCount(search.data);
      chatSearchResults.querySelectorAll('.cs-item').forEach((b, i) => { b.classList.toggle('on', i === search.index); b.setAttribute('aria-selected', String(i === search.index)); });
      // On narrow screens such as phones the list is collapsed so the bubble is visible (tapping the search box expands it again)
      if (!mdQuery.matches) chatSearchResults.classList.add('hidden');
      else chatSearchResults.querySelector('.cs-item.on')?.scrollIntoView({ block: 'nearest' });
      jumpToLogItem(search.items[search.index].id);
    }
    function openChatSearch() {
      if (modeFor(currentWindow()) !== 'log') return;
      if (search.pane !== state.paneId) {
        search.pane = state.paneId;
        chatSearchInput.value = '';
        search.q = '';
        search.items = [];
        renderSearchResults(null);
        renderSearchCount(null);
      }
      chatSearch.classList.remove('hidden');
      chatSearchInput.focus();
      chatSearchInput.select();
      if (search.q && search.items.length) chatSearchResults.classList.remove('hidden');
    }
    function closeChatSearch() {
      if (chatSearch.classList.contains('hidden')) return;
      chatSearch.classList.add('hidden');
      chatSearchResults.classList.add('hidden');
      clearTimeout(search.timer);
      search.seq += 1;
      unmarkLogItem();
    }
    $('#chatSearchBtn').addEventListener('click', () => (chatSearch.classList.contains('hidden') ? openChatSearch() : closeChatSearch()));

    // ── Usage overview: skills · plugins · MCP servers · subagents · built-in tools used in this conversation ──
    // Now / just now = since the last prompt. Number keys (1–5) collapse/expand a kind, a toggles all, Esc closes.
    const chatUsage = $('#chatUsage');
    const usageBtn = $('#chatUsageBtn');
    const USAGE_LABELS = { skill: t('스킬'), plugin: t('플러그인'), mcp: t('MCP 서버'), agent: t('서브에이전트'), builtin: t('내장 도구') };
    const usage = { pane: null, data: null, timer: null, seq: 0, busy: false, open: store.get('chat-usage-open', []) };
    const usageSummary = $('#usageSummary');
    const wideScreen = window.matchMedia('(min-width: 768px)');
    // The bottom-bar summary shows only in the chat view on wide screens (not on phones)
    const summaryWanted = () => { const w = currentWindow(); return wideScreen.matches && !!state.paneId && !!w && !!agentOf(w) && modeFor(w) === 'log'; };
    const usageWanted = () => !chatUsage.classList.contains('hidden') || summaryWanted();
    const usageDot = (st) => `<span class="cu-dot ${st === 'running' ? 'run' : st === 'error' ? 'err' : st === 'ok' ? 'ok' : 'idle'}"></span>`;
    function renderUsagePanel() {
      const data = usage.data;
      if (!data) { chatUsage.innerHTML = `<div class="cu-empty">${t('불러오는 중…')}</div>`; return; }
      if (!data.available) { chatUsage.innerHTML = `<div class="cu-empty">${t('이 창의 대화 기록을 찾지 못했습니다.')}</div>`; return; }
      const allOpen = data.groups.every((g) => !g.items.length || usage.open.includes(g.group));
      // It is 'now' only while the agent is working. When idle, these are what the last question used (just now), and a tool that never finished was interrupted.
      const busy = typeof data.busy === 'boolean' ? data.busy : usage.busy;
      const st = (s) => (!busy && s === 'running' ? 'ok' : s);
      const states = data.recent.map((r) => st(r.state));
      const count = (s) => states.filter((x) => x === s).length;
      const recent = data.recent.length
        ? data.recent.map((r) => `<div class="cu-row${busy ? '' : ' past'}">${usageDot(busy ? st(r.state) : 'idle')}<span class="cu-kind">${USAGE_LABELS[r.group]}</span><span class="cu-name">${escapeHtml(r.name)}</span><span class="cu-count">×${r.count}</span></div>`).join('')
        : `<div class="cu-empty">${busy ? t('이번 질문에서는 아직 쓴 것이 없습니다.') : t('지난 질문에서 쓴 것이 없습니다.')}</div>`;
      const groups = data.groups.map((g, index) => {
        const open = usage.open.includes(g.group);
        const used = g.items.filter((r) => r.recent).length;
        return `<div class="cu-group${open ? ' open' : ''}">
          <button type="button" class="cu-ghead" data-cu-group="${g.group}" aria-expanded="${open}" ${g.items.length ? '' : 'disabled'}>
            <kbd>${index + 1}</kbd><i class="fas fa-caret-${open ? 'down' : 'right'}"></i>
            <span>${t('{label} · 사용 {count}', { label: USAGE_LABELS[g.group], count: g.items.length })}</span>${used && busy ? `<span class="cu-gnow">${usageDot('ok')}${used}</span>` : ''}
          </button>
          ${open ? `<div class="cu-items">${g.items.map((r) => `<div class="cu-row">${usageDot(r.recent && busy ? st(r.state) : 'idle')}<span class="cu-name">${escapeHtml(r.name)}</span><span class="cu-count">×${r.count}${r.recent ? ` <b>(+${r.recent})</b>` : ''}</span></div>`).join('')}</div>` : ''}
        </div>`;
      }).join('');
      chatUsage.innerHTML = `
        <div class="cu-head">
          ${busy
            ? `<span>${usageDot('running')}${t('{count} 실행', { count: count('running') })}</span><span>${usageDot('ok')}${t('{count} 사용', { count: count('ok') })}</span><span>${usageDot('error')}${t('{count} 오류', { count: count('error') })}</span>`
            : `<span class="cu-idle">${t('대기 중')}</span>`}<span class="cu-total" title="${t('이 대화에서 지금까지 쓴 스킬 · 플러그인 · MCP · 서브에이전트 · 도구 가짓수')}">${t('이 대화 {count}가지', { count: data.total })}</span>
          <button type="button" class="cu-btn" data-cu-all>[a] ${allOpen ? t('모두 접기') : t('모두 펼침')}</button>
          <button type="button" class="cu-btn cu-x" data-cu-close aria-label="${t('닫기')}"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="cu-body">
          <div class="cu-title">${busy ? t('지금 (작업 중)') : t('방금 (지난 질문)')}</div>
          <div class="cu-recent">${recent}</div>
          <div class="cu-groups">${groups}</div>
          <div class="cu-legend">${t('{ok} 사용 {run} 실행 중 {err} 오류 {idle} 지금 안 씀 · 숫자키로 그룹 접기/펼치기', { ok: usageDot('ok'), run: usageDot('running'), err: usageDot('error'), idle: usageDot('idle') })}</div>
        </div>`;
    }
    // The tool in use now: "⚙ Bash · git status" (running) / "just now Read · app.js" (picking the next tool)
    function usageNowText(current, names) {
      if (!current) return names.length ? escapeHtml(names.slice(0, 2).join(', ')) : t('작업 중');
      const use = (current.use || []).find((u) => u[0] !== 'builtin');
      const label = use ? `${USAGE_LABELS[use[0]]} ${use[1]}` : toolLabel(current.name);
      const icon = current.running ? '<i class="fas fa-gear fa-spin us-spin"></i>' : `<span class="us-past">${t('방금')}</span>`;
      return `${icon}<b>${escapeHtml(label)}</b>${current.summary ? ` · ${escapeHtml(current.summary)}` : ''}${current.more ? ` <span class="us-past">+${current.more}</span>` : ''}`;
    }
    const toolLabel = (name) => (name && name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name || t('도구'));
    // Bottom-bar traffic-light summary: while working, this question's running · used · errors; when idle, a dimmed 'Idle'
    function renderUsageSummary() {
      const data = usage.data;
      const show = summaryWanted() && data?.available && usage.pane === state.paneId;
      usageSummary.classList.toggle('hidden', !show);
      if (!show) return;
      const busy = typeof data.busy === 'boolean' ? data.busy : usage.busy;
      // The traffic lights are 'now' only: all 0 when idle (what the last question used is on hover or in the panel)
      const states = busy ? data.recent.map((r) => r.state) : [];
      const n = (st) => states.filter((x) => x === st).length;
      const names = busy ? data.recent.filter((r) => r.group !== 'builtin').map((r) => r.name) : [];
      const past = data.recent.filter((r) => r.group !== 'builtin').map((r) => r.name);
      usageSummary.classList.toggle('idle', !busy);
      usageSummary.innerHTML = `<span class="us-light">${usageDot('running')}${n('running')}</span><span class="us-light">${usageDot('ok')}${n('ok')}</span><span class="us-light">${usageDot('error')}${n('error')}</span>`
        + `<span class="us-text">${busy ? usageNowText(data.current, names) : t('대기 중')}</span>`;
      const tool = data.current ? `${toolLabel(data.current.name)}${data.current.summary ? ` · ${data.current.summary}` : ''}` : '';
      const nowLine = !data.current ? '' : `${data.current.running ? t('실행 중: {tool}', { tool }) : t('방금: {tool}', { tool })}\n`;
      const counts = { run: n('running'), ok: n('ok'), err: n('error'), names: names.join(', ') };
      usageSummary.title = busy
        ? nowLine + (names.length
          ? t('지금 (작업 중): 실행 {run} · 사용 {ok} · 오류 {err} · {names} — 누르면 사용 현황', counts)
          : t('지금 (작업 중): 실행 {run} · 사용 {ok} · 오류 {err} — 누르면 사용 현황', counts))
        : past.length
          ? t('대기 중 · 지난 질문에서 쓴 것: {names} · 이 대화에서 쓴 것 {total}가지 — 누르면 사용 현황', { names: past.join(', '), total: data.total })
          : t('대기 중 · 이 대화에서 쓴 것 {total}가지 — 누르면 사용 현황', { total: data.total });
    }
    async function loadUsage() {
      const pane = state.paneId;
      if (!pane || !usageWanted()) return;
      const seq = ++usage.seq;
      try {
        const data = await api('GET', `/api/transcript/usage?pane=${encodeURIComponent(pane)}`);
        if (seq !== usage.seq || pane !== state.paneId) return;
        const sig = JSON.stringify(data);
        if (sig === usage.sig) return;
        usage.sig = sig;
        usage.data = data;
        usage.pane = pane;
        if (!chatUsage.classList.contains('hidden')) renderUsagePanel();
        renderUsageSummary();
      } catch (error) {
        if (seq === usage.seq && !usage.data && !chatUsage.classList.contains('hidden')) chatUsage.innerHTML = `<div class="cu-empty">${escapeHtml(error.message || t('불러오지 못했습니다.'))}</div>`;
      }
    }
    function scheduleUsage() {
      clearTimeout(usage.timer);
      if (!usageWanted()) return;
      // Often while working, rarely when idle · stops when the page is not visible.
      // Lite mode polls even less often (a new transcript entry triggers an immediate reread via logged(), so responsiveness is unchanged)
      const lite = document.documentElement.hasAttribute('data-ui-lite');
      const busy = usage.data?.busy || usage.busy;
      usage.timer = setTimeout(async () => { if (!document.hidden) await loadUsage(); scheduleUsage(); }, busy ? (lite ? 5000 : 2000) : (lite ? 30000 : 8000));
    }
    function openUsage() {
      if (modeFor(currentWindow()) !== 'log') return;
      closeChatSearch();
      if (usage.pane !== state.paneId) { usage.pane = state.paneId; usage.data = null; usage.sig = ''; }
      chatUsage.classList.remove('hidden');
      usageBtn.setAttribute('aria-expanded', 'true');
      usageBtn.classList.add('on');
      renderUsagePanel();
      chatUsage.focus({ preventScroll: true });
      loadUsage().then(scheduleUsage);
    }
    function closeUsage() {
      chatUsage.classList.add('hidden');
      usageBtn.setAttribute('aria-expanded', 'false');
      usageBtn.classList.remove('on');
      if (!usageWanted()) { clearTimeout(usage.timer); usage.seq += 1; }
    }
    function resetUsageFor(pane) {
      usage.pane = pane; usage.data = null; usage.sig = '';
      renderUsageSummary();
      if (!chatUsage.classList.contains('hidden')) renderUsagePanel();
      loadUsage().then(scheduleUsage);
    }
    usageSummary.addEventListener('click', () => (chatUsage.classList.contains('hidden') ? openUsage() : closeUsage()));
    wideScreen.addEventListener?.('change', () => { renderUsageSummary(); if (usageWanted()) loadUsage().then(scheduleUsage); });
    function toggleUsageGroup(group) {
      usage.open = usage.open.includes(group) ? usage.open.filter((g) => g !== group) : [...usage.open, group];
      store.set('chat-usage-open', usage.open);
      renderUsagePanel();
    }
    usageBtn.addEventListener('click', () => (chatUsage.classList.contains('hidden') ? openUsage() : closeUsage()));
    chatUsage.addEventListener('click', (event) => {
      const group = event.target.closest('[data-cu-group]');
      if (group) { toggleUsageGroup(group.dataset.cuGroup); return; }
      if (event.target.closest('[data-cu-close]')) { closeUsage(); return; }
      if (event.target.closest('[data-cu-all]') && usage.data) {
        const groups = usage.data.groups.filter((g) => g.items.length).map((g) => g.group);
        usage.open = groups.every((g) => usage.open.includes(g)) ? [] : groups;
        store.set('chat-usage-open', usage.open);
        renderUsagePanel();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (chatUsage.classList.contains('hidden') || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const active = document.activeElement;
      if (active && active.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (!sheetOverlay.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); closeUsage(); return; }
      if (!usage.data?.groups) return;
      if (/^[1-5]$/.test(event.key)) {
        const g = usage.data.groups[Number(event.key) - 1];
        if (g?.items.length) { event.preventDefault(); toggleUsageGroup(g.group); }
      } else if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        chatUsage.querySelector('[data-cu-all]')?.click();
      }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && usageWanted()) loadUsage(); });
    window.UnivDashChatUsage = {
      close: closeUsage,
      // Same criterion as the chat's 'Working' indicator: on change, redraw and reread right away
      busy: (busy) => {
        if (busy === usage.busy) return;
        usage.busy = busy;
        if (usageWanted()) loadUsage().then(scheduleUsage);
      },
      // When new transcript entries arrive (answer finished · tool result, …), reread right away
      logged: () => {
        if (!usageWanted()) return;
        clearTimeout(usage.kick);
        usage.kick = setTimeout(() => loadUsage().then(scheduleUsage), 120);
      },
      // Switching to another window reloads with that window's transcript
      paneChanged: () => { if (usage.pane !== state.paneId) resetUsageFor(state.paneId); },
      // Chat ↔ terminal view switch · window selection: show or hide the summary and load when needed
      modeChanged: () => {
        if (usage.pane !== state.paneId) { resetUsageFor(state.paneId); return; }
        renderUsageSummary();
        if (usageWanted()) { if (!usage.data) loadUsage().then(scheduleUsage); else scheduleUsage(); } else clearTimeout(usage.timer);
      },
    };
    // Esc still closes it after a result was clicked and focus left the input (another input · an open sheet takes precedence)
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || chatSearch.classList.contains('hidden') || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active && active !== chatSearchInput && active.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (!sheetOverlay.hidden) return;
      event.preventDefault();
      closeChatSearch();
    });
    // Tapping the chat only collapses the result list (the query · the marks stay)
    logScroll.addEventListener('pointerdown', () => chatSearchResults.classList.add('hidden'), { passive: true });
    chatSearchInput.addEventListener('input', () => { clearTimeout(search.timer); search.timer = setTimeout(runChatSearch, 250); });
    chatSearchInput.addEventListener('focus', () => { if (search.q) chatSearchResults.classList.remove('hidden'); });
    chatSearchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeChatSearch(); return; }
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        if (chatSearchInput.value.trim() !== search.q) { clearTimeout(search.timer); runChatSearch(); return; }
        pickSearchResult(search.index + (event.shiftKey ? -1 : 1));
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        pickSearchResult(search.index + (event.key === 'ArrowDown' ? 1 : -1));
      }
    });
    chatSearch.addEventListener('click', (event) => {
      const item = event.target.closest('[data-cs-index]');
      if (item) { pickSearchResult(Number(item.dataset.csIndex)); return; }
      const step = event.target.closest('[data-cs-step]');
      if (step) { pickSearchResult(search.index < 0 && Number(step.dataset.csStep) < 0 ? 0 : search.index + Number(step.dataset.csStep)); return; }
      if (event.target.closest('[data-cs-close]')) closeChatSearch();
    });
    async function pollLog() {
      if (log.pane !== state.paneId || !log.available || log.loading) return;
      const pane = state.paneId;
      try {
        // Fetch the last few again so items filled in later, such as tool results, are refreshed too.
        const data = await fetchLog({ start: Math.max(log.start, log.total - 12), limit: 300 });
        if (pane !== state.paneId) return;
        applyLogData(data);
      } catch (error) { /* retry on the next cycle */ }
    }
    // ── The queue acknowledged by the agent · prompts just sent ──
    // A sent prompt is shown as a bubble right away, even before it is written to the log.
    // What removes it is order, not text comparison: each time a new user message (or queue item) appears
    // in the log after sending, the oldest bubble is removed — so no duplicate remains even when
    // attachment paths are appended or long text is truncated and the logged text differs.
    const chatPending = $('#chatPending');
    const chatStatus = $('#chatStatus');
    const SENT_KEEP_MS = 10 * 60 * 1000;
    log.queued = [];
    log.submitted = [];   // prompts sent but not recorded yet (e.g. while Codex is compacting the conversation · reported by the server)
    log.sent = [];
    function addSent(text) {
      if (modeFor(currentWindow()) !== 'log' || !text.trim() || /^\/\S/.test(text.trim())) return null;   // slash commands do not stay in the log as ordinary messages
      const entry = { pane: state.paneId, text, at: Date.now(), afterId: log.total - 1, queuedBase: log.queued.length };
      log.sent.push(entry);
      renderPending();
      followBottom();   // a prompt I sent: follow the latest again
      return entry;
    }
    setInterval(() => { if (log.sent.length) renderPending(); }, 30000);
    function removeSent(entry) {
      log.sent = log.sent.filter((item) => item !== entry);
      renderPending();
    }
    function renderPending() {
      const now = Date.now();
      const mine = log.sent.filter((e) => e.pane === state.paneId);
      if (mine.length && log.pane === state.paneId) {
        const first = mine[0];
        let arrived = [...log.rendered.values()].filter(({ item }) => item.kind === 'user' && item.id > first.afterId).length
          + Math.max(0, log.queued.length - first.queuedBase);
        log.sent = log.sent.filter((e) => {
          if (e.pane === state.paneId && arrived > 0) { arrived -= 1; return false; }
          return now - e.at < SENT_KEEP_MS;
        });
      }
      const queuedBubble = (text) => `<div class="msg msg-user pending"><div class="msg-meta"><i class="fas fa-hourglass-half"></i> ${t('대기 중 · 작업 중에 곧 전달됩니다')}</div><div class="msg-body">${escapeHtml(text)}</div></div>`;
      const sentBubble = (e) => `<div class="msg msg-user"><div class="msg-meta">${t('나 · {time}', { time: escapeHtml(logTime(e.at)) })}</div><div class="msg-body">${escapeHtml(e.text)}</div></div>`;
      const sentHere = log.sent.filter((e) => e.pane === state.paneId);
      // When this screen already has bubbles it sent, the ones reported by the server would overlap, so they are left out
      const submittedBubble = (text) => `<div class="msg msg-user"><div class="msg-meta">${t('나 · 전달됨')}</div><div class="msg-body">${escapeHtml(text)}</div></div>`;
      const submitted = sentHere.length || log.pane !== state.paneId ? [] : log.submitted.map(submittedBubble);
      chatPending.innerHTML = [...log.queued.map(queuedBubble), ...submitted, ...sentHere.map(sentBubble)].join('');
    }

    // ── Agent status card: reads the status line / choice question from the terminal screen and shows it at the bottom of the chat ──
    const STATUS_LINE = /^\s*[✻✽✶✢✳✺✹✷·*•◦●⠀-⣿]\s+(\S.*)$/;
    // Option lines: "❯ 1. Yes", "› 2. GPT-6-Sol (current)  description", "↓ 10. Opus 4.6   description" (long lists get ↑↓)
    const OPTION_LINE = /^\s*(?:[❯›>↑↓]\s*)*(\d{1,2})\.\s+(.+?)\s*$/;
    const CURSOR_LINE = /^\s*(?:[↑↓]\s*)?[❯›>]/;
    const PICKER_FOOTER = /enter to set as default|enter select|enter default|esc back|s to use this session only|\bs session\b/i;
    function chatStatusFrom(screen, w) {
      const lines = screen.content.split('\n').slice(-Math.max(1, screen.height)).map((line) => plainText(line));
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();  // drop the empty lines at the bottom of the screen
      if (w.status === 'waiting') {
        // The lowest block of options (in a long list scrolled up, 1. may not be visible)
        let last = -1;
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) if (OPTION_LINE.test(lines[i])) { last = i; break; }
        if (last < 0) return { kind: 'waiting', question: t('응답이 필요합니다. 터미널 탭에서 확인하십시오.'), options: [] };
        let first = last;
        for (let i = last - 1; i >= 0; i--) {
          if (OPTION_LINE.test(lines[i])) first = i;
          else if (lines[i].trim() && !/^\s{3,}/.test(lines[i])) break;
          else if (!lines[i].trim() && !OPTION_LINE.test(lines[i - 1] || '')) break;
        }
        const options = [];
        for (let i = first; i <= last; i++) {
          const m = lines[i].match(OPTION_LINE);
          if (!m) continue;
          const [label, desc = ''] = m[2].replace(/[│|]\s*$/, '').trim().split(/\s{2,}/, 2);
          const current = /✔|✓|\(current\)/i.test(label);
          options.push({ key: m[1], label: label.replace(/\s*(✔|✓|\(current\))\s*/gi, ' ').trim(), desc: desc.trim(), current, cursor: CURSOR_LINE.test(lines[i]) });
        }
        // Below the options: the reasoning-effort line ("◐ Medium effort (default) ←/→ to adjust") · the hint ("Enter to set as default · s to use this session only")
        let effort = '';
        let effortAdjust = false;
        let footer = '';
        for (let i = last + 1; i < lines.length; i++) {
          const text = lines[i].trim();
          if (/\beffort\b/i.test(text) && !effort) { effortAdjust = /←\/→/.test(text); effort = text.replace(/←\/→.*$/, '').replace(/^[^\w(]+/, '').trim(); }
          else if (PICKER_FOOTER.test(text)) footer = text;
        }
        // List-style pickers such as model selection: a tap only moves the cursor, and the buttons below (Enter / s) confirm
        const picker = !!footer && options.some((o) => o.cursor);
        const question = [];
        for (let i = first - 1; i >= 0 && question.length < 12; i--) {
          const line = lines[i].replace(/^[\s│╭╮╰╯]+|[\s│╭╮╰╯]+$/g, '');
          if (/^[─━═╌▔▁-]{6,}/.test(line)) break;
          // Only the title area right above the list is shown. Earlier conversation and model-change notices beyond an empty line are excluded.
          if (picker && !line && question.length) break;
          if (line) question.unshift(line);
          else if (question.length && question[0] !== '') question.unshift('');
          if (picker && /^(?:select|choose)\b/i.test(line)) break;
        }
        while (question.length && !question[0]) question.shift();
        return { kind: 'waiting', question: question.join('\n'), options, picker, effort, effortAdjust, sessionOnly: /s to use this session only|\bs session\b/i.test(footer), footer };
      }
      if (w.status === 'busy') {
        // Live output covers the scrollback too, not just the visible screen (long command output · answers: everything from this turn)
        const all = screen.content.split('\n').map((line) => plainText(line));
        while (all.length && !all[all.length - 1].trim()) all.pop();
        for (let i = all.length - 1; i >= Math.max(0, all.length - 20); i--) {
          const m = all[i].match(STATUS_LINE);
          if (m && (/…|\.\.\./.test(m[1]) || /interrupt/i.test(m[1])) && !/^⏵/.test(all[i].trim())) return { kind: 'busy', text: m[1].trim(), live: liveOutput(all, i) };
        }
        return { kind: 'busy', text: t('작업 중…'), live: liveOutput(all, all.length) };
      }
      return null;
    }
    // The agent writes to the session log only after an answer · a command finishes, so content still being written is shown straight from the terminal screen.
    // Everything printed in the terminal right above the status line (✻ … / • Working …), after this turn's user input (Claude "> …", Codex "› …").
    const LIVE_LINES = 400;
    function liveOutput(lines, statusIndex) {
      let start = Math.max(0, statusIndex - LIVE_LINES);
      for (let i = statusIndex - 1; i >= start; i--) {
        if (/^\s*[>›❯]\s/.test(lines[i]) || /^[─━═]{6,}/.test(lines[i].trim())) { start = i + 1; break; }
      }
      const out = lines.slice(start, statusIndex).map((line) => line.replace(/\s+$/, ''));
      while (out.length && !out[0].trim()) out.shift();
      while (out.length && !out[out.length - 1].trim()) out.pop();
      return out.slice(-LIVE_LINES).join('\n');
    }
    let lastStatusKey = '';
    function updateChatStatus(screen) {
      const w = currentWindow();
      const status = w && agentOf(w) && modeFor(w) === 'log' ? chatStatusFrom(screen, w) : null;
      window.UnivDashChatUsage?.busy(status?.kind === 'busy');
      const key = JSON.stringify(status);
      if (key === lastStatusKey) return;
      lastStatusKey = key;
      const stick = log.follow || logAtBottom();
      if (!status) { chatStatus.className = 'chat-status hidden'; chatStatus.innerHTML = ''; if (stick) pinBottom(); return; }
      chatStatus.classList.remove('hidden');
      chatStatus.className = `chat-status ${status.kind}`;
      if (status.kind === 'busy') {
        const showLive = status.live && chatLiveOpen(agentOf(w));
        chatStatus.innerHTML = `<div class="chat-status-row"><i class="fas fa-circle-notch fa-spin"></i><span class="chat-status-text">${escapeHtml(status.text)}</span>
          ${status.live ? `<button type="button" class="chat-live-toggle" data-live-toggle title="${showLive ? t('실시간 출력 접기') : t('실시간 출력 펼치기')}"><i class="fas fa-chevron-${showLive ? 'down' : 'up'}"></i></button>` : ''}
          <button type="button" data-status-keys="Escape" title="${t('작업 중단 (Esc)')}">${t('중단')}</button></div>
          ${showLive ? `<pre class="chat-live">${escapeHtml(status.live)}</pre>` : ''}`;
        const livePre = chatStatus.querySelector('.chat-live');
        if (livePre) livePre.scrollTop = livePre.scrollHeight;
      } else {
        chatStatus.innerHTML = waitingCardHtml(status);
      }
      if (stick) pinBottom();
    }
    chatStatus.addEventListener('click', (event) => {
      if (!event.target.closest('[data-live-toggle]')) return;
      toggleChatLive(agentOf(currentWindow()));
      lastStatusKey = '';
      if (lastScreen) updateChatStatus(lastScreen);
    });
    // Picking an option: when a cursor (❯ ›) is visible, move with the arrow keys (number keys do not work in Codex lists). Without a cursor, the number character.
    // move: move only (list-style picker — confirmed with the Enter / s buttons)
    function optionKeys(status, key, agent, move = false) {
      if (!status?.options?.length || !status.options.some((o) => o.cursor)) return null;
      const target = status.options.find((o) => o.key === key);
      const from = status.options.find((o) => o.cursor);
      if (!target) return null;
      const step = Number(target.key) - Number(from.key);
      const arrows = Array(Math.abs(step)).fill(step > 0 ? 'Down' : 'Up');
      return move ? arrows : [...arrows, 'Enter'];
    }
    // "Needs answer" card (shared by the main and split views)
    function waitingCardHtml(status) {
      const head = `<div class="chat-status-head"><i class="fas fa-hand"></i> ${t('응답이 필요합니다')}</div>
        ${status.question ? `<div class="chat-status-question">${escapeHtml(status.question)}</div>` : ''}`;
      if (!status.picker) {
        return `${head}<div class="chat-status-options">${status.options.map((o) => `<button type="button" data-status-text="${escapeHtml(o.key)}"><b>${escapeHtml(o.key)}</b> ${escapeHtml(o.label)}</button>`).join('')}
          <button type="button" data-status-keys="Escape" class="muted">Esc</button></div>`;
      }
      return `${head}<div class="chat-picker">${status.options.map((o) => `<button type="button" class="${o.cursor ? 'on' : ''}" data-status-move="${escapeHtml(o.key)}">
            <b>${escapeHtml(o.key)}</b><span class="cp-main"><span class="cp-label">${escapeHtml(o.label)}${o.current ? ` <em>${t('사용 중')}</em>` : ''}</span>${o.desc ? `<span class="cp-desc">${escapeHtml(o.desc)}</span>` : ''}</span>
            ${o.cursor ? '<i class="fas fa-check"></i>' : ''}</button>`).join('')}</div>
        ${status.effort ? `<div class="chat-picker-effort">${status.effortAdjust ? `<button type="button" data-status-keys="Left" aria-label="${t('추론 수준 낮추기')}"><i class="fas fa-chevron-left"></i></button>` : ''}
          <span>${escapeHtml(status.effort)}</span>${status.effortAdjust ? `<button type="button" data-status-keys="Right" aria-label="${t('추론 수준 높이기')}"><i class="fas fa-chevron-right"></i></button>` : ''}</div>` : ''}
        <div class="chat-status-options chat-picker-actions"><button type="button" data-status-keys="Escape" class="muted">${t('취소')}</button>
          ${status.sessionOnly ? `<button type="button" data-status-text="s">${t('이 세션만')}</button>` : ''}
          <button type="button" data-status-keys="Enter" class="primary">${status.sessionOnly ? t('기본값으로 적용') : t('선택')}</button></div>`;
    }
    // Card button → the message to send
    function statusMessage(button, status, agent, pane) {
      if (button.dataset.statusMove) {
        const keys = optionKeys(status, button.dataset.statusMove, agent, true);
        return keys?.length ? { t: 'keys', pane, keys } : null;
      }
      if (button.dataset.statusText) {
        const keys = status?.picker && button.dataset.statusText === 's' ? null : optionKeys(status, button.dataset.statusText, agent);
        return keys ? { t: 'keys', pane, keys } : { t: 'text', pane, text: button.dataset.statusText };
      }
      return { t: 'keys', pane, keys: [button.dataset.statusKeys] };
    }
    chatStatus.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-status-text], [data-status-keys], [data-status-move]');
      if (!button || !state.paneId) return;
      vibrate(8);
      try {
        const w = currentWindow();
        const message = statusMessage(button, lastScreen ? chatStatusFrom(lastScreen, w) : null, agentOf(w), state.paneId);
        if (message) await socket.send(message, { ack: true });
      } catch (error) { toast(error.message, 'error'); }
    });

    function applyLogData(data) {
      if (log.pane !== state.paneId || log.loading) return;
      if (Array.isArray(data.queued)) { log.queued = data.queued; }
      log.submitted = Array.isArray(data.submitted) ? data.submitted : [];
      const stick = log.follow || logAtBottom();
      if (data.total < log.total) { loadLatestLog(); return; }  // the session changed (/clear, …)
      // When so much piled up meanwhile that the middle is missing (background · reconnect), start again from the latest — earlier ones via 'show more'
      if (data.items.length && (data.items[0].id > log.total || data.items.at(-1).id + 1 < data.total)) { loadLatestLog(); return; }
      const items = data.items.filter((item) => item.id >= log.start);
      window.UnivDashChatUsage?.logged();
      const hasNew = items.some((item) => !log.rendered.has(item.id));
      if (hasNew) logList.querySelector('.log-empty')?.remove();
      upsertLogItems(items);
      // When a subagent finishes, the earlier tool item changes too (working → done)
      if (Array.isArray(data.related)) upsertLogItems(data.related.filter((item) => log.rendered.has(item.id)));
      log.total = Math.max(log.total, data.total);
      renderPending();
      if (stick) pinBottom();
      else if (hasNew) jumpBtn.classList.remove('hidden');
    }
    socket.on('log', (message) => {
      if (message.pane !== state.paneId || modeFor(currentWindow()) !== 'log') return;
      if (!log.available) { loadLatestLog(); return; }   // the new session's log was just created
      applyLogData(message);
    });
    logScroll.addEventListener('scroll', () => {
      if (logScroll.scrollTop < 120) loadOlderLog();
      // Back at the bottom (the very end), follow the latest again (it is off only when the user scrolled up)
      if (logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 4) log.follow = true;
      if (logAtBottom()) jumpBtn.classList.add('hidden');
    }, { passive: true });
    // ── Auto-scroll: stops only when the user scrolls up 'on purpose' ──
    // Judging by position alone (are we at the bottom?) fails when a new item grows after it is drawn later
    // (off-screen skipping · images · math): it gets pushed off the bottom and the next update no longer follows.
    // So following is turned off only by user input (wheel · touch · keys · scrollbar).
    // Input that tries to go up turns it off right away (smooth scrolling moves a few frames late, so we do not wait for the position).
    // Scrolling up a little and then back down to the very end turns it on again in the scroll handler above.
    function stopFollow() { log.follow = false; }
    logScroll.addEventListener('wheel', (event) => { if (event.deltaY < 0 && !event.ctrlKey) stopFollow(); }, { passive: true });
    let touchY = null;
    logScroll.addEventListener('touchstart', (event) => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
    logScroll.addEventListener('touchmove', (event) => {
      const y = event.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && y - touchY > 6) stopFollow();   // finger moves down = looking at content above
    }, { passive: true });
    logScroll.addEventListener('keydown', (event) => { if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) stopFollow(); });
    // Dragging the scrollbar (the bar is at the element's right edge)
    logScroll.addEventListener('pointerdown', (event) => {
      if (event.offsetX > logScroll.clientWidth) {
        const top = logScroll.scrollTop;
        const up = () => { if (logScroll.scrollTop < top - 4) stopFollow(); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointerup', up);
      }
    });
    // While following, go to the bottom (once more on the next frame in case the size changes after drawing)
    function pinBottom() {
      if (!log.follow) return;
      logScroll.scrollTop = logScroll.scrollHeight;
      cancelAnimationFrame(pinBottom.raf);
      pinBottom.raf = requestAnimationFrame(() => { if (log.follow) logScroll.scrollTop = logScroll.scrollHeight; });
    }
    function followBottom() { log.follow = true; jumpBtn.classList.add('hidden'); pinBottom(); }
    // When the content size changes (new items · items drawn later · collapse/expand · status card), stick to the bottom only while following
    if ('ResizeObserver' in window) {
      const keepPinned = new ResizeObserver(() => { if (log.follow && modeFor(currentWindow()) === 'log') pinBottom(); });
      [logList, $('#chatPending'), chatStatus].forEach((el) => el && keepPinned.observe(el));
    }
    logOlder.addEventListener('click', loadOlderLog);
    logList.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-copy]');
      if (!button) return;
      const entry = log.rendered.get(Number(button.dataset.copy));
      try { await navigator.clipboard.writeText(entry.item.text); toast(t('복사했습니다.'), 'ok', null, 1200); } catch (e) { toast(t('복사하지 못했습니다 (HTTPS 에서만 가능).'), 'error'); }
    });

    // ── Quick phrases & recent history ──
    function remember(text) {
      const recent = store.get('recent', []).filter((t) => t !== text);
      recent.unshift(text);
      store.set('recent', recent.slice(0, 100));
    }
    const DEFAULT_SNIPPETS = [t('계속 진행해줘'), t('커밋해줘'), t('테스트 돌려서 확인해줘'), '/compact', '/clear'];
    function insertText(text) {
      exitDirect();
      input.value = input.value ? `${input.value}${input.value.endsWith('\n') ? '' : ' '}${text}` : text;
      autosize(); saveDraft();
      input.focus();
    }
    function snippetSheet() {
      const snippets = store.get('snippets', DEFAULT_SNIPPETS);
      const recent = store.get('recent', []).slice(0, 20);
      const rows = (items, removable) => items.map((text, index) => `
          <div class="snippet-row"><button type="button" class="sheet-action" data-text-index="${index}" data-kind="${removable ? 's' : 'r'}">
            <i class="fas ${removable ? 'fa-bolt' : 'fa-clock-rotate-left'} lead"></i><span class="txt">${escapeHtml(text.replace(/\s+/g, ' '))}</span></button>
            ${removable ? `<button type="button" class="snippet-del" data-del="${index}" aria-label="${t('삭제')}"><i class="fas fa-xmark"></i></button>` : ''}</div>`).join('');
      const label = (text) => `<p class="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider opacity-50">${text}</p>`;
      openSheet(`${sheetHead(t('히스토리'), t('탭하면 입력창에 넣습니다. 길게 눌러 바로 보내기.'))}
        <div class="sheet-actions">
          ${label(t('최근 보낸 프롬프트'))}${recent.length ? rows(recent, false) : `<p class="px-3 py-2 text-xs opacity-60">${t('아직 보낸 프롬프트가 없습니다.')}</p>`}
          <div class="sheet-sep"></div>${label(t('빠른 문구'))}
          ${rows(snippets, true) || `<p class="px-3 py-2 text-xs opacity-60">${t('저장된 문구가 없습니다.')}</p>`}
          <button type="button" class="sheet-action" data-add><i class="fas fa-plus lead"></i><span>${input.value.trim() ? t('지금 입력한 내용을 문구로 저장') : t('새 문구 추가')}</span></button>
        </div>
        <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>${t('닫기')}</button></div>`, (body) => {
        body.querySelector('[data-close]').addEventListener('click', closeSheet);
        const textOf = (button) => (button.dataset.kind === 's' ? snippets : recent)[Number(button.dataset.textIndex)];
        body.querySelectorAll('[data-text-index]').forEach((button) => {
          button.addEventListener('click', () => { closeSheet(); insertText(textOf(button)); });
        });
        attachLongPress(body, '[data-text-index]', async (button) => {
          const text = textOf(button);
          closeSheet();
          if (!state.paneId) return;
          const entry = addSent(text);
          try { await sendPromptOnce(state.paneId, text); remember(text); toast(t('보냈습니다.'), 'ok', null, 1500); } catch (error) { if (entry) removeSent(entry); toast(error.message, 'error'); }
        });
        body.querySelectorAll('[data-del]').forEach((button) => button.addEventListener('click', () => {
          snippets.splice(Number(button.dataset.del), 1);
          store.set('snippets', snippets);
          snippetSheet();
        }));
        body.querySelector('[data-add]').addEventListener('click', () => {
          const current = input.value.trim();
          if (current) {
            store.set('snippets', [current, ...snippets.filter((s) => s !== current)].slice(0, 30));
            toast(t('문구로 저장했습니다.'), 'ok', null, 1500);
            closeSheet();
            return;
          }
          formSheet({
            title: t('새 문구'), fields: [{ name: 'text', label: t('문구'), placeholder: t('예: 변경사항 요약해줘'), maxlength: 2000 }], submitLabel: t('추가'),
            onSubmit(values) {
              const text = values.text.trim();
              if (!text) throw new Error(t('문구를 입력하십시오.'));
              store.set('snippets', [text, ...snippets.filter((s) => s !== text)].slice(0, 30));
            },
          });
        });
      });
    }
    $('#snippetBtn').addEventListener('pointerdown', (event) => event.preventDefault());
    $('#snippetBtn').addEventListener('click', snippetSheet);

    // ── Initialization ──
    applyView();
    desktopQuery.addEventListener('change', () => {
      if (desktopQuery.matches) document.body.classList.remove('term-open');
      else if (state.selectedKey) document.body.classList.add('term-open');
      refit();
    });
    socket.on('open', () => {
      subscribe();
      if (modeFor(currentWindow()) === 'log') { pollLog(); subscribeLog(); }
    });

    function restoreSelection() {
      const fromHash = decodeURIComponent(location.hash.slice(1));
      const key = byKey().has(fromHash) ? fromHash : (desktopQuery.matches ? store.get('last-window', null) : null);
      if (key && byKey().has(key)) select(key, { pushHistory: false, keepFile: desktopQuery.matches });
      if (!desktopQuery.matches && fromHash && byKey().has(fromHash)) {
        // Even when arriving via a reload, Back should return to the list.
        replaceHash(null);
        pushHash(fromHash);
      }
    }

    function onWindowsChanged() {
      const w = currentWindow();
      if (state.selectedKey && !w) return;
      if (w) {
        const paneStillThere = w.panes.some((p) => p.id === state.paneId);
        if (!paneStillThere) { state.paneId = pickPane(w); subscribe(); }
        renderHeader();
        // When the agent starts or stops, the Chat/Terminal switch follows
        if ($('#termModes').classList.contains('hidden') === !!agentOf(w)) applyMode();
      }
    }

    function renameKeys(move) {
      termTabs = termTabs.map(move);
      saveTermTabs();
      for (const key of Object.keys(drafts)) {
        const moved = move(key);
        if (moved !== key) { drafts[moved] = drafts[key]; delete drafts[key]; }
      }
      store.set('drafts', drafts);
      for (const [key, list] of [...attachments.entries()]) {
        const moved = move(key);
        if (moved !== key) { attachments.set(moved, list); attachments.delete(key); }
      }
      if (state.selectedKey) replaceHash(state.selectedKey);
    }

    terminal = { refit };
    // On a light ↔ dark switch, redraw the screen with the new colours
    new MutationObserver(() => {
      const next = document.documentElement.getAttribute('data-ui-theme-mode') === 'light';
      if (next === lightTerm) return;
      lightTerm = next;
      adaptCache.clear();
      if (lastScreen) renderScreen(lastScreen);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-theme-mode'] });
    // Exposed so the tmux panels of the split view render the same way as the main one
    const renderers = {
      logItem(item, agent) { const saved = log.agent; log.agent = agent; const html = logItemHtml(item); log.agent = saved; return html; },
      markFinalAnswers,
      chatStatus: (screen, w) => chatStatusFrom(screen, w),
      prettyModel, usageMarkup, sendSlash, pickGeminiModel, optionKeys, waitingCardHtml, statusMessage, watchModelChange, restartAgent,
      chatLiveOpen, toggleChatLive,
      refreshLimits: () => refreshLimits(),
    };
    return { renderList, select, closeTerm, restoreSelection, onWindowsChanged, watchCurrentModel, renameKeys, currentWindow, termTabs: termTabApi, renderers };
  })();


  // ════════════════════════════════════════════════════════════════════
  // Workspace view switch: windows · files (Explorer)
  //  - A file opened from the Files tab appears on the right (on phones, a sliding panel) in place of the terminal.
  //  - A path can be inserted straight into the prompt of the selected window.
  // ════════════════════════════════════════════════════════════════════
  const wsFiles = !workspace ? null : (() => {
    const modes = { windows: $('#winMode'), files: $('#fileMode') };
    const fileView = $('#fileView');
    let tree = null;
    let viewer = null;

    function ensureTree() {
      if (tree || !window.UnivDashExplorer) return tree;
      tree = window.UnivDashExplorer.mountTree($('#wsExplorer'), {
        onOpen: openFile, onInsert: insertPath,
        onReady: () => { lastSidebar = null; syncSidebar(); },
      });
      return tree;
    }
    // ── Selection in the left file tree · window list = the tab being viewed (in a split view, the tab of the last clicked cell) ──
    let lastSidebar = null;
    function focusedTab() {
      const g = focusGroup !== 'main' && isSplit() ? groups[focusGroup] : null;
      if (g) return tabsOf(g).find((t) => t?.id === g.active) || null;
      const id = activeId();
      return id ? currentTabs().find((t) => t.id === id) || null : null;
    }
    function syncSidebar() {
      const tab = focusedTab();
      const signature = tab ? `${tab.id}` : '';
      if (signature === lastSidebar) return;
      lastSidebar = signature;
      tree?.follow(tab?.type === 'file' ? tab.path : null);
      const key = tab?.type === 'term' ? tab.key : null;
      state.listCurrent = key;
      $$('.win-item[data-key]').forEach((el) => {
        const on = el.dataset.key === key;
        el.classList.toggle('selected', on);
        el.setAttribute('aria-current', String(on));
      });
    }
    function setMode(mode, { save = true } = {}) {
      if (!modes[mode]) mode = 'windows';
      document.body.dataset.wsMode = mode;
      if (save) store.set('ws-mode', mode);
      $$('[data-ws-mode]').forEach((button) => {
        button.classList.toggle('active', button.dataset.wsMode === mode);
        button.setAttribute('aria-selected', String(button.dataset.wsMode === mode));
      });
      if (mode === 'files' || desktopQuery.matches) ensureTree();
      if (mode !== 'files') renderAll(true);
    }
    $$('[data-ws-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.wsMode)));

    function showFileView(show) {
      fileView.classList.toggle('hidden', !show);
      fileView.classList.toggle('flex', show);
      document.body.classList.toggle('file-open', show);
      store.set('ws-file-open', show);
      syncChip();
      renderBar();
    }
    function ensureViewer() {
      if (!viewer && window.UnivDashExplorer) {
        viewer = window.UnivDashExplorer.mountViewer(fileView, {
          backAlways: true, hideTabs: true, onInsert: insertPath,
          onTabsChange: () => { syncChip(); renderBar(); },
          // If the last file tab was closed while tmux tabs remain, go there (the shared tab bar handles the switch)
          onClose: (info) => { if (info?.reason === 'empty' && orderedTabs().length) { showFileView(false); restoreRight(); } else closeFile(); },
        });
      }
      return viewer;
    }
    // ── Shared tab bar: tmux window tabs + file tabs on one row (kinds are told apart by icon · colour) ──
    const bar = $('#wsTabs');
    // Split view state (up to 2×2): which group each cell belongs to · per-group tabs (order) and the tab being viewed
    let layout = store.get('ws-layout', null);          // [[tl, tr], [bl, br]] group ids ('main' | 's1' | 's2' | 's3')
    let groupState = store.get('ws-groups', {});         // { s1: { items: [...], active } }
    const groups = {};                                   // groups after the first one, created on screen
    let focusGroup = 'main';
    let tabOrder = store.get('ws-tab-order', []).filter((id) => typeof id === 'string');
    let lastActive = null;
    const termId = (key) => `term:${key}`;
    const fileId = (path) => `file:${path}`;
    function currentTabs() {
      const map = byKey();
      const terms = workspace.termTabs.list().map((key) => ({ id: termId(key), type: 'term', key, w: map.get(key) })).filter((t) => t.w);
      const files = (viewer?.tabs || []).map((tab) => ({ id: fileId(tab.path), type: 'file', path: tab.path, tab }));
      const shells = [...ptys.values()].map((p) => ({ id: ptyId(p.id), type: 'pty', ptyId: p.id, p }));
      return [...terms, ...files, ...shells];
    }
    function activeId() {
      if (document.body.classList.contains('pty-open') && activePty) return ptyId(activePty);
      if (document.body.classList.contains('file-open') && viewer?.activePath) return fileId(viewer.activePath);
      return state.selectedKey ? termId(state.selectedKey) : null;
    }
    function orderedTabs() {
      const tabs = currentTabs();
      const ids = new Set(tabs.map((t) => t.id));
      // Tabs of a side not loaded yet (window list · file viewer) keep their place (so the order is not scrambled while loading)
      const loaded = (id) => (id.startsWith('term:') ? state.windows.length > 0 : id.startsWith('pty:') ? ptyLoaded : !!viewer);
      const next = tabOrder.filter((id) => ids.has(id) || !loaded(id));
      for (const tab of tabs) {
        if (next.includes(tab.id)) continue;
        const at = next.indexOf(lastActive);   // a new tab goes to the right of the tab being viewed
        next.splice(at < 0 ? next.length : at + 1, 0, tab.id);
      }
      if (next.join('\n') !== tabOrder.join('\n')) { tabOrder = next; store.set('ws-tab-order', tabOrder); }
      const byId = new Map(tabs.map((t) => [t.id, t]));
      return next.filter((id) => byId.has(id)).map((id) => byId.get(id));
    }
    // tmux · Terminal tabs moved to a second group (split) are left out of the main tab bar (files have a separate viewer per group)
    const inSide = (id) => Object.values(groups).some((g) => g.items.includes(id));
    function mainTabs() { return orderedTabs().filter((t) => !inSide(t.id)); }
    function renderBar() {
      if (!bar) return;
      const tabs = mainTabs();
      const active = activeId();
      bar.classList.toggle('hidden', !tabs.length && !isSplit() && !SOLO);
      $('#termPane').classList.toggle('has-tabs', tabs.length > 0 || SOLO);
      bar.innerHTML = tabs.map((t) => tabHtml(t, t.id === active)).join('') + (SOLO ? soloBarHtml() : '')
        + (tabs.length > 1 ? `<button type="button" class="wt-close-all" data-close-all title="${t('탭 모두 닫기')}" aria-label="${t('탭 모두 닫기')}"><i class="fas fa-rectangle-xmark"></i><span>${t('모두 닫기')}</span></button>` : '');
      if (SOLO) soloSync(tabs, active);
      lastActive = active;
      bar.querySelector('.wt.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      syncSidebar();
    }
    function tabHtml(tab, on) {
      {
        const close = (label) => `<button type="button" class="wt-close" data-close aria-label="${t('{name} 탭 닫기', { name: escapeHtml(label) })}"><i class="fas fa-xmark"></i></button>`;
        if (tab.type === 'term') {
          const w = tab.w;
          const unread = !isWindowVisible(w.key) && unreadActivity(w) > (state.seen[w.key] || 0);
          return `<div class="wt wt-term ${on ? 'active' : ''}" role="tab" aria-selected="${on}" data-id="${escapeHtml(tab.id)}" title="${escapeHtml(t('tmux 세션 · {session}:{index} · {path}', { session: w.session, index: w.index, path: w.path }))}">
              <span class="wt-kind" aria-label="tmux"><i class="fas fa-terminal"></i></span><span class="status-dot ${w.status}"></span>
              <span class="wt-name">${escapeHtml(displayName(w))}</span>${unread ? '<span class="tt-unread"></span>' : ''}${close(displayName(w))}</div>`;
        }
        if (tab.type === 'pty') {
          const name = ptyName(tab.p);
          return `<div class="wt wt-pty ${on ? 'active' : ''} ${tab.p.dead ? 'dead' : ''}" role="tab" aria-selected="${on}" data-id="${escapeHtml(tab.id)}" title="${escapeHtml(`Terminal · ${tab.p.cwd}`)}">
              <span class="wt-kind pty" aria-label="Terminal">$</span><span class="wt-name">${escapeHtml(name)}</span>${close(name)}</div>`;
        }
        const anyViewer = viewer || Object.values(groups).find((g) => g.viewer)?.viewer;
        const icon = anyViewer?.iconFor(tab.tab) || '<i class="far fa-file"></i>';
        return `<div class="wt wt-file ${on ? 'active' : ''}" role="tab" aria-selected="${on}" data-id="${escapeHtml(tab.id)}" title="${escapeHtml(t('파일 · {path}', { path: tab.path }))}">
            ${icon}<span class="wt-name">${tab.tab.dirty ? '<b class="exv-dirty">●</b>' : ''}${escapeHtml(tab.tab.name)}</span>${close(tab.tab.name)}</div>`;
      }
    }
    function activate(tab) {
      if (!tab) return;
      if (tab.type === 'term') workspace.select(tab.key, { pushHistory: false });
      else if (tab.type === 'pty') showPty(tab.ptyId);
      else openFile({ path: tab.path, name: tab.tab.name, ext: tab.tab.ext, type: 'file' });
    }
    async function closeTab(id, { keep = false } = {}) {
      const tabs = mainTabs();
      const index = tabs.findIndex((t) => t.id === id);
      if (index < 0) return;
      const tab = tabs[index];
      const neighbour = id === activeId() ? (tabs[index + 1] || tabs[index - 1]) : null;
      if (tab.type === 'file' && tab.tab.dirty) {
        if (!(await viewer.closeTab(tab.path))) return;          // unsaved changes: close after confirming
        if (neighbour) activate(neighbour);
      } else {
        if (neighbour) activate(neighbour);                        // move to the neighbouring tab first, then close
        if (tab.type === 'file') await viewer.closeTab(tab.path);
        else if (tab.type === 'pty') closePty(tab.ptyId, { hasNeighbour: !!neighbour, keep });
        else workspace.termTabs.close(tab.key);
      }
      renderBar();
    }
    // Close all tabs: for tmux windows only the tab closes (the window keeps running), for Terminal tabs the shell ends → tell the user before closing
    async function closeAllTabs() {
      const tabs = mainTabs();
      if (!tabs.length) return;
      const shells = tabs.filter((t) => t.type === 'pty').length;
      const windows = tabs.filter((t) => t.type === 'term').length;
      const notes = [];
      if (windows) notes.push(t('tmux 창 {count}개는 탭만 닫히며 창은 계속 실행됩니다.', { count: windows }));
      if (shells) notes.push(t('Terminal 탭 {count}개는 셸이 종료됩니다.', { count: shells }));
      if (tabs.some((tab) => tab.type === 'file' && tab.tab.dirty)) notes.push(t('저장하지 않은 파일은 하나씩 확인합니다.'));
      const ok = await confirmSheet({ title: t('탭 모두 닫기'), message: `${t('열린 탭 {count}개를 모두 닫습니다.', { count: tabs.length })}${notes.length ? `\n${notes.join('\n')}` : ''}`, confirmLabel: t('모두 닫기'), danger: shells > 0 });
      if (!ok) return;
      // Close the tab being viewed last, so the screen does not switch to neighbouring tabs several times while closing
      const active = activeId();
      for (const tab of [...tabs.filter((t) => t.id !== active), ...tabs.filter((t) => t.id === active)]) {
        await closeTab(tab.id);
      }
    }
    window.UnivDashKeys?.register('ws.closeAllTabs', () => { closeAllTabs(); });
    bar?.addEventListener('click', (event) => {
      if (event.target.closest('[data-solo-return]')) { returnToMain(); return; }
      if (event.target.closest('[data-close-all]')) { closeAllTabs(); return; }
      const el = event.target.closest('.wt');
      if (!el) return;
      const tab = mainTabs().find((t) => t.id === el.dataset.id);
      if (!tab) return;
      if (event.target.closest('[data-close]')) { closeTab(tab.id); return; }
      if (tab.id !== activeId()) activate(tab);
    });
    bar?.addEventListener('auxclick', (event) => {
      const el = event.target.closest('.wt');
      if (el && event.button === 1) { event.preventDefault(); closeTab(el.dataset.id); }
    });
    workspace.termTabs.onChange(() => { renderBar(); renderGroups(); });

    // ── Terminal (not tmux) ─────────────────────────────────────────
    // The shell lives on the server, so it reattaches after a reload. Closing the tab (×) ends the shell right away.
    const ptyView = $('#ptyView');
    const ptyHost = $('#ptyHost');
    const ptys = new Map();   // id → { id, cwd, title, dead, client }
    let activePty = null;
    let ptyLoaded = false;
    const ptyId = (id) => `pty:${id}`;
    const ptyName = (p) => p.title || (p.cwd === '/' ? '/' : p.cwd.replace(/\/+$/, '').split('/').pop() || '~');
    const savePtyTabs = () => store.set('pty-tabs', [...ptys.keys()]);
    function addPty(info) {
      if (ptys.has(info.id)) return ptys.get(info.id);
      const p = { id: info.id, cwd: info.cwd, title: '', dead: !info.alive, client: null };
      ptys.set(p.id, p);
      savePtyTabs();
      return p;
    }
    function ensureClient(p) {
      if (p.client || !window.UnivDashPty || !window.Terminal) return p.client;
      p.client = window.UnivDashPty.attach(ptyHost, p.id, {
        onTitle: (title) => { p.title = title.slice(0, 60); if (activePty === p.id) $('#ptyTitle').textContent = ptyName(p); renderBar(); },
        onExit: () => { p.dead = true; renderBar(); },
        onGone: () => { p.dead = true; renderBar(); },
      });
      return p.client;
    }
    function hidePtyView() {
      if (!document.body.classList.contains('pty-open')) return;
      document.body.classList.remove('pty-open');
      ptyView.classList.add('hidden');
      ptyView.classList.remove('flex');
      store.set('ws-pty-open', false);
    }
    function showPty(id) {
      const p = ptys.get(id);
      if (!p) return;
      activePty = id;
      store.set('pty-active', id);
      if (document.body.classList.contains('file-open')) showFileView(false);
      $('#termView').classList.remove('open');
      $('#termEmpty').classList.add('hidden');
      $('#termEmpty').classList.remove('lg:flex');
      ptyView.classList.remove('hidden');
      ptyView.classList.add('flex');
      document.body.classList.add('pty-open');
      store.set('ws-pty-open', true);
      if (!desktopQuery.matches && !document.body.classList.contains('term-open')) {
        document.body.classList.add('term-open');
        try { window.history.pushState({ ptyTab: id }, ''); } catch (e) { /* noop */ }
      }
      const client = ensureClient(p);
      if (client && client.el.parentElement !== ptyHost) ptyHost.appendChild(client.el);   // coming back from a second group
      ptys.forEach((other) => { if (!inSide(ptyId(other.id))) other.client?.el.classList.toggle('hidden', other.id !== id); });
      $('#ptyTitle').textContent = ptyName(p);
      $('#ptyCwd').textContent = p.cwd;
      renderBar();
      requestAnimationFrame(() => { client?.refit(); if (!coarsePointer) client?.focus(); });
    }
    function leavePty(fromPopstate = false) {
      if (!document.body.classList.contains('pty-open')) return;
      if (!desktopQuery.matches && !fromPopstate && window.history.state?.ptyTab) { window.history.back(); return; }
      hidePtyView();
      if (!desktopQuery.matches) document.body.classList.remove('term-open');
      restoreRight();
      renderBar();
    }
    window.addEventListener('popstate', () => { if (document.body.classList.contains('pty-open')) leavePty(true); });
    async function newTerminal(cwd = '') {
      if (!window.UnivDashPty) return;
      try {
        const info = await window.UnivDashPty.create(cwd);
        addPty(info);
        showPty(info.id);
      } catch (error) { toast(error.message, 'error'); }
    }
    function closePty(id, { hasNeighbour = false, keep = false } = {}) {
      const p = ptys.get(id);
      if (!p) return;
      ptys.delete(id);
      savePtyTabs();
      p.client?.dispose();
      if (!keep) window.UnivDashPty?.kill(id);         // closing the tab ends the shell too (left alone when moving to a new window)
      if (activePty === id) {
        activePty = null;
        if (!hasNeighbour) leavePty();
      }
      renderBar();
    }
    $('#ptyBack')?.addEventListener('click', () => leavePty());
    $('#ptyNew')?.addEventListener('click', () => newTerminal(ptys.get(activePty)?.cwd || ''));
    $('#ptyKill')?.addEventListener('click', () => { if (activePty) closeTab(ptyId(activePty)); });
    const ptyKeys = $('#ptyKeys');
    if (ptyKeys) {
      ptyKeys.innerHTML = ['Esc', 'Tab', '^C', '^D', '↑', '↓', '←', '→', '^R', '^L', '^Z', '|', '~', '/', '-', 'Home', 'End', 'PgUp', 'PgDn']
        .map((k) => `<button type="button" class="key-chip ${k === '^C' ? 'key-danger' : k === 'Esc' ? 'key-accent' : ''}" data-pty-key="${escapeHtml(k)}">${escapeHtml(k)}</button>`).join('');
      ptyKeys.addEventListener('pointerdown', (event) => { if (event.target.closest('[data-pty-key]')) event.preventDefault(); });
      ptyKeys.addEventListener('click', (event) => {
        const key = event.target.closest('[data-pty-key]')?.dataset.ptyKey;
        const p = ptys.get(activePty);
        if (key && p?.client) { vibrate(6); p.client.sendKeys(window.UnivDashPty.KEYS[key]); }
      });
    }
    // Start-up: of the terminals alive on the server, restore as tabs only the ones opened on this device
    async function restorePtys() {
      if (!window.UnivDashPty) { ptyLoaded = true; return; }
      const mine = new Set(store.get('pty-tabs', []));
      try {
        const alive = await window.UnivDashPty.list();
        alive.filter((t) => mine.has(t.id) && t.alive).forEach(addPty);
      } catch (e) { /* noop */ }
      ptyLoaded = true;
      savePtyTabs();
      restoreGroups();
      const want = store.get('pty-active', null);
      if (store.get('ws-pty-open', false) && ptys.has(want) && (desktopQuery.matches || !location.hash)) showPty(want);
      else renderBar();
      const params = new URLSearchParams(location.search);
      if (params.get('newterm')) {
        try { window.history.replaceState(window.history.state, '', location.pathname + location.hash); } catch (e) { /* noop */ }
        newTerminal(params.get('cwd') || '');
      }
    }
    window.UnivDashWs = { ...(window.UnivDashWs || {}), newTerminal };
    // Shortcuts (keys.js · defaults: w close current tab · 1~9 Nth tab · ←/→ previous/next tab)
    // While split, they apply to the last clicked group
    function tabContext() {
      const g = focusGroup !== 'main' && isSplit() ? groups[focusGroup] : null;
      const tabs = g ? tabsOf(g) : mainTabs();
      const id = g ? g.active : activeId();
      const go = (tab) => { if (tab && tab.id !== id) { if (g) showIn(g, tab.id); else activate(tab); } };
      return { g, tabs, id, go, index: tabs.findIndex((t) => t.id === id) };
    }
    const keys = window.UnivDashKeys;
    keys?.register('tab.close', () => {
      const { g, id, index } = tabContext();
      if (index < 0) return false;
      if (g) closeTabIn(g, id); else closeTab(id);
      return true;
    });
    [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((n) => keys?.register(`tab.${n}`, () => {
      const { tabs, go } = tabContext();
      if (!tabs[n - 1]) return false;
      go(tabs[n - 1]);
      return true;
    }));
    [['tab.next', 1], ['tab.prev', -1]].forEach(([id, step]) => keys?.register(id, () => {
      const { tabs, go, index } = tabContext();
      if (tabs.length < 2) return false;
      go(tabs[((index < 0 ? 0 : index + step) + tabs.length) % tabs.length]);
      return true;
    }));

    // ════════════════════════════════════════════════════════════════
    // Split view (up to 2×2 · 4 groups, like VS Code): dragging a tab onto the edge of a group splits that group's area in half.
    //  - The arrangement is stored as a 2×2 cell table (layout): a group id per cell. When a group is removed, a neighbouring group takes over its cells.
    //  - The main group is the existing screen (all features); the other groups are a file viewer · Terminal · live tmux screen (+ quick input).
    //  - Only the central editor area is split, regardless of the left/right sidebars.
    // ════════════════════════════════════════════════════════════════
    const editorArea = $('#editorArea');
    const GROUP_IDS = ['s1', 's2', 's3'];
    const sfileId = (path) => `sfile:${path}`;
    const FULL = () => [['main', 'main'], ['main', 'main']];
    if (!Array.isArray(layout) || layout.length !== 2) layout = FULL();
    // Migrate the old single-split (ws-split) state to the new format
    (() => {
      const old = store.get('ws-split', null);
      const items = store.get('ws-side-items', []);
      if (!old || !items.length || layout.flat().some((id) => id !== 'main')) return;
      const side = 's1';
      layout = old.dir === 'column'
        ? (old.first === 'side' ? [[side, side], ['main', 'main']] : [['main', 'main'], [side, side]])
        : (old.first === 'side' ? [[side, 'main'], [side, 'main']] : [['main', side], ['main', side]]);
      groupState = { s1: { items, active: store.get('ws-side-active', null) } };
      try { const tabs = localStorage.getItem('univdash-ex-tabs-side'); if (tabs && !localStorage.getItem('univdash-ex-tabs-s1')) localStorage.setItem('univdash-ex-tabs-s1', tabs); } catch (e) { /* noop */ }
      store.set('ws-split', null);
    })();
    const layoutIds = () => [...new Set(layout.flat())];
    const isSplit = () => desktopQuery.matches && layoutIds().length > 1;
    function saveLayout() {
      for (const id of Object.keys(groupState)) if (!groups[id] && !layoutIds().includes(id)) delete groupState[id];
      Object.values(groups).forEach((g) => { groupState[g.id] = { items: g.items, active: g.active }; });
      store.set('ws-layout', layout);
      store.set('ws-groups', groupState);
    }
    const cellsOf = (id) => [[0, 0], [0, 1], [1, 0], [1, 1]].filter(([r, c]) => layout[r][c] === id);
    function canSplit(id, edge) {
      const cells = cellsOf(id);
      if (!cells.length) return false;
      const rows = new Set(cells.map(([r]) => r));
      const cols = new Set(cells.map(([, c]) => c));
      return edge === 'left' || edge === 'right' ? cols.size === 2 : rows.size === 2;
    }
    function positionLabel(id) {
      const cells = cellsOf(id);
      const rows = new Set(cells.map(([r]) => r));
      const cols = new Set(cells.map(([, c]) => c));
      const v = rows.size === 2 ? '' : rows.has(0) ? 'top' : 'bottom';
      const h = cols.size === 2 ? '' : cols.has(0) ? 'left' : 'right';
      const labels = {
        'left top': t('왼쪽 위'), 'left bottom': t('왼쪽 아래'), 'right top': t('오른쪽 위'), 'right bottom': t('오른쪽 아래'),
        left: t('왼쪽'), right: t('오른쪽'), top: t('위'), bottom: t('아래'),
      };
      return labels[`${h} ${v}`.trim()] || t('전체');
    }

    // ── Creating · removing groups ──
    function createGroup(id) {
      if (groups[id]) return groups[id];
      const el = document.createElement('section');
      el.className = 'side-pane';
      el.dataset.group = id;
      el.style.gridArea = id;
      el.setAttribute('aria-label', t('분할 화면'));
      el.innerHTML = `
        <div class="side-bar">
          <div class="ws-tabbar no-scrollbar" role="tablist"></div>
          <button type="button" class="side-bar-btn" data-g-close title="${t('이 분할 닫기 (탭은 메인 그룹으로)')}" aria-label="${t('분할 닫기')}"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="side-host">
          <div class="side-view g-file hidden"></div>
          <div class="side-view g-pty pty-host hidden"></div>
          <div class="side-view g-mirror hidden"></div>
          <div class="side-view side-empty"><i class="fas fa-table-columns"></i><p>${t('탭을 여기로 끌어다 놓으십시오.')}</p></div>
        </div>`;
      editorArea.insertBefore(el, $('#dropZones'));
      const saved = groupState[id] || {};
      const g = { id, el, bar: el.querySelector('.ws-tabbar'), items: (saved.items || []).filter((x) => typeof x === 'string'), active: saved.active || null, shown: null, viewer: null, mirror: null };
      groups[id] = g;
      g.bar.addEventListener('click', (event) => {
        const tabEl = event.target.closest('.wt');
        if (!tabEl) return;
        if (event.target.closest('[data-close]')) { closeTabIn(g, tabEl.dataset.id); return; }
        showIn(g, tabEl.dataset.id);
      });
      g.bar.addEventListener('auxclick', (event) => {
        const tabEl = event.target.closest('.wt');
        if (tabEl && event.button === 1) { event.preventDefault(); closeTabIn(g, tabEl.dataset.id); }
      });
      g.bar.addEventListener('contextmenu', (event) => tabMenu(event, id));
      el.querySelector('[data-g-close]').addEventListener('click', () => closeGroup(id));
      el.addEventListener('pointerdown', () => { focusGroup = id; setTimeout(syncSidebar); }, true);
      if (window.Sortable) sortableFor(g.bar, id);
      return g;
    }
    // Remove a group and hand its cells to a neighbouring group that stays rectangular
    function removeGroup(id) {
      const cells = cellsOf(id);
      const others = layoutIds().filter((x) => x !== id);
      const heir = ['main', ...others.filter((x) => x !== 'main')].find((other) => {
        const union = [...cellsOf(other), ...cells];
        const rows = new Set(union.map(([r]) => r));
        const cols = new Set(union.map(([, c]) => c));
        return rows.size * cols.size === union.length;
      }) || 'main';
      cells.forEach(([r, c]) => { layout[r][c] = heir; });
      const g = groups[id];
      if (g) { g.mirror?.dispose(); g.el.remove(); delete groups[id]; }
      delete groupState[id];
      saveLayout();
      applyLayout();
    }
    function applyLayout() {
      const split = isSplit();
      editorArea.classList.toggle('is-split', split);
      editorArea.style.gridTemplateAreas = split ? layout.map((row) => `"${row.join(' ')}"`).join(' ') : '';
      $('#termPane').style.gridArea = split ? 'main' : '';
      Object.values(groups).forEach((g) => g.el.classList.toggle('hidden', !split));
      requestAnimationFrame(() => terminal?.refit());
    }

    // ── Tabs of a group ──
    function ensureGroupViewer(g) {
      if (!g.viewer && window.UnivDashExplorer) {
        g.viewer = window.UnivDashExplorer.mountViewer(g.el.querySelector('.g-file'), {
          stateKey: `tabs-${g.id}`, hideTabs: true, onInsert: insertPath,
          onTabsChange: () => renderGroup(g),
          onClose: () => renderGroup(g),
        });
      }
      return g.viewer;
    }
    function tabsOf(g) {
      const map = byKey();
      if (g.viewer) {
        const files = new Set(g.viewer.tabs.map((t) => sfileId(t.path)));
        const next = g.items.filter((id) => !id.startsWith('sfile:') || files.has(id));
        files.forEach((id) => { if (!next.includes(id)) next.push(id); });
        if (next.join('\n') !== g.items.join('\n')) { g.items = next; saveLayout(); }
      }
      return g.items.map((id) => {
        if (id.startsWith('term:')) {
          const w = map.get(id.slice(5));
          if (!w && state.windows.length) { g.items = g.items.filter((x) => x !== id); saveLayout(); return null; }
          return w ? { id, type: 'term', key: w.key, w } : null;
        }
        if (id.startsWith('pty:')) {
          const p = ptys.get(id.slice(4));
          if (!p && ptyLoaded) { g.items = g.items.filter((x) => x !== id); saveLayout(); return null; }
          return p ? { id, type: 'pty', ptyId: p.id, p } : null;
        }
        const tab = g.viewer?.tabs.find((t) => sfileId(t.path) === id);
        return tab ? { id, type: 'file', path: tab.path, tab } : null;
      }).filter(Boolean);
    }
    const sourcesLoaded = (id) => !id || (id.startsWith('sfile:') ? true : id.startsWith('term:') ? state.windows.length > 0 : ptyLoaded);
    function renderGroup(g) {
      const tabs = tabsOf(g);
      const activeTerm = tabs.find((t) => t.id === g.active && t.type === 'term');
      if (activeTerm && g.mirror?.key === activeTerm.key) g.mirror.update(activeTerm.w);   // refresh status dot · title
      g.bar.innerHTML = tabs.map((t) => tabHtml(t, t.id === g.active)).join('');
      if (!g.el.isConnected || !isSplit()) return;
      if (!sourcesLoaded(g.active)) return;                 // right after a reload: open once loaded
      if (!tabs.some((t) => t.id === g.active)) g.active = tabs[0]?.id || null;
      if (!g.active) { hideGroupViews(g); g.el.querySelector('.side-empty').classList.remove('hidden'); g.shown = null; return; }
      if (g.shown !== g.active) showIn(g, g.active);
    }
    function renderGroups() {
      Object.values(groups).forEach((g) => renderGroup(g));
      applyLayout();
      queueCollapse();
      // Also mark visible windows as read when returning from mobile to the desktop split or restoring the layout.
      Object.values(groups).forEach((g) => {
        const key = g.mirror?.key;
        const w = key && byKey().get(key);
        if (w && isWindowVisible(key)) markSeen(key, unreadActivity(w));
      });
    }
    // ── No empty cells: a group without tabs is removed, and when main is empty a neighbouring group takes main's place ──
    // With a single pane left it naturally becomes full screen. Nothing is touched while a tab is being moved (briefly empty) or while loading.
    let layoutBusy = 0;
    let collapsing = false;
    let collapseQueued = false;
    async function whileMoving(task) {
      layoutBusy += 1;
      try { return await task(); } finally { layoutBusy -= 1; queueCollapse(); }
    }
    function queueCollapse() {
      if (collapseQueued) return;
      collapseQueued = true;
      setTimeout(() => { collapseQueued = false; collapseEmptyGroups(); });
    }
    const groupIsEmpty = (g) => !(g.items.some((id) => id.startsWith('sfile:')) && !g.viewer) && !tabsOf(g).length;
    // Main file tabs only show up after the viewer is opened, so with no viewer and saved file tabs main is not considered empty
    const mainIsEmpty = () => !mainTabs().length && (viewer || !tabOrder.some((id) => id.startsWith('file:')));
    // It must be a group that still forms a rectangle when merged with main, or the rest of the layout breaks
    function groupForMain() {
      const main = cellsOf('main');
      return Object.values(groups).find((g) => {
        const union = [...main, ...cellsOf(g.id)];
        return new Set(union.map(([r]) => r)).size * new Set(union.map(([, c]) => c)).size === union.length;
      });
    }
    async function promoteToMain(g) {
      const activeTab = tabsOf(g).find((t) => t.id === g.active);
      for (const tab of tabsOf(g)) await moveTab(tab, g.id, 'main', { show: false });
      if (groups[g.id]) removeGroup(g.id);
      focusGroup = 'main';
      const shown = activeTab && findTab('main', activeTab.type === 'file' ? fileId(activeTab.path) : activeTab.id);
      const next = shown || mainTabs()[0];
      if (next) activate(next);
    }
    async function collapseEmptyGroups() {
      if (layoutBusy || collapsing || SOLO || !desktopQuery.matches || !state.windowsLoaded || !ptyLoaded) return;
      collapsing = true;
      let changed = false;
      try {
        Object.values(groups).filter(groupIsEmpty).forEach((g) => { removeGroup(g.id); changed = true; });
        const heir = isSplit() && mainIsEmpty() ? groupForMain() : null;
        if (heir) { await promoteToMain(heir); changed = true; }
      } finally {
        collapsing = false;
      }
      if (changed) { if (!groups[focusGroup]) focusGroup = 'main'; renderBar(); renderGroups(); }
    }
    setInterval(collapseEmptyGroups, 2000);   // so windows closed from outside are not missed either
    function hideGroupViews(g) { g.el.querySelectorAll('.side-view').forEach((el) => el.classList.add('hidden')); }
    function showIn(g, id) {
      const tab = tabsOf(g).find((t) => t.id === id);
      if (!tab) return;
      g.active = id;
      g.shown = id;
      saveLayout();
      hideGroupViews(g);
      if (tab.type !== 'term') g.mirror?.stop();
      if (tab.type === 'file') {
        g.el.querySelector('.g-file').classList.remove('hidden');
        if (g.viewer?.activePath !== tab.path || !g.viewer.current) g.viewer.open({ path: tab.path, name: tab.tab.name, ext: tab.tab.ext, type: 'file' });
      } else if (tab.type === 'pty') {
        const host = g.el.querySelector('.g-pty');
        host.classList.remove('hidden');
        const client = ensureClient(tab.p);
        if (client && client.el.parentElement !== host) host.appendChild(client.el);
        host.querySelectorAll('.pty-screen').forEach((el) => el.classList.toggle('hidden', el !== client?.el));
        requestAnimationFrame(() => { client?.refit(); if (!coarsePointer) client?.focus(); });
      } else {
        g.el.querySelector('.g-mirror').classList.remove('hidden');
        ensureMirror(g).show(tab.w);
      }
      g.bar.querySelectorAll('.wt').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
      focusGroup = g.id;
      syncSidebar();
    }

    // ── Moving tabs: from/to is 'main' or a group id ──
    const findTab = (from, id) => (from === 'main' ? mainTabs() : tabsOf(groups[from] || { items: [] })).find((t) => t.id === id);
    function moveTab(tab, from, to, options) { return whileMoving(() => moveTabNow(tab, from, to, options)); }
    async function moveTabNow(tab, from, to, { show = true } = {}) {
      if (!tab || from === to) return;
      const entry = tab.type === 'file' ? { path: tab.path, name: tab.tab.name, ext: tab.tab.ext, type: 'file' } : null;
      // 1) Take it out of the original group (if it was the viewed tab, go to the neighbouring tab)
      if (from === 'main') {
        const mains = mainTabs();
        const index = mains.findIndex((t) => t.id === tab.id);
        const neighbour = tab.id === activeId() ? (mains[index + 1] || mains[index - 1]) : null;
        if (tab.type !== 'file' && to !== 'main') groups[to]?.items.push(tab.id);   // so it leaves the main list first
        if (neighbour) activate(neighbour);
        if (tab.type === 'term') workspace.termTabs.close(tab.key, { activateNext: false });
        else if (tab.type === 'pty') { if (activePty === tab.ptyId) { activePty = null; if (!neighbour) leavePty(); } }
        else await viewer.forget(tab.path);
      } else {
        const g = groups[from];
        const list = tabsOf(g);
        const index = list.findIndex((t) => t.id === tab.id);
        g.items = g.items.filter((x) => x !== tab.id);
        if (g.active === tab.id) { g.active = (list[index + 1] || list[index - 1])?.id || null; g.shown = null; }
        if (tab.type === 'term' && g.mirror?.key === tab.key) g.mirror.stop();
        if (tab.type === 'file') await g.viewer.forget(tab.path);
      }
      // 2) Put it into the new group
      if (to === 'main') {
        if (tab.type === 'term') { if (show) workspace.select(tab.key, { pushHistory: false }); else workspace.termTabs.add(tab.key); }
        else if (tab.type === 'pty') { if (tab.p.client) ptyHost.appendChild(tab.p.client.el); if (show) showPty(tab.ptyId); }
        else if (show) openFile(entry); else ensureViewer()?.add(entry);
      } else {
        const g = groups[to];
        const id = tab.type === 'file' ? sfileId(tab.path) : tab.id;
        if (!g.items.includes(id)) g.items.push(id);
        if (tab.type === 'file') { ensureGroupViewer(g); if (show) g.viewer.open(entry); else g.viewer.add(entry); }
        if (show || !g.active) { g.active = id; g.shown = null; }
      }
      // 3) Remove an empty group
      if (from !== 'main' && groups[from] && !groups[from].items.length) removeGroup(from);
      saveLayout();
      renderBar();
      renderGroups();
    }
    // Split the edge-side half of the target group into a new group and move the tab there
    // Create a new group in the edge-side half of the target group's area (returns the new group id, or null if it cannot be made)
    function makeGroupAt(target, edge) {
      if (!desktopQuery.matches || !canSplit(target, edge)) return null;
      const id = GROUP_IDS.find((x) => !layoutIds().includes(x));
      if (!id) { toast(t('최대 4개까지 나눌 수 있습니다.'), 'info'); return null; }
      cellsOf(target).forEach(([r, c]) => {
        const side = edge === 'left' ? c === 0 : edge === 'right' ? c === 1 : edge === 'top' ? r === 0 : r === 1;
        if (side) layout[r][c] = id;
      });
      createGroup(id);
      saveLayout();
      applyLayout();
      return id;
    }
    async function splitWith(tab, from, target, edge) {
      if (from === target && from !== 'main' && tabsOf(groups[from]).length <= 1) return;   // the only tab onto its own edge: pointless
      await whileMoving(async () => {
        const id = makeGroupAt(target, edge);
        if (id) await moveTab(tab, from, id);
      });
    }
    // Open a file in a given group (a file dragged from the explorer)
    function openFileIn(group, entry) {
      if (group === 'main' || !groups[group]) { openFile(entry); focusGroup = 'main'; return; }
      const g = groups[group];
      ensureGroupViewer(g);
      const id = sfileId(entry.path);
      if (!g.items.includes(id)) g.items.push(id);
      g.viewer.open(entry);
      g.active = id;
      g.shown = null;
      saveLayout();
      renderGroups();
    }
    async function closeTabIn(g, id, { keep = false } = {}) {
      const tab = tabsOf(g).find((t) => t.id === id);
      if (!tab) return;
      if (tab.type === 'file') { if (!(await g.viewer.closeTab(tab.path))) return; }
      else if (tab.type === 'pty') closePty(tab.ptyId, { hasNeighbour: true, keep });
      else if (g.mirror?.key === tab.key) g.mirror.stop();
      const list = tabsOf(g);
      const index = list.findIndex((t) => t.id === id);
      g.items = g.items.filter((x) => x !== id);
      if (g.active === id) { g.active = (list[index + 1] || list[index - 1])?.id || null; g.shown = null; }
      if (!g.items.length) removeGroup(g.id);
      saveLayout();
      renderGroups();
      renderBar();
    }
    function closeGroup(id) {
      return whileMoving(async () => {
        const g = groups[id];
        if (!g) return;
        for (const tab of tabsOf(g)) await moveTab(tab, id, 'main', { show: false });
        if (groups[id]) removeGroup(id);
        renderBar();
        renderGroups();
      });
    }
    // After a reload: recreate the groups from the saved layout
    function restoreGroups() {
      layoutIds().filter((id) => id !== 'main').forEach((id) => {
        const g = createGroup(id);
        if (g.items.some((x) => x.startsWith('sfile:'))) ensureGroupViewer(g);
      });
      renderGroups();
      renderBar();
    }
    $('#termPane')?.addEventListener('pointerdown', () => { focusGroup = 'main'; setTimeout(syncSidebar); }, true);
    desktopQuery.addEventListener('change', () => { renderBar(); renderGroups(); });

    // ── Tab right-click: split · move ──
    function tabMenu(event, group) {
      const el = event.target.closest('.wt');
      if (!el || !desktopQuery.matches) return;
      event.preventDefault();
      const tab = findTab(group, el.dataset.id);
      if (!tab) return;
      const splits = [['right', t('오른쪽으로 분할'), 'fa-table-columns'], ['left', t('왼쪽으로 분할'), 'fa-table-columns'], ['bottom', t('아래로 분할'), 'fa-table-cells-large'], ['top', t('위로 분할'), 'fa-table-cells-large']]
        .filter(([edge]) => canSplit(group, edge) && layoutIds().length < 4)
        .map(([edge, label, icon]) => ({ icon, label, onClick: () => splitWith(tab, group, group, edge) }));
      const moves = layoutIds().filter((id) => id !== group).map((id) => ({
        icon: 'fa-arrow-right-to-bracket', label: id === 'main' ? t('메인 그룹 ({position})으로 옮기기', { position: positionLabel(id) }) : t('분할 ({position})으로 옮기기', { position: positionLabel(id) }), onClick: () => moveTab(tab, group, id),
      }));
      const pops = [{ icon: 'fa-up-right-from-square', label: t('새 창으로 띄우기'), desc: t('팝업 창으로 떼어 내서 다른 모니터에 두고 쓸 수 있습니다'), onClick: () => popOut(tab, group) }];
      if (window.screen?.isExtended && 'getScreenDetails' in window) pops.push({ icon: 'fa-display', label: t('다른 모니터에 띄우기'), onClick: () => popOut(tab, group, { otherScreen: true }) });
      actionSheet({
        title: el.querySelector('.wt-name')?.textContent || t('탭'),
        actions: [
          ...pops, 'sep',
          ...splits, ...(splits.length && moves.length ? ['sep'] : []), ...moves, 'sep',
          { icon: 'fa-xmark', label: t('닫기'), onClick: () => (group === 'main' ? closeTab(tab.id) : closeTabIn(groups[group], tab.id)) },
          ...(group !== 'main' ? [{ icon: 'fa-table-columns', label: t('이 분할 닫기'), onClick: () => closeGroup(group) }] : []),
        ],
      });
    }
    bar?.addEventListener('contextmenu', (event) => tabMenu(event, 'main'));

    // ── Pop out to a new window: a popup window showing a single tab (/?solo=…). Drag it to another monitor and use it there ──
    // The tmux window · Terminal shell stays alive on the server and the new window attaches to the same one. The tab is removed from this window.
    // Pressing 'Back to main window' in the popup, or simply closing a Terminal popup, brings it back to this window.
    const SOLO_CHANNEL = 'univdash-solo';
    let screenDetails = null;
    const tabInfo = (tab) => (tab.type === 'term' ? { type: 'term', key: tab.key }
      : tab.type === 'pty' ? { type: 'pty', id: tab.ptyId, cwd: tab.p?.cwd || '' }
        : { type: 'file', path: tab.path, name: tab.tab?.name, ext: tab.tab?.ext });
    function soloUrl(info) {
      const q = new URLSearchParams({ solo: info.type });
      if (info.type === 'term') q.set('key', info.key);
      else if (info.type === 'pty') q.set('id', info.id);
      else q.set('path', info.path);
      return `/?${q}${info.type === 'term' ? `#${encodeURIComponent(info.key)}` : ''}`;
    }
    function popupName(id) {
      let h = 0;
      for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
      return `univdash-solo-${(h >>> 0).toString(36)}`;
    }
    const onScreen = (sc, p) => p.x >= sc.left && p.x < sc.left + sc.width && p.y >= sc.top && p.y < sc.top + sc.height;
    // The monitor containing screen coordinate p (null when unknown → leave it to the browser).
    // No permission prompt during drag and drop: while waiting, the popup that is only allowed right after a click would be blocked.
    // If permission is not granted yet, needScreenAccess is set and it is requested after opening via the notice's [Allow] button (a new click).
    let needScreenAccess = false;
    async function screenAt(p) {
      const here = window.screen;
      const cur = { left: here.availLeft ?? 0, top: here.availTop ?? 0, width: here.width, height: here.height };
      if (onScreen(cur, p) || !('getScreenDetails' in window)) return null;
      try {
        if (!screenDetails) {
          const state = (await navigator.permissions.query({ name: 'window-management' }))?.state;
          if (state !== 'granted') { needScreenAccess = state === 'prompt'; return null; }
          screenDetails = await window.getScreenDetails();
        }
        return screenDetails.screens.find((sc) => onScreen(sc, p)) || null;
      } catch (e) {
        return null;
      }
    }
    async function moveToScreen(win, p, width, height) {
      try {
        screenDetails = screenDetails || await window.getScreenDetails();
        const sc = screenDetails.screens.find((x) => onScreen(x, p));
        if (!sc || win.closed) return;
        const w = Math.min(width, sc.availWidth);
        const h = Math.min(height, sc.availHeight);
        win.moveTo(Math.min(Math.max(p.x - 120, sc.availLeft), sc.availLeft + sc.availWidth - w), Math.min(Math.max(p.y - 20, sc.availTop), sc.availTop + sc.availHeight - h));
        win.resizeTo(w, h);
        toast(t('놓은 모니터로 옮겼습니다. 다음부터는 바로 그 모니터에 표시됩니다.'), 'success', 2600);
      } catch (e) {
        toast(t('창 관리 권한이 없어 이 모니터에 띄웠습니다. 주소창 왼쪽 사이트 설정에서 \'창 관리\'를 허용하면 놓은 모니터에 표시됩니다.'), 'info', 6000);
      }
    }
    async function popOut(tab, group, { otherScreen = false, at = null } = {}) {
      if (!tab) return;
      if (tab.type === 'file' && tab.tab?.dirty) { toast(t('저장하지 않은 변경이 있습니다. 저장한 뒤 새 창으로 띄워 주십시오.'), 'error'); return; }
      const info = tabInfo(tab);
      const pane = (group === 'main' ? $('#termPane') : groups[group]?.el)?.getBoundingClientRect();
      let width = Math.round(Math.min(window.screen.availWidth, Math.max(1100, pane?.width || 1100)));
      let height = Math.round(Math.min(window.screen.availHeight, Math.max(520, (pane?.height || 760) + 40)));
      let left = at ? Math.round(at.x - 120) : window.screenX + 48;   // at: screen position where the tab was dropped
      let top = at ? Math.round(at.y - 20) : window.screenY + 48;
      // If the drop point is not on this window's monitor (window on a secondary monitor → primary monitor, etc.), find that monitor and open inside it.
      // Without the 'window management' permission the browser pulls the popup into the current monitor, so we get the permission and use the monitor info.
      needScreenAccess = false;
      if (at && !otherScreen) {
        const target = await screenAt(at);
        if (target) {
          width = Math.min(width, target.availWidth);
          height = Math.min(height, target.availHeight);
          left = Math.min(Math.max(left, target.availLeft), target.availLeft + target.availWidth - width);
          top = Math.min(Math.max(top, target.availTop), target.availTop + target.availHeight - height);
        }
      }
      if (otherScreen) {
        try {
          screenDetails = screenDetails || await window.getScreenDetails();   // asks for the 'window management' permission the first time
          const here = screenDetails.currentScreen;
          const other = screenDetails.screens.find((sc) => sc !== here && (sc.left !== here.left || sc.top !== here.top));
          if (other) {
            left = other.availLeft + Math.max(0, Math.round((other.availWidth - width) / 2));
            top = other.availTop + Math.max(0, Math.round((other.availHeight - height) / 2));
          }
        } catch (e) { /* permission denied: just open next to this window */ }
      }
      const win = window.open(soloUrl(info), popupName(tab.id), `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
      if (!win) {
        // A long drag (all the way to another monitor) is not seen by the browser as 'right after a click', so the popup is blocked → open it with one button press
        if (at) toast(t('탭을 새 창으로 띄우려면 눌러 주십시오.'), 'info', { label: t('새 창 열기'), onClick: () => popOut(tab, group, { at }) }, 8000);
        else toast(t('팝업이 막혔습니다. 주소창의 팝업 차단 아이콘에서 이 사이트를 허용한 뒤 다시 눌러 주십시오.'), 'error');
        return;
      }
      const askScreen = needScreenAccess === true && at;
      needScreenAccess = false;
      if (group === 'main') await closeTab(tab.id, { keep: true });
      else await closeTabIn(groups[group], tab.id, { keep: true });
      if (info.type === 'pty') watchPopup(win, info);
      if (askScreen) toast(t('놓은 모니터에 띄우려면 창 관리 권한이 필요합니다.'), 'info', { label: t('허용하고 옮기기'), onClick: () => moveToScreen(win, at, width, height) }, 8000);
      else toast(t('새 창으로 띄웠습니다. 원하는 모니터로 옮겨 쓰십시오.'), 'success', 2200);
    }
    // If the popup closed but the Terminal did not come back (the window was simply closed), return it to a tab in this window as long as the shell is alive
    function watchPopup(win, info) {
      const timer = setInterval(async () => {
        if (!win.closed) return;
        clearInterval(timer);
        if (ptys.has(info.id)) return;
        try {
          const alive = (await window.UnivDashPty.list()).find((t) => t.id === info.id && t.alive);
          if (!alive || ptys.has(info.id)) return;
          addPty(alive);
          renderBar();
          toast(t('새 창을 닫아서 Terminal 을 이 창 탭으로 돌려놨습니다.'), 'info', 2600);
        } catch (e) { /* noop */ }
      }, 1200);
    }
    function adoptTabs(list) {
      let last = null;
      for (const info of list || []) {
        if (info?.type === 'term' && byKey().has(info.key)) { workspace.select(info.key, { pushHistory: false }); last = info; }
        else if (info?.type === 'pty' && typeof info.id === 'string') { addPty({ id: info.id, cwd: info.cwd || '', alive: true }); showPty(info.id); last = info; }
        else if (info?.type === 'file' && typeof info.path === 'string') { openFile({ path: info.path, name: info.name, ext: info.ext, type: 'file' }); last = info; }
      }
      if (last) { renderBar(); window.focus(); }
    }
    if (!SOLO) {
      // 'Back to main window' from a popup: to the opener window if there is one, otherwise (main window reloaded, etc.) to the open main windows
      window.addEventListener('message', (event) => {
        if (event.origin !== location.origin || event.data?.type !== 'univdash-solo-return') return;
        adoptTabs(event.data.tabs);
      });
      if ('BroadcastChannel' in window) {
        const channel = new BroadcastChannel(SOLO_CHANNEL);
        channel.addEventListener('message', (event) => { if (event.data?.type === 'univdash-solo-return' && document.visibilityState !== 'hidden') adoptTabs(event.data.tabs); });
      }
    }
    // ── The popup (solo) window side ──
    let soloSeen = false;
    function soloBarHtml() {
      return `<button type="button" class="wt-solo-return" data-solo-return title="${t('이 창의 탭을 메인 창으로 돌려놓고 닫기')}"><i class="fas fa-arrow-right-to-bracket fa-flip-horizontal"></i><span>${t('메인 창으로')}</span></button>`;
    }
    function soloSync(tabs, active) {
      const all = currentTabs();
      if (all.length) soloSeen = true;
      const name = all.find((t) => t.id === active) || all[0];
      if (name) document.title = `${name.type === 'term' ? displayName(name.w) : name.type === 'pty' ? ptyName(name.p) : name.tab.name} — UnivDash`;
      // Closing the last tab closes the window too
      if (soloSeen && !workspace.termTabs.list().length && !ptys.size && !(viewer?.tabs || []).length) window.close();
    }
    function returnToMain() {
      const tabs = [...currentTabs(), ...Object.values(groups).flatMap((g) => tabsOf(g))];
      if (tabs.some((t) => t.type === 'file' && t.tab?.dirty)) { toast(t('저장하지 않은 변경이 있습니다. 저장한 뒤 돌려놓아 주십시오.'), 'error'); return; }
      const message = { type: 'univdash-solo-return', tabs: [...new Map(tabs.map((t) => [t.id.replace(/^sfile:/, 'file:'), tabInfo(t)])).values()] };
      let sent = false;
      try { if (window.opener && !window.opener.closed) { window.opener.postMessage(message, location.origin); sent = true; } } catch (e) { /* noop */ }
      if (!sent && 'BroadcastChannel' in window) { const channel = new BroadcastChannel(SOLO_CHANNEL); channel.postMessage(message); channel.close(); }
      ptys.forEach((p) => p.client?.dispose());   // the shell is not ended (the main window attaches next)
      ptys.clear();
      setTimeout(() => window.close(), 60);
    }

    // ── Tab drag and drop: inside a tab bar it reorders · moves between groups; dragged over the screen it shows drop zones (edge = split that group in half) ──
    let dragTab = null;       // { id, group }
    let dropTarget = null;    // { group, zone, r }
    const zonesEl = $('#dropZones');
    const highlight = zonesEl?.querySelector('.dz-highlight');
    function contentRect(group) {
      const pane = group === 'main' ? $('#termPane') : groups[group]?.el;
      if (!pane || pane.classList.contains('hidden')) return null;
      const r = pane.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const tabbar = group === 'main' ? bar : pane.querySelector('.side-bar');
      const top = tabbar && !tabbar.classList.contains('hidden') && tabbar.offsetParent ? tabbar.getBoundingClientRect().bottom : r.top;
      return { left: r.left, top, right: r.right, bottom: r.bottom, width: r.width, height: r.bottom - top };
    }
    function zoneAt(x, y) {
      for (const group of isSplit() ? layoutIds() : ['main']) {
        const r = contentRect(group);
        if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        const fx = (x - r.left) / r.width;
        const fy = (y - r.top) / r.height;
        const edges = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]].sort((a, b) => a[1] - b[1]);
        const [edge, dist] = edges[0];
        const zone = dist < 0.28 && canSplit(group, edge) && layoutIds().length < 4 ? edge : 'center';
        return { group, zone, r };
      }
      return null;
    }
    function showZone(target) {
      if (!highlight) return;
      if (!target || target.zone === 'pty' || (dragTab && target.zone === 'center' && target.group === dragTab.group)) { highlight.style.opacity = '0'; return; }
      const area = editorArea.getBoundingClientRect();
      const { r, zone } = target;
      let [left, top, width, height] = [r.left, r.top, r.width, r.height];
      if (zone === 'left') width /= 2;
      if (zone === 'right') { left += width / 2; width /= 2; }
      if (zone === 'top') height /= 2;
      if (zone === 'bottom') { top += height / 2; height /= 2; }
      Object.assign(highlight.style, { opacity: '1', left: `${left - area.left}px`, top: `${top - area.top}px`, width: `${width}px`, height: `${height}px` });
    }
    // Drag a file from the explorer to open it · open it in a split
    let dragFile = null;
    const hideZones = () => { zonesEl?.classList.add('hidden'); if (highlight) highlight.style.opacity = '0'; dropTarget = null; };
    document.addEventListener('dragstart', (event) => {
      const row = event.target.closest?.('#wsExplorer .ex-row[draggable="true"]');
      if (!row || row.dataset.type !== 'file' || !desktopQuery.matches) return;
      dragFile = { path: row.dataset.path };
      zonesEl?.classList.remove('hidden');
    });
    document.addEventListener('dragend', () => { if (dragFile || dragWin) { dragFile = null; dragWin = null; hideZones(); } });
    // Drag a tmux session from the window list to open it · open it in a split
    let dragWin = null;
    document.addEventListener('dragstart', (event) => {
      const item = event.target.closest?.('#windowList .win-item[draggable="true"]');
      if (!item || !desktopQuery.matches) return;
      dragWin = { key: item.dataset.key };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-univdash-window', item.dataset.key);
      zonesEl?.classList.remove('hidden');
    });
    // Open a session in a given group: if it is already open in another group, move that tab
    async function openWindowIn(group, key) {
      const id = termId(key);
      const from = mainTabs().some((t) => t.id === id) ? 'main' : Object.values(groups).find((g) => g.items.includes(id))?.id;
      if (from && from !== group) { await moveTab(findTab(from, id), from, group); return; }
      if (group === 'main' || !groups[group]) { workspace.select(key, { pushHistory: false }); focusGroup = 'main'; return; }
      const g = groups[group];
      if (!g.items.includes(id)) g.items.push(id);
      g.active = id;
      g.shown = null;
      saveLayout();
      renderGroups();
      renderBar();
    }
    // Clicking a session in the list while split: if a split pane already has it open, go to that pane;
    // if it is open nowhere, open it in the currently focused split pane (like VS Code). false means open in main as usual.
    function openFromList(key) {
      if (!isSplit()) return false;
      const id = termId(key);
      if (mainTabs().some((t) => t.id === id)) return false;
      const g = Object.values(groups).find((x) => x.items.includes(id));
      if (g) { showIn(g, id); renderBar(); return true; }
      if (focusGroup !== 'main' && groups[focusGroup]) { openWindowIn(focusGroup, key); return true; }
      return false;
    }
    function isVisibleTerm(key) {
      if (!isSplit()) return false;
      return Object.values(groups).some((g) => g.active === termId(key)
        && g.shown === g.active && g.mirror?.key === key
        && g.el.isConnected && !g.el.classList.contains('hidden'));
    }
    window.UnivDashWs = { ...(window.UnivDashWs || {}), openFromList, isVisibleTerm };
    document.addEventListener('drop', async (event) => {
      if (dragWin) {
        const target = dropTarget;
        const { key } = dragWin;
        dragWin = null;
        hideZones();
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (target.zone === 'center') await openWindowIn(target.group, key);
        else await whileMoving(async () => { const id = makeGroupAt(target.group, target.zone); await openWindowIn(id || target.group, key); });
        return;
      }
      if (!dragFile) return;
      const target = dropTarget;
      const { path } = dragFile;
      dragFile = null;
      hideZones();
      if (!target) return;                 // input fields etc.: default behaviour (insert the path as text)
      event.preventDefault();
      event.stopPropagation();
      if (target.zone === 'pty') {
        // Insert the path into that Terminal (quoted if it has spaces · special characters)
        const client = [...ptys.values()].map((p) => p.client).find((c) => c?.el?.contains(target.xterm));
        const quoted = /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
        client?.sendKeys(`${quoted} `);
        return;
      }
      const name = path.split('/').pop();
      const dot = name.lastIndexOf('.');
      const entry = { path, name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '', type: 'file' };
      if (target.zone === 'center') openFileIn(target.group, entry);
      else { const id = makeGroupAt(target.group, target.zone); openFileIn(id || target.group, entry); }
    }, true);
    document.addEventListener('dragover', (event) => {
      if (!dragTab && !dragFile && !dragWin) return;
      // Over the prompt input, drop zones are turned off so the path can be inserted as text
      if (dragFile && event.target.closest?.('input, textarea')) { dropTarget = null; showZone(null); return; }
      let target = zoneAt(event.clientX, event.clientY);
      // Dropping on a tab bar opens it as a tab in that pane (like VS Code)
      const tabBar = (dragFile || dragWin) && event.target.closest?.('#wsTabs, .side-pane .ws-tabbar');
      if (tabBar) {
        const group = tabBar.id === 'wsTabs' ? 'main' : tabBar.closest('[data-group]')?.dataset.group;
        const r = group && contentRect(group);
        if (r) target = { group, zone: 'center', r };
      }
      // Over a Terminal: an edge splits, the centre inserts the path as text into that Terminal (without a highlight)
      const xterm = dragFile && event.target.closest?.('.xterm');
      if (xterm && target && target.zone === 'center') target = { ...target, zone: 'pty', xterm };
      dropTarget = target;
      showZone(target);
      if (target) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; }
    });
    async function finishDrop() {
      const target = dropTarget;
      const drag = dragTab;
      dragTab = null;
      dropTarget = null;
      zonesEl?.classList.add('hidden');
      if (highlight) highlight.style.opacity = '0';
      if (!drag || !target) return false;
      const tab = findTab(drag.group, drag.id);
      if (!tab) return false;
      if (target.zone === 'center') { if (target.group !== drag.group) await moveTab(tab, drag.group, target.group); }
      else await splitWith(tab, drag.group, target.group, target.zone);
      return true;
    }
    function sortableFor(el, group) {
      return new window.Sortable(el, {
        group: 'ws-tabs', draggable: '.wt', direction: 'horizontal', animation: 150, delay: 250, delayOnTouchOnly: true,
        filter: '.wt-close', preventOnFilter: false,
        // Carry the tab info along so it can be dropped on another window (popup ↔ main)
        setData: (dataTransfer, dragEl) => {
          const tab = findTab(group, dragEl.dataset.id);
          if (!tab) return;
          const payload = { from: WIN_ID, srcId: tab.id, group, info: tabInfo(tab), dirty: !!(tab.type === 'file' && tab.tab?.dirty) };
          dataTransfer.setData(XTAB, JSON.stringify(payload));
          dataTransfer.effectAllowed = 'move';
        },
        onStart: (event) => {
          dragTab = { id: event.item.dataset.id, group };
          if (desktopQuery.matches) zonesEl?.classList.remove('hidden');
        },
        onEnd: async (event) => {
          if (await finishDrop()) { renderBar(); renderGroups(); return; }   // if dropped on the screen, redraw the tab bars from state
          const groupOf = (barEl) => (barEl === bar ? 'main' : barEl.closest('[data-group]')?.dataset.group);
          const from = groupOf(event.from);
          const to = groupOf(event.to);
          if (from && to && from !== to) {
            const tab = findTab(from, event.item.dataset.id);
            renderBar(); renderGroups();
            await moveTab(tab, from, to);
            return;
          }
          if (to === 'main') { tabOrder = [...bar.querySelectorAll('.wt')].map((x) => x.dataset.id); store.set('ws-tab-order', tabOrder); }
          else if (groups[to]) { groups[to].items = [...groups[to].bar.querySelectorAll('.wt')].map((x) => x.dataset.id); saveLayout(); }
        },
      });
    }
    // ── Moving tabs between windows: main window ↔ a popped-out (popup) window, by dragging a tab onto the other window ──
    // The receiving window opens the tab and tells the original window it was 'taken', which closes the tab there (tmux · Terminal stay alive on the server).
    const XTAB = 'application/x-univdash-tab';
    const WIN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const tabChannel = 'BroadcastChannel' in window ? new BroadcastChannel('univdash-tabs') : null;
    const crossDrag = (event) => !dragTab && !dragFile && !dragWin && [...(event.dataTransfer?.types || [])].includes(XTAB);
    let xdropBefore = null;   // drop position: before this tab (null means at the very end)
    function clearXdrop() {
      document.body.classList.remove('xtab-over');
      bar?.querySelectorAll('.xdrop-before, .xdrop-after').forEach((el) => el.classList.remove('xdrop-before', 'xdrop-after'));
      xdropBefore = null;
    }
    document.addEventListener('dragover', (event) => {
      if (!crossDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      document.body.classList.add('xtab-over');
      bar?.querySelectorAll('.xdrop-before, .xdrop-after').forEach((el) => el.classList.remove('xdrop-before', 'xdrop-after'));
      const tabs = bar ? [...bar.querySelectorAll('.wt')] : [];
      const overBar = bar && event.target.closest?.('#wsTabs');
      const at = overBar ? tabs.find((el) => { const r = el.getBoundingClientRect(); return event.clientX < r.left + r.width / 2; }) : null;
      xdropBefore = at?.dataset.id || null;
      if (at) at.classList.add('xdrop-before');
      else tabs[tabs.length - 1]?.classList.add('xdrop-after');
    });
    document.addEventListener('dragleave', (event) => { if (crossDrag(event) && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight)) clearXdrop(); });
    document.addEventListener('drop', (event) => {
      if (!crossDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const before = xdropBefore;
      clearXdrop();
      let payload = null;
      try { payload = JSON.parse(event.dataTransfer.getData(XTAB)); } catch (e) { payload = null; }
      const info = payload?.info;
      if (!info || payload.from === WIN_ID) return;
      if (payload.dirty) { toast(t('저장하지 않은 변경이 있습니다. 저장한 뒤 옮겨 주십시오.'), 'error'); return; }
      const id = info.type === 'term' ? termId(info.key) : info.type === 'pty' ? ptyId(info.id) : fileId(info.path);
      if (info.type === 'term' && !byKey().has(info.key)) { toast(t('이 창에서 찾을 수 없는 tmux 세션입니다.'), 'error'); return; }
      adoptTabs([info]);
      tabChannel?.postMessage({ type: 'tab-taken', from: payload.from, srcId: payload.srcId, group: payload.group });
      // Put it in the order of the drop position (file tabs take a moment to open)
      let tries = 0;
      const place = () => {
        if (!currentTabs().some((t) => t.id === id)) { if (++tries < 30) setTimeout(place, 100); return; }
        const order = orderedTabs().map((t) => t.id).filter((x) => x !== id);
        const k = before ? order.indexOf(before) : -1;
        order.splice(k < 0 ? order.length : k, 0, id);
        tabOrder = order;
        store.set('ws-tab-order', tabOrder);
        renderBar();
      };
      place();
    }, true);
    window.addEventListener('dragend', clearXdrop);
    // When the dragged tab leaves the window, clear this window's drop zone (split indicator) → so dropping on another window does not split this one
    document.addEventListener('dragleave', (event) => {
      if (!dragTab) return;
      const { clientX: x, clientY: y } = event;
      if (x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight) { dropTarget = null; showZone(null); }
    });
    // Dropping a tab outside the window (desktop · over another program) pops it out as a new window at that spot.
    // If another UnivDash window received it, that window sends 'tab-taken', so we wait briefly and pop out only when nobody took it.
    let outside = false;       // whether the dragged tab last went outside the window
    let pendingPop = null;
    document.addEventListener('dragover', () => { if (dragTab) outside = false; }, true);
    // Browsers rarely fill relatedTarget on drag events, so check whether the coordinates went beyond the window edges
    const offWindow = (e) => e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
    document.addEventListener('dragleave', (event) => { if (dragTab && offWindow(event)) outside = true; }, true);
    document.addEventListener('dragend', (event) => {
      const drag = dragTab;
      const at = event.screenX || event.screenY ? { x: event.screenX, y: event.screenY } : null;
      // Whether it left the window: what dragleave saw + whether the drop screen coordinates are outside this window
      // (when crossing to another monitor, dragleave coordinates sometimes come as values inside the window, so check both)
      const offScreen = !!at && (at.x < window.screenX || at.y < window.screenY
        || at.x >= window.screenX + window.outerWidth || at.y >= window.screenY + window.outerHeight);
      const left = outside || offScreen;
      outside = false;
      if (!drag || !left || !desktopQuery.matches || event.dataTransfer?.dropEffect === 'move') return;
      clearTimeout(pendingPop?.timer);
      pendingPop = { id: drag.id, timer: setTimeout(() => {
        pendingPop = null;
        const tab = findTab(drag.group, drag.id);
        if (tab) popOut(tab, drag.group, { at });
      }, 250) };
    }, true);
    tabChannel?.addEventListener('message', async (event) => {
      const msg = event.data;
      if (msg?.type !== 'tab-taken' || msg.from !== WIN_ID) return;
      if (pendingPop?.id === msg.srcId) { clearTimeout(pendingPop.timer); pendingPop = null; }
      const group = msg.group === 'main' || groups[msg.group] ? msg.group : 'main';
      if (!findTab(group, msg.srcId)) return;
      if (group === 'main') await closeTab(msg.srcId, { keep: true });
      else await closeTabIn(groups[group], msg.srcId, { keep: true });
      renderBar(); renderGroups();
    });
    window.addEventListener('DOMContentLoaded', () => {
      if (!window.Sortable) return;
      if (bar) sortableFor(bar, 'main');
      Object.values(groups).forEach((g) => sortableFor(g.bar, g.id));
    });

    // ── tmux window of a split group: same header as main (Chat | Terminal · usage) · chat · screen · model · input (each group has its own WebSocket) ──
    function ensureMirror(g) {
      if (g.mirror) return g.mirror;
      const R = workspace.renderers;
      const root = g.el.querySelector('.g-mirror');
      root.innerHTML = `
        <div class="tp-head">
          <div class="tp-row1">
            <span class="status-dot tp-dot"></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 min-w-0"><h3 class="tp-title truncate"></h3><span class="agent-pill tp-agent hidden"></span></div>
              <p class="tp-sub truncate"></p>
            </div>
            <button type="button" class="side-bar-btn" data-mirror-main title="${t('메인 그룹으로 옮기기')}" aria-label="${t('메인 그룹으로')}"><i class="fas fa-up-right-and-down-left-from-center"></i></button>
          </div>
          <div class="tp-row2">
            <div class="mode-switch tp-modes hidden" role="tablist"><button type="button" data-tpmode="log"><i class="fas fa-comments"></i> ${t('채팅')}</button><button type="button" data-tpmode="screen"><i class="fas fa-terminal"></i> ${t('터미널')}</button></div>
            <div class="usage-mini tp-usage hidden ml-auto"></div>
          </div>
        </div>
        <div class="tp-body">
          <div class="tp-log terminal hidden"><div class="chat-list tp-list"></div><div class="chat-status tp-status hidden"></div></div>
          <div class="tp-screen terminal"><div class="term-screen wrap"><div class="term-inner"></div></div></div>
        </div>
        <div class="tp-composer composer glass border-0 border-t border-white/10 flex-shrink-0 safe-bottom">
          <div class="keybar tp-keys flex gap-1.5 overflow-x-auto no-scrollbar px-2 md:px-3 pt-2">
            ${[['Escape', 'Esc', 'key-accent'], ['BTab', '⇧Tab'], ['Up', '↑'], ['Down', '↓'], ['Enter', '⏎'], ['#1', '1'], ['#2', '2'], ['#3', '3'], ['C-c', '^C', 'key-danger'], ['Tab', 'Tab'], ['Left', '←'], ['Right', '→'], ['#y', 'y'], ['#n', 'n'], ['#/', '/'], ['BSpace', '⌫'], ['Space', 'Space'], ['PageUp', 'PgUp'], ['PageDown', 'PgDn'], ['C-o', '^O'], ['C-r', '^R'], ['C-l', '^L'], ['C-d', '^D'], ['C-z', '^Z']]
              .map(([k, label, cls = '']) => `<button type="button" class="key-chip ${cls}" data-mk="${k}">${label}</button>`).join('')}
          </div>
          <div class="attach-tray tp-tray hidden gap-2 overflow-x-auto no-scrollbar px-2 md:px-3 pt-2"></div>
          <form class="tp-form flex items-end gap-2 p-2 md:p-3" autocomplete="off">
            <button type="button" class="model-chip tp-model hidden" title="${t('모델 바꾸기')}"><i class="fas fa-microchip"></i><span>—</span></button>
            <div class="relative flex-1 min-w-0">
              <textarea rows="1" enterkeyhint="send" placeholder="${t('프롬프트 입력')}" spellcheck="false" autocapitalize="off" class="prompt-input w-full glass-input rounded-2xl pl-4 pr-11 py-2.5 text-white placeholder-white/30 resize-none"></textarea>
              <button type="button" class="attach-btn" data-tp-attach title="${t('사진 · 파일 첨부')}" aria-label="${t('첨부')}"><i class="fas fa-paperclip"></i></button>
              <input type="file" multiple class="hidden tp-file" tabindex="-1" aria-hidden="true">
              <div class="tp-direct-banner hidden"><i class="fas fa-keyboard"></i> ${t('직접 입력 중 · 누르는 키가 바로 터미널로 전달됩니다')}</div>
            </div>
            <button type="button" class="composer-btn" data-tp-direct title="${t('터미널 직접 입력 모드')}" aria-pressed="false"><i class="fas fa-keyboard text-sm"></i></button>
            <button type="submit" class="send-btn btn-glow" aria-label="${t('보내기')}"><i class="fas fa-paper-plane text-sm"></i></button>
          </form>
          <div class="flex items-center justify-between gap-2 px-3 md:px-4 pb-2 -mt-1 text-[10px] text-white/40">
            <div class="flex items-center gap-1 min-w-0">
              <button type="button" class="submit-toggle" data-tp-keybar></button>
              <button type="button" class="submit-toggle qs-btn" data-tp-snippet title="${t('최근 보낸 프롬프트 · 빠른 문구')}" aria-label="${t('히스토리')}">${t('히스토리')}</button>
              <button type="button" class="submit-toggle qs-btn hidden" data-tp-update title="${t('에이전트를 업데이트하고 같은 대화로 다시 켜기')}" aria-label="${t('업데이트')}">${t('업데이트')}</button>
              <button type="button" class="submit-toggle qs-btn hidden" data-tp-switch title="${t('지금 에이전트를 끄고 다른 에이전트(Claude · Codex · Gemini)를 선택해 켜기')}">${t('에이전트 바꾸기')}</button>
            </div>
            <div class="flex items-center gap-1 min-w-0">
              <span class="truncate hidden sm:inline">${t('Enter 전송 · Shift+Enter 줄바꿈')}</span>
              <button type="button" class="hist-btn" data-tp-hist="1" title="${t('이전 프롬프트 (↑)')}"><i class="fas fa-chevron-up"></i></button>
              <button type="button" class="hist-btn" data-tp-hist="-1" title="${t('다음 프롬프트 (↓)')}"><i class="fas fa-chevron-down"></i></button>
            </div>
          </div>
        </div>
        </div>`;
      const $$in = (sel) => root.querySelector(sel);
      const logEl = $$in('.tp-log');
      window.UnivDashRouteChatWheel?.(logEl);   // split-view chat too: vertical wheel scrolls the whole chat, only horizontal scrolls a card
      const listEl = $$in('.tp-list');
      const statusEl = $$in('.tp-status');
      const screenEl = $$in('.tp-screen');
      const innerEl = $$in('.term-inner');
      const input = $$in('textarea');
      const modelEl = $$in('.tp-model');
      let ws = null;
      let pane = null;
      let w = null;
      let disposed = false;
      let lastScreen = null;
      let stick = true;
      let logStick = true;
      const chat = { items: new Map(), total: 0, available: false, agent: null, submitted: [], queued: [] };
      const model = { id: null };
      let modelRequest = 0;
      const modes = store.get('tp-modes', {});
      const modeOf = () => (w?.agent ? (modes[w.key] || 'log') : 'screen');
      const KEYS = { Esc: 'Escape', '⇧Tab': 'BTab', '↑': 'Up', '↓': 'Down', '⏎': 'Enter', '^C': 'C-c' };
      const send = (message) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
      function connect() {
        const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        ws = sock;
        lastRecv = Date.now();
        pingAt = 0;
        ws.onopen = () => { if (pane) { send({ t: 'sub', pane, history: 300 }); if (modeOf() === 'log' && (chat.available || w?.agent)) send({ t: 'logsub', pane, since: chat.total }); } };
        ws.onmessage = (event) => {
          lastRecv = Date.now();
          let message;
          try { message = JSON.parse(event.data); } catch (e) { return; }
          if (message.pane !== pane) return;
          if (message.t === 'screen') { const first = !lastScreen; lastScreen = message; if (first) fitTmux(true); if (modeOf() === 'screen') renderScreen(); else renderStatus(); }
          else if (message.t === 'log') applyLog(message);
        };
        ws.onclose = () => { if (ws === sock && pane && !disposed) setTimeout(() => { if (ws === sock && pane && !disposed) connect(); }, 1500); };
      }
      // Detect a silently dead connection (same rule as the main connection): ping when quiet, reconnect when there is no answer
      let lastRecv = 0;
      let pingAt = 0;
      const aliveTimer = setInterval(() => {
        if (disposed) { clearInterval(aliveTimer); return; }
        if (!pane || ws?.readyState !== WebSocket.OPEN || document.visibilityState !== 'visible') return;
        const now = Date.now();
        if (pingAt && lastRecv < pingAt) {
          if (now - pingAt < 4000) return;
          const dead = ws;
          ws = null;
          try { dead.close(); } catch (e) { /* already closed */ }
          connect();
          return;
        }
        pingAt = 0;
        if (now - lastRecv > 5000) { pingAt = now; send({ t: 'ping' }); }
      }, 2000);
      // Terminal screen
      function renderScreen() {
        if (!lastScreen) return;
        const screen = lastScreen;
        const lines = screen.content.split('\n');
        const visibleStart = Math.max(0, lines.length - screen.height);
        const cursorLine = screen.cursor.visible && !screen.in_mode ? visibleStart + screen.cursor.y : -1;
        let end = lines.length - 1;
        while (end > cursorLine && end >= 0 && !plainText(lines[end]).trim()) end--;
        const st = { fg: null, bg: null, b: false, d: false, i: false, u: false, inv: false, s: false };
        let html = '';
        for (let i = 0; i <= end; i++) html += `<div class="ln">${renderLine(lines[i], st, { cursorCol: i === cursorLine ? screen.cursor.x : null, collapseSpaces: i !== cursorLine }) || ' '}</div>`;
        innerEl.innerHTML = html;
        if (stick) screenEl.scrollTop = screenEl.scrollHeight;
      }
      screenEl.addEventListener('scroll', () => { stick = screenEl.scrollHeight - screenEl.scrollTop - screenEl.clientHeight < 40; }, { passive: true });
      // Fit the tmux window size to this cell (same rule as the main screen)
      let fitTimer = 0;
      let fitSent = '';
      function fitTmux(force = false) {
        clearTimeout(fitTimer);
        fitTimer = setTimeout(() => {
          if (disposed || !pane || modeOf() !== 'screen' || document.visibilityState !== 'visible') return;
          const grid = termGrid(screenEl, innerEl, 12);
          if (!grid) return;
          const signature = `${pane} ${grid.cols}x${grid.rows}`;
          if (!force && signature === fitSent) return;
          fitSent = signature;
          if (lastScreen?.pane === pane && lastScreen.width === grid.cols && lastScreen.height === grid.rows) return;
          send({ t: 'size', pane, cols: grid.cols, rows: grid.rows });
        }, 250);
      }
      new ResizeObserver(() => fitTmux()).observe(screenEl);
      document.addEventListener('visibilitychange', () => fitTmux(true));
      window.addEventListener('focus', () => fitTmux(true));
      // Chat (session log)
      // Just-sent prompts: each time a new user message appears in the log, remove them one by one from the oldest (same rule as main)
      const sent = [];
      function renderChat() {
        const items = [...chat.items.values()].sort((a, b) => a.id - b.id).slice(-200);
        if (sent.length) {
          let arrived = items.filter((item) => item.kind === 'user' && item.id > sent[0].afterId).length;
          while (sent.length && (arrived > 0 || Date.now() - sent[0].at > 10 * 60 * 1000)) { if (arrived > 0) arrived -= 1; sent.shift(); }
        }
        const queuedHtml = chat.queued.map((text) => `<div class="msg msg-user pending"><div class="msg-meta"><i class="fas fa-hourglass-half"></i> ${t('대기 중 · 작업 중에 곧 전달됩니다')}</div><div class="msg-body">${escapeHtml(text)}</div></div>`).join('');
        const pending = queuedHtml + (sent.length
          ? sent.map((e) => `<div class="msg msg-user"><div class="msg-meta">${t('나 · {time}', { time: escapeHtml(new Date(e.at).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' })) })}</div><div class="msg-body">${escapeHtml(e.text)}</div></div>`).join('')
          : chat.submitted.map((text) => `<div class="msg msg-user"><div class="msg-meta">${t('나 · 전달됨')}</div><div class="msg-body">${escapeHtml(text)}</div></div>`).join(''));
        // Items left expanded (subagents etc.) stay expanded across redraws
        const opened = new Set([...listEl.querySelectorAll(':scope > details[open][data-item]')].map((el) => el.dataset.item));
        listEl.dataset.pane = pane || '';
        listEl.innerHTML = (items.length || pending) ? items.map((item) => R.logItem(item, chat.agent)).join('') + pending : `<div class="log-empty">${t('아직 대화가 없습니다.')}</div>`;
        opened.forEach((id) => { const el = listEl.querySelector(`:scope > details[data-item="${CSS.escape(id)}"]`); if (el) el.open = true; });
        R.markFinalAnswers(listEl);
        if (logStick) logEl.scrollTop = logEl.scrollHeight;
      }
      window.addEventListener('univdash:agent-switched', (event) => {
        if (disposed || event.detail?.pane !== pane) return;
        [2500, 6000].forEach((ms) => setTimeout(() => {
          if (disposed || event.detail.pane !== pane) return;
          chat.total = 0;
          model.id = null;
          modelRequest += 1;
          if (modeOf() === 'log') loadChat();
          refreshModel();
        }, ms));
      });
      async function loadChat() {
        chat.items.clear();
        listEl.innerHTML = `<div class="log-empty"><i class="fas fa-circle-notch fa-spin"></i> ${t('채팅을 불러오는 중...')}</div>`;
        const forPane = pane;
        try {
          const data = await api('GET', `/api/transcript?pane=${encodeURIComponent(pane)}&limit=80`);
          if (forPane !== pane) return;
          chat.available = data.available;
          chat.agent = data.agent;
          if (!data.available) {
            listEl.innerHTML = `<div class="log-empty">${data.agent ? t('아직 대화가 없습니다. 첫 프롬프트를 보내면 여기에 바로 표시됩니다.') : t('이 창의 채팅(에이전트 세션 로그)을 찾지 못했습니다.')}</div>`;
            if (data.agent) send({ t: 'logsub', pane, since: 0 });   // the server tells us once a log appears
            return;
          }
          data.items.forEach((item) => chat.items.set(item.id, item));
          chat.total = data.total;
          chat.submitted = data.submitted || []; chat.queued = data.queued || [];
          logStick = true;
          renderChat();
          send({ t: 'logsub', pane, since: chat.total });
        } catch (error) { listEl.innerHTML = `<div class="log-empty">${escapeHtml(error.message)}</div>`; }
      }
      function applyLog(data) {
        if (modeOf() !== 'log') return;
        if (!chat.available || data.total < chat.total) { loadChat(); return; }
        if (data.items.length && (data.items[0].id > chat.total || data.items.at(-1).id + 1 < data.total)) { loadChat(); return; }
        data.items.forEach((item) => chat.items.set(item.id, item));
        chat.submitted = data.submitted || []; chat.queued = data.queued || [];
        (data.related || []).forEach((item) => { if (chat.items.has(item.id)) chat.items.set(item.id, item); });
        chat.total = Math.max(chat.total, data.total);
        renderChat();
      }
      // Same as the main chat: following is turned off only when the user scrolls up on purpose, and back on when scrolled to the end
      logEl.addEventListener('scroll', () => { if (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 4) logStick = true; }, { passive: true });
      logEl.addEventListener('wheel', (event) => { if (event.deltaY < 0 && !event.ctrlKey) logStick = false; }, { passive: true });
      let tpTouchY = null;
      logEl.addEventListener('touchstart', (event) => { tpTouchY = event.touches[0]?.clientY ?? null; }, { passive: true });
      logEl.addEventListener('touchmove', (event) => { const y = event.touches[0]?.clientY; if (tpTouchY !== null && y !== undefined && y - tpTouchY > 6) logStick = false; }, { passive: true });
      if ('ResizeObserver' in window) {
        new ResizeObserver(() => { if (logStick && !logEl.classList.contains('hidden')) logEl.scrollTop = logEl.scrollHeight; }).observe(listEl);
      }
      listEl.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-copy]');
        if (!button) return;
        const item = chat.items.get(Number(button.dataset.copy));
        try { await navigator.clipboard.writeText(item?.text || ''); toast(t('복사했습니다.'), 'ok', null, 1200); } catch (e) { toast(t('복사하지 못했습니다.'), 'error'); }
      });
      // Working · Needs answer card (same rule as main)
      function renderStatus() {
        if (!lastScreen || !w || modeOf() !== 'log') { statusEl.className = 'chat-status tp-status hidden'; statusEl.innerHTML = ''; return; }
        const status = R.chatStatus(lastScreen, w);
        if (!status) { statusEl.className = 'chat-status tp-status hidden'; statusEl.innerHTML = ''; return; }
        statusEl.className = `chat-status tp-status ${status.kind}`;
        const showLive = status.kind === 'busy' && status.live && R.chatLiveOpen(w.agent);
        statusEl.innerHTML = status.kind === 'busy'
          ? `<div class="chat-status-row"><i class="fas fa-circle-notch fa-spin"></i><span class="chat-status-text">${escapeHtml(status.text)}</span>
              ${status.live ? `<button type="button" class="chat-live-toggle" data-live-toggle title="${showLive ? t('실시간 출력 접기') : t('실시간 출력 펼치기')}"><i class="fas fa-chevron-${showLive ? 'down' : 'up'}"></i></button>` : ''}
              <button type="button" data-status-keys="Escape">${t('중단')}</button></div>${showLive ? `<pre class="chat-live">${escapeHtml(status.live)}</pre>` : ''}`
          : R.waitingCardHtml(status);
        const livePre = statusEl.querySelector('.chat-live');
        if (livePre) livePre.scrollTop = livePre.scrollHeight;   // go to the bottom when new text arrives
        if (logStick) logEl.scrollTop = logEl.scrollHeight;
      }
      statusEl.addEventListener('click', (event) => {
        if (event.target.closest('[data-live-toggle]')) {
          R.toggleChatLive(w?.agent);
          renderStatus();
          return;
        }
        const button = event.target.closest('[data-status-text], [data-status-keys], [data-status-move]');
        if (!button || !pane) return;
        const message = R.statusMessage(button, lastScreen ? R.chatStatus(lastScreen, w) : null, w?.agent, pane);
        if (message) send(message);
      });
      // Header · mode · usage · model
      function applyMode() {
        const mode = modeOf();
        $$in('.tp-modes').classList.toggle('hidden', !w?.agent);
        root.querySelectorAll('[data-tpmode]').forEach((b) => b.classList.toggle('on', b.dataset.tpmode === mode));
        logEl.classList.toggle('hidden', mode !== 'log');
        screenEl.classList.toggle('hidden', mode !== 'screen');
        if (mode === 'log' && direct) setDirect(false);
        $$in('[data-tp-direct]').classList.toggle('hidden', mode === 'log');   // ⌨ is hidden in chat mode
        if (mode === 'log') { if (!chat.items.size && pane) loadChat(); else send({ t: 'logsub', pane, since: chat.total }); renderStatus(); }
        else { send({ t: 'logunsub' }); renderScreen(); fitTmux(true); }
      }
      root.querySelectorAll('[data-tpmode]').forEach((b) => b.addEventListener('click', () => {
        if (!w) return;
        modes[w.key] = b.dataset.tpmode;
        store.set('tp-modes', modes);
        applyMode();
      }));
      function renderHead() {
        if (!w) return;
        $$in('.tp-dot').className = `status-dot tp-dot ${w.status}`;
        $$in('.tp-title').textContent = displayName(w);
        if (!direct) input.placeholder = promptHint();
        const pill = $$in('.tp-agent');
        pill.className = `tp-agent ${w.agent ? `agent-pill agent-${w.agent}` : 'agent-pill agent-shell'}`;   // same colours as the main header
        pill.textContent = w.agent || 'shell';
        const statusLabel = STATUS[w.status]?.label || '';
        $$in('.tp-sub').textContent = [statusLabel, windowNote(w), w.path].filter(Boolean).join(' · ');
        const usage = $$in('.tp-usage');
        const html = R.usageMarkup(w.agent);
        usage.classList.toggle('hidden', !html);
        if (html) usage.innerHTML = html;
        modelEl.classList.toggle('hidden', !w.agent);
        $$in('[data-tp-update]').classList.toggle('hidden', !w.agent);
        const switchBtn = $$in('[data-tp-switch]');
        switchBtn.classList.toggle('hidden', !w.agent);
        if (w.agent) switchBtn.textContent = t('에이전트 바꾸기');
        modelEl.querySelector('span').textContent = R.prettyModel(model.id);
      }
      async function refreshModel() {
        if (!pane || !w?.agent) return;
        const request = ++modelRequest;
        const targetPane = pane;
        const targetAgent = w.agent;
        try {
          const data = await api('GET', `/api/agent/model?pane=${encodeURIComponent(targetPane)}`);
          if (disposed || request !== modelRequest || pane !== targetPane || w?.agent !== targetAgent) return;
          model.id = data.model;
          renderHead();
        } catch (e) { /* noop */ }
      }
      const modelTimer = setInterval(() => { if (!disposed && pane && document.visibilityState === 'visible') refreshModel(); }, 2000);
      const usageTimer = setInterval(() => { if (!disposed && pane && document.visibilityState === 'visible') R.refreshLimits().then(renderHead); }, 15000);
      const accountChanged = () => { renderHead(); R.refreshLimits().then(renderHead); };
      window.addEventListener('univdash:codex-account-changed', accountChanged);
      modelEl.addEventListener('click', async () => {
        if (!w?.agent || !pane) return;
        if (w.status === 'busy') { toast(t('지금 작업 중입니다. 끝난 뒤에 모델을 바꿀 수 있습니다.'), 'warn'); return; }
        const before = model.id;
        const watch = () => R.watchModelChange(refreshModel, () => disposed || model.id !== before);
        if (w.agent === 'gemini') { R.pickGeminiModel(pane, async (message) => send(message), watch); return; }
        await R.sendSlash(pane, w.agent, '/model', async (message) => send(message));
        watch();
      });
      // ── Input (same make-up as the main input: special keys · quick phrases · model · attachments · direct input · auto submit · key folding · previous prompts) ──
      const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
      const submit = true;
      let direct = false;
      const history = { index: -1, stash: '' };
      const attachments = [];
      const tray = $$in('.tp-tray');
      function syncToggles() {
        const collapsed = store.get('keybar-folded', true);
        $$in('.tp-keys').classList.toggle('hidden', collapsed);
        $$in('[data-tp-keybar]').innerHTML = collapsed ? `<i class="fas fa-chevron-up"></i> ${t('키 펼치기')}` : `<i class="fas fa-chevron-down"></i> ${t('키 접기')}`;
      }
      syncToggles();

      $$in('[data-tp-keybar]').addEventListener('click', () => { store.set('keybar-folded', !store.get('keybar-folded', true)); syncToggles(); });
      function recall(delta) {
        const list = store.get('recent', []);
        if (!list.length) return;
        if (history.index === -1) history.stash = input.value;
        const next = Math.max(-1, Math.min(list.length - 1, history.index + delta));
        if (next === history.index) return;
        history.index = next;
        input.value = next === -1 ? history.stash : list[next];
        autosize();
      }
      root.querySelectorAll('[data-tp-hist]').forEach((b) => {
        b.addEventListener('pointerdown', (event) => event.preventDefault());
        b.addEventListener('click', () => recall(Number(b.dataset.tpHist)));
      });
      $$in('[data-tp-switch]').addEventListener('click', () => pickAgentSwitch(w));
      $$in('[data-tp-update]').addEventListener('click', () => R.restartAgent({ pane, agent: w?.agent, busy: w?.status === 'busy', window: w }));
      $$in('[data-tp-snippet]').addEventListener('click', () => {
        const snippets = store.get('snippets', [t('계속 진행해줘'), t('커밋해줘'), t('테스트 돌려서 확인해줘'), '/compact', '/clear']);
        const recent = store.get('recent', []).slice(0, 20);
        const put = (text) => { input.value = input.value ? `${input.value}${input.value.endsWith('\n') ? '' : ' '}${text}` : text; autosize(); input.focus(); };
        actionSheet({
          title: t('히스토리'), subtitle: t('누르면 입력창에 넣습니다.'),
          actions: [...recent.map((text) => ({ icon: 'fa-clock-rotate-left', label: text.replace(/\s+/g, ' ').slice(0, 80), onClick: () => put(text) })), ...(recent.length ? ['sep'] : []), ...snippets.map((text) => ({ icon: 'fa-bolt', label: text, onClick: () => put(text) }))],
        });
      });
      // Attachments: uploaded ahead and sent along with the prompt (same /api/uploads as main)
      function renderTray() {
        tray.classList.toggle('hidden', !attachments.length);
        tray.classList.toggle('flex', attachments.length > 0);
        tray.innerHTML = attachments.map((a, i) => `<span class="attach-chip ${a.status}"><i class="fas ${a.status === 'error' ? 'fa-triangle-exclamation' : a.status === 'done' ? 'fa-paperclip' : 'fa-circle-notch fa-spin'}"></i><span class="truncate max-w-[140px]">${escapeHtml(a.name)}</span><button type="button" data-tp-unattach="${i}" aria-label="${t('빼기')}"><i class="fas fa-xmark"></i></button></span>`).join('');
      }
      function addFiles(files) {
        for (const file of files) {
          const item = { name: file.name, status: 'uploading', id: null };
          attachments.push(item);
          item.promise = window.UnivDash.uploadFile(file, { kind: 'attach' }).promise
            .then((data) => { Object.assign(item, { status: 'done', id: data.id }); }, (error) => { item.status = 'error'; if (error.status) toast(`${file.name}: ${error.message}`, 'error'); })
            .finally(renderTray);
        }
        renderTray();
      }
      $$in('[data-tp-attach]').addEventListener('click', () => $$in('.tp-file').click());
      $$in('.tp-file').addEventListener('change', (event) => { addFiles([...event.target.files]); event.target.value = ''; });
      tray.addEventListener('click', (event) => {
        const b = event.target.closest('[data-tp-unattach]');
        if (b) { attachments.splice(Number(b.dataset.tpUnattach), 1); renderTray(); }
      });
      input.addEventListener('paste', (event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.length) { event.preventDefault(); addFiles(files); }
      });
      // Direct input mode: pressed keys go straight to the terminal
      const DIRECT_KEYS = { Enter: 'Enter', Backspace: 'BSpace', Tab: 'Tab', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Delete: 'DC', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
      const promptHint = () => promptPlaceholder(w);
      function setDirect(on) {
        direct = on;
        $$in('[data-tp-direct]').setAttribute('aria-pressed', String(on));
        $$in('[data-tp-direct]').classList.toggle('active', on);
        $$in('.tp-direct-banner').classList.toggle('hidden', !on);
        input.placeholder = on ? t('직접 입력 중 (Esc 두 번이면 해제)') : promptHint();
        if (on) { input.value = ''; autosize(); input.focus(); }
      }
      $$in('[data-tp-direct]').addEventListener('click', () => setDirect(!direct));
      input.addEventListener('compositionend', (event) => { if (direct && event.data) { send({ t: 'text', pane, text: event.data }); input.value = ''; } });
      input.addEventListener('input', (event) => {
        history.index = -1;
        autosize();
        if (direct && !event.isComposing && event.inputType?.startsWith('insert') && input.value) { send({ t: 'text', pane, text: input.value }); input.value = ''; }
      });
      input.addEventListener('keydown', (event) => {
        if (direct) {
          if (event.isComposing || event.keyCode === 229) return;
          const key = DIRECT_KEYS[event.key];
          if (event.ctrlKey && /^[a-z]$/i.test(event.key)) { event.preventDefault(); send({ t: 'keys', pane, keys: [`C-${event.key.toLowerCase()}`] }); return; }
          if (key) { event.preventDefault(); send({ t: 'keys', pane, keys: [key] }); }
          return;
        }
        if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.isComposing) {
          // Same rule as main: history only when empty, keep going while browsing history, otherwise move the cursor
          const browsing = history.index !== -1;
          if (event.key === 'ArrowUp' && (browsing || !input.value)) { event.preventDefault(); recall(1); return; }
          if (event.key === 'ArrowDown' && browsing) { event.preventDefault(); recall(-1); return; }
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && (!coarsePointer || event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          $$in('.tp-form').requestSubmit();
        }
      });
      $$in('.tp-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!pane || direct) return;
        const text = input.value;
        if (attachments.some((a) => a.status === 'uploading')) { toast(t('첨부 업로드가 끝나면 보냅니다…'), 'info'); await Promise.all(attachments.map((a) => a.promise)); }
        const ready = attachments.filter((a) => a.status === 'done').map((a) => a.id);
        if (!text.trim() && !ready.length) send({ t: 'keys', pane, keys: ['Enter'] });
        else {
          send({ t: 'prompt', pane, text, submit, attachments: ready });
          if (text.trim() && !/^\/\S/.test(text.trim()) && modeOf() === 'log') { sent.push({ text, at: Date.now(), afterId: chat.total - 1 }); logStick = true; renderChat(); }
          if (text.trim()) store.set('recent', [text, ...store.get('recent', []).filter((t) => t !== text)].slice(0, 100));   // also kept in the ↑ history
        }
        attachments.length = 0;
        renderTray();
        input.value = '';
        history.index = -1;
        autosize();
        stick = true;
        logStick = true;
      });
      const keysEl = $$in('.tp-keys');
      keysEl.addEventListener('pointerdown', (event) => { if (event.target.closest('[data-mk]')) event.preventDefault(); });
      keysEl.addEventListener('click', (event) => {
        const key = event.target.closest('[data-mk]')?.dataset.mk;
        if (!key || !pane) return;
        if (key.startsWith('#')) send({ t: 'text', pane, text: key.slice(1) }); else send({ t: 'keys', pane, keys: [key] });
        stick = true;
      });
      $$in('[data-mirror-main]').addEventListener('click', () => {
        const tab = tabsOf(g).find((t) => t.type === 'term' && t.key === g.mirror.key);
        if (tab) moveTab(tab, g.id, 'main');
      });
      g.mirror = {
        key: null,
        show(next) {
          const same = this.key === next.key;
          this.key = next.key;
          w = next;
          const nextPane = (next.panes.find((p) => next.agent && p.command === next.agent) || next.panes.find((p) => p.active) || next.panes[0])?.id || null;
          if (!same || nextPane !== pane) {
            if (pane) send({ t: 'unsub' });
            pane = nextPane;
            lastScreen = null;
            chat.items.clear();
            chat.total = 0;
            model.id = null;
            modelRequest += 1;
            innerEl.innerHTML = `<div class="ln term-empty-note">${t('화면을 불러오는 중...')}</div>`;
            stick = true;
            if (!ws || ws.readyState > 1) connect(); else send({ t: 'sub', pane, history: 300 });
            refreshModel();
            const modelPane = pane;
            R.watchModelChange(refreshModel, () => disposed || pane !== modelPane || !!model.id, 30000);
            R.refreshLimits().then(renderHead);
          }
          renderHead();
          applyMode();
          if (isWindowVisible(next.key)) markSeen(next.key, unreadActivity(next));
        },
      update(next) {
        if (next.key !== this.key) return;
        const completedPicker = w?.status === 'waiting' && next.status !== 'waiting';
        w = next;
        renderHead();
        renderStatus();
        if (isWindowVisible(next.key)) markSeen(next.key, unreadActivity(next));
        if (completedPicker) {
          const targetPane = pane;
          const before = model.id;
          R.watchModelChange(
            () => { if (pane === targetPane) refreshModel(); },
            () => disposed || pane !== targetPane || model.id !== before,
            30000,
          );
        }
      },
        stop() { this.key = null; pane = null; w = null; send({ t: 'unsub' }); send({ t: 'logunsub' }); },
        rerender() { renderScreen(); },
        dispose() { disposed = true; pane = null; clearInterval(modelTimer); clearInterval(usageTimer); window.removeEventListener('univdash:codex-account-changed', accountChanged); try { ws?.close(); } catch (e) { /* noop */ } },
      };
      return g.mirror;
    }

    // Closing the viewer in the Files tab keeps the tabs → reopen via "Open files N"
    const chip = $('#wsOpenFiles');
    function syncChip() {
      const count = viewer?.count || 0;
      chip.classList.toggle('hidden', !count || document.body.classList.contains('file-open'));
      chip.querySelector('span').textContent = t('열린 파일 {count}', { count });
    }
    chip.addEventListener('click', () => openFile(null));
    function openFile(entry) {
      if (!ensureViewer()) return;
      hidePtyView();
      showFileView(true);
      $('#termView').classList.remove('open');
      $('#termEmpty').classList.add('hidden');
      $('#termEmpty').classList.remove('lg:flex');
      if (!desktopQuery.matches && !document.body.classList.contains('term-open')) {
        document.body.classList.add('term-open');
        try { window.history.pushState({ exFile: entry?.path || 1 }, ''); } catch (e) { /* noop */ }
      }
      if (entry) viewer.open(entry);
      else viewer.restore();
    }
    function restoreRight() {
      if (state.selectedKey && byKey().get(state.selectedKey)) $('#termView').classList.add('open');
      else { $('#termEmpty').classList.remove('hidden'); $('#termEmpty').classList.add('lg:flex'); }
    }
    function closeFile(fromPopstate = false) {
      if (!document.body.classList.contains('file-open')) return;
      if (!desktopQuery.matches && !fromPopstate && window.history.state?.exFile) { window.history.back(); return; }
      showFileView(false);
      if (!desktopQuery.matches) document.body.classList.remove('term-open');
      restoreRight();
    }
    window.addEventListener('popstate', () => { if (document.body.classList.contains('file-open')) closeFile(true); });

    // Insert the path into the prompt of the currently selected window and return to the terminal
    function insertPath(path) {
      const w = workspace.currentWindow();
      if (!w) {
        window.UnivDashExplorer.copyText(path, t('먼저 창을 선택하십시오. 경로는 복사했습니다'));
        return;
      }
      const fromViewer = document.body.classList.contains('file-open');
      workspace.select(w.key, { pushHistory: true });
      if (fromViewer && !desktopQuery.matches) { try { window.history.replaceState({ tdxTerm: w.key }, '', `#${encodeURIComponent(w.key)}`); } catch (e) { /* noop */ } }
      const input = $('#promptInput');
      const text = /\s/.test(path) ? `"${path}"` : path;
      const start = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, start);
      const after = input.value.slice(input.selectionEnd ?? start);
      const pad = before && !/\s$/.test(before) ? ' ' : '';
      input.value = `${before}${pad}${text} ${after.replace(/^\s+/, '')}`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (!coarsePointer) { input.focus(); const pos = (before + pad + text).length + 1; input.setSelectionRange(pos, pos); }
      toast(t('{name} 프롬프트에 경로를 넣었습니다.', { name: displayName(w) }), 'ok');
    }

    // Path links in chat answers: a file opens as a file tab, a folder is expanded and shown in the explorer.
    // Relative paths are resolved against the working folder of that chat's tmux window (for a split pane, that pane's).
    async function openChatPath(link) {
      const raw = link.dataset.openPath;
      const group = link.closest('.side-pane[data-group]')?.dataset.group;
      const key = group ? groups[group]?.mirror?.key : workspace.currentWindow()?.key;
      const w = key ? byKey().get(key) : null;
      const pane = w && (w.panes.find((p) => p.id === state.paneId) || w.panes.find((p) => w.agent && p.command === w.agent) || w.panes[0]);
      const cwd = pane?.path || w?.path || '~';
      const path = /^(~|\/)/.test(raw) ? raw : `${cwd.replace(/\/$/, '')}/${raw}`;
      let info;
      try { info = await api('GET', `/api/fs/stat?path=${encodeURIComponent(path)}`); } catch (error) {
        // When a Korean particle got attached to a Hangul folder name and became part of the link ("…/02_<name>" + particle): retry while dropping trailing characters one at a time
        for (let cut = 1; !info && cut <= 3 && /\p{Script=Hangul}{2,}$/u.test(path.slice(0, path.length - cut + 1)); cut += 1) {
          try { info = await api('GET', `/api/fs/stat?path=${encodeURIComponent(path.slice(0, -cut))}`); } catch (e) { /* next */ }
        }
        if (!info) { toast(t('열 수 없습니다: {path} ({error})', { path: raw, error: error.message }), 'warn'); return; }
      }
      if (info.type === 'dir') { reveal(info.path); return; }
      const name = info.path.split('/').pop();
      const dot = name.lastIndexOf('.');
      openFile({ path: info.path, name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '', type: 'file', line: Number(link.dataset.line || 0) });
    }
    document.addEventListener('click', (event) => {
      const link = event.target.closest?.('.path-link[data-open-path]');
      if (!link) return;
      event.preventDefault();
      openChatPath(link);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.matches?.('.path-link[data-open-path]')) openChatPath(event.target);
    });

    // Window menu → "Show working folder files"
    function reveal(path) {
      if (document.body.classList.contains('term-open') && !desktopQuery.matches) workspace.closeTerm();
      if (desktopQuery.matches) setSide('right', false);
      setMode('files');
      ensureTree()?.reveal(path);
    }

    setMode(store.get('ws-mode', 'windows'));
    // explorer.js loads after app.js, so if the Files tab is open from the start it is attached after loading
    // ── Collapsing the left (windows) · right (files) sidebars — the state is saved and survives a reload ──
    function setSide(side, collapsed) {
      const cls = `ws-${side}-collapsed`;
      document.documentElement.classList.toggle(cls, collapsed);
      store.set(cls, collapsed);
      if (side === 'right' && !collapsed) ensureTree();
      requestAnimationFrame(() => terminal?.refit());
    }
    // The file sidebar width is adjusted by dragging, and the saved width is kept after a reload.
    const filePane = $('#filePane');
    const fileResize = $('[data-file-resize]');
    const fileWidthDefault = () => window.innerWidth >= 1280 ? 280 : 250;
    const applyFileWidth = (width, persist = false) => {
      const max = Math.max(220, Math.min(520, window.innerWidth - 640));
      const clamped = Math.round(Math.max(200, Math.min(max, width)));
      filePane.style.width = `${clamped}px`;
      filePane.style.flexBasis = `${clamped}px`;
      if (persist) store.set('ws-file-width', clamped);
      requestAnimationFrame(() => terminal?.refit());
      return clamped;
    };
    if (desktopQuery.matches) {
      const savedWidth = store.get('ws-file-width', null);
      if (Number.isFinite(savedWidth)) applyFileWidth(savedWidth);
    }
    desktopQuery.addEventListener('change', ({ matches }) => {
      if (matches) {
        const savedWidth = store.get('ws-file-width', null);
        if (Number.isFinite(savedWidth)) applyFileWidth(savedWidth);
      } else {
        filePane.style.removeProperty('width');
        filePane.style.removeProperty('flex-basis');
      }
    });
    $('[data-file-width-reset]')?.addEventListener('click', () => {
      applyFileWidth(fileWidthDefault(), true);
    });
    fileResize?.addEventListener('pointerdown', (event) => {
      if (!desktopQuery.matches || event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = filePane.getBoundingClientRect().width;
      const swapped = document.documentElement.classList.contains('ws-swapped');
      fileResize.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('ws-resizing-file-pane');
      const move = (pointer) => applyFileWidth(startWidth + (swapped ? pointer.clientX - startX : startX - pointer.clientX));
      const end = (pointer) => {
        move(pointer);
        store.set('ws-file-width', Math.round(filePane.getBoundingClientRect().width));
        document.documentElement.classList.remove('ws-resizing-file-pane');
        fileResize.removeEventListener('pointermove', move);
        fileResize.removeEventListener('pointerup', end);
        fileResize.removeEventListener('pointercancel', end);
      };
      fileResize.addEventListener('pointermove', move);
      fileResize.addEventListener('pointerup', end);
      fileResize.addEventListener('pointercancel', end);
    });
    fileResize?.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !desktopQuery.matches) return;
      event.preventDefault();
      const delta = (event.key === 'ArrowRight' ? 16 : -16) * (document.documentElement.classList.contains('ws-swapped') ? -1 : 1);
      applyFileWidth(filePane.getBoundingClientRect().width + delta, true);
    });
    // Swap the window list ↔ file sidebar sides (saved and kept after a reload)
    $$('[data-ws-swap]').forEach((button) => button.addEventListener('click', () => {
      const swapped = document.documentElement.classList.toggle('ws-swapped');
      store.set('ws-swapped', swapped);
      requestAnimationFrame(() => terminal?.refit());
    }));
    $$('[data-side-toggle]').forEach((button) => button.addEventListener('click', () => {
      const side = button.dataset.sideToggle;
      setSide(side, !document.documentElement.classList.contains(`ws-${side}-collapsed`));
    }));

    window.addEventListener('DOMContentLoaded', () => {
      // On desktop the file sidebar is always visible (unless collapsed), so attach the tree right away
      if (document.body.dataset.wsMode === 'files' || (desktopQuery.matches && !document.documentElement.classList.contains('ws-right-collapsed'))) ensureTree();
      if (!ensureViewer()) return;
      // If a file was being viewed when leaving, reopen it as it was (including tabs · scroll position)
      if (store.get('ws-file-open', false) && viewer.count && (desktopQuery.matches || !location.hash) && !store.get('ws-pty-open', false)) openFile(null);
      else syncChip();
      renderBar();
      restorePtys();
    });

    return { reveal, setMode };
  })();

  // ── Start ───────────────────────────────────────────────────────────
  socket.on('windows', (message) => {
    onWindows(message.windows);
    workspace?.onWindowsChanged();
  });
  // Report this device's state to the server (push.js uses it to pick web push targets):
  //  - keys: windows currently shown on screen → notifications for them are in-page only, no push
  //  - present: the dashboard is in use on this device → notifications go only to this device and other devices (phone etc.) stay quiet
  //    It counts as in use when the window is in front, or the dashboard is visible and was touched within PRESENT_MS.
  const PRESENT_MS = 30 * 60 * 1000;
  let lastFocus = '';
  let lastInput = Date.now();
  const reportFocus = (force = false) => {
    const visible = document.visibilityState === 'visible';
    const on = visible && document.hasFocus();
    const keys = on ? state.windows.filter((w) => isWindowVisible(w.key)).map((w) => w.key) : [];
    const present = on || (visible && Date.now() - lastInput < PRESENT_MS);
    const signature = JSON.stringify([keys, present]);
    if (!force && signature === lastFocus) return;
    lastFocus = signature;
    socket.send({ t: 'focus', device: window.UnivDash.deviceId(), keys, present });
  };
  const touched = () => { lastInput = Date.now(); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((type) => document.addEventListener(type, touched, { capture: true, passive: true }));
  socket.on('open', () => reportFocus(true));
  window.addEventListener('focus', () => { touched(); reportFocus(); });
  window.addEventListener('blur', () => reportFocus());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') touched(); reportFocus(); });
  setInterval(() => reportFocus(), 1000);  // also picks up changes in viewed windows · in-use state
  // When windows are restarted by applying a new Codex account, re-read the chat · model display being viewed
  window.addEventListener('univdash:codex-applied', () => {
    if (state.paneId) window.dispatchEvent(new CustomEvent('univdash:agent-switched', { detail: { pane: state.paneId } }));
  });
  // Open that window when a push notification is clicked
  window.addEventListener('univdash:open-window', (event) => {
    const key = event.detail?.key;
    if (workspace && state.windows.some((w) => w.key === key)) workspace.select(key);
  });
  socket.on('seen', (message) => { if (mergeSeen(message.seen)) renderAll(true); flushSeen(); });
  socket.on('open', flushSeen);

  (async () => {
    await refreshState();
    workspace?.restoreSelection();
    socket.connect();
  })();
  // Refresh the "n minutes ago" labels
  setInterval(() => renderAll(), 30000);
})();
