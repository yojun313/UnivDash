// Git management page: repository list (folders/order/hidden/favorites/aliases), staging changes · commit · branches · merge · stash
(function () {
  'use strict';
  const { escapeHtml, api, toast, relativeTime, formatDate } = window.UnivDash;
  const $ = (id) => document.getElementById(id);
  if (!$('git-manager')) return;

  const state = {
    repositories: [],
    prefs: { folders: [], order: [], hidden: [], favorites: [], aliases: {}, sort: 'changes' },
    selectedId: null,
    detail: null,
    detailJson: '',
    detailRequest: 0,
    tab: null,
    filter: 'all',
    showHidden: false,
    selectedFile: null, // { path, staged }
    busy: false,
    dragId: null,
    autoPull: {}, // { repository ID: auto-pull settings · last result }
  };

  const byId = (id) => state.repositories.find((repo) => repo.id === id);
  const displayName = (repo) => state.prefs.aliases[repo.id] || repo.name;
  const isHidden = (id) => state.prefs.hidden.includes(id);
  const isFavorite = (id) => state.prefs.favorites.includes(id);

  // ── Sorting (within each group: favorites · folders · ungrouped) ─────
  const SORTS = {
    changes: { label: t('변경사항 우선'), icon: 'fa-pen-to-square', desc: t('충돌 → 변경 있음 → 풀 필요 → 푸시 필요 → 깨끗함') },
    recent: { label: t('최근 커밋순'), icon: 'fa-clock', desc: t('마지막 커밋이 최근인 저장소부터') },
    name: { label: t('이름순'), icon: 'fa-arrow-down-a-z', desc: t('표시 이름 가나다/ABC 순') },
    manual: { label: t('직접 지정'), icon: 'fa-hand-pointer', desc: t('끌어다 놓은 순서 그대로') },
  };
  const sortMode = () => (SORTS[state.prefs.sort] ? state.prefs.sort : 'changes');
  function changeRank(repo) {
    const status = repo.status;
    if (!status) return 5;
    if (status.conflicts) return 0;
    if (status.changes) return 1;
    if (status.behind) return 2;   // needs pull (commits to receive)
    if (status.ahead) return 3;    // needs push
    return 4;
  }
  // Within the same rank the manual order is kept (Array.prototype.sort is stable)
  function sortRepos(repos) {
    const mode = sortMode();
    if (mode === 'manual') return repos;
    const sorted = [...repos];
    if (mode === 'changes') sorted.sort((a, b) => changeRank(a) - changeRank(b) || (b.status?.changes || 0) - (a.status?.changes || 0) || (b.status?.behind || 0) - (a.status?.behind || 0));
    else if (mode === 'recent') sorted.sort((a, b) => (b.status?.last_commit || 0) - (a.status?.last_commit || 0));
    else if (mode === 'name') sorted.sort((a, b) => displayName(a).localeCompare(displayName(b), 'ko', { numeric: true }));
    return sorted;
  }

  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* noop */ } }

  // ── Saving preferences ──────────────────────────────────────────────
  let saveTimer = null;
  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const result = await api('/api/git/preferences', { method: 'PUT', body: state.prefs });
        state.prefs = result.preferences;
        renderList();
      } catch (error) {
        toast(t('목록 설정 저장 실패: {error}', { error: error.message }), 'error');
      }
    }, 250);
  }

  function folderOf(id) {
    return state.prefs.folders.find((folder) => folder.repositories.includes(id)) || null;
  }

  function ungroupedIds() {
    const inFolder = new Set(state.prefs.folders.flatMap((folder) => folder.repositories));
    const ordered = state.prefs.order.filter((id) => byId(id) && !inFolder.has(id));
    const rest = state.repositories
      .filter((repo) => !inFolder.has(repo.id) && !ordered.includes(repo.id))
      .map((repo) => repo.id);
    return [...ordered, ...rest];
  }

  function moveRepository(id, folderId, beforeId = null, after = false) {
    // Fix the currently visible order first, then move.
    const ungrouped = ungroupedIds().filter((item) => item !== id);
    state.prefs.folders.forEach((folder) => {
      folder.repositories = folder.repositories.filter((item) => item !== id && byId(item));
    });
    let list = ungrouped;
    if (folderId) {
      const folder = state.prefs.folders.find((item) => item.id === folderId);
      if (!folder) return;
      list = folder.repositories;
    }
    let index = beforeId ? list.indexOf(beforeId) : -1;
    if (index >= 0 && after) index += 1;
    if (index < 0) list.push(id); else list.splice(index, 0, id);
    state.prefs.order = folderId ? ungrouped : list;
    renderList();
    savePrefs();
  }

  function shiftRepository(id, delta) {
    const folder = folderOf(id);
    const list = folder ? folder.repositories.filter((item) => byId(item)) : ungroupedIds();
    const index = list.indexOf(id);
    const target = list[index + delta];
    if (index < 0 || target === undefined) return;
    moveRepository(id, folder?.id || null, target, delta > 0);
  }

  function newFolderId() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function createFolder(withRepoId = null) {
    const name = (prompt(t('새 폴더 이름')) || '').trim();
    if (!name) return;
    const folder = { id: newFolderId(), name: name.slice(0, 60), collapsed: false, repositories: [] };
    state.prefs.folders.push(folder);
    if (withRepoId) moveRepository(withRepoId, folder.id);
    else { renderList(); savePrefs(); }
  }

  function toggleIn(listName, id) {
    const list = state.prefs[listName];
    const index = list.indexOf(id);
    if (index >= 0) list.splice(index, 1); else list.push(id);
    renderList();
    savePrefs();
  }

  // ── List rendering ──────────────────────────────────────────────────
  function matchesFilter(repo) {
    const status = repo.status;
    if (state.filter === 'dirty' && !(status && status.changes > 0)) return false;
    if (state.filter === 'sync' && !(status && (status.ahead > 0 || status.behind > 0))) return false;
    const query = ($('gitRepositorySearch').value || '').trim().toLowerCase();
    if (!query) return true;
    return [displayName(repo), repo.name, repo.path, status?.branch || ''].some((value) => value.toLowerCase().includes(query));
  }

  function visible(repo) {
    return (state.showHidden || !isHidden(repo.id)) && matchesFilter(repo);
  }

  function statusBadges(status) {
    if (!status) return `<span class="text-white/30">${t('상태 확인 불가')}</span>`;
    const badges = [`<span class="truncate font-mono">${escapeHtml(status.branch || 'detached')}</span>`];
    if (status.conflicts) badges.push(`<span class="text-red-400" title="${t('충돌')}"><i class="fas fa-triangle-exclamation"></i> ${status.conflicts}</span>`);
    if (status.changes) badges.push(`<span class="text-amber-400" title="${t('변경 파일')}">● ${status.changes}</span>`);
    if (status.ahead) badges.push(`<span class="text-cyan-400" title="${t('푸시할 커밋')}">↑${status.ahead}</span>`);
    if (status.behind) badges.push(`<span class="text-violet-300" title="${t('받을 커밋')}">↓${status.behind}</span>`);
    if (!status.upstream && status.branch) badges.push(`<span class="text-white/30" title="${t('upstream 없음')}">local</span>`);
    return badges.join('<span class="text-white/20">·</span>');
  }

  function autoPullBadge(id) {
    const info = state.autoPull[id];
    if (!info?.enabled) return '';
    return info.ok === false
      ? `<i class="fas fa-rotate text-[9px] text-red-400" title="${t('자동 Pull 실패')}"></i>`
      : `<i class="fas fa-rotate text-[9px] text-violet-300" title="${t('자동 Pull {minutes}분마다', { minutes: info.interval_minutes })}"></i>`;
  }

  function repoItem(repo, { draggable = true } = {}) {
    const selected = repo.id === state.selectedId;
    const hidden = isHidden(repo.id);
    const dirty = repo.status && (repo.status.changes > 0 || repo.status.conflicts > 0);
    const dot = repo.status?.conflicts ? 'bg-red-400' : dirty ? 'bg-amber-400' : repo.status ? 'bg-emerald-500' : 'bg-white/20';
    return `
      <div class="git-repo-item group relative flex items-center gap-2 rounded-xl border px-2.5 py-2 transition cursor-pointer ${selected ? 'border-cyan-500/30 bg-cyan-500/10' : 'border-transparent hover:border-white/10 hover:bg-white/5'} ${hidden ? 'opacity-50' : ''}"
           data-repository-id="${escapeHtml(repo.id)}" ${draggable ? 'draggable="true"' : ''} role="button" tabindex="0" ${selected ? 'aria-current="true"' : ''}>
        <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full ${dot}"></span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5 text-xs font-bold ${selected ? 'text-cyan-300' : 'text-white/80'}">
            <span class="truncate">${escapeHtml(displayName(repo))}</span>
            ${isFavorite(repo.id) ? '<i class="fas fa-star text-[9px] text-amber-400"></i>' : ''}
            ${hidden ? '<i class="fas fa-eye-slash text-[9px] text-white/40"></i>' : ''}
            ${autoPullBadge(repo.id)}
          </span>
          <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[9px] text-white/40">${statusBadges(repo.status)}</span>
        </span>
        <button type="button" class="git-row-actions git-repo-menu-btn flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-white/40 hover:bg-white/10 hover:text-white" data-menu-for="${escapeHtml(repo.id)}" aria-label="${t('{name} 메뉴', { name: escapeHtml(displayName(repo)) })}" aria-haspopup="menu"><i class="fas fa-ellipsis text-xs"></i></button>
      </div>`;
  }

  function folderBlock(folder) {
    const repos = sortRepos(folder.repositories.map(byId).filter(Boolean).filter(visible));
    const total = folder.repositories.filter((id) => byId(id)).length;
    const searching = ($('gitRepositorySearch').value || '').trim() || state.filter !== 'all';
    if (searching && !repos.length) return '';
    const collapsed = folder.collapsed && !searching;
    const dirty = repos.filter((repo) => repo.status && repo.status.changes > 0).length;
    return `
      <div class="git-folder" data-folder-id="${escapeHtml(folder.id)}">
        <div class="git-folder-head group flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5">
          <button type="button" class="git-folder-toggle flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded="${!collapsed}">
            <i class="fas fa-chevron-${collapsed ? 'right' : 'down'} w-3 text-[9px] text-white/40"></i>
            <i class="fas ${collapsed ? 'fa-folder' : 'fa-folder-open'} text-xs text-cyan-400"></i>
            <span class="truncate text-[11px] font-bold text-white/70">${escapeHtml(folder.name)}</span>
            <span class="text-[10px] text-white/35">${total}</span>
            ${dirty ? `<span class="text-[9px] text-amber-400">● ${dirty}</span>` : ''}
          </button>
          <span class="git-row-actions flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
            <button type="button" class="git-folder-action flex h-5 w-5 items-center justify-center rounded text-white/40 hover:text-white" data-folder-action="up" title="${t('위로')}"><i class="fas fa-arrow-up text-[9px]"></i></button>
            <button type="button" class="git-folder-action flex h-5 w-5 items-center justify-center rounded text-white/40 hover:text-white" data-folder-action="down" title="${t('아래로')}"><i class="fas fa-arrow-down text-[9px]"></i></button>
            <button type="button" class="git-folder-action flex h-5 w-5 items-center justify-center rounded text-white/40 hover:text-white" data-folder-action="rename" title="${t('이름 변경')}"><i class="fas fa-pen text-[9px]"></i></button>
            <button type="button" class="git-folder-action flex h-5 w-5 items-center justify-center rounded text-white/40 hover:text-red-300" data-folder-action="delete" title="${t('폴더 삭제')}"><i class="fas fa-trash-can text-[9px]"></i></button>
          </span>
        </div>
        <div class="git-folder-body ml-3 space-y-1 border-l border-white/10 pl-2 ${collapsed ? 'hidden' : ''}" data-drop-folder="${escapeHtml(folder.id)}">
          ${repos.map((repo) => repoItem(repo)).join('') || `<p class="px-2 py-2 text-[10px] text-white/30">${t('여기로 저장소를 끌어다 놓으십시오.')}</p>`}
        </div>
      </div>`;
  }

  function renderList() {
    const container = $('gitRepositoryList');
    const hiddenCount = state.repositories.filter((repo) => isHidden(repo.id)).length;
    $('gitRepositoryCount').textContent = hiddenCount
      ? t('{count}개 저장소 · {hidden}개 숨김', { count: state.repositories.length, hidden: hiddenCount })
      : t('{count}개 저장소', { count: state.repositories.length });
    if (!state.repositories.length) {
      container.innerHTML = `<div class="rounded-xl border border-white/10 px-3 py-4 text-center text-xs text-white/35">${t('발견된 Git 저장소가 없습니다.')}</div>`;
      return;
    }

    const parts = [];
    $('gitSortLabel').textContent = SORTS[sortMode()].label;
    const favorites = sortRepos(state.prefs.favorites.map(byId).filter(Boolean).filter(visible));
    if (favorites.length) {
      parts.push(`<div><p class="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-amber-400/80"><i class="fas fa-star mr-1"></i>${t('즐겨찾기')}</p><div class="space-y-1">${favorites.map((repo) => repoItem(repo, { draggable: false })).join('')}</div></div>`);
    }
    const folders = state.prefs.folders.map(folderBlock).filter(Boolean);
    if (folders.length) parts.push(`<div class="space-y-1">${folders.join('')}</div>`);
    const ungrouped = sortRepos(ungroupedIds().map(byId).filter(Boolean).filter(visible));
    parts.push(`
      <div data-drop-folder="">
        ${state.prefs.folders.length ? `<p class="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-wider text-white/35">${t('미분류')}</p>` : ''}
        <div class="space-y-1 min-h-[24px]" data-drop-folder="">${ungrouped.map((repo) => repoItem(repo)).join('')}</div>
      </div>`);
    const anyVisible = favorites.length || ungrouped.length || folders.length;
    container.innerHTML = anyVisible ? parts.join('<div class="my-2 border-t border-white/5"></div>') : `<div class="rounded-xl border border-white/10 px-3 py-4 text-center text-xs text-white/35">${t('조건에 맞는 저장소가 없습니다.')}</div>`;
  }

  // ── Repository menu ─────────────────────────────────────────────────
  function closeMenus() {
    $('gitRepoMenu').classList.add('hidden');
    $('gitMoreMenu').classList.add('hidden');
    $('gitMoreButton').setAttribute('aria-expanded', 'false');
  }

  function openRepoMenu(id, anchor) {
    const repo = byId(id);
    if (!repo) return;
    const menu = $('gitRepoMenu');
    const current = folderOf(id);
    const folderButtons = state.prefs.folders
      .filter((folder) => folder.id !== current?.id)
      .map((folder) => `<button type="button" data-repo-action="move" data-folder="${escapeHtml(folder.id)}"><i class="fas fa-folder"></i>${escapeHtml(folder.name)}</button>`)
      .join('');
    menu.innerHTML = `
      <div class="git-menu-label">${escapeHtml(repo.name)}</div>
      <button type="button" data-repo-action="favorite"><i class="fas fa-star"></i>${isFavorite(id) ? t('즐겨찾기 해제') : t('즐겨찾기')}</button>
      <button type="button" data-repo-action="rename"><i class="fas fa-pen"></i>${t('표시 이름 변경')}</button>
      <button type="button" data-repo-action="hide"><i class="fas ${isHidden(id) ? 'fa-eye' : 'fa-eye-slash'}"></i>${isHidden(id) ? t('다시 표시') : t('목록에서 숨기기')}</button>
      <hr>
      ${sortMode() === 'manual' ? `<button type="button" data-repo-action="up"><i class="fas fa-arrow-up"></i>${t('위로 이동')}</button>
      <button type="button" data-repo-action="down"><i class="fas fa-arrow-down"></i>${t('아래로 이동')}</button>
      <hr>` : ''}
      <div class="git-menu-label">${t('폴더로 이동')}</div>
      ${folderButtons}
      ${current ? `<button type="button" data-repo-action="move" data-folder=""><i class="fas fa-inbox"></i>${t('미분류로')}</button>` : ''}
      <button type="button" data-repo-action="new-folder"><i class="fas fa-folder-plus"></i>${t('새 폴더 만들어 이동')}</button>`;
    menu.dataset.repoId = id;
    menu.classList.remove('hidden');
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
    const top = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector('button')?.focus();
  }

  $('gitRepoMenu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-repo-action]');
    if (!button) return;
    const id = $('gitRepoMenu').dataset.repoId;
    const action = button.dataset.repoAction;
    closeMenus();
    if (action === 'favorite') toggleIn('favorites', id);
    else if (action === 'hide') {
      toggleIn('hidden', id);
      if (isHidden(id)) toast(t('{name} 을(를) 숨겼습니다. 눈 아이콘으로 숨긴 저장소를 볼 수 있습니다.', { name: displayName(byId(id)) }));
    } else if (action === 'rename') {
      const repo = byId(id);
      const value = prompt(t('표시 이름 (비우면 원래 이름 "{name}")', { name: repo.name }), state.prefs.aliases[id] || '');
      if (value === null) return;
      if (value.trim()) state.prefs.aliases[id] = value.trim().slice(0, 60); else delete state.prefs.aliases[id];
      renderList();
      if (id === state.selectedId && state.detail) renderHeader(state.detail);
      savePrefs();
    } else if (action === 'up') shiftRepository(id, -1);
    else if (action === 'down') shiftRepository(id, 1);
    else if (action === 'move') moveRepository(id, button.dataset.folder || null);
    else if (action === 'new-folder') createFolder(id);
  });

  // ── List events (click / folder / drag) ─────────────────────────────
  const list = $('gitRepositoryList');
  list.addEventListener('click', (event) => {
    const menuButton = event.target.closest('.git-repo-menu-btn');
    if (menuButton) {
      event.stopPropagation();
      openRepoMenu(menuButton.dataset.menuFor, menuButton);
      return;
    }
    const folderEl = event.target.closest('.git-folder');
    const folderAction = event.target.closest('.git-folder-action');
    if (folderAction && folderEl) {
      const folder = state.prefs.folders.find((item) => item.id === folderEl.dataset.folderId);
      const index = state.prefs.folders.indexOf(folder);
      const action = folderAction.dataset.folderAction;
      if (action === 'rename') {
        const name = (prompt(t('폴더 이름'), folder.name) || '').trim();
        if (!name) return;
        folder.name = name.slice(0, 60);
      } else if (action === 'delete') {
        if (!confirm(t('"{name}" 폴더를 삭제하시겠습니까? 안의 저장소는 미분류로 옮겨집니다.', { name: folder.name }))) return;
        state.prefs.order = [...ungroupedIds(), ...folder.repositories];
        state.prefs.folders.splice(index, 1);
      } else if (action === 'up' || action === 'down') {
        const target = index + (action === 'up' ? -1 : 1);
        if (target < 0 || target >= state.prefs.folders.length) return;
        [state.prefs.folders[index], state.prefs.folders[target]] = [state.prefs.folders[target], state.prefs.folders[index]];
      }
      renderList();
      savePrefs();
      return;
    }
    const toggle = event.target.closest('.git-folder-toggle');
    if (toggle && folderEl) {
      const folder = state.prefs.folders.find((item) => item.id === folderEl.dataset.folderId);
      folder.collapsed = !folder.collapsed;
      renderList();
      savePrefs();
      return;
    }
    const item = event.target.closest('.git-repo-item');
    if (item) selectRepository(item.dataset.repositoryId);
  });
  list.addEventListener('keydown', (event) => {
    const item = event.target.closest('.git-repo-item');
    if (item && (event.key === 'Enter' || event.key === ' ') && event.target === item) {
      event.preventDefault();
      selectRepository(item.dataset.repositoryId);
    }
  });

  function clearDropMarks() {
    list.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
  }
  list.addEventListener('dragstart', (event) => {
    const item = event.target.closest('.git-repo-item[draggable="true"]');
    if (!item) return;
    state.dragId = item.dataset.repositoryId;
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', state.dragId);
  });
  list.addEventListener('dragend', () => {
    state.dragId = null;
    list.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    clearDropMarks();
  });
  function dropTarget(event) {
    const item = event.target.closest('.git-repo-item[draggable="true"]');
    if (item && item.dataset.repositoryId === state.dragId) return null;
    if (item) {
      const rect = item.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const folderEl = item.closest('[data-drop-folder]');
      return { item, after, folderId: folderEl ? folderEl.dataset.dropFolder : '' };
    }
    const folder = event.target.closest('.git-folder');
    if (folder) return { folder, folderId: folder.dataset.folderId };
    const zone = event.target.closest('[data-drop-folder]');
    if (zone) return { folderId: zone.dataset.dropFolder };
    return null;
  }
  list.addEventListener('dragover', (event) => {
    if (!state.dragId) return;
    const target = dropTarget(event);
    if (!target) return;
    event.preventDefault();
    clearDropMarks();
    if (target.item) target.item.classList.add(target.after ? 'drop-after' : 'drop-before');
    else if (target.folder) target.folder.classList.add('drop-into');
  });
  list.addEventListener('drop', (event) => {
    if (!state.dragId) return;
    const target = dropTarget(event);
    event.preventDefault();
    clearDropMarks();
    if (!target) return;
    const folderId = target.folderId || null;
    if (target.item) moveRepository(state.dragId, folderId, target.item.dataset.repositoryId, target.after);
    else moveRepository(state.dragId, folderId);
  });

  // ── Loading the list ────────────────────────────────────────────────
  async function loadRepositories({ quiet = false } = {}) {
    if (!quiet) $('gitRepositoryCount').textContent = t('검색 중...');
    try {
      const data = await api('/api/git/repositories');
      state.repositories = data.repositories || [];
      state.prefs = data.preferences;
      state.autoPull = data.auto_pull || {};
      renderList();
      if (state.selectedId && !byId(state.selectedId)) state.selectedId = null;
      if (!state.selectedId) {
        const remembered = storageGet('univdash-git-selected');
        const first = byId(remembered) || state.prefs.favorites.map(byId).find(Boolean)
          || state.repositories.find((repo) => !isHidden(repo.id));
        if (first) await selectRepository(first.id);
      }
    } catch (error) {
      $('gitRepositoryCount').textContent = t('불러오기 실패');
      list.innerHTML = `<div class="rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-4 text-center text-xs text-red-400">${escapeHtml(error.message)}</div>`;
    }
  }

  // ── Detail ──────────────────────────────────────────────────────────
  function setTab(name) {
    state.tab = name;
    storageSet('univdash-git-tab', name);
    document.querySelectorAll('.git-panel').forEach((panel) => panel.classList.add('hidden'));
    $(`gitPanel-${name}`)?.classList.remove('hidden');
    document.querySelectorAll('.git-tab').forEach((tab) => {
      const active = tab.dataset.gitTab === name;
      tab.classList.toggle('border-cyan-400', active);
      tab.classList.toggle('text-cyan-400', active);
      tab.classList.toggle('border-transparent', !active);
      tab.classList.toggle('text-white/40', !active);
      tab.setAttribute('aria-selected', String(active));
    });
  }

  function renderHeader(detail) {
    const repo = byId(detail.id);
    const alias = repo && state.prefs.aliases[repo.id];
    $('gitRepositoryName').textContent = alias || detail.name;
    $('gitRepositoryRealName').textContent = alias ? `(${detail.name})` : '';
    $('gitRepositoryRealName').classList.toggle('hidden', !alias);
    $('gitRepositoryPath').textContent = detail.path;
    $('gitRepositoryRemote').textContent = detail.remotes.length
      ? detail.remotes.map((remote) => `${remote.name} → ${remote.url}`).join('   ')
      : t('원격 저장소 없음');
  }

  function renderSummary(detail) {
    const counts = detail.counts;
    $('gitBranch').textContent = detail.branch;
    $('gitUpstream').textContent = detail.upstream ? `↔ ${detail.upstream}` : t('upstream 없음');
    const workingTree = $('gitWorkingTree');
    workingTree.textContent = counts.conflicts ? t('충돌 {count}개', { count: counts.conflicts }) : detail.dirty ? t('{count}개 변경', { count: detail.changes.length }) : t('깨끗함');
    workingTree.className = `mt-2 text-sm font-bold ${counts.conflicts ? 'text-red-400' : detail.dirty ? 'text-amber-400' : 'text-emerald-400'}`;
    $('gitWorkingTreeDetail').textContent = t('스테이징 {staged} · 수정 {unstaged} · 새 파일 {untracked}', { staged: counts.staged, unstaged: counts.unstaged, untracked: counts.untracked });
    const aheadBehind = $('gitAheadBehind');
    aheadBehind.textContent = detail.upstream ? `↑${detail.ahead} ↓${detail.behind}` : '—';
    aheadBehind.className = `mt-2 font-mono text-sm font-bold ${(detail.ahead || detail.behind) ? 'text-amber-400' : 'text-emerald-400'}`;
    $('gitLastFetch').textContent = detail.last_fetch ? t('마지막 fetch {time}', { time: relativeTime(detail.last_fetch) }) : t('fetch 기록 없음');
    $('gitDirtyDot').className = `h-2 w-2 flex-shrink-0 rounded-full ${counts.conflicts ? 'bg-red-400' : detail.dirty ? 'bg-amber-400' : 'bg-emerald-500'}`;
    const recent = detail.commits[0];
    $('gitRecentCommit').textContent = recent ? `${recent.short_hash} · ${recent.subject}` : t('커밋 없음');
    $('gitRecentCommitMeta').textContent = recent ? `${recent.author} · ${relativeTime(recent.date)}` : '—';
    $('gitChangesCount').textContent = detail.changes.length;
    $('gitStashCount').textContent = detail.stashes.length;
    $('gitPullCount').textContent = detail.behind ? `(${detail.behind})` : '';
    $('gitPushCount').textContent = detail.ahead ? `(${detail.ahead})` : '';
    $('gitMergeTarget').textContent = detail.detached ? 'detached HEAD' : detail.branch;

    const banner = $('gitOperationBanner');
    banner.classList.toggle('hidden', !detail.operation);
    if (detail.operation) {
      const names = { merge: t('병합'), rebase: t('리베이스'), 'cherry-pick': t('체리픽'), revert: t('되돌리기') };
      const name = names[detail.operation] || detail.operation;
      $('gitOperationText').textContent = counts.conflicts
        ? t('{name} 진행 중 · 충돌 파일 {count}개 — 충돌을 해결한 파일을 스테이징하고 커밋하거나, 작업을 중단하십시오.', { name, count: counts.conflicts })
        : t('{name} 진행 중 — 충돌을 해결한 파일을 스테이징하고 커밋하거나, 작업을 중단하십시오.', { name });
    }
    $('gitUserWarning').classList.toggle('hidden', Boolean(detail.user.name && detail.user.email));
  }

  function fileRow(change, staged) {
    const selected = state.selectedFile && state.selectedFile.path === change.path && state.selectedFile.staged === staged;
    const code = change.conflict ? '!' : staged ? change.index_state : (change.untracked ? 'U' : change.worktree_state);
    const colors = { M: 'text-amber-400', A: 'text-emerald-400', U: 'text-emerald-400', D: 'text-red-400', R: 'text-blue-400', C: 'text-blue-400', T: 'text-purple-400', '!': 'text-red-400' };
    const slash = change.path.lastIndexOf('/');
    const base = change.path.slice(slash + 1);
    const dir = slash >= 0 ? change.path.slice(0, slash) : '';
    const actions = staged
      ? `<button type="button" data-file-action="unstage" class="flex h-6 w-6 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-white" title="${t('스테이징 취소')}"><i class="fas fa-minus text-[10px]"></i></button>`
      : `${change.conflict ? '' : `<button type="button" data-file-action="discard" class="flex h-6 w-6 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-red-300" title="${t('변경 되돌리기')}"><i class="fas fa-rotate-left text-[10px]"></i></button>`}
         <button type="button" data-file-action="stage" class="flex h-6 w-6 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-white" title="${change.conflict ? t('해결됨으로 표시(스테이징)') : t('스테이징')}"><i class="fas fa-plus text-[10px]"></i></button>`;
    return `
      <div class="git-file-row flex items-center gap-2 border-b border-white/5 px-2.5 py-1.5 last:border-0 cursor-pointer hover:bg-white/5 ${selected ? 'selected' : ''}"
           data-path="${escapeHtml(change.path)}" data-staged="${staged}" title="${escapeHtml(change.original_path ? `${change.original_path} → ${change.path}` : change.path)}">
        <span class="w-4 flex-shrink-0 text-center font-mono text-[10px] font-bold ${colors[code] || 'text-white/50'}">${escapeHtml(code)}</span>
        <span class="min-w-0 flex-1 truncate text-[11px]"><span class="font-semibold text-white/80">${escapeHtml(base)}</span>${dir ? ` <span class="text-white/35">${escapeHtml(dir)}</span>` : ''}</span>
        <span class="git-row-actions flex flex-shrink-0 items-center">${actions}</span>
      </div>`;
  }

  function renderChanges(detail) {
    const staged = detail.changes.filter((change) => change.staged);
    const unstaged = detail.changes.filter((change) => change.unstaged);
    $('gitStagedCount').textContent = staged.length;
    $('gitUnstagedCount').textContent = unstaged.length;
    $('gitStagedList').innerHTML = staged.length ? staged.map((change) => fileRow(change, true)).join('')
      : `<p class="px-3 py-4 text-center text-[11px] text-white/35">${t('스테이징된 파일이 없습니다.')}</p>`;
    $('gitUnstagedList').innerHTML = unstaged.length ? unstaged.map((change) => fileRow(change, false)).join('')
      : `<p class="px-3 py-4 text-center text-[11px] text-emerald-400">${t('작업 트리가 깨끗합니다.')}</p>`;
    updateCommitCount();
    $('gitCommitHint').textContent = detail.operation === 'merge' ? t('병합 커밋 — 메시지를 비우면 기본 메시지 사용') : '';

    // If the selected file is gone, clear the diff.
    if (state.selectedFile && !detail.changes.some((change) => change.path === state.selectedFile.path
      && (state.selectedFile.staged ? change.staged : change.unstaged))) {
      state.selectedFile = null;
      showDiffPlaceholder();
    }
  }

  function renderCommits(detail) {
    $('gitCommitList').innerHTML = detail.commits.length ? detail.commits.map((commit) => {
      const refs = commit.refs.map((ref) => {
        const tag = ref.startsWith('tag: ');
        const head = ref.startsWith('HEAD');
        const cls = head ? 'border-cyan-400/40 text-cyan-300' : tag ? 'border-amber-400/40 text-amber-300' : 'border-violet-400/30 text-violet-300';
        return `<span class="ml-1 inline-block rounded border ${cls} px-1 py-px font-mono text-[9px]">${escapeHtml(ref)}</span>`;
      }).join('');
      return `
        <tr class="git-commit-row border-b border-white/5 hover:bg-white/5 cursor-pointer" data-hash="${escapeHtml(commit.hash)}">
          <td class="px-3 py-2.5 align-top"><span class="font-mono text-[11px] font-bold text-cyan-400">${escapeHtml(commit.short_hash)}</span>${commit.merge ? ` <i class="fas fa-code-merge text-[9px] text-violet-300" title="${t('병합 커밋')}"></i>` : ''}</td>
          <td class="px-3 py-2.5 text-xs font-semibold text-white/70">${escapeHtml(commit.subject)}${refs}${detail.upstream && !commit.pushed ? ` <span class="ml-1 rounded bg-amber-500/15 px-1 py-px text-[9px] text-amber-300">${t('미푸시')}</span>` : ''}</td>
          <td class="px-3 py-2.5 text-right text-[10px] text-white/35"><span class="text-white/50">${escapeHtml(commit.author)}</span><br>${escapeHtml(formatDate(commit.date, true))}</td>
          <td class="px-3 py-2.5 text-right whitespace-nowrap">
            <button type="button" data-commit-action="revert" class="rounded px-1.5 py-1 text-[10px] font-bold text-white/40 hover:bg-white/10 hover:text-white" title="${t('이 커밋을 되돌리는 새 커밋 생성')}"><i class="fas fa-rotate-left"></i> Revert</button>
          </td>
        </tr>`;
    }).join('') : `<tr><td colspan="4" class="p-8 text-center text-xs text-white/35">${t('표시할 커밋이 없습니다.')}</td></tr>`;
  }

  function branchRow(branch) {
    const track = [];
    if (branch.upstream) track.push(`<span class="font-mono">${escapeHtml(branch.upstream)}</span>`);
    if (branch.gone) track.push(`<span class="text-red-400">${t('원격 삭제됨')}</span>`);
    if (branch.ahead) track.push(`<span class="text-cyan-400">↑${branch.ahead}</span>`);
    if (branch.behind) track.push(`<span class="text-violet-300">↓${branch.behind}</span>`);
    const buttons = [];
    if (!branch.current) {
      buttons.push(`<button type="button" data-branch-action="checkout" class="rounded-lg px-2 py-1 text-[10px] font-bold text-white/60 hover:bg-white/10 hover:text-white"><i class="fas fa-right-to-bracket mr-1"></i>${branch.remote ? t('체크아웃') : t('전환')}</button>`);
      if (!state.detail.detached) buttons.push(`<button type="button" data-branch-action="merge" class="rounded-lg px-2 py-1 text-[10px] font-bold text-violet-300 hover:bg-violet-500/10"><i class="fas fa-code-merge mr-1"></i>${t('병합')}</button>`);
      if (!branch.remote) buttons.push('<button type="button" data-branch-action="delete" class="rounded-lg px-2 py-1 text-[10px] font-bold text-white/40 hover:bg-red-500/10 hover:text-red-300"><i class="fas fa-trash-can"></i></button>');
    }
    return `
      <div class="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-branch="${escapeHtml(branch.name)}">
        <div class="min-w-0">
          <p class="flex items-center gap-2 truncate font-mono text-xs font-bold ${branch.current ? 'text-cyan-400' : 'text-white/80'}">${branch.current ? '<i class="fas fa-circle text-[6px]"></i>' : ''}${escapeHtml(branch.name)}${branch.current ? `<span class="rounded bg-cyan-500/15 px-1.5 py-px font-sans text-[9px] text-cyan-300">${t('현재')}</span>` : ''}</p>
          <p class="mt-0.5 truncate text-[10px] text-white/40"><span class="font-mono">${escapeHtml(branch.hash)}</span> · ${escapeHtml(branch.subject || '')} · ${relativeTime(branch.date)}${track.length ? ` · ${track.join(' ')}` : ''}</p>
        </div>
        <div class="flex flex-shrink-0 items-center gap-1">${buttons.join('')}</div>
      </div>`;
  }

  function renderBranches(detail) {
    const local = detail.branches.filter((branch) => !branch.remote);
    const remote = detail.branches.filter((branch) => branch.remote);
    $('gitBranchList').innerHTML = local.map(branchRow).join('') || `<p class="p-6 text-center text-xs text-white/35">${t('로컬 브랜치가 없습니다.')}</p>`;
    $('gitRemoteBranchList').innerHTML = remote.map(branchRow).join('') || `<p class="p-6 text-center text-xs text-white/35">${t('원격 브랜치가 없습니다. Fetch 해 보십시오.')}</p>`;
    const select = $('gitNewBranchStart');
    const previous = select.value;
    select.innerHTML = `<option value="">${t('현재 HEAD ({head})', { head: escapeHtml(detail.head) })}</option>` + detail.branches
      .map((branch) => `<option value="${escapeHtml(branch.name)}">${escapeHtml(branch.name)}</option>`).join('');
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }

  function renderStashes(detail) {
    $('gitStashList').innerHTML = detail.stashes.length ? detail.stashes.map((stash) => `
      <div class="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-stash="${escapeHtml(stash.ref)}">
        <div class="min-w-0">
          <p class="truncate text-xs font-semibold text-white/80">${escapeHtml(stash.message)}</p>
          <p class="mt-0.5 text-[10px] text-white/40"><span class="font-mono">${escapeHtml(stash.ref)}</span> · ${relativeTime(stash.date)}</p>
        </div>
        <div class="flex flex-shrink-0 items-center gap-1">
          <button type="button" data-stash-action="stash_apply" class="rounded-lg px-2 py-1 text-[10px] font-bold text-white/60 hover:bg-white/10 hover:text-white">${t('적용')}</button>
          <button type="button" data-stash-action="stash_pop" class="rounded-lg px-2 py-1 text-[10px] font-bold text-violet-300 hover:bg-violet-500/10">${t('꺼내기 (pop)')}</button>
          <button type="button" data-stash-action="stash_drop" class="rounded-lg px-2 py-1 text-[10px] font-bold text-white/40 hover:bg-red-500/10 hover:text-red-300"><i class="fas fa-trash-can"></i></button>
        </div>
      </div>`).join('') : `<p class="p-6 text-center text-xs text-white/35">${t('저장된 스태시가 없습니다.')}</p>`;
  }

  function renderDetail(detail) {
    state.detail = detail;
    $('gitEmptyState').classList.add('hidden');
    $('gitRepositoryDetail').classList.remove('hidden');
    renderHeader(detail);
    renderSummary(detail);
    renderChanges(detail);
    renderCommits(detail);
    renderBranches(detail);
    renderStashes(detail);
    if (!state.tab) setTab('changes');
  }

  // ── Auto pull ───────────────────────────────────────────────────────
  function renderAutoPull(info) {
    const interval = $('gitAutoPullInterval');
    if (autoPullSaving) return;
    $('gitAutoPullEnabled').checked = Boolean(info?.enabled);
    if (document.activeElement !== interval) interval.value = info?.interval_minutes ?? 15;
    const status = $('gitAutoPullStatus');
    const parts = [];
    if (info?.last_run) parts.push(t('{time} 확인: {message}', { time: relativeTime(info.last_run * 1000), message: info.message }));
    if (info?.enabled) {
      if (!info.next_run) parts.push(t('곧 첫 확인을 합니다'));
      else if (info.next_run * 1000 > Date.now()) parts.push(t('다음 확인 {time}', { time: relativeTime(info.next_run * 1000) }));
      else parts.push(t('곧 다시 확인합니다'));
    }
    if (info?.updated_at) parts.push(t('마지막으로 받은 때 {time}', { time: relativeTime(info.updated_at * 1000) }));
    status.textContent = parts.join(' · ');
    status.classList.toggle('text-red-400', info?.ok === false);
    status.classList.toggle('text-white/40', info?.ok !== false);
  }

  // Editing the interval and then clicking the checkbox right away triggers back-to-back saves → send them in turn so the last on-screen value wins
  let autoPullSaving = false;
  let autoPullAgain = false;
  async function saveAutoPull() {
    if (autoPullSaving) { autoPullAgain = true; return; }
    const id = state.selectedId;
    if (!id) return;
    autoPullSaving = true;
    let info = state.autoPull[id];
    try {
      do {
        autoPullAgain = false;
        const minutes = Number($('gitAutoPullInterval').value);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
          toast(t('주기는 1분에서 10080분(7일) 사이의 정수로 적어 주십시오.'), 'error');
          break;
        }
        info = await api(`/api/git/auto-pull/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: { enabled: $('gitAutoPullEnabled').checked, interval_minutes: minutes },
        });
        state.autoPull[id] = info;
      } while (autoPullAgain && state.selectedId === id);
      renderList();
    } catch (error) {
      toast(t('자동 Pull 설정 저장 실패: {error}', { error: error.message }), 'error');
    } finally {
      autoPullSaving = false;
      if (state.selectedId === id) renderAutoPull(info);
    }
  }

  async function refreshDetail({ quiet = false } = {}) {
    if (!state.selectedId) return;
    const requestNumber = ++state.detailRequest;
    try {
      const detail = await api(`/api/git/repositories/${encodeURIComponent(state.selectedId)}`);
      if (requestNumber !== state.detailRequest) return;
      // The remaining time keeps changing, so it is rendered separately from the rest of the detail
      if (!autoPullSaving) {
        state.autoPull[detail.id] = detail.auto_pull;
        renderAutoPull(detail.auto_pull);
      }
      delete detail.auto_pull;
      const json = JSON.stringify(detail);
      if (json !== state.detailJson) {
        state.detailJson = json;
        renderDetail(detail);
        if (state.selectedFile) loadDiff(state.selectedFile.path, state.selectedFile.staged, { quiet: true });
      }
      // Bring the status badges in the list up to date as well.
      const repo = byId(detail.id);
      if (repo) {
        repo.status = {
          branch: detail.detached ? null : detail.branch,
          changes: detail.changes.length,
          conflicts: detail.counts.conflicts,
          ahead: detail.ahead,
          behind: detail.behind,
          upstream: Boolean(detail.upstream),
        };
        renderList();
      }
    } catch (error) {
      if (requestNumber !== state.detailRequest) return;
      if (!quiet) {
        $('gitEmptyState').classList.remove('hidden');
        $('gitRepositoryDetail').classList.add('hidden');
        $('gitEmptyMessage').textContent = error.message;
      }
    }
  }

  async function selectRepository(id) {
    if (state.selectedId !== id) {
      state.selectedFile = null;
      state.detailJson = '';
      showDiffPlaceholder();
      saveDraft();
    }
    state.selectedId = id;
    storageSet('univdash-git-selected', id);
    setTab('changes');  // clicking a repository always starts on the Changes tab
    renderList();
    loadDraft();
    if (!state.detail || state.detail.id !== id) {
      $('gitEmptyState').classList.remove('hidden');
      $('gitRepositoryDetail').classList.add('hidden');
      $('gitEmptyMessage').textContent = t('저장소 정보를 불러오는 중입니다.');
    }
    syncWorkflowButton();
    renderAutoPull(state.autoPull[id]);
    await refreshDetail();
  }

  // ── diff ────────────────────────────────────────────────────────────
  function showDiffPlaceholder(message = t('파일을 선택하면 변경 내용이 표시됩니다.')) {
    $('gitDiffTitle').textContent = message;
    $('gitDiffStats').textContent = '';
    $('gitDiffView').innerHTML = '';
  }

  function renderDiffText(container, text, { truncated = false } = {}) {
    if (!text.trim()) {
      container.innerHTML = `<div class="note">${t('표시할 변경 내용이 없습니다. (공백/권한 변경이거나 빈 파일)')}</div>`;
      return { added: 0, removed: 0 };
    }
    const lines = text.split('\n');
    const maxLines = 6000;
    const fragment = document.createDocumentFragment();
    let added = 0;
    let removed = 0;
    let oldLine = 0;
    let newLine = 0;
    lines.slice(0, maxLines).forEach((line) => {
      const row = document.createElement('div');
      let cls = 'ctx';
      let number = '';
      if (line.startsWith('diff --git')) cls = 'file';
      else if (line.startsWith('@@')) {
        cls = 'hunk';
        const match = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
        if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); }
      } else if (line.startsWith('+++') || line.startsWith('---') || /^(index|new file|deleted file|similarity|rename|old mode|new mode|Binary)/.test(line)) cls = 'meta';
      else if (line.startsWith('+')) { cls = 'add'; added += 1; number = newLine++; }
      else if (line.startsWith('-')) { cls = 'del'; removed += 1; number = oldLine++; }
      else if (line.startsWith('\\')) cls = 'meta';
      else if (oldLine || newLine) { number = newLine++; oldLine++; }
      row.className = `dl ${cls}`;
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = number === '' ? '' : String(number);
      const tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = line || ' ';
      row.append(ln, tx);
      fragment.appendChild(row);
    });
    container.replaceChildren(fragment);
    if (truncated || lines.length > maxLines) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = t('… 내용이 너무 길어 일부만 표시했습니다.');
      container.appendChild(note);
    }
    return { added, removed };
  }

  async function loadDiff(path, staged, { quiet = false } = {}) {
    state.selectedFile = { path, staged };
    document.querySelectorAll('.git-file-row').forEach((row) => {
      row.classList.toggle('selected', row.dataset.path === path && row.dataset.staged === String(staged));
    });
    if (!quiet) {
      $('gitDiffTitle').textContent = t('{path} · 불러오는 중...', { path });
    }
    try {
      const diff = await api(`/api/git/repositories/${encodeURIComponent(state.selectedId)}/diff?path=${encodeURIComponent(path)}&staged=${staged}`);
      if (!state.selectedFile || state.selectedFile.path !== path) return;
      $('gitDiffTitle').textContent = staged ? t('{path} (스테이징됨)', { path }) : t('{path} (작업 트리)', { path });
      if (diff.binary) {
        $('gitDiffView').innerHTML = `<div class="note">${t('바이너리 파일은 미리 볼 수 없습니다.')}</div>`;
        $('gitDiffStats').textContent = '';
        return;
      }
      const stats = renderDiffText($('gitDiffView'), diff.diff, { truncated: diff.truncated });
      $('gitDiffStats').innerHTML = `<span class="text-emerald-400">+${stats.added}</span> <span class="text-red-400">−${stats.removed}</span>`;
    } catch (error) {
      $('gitDiffTitle').textContent = path;
      $('gitDiffView').innerHTML = `<div class="note">${escapeHtml(error.message)}</div>`;
    }
  }

  // ── Commit detail modal ─────────────────────────────────────────────
  async function openCommit(hash) {
    const modal = $('gitCommitModal');
    modal.classList.remove('hidden');
    $('gitCommitModalTitle').textContent = hash.slice(0, 10);
    $('gitCommitModalMeta').textContent = t('불러오는 중...');
    $('gitCommitModalMessage').textContent = '';
    $('gitCommitModalFiles').innerHTML = '';
    $('gitCommitModalDiff').innerHTML = '';
    try {
      const commit = await api(`/api/git/repositories/${encodeURIComponent(state.selectedId)}/commits/${encodeURIComponent(hash)}`);
      $('gitCommitModalTitle').textContent = `${commit.hash.slice(0, 10)} · ${commit.message.split('\n')[0]}`;
      $('gitCommitModalMeta').textContent = `${commit.author} <${commit.author_email}> · ${formatDate(commit.date, true)}${commit.parents.length > 1 ? ` · ${t('병합 커밋')}` : ''}`;
      $('gitCommitModalMessage').textContent = commit.message;
      $('gitCommitModalFiles').innerHTML = commit.files.map((file) => `
        <div class="flex items-center justify-between gap-2 text-[11px]">
          <span class="min-w-0 truncate font-mono text-white/70" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span>
          <span class="flex-shrink-0 font-mono">${file.added === null ? '<span class="text-white/40">bin</span>' : `<span class="text-emerald-400">+${file.added}</span> <span class="text-red-400">−${file.deleted}</span>`}</span>
        </div>`).join('') || `<p class="text-[11px] text-white/40">${t('변경된 파일 없음')}</p>`;
      renderDiffText($('gitCommitModalDiff'), commit.diff, { truncated: commit.truncated });
    } catch (error) {
      $('gitCommitModalMeta').textContent = error.message;
    }
  }
  function closeCommitModal() { $('gitCommitModal').classList.add('hidden'); }
  $('gitCommitModalClose').addEventListener('click', closeCommitModal);
  $('gitCommitModal').addEventListener('click', (event) => { if (event.target.id === 'gitCommitModal') closeCommitModal(); });

  // ── Running actions ─────────────────────────────────────────────────
  function writeConsole(message) {
    const consoleElement = $('gitConsole');
    const prefix = `[${new Date().toLocaleTimeString(t.locale)}] `;
    const current = consoleElement.textContent === t('Git 작업 결과가 여기에 표시됩니다.') ? '' : `${consoleElement.textContent}\n\n`;
    consoleElement.textContent = `${current}${prefix}${message}`;
    consoleElement.scrollTop = consoleElement.scrollHeight;
    $('gitConsoleDot').classList.replace('bg-white/20', 'bg-cyan-400');
  }

  const actionLabels = {
    fetch: 'Fetch', pull: 'Pull', push: 'Push', stage: t('스테이징'), unstage: t('스테이징 취소'), discard: t('변경 되돌리기'),
    commit: t('커밋'), checkout: t('브랜치 전환'), create_branch: t('브랜치 생성'), delete_branch: t('브랜치 삭제'), merge: t('병합'),
    abort_operation: t('작업 중단'), stash: t('스태시 저장'), stash_apply: t('스태시 적용'), stash_pop: t('스태시 꺼내기'),
    stash_drop: t('스태시 삭제'), undo_commit: t('커밋 취소'), revert: 'Revert', ruff_format: 'ruff format',
  };
  const noisyActions = new Set(['fetch', 'pull', 'push', 'merge', 'commit', 'revert', 'abort_operation']);
  let workflowBusy = false;

  async function runGit(action, payload = {}, { showConsole = false, workflow = false } = {}) {
    if (!state.selectedId || state.busy || (workflowBusy && !workflow)) return null;
    state.busy = true;
    const buttons = document.querySelectorAll('.git-action');
    buttons.forEach((button) => { button.disabled = true; button.classList.add('opacity-50'); });
    const label = actionLabels[action] || action;
    writeConsole(t('{label} 실행 중...', { label }));
    try {
      const result = await api(`/api/git/repositories/${encodeURIComponent(state.selectedId)}/${action}`, { method: 'POST', body: payload });
      writeConsole(`$ ${result.command}\n${result.output}\n\n${result.success ? t('✓ 작업 완료') : t('✕ 작업 실패 (code {code})', { code: result.return_code })}`);
      if (result.success) toast(result.summary ? `${label}: ${result.summary}` : t('{label} 완료', { label }), 'success');
      else toast(`${t('{label} 실패', { label })}\n${result.output.split('\n').slice(0, 4).join('\n')}`, 'error');
      if (showConsole || (!result.success && noisyActions.has(action))) setTab('console');
      return result;
    } catch (error) {
      writeConsole(`✕ ${label}: ${error.message}`);
      toast(error.message, 'error');
      return null;
    } finally {
      state.busy = false;
      buttons.forEach((button) => { button.disabled = workflowBusy; button.classList.remove('opacity-50'); });
      state.detailJson = '';
      await refreshDetail({ quiet: true });
    }
  }

  // Top buttons
  document.querySelectorAll('[data-git-action]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.gitAction;
    const detail = state.detail;
    if (action === 'pull' && !confirm($('gitRebase').checked ? t('원격 변경을 가져와 rebase하시겠습니까?') : t('원격 변경을 가져와 병합하시겠습니까?'))) return;
    if (action === 'push' && !confirm(t('{branch}의 커밋 {count}개를 푸시하시겠습니까?', { branch: detail?.branch || t('현재 브랜치'), count: detail?.ahead || 0 }))) return;
    runGit(action, { rebase: $('gitRebase').checked }, { showConsole: true });
  }));

  $('gitMoreButton').addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = $('gitMoreMenu');
    const open = menu.classList.contains('hidden');
    closeMenus();
    menu.classList.toggle('hidden', !open);
    $('gitMoreButton').setAttribute('aria-expanded', String(open));
  });
  $('gitMoreMenu').addEventListener('click', (event) => {
    const button = event.target.closest('[data-git-more]');
    if (!button) return;
    closeMenus();
    const action = button.dataset.gitMore;
    if (action === 'stash') {
      runGit('stash', { include_untracked: true });
    } else if (action === 'undo_commit') {
      if (confirm(t('마지막 커밋을 취소하시겠습니까? 변경 내용은 스테이징된 상태로 남습니다.'))) runGit('undo_commit');
    } else if (action === 'force_push') {
      if (confirm(t('원격 브랜치를 로컬 기록으로 덮어씁니다 (--force-with-lease). 계속하시겠습니까?'))) runGit('push', { force: true }, { showConsole: true });
    } else if (action === 'refresh') {
      state.detailJson = '';
      refreshDetail();
    }
  });
  $('gitAbortOperation').addEventListener('click', () => {
    if (confirm(t('진행 중인 작업을 중단하고 이전 상태로 되돌리시겠습니까?'))) runGit('abort_operation');
  });

  // Changed-file lists
  function onFileListClick(event) {
    const row = event.target.closest('.git-file-row');
    if (!row) return;
    const path = row.dataset.path;
    const staged = row.dataset.staged === 'true';
    const button = event.target.closest('[data-file-action]');
    if (!button) { loadDiff(path, staged); return; }
    const action = button.dataset.fileAction;
    if (action === 'discard' && !confirm(t('"{path}" 의 변경을 되돌리시겠습니까? 되돌린 내용은 복구할 수 없습니다.', { path }))) return;
    runGit(action, { paths: [path] });
  }
  $('gitStagedList').addEventListener('click', onFileListClick);
  $('gitUnstagedList').addEventListener('click', onFileListClick);
  $('gitStageAll').addEventListener('click', () => runGit('stage', {}));
  $('gitUnstageAll').addEventListener('click', () => runGit('unstage', {}));
  $('gitDiscardAll').addEventListener('click', () => {
    const count = state.detail?.changes.filter((change) => change.unstaged && !change.conflict).length || 0;
    if (!count) return;
    if (confirm(t('스테이징하지 않은 변경 {count}개를 모두 되돌리시겠습니까? 새 파일도 삭제되며 복구할 수 없습니다.', { count }))) runGit('discard', {});
  });

  // Commit
  function draftKey() { return `univdash-git-draft-${state.selectedId}`; }
  function saveDraft() { if (state.selectedId) storageSet(draftKey(), $('gitCommitMessage').value); }
  function loadDraft() {
    $('gitCommitMessage').value = storageGet(draftKey()) || '';
    $('gitCommitAmend').checked = false;
    $('gitCommitStageAll').checked = true;
    updateSummaryLength();
  }
  function updateSummaryLength() {
    const summary = $('gitCommitMessage').value.split('\n')[0];
    const el = $('gitCommitSummaryLength');
    el.textContent = t('요약 {length}/72', { length: summary.length });
    el.className = summary.length > 72 ? 'text-amber-400' : '';
  }
  $('gitCommitMessage').addEventListener('input', () => { updateSummaryLength(); saveDraft(); });
  $('gitCommitAmend').addEventListener('change', () => {
    if ($('gitCommitAmend').checked && !$('gitCommitMessage').value.trim() && state.detail?.commits[0]) {
      $('gitCommitMessage').placeholder = t('비워 두면 기존 메시지 유지: {subject}', { subject: state.detail.commits[0].subject });
    } else {
      $('gitCommitMessage').placeholder = t('커밋 메시지 (첫 줄은 요약, Ctrl+Enter 로 커밋)');
    }
  });

  // With "include all changes" (on by default) the total change count, otherwise the staged count
  function updateCommitCount() {
    const changes = state.detail?.changes || [];
    const count = $('gitCommitStageAll').checked ? changes.length : changes.filter((change) => change.staged).length;
    $('gitCommitButton').innerHTML = `<i class="fas fa-check mr-1"></i>${count ? t('커밋 ({count})', { count }) : t('커밋')}`;
  }
  $('gitCommitStageAll').addEventListener('change', updateCommitCount);

  // ── AI commit message (like VS Code Copilot): send the changes to commit to an OpenAI-compatible API and get a message back ──
  // The settings (URL · model · token) are stored on the server only, and the token never comes back to the browser.
  const UI = () => window.UnivDashUI;
  async function aiSettingsSheet({ thenGenerate = false } = {}) {
    let current;
    try { current = await api('/api/git/ai/settings'); } catch (error) { toast(error.message, 'error'); return; }
    let selectedModel = current.model || '';
    let modelForUrl = '';
    let modelRequest = 0;
    let modelTimer = null;
    UI().formSheet({
      title: t('AI 커밋 메시지 설정'),
      subtitle: t('기본 API: OpenAI 호환 주소를 입력하면 /models 를 조회해 모델을 자동으로 선택합니다. 실패하면 아래 예비 API(OpenAI)로 다시 씁니다. 토큰은 서버에만 저장됩니다.'),
      fields: [
        { name: 'base_url', label: t('API 주소 (Base URL)'), value: current.base_url, placeholder: 'https://api.openai.com/v1', maxlength: 500 },
        { name: 'token', label: current.token_set ? t('Bearer 토큰 (저장됨 · 바꿀 때만 입력)') : t('Bearer 토큰'), value: '', placeholder: current.token_set ? t('••••••••  (비워 두면 그대로)') : 'sk-...', maxlength: 1000 },
      ],
      extraHtml: `<div class="text-xs text-white/60" data-model-status>${current.model ? t('현재 선택 모델: {model}', { model: escapeHtml(current.model) }) : t('주소를 입력하면 사용 가능한 모델을 자동으로 확인합니다.')}</div>
        <label>${t('메시지 언어')}<select name="language">
          <option value="auto" ${current.language === 'auto' ? 'selected' : ''}>${t('자동 (최근 커밋과 같은 언어)')}</option>
          <option value="ko" ${current.language === 'ko' ? 'selected' : ''}>한국어</option>
          <option value="en" ${current.language === 'en' ? 'selected' : ''}>English</option></select></label>
        ${current.token_set ? `<label class="check-row"><input type="checkbox" name="clear_token"> ${t('저장된 토큰 지우기')}</label>` : ''}
        <div class="git-ai-fallback">
          <div class="git-ai-fallback-head"><b>${t('예비 API · OpenAI')}</b><span>${t('기본 API 가 실패하거나 비어 있으면 이것으로 다시 씁니다.')}</span></div>
          <label>${current.fallback_token_set ? t('OpenAI API 키 (저장됨 · 바꿀 때만 입력)') : t('OpenAI API 키')}
            <input name="fallback_token" type="password" autocomplete="new-password" maxlength="1000" spellcheck="false" autocapitalize="off"
              placeholder="${current.fallback_token_set ? t('••••••••  (비워 두면 그대로)') : 'sk-...'}"></label>
          <label>${t('모델')}<span class="git-ai-model-row"><select name="fallback_model" data-fallback-model>
              ${current.fallback_model ? `<option value="${escapeHtml(current.fallback_model)}" selected>${escapeHtml(current.fallback_model)}</option>` : `<option value="">${t('(사용 안 함)')}</option>`}
            </select><button type="button" class="sheet-cancel" data-fallback-load>${t('목록 불러오기')}</button></span></label>
          <div class="text-xs text-white/60" data-fallback-status>${current.fallback_configured ? t('사용 중: {model}', { model: escapeHtml(current.fallback_model) }) : t('키를 넣고 목록을 불러와 모델을 고르십시오.')}</div>
          ${current.fallback_token_set ? `<label class="check-row"><input type="checkbox" name="clear_fallback"> ${t('예비 API 끄기 (저장된 키 지우기)')}</label>` : ''}
        </div>`,
      submitLabel: t('저장'),
      onMount: (body) => {
        const token = body.querySelector('input[name="token"]');
        token.type = 'password';
        token.autocomplete = 'new-password';
        const baseUrl = body.querySelector('input[name="base_url"]');
        const modelStatus = body.querySelector('[data-model-status]');
        const discover = async () => {
          const url = baseUrl.value.trim().replace(/\/+$/, '');
          if (!url) { modelStatus.textContent = t('API 주소를 입력해 주십시오.'); return false; }
          const request = ++modelRequest;
          modelStatus.textContent = t('사용 가능한 모델 확인 중…');
          try {
            const data = await api('/api/git/ai/models', { method: 'POST', body: { base_url: url, token: token.value || null } });
            if (request !== modelRequest) return false;
            selectedModel = data.model;
            modelForUrl = url;
            modelStatus.textContent = data.models.length > 1
              ? t('자동 선택 모델: {model} · 외 {count}개', { model: data.model, count: data.models.length - 1 })
              : t('자동 선택 모델: {model}', { model: data.model });
            return true;
          } catch (error) {
            if (request === modelRequest) modelStatus.textContent = error.message;
            throw error;
          }
        };
        baseUrl.addEventListener('input', () => {
          clearTimeout(modelTimer);
          modelTimer = setTimeout(() => discover().catch(() => {}), 500);
        });
        token.addEventListener('input', () => {
          if (baseUrl.value.trim()) {
            clearTimeout(modelTimer);
            modelTimer = setTimeout(() => discover().catch(() => {}), 500);
          }
        });
        if (baseUrl.value.trim()) discover().catch(() => {});
        body._discoverModel = discover;
        // Fallback API (OpenAI): load /models with the key and pick among the chat models
        const fbToken = body.querySelector('input[name="fallback_token"]');
        const fbSelect = body.querySelector('[data-fallback-model]');
        const fbStatus = body.querySelector('[data-fallback-status]');
        const loadFallback = async () => {
          if (!fbToken.value.trim() && !current.fallback_token_set) { fbStatus.textContent = t('OpenAI API 키를 먼저 입력하십시오.'); return; }
          fbStatus.textContent = t('모델 목록 불러오는 중…');
          try {
            const data = await api('/api/git/ai/models', { method: 'POST', body: { target: 'fallback', token: fbToken.value.trim() || null } });
            const keep = fbSelect.value || data.model;
            fbSelect.innerHTML = `<option value="">${t('(사용 안 함)')}</option>` + data.models.map((m) => `<option value="${escapeHtml(m)}"${m === keep ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('');
            if (!data.models.includes(keep)) fbSelect.value = data.model;
            fbStatus.textContent = t('쓸 수 있는 모델 {count}개', { count: data.models.length });
          } catch (error) { fbStatus.textContent = error.message; }
        };
        body.querySelector('[data-fallback-load]').addEventListener('click', loadFallback);
        let fbTimer = null;
        fbToken.addEventListener('input', () => { clearTimeout(fbTimer); if (fbToken.value.trim().length > 20) fbTimer = setTimeout(loadFallback, 600); });
        if (current.fallback_token_set) loadFallback();
      },
      onSubmit: async (values, body) => {
        const url = (values.base_url || '').trim().replace(/\/+$/, '');
        // The primary API may be left empty (use only the fallback API).
        // Saving is not blocked even when the primary API is down right now (local model etc.): the model is checked again at use time.
        let primaryModel = '';
        if (url) {
          if (modelForUrl !== url || !selectedModel) await body._discoverModel().catch(() => false);
          if (modelForUrl === url && selectedModel) primaryModel = selectedModel;
          else if (url === (current.base_url || '').replace(/\/+$/, '')) primaryModel = current.model || '';
        }
        const token = values.clear_token ? '' : (values.token ? values.token : null);
        const clearFallback = Boolean(values.clear_fallback);
        const fallbackToken = clearFallback ? '' : ((values.fallback_token || '').trim() || null);
        const fallbackModel = clearFallback ? '' : (values.fallback_model || '');
        if (fallbackModel && !fallbackToken && !current.fallback_token_set) throw new Error(t('예비 API 를 쓰려면 OpenAI API 키를 입력하십시오.'));
        await api('/api/git/ai/settings', { method: 'PUT', body: {
          base_url: url, model: primaryModel, token, language: values.language || 'auto',
          fallback_model: fallbackModel, fallback_token: fallbackToken,
        } });
        toast(url && !primaryModel ? t('AI 설정을 저장했습니다. 기본 API 모델은 쓸 때 다시 확인하고, 안 되면 예비 API 로 씁니다.') : t('AI 설정을 저장했습니다.'), 'success');
        if (thenGenerate) setTimeout(generateCommitMessage, 50);
      },
    });
  }
  async function generateCommitMessage() {
    if (!state.selectedId) return;
    const button = $('gitAiMessage');
    try {
      const settings = await api('/api/git/ai/settings');
      if (!settings.configured) { aiSettingsSheet({ thenGenerate: true }); return; }
    } catch (error) { toast(error.message, 'error'); return; }
    const input = $('gitCommitMessage');
    if (input.value.trim() && !confirm(t('지금 쓴 커밋 메시지를 AI 가 쓴 것으로 바꾸시겠습니까?'))) return;
    button.disabled = true;
    button.classList.add('busy');
    button.querySelector('i').className = 'fas fa-circle-notch fa-spin';
    button.querySelector('span').textContent = t('AI가 쓰는 중…');
    try {
      const result = await api(`/api/git/ai/commit-message/${encodeURIComponent(state.selectedId)}`, { method: 'POST', body: { stage_all: $('gitCommitStageAll').checked } });
      input.value = result.message;
      updateSummaryLength();
      saveDraft();
      input.focus();
      if (result.provider === 'fallback' && result.primary_error) toast(t('기본 API 가 실패해서 예비 API({model})로 썼습니다 · {error}', { model: result.model, error: result.primary_error }), 'info');
      if (result.truncated) toast(t('변경이 많아 앞부분만 보고 썼습니다. 한 번 확인해 주십시오.'), 'info');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.classList.remove('busy');
      button.querySelector('i').className = 'fas fa-wand-magic-sparkles';
      button.querySelector('span').textContent = t('AI로 작성');
    }
  }
  $('gitAiMessage').addEventListener('click', generateCommitMessage);
  $('gitAiSettings').addEventListener('click', () => aiSettingsSheet());

  async function commit(pushAfter) {
    const detail = state.detail;
    if (!detail) return;
    const message = $('gitCommitMessage').value;
    const amend = $('gitCommitAmend').checked;
    const stageAll = $('gitCommitStageAll').checked;
    if (!message.trim() && !amend && detail.operation !== 'merge') {
      toast(t('커밋 메시지를 입력하십시오.'), 'error');
      $('gitCommitMessage').focus();
      return;
    }
    if (!stageAll && !amend && detail.operation !== 'merge' && !detail.counts.staged) {
      toast(t('스테이징된 파일이 없습니다. 파일을 스테이징하거나 "모든 변경 포함"을 선택하십시오.'), 'error');
      return;
    }
    let force = false;
    if (amend && pushAfter) {
      const pushedHead = detail.upstream && detail.commits[0]?.pushed;
      if (pushedHead) {
        if (!confirm(t('이미 푸시된 커밋을 수정합니다. 강제 푸시(--force-with-lease)가 필요합니다. 계속하시겠습니까?'))) return;
        force = true;
      }
    }
    const result = await runGit('commit', { message, amend, stage_all: stageAll, push_after: pushAfter, force }, { showConsole: pushAfter });
    if (result?.success) {
      $('gitCommitMessage').value = '';
      saveDraft();
      $('gitCommitAmend').checked = false;
      $('gitCommitStageAll').checked = true;
      updateSummaryLength();
    }
  }
  // Tidy the code before committing: ruff format . at the repository root → show "N files reformatted, M files left unchanged" right away
  $('gitRuffButton').addEventListener('click', async () => {
    const result = await runGit('ruff_format');
    const box = $('gitRuffResult');
    if (!result) return;
    // On a real failure show ruff's own message, not just its last line. A syntax error in a file is only a warning.
    box.textContent = result.success
      ? [result.summary, result.warning].filter(Boolean).join(' · ') || result.output.split('\n').slice(-2).join(' · ')
      : result.output.split('\n').filter((line) => line.trim()).slice(0, 4).join('\n');
    box.className = `mt-1.5 rounded-lg bg-black/25 px-2.5 py-1.5 font-mono text-[11px] whitespace-pre-wrap ${!result.success ? 'text-red-300' : result.warning ? 'text-amber-300' : 'text-emerald-300'}`;
  });
  // ruff format · AI commit · push: the server runs it to the end in a separate process.
  // You can look at another repository or leave the page without waiting; when it finishes a notice shows on any UnivDash page (common.js gitWorkflows).
  const ALL_IN_ONE_LABEL = t('ruff format · AI 커밋 · 푸시');
  const workflows = window.UnivDash.gitWorkflows;
  const workflowStatus = new Map();   // job id → last seen status (to catch the moment it finishes)
  const runningWorkflow = (id) => workflows.jobs().find((job) => job.repository_id === id && job.status === 'running');
  function syncWorkflowButton() {
    const button = $('gitAllInOneButton');
    const label = button.querySelector('span');
    const job = state.selectedId ? runningWorkflow(state.selectedId) : null;
    workflowBusy = !!job;
    button.disabled = !!job;
    button.classList.toggle('is-running', !!job);
    label.textContent = job ? `${job.step_label}…` : ALL_IN_ONE_LABEL;
    [$('gitAiMessage'), $('gitAiSettings')].forEach((item) => { item.disabled = !!job; });
    if (!state.busy) document.querySelectorAll('.git-action').forEach((item) => { item.disabled = !!job; });
  }
  workflows.subscribe((jobs) => {
    for (const job of jobs) {
      const before = workflowStatus.get(job.id);
      workflowStatus.set(job.id, job.status);
      if (before !== 'running' || job.status === 'running' || job.repository_id !== state.selectedId) continue;
      // The workflow of the repository on screen has just finished → apply the result
      if (job.ruff) {
        const ruffBox = $('gitRuffResult');
        ruffBox.textContent = job.ruff;
        ruffBox.className = `mt-1.5 rounded-lg bg-black/25 px-2.5 py-1.5 font-mono text-[11px] ${job.status === 'done' || job.step !== 'ruff' ? 'text-emerald-300' : 'text-red-300'}`;
      }
      if (job.status === 'done') {
        $('gitCommitMessage').value = '';
        $('gitCommitAmend').checked = false;
        $('gitCommitStageAll').checked = true;
        saveDraft();
        updateSummaryLength();
      } else if (job.message && !$('gitCommitMessage').value.trim()) {
        $('gitCommitMessage').value = job.message;   // if only the push failed, keep the generated message
        saveDraft();
        updateSummaryLength();
      }
      refreshDetail({ quiet: true });
    }
    syncWorkflowButton();
  });
  $('gitAllInOneButton').addEventListener('click', async () => {
    if (!state.selectedId || state.busy || workflowBusy) return;
    let settings;
    try { settings = await api('/api/git/ai/settings'); }
    catch (error) { toast(error.message, 'error'); return; }
    if (!settings.configured) {
      toast(t('먼저 AI 커밋 메시지 설정을 해 주십시오.'), 'warn');
      aiSettingsSheet();
      return;
    }
    if (!$('gitCommitStageAll').checked) {
      toast(t('ruff format 결과까지 포함하려면 "모든 변경 포함"을 켜 주십시오.'), 'warn');
      return;
    }
    const branch = state.detail?.branch || t('현재 브랜치');
    if (!confirm(t('{branch}의 모든 변경을 ruff format 한 뒤 AI 커밋 메시지로 커밋하고 푸시하시겠습니까?', { branch }))) return;
    const button = $('gitAllInOneButton');
    button.disabled = true;
    try {
      const job = await api(`/api/git/workflows/${encodeURIComponent(state.selectedId)}`, { method: 'POST' });
      workflowStatus.set(job.id, 'running');
      workflows.started(job);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      syncWorkflowButton();
    }
  });
  $('gitCommitButton').addEventListener('click', () => commit(false));
  $('gitCommitPushButton').addEventListener('click', () => commit(true));
  $('gitCommitMessage').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(false); }
  });

  // Commit log
  $('gitCommitList').addEventListener('click', (event) => {
    const row = event.target.closest('.git-commit-row');
    if (!row) return;
    const hash = row.dataset.hash;
    if (event.target.closest('[data-commit-action="revert"]')) {
      if (confirm(t('{hash} 커밋의 변경을 되돌리는 새 커밋을 만드시겠습니까?', { hash: hash.slice(0, 7) }))) runGit('revert', { commit: hash }, { showConsole: true });
      return;
    }
    openCommit(hash);
  });

  // Branches
  function mergeMode() { return document.querySelector('input[name="gitMergeMode"]:checked')?.value || 'default'; }
  async function onBranchClick(event) {
    const button = event.target.closest('[data-branch-action]');
    if (!button) return;
    const branch = button.closest('[data-branch]').dataset.branch;
    const action = button.dataset.branchAction;
    const detail = state.detail;
    if (action === 'checkout') {
      if (detail.dirty && !confirm(t('작업 트리에 변경사항이 있습니다. 충돌하면 전환이 실패할 수 있습니다. 계속하시겠습니까? (먼저 스태시하는 것을 권장)'))) return;
      runGit('checkout', { branch });
    } else if (action === 'merge') {
      const mode = mergeMode();
      const modeLabel = { default: '', no_ff: ' (--no-ff)', squash: ' (--squash)' }[mode];
      if (!confirm(t('{source} → {target} 병합{mode}을 실행하시겠습니까?', { source: branch, target: detail.branch, mode: modeLabel }))) return;
      const result = await runGit('merge', { branch, no_ff: mode === 'no_ff', squash: mode === 'squash' }, { showConsole: true });
      if (result?.success && mode === 'squash') {
        toast(t('squash 병합은 변경만 스테이징합니다. 커밋 메시지를 작성해 커밋하십시오.'));
        $('gitCommitMessage').value = `Merge branch '${branch}' (squash)`;
        setTab('changes');
      }
    } else if (action === 'delete') {
      if (!confirm(t('로컬 브랜치 {branch} 를 삭제하시겠습니까?', { branch }))) return;
      const result = await runGit('delete_branch', { branch });
      if (result && !result.success && /not fully merged/.test(result.output)
        && confirm(t('{branch} 는 아직 병합되지 않은 커밋이 있습니다. 강제로 삭제하시겠습니까? (커밋을 잃을 수 있음)', { branch }))) {
        runGit('delete_branch', { branch, force: true });
      }
    }
  }
  $('gitBranchList').addEventListener('click', onBranchClick);
  $('gitRemoteBranchList').addEventListener('click', onBranchClick);
  $('gitCreateBranchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('gitNewBranchName').value.trim();
    if (!name) return;
    const result = await runGit('create_branch', {
      branch: name,
      start_point: $('gitNewBranchStart').value || null,
      switch: $('gitNewBranchSwitch').checked,
    });
    if (result?.success) $('gitNewBranchName').value = '';
  });

  // Stash
  $('gitStashForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await runGit('stash', { message: $('gitStashMessage').value, include_untracked: $('gitStashUntracked').checked });
    if (result?.success) $('gitStashMessage').value = '';
  });
  $('gitStashList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-stash-action]');
    if (!button) return;
    const ref = button.closest('[data-stash]').dataset.stash;
    const action = button.dataset.stashAction;
    if (action === 'stash_drop' && !confirm(t('{ref} 를 삭제하시겠습니까? 복구할 수 없습니다.', { ref }))) return;
    runGit(action, { stash_ref: ref });
  });

  // Console
  $('gitClearConsole').addEventListener('click', () => {
    $('gitConsole').textContent = t('Git 작업 결과가 여기에 표시됩니다.');
    $('gitConsoleDot').classList.replace('bg-cyan-400', 'bg-white/20');
  });

  // Sidebar controls
  $('gitRepositorySearch').addEventListener('input', renderList);
  $('gitRefreshRepositories').addEventListener('click', () => loadRepositories());
  $('gitNewFolder').addEventListener('click', () => createFolder());
  $('gitToggleHidden').addEventListener('click', () => {
    state.showHidden = !state.showHidden;
    $('gitToggleHidden').setAttribute('aria-pressed', String(state.showHidden));
    $('gitToggleHidden').querySelector('i').className = `fas ${state.showHidden ? 'fa-eye' : 'fa-eye-slash'} text-xs`;
    renderList();
  });
  document.querySelectorAll('.git-filter').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.gitFilter;
    document.querySelectorAll('.git-filter').forEach((item) => {
      const active = item === button;
      item.classList.toggle('bg-white/10', active);
      item.classList.toggle('text-white', active);
      item.classList.toggle('text-white/50', !active);
    });
    renderList();
  }));
  document.querySelectorAll('.git-tab').forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.gitTab)));
  $('gitAutoPullEnabled').addEventListener('change', saveAutoPull);
  $('gitAutoPullInterval').addEventListener('change', saveAutoPull);

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.git-menu') && !event.target.closest('#gitMoreButton')) closeMenus();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeMenus(); closeCommitModal(); }
  });
  window.addEventListener('resize', closeMenus);
  $('gitRepositoryList').addEventListener('scroll', closeMenus);

  // Periodic refresh: only while the page is visible and no action is running
  setInterval(() => {
    if (document.visibilityState === 'visible' && !state.busy) refreshDetail({ quiet: true });
  }, 15000);
  setInterval(() => {
    if (document.visibilityState === 'visible' && !state.busy) loadRepositories({ quiet: true });
  }, 60000);

  loadRepositories();

  // On phones the detail sits below the list, so picking a repository scrolls down to the detail.
  if (window.matchMedia('(max-width: 1279.98px)').matches) {
    document.getElementById('gitRepositoryList')?.addEventListener('click', (event) => {
      if (!event.target.closest('.git-repo-item') || event.target.closest('button[data-repo-menu], .git-row-actions')) return;
      setTimeout(() => document.getElementById('gitRepositoryDetail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);
    });
  }

  $('gitSortBtn').addEventListener('click', () => {
    const current = sortMode();
    window.UnivDashUI.actionSheet({
      title: t('저장소 정렬 기준'),
      subtitle: t('즐겨찾기 · 폴더 · 미분류 안에서 정렬됩니다. 휴대폰 · PC 에 같이 적용됩니다.'),
      actions: Object.entries(SORTS).map(([id, sort]) => ({
        icon: sort.icon, label: sort.label, desc: sort.desc, sub: id === current ? '✓' : '', current: id === current,
        onClick: () => { state.prefs.sort = id; renderList(); savePrefs(); },
      })),
    });
  });
})();
