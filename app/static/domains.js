// Domains 페이지: nginx 도메인 · 경로 · 인증서 · 표시용 폴더 관리
(function () {
  'use strict';
  const { escapeHtml, api, toast } = window.UnivDash;
  const $ = (id) => document.getElementById(id);
  const list = $('domainList');
  if (!list) return;

  const state = {
    groups: [],
    folders: [],
    helper: { ready: false },
    collapsed: new Map(),  // 폴더 ID → 접힘 여부 (처음에는 폴더만 접어 둔다)
    openDomains: new Set(),
    pathDomain: '',
    pathValue: '',
    renameDomain: '',
    deleteDomain: '',
    moveDomain: '',
    folderId: '',
    dragging: null,
    dragged: false,
  };

  const allDomains = () => state.groups.flatMap((group) => group.domains);
  const domainInfo = (name) => allDomains().find((item) => item.domain === name);
  const routeOf = (domain, path) => `${domain}${path === '/' ? '' : path}`;
  const icon = (name, label, attrs, tone = '') => `<button type="button" class="dom-icon ${tone}" title="${label}" aria-label="${label}" ${attrs}><i class="fas ${name}"></i></button>`;
  const isCollapsed = (group) => (state.collapsed.has(group.id) ? state.collapsed.get(group.id) : Boolean(group.id));

  function matches(domain, folderName, query) {
    if (!query) return true;
    if (folderName.toLowerCase().includes(query)) return true;
    const paths = domain.paths.map((item) => `${item.path} ${item.port}`).join(' ');
    return `${domain.domain} ${domain.filename} ${domain.primary_port ?? ''} ${paths}`.toLowerCase().includes(query);
  }

  function portCell(domain) {
    const main = domain.primary_port
      ? `<span class="dom-port">:${domain.primary_port}</span>`
      : '<span class="text-xs text-white/30">—</span>';
    const others = [...new Set(domain.paths.map((item) => item.port))]
      .filter((port) => port !== 'N/A' && port !== String(domain.primary_port));
    return main + (others.length ? `<span class="ml-1 font-mono text-[10px] text-white/40">+${escapeHtml(others.join(', '))}</span>` : '');
  }

  function pathsPanel(domain) {
    const rows = domain.paths.map((item) => `
      <div class="dom-path-row">
        <span class="min-w-0 break-all font-mono text-white/70">${escapeHtml(routeOf(domain.domain, item.path))}</span>
        <span class="font-mono text-white/50">:${escapeHtml(item.port)}</span>
        <span class="flex justify-end gap-1">
          <button type="button" class="dom-text-btn" data-action="edit-path" data-domain="${escapeHtml(domain.domain)}" data-path="${escapeHtml(item.path)}" data-port="${escapeHtml(item.port)}">수정</button>
          <button type="button" class="dom-text-btn dom-text-danger" data-action="delete-path" data-domain="${escapeHtml(domain.domain)}" data-path="${escapeHtml(item.path)}">삭제</button>
        </span>
      </div>`).join('');
    return `<div class="dom-paths">${rows || '<p class="text-white/35">경로가 없습니다.</p>'}</div>`;
  }

  function domainRow(domain, inFolder) {
    const open = state.openDomains.has(domain.domain);
    const name = escapeHtml(domain.domain);
    return `
      <div class="dom-item" data-domain-item="${name}">
        <div class="dom-row ${inFolder ? 'dom-in-folder' : ''}" draggable="true" data-domain="${name}" role="button" tabindex="0" aria-expanded="${open}">
          <div class="dom-cell-name">
            <i class="fas fa-chevron-${open ? 'down' : 'right'} w-3 text-[9px] text-white/40"></i>
            <span class="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-cyan-400"></span>
            <a href="https://${name}" target="_blank" rel="noopener noreferrer" draggable="false" class="min-w-0 break-all text-xs font-bold text-white/80 hover:text-cyan-300 hover:underline">${name}</a>
          </div>
          <div data-label="Port">${portCell(domain)}</div>
          <div data-label="Paths"><span class="font-mono text-[11px] text-white/50">${domain.paths.length}개</span></div>
          <div data-label="Config File" class="min-w-0 truncate font-mono text-[11px] text-white/40">${escapeHtml(domain.filename)}</div>
          <div class="dom-cell-actions">
            ${icon('fa-folder', '폴더 이동', `data-action="move" data-domain="${name}"`)}
            ${icon('fa-pen', '도메인 이름 변경 (포트 유지)', `data-action="rename" data-domain="${name}"`)}
            ${icon('fa-plus', '경로 추가', `data-action="add-path" data-domain="${name}"`)}
            ${icon('fa-trash-can', '도메인 전체 삭제', `data-action="delete" data-domain="${name}"`, 'dom-icon-danger')}
          </div>
        </div>
        ${open ? pathsPanel(domain) : ''}
      </div>`;
  }

  function groupBlock(group, query, showHeader) {
    const visible = group.domains.filter((domain) => matches(domain, group.name, query));
    if (query && !visible.length && !group.name.toLowerCase().includes(query)) return '';
    const collapsed = !query && isCollapsed(group);
    const key = escapeHtml(group.id || '');
    const ports = group.ports.length
      ? group.ports.map((port) => `<span class="dom-port dom-port-small">:${port}</span>`).join('')
      : '<span class="font-mono text-[10px] text-white/30">포트 없음</span>';
    const actions = group.id ? `
      <span class="flex flex-shrink-0 gap-1">
        ${icon('fa-pen', '폴더 이름 변경', `data-action="rename-folder" data-folder="${key}"`)}
        ${icon('fa-trash-can', '폴더 삭제 (도메인은 유지)', `data-action="delete-folder" data-folder="${key}"`, 'dom-icon-danger')}
      </span>` : '';
    const header = showHeader ? `
      <div class="dom-folder-head" data-folder-toggle role="button" tabindex="0" aria-expanded="${!collapsed}">
        <div class="flex min-w-0 items-center gap-2">
          <i class="fas fa-chevron-${collapsed ? 'right' : 'down'} w-3 text-[9px] text-white/40"></i>
          <i class="fas ${collapsed ? 'fa-folder' : 'fa-folder-open'} text-xs ${group.id ? 'text-amber-400' : 'text-white/30'}"></i>
          <span class="truncate text-xs font-bold text-white/80">${escapeHtml(group.name)}</span>
          <span class="flex-shrink-0 text-[10px] text-white/35">${group.domains.length}개 도메인</span>
        </div>
        <div class="flex min-w-0 flex-wrap items-center gap-1">${ports}</div>
        ${actions}
      </div>` : '';
    const empty = group.id
      ? '이 폴더에 담긴 도메인이 없습니다. 도메인을 끌어다 놓거나 폴더 이동 버튼을 쓰세요.'
      : '모든 도메인이 폴더에 들어가 있습니다.';
    const body = collapsed ? '' : (visible.map((domain) => domainRow(domain, Boolean(group.id))).join('')
      || (query ? '' : `<p class="dom-empty">${empty}</p>`));
    return `<div class="dom-group" data-group="${key}">${header}${body}</div>`;
  }

  function render() {
    const query = $('domainSearch').value.trim().toLowerCase();
    const hasDomains = allDomains().length > 0;
    if (!hasDomains && !state.folders.length) {
      list.innerHTML = '<p class="p-10 text-center text-xs text-white/35">등록된 도메인이 없습니다.</p>';
      return;
    }
    const hasFolders = state.folders.length > 0;
    const blocks = state.groups
      .filter((group) => group.id || group.domains.length || hasFolders)
      .map((group) => groupBlock(group, query, Boolean(group.id) || hasFolders))
      .join('');
    list.innerHTML = blocks || '<p class="p-10 text-center text-xs text-white/35">일치하는 도메인이나 폴더가 없습니다. 검색어를 지우면 전체 목록이 다시 표시됩니다.</p>';
  }

  function renderHelper() {
    const { helper } = state;
    $('domainHelperBanner').classList.toggle('hidden', Boolean(helper.ready));
    if (helper.ready) return;
    $('domainHelperText').textContent = helper.reason === 'outdated'
      ? 'Nginx 헬퍼가 현재 코드와 달라 다시 설치해야 합니다.'
      : '도메인을 바꾸려면 Nginx 헬퍼를 한 번 설치해야 합니다.';
    $('domainHelperCommand').textContent = helper.command || '';
  }

  function renderFolderSelects() {
    const options = ['<option value="">미분류</option>']
      .concat(state.folders.map((folder) => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</option>`))
      .join('');
    document.querySelectorAll('[data-folder-select]').forEach((select) => { select.innerHTML = options; });
  }

  async function load() {
    try {
      const data = await api('/api/domains');
      state.groups = data.groups;
      state.folders = data.folders;
      state.helper = data.helper;
      renderHelper();
      renderFolderSelects();
      render();
    } catch (error) {
      list.innerHTML = `<p class="p-10 text-center text-xs text-red-400">${escapeHtml(error.message)}</p>`;
    }
  }

  // ── 모달 ────────────────────────────────────────────────────────────
  function openModal(id) {
    const modal = $(id);
    modal.classList.remove('hidden');
    modal.querySelector('input:not([type=hidden]), select')?.focus();
  }
  function closeModals() {
    document.querySelectorAll('.dom-modal').forEach((modal) => modal.classList.add('hidden'));
  }
  function requireHelper() {
    if (state.helper.ready) return true;
    toast('먼저 Nginx 헬퍼를 설치해 주세요.', 'error');
    return false;
  }
  function selfWarning(form, domain) {
    const warning = form.querySelector('.dom-self-warning');
    const self = domain === location.hostname;
    warning.classList.toggle('hidden', !self);
    warning.textContent = self ? '지금 이 대시보드에 접속 중인 도메인입니다. 진행하면 이 주소로 접속하지 못하게 될 수 있어요.' : '';
  }
  const formValues = (form) => Object.fromEntries(new FormData(form).entries());

  async function submitting(form, task) {
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try { await task(); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
  }

  // ── 콘솔 ────────────────────────────────────────────────────────────
  function runConsole(payload) {
    const output = $('domConsoleOutput');
    const close = $('domConsoleClose');
    const title = $('domConsoleTitle');
    const addLine = (text, tone = '') => {
      const line = document.createElement('div');
      line.className = `whitespace-pre-wrap break-all ${tone}`;
      line.textContent = text;
      output.appendChild(line);
      output.scrollTop = output.scrollHeight;
    };
    output.textContent = '';
    close.classList.add('hidden');
    title.textContent = '실행 중...';
    $('domConsoleModal').classList.remove('hidden');
    let finished = false;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/ws/domains/console`);
    socket.onopen = () => socket.send(JSON.stringify(payload));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.line !== undefined) addLine(message.line, message.line.startsWith('실패') ? 'text-red-400' : '');
      if (message.done) {
        finished = true;
        title.textContent = message.ok ? '완료' : '실패';
        addLine(message.ok ? '작업이 완료되었습니다.' : '작업이 실패했습니다.', message.ok ? 'text-emerald-400' : 'text-red-400');
      }
    };
    socket.onclose = () => {
      if (!finished) {
        title.textContent = '연결 끊김';
        addLine('연결이 끊겼어요. 서버에서는 작업이 끝까지 진행됩니다. 잠시 뒤 목록을 확인해 주세요.', 'text-amber-300');
      }
      close.classList.remove('hidden');
      close.focus();
    };
  }
  $('domConsoleClose').addEventListener('click', () => {
    $('domConsoleModal').classList.add('hidden');
    load();
  });

  // ── 목록 동작 ───────────────────────────────────────────────────────
  function openRename(domain) {
    if (!requireHelper()) return;
    state.renameDomain = domain;
    const form = $('domRenameForm');
    form.reset();
    $('domRenameOld').textContent = domain;
    const kept = $('domRenameKept');
    kept.textContent = '';
    (domainInfo(domain)?.paths || []).forEach((item) => {
      const line = document.createElement('div');
      line.textContent = `${item.path} → :${item.port}`;
      kept.appendChild(line);
    });
    selfWarning(form, domain);
    openModal('domRenameModal');
    form.new_domain.focus();
  }

  function openDelete(domain) {
    if (!requireHelper()) return;
    state.deleteDomain = domain;
    $('domDeleteTarget').textContent = domain;
    $('domDeleteInput').value = '';
    $('domDeleteConfirm').disabled = true;
    selfWarning($('domDeleteForm'), domain);
    openModal('domDeleteModal');
  }

  function openFolderModal(folder) {
    state.folderId = folder?.id || '';
    $('domFolderTitle').textContent = folder ? '폴더 이름 변경' : '새 폴더';
    const form = $('domFolderForm');
    form.reset();
    if (folder) form.name.value = folder.name;
    openModal('domFolderModal');
  }

  async function deletePath(domain, path) {
    if (!requireHelper()) return;
    if (!confirm(`${routeOf(domain, path)} 경로를 삭제할까요?`)) return;
    try {
      const result = await api('/api/domains/paths/delete', { method: 'POST', body: { domain, path } });
      if (result.requires_full_delete) {
        toast('마지막 경로예요. 지우려면 도메인 전체를 삭제해야 합니다.');
        openDelete(domain);
        return;
      }
      await load();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function deleteFolder(id) {
    const folder = state.folders.find((item) => item.id === id);
    if (!folder || !confirm(`'${folder.name}' 폴더를 삭제할까요?\n\n안에 있던 도메인은 미분류로 이동하며, nginx 설정과 인증서는 그대로입니다.`)) return;
    try {
      await api(`/api/domains/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function assign(domain, folderId) {
    try {
      await api('/api/domains/folders/assign', { method: 'POST', body: { domain, folder_id: folderId || null } });
      if (folderId) state.collapsed.set(folderId, false);
      await load();
    } catch (error) { toast(error.message, 'error'); }
  }

  function toggleFolder(group) {
    if ($('domainSearch').value.trim()) {
      $('domainSearch').value = '';
      state.collapsed.set(group.id, false);
    } else {
      state.collapsed.set(group.id, !isCollapsed(group));
    }
    render();
  }

  function toggleDomain(domain) {
    if (state.openDomains.has(domain)) state.openDomains.delete(domain);
    else state.openDomains.add(domain);
    render();
  }

  const actions = {
    move(button) {
      state.moveDomain = button.dataset.domain;
      $('domMoveLabel').textContent = state.moveDomain;
      const current = state.groups.find((group) => group.domains.some((item) => item.domain === state.moveDomain));
      $('domMoveForm').folder_id.value = current?.id || '';
      openModal('domMoveModal');
    },
    rename: (button) => openRename(button.dataset.domain),
    delete: (button) => openDelete(button.dataset.domain),
    'add-path': (button) => {
      if (!requireHelper()) return;
      state.pathDomain = button.dataset.domain;
      $('domAddPathLabel').textContent = state.pathDomain;
      $('domAddPathForm').reset();
      openModal('domAddPathModal');
    },
    'edit-path': (button) => {
      if (!requireHelper()) return;
      state.pathDomain = button.dataset.domain;
      state.pathValue = button.dataset.path;
      $('domEditPathLabel').textContent = routeOf(state.pathDomain, state.pathValue);
      $('domEditPathForm').port.value = button.dataset.port === 'N/A' ? '' : button.dataset.port;
      openModal('domEditPathModal');
    },
    'delete-path': (button) => deletePath(button.dataset.domain, button.dataset.path),
    'rename-folder': (button) => openFolderModal(state.folders.find((item) => item.id === button.dataset.folder)),
    'delete-folder': (button) => deleteFolder(button.dataset.folder),
  };

  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button) { actions[button.dataset.action]?.(button); return; }
    if (event.target.closest('a')) return;
    const head = event.target.closest('[data-folder-toggle]');
    if (head) {
      const key = head.closest('[data-group]').dataset.group;
      const group = state.groups.find((item) => (item.id || '') === key);
      if (group) toggleFolder(group);
      return;
    }
    const row = event.target.closest('.dom-row');
    if (row && !state.dragged) toggleDomain(row.dataset.domain);
  });
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!event.target.matches('.dom-row, [data-folder-toggle]')) return;
    event.preventDefault();
    event.target.click();
  });

  // ── 드래그 ──────────────────────────────────────────────────────────
  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest?.('.dom-row');
    if (!row) return;
    state.dragging = row.dataset.domain;
    state.dragged = true;
    row.classList.add('dom-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', state.dragging);
  });
  list.addEventListener('dragend', (event) => {
    event.target.closest?.('.dom-row')?.classList.remove('dom-dragging');
    list.querySelectorAll('.dom-drop').forEach((group) => group.classList.remove('dom-drop'));
    state.dragging = null;
    setTimeout(() => { state.dragged = false; }, 0);
  });
  list.addEventListener('dragover', (event) => {
    const group = event.target.closest('[data-group]');
    if (!state.dragging || !group) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    list.querySelectorAll('.dom-drop').forEach((item) => { if (item !== group) item.classList.remove('dom-drop'); });
    group.classList.add('dom-drop');
  });
  list.addEventListener('drop', (event) => {
    const group = event.target.closest('[data-group]');
    if (!state.dragging || !group) return;
    event.preventDefault();
    const domain = state.dragging;
    const current = state.groups.find((item) => item.domains.some((entry) => entry.domain === domain));
    if ((current?.id || '') !== group.dataset.group) assign(domain, group.dataset.group);
  });

  // ── 폼 ──────────────────────────────────────────────────────────────
  $('domainSearch').addEventListener('input', render);
  $('domainNewFolder').addEventListener('click', () => openFolderModal(null));
  $('domainAdd').addEventListener('click', () => {
    if (!requireHelper()) return;
    $('domAddForm').reset();
    renderFolderSelects();
    openModal('domAddModal');
  });
  document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', closeModals));

  $('domAddForm').addEventListener('submit', (event) => {
    event.preventDefault();
    closeModals();
    runConsole({ action: 'add', ...formValues(event.target) });
  });
  $('domAddPathForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    submitting(form, async () => {
      await api('/api/domains/paths', { method: 'POST', body: { domain: state.pathDomain, ...formValues(form) } });
      closeModals();
      await load();
    });
  });
  $('domEditPathForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    submitting(form, async () => {
      await api('/api/domains/paths', { method: 'PUT', body: { domain: state.pathDomain, path: state.pathValue, port: form.port.value } });
      closeModals();
      await load();
    });
  });
  $('domRenameForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    const oldDomain = state.renameDomain;
    const newDomain = form.new_domain.value.trim().toLowerCase();
    const email = form.email.value.trim();
    submitting(form, async () => {
      await api('/api/domains/rename/check', { method: 'POST', body: { old_domain: oldDomain, new_domain: newDomain } });
      if (!confirm(`${oldDomain} → ${newDomain}\n\n경로와 포트는 유지되고, 새 도메인으로 SSL 인증서를 다시 발급합니다. 진행할까요?`)) return;
      closeModals();
      runConsole({ action: 'rename', old_domain: oldDomain, new_domain: newDomain, email });
    });
  });
  $('domDeleteInput').addEventListener('input', (event) => {
    $('domDeleteConfirm').disabled = event.target.value !== state.deleteDomain;
  });
  $('domDeleteForm').addEventListener('submit', (event) => {
    event.preventDefault();
    if ($('domDeleteInput').value !== state.deleteDomain) return;
    const domain = state.deleteDomain;
    closeModals();
    runConsole({ action: 'delete', domain });
  });
  $('domFolderForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    submitting(form, async () => {
      const name = form.name.value;
      if (state.folderId) await api(`/api/domains/folders/${encodeURIComponent(state.folderId)}`, { method: 'PUT', body: { name } });
      else await api('/api/domains/folders', { method: 'POST', body: { name } });
      closeModals();
      await load();
    });
  });
  $('domMoveForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const folderId = event.target.folder_id.value;
    closeModals();
    assign(state.moveDomain, folderId);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModals();
  });
  document.querySelectorAll('.dom-modal').forEach((modal) => modal.addEventListener('mousedown', (event) => {
    if (event.target === modal) closeModals();
  }));

  load();
})();
