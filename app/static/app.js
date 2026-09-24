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

  function vibrate(ms = 8) { try { navigator.vibrate?.(ms); } catch (e) { /* noop */ } }

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
  if (store.get('sidebar-collapsed', false)) document.body.classList.add('sidebar-collapsed');
  sidebarMenuButton.addEventListener('click', () => {
    if (mdQuery.matches) {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      store.set('sidebar-collapsed', collapsed);
      requestAnimationFrame(() => terminal?.refit());
    } else {
      setSidebarOpen(true);
    }
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

  function openSheet(html, onMount, onClose) {
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
      openSheet(`${sheetHead(title, message)}<div class="sheet-buttons">
          <button type="button" class="sheet-cancel" data-no>취소</button>
          <button type="button" class="${danger ? 'sheet-danger' : 'btn-glow'}" data-yes>${escapeHtml(confirmLabel)}</button></div>`, (body) => {
        body.querySelector('[data-no]').addEventListener('click', () => closeSheet());
        body.querySelector('[data-yes]').addEventListener('click', () => { answered = true; closeSheet(); resolve(true); });
      }, () => { if (!answered) resolve(false); });
    });
  }

  // 다른 페이지 스크립트(server.js 등)도 같은 시트 · 토스트를 쓰도록 공개한다.
  window.UnivDashUI = { actionSheet, formSheet, confirmSheet, closeSheet, toast };

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
    manual: { label: '직접 지정', icon: 'fa-hand-pointer', desc: '창 정리에서 끌어 놓은 순서 그대로' },
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

  function moveWithinGroup(key, delta) {
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
        ...(page === 'organize' || sortMode() === 'manual' ? [
          { icon: 'fa-arrow-up', label: '위로 이동', onClick: () => moveWithinGroup(w.key, -1) },
          { icon: 'fa-arrow-down', label: '아래로 이동', onClick: () => moveWithinGroup(w.key, 1) },
        ] : []),
        { icon: hidden ? 'fa-eye' : 'fa-eye-slash', label: hidden ? '다시 표시' : '목록에서 숨기기', onClick: () => toggleHidden(w.key) },
        'sep',
        { icon: 'fa-trash-can', label: 'tmux 창 종료', danger: true, onClick: () => killWindow(w) },
      ],
    });
  }

  // ── 새 세션 ──────────────────────────────────────────────────────────
  function newSessionForm() {
    const presets = { claude: 'claude', codex: 'codex', shell: '', custom: '' };
    let preset = store.get('new-session-preset', 'claude');
    if (!(preset in presets)) preset = 'claude';
    formSheet({
      title: '새 tmux 세션',
      subtitle: '분리(detached) 세션을 만들고 시작 명령을 실행합니다.',
      fields: [
        { name: 'name', label: '세션 이름', placeholder: '예: my-project', maxlength: 50 },
        { name: 'path', label: '작업 폴더', value: store.get('new-session-path', '~'), placeholder: '~/project', maxlength: 1024 },
      ],
      extraHtml: `<label>시작 명령<div class="seg" role="radiogroup">
          ${['claude', 'codex', 'shell', 'custom'].map((p) => `<button type="button" data-preset="${p}" class="${p === preset ? 'on' : ''}">${{ claude: 'Claude', codex: 'Codex', shell: '셸만', custom: '직접' }[p]}</button>`).join('')}
        </div></label>
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
        body.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => {
          preset = button.dataset.preset;
          body.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b === button));
          body.querySelector('[data-custom]').classList.toggle('hidden', preset !== 'custom');
        }));
      },
      async onSubmit(values) {
        const command = preset === 'custom' ? (values.command || '') : presets[preset];
        const result = await api('POST', '/api/sessions', { name: values.name.trim(), path: values.path.trim() || '~', command });
        store.set('new-session-path', values.path.trim() || '~');
        store.set('new-session-preset', preset);
        toast(`${values.name} 세션을 만들었습니다.`, 'ok');
        state.pendingPane = result.pane;
        socket.poke();
      },
    });
  }
  $('#newSessionBtn')?.addEventListener('click', newSessionForm);

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
      ws.onopen = () => { retry = 0; setConn('live'); handlers.open?.(); };
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
        handlers[message.t]?.(message);
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
      connect, send, on(type, fn) { handlers[type] = fn; },
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
    let seenChanged = false;
    windows.forEach((w) => {
      if (state.seen[w.key] == null || (w.key === state.selectedKey && isTermVisible())) {
        if (state.seen[w.key] !== w.activity) { state.seen[w.key] = w.activity; seenChanged = true; }
      }
    });
    if (seenChanged) store.set('seen', state.seen);

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
    return page === 'workspace' && !!state.selectedKey && (desktopQuery.matches || document.body.classList.contains('term-open'));
  }

  let lastRenderSignature = '';
  function renderAll(force = false) {
    renderStats();
    const windowsSignature = page === 'organize'
      ? state.windows.map((w) => [w.key, w.name, w.title, w.agent])
      : state.windows.map((w) => [w.key, w.status, w.title, w.path, w.agent, w.activity > (state.seen[w.key] || 0), timeAgo(w.activity), w.panes.length]);
    const signature = JSON.stringify([windowsSignature, state.prefs, state.filter, state.search, state.showHidden, state.selectedKey]);
    if (!force && signature === lastRenderSignature) return;
    lastRenderSignature = signature;
    if (page === 'workspace') workspace.renderList();
    if (page === 'organize') organize.render();
  }

  async function refreshState() {
    try {
      const data = await api('GET', '/api/state');
      state.prefs = data.preferences;
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
      if (!target || event.button > 0 || event.target.closest('button')) return;
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
  // 터미널 렌더러 (ANSI SGR → HTML). 터미널 영역은 테마와 무관하게 어둡게 유지한다.
  // ════════════════════════════════════════════════════════════════════
  const PALETTE = ['#1f2430', '#f07178', '#a6da95', '#eed49f', '#7aa2f7', '#c6a0f6', '#7dcfff', '#cad3f5',
    '#5b6078', '#ff8a92', '#b8f0a8', '#ffe0a8', '#9ab8ff', '#dcb8ff', '#a4e0ff', '#ffffff'];
  const DEFAULT_FG = '#d4d8e1';
  const DEFAULT_BG = '#05070c';
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
    if (st.inv) { const t = fg || DEFAULT_FG; fg = bg || DEFAULT_BG; bg = t; }
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
    const submitToggle = $('#submitToggle');
    const jumpBtn = $('#jumpBottomBtn');
    const loadMoreBtn = $('#loadMoreBtn');

    const view = Object.assign({ mode: desktopQuery.matches ? 'fit' : 'wrap', font: coarsePointer ? 11.5 : 12.5 }, store.get('view', {}));
    let scrollback = 400;
    let lastScreen = null;
    let stickBottom = true;
    let charRatio = 0.6;
    let submit = store.get('auto-submit', true);
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
      return `<div class="win-item ${selected ? 'selected' : ''} ${isHidden(w.key) ? 'is-hidden' : ''}" role="button" tabindex="0" data-key="${escapeHtml(w.key)}" aria-current="${selected}">
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

    function renderList() {
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

    function select(key, { pushHistory = true } = {}) {
      const w = byKey().get(key);
      if (!w) return;
      saveDraft();
      const changed = state.selectedKey !== key;
      state.selectedKey = key;
      if (changed) { state.paneId = null; lastScreen = null; scrollback = 400; inner.innerHTML = '<div class="ln term-empty-note">화면을 불러오는 중...</div>'; }
      state.paneId = pickPane(w);
      state.seen[key] = w.activity;
      store.set('seen', state.seen);
      store.set('last-window', key);
      stickBottom = true;

      $('#termEmpty').classList.add('hidden');
      $('#termEmpty').classList.remove('lg:flex');
      $('#termView').classList.add('open');
      if (!desktopQuery.matches && !document.body.classList.contains('term-open')) {
        document.body.classList.add('term-open');
        if (pushHistory) pushHash(key);
      } else {
        replaceHash(key);
      }
      input.value = drafts[key] || '';
      autosize();
      renderHeader();
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
      if (document.body.classList.contains('term-open')) closeTerm(true);
    });
    $('#termBack').addEventListener('click', () => closeTerm());

    function subscribe() {
      if (state.paneId) socket.send({ t: 'sub', pane: state.paneId, history: scrollback });
    }

    function renderHeader() {
      const w = currentWindow();
      if (!w) return;
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
        ? '<div class="alt-hint"><i class="fas fa-circle-info"></i><span>전체 화면 모드라 tmux 에 이전 기록이 남지 않아요.</span><button type="button" data-open-log>대화 기록 보기</button></div>'
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
      if (w) { state.seen[w.key] = w.activity; }
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
      submitToggle.setAttribute('aria-pressed', String(submit));
      submitToggle.innerHTML = submit ? '<i class="fas fa-check-circle"></i> Enter 자동 제출' : '<i class="far fa-circle"></i> 입력만 (제출 안 함)';
      $('#composerHint').textContent = coarsePointer ? '줄바꿈은 키보드 Enter · 전송은 ➤' : 'Enter 전송 · Shift+Enter 줄바꿈';
    }
    submitToggle.addEventListener('click', () => { submit = !submit; store.set('auto-submit', submit); syncSubmitToggle(); });
    syncSubmitToggle();

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
            await socket.send({ t: 'prompt', pane, text, submit, attachments: ready.map((item) => item.id) }, { ack: true });
          } catch (error) {
            if (text && !input.value) { input.value = text; autosize(); saveDraft(); }
            throw error;
          }
          if (text) remember(text);
          clearAttachments(key, { deleteOnServer: false });
        }
        stickBottom = true;
        vibrate(10);
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

    // ── 대화 기록 (에이전트 세션 로그) ──
    // Claude Code 는 alternate screen 이라 tmux 스크롤백이 없다. 세션 로그를 읽어 전체 대화를 보여준다.
    const logScroll = $('#logScroll');
    const logList = $('#logList');
    const logOlder = $('#logOlder');
    const LOG_PAGE = 80;
    const log = { pane: null, start: 0, total: 0, rendered: new Map(), timer: null, loading: false, available: true };
    let termMode = store.get('term-mode', 'screen');

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
      jumpBtn.classList.add('hidden');
      clearInterval(log.timer);
      log.timer = null;
      if (mode === 'log') {
        if (log.pane !== state.paneId) loadLatestLog();
        else pollLog();
        log.timer = setInterval(() => { if (document.visibilityState === 'visible') pollLog(); }, 2000);
      }
    }
    function setMode(mode) {
      termMode = mode;
      store.set('term-mode', mode);
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
      logList.innerHTML = '<div class="log-empty"><i class="fas fa-circle-notch fa-spin"></i> 대화 기록을 불러오는 중...</div>';
      logOlder.classList.add('hidden');
      try {
        const data = await fetchLog({ limit: LOG_PAGE });
        if (pane !== state.paneId) return;
        log.available = data.available;
        log.agent = data.agent;
        logList.innerHTML = '';
        if (!data.available) {
          logList.innerHTML = '<div class="log-empty">이 창의 대화 기록(에이전트 세션 로그)을 찾지 못했습니다.<br>Claude Code · Codex 가 실행 중인 창에서만 볼 수 있어요.</div>';
          return;
        }
        log.start = data.start;
        log.total = data.total;
        if (!data.items.length) logList.innerHTML = '<div class="log-empty">아직 대화가 없습니다.</div>';
        upsertLogItems(data.items);
        renderLogOlder();
        logScroll.scrollTop = logScroll.scrollHeight;
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
        const stick = logAtBottom();
        if (data.total < log.total) { loadLatestLog(); return; }  // 세션이 바뀜 (/clear 등)
        const hasNew = data.items.some((item) => !log.rendered.has(item.id));
        if (hasNew) logList.querySelector('.log-empty')?.remove();
        upsertLogItems(data.items);
        log.total = data.total;
        if (stick) logScroll.scrollTop = logScroll.scrollHeight;
        else if (hasNew) jumpBtn.classList.remove('hidden');
      } catch (error) { /* 다음 주기에 다시 시도 */ }
    }
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
      store.set('recent', recent.slice(0, 20));
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
      const recent = store.get('recent', []);
      const rows = (items, removable) => items.map((text, index) => `
          <div class="snippet-row"><button type="button" class="sheet-action" data-text-index="${index}" data-kind="${removable ? 's' : 'r'}">
            <i class="fas ${removable ? 'fa-bolt' : 'fa-clock-rotate-left'} lead"></i><span class="txt">${escapeHtml(text.replace(/\s+/g, ' '))}</span></button>
            ${removable ? `<button type="button" class="snippet-del" data-del="${index}" aria-label="삭제"><i class="fas fa-xmark"></i></button>` : ''}</div>`).join('');
      openSheet(`${sheetHead('빠른 문구', '탭하면 입력창에 넣습니다. 길게 눌러 바로 보내기.')}
        <div class="sheet-actions">${rows(snippets, true) || '<p class="px-3 py-2 text-xs opacity-60">저장된 문구가 없습니다.</p>'}
          <button type="button" class="sheet-action" data-add><i class="fas fa-plus lead"></i><span>${input.value.trim() ? '지금 입력한 내용을 문구로 저장' : '새 문구 추가'}</span></button>
          ${recent.length ? `<div class="sheet-sep"></div><p class="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider opacity-50">최근 보낸 프롬프트</p>${rows(recent.slice(0, 10), false)}` : ''}
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
    socket.on('open', () => subscribe());

    function restoreSelection() {
      const fromHash = decodeURIComponent(location.hash.slice(1));
      const key = byKey().has(fromHash) ? fromHash : (desktopQuery.matches ? store.get('last-window', null) : null);
      if (key && byKey().has(key)) select(key, { pushHistory: false });
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
        // 에이전트가 켜지거나 꺼지면 화면/대화 기록 전환 버튼도 따라 바뀐다
        if ($('#termModes').classList.contains('hidden') === !!agentOf(w)) applyMode();
      }
    }

    function renameKeys(move) {
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
    return { renderList, select, closeTerm, restoreSelection, onWindowsChanged, renameKeys };
  })();

  // ════════════════════════════════════════════════════════════════════
  // 창 정리
  // ════════════════════════════════════════════════════════════════════
  const organize = page !== 'organize' ? null : (() => {
    const root = $('#organizeRoot');
    let sortables = [];
    let pendingRender = false;

    function itemHtml(w) {
      const hidden = isHidden(w.key);
      const alias = state.prefs.aliases[w.key];
      return `<div class="org-item ${hidden ? 'is-hidden' : ''}" data-key="${escapeHtml(w.key)}">
          <span class="drag-handle item-handle" aria-label="끌어서 이동"><i class="fas fa-grip-vertical"></i></span>
          <div class="org-main min-w-0 flex-1 flex items-center gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 min-w-0"><span class="truncate text-sm font-bold text-white/90">${escapeHtml(displayName(w))}</span>${agentPill(w)}</div>
              <p class="truncate font-mono text-[10px] text-white/40 mt-0.5">${escapeHtml(`${alias ? `${w.session}:${w.index} · ` : ''}${w.title || w.path}`)}</p>
            </div>
          </div>
          <button type="button" class="org-icon-btn" data-act="alias" title="이름 변경" aria-label="tmux 세션 이름 변경"><i class="fas fa-pen text-xs"></i></button>
          <button type="button" class="org-icon-btn ${hidden ? 'on' : ''}" data-act="hide" title="${hidden ? '다시 표시' : '숨기기'}" aria-label="${hidden ? '다시 표시' : '숨기기'}"><i class="fas ${hidden ? 'fa-eye-slash' : 'fa-eye'} text-xs"></i></button>
          <button type="button" class="org-icon-btn" data-act="more" title="메뉴" aria-label="메뉴"><i class="fas fa-ellipsis-vertical text-sm"></i></button>
        </div>`;
    }

    function render() {
      if (state.dragging) { pendingRender = true; return; }
      sortables.forEach((s) => s.destroy());
      sortables = [];
      const groups = buildGroups(true);
      const folderGroups = groups.filter((g) => g.folder);
      const rootGroup = groups.at(-1);
      const allCollapsed = folderGroups.length && folderGroups.every((g) => g.folder.collapsed);
      const collapseBtn = $('#collapseAllBtn span');
      if (collapseBtn) collapseBtn.textContent = allCollapsed ? '모두 펼치기' : '모두 접기';

      root.innerHTML = `
        <div id="orgFolders" class="space-y-3">${folderGroups.map((group) => {
          const folder = group.folder;
          return `<section class="org-folder glass rounded-2xl overflow-hidden ${folder.collapsed ? 'collapsed' : ''}" data-folder-id="${escapeHtml(folder.id)}">
              <div class="flex items-center gap-1 p-2 pr-2 ${folder.collapsed ? '' : 'border-b border-white/10'}">
                <span class="drag-handle folder-handle" aria-label="폴더 끌어서 이동"><i class="fas fa-grip-vertical"></i></span>
                <button type="button" class="flex items-center gap-2.5 min-w-0 flex-1 text-left py-1.5" data-act="collapse">
                  <i class="fas ${folder.collapsed ? 'fa-folder' : 'fa-folder-open'} fc-${folder.color}"></i>
                  <span class="truncate text-sm font-bold text-white/90">${escapeHtml(folder.name)}</span>
                  <span class="font-mono text-[10px] text-white/40">${group.windows.length}</span>
                  <i class="fas fa-chevron-down folder-caret text-white/40"></i>
                </button>
                <button type="button" class="org-icon-btn" data-act="edit-folder" aria-label="폴더 편집"><i class="fas fa-pen text-xs"></i></button>
                <button type="button" class="org-icon-btn" data-act="delete-folder" aria-label="폴더 삭제"><i class="fas fa-trash-can text-xs"></i></button>
              </div>
              <div class="org-list p-2 ${folder.collapsed ? 'hidden' : ''}" data-list="${escapeHtml(folder.id)}">${group.windows.map(itemHtml).join('')}</div>
            </section>`;
        }).join('')}</div>
        <section class="glass rounded-2xl overflow-hidden">
          <div class="flex items-center gap-2.5 px-4 py-3 border-b border-white/10">
            <i class="fas fa-inbox text-white/40"></i><span class="text-sm font-bold text-white/80">폴더 없음</span>
            <span class="font-mono text-[10px] text-white/40">${rootGroup.windows.length}</span>
          </div>
          <div class="org-list p-2" data-list="">${rootGroup.windows.map(itemHtml).join('')}</div>
        </section>
        ${state.windows.length ? '' : '<p class="text-center text-xs text-white/40 py-6">실행 중인 tmux 창이 없습니다.</p>'}`;

      if (!window.Sortable) return;
      const common = {
        animation: 160, ghostClass: 'sortable-ghost', chosenClass: 'sortable-chosen', dragClass: 'sortable-drag',
        forceFallback: true, fallbackTolerance: 3, scroll: true, bubbleScroll: true,
        onStart: () => { state.dragging = true; vibrate(10); },
        onEnd: () => { state.dragging = false; syncFromDom(); },
      };
      sortables.push(new Sortable($('#orgFolders'), { ...common, handle: '.folder-handle', draggable: '.org-folder' }));
      $$('.org-list', root).forEach((listEl) => {
        sortables.push(new Sortable(listEl, { ...common, group: 'windows', handle: '.item-handle', draggable: '.org-item' }));
      });
    }

    // 드래그 결과(DOM)를 설정으로 옮긴다. 지금 없는 창(tmux 에서 꺼진 창)의 자리는 보존한다.
    function syncFromDom() {
      const exist = existingKeys();
      const folderById = new Map(state.prefs.folders.map((f) => [f.id, f]));
      const folders = $$('#orgFolders > .org-folder').map((section) => {
        const folder = folderById.get(section.dataset.folderId);
        const keys = $$('.org-item', section).map((el) => el.dataset.key);
        return { ...folder, items: [...keys, ...folder.items.filter((k) => !exist.has(k))] };
      });
      const rootKeys = $$('.org-list[data-list=""] .org-item', root).map((el) => el.dataset.key);
      state.prefs.folders = folders;
      state.prefs.order = [...rootKeys, ...state.prefs.order.filter((k) => !exist.has(k) && !folders.some((f) => f.items.includes(k)))];
      savePrefs();
      if (pendingRender) { pendingRender = false; }
      renderAll(true);
    }

    root.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const act = button.dataset.act;
      const section = button.closest('[data-folder-id]');
      const folder = section ? state.prefs.folders.find((f) => f.id === section.dataset.folderId) : null;
      const item = button.closest('.org-item');
      const w = item ? byKey().get(item.dataset.key) : null;
      if (w) {
        if (act === 'alias') renameForm(w);
        else if (act === 'hide') toggleHidden(w.key);
        else if (act === 'more') windowMenu(w);
        return;
      }
      if (!folder) return;
      if (act === 'collapse') { folder.collapsed = !folder.collapsed; commitPrefs(); }
      else if (act === 'edit-folder') folderForm({ folder });
      else if (act === 'delete-folder') {
        const ok = await confirmSheet({ title: '폴더 삭제', message: `'${folder.name}' 폴더를 삭제합니다. 안에 있던 창은 '폴더 없음'으로 옮겨집니다.`, confirmLabel: '삭제', danger: true });
        if (!ok) return;
        const rootKeys = buildGroups(true).at(-1).windows.map((x) => x.key);
        state.prefs.order = [...rootKeys, ...folder.items, ...state.prefs.order.filter((k) => !rootKeys.includes(k))];
        state.prefs.folders = state.prefs.folders.filter((f) => f.id !== folder.id);
        commitPrefs();
      }
    });

    $('#addFolderBtn').addEventListener('click', () => folderForm());
    $('#collapseAllBtn').addEventListener('click', () => {
      const allCollapsed = state.prefs.folders.length && state.prefs.folders.every((f) => f.collapsed);
      state.prefs.folders.forEach((f) => { f.collapsed = !allCollapsed; });
      commitPrefs();
    });

    return { render };
  })();

  // ── 시작 ────────────────────────────────────────────────────────────
  socket.on('windows', (message) => {
    onWindows(message.windows);
    workspace?.onWindowsChanged();
  });

  (async () => {
    await refreshState();
    workspace?.restoreSelection();
    socket.connect();
  })();
  // "n분 전" 표시 갱신
  setInterval(() => renderAll(), 30000);
})();
