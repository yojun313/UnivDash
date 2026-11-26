// Explorer: browse and manage the server's folders and files like the VS Code explorer.
// - UnivDashExplorer.mountTree(container, options)   folder tree (shared by the Explorer page and the Workspace [Files] tab)
// - UnivDashExplorer.mountViewer(container, options) file viewer (syntax highlighting · images · download)
// Settings (pinned folders · hidden items · per-folder order · sort · dotfiles) are saved on the server and shared by phone and PC.
(function () {
  'use strict';
  const { escapeHtml, api, toast } = window.UnivDash;
  const ui = () => window.UnivDashUI;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const ENV_NAME = /^\.env(\..+)?$/;   // .env · .env.local · .env.example …
  const showEnv = () => { try { const v = localStorage.getItem('univdash-ex-show-env'); return v === null ? true : JSON.parse(v) !== false; } catch (e) { return true; } };
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(`univdash-ex-${key}`); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(`univdash-ex-${key}`, JSON.stringify(value)); } catch (e) { /* noop */ } },
  };

  // ── Shared state (a page has only one tree, but settings and the clipboard are shared) ─────────────
  const shared = { prefs: null, roots: [], home: '', clipboard: null, loading: null };
  const SORTS = {
    name: { label: t('이름 (폴더 먼저)'), icon: 'fa-arrow-down-a-z', desc: t('VS Code 기본') },
    mixed: { label: t('이름 (섞어서)'), icon: 'fa-shuffle', desc: t('폴더와 파일을 이름순으로 함께') },
    type: { label: t('종류'), icon: 'fa-shapes', desc: t('확장자별로 묶어서') },
    modified: { label: t('수정한 날짜'), icon: 'fa-clock', desc: t('최근에 바꾼 것 먼저') },
    size: { label: t('크기'), icon: 'fa-weight-hanging', desc: t('큰 파일 먼저') },
    manual: { label: t('직접 지정'), icon: 'fa-hand-pointer', desc: t('끌어서(휴대폰은 길게 눌러) 순서 변경') },
  };

  async function loadPrefs() {
    if (shared.prefs) return shared.prefs;
    if (!shared.loading) {
      shared.loading = api('/api/fs/prefs').then((data) => {
        shared.prefs = data.prefs;
        shared.roots = data.roots;
        shared.home = data.home;
        return shared.prefs;
      });
    }
    return shared.loading;
  }
  let saveTimer = null;
  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api('/api/fs/prefs', { method: 'PUT', body: shared.prefs }).catch((error) => toast(t('Explorer 설정 저장 실패: {error}', { error: error.message }), 'error'));
    }, 250);
  }

  const basename = (path) => path.replace(/\/+$/, '').split('/').pop() || '/';
  const dirname = (path) => path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
  const expandHome = (path) => (path.startsWith('~') ? shared.home + path.slice(1) : path);
  const shortHome = (path) => (shared.home && (path === shared.home || path.startsWith(`${shared.home}/`)) ? `~${path.slice(shared.home.length)}` : path);

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  function formatTime(epoch) {
    const date = new Date(epoch * 1000);
    const today = new Date().toDateString() === date.toDateString();
    return date.toLocaleString(t.locale, today ? { hour: '2-digit', minute: '2-digit' } : { year: '2-digit', month: 'numeric', day: 'numeric' });
  }

  const ICONS = {
    py: ['fa-brands fa-python', '#60a5fa'], js: ['fa-brands fa-js', '#facc15'], mjs: ['fa-brands fa-js', '#facc15'], ts: ['fas fa-code', '#3b82f6'], tsx: ['fa-brands fa-react', '#38bdf8'], jsx: ['fa-brands fa-react', '#38bdf8'],
    html: ['fa-brands fa-html5', '#f97316'], css: ['fa-brands fa-css3-alt', '#3b82f6'], scss: ['fa-brands fa-sass', '#ec4899'], json: ['fas fa-code', '#facc15'], md: ['fa-brands fa-markdown', '#94a3b8'],
    sh: ['fas fa-terminal', '#34d399'], bash: ['fas fa-terminal', '#34d399'], zsh: ['fas fa-terminal', '#34d399'], go: ['fa-brands fa-golang', '#22d3ee'], rs: ['fa-brands fa-rust', '#fb923c'], java: ['fa-brands fa-java', '#f87171'],
    php: ['fa-brands fa-php', '#a78bfa'], swift: ['fa-brands fa-swift', '#fb923c'], yml: ['fas fa-sliders', '#f472b6'], yaml: ['fas fa-sliders', '#f472b6'], toml: ['fas fa-sliders', '#f472b6'], ini: ['fas fa-sliders', '#94a3b8'], env: ['fas fa-key', '#fbbf24'],
    lock: ['fas fa-lock', '#94a3b8'], txt: ['fas fa-file-lines', '#cbd5e1'], log: ['fas fa-file-lines', '#94a3b8'], csv: ['fas fa-file-csv', '#34d399'], xlsx: ['fas fa-file-excel', '#22c55e'], pdf: ['fas fa-file-pdf', '#f87171'],
    zip: ['fas fa-file-zipper', '#fbbf24'], gz: ['fas fa-file-zipper', '#fbbf24'], tar: ['fas fa-file-zipper', '#fbbf24'], sql: ['fas fa-database', '#60a5fa'], db: ['fas fa-database', '#60a5fa'], sqlite: ['fas fa-database', '#60a5fa'],
    hwp: ['fas fa-file-lines', '#38bdf8'], hwpx: ['fas fa-file-lines', '#38bdf8'], doc: ['fas fa-file-word', '#3b82f6'], odt: ['fas fa-file-word', '#3b82f6'], rtf: ['fas fa-file-word', '#3b82f6'],
    xls: ['fas fa-file-excel', '#22c55e'], ods: ['fas fa-file-excel', '#22c55e'], tsv: ['fas fa-file-csv', '#34d399'], pptx: ['fas fa-file-powerpoint', '#f97316'], ppt: ['fas fa-file-powerpoint', '#f97316'], odp: ['fas fa-file-powerpoint', '#f97316'],
    '7z': ['fas fa-file-zipper', '#fbbf24'], rar: ['fas fa-file-zipper', '#fbbf24'], tgz: ['fas fa-file-zipper', '#fbbf24'], jar: ['fas fa-file-zipper', '#fbbf24'], sqlite3: ['fas fa-database', '#60a5fa'],
    heic: ['fas fa-file-image', '#a78bfa'], heif: ['fas fa-file-image', '#a78bfa'], tif: ['fas fa-file-image', '#a78bfa'], tiff: ['fas fa-file-image', '#a78bfa'], mkv: ['fas fa-file-video', '#c084fc'], webm: ['fas fa-file-video', '#c084fc'],
    mp4: ['fas fa-file-video', '#c084fc'], mov: ['fas fa-file-video', '#c084fc'], mp3: ['fas fa-file-audio', '#c084fc'], wav: ['fas fa-file-audio', '#c084fc'], ipynb: ['fas fa-book', '#fb923c'], docx: ['fas fa-file-word', '#3b82f6'],
  };
  const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
  function iconFor(entry, open = false) {
    if (entry.type === 'dir') return `<i class="ex-icon fas ${open ? 'fa-folder-open' : 'fa-folder'}" style="color:#7dd3fc"></i>`;
    if (IMAGE_EXT.has(entry.ext)) return '<i class="ex-icon fas fa-file-image" style="color:#a78bfa"></i>';
    const name = entry.name.toLowerCase();
    const [cls, color] = name === 'dockerfile' ? ['fa-brands fa-docker', '#38bdf8'] : name.startsWith('.git') ? ['fa-brands fa-git-alt', '#f97316']
      : name === 'readme.md' ? ['fas fa-circle-info', '#60a5fa'] : ICONS[entry.ext] || ['far fa-file', '#94a3b8'];
    return `<i class="ex-icon ${cls}" style="color:${color}"></i>`;
  }

  async function copyText(text, label = t('복사했습니다')) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) { toast(t('복사하지 못했습니다.'), 'error'); return; }
    }
    toast(`${label}: ${text}`, 'success');
  }

  // ── Menu: a popup next to the cursor on desktop, a bottom sheet on phones ─────────────────────────────
  let popup = null;
  function closePopup() { popup?.remove(); popup = null; }
  document.addEventListener('click', (event) => { if (popup && !popup.contains(event.target)) closePopup(); }, true);
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePopup(); });
  window.addEventListener('resize', closePopup);
  function openMenu({ title, subtitle, items, x, y }) {
    closePopup();
    const actions = items.filter(Boolean);
    if (coarse || x == null) {
      ui().actionSheet({ title, subtitle, actions: actions.map((item) => (item === 'sep' ? 'sep' : { icon: item.icon, label: item.label, danger: item.danger, sub: item.sub, onClick: item.onClick })) });
      return;
    }
    popup = document.createElement('div');
    popup.className = 'git-menu fixed w-64 ex-menu';
    popup.setAttribute('role', 'menu');
    popup.innerHTML = `<div class="git-menu-label">${escapeHtml(title)}</div>${actions.map((item, i) => (item === 'sep' ? '<hr>'
      : `<button type="button" data-i="${i}" class="${item.danger ? 'danger' : ''}"><i class="fas ${item.icon}"></i><span class="flex-1 truncate">${escapeHtml(item.label)}</span>${item.sub ? `<span class="text-[10px] opacity-50">${escapeHtml(item.sub)}</span>` : ''}</button>`)).join('')}`;
    document.body.appendChild(popup);
    const rect = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    popup.style.top = `${Math.max(8, y + rect.height > window.innerHeight - 8 ? y - rect.height : y)}px`;
    popup.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-i]');
      if (!button) return;
      const item = actions[Number(button.dataset.i)];
      closePopup();
      item.onClick?.();
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Tree
  // ════════════════════════════════════════════════════════════════════════
  function mountTree(container, options = {}) {
    const cache = new Map();          // folder path → entries
    const pending = new Map();
    let expanded = new Set(store.get('expanded', []));
    let root = store.get('root', null);
    let selected = store.get('selected', null);
    let picked = new Set(selected ? [selected] : []);
    let pendingScroll = store.get('tree-scroll', 0);   // on the first render, restore the previous scroll position
    let sortables = [];
    let searchSeq = 0;

    container.classList.add('ex');
    container.setAttribute('data-explorer', '');
    container.innerHTML = `
      <div class="ex-head">
        <button type="button" class="ex-root" data-act="root" title="${t('루트 폴더 바꾸기')}"><i class="fas fa-folder-tree"></i><span class="ex-root-name">…</span><i class="fas fa-chevron-down text-[9px] opacity-60"></i></button>
        <div class="ex-tools">
          <button type="button" data-act="new-file" title="${t('새 파일')}" aria-label="${t('새 파일')}"><i class="fas fa-file-circle-plus"></i></button>
          <button type="button" data-act="new-folder" title="${t('새 폴더')}" aria-label="${t('새 폴더')}"><i class="fas fa-folder-plus"></i></button>
          <button type="button" data-act="upload" title="${t('선택한 폴더에 업로드')}" aria-label="${t('업로드')}"><i class="fas fa-upload"></i></button>
          ${options.showWidthReset ? `<button type="button" data-act="reset-width" title="${t('폴더 트리 기본 폭으로')}" aria-label="${t('폴더 트리 기본 폭으로')}"><i class="fas fa-arrows-left-right-to-line"></i></button>` : ''}
          <button type="button" data-act="refresh" title="${t('새로고침')}" aria-label="${t('새로고침')}"><i class="fas fa-rotate-right"></i></button>
          <button type="button" data-act="collapse" title="${t('모두 접기')}" aria-label="${t('모두 접기')}"><i class="fas fa-down-left-and-up-right-to-center"></i></button>
          <button type="button" data-act="more" title="${t('보기 · 정렬')}" aria-label="${t('보기 · 정렬')}"><i class="fas fa-ellipsis-vertical"></i></button>
        </div>
      </div>
      <label class="ex-search"><i class="fas fa-magnifying-glass"></i><input type="search" placeholder="${t('파일 · 폴더 이름 검색')}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="ex-status"></div>
      <div class="ex-body" tabindex="0" aria-label="${t('파일 목록 (Shift 로 여러 개 선택 · Backspace 로 삭제)')}"><div class="ex-tree" role="tree" aria-multiselectable="true"></div><div class="ex-results hidden"></div><div class="ex-drop-hint hidden"></div></div>
      <input type="file" class="hidden ex-upload" multiple>
      <input type="file" class="hidden ex-upload-dir" webkitdirectory multiple>`;
    const $ = (sel) => container.querySelector(sel);
    const treeEl = $('.ex-tree');
    const body = $('.ex-body');
    const results = $('.ex-results');
    const searchInput = $('.ex-search input');
    const statusEl = $('.ex-status');

    const prefs = () => shared.prefs;
    const isGated = (path) => prefs().hidden.includes(path);
    const saveExpanded = () => store.set('expanded', [...expanded].slice(-400));
    let treeScrollTimer = null;

    // ── Data ──
    // Share the in-flight request (Promise) so the same folder is not read several times at once
    function load(dir, force = false) {
      if (!force && cache.has(dir)) return Promise.resolve(cache.get(dir));
      if (pending.has(dir)) return pending.get(dir);
      const request = api(`/api/fs/list?path=${encodeURIComponent(dir)}`)
        .then((data) => { cache.set(dir, data.entries); return data.entries; })
        .catch((error) => { cache.set(dir, { error: error.message }); return null; })
        .finally(() => pending.delete(dir));
      pending.set(dir, request);
      return request;
    }

    function visibleEntries(dir, entries) {
      const p = prefs();
      const env = showEnv();
      return entries.filter((e) => (p.show_dotfiles || !e.name.startsWith('.') || (env && ENV_NAME.test(e.name))) && (p.show_hidden || !isGated(e.path)));
    }
    // Keep .env visible even when dotfiles are off (Settings → Files · Editor, on by default)
    window.addEventListener('univdash:settings', (event) => { if (event.detail?.key === 'show-env') render(); });
    function sortEntries(dir, entries) {
      const mode = prefs().sort;
      const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
      const dirsFirst = (a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1);
      const list = [...entries];
      if (mode === 'mixed') list.sort(byName);
      else if (mode === 'type') list.sort((a, b) => dirsFirst(a, b) || a.ext.localeCompare(b.ext) || byName(a, b));
      else if (mode === 'modified') list.sort((a, b) => dirsFirst(a, b) || b.mtime - a.mtime || byName(a, b));
      else if (mode === 'size') list.sort((a, b) => dirsFirst(a, b) || b.size - a.size || byName(a, b));
      else if (mode === 'manual') {
        const order = prefs().orders[dir] || [];
        const index = new Map(order.map((name, i) => [name, i]));
        list.sort((a, b) => (index.has(a.name) ? index.get(a.name) : 1e6) - (index.has(b.name) ? index.get(b.name) : 1e6) || dirsFirst(a, b) || byName(a, b));
      } else list.sort((a, b) => dirsFirst(a, b) || byName(a, b));
      return list;
    }

    // ── Rendering ──
    function rowHtml(entry, depth) {
      const open = entry.type === 'dir' && expanded.has(entry.path);
      const mode = prefs().sort;
      const meta = mode === 'size' && entry.type === 'file' ? formatSize(entry.size) : mode === 'modified' ? formatTime(entry.mtime) : '';
      const cut = shared.clipboard?.mode === 'cut' && shared.clipboard.paths.includes(entry.path);
      const dim = entry.name.startsWith('.') || isGated(entry.path);
      const drag = !coarse ? 'draggable="true"' : '';   // mouse: drag to move into a folder · open in a split · (in manual sort) reorder
      return `<div class="ex-row ${picked.has(entry.path) ? 'selected' : ''} ${dim ? 'dim' : ''} ${entry.ignored ? 'ignored' : ''} ${cut ? 'cut' : ''}" ${drag} ${entry.ignored ? `title="${t('.gitignore 에 의해 무시됨')}"` : ''} data-path="${escapeHtml(entry.path)}" data-type="${entry.type}" style="padding-left:${6 + depth * 14}px" role="treeitem" ${entry.type === 'dir' ? `aria-expanded="${open}"` : ''}>
          ${entry.type === 'dir' ? `<i class="ex-chev fas fa-chevron-right ${open ? 'open' : ''}"></i>` : '<span class="ex-chev"></span>'}
          ${iconFor(entry, open)}
          <span class="ex-name">${escapeHtml(entry.name)}${entry.link ? ' <i class="fas fa-link text-[9px] opacity-50"></i>' : ''}${isGated(entry.path) ? ' <i class="fas fa-eye-slash text-[9px] opacity-60"></i>' : ''}</span>
          ${meta ? `<span class="ex-meta">${escapeHtml(meta)}</span>` : ''}
          <button type="button" class="ex-more ex-copy" data-act="copy" title="${t('경로 복사')}" aria-label="${t('{name} 경로 복사', { name: escapeHtml(entry.name) })}"><i class="far fa-copy"></i></button>
          <button type="button" class="ex-more" data-act="menu" aria-label="${t('{name} 메뉴', { name: escapeHtml(entry.name) })}"><i class="fas fa-ellipsis"></i></button>
        </div>`;
    }
    function dirHtml(dir, depth) {
      const entries = cache.get(dir);
      if (entries === undefined) {
        if (!pending.has(dir)) load(dir).then(render);
        return `<div class="ex-note" style="padding-left:${26 + depth * 14}px"><i class="fas fa-circle-notch fa-spin"></i> ${t('불러오는 중')}</div>`;
      }
      if (entries?.error) return `<div class="ex-note error" style="padding-left:${26 + depth * 14}px">${escapeHtml(entries.error)}</div>`;
      const list = sortEntries(dir, visibleEntries(dir, entries || []));
      if (!list.length) return `<div class="ex-note" style="padding-left:${26 + depth * 14}px">${t('비어 있음')}</div>`;
      return list.map((entry) => `<div class="ex-node" data-name="${escapeHtml(entry.name)}">${rowHtml(entry, depth)}${entry.type === 'dir' && expanded.has(entry.path)
        ? `<div class="ex-children" data-dir="${escapeHtml(entry.path)}">${dirHtml(entry.path, depth + 1)}</div>` : ''}</div>`).join('');
    }
    function render() {
      if (!prefs() || !root) return;
      const top = body.scrollTop;
      $('.ex-root-name').textContent = basename(root) === '/' ? '/' : basename(root);
      $('.ex-root').title = t('{path} — 루트 폴더 바꾸기', { path: shortHome(root) });
      treeEl.dataset.dir = root;
      treeEl.innerHTML = dirHtml(root, 0);
      const p = prefs();
      const flags = [SORTS[p.sort]?.label, p.show_dotfiles ? t('숨김 파일 표시') : '', p.show_hidden ? t('가린 항목 표시') : '', shared.clipboard ? (shared.clipboard.mode === 'cut' ? t('잘라낸 항목: {label}', { label: clipLabel() }) : t('복사한 항목: {label}', { label: clipLabel() })) : ''].filter(Boolean);
      statusEl.innerHTML = `<i class="fas fa-location-dot"></i> ${escapeHtml(shortHome(root))}<span class="opacity-60"> · ${escapeHtml(flags.join(' · '))}</span>`;
      body.scrollTop = top;
      if (pendingScroll && !pending.size) { body.scrollTop = pendingScroll; pendingScroll = 0; }
      paintSelection();
      setupSortables();
    }

    // Manual sort (phone): long-press and drag to reorder.
    // The mouse does not use Sortable — it would hijack the drag and break moving into a folder / opening in a split,
    // so reordering is handled inside the native drag and drop below (top / bottom edge of an item in the same folder).
    function setupSortables() {
      sortables.forEach((s) => s.destroy());
      sortables = [];
      if (prefs().sort !== 'manual' || !window.Sortable || !coarse) return;
      [treeEl, ...container.querySelectorAll('.ex-children')].forEach((list) => {
        sortables.push(new window.Sortable(list, {
          draggable: '.ex-node', animation: 150, forceFallback: true, fallbackTolerance: 4,
          delay: 220, delayOnTouchOnly: true, ghostClass: 'sortable-ghost', group: 'ex-tree',
          onEnd: (event) => {
            // Dropped into another folder (an expanded folder's list) → move (after confirming). The view is restored first.
            if (event.from !== event.to) {
              const source = event.item.querySelector('.ex-row')?.dataset.path;
              render();
              if (source) moveTo(source, event.to.dataset.dir);
              return;
            }
            const dir = list.dataset.dir;
            const names = [...list.children].filter((el) => el.classList.contains('ex-node')).map((el) => el.dataset.name);
            const rest = (prefs().orders[dir] || []).filter((n) => !names.includes(n));
            prefs().orders[dir] = [...names, ...rest];
            savePrefs();
          },
        }));
      });
    }

    // ── Actions ──
    function entryAt(path) {
      const entries = cache.get(dirname(path));
      return Array.isArray(entries) ? entries.find((e) => e.path === path) : null;
    }
    async function refresh(dir = null) {
      if (dir) { await load(dir, true); }
      else { cache.clear(); await load(root, true); }
      render();
    }
    // Detect files created or changed outside the browser by an agent / terminal.
    // Only the root and the expanded folders are re-read (cheaply), and the tree is redrawn only when a listing actually changed.
    async function refreshChangedFolders() {
      if (!root || !prefs() || document.visibilityState !== 'visible'
        || !container.isConnected || !container.getClientRects().length
        || treeEl.classList.contains('hidden')) return;
      const dirs = [...new Set([root, ...expanded].filter((dir) => dir === root || dir.startsWith(`${root}/`)))];
      const before = new Map(dirs.map((dir) => [dir, JSON.stringify(cache.get(dir))]));
      await Promise.all(dirs.map((dir) => load(dir, true)));
      // Forget expanded folders that were deleted or moved elsewhere (so they are not re-read forever, failing each time)
      const gone = dirs.filter((dir) => dir !== root && cache.get(dir)?.error);
      if (gone.length) {
        gone.forEach((dir) => { expanded.delete(dir); cache.delete(dir); });
        saveExpanded();
      }
      if (gone.length || dirs.some((dir) => before.get(dir) !== JSON.stringify(cache.get(dir)))) render();
    }
    const treeRefreshTimer = setInterval(() => {
      if (!container.isConnected) { clearInterval(treeRefreshTimer); return; }
      refreshChangedFolders().catch(() => {});
    }, 2000);
    async function setRoot(path) {
      root = path;
      store.set('root', root);
      if (!cache.has(root)) await load(root);
      if (cache.get(root)?.error) toast(cache.get(root).error, 'error');
      render();
    }
    function toggle(path) {
      if (expanded.has(path)) expanded.delete(path);
      else expanded.add(path);
      saveExpanded();
      render();
    }
    // Selection: selected = anchor (the last one clicked), picked = multi-selection (Shift = range, Ctrl/⌘ = add / remove one at a time)
    function paintSelection() {
      container.querySelectorAll('.ex-tree .ex-row').forEach((el) => el.classList.toggle('selected', picked.has(el.dataset.path)));
      body.classList.toggle('root-target', !picked.size);
      body.classList.toggle('multi', picked.size > 1);
      statusEl.querySelector('.ex-multi')?.remove();
      if (picked.size > 1) statusEl.insertAdjacentHTML('afterbegin', `<span class="ex-multi">${t('{count}개 선택 · Backspace 삭제 · Esc 해제', { count: picked.size })}</span>`);
    }
    function select(path) {
      selected = path;
      picked = new Set(path ? [path] : []);
      store.set('selected', path);
      paintSelection();
    }
    function visiblePaths() { return [...container.querySelectorAll('.ex-tree .ex-row')].map((el) => el.dataset.path); }
    function selectRange(path) {
      const order = visiblePaths();
      const a = order.indexOf(selected);
      const b = order.indexOf(path);
      if (a < 0 || b < 0) { select(path); return; }
      picked = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));   // keep the anchor so the range can be adjusted again
      paintSelection();
    }
    function toggleSelect(path) {
      if (picked.has(path)) picked.delete(path); else picked.add(path);
      selected = path;
      paintSelection();
    }
    // Move several items to the trash at once (when a child is picked together with its parent, only the parent)
    async function removeMany(paths) {
      const list = [...new Set(paths)].filter((p) => !paths.some((other) => other !== p && p.startsWith(`${other}/`)));
      if (!list.length) return;
      const names = list.slice(0, 6).map((p) => `· ${basename(p)}`).join('\n') + (list.length > 6 ? `\n${t('외 {count}개', { count: list.length - 6 })}` : '');
      const ok = await ui().confirmSheet({
        title: list.length > 1 ? t('{count}개 항목을 휴지통으로', { count: list.length }) : t('휴지통으로 이동'),
        message: `${names}\n\n${t('~/.univdash/trash 로 옮깁니다. 필요하면 거기서 되살릴 수 있습니다.')}`, confirmLabel: t('삭제'), danger: true,
      });
      if (!ok) return;
      let done = 0;
      for (const path of list) {
        try {
          await api('/api/fs/op', { method: 'POST', body: { op: 'delete', path } });
          done += 1;
          window.dispatchEvent(new CustomEvent('univdash:fs-deleted', { detail: { path } }));
        } catch (error) { toast(`${basename(path)}: ${error.message}`, 'error'); }
      }
      if (done) toast(t('{count}개 항목을 휴지통으로 옮겼습니다.', { count: done }), 'success');
      select(null);
      for (const dir of new Set(list.map(dirname))) await load(dir, true);
      render();
    }
    async function reveal(path) {
      path = expandHome(path);
      if (!root || !(path === root || path.startsWith(`${root}/`))) {
        const holder = [...(prefs().pinned || []), ...shared.roots].find((r) => path === r || path.startsWith(`${r}/`));
        root = holder || path;
        store.set('root', root);
      }
      const parts = path.slice(root.length).split('/').filter(Boolean);
      let current = root;
      for (const part of parts.slice(0, -1)) {
        current = `${current}/${part}`;
        expanded.add(current);
        await load(current);
      }
      if (parts.length) { await load(dirname(path)); }
      const entry = entryAt(path);
      if (entry?.type === 'dir' || !parts.length) { expanded.add(path); await load(path); }
      saveExpanded();
      selected = path;
      picked = new Set([path]);
      store.set('selected', path);
      clearSearch();
      render();
      requestAnimationFrame(() => container.querySelector(`.ex-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' }));
    }
    // Follow the tab being viewed (like VS Code): for a file tab, expand to that file and select it;
    // for a non-file tab (tmux · Terminal), only clear the file selection (a folder picked as the upload target stays selected).
    // For a file outside the root, the root is not changed and only the selection is cleared.
    let followSeq = 0;
    async function follow(path) {
      const seq = ++followSeq;
      path = path ? expandHome(path) : null;
      if (!path || !root || !path.startsWith(`${root}/`)) {
        const files = [...picked].filter((p) => entryAt(p)?.type !== 'dir');
        if (files.length && !(path && picked.size === 1 && picked.has(path))) select(null);
        return;
      }
      if (picked.size === 1 && picked.has(path) && container.querySelector(`.ex-row[data-path="${CSS.escape(path)}"]`)) return;
      let current = root;
      let opened = false;
      for (const part of path.slice(root.length).split('/').filter(Boolean).slice(0, -1)) {
        current = `${current}/${part}`;
        if (!expanded.has(current)) { expanded.add(current); opened = true; }
        await load(current);
        if (seq !== followSeq) return;   // switched to another tab in the meantime
      }
      if (opened) { saveExpanded(); render(); }
      select(path);
      const row = container.querySelector(`.ex-row[data-path="${CSS.escape(path)}"]`);
      if (row) {
        const box = body.getBoundingClientRect();
        const rect = row.getBoundingClientRect();
        if (rect.top < box.top || rect.bottom > box.bottom) row.scrollIntoView({ block: 'center' });
      }
    }
    const relative = (path) => (path === root ? '.' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);

    async function op(body, success) {
      try {
        const result = await api('/api/fs/op', { method: 'POST', body });
        if (success) toast(success, 'success');
        return result;
      } catch (error) {
        toast(error.message, 'error');
        return null;
      }
    }
    function askName({ title, subtitle, value = '', label = t('이름'), submitLabel = t('확인') }) {
      return new Promise((resolve) => {
        let done = false;
        ui().formSheet({
          title, subtitle, submitLabel,
          fields: [{ name: 'name', label, value, maxlength: 255 }],
          onMount(sheet) {
            const input = sheet.querySelector('input[name="name"]');
            setTimeout(() => {
              input.focus();
              const dot = value.lastIndexOf('.');
              input.setSelectionRange(0, dot > 0 ? dot : value.length);  // select up to the extension, like VS Code
            }, 40);
          },
          // Resolve after the input sheet has closed, so a following sheet (confirm dialog) opened right away is not closed with it
          onSubmit(values) { done = true; setTimeout(() => resolve(values.name.trim() || null), 0); },
        });
        const overlay = document.getElementById('sheetOverlay');
        const watch = setInterval(() => { if (overlay.hidden) { clearInterval(watch); if (!done) resolve(null); } }, 300);
      });
    }
    async function create(dir, kind) {
      const name = await askName({ title: kind === 'dir' ? t('새 폴더') : t('새 파일'), subtitle: shortHome(dir), submitLabel: t('만들기') });
      if (!name) return;
      const result = await op({ op: kind === 'dir' ? 'mkdir' : 'touch', path: dir, name });
      if (!result) return;
      expanded.add(dir);
      saveExpanded();
      await refresh(dir);
      select(result.path);
      if (kind === 'file') options.onOpen?.({ path: result.path, name, type: 'file', ext: name.split('.').pop().toLowerCase(), size: 0 });
    }
    // New folder: create an empty folder or git clone (with only a URL, the folder is named after the repository)
    function folderSheet(dir, mode = store.get('new-folder-mode', 'empty')) {
      const field = (name, label, placeholder, extra = '') => `<label data-mode-field="${extra}">${label}<input name="${name}" placeholder="${escapeHtml(placeholder)}" maxlength="2000" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`;
      ui().formSheet({
        title: t('새 폴더'), subtitle: t('위치: {path}', { path: shortHome(dir) }), submitLabel: t('만들기'),
        extraHtml: `<div class="seg" role="radiogroup" aria-label="${t('만드는 방법')}">
            <button type="button" data-folder-mode="empty"><i class="fas fa-folder-plus mr-1"></i>${t('빈 폴더')}</button>
            <button type="button" data-folder-mode="clone"><i class="fab fa-git-alt mr-1"></i>Git clone</button>
          </div>
          ${field('url', t('저장소 주소'), t('https://github.com/user/repo.git 또는 git@github.com:user/repo.git'), 'clone')}
          ${field('name', t('폴더 이름'), t('새 폴더'), 'both')}
          ${field('branch', t('브랜치 (선택)'), t('비우면 기본 브랜치'), 'clone')}
          <label data-mode-field="clone" class="check-row"><input type="checkbox" name="shallow"> ${t('최근 기록만 받기 (--depth 1, 빠름)')}</label>
          <p data-mode-field="clone" class="text-[11px] opacity-60 leading-5">${t('비공개 저장소는 서버에 SSH 키(또는 git 자격 증명)가 설정되어 있어야 합니다. 비밀번호는 묻지 않습니다.')}</p>`,
        onMount(sheet) {
          const nameInput = sheet.querySelector('input[name="name"]');
          const urlInput = sheet.querySelector('input[name="url"]');
          const submit = sheet.querySelector('[type="submit"]');
          const apply = (next) => {
            mode = next;
            store.set('new-folder-mode', mode);
            sheet.querySelectorAll('[data-folder-mode]').forEach((b) => b.classList.toggle('on', b.dataset.folderMode === mode));
            sheet.querySelectorAll('[data-mode-field]').forEach((el) => el.classList.toggle('hidden', !(el.dataset.modeField === 'both' || el.dataset.modeField === mode)));
            nameInput.placeholder = mode === 'clone' ? t('비우면 저장소 이름') : t('새 폴더');
            submit.textContent = mode === 'clone' ? 'Clone' : t('만들기');
            setTimeout(() => (mode === 'clone' ? urlInput : nameInput).focus(), 30);
          };
          sheet.querySelectorAll('[data-folder-mode]').forEach((b) => b.addEventListener('click', () => apply(b.dataset.folderMode)));
          urlInput.addEventListener('input', () => {
            const guess = urlInput.value.trim().replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '');
            nameInput.placeholder = guess || t('비우면 저장소 이름');
          });
          apply(mode);
        },
        async onSubmit(values, sheet) {
          if (mode === 'empty') {
            const name = (values.name || '').trim();
            if (!name) throw new Error(t('폴더 이름을 적어 주십시오.'));
            const result = await api('/api/fs/op', { method: 'POST', body: { op: 'mkdir', path: dir, name } });
            await afterCreate(dir, result.path);
            return false;
          }
          const submit = sheet.querySelector('[type="submit"]');
          submit.innerHTML = `<i class="fas fa-circle-notch fa-spin mr-1"></i>${t('Clone 중…')}`;
          try {
            const result = await api('/api/fs/clone', { method: 'POST', body: { url: (values.url || '').trim(), parent: dir, name: (values.name || '').trim(), branch: (values.branch || '').trim(), depth: values.shallow ? 1 : 0 } });
            toast(t('{name} 을(를) 받았습니다.', { name: result.name }), 'success');
            await afterCreate(dir, result.path);
            return false;
          } finally {
            submit.textContent = 'Clone';
          }
        },
      });
    }
    async function afterCreate(dir, path) {
      expanded.add(dir);
      saveExpanded();
      await refresh(dir);
      select(path);
      requestAnimationFrame(() => container.querySelector(`.ex-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' }));
    }

    async function rename(entry) {
      const name = await askName({ title: t('이름 바꾸기'), subtitle: shortHome(entry.path), value: entry.name, submitLabel: t('바꾸기') });
      if (!name || name === entry.name) return;
      const result = await op({ op: 'rename', path: entry.path, name });
      if (!result) return;
      if (expanded.delete(entry.path)) expanded.add(result.path);
      window.dispatchEvent(new CustomEvent('univdash:fs-moved', { detail: { from: entry.path, to: result.path } }));
      await refresh(dirname(entry.path));
      select(result.path);
    }
    async function remove(entry) { await removeMany([entry.path]); }
    // Copy · cut (Ctrl/⌘ + C · X → Ctrl/⌘ + V in another folder). Copies / moves within the server.
    // When a child is picked together with its parent, only the parent. Explorer windows share one clipboard.
    function clipLabel() {
      const paths = shared.clipboard?.paths || [];
      return paths.length > 1 ? t('{name} 외 {count}개', { name: basename(paths[0]), count: paths.length - 1 }) : basename(paths[0] || '');
    }
    function setClip(mode, paths) {
      const list = [...new Set(paths.filter(Boolean))];
      const top = list.filter((p) => !list.some((other) => other !== p && p.startsWith(`${other}/`)));
      if (!top.length) return;
      shared.clipboard = { mode, paths: top };
      render();
      const key = isMac ? '⌘' : 'Ctrl';
      toast(mode === 'cut'
        ? t('{label} 잘라냈습니다 · 붙여 넣을 폴더에서 {key}+V', { label: clipLabel(), key })
        : t('{label} 복사했습니다 · 붙여 넣을 폴더에서 {key}+V', { label: clipLabel(), key }), 'info');
    }
    const clipTargets = (entry) => (entry && picked.has(entry.path) && picked.size > 1 ? [...picked] : [entry?.path]);
    let pasting = false;
    async function paste(dir) {
      const clip = shared.clipboard;
      if (!clip || pasting) return;
      const move = clip.mode === 'cut';
      pasting = true;
      const slow = setTimeout(() => toast(move ? t('{label} 옮기는 중…', { label: clipLabel() }) : t('{label} 복사하는 중…', { label: clipLabel() }), 'info'), 1200);   // only when it takes long, e.g. a big folder
      const placed = [];
      try {
        for (const path of clip.paths) {
          // Pasting a copied folder onto (or inside) itself makes a copy next to it (copying into itself is not possible)
          const dest = !move && (dir === path || dir.startsWith(`${path}/`)) ? dirname(path) : dir;
          try {
            const result = await api('/api/fs/op', { method: 'POST', body: { op: move ? 'move' : 'copy', path, dest } });
            placed.push(result.path);
            if (move && result.path !== path) {
              cache.delete(dirname(path));
              window.dispatchEvent(new CustomEvent('univdash:fs-moved', { detail: { from: path, to: result.path } }));
            }
          } catch (error) { toast(`${basename(path)}: ${error.message}`, 'error'); }
        }
      } finally { pasting = false; clearTimeout(slow); }
      if (move) shared.clipboard = null;   // a cut pastes once, a copy can be pasted many times
      if (placed.length) {
        const count = placed.length;
        const name = basename(placed[0]);
        toast(count > 1
          ? (move ? t('{count}개 항목을 옮겼습니다.', { count }) : t('{count}개 항목을 복사했습니다.', { count }))
          : (move ? t('{name} 옮겼습니다.', { name }) : t('{name} 복사했습니다.', { name })), 'success');
      }
      expanded.add(dir);
      saveExpanded();
      for (const d of new Set(placed.map(dirname))) await refresh(d);
      if (!placed.length) { render(); return; }
      select(placed[placed.length - 1]);
      if (placed.length > 1) { picked = new Set(placed); paintSelection(); }
    }
    // ── Moving (drag and drop · menu) ──
    function canMove(source, dest) {
      if (!source || !dest) return false;
      if (dirname(source) === dest) return false;                        // same folder
      if (dest === source || dest.startsWith(`${source}/`)) return false;  // into itself
      return true;
    }
    // Inside the root: path relative to the root (starting with the root's name); outside: ~ path
    const where = (path) => (path === root || path.startsWith(`${root}/`) ? `${basename(root)}${path.slice(root.length)}` : shortHome(path));
    async function moveTo(source, dest, { copy = false } = {}) {
      if (!copy && !canMove(source, dest)) {
        if (dest === source || dest?.startsWith(`${source}/`)) toast(t('폴더를 자기 안으로 옮길 수 없습니다.'), 'error');
        return null;
      }
      const name = basename(source);
      const ok = await ui().confirmSheet({
        title: copy ? t('여기로 복사하시겠습니까?') : t('여기로 옮기시겠습니까?'),
        message: `${name}\n${where(dirname(source))}  →  ${where(dest)}${copy ? '' : `\n\n${t('Ctrl/Alt 를 누른 채 놓으면 복사합니다.')}`}`,
        confirmLabel: copy ? t('복사') : t('이동'),
      });
      if (!ok) return null;
      const result = await op({ op: copy ? 'copy' : 'move', path: source, dest }, copy ? t('{name} 을(를) 복사했습니다.', { name }) : t('{name} 을(를) 옮겼습니다.', { name }));
      if (!result) return null;
      if (!copy) {
        // Expanded subfolders · hidden items · manual order also follow to the new path
        const swap = (p) => (p === source ? result.path : p.startsWith(`${source}/`) ? result.path + p.slice(source.length) : p);
        expanded = new Set([...expanded].map(swap));
        prefs().hidden = prefs().hidden.map(swap);
        saveExpanded();
        savePrefs();
        cache.delete(dirname(source));
        if (shared.clipboard?.paths.includes(source)) shared.clipboard = null;
        window.dispatchEvent(new CustomEvent('univdash:fs-moved', { detail: { from: source, to: result.path } }));
      }
      expanded.add(dest);
      saveExpanded();
      await load(dirname(source), true);
      await refresh(dest);
      select(result.path);
      return result.path;
    }
    // Move · copy several at once (drag and drop). Asks once, and leaves out what cannot be moved (already in that folder · into itself), saying so.
    async function moveManyTo(sources, dest, { copy = false } = {}) {
      const list = sources.filter((p) => (copy ? !(dest === p || dest.startsWith(`${p}/`)) : canMove(p, dest)));
      const skipped = sources.length - list.length;
      if (!list.length) { toast(copy ? t('폴더를 자기 안으로 복사할 수 없습니다.') : t('옮길 수 있는 항목이 없습니다 (이미 그 폴더에 있거나 자기 안으로).'), 'error'); return; }
      const names = list.slice(0, 6).map((p) => `· ${basename(p)}`).join('\n') + (list.length > 6 ? `\n${t('외 {count}개', { count: list.length - 6 })}` : '');
      const ok = await ui().confirmSheet({
        title: copy ? t('{count}개 항목을 여기로 복사하시겠습니까?', { count: list.length }) : t('{count}개 항목을 여기로 옮기시겠습니까?', { count: list.length }),
        message: `${names}\n→  ${where(dest)}${skipped ? `\n\n${t('(이미 그 폴더에 있거나 자기 안이라 {count}개는 제외합니다)', { count: skipped })}` : ''}${copy ? '' : `\n\n${t('Ctrl/Alt 를 누른 채 놓으면 복사합니다.')}`}`,
        confirmLabel: copy ? t('복사') : t('이동'),
      });
      if (!ok) return;
      const slow = setTimeout(() => toast(copy ? t('{count}개 항목을 복사하는 중…', { count: list.length }) : t('{count}개 항목을 옮기는 중…', { count: list.length }), 'info'), 1200);
      const placed = [];
      const swaps = [];
      try {
        for (const source of list) {
          try {
            const result = await api('/api/fs/op', { method: 'POST', body: { op: copy ? 'copy' : 'move', path: source, dest } });
            placed.push(result.path);
            if (!copy) {
              swaps.push([source, result.path]);
              cache.delete(dirname(source));
              if (shared.clipboard?.paths.includes(source)) shared.clipboard = null;
              window.dispatchEvent(new CustomEvent('univdash:fs-moved', { detail: { from: source, to: result.path } }));
            }
          } catch (error) { toast(`${basename(source)}: ${error.message}`, 'error'); }
        }
      } finally { clearTimeout(slow); }
      if (swaps.length) {
        // Expanded subfolders · hidden items also follow to the new path
        const swap = (p) => { for (const [from, to] of swaps) { if (p === from) return to; if (p.startsWith(`${from}/`)) return to + p.slice(from.length); } return p; };
        expanded = new Set([...expanded].map(swap));
        prefs().hidden = prefs().hidden.map(swap);
        savePrefs();
      }
      if (placed.length) toast(copy ? t('{count}개 항목을 복사했습니다.', { count: placed.length }) : t('{count}개 항목을 옮겼습니다.', { count: placed.length }), 'success');
      expanded.add(dest);
      saveExpanded();
      for (const d of new Set(list.map(dirname))) await load(d, true);
      await refresh(dest);
      if (!placed.length) { render(); return; }
      select(placed[placed.length - 1]);
      if (placed.length > 1) { picked = new Set(placed); paintSelection(); }
    }
    async function moveDialog(entry) {
      const value = await askName({ title: t('다른 폴더로 이동'), subtitle: t('{name} 을(를) 옮길 폴더 경로 (~/ 가능)', { name: entry.name }), value: shortHome(dirname(entry.path)), label: t('대상 폴더'), submitLabel: t('다음') });
      if (!value) return;
      moveTo(entry.path, expandHome(value.replace(/\/+$/, '')) || '/');
    }

    function moveInOrder(entry, delta) {
      const dir = dirname(entry.path);
      const names = sortEntries(dir, visibleEntries(dir, cache.get(dir) || [])).map((e) => e.name);
      const i = names.indexOf(entry.name);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= names.length) return;
      [names[i], names[j]] = [names[j], names[i]];
      prefs().orders[dir] = names;
      savePrefs();
      render();
    }
    function toggleGate(entry) {
      const list = prefs().hidden;
      const gated = list.includes(entry.path);
      prefs().hidden = gated ? list.filter((p) => p !== entry.path) : [...list, entry.path];
      savePrefs();
      render();
      if (!gated) toast(t('{name} 을(를) 가렸습니다. ⋮ 메뉴 → 가린 항목 표시로 다시 볼 수 있습니다.', { name: entry.name }), 'info');
    }
    function togglePin(path) {
      const pinned = prefs().pinned;
      prefs().pinned = pinned.includes(path) ? pinned.filter((p) => p !== path) : [...pinned, path];
      savePrefs();
      toast(pinned.includes(path) ? t('고정 해제했습니다.') : t('루트 목록에 고정했습니다.'), 'success');
    }

    // ── Upload (button · drag and drop) ──
    let uploadDir = null;
    const uploadInput = $('.ex-upload');
    const dropHint = $('.ex-drop-hint');
    // items: [{ file, dir, rel }] — rel is the subfolder path under dir (folder upload); the server creates it
    function uploadItems(items, refreshDir, emptyDirs = []) {
      if (!items.length && !emptyDirs.length) return;
      const total = items.length;
      if (total > 300 && !confirm(t('파일 {total}개를 업로드하시겠습니까?', { total }))) return;
      let done = 0;
      let failed = 0;
      let left = total;
      const finish = () => {
        toast(failed ? t('{done}개 업로드 완료 · {failed}개 실패', { done, failed }) : t('{done}개 업로드 완료', { done }), failed ? 'warn' : 'success');
        expanded.add(refreshDir); saveExpanded();
        refresh(refreshDir);
      };
      // Empty folders first, then every file is handed to the site-wide upload list at once (it uploads a few at a
      // time, shows the progress panel and keeps going when this page is left).
      (async () => {
        for (const { dir, rel } of emptyDirs) {
          try { await api('/api/fs/upload-folder', { method: 'POST', body: { dir, rel, unique: false } }); } catch (e) { /* empty folders are skipped on failure */ }
        }
        if (!total) { finish(); return; }
        for (const { file, dir, rel } of items) {
          window.UnivDash.uploads.add(file, { dir, rel }).promise
            .then(() => { done += 1; })
            .catch((error) => { failed += 1; if (!error.aborted) toast(`${rel ? `${rel}/` : ''}${file.name}: ${error.message}`, 'error'); })
            .finally(() => { left -= 1; if (!left) finish(); });
        }
      })();
    }
    function upload(files, dir) { uploadItems(files.map((file) => ({ file, dir, rel: '' })), dir); }
    body.addEventListener('paste', (event) => {
      const items = [...(event.clipboardData?.items || [])];
      let files = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile()).filter(Boolean);
      if (!files.length) files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith('image/'));
      clearTimeout(pasteTimer);
      if (!files.length) {
        if (shared.clipboard) { event.preventDefault(); paste(selectedDir()); }
        return;
      }
      event.preventDefault();
      const dir = selectedDir();
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      files = files.map((file, index) => {
        const ext = file.type === 'image/svg+xml' ? 'svg'
          : (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'png';
        const genericName = !file.name || /^(?:image|blob)\.[a-z0-9]+$/i.test(file.name);
        return genericName
          ? new File([file], `clipboard-image-${stamp}${files.length > 1 ? `-${index + 1}` : ''}.${ext}`, { type: file.type, lastModified: file.lastModified })
          : file;
      });
      toast(t('이미지를 {path} 에 업로드합니다.', { path: shortHome(dir) }), 'info');
      upload(files, dir);
    });
    // Folder upload: the top folder is created anew (if the name exists, "name (2)" — so it does not mix into an existing folder)
    async function makeTop(dir, name) {
      const made = await api('/api/fs/upload-folder', { method: 'POST', body: { dir, rel: name, unique: true } });
      return made.path;
    }
    // Dropped items → list of files · empty folders (folders are walked recursively)
    const readBatch = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));
    async function walk(entry, rel, out) {
      if (entry.isFile) { out.files.push({ file: await entryFile(entry), rel }); return; }
      if (!entry.isDirectory) return;
      const sub = rel ? `${rel}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      let any = false;
      for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
        for (const child of batch) { any = true; await walk(child, sub, out); }
      }
      if (!any && rel) out.dirs.push(sub);
    }
    // Dropped files are copied into memory as soon as they are dropped: apps like Yoink delete or move the original after the drag,
    // so reading it later during the upload fails in the browser with a "network error". Very large files are read straight from the original instead of memory.
    const SNAP_FILE = 512 * 1024 * 1024;
    const SNAP_TOTAL = 1024 * 1024 * 1024;
    function snapshotFiles(files) {
      let budget = SNAP_TOTAL;
      return Promise.all(files.map((file) => {
        if (!file || file.size > SNAP_FILE || file.size > budget) return Promise.resolve({ file });
        budget -= file.size;
        return file.arrayBuffer()   // start reading right inside the drop event
          .then((buf) => ({ file: new File([buf], file.name, { type: file.type, lastModified: file.lastModified }) }))
          .catch(() => ({ file, unreadable: true }));
      }));
    }
    async function uploadSnapshots(pending, dir) {
      const list = await pending;
      const bad = list.filter((x) => x.unreadable);
      bad.forEach(({ file }) => toast(t('{name}: 원본 파일을 읽을 수 없습니다. 끌어온 앱(Yoink 등)이 파일을 옮기거나 지웠을 수 있습니다.', { name: file.name }), 'error'));
      const ok = list.filter((x) => !x.unreadable).map((x) => x.file);
      if (ok.length) upload(ok, dir);
    }
    async function uploadDropped(dataTransfer, dir) {
      // The item list disappears once the drop event ends, so take everything out first
      const entries = [...(dataTransfer.items || [])].map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null));
      if (!entries.some((e) => e?.isDirectory)) { uploadSnapshots(snapshotFiles([...dataTransfer.files]), dir); return; }
      const files = [...dataTransfer.files];
      toast(t('폴더를 읽는 중…'), 'info');
      const items = [];
      const emptyDirs = [];
      for (const [index, entry] of entries.entries()) {
        if (!entry) continue;
        if (entry.isFile) { items.push({ file: files[index] || await entryFile(entry), dir, rel: '' }); continue; }
        try {
          const out = { files: [], dirs: [] };
          await walk(entry, '', out);
          const top = await makeTop(dir, entry.name);
          const inner = (rel) => rel.split('/').slice(1).join('/');   // the rest without the top folder name
          out.files.forEach(({ file, rel }) => items.push({ file, dir: top, rel: inner(rel) }));
          out.dirs.forEach((rel) => emptyDirs.push({ dir: top, rel: inner(rel) }));
          if (!out.files.length && !out.dirs.length) toast(t('{name}: 빈 폴더를 만들었습니다.', { name: entry.name }), 'info');
        } catch (error) { toast(`${entry.name}: ${error.message || t('폴더를 읽지 못했습니다.')}`, 'error'); }
      }
      uploadItems(items, dir, emptyDirs);
    }
    // Upload through the folder picker (webkitdirectory: each file comes with a "top-folder/sub/file" path)
    async function uploadPickedFolder(files, dir) {
      const byTop = new Map();
      files.forEach((file) => {
        const parts = (file.webkitRelativePath || file.name).split('/');
        const top = parts.length > 1 ? parts[0] : '';
        if (!byTop.has(top)) byTop.set(top, []);
        byTop.get(top).push({ file, rel: parts.slice(1, -1).join('/') });
      });
      const items = [];
      for (const [top, list] of byTop) {
        let target = dir;
        if (top) { try { target = await makeTop(dir, top); } catch (error) { toast(`${top}: ${error.message}`, 'error'); continue; } }
        list.forEach(({ file, rel }) => items.push({ file, dir: target, rel }));
      }
      uploadItems(items, dir);
    }
    const uploadDirInput = $('.ex-upload-dir');
    uploadDirInput.addEventListener('change', () => { uploadPickedFolder([...uploadDirInput.files], uploadDir || root); uploadDirInput.value = ''; });
    uploadInput.addEventListener('change', () => { upload([...uploadInput.files], uploadDir || root); uploadInput.value = ''; });
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    function dropDir(event) {
      const row = event.target.closest('.ex-row');
      if (!row) return root;
      return row.dataset.type === 'dir' ? row.dataset.path : dirname(row.dataset.path);
    }
    // Only while the file list has focus (so it does not clash with Backspace in the terminal · inputs)
    body.addEventListener('keydown', (event) => {
      if (event.target !== body) return;
      if (event.key === 'Enter' && selected && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const entry = entryAt(selected);
        if (entry) { event.preventDefault(); rename(entry); }
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.altKey) {
        const paths = [...picked];
        if (!paths.length) return;
        event.preventDefault();
        removeMany(paths);
      } else if (event.key === 'Escape' && picked.size > 1 && !document.querySelector('.ex-menu')) {   // an Esc that closes a menu leaves the selection alone
        event.preventDefault();
        select(selected);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        picked = new Set(visiblePaths());
        paintSelection();
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ['c', 'x'].includes(event.key.toLowerCase())) {
        if (!picked.size || window.getSelection()?.toString()) return;   // if text was selected by dragging, copy that text
        setClip(event.key.toLowerCase() === 'x' ? 'cut' : 'copy', [...picked]);
        // The default action (copy event) is not prevented → the copy handler below also puts the paths in as text
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v' && shared.clipboard) {
        // A system clipboard holding an image goes to upload in the paste event. Also lets browsers that send no paste event (Safari etc.) paste
        clearTimeout(pasteTimer);
        const dir = selectedDir();
        pasteTimer = setTimeout(() => paste(dir), 80);
      }
    });
    let pasteTimer = null;
    body.addEventListener('copy', (event) => {
      if (event.target !== body || !shared.clipboard || window.getSelection()?.toString()) return;
      event.clipboardData?.setData('text/plain', shared.clipboard.paths.join('\n'));   // pasted into a terminal etc., it is the paths
      event.preventDefault();
    });
    body.addEventListener('cut', (event) => {
      if (event.target !== body || !shared.clipboard || window.getSelection()?.toString()) return;
      event.clipboardData?.setData('text/plain', shared.clipboard.paths.join('\n'));
      event.preventDefault();
    });
    // A name truncated (…) for lack of width shows its full name over itself as soon as the mouse hovers it (like VS Code).
    // The browser's native tooltip (title) takes 0.5–1 s to appear, so it is drawn here. Not shown for names that are not truncated.
    let nameTip = null;
    const hideNameTip = () => { if (nameTip) nameTip.hidden = true; };
    container.addEventListener('mouseover', (event) => {
      const name = event.target.closest?.('.ex-name');
      const row = name?.closest('.ex-row');
      if (!row || name.scrollWidth <= name.clientWidth + 1 || document.querySelector('.ex-row.dragging')) { hideNameTip(); return; }
      if (!nameTip) {
        nameTip = document.createElement('div');
        nameTip.className = 'ex-name-tip';
        nameTip.setAttribute('role', 'tooltip');
        document.body.appendChild(nameTip);
      }
      nameTip.textContent = basename(row.dataset.path) + (row.classList.contains('ignored') ? `  · ${t('.gitignore 에 의해 무시됨')}` : '');
      const r = name.getBoundingClientRect();
      const style = getComputedStyle(name);
      Object.assign(nameTip.style, { font: style.font, left: '0px', top: `${Math.round(r.top + r.height / 2)}px`, maxWidth: `${window.innerWidth - 16}px` });
      nameTip.hidden = false;
      // When there is not enough room on the right (e.g. a right sidebar), shift left so the whole name is visible
      const width = nameTip.offsetWidth;
      nameTip.style.left = `${Math.round(Math.max(8, Math.min(r.left - 4, window.innerWidth - width - 8)))}px`;
    });
    container.addEventListener('mouseout', (event) => { if (!event.relatedTarget || !event.relatedTarget.closest?.('.ex-name')) hideNameTip(); });
    body.addEventListener('scroll', hideNameTip, { passive: true });
    container.addEventListener('dragstart', hideNameTip);
    container.addEventListener('pointerdown', hideNameTip);
    // Keep focus on the list even when a row is pressed (for shortcuts)
    body.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('button, input') && document.activeElement !== body) body.focus({ preventScroll: true });
    });
    body.addEventListener('scroll', () => {
      clearTimeout(treeScrollTimer);
      treeScrollTimer = setTimeout(() => { if (!pendingScroll) store.set('tree-scroll', Math.round(body.scrollTop)); }, 200);
    }, { passive: true });
    // Drag with the mouse inside the tree (drop on another folder → confirm → move; Ctrl/Alt copies)
    let dragSource = null;
    let dragSources = [];   // with several picked, dragging one of them drags all of them (for children, only the parent)
    let hoverTimer = null;
    let hoverDir = null;
    const clearDrop = () => {
      container.querySelectorAll('.ex-row.drop, .ex-row.drop-before, .ex-row.drop-after').forEach((el) => el.classList.remove('drop', 'drop-before', 'drop-after'));
      body.classList.remove('drop-root');
      dropHint.classList.add('hidden');
      clearTimeout(hoverTimer);
      hoverDir = null;
    };
    container.addEventListener('dragstart', (event) => {
      const row = event.target.closest?.('.ex-row[draggable="true"]');
      if (!row) return;
      dragSource = row.dataset.path;
      const many = picked.has(dragSource) && picked.size > 1 ? [...picked] : [dragSource];
      dragSources = many.filter((p) => !many.some((other) => other !== p && p.startsWith(`${other}/`)));
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData('application/x-univdash-path', dragSource);
      event.dataTransfer.setData('text/plain', dragSources.join(' '));   // dropped on the prompt input, the paths are inserted
      if (dragSources.length > 1) container.querySelectorAll('.ex-tree .ex-row.selected').forEach((el) => el.classList.add('dragging'));
      else row.classList.add('dragging');
    });
    container.addEventListener('dragend', () => {
      container.querySelectorAll('.ex-row.dragging').forEach((el) => el.classList.remove('dragging'));
      dragSource = null;
      dragSources = [];
      clearDrop();
    });
    // Manual order: dropping on an item of the same folder places it before · after (on a folder row, the middle means into the folder, the top · bottom edge means order)
    function reorderSpot(event) {
      if (prefs().sort !== 'manual' || !dragSource || dragSources.length > 1 || event.ctrlKey || event.altKey || event.metaKey) return null;
      const row = event.target.closest?.('.ex-row');
      if (!row || row.dataset.path === dragSource || dirname(row.dataset.path) !== dirname(dragSource)) return null;
      const r = row.getBoundingClientRect();
      const f = (event.clientY - r.top) / r.height;
      if (row.dataset.type === 'dir' && f > 0.28 && f < 0.72) return null;
      return { row, before: f < 0.5 };
    }
    function reorder(source, target, before) {
      const dir = dirname(source);
      const entries = cache.get(dir);
      if (!Array.isArray(entries)) return;
      const names = sortEntries(dir, visibleEntries(dir, entries)).map((e) => e.name).filter((n) => n !== basename(source));
      const at = names.indexOf(basename(target));
      if (at < 0) return;
      names.splice(before ? at : at + 1, 0, basename(source));
      const rest = (prefs().orders[dir] || []).filter((n) => !names.includes(n));
      prefs().orders[dir] = [...names, ...rest];
      savePrefs();
      render();
    }
    body.addEventListener('dragover', (event) => {
      if (!dragSource) return;
      const spot = reorderSpot(event);
      if (spot) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        clearDrop();
        spot.row.classList.add(spot.before ? 'drop-before' : 'drop-after');
        dropHint.innerHTML = `<i class="fas fa-arrows-up-down"></i> ${t('순서 바꾸기')}`;
        dropHint.classList.remove('hidden');
        return;
      }
      const dir = dropDir(event);
      const copy = event.ctrlKey || event.altKey || event.metaKey;
      if (!copy && !dragSources.some((source) => canMove(source, dir))) { event.dataTransfer.dropEffect = 'none'; clearDrop(); return; }
      event.preventDefault();
      event.dataTransfer.dropEffect = copy ? 'copy' : 'move';
      if (hoverDir !== dir) {
        clearDrop();
        hoverDir = dir;
        container.querySelector(`.ex-row[data-path="${CSS.escape(dir)}"]`)?.classList.add('drop');
        body.classList.toggle('drop-root', dir === root);
        // Hovering briefly over a collapsed folder expands it so the item can be dropped deeper (like VS Code)
        if (dir !== root && !expanded.has(dir) && entryAt(dir)?.type === 'dir') {
          hoverTimer = setTimeout(() => { expanded.add(dir); saveExpanded(); render(); hoverDir = null; }, 800);
        }
      }
      dropHint.innerHTML = `<i class="fas ${copy ? 'fa-clone' : 'fa-arrow-right-to-bracket'}"></i> ${copy ? t('여기로 복사: <b>{path}</b>', { path: escapeHtml(shortHome(dir)) }) : t('여기로 이동: <b>{path}</b>', { path: escapeHtml(shortHome(dir)) })}`;
      dropHint.classList.remove('hidden');
    });
    body.addEventListener('drop', (event) => {
      if (!dragSource) return;
      event.preventDefault();
      event.stopPropagation();
      const source = dragSource;
      const sources = dragSources;
      const spot = reorderSpot(event);
      const dir = dropDir(event);
      const copy = event.ctrlKey || event.altKey || event.metaKey;
      dragSource = null;
      dragSources = [];
      clearDrop();
      if (spot) { reorder(source, spot.row.dataset.path, spot.before); return; }
      if (sources.length > 1) moveManyTo(sources, dir, { copy });
      else moveTo(source, dir, { copy });
    });

    body.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      const dir = dropDir(event);
      container.querySelectorAll('.ex-row.drop').forEach((el) => el.classList.remove('drop'));
      container.querySelector(`.ex-row[data-path="${CSS.escape(dir)}"]`)?.classList.add('drop');
      body.classList.toggle('drop-root', dir === root);
      dropHint.innerHTML = `<i class="fas fa-cloud-arrow-up"></i> ${t('여기에 업로드: <b>{path}</b>', { path: escapeHtml(shortHome(dir)) })}`;
      dropHint.classList.remove('hidden');
    });
    body.addEventListener('dragleave', (event) => {
      if (!body.contains(event.relatedTarget)) { container.querySelectorAll('.ex-row.drop').forEach((el) => el.classList.remove('drop')); body.classList.remove('drop-root'); dropHint.classList.add('hidden'); }
    });
    body.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      container.querySelectorAll('.ex-row.drop').forEach((el) => el.classList.remove('drop'));
      body.classList.remove('drop-root');
      dropHint.classList.add('hidden');
      uploadDropped(event.dataTransfer, dropDir(event));
    });

    // Folder download: shows progress while the server builds the zip (an error if it is too big); when done the browser downloads it right away.
    async function downloadFolder(entry, skipIgnored) {
      const started = await op2('/api/fs/zip', { path: entry.path, skip_ignored: skipIgnored });
      if (!started) return;
      const jobUrl = `/api/fs/zip/job/${encodeURIComponent(started.job)}`;
      let cancelled = false;
      const bar = progressToast(skipIgnored ? t('{name} 폴더 압축 (.gitignore 제외)', { name: entry.name }) : t('{name} 폴더 압축', { name: entry.name }), () => {
        cancelled = true;
        api(jobUrl, { method: 'DELETE' }).catch(() => {});
      });
      for (;;) {
        await new Promise((resolve) => { setTimeout(resolve, 500); });
        let job;
        try { job = await api(jobUrl); } catch (error) { bar.close(); toast(error.message, 'error'); return; }
        if (job.state === 'running') {
          if (job.stage !== 'zip') bar.update(t('파일 찾는 중… {count}개', { count: Number(job.files || 0).toLocaleString(t.locale) }), null);
          else {
            const ratio = job.total_bytes ? job.done_bytes / job.total_bytes : (job.files_total ? job.files / job.files_total : 0);
            bar.update(t('{pct}% · {done} / {total} · 파일 {files} / {filesTotal}', { pct: Math.floor(ratio * 100), done: formatSize(job.done_bytes || 0), total: formatSize(job.total_bytes || 0), files: Number(job.files || 0).toLocaleString(t.locale), filesTotal: Number(job.files_total || 0).toLocaleString(t.locale) }), ratio);
          }
          continue;
        }
        bar.close();
        if (job.state === 'error') { toast(cancelled ? t('압축을 취소했습니다.') : job.error, cancelled ? 'info' : 'error'); return; }
        toast(t('{name} ({size}) 다운로드를 시작합니다.', { name: job.name, size: formatSize(job.size) }), 'success');
        window.location.href = `/api/fs/zip/${encodeURIComponent(job.token)}`;
        return;
      }
    }
    // Progress toast: stays on screen during a long job (re-attached if other toasts push it out)
    function progressToast(title, onCancel) {
      const host = document.getElementById('toastHost');
      const item = document.createElement('div');
      item.className = 'toast info ex-progress';
      item.innerHTML = `<i class="fas fa-file-zipper"></i>
        <div class="min-w-0 flex-1"><div class="ex-progress-title truncate"></div><div class="ex-progress-bar"><span></span></div><div class="ex-progress-text">${t('준비 중…')}</div></div>
        <button type="button" aria-label="${t('취소')}">${t('취소')}</button>`;
      item.querySelector('.ex-progress-title').textContent = title;
      const fill = item.querySelector('.ex-progress-bar span');
      const text = item.querySelector('.ex-progress-text');
      const cancel = item.querySelector('button');
      cancel.addEventListener('click', () => { cancel.disabled = true; text.textContent = t('취소하는 중…'); onCancel?.(); });
      host?.appendChild(item);
      return {
        update(message, ratio) {
          if (host && !item.isConnected) host.appendChild(item);
          if (!cancel.disabled) text.textContent = message;
          item.classList.toggle('indeterminate', ratio == null);
          if (ratio != null) fill.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
        },
        close() { item.remove(); },
      };
    }
    // ── Share link: lets one file · folder be downloaded without signing in for a set time (the link is shown only once, when created) ──
    const SHARE_TIMES = [[5, t('5분')], [15, t('15분')], [30, t('30분')], [60, t('1시간')], [180, t('3시간')], [720, t('12시간')], [1440, t('1일')], [4320, t('3일')], [10080, t('7일')]];
    const SHARE_COUNTS = [[0, t('제한 없음')], [1, t('1번만')], [3, t('3번')], [10, t('10번')]];
    function shareSheet(entry) {
      const isDir = entry.type === 'dir';
      const opts = (list, value) => list.map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${label}</option>`).join('');
      ui().formSheet({
        title: t('공유 링크 만들기'), subtitle: shortHome(entry.path), submitLabel: t('링크 만들기'),
        extraHtml: `<label>${t('받을 수 있는 시간')}<select name="minutes">${opts(SHARE_TIMES, 15)}</select></label>
          <label>${t('받을 수 있는 횟수')}<select name="count">${opts(SHARE_COUNTS, 0)}</select></label>
          ${isDir ? `<label class="check-row"><input type="checkbox" name="skip_ignored"> ${t('.gitignore 항목 빼기 (node_modules · .venv 등)')}</label>` : ''}
          <label class="check-row"><input type="checkbox" name="require_code"> ${t('접근 코드도 있어야 받을 수 있게 (링크와 따로 전달할 코드를 만듭니다)')}</label>
          <p class="text-[11px] opacity-60 leading-5"><i class="fas fa-shield-halved mr-1"></i>${isDir
            ? t('링크를 받은 사람은 로그인 없이 이 폴더 하나만 zip 으로 받을 수 있습니다. 다른 파일 · 폴더는 볼 수 없고, 시간이 지나면 링크가 사라집니다. 지금 내용을 묶어 두므로 나중에 바뀐 내용은 들어가지 않습니다. .env · 개인 키 · .git 은 제외됩니다.')
            : t('링크를 받은 사람은 로그인 없이 이 파일 하나만 받을 수 있습니다. 다른 파일 · 폴더는 볼 수 없고, 시간이 지나면 링크가 사라집니다.')}</p>`,
        async onSubmit(values) {
          const body = { path: entry.path, minutes: Number(values.minutes) || 15, max_downloads: Number(values.count) || 0, skip_ignored: !!values.skip_ignored, require_code: !!values.require_code };
          const result = await api('/api/share', { method: 'POST', body });
          if (result.state === 'done') { setTimeout(() => shareResult(result), 0); return false; }
          setTimeout(() => waitShare(entry, result.job), 0);
          return false;
        },
      });
    }
    async function waitShare(entry, jobId) {
      const jobUrl = `/api/share/job/${encodeURIComponent(jobId)}`;
      let cancelled = false;
      const bar = progressToast(t('{name} 공유 준비 (압축)', { name: entry.name }), () => { cancelled = true; api(jobUrl, { method: 'DELETE' }).catch(() => {}); });
      for (;;) {
        await new Promise((resolve) => { setTimeout(resolve, 500); });
        let job;
        try { job = await api(jobUrl); } catch (error) { bar.close(); toast(error.message, 'error'); return; }
        if (job.state === 'running') {
          if (job.stage !== 'zip') bar.update(t('파일 찾는 중… {count}개', { count: Number(job.files || 0).toLocaleString(t.locale) }), null);
          else {
            const ratio = job.total_bytes ? job.done_bytes / job.total_bytes : (job.files_total ? job.files / job.files_total : 0);
            bar.update(t('{pct}% · {done} / {total} · 파일 {files} / {filesTotal}', { pct: Math.floor(ratio * 100), done: formatSize(job.done_bytes || 0), total: formatSize(job.total_bytes || 0), files: Number(job.files || 0).toLocaleString(t.locale), filesTotal: Number(job.files_total || 0).toLocaleString(t.locale) }), ratio);
          }
          continue;
        }
        bar.close();
        if (job.state === 'error') { toast(cancelled ? t('공유를 취소했습니다.') : job.error, cancelled ? 'info' : 'error'); return; }
        shareResult(job);
        return;
      }
    }
    const shareWhen = (epoch) => new Date(epoch * 1000).toLocaleString(t.locale, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    function shareLeft(share) {
      const minutes = Math.max(0, Math.ceil((share.expires * 1000 - Date.now()) / 60000));
      const time = minutes >= 1440 ? t('{days}일 {hours}시간', { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60) })
        : minutes >= 60 ? t('{hours}시간 {minutes}분', { hours: Math.floor(minutes / 60), minutes: minutes % 60 }) : t('{minutes}분', { minutes });
      const count = share.max_downloads ? t('{count}/{max}번 받음', { count: share.downloads, max: share.max_downloads }) : t('{count}번 받음', { count: share.downloads });
      return t('{time} 남음 · {count}', { time, count });
    }
    function shareResult({ url, code, share }) {
      const link = `${location.origin}${url}`;
      const codeBox = code ? window.UnivDashAccessCode?.html(code) : '';
      ui().infoSheet({
        title: t('공유 링크를 만들었습니다'), subtitle: `${share.name} · ${formatSize(share.size)}`,
        bodyHtml: `<div class="share-box">${codeBox ? `${codeBox}<div class="mt-3"></div>` : ''}<div class="share-link"><input readonly value="${escapeHtml(link)}" aria-label="${t('공유 링크')}" spellcheck="false">
            <button type="button" class="btn-glow" data-copy><i class="fas fa-copy mr-1"></i>${t('복사')}</button>
            ${navigator.share ? `<button type="button" class="sheet-cancel" data-send><i class="fas fa-share-nodes mr-1"></i>${t('보내기')}</button>` : ''}</div>
          <p class="text-[12px] opacity-75 leading-5 mt-3">${share.max_downloads
            ? t('{when}까지 받을 수 있습니다 · {count}번만', { when: escapeHtml(shareWhen(share.expires)), count: escapeHtml(share.max_downloads) })
            : t('{when}까지 받을 수 있습니다 · 횟수 제한 없음', { when: escapeHtml(shareWhen(share.expires)) })}</p>
          <p class="text-[11px] opacity-60 leading-5 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>${code
            ? t('링크와 코드는 지금만 표시됩니다. 링크만으로는 받을 수 없고 코드가 꼭 있어야 합니다. 코드는 링크와 다른 방법(직접 말하기 · 다른 메신저)으로 받을 사람에게만 전달하십시오.')
            : t('링크는 지금만 표시됩니다. 링크를 아는 사람은 누구나 받을 수 있으니 받을 사람에게만 보내십시오.')} ${t('탐색기 ⋯ 메뉴 › 공유 중인 링크에서 언제든 끊을 수 있습니다.')}</p></div>`,
        onMount(body) {
          if (code) window.UnivDashAccessCode?.mount(body, code);
          const input = body.querySelector('.share-link input');
          input.addEventListener('focus', () => input.select());
          body.querySelector('[data-copy]').addEventListener('click', () => copyText(link, t('공유 링크 복사')));
          body.querySelector('[data-send]')?.addEventListener('click', () => navigator.share({ title: share.name, url: link }).catch(() => {}));
        },
      });
    }
    async function sharesSheet() {
      let list;
      try { list = (await api('/api/shares')).shares; } catch (error) { toast(error.message, 'error'); return; }
      const rows = list.map((s) => `<li class="share-row" data-share="${escapeHtml(s.id)}">
          <i class="fas ${s.kind === 'dir' ? 'fa-file-zipper' : 'fa-file'} opacity-70"></i>
          <div class="min-w-0 flex-1"><div class="truncate font-semibold">${escapeHtml(s.name)}${s.has_code ? `<span class="share-tag"><i class="fas fa-key"></i> ${t('코드')}</span>` : ''}</div>
            <div class="truncate text-[11px] opacity-60">${escapeHtml(shortHome(s.path))}</div>
            <div class="text-[11px] opacity-75">${escapeHtml(shareLeft(s))} · ${escapeHtml(formatSize(s.size))}</div></div>
          <button type="button" class="sheet-danger" data-revoke>${t('끊기')}</button></li>`).join('');
      ui().infoSheet({
        title: t('공유 중인 링크'), subtitle: list.length ? t('{count}개 · 시간이 지나면 저절로 사라집니다', { count: list.length }) : '',
        bodyHtml: `<div class="share-box">${list.length ? `<ul class="share-list">${rows}</ul>` : `<p class="opacity-70 text-sm">${t('공유 중인 링크가 없습니다. 파일이나 폴더를 우클릭해 만들 수 있습니다.')}</p>`}</div>`,
        onMount(body) {
          body.querySelectorAll('[data-revoke]').forEach((button) => button.addEventListener('click', async () => {
            const row = button.closest('[data-share]');
            button.disabled = true;
            try {
              await api(`/api/shares/${encodeURIComponent(row.dataset.share)}`, { method: 'DELETE' });
              row.remove();
              toast(t('링크를 끊었습니다. 이제 받을 수 없습니다.'), 'success');
            } catch (error) { button.disabled = false; toast(error.message, 'error'); }
          }));
        },
      });
    }
    async function op2(url, body) {
      try { return await api(url, { method: 'POST', body }); } catch (error) { toast(error.message, 'error'); return null; }
    }

    // ── Properties: kind · size (for folders the total size, quickly via the server's du) · permissions · owner · times · git ──
    async function showProperties(entry) {
      let info;
      try { info = await api(`/api/fs/stat?path=${encodeURIComponent(entry.path)}`); } catch (error) { toast(error.message, 'error'); return; }
      const isDir = info.type === 'dir';
      const when = (epoch) => (epoch ? new Date(epoch * 1000).toLocaleString(t.locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
      const exact = (n) => t('{n} 바이트', { n: Number(n).toLocaleString(t.locale) });
      const row = (label, value, extra = '') => `<div class="prop-row ${extra}"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
      const rows = [
        row(t('종류'), escapeHtml(isDir ? t('폴더') : `${info.kind}${entry.ext ? ` (.${entry.ext})` : ''}`)),
        row(t('위치'), `<button type="button" class="prop-copy" data-copy="${escapeHtml(info.path)}" title="${t('경로 복사')}">${escapeHtml(shortHome(info.path))} <i class="fas fa-copy"></i></button>`),
        info.link ? row(t('링크 대상'), escapeHtml(info.link_target || '')) : '',
        isDir
          ? row(t('크기'), `<span data-du-size><i class="fas fa-circle-notch fa-spin"></i> ${t('계산 중…')}</span>`, 'strong') + row(t('디스크 사용'), '<span data-du-disk>…</span>') + row(t('안에 든 항목'), `<span data-du-items>…</span><span class="opacity-60"> ${t('(바로 아래 {children}개 · 폴더 {dirs}개)', { children: info.children ?? '?', dirs: info.child_dirs ?? '?' })}</span>`)
          : row(t('크기'), `${escapeHtml(formatSize(info.size))} <span class="opacity-60">(${exact(info.size)})</span>`, 'strong') + row(t('디스크 사용'), escapeHtml(formatSize(info.disk))),
        row(t('수정한 날짜'), escapeHtml(when(info.mtime))),
        row(t('마지막으로 연 날짜'), escapeHtml(when(info.atime))),
        row(t('상태 변경'), escapeHtml(when(info.ctime))),
        info.birth ? row(t('만든 날짜'), escapeHtml(when(info.birth))) : '',
        row(t('권한'), `<code>${escapeHtml(info.mode)}</code> <span class="opacity-60">(${escapeHtml(info.octal)})</span> · ${[info.readable && t('읽기'), info.writable && t('쓰기'), info.executable && t('실행')].filter(Boolean).join(' · ') || t('접근 불가')}`),
        row(t('소유자'), escapeHtml(`${info.owner} : ${info.group}`)),
        info.git_repo ? row(t('Git 저장소'), `${escapeHtml(shortHome(info.git_repo))}${info.git_ignored ? ` <span class="prop-tag">${t('.gitignore 로 무시됨')}</span>` : ''}`) : '',
      ].join('');
      ui().infoSheet({
        title: info.name, subtitle: isDir ? t('폴더 속성') : t('파일 속성'),
        bodyHtml: `<dl class="prop-list">${rows}</dl>`,
        async onMount(body) {
          body.querySelector('[data-copy]')?.addEventListener('click', (event) => copyText(event.currentTarget.dataset.copy, t('경로 복사')));
          if (!isDir) return;
          try {
            const du = await api(`/api/fs/du?path=${encodeURIComponent(entry.path)}`);
            const set = (sel, html) => { const el = body.querySelector(sel); if (el) el.innerHTML = html; };
            if (du.timed_out) { set('[data-du-size]', t('너무 커서 30초 안에 다 세지 못했습니다')); set('[data-du-disk]', '—'); set('[data-du-items]', '—'); return; }
            const note = du.partial ? ` <span class="prop-tag warn">${t('권한 없는 하위 폴더 제외')}</span>` : '';
            set('[data-du-size]', `${escapeHtml(formatSize(du.size))} <span class="opacity-60">(${exact(du.size)})</span>${note}`);
            set('[data-du-disk]', escapeHtml(formatSize(du.disk)));
            set('[data-du-items]', t('{count}개', { count: Number(du.items).toLocaleString(t.locale) }));
          } catch (error) {
            const el = body.querySelector('[data-du-size]');
            if (el) el.textContent = t('계산 실패: {error}', { error: error.message });
          }
        },
      });
    }

    // ── Menus ──
    function entryMenu(entry, x, y) {
      if (picked.size > 1 && picked.has(entry.path)) {
        const paths = [...picked];
        openMenu({
          title: t('{count}개 선택', { count: paths.length }), x, y,
          items: [
            { icon: 'fa-copy', label: t('경로 모두 복사'), onClick: () => copyText(paths.join('\n'), t('{count}개 경로 복사', { count: paths.length })) },
            options.onInsert && { icon: 'fa-paper-plane', label: t('프롬프트에 경로 모두 넣기'), onClick: () => options.onInsert(paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')) },
            'sep',
            { icon: 'fa-trash-can', label: t('{count}개 삭제 (휴지통으로)', { count: paths.length }), danger: true, onClick: () => removeMany(paths) },
          ],
        });
        return;
      }
      const isDir = entry.type === 'dir';
      const manual = prefs().sort === 'manual';
      const clip = shared.clipboard;
      openMenu({
        title: entry.name, subtitle: shortHome(entry.path), x, y,
        items: [
          isDir ? { icon: 'fa-file-circle-plus', label: t('새 파일'), onClick: () => create(entry.path, 'file') } : { icon: 'fa-eye', label: t('열기'), onClick: () => options.onOpen?.(entry) },
          isDir && { icon: 'fa-folder-plus', label: t('새 폴더 · Git clone'), onClick: () => folderSheet(entry.path) },
          isDir && { icon: 'fa-upload', label: t('파일 업로드'), onClick: () => { uploadDir = entry.path; uploadInput.click(); } },
          isDir && { icon: 'fa-folder-plus', label: t('폴더 업로드'), onClick: () => { uploadDir = entry.path; uploadDirInput.click(); } },
          isDir && clip && { icon: 'fa-paste', label: t('붙여넣기'), sub: clipLabel(), onClick: () => paste(entry.path) },
          'sep',
          { icon: 'fa-copy', label: t('경로 복사'), onClick: () => copyText(entry.path, t('경로 복사')) },
          { icon: 'fa-code-branch', label: t('상대 경로 복사'), onClick: () => copyText(relative(entry.path), t('상대 경로 복사')) },
          { icon: 'fa-font', label: t('이름 복사'), onClick: () => copyText(entry.name, t('이름 복사')) },
          options.onInsert && { icon: 'fa-paper-plane', label: t('프롬프트에 경로 넣기'), onClick: () => options.onInsert(entry.path) },
          !isDir && { icon: 'fa-download', label: t('다운로드'), onClick: () => { window.location.href = `/api/fs/raw?download=1&path=${encodeURIComponent(entry.path)}`; } },
          isDir && { icon: 'fa-file-zipper', label: t('폴더 다운로드 (.zip)'), onClick: () => downloadFolder(entry, false) },
          isDir && { icon: 'fa-filter', label: t('다운로드 (.gitignore 항목 제외)'), sub: t('node_modules · .venv 등 빼고'), onClick: () => downloadFolder(entry, true) },
          { icon: 'fa-link', label: t('공유 링크 만들기'), sub: t('정한 시간 동안 로그인 없이 받기'), onClick: () => shareSheet(entry) },
          isDir && { icon: 'fa-terminal', label: t('여기서 Terminal 열기'), onClick: () => { if (window.UnivDashWs?.newTerminal) window.UnivDashWs.newTerminal(entry.path); else location.href = `/?newterm=1&cwd=${encodeURIComponent(entry.path)}`; } },
          isDir && ui().newSession && { icon: 'fa-layer-group', label: t('여기서 새 tmux 세션'), onClick: () => ui().newSession(entry.path) },
          isDir && { icon: 'fa-arrow-right-to-bracket', label: t('이 폴더를 루트로 보기'), onClick: () => setRoot(entry.path) },
          isDir && { icon: 'fa-thumbtack', label: prefs().pinned.includes(entry.path) ? t('루트 목록에서 고정 해제') : t('루트 목록에 고정'), onClick: () => togglePin(entry.path) },
          'sep',
          { icon: 'fa-arrow-right-to-bracket', label: t('다른 폴더로 이동…'), onClick: () => moveDialog(entry) },
          { icon: 'fa-scissors', label: t('잘라내기'), sub: `${isMac ? '⌘' : 'Ctrl+'}X`, onClick: () => setClip('cut', clipTargets(entry)) },
          { icon: 'fa-clone', label: t('복사'), sub: `${isMac ? '⌘' : 'Ctrl+'}C`, onClick: () => setClip('copy', clipTargets(entry)) },
          { icon: 'fa-pen', label: t('이름 바꾸기'), onClick: () => rename(entry) },
          { icon: isGated(entry.path) ? 'fa-eye' : 'fa-eye-slash', label: isGated(entry.path) ? t('다시 보이기') : t('가리기'), onClick: () => toggleGate(entry) },
          manual && { icon: 'fa-arrow-up', label: t('위로 이동'), onClick: () => moveInOrder(entry, -1) },
          manual && { icon: 'fa-arrow-down', label: t('아래로 이동'), onClick: () => moveInOrder(entry, 1) },
          'sep',
          { icon: 'fa-circle-info', label: t('속성'), onClick: () => showProperties(entry) },
          'sep',
          { icon: 'fa-trash-can', label: t('삭제 (휴지통으로)'), danger: true, onClick: () => remove(entry) },
        ],
      });
    }
    function sortSheet() {
      const current = prefs().sort;
      ui().actionSheet({
        title: t('정렬 기준'), subtitle: t('모든 폴더에 적용됩니다. 직접 지정은 폴더마다 순서를 기억합니다.'),
        actions: Object.entries(SORTS).map(([id, s]) => ({ icon: s.icon, label: s.label, desc: s.desc, sub: id === current ? '✓' : '', current: id === current, onClick: () => { prefs().sort = id; savePrefs(); render(); } })),
      });
    }
    function moreMenu(x, y) {
      const p = prefs();
      openMenu({
        title: t('보기 · 정렬'), x, y,
        items: [
          { icon: 'fa-arrow-down-wide-short', label: t('정렬 기준'), sub: SORTS[p.sort].label, onClick: sortSheet },
          { icon: p.show_dotfiles ? 'fa-toggle-on' : 'fa-toggle-off', label: t('숨김 파일(. 파일) 표시'), sub: p.show_dotfiles ? t('켜짐') : t('꺼짐'), onClick: () => { p.show_dotfiles = !p.show_dotfiles; savePrefs(); render(); } },
          { icon: p.show_hidden ? 'fa-toggle-on' : 'fa-toggle-off', label: t('가린 항목 표시'), sub: t('{count}개', { count: p.hidden.length }), onClick: () => { p.show_hidden = !p.show_hidden; savePrefs(); render(); } },
          'sep',
          { icon: 'fa-upload', label: t('루트에 파일 업로드'), onClick: () => { uploadDir = root; uploadInput.click(); } },
          { icon: 'fa-folder-plus', label: t('루트에 폴더 업로드'), onClick: () => { uploadDir = root; uploadDirInput.click(); } },
          shared.clipboard && { icon: 'fa-paste', label: t('루트에 붙여넣기'), sub: clipLabel(), onClick: () => paste(root) },
          { icon: 'fa-copy', label: t('루트 경로 복사'), onClick: () => copyText(root, t('경로 복사')) },
          { icon: 'fa-trash-arrow-up', label: t('휴지통 열기'), onClick: () => setRoot(`${shared.home}/.univdash/trash`) },
          { icon: 'fa-link', label: t('공유 중인 링크'), onClick: () => sharesSheet() },
        ],
      });
    }
    function rootMenu(x, y) {
      const pinned = prefs().pinned;
      const candidates = [...new Set([...pinned, ...shared.roots, shared.home])];
      const parent = dirname(root);
      const parentAllowed = root !== '/' && shared.roots.some((r) => parent === r || parent.startsWith(`${r}/`));
      openMenu({
        title: t('루트 폴더'), subtitle: shortHome(root), x, y,
        items: [
          parentAllowed && { icon: 'fa-arrow-turn-up', label: t('상위 폴더로'), sub: shortHome(parent), onClick: () => setRoot(parent) },
          ...candidates.map((path) => ({ icon: pinned.includes(path) ? 'fa-thumbtack' : 'fa-house', label: shortHome(path), sub: path === root ? t('현재') : '', onClick: () => setRoot(path) })),
          'sep',
          { icon: 'fa-keyboard', label: t('경로 입력해서 열기'), onClick: async () => {
            const value = await askName({ title: t('폴더 열기'), subtitle: t('~/ 로 시작해도 됩니다.'), value: shortHome(root), label: t('경로'), submitLabel: t('열기') });
            if (value) reveal(value.replace(/\/+$/, '') || '/');
          } },
          { icon: 'fa-thumbtack', label: pinned.includes(root) ? t('현재 루트 고정 해제') : t('현재 루트를 목록에 고정'), onClick: () => togglePin(root) },
        ],
      });
    }

    // ── Events ──
    const pointOf = (event, fallback) => {
      if (event.clientX || event.clientY) return [event.clientX, event.clientY];
      const rect = fallback.getBoundingClientRect();
      return [rect.left, rect.bottom];
    };
    container.addEventListener('click', (event) => {
      const tool = event.target.closest('[data-act]');
      if (tool && !tool.closest('.ex-row')) {
        const [x, y] = pointOf(event, tool);
        const act = tool.dataset.act;
        if (act === 'root') rootMenu(x, y);
        else if (act === 'new-file') create(selectedDir(), 'file');
        else if (act === 'new-folder') folderSheet(selectedDir());
        else if (act === 'upload') { uploadDir = selectedDir(); toast(t('업로드 위치: {path}', { path: shortHome(uploadDir) }), 'info'); uploadInput.click(); }
        else if (act === 'reset-width') options.onWidthReset?.();
        else if (act === 'refresh') refresh().then(() => toast(t('새로고침했습니다.'), 'success'));
        else if (act === 'collapse') { expanded = new Set(); saveExpanded(); render(); }
        else if (act === 'more') moreMenu(x, y);
        return;
      }
      const row = event.target.closest('.ex-row');
      if (!row) {
        // Clicking empty space clears the selection → new file · folder · upload go to the root (~)
        if (event.target.closest('.ex-body') && !event.target.closest('.ex-results')) select(null);
        return;
      }
      const path = row.dataset.path;
      const entry = entryAt(path) || { path, name: basename(path), type: row.dataset.type, ext: '' };
      body.focus({ preventScroll: true });
      if (event.target.closest('[data-act="copy"]')) {
        copyText(path, t('경로 복사'));
        const button = event.target.closest('[data-act="copy"]');
        button.innerHTML = '<i class="fas fa-check"></i>';
        button.classList.add('done');
        setTimeout(() => { button.innerHTML = '<i class="far fa-copy"></i>'; button.classList.remove('done'); }, 1200);
        return;
      }
      if (event.target.closest('[data-act="menu"]')) { const [x, y] = pointOf(event, event.target); entryMenu(entry, x, y); return; }
      if (event.shiftKey && !event.target.closest('.ex-results')) { event.preventDefault(); selectRange(path); return; }
      if ((event.ctrlKey || event.metaKey) && !event.target.closest('.ex-results')) { toggleSelect(path); return; }
      select(path);
      if (entry.type === 'dir') toggle(path);
      else options.onOpen?.(entry);
    });
    container.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('.ex-row');
      if (!row) return;
      event.preventDefault();
      const entry = entryAt(row.dataset.path);
      if (entry) { if (!(picked.size > 1 && picked.has(entry.path))) select(entry.path); entryMenu(entry, event.clientX, event.clientY); }
    });
    // Phone: long-press opens the menu (in manual sort a long-press drags, so use the ⋯ button)
    let pressTimer = null;
    let pressStart = null;
    container.addEventListener('pointerdown', (event) => {
      const row = event.target.closest('.ex-row');
      if (!row || event.pointerType === 'mouse' || prefs()?.sort === 'manual' || event.target.closest('button')) return;
      pressStart = [event.clientX, event.clientY];
      pressTimer = setTimeout(() => {
        pressTimer = null;
        const entry = entryAt(row.dataset.path);
        if (entry) { window.UnivDash.haptic(10); select(entry.path); entryMenu(entry); row.dataset.pressed = '1'; }
      }, 520);
    });
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
    container.addEventListener('pointermove', (event) => { if (pressTimer && Math.hypot(event.clientX - pressStart[0], event.clientY - pressStart[1]) > 10) cancelPress(); });
    container.addEventListener('pointerup', cancelPress);
    container.addEventListener('pointercancel', cancelPress);
    container.addEventListener('click', (event) => {
      const row = event.target.closest('.ex-row');
      if (row?.dataset.pressed) { delete row.dataset.pressed; event.stopImmediatePropagation(); event.preventDefault(); }
    }, true);

    function selectedDir() {
      if (!selected) return root;
      const entry = entryAt(selected);
      return entry?.type === 'dir' ? selected : dirname(selected);
    }

    // ── Search ──
    let searchTimer = null;
    function clearSearch() {
      searchInput.value = '';
      results.classList.add('hidden');
      treeEl.classList.remove('hidden');
    }
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = searchInput.value.trim();
      if (!q) { clearSearch(); return; }
      searchTimer = setTimeout(async () => {
        const seq = ++searchSeq;
        results.classList.remove('hidden');
        treeEl.classList.add('hidden');
        results.innerHTML = `<div class="ex-note"><i class="fas fa-circle-notch fa-spin"></i> ${t('검색 중…')}</div>`;
        try {
          const data = await api(`/api/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&hidden=${prefs().show_dotfiles ? 1 : 0}&env=${showEnv() ? 1 : 0}`);
          if (seq !== searchSeq) return;
          results.innerHTML = data.results.length ? data.results.map((entry) => `
            <div class="ex-row ex-result" data-path="${escapeHtml(entry.path)}" data-type="${entry.type}">
              ${iconFor(entry)}<span class="ex-name">${escapeHtml(entry.name)}<span class="ex-result-path">${escapeHtml(dirname(relative(entry.path)) === '.' ? '' : dirname(relative(entry.path)))}</span></span>
              <button type="button" class="ex-more ex-copy" data-act="copy" title="${t('경로 복사')}" aria-label="${t('경로 복사')}"><i class="far fa-copy"></i></button>
              <button type="button" class="ex-more" data-act="menu" aria-label="${t('메뉴')}"><i class="fas fa-ellipsis"></i></button>
            </div>`).join('') + (data.truncated ? `<div class="ex-note">${t('결과가 많아 일부만 보여줍니다.')}</div>` : '')
            : `<div class="ex-note">${t('결과가 없습니다.')}</div>`;
          data.results.forEach((entry) => {
            const dir = dirname(entry.path);
            if (!cache.has(dir)) cache.set(dir, []);
            if (Array.isArray(cache.get(dir)) && !cache.get(dir).some((e) => e.path === entry.path)) cache.get(dir).push(entry);
          });
        } catch (error) {
          results.innerHTML = `<div class="ex-note error">${escapeHtml(error.message)}</div>`;
        }
      }, 300);
    });
    results.addEventListener('click', (event) => {
      const row = event.target.closest('.ex-result');
      if (!row || event.target.closest('[data-act="menu"]')) return;
      if (event.target.closest('[data-act="copy"]')) { event.stopPropagation(); copyText(row.dataset.path, t('경로 복사')); return; }
      event.stopPropagation();
      reveal(row.dataset.path);
      if (row.dataset.type !== 'dir') options.onOpen?.(entryAt(row.dataset.path) || { path: row.dataset.path, name: basename(row.dataset.path), type: 'file', ext: '' });
    }, true);

    // ── Start ──
    loadPrefs().then(async () => {
      const candidates = [...(prefs().pinned || []), ...shared.roots];
      if (!root || !shared.roots.some((r) => root === r || root.startsWith(`${r}/`))) root = candidates[0] || shared.home;
      await setRoot(root);
      if (options.initialReveal) reveal(options.initialReveal);
      options.onReady?.();
    }).catch((error) => { treeEl.innerHTML = `<div class="ex-note error">${escapeHtml(error.message)}</div>`; });

    return { reveal, follow, refresh: () => refresh(), get root() { return root; } };
  }

  // ════════════════════════════════════════════════════════════════════════
  // File viewer
  // ════════════════════════════════════════════════════════════════════════
  const LANGS = {
    py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
    css: 'css', scss: 'scss', less: 'less', md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'bash',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', sql: 'sql', swift: 'swift', lua: 'lua', r: 'r', pl: 'perl', diff: 'diff', patch: 'diff', graphql: 'graphql',
  };
  // Open tabs · per-tab view state (scroll · zoom) are saved in localStorage → unchanged after visiting another page.
  // The Explorer page and the Workspace file view share the same tab list.
  const TAB_KEY = 'tabs';
  const MAX_TABS = 30;
  function loadTabState(key = TAB_KEY) {
    const saved = store.get(key, null);
    // Tabs opened earlier literally as "file:58" get the line number stripped and become real file tabs
    const fixed = (tab) => {
      const ref = splitLineRef(tab.path);
      if (!ref.line) return tab;
      const name = basename(ref.path);
      const dot = name.lastIndexOf('.');
      return { ...tab, path: ref.path, name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
    };
    const tabs = (Array.isArray(saved?.tabs) ? saved.tabs.filter((tab) => tab && typeof tab.path === 'string').map(fixed) : [])
      .filter((tab, i, all) => all.findIndex((o) => o.path === tab.path) === i).slice(0, MAX_TABS);
    const savedActive = typeof saved?.active === 'string' ? splitLineRef(saved.active).path : null;
    const active = tabs.some((tab) => tab.path === savedActive) ? savedActive : tabs[0]?.path || null;
    return { tabs, active, view: saved?.view && typeof saved.view === 'object' ? saved.view : {} };
  }

  // "file:58" · "file:58:3" · "file:58-60" · "file#L58" → { path, line } (line 0 when there is no line number)
  const LINE_REF = /^(.*?[^/:])(?::(\d+)(?:[:-]\d+)?|#L(\d+)(?:-L?\d+)?)$/;
  function splitLineRef(path) {
    const m = String(path || '').match(LINE_REF);
    return m ? { path: m[1], line: Number(m[2] || m[3]) } : { path, line: 0 };
  }
  // The #L58 of a link inside a document is dropped by path resolution, so it is re-attached as ":58"
  const withHashLine = (path, href) => {
    const line = path && String(href).match(/#L(\d+)/)?.[1];
    return line ? `${path}:${line}` : path;
  };
  // Relative path (image · link) → absolute path based on the md file
  function resolveRelPath(base, href) {
    let clean;
    try { clean = decodeURIComponent(href.split('#')[0].split('?')[0]); } catch (e) { return null; }
    if (!clean) return null;
    const parts = (clean.startsWith('/') ? clean : `${dirname(base)}/${clean}`).split('/');
    const out = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return `/${out.join('/')}`;
  }
  // HTML file preview: scripts are never run (DOMPurify), and the document's styles apply only inside a Shadow DOM so they do not mix with the dashboard.
  // Relative paths and file:/// URLs of images · CSS are rewritten to the same file on the server (/api/fs/raw). External (https) images are blocked by CSP and do not show.
  const HTML_RES_ATTRS = [['img', 'src'], ['img', 'srcset'], ['source', 'src'], ['source', 'srcset'], ['video', 'src'], ['video', 'poster'], ['audio', 'src'], ['track', 'src'], ['image', 'href'], ['image', 'xlink:href'], ['*', 'background']];
  function htmlLocalPath(url, base) {
    const value = (url || '').trim();
    if (!value || value.startsWith('#') || value.startsWith('//')) return null;
    if (/^file:/i.test(value)) { try { return resolveRelPath(base, new URL(value).pathname); } catch (e) { return null; } }
    if (/^[a-z][\w+.-]*:/i.test(value)) return null;   // https: data: mailto: …
    return resolveRelPath(base, value);
  }
  const htmlRawUrl = (path) => `/api/fs/raw?path=${encodeURIComponent(path)}`;
  function htmlCssUrls(css, base) {
    return css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, url) => { const path = htmlLocalPath(url, base); return path ? `url("${htmlRawUrl(path)}")` : m; });
  }
  // Document CSS → a stylesheet for this document only: html · :root · body selectors are moved onto the wrappers inside the Shadow DOM
  function htmlSheet(css, base) {
    const sheet = new CSSStyleSheet();
    try { sheet.replaceSync(htmlCssUrls(css.replace(/@import[^;]*;/gi, ''), base)); } catch (e) { return null; }
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText && rule.style) {
          rule.selectorText = rule.selectorText
            .replace(/(^|[\s>+~,(])(html|:root)(?![\w-])/gi, '$1.hv-html')
            .replace(/(^|[\s>+~,(])body(?![\w-])/gi, '$1.hv-body');
        }
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    walk(sheet.cssRules);
    return sheet;
  }
  const HTML_BASE_CSS = ':host{all:initial;display:block;color-scheme:light}.hv-html{background:#fff;color:#000;min-height:100%;overflow-wrap:break-word}.hv-body{display:block;margin:8px}.hv-html.hv-paper{background:transparent;min-width:max-content;padding:20px 24px 40px}.hv-paper>.hv-body{box-shadow:0 2px 14px rgba(0,0,0,.35)}:where(a[data-ex-open],a[data-anchor]){color:LinkText;text-decoration:underline;cursor:pointer}img,video,svg{max-width:100%}';
  const HTML_CURSOR_CSS = '.md-cursor{outline:2px solid rgba(37,99,235,.75)!important;outline-offset:2px;border-radius:2px}';
  // For the preview while editing: inserts a line range (data-md-line · data-md-end, 0-based) into every opening tag of the source.
  // Skips the inside of comments · CDATA · raw-text elements like <script>/<style>, and takes the end line from the closing tag (an unclosed element lasts until its parent closes).
  const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const HTML_RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript']);
  const HTML_SKIP = new Set(['html', 'head', 'body', 'br', 'wbr', 'meta', 'link', 'base', 'script', 'style', 'title']);
  const HTML_IMPLIED = { li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], p: ['p'], tr: ['tr'], td: ['td', 'th'], th: ['td', 'th'], option: ['option'], tbody: ['thead', 'tbody'], tfoot: ['thead', 'tbody'] };
  const HTML_SCOPE = ['ul', 'ol', 'menu', 'dl', 'table', 'select', 'div', 'section', 'article', 'blockquote'];
  function tagHtmlLines(src) {
    const marks = [];
    const stack = [];
    let line = 0;
    let at = 0;
    const advance = (to) => { for (let i = at; i < to; i++) if (src.charCodeAt(i) === 10) line++; at = to; };
    const len = src.length;
    let i = src.indexOf('<');
    while (i >= 0 && i < len) {
      advance(i);
      if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e < 0 ? len : e + 3; }
      else if (src.startsWith('<![CDATA[', i)) { const e = src.indexOf(']]>', i); i = e < 0 ? len : e + 3; }
      else if (src[i + 1] === '!' || src[i + 1] === '?') { const e = src.indexOf('>', i); i = e < 0 ? len : e + 1; }
      else if (src[i + 1] === '/') {
        const m = /^<\/([a-zA-Z][\w:-]*)[^>]*>?/.exec(src.slice(i, i + 200));
        if (m) {
          const name = m[1].toLowerCase();
          const k = stack.map((item) => item.name).lastIndexOf(name);
          if (k >= 0) while (stack.length > k) stack.pop().end = line;
        }
        i += m ? m[0].length : 2;
      } else {
        const m = /^<([a-zA-Z][\w:-]*)/.exec(src.slice(i, i + 200));
        if (!m) { i += 1; i = src.indexOf('<', i); continue; }
        const name = m[1].toLowerCase();
        // Find the end of the tag, ignoring > inside quotes
        let j = i + m[0].length;
        let quote = '';
        for (; j < len; j++) {
          const c = src[j];
          if (quote) { if (c === quote) quote = ''; }
          else if (c === '"' || c === "'") quote = c;
          else if (c === '>') break;
        }
        const selfClose = src[j - 1] === '/';
        // Elements that need no closing tag (<li>, <p>, <tr> …) end on the line before the next sibling opens
        const implied = HTML_IMPLIED[name];
        if (implied) {
          const names = stack.map((item) => item.name);
          const k = Math.max(...implied.map((n) => names.lastIndexOf(n)));
          const stop = Math.max(...HTML_SCOPE.map((n) => names.lastIndexOf(n)));   // do not close anything outside the inner list · table
          if (k >= 0 && k > stop) {
            const own = /^\s*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i));   // when the new tag starts its line, up to the previous line
            while (stack.length > k) { const item = stack.pop(); item.end = Math.max(item.start, own ? line - 1 : line); }
          }
        }
        const mark = { pos: i + m[0].length, start: line, end: -1, name };
        if (!HTML_SKIP.has(name)) marks.push(mark);
        i = j + 1;
        if (HTML_RAW.has(name)) {
          const e = src.toLowerCase().indexOf(`</${name}`, i);
          i = e < 0 ? len : e;
          if (!HTML_SKIP.has(name)) stack.push(mark);
        } else if (!HTML_VOID.has(name) && !selfClose) stack.push(mark);
        else { advance(Math.min(i, len)); mark.end = line; }
      }
      i = i < len ? src.indexOf('<', i) : -1;
    }
    advance(len);
    stack.forEach((item) => { item.end = line; });
    let out = '';
    let last = 0;
    for (const mark of marks) {
      out += `${src.slice(last, mark.pos)} data-md-line="${mark.start}" data-md-end="${Math.max(mark.start, mark.end)}"`;
      last = mark.pos;
    }
    return out + src.slice(last);
  }
  // Draws the document inside host. onOpen(path): a local file link inside the document was clicked
  // options.lines: attach line ranges so the cursor marker can be used, options.cssCache: avoid re-reading linked CSS (Map),
  // options.alive(): keeps an earlier render that finished late from overwriting the newer result
  async function mountHtmlDoc(host, content, docPath, onOpen, options = {}) {
    if (options.lines) { try { content = tagHtmlLines(content); } catch (e) { /* render without line marks */ } }
    const doc = new DOMParser().parseFromString(content, 'text/html');   // a document in which scripts do not run
    const sheets = [];
    for (const el of doc.querySelectorAll('style, link[rel~="stylesheet" i][href]')) {
      if (el.tagName === 'STYLE') { sheets.push({ css: el.textContent, base: docPath }); continue; }
      const path = htmlLocalPath(el.getAttribute('href'), docPath);
      if (!path) continue;
      const cache = options.cssCache;
      if (cache?.has(path)) { if (cache.get(path) != null) sheets.push({ css: cache.get(path), base: path }); continue; }
      let css = null;
      try {
        const file = await window.UnivDash.api(`/api/fs/read?path=${encodeURIComponent(path)}`);
        if (typeof file?.content === 'string') css = file.content;
      } catch (e) { /* CSS that cannot be read is skipped */ }
      cache?.set(path, css);
      if (css != null) sheets.push({ css, base: path });
    }
    if (options.alive && !options.alive()) return;
    doc.querySelectorAll('style, link, script, noscript, base, meta').forEach((el) => el.remove());
    for (const [tag, attr] of HTML_RES_ATTRS) {
      doc.body.querySelectorAll(tag === '*' ? `[${CSS.escape(attr)}]` : tag).forEach((el) => {
        const value = el.getAttribute(attr);
        if (value == null) return;
        if (attr === 'srcset') {
          el.setAttribute(attr, value.split(',').map((part) => {
            const [url, ...rest] = part.trim().split(/\s+/);
            const path = htmlLocalPath(url, docPath);
            return [path ? htmlRawUrl(path) : url, ...rest].join(' ');
          }).join(', '));
          return;
        }
        const path = htmlLocalPath(value, docPath);
        if (path) el.setAttribute(attr, htmlRawUrl(path));
      });
    }
    doc.body.querySelectorAll('[style]').forEach((el) => el.setAttribute('style', htmlCssUrls(el.getAttribute('style'), docPath)));
    const purify = { USE_PROFILES: { html: true, svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'style', 'link', 'meta', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'], ADD_ATTR: ['xlink:href'], RETURN_DOM_FRAGMENT: true };
    const fragment = window.DOMPurify.sanitize(doc.body.innerHTML, purify);
    fragment.querySelectorAll('img').forEach((img) => { img.loading = 'lazy'; img.decoding = 'async'; });
    fragment.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) { a.dataset.anchor = href.slice(1); a.removeAttribute('href'); return; }
      if (/^(https?:|mailto:|tel:)/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
      const path = withHashLine(htmlLocalPath(href, docPath), href);
      a.removeAttribute('href');
      if (path) { a.dataset.exOpen = path; a.title = shortHome(path); a.setAttribute('role', 'link'); a.tabIndex = 0; }
    });
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    const base = new CSSStyleSheet();
    base.replaceSync(HTML_BASE_CSS + (options.lines ? HTML_CURSOR_CSS : ''));
    root.adoptedStyleSheets = [base, ...sheets.map((item) => htmlSheet(item.css, item.base)).filter(Boolean)];
    const htmlEl = document.createElement('div');
    htmlEl.className = `hv-html ${doc.documentElement.className || ''}`.trim();
    const bodyEl = document.createElement('div');
    bodyEl.className = `hv-body ${doc.body.className || ''}`.trim();
    const bodyStyle = doc.body.getAttribute('style');
    if (bodyStyle) bodyEl.setAttribute('style', bodyStyle);
    bodyEl.appendChild(fragment);
    htmlEl.appendChild(bodyEl);
    root.replaceChildren(htmlEl);
    // A fixed-width document (a print page like body{width:210mm}) is placed as a centred sheet like a PDF, with the viewer background around it.
    // Briefly making the frame very wide and measuring tells this regardless of the screen width.
    htmlEl.style.width = '20000px';
    const style = getComputedStyle(bodyEl);
    const fixed = bodyEl.getBoundingClientRect().width + parseFloat(style.marginLeft) + parseFloat(style.marginRight) < 19990;
    htmlEl.style.width = '';
    host.classList.toggle('hv-paper', fixed);
    if (fixed) {
      htmlEl.classList.add('hv-paper');
      bodyEl.style.marginLeft = 'auto';
      bodyEl.style.marginRight = 'auto';
      if (style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none') bodyEl.style.backgroundColor = '#fff';
    }
    if (host.dataset.bound) return;
    host.dataset.bound = '1';
    root.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-anchor], a[data-ex-open]');
      if (!link) return;
      event.preventDefault();
      if (link.dataset.anchor) {
        const id = link.dataset.anchor;
        (root.getElementById(id) || root.querySelector(`[name="${CSS.escape(id)}"]`))?.scrollIntoView({ behavior: 'smooth' });
      } else onOpen?.(link.dataset.exOpen);
    });
  }

  // Markdown → HTML (the viewer and the PDF use the same function, so they look identical):
  // math is taken out before marked (common.js) and drawn with KaTeX after DOMPurify sanitising; code is coloured with highlight.js.
  // options.imageUrl(path): URL for a relative-path image, options.pdf: links stay as text instead of being clickable,
  // options.lines: attach the source line range (data-md-line · data-md-end, 0-based) to each block (to show the cursor position while editing)
  function renderMarkdownHtml(content, mdPath, options = {}) {
    if (!window.marked || !window.DOMPurify) return null;
    const { text, math } = window.UnivDash.math.extract(content);
    const opts = { gfm: true, breaks: false };
    let raw;
    let marks = null;
    // Counting lines: multi-line math has been replaced by a one-line placeholder, so the swallowed lines are added back
    const span = (str) => {
      let n = (str.match(/\n/g) || []).length;
      str.replace(/KTXM(\d+)Z/g, (m, i) => { n += math[Number(i)]?.nl || 0; return m; });
      return n;
    };
    if (options.lines) {
      // Render with an empty marker tag inserted before each top-level block, then copy the line range onto the element right after the tag and remove the tag
      const tokens = window.marked.lexer(text, opts);
      marks = [];
      let line = 0;
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        const start = line;
        line += span(token.raw);
        if (token.type === 'space') continue;
        marks.push({ token, start, end: start + span(token.raw.replace(/\n+$/, '')) });
        tokens.splice(i, 0, { type: 'html', block: true, pre: false, raw: '', text: `<span data-mdmark="${marks.length - 1}"></span>` });
        i += 1;
      }
      raw = window.marked.parser(tokens, opts);
    } else {
      raw = window.marked.parse(text, opts);
    }
    const html = window.DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });
    const box = document.createElement('div');
    box.className = 'exv-md';
    box.innerHTML = window.UnivDash.math.render(html, math);
    if (marks) {
      const tag = (el, a, b) => { el.dataset.mdLine = a; el.dataset.mdEnd = b; };
      // Lists are tagged per item (nested lists too), tables per row
      const tagList = (el, token, start) => {
        if (!/^(UL|OL)$/.test(el.tagName)) return;
        const items = [...el.children].filter((c) => c.tagName === 'LI');
        if (items.length !== token.items.length) return;
        let line = start;
        token.items.forEach((item, i) => {
          const a = line;
          line += span(item.raw);
          tag(items[i], a, a + span(item.raw.replace(/\n+$/, '')));
          const rows = item.raw.split('\n');
          const nestedEls = [...items[i].children].filter((c) => /^(UL|OL)$/.test(c.tagName));
          (item.tokens || []).filter((tok) => tok.type === 'list').forEach((sub, n) => {
            const first = sub.raw.split('\n')[0].trim();
            const k = rows.findIndex((row, j) => j > 0 && row.trim() === first);
            if (k > 0 && nestedEls[n]) tagList(nestedEls[n], sub, a + span(rows.slice(0, k).join('\n')) + 1);
          });
        });
      };
      box.querySelectorAll('span[data-mdmark]').forEach((marker) => {
        const info = marks[Number(marker.dataset.mdmark)];
        const el = marker.nextElementSibling;
        marker.remove();
        if (!info || !el || el.matches('span[data-mdmark]')) return;
        tag(el, info.start, info.end);
        if (info.token.type === 'list') tagList(el, info.token, info.start);
        if (info.token.type === 'table' && el.tagName === 'TABLE') {
          el.querySelectorAll(':scope > thead > tr, :scope > tbody > tr').forEach((tr, i) => { const l = i ? info.start + 1 + i : info.start; tag(tr, l, l); });
        }
      });
    }
    box.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (/^(https?:|data:|\/\/)/i.test(src)) return;
      const path = resolveRelPath(mdPath, src);
      if (path && options.imageUrl) img.src = options.imageUrl(path);
      if (!options.pdf) img.loading = 'lazy';
    });
    box.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (options.pdf) { if (!/^(https?:|mailto:)/i.test(href)) a.removeAttribute('href'); return; }
      if (href.startsWith('#')) { a.dataset.anchor = href.slice(1); return; }
      if (/^(https?:|mailto:)/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
      const path = withHashLine(resolveRelPath(mdPath, href), href);
      if (path) { a.dataset.exOpen = path; a.title = shortHome(path); }
      a.removeAttribute('href');
      a.setAttribute('role', 'link');
      a.tabIndex = 0;
    });
    box.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => { h.id = `md-${h.textContent.trim().toLowerCase().replace(/[^\w가-힣]+/g, '-')}`; });
    box.querySelectorAll('pre code').forEach((code) => {
      const lang = (code.className.match(/language-([\w-]+)/) || [])[1];
      const name = LANGS[lang] || lang;
      if (window.hljs && name && window.hljs.getLanguage(name)) {
        try { code.innerHTML = window.hljs.highlight(code.textContent, { language: name, ignoreIllegals: true }).value; code.classList.add('hljs'); } catch (e) { /* noop */ }
      }
    });
    box.querySelectorAll('table').forEach((table) => { const wrapEl = document.createElement('div'); wrapEl.className = 'exv-md-table'; table.replaceWith(wrapEl); wrapEl.appendChild(table); });
    return box.outerHTML;
  }

  function mountViewer(container, options = {}) {
    const tabKey = options.stateKey || TAB_KEY;       // the second group of a split screen stores its own tab list
    const tabState = loadTabState(tabKey);
    let current = null;        // entry of the tab shown right now
    let lastFile = null;       // content of the text file shown right now (for md ↔ code switching)
    let renderSeq = 0;
    let wrap = store.get('wrap', coarse);
    let mdRendered = store.get('md-rendered', true);   // .md is shown rendered by default
    container.classList.add('exv');
    container.innerHTML = `
      <div class="exv-head term-head glass border-0 border-b border-white/10 safe-top-term">
        <div class="flex items-center gap-1.5 px-2 md:px-3 h-14">
          <button type="button" data-act="back" class="term-tool ${options.backAlways ? '' : 'lg:hidden'}" aria-label="${t('뒤로')}"><i class="fas fa-chevron-left"></i></button>
          <span class="exv-icon"></span>
          <div class="min-w-0 flex-1">
            <h3 class="exv-name truncate text-sm font-bold text-white/90">—</h3>
            <button type="button" data-act="copy-path" class="exv-path block max-w-full truncate text-left text-[11px] text-white/40 hover:text-white/70" title="${t('경로 복사')}">—</button>
          </div>
          <div class="exv-zoom hidden"><button type="button" data-act="zoom-out" aria-label="${t('축소')}"><i class="fas fa-minus"></i></button><span class="exv-zoom-label">100%</span><button type="button" data-act="zoom-in" aria-label="${t('확대')}"><i class="fas fa-plus"></i></button></div>
          <button type="button" data-act="edit" class="exv-edit-btn hidden" title="${t('편집 (수정)')}" aria-label="${t('편집')}"><i class="fas fa-pen"></i><span>${t('편집')}</span></button>
          <button type="button" data-act="revert" class="term-tool hidden" title="${t('저장 안 한 변경 버리기')}" aria-label="${t('변경 버리기')}"><i class="fas fa-rotate-left text-xs"></i></button>
          <button type="button" data-act="autosave" class="exv-auto-btn hidden" title="${t('자동 저장 켜기 / 끄기')}" aria-label="${t('자동 저장')}"></button>
          <button type="button" data-act="save" class="exv-save-btn hidden" title="${t('저장 (Ctrl/⌘+S)')}" aria-label="${t('저장')}"><i class="fas fa-floppy-disk"></i><span>${t('저장')}</span></button>
          <button type="button" data-act="md" class="exv-md-toggle hidden" title="${t('미리보기 / 코드 전환')}" aria-label="${t('미리보기 / 코드 전환')}"><i class="fas fa-code"></i><span>${t('코드')}</span></button>
          <button type="button" data-act="mdpdf" class="term-tool hidden" title="${t('PDF 로 저장 · 다운로드 (보이는 모습 그대로 · 모아찍기)')}" aria-label="${t('PDF 로 저장')}"><i class="fas fa-file-pdf text-xs"></i></button>
          <button type="button" data-act="wrap" class="term-tool" title="${t('줄바꿈')}" aria-label="${t('줄바꿈')}"><i class="fas fa-text-width text-xs"></i></button>
          ${options.onInsert ? `<button type="button" data-act="insert" class="term-tool" title="${t('프롬프트에 경로 넣기')}" aria-label="${t('프롬프트에 경로 넣기')}"><i class="fas fa-paper-plane text-xs"></i></button>` : ''}
          <button type="button" data-act="download" class="term-tool" title="${t('다운로드')}" aria-label="${t('다운로드')}"><i class="fas fa-download text-xs"></i></button>
          <button type="button" data-act="reload" class="term-tool hidden sm:flex" title="${t('다시 불러오기')}" aria-label="${t('다시 불러오기')}"><i class="fas fa-rotate-right text-xs"></i></button>
        </div>
        <div class="exv-tabs no-scrollbar" role="tablist" aria-label="${t('열린 파일')}"></div>
      </div>
      <div class="exv-body terminal"></div>
      <div class="exv-pageno hidden"></div>`;
    const $ = (sel) => container.querySelector(sel);
    const bodyEl = $('.exv-body');
    const tabsEl = $('.exv-tabs');
    const pageNo = $('.exv-pageno');
    const find = window.UnivDashFileSearch.mount(container, bodyEl, () => ({ entry: current, editor: editing ? editorEl : null, pdf: pdfInfo }));

    const saveTabs = () => store.set(tabKey, { tabs: tabState.tabs, active: tabState.active, view: tabState.view });
    const viewOf = (path) => { tabState.view[path] = tabState.view[path] || {}; return tabState.view[path]; };
    function pruneViews() {
      const open = new Set(tabState.tabs.map((t) => t.path));
      Object.keys(tabState.view).forEach((path) => { if (!open.has(path)) delete tabState.view[path]; });
    }

    // ── Tab strip ──
    function renderTabs() {
      const names = tabState.tabs.map((item) => item.name);
      tabsEl.innerHTML = tabState.tabs.map((tab) => {
        const dup = names.filter((n) => n === tab.name).length > 1;   // same name: also show the parent folder
        return `<div class="exv-tab ${tab.path === tabState.active ? 'active' : ''}" role="tab" aria-selected="${tab.path === tabState.active}" data-tab="${escapeHtml(tab.path)}" title="${escapeHtml(shortHome(tab.path))}">
            ${iconFor({ ...tab, type: 'file' })}<span class="exv-tab-name">${hasDraft(tab.path) ? `<b class="exv-dirty" title="${t('저장 안 한 변경')}">●</b>` : ''}${escapeHtml(tab.name)}${dup ? `<small>${escapeHtml(basename(dirname(tab.path)))}</small>` : ''}</span>
            <button type="button" class="exv-tab-close" data-close-tab aria-label="${t('{name} 닫기', { name: escapeHtml(tab.name) })}"><i class="fas fa-xmark"></i></button>
          </div>`;
      }).join('');
      tabsEl.classList.toggle('hidden', !tabState.tabs.length || !!options.hideTabs);   // Workspace uses the shared tab bar
      tabsEl.querySelector('.exv-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      options.onTabsChange?.(tabState.tabs.length);
    }
    async function closeTab(path) {
      const index = tabState.tabs.findIndex((t) => t.path === path);
      if (index < 0) return false;
      if (autoSave && current?.path === path && editing) await flushPending();
      if (hasDraft(path)) {
        const ok = await ui().confirmSheet({ title: t('저장 안 한 변경이 있습니다'), message: t('{name} 의 수정 내용을 버리고 닫으시겠습니까?', { name: basename(path) }), confirmLabel: t('버리고 닫기'), danger: true });
        if (!ok) return false;
        clearDraft(path);
      }
      tabState.tabs.splice(index, 1);
      delete tabState.view[path];
      if (tabState.active === path) {
        const next = tabState.tabs[index] || tabState.tabs[index - 1];
        tabState.active = next?.path || null;
        saveTabs();
        renderTabs();
        if (next) show(next);
        else { current = null; bodyEl.innerHTML = ''; options.onClose?.({ reason: 'empty' }); }
        return true;
      }
      saveTabs();
      renderTabs();
      return true;
    }
    // Add a tab without showing it (taking back the other group's tabs when the split is closed)
    function add(entry) {
      if (tabState.tabs.some((t) => t.path === entry.path)) return;
      tabState.tabs.push({ path: entry.path, name: entry.name || basename(entry.path), ext: entry.ext || '' });
      if (!tabState.active) tabState.active = entry.path;
      saveTabs();
      renderTabs();
    }
    // When moving to another group: just drop the tab without asking (unsaved drafts are kept per file, so the receiving side continues them)
    async function forget(path) {
      const index = tabState.tabs.findIndex((t) => t.path === path);
      if (index < 0) return;
      if (current?.path === path && editing) await flushPending();
      tabState.tabs.splice(index, 1);
      delete tabState.view[path];
      if (tabState.active === path) {
        const next = tabState.tabs[index] || tabState.tabs[index - 1];
        tabState.active = next?.path || null;
        saveTabs();
        renderTabs();
        if (next) show(next);
        else { current = null; bodyEl.innerHTML = ''; options.onClose?.({ reason: 'empty' }); }
        return;
      }
      saveTabs();
      renderTabs();
    }
    function closeOthers(path) {
      tabState.tabs = tabState.tabs.filter((t) => t.path === path);
      pruneViews();
      tabState.active = path;
      saveTabs();
      renderTabs();
    }
    tabsEl.addEventListener('click', (event) => {
      const tab = event.target.closest('.exv-tab');
      if (!tab) return;
      if (event.target.closest('[data-close-tab]')) { closeTab(tab.dataset.tab); return; }
      const entry = tabState.tabs.find((t) => t.path === tab.dataset.tab);
      if (entry && entry.path !== tabState.active) { tabState.active = entry.path; saveTabs(); renderTabs(); show(entry); }
    });
    tabsEl.addEventListener('auxclick', (event) => {           // close with a middle click
      const tab = event.target.closest('.exv-tab');
      if (tab && event.button === 1) { event.preventDefault(); closeTab(tab.dataset.tab); }
    });
    tabsEl.addEventListener('contextmenu', (event) => {
      const tab = event.target.closest('.exv-tab');
      if (!tab) return;
      event.preventDefault();
      const path = tab.dataset.tab;
      openMenu({
        title: basename(path), subtitle: shortHome(path), x: event.clientX, y: event.clientY,
        items: [
          { icon: 'fa-xmark', label: t('닫기'), onClick: () => closeTab(path) },
          { icon: 'fa-rectangle-xmark', label: t('다른 탭 모두 닫기'), onClick: () => closeOthers(path) },
          { icon: 'fa-trash-can', label: t('모든 탭 닫기'), onClick: () => closeAll() },
          'sep',
          { icon: 'fa-copy', label: t('경로 복사'), onClick: () => copyText(path, t('경로 복사')) },
        ],
      });
    });

    // Close the tabs of files sent to the trash
    window.addEventListener('univdash:fs-deleted', (event) => {
      const gone = event.detail.path;
      tabState.tabs.filter((t) => t.path === gone || t.path.startsWith(`${gone}/`)).forEach((t) => { clearDraft(t.path); forget(t.path); });
    });
    // When a file or folder is moved or renamed, the open tabs, view state and drafts follow
    window.addEventListener('univdash:fs-moved', (event) => {
      const { from, to } = event.detail;
      const swap = (p) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
      let changed = false;
      tabState.tabs.forEach((tab) => {
        const next = swap(tab.path);
        if (next === tab.path) return;
        changed = true;
        if (tabState.view[tab.path]) { tabState.view[next] = tabState.view[tab.path]; delete tabState.view[tab.path]; }
        const draft = store.get(draftKey(tab.path), null);
        if (draft) { store.set(draftKey(next), draft); clearDraft(tab.path); }
        if (tabState.active === tab.path) tabState.active = next;
        tab.path = next;
        tab.name = basename(next);
      });
      if (!changed) return;
      if (current) { const next = swap(current.path); if (next !== current.path) { current = { ...current, path: next, name: basename(next) }; setHeader(current); } }
      saveTabs();
      renderTabs();
    });

    // ── Save the scroll position (per tab) ──
    let scrollTimer = null;
    bodyEl.addEventListener('scroll', () => {
      if (!current) return;
      updatePageNo();
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (!current) return;
        const view = viewOf(current.path);
        view.top = Math.round(bodyEl.scrollTop);
        view.left = Math.round(bodyEl.scrollLeft);
        view.ratio = bodyEl.scrollHeight > bodyEl.clientHeight ? bodyEl.scrollTop / (bodyEl.scrollHeight - bodyEl.clientHeight) : 0;
        saveTabs();
      }, 150);
    }, { passive: true });
    function restoreScroll(entry) {
      const view = viewOf(entry.path);
      bodyEl.scrollTop = view.top || 0;
      bodyEl.scrollLeft = view.left || 0;
    }

    // ── Code · Markdown ──
    function renderCode(file) {
      const lines = file.content.split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const lang = LANGS[file.ext] || (file.name.toLowerCase() === 'dockerfile' ? 'bash' : file.name.toLowerCase() === 'makefile' ? 'makefile' : null);
      let html;
      if (window.hljs && lang && window.hljs.getLanguage(lang) && file.content.length < 300000) {
        try { html = window.hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value; } catch (e) { html = null; }
      }
      html = html || escapeHtml(lines.join('\n'));
      const gutter = Array.from({ length: lines.length }, (_, i) => i + 1).join('\n');
      return `${file.truncated ? `<div class="exv-note">${t('파일이 커서 앞부분(2MB)만 보여줍니다. 전체는 다운로드하십시오.')}</div>` : ''}
        <div class="exv-code ${wrap ? 'wrap' : ''}"><pre class="exv-gutter" aria-hidden="true">${gutter}</pre><pre class="exv-pre"><code class="hljs">${html}</code></pre></div>`;
    }
    // Markdown preview (marked → cleaned by DOMPurify → relative images and links are wired to Explorer)
    const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);
    const isMarkdown = (entry) => MD_EXT.has((entry.ext || '').toLowerCase());
    // ── Markdown → PDF: the server builds the PDF with the same rendering as the viewer and previews it as page images ──
    const PDF_ZOOMS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
    // N-up: 1 · 2 (landscape paper, left→right) · 4 pages (portrait paper, 2×2) per sheet. For 4 pages the placement order is chosen.
    const PDF_PER = [1, 2, 4];
    const PDF_ORDERS = [
      { id: 'z', label: t('왼쪽에서 오른쪽, 위에서 아래 (Z)'), cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
      { id: 's', label: t('오른쪽에서 왼쪽, 위에서 아래'), cells: [[1, 0], [0, 0], [1, 1], [0, 1]] },
      { id: 'n', label: t('위에서 아래, 왼쪽 열부터'), cells: [[0, 0], [0, 1], [1, 0], [1, 1]] },
      { id: 'rn', label: t('위에서 아래, 오른쪽 열부터'), cells: [[1, 0], [1, 1], [0, 0], [0, 1]] },
    ];
    // Order icon: an arrow passing over the 2×2 cells in 1→4 order
    const orderIcon = (cells) => {
      const pts = cells.map(([c, r]) => [5.5 + c * 11, 5.5 + r * 11]);
      const [x1, y1] = pts[2]; const [x2, y2] = pts[3];
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = [angle + 2.6, angle - 2.6].map((a) => `${(x2 + 4 * Math.cos(a)).toFixed(1)},${(y2 + 4 * Math.sin(a)).toFixed(1)}`);
      return `<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="1" opacity=".35"><rect x=".5" y=".5" width="10" height="10" rx="1.5"/><rect x="11.5" y=".5" width="10" height="10" rx="1.5"/><rect x=".5" y="11.5" width="10" height="10" rx="1.5"/><rect x="11.5" y="11.5" width="10" height="10" rx="1.5"/></g>
        <polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="${head[0]} ${x2},${y2} ${head[1]}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    };
    // Document → PDF (A4) save · download. Zoom applies to text files only (md · code · notebook · table); N-up to every document.
    // When the source is a PDF only the N-up result is saved (name-2up.pdf · name-4up.pdf).
    function mdPdfDialog(entry, { zoomable = true } = {}) {
      const UI = window.UnivDashUI;
      let zoom = store.get('md-pdf-zoom', 1);
      if (!PDF_ZOOMS.includes(zoom)) zoom = 1;
      let per = store.get('md-pdf-per', 1);
      if (!PDF_PER.includes(per)) per = 1;
      let theme = store.get('md-pdf-theme', 'light') === 'dark' ? 'dark' : 'light';   // background (text files only)
      let order = store.get('md-pdf-order', 'z');
      if (!PDF_ORDERS.some((o) => o.id === order)) order = 'z';
      const layout = () => (per === 4 ? `4${order}` : String(per));
      let shown = '';   // layout currently shown in the preview
      let job = null;
      let seq = 0;
      let timer = 0;
      const base = entry.name.replace(/\.[^.]+$/, '') || entry.name;
      const sourcePdf = (entry.ext || '').toLowerCase() === 'pdf';
      const fileName = (want = shown || '1') => (sourcePdf ? `${base}-${want[0]}up.pdf` : `${base}.pdf`);
      const syncActions = () => {
        const el = box();
        if (!el) return;
        const ready = !!job && shown === layout();
        el.querySelectorAll('[data-pdf-act]').forEach((b) => { b.disabled = !ready; });
        const saveBtn = el.querySelector('[data-pdf-act="save"]');
        if (sourcePdf && layout() === '1') saveBtn.disabled = true;   // same as the source
        saveBtn.querySelector('small').textContent = sourcePdf && layout() === '1' ? t('(한 장에 2쪽 이상)') : `(${fileName(layout())})`;
      };
      const box = () => document.querySelector('#sheetBody .mdpdf');
      const pagesEl = () => box()?.querySelector('.mdpdf-pages');
      async function build() {
        const mine = ++seq;
        job = null;
        const el = box();
        if (!el) return;
        el.querySelector('.mdpdf-zoom').textContent = `${Math.round(zoom * 100)}%`;
        el.querySelectorAll('[data-pdf-act]').forEach((b) => { b.disabled = true; });
        el.querySelector('.mdpdf-info').textContent = t('PDF 만드는 중…');
        pagesEl().classList.add('busy');
        try {
          const result = await api('/api/fs/md-pdf', { method: 'POST', body: { path: entry.path, zoom, theme } });
          if (mine !== seq || !box()) return;
          job = result;
          shown = '';
          if (!result.zoomable) box().querySelectorAll('.mdpdf-zoomctl').forEach((e) => e.classList.add('hidden'));
          await showLayout(mine);
        } catch (error) {
          if (mine !== seq || !box()) return;
          pagesEl().innerHTML = `<p class="mdpdf-error"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}</p>`;
          box().querySelector('.mdpdf-info').textContent = '';
        } finally {
          if (mine === seq) pagesEl()?.classList.remove('busy');
        }
      }
      // Apply N-up to the built PDF and preview it (Chrome is not run again)
      async function showLayout(mine = seq) {
        if (!job || !box()) return;
        const want = layout();
        if (want === shown) return;
        const el = box();
        el.querySelectorAll('[data-pdf-act]').forEach((b) => { b.disabled = true; });
        pagesEl().classList.add('busy');
        try {
          const info = want === '1' ? job : await api(`/api/fs/md-pdf/${job.token}/layout?layout=${want}`);
          if (mine !== seq || want !== layout() || !box()) return;
          shown = want;
          const width = Math.min(1600, Math.round((pagesEl().clientWidth - 24) * Math.min(window.devicePixelRatio || 1, 2)));
          pagesEl().innerHTML = Array.from({ length: info.pages }, (_, i) => `<img class="mdpdf-page${want === '2' ? ' landscape' : ''}" alt="${t('{n}장', { n: i + 1 })}" src="/api/fs/md-pdf/${job.token}/page/${i + 1}?w=${width}&layout=${want}" loading="lazy">`).join('');
          box().querySelector('.mdpdf-info').textContent = want === '1'
            ? t('{pages}쪽 · {size}', { pages: info.pages, size: formatSize(info.size) })
            : t('{pages}쪽 → 종이 {sheets}장 · {size}', { pages: job.pages, sheets: info.pages, size: formatSize(info.size) });
          syncActions();
        } catch (error) {
          if (mine !== seq || !box()) return;
          toast(error.message, 'error');
        } finally {
          if (mine === seq) pagesEl()?.classList.remove('busy');
        }
      }
      function syncLayoutButtons() {
        const el = box();
        if (!el) return;
        el.querySelectorAll('[data-per]').forEach((b) => b.classList.toggle('on', Number(b.dataset.per) === per));
        el.querySelectorAll('[data-order]').forEach((b) => b.classList.toggle('on', b.dataset.order === order));
        el.querySelectorAll('[data-theme-pick]').forEach((b) => b.classList.toggle('on', b.dataset.themePick === theme));
        el.querySelector('.mdpdf-order').classList.toggle('hidden', per !== 4);
      }
      async function save(overwrite = false) {
        if (!job) return;
        try {
          const result = await api(`/api/fs/md-pdf/${job.token}/save`, { method: 'POST', body: { path: entry.path, overwrite, layout: shown || '1' } });
          toast(t('저장했습니다:{path}', { path: shortHome(result.path) }), 'success');
          window.dispatchEvent(new CustomEvent('univdash:fs-changed', { detail: { dir: dirname(entry.path) } }));
        } catch (error) {
          if (!overwrite && /이미 있(습니다|어요)|already exists/i.test(error.message)) {
            if (confirm(t('{name} 가 이미 있습니다. 덮어쓰시겠습니까?', { name: fileName() }))) save(true);
            return;
          }
          toast(error.message, 'error');
        }
      }
      UI.infoSheet({
        title: t('PDF 로 저장'),
        subtitle: `${sourcePdf
          ? t('{name} — 한 장에 여러 쪽씩 모아 A4 로 다시 배치합니다.', { name: entry.name })
          : t('{name} — 화면에 보이는 모습 그대로 (A4).', { name: entry.name })} ${zoomable
          ? t('배율 · 한 장에 넣을 쪽 수를 정한 뒤 저장하거나 내려받으십시오.')
          : t('한 장에 넣을 쪽 수를 정한 뒤 저장하거나 내려받으십시오.')}`,
        bodyHtml: `<div class="mdpdf">
            <div class="mdpdf-bar">
              <span class="mdpdf-zoomctl${zoomable ? '' : ' hidden'}">
                <span class="mdpdf-label">${t('배율')}</span>
                <button type="button" data-zoom="-1" aria-label="${t('작게')}"><i class="fas fa-minus"></i></button>
                <span class="mdpdf-zoom">${Math.round(zoom * 100)}%</span>
                <button type="button" data-zoom="1" aria-label="${t('크게')}"><i class="fas fa-plus"></i></button>
              </span>
              <span class="mdpdf-zoomctl${zoomable ? '' : ' hidden'}">
                <span class="mdpdf-label">${t('배경')}</span>
                <div class="mdpdf-seg" role="group" aria-label="${t('배경')}">
                  <button type="button" data-theme-pick="light" aria-label="${t('흰 배경')}">${t('흰색')}</button>
                  <button type="button" data-theme-pick="dark" aria-label="${t('검은 배경')}">${t('검정')}</button>
                </div>
              </span>
              <span class="mdpdf-info"></span>
            </div>
            <div class="mdpdf-bar mdpdf-layout">
              <span class="mdpdf-label">${t('한 장에')}</span>
              <div class="mdpdf-seg" role="group" aria-label="${t('한 장에 넣을 쪽 수')}">
                ${PDF_PER.map((n) => `<button type="button" data-per="${n}" aria-label="${t('한 장에 {n}쪽', { n })}">${t('{n}쪽', { n })}</button>`).join('')}
              </div>
              <div class="mdpdf-order hidden">
                <span class="mdpdf-label">${t('레이아웃 방향')}</span>
                <div class="mdpdf-seg icons" role="group" aria-label="${t('레이아웃 방향')}">
                  ${PDF_ORDERS.map((o) => `<button type="button" data-order="${o.id}" title="${o.label}" aria-label="${o.label}">${orderIcon(o.cells)}</button>`).join('')}
                </div>
              </div>
            </div>
            <div class="mdpdf-pages"></div>
            <div class="mdpdf-actions">
              <button type="button" data-pdf-act="save" class="btn-glow" disabled><i class="fas fa-floppy-disk"></i> ${t('서버에 저장')} <small>(${escapeHtml(fileName(layout()))})</small></button>
              <button type="button" data-pdf-act="download" class="mdpdf-secondary" disabled><i class="fas fa-download"></i> ${t('다운로드')}</button>
            </div>
          </div>`,
        onMount: (body) => {
          body.closest('.tdx-sheet')?.classList.add('wide');
          syncLayoutButtons();
          body.addEventListener('click', (event) => {
            const p = event.target.closest('[data-per]');
            const o = event.target.closest('[data-order]');
            if (p || o) {
              if (p) { per = Number(p.dataset.per); store.set('md-pdf-per', per); }
              if (o) { order = o.dataset.order; store.set('md-pdf-order', order); }
              syncLayoutButtons();
              syncActions();
              showLayout();
              return;
            }
            const t = event.target.closest('[data-theme-pick]');
            if (t && zoomable) {
              if (t.dataset.themePick === theme) return;
              theme = t.dataset.themePick;
              store.set('md-pdf-theme', theme);
              syncLayoutButtons();
              clearTimeout(timer);
              build();
              return;
            }
            const z = event.target.closest('[data-zoom]');
            if (z && zoomable) {
              const index = PDF_ZOOMS.indexOf(zoom) + Number(z.dataset.zoom);
              if (index < 0 || index >= PDF_ZOOMS.length) return;
              zoom = PDF_ZOOMS[index];
              store.set('md-pdf-zoom', zoom);
              box().querySelector('.mdpdf-zoom').textContent = `${Math.round(zoom * 100)}%`;
              clearTimeout(timer);
              timer = setTimeout(build, 350);   // repeated presses build only once, with the last zoom
              return;
            }
            const act = event.target.closest('[data-pdf-act]')?.dataset.pdfAct;
            if (act === 'save') save();
            else if (act === 'download' && job) {
              const a = document.createElement('a');
              a.href = `/api/fs/md-pdf/${job.token}/download?name=${encodeURIComponent(fileName())}&layout=${shown || '1'}`;
              a.download = fileName();
              document.body.appendChild(a); a.click(); a.remove();
            }
          });
          build();
        },
        onClose: () => { seq += 1; clearTimeout(timer); document.querySelector('.tdx-sheet.wide')?.classList.remove('wide'); },
      });
    }

    function renderMarkdown(file, entry, extra = {}) {
      return renderMarkdownHtml(file.content, entry.path, { imageUrl: (path) => `/api/fs/raw?path=${encodeURIComponent(path)}`, ...extra });
    }
    const metaHtml = (file, extra = '') => `<div class="exv-meta">${t('{size} · {time} 수정', { size: formatSize(file.size), time: formatTime(file.mtime) })}${extra}</div>`;
    // Text that can be shown rendered (rendered by default, switchable to code): Markdown · Jupyter · CSV
    const isHtml = (entry) => ['html', 'htm', 'xhtml'].includes((entry?.ext || '').toLowerCase());
    const htmlRenderable = (entry) => isHtml(entry) && !!(window.DOMPurify && window.CSSStyleSheet && document.adoptedStyleSheets);
    const splitable = (entry) => isMarkdown(entry) || htmlRenderable(entry);   // files that use the live preview on the right while editing
    const renderable = (entry) => isMarkdown(entry) || isHtml(entry) || ['ipynb', 'csv', 'tsv'].includes((entry?.ext || '').toLowerCase());
    function renderRich(file, entry) {
      const ext = (entry.ext || '').toLowerCase();
      if (isMarkdown(entry)) return renderMarkdown(file, entry);
      if (ext === 'ipynb') return renderNotebook(file, entry);
      if (ext === 'csv' || ext === 'tsv') return renderCsv(file, ext === 'tsv' ? '\t' : ',');
      if (htmlRenderable(entry)) return '<div class="exv-htmldoc"></div>';   // filled by mountHtmlDoc after rendering
      return null;
    }
    const openLocal = (path) => {
      const name = basename(path);
      const dot = name.lastIndexOf('.');
      (options.onOpen || open)({ path, name, type: 'file', ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' });
    };
    function renderText(file, entry) {
      const rich = renderable(entry);
      const toggle = $('.exv-md-toggle');
      toggle.classList.toggle('hidden', !rich);
      toggle.innerHTML = mdRendered ? `<i class="fas fa-code"></i><span>${t('코드')}</span>` : `<i class="fas fa-book-open"></i><span>${t('미리보기')}</span>`;
      $('[data-act="wrap"]').classList.toggle('hidden', rich && mdRendered);
      let rendered = null;
      if (rich && mdRendered) { try { rendered = renderRich(file, entry); } catch (e) { rendered = null; } }
      bodyEl.innerHTML = metaHtml(file) + (rendered ? `<div class="exv-rich">${rendered}</div>` : renderCode({ ...file, name: entry.name, ext: file.ext || entry.ext }));
      if (rendered) { sizeRich(); showZoom(); } else $('.exv-zoom').classList.add('hidden');
      const htmlHost = rendered && bodyEl.querySelector('.exv-htmldoc');
      if (htmlHost) mountHtmlDoc(htmlHost, file.content, entry.path, openLocal).then(() => find.refresh()).catch(() => { htmlHost.textContent = t('HTML 을 그리지 못했습니다. 코드 보기로 확인하십시오.'); });
      $('[data-act="mdpdf"]').classList.remove('hidden');   // every text file can go to PDF (md · code · notebook · table · html)
    }

    // Jupyter notebook: markdown cells · code cells (highlighted) · outputs (text · image · error)
    function renderNotebook(file, entry) {
      const nb = JSON.parse(file.content);
      const lang = (nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || 'python').toLowerCase();
      const join = (value) => (Array.isArray(value) ? value.join('') : value || '');
      const highlight = (code, name) => {
        if (window.hljs && window.hljs.getLanguage(name)) { try { return window.hljs.highlight(code, { language: name, ignoreIllegals: true }).value; } catch (e) { /* noop */ } }
        return escapeHtml(code);
      };
      const cells = (nb.cells || []).map((cell) => {
        const source = join(cell.source);
        if (cell.cell_type === 'markdown') {
          return `<div class="nb-cell nb-md">${renderMarkdown({ content: source }, entry) || escapeHtml(source)}</div>`;
        }
        if (cell.cell_type !== 'code') return `<pre class="nb-raw">${escapeHtml(source)}</pre>`;
        const outputs = (cell.outputs || []).map((out) => {
          if (out.output_type === 'stream') return `<pre class="nb-out ${out.name === 'stderr' ? 'err' : ''}">${escapeHtml(join(out.text))}</pre>`;
          if (out.output_type === 'error') return `<pre class="nb-out err">${escapeHtml(`${out.ename}: ${out.evalue}`)}</pre>`;
          const data = out.data || {};
          for (const type of ['image/png', 'image/jpeg', 'image/gif']) {
            if (data[type]) return `<img class="nb-img" src="data:${type};base64,${join(data[type]).replace(/\s/g, '')}" alt="">`;
          }
          if (data['image/svg+xml'] && window.DOMPurify) return `<div class="nb-svg">${window.DOMPurify.sanitize(join(data['image/svg+xml']), { USE_PROFILES: { svg: true } })}</div>`;
          if (data['text/html'] && window.DOMPurify) return `<div class="nb-html">${window.DOMPurify.sanitize(join(data['text/html']), { FORBID_TAGS: ['style', 'script', 'iframe', 'form'] })}</div>`;
          if (data['text/markdown']) return `<div class="nb-md">${renderMarkdown({ content: join(data['text/markdown']) }, entry) || ''}</div>`;
          if (data['text/plain']) return `<pre class="nb-out">${escapeHtml(join(data['text/plain']))}</pre>`;
          return '';
        }).join('');
        const count = cell.execution_count ?? ' ';
        return `<div class="nb-cell nb-code"><div class="nb-prompt">In [${escapeHtml(String(count))}]</div><pre class="nb-src"><code class="hljs">${highlight(source, lang)}</code></pre>${outputs ? `<div class="nb-outputs">${outputs}</div>` : ''}</div>`;
      }).join('');
      return `<div class="nb">${cells || `<p class="exv-empty">${t('빈 노트북입니다.')}</p>`}</div>`;
    }

    // CSV · TSV: table (cells with quotes and line breaks supported, first 2000 rows)
    function renderCsv(file, sep) {
      const rows = [];
      let row = [''];
      let quoted = false;
      const text = file.content;
      for (let i = 0; i < text.length && rows.length < 2001; i++) {
        const ch = text[i];
        if (quoted) {
          if (ch === '"' && text[i + 1] === '"') { row[row.length - 1] += '"'; i++; }
          else if (ch === '"') quoted = false;
          else row[row.length - 1] += ch;
        } else if (ch === '"' && row[row.length - 1] === '') quoted = true;
        else if (ch === sep) row.push('');
        else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i + 1] === '\n') i++;
          rows.push(row); row = [''];
        } else row[row.length - 1] += ch;
      }
      if (row.length > 1 || row[0]) rows.push(row);
      if (!rows.length) return null;
      const [head, ...body] = rows;
      const more = rows.length > 2000 || file.truncated;
      return `<div class="data-wrap"><table class="data-table"><thead><tr><th class="rn">#</th>${head.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${body.slice(0, 2000).map((r, i) => `<tr><td class="rn">${i + 1}</td>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
        ${more ? `<p class="exv-note">${t('앞부분만 보여줍니다. 전체는 코드 보기나 다운로드로 확인하십시오.')}</p>` : ''}</div>`;
    }

    // ── Server previews: hwpx · archive · SQLite · converted image · hex ──
    async function renderPreview(file, entry, seq) {
      const q = `path=${encodeURIComponent(entry.path)}`;
      $('[data-act="wrap"]').classList.add('hidden');
      if (file.preview === 'hwpx') {
        bodyEl.innerHTML = `${metaHtml(file)}<div class="exv-note"><i class="fas fa-circle-notch fa-spin"></i> ${t('한글 문서를 여는 중…')}</div>`;
        const data = await api(`/api/fs/preview/hwpx?${q}`);
        if (seq !== renderSeq) return;
        const safe = window.DOMPurify ? window.DOMPurify.sanitize(data.html, { FORBID_TAGS: ['script', 'iframe', 'form', 'style', 'link'], ADD_DATA_URI_TAGS: ['img'] }) : escapeHtml(data.html);
        bodyEl.innerHTML = `${metaHtml(file, t(' · 한글(hwpx) 미리보기'))}<div class="hwp-doc">${safe}</div>`;
        $('[data-act="mdpdf"]').classList.remove('hidden');
        fitHwp();
        showZoom();
      } else if (file.preview === 'archive') {
        const data = await api(`/api/fs/preview/archive?${q}`);
        if (seq !== renderSeq) return;
        const files = data.entries.filter((e) => !e.dir);
        const total = files.reduce((sum, e) => sum + (e.size || 0), 0);
        const archiveMeta = total
          ? t(' · {format} · 파일 {count}개 · 풀면 {size}', { format: data.format.toUpperCase(), count: files.length, size: formatSize(total) })
          : t(' · {format} · 파일 {count}개', { format: data.format.toUpperCase(), count: files.length });
        bodyEl.innerHTML = `${metaHtml(file, archiveMeta)}
          <div class="data-wrap"><table class="data-table"><thead><tr><th>${t('이름')}</th><th class="num">${t('크기')}</th><th class="num">${t('수정')}</th></tr></thead><tbody>
          ${data.entries.map((e) => `<tr class="${e.dir ? 'dir' : ''}"><td><i class="fas ${e.dir ? 'fa-folder' : 'fa-file'} mr-1.5 opacity-60"></i>${escapeHtml(e.name)}</td><td class="num">${e.dir || e.size == null ? '' : formatSize(e.size)}</td><td class="num">${e.mtime ? formatTime(e.mtime) : ''}</td></tr>`).join('')}
          </tbody></table>${data.truncated ? `<p class="exv-note">${t('항목이 많아 일부만 보여줍니다.')}</p>` : ''}</div>`;
      } else if (file.preview === 'sqlite') {
        const data = await api(`/api/fs/preview/sqlite?${q}`);
        if (seq !== renderSeq) return;
        const view = viewOf(entry.path);
        const pick = (name) => {
          view.table = name;
          saveTabs();
          const table = data.tables.find((item) => item.name === name) || data.tables[0];
          const head = `<div class="db-tabs">${data.tables.map((item) => `<button type="button" data-db-table="${escapeHtml(item.name)}" class="${item === table ? 'on' : ''}">${escapeHtml(item.name)}${typeof item.count === 'number' ? ` <small>${item.count}</small>` : ''}</button>`).join('')}</div>`;
          const body = !table ? `<p class="exv-empty">${t('표가 없습니다.')}</p>` : `<div class="data-wrap"><table class="data-table"><thead><tr>${table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>${table.rows.map((r) => `<tr>${r.map((v) => `<td class="${v === null ? 'null' : ''}">${v === null ? 'NULL' : escapeHtml(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>
            ${typeof table.count === 'number' && table.count > table.rows.length ? `<p class="exv-note">${t('{total}행 중 앞 {shown}행 (읽기 전용)', { total: table.count, shown: table.rows.length })}</p>` : ''}</div>`;
          bodyEl.innerHTML = `${metaHtml(file, t(' · SQLite · 표 {count}개', { count: data.tables.length }))}${head}${body}`;
          bodyEl.querySelectorAll('[data-db-table]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.dbTable)));
        };
        pick(view.table);
      } else if (file.preview === 'image') {
        bodyEl.innerHTML = `${metaHtml(file, t(' · 서버에서 변환'))}<div class="exv-image"><img src="/api/fs/preview/image?${q}&v=${file.mtime}" alt="${escapeHtml(entry.name)}"></div>`;
        bodyEl.querySelector('.exv-image img').addEventListener('load', () => { if (seq === renderSeq) sizeImage(); }, { once: true });
        mountGallery(entry, seq);
        showZoom();
      }
    }
    function fitHwp() {
      const doc = bodyEl.querySelector('.hwp-doc');
      if (!doc) return;
      const widest = Math.max(...[...doc.querySelectorAll('.hwp-page')].map((p) => parseFloat(p.style.width) || 794), 300);
      doc.style.zoom = String(Math.min(1, (bodyEl.clientWidth - 24) / widest) * ((current && viewOf(current.path).zoom) || 1));
    }
    async function renderHex(file, entry, seq) {
      const data = await api(`/api/fs/preview/hex?path=${encodeURIComponent(entry.path)}`);
      if (seq !== renderSeq) return;
      const bytes = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0));
      const lines = [];
      for (let i = 0; i < bytes.length; i += 16) {
        const chunk = bytes.slice(i, i + 16);
        const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
        const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
        lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
      }
      bodyEl.innerHTML = `${metaHtml(file)}<div class="exv-note exv-note-info"><i class="fas fa-circle-info"></i> ${t('텍스트로 볼 수 없는 파일이라 앞부분 {size}을 16진수로 보여줍니다.', { size: formatSize(data.shown) })}
        <button type="button" data-act="download" class="ml-2 underline">${t('다운로드')}</button></div><pre class="exv-hex">${escapeHtml(lines.join('\n'))}</pre>`;
    }

    // ── PDF: the server renders pages as PNG (only visible pages are lazy-loaded) ──
    let pdfInfo = null;
    const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
    const ZOOM_MIN = 0.5;
    const ZOOM_MAX = 4;
    function pdfSize(zoom) {
      const available = Math.max(200, bodyEl.clientWidth - 24);
      const cssWidth = Math.round(Math.min(available, 1000) * zoom);
      return { cssWidth, pixels: Math.min(3200, Math.round(cssWidth * Math.min(window.devicePixelRatio || 1, 2))) };
    }
    const pdfSrc = (path, info, page, pixels) => `/api/fs/pdf/page?path=${encodeURIComponent(path)}&page=${page}&w=${pixels}&v=${info.version}`;
    function renderPdf(entry, info) {
      pdfInfo = info;
      find.refresh();
      const zoom = viewOf(entry.path).zoom || 1;
      setZoomLabel(zoom);
      const { cssWidth, pixels } = pdfSize(zoom);
      const pages = Array.from({ length: info.pages }, (_, i) => {
        const [w, h] = info.sizes[i] || info.sizes[0];
        return `<div class="exv-pdf-page" data-page="${i + 1}" style="width:${cssWidth}px;aspect-ratio:${w} / ${h}"><img src="${pdfSrc(entry.path, info, i + 1, pixels)}" alt="${t('{n} 페이지', { n: i + 1 })}" loading="lazy" decoding="async"></div>`;
      }).join('');
      bodyEl.innerHTML = `${metaHtml(info, t(' · {pages}쪽', { pages: info.pages }))}<div class="exv-pdf">${pages}</div>`;
    }
    // On zoom the pages are not rebuilt, only their width changes. The new-resolution image is swapped in after it has fully loaded, so nothing flickers.
    function resizePdf(zoom) {
      const { cssWidth, pixels } = pdfSize(zoom);
      bodyEl.querySelectorAll('.exv-pdf-page').forEach((page) => {
        page.style.width = `${cssWidth}px`;
        const img = page.querySelector('img');
        const src = pdfSrc(current.path, pdfInfo, page.dataset.page, pixels);
        if (!img || img.getAttribute('src') === src) return;
        if (!img.complete || !img.naturalWidth) { img.src = src; return; }   // page not loaded yet (off screen)
        const next = new Image();
        next.decoding = 'async';
        next.onload = () => { if (img.isConnected) img.src = src; };
        next.src = src;
      });
    }
    function updatePageNo() {
      if (!pdfInfo || !bodyEl.querySelector('.exv-pdf')) { pageNo.classList.add('hidden'); return; }
      const mid = bodyEl.getBoundingClientRect().top + bodyEl.clientHeight / 3;
      let page = 1;
      for (const el of bodyEl.querySelectorAll('.exv-pdf-page')) {
        if (el.getBoundingClientRect().top <= mid) page = Number(el.dataset.page); else break;
      }
      pageNo.textContent = `${page} / ${pdfInfo.pages}`;
      pageNo.classList.remove('hidden');
      clearTimeout(pageNo.timer);
      pageNo.timer = setTimeout(() => pageNo.classList.add('hidden'), 1400);
    }
    // ── Zoom: ± buttons, trackpad pinch (ctrl+wheel on Chrome · Edge · Firefox, gesture events on Safari), two fingers on phones ──
    // Documents (PDF · Office · Hangul) and images only. While the fingers spread it scales right away with transform (smooth),
    // and on release it re-renders at that zoom (PDF at the matching resolution) and adjusts the scroll so the point under the fingers stays put.
    const zoomable = () => bodyEl.querySelector('.exv-pdf, .hwp-doc, .exv-image img, .exv-rich');
    const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    function setZoomLabel(zoom) { $('.exv-zoom-label').textContent = `${Math.round(zoom * 100)}%`; }
    function showZoom() { $('.exv-zoom').classList.remove('hidden'); setZoomLabel((current && viewOf(current.path).zoom) || 1); }
    function applyZoom(zoom) {
      const view = viewOf(current.path);
      view.zoom = zoom;
      saveTabs();
      setZoomLabel(zoom);
      if (pdfInfo && bodyEl.querySelector('.exv-pdf')) resizePdf(zoom);
      else if (bodyEl.querySelector('.hwp-doc')) fitHwp();
      else if (bodyEl.querySelector('.exv-image img')) sizeImage();
      else if (bodyEl.querySelector('.exv-rich')) sizeRich();
    }
    // Markdown · notebook · table: text, images and formulas scale together (CSS zoom also re-flows line breaks)
    function sizeRich() {
      const rich = bodyEl.querySelector('.exv-rich');
      if (rich && current) rich.style.zoom = String((viewOf(current.path).zoom || 1));
    }
    // Zoom around the screen point (cx, cy): the content under that point stays in place
    function zoomAt(zoom, cx, cy) {
      const target = zoomable();
      if (!target || !current) return;
      const before = viewOf(current.path).zoom || 1;
      zoom = clampZoom(zoom);
      if (Math.abs(zoom - before) < 0.005) return;
      const rect = target.getBoundingClientRect();
      const ox = cx - rect.left;
      const oy = cy - rect.top;
      applyZoom(zoom);
      const after = zoomable()?.getBoundingClientRect();
      if (!after) return;
      const k = zoom / before;
      bodyEl.scrollLeft += after.left + ox * k - cx;
      bodyEl.scrollTop += after.top + oy * k - cy;
    }
    function setZoom(delta) {
      if (!current || !zoomable()) return;
      const now = viewOf(current.path).zoom || 1;
      const next = delta > 0 ? ZOOMS.find((z) => z > now + 0.01) : [...ZOOMS].reverse().find((z) => z < now - 0.01);
      if (!next) return;
      const box = bodyEl.getBoundingClientRect();
      zoomAt(next, box.left + box.width / 2, box.top + box.height / 3);
    }
    function sizeImage() {
      const img = bodyEl.querySelector('.exv-image img');
      if (!img || !img.naturalWidth || !current) return;
      const zoom = viewOf(current.path).zoom || 1;
      const wrap = img.closest('.exv-image');
      wrap.classList.toggle('zoomed', zoom !== 1);
      if (zoom === 1) { img.style.width = ''; return; }
      const fit = Math.min(1, (bodyEl.clientWidth - 32) / img.naturalWidth, (window.innerHeight * 0.8) / img.naturalHeight);
      img.style.width = `${Math.round(img.naturalWidth * fit * zoom)}px`;
    }
    // ── Browse the images of the same folder: previous · next buttons at the bottom, swipe left/right on phones, ← → on the keyboard ──
    // Browsing replaces the current tab instead of opening a new one (so tabs do not pile up)
    const GALLERY_EXT = new Set([...IMAGE_EXT, 'heic', 'heif', 'tif', 'tiff']);
    const galleryCache = new Map();   // folder → { at, list }
    let gallery = null;               // { path, list, index }
    async function galleryOf(path) {
      const dir = path.slice(0, path.lastIndexOf('/')) || '/';
      const hit = galleryCache.get(dir);
      if (hit && Date.now() - hit.at < 15000) return hit.list;
      const data = await api(`/api/fs/list?path=${encodeURIComponent(dir)}`);
      const list = (data.entries || [])
        .filter((e) => e.type === 'file' && GALLERY_EXT.has(e.ext) && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }));
      galleryCache.set(dir, { at: Date.now(), list });
      return list;
    }
    async function mountGallery(entry, seq) {
      gallery = null;
      let list;
      try { list = await galleryOf(entry.path); } catch (error) { return; }
      if (seq !== renderSeq || current?.path !== entry.path) return;
      const index = list.findIndex((e) => e.path === entry.path);
      if (index < 0 || list.length < 2) return;
      gallery = { path: entry.path, list, index };
      bodyEl.querySelector('.exv-gallery')?.remove();
      const bar = document.createElement('div');
      bar.className = 'exv-gallery';
      bar.innerHTML = `<button type="button" data-gallery="-1" aria-label="${t('이전 그림')}" ${index ? '' : 'disabled'}><i class="fas fa-chevron-left"></i></button>
        <span>${index + 1} / ${list.length}</span>
        <button type="button" data-gallery="1" aria-label="${t('다음 그림')}" ${index < list.length - 1 ? '' : 'disabled'}><i class="fas fa-chevron-right"></i></button>`;
      bar.addEventListener('click', (event) => {
        const button = event.target.closest('[data-gallery]');
        if (button) galleryGo(Number(button.dataset.gallery));
      });
      bodyEl.appendChild(bar);
    }
    function galleryGo(delta) {
      if (!gallery || !current || gallery.path !== current.path) return false;
      const next = gallery.list[gallery.index + delta];
      if (!next) return false;
      const tab = { path: next.path, name: next.name, ext: next.ext || '' };
      if (!tabState.tabs.some((t) => t.path === tab.path)) {
        const at = tabState.tabs.findIndex((t) => t.path === current.path);
        if (at < 0) tabState.tabs.push(tab);
        else tabState.tabs.splice(at, 1, tab);
        pruneViews();
      }
      tabState.active = tab.path;
      saveTabs();
      renderTabs();
      show(tabState.tabs.find((t) => t.path === tab.path));
      return true;
    }
    // Only while the image is shown fitted to the screen (when zoomed or at actual size, swiping pans the image)
    const galleryFit = () => gallery && current && gallery.path === current.path && !editing
      && (viewOf(current.path).zoom || 1) === 1 && !viewOf(current.path).actual;
    const swipe = { x: 0, y: 0, t: 0, on: false };
    bodyEl.addEventListener('touchstart', (event) => {
      swipe.on = event.touches.length === 1 && !!galleryFit();
      if (!swipe.on) return;
      const t = event.touches[0];
      Object.assign(swipe, { x: t.clientX, y: t.clientY, t: Date.now() });
    }, { passive: true });
    bodyEl.addEventListener('touchmove', (event) => { if (event.touches.length !== 1) swipe.on = false; }, { passive: true });
    bodyEl.addEventListener('touchend', (event) => {
      if (!swipe.on || event.touches.length) return;
      swipe.on = false;
      const t = event.changedTouches[0];
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      if (Date.now() - swipe.t < 700 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) galleryGo(dx < 0 ? 1 : -1);
    });
    const pinch = { target: null, base: 1, zoom: 1, cx: 0, cy: 0, acc: 1, timer: 0, gesture: false, dist: 0 };
    function pinchStart(cx, cy) {
      const target = zoomable();
      if (!target || !current || editing) return false;
      const rect = target.getBoundingClientRect();
      Object.assign(pinch, { target, base: viewOf(current.path).zoom || 1, cx, cy, acc: 1 });
      pinch.zoom = pinch.base;
      target.style.transformOrigin = `${cx - rect.left}px ${cy - rect.top}px`;
      target.style.willChange = 'transform';
      return true;
    }
    function pinchMove(scale) {
      if (!pinch.target) return;
      pinch.zoom = clampZoom(pinch.base * scale);
      pinch.target.style.transform = `scale(${pinch.zoom / pinch.base})`;
      setZoomLabel(pinch.zoom);
    }
    function pinchEnd() {
      const { target, zoom, cx, cy } = pinch;
      if (!target) return;
      pinch.target = null;
      target.style.transform = '';
      target.style.transformOrigin = '';
      target.style.willChange = '';
      zoomAt(zoom, cx, cy);
      setZoomLabel(viewOf(current.path).zoom || 1);
    }
    // Trackpad pinch (Chrome · Edge · Firefox): arrives as a wheel event with ctrlKey. Zooms only the document instead of the browser page.
    bodyEl.addEventListener('wheel', (event) => {
      if (!event.ctrlKey || pinch.gesture || !zoomable()) return;
      event.preventDefault();
      if (!pinch.target && !pinchStart(event.clientX, event.clientY)) return;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      pinch.acc *= Math.exp(-Math.max(-50, Math.min(50, delta)) * 0.01);
      pinchMove(pinch.acc);
      clearTimeout(pinch.timer);
      pinch.timer = setTimeout(pinchEnd, 160);
    }, { passive: false });
    // Safari (Mac trackpad): gesture events
    bodyEl.addEventListener('gesturestart', (event) => {
      if (!zoomable()) return;
      event.preventDefault();
      pinch.gesture = pinchStart(event.clientX, event.clientY);
    }, { passive: false });
    bodyEl.addEventListener('gesturechange', (event) => { if (!pinch.gesture) return; event.preventDefault(); pinchMove(event.scale); }, { passive: false });
    bodyEl.addEventListener('gestureend', (event) => { if (!pinch.gesture) return; event.preventDefault(); pinch.gesture = false; pinchEnd(); }, { passive: false });
    // Phones · tablets: two fingers
    const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    bodyEl.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 2 || !zoomable()) return;
      const [a, b] = event.touches;
      if (pinchStart((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)) pinch.dist = touchDist(event.touches) || 1;
    }, { passive: true });
    bodyEl.addEventListener('touchmove', (event) => {
      if (!pinch.target || event.touches.length !== 2) return;
      event.preventDefault();
      pinchMove(touchDist(event.touches) / pinch.dist);
    }, { passive: false });
    const touchDone = (event) => { if (pinch.target && event.touches.length < 2 && !pinch.gesture) pinchEnd(); };
    bodyEl.addEventListener('touchend', touchDone);
    bodyEl.addEventListener('touchcancel', touchDone);

    // ── Editing ───────────────────────────────────────────────────────
    // Unsaved content is kept per file as a draft in localStorage, so editing continues after visiting another tab or page.
    const draftKey = (path) => `draft:${path}`;
    function hasDraft(path) { return !!store.get(draftKey(path), null); }
    function clearDraft(path) { try { localStorage.removeItem(`univdash-ex-${draftKey(path)}`); } catch (e) { /* noop */ } }
    let editing = false;
    let editorEl = null;
    // Auto-save (on by default): saves 0.8 s after typing stops, and when switching tabs or leaving the page.
    // If something else (an agent, etc.) changed the file after it was opened, it does not overwrite: it stops and asks what to do.
    let autoSave = store.get('auto-save', true);
    let autoTimer = null;
    let draftTimer = null;
    let saving = false;
    let conflictPath = null;
    function writeDraft() {
      clearTimeout(draftTimer);
      draftTimer = null;
      if (!editorEl || !current || !lastFile) return;
      const path = current.path;
      if (editorEl.value === lastFile.content) clearDraft(path);
      else store.set(draftKey(path), { text: editorEl.value, base: store.get(draftKey(path), null)?.base ?? lastFile.mtime_ns });
      renderTabs();
      setEditButtons();
    }
    function scheduleAutoSave(delay = 800) {
      if (!autoSave || !current || conflictPath === current.path) return;
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => { autoTimer = null; save(false, { auto: true }); }, delay);
    }
    // Flush the pending draft and auto-save right away before switching tabs, finishing editing or leaving the page
    async function flushPending({ keepalive = false } = {}) {
      if (draftTimer) writeDraft();
      if (!editing || !current || !hasDraft(current.path)) { clearTimeout(autoTimer); autoTimer = null; return true; }
      if (!autoSave || conflictPath === current.path) return false;
      clearTimeout(autoTimer);
      autoTimer = null;
      return save(false, { auto: true, keepalive });
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPending({ keepalive: true }); });
    window.addEventListener('pagehide', () => flushPending({ keepalive: true }));
    function showConflict() {
      bodyEl.querySelector('.exv-conflict')?.remove();
      if (!current || conflictPath !== current.path) return;
      const bar = document.createElement('div');
      bar.className = 'exv-conflict';
      bar.innerHTML = `<i class="fas fa-triangle-exclamation"></i><span>${t('연 뒤에 다른 곳(에이전트 등)에서 이 파일이 바뀌어 자동 저장을 멈췄습니다. 내 수정은 그대로 남아 있습니다.')}</span>
        <button type="button" data-act="conflict-overwrite">${t('내 것으로 덮어쓰기')}</button><button type="button" data-act="conflict-reload">${t('파일 다시 불러오기')}</button>`;
      bodyEl.querySelector('.exv-meta')?.after(bar);
    }
    const editable = (file) => file && !file.binary && !file.image && !file.pdf && !file.media && !file.truncated && typeof file.content === 'string';
    function indentUnit(text) {
      if (/^\t/m.test(text)) return '\t';
      const sizes = (text.match(/^( +)\S/gm) || []).map((m) => m.length - 1).filter((n) => n > 0);
      return ' '.repeat(sizes.length ? Math.min(...sizes, 4) : 4);
    }
    function setEditButtons() {
      const can = !!lastFile && editable(lastFile);
      const dirty = !!current && hasDraft(current.path);
      $('.exv-edit-btn').classList.toggle('hidden', !can || editing);
      $('.exv-save-btn').classList.toggle('hidden', !editing);
      $('.exv-save-btn').classList.toggle('dirty', dirty);
      const auto = $('.exv-auto-btn');
      auto.classList.toggle('hidden', !editing);
      auto.classList.toggle('on', autoSave);
      auto.innerHTML = `<i class="fas ${autoSave ? 'fa-bolt' : 'fa-hand'}"></i><span>${autoSave ? t('자동 저장') : t('수동 저장')}</span>`;
      $('.exv-save-btn span').textContent = autoSave && !dirty ? t('저장됨') : t('저장');
      $('[data-act="revert"]').classList.toggle('hidden', !editing || !dirty);
      const md = current && renderable(current);
      const toggle = $('.exv-md-toggle');
      toggle.classList.toggle('hidden', !md || (editing && !splitable(current)));
      if (editing) $('[data-act="mdpdf"]').classList.add('hidden');
      toggle.classList.toggle('off', editing && !mdSplit);
      toggle.innerHTML = editing
        ? `<i class="fas fa-table-columns"></i><span>${t('미리보기')}</span>`
        : mdRendered ? `<i class="fas fa-code"></i><span>${t('코드')}</span>` : `<i class="fas fa-book-open"></i><span>${t('미리보기')}</span>`;
      toggle.title = editing ? t('실시간 미리보기 켜기 / 끄기') : t('미리보기 / 코드 전환');
      if (editing) {
        $('.exv-edit-btn').classList.add('hidden');
        $('.exv-done-btn')?.remove();
        const done = document.createElement('button');
        done.type = 'button'; done.dataset.act = 'done'; done.className = 'exv-done-btn'; done.textContent = t('완료');
        $('.exv-save-btn').after(done);
      } else {
        $('.exv-done-btn')?.remove();
      }
    }
    // Markdown editing: like VS Code, editor on the left and live preview on the right (on by default, toggled with the preview button)
    let mdSplit = store.get('md-split', true);
    let splitRatio = store.get('md-split-ratio', 0.5);
    const livePreview = () => editing && mdSplit && current && splitable(current);
    let previewTimer = null;
    let previewHtml = '';
    let previewSeq = 0;
    let previewCss = new Map();   // HTML preview: linked CSS files (cleared when the editor is opened anew)
    function updatePreview() {
      clearTimeout(previewTimer);
      previewTimer = null;
      const pane = bodyEl.querySelector('.exv-live');
      if (!pane || !editorEl || !current) return;
      if (htmlRenderable(current)) {
        const text = editorEl.value;
        if (text === previewHtml) return;
        previewHtml = text;
        let host = pane.querySelector('.exv-htmldoc');
        if (!host) { pane.innerHTML = '<div class="exv-htmldoc"></div>'; host = pane.firstChild; }
        const seq = ++previewSeq;
        const top = pane.scrollTop;
        mountHtmlDoc(host, text, current.path, openLocal, { lines: true, cssCache: previewCss, alive: () => seq === previewSeq && host.isConnected })
          .then(() => { if (seq !== previewSeq) return; anchorCache = null; pane.scrollTop = top; markPreviewCursor(true); find.refresh(); })
          .catch(() => { if (seq === previewSeq) { previewHtml = ''; pane.innerHTML = `<pre class="exv-live-plain">${escapeHtml(text)}</pre>`; } });
        return;
      }
      let html = null;
      try { html = renderMarkdown({ content: editorEl.value }, current, { lines: true }); } catch (e) { html = null; }
      html = html ?? `<pre class="exv-live-plain">${escapeHtml(editorEl.value)}</pre>`;
      if (html === previewHtml) return;
      previewHtml = html;
      const top = pane.scrollTop;
      pane.innerHTML = html;
      anchorCache = null;
      pane.scrollTop = top;
      markPreviewCursor(true);
    }
    // Line of the editor cursor → mark the block rendered from that line in the preview (down to list items and table rows) and scroll to it when it is out of view
    let cursorFrame = 0;
    let cursorLine = -1;
    function markPreviewCursor(rendered = false) {
      cancelAnimationFrame(cursorFrame);
      cursorFrame = requestAnimationFrame(() => {
        const pane = bodyEl.querySelector('.exv-live');
        if (!pane || !editorEl) return;
        if (document.activeElement !== editorEl && cursorLine < 0) return;   // no mark until the cursor has been placed once
        const line = editorEl.value.slice(0, editorEl.selectionStart).split('\n').length - 1;
        if (!rendered && line === cursorLine) return;
        cursorLine = line;
        let best = null;
        let bestSize = Infinity;
        let prev = null;
        let prevEnd = -1;
        const scope = pane.querySelector('.exv-htmldoc')?.shadowRoot || pane;   // HTML documents live inside a Shadow DOM
        const outer = scope !== pane;   // HTML: on the same line prefer the outer element (<p> instead of the <b> inside it)
        scope.querySelectorAll('[data-md-line]').forEach((el) => {
          const a = Number(el.dataset.mdLine);
          const b = Number(el.dataset.mdEnd);
          if (a <= line && line <= b) { if (outer ? b - a < bestSize : b - a <= bestSize) { best = el; bestSize = b - a; } }   // the narrowest one (for md, the inner one on a tie)
          else if (b < line && b > prevEnd) { prev = el; prevEnd = b; }                              // on an empty line, the block right above
        });
        const target = best || prev;
        scope.querySelectorAll('.md-cursor').forEach((el) => { if (el !== target) el.classList.remove('md-cursor'); });
        if (!target) return;
        target.classList.add('md-cursor');
        const box = pane.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        if (rect.top < box.top || rect.bottom > box.bottom) {
          const offset = rect.height > box.height * 0.6 ? 16 : box.height / 3;
          pane.scrollTop += rect.top - box.top - offset;
        }
      });
    }
    document.addEventListener('selectionchange', () => {
      if (!editorEl || document.activeElement !== editorEl) return;
      placeCaretLine();
      if (livePreview()) markPreviewCursor();
    });
    // Scrolling the editor makes the preview follow to the same line.
    // Source line → preview position is interpolated between anchors taken from each block's line range (data-md-line), and it moves only by the scrolled amount
    // so a preview aligned by the cursor mark does not jump away (the difference is reduced little by little while scrolling).
    let anchorCache = null;
    let lineTopCache = null;
    let syncedTop = null;   // editor scrollTop of the last sync
    function previewAnchors(pane) {
      const key = `${pane.clientWidth}:${pane.scrollHeight}`;
      if (anchorCache?.key === key) return anchorCache.list;
      const scope = pane.querySelector('.exv-htmldoc')?.shadowRoot || pane;
      const box = pane.getBoundingClientRect();
      const raw = [];
      let bottom = 0;
      scope.querySelectorAll('[data-md-line]').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect.height && !rect.width) return;   // hidden element
        const y = rect.top - box.top + pane.scrollTop;
        raw.push([Number(el.dataset.mdLine), y]);
        bottom = Math.max(bottom, rect.bottom - box.top + pane.scrollTop);
      });
      raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const list = [[0, 0]];
      for (const [line, y] of raw) {
        const last = list[list.length - 1];
        if (line === last[0]) continue;              // for the same line, keep the topmost one
        if (y >= last[1]) list.push([line, y]);      // drop anchors whose position goes backwards (overlapping blocks)
      }
      list.push([editorEl.value.split('\n').length, Math.max(bottom, list[list.length - 1][1])]);
      anchorCache = { key, list };
      return list;
    }
    // Top y of every editor line (with soft wrap it is measured on a hidden mirror)
    function editorLineTops() {
      const value = editorEl.value;
      const key = `${wrap}:${editorEl.clientWidth}`;
      if (lineTopCache?.key === key && lineTopCache.value === value) return lineTopCache.tops;
      const style = getComputedStyle(editorEl);
      const padTop = parseFloat(style.paddingTop) || 0;
      const lines = value.split('\n');
      let tops;
      if (!wrap) {
        const lh = parseFloat(style.lineHeight) || 20;
        tops = lines.map((_, i) => padTop + i * lh);
      } else {
        const mirror = document.createElement('div');
        mirror.style.cssText = `position:absolute;visibility:hidden;left:-99999px;top:0;box-sizing:border-box;width:${editorEl.clientWidth}px;padding:0 ${style.paddingRight} 0 ${style.paddingLeft};font:${style.font};line-height:${style.lineHeight};tab-size:${style.tabSize};white-space:pre-wrap;overflow-wrap:anywhere;letter-spacing:${style.letterSpacing}`;
        const frag = document.createDocumentFragment();
        for (const line of lines) { const d = document.createElement('div'); d.textContent = line || '\u200b'; frag.appendChild(d); }
        mirror.appendChild(frag);
        document.body.appendChild(mirror);
        tops = Array.from(mirror.children, (d) => padTop + d.offsetTop);
        mirror.remove();
      }
      lineTopCache = { key, value, tops };
      return tops;
    }
    // Editor scrollTop → preview scrollTop
    function mapEditorTop(pane, top) {
      const tops = editorLineTops();
      let lo = 0;
      let hi = tops.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= top) lo = mid; else hi = mid - 1; }
      const next = lo + 1 < tops.length ? tops[lo + 1] : tops[lo] + (parseFloat(getComputedStyle(editorEl).lineHeight) || 20);
      const line = lo + Math.min(1, Math.max(0, (top - tops[lo]) / Math.max(1, next - tops[lo])));   // fractional line
      const anchors = previewAnchors(pane);
      let k = 0;
      while (k + 1 < anchors.length && anchors[k + 1][0] <= line) k++;
      const [l0, y0] = anchors[k];
      const [l1, y1] = anchors[Math.min(k + 1, anchors.length - 1)];
      const y = l1 > l0 ? y0 + ((line - l0) / (l1 - l0)) * (y1 - y0) : y0;
      return Math.max(0, y - 12);
    }
    function syncPreviewScroll(reset = false) {
      const pane = bodyEl.querySelector('.exv-live');
      if (!pane || !editorEl) return;
      const top = editorEl.scrollTop;
      const max = editorEl.scrollHeight - editorEl.clientHeight;
      const paneMax = pane.scrollHeight - pane.clientHeight;
      let target;
      try { target = mapEditorTop(pane, top); } catch (e) { target = max > 0 ? (top / max) * paneMax : 0; }
      if (top <= 0) target = 0;
      if (reset || syncedTop == null || top <= 0 || top >= max - 1) pane.scrollTop = target;
      else {
        const delta = target - mapEditorTop(pane, syncedTop);   // exactly the scrolled amount
        const gap = target - (pane.scrollTop + delta);
        pane.scrollTop += delta + gap * Math.min(0.25, Math.abs(top - syncedTop) / Math.max(1, editorEl.clientHeight));   // the drift is closed slowly
      }
      syncedTop = top;
    }
    // Clicking the preview moves the editor cursor there: the clicked text is searched within the source line range of the clicked block, falling back to the block's first line
    function jumpFromPreview(event) {
      if (!editorEl || event.defaultPrevented || event.button !== 0) return;
      const path = event.composedPath();
      if (path.some((el) => el instanceof Element && el.matches('a, button, input, summary, label, [data-ex-open], [data-anchor]'))) return;
      if (String(window.getSelection?.() || '').length) return;   // leave it alone when text was selected by dragging
      const block = path.find((el) => el instanceof Element && el.dataset?.mdLine != null);
      if (!block) return;
      const value = editorEl.value;
      const lineStart = (n) => {   // start offset of line n (end of the text when there are fewer lines)
        let at = 0;
        for (let i = 0; i < n; i++) { const nl = value.indexOf('\n', at); if (nl < 0) return value.length; at = nl + 1; }
        return at;
      };
      const from = lineStart(Number(block.dataset.mdLine));
      const to = lineStart(Number(block.dataset.mdEnd) + 1);
      let caret = from + (value.slice(from, to).match(/^[ \t]*/)?.[0].length || 0);
      // Character at the clicked point (caretPositionFromPoint first, so it also works inside a Shadow DOM)
      let node = null;
      let offset = 0;
      try {
        const root = block.getRootNode();
        const pos = document.caretPositionFromPoint?.(event.clientX, event.clientY, root instanceof ShadowRoot ? { shadowRoots: [root] } : undefined);
        if (pos) { node = pos.offsetNode; offset = pos.offset; }
        else { const range = document.caretRangeFromPoint?.(event.clientX, event.clientY); if (range) { node = range.startContainer; offset = range.startOffset; } }
      } catch (e) { node = null; }
      if (node?.nodeType === Node.TEXT_NODE && block.contains(node)) {
        const segment = value.slice(from, to);
        const after = node.data.slice(offset, offset + 16).trim();
        const before = node.data.slice(Math.max(0, offset - 16), offset).trim();
        const hits = (needle) => { const out = []; if (!needle) return out; let i = segment.indexOf(needle); while (i >= 0) { out.push(i); i = segment.indexOf(needle, i + 1); } return out; };
        // Search with the text on both sides for the exact spot first, otherwise the text after → the text before
        const ahead = hits(after);
        const behind = hits(before).map((i) => i + before.length);
        const both = ahead.filter((i) => behind.some((j) => j <= i && i - j <= 2));
        const pick = both[0] ?? (ahead.length === 1 ? ahead[0] : null) ?? (behind.length === 1 ? behind[0] : null) ?? ahead[0] ?? behind[0];
        if (pick != null) caret = from + pick;
      }
      const top = editorEl.scrollTop;
      editorEl.focus({ preventScroll: true });
      editorEl.setSelectionRange(caret, caret);
      editorEl.scrollTop = top;
      // Centre the cursor line vertically in the editor (the preview stays where it was clicked)
      const box = caretLineBox();
      if (box) {
        editorEl.scrollTop = Math.max(0, box.top + box.height / 2 - editorEl.clientHeight / 2);
        syncedTop = editorEl.scrollTop;   // this scroll does not move the preview
      }
      placeCaretLine({ flash: true });
      markPreviewCursor();
    }
    // Current-line marker of the editor (a faint band across the line like VS Code, flashing briefly when jumping from the preview)
    function caretLineBox() {
      if (!editorEl) return null;
      const line = editorEl.value.slice(0, editorEl.selectionStart).split('\n').length - 1;
      let tops;
      try { tops = editorLineTops(); } catch (e) { return null; }
      const lh = parseFloat(getComputedStyle(editorEl).lineHeight) || 20;
      const top = tops[line];
      if (top == null) return null;
      const height = line + 1 < tops.length ? Math.max(lh, tops[line + 1] - top) : lh;
      return { top, height };
    }
    let caretFrame = 0;
    let caretFlash = false;   // the flash survives another event calling again within the same frame
    function placeCaretLine({ flash = false } = {}) {
      caretFlash ||= flash;
      cancelAnimationFrame(caretFrame);
      caretFrame = requestAnimationFrame(() => {
        const band = editorEl?.parentElement?.querySelector('.exv-caretline');
        if (!band) return;
        const box = caretLineBox();
        if (!box) { band.hidden = true; return; }
        band.hidden = false;
        band.classList.toggle('focused', document.activeElement === editorEl);
        Object.assign(band.style, { top: `${editorEl.offsetTop + box.top - editorEl.scrollTop}px`, height: `${box.height}px`, left: `${editorEl.offsetLeft}px`, width: `${editorEl.clientWidth}px` });
        if (caretFlash) { caretFlash = false; band.classList.remove('flash'); void band.offsetWidth; band.classList.add('flash'); }
      });
    }
    function bindSplitter() {
      const split = bodyEl.querySelector('.exv-split');
      const bar = split?.querySelector('.exv-split-bar');
      if (!bar) return;
      const apply = () => split.style.setProperty('--split', `${(splitRatio * 100).toFixed(2)}%`);
      apply();
      bar.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        bar.setPointerCapture(event.pointerId);
        const stacked = getComputedStyle(split).flexDirection === 'column';
        const move = (ev) => {
          const rect = split.getBoundingClientRect();
          const ratio = stacked ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
          splitRatio = Math.min(0.8, Math.max(0.2, ratio));
          apply();
        };
        const up = () => {
          bar.removeEventListener('pointermove', move);
          bar.removeEventListener('pointerup', up);
          bar.removeEventListener('pointercancel', up);
          split.classList.remove('dragging');
          store.set('md-split-ratio', splitRatio);
        };
        split.classList.add('dragging');
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
        bar.addEventListener('pointercancel', up);
      });
      bar.addEventListener('dblclick', () => { splitRatio = 0.5; apply(); store.set('md-split-ratio', splitRatio); });
    }
    function renderEditor(text) {
      const lines = text.split('\n').length;
      const editorHtml = `<div class="exv-editor ${wrap ? 'wrap' : ''}"><pre class="exv-gutter" aria-hidden="true"></pre><textarea class="exv-textarea" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="${wrap ? 'soft' : 'off'}" aria-label="${t('{name} 편집', { name: escapeHtml(current.name) })}"></textarea></div>`;
      const live = livePreview();
      $('.exv-zoom').classList.add('hidden');
      bodyEl.innerHTML = metaHtml(lastFile, t(' · 편집 중')) + (live
        ? `<div class="exv-split">${editorHtml}<div class="exv-split-bar" role="separator" aria-orientation="vertical" title="${t('끌어서 크기 조절 · 두 번 눌러 반반')}"></div><div class="exv-live" aria-label="${t('미리보기')}"></div></div>`
        : editorHtml);
      editorEl = bodyEl.querySelector('.exv-textarea');
      editorEl.value = text;
      const band = document.createElement('div');
      band.className = 'exv-caretline'; band.hidden = true; band.setAttribute('aria-hidden', 'true');
      band.addEventListener('animationend', () => band.classList.remove('flash'));
      editorEl.before(band);
      ['focus', 'blur', 'click', 'keyup', 'input'].forEach((type) => editorEl.addEventListener(type, () => placeCaretLine()));
      previewHtml = '';
      previewCss = new Map();
      cursorLine = -1;
      anchorCache = null;
      lineTopCache = null;
      syncedTop = null;
      if (live) {
        bindSplitter();
        updatePreview();
        ['focus', 'click', 'keyup'].forEach((type) => editorEl.addEventListener(type, () => markPreviewCursor()));
        bodyEl.querySelector('.exv-live').addEventListener('click', jumpFromPreview);
      }
      const gutter = bodyEl.querySelector('.exv-gutter');
      let lineCount = 0;
      const syncGutter = () => {
        const count = editorEl.value.split('\n').length;
        if (count !== lineCount) { lineCount = count; gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n'); }
        gutter.style.transform = `translateY(${-editorEl.scrollTop}px)`;
      };
      syncGutter();
      void lines;
      editorEl.addEventListener('input', () => {
        syncGutter();
        clearTimeout(draftTimer);
        draftTimer = setTimeout(writeDraft, 250);
        scheduleAutoSave();
        if (live) { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 120); }
      });
      editorEl.addEventListener('scroll', () => {
        gutter.style.transform = `translateY(${-editorEl.scrollTop}px)`;
        placeCaretLine();
        if (live) syncPreviewScroll();
        viewOf(current.path).editTop = Math.round(editorEl.scrollTop);
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(saveTabs, 200);
      }, { passive: true });
      editorEl.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return; }
        if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          const unit = indentUnit(lastFile.content);
          const { selectionStart: start, selectionEnd: end, value } = editorEl;
          if (start === end && !event.shiftKey) {
            editorEl.setRangeText(unit, start, end, 'end');
          } else {
            // Multi-line selection: indent / Shift+Tab outdent
            const lineStart = value.lastIndexOf('\n', start - 1) + 1;
            const block = value.slice(lineStart, end);
            const changed = event.shiftKey
              ? block.replace(/^(\t| {1,4})/gm, '')
              : block.replace(/^/gm, unit);
            editorEl.setRangeText(changed, lineStart, end, 'select');
          }
          editorEl.dispatchEvent(new Event('input'));
        }
      });
      editorEl.scrollTop = viewOf(current.path).editTop || 0;
      syncGutter();
      if (live) requestAnimationFrame(() => syncPreviewScroll(true));
    }
    function enterEdit({ focus = true } = {}) {
      if (!lastFile || !editable(lastFile)) return;
      editing = true;
      viewOf(current.path).edit = true;
      saveTabs();
      const draft = store.get(draftKey(current.path), null);
      renderEditor(draft ? draft.text : lastFile.content);
      $('[data-act="wrap"]').classList.remove('hidden');
      setEditButtons();
      showConflict();
      if (draft) scheduleAutoSave(300);   // a draft left unsaved last time is saved now
      if (focus && !coarse) editorEl.focus();
    }
    async function exitEdit() {
      if (autoSave && current && hasDraft(current.path) && conflictPath !== current.path) await flushPending();
      if (current && hasDraft(current.path)) {
        const ok = await ui().confirmSheet({ title: t('저장하시겠습니까?'), message: t('{name} 에 저장 안 한 변경이 있습니다.', { name: current.name }), confirmLabel: t('저장하고 닫기') });
        if (!ok) return;
        if (!(await save())) return;
      }
      editing = false;
      editorEl = null;
      if (current) { viewOf(current.path).edit = false; saveTabs(); }
      if (lastFile) renderText(lastFile, current);
      setEditButtons();
    }
    async function save(force = false, { auto = false, keepalive = false } = {}) {
      if (!editing || !editorEl || !current || !lastFile) return false;
      if (saving) {                       // while a save is running, retry after it ends
        if (auto) scheduleAutoSave(400);
        return false;
      }
      if (draftTimer) writeDraft();
      const path = current.path;
      const text = editorEl.value;
      if (auto && !hasDraft(path)) return true;             // nothing changed
      const draft = store.get(draftKey(path), null);
      const base = draft?.base ?? lastFile.mtime_ns;
      const button = $('.exv-save-btn');
      button.disabled = true;
      saving = true;
      try {
        const body = JSON.stringify({ path, content: text, mtime_ns: base, force });
        const response = await fetch('/api/fs/write', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
          keepalive: keepalive && body.length < 60000,       // finish sending even while the page is being left
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 409) {
          if (auto) { conflictPath = path; if (current?.path === path) showConflict(); return false; }
          saving = false;
          const ok = await ui().confirmSheet({ title: t('파일이 바뀌었습니다'), message: t('연 뒤에 다른 곳(에이전트 등)에서 이 파일을 고쳤습니다. 내 내용으로 덮어쓰시겠습니까? 취소하면 편집 내용은 그대로 남습니다.'), confirmLabel: t('덮어쓰기'), danger: true });
          return ok ? save(true) : false;
        }
        if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : t('저장하지 못했습니다.'));
        if (conflictPath === path) conflictPath = null;
        // If more was typed during the save, keep that draft and continue saving against the new base time
        const latest = store.get(draftKey(path), null);
        if (!latest || latest.text === text) clearDraft(path);
        else store.set(draftKey(path), { text: latest.text, base: data.mtime_ns });
        if (current?.path === path) {
          lastFile = { ...lastFile, content: text, size: data.size ?? lastFile.size, mtime: data.mtime ?? lastFile.mtime, mtime_ns: data.mtime_ns };
          bodyEl.querySelector('.exv-conflict')?.remove();
          const meta = bodyEl.querySelector('.exv-meta');
          const time = new Date().toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          if (meta) meta.textContent = auto
            ? t('{size} · 자동 저장됨 {time}', { size: formatSize(lastFile.size), time })
            : t('{size} · 저장함 {time}', { size: formatSize(lastFile.size), time });
          if (editorEl && editorEl.value !== text) scheduleAutoSave();
        }
        renderTabs();
        setEditButtons();
        if (!auto) toast(t('{name} 저장했습니다.', { name: basename(path) }), 'success');
        return true;
      } catch (error) {
        if (auto) {                        // the draft survives a brief network drop, so retry a little later
          const meta = bodyEl.querySelector('.exv-meta');
          if (meta && current?.path === path) meta.textContent = t('자동 저장 실패 — 다시 시도하는 중 ({error})', { error: error.message });
          scheduleAutoSave(4000);
        } else toast(error.message, 'error');
        return false;
      } finally {
        saving = false;
        button.disabled = false;
      }
    }
    async function revert() {
      if (!current || !hasDraft(current.path)) return;
      const ok = await ui().confirmSheet({ title: t('변경 버리기'), message: t('{name} 의 저장 안 한 수정을 모두 버립니다.', { name: current.name }), confirmLabel: t('버리기'), danger: true });
      if (!ok) return;
      clearDraft(current.path);
      renderEditor(lastFile.content);
      renderTabs();
      setEditButtons();
    }

    // ── Showing a tab's content ──
    function setHeader(entry) {
      $('.exv-icon').innerHTML = iconFor({ ...entry, type: 'file' });
      $('.exv-name').textContent = entry.name;
      $('.exv-path').textContent = shortHome(entry.path);
    }
    async function show(entry) {
      if (editing && current && current.path !== entry.path) await flushPending();
      const seq = ++renderSeq;
      current = entry;
      lastFile = null;
      pdfInfo = null;
      editing = false;
      editorEl = null;
      setHeader(entry);
      $('.exv-md-toggle').classList.add('hidden');
      $('[data-act="mdpdf"]').classList.add('hidden');
      $('.exv-zoom').classList.add('hidden');
      $('[data-act="wrap"]').classList.remove('hidden');
      bodyEl.innerHTML = `<div class="exv-note"><i class="fas fa-circle-notch fa-spin"></i> ${t('불러오는 중…')}</div>`;
      try {
        const file = await api(`/api/fs/read?path=${encodeURIComponent(entry.path)}`);
        if (seq !== renderSeq) return;
        const raw = `/api/fs/raw?path=${encodeURIComponent(entry.path)}&v=${file.mtime}`;
        if (file.pdf || file.preview === 'office') {
          $('[data-act="wrap"]').classList.add('hidden');
          if (file.preview === 'office') bodyEl.innerHTML = `${metaHtml(file)}<div class="exv-note"><i class="fas fa-circle-notch fa-spin"></i> ${t('문서를 변환하는 중… (처음 한 번만 몇 초 걸립니다)')}</div>`;
          const info = await api(`/api/fs/pdf/info?path=${encodeURIComponent(entry.path)}`);
          if (seq !== renderSeq) return;
          $('.exv-zoom').classList.remove('hidden');
          $('[data-act="mdpdf"]').classList.remove('hidden');   // N-up · (for Office documents) save as PDF
          renderPdf(entry, info);
        } else if (file.image) {
          $('[data-act="wrap"]').classList.add('hidden');
          bodyEl.innerHTML = `${metaHtml(file)}<div class="exv-image ${viewOf(entry.path).actual ? 'actual' : ''}"><img src="${raw}" alt="${escapeHtml(entry.name)}" title="${t('눌러서 원본 크기 / 화면 맞춤')}"></div>`;
          const img = bodyEl.querySelector('img');
          showZoom();
          img.addEventListener('load', () => { if (seq === renderSeq) { sizeImage(); restoreScroll(entry); } }, { once: true });
          mountGallery(entry, seq);
          img.addEventListener('click', () => {
            const view = viewOf(entry.path);
            if ((view.zoom || 1) !== 1) { view.actual = false; bodyEl.querySelector('.exv-image').classList.remove('actual'); applyZoom(1); return; }   // clicking a zoomed image goes back to fit
            view.actual = !view.actual;
            bodyEl.querySelector('.exv-image').classList.toggle('actual', view.actual);
            saveTabs();
          });
        } else if (file.media) {
          $('[data-act="wrap"]').classList.add('hidden');
          bodyEl.innerHTML = `${metaHtml(file)}<div class="exv-media">${file.media === 'video'
            ? `<video src="${raw}" controls playsinline preload="metadata"></video>`
            : `<i class="fas fa-music text-4xl text-violet-300"></i><audio src="${raw}" controls preload="metadata"></audio>`}</div>`;
        } else if (file.preview) {
          await renderPreview(file, entry, seq);
        } else if (file.binary) {
          await renderHex(file, entry, seq);
        } else {
          lastFile = { ...file, content: file.content || '' };
          // Tabs with a draft or that were being edited, and empty (newly created) files, open straight in the editor
          if (editable(lastFile) && (hasDraft(entry.path) || viewOf(entry.path).edit || !lastFile.content)) enterEdit({ focus: !lastFile.content });
          else renderText(lastFile, entry);
        }
        setEditButtons();
        restoreScroll(entry);
        jumpPending(entry);
      } catch (error) {
        if (seq === renderSeq) bodyEl.innerHTML = `<div class="exv-empty"><i class="fas fa-triangle-exclamation text-2xl text-amber-400"></i><p>${escapeHtml(error.message)}</p></div>`;
      }
    }

    // Open a file: go to its tab when already open, otherwise a new tab to the right of the current one
    // With entry.line (or :58 · #L58 at the end of the path) it jumps to that line and highlights it briefly
    let pendingLine = null;
    function open(entry) {
      const ref = splitLineRef(entry.path);
      if (ref.line) {
        const name = basename(ref.path);
        const dot = name.lastIndexOf('.');
        entry = { ...entry, path: ref.path, name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' };
      }
      const line = Number(entry.line) || ref.line;
      pendingLine = line > 0 ? { path: entry.path, line } : null;
      const tab = { path: entry.path, name: entry.name || basename(entry.path), ext: entry.ext || '' };
      if (!tabState.tabs.some((t) => t.path === tab.path)) {
        const at = tabState.tabs.findIndex((t) => t.path === tabState.active);
        tabState.tabs.splice(at < 0 ? tabState.tabs.length : at + 1, 0, tab);
        while (tabState.tabs.length > MAX_TABS) {
          const drop = tabState.tabs.findIndex((t) => t.path !== tab.path);
          tabState.tabs.splice(drop, 1);
        }
        pruneViews();
      }
      const same = tabState.active === tab.path && current?.path === tab.path;
      tabState.active = tab.path;
      saveTabs();
      renderTabs();
      if (!same) show(tabState.tabs.find((t) => t.path === tab.path));
      else jumpPending(tab);
    }
    function jumpPending(entry) {
      if (!pendingLine || pendingLine.path !== entry.path) return false;
      const { line } = pendingLine;
      pendingLine = null;
      requestAnimationFrame(() => gotoLine(line));
      return true;
    }
    // In the code view · editor, bring line number `line` to the upper third of the screen and highlight it briefly
    function gotoLine(line) {
      if (editorEl) {
        const text = editorEl.value;
        let start = 0;
        for (let i = 1; i < line; i += 1) {
          const next = text.indexOf('\n', start);
          if (next < 0) { start = text.length; break; }
          start = next + 1;
        }
        const end = text.indexOf('\n', start);
        editorEl.setSelectionRange(start, end < 0 ? text.length : end);
        const height = parseFloat(getComputedStyle(editorEl).lineHeight) || 18;
        editorEl.scrollTop = Math.max(0, (line - 1) * height - editorEl.clientHeight / 3);
        if (!coarse) editorEl.focus({ preventScroll: true });
        return;
      }
      const code = bodyEl.querySelector('.exv-pre code');
      if (!code) return;
      // Position of the line's first character (measured from the real character position so it is right in wrapped view too)
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      let remaining = line - 1;
      let node = null;
      let offset = 0;
      while (remaining > 0 && (node = walker.nextNode())) {
        let at = -1;
        while (remaining > 0 && (at = node.data.indexOf('\n', at + 1)) >= 0) remaining -= 1;
        if (!remaining) offset = at + 1;
      }
      if (remaining > 0) return;   // line number beyond the end of the file
      if (!node || offset >= node.length) { node = walker.nextNode() || node || code; offset = 0; }
      const range = document.createRange();
      try { range.setStart(node, Math.min(offset, node.length ?? 0)); range.collapse(true); } catch (e) { return; }
      const rect = range.getClientRects()[0] || range.getBoundingClientRect();
      const box = bodyEl.getBoundingClientRect();
      const height = parseFloat(getComputedStyle(code).lineHeight) || 18;
      const top = rect.top - box.top + bodyEl.scrollTop;
      const holder = code.closest('.exv-code');
      const inHolder = holder ? rect.top - holder.getBoundingClientRect().top : 0;   // measured before scrolling
      bodyEl.scrollTop = Math.max(0, top - bodyEl.clientHeight / 3);
      if (!holder) return;
      holder.querySelector('.exv-line-flash')?.remove();
      const flash = document.createElement('div');
      flash.className = 'exv-line-flash';
      flash.style.top = `${inHolder}px`;
      flash.style.height = `${height}px`;
      holder.appendChild(flash);
      setTimeout(() => flash.remove(), 2600);
    }
    // Restore the saved tabs (true when there is an open tab)
    function restore() {
      renderTabs();
      const active = tabState.tabs.find((t) => t.path === tabState.active);
      if (active) show(active);
      return !!active;
    }
    function closeAll() {
      tabState.tabs = [];
      tabState.active = null;
      tabState.view = {};
      saveTabs();
      renderTabs();
      current = null;
      bodyEl.innerHTML = '';
      options.onClose?.({ reason: 'empty' });
    }

    container.addEventListener('click', (event) => {
      const link = event.target.closest('.exv-md a[data-ex-open], .exv-md a[data-anchor]');
      if (link) {
        event.preventDefault();
        if (link.dataset.anchor) { bodyEl.querySelector(`#md-${CSS.escape(link.dataset.anchor.toLowerCase())}`)?.scrollIntoView({ behavior: 'smooth' }); return; }
        openLocal(link.dataset.exOpen);
        return;
      }
      const button = event.target.closest('[data-act]');
      if (!button) return;
      const act = button.dataset.act;
      if (act === 'back') options.onClose?.();
      else if (!current) return;
      else if (act === 'copy-path') copyText(current.path, t('경로 복사'));
      else if (act === 'insert') options.onInsert?.(current.path);
      else if (act === 'download') window.location.href = `/api/fs/raw?download=1&path=${encodeURIComponent(current.path)}`;
      else if (act === 'reload') show(current);
      else if (act === 'edit') enterEdit();
      else if (act === 'save') save();
      else if (act === 'autosave') {
        autoSave = !autoSave;
        store.set('auto-save', autoSave);
        setEditButtons();
        toast(autoSave ? t('자동 저장을 켰습니다.') : t('자동 저장을 껐습니다. 저장 버튼이나 Ctrl/⌘+S 로 저장하십시오.'), 'info');
        if (autoSave && current && hasDraft(current.path)) scheduleAutoSave(200);
      } else if (act === 'conflict-overwrite') { conflictPath = null; save(true); }
      else if (act === 'conflict-reload') { conflictPath = null; clearDraft(current.path); viewOf(current.path).edit = true; show(current); }
      else if (act === 'done') exitEdit();
      else if (act === 'revert') revert();
      else if (act === 'mdpdf' && current) mdPdfDialog(current, { zoomable: !!lastFile && !isHtml(current) });
      else if (act === 'zoom-in') setZoom(1);
      else if (act === 'zoom-out') setZoom(-1);
      else if (act === 'md' && editing) {
        mdSplit = !mdSplit;
        store.set('md-split', mdSplit);
        rerenderEditor();
      } else if (act === 'md') {
        mdRendered = !mdRendered;
        store.set('md-rendered', mdRendered);
        if (lastFile) { renderText(lastFile, current); bodyEl.scrollTop = 0; }
      } else if (act === 'wrap') {
        wrap = !wrap;
        store.set('wrap', wrap);
        applyWrap();
      }
    });
    function applyWrap() {
      container.querySelector('.exv-code')?.classList.toggle('wrap', wrap);
      container.querySelector('.exv-editor')?.classList.toggle('wrap', wrap);
      editorEl?.setAttribute('wrap', wrap ? 'soft' : 'off');
    }
    // Re-render the editor keeping its content and cursor (turning the live preview on / off)
    function rerenderEditor() {
      if (!editing || !editorEl) return;
      const text = editorEl.value;
      const { selectionStart, selectionEnd } = editorEl;
      const focused = document.activeElement === editorEl;
      if (draftTimer) writeDraft();
      renderEditor(text);
      editorEl.setSelectionRange(selectionStart, selectionEnd);
      if (focused) editorEl.focus();
      setEditButtons();
      showConflict();
    }
    // Editor settings changed in the Settings window (or another tab) apply to open viewers right away
    window.addEventListener('univdash:settings', () => {
      const next = { auto: store.get('auto-save', true), wrap: store.get('wrap', coarse), split: store.get('md-split', true), rendered: store.get('md-rendered', true) };
      if (next.auto !== autoSave) { autoSave = next.auto; if (autoSave && current && hasDraft(current.path)) scheduleAutoSave(200); }
      if (next.wrap !== wrap) { wrap = next.wrap; applyWrap(); }
      if (next.split !== mdSplit) { mdSplit = next.split; if (editing && current && splitable(current)) rerenderEditor(); }
      if (next.rendered !== mdRendered) { mdRendered = next.rendered; if (!editing && lastFile && current) renderText(lastFile, current); }
      if (current) setEditButtons();
    });
    // When the window size changes, fit the PDF page width again
    let resizeTimer = null;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitHwp();
        if (!pdfInfo || !current || !bodyEl.clientWidth) return;
        const ratio = bodyEl.scrollHeight > bodyEl.clientHeight ? bodyEl.scrollTop / (bodyEl.scrollHeight - bodyEl.clientHeight) : 0;
        renderPdf(current, pdfInfo);
        bodyEl.scrollTop = ratio * (bodyEl.scrollHeight - bodyEl.clientHeight);
      }, 200);
    }).observe(bodyEl);
    // ── Pick up files changed elsewhere (by an agent, etc.) right away ──
    // Only the visible text file has its modification time checked every 1.5 s (the content is read only when it changed).
    // - Viewing: re-render keeping the scroll position.
    // - Editing · no unsaved input: replace the editor content (cursor and scroll kept, preview too).
    // - Editing · unsaved input: merge when different lines were changed. For the same line, show the "file changed" notice.
    let watching = false;
    function replaceEditorText(next) {
      const cur = editorEl.value;
      if (cur === next) return;
      let a = 0;
      while (a < cur.length && a < next.length && cur[a] === next[a]) a += 1;
      let b = 0;
      while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b += 1;
      const top = editorEl.scrollTop;
      const left = editorEl.scrollLeft;
      editorEl.setRangeText(next.slice(a, next.length - b), a, cur.length - b, 'preserve');   // only the changed part → the cursor stays in place
      editorEl.scrollTop = top;
      editorEl.scrollLeft = left;
    }
    function flashMeta(message) {   // message({ size, time }) → the whole translated line
      const meta = bodyEl.querySelector('.exv-meta');
      if (!meta) return;
      const time = new Date().toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      meta.textContent = message({ size: formatSize(lastFile.size), time });
      meta.classList.remove('exv-meta-flash');
      void meta.offsetWidth;
      meta.classList.add('exv-meta-flash');
    }
    async function checkExternal() {
      if (watching || saving || !current || !lastFile || typeof lastFile.content !== 'string' || lastFile.mtime_ns == null) return;
      if (document.hidden || !container.isConnected || !container.getClientRects().length) return;
      if (conflictPath === current.path) return;   // already asking what to do
      const path = current.path;
      const snap = lastFile;
      watching = true;
      try {
        const response = await fetch(`/api/fs/version?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
        if (!response.ok) return;
        const version = await response.json();
        if (version.mtime_ns === snap.mtime_ns || current?.path !== path || lastFile !== snap || saving) return;
        const file = await api(`/api/fs/read?path=${encodeURIComponent(path)}`);
        if (current?.path !== path || lastFile !== snap || saving || typeof file.content !== 'string') return;
        const next = { ...file, content: file.content || '' };
        if (!editing) {
          const top = bodyEl.scrollTop;
          const left = bodyEl.scrollLeft;
          lastFile = next;
          renderText(lastFile, current);
          setEditButtons();
          bodyEl.scrollTop = top;
          bodyEl.scrollLeft = left;
          flashMeta((values) => t('{size} · 다른 곳에서 바뀐 내용 반영 {time}', values));
          return;
        }
        if (!editorEl || !editable(next)) return;
        if (draftTimer) writeDraft();
        const mine = editorEl.value;
        const draft = store.get(draftKey(path), null);
        if (mine === snap.content && !draft) {
          lastFile = next;
          replaceEditorText(next.content);
        } else {
          // Merge only when my draft is based on the file version currently shown
          const merged = (draft?.base ?? snap.mtime_ns) === snap.mtime_ns ? merge3(snap.content, mine, next.content) : null;
          if (merged == null) { conflictPath = path; showConflict(); return; }
          lastFile = next;
          if (merged === next.content) clearDraft(path);
          else store.set(draftKey(path), { text: merged, base: next.mtime_ns });
          replaceEditorText(merged);
        }
        editorEl.dispatchEvent(new Event('input'));   // line numbers · preview · draft · auto-save
        renderTabs();
        setEditButtons();
        flashMeta(mine === snap.content
          ? (values) => t('{size} · 다른 곳에서 바뀐 내용 반영 · 편집 중 {time}', values)
          : (values) => t('{size} · 다른 곳의 수정과 내 수정을 합침 · 편집 중 {time}', values));
      } catch (e) { /* retried at the next check */ } finally { watching = false; }
    }
    setInterval(checkExternal, 1500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkExternal(); });

    // Zoom with the +/- keys (the shared key handling below picks the viewer touched last)
    zoomViewers.push({
      container,
      canZoom: () => !!current && !editing && !!zoomable(),
      step: (delta) => setZoom(delta),
      reset() { const box = bodyEl.getBoundingClientRect(); zoomAt(1, box.left + box.width / 2, box.top + box.height / 3); },
      canGallery: () => !!gallery && !!current && gallery.path === current.path && !editing,
      gallery: (delta) => galleryGo(delta),
    });
    // Ctrl/⌘+W closes the browser window, so it is not intercepted. Alt+W closes the current tab.
    container.addEventListener('keydown', (event) => {
      if (event.altKey && event.key.toLowerCase() === 'w' && current) { event.preventDefault(); closeTab(current.path); }
    });

    return {
      open, restore, closeAll, closeTab, forget, add,
      get current() { return current; },
      get count() { return tabState.tabs.length; },
      get tabs() { return tabState.tabs.map((t) => ({ ...t, dirty: hasDraft(t.path) })); },
      get activePath() { return tabState.active; },
      iconFor: (entry) => iconFor({ ...entry, type: 'file' }),
    };
  }

  // ── 3-way merge (line based): combines what mine · theirs each changed from base. null when the same place was changed differently ──
  function lineMatch(a, b) {
    // Which line of b each line of a pairs with (longest common subsequence). Equal head and tail are cut off first to reduce the work.
    const match = new Array(a.length).fill(-1);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) { match[head] = head; head += 1; }
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
      match[a.length - 1 - tail] = b.length - 1 - tail;
      tail += 1;
    }
    const n = a.length - head - tail;
    const m = b.length - head - tail;
    if (!n || !m) return match;
    if (n * m > 4e6) return null;   // changed too much: do not merge
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] = a[head + i] === b[head + j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) { match[head + i] = head + j; i += 1; j += 1; } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i += 1; else j += 1;
    }
    return match;
  }
  function merge3(base, mine, theirs) {
    if (mine === base) return theirs;
    if (theirs === base || theirs === mine) return mine;
    const B = base.split('\n');
    const M = mine.split('\n');
    const T = theirs.split('\n');
    const bm = lineMatch(B, M);
    const bt = lineMatch(B, T);
    if (!bm || !bt) return null;
    const same = (x, y) => x.length === y.length && x.every((line, k) => line === y[k]);
    const out = [];
    let i = 0;
    let j = 0;
    let k = 0;
    for (let x = 0; x <= B.length; x += 1) {
      const end = x === B.length;
      if (!end && (bm[x] < 0 || bt[x] < 0)) continue;   // lines both sides left untouched are the anchors
      const mj = end ? M.length : bm[x];
      const tk = end ? T.length : bt[x];
      const b = B.slice(i, x);
      const m = M.slice(j, mj);
      const t = T.slice(k, tk);
      if (same(m, b)) out.push(...t);
      else if (same(t, b) || same(m, t)) out.push(...m);
      else return null;                                  // the same place was changed differently
      if (!end) out.push(B[x]);
      i = x + 1;
      j = mj + 1;
      k = tk + 1;
    }
    return out.join('\n');
  }

  // ── Viewer zoom shortcuts: + (=) zoom in · - zoom out · 0 original size ──
  // Only while not typing; Ctrl/⌘ combinations (browser page zoom) are left alone.
  // Target: the viewer clicked or focused last, otherwise the viewer visible on screen (just one, even in the Workspace split screen).
  const zoomViewers = [];
  let lastViewer = null;
  const viewerOf = (el) => zoomViewers.find((v) => v.container.contains(el));
  document.addEventListener('pointerdown', (event) => { lastViewer = viewerOf(event.target) || lastViewer; }, true);
  document.addEventListener('focusin', (event) => { lastViewer = viewerOf(event.target) || lastViewer; });
  const visible = (v) => v.container.isConnected && v.container.getClientRects().length > 0 && v.container.offsetParent !== null;
  // Shortcuts (keys.js · default: + / = zoom in · - zoom out · 0 original size)
  const zoomTarget = () => [lastViewer, ...zoomViewers].find((v) => v && visible(v) && v.canZoom());
  [['view.zoomIn', (v) => v.step(1)], ['view.zoomOut', (v) => v.step(-1)], ['view.zoomReset', (v) => v.reset()]].forEach(([id, act]) => {
    window.UnivDashKeys?.register(id, () => { const target = zoomTarget(); if (!target) return false; act(target); return true; }, () => !!zoomTarget());
  });
  // Browse the images of the same folder (default: , previous · . next)
  const galleryTarget = () => [lastViewer, ...zoomViewers].find((v) => v && visible(v) && v.canGallery());
  [['view.prevImage', -1], ['view.nextImage', 1]].forEach(([id, delta]) => {
    window.UnivDashKeys?.register(id, () => { const target = galleryTarget(); return !!target && target.gallery(delta); }, () => !!galleryTarget());
  });

  window.UnivDashExplorer = { mountTree, mountViewer, copyText, loadPrefs, shared, renderMarkdownHtml };

  // ════════════════════════════════════════════════════════════════════════
  // Explorer page (/explorer)
  // ════════════════════════════════════════════════════════════════════════
  if (document.body.dataset.page !== 'explorer') return;
  const desktop = window.matchMedia('(min-width: 1024px)');
  const viewerMount = document.getElementById('viewerMount');
  const viewerEmpty = document.getElementById('viewerEmpty');
  const openChip = document.getElementById('openFilesChip');
  const isOpen = () => document.body.classList.contains('panel-open');

  function showViewerArea(show) {
    viewerEmpty.classList.toggle('hidden', show);
    viewerEmpty.classList.toggle('lg:flex', !show);
    viewerMount.classList.toggle('hidden', !show);
    viewerMount.classList.toggle('flex', show);
  }
  function syncChip() {
    const count = viewer.count;
    openChip.classList.toggle('hidden', !count || desktop.matches || isOpen());
    openChip.querySelector('span').textContent = t('열린 파일 {count}', { count });
  }
  // Phones: the viewer is a slide-in panel (closed with Back). Whether it was open is remembered too.
  function openPanel() {
    showViewerArea(true);
    if (!desktop.matches && !isOpen()) {
      document.body.classList.add('panel-open');
      history.pushState({ exFile: 1 }, '');
    }
    store.set('panel-open', true);
    syncChip();
  }
  function closePanel(fromPopstate = false) {
    if (!desktop.matches && isOpen() && !fromPopstate && history.state?.exFile) { history.back(); return; }
    document.body.classList.remove('panel-open');
    store.set('panel-open', false);
    if (!viewer.count) showViewerArea(false);
    syncChip();
  }
  const viewer = mountViewer(viewerMount, {
    onClose: () => closePanel(),
    onTabsChange: () => { if (!viewer?.count) showViewerArea(false); syncChip(); tree?.follow(viewer?.activePath || null); },
  });
  const explorerTreePane = document.getElementById('explorerTreePane');
  const explorerResize = document.querySelector('[data-explorer-resize]');
  const explorerDesktop = window.matchMedia('(min-width: 1024px)');
  const explorerDefaultWidth = () => window.innerWidth >= 1280 ? 400 : 360;
  const applyExplorerWidth = (width, persist = false) => {
    const max = Math.max(260, Math.min(640, window.innerWidth - 480));
    const clamped = Math.round(Math.max(240, Math.min(max, width)));
    explorerTreePane.style.width = `${clamped}px`;
    explorerTreePane.style.flexBasis = `${clamped}px`;
    if (persist) store.set('explorer-tree-width', clamped);
  };
  if (explorerDesktop.matches) {
    const savedWidth = store.get('explorer-tree-width', null);
    if (Number.isFinite(savedWidth)) applyExplorerWidth(savedWidth);
  }
  explorerDesktop.addEventListener('change', ({ matches }) => {
    if (matches) {
      const savedWidth = store.get('explorer-tree-width', null);
      if (Number.isFinite(savedWidth)) applyExplorerWidth(savedWidth);
    } else {
      explorerTreePane.style.removeProperty('width');
      explorerTreePane.style.removeProperty('flex-basis');
    }
  });
  explorerResize?.addEventListener('pointerdown', (event) => {
    if (!explorerDesktop.matches || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerTreePane.getBoundingClientRect().width;
    explorerResize.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('ex-resizing-pane');
    const move = (pointer) => applyExplorerWidth(startWidth + pointer.clientX - startX);
    const end = (pointer) => {
      move(pointer);
      store.set('explorer-tree-width', Math.round(explorerTreePane.getBoundingClientRect().width));
      document.documentElement.classList.remove('ex-resizing-pane');
      explorerResize.removeEventListener('pointermove', move);
      explorerResize.removeEventListener('pointerup', end);
      explorerResize.removeEventListener('pointercancel', end);
    };
    explorerResize.addEventListener('pointermove', move);
    explorerResize.addEventListener('pointerup', end);
    explorerResize.addEventListener('pointercancel', end);
  });
  explorerResize?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !explorerDesktop.matches) return;
    event.preventDefault();
    applyExplorerWidth(explorerTreePane.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 16 : -16), true);
  });
  // The folder tree selection follows the file tab currently shown
  const tree = mountTree(document.getElementById('explorerTree'), {
    onReady: () => { if (viewer.activePath) tree?.follow(viewer.activePath); },
    initialReveal: new URLSearchParams(location.search).get('path'),
    showWidthReset: true,
    onWidthReset() { applyExplorerWidth(explorerDefaultWidth(), true); },
    onOpen(entry) { openPanel(); viewer.open(entry); },
  });
  window.addEventListener('popstate', () => { if (isOpen()) closePanel(true); });
  // Shortcuts (keys.js · default: w close the current file tab · 1~9 Nth tab · ←/→ previous/next tab)
  const keys = window.UnivDashKeys;
  const tabIndex = () => viewer.tabs.findIndex((t) => t.path === viewer.activePath);
  const goTab = (tab) => { if (tab && tab.path !== viewer.activePath) { openPanel(); viewer.open(tab); } };
  keys?.register('tab.close', () => {
    if (!viewer.current) return false;
    viewer.closeTab(viewer.current.path);
    return true;
  });
  [1, 2, 3, 4, 5, 6, 7, 8, 9].forEach((n) => keys?.register(`tab.${n}`, () => {
    if (!viewer.tabs[n - 1]) return false;
    goTab(viewer.tabs[n - 1]);
    return true;
  }));
  [['tab.next', 1], ['tab.prev', -1]].forEach(([id, step]) => keys?.register(id, () => {
    const tabs = viewer.tabs;
    if (tabs.length < 2) return false;
    const index = tabIndex();
    goTab(tabs[((index < 0 ? 0 : index + step) + tabs.length) % tabs.length]);
    return true;
  }));
  openChip.addEventListener('click', () => { openPanel(); });
  desktop.addEventListener('change', () => { document.body.classList.toggle('panel-open', false); showViewerArea(viewer.count > 0); syncChip(); });

  // Restore: with open tabs, desktop shows them right away; phones reopen the viewer if it was open when leaving
  if (viewer.count) {
    showViewerArea(true);
    if (!desktop.matches && store.get('panel-open', false)) openPanel();
    viewer.restore();
  }
  syncChip();
})();
