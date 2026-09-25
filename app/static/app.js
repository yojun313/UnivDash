// ============================================================================
// UnivDash 클라이언트
// - Workspace: 창 목록 + 터미널 화면 + 프롬프트/키 입력 (모바일 우선)
// - 창 정리: 폴더, 순서(드래그), 숨김, 표시 이름
// 서버와는 /ws 하나로 실시간 통신하고, 정리 설정만 REST(/api/preferences)로 저장한다.
// ============================================================================
(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const page = document.body.dataset.page;
  const desktopQuery = window.matchMedia('(min-width: 1024px)');
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(`univdash-${key}`); return raw === null ? fallback : JSON.parse(raw); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`univdash-${key}`, JSON.stringify(value)); } catch (e) { /* 저장 불가 환경 */ }
    },
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function timeAgo(epochSeconds) {
    if (!epochSeconds) return '';
    const diff = Math.max(0, Date.now() / 1000 - epochSeconds);
    if (diff < 45) return '방금';
    if (diff < 3600) return `${Math.round(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.round(diff / 3600)}시간 전`;
    return `${Math.round(diff / 86400)}일 전`;
  }

  // 안드로이드는 진동, 아이폰은 시스템 햅틱 (common.js · 사용자 탭 안에서만 울린다)
  const vibrate = (ms = 8) => window.UnivDash.haptic(ms);

  // ── 토스트 ──────────────────────────────────────────────────────────
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

  // ── 뷰포트: 모바일 키보드가 올라와도 입력창이 보이도록 실제 보이는 높이를 쓴다 ──────
  const isEditable = (el) => !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable
    || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file', 'range'].includes(el.type)));
  let lastViewportHeight = 0;

  function syncViewport() {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const typing = coarsePointer && isEditable(document.activeElement);
    const visible = vv ? vv.height : window.innerHeight;
    // 평소에는 앱 영역 전체(100%)를 쓴다. 키보드가 떠 있으면(입력칸 포커스 또는 보이는 영역이 줄어듦)
    // iOS 는 레이아웃 크기를 그대로 둔 채 보이는 영역만 줄이므로 그 영역에 맞춰 입력창이 키보드 위에 오게 한다.
    const keyboard = !!vv && (typing || window.innerHeight - vv.height > 80);
    root.style.setProperty('--app-h', keyboard ? `${Math.round(visible)}px` : '100%');
    root.style.setProperty('--vv-top', keyboard ? `${Math.round(vv.offsetTop)}px` : '0px');
    root.classList.toggle('kb-open', typing);
    // 문서 자체는 스크롤되지 않게 (iOS 가 입력창을 보이려고 페이지를 밀어 올리는 것 되돌리기)
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    // 키보드로 화면이 줄어들면 입력 중인 칸이 가려지지 않게 스크롤 컨테이너 안에서 보이게 한다
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

  // 휴대폰: 키보드가 떠 있는 동안 표시(탭바 숨김), 확대 제스처 · 두 번 탭 확대 막기
  if (coarsePointer) {
    // 키보드가 올라오고 내려가는 애니메이션 동안 resize 가 안 오는 경우가 있어 몇 번 다시 잰다
    const resyncSoon = () => [0, 100, 300, 600].forEach((ms) => setTimeout(syncViewport, ms));
    document.addEventListener('focusin', resyncSoon);
    document.addEventListener('focusout', resyncSoon);
    window.addEventListener('orientationchange', resyncSoon);
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => document.addEventListener(type, (event) => event.preventDefault(), { passive: false }));
    // 두 손가락 핀치만 막는다. 두 번 탭 확대는 CSS touch-action: manipulation 이 막으므로
    // 빠른 연속 탭(Esc 두 번 등)은 그대로 전달된다.
    document.addEventListener('touchmove', (event) => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
  }
  window.addEventListener('resize', syncViewport);

  // ── 사이드바 (모바일 슬라이드 + 데스크톱 접기) ─────────────────────────────
  const sidebar = $('#sidebar');
  const sidebarOverlay = $('#sidebarOverlay');
  const sidebarMenuButton = $('#sidebarMenuButton');
  const mdQuery = window.matchMedia('(min-width: 768px)');

  function setSidebarOpen(isOpen) {
    sidebar.classList.toggle('-translate-x-full', !isOpen);
    sidebarOverlay.classList.toggle('hidden', !isOpen);
    sidebarMenuButton.setAttribute('aria-expanded', String(isOpen));
  }
  if (store.get('sidebar-collapsed', false)) document.documentElement.classList.add('sidebar-collapsed');
  // 휴대폰: 상단 ☰ 로 서랍 열기 / 데스크톱: 사이드바 아래 버튼으로 아이콘만 남기고 접기
  sidebarMenuButton.addEventListener('click', () => setSidebarOpen(true));
  $('#sidebarCollapseBtn')?.addEventListener('click', () => {
    const collapsed = document.documentElement.classList.toggle('sidebar-collapsed');
    store.set('sidebar-collapsed', collapsed);
    $('#sidebarCollapseBtn').setAttribute('aria-label', collapsed ? '사이드바 펼치기' : '사이드바 접기');
    requestAnimationFrame(() => terminal?.refit());
  });
  $('#closeSidebarBtn').addEventListener('click', () => setSidebarOpen(false));
  document.querySelector('.logout-all')?.addEventListener('click', async (event) => {
    event.preventDefault();
    const button = event.currentTarget;
    const ok = await confirmSheet({ title: '모든 기기에서 로그아웃', message: '이 기기를 포함해 로그인된 모든 브라우저 · 홈 화면 앱의 세션을 끊습니다.', confirmLabel: '모두 로그아웃', danger: true });
    if (ok) button.form.requestSubmit(button);
  });
  sidebarOverlay.addEventListener('click', () => setSidebarOpen(false));
  $$('.sidebar-link').forEach((link) => link.addEventListener('click', () => { if (!mdQuery.matches) setSidebarOpen(false); }));

  // ── 시트(하단 시트 / 모달) ────────────────────────────────────────────
  const sheetOverlay = $('#sheetOverlay');
  const sheetBody = $('#sheetBody');
  let sheetOnClose = null;

  let sheetReturnFocus = null;
  function openSheet(html, onMount, onClose) {
    if (sheetOverlay.hidden) sheetReturnFocus = document.activeElement;   // 닫으면 원래 자리로 초점을 돌려준다 (단축키가 이어지게)
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

  // actions: [{icon, label, sub, danger, current, onClick}] 또는 'sep'
  function actionSheet({ title, subtitle, actions }) {
    const items = actions.map((action, index) => {
      if (action === 'sep') return '<div class="sheet-sep"></div>';
      return `<button type="button" class="sheet-action ${action.danger ? 'danger' : ''} ${action.current ? 'current' : ''}" data-index="${index}">
          <i class="fas ${action.icon || 'fa-circle'} lead"></i><span class="min-w-0 ${action.desc ? 'flex-1' : 'truncate'}">${action.desc
            ? `<span class="block truncate">${escapeHtml(action.label)}</span><span class="block text-[11px] font-medium opacity-55 mt-0.5">${escapeHtml(action.desc)}</span>`
            : escapeHtml(action.label)}</span>
          ${action.sub ? `<span class="sub">${escapeHtml(action.sub)}</span>` : ''}</button>`;
    }).join('');
    openSheet(`${sheetHead(title, subtitle)}<div class="sheet-actions">${items}</div>
      <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>닫기</button></div>`, (body) => {
      body.querySelector('[data-close]').addEventListener('click', closeSheet);
      body.querySelectorAll('.sheet-action').forEach((button) => {
        button.addEventListener('click', () => {
          const action = actions[Number(button.dataset.index)];
          closeSheet();
          action.onClick?.();
        });
      });
    });
  }

  // fields: [{name, label, value, placeholder, maxlength, autocomplete}]
  function formSheet({ title, subtitle, fields = [], extraHtml = '', submitLabel = '저장', onMount, onSubmit }) {
    const inputs = fields.map((field) => `
      <label>${escapeHtml(field.label)}
        <input name="${field.name}" value="${escapeHtml(field.value ?? '')}" placeholder="${escapeHtml(field.placeholder ?? '')}"
          maxlength="${field.maxlength || 100}" autocomplete="off" autocapitalize="off" spellcheck="false" ${field.inputmode ? `inputmode="${field.inputmode}"` : ''}>
      </label>`).join('');
    openSheet(`${sheetHead(title, subtitle)}<form class="sheet-form-wrap"><div class="sheet-form">${inputs}${extraHtml}</div>
      <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>취소</button><button type="submit" class="btn-glow">${escapeHtml(submitLabel)}</button></div></form>`, (body) => {
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
          toast(error.message || '처리하지 못했습니다.', 'error');
        } finally {
          submit.disabled = false;
        }
      });
      const first = body.querySelector('input');
      if (first && !coarsePointer) setTimeout(() => first.focus(), 30);
    });
  }

  function confirmSheet({ title, message, confirmLabel = '확인', danger = false }) {
    return new Promise((resolve) => {
      let answered = false;
      let keyHandler = null;
      openSheet(`${sheetHead(title, message)}<div class="sheet-buttons">
          <button type="button" class="sheet-cancel" data-no>취소</button>
          <button type="button" class="${danger ? 'sheet-danger' : 'btn-glow'}" data-yes>${escapeHtml(confirmLabel)}</button></div>`, (body) => {
        const yes = body.querySelector('[data-yes]');
        body.querySelector('[data-no]').addEventListener('click', () => closeSheet());
        yes.addEventListener('click', () => { answered = true; closeSheet(); resolve(true); });
        // Enter = 확인 · Esc = 취소 (확인 버튼에 초점을 두어 키보드로 바로 누를 수 있게)
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

  // 다른 페이지 스크립트(server.js 등)도 같은 시트 · 토스트를 쓰도록 공개한다.
  // 정보만 보여주는 시트 (bodyHtml 은 호출한 쪽에서 escape 한 HTML). onMount 로 나중에 값을 채울 수 있다.
  function infoSheet({ title, subtitle, bodyHtml, onMount }) {
    openSheet(`${sheetHead(title, subtitle)}<div class="sheet-info">${bodyHtml}</div>
      <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>닫기</button></div>`, (body) => {
      body.querySelector('[data-close]').addEventListener('click', closeSheet);
      onMount?.(body);
    });
  }
  window.UnivDashUI = { actionSheet, formSheet, confirmSheet, closeSheet, toast, infoSheet };

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
    if (response.status === 401) { location.href = '/login'; throw new Error('로그인이 필요합니다.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || '요청이 실패했습니다.');
    return data;
  }

  // ── 상태 ─────────────────────────────────────────────────────────────
  const STATUS = {
    busy: { label: '작업 중', icon: 'fa-circle-notch fa-spin' },
    waiting: { label: '응답 필요', icon: 'fa-hand' },
    idle: { label: '대기', icon: 'fa-check' },
    shell: { label: '셸', icon: 'fa-terminal' },
    dead: { label: '종료됨', icon: 'fa-power-off' },
  };
  const FOLDER_COLORS = ['blue', 'purple', 'emerald', 'amber', 'rose', 'cyan', 'slate'];
  // Workspace 목록 정렬. 폴더 구분은 유지하고 각 폴더(와 '폴더 없음') 안에서 정렬한다.
  const SORTS = {
    status: { label: '상태순', icon: 'fa-bolt', desc: '안 읽은 답변 → 작업 중 → 응답 필요 → 대기 중 에이전트 → 셸' },
    activity: { label: '최근 활동순', icon: 'fa-clock', desc: '마지막 출력이 최근인 창부터' },
    name: { label: '이름순', icon: 'fa-arrow-down-a-z', desc: '표시 이름 가나다/ABC 순' },
    manual: { label: '직접 지정', icon: 'fa-hand-pointer', desc: '⋯ 메뉴의 위로 · 아래로 이동으로 정한 순서' },
  };
  const STATUS_RANK = { busy: 0, waiting: 1, idle: 2, shell: 3, dead: 4 };
  const sortMode = () => (SORTS[state.prefs.sort] ? state.prefs.sort : 'status');
  // 에이전트가 답을 마쳤는데(작업 중이 아님) 그 뒤로 이 창을 보지 않았다
  const hasUnreadReply = (w) => !!w.agent && (w.status === 'idle' || w.status === 'waiting')
    && w.key !== state.selectedKey && w.activity > (state.seen[w.key] || 0);

  // 같은 순위끼리는 직접 지정한 순서를 유지한다 (Array.prototype.sort 는 안정 정렬).
  function sortWindows(windows) {
    const mode = sortMode();
    if (mode === 'manual') return windows;
    const sorted = [...windows];
    if (mode === 'status') {
      // 답변이 끝났는데(대기 · 응답 필요) 아직 안 읽은 창이 맨 위, 그중 최근 것 먼저
      const rank = (w) => (hasUnreadReply(w) ? -1 : (STATUS_RANK[w.status] ?? 9));
      sorted.sort((a, b) => rank(a) - rank(b) || (rank(a) === -1 ? b.activity - a.activity : 0));
    }
    else if (mode === 'activity') sorted.sort((a, b) => b.activity - a.activity);
    else if (mode === 'name') sorted.sort((a, b) => displayName(a).localeCompare(displayName(b), 'ko', { numeric: true }));
    return sorted;
  }

  const state = {
    windows: [],
    prefs: { folders: [], order: [], hidden: [], aliases: {}, sort: 'status' },
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
  const displayName = (w) => state.prefs.aliases[w.key] || (w.index === 0 && !state.windows.some((o) => o.session === w.session && o.key !== w.key) ? w.session : `${w.session}:${w.index} ${w.name}`);
  const isHidden = (key) => state.prefs.hidden.includes(key);
  const folderOf = (key) => state.prefs.folders.find((f) => f.items.includes(key)) || null;

  // 폴더들 → 폴더 밖 창 순서. includeHidden=false 면 숨긴 창 제외.
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

  // ── 정리 설정 저장 ─────────────────────────────────────────────────────
  let saveTimer = null;
  let saveChain = Promise.resolve();
  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const snapshot = JSON.parse(JSON.stringify(state.prefs));
      saveChain = saveChain.then(() => api('PUT', '/api/preferences', snapshot))
        .catch((error) => toast(`설정 저장 실패: ${error.message}`, 'error'));
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
      // 폴더 밖 목록의 현재 표시 순서를 저장해 두고 맨 끝에 붙인다.
      const rootGroup = buildGroups(true).at(-1);
      state.prefs.order = [...rootGroup.windows.map((w) => w.key).filter((k) => k !== key), key, ...state.prefs.order.filter((k) => !existingKeys().has(k))];
    }
    commitPrefs();
  }

  // 지금 보이는 정렬 순서를 직접 지정 순서로 굳힌다 (다른 정렬에서 위/아래 이동할 때)
  function adoptDisplayOrder() {
    if (sortMode() === 'manual') return;
    const exist = existingKeys();
    buildGroups(true).forEach((group) => {
      const keys = sortWindows(group.windows).map((w) => w.key);
      if (group.folder) group.folder.items = [...keys, ...group.folder.items.filter((k) => !exist.has(k))];
      else state.prefs.order = [...keys, ...state.prefs.order.filter((k) => !exist.has(k))];
    });
    state.prefs.sort = 'manual';
    toast('정렬 기준을 직접 지정으로 바꿨습니다.', 'info');
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
    toast(hidden ? '다시 목록에 표시합니다.' : '목록에서 숨겼습니다.', 'ok', hidden ? null : { label: '되돌리기', onClick: () => toggleHidden(key) });
  }

  function newFolderId() { return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

  function folderForm({ folder = null, onCreated } = {}) {
    let color = folder?.color || FOLDER_COLORS[state.prefs.folders.length % FOLDER_COLORS.length];
    const swatches = FOLDER_COLORS.map((c) => `<button type="button" class="color-swatch fb-${c} fc-${c} ${c === color ? 'on' : ''}" data-color="${c}" aria-label="${c}"></button>`).join('');
    formSheet({
      title: folder ? '폴더 편집' : '새 폴더',
      fields: [{ name: 'name', label: '폴더 이름', value: folder?.name || '', placeholder: '예: 회사 프로젝트', maxlength: 40 }],
      extraHtml: `<label>색상<div class="color-row">${swatches}</div></label>`,
      submitLabel: folder ? '저장' : '만들기',
      onMount(body) {
        body.querySelectorAll('.color-swatch').forEach((button) => button.addEventListener('click', () => {
          color = button.dataset.color;
          body.querySelectorAll('.color-swatch').forEach((b) => b.classList.toggle('on', b === button));
        }));
      },
      onSubmit(values) {
        const name = values.name.trim();
        if (!name) throw new Error('폴더 이름을 입력하세요.');
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

  // 이름 변경 = 실제 tmux 세션 이름 변경. 폴더 · 순서 · 숨김 · 읽음 표시 · 입력 중이던 내용도 새 이름으로 옮긴다.
  function renameForm(w) {
    const siblings = state.windows.filter((o) => o.session === w.session).length;
    formSheet({
      title: '이름 변경',
      subtitle: `tmux 세션 이름을 바꿉니다${siblings > 1 ? ` (이 세션의 창 ${siblings}개 모두 적용)` : ''}. 공백 · : · . 은 쓸 수 없어요.`,
      fields: [{ name: 'name', label: 'tmux 세션 이름', value: w.session, placeholder: w.session, maxlength: 50 }],
      submitLabel: '변경',
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
      title: '폴더로 이동',
      subtitle: displayName(w),
      actions: [
        ...state.prefs.folders.map((folder) => ({
          icon: `fa-folder fc-${folder.color}`, label: folder.name, current: current?.id === folder.id,
          sub: current?.id === folder.id ? '현재' : `${folder.items.length}`,
          onClick: () => moveToFolder(w.key, folder.id),
        })),
        { icon: 'fa-inbox', label: '폴더 없음', current: !current, sub: !current ? '현재' : '', onClick: () => moveToFolder(w.key, null) },
        'sep',
        { icon: 'fa-folder-plus', label: '새 폴더 만들어 이동', onClick: () => folderForm({ onCreated: (folder) => { folder.items.push(w.key); } }) },
      ],
    });
  }

  // 폴더 메뉴: 편집(이름 · 색) · 순서 · 접기 · 삭제 (예전 '창 정리' 탭 기능)
  function moveFolder(folder, delta) {
    const list = state.prefs.folders;
    const index = list.indexOf(folder);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    commitPrefs();
  }
  async function deleteFolder(folder) {
    const ok = await confirmSheet({ title: '폴더 삭제', message: `'${folder.name}' 폴더를 삭제합니다. 안에 있던 창은 '폴더 없음'으로 옮겨집니다.`, confirmLabel: '삭제', danger: true });
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
      title: folder.name, subtitle: `창 ${folder.items.filter((k) => existingKeys().has(k)).length}개`,
      actions: [
        { icon: 'fa-pen', label: '이름 · 색 바꾸기', onClick: () => folderForm({ folder }) },
        { icon: folder.collapsed ? 'fa-folder-open' : 'fa-folder', label: folder.collapsed ? '펼치기' : '접기', onClick: () => { folder.collapsed = !folder.collapsed; commitPrefs(); } },
        { icon: 'fa-arrow-up', label: '폴더를 위로', onClick: () => moveFolder(folder, -1) },
        { icon: 'fa-arrow-down', label: '폴더를 아래로', onClick: () => moveFolder(folder, 1) },
        { icon: 'fa-folder-plus', label: '새 폴더', onClick: () => folderForm() },
        { icon: 'fa-down-left-and-up-right-to-center', label: allCollapsed ? '모든 폴더 펼치기' : '모든 폴더 접기', onClick: () => { folders.forEach((f) => { f.collapsed = !allCollapsed; }); commitPrefs(); } },
        'sep',
        { icon: 'fa-trash-can', label: '폴더 삭제', danger: true, onClick: () => deleteFolder(folder) },
      ],
    });
  }

  async function killWindow(w) {
    const ok = await confirmSheet({
      title: 'tmux 창 종료',
      message: `${displayName(w)} (${w.session}:${w.index}) 창을 종료합니다. 실행 중인 ${w.agent || '프로그램'}도 함께 종료됩니다.`,
      confirmLabel: '종료', danger: true,
    });
    if (!ok) return;
    try {
      await api('POST', '/api/windows/kill', { window: w.id });
      toast('창을 종료했습니다.', 'ok');
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
        ...(page === 'workspace' && state.selectedKey !== w.key ? [{ icon: 'fa-terminal', label: '열기', onClick: () => workspace.select(w.key) }] : []),
        { icon: 'fa-pen', label: '이름 변경 (tmux 세션)', onClick: () => renameForm(w) },
        { icon: 'fa-folder-open', label: '폴더로 이동', sub: folder ? folder.name : '없음', onClick: () => folderPicker(w) },
        ...(wsFiles ? [{ icon: 'fa-folder-tree', label: '작업 폴더 파일 보기', sub: w.path, onClick: () => wsFiles.reveal(w.path) }] : []),
        { icon: 'fa-arrow-up', label: '위로 이동', sub: sortMode() === 'manual' ? '' : '직접 지정으로 전환', onClick: () => moveWithinGroup(w.key, -1) },
        { icon: 'fa-arrow-down', label: '아래로 이동', onClick: () => moveWithinGroup(w.key, 1) },
        ...(folder ? [{ icon: 'fa-sliders', label: `'${folder.name}' 폴더 관리`, onClick: () => folderMenu(folder) }] : []),
        { icon: hidden ? 'fa-eye' : 'fa-eye-slash', label: hidden ? '다시 표시' : '목록에서 숨기기', onClick: () => toggleHidden(w.key) },
        'sep',
        { icon: 'fa-trash-can', label: 'tmux 창 종료', danger: true, onClick: () => killWindow(w) },
      ],
    });
  }

  // ── 새 세션 ──────────────────────────────────────────────────────────
  function newSessionForm(startPath) {
    // Codex 는 권한을 "Full access"(샌드박스 없음 · 승인 안 물음)로 켠다
    const presets = { claude: 'claude', codex: 'codex --sandbox danger-full-access --ask-for-approval never', shell: '', custom: '' };
    let preset = store.get('new-session-preset', 'claude');
    if (!(preset in presets)) preset = 'claude';
    formSheet({
      title: '새 tmux 세션',
      subtitle: '분리(detached) 세션을 만들고 시작 명령을 실행합니다.',
      fields: [
        { name: 'name', label: '세션 이름', placeholder: '예: my-project', maxlength: 50 },
        { name: 'path', label: '작업 폴더', value: typeof startPath === 'string' ? startPath : store.get('new-session-path', '~'), placeholder: '~/project', maxlength: 1024 },
      ],
      extraHtml: `<div class="fp">
          <div class="fp-actions">
            <button type="button" class="fp-toggle" data-fp-toggle><i class="fas fa-folder-open"></i> 폴더 고르기</button>
            ${store.get('recent-session-paths', []).slice(0, 5).map((p) => `<button type="button" class="fp-chip" data-fp-recent="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(p.replace(/\/+$/, '').split('/').pop() || p)}</button>`).join('')}
          </div>
          <div class="fp-panel hidden">
            <div class="fp-head">
              <button type="button" class="fp-btn" data-fp-up title="상위 폴더" aria-label="상위 폴더"><i class="fas fa-arrow-turn-up"></i></button>
              <button type="button" class="fp-btn" data-fp-home title="홈 폴더" aria-label="홈 폴더"><i class="fas fa-house"></i></button>
              <span class="fp-where">~</span>
              <button type="button" class="fp-btn" data-fp-dot title="숨김 폴더 보기" aria-label="숨김 폴더 보기"><i class="fas fa-eye-slash"></i></button>
            </div>
            <div class="fp-list"></div>
            <button type="button" class="fp-pick" data-fp-pick><i class="fas fa-check"></i> <span>이 폴더로</span></button>
          </div>
        </div>
        <label>시작 명령<div class="seg" role="radiogroup">
          ${['claude', 'codex', 'shell', 'custom'].map((p) => `<button type="button" data-preset="${p}" class="${p === preset ? 'on' : ''}">${{ claude: 'Claude', codex: 'Codex', shell: '셸만', custom: '직접' }[p]}</button>`).join('')}
        </div></label>
        <p data-codex-note class="text-[11px] opacity-60 -mt-1 ${preset === 'codex' ? '' : 'hidden'}"><i class="fas fa-unlock mr-1"></i>Codex 는 권한 Full access 로 켭니다 (샌드박스 없음 · 승인 묻지 않음)</p>
        <label data-custom class="${preset === 'custom' ? '' : 'hidden'}">명령어<input name="command" maxlength="500" placeholder="예: claude --continue" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`,
      submitLabel: '만들기',
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

        // ── 작업 폴더 고르기 (홈에서부터 폴더를 눌러 들어가며 고르기) ──
        const panel = body.querySelector('.fp-panel');
        const listEl = body.querySelector('.fp-list');
        let home = '';
        let current = null;
        let showDot = store.get('fp-dot', false);
        const tilde = (p) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
        const setPath = (p) => { path.value = tilde(p); path.dispatchEvent(new Event('input')); };
        async function browse(dir) {
          listEl.innerHTML = '<div class="fp-note"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중…</div>';
          try {
            const data = await api('GET', `/api/fs/list?path=${encodeURIComponent(dir)}`);
            if (!home && dir === '~') home = data.path;
            current = data;
            body.querySelector('.fp-where').textContent = tilde(data.path);
            body.querySelector('[data-fp-up]').disabled = !data.parent;
            body.querySelector('[data-fp-dot]').classList.toggle('on', showDot);
            body.querySelector('.fp-pick span').textContent = `이 폴더로: ${tilde(data.path)}`;
            const dirs = data.entries.filter((e) => e.type === 'dir' && (showDot || !e.name.startsWith('.')))
              .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }));
            listEl.innerHTML = dirs.length ? dirs.map((e) => `<div class="fp-row" data-fp-dir="${escapeHtml(e.path)}">
                <i class="fas fa-folder"></i><span class="fp-name">${escapeHtml(e.name)}</span>
                <button type="button" class="fp-use" data-fp-use="${escapeHtml(e.path)}" title="이 폴더 선택" aria-label="${escapeHtml(e.name)} 선택"><i class="fas fa-check"></i></button>
                <i class="fas fa-chevron-right fp-go"></i></div>`).join('')
              : '<div class="fp-note">하위 폴더가 없습니다.</div>';
          } catch (error) {
            listEl.innerHTML = `<div class="fp-note error">${escapeHtml(error.message)}</div>`;
          }
        }
        body.querySelector('[data-fp-toggle]').addEventListener('click', async () => {
          const open = panel.classList.toggle('hidden') === false;
          if (!open) return;
          if (!home) { try { home = (await api('GET', '/api/fs/list?path=~')).path; } catch (e) { /* noop */ } }
          const typed = path.value.trim();
          browse(typed ? typed.replace(/^~(?=\/|$)/, home || '~') : '~');   // 지금 적힌 폴더에서 시작 (없으면 홈)
        });
        body.querySelector('[data-fp-up]').addEventListener('click', () => { if (current?.parent) browse(current.parent); });
        body.querySelector('[data-fp-home]').addEventListener('click', () => browse('~'));
        body.querySelector('[data-fp-dot]').addEventListener('click', () => { showDot = !showDot; store.set('fp-dot', showDot); if (current) browse(current.path); });
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
        body.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => {
          preset = button.dataset.preset;
          body.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b === button));
          body.querySelector('[data-custom]').classList.toggle('hidden', preset !== 'custom');
          body.querySelector('[data-codex-note]').classList.toggle('hidden', preset !== 'codex');
        }));
      },
      async onSubmit(values) {
        const command = preset === 'custom' ? (values.command || '') : presets[preset];
        const result = await api('POST', '/api/sessions', { name: values.name.trim(), path: values.path.trim() || '~', command });
        store.set('new-session-path', values.path.trim() || '~');
        const used = values.path.trim() || '~';
        store.set('recent-session-paths', [used, ...store.get('recent-session-paths', []).filter((p) => p !== used)].slice(0, 8));
        store.set('new-session-preset', preset);
        toast(`${values.name} 세션을 만들었습니다.`, 'ok');
        state.pendingPane = result.pane;
        socket.poke();
        if (page !== 'workspace') setTimeout(() => { location.href = '/'; }, 400);
      },
    });
  }
  // "+ 새 세션": tmux 세션(에이전트용) 또는 Terminal
  function newChooser() {
    actionSheet({
      title: '새로 열기',
      actions: [
        { icon: 'fa-layer-group', label: 'tmux 세션', desc: 'Claude Code · Codex 등을 띄워 두고 휴대폰에서도 이어서 쓰기', onClick: () => newSessionForm() },
        { icon: 'fa-terminal', label: 'Terminal', desc: '셸 하나를 탭으로 바로 열기 (탭을 닫으면 끝남)', onClick: () => { if (window.UnivDashWs?.newTerminal) window.UnivDashWs.newTerminal(); else location.href = '/?newterm=1'; } },
      ],
    });
  }
  $$('[data-new-session]').forEach((button) => button.addEventListener('click', () => { if (!mdQuery.matches) setSidebarOpen(false); newChooser(); }));

  // 단축키 (입력 중이 아닐 때, 모든 페이지): t/ㅅ 한 번 → 새 Terminal · tt/ㅅㅅ 빠르게 두 번 → 새 tmux 세션 설정
  // 한 번 누른 것인지 확인하려고 0.35초 기다린 뒤 연다.
  const DOUBLE_TAP_MS = 350;
  let tTimer = null;
  function openTerminalShortcut() {
    if (window.UnivDashWs?.newTerminal) window.UnivDashWs.newTerminal();
    else location.href = '/?newterm=1';
  }
  document.addEventListener('keydown', (event) => {
    const { plainKey, typingOrBusy } = window.UnivDash;
    if (!plainKey(event, 'KeyT') || typingOrBusy(event)) return;
    event.preventDefault();
    if (tTimer) {
      clearTimeout(tTimer);
      tTimer = null;
      newSessionForm();
      return;
    }
    tTimer = setTimeout(() => { tTimer = null; openTerminalShortcut(); }, DOUBLE_TAP_MS);
  });
  window.UnivDashUI.newSession = newSessionForm;

  // ── 실시간 연결 ──────────────────────────────────────────────────────
  const socket = (() => {
    let ws = null;
    let retry = 0;
    let seq = 0;
    let reconnectTimer = null;
    const pending = new Map();
    const handlers = {};

    function setConn(status) {
      const text = { live: 'Live · 실시간 연결됨', connecting: '연결 중...', offline: '연결 끊김 · 재시도 중' }[status];
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
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
      ws.onopen = () => { retry = 0; setConn('live'); (handlers.open || []).forEach((fn) => fn()); };
      ws.onmessage = (event) => {
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
      ws.onclose = (event) => {
        pending.forEach((entry) => { clearTimeout(entry.timer); entry.reject(new Error('연결이 끊어졌습니다.')); });
        pending.clear();
        if (event.code === 1008) { location.href = '/login'; return; }
        setConn('offline');
        retry = Math.min(retry + 1, 5);
        reconnectTimer = setTimeout(connect, [0, 800, 1500, 3000, 6000, 10000][retry]);
      };
    }

    function send(message, { ack = false } = {}) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (ack) return Promise.reject(new Error('서버와 연결되어 있지 않습니다. 잠시 후 다시 시도하세요.'));
        return Promise.resolve();
      }
      if (!ack) { ws.send(JSON.stringify(message)); return Promise.resolve(); }
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('응답 시간이 초과되었습니다.')); }, 10000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ ...message, id }));
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { retry = 0; connect(); refreshState(); }
    });
    window.addEventListener('online', () => { retry = 0; connect(); });

    return {
      connect, send, on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
      poke() { send({ t: 'ping' }); },
      get open() { return ws && ws.readyState === WebSocket.OPEN; },
    };
  })();

  // ── 공통 렌더링 ──────────────────────────────────────────────────────
  let lastStatuses = new Map();
  function onWindows(windows) {
    const previous = lastStatuses;
    lastStatuses = new Map(windows.map((w) => [w.key, w.status]));
    state.windows = windows;

    // 처음 보는 창은 읽은 것으로 간주, 선택된 창은 계속 읽음 처리
    windows.forEach((w) => {
      if (state.seen[w.key] == null || (w.key === state.selectedKey && isTermVisible())) markSeen(w.key, w.activity);
    });

    // 에이전트 상태 변화 알림 (보고 있지 않은 창만)
    if (previous.size) {
      windows.forEach((w) => {
        const before = previous.get(w.key);
        if (!before || before === w.status || isHidden(w.key)) return;
        const watching = w.key === state.selectedKey && isTermVisible() && document.visibilityState === 'visible';
        if (watching) return;
        const open = page === 'workspace' ? { label: '열기', onClick: () => workspace.select(w.key) } : null;
        if (w.status === 'waiting') { toast(`${displayName(w)} · 응답이 필요합니다`, 'warn', open, 6000); vibrate([20, 60, 20]); }
        else if (before === 'busy' && w.status === 'idle') { toast(`${displayName(w)} · 작업 완료`, 'ok', open, 5000); vibrate(15); }
      });
    }

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

  let lastRenderSignature = '';
  function renderAll(force = false) {
    renderStats();
    const windowsSignature = state.windows.map((w) => [w.key, w.status, w.title, w.path, w.agent, w.activity > (state.seen[w.key] || 0), timeAgo(w.activity), w.panes.length]);
    const signature = JSON.stringify([windowsSignature, state.prefs, state.filter, state.search, state.showHidden, state.selectedKey]);
    if (!force && signature === lastRenderSignature) return;
    lastRenderSignature = signature;
    if (page === 'workspace') workspace.renderList();
  }

  // ── 읽음 상태: 서버에 모아 모든 기기가 공유 (PC 에서 본 창은 휴대폰에서도 읽음) ──
  const seenOutbox = {};
  let seenTimer = null;
  function markSeen(key, activity) {
    if (activity == null || (state.seen[key] ?? -Infinity) >= activity) return;
    state.seen[key] = activity;
    store.set('seen', state.seen);
    seenOutbox[key] = activity;
    clearTimeout(seenTimer);
    seenTimer = setTimeout(flushSeen, 300);
  }
  function flushSeen() {
    if (!Object.keys(seenOutbox).length || !socket.open) return;   // 끊겨 있으면 다시 연결될 때 보낸다
    socket.send({ t: 'seen', items: { ...seenOutbox } });
    Object.keys(seenOutbox).forEach((key) => delete seenOutbox[key]);
  }
  function mergeSeen(remote) {
    if (!remote || typeof remote !== 'object') return false;
    let changed = false;
    for (const [key, value] of Object.entries(remote)) {
      if (typeof value === 'number' && value > (state.seen[key] ?? -Infinity)) { state.seen[key] = value; changed = true; }
    }
    // 이 기기에만 있는 읽음 기록(서버가 모르는 것)은 서버로 올린다
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

  // 길게 누르기 → 메뉴 (iOS 는 contextmenu 이벤트가 없어서 직접 구현)
  function attachLongPress(root, selector, onLongPress) {
    let timer = null;
    let start = null;
    let fired = false;
    root.addEventListener('pointerdown', (event) => {
      const target = event.target.closest(selector);
      // 마우스는 오른쪽 클릭으로 메뉴를 열고, 누른 채 끌기는 드래그(분할로 열기)라서 길게 누르기는 터치에서만
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
  // 터미널 렌더러 (ANSI SGR → HTML). 라이트 모드에서는 프로그램이 어두운 배경을 가정하고 고른 색을
  // 밝은 배경에서도 읽히게 고친다 (VS Code 터미널의 '최소 대비'처럼: 너무 밝은 글자는 어둡게, 어두운 배경은 밝게).
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
  // 라이트 모드용 색 보정 (결과는 캐시)
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
        l = Math.min(l, 1 - l);                 // 밝은 색은 명도를 뒤집고
        let next = fromHsl([h, s, l]);
        while (contrast(next) < 4.5 && l > 0.05) { l -= 0.04; next = fromHsl([h, s, l]); }   // 그래도 흐리면 더 어둡게
        out = `rgb(${next.join(',')})`;
      }
    } else if (l < 0.45) {
      out = `rgb(${fromHsl([h, Math.min(s, 0.6), Math.max(0.86, 1 - l * 0.5)]).join(',')})`;   // 어두운 배경 → 옅은 같은 색조
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

  // 한 줄을 HTML 로. st 는 줄 사이에 이어지는 SGR 상태. cursorCol 이 있으면 그 칸에 커서를 그린다.
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
    let stickBottom = true;
    let charRatio = 0.6;
    const submit = true;   // 보내면 항상 Enter 까지 (자동 제출 토글은 없앰)
    const drafts = store.get('drafts', {});
    let draftTimer = null;

    // ── 목록 ──
    function matches(w) {
      const query = state.search.trim().toLowerCase();
      if (query) {
        const haystack = [displayName(w), w.session, w.name, w.title, w.path, w.agent].join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (state.filter === 'busy') return w.status === 'busy';
      if (state.filter === 'waiting') return w.status === 'waiting';
      if (state.filter === 'agent') return !!w.agent;
      return true;
    }

    function itemHtml(w) {
      const selected = w.key === state.selectedKey;
      const unread = !selected && w.activity > (state.seen[w.key] || 0);
      const status = STATUS[w.status] || STATUS.idle;
      const meta = [status.label, w.path, timeAgo(w.activity)].filter(Boolean).join(' · ');
      return `<div class="win-item ${selected ? 'selected' : ''} ${isHidden(w.key) ? 'is-hidden' : ''}" role="button" tabindex="0" ${coarsePointer ? '' : 'draggable="true"'} data-key="${escapeHtml(w.key)}" aria-current="${selected}">
          ${unread ? '<span class="unread-dot" title="새 출력"></span>' : ''}
          ${statusIcon(w)}
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-2 min-w-0"><span class="truncate text-sm font-bold text-white/90">${escapeHtml(displayName(w))}</span>${agentPill(w)}</span>
            ${w.title && w.title !== displayName(w) ? `<span class="block truncate text-xs text-white/60 mt-0.5">${escapeHtml(w.title)}</span>` : ''}
            <span class="block truncate font-mono text-[10px] text-white/35 mt-0.5">${escapeHtml(meta)}</span>
          </span>
          <button type="button" class="win-more" data-more aria-label="${escapeHtml(displayName(w))} 메뉴"><i class="fas fa-ellipsis-vertical"></i></button>
        </div>`;
    }

    // ── tmux 창 탭: 창을 고르면 탭으로 열리고, 탭끼리 바로 전환 (이 기기에 저장) ──
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
    // 탭바 그리기는 아래 공용 탭바(파일 탭과 함께)가 맡는다. 여기서는 목록만 관리한다.
    const termTabHooks = [];
    function renderTermTabs() {
      const map = byKey();
      if (state.windows.length) {
        const alive = termTabs.filter((k) => map.has(k));   // tmux 에서 닫힌 창은 탭에서도 뺀다
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

      if (!state.windows.length) {
        list.innerHTML = `<div class="px-4 py-12 text-center">
            <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl glass-strong text-lg text-blue-400"><i class="fas fa-terminal"></i></div>
            <p class="mt-4 text-sm font-bold text-white/70">실행 중인 tmux 세션이 없습니다.</p>
            <p class="mt-1 text-xs text-white/40">오른쪽 위 + 버튼으로 새 세션을 만들 수 있습니다.</p></div>`;
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
                <span class="folder-more" data-folder-more role="button" aria-label="폴더 메뉴"><i class="fas fa-ellipsis"></i></span>
              </button>
              ${collapsed ? '' : `<div class="mt-1 space-y-1">${group.windows.map(itemHtml).join('')}</div>`}
            </section>`;
        } else {
          html += `<section>${hasFolders ? '<p class="folder-head pointer-events-none"><i class="fas fa-inbox text-[10px]"></i><span class="normal-case tracking-normal text-[12px]">폴더 없음</span></p>' : ''}
              <div class="${hasFolders ? 'mt-1 ' : ''}space-y-1">${group.windows.map(itemHtml).join('')}</div></section>`;
        }
      });
      list.innerHTML = html || `<div class="px-4 py-12 text-center text-xs text-white/40">조건에 맞는 창이 없습니다.</div>`;
    }

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
      select(w.key);
    });
    list.addEventListener('keydown', (event) => {
      const item = event.target.closest('.win-item');
      if (item && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(item.dataset.key); }
    });
    attachLongPress(list, '.win-item', (item) => { const w = byKey().get(item.dataset.key); if (w) windowMenu(w); });
    attachLongPress(list, '[data-folder]', (head) => { const folder = state.prefs.folders.find((f) => f.id === head.dataset.folder); if (folder) folderMenu(folder); });

    $('#windowSearch').addEventListener('input', (event) => { state.search = event.target.value; renderAll(); });
    $$('[data-filter]').forEach((chip) => chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter; store.set('filter', state.filter); renderAll();
    }));
    $('#toggleHiddenBtn').addEventListener('click', () => { state.showHidden = !state.showHidden; renderAll(); });
    $('#sortBtn').addEventListener('click', () => {
      const current = sortMode();
      actionSheet({
        title: '정렬 기준',
        subtitle: '폴더 안에서 정렬됩니다. 휴대폰·PC 에 같이 적용돼요.',
        actions: Object.entries(SORTS).map(([id, sort]) => ({
          icon: sort.icon, label: sort.label, desc: sort.desc, sub: id === current ? '✓' : '', current: id === current,
          onClick: () => { state.prefs.sort = id; commitPrefs(); },
        })),
      });
    });

    // ── 창 선택 / 터미널 열기 ──
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
      if (changed) { state.paneId = null; lastScreen = null; scrollback = 400; inner.innerHTML = '<div class="ln term-empty-note">화면을 불러오는 중...</div>'; }
      state.paneId = pickPane(w);
      markSeen(key, w.activity);
      store.set('last-window', key);
      stickBottom = true;

      $('#termEmpty').classList.add('hidden');
      $('#termEmpty').classList.remove('lg:flex');
      // keepFile: 새로고침 복원 때 보고 있던 파일은 그대로 두고 터미널은 뒤에서 준비만 한다
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
      input.value = drafts[key] || '';
      autosize();
      renderHeader();
      refreshModel(true);
      refreshLimits().then(renderUsage);
      renderAttachments();
      log.pane = null;
      applyMode();
      subscribe();
      renderAll(true);
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
        window.history.back();  // popstate 에서 마저 닫는다
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
      if (document.body.classList.contains('file-open') || document.body.classList.contains('pty-open')) return;  // 파일 · 터미널 보기가 먼저 닫힌다 (아래)
      if (document.body.classList.contains('term-open')) closeTerm(true);
    });
    $('#termBack').addEventListener('click', () => closeTerm());

    function subscribe() {
      if (state.paneId) socket.send({ t: 'sub', pane: state.paneId, history: scrollback });
    }

    // ── 지금 쓰는 모델 (입력창 ⚡ 옆) · 남은 사용량 (머리글 오른쪽) ──
    const modelBtn = $('#modelBtn');
    const usageMini = $('#usageMini');
    const modelState = { pane: null, model: null, pending: null, at: 0 };
    function prettyModel(id) {
      if (!id) return '모델';
      if (!id.startsWith('claude-')) return id;
      const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
      const family = parts.shift();
      return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${parts.join('.')}`.trim();
    }
    function renderModel() {
      const w = currentWindow();
      const agent = w && agentOf(w);
      modelBtn.classList.toggle('hidden', !agent);
      if (!agent) return;
      const label = modelState.pending ? `→ ${prettyModel(modelState.pending)}` : prettyModel(modelState.model);
      $('#modelLabel').textContent = label;
      modelBtn.title = modelState.model ? `지금 모델: ${modelState.model} — 눌러서 바꾸기` : '모델 바꾸기';
      modelBtn.classList.toggle('pending', !!modelState.pending);
    }
    async function refreshModel(force = false) {
      const w = currentWindow();
      if (!w || !agentOf(w) || !state.paneId) { renderModel(); return; }
      if (!force && modelState.pane === state.paneId && Date.now() - modelState.at < 8000) return;
      const pane = state.paneId;
      try {
        const data = await api('GET', `/api/agent/model?pane=${encodeURIComponent(pane)}`);
        if (pane !== state.paneId) return;
        if (modelState.pane !== pane) modelState.pending = null;
        modelState.pane = pane;
        modelState.at = Date.now();
        if (data.model && modelState.pending && data.model !== modelState.model) modelState.pending = null;   // 바뀐 모델이 기록에 나타남
        modelState.model = data.model;
      } catch (e) { /* noop */ }
      renderModel();
    }
    const CLAUDE_MODELS = [
      ['claude-opus-5-5', 'Opus 5.5', '가장 똑똑함'], ['claude-fable-5-1', 'Fable 5.1', ''], ['claude-sonnet-5', 'Sonnet 5', '빠르고 균형 잡힘'],
      ['claude-haiku-4-5-20251001', 'Haiku 4.5', '가장 빠름'], ['default', '기본값', '계정 기본 모델'],
    ];
    // 슬래시 명령 보내기: Codex 는 붙여넣기 직후의 Enter 를 줄바꿈으로 받으므로 글자로 치고 잠시 뒤 Enter
    async function sendSlash(pane, agent, text, sendFn) {
      if (agent === 'codex') {
        await sendFn({ t: 'text', pane, text });
        await new Promise((resolve) => setTimeout(resolve, 450));
        await sendFn({ t: 'keys', pane, keys: ['Enter'] });
      } else await sendFn({ t: 'prompt', pane, text, submit: true, attachments: [] });
    }
    async function sendModelCommand(text, label) {
      if (!state.paneId) return;
      try {
        await sendSlash(state.paneId, agentOf(currentWindow()), text, (message) => socket.send(message, { ack: true }));
        toast(label ? `${label} 로 바꾸는 중… (다음 답변부터 적용)` : '모델 목록이 뜨면 채팅 아래 카드에서 고르세요 (Codex 는 모델 → 추론 수준 두 번).', 'info');
      } catch (error) { toast(error.message, 'error'); }
    }
    modelBtn.addEventListener('pointerdown', (event) => event.preventDefault());
    // 모델 바꾸기 메뉴 (메인 · 분할 화면 공용): ctx = { agent, model, busy, send(text, label), onPending(id) }
    function modelMenu(ctx) {
      const busy = ctx.busy ? ' · 작업 중이라 지금 턴이 끝난 뒤 적용돼요' : '';
      if (ctx.agent !== 'claude') {
        actionSheet({
          title: `${ctx.agent === 'codex' ? 'Codex' : ctx.agent} 모델`, subtitle: `지금: ${ctx.model || '알 수 없음'}${busy}`,
          actions: [{ icon: 'fa-list', label: '모델 목록 열기 (/model)', desc: '선택지는 채팅 아래 카드에 버튼으로 뜹니다', onClick: () => ctx.send('/model') }],
        });
        return;
      }
      actionSheet({
        title: 'Claude 모델', subtitle: `지금: ${prettyModel(ctx.model)}${busy}`,
        actions: [
          ...CLAUDE_MODELS.map(([id, label, desc]) => ({
            icon: 'fa-microchip', label, desc, current: id === ctx.model, sub: id === ctx.model ? '사용 중' : '',
            onClick: () => { ctx.onPending?.(id === 'default' ? null : id); ctx.send(`/model ${id}`, label); },
          })),
          'sep',
          { icon: 'fa-list', label: 'Claude 목록에서 고르기 (/model)', onClick: () => ctx.send('/model') },
          { icon: 'fa-keyboard', label: '모델 이름 직접 입력', onClick: () => formSheet({
            title: '모델 바꾸기', fields: [{ name: 'model', label: '모델 이름 또는 별칭', placeholder: '예: opus, sonnet, claude-opus-5-5', maxlength: 80 }], submitLabel: '바꾸기',
            onSubmit: (values) => {
              const id = (values.model || '').trim();
              if (!/^[\w.\-\[\]]{1,80}$/.test(id)) throw new Error('모델 이름이 올바르지 않습니다.');
              ctx.onPending?.(id);
              ctx.send(`/model ${id}`, id);
            },
          }) },
        ],
      });
    }
    modelBtn.addEventListener('click', () => {
      const w = currentWindow();
      const agent = w && agentOf(w);
      if (!agent) return;
      modelMenu({
        agent, model: modelState.model, busy: w.status === 'busy',
        send: (text, label) => sendModelCommand(text, label),
        onPending: (id) => { modelState.pending = id; renderModel(); },
      });
    });

    // 남은 사용량: 현재 세션 · 주간 (Claude / Codex, 1분마다)
    let limits = null;
    let limitsAt = 0;
    async function refreshLimits(force = false) {
      if (!force && limits && Date.now() - limitsAt < 60000) return;
      try { limits = await api('GET', '/api/ai-limits'); limitsAt = Date.now(); } catch (e) { /* noop */ }
    }
    function renderUsage() {
      const w = currentWindow();
      const html = usageMarkup(w && agentOf(w));
      usageMini.classList.toggle('hidden', !html);
      if (html) usageMini.innerHTML = html;
    }
    // 남은 사용량 게이지 HTML (메인 · 분할 화면 공용). 없으면 ''
    function usageMarkup(agent) {
      const provider = agent && limits?.[agent === 'codex' ? 'codex' : 'claude'];
      const windows = provider?.windows || [];
      const session = windows.find((x) => x.window_minutes && x.window_minutes <= 360);
      const weekly = windows.find((x) => /weekly_all|seven_day$|codex-secondary/.test(x.id)) || windows.find((x) => x.window_minutes >= 10080);
      const gauges = [['세션', session], ['주간', weekly]].filter(([, x]) => x);
      if (!gauges.length) return '';
      const when = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');
      return `<span class="um-provider">${agent === 'codex' ? 'Codex' : 'Claude'}${provider.plan ? ` · ${escapeHtml(provider.plan)}` : ''}</span>` + gauges.map(([name, x]) => {
        const left = Math.round(x.remaining_percent);
        const tone = left > 50 ? 'ok' : left > 20 ? 'mid' : 'low';
        return `<div class="um ${tone}" title="${escapeHtml(`${x.label} ${left}% 남음${x.resets_at ? ` · ${when(x.resets_at)} 초기화` : ''}`)}">
            <span class="um-label">${name}</span><span class="um-bar"><i style="width:${left}%"></i></span><span class="um-val">${left}%</span></div>`;
      }).join('');
    }
    setInterval(() => { if (document.visibilityState === 'visible' && state.selectedKey) refreshLimits().then(renderUsage); }, 60000);
    setInterval(() => { if (document.visibilityState === 'visible' && state.selectedKey) refreshModel(); }, 10000);

    function renderHeader() {
      const w = currentWindow();
      if (!w) return;
      renderModel();
      renderUsage();
      // 창 상태(응답 필요 등)가 바뀌면 화면이 그대로여도 채팅 아래 카드를 다시 판단한다 (Codex 선택 창은 화면이 안 바뀜)
      if (lastScreen && lastScreen.pane === state.paneId) updateChatStatus(lastScreen);
      $('#termTitle').textContent = displayName(w);
      $('#termSubtitle').textContent = [STATUS[w.status]?.label, w.title, w.path].filter(Boolean).join(' · ');
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

    // ── 화면 ──
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
      const stick = firstForPane || stickBottom || atBottom();
      const lines = screen.content.split('\n');
      const visibleStart = Math.max(0, lines.length - screen.height);
      const cursorLine = screen.cursor.visible && !screen.in_mode ? visibleStart + screen.cursor.y : -1;

      // 화면 아래쪽의 빈 줄은 잘라낸다 (커서 줄은 유지)
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
        ? '<div class="alt-hint"><i class="fas fa-circle-info"></i><span>전체 화면 모드라 tmux 에 이전 기록이 남지 않아요.</span><button type="button" data-open-log>채팅으로 보기</button></div>'
        : '';
      inner.innerHTML = hint + (html || '<div class="ln term-empty-note">(빈 화면)</div>');

      const historyLines = lines.length - screen.height;
      const canLoadMore = historyLines >= scrollback && scrollback < 5000;
      loadMoreBtn.classList.toggle('hidden', !canLoadMore);
      loadMoreBtn.textContent = `이전 기록 더 보기 (+1000줄)`;
      if (canLoadMore) scroll.prepend(loadMoreBtn);

      if (view.mode === 'fit') refit();
      if (stick) { scroll.scrollTop = scroll.scrollHeight; stickBottom = true; }
      jumpBtn.classList.toggle('hidden', stick || atBottom());

      const w = currentWindow();
      if (w) markSeen(w.key, w.activity);
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
    jumpBtn.addEventListener('click', () => { const target = activeScroll(); target.scrollTop = target.scrollHeight; stickBottom = true; jumpBtn.classList.add('hidden'); });
    loadMoreBtn.addEventListener('click', () => {
      scrollback = Math.min(5000, scrollback + 1000);
      stickBottom = false;
      const fromBottom = scroll.scrollHeight - scroll.scrollTop;
      subscribe();
      const restore = () => { scroll.scrollTop = scroll.scrollHeight - fromBottom; };
      setTimeout(restore, 400);
    });
    window.addEventListener('resize', () => requestAnimationFrame(refit));

    socket.on('screen', (screen) => {
      if (screen.pane !== state.paneId) return;
      renderScreen(screen);
      updateChatStatus(screen);
    });
    socket.on('gone', (message) => {
      if (message.pane !== state.paneId) return;
      toast('창이 닫혔습니다.', 'info');
      if (desktopQuery.matches) {
        state.selectedKey = null; state.paneId = null;
        $('#termView').classList.remove('open');
        $('#termEmpty').classList.remove('hidden'); $('#termEmpty').classList.add('lg:flex');
      } else {
        closeTerm();
      }
    });

    // 보기 설정
    $('#termViewBtn').addEventListener('click', () => {
      const modes = [['wrap', '줄바꿈', 'fa-align-left', '모바일에서 읽기 편함'], ['fit', '화면 맞춤', 'fa-expand', '가로폭에 맞춰 축소'], ['raw', '원본', 'fa-arrows-left-right', '가로 스크롤']];
      openSheet(`${sheetHead('보기 설정', '이 기기에만 저장됩니다.')}
        <div class="sheet-form">
          <label>표시 방식<div class="seg">${modes.map(([id, label]) => `<button type="button" data-mode="${id}" class="${view.mode === id ? 'on' : ''}">${label}</button>`).join('')}</div></label>
          <p data-mode-desc class="text-[11px] opacity-60 -mt-1"></p>
          <label>글자 크기 <span data-font-label class="font-mono"></span>
            <div class="seg"><button type="button" data-font="-1">A−</button><button type="button" data-font="0">기본</button><button type="button" data-font="1">A+</button></div></label>
        </div>
        <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>닫기</button></div>`, (body) => {
        const sync = () => {
          body.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === view.mode));
          body.querySelector('[data-mode-desc]').textContent = modes.find((m) => m[0] === view.mode)[3];
          body.querySelector('[data-font-label]').textContent = view.mode === 'fit' ? '(자동)' : `${view.font}px`;
        };
        sync();
        body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
          view.mode = b.dataset.mode; store.set('view', view); applyView(); if (lastScreen) renderScreen(lastScreen); sync();
        }));
        body.querySelectorAll('[data-font]').forEach((b) => b.addEventListener('click', () => {
          const delta = Number(b.dataset.font);
          view.font = delta === 0 ? (coarsePointer ? 11.5 : 12.5) : Math.max(8, Math.min(20, view.font + delta));
          if (view.mode === 'fit') view.mode = 'wrap';
          store.set('view', view); applyView(); if (lastScreen) renderScreen(lastScreen); sync();
        }));
        body.querySelector('[data-close]').addEventListener('click', closeSheet);
      });
    });

    $('#termMoreBtn').addEventListener('click', () => { const w = currentWindow(); if (w) windowMenu(w); });

    // ── 입력: 프롬프트 ──
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
      $('#composerHint').textContent = coarsePointer ? '줄바꿈은 키보드 Enter · 전송은 ➤' : 'Enter 전송 · Shift+Enter 줄바꿈';
    }

    syncSubmitToggle();

    // ── 이전 프롬프트 불러오기 (셸처럼 ↑ / ↓, 휴대폰은 입력창 아래 ⌃ ⌄ 버튼) ──
    const history = { index: -1, stash: '' };
    function recallHistory(delta) {
      const list = store.get('recent', []);
      if (!list.length) { toast('보낸 프롬프트 기록이 없습니다.', 'info', null, 1500); return; }
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
        const caret = input.selectionStart;
        const onFirstLine = !input.value.slice(0, caret).includes('\n');
        const onLastLine = !input.value.slice(input.selectionEnd).includes('\n');
        // 여러 줄을 쓰는 중이면 커서가 맨 윗줄 / 맨 아랫줄일 때만 기록을 넘긴다
        if (event.key === 'ArrowUp' && onFirstLine && (history.index !== -1 || !input.value.includes('\n'))) { event.preventDefault(); recallHistory(1); return; }
        if (event.key === 'ArrowDown' && onLastLine && history.index !== -1) { event.preventDefault(); recallHistory(-1); return; }
      }
    });
    for (const [id, delta] of [['#histPrev', 1], ['#histNext', -1]]) {
      $(id).addEventListener('pointerdown', (event) => event.preventDefault());  // 키보드가 내려가지 않게
      $(id).addEventListener('click', () => { exitDirect(); recallHistory(delta); });
    }

    // ── 특수 키 줄 접기 / 펼치기 ──
    function applyKeyBar(collapsed) {
      $('#keyBar').classList.toggle('hidden', collapsed);
      const toggle = $('#keyBarToggle');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.innerHTML = collapsed ? '<i class="fas fa-chevron-up"></i> 키 펼치기' : '<i class="fas fa-chevron-down"></i> 키 접기';
    }
    applyKeyBar(store.get('keybar-collapsed', false));
    $('#keyBarToggle').addEventListener('pointerdown', (event) => event.preventDefault());
    $('#keyBarToggle').addEventListener('click', () => {
      const collapsed = !$('#keyBar').classList.contains('hidden');
      store.set('keybar-collapsed', collapsed);
      applyKeyBar(collapsed);
      refit();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      const send = (event.ctrlKey || event.metaKey) || (!coarsePointer && !event.shiftKey && !event.altKey);
      if (send) { event.preventDefault(); sendPrompt(); }
    });
    $('#composerForm').addEventListener('submit', (event) => { event.preventDefault(); sendPrompt(); });

    async function sendPrompt() {
      if (!state.paneId) return;
      const pane = state.paneId;
      const key = state.selectedKey;
      const list = attachList(key);
      sendBtn.disabled = true;
      vibrate(10);   // 보내기를 누른 그 순간 (await 뒤에서는 iOS 햅틱이 안 울린다)
      try {
        if (list.some((item) => item.status === 'uploading')) {
          toast('첨부 파일 업로드가 끝나면 보냅니다...', 'info', null, 1800);
          await Promise.all(list.map((item) => item.promise));
          if (state.selectedKey !== key) return;
        }
        if (list.some((item) => item.status === 'error')) {
          throw new Error('업로드에 실패한 첨부가 있습니다. ✕ 로 빼거나 다시 첨부하세요.');
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
          try {
            const echo = text && submit ? addOptimistic(text) : null;
            try {
              await socket.send({ t: 'prompt', pane, text, submit, attachments: ready.map((item) => item.id) }, { ack: true });
            } catch (error) {
              if (echo) removeOptimistic(echo);
              throw error;
            }
          } catch (error) {
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

    // ── 첨부 파일 (사진·파일 선택, 붙여넣기, 드래그앤드롭) ──
    // 파일은 서버의 업로드 폴더에 올라가고, 보낼 때 경로가 프롬프트에 붙여넣어진다.
    const attachTray = $('#attachTray');
    const fileInput = $('#fileInput');
    const dropOverlay = $('#dropOverlay');
    const attachments = new Map(); // 창 키 → 첨부 목록
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
      if (!key) { toast('먼저 첨부할 창을 선택하세요.', 'warn'); return; }
      exitDirect();
      const list = attachList(key);
      let added = 0;
      for (const file of fileList) {
        if (list.length >= MAX_ATTACH) { toast(`첨부는 한 번에 ${MAX_ATTACH}개까지 가능합니다.`, 'warn'); break; }
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
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        item.xhr = xhr;
        xhr.open('POST', '/api/uploads');
        xhr.setRequestHeader('X-Filename', encodeURIComponent(item.name));
        xhr.setRequestHeader('Content-Type', item.type || 'application/octet-stream');
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) { item.progress = event.loaded / event.total; updateChip(item); }
        };
        xhr.onload = () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText); } catch (e) { /* noop */ }
          if (xhr.status === 401) { location.href = '/login'; return; }
          if (xhr.status >= 200 && xhr.status < 300) {
            Object.assign(item, { status: 'done', id: data.id, path: data.path, progress: 1 });
          } else {
            Object.assign(item, { status: 'error', error: data.detail || `업로드 실패 (${xhr.status})` });
            toast(`${item.name}: ${item.error}`, 'error');
          }
          updateChip(item);
          resolve(item);
        };
        xhr.onerror = () => { Object.assign(item, { status: 'error', error: '네트워크 오류' }); updateChip(item); resolve(item); };
        xhr.onabort = () => { item.status = 'aborted'; resolve(item); };
        xhr.send(item.file);
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
          <button type="button" class="attach-remove" data-remove="${item.local}" aria-label="${escapeHtml(item.name)} 첨부 취소"><i class="fas fa-xmark"></i></button>
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

    // 붙여넣기: 스크린샷 등 클립보드의 파일/이미지
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
    document.addEventListener('paste', (event) => {
      if (event.target === input || event.target.closest?.('input, textarea, .tdx-sheet') || !isTermVisible()) return;
      const files = pastedFiles(event);
      if (files.length) { event.preventDefault(); addFiles(files); }
    });

    // 드래그앤드롭: 터미널 영역에 놓으면 현재 창에, 목록의 창 위에 놓으면 그 창에 첨부
    let dragDepth = 0;
    const draggingFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    function showDrop(event) {
      if (event.target.closest?.('[data-explorer]') || document.body.classList.contains('file-open')) { dropOverlay.classList.add('hidden'); return; }
      const item = event.target.closest?.('.win-item');
      $$('.win-item.drop-target').forEach((el) => { if (el !== item) el.classList.remove('drop-target'); });
      if (item) { item.classList.add('drop-target'); dropOverlay.classList.add('hidden'); return; }
      if (state.selectedKey && isTermVisible()) {
        const w = currentWindow();
        $('#dropTarget').textContent = w ? `${displayName(w)} 창에 첨부` : '';
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
      if (event.target.closest?.('[data-explorer]') || document.body.classList.contains('file-open')) return;  // 파일 탭 업로드는 Explorer 가 처리
      const files = Array.from(event.dataTransfer.files || []);
      if (!files.length) return;
      if (item) select(item.dataset.key);
      addFiles(files);
    });
    window.addEventListener('blur', hideDrop);

    // ── 입력: 특수 키 ──
    const keyBar = $('#keyBar');
    // 누르는 순간 포커스를 뺏지 않아야 모바일 키보드가 내려가지 않는다.
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

    // ── 입력: 직접 입력 모드 (키 하나하나를 그대로 터미널로) ──
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
      toast('직접 입력 모드: 누르는 키가 바로 터미널로 전달됩니다.', 'info', null, 2400);
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
    // 모바일 키보드는 keydown 대신 input/composition 이벤트만 주는 경우가 많아서, 입력 받개에
    // 보이지 않는 문자(SENTINEL)를 채워 두고 값의 변화로 입력을 알아낸다. 비어 있으면 Android 에서
    // 백스페이스 이벤트가 오지 않기 때문이다.
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
      banner.innerHTML = `<i class="fas fa-keyboard"></i> 입력 중: <span class="font-mono">${escapeHtml(event.data || '')}</span>`;
    });
    direct.addEventListener('compositionend', () => {
      banner.innerHTML = bannerIdle;
      setTimeout(flushDirect, 0);
    });

    // ── 채팅 (에이전트 세션 로그) ──
    // Claude Code 는 alternate screen 이라 tmux 스크롤백이 없다. 세션 로그를 읽어 전체 대화를 보여준다.
    const logScroll = $('#logScroll');
    const logList = $('#logList');
    const logOlder = $('#logOlder');
    const LOG_PAGE = 80;
    const log = { pane: null, start: 0, total: 0, rendered: new Map(), timer: null, loading: false, available: true };
    // 에이전트 창은 채팅이 기본 (예전 저장값 term-mode 는 무시하고 새 키 사용)
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
      // 채팅 모드에서는 터미널 직접 입력(⌨) 버튼을 숨긴다
      if (mode === 'log') exitDirect();
      $('#directBtn').classList.toggle('hidden', mode === 'log');
      jumpBtn.classList.add('hidden');
      clearInterval(log.timer);
      log.timer = null;
      if (mode === 'log') {
        if (log.pane !== state.paneId) loadLatestLog();
        else { pollLog(); subscribeLog(); }
        // 실시간은 WebSocket 으로 밀려온다. 연결이 끊겼을 때를 위한 느린 확인만 남긴다.
        log.timer = setInterval(() => { if (document.visibilityState === 'visible' && !socket.open) pollLog(); }, 6000);
      } else {
        socket.send({ t: 'logunsub' });
      }
    }
    // 서버가 세션 로그 파일이 바뀌는 즉시(0.4초 주기) 새 항목을 보내 준다
    function subscribeLog() {
      if (state.paneId && log.pane === state.paneId && log.available) socket.send({ t: 'logsub', pane: state.paneId, since: log.total });
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
      return date.toLocaleString('ko-KR', today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function mdLite(text) {
      return String(text).split('```').map((part, index) => {
        if (index % 2) return `<pre class="md-code">${escapeHtml(part.replace(/^[\w+.-]*\n/, ''))}</pre>`;
        return escapeHtml(part)
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
          .replace(/^(#{1,6}) (.+)$/gm, '<span class="md-h">$2</span>');
      }).join('');
    }
    const TOOL_ICONS = { Bash: 'fa-terminal', exec_command: 'fa-terminal', shell: 'fa-terminal', Read: 'fa-file-lines', Edit: 'fa-pen', Write: 'fa-file-pen', MultiEdit: 'fa-pen', apply_patch: 'fa-pen', Grep: 'fa-magnifying-glass', Glob: 'fa-folder-open', WebFetch: 'fa-globe', WebSearch: 'fa-globe', Agent: 'fa-robot', Task: 'fa-robot', TodoWrite: 'fa-list-check' };
    function logItemHtml(item) {
      const agentName = { claude: 'Claude', codex: 'Codex' }[log.agent] || 'Agent';
      if (item.kind === 'user') {
        return `<div class="msg msg-user"><div class="msg-meta">나 · ${escapeHtml(logTime(item.ts))}</div><div class="msg-body">${escapeHtml(item.text)}</div></div>`;
      }
      if (item.kind === 'assistant') {
        return `<div class="msg msg-ai"><div class="msg-meta">${agentName} · ${escapeHtml(logTime(item.ts))}<button type="button" class="copy-btn" data-copy="${item.id}" aria-label="복사"><i class="far fa-copy"></i></button></div><div class="msg-body">${mdLite(item.text)}</div></div>`;
      }
      if (item.kind === 'system') return `<div class="msg-system">${escapeHtml(item.text)}</div>`;
      const pending = item.output === null || item.output === undefined;
      const stateIcon = pending ? '<i class="fas fa-circle-notch fa-spin text-slate-400"></i>' : item.error ? '<i class="fas fa-xmark"></i>' : '<i class="fas fa-check"></i>';
      return `<details class="msg-tool ${item.error ? 'error' : ''}"><summary><i class="fas ${TOOL_ICONS[item.name] || 'fa-wrench'} text-slate-500 text-[11px]"></i>
          <span class="tool-name">${escapeHtml(item.name)}</span><span class="tool-sum">${escapeHtml(item.summary || '')}</span><span class="tool-state">${stateIcon}</span></summary>
          ${pending ? '' : `<pre>${escapeHtml(item.output || '(출력 없음)')}</pre>`}</details>`;
    }
    function logAtBottom() { return logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight < 60; }
    function renderLogOlder() {
      logOlder.classList.toggle('hidden', log.start <= 0);
      logOlder.innerHTML = log.loading ? '<i class="fas fa-circle-notch fa-spin"></i> 이전 대화를 불러오는 중' : `<button type="button">이전 대화 ${log.start}개 더 보기</button>`;
    }
    function upsertLogItems(items, { prepend = false } = {}) {
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
      if (prepend) logList.prepend(...nodes); else logList.append(...nodes);
    }
    async function fetchLog(params) {
      const query = new URLSearchParams({ pane: state.paneId, ...params });
      return api('GET', `/api/transcript?${query}`);
    }
    async function loadLatestLog() {
      const pane = state.paneId;
      if (!pane) return;
      log.pane = pane;
      log.rendered.clear();
      log.queued = [];
      chatPending.innerHTML = '';
      lastStatusKey = '';
      chatStatus.classList.add('hidden');
      logList.innerHTML = '<div class="log-empty"><i class="fas fa-circle-notch fa-spin"></i> 채팅을 불러오는 중...</div>';
      logOlder.classList.add('hidden');
      try {
        const data = await fetchLog({ limit: LOG_PAGE });
        if (pane !== state.paneId) return;
        log.available = data.available;
        log.agent = data.agent;
        logList.innerHTML = '';
        if (!data.available) {
          logList.innerHTML = '<div class="log-empty">이 창의 채팅(에이전트 세션 로그)을 찾지 못했습니다.<br>Claude Code · Codex 가 실행 중인 창에서만 볼 수 있어요.</div>';
          return;
        }
        log.start = data.start;
        log.total = data.total;
        log.queued = data.queued || [];
        renderPending();
        if (!data.items.length) logList.innerHTML = '<div class="log-empty">아직 대화가 없습니다.</div>';
        upsertLogItems(data.items);
        renderLogOlder();
        logScroll.scrollTop = logScroll.scrollHeight;
        subscribeLog();
      } catch (error) {
        logList.innerHTML = `<div class="log-empty">${escapeHtml(error.message)}</div>`;
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
        logScroll.scrollTop = logScroll.scrollHeight - fromBottom;  // 보던 위치 유지
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        log.loading = false;
        renderLogOlder();
      }
    }
    async function pollLog() {
      if (log.pane !== state.paneId || !log.available || log.loading) return;
      const pane = state.paneId;
      try {
        // 끝부분 몇 개를 다시 받아 도구 실행 결과처럼 나중에 채워지는 항목도 갱신한다.
        const data = await fetchLog({ start: Math.max(log.start, log.total - 12), limit: 300 });
        if (pane !== state.paneId) return;
        applyLogData(data);
      } catch (error) { /* 다음 주기에 다시 시도 */ }
    }
    // ── 대기열 / 보내는 중 말풍선 ──
    const chatPending = $('#chatPending');
    const chatStatus = $('#chatStatus');
    log.queued = [];
    log.optimistic = [];
    const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
    function addOptimistic(text) {
      if (modeFor(currentWindow()) !== 'log') return null;
      const entry = { text, at: Date.now(), pane: state.paneId };
      log.optimistic.push(entry);
      renderPending();
      logScroll.scrollTop = logScroll.scrollHeight;
      return entry;
    }
    function removeOptimistic(entry) {
      log.optimistic = log.optimistic.filter((item) => item !== entry);
      renderPending();
    }
    function renderPending() {
      const now = Date.now();
      // 로그(대기열 또는 대화)에 나타났거나 20초가 지난 "보내는 중" 은 지운다
      const seen = (text) => log.queued.some((q) => sameText(q, text))
        || [...log.rendered.values()].slice(-20).some(({ item }) => item.kind === 'user' && sameText(item.text, text));
      log.optimistic = log.optimistic.filter((item) => item.pane === state.paneId && now - item.at < 20000 && !seen(item.text));
      const bubble = (text, badge) => `<div class="msg msg-user pending"><div class="msg-meta">${badge}</div><div class="msg-body">${escapeHtml(text)}</div></div>`;
      chatPending.innerHTML = [
        ...log.queued.map((text) => bubble(text, '<i class="fas fa-hourglass-half"></i> 대기 중 · 지금 작업이 끝나면 전달돼요')),
        ...log.optimistic.map((item) => bubble(item.text, '<i class="fas fa-circle-notch fa-spin"></i> 보내는 중')),
      ].join('');
    }
    setInterval(() => { if (log.optimistic.length) renderPending(); }, 2000);

    // ── 에이전트 상태 카드: 터미널 화면에서 상태 줄 / 선택 질문을 읽어 채팅 하단에 보여준다 ──
    const STATUS_LINE = /^\s*[✻✽✶✢✳✺✹✷·*•◦●⠀-⣿]\s+(\S.*)$/;
    const OPTION_LINE = /^\s*[❯›>]?\s*(\d{1,2})\.\s+(.+?)\s*$/;
    function chatStatusFrom(screen, w) {
      const lines = screen.content.split('\n').slice(-Math.max(1, screen.height)).map((line) => plainText(line));
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();  // 화면 아래 빈 줄 제거
      if (w.status === 'waiting') {
        let first = -1;
        for (let i = lines.length - 1; i >= 0; i--) if (/^\s*[❯›]\s*1\.\s/.test(lines[i])) { first = i; break; }
        if (first < 0) for (let i = lines.length - 1; i >= 0; i--) if (/^\s*1\.\s/.test(lines[i])) { first = i; break; }
        if (first < 0) return { kind: 'waiting', question: '응답이 필요해요. 터미널 탭에서 확인하세요.', options: [] };
        const options = [];
        for (let i = first; i < lines.length; i++) {
          const m = lines[i].match(OPTION_LINE);
          if (m) options.push({ key: m[1], label: m[2].replace(/[│|]\s*$/, '').trim(), cursor: /^\s*[❯›>]/.test(lines[i]) });
          else if (options.length && lines[i].trim() && !/^\s{3,}/.test(lines[i])) break;
        }
        // 선택지 위쪽을 구분선(────)이나 상자 테두리가 나올 때까지 모은다 (명령어 · 파일 경로 등 무엇을 허락하는지)
        const question = [];
        for (let i = first - 1; i >= 0 && question.length < 12; i--) {
          const line = lines[i].replace(/^[\s│╭╮╰╯]+|[\s│╭╮╰╯]+$/g, '');
          if (/^[─━═╌-]{6,}$/.test(line)) break;
          if (line) question.unshift(line);
          else if (question.length && question[0] !== '') question.unshift('');
        }
        while (question.length && !question[0]) question.shift();
        return { kind: 'waiting', question: question.join('\n'), options };
      }
      if (w.status === 'busy') {
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
          const m = lines[i].match(STATUS_LINE);
          if (m && (/…|\.\.\./.test(m[1]) || /interrupt/i.test(m[1])) && !/^⏵/.test(lines[i].trim())) return { kind: 'busy', text: m[1].trim(), live: liveOutput(lines, i) };
        }
        return { kind: 'busy', text: '작업 중…', live: '' };
      }
      return null;
    }
    // 에이전트는 답변 한 덩어리가 끝나야 세션 로그에 쓰므로, 쓰는 중인 내용은 화면에서 바로 보여준다.
    // 상태 줄(✻ … ) 바로 위, 마지막 사용자 입력(> …) 이후의 출력 몇 줄.
    const LIVE_LINES = 14;
    function liveOutput(lines, statusIndex) {
      let start = Math.max(0, statusIndex - 40);
      for (let i = statusIndex - 1; i >= start; i--) {
        if (/^\s*>\s/.test(lines[i]) || /^[─━═]{6,}/.test(lines[i].trim())) { start = i + 1; break; }
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
      const key = JSON.stringify(status);
      if (key === lastStatusKey) return;
      lastStatusKey = key;
      const stick = logAtBottom();
      if (!status) { chatStatus.classList.add('hidden'); chatStatus.innerHTML = ''; return; }
      chatStatus.classList.remove('hidden');
      chatStatus.className = `chat-status ${status.kind}`;
      if (status.kind === 'busy') {
        const showLive = status.live && store.get('chat-live', true);
        chatStatus.innerHTML = `<div class="chat-status-row"><i class="fas fa-circle-notch fa-spin"></i><span class="chat-status-text">${escapeHtml(status.text)}</span>
          ${status.live ? `<button type="button" class="chat-live-toggle" data-live-toggle title="실시간 출력 ${showLive ? '접기' : '펼치기'}"><i class="fas fa-chevron-${showLive ? 'down' : 'up'}"></i></button>` : ''}
          <button type="button" data-status-keys="Escape" title="작업 중단 (Esc)">중단</button></div>
          ${showLive ? `<pre class="chat-live">${escapeHtml(status.live)}</pre>` : ''}`;
      } else {
        chatStatus.innerHTML = `<div class="chat-status-head"><i class="fas fa-hand"></i> 응답이 필요해요</div>
          ${status.question ? `<div class="chat-status-question">${escapeHtml(status.question)}</div>` : ''}
          <div class="chat-status-options">${status.options.map((o) => `<button type="button" data-status-text="${escapeHtml(o.key)}"><b>${escapeHtml(o.key)}</b> ${escapeHtml(o.label)}</button>`).join('')}
          <button type="button" data-status-keys="Escape" class="muted">Esc</button></div>`;
      }
      if (stick) logScroll.scrollTop = logScroll.scrollHeight;
    }
    chatStatus.addEventListener('click', (event) => {
      if (!event.target.closest('[data-live-toggle]')) return;
      store.set('chat-live', !store.get('chat-live', true));
      lastStatusKey = '';
      if (lastScreen) updateChatStatus(lastScreen);
    });
    // 선택지 고르기: Claude 는 번호 키, Codex 목록(/model 등)은 번호가 안 먹어서 화살표로 옮긴 뒤 Enter
    function optionKeys(status, key, agent) {
      if (agent !== 'codex' || !status?.options?.length) return null;
      const target = status.options.findIndex((o) => o.key === key);
      const from = Math.max(0, status.options.findIndex((o) => o.cursor));
      if (target < 0) return null;
      const step = target - from;
      return [...Array(Math.abs(step)).fill(step > 0 ? 'Down' : 'Up'), 'Enter'];
    }
    chatStatus.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-status-text], [data-status-keys]');
      if (!button || !state.paneId) return;
      vibrate(8);
      try {
        const w = currentWindow();
        const keys = button.dataset.statusText && lastScreen ? optionKeys(chatStatusFrom(lastScreen, w), button.dataset.statusText, agentOf(w)) : null;
        if (keys) await socket.send({ t: 'keys', pane: state.paneId, keys }, { ack: true });
        else if (button.dataset.statusText) await socket.send({ t: 'text', pane: state.paneId, text: button.dataset.statusText }, { ack: true });
        else await socket.send({ t: 'keys', pane: state.paneId, keys: [button.dataset.statusKeys] }, { ack: true });
      } catch (error) { toast(error.message, 'error'); }
    });

    function applyLogData(data) {
      if (log.pane !== state.paneId || log.loading) return;
      if (Array.isArray(data.queued)) { log.queued = data.queued; }
      const stick = logAtBottom();
      if (data.total < log.total) { loadLatestLog(); return; }  // 세션이 바뀜 (/clear 등)
      const items = data.items.filter((item) => item.id >= log.start);
      const hasNew = items.some((item) => !log.rendered.has(item.id));
      if (hasNew) logList.querySelector('.log-empty')?.remove();
      upsertLogItems(items);
      log.total = Math.max(log.total, data.total);
      renderPending();
      if (stick) logScroll.scrollTop = logScroll.scrollHeight;
      else if (hasNew) jumpBtn.classList.remove('hidden');
    }
    socket.on('log', (message) => {
      if (message.pane !== state.paneId || modeFor(currentWindow()) !== 'log') return;
      applyLogData(message);
    });
    logScroll.addEventListener('scroll', () => {
      if (logScroll.scrollTop < 120) loadOlderLog();
      if (logAtBottom()) jumpBtn.classList.add('hidden');
    }, { passive: true });
    logOlder.addEventListener('click', loadOlderLog);
    logList.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-copy]');
      if (!button) return;
      const entry = log.rendered.get(Number(button.dataset.copy));
      try { await navigator.clipboard.writeText(entry.item.text); toast('복사했습니다.', 'ok', null, 1200); } catch (e) { toast('복사하지 못했습니다 (HTTPS 에서만 가능).', 'error'); }
    });

    // ── 빠른 문구 & 최근 기록 ──
    function remember(text) {
      const recent = store.get('recent', []).filter((t) => t !== text);
      recent.unshift(text);
      store.set('recent', recent.slice(0, 100));
    }
    const DEFAULT_SNIPPETS = ['계속 진행해줘', '커밋해줘', '테스트 돌려서 확인해줘', '/compact', '/clear'];
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
            ${removable ? `<button type="button" class="snippet-del" data-del="${index}" aria-label="삭제"><i class="fas fa-xmark"></i></button>` : ''}</div>`).join('');
      const label = (text) => `<p class="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider opacity-50">${text}</p>`;
      openSheet(`${sheetHead('히스토리', '탭하면 입력창에 넣습니다. 길게 눌러 바로 보내기.')}
        <div class="sheet-actions">
          ${label('최근 보낸 프롬프트')}${recent.length ? rows(recent, false) : '<p class="px-3 py-2 text-xs opacity-60">아직 보낸 프롬프트가 없습니다.</p>'}
          <div class="sheet-sep"></div>${label('빠른 문구')}
          ${rows(snippets, true) || '<p class="px-3 py-2 text-xs opacity-60">저장된 문구가 없습니다.</p>'}
          <button type="button" class="sheet-action" data-add><i class="fas fa-plus lead"></i><span>${input.value.trim() ? '지금 입력한 내용을 문구로 저장' : '새 문구 추가'}</span></button>
        </div>
        <div class="sheet-buttons"><button type="button" class="sheet-cancel" data-close>닫기</button></div>`, (body) => {
        body.querySelector('[data-close]').addEventListener('click', closeSheet);
        const textOf = (button) => (button.dataset.kind === 's' ? snippets : recent)[Number(button.dataset.textIndex)];
        body.querySelectorAll('[data-text-index]').forEach((button) => {
          button.addEventListener('click', () => { closeSheet(); insertText(textOf(button)); });
        });
        attachLongPress(body, '[data-text-index]', async (button) => {
          const text = textOf(button);
          closeSheet();
          if (!state.paneId) return;
          try { await socket.send({ t: 'prompt', pane: state.paneId, text, submit: true }, { ack: true }); remember(text); toast('보냈습니다.', 'ok', null, 1500); } catch (error) { toast(error.message, 'error'); }
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
            toast('문구로 저장했습니다.', 'ok', null, 1500);
            closeSheet();
            return;
          }
          formSheet({
            title: '새 문구', fields: [{ name: 'text', label: '문구', placeholder: '예: 변경사항 요약해줘', maxlength: 2000 }], submitLabel: '추가',
            onSubmit(values) {
              const text = values.text.trim();
              if (!text) throw new Error('문구를 입력하세요.');
              store.set('snippets', [text, ...snippets.filter((s) => s !== text)].slice(0, 30));
            },
          });
        });
      });
    }
    $('#snippetBtn').addEventListener('pointerdown', (event) => event.preventDefault());
    $('#snippetBtn').addEventListener('click', snippetSheet);

    // ── 초기화 ──
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
        // 새로고침으로 들어온 경우에도 뒤로 가기로 목록에 돌아올 수 있게 한다.
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
        // 에이전트가 켜지거나 꺼지면 채팅/터미널 전환 버튼도 따라 바뀐다
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
    // 라이트 ↔ 다크 전환 시 화면을 새 색으로 다시 그린다
    new MutationObserver(() => {
      const next = document.documentElement.getAttribute('data-ui-theme-mode') === 'light';
      if (next === lightTerm) return;
      lightTerm = next;
      adaptCache.clear();
      if (lastScreen) renderScreen(lastScreen);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-theme-mode'] });
    // 분할 화면의 tmux 패널이 메인과 같은 모양으로 그리도록 공개
    const renderers = {
      logItem(item, agent) { const saved = log.agent; log.agent = agent; const html = logItemHtml(item); log.agent = saved; return html; },
      chatStatus: (screen, w) => chatStatusFrom(screen, w),
      prettyModel, modelMenu, usageMarkup, sendSlash, optionKeys,
      refreshLimits: () => refreshLimits(),
    };
    return { renderList, select, closeTerm, restoreSelection, onWindowsChanged, renameKeys, currentWindow, termTabs: termTabApi, renderers };
  })();


  // ════════════════════════════════════════════════════════════════════
  // Workspace 보기 전환: 창 · 파일(Explorer)
  //  - 파일 탭에서 연 파일은 오른쪽(휴대폰은 밀려 들어오는 패널) 터미널 자리에 뜬다.
  //  - 경로를 선택한 창의 프롬프트에 바로 넣을 수 있다.
  // ════════════════════════════════════════════════════════════════════
  const wsFiles = !workspace ? null : (() => {
    const modes = { windows: $('#winMode'), files: $('#fileMode') };
    const fileView = $('#fileView');
    let tree = null;
    let viewer = null;

    function ensureTree() {
      if (tree || !window.UnivDashExplorer) return tree;
      tree = window.UnivDashExplorer.mountTree($('#wsExplorer'), { onOpen: openFile, onInsert: insertPath });
      return tree;
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
          // 마지막 파일 탭을 닫았는데 tmux 탭이 남아 있으면 그쪽으로 (공용 탭바가 전환을 맡음)
          onClose: (info) => { if (info?.reason === 'empty' && orderedTabs().length) { showFileView(false); restoreRight(); } else closeFile(); },
        });
      }
      return viewer;
    }
    // ── 공용 탭바: tmux 창 탭 + 파일 탭을 한 줄에 (종류는 아이콘 · 색으로 구분) ──
    const bar = $('#wsTabs');
    // 분할 화면 상태 (최대 2×2): 칸마다 어느 그룹인지 · 그룹별 탭(순서)과 보고 있는 탭
    let layout = store.get('ws-layout', null);          // [[tl, tr], [bl, br]] 그룹 id ('main' | 's1' | 's2' | 's3')
    let groupState = store.get('ws-groups', {});         // { s1: { items: [...], active } }
    const groups = {};                                   // 화면에 만든 두 번째 이후 그룹들
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
      // 아직 불러오지 않은 쪽(창 목록 · 파일 뷰어)의 탭은 자리를 지킨다 (로딩 중에 순서가 흐트러지지 않게)
      const loaded = (id) => (id.startsWith('term:') ? state.windows.length > 0 : id.startsWith('pty:') ? ptyLoaded : !!viewer);
      const next = tabOrder.filter((id) => ids.has(id) || !loaded(id));
      for (const tab of tabs) {
        if (next.includes(tab.id)) continue;
        const at = next.indexOf(lastActive);   // 새 탭은 보고 있던 탭 오른쪽에
        next.splice(at < 0 ? next.length : at + 1, 0, tab.id);
      }
      if (next.join('\n') !== tabOrder.join('\n')) { tabOrder = next; store.set('ws-tab-order', tabOrder); }
      const byId = new Map(tabs.map((t) => [t.id, t]));
      return next.filter((id) => byId.has(id)).map((id) => byId.get(id));
    }
    // 두 번째 그룹(분할)으로 옮긴 tmux · Terminal 탭은 메인 탭바에서 뺀다 (파일은 그룹마다 뷰어가 따로)
    const inSide = (id) => Object.values(groups).some((g) => g.items.includes(id));
    function mainTabs() { return orderedTabs().filter((t) => !inSide(t.id)); }
    function renderBar() {
      if (!bar) return;
      const tabs = mainTabs();
      const active = activeId();
      bar.classList.toggle('hidden', !tabs.length && !isSplit());
      $('#termPane').classList.toggle('has-tabs', tabs.length > 0);
      bar.innerHTML = tabs.map((t) => tabHtml(t, t.id === active)).join('');
      lastActive = active;
      bar.querySelector('.wt.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    function tabHtml(t, on) {
      {
        const close = (label) => `<button type="button" class="wt-close" data-close aria-label="${escapeHtml(label)} 탭 닫기"><i class="fas fa-xmark"></i></button>`;
        if (t.type === 'term') {
          const w = t.w;
          const unread = !on && w.activity > (state.seen[w.key] || 0);
          return `<div class="wt wt-term ${on ? 'active' : ''}" role="tab" aria-selected="${on}" data-id="${escapeHtml(t.id)}" title="${escapeHtml(`tmux 세션 · ${w.session}:${w.index} · ${w.path}`)}">
              <span class="wt-kind" aria-label="tmux"><i class="fas fa-terminal"></i></span><span class="status-dot ${w.status}"></span>
              <span class="wt-name">${escapeHtml(displayName(w))}</span>${unread ? '<span class="tt-unread"></span>' : ''}${close(displayName(w))}</div>`;
        }
        if (t.type === 'pty') {
          const name = ptyName(t.p);
          return `<div class="wt wt-pty ${on ? 'active' : ''} ${t.p.dead ? 'dead' : ''}" role="tab" aria-selected="${on}" data-id="${escapeHtml(t.id)}" title="${escapeHtml(`Terminal · ${t.p.cwd}`)}">
              <span class="wt-kind pty" aria-label="Terminal">$</span><span class="wt-name">${escapeHtml(name)}</span>${close(name)}</div>`;
        }
        const anyViewer = viewer || Object.values(groups).find((g) => g.viewer)?.viewer;
        const icon = anyViewer?.iconFor(t.tab) || '<i class="far fa-file"></i>';
        return `<div class="wt wt-file ${on ? 'active' : ''}" role="tab" aria-selected="${on}" data-id="${escapeHtml(t.id)}" title="${escapeHtml(`파일 · ${t.path}`)}">
            ${icon}<span class="wt-name">${t.tab.dirty ? '<b class="exv-dirty">●</b>' : ''}${escapeHtml(t.tab.name)}</span>${close(t.tab.name)}</div>`;
      }
    }
    function activate(tab) {
      if (!tab) return;
      if (tab.type === 'term') workspace.select(tab.key, { pushHistory: false });
      else if (tab.type === 'pty') showPty(tab.ptyId);
      else openFile({ path: tab.path, name: tab.tab.name, ext: tab.tab.ext, type: 'file' });
    }
    async function closeTab(id) {
      const tabs = mainTabs();
      const index = tabs.findIndex((t) => t.id === id);
      if (index < 0) return;
      const tab = tabs[index];
      const neighbour = id === activeId() ? (tabs[index + 1] || tabs[index - 1]) : null;
      if (tab.type === 'file' && tab.tab.dirty) {
        if (!(await viewer.closeTab(tab.path))) return;          // 저장 안 한 변경: 확인 후 닫기
        if (neighbour) activate(neighbour);
      } else {
        if (neighbour) activate(neighbour);                        // 먼저 옆 탭으로 넘어간 뒤 닫는다
        if (tab.type === 'file') await viewer.closeTab(tab.path);
        else if (tab.type === 'pty') closePty(tab.ptyId, { hasNeighbour: !!neighbour });
        else workspace.termTabs.close(tab.key);
      }
      renderBar();
    }
    bar?.addEventListener('click', (event) => {
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

    // ── Terminal (tmux 아님) ─────────────────────────────────────────
    // 셸은 서버에 살아 있어 새로고침해도 다시 붙는다. 탭을 닫으면(×) 셸도 바로 끝난다.
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
      if (client && client.el.parentElement !== ptyHost) ptyHost.appendChild(client.el);   // 두 번째 그룹에서 돌아온 경우
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
    function closePty(id, { hasNeighbour = false } = {}) {
      const p = ptys.get(id);
      if (!p) return;
      ptys.delete(id);
      savePtyTabs();
      p.client?.dispose();
      window.UnivDashPty?.kill(id);         // 탭을 닫으면 셸도 끝낸다
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
    // 시작: 서버에 살아 있는 터미널 중 이 기기에서 열어 둔 것만 탭으로 되살린다
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
    window.UnivDashWs = { newTerminal };
    // 단축키 (입력 중이 아닐 때): w/ㅈ 지금 탭 닫기 · 1~9 N번째 탭 · ←/→ 이전/다음 탭
    document.addEventListener('keydown', (event) => {
      const { plainKey, typingOrBusy } = window.UnivDash;
      if (typingOrBusy(event)) return;
      // 분할 중이면 마지막으로 누른 그룹에 적용
      const g = focusGroup !== 'main' && isSplit() ? groups[focusGroup] : null;
      const side = !!g;
      const tabs = g ? tabsOf(g) : mainTabs();
      const id = g ? g.active : activeId();
      const go = (tab) => { if (tab && tab.id !== id) { if (g) showIn(g, tab.id); else activate(tab); } };
      const index = tabs.findIndex((t) => t.id === id);
      if (plainKey(event, 'KeyW')) {
        if (index < 0) return;
        event.preventDefault();
        if (side) closeTabIn(g, id); else closeTab(id);
        return;
      }
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && plainKey(event, event.code)) {
        const tab = tabs[Number(digit[1]) - 1];
        if (!tab) return;
        event.preventDefault();
        go(tab);
        return;
      }
      if ((plainKey(event, 'ArrowLeft') || plainKey(event, 'ArrowRight')) && tabs.length > 1) {
        event.preventDefault();
        const step = event.code === 'ArrowRight' ? 1 : -1;
        go(tabs[((index < 0 ? 0 : index + step) + tabs.length) % tabs.length]);
      }
    });

    // ════════════════════════════════════════════════════════════════
    // 분할 화면 (최대 2×2 · 4개, VS Code 처럼): 탭을 끌어 어떤 그룹의 가장자리에 놓으면 그 그룹 영역을 반으로 나눈다.
    //  - 배치는 2×2 칸 표(layout)로 저장: 칸마다 그룹 id. 그룹을 없애면 이웃 그룹이 그 칸을 넘겨받는다.
    //  - 메인 그룹은 기존 화면(전체 기능), 나머지 그룹은 파일 뷰어 · Terminal · tmux 실시간 화면(+빠른 입력).
    //  - 좌우 사이드바와는 무관하게 가운데 편집 영역 안에서만 나뉜다.
    // ════════════════════════════════════════════════════════════════
    const editorArea = $('#editorArea');
    const GROUP_IDS = ['s1', 's2', 's3'];
    const sfileId = (path) => `sfile:${path}`;
    const FULL = () => [['main', 'main'], ['main', 'main']];
    if (!Array.isArray(layout) || layout.length !== 2) layout = FULL();
    // 예전 한 칸 분할(ws-split) 상태를 새 형식으로 옮긴다
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
      const v = rows.size === 2 ? '' : rows.has(0) ? '위' : '아래';
      const h = cols.size === 2 ? '' : cols.has(0) ? '왼쪽' : '오른쪽';
      return `${h} ${v}`.trim() || '전체';
    }

    // ── 그룹 만들기 · 없애기 ──
    function createGroup(id) {
      if (groups[id]) return groups[id];
      const el = document.createElement('section');
      el.className = 'side-pane';
      el.dataset.group = id;
      el.style.gridArea = id;
      el.setAttribute('aria-label', '분할 화면');
      el.innerHTML = `
        <div class="side-bar">
          <div class="ws-tabbar no-scrollbar" role="tablist"></div>
          <button type="button" class="side-bar-btn" data-g-close title="이 분할 닫기 (탭은 메인 그룹으로)" aria-label="분할 닫기"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="side-host">
          <div class="side-view g-file hidden"></div>
          <div class="side-view g-pty pty-host hidden"></div>
          <div class="side-view g-mirror hidden"></div>
          <div class="side-view side-empty"><i class="fas fa-table-columns"></i><p>탭을 여기로 끌어다 놓으세요.</p></div>
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
      el.addEventListener('pointerdown', () => { focusGroup = id; }, true);
      if (window.Sortable) sortableFor(g.bar, id);
      return g;
    }
    // 그룹을 없애고 그 칸을 직사각형이 되는 이웃 그룹에게 넘긴다
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

    // ── 그룹의 탭 ──
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
      if (activeTerm && g.mirror?.key === activeTerm.key) g.mirror.update(activeTerm.w);   // 상태 점 · 제목 갱신
      g.bar.innerHTML = tabs.map((t) => tabHtml(t, t.id === g.active)).join('');
      if (!g.el.isConnected || !isSplit()) return;
      if (!sourcesLoaded(g.active)) return;                 // 새로고침 직후: 불러온 뒤에 연다
      if (!tabs.some((t) => t.id === g.active)) g.active = tabs[0]?.id || null;
      if (!g.active) { hideGroupViews(g); g.el.querySelector('.side-empty').classList.remove('hidden'); g.shown = null; return; }
      if (g.shown !== g.active) showIn(g, g.active);
    }
    function renderGroups() {
      Object.values(groups).forEach((g) => renderGroup(g));
      applyLayout();
    }
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
    }

    // ── 탭 옮기기: from/to 는 'main' 또는 그룹 id ──
    const findTab = (from, id) => (from === 'main' ? mainTabs() : tabsOf(groups[from] || { items: [] })).find((t) => t.id === id);
    async function moveTab(tab, from, to, { show = true } = {}) {
      if (!tab || from === to) return;
      const entry = tab.type === 'file' ? { path: tab.path, name: tab.tab.name, ext: tab.tab.ext, type: 'file' } : null;
      // 1) 원래 그룹에서 빼기 (보고 있던 탭이면 옆 탭으로)
      if (from === 'main') {
        const mains = mainTabs();
        const index = mains.findIndex((t) => t.id === tab.id);
        const neighbour = tab.id === activeId() ? (mains[index + 1] || mains[index - 1]) : null;
        if (tab.type !== 'file' && to !== 'main') groups[to]?.items.push(tab.id);   // 메인 목록에서 먼저 빠지게
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
      // 2) 새 그룹에 넣기
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
      // 3) 빈 그룹은 없앤다
      if (from !== 'main' && groups[from] && !groups[from].items.length) removeGroup(from);
      saveLayout();
      renderBar();
      renderGroups();
    }
    // target 그룹의 edge 쪽 반을 새 그룹으로 나누고 탭을 옮긴다
    // target 그룹 영역의 edge 쪽 반에 새 그룹을 만든다 (만든 그룹 id, 못 만들면 null)
    function makeGroupAt(target, edge) {
      if (!desktopQuery.matches || !canSplit(target, edge)) return null;
      const id = GROUP_IDS.find((x) => !layoutIds().includes(x));
      if (!id) { toast('최대 4개까지 나눌 수 있어요.', 'info'); return null; }
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
      if (from === target && from !== 'main' && tabsOf(groups[from]).length <= 1) return;   // 하나뿐인 탭을 자기 가장자리로: 의미 없음
      const id = makeGroupAt(target, edge);
      if (id) await moveTab(tab, from, id);
    }
    // 파일을 어느 그룹에서 열기 (탐색기에서 끌어 온 파일)
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
    async function closeTabIn(g, id) {
      const tab = tabsOf(g).find((t) => t.id === id);
      if (!tab) return;
      if (tab.type === 'file') { if (!(await g.viewer.closeTab(tab.path))) return; }
      else if (tab.type === 'pty') closePty(tab.ptyId, { hasNeighbour: true });
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
    async function closeGroup(id) {
      const g = groups[id];
      if (!g) return;
      for (const tab of tabsOf(g)) await moveTab(tab, id, 'main', { show: false });
      if (groups[id]) removeGroup(id);
      renderBar();
      renderGroups();
    }
    // 새로고침 뒤: 저장된 배치대로 그룹을 다시 만든다
    function restoreGroups() {
      layoutIds().filter((id) => id !== 'main').forEach((id) => {
        const g = createGroup(id);
        if (g.items.some((x) => x.startsWith('sfile:'))) ensureGroupViewer(g);
      });
      renderGroups();
      renderBar();
    }
    $('#termPane')?.addEventListener('pointerdown', () => { focusGroup = 'main'; }, true);
    desktopQuery.addEventListener('change', () => { renderBar(); renderGroups(); });

    // ── 탭 오른쪽 클릭: 분할 · 옮기기 ──
    function tabMenu(event, group) {
      const el = event.target.closest('.wt');
      if (!el || !desktopQuery.matches) return;
      event.preventDefault();
      const tab = findTab(group, el.dataset.id);
      if (!tab) return;
      const splits = [['right', '오른쪽으로 분할', 'fa-table-columns'], ['left', '왼쪽으로 분할', 'fa-table-columns'], ['bottom', '아래로 분할', 'fa-table-cells-large'], ['top', '위로 분할', 'fa-table-cells-large']]
        .filter(([edge]) => canSplit(group, edge) && layoutIds().length < 4)
        .map(([edge, label, icon]) => ({ icon, label, onClick: () => splitWith(tab, group, group, edge) }));
      const moves = layoutIds().filter((id) => id !== group).map((id) => ({
        icon: 'fa-arrow-right-to-bracket', label: `${id === 'main' ? '메인 그룹' : '분할'} (${positionLabel(id)})으로 옮기기`, onClick: () => moveTab(tab, group, id),
      }));
      actionSheet({
        title: el.querySelector('.wt-name')?.textContent || '탭',
        actions: [
          ...splits, ...(splits.length && moves.length ? ['sep'] : []), ...moves, 'sep',
          { icon: 'fa-xmark', label: '닫기', onClick: () => (group === 'main' ? closeTab(tab.id) : closeTabIn(groups[group], tab.id)) },
          ...(group !== 'main' ? [{ icon: 'fa-table-columns', label: '이 분할 닫기', onClick: () => closeGroup(group) }] : []),
        ],
      });
    }
    bar?.addEventListener('contextmenu', (event) => tabMenu(event, 'main'));

    // ── 탭 끌어 놓기: 탭바 안에서는 순서 · 그룹 이동, 화면 위로 끌면 놓을 자리 (가장자리 = 그 그룹을 반으로 분할) ──
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
      if (!target || (dragTab && target.zone === 'center' && target.group === dragTab.group)) { highlight.style.opacity = '0'; return; }
      const area = editorArea.getBoundingClientRect();
      const { r, zone } = target;
      let [left, top, width, height] = [r.left, r.top, r.width, r.height];
      if (zone === 'left') width /= 2;
      if (zone === 'right') { left += width / 2; width /= 2; }
      if (zone === 'top') height /= 2;
      if (zone === 'bottom') { top += height / 2; height /= 2; }
      Object.assign(highlight.style, { opacity: '1', left: `${left - area.left}px`, top: `${top - area.top}px`, width: `${width}px`, height: `${height}px` });
    }
    // 탐색기의 파일을 끌어 와서 열기 · 분할해서 열기
    let dragFile = null;
    const hideZones = () => { zonesEl?.classList.add('hidden'); if (highlight) highlight.style.opacity = '0'; dropTarget = null; };
    document.addEventListener('dragstart', (event) => {
      const row = event.target.closest?.('#wsExplorer .ex-row[draggable="true"]');
      if (!row || row.dataset.type !== 'file' || !desktopQuery.matches) return;
      dragFile = { path: row.dataset.path };
      zonesEl?.classList.remove('hidden');
    });
    document.addEventListener('dragend', () => { if (dragFile || dragWin) { dragFile = null; dragWin = null; hideZones(); } });
    // 창 목록의 tmux 세션을 끌어 와서 열기 · 분할해서 열기
    let dragWin = null;
    document.addEventListener('dragstart', (event) => {
      const item = event.target.closest?.('#windowList .win-item[draggable="true"]');
      if (!item || !desktopQuery.matches) return;
      dragWin = { key: item.dataset.key };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('application/x-univdash-window', item.dataset.key);
      zonesEl?.classList.remove('hidden');
    });
    // 세션을 어느 그룹에서 열기: 이미 다른 그룹에 열려 있으면 그 탭을 옮긴다
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
        else { const id = makeGroupAt(target.group, target.zone); await openWindowIn(id || target.group, key); }
        return;
      }
      if (!dragFile) return;
      const target = dropTarget;
      const { path } = dragFile;
      dragFile = null;
      hideZones();
      if (!target) return;                 // 입력창 등: 기본 동작(경로 글자 넣기)
      event.preventDefault();
      event.stopPropagation();
      const name = path.split('/').pop();
      const dot = name.lastIndexOf('.');
      const entry = { path, name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '', type: 'file' };
      if (target.zone === 'center') openFileIn(target.group, entry);
      else { const id = makeGroupAt(target.group, target.zone); openFileIn(id || target.group, entry); }
    }, true);
    document.addEventListener('dragover', (event) => {
      if (!dragTab && !dragFile && !dragWin) return;
      // 프롬프트 입력창 위에서는 경로를 글자로 넣을 수 있게 놓을 자리를 끈다
      if (dragFile && event.target.closest?.('input, textarea, .xterm')) { dropTarget = null; showZone(null); return; }
      const target = zoneAt(event.clientX, event.clientY);
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
        onStart: (event) => {
          dragTab = { id: event.item.dataset.id, group };
          if (desktopQuery.matches) zonesEl?.classList.remove('hidden');
        },
        onEnd: async (event) => {
          if (await finishDrop()) { renderBar(); renderGroups(); return; }   // 화면 위에 놓았으면 탭바는 상태대로 다시 그린다
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
    window.addEventListener('DOMContentLoaded', () => {
      if (!window.Sortable) return;
      if (bar) sortableFor(bar, 'main');
      Object.values(groups).forEach((g) => sortableFor(g.bar, g.id));
    });

    // ── 분할 그룹의 tmux 창: 메인과 같은 머리글(채팅 | 터미널 · 사용량) · 채팅 · 화면 · 모델 · 입력 (그룹마다 자기 WebSocket) ──
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
            <button type="button" class="side-bar-btn" data-mirror-main title="메인 그룹으로 옮기기" aria-label="메인 그룹으로"><i class="fas fa-up-right-and-down-left-from-center"></i></button>
          </div>
          <div class="tp-row2">
            <div class="mode-switch tp-modes hidden" role="tablist"><button type="button" data-tpmode="log"><i class="fas fa-comments"></i> 채팅</button><button type="button" data-tpmode="screen"><i class="fas fa-terminal"></i> 터미널</button></div>
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
            <button type="button" class="model-chip tp-model hidden" title="모델 바꾸기"><i class="fas fa-microchip"></i><span>—</span></button>
            <div class="relative flex-1 min-w-0">
              <textarea rows="1" enterkeyhint="send" placeholder="프롬프트 입력" spellcheck="false" autocapitalize="off" class="prompt-input w-full glass-input rounded-2xl pl-4 pr-11 py-2.5 text-white placeholder-white/30 resize-none"></textarea>
              <button type="button" class="attach-btn" data-tp-attach title="사진 · 파일 첨부" aria-label="첨부"><i class="fas fa-paperclip"></i></button>
              <input type="file" multiple class="hidden tp-file" tabindex="-1" aria-hidden="true">
              <div class="tp-direct-banner hidden"><i class="fas fa-keyboard"></i> 직접 입력 중 · 누르는 키가 바로 터미널로 가요</div>
            </div>
            <button type="button" class="composer-btn" data-tp-direct title="터미널 직접 입력 모드" aria-pressed="false"><i class="fas fa-keyboard text-sm"></i></button>
            <button type="submit" class="send-btn btn-glow" aria-label="보내기"><i class="fas fa-paper-plane text-sm"></i></button>
          </form>
          <div class="flex items-center justify-between gap-2 px-3 md:px-4 pb-2 -mt-1 text-[10px] text-white/40">
            <div class="flex items-center gap-1 min-w-0">
              <button type="button" class="submit-toggle" data-tp-keybar></button>
              <button type="button" class="submit-toggle qs-btn" data-tp-snippet title="최근 보낸 프롬프트 · 빠른 문구" aria-label="히스토리">히스토리</button>
            </div>
            <div class="flex items-center gap-1 min-w-0">
              <span class="truncate hidden sm:inline">Enter 전송 · Shift+Enter 줄바꿈</span>
              <button type="button" class="hist-btn" data-tp-hist="1" title="이전 프롬프트 (↑)"><i class="fas fa-chevron-up"></i></button>
              <button type="button" class="hist-btn" data-tp-hist="-1" title="다음 프롬프트 (↓)"><i class="fas fa-chevron-down"></i></button>
            </div>
          </div>
        </div>
        </div>`;
      const $$in = (sel) => root.querySelector(sel);
      const logEl = $$in('.tp-log');
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
      const chat = { items: new Map(), total: 0, available: false, agent: null };
      const model = { id: null, pending: null };
      const modes = store.get('tp-modes', {});
      const modeOf = () => (w?.agent ? (modes[w.key] || 'log') : 'screen');
      const KEYS = { Esc: 'Escape', '⇧Tab': 'BTab', '↑': 'Up', '↓': 'Down', '⏎': 'Enter', '^C': 'C-c' };
      const send = (message) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
      function connect() {
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
        ws.onopen = () => { if (pane) { send({ t: 'sub', pane, history: 300 }); if (modeOf() === 'log' && chat.available) send({ t: 'logsub', pane, since: chat.total }); } };
        ws.onmessage = (event) => {
          let message;
          try { message = JSON.parse(event.data); } catch (e) { return; }
          if (message.pane !== pane) return;
          if (message.t === 'screen') { lastScreen = message; if (modeOf() === 'screen') renderScreen(); else renderStatus(); }
          else if (message.t === 'log') applyLog(message);
        };
        ws.onclose = () => { if (pane && !disposed) setTimeout(() => { if (pane && !disposed && (!ws || ws.readyState === WebSocket.CLOSED)) connect(); }, 1500); };
      }
      // 터미널 화면
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
      // 채팅 (세션 로그)
      function renderChat() {
        const items = [...chat.items.values()].sort((a, b) => a.id - b.id).slice(-200);
        listEl.innerHTML = items.length ? items.map((item) => R.logItem(item, chat.agent)).join('') : '<div class="log-empty">아직 대화가 없습니다.</div>';
        if (logStick) logEl.scrollTop = logEl.scrollHeight;
      }
      async function loadChat() {
        chat.items.clear();
        listEl.innerHTML = '<div class="log-empty"><i class="fas fa-circle-notch fa-spin"></i> 채팅을 불러오는 중...</div>';
        const forPane = pane;
        try {
          const data = await api('GET', `/api/transcript?pane=${encodeURIComponent(pane)}&limit=80`);
          if (forPane !== pane) return;
          chat.available = data.available;
          chat.agent = data.agent;
          if (!data.available) { listEl.innerHTML = '<div class="log-empty">이 창의 채팅(에이전트 세션 로그)을 찾지 못했습니다.</div>'; return; }
          data.items.forEach((item) => chat.items.set(item.id, item));
          chat.total = data.total;
          logStick = true;
          renderChat();
          send({ t: 'logsub', pane, since: chat.total });
        } catch (error) { listEl.innerHTML = `<div class="log-empty">${escapeHtml(error.message)}</div>`; }
      }
      function applyLog(data) {
        if (modeOf() !== 'log') return;
        if (data.total < chat.total) { loadChat(); return; }
        data.items.forEach((item) => chat.items.set(item.id, item));
        chat.total = Math.max(chat.total, data.total);
        renderChat();
      }
      logEl.addEventListener('scroll', () => { logStick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60; }, { passive: true });
      listEl.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-copy]');
        if (!button) return;
        const item = chat.items.get(Number(button.dataset.copy));
        try { await navigator.clipboard.writeText(item?.text || ''); toast('복사했습니다.', 'ok', null, 1200); } catch (e) { toast('복사하지 못했습니다.', 'error'); }
      });
      // 작업 중 · 응답 필요 카드 (메인과 같은 규칙)
      function renderStatus() {
        if (!lastScreen || !w || modeOf() !== 'log') { statusEl.classList.add('hidden'); return; }
        const status = R.chatStatus(lastScreen, w);
        if (!status) { statusEl.classList.add('hidden'); statusEl.innerHTML = ''; return; }
        statusEl.className = `chat-status tp-status ${status.kind}`;
        statusEl.innerHTML = status.kind === 'busy'
          ? `<div class="chat-status-row"><i class="fas fa-circle-notch fa-spin"></i><span class="chat-status-text">${escapeHtml(status.text)}</span><button type="button" data-status-keys="Escape">중단</button></div>${status.live ? `<pre class="chat-live">${escapeHtml(status.live)}</pre>` : ''}`
          : `<div class="chat-status-head"><i class="fas fa-hand"></i> 응답이 필요해요</div>${status.question ? `<div class="chat-status-question">${escapeHtml(status.question)}</div>` : ''}
             <div class="chat-status-options">${status.options.map((o) => `<button type="button" data-status-text="${escapeHtml(o.key)}"><b>${escapeHtml(o.key)}</b> ${escapeHtml(o.label)}</button>`).join('')}<button type="button" data-status-keys="Escape" class="muted">Esc</button></div>`;
        if (logStick) logEl.scrollTop = logEl.scrollHeight;
      }
      statusEl.addEventListener('click', (event) => {
        const button = event.target.closest('[data-status-text], [data-status-keys]');
        if (!button || !pane) return;
        const keys = button.dataset.statusText && lastScreen ? R.optionKeys(R.chatStatus(lastScreen, w), button.dataset.statusText, w?.agent) : null;
        if (keys) send({ t: 'keys', pane, keys });
        else if (button.dataset.statusText) send({ t: 'text', pane, text: button.dataset.statusText });
        else send({ t: 'keys', pane, keys: [button.dataset.statusKeys] });
      });
      // 머리글 · 모드 · 사용량 · 모델
      function applyMode() {
        const mode = modeOf();
        $$in('.tp-modes').classList.toggle('hidden', !w?.agent);
        root.querySelectorAll('[data-tpmode]').forEach((b) => b.classList.toggle('on', b.dataset.tpmode === mode));
        logEl.classList.toggle('hidden', mode !== 'log');
        screenEl.classList.toggle('hidden', mode !== 'screen');
        if (mode === 'log' && direct) setDirect(false);
        $$in('[data-tp-direct]').classList.toggle('hidden', mode === 'log');   // 채팅 모드에서는 ⌨ 숨김
        if (mode === 'log') { if (!chat.items.size && pane) loadChat(); else send({ t: 'logsub', pane, since: chat.total }); renderStatus(); }
        else { send({ t: 'logunsub' }); renderScreen(); }
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
        const pill = $$in('.tp-agent');
        pill.className = `tp-agent ${w.agent ? `agent-pill agent-${w.agent}` : 'agent-pill agent-shell'}`;   // 메인 머리글과 같은 색
        pill.textContent = w.agent || 'shell';
        const statusLabel = STATUS[w.status]?.label || '';
        $$in('.tp-sub').textContent = [statusLabel, w.title, w.path].filter(Boolean).join(' · ');
        const usage = $$in('.tp-usage');
        const html = R.usageMarkup(w.agent);
        usage.classList.toggle('hidden', !html);
        if (html) usage.innerHTML = html;
        modelEl.classList.toggle('hidden', !w.agent);
        modelEl.querySelector('span').textContent = model.pending ? `→ ${R.prettyModel(model.pending)}` : R.prettyModel(model.id);
        modelEl.classList.toggle('pending', !!model.pending);
      }
      async function refreshModel() {
        if (!pane || !w?.agent) return;
        try {
          const data = await api('GET', `/api/agent/model?pane=${encodeURIComponent(pane)}`);
          if (model.pending && data.model && data.model !== model.id) model.pending = null;
          model.id = data.model;
          renderHead();
        } catch (e) { /* noop */ }
      }
      const modelTimer = setInterval(() => { if (!disposed && pane && document.visibilityState === 'visible') { refreshModel(); R.refreshLimits().then(renderHead); } }, 15000);
      modelEl.addEventListener('click', () => {
        if (!w?.agent) return;
        R.modelMenu({
          agent: w.agent, model: model.id, busy: w.status === 'busy',
          send: (text, label) => { R.sendSlash(pane, w.agent, text, async (message) => send(message)); toast(label ? `${label} 로 바꾸는 중…` : '모델 목록이 뜨면 아래 카드에서 고르세요.', 'info'); },
          onPending: (id) => { model.pending = id; renderHead(); },
        });
      });
      // ── 입력 (메인 입력창과 같은 구성: 특수 키 · 빠른 문구 · 모델 · 첨부 · 직접 입력 · 자동 제출 · 키 접기 · 이전 프롬프트) ──
      const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
      const submit = true;
      let direct = false;
      const history = { index: -1, stash: '' };
      const attachments = [];
      const tray = $$in('.tp-tray');
      function syncToggles() {
        const collapsed = store.get('keybar-collapsed', false);
        $$in('.tp-keys').classList.toggle('hidden', collapsed);
        $$in('[data-tp-keybar]').innerHTML = collapsed ? '<i class="fas fa-chevron-up"></i> 키 펼치기' : '<i class="fas fa-chevron-down"></i> 키 접기';
      }
      syncToggles();

      $$in('[data-tp-keybar]').addEventListener('click', () => { store.set('keybar-collapsed', !store.get('keybar-collapsed', false)); syncToggles(); });
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
      $$in('[data-tp-snippet]').addEventListener('click', () => {
        const snippets = store.get('snippets', ['계속 진행해줘', '커밋해줘', '테스트 돌려서 확인해줘', '/compact', '/clear']);
        const recent = store.get('recent', []).slice(0, 20);
        const put = (text) => { input.value = input.value ? `${input.value}${input.value.endsWith('\n') ? '' : ' '}${text}` : text; autosize(); input.focus(); };
        actionSheet({
          title: '히스토리', subtitle: '누르면 입력창에 넣습니다.',
          actions: [...recent.map((t) => ({ icon: 'fa-clock-rotate-left', label: t.replace(/\s+/g, ' ').slice(0, 80), onClick: () => put(t) })), ...(recent.length ? ['sep'] : []), ...snippets.map((t) => ({ icon: 'fa-bolt', label: t, onClick: () => put(t) }))],
        });
      });
      // 첨부: 업로드해 두었다가 보낼 때 함께 (메인과 같은 /api/uploads)
      function renderTray() {
        tray.classList.toggle('hidden', !attachments.length);
        tray.classList.toggle('flex', attachments.length > 0);
        tray.innerHTML = attachments.map((a, i) => `<span class="attach-chip ${a.status}"><i class="fas ${a.status === 'error' ? 'fa-triangle-exclamation' : a.status === 'done' ? 'fa-paperclip' : 'fa-circle-notch fa-spin'}"></i><span class="truncate max-w-[140px]">${escapeHtml(a.name)}</span><button type="button" data-tp-unattach="${i}" aria-label="빼기"><i class="fas fa-xmark"></i></button></span>`).join('');
      }
      function addFiles(files) {
        for (const file of files) {
          const item = { name: file.name, status: 'uploading', id: null };
          attachments.push(item);
          item.promise = new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/uploads');
            xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
            xhr.onload = () => {
              let data = {};
              try { data = JSON.parse(xhr.responseText); } catch (e) { /* noop */ }
              if (xhr.status >= 200 && xhr.status < 300) Object.assign(item, { status: 'done', id: data.id });
              else { item.status = 'error'; toast(`${file.name}: ${data.detail || '업로드 실패'}`, 'error'); }
              renderTray(); resolve();
            };
            xhr.onerror = () => { item.status = 'error'; renderTray(); resolve(); };
            xhr.send(file);
          });
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
      // 직접 입력 모드: 누르는 키를 바로 터미널로
      const DIRECT_KEYS = { Enter: 'Enter', Backspace: 'BSpace', Tab: 'Tab', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Delete: 'DC', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
      function setDirect(on) {
        direct = on;
        $$in('[data-tp-direct]').setAttribute('aria-pressed', String(on));
        $$in('[data-tp-direct]').classList.toggle('active', on);
        $$in('.tp-direct-banner').classList.toggle('hidden', !on);
        input.placeholder = on ? '직접 입력 중 (Esc 두 번이면 해제)' : '프롬프트 입력';
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
          const first = !input.value.slice(0, input.selectionStart).includes('\n');
          const last = !input.value.slice(input.selectionEnd).includes('\n');
          if (event.key === 'ArrowUp' && first && (history.index !== -1 || !input.value.includes('\n'))) { event.preventDefault(); recall(1); return; }
          if (event.key === 'ArrowDown' && last && history.index !== -1) { event.preventDefault(); recall(-1); return; }
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
        if (attachments.some((a) => a.status === 'uploading')) { toast('첨부 업로드가 끝나면 보냅니다…', 'info'); await Promise.all(attachments.map((a) => a.promise)); }
        const ready = attachments.filter((a) => a.status === 'done').map((a) => a.id);
        if (!text.trim() && !ready.length) send({ t: 'keys', pane, keys: ['Enter'] });
        else {
          send({ t: 'prompt', pane, text, submit, attachments: ready });
          if (text.trim()) store.set('recent', [text, ...store.get('recent', []).filter((t) => t !== text)].slice(0, 100));   // ↑ 기록에도 남긴다
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
            model.pending = null;
            innerEl.innerHTML = '<div class="ln term-empty-note">화면을 불러오는 중...</div>';
            stick = true;
            if (!ws || ws.readyState > 1) connect(); else send({ t: 'sub', pane, history: 300 });
            refreshModel();
            R.refreshLimits().then(renderHead);
          }
          renderHead();
          applyMode();
          markSeen(next.key, next.activity);
        },
        update(next) { if (next.key === this.key) { w = next; renderHead(); renderStatus(); } },
        stop() { this.key = null; pane = null; w = null; send({ t: 'unsub' }); send({ t: 'logunsub' }); },
        rerender() { renderScreen(); },
        dispose() { disposed = true; pane = null; clearInterval(modelTimer); try { ws?.close(); } catch (e) { /* noop */ } },
      };
      return g.mirror;
    }

    // 파일 탭에서 뷰어를 닫아도 탭은 남는다 → "열린 파일 N" 으로 다시 열기
    const chip = $('#wsOpenFiles');
    function syncChip() {
      const count = viewer?.count || 0;
      chip.classList.toggle('hidden', !count || document.body.classList.contains('file-open'));
      chip.querySelector('span').textContent = `열린 파일 ${count}`;
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

    // 경로를 지금 선택한 창의 프롬프트에 넣고 터미널로 돌아간다
    function insertPath(path) {
      const w = workspace.currentWindow();
      if (!w) {
        window.UnivDashExplorer.copyText(path, '먼저 창을 선택하세요. 경로는 복사했어요');
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
      toast(`${displayName(w)} 프롬프트에 경로를 넣었습니다.`, 'ok');
    }

    // 창 메뉴 → "작업 폴더 파일 보기"
    function reveal(path) {
      if (document.body.classList.contains('term-open') && !desktopQuery.matches) workspace.closeTerm();
      if (desktopQuery.matches) setSide('right', false);
      setMode('files');
      ensureTree()?.reveal(path);
    }

    setMode(store.get('ws-mode', 'windows'));
    // explorer.js 는 app.js 뒤에 로드되므로 파일 탭이 처음부터 열려 있으면 로드 후에 붙인다
    // ── 왼쪽(창) · 오른쪽(파일) 사이드바 접기 — 상태는 저장되어 새로고침해도 유지 ──
    function setSide(side, collapsed) {
      const cls = `ws-${side}-collapsed`;
      document.documentElement.classList.toggle(cls, collapsed);
      store.set(cls, collapsed);
      if (side === 'right' && !collapsed) ensureTree();
      requestAnimationFrame(() => terminal?.refit());
    }
    // 창 목록 ↔ 파일 사이드바 좌우 바꾸기 (저장되어 새로고침해도 유지)
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
      // 데스크톱은 파일 사이드바가 늘 보이므로(접혀 있지 않으면) 바로 트리를 붙인다
      if (document.body.dataset.wsMode === 'files' || (desktopQuery.matches && !document.documentElement.classList.contains('ws-right-collapsed'))) ensureTree();
      if (!ensureViewer()) return;
      // 떠날 때 파일을 보고 있었으면 그대로 다시 연다 (탭 · 스크롤 위치 포함)
      if (store.get('ws-file-open', false) && viewer.count && (desktopQuery.matches || !location.hash) && !store.get('ws-pty-open', false)) openFile(null);
      else syncChip();
      renderBar();
      restorePtys();
    });

    return { reveal, setMode };
  })();

  // ── 시작 ────────────────────────────────────────────────────────────
  socket.on('windows', (message) => {
    onWindows(message.windows);
    workspace?.onWindowsChanged();
  });
  socket.on('seen', (message) => { if (mergeSeen(message.seen)) renderAll(true); flushSeen(); });
  socket.on('open', flushSeen);

  (async () => {
    await refreshState();
    workspace?.restoreSelection();
    socket.connect();
  })();
  // "n분 전" 표시 갱신
  setInterval(() => renderAll(), 30000);
})();
