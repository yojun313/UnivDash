// Explorer: VS Code 탐색기처럼 서버의 폴더 · 파일을 보고 관리한다.
// - UnivDashExplorer.mountTree(container, options)   폴더 트리 (Explorer 페이지 · Workspace [파일] 탭 공용)
// - UnivDashExplorer.mountViewer(container, options) 파일 뷰어 (코드 강조 · 이미지 · 다운로드)
// 설정(고정 폴더 · 가린 항목 · 폴더별 순서 · 정렬 · 숨김 파일)은 서버에 저장되어 휴대폰 · PC 가 같이 쓴다.
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

  // ── 공용 상태 (한 페이지에 트리가 하나뿐이지만 설정 · 클립보드는 공유) ─────────────
  const shared = { prefs: null, roots: [], home: '', clipboard: null, loading: null };
  const SORTS = {
    name: { label: '이름 (폴더 먼저)', icon: 'fa-arrow-down-a-z', desc: 'VS Code 기본' },
    mixed: { label: '이름 (섞어서)', icon: 'fa-shuffle', desc: '폴더와 파일을 이름순으로 함께' },
    type: { label: '종류', icon: 'fa-shapes', desc: '확장자별로 묶어서' },
    modified: { label: '수정한 날짜', icon: 'fa-clock', desc: '최근에 바꾼 것 먼저' },
    size: { label: '크기', icon: 'fa-weight-hanging', desc: '큰 파일 먼저' },
    manual: { label: '직접 지정', icon: 'fa-hand-pointer', desc: '끌어서(휴대폰은 길게 눌러) 순서 변경' },
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
      api('/api/fs/prefs', { method: 'PUT', body: shared.prefs }).catch((error) => toast(`Explorer 설정 저장 실패: ${error.message}`, 'error'));
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
    return date.toLocaleString('ko-KR', today ? { hour: '2-digit', minute: '2-digit' } : { year: '2-digit', month: 'numeric', day: 'numeric' });
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

  async function copyText(text, label = '복사했습니다') {
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
      if (!ok) { toast('복사하지 못했습니다.', 'error'); return; }
    }
    toast(`${label}: ${text}`, 'success');
  }

  // ── 메뉴: 데스크톱은 커서 옆 팝업, 휴대폰은 하단 시트 ─────────────────────────────
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
  // 트리
  // ════════════════════════════════════════════════════════════════════════
  function mountTree(container, options = {}) {
    const cache = new Map();          // 폴더 경로 → entries
    const pending = new Map();
    let expanded = new Set(store.get('expanded', []));
    let root = store.get('root', null);
    let selected = store.get('selected', null);
    let picked = new Set(selected ? [selected] : []);
    let pendingScroll = store.get('tree-scroll', 0);   // 처음 그릴 때 지난번 스크롤 위치로
    let sortables = [];
    let searchSeq = 0;

    container.classList.add('ex');
    container.setAttribute('data-explorer', '');
    container.innerHTML = `
      <div class="ex-head">
        <button type="button" class="ex-root" data-act="root" title="루트 폴더 바꾸기"><i class="fas fa-folder-tree"></i><span class="ex-root-name">…</span><i class="fas fa-chevron-down text-[9px] opacity-60"></i></button>
        <div class="ex-tools">
          <button type="button" data-act="new-file" title="새 파일" aria-label="새 파일"><i class="fas fa-file-circle-plus"></i></button>
          <button type="button" data-act="new-folder" title="새 폴더" aria-label="새 폴더"><i class="fas fa-folder-plus"></i></button>
          <button type="button" data-act="upload" title="선택한 폴더에 업로드" aria-label="업로드"><i class="fas fa-upload"></i></button>
          ${options.showWidthReset ? '<button type="button" data-act="reset-width" title="폴더 트리 기본 폭으로" aria-label="폴더 트리 기본 폭으로"><i class="fas fa-arrows-left-right-to-line"></i></button>' : ''}
          <button type="button" data-act="refresh" title="새로고침" aria-label="새로고침"><i class="fas fa-rotate-right"></i></button>
          <button type="button" data-act="collapse" title="모두 접기" aria-label="모두 접기"><i class="fas fa-down-left-and-up-right-to-center"></i></button>
          <button type="button" data-act="more" title="보기 · 정렬" aria-label="보기 · 정렬"><i class="fas fa-ellipsis-vertical"></i></button>
        </div>
      </div>
      <label class="ex-search"><i class="fas fa-magnifying-glass"></i><input type="search" placeholder="파일 · 폴더 이름 검색" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="ex-status"></div>
      <div class="ex-body" tabindex="0" aria-label="파일 목록 (Shift 로 여러 개 선택 · Backspace 로 삭제)"><div class="ex-tree" role="tree" aria-multiselectable="true"></div><div class="ex-results hidden"></div><div class="ex-drop-hint hidden"></div></div>
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

    // ── 데이터 ──
    // 같은 폴더를 동시에 여러 번 읽지 않도록 진행 중인 요청(Promise)을 공유한다
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
    // 숨김 파일을 꺼 둬도 .env 는 보이게 (설정 → 파일 · 편집기, 기본 켜짐)
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

    // ── 렌더링 ──
    function rowHtml(entry, depth) {
      const open = entry.type === 'dir' && expanded.has(entry.path);
      const mode = prefs().sort;
      const meta = mode === 'size' && entry.type === 'file' ? formatSize(entry.size) : mode === 'modified' ? formatTime(entry.mtime) : '';
      const cut = shared.clipboard?.mode === 'cut' && shared.clipboard.paths.includes(entry.path);
      const dim = entry.name.startsWith('.') || isGated(entry.path);
      const drag = !coarse ? 'draggable="true"' : '';   // 마우스: 끌어서 폴더로 옮기기 · 분할로 띄우기 · (직접 지정이면) 순서 바꾸기
      return `<div class="ex-row ${picked.has(entry.path) ? 'selected' : ''} ${dim ? 'dim' : ''} ${entry.ignored ? 'ignored' : ''} ${cut ? 'cut' : ''}" ${drag} ${entry.ignored ? 'title=".gitignore 에 의해 무시됨"' : ''} data-path="${escapeHtml(entry.path)}" data-type="${entry.type}" style="padding-left:${6 + depth * 14}px" role="treeitem" ${entry.type === 'dir' ? `aria-expanded="${open}"` : ''}>
          ${entry.type === 'dir' ? `<i class="ex-chev fas fa-chevron-right ${open ? 'open' : ''}"></i>` : '<span class="ex-chev"></span>'}
          ${iconFor(entry, open)}
          <span class="ex-name">${escapeHtml(entry.name)}${entry.link ? ' <i class="fas fa-link text-[9px] opacity-50"></i>' : ''}${isGated(entry.path) ? ' <i class="fas fa-eye-slash text-[9px] opacity-60"></i>' : ''}</span>
          ${meta ? `<span class="ex-meta">${escapeHtml(meta)}</span>` : ''}
          <button type="button" class="ex-more ex-copy" data-act="copy" title="경로 복사" aria-label="${escapeHtml(entry.name)} 경로 복사"><i class="far fa-copy"></i></button>
          <button type="button" class="ex-more" data-act="menu" aria-label="${escapeHtml(entry.name)} 메뉴"><i class="fas fa-ellipsis"></i></button>
        </div>`;
    }
    function dirHtml(dir, depth) {
      const entries = cache.get(dir);
      if (entries === undefined) {
        if (!pending.has(dir)) load(dir).then(render);
        return `<div class="ex-note" style="padding-left:${26 + depth * 14}px"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중</div>`;
      }
      if (entries?.error) return `<div class="ex-note error" style="padding-left:${26 + depth * 14}px">${escapeHtml(entries.error)}</div>`;
      const list = sortEntries(dir, visibleEntries(dir, entries || []));
      if (!list.length) return `<div class="ex-note" style="padding-left:${26 + depth * 14}px">비어 있음</div>`;
      return list.map((entry) => `<div class="ex-node" data-name="${escapeHtml(entry.name)}">${rowHtml(entry, depth)}${entry.type === 'dir' && expanded.has(entry.path)
        ? `<div class="ex-children" data-dir="${escapeHtml(entry.path)}">${dirHtml(entry.path, depth + 1)}</div>` : ''}</div>`).join('');
    }
    function render() {
      if (!prefs() || !root) return;
      const top = body.scrollTop;
      $('.ex-root-name').textContent = basename(root) === '/' ? '/' : basename(root);
      $('.ex-root').title = `${shortHome(root)} — 루트 폴더 바꾸기`;
      treeEl.dataset.dir = root;
      treeEl.innerHTML = dirHtml(root, 0);
      const p = prefs();
      const flags = [SORTS[p.sort]?.label, p.show_dotfiles ? '숨김 파일 표시' : '', p.show_hidden ? '가린 항목 표시' : '', shared.clipboard ? `${shared.clipboard.mode === 'cut' ? '잘라낸' : '복사한'} 항목: ${clipLabel()}` : ''].filter(Boolean);
      statusEl.innerHTML = `<i class="fas fa-location-dot"></i> ${escapeHtml(shortHome(root))}<span class="opacity-60"> · ${escapeHtml(flags.join(' · '))}</span>`;
      body.scrollTop = top;
      if (pendingScroll && !pending.size) { body.scrollTop = pendingScroll; pendingScroll = 0; }
      paintSelection();
      setupSortables();
    }

    // 직접 지정 정렬 (휴대폰): 길게 눌러 끌어서 순서 변경.
    // 마우스는 Sortable 을 쓰지 않는다 — 드래그를 가로채 폴더로 옮기기 · 분할로 띄우기가 안 되므로,
    // 아래 기본 끌어다 놓기 안에서 순서 바꾸기까지 함께 처리한다 (같은 폴더 항목의 위 · 아래 가장자리).
    function setupSortables() {
      sortables.forEach((s) => s.destroy());
      sortables = [];
      if (prefs().sort !== 'manual' || !window.Sortable || !coarse) return;
      [treeEl, ...container.querySelectorAll('.ex-children')].forEach((list) => {
        sortables.push(new window.Sortable(list, {
          draggable: '.ex-node', animation: 150, forceFallback: true, fallbackTolerance: 4,
          delay: 220, delayOnTouchOnly: true, ghostClass: 'sortable-ghost', group: 'ex-tree',
          onEnd: (event) => {
            // 다른 폴더(펼친 폴더 목록)로 끌어 놓으면 → 이동 (확인 후). 화면은 원래대로 되돌린다.
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

    // ── 동작 ──
    function entryAt(path) {
      const entries = cache.get(dirname(path));
      return Array.isArray(entries) ? entries.find((e) => e.path === path) : null;
    }
    async function refresh(dir = null) {
      if (dir) { await load(dir, true); }
      else { cache.clear(); await load(root, true); }
      render();
    }
    // 에이전트/터미널이 브라우저 밖에서 파일을 만들거나 바꾼 경우를 탐지한다.
    // 루트와 펼쳐 둔 폴더만 가볍게 다시 읽고, 실제 목록이 바뀐 경우에만 트리를 다시 그린다.
    async function refreshChangedFolders() {
      if (!root || !prefs() || document.visibilityState !== 'visible'
        || !container.isConnected || !container.getClientRects().length
        || treeEl.classList.contains('hidden')) return;
      const dirs = [...new Set([root, ...expanded].filter((dir) => dir === root || dir.startsWith(`${root}/`)))];
      const before = new Map(dirs.map((dir) => [dir, JSON.stringify(cache.get(dir))]));
      await Promise.all(dirs.map((dir) => load(dir, true)));
      if (dirs.some((dir) => before.get(dir) !== JSON.stringify(cache.get(dir)))) render();
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
    // 선택: selected = 기준(마지막으로 누른 것), picked = 여러 개 선택 (Shift = 범위, Ctrl/⌘ = 하나씩 더하기 · 빼기)
    function paintSelection() {
      container.querySelectorAll('.ex-tree .ex-row').forEach((el) => el.classList.toggle('selected', picked.has(el.dataset.path)));
      body.classList.toggle('root-target', !picked.size);
      body.classList.toggle('multi', picked.size > 1);
      statusEl.querySelector('.ex-multi')?.remove();
      if (picked.size > 1) statusEl.insertAdjacentHTML('afterbegin', `<span class="ex-multi">${picked.size}개 선택 · Backspace 삭제 · Esc 해제</span>`);
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
      picked = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));   // 기준은 그대로 두어 범위를 다시 잡을 수 있게
      paintSelection();
    }
    function toggleSelect(path) {
      if (picked.has(path)) picked.delete(path); else picked.add(path);
      selected = path;
      paintSelection();
    }
    // 여러 개를 한 번에 휴지통으로 (하위 항목이 같이 골라졌으면 상위만)
    async function removeMany(paths) {
      const list = [...new Set(paths)].filter((p) => !paths.some((other) => other !== p && p.startsWith(`${other}/`)));
      if (!list.length) return;
      const names = list.slice(0, 6).map((p) => `· ${basename(p)}`).join('\n') + (list.length > 6 ? `\n외 ${list.length - 6}개` : '');
      const ok = await ui().confirmSheet({
        title: list.length > 1 ? `${list.length}개 항목을 휴지통으로` : '휴지통으로 이동',
        message: `${names}\n\n~/.univdash/trash 로 옮깁니다. 필요하면 거기서 되살릴 수 있어요.`, confirmLabel: '삭제', danger: true,
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
      if (done) toast(`${done}개 항목을 휴지통으로 옮겼습니다.`, 'success');
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
      clearSearch();
      render();
      requestAnimationFrame(() => container.querySelector(`.ex-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' }));
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
    function askName({ title, subtitle, value = '', label = '이름', submitLabel = '확인' }) {
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
              input.setSelectionRange(0, dot > 0 ? dot : value.length);  // VS Code 처럼 확장자 앞까지 선택
            }, 40);
          },
          // 입력 시트가 닫힌 뒤에 넘겨야 다음 시트(확인 창)를 바로 띄워도 같이 닫히지 않는다
          onSubmit(values) { done = true; setTimeout(() => resolve(values.name.trim() || null), 0); },
        });
        const overlay = document.getElementById('sheetOverlay');
        const watch = setInterval(() => { if (overlay.hidden) { clearInterval(watch); if (!done) resolve(null); } }, 300);
      });
    }
    async function create(dir, kind) {
      const name = await askName({ title: kind === 'dir' ? '새 폴더' : '새 파일', subtitle: shortHome(dir), submitLabel: '만들기' });
      if (!name) return;
      const result = await op({ op: kind === 'dir' ? 'mkdir' : 'touch', path: dir, name });
      if (!result) return;
      expanded.add(dir);
      saveExpanded();
      await refresh(dir);
      select(result.path);
      if (kind === 'file') options.onOpen?.({ path: result.path, name, type: 'file', ext: name.split('.').pop().toLowerCase(), size: 0 });
    }
    // 새 폴더: 빈 폴더 만들기 또는 git clone (주소만 넣으면 폴더 이름은 저장소 이름으로)
    function folderSheet(dir, mode = store.get('new-folder-mode', 'empty')) {
      const field = (name, label, placeholder, extra = '') => `<label data-mode-field="${extra}">${label}<input name="${name}" placeholder="${escapeHtml(placeholder)}" maxlength="2000" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`;
      ui().formSheet({
        title: '새 폴더', subtitle: `위치: ${shortHome(dir)}`, submitLabel: '만들기',
        extraHtml: `<div class="seg" role="radiogroup" aria-label="만드는 방법">
            <button type="button" data-folder-mode="empty"><i class="fas fa-folder-plus mr-1"></i>빈 폴더</button>
            <button type="button" data-folder-mode="clone"><i class="fab fa-git-alt mr-1"></i>Git clone</button>
          </div>
          ${field('url', '저장소 주소', 'https://github.com/user/repo.git 또는 git@github.com:user/repo.git', 'clone')}
          ${field('name', '폴더 이름', '새 폴더', 'both')}
          ${field('branch', '브랜치 (선택)', '비우면 기본 브랜치', 'clone')}
          <label data-mode-field="clone" class="check-row"><input type="checkbox" name="shallow"> 최근 기록만 받기 (--depth 1, 빠름)</label>
          <p data-mode-field="clone" class="text-[11px] opacity-60 leading-5">비공개 저장소는 서버에 SSH 키(또는 git 자격 증명)가 설정되어 있어야 합니다. 비밀번호는 묻지 않아요.</p>`,
        onMount(sheet) {
          const nameInput = sheet.querySelector('input[name="name"]');
          const urlInput = sheet.querySelector('input[name="url"]');
          const submit = sheet.querySelector('[type="submit"]');
          const apply = (next) => {
            mode = next;
            store.set('new-folder-mode', mode);
            sheet.querySelectorAll('[data-folder-mode]').forEach((b) => b.classList.toggle('on', b.dataset.folderMode === mode));
            sheet.querySelectorAll('[data-mode-field]').forEach((el) => el.classList.toggle('hidden', !(el.dataset.modeField === 'both' || el.dataset.modeField === mode)));
            nameInput.placeholder = mode === 'clone' ? '비우면 저장소 이름' : '새 폴더';
            submit.textContent = mode === 'clone' ? 'Clone' : '만들기';
            setTimeout(() => (mode === 'clone' ? urlInput : nameInput).focus(), 30);
          };
          sheet.querySelectorAll('[data-folder-mode]').forEach((b) => b.addEventListener('click', () => apply(b.dataset.folderMode)));
          urlInput.addEventListener('input', () => {
            const guess = urlInput.value.trim().replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '');
            nameInput.placeholder = guess || '비우면 저장소 이름';
          });
          apply(mode);
        },
        async onSubmit(values, sheet) {
          if (mode === 'empty') {
            const name = (values.name || '').trim();
            if (!name) throw new Error('폴더 이름을 적어 주세요.');
            const result = await api('/api/fs/op', { method: 'POST', body: { op: 'mkdir', path: dir, name } });
            await afterCreate(dir, result.path);
            return false;
          }
          const submit = sheet.querySelector('[type="submit"]');
          submit.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-1"></i>Clone 중…';
          try {
            const result = await api('/api/fs/clone', { method: 'POST', body: { url: (values.url || '').trim(), parent: dir, name: (values.name || '').trim(), branch: (values.branch || '').trim(), depth: values.shallow ? 1 : 0 } });
            toast(`${result.name} 을(를) 받았습니다.`, 'success');
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
      const name = await askName({ title: '이름 바꾸기', subtitle: shortHome(entry.path), value: entry.name, submitLabel: '바꾸기' });
      if (!name || name === entry.name) return;
      const result = await op({ op: 'rename', path: entry.path, name });
      if (!result) return;
      if (expanded.delete(entry.path)) expanded.add(result.path);
      window.dispatchEvent(new CustomEvent('univdash:fs-moved', { detail: { from: entry.path, to: result.path } }));
      await refresh(dirname(entry.path));
      select(result.path);
    }
    async function remove(entry) { await removeMany([entry.path]); }
    // 복사 · 잘라내기 (Ctrl/⌘ + C · X → 다른 폴더에서 Ctrl/⌘ + V). 서버 안에서 복사 · 이동한다.
    // 하위 항목이 같이 골라졌으면 상위만. 탐색기 창끼리 같은 클립보드를 쓴다.
    function clipLabel() {
      const paths = shared.clipboard?.paths || [];
      return paths.length > 1 ? `${basename(paths[0])} 외 ${paths.length - 1}개` : basename(paths[0] || '');
    }
    function setClip(mode, paths) {
      const list = [...new Set(paths.filter(Boolean))];
      const top = list.filter((p) => !list.some((other) => other !== p && p.startsWith(`${other}/`)));
      if (!top.length) return;
      shared.clipboard = { mode, paths: top };
      render();
      toast(`${clipLabel()} ${mode === 'cut' ? '잘라냈어요' : '복사했어요'} · 붙여 넣을 폴더에서 ${isMac ? '⌘' : 'Ctrl'}+V`, 'info');
    }
    const clipTargets = (entry) => (entry && picked.has(entry.path) && picked.size > 1 ? [...picked] : [entry?.path]);
    let pasting = false;
    async function paste(dir) {
      const clip = shared.clipboard;
      if (!clip || pasting) return;
      const move = clip.mode === 'cut';
      pasting = true;
      const slow = setTimeout(() => toast(`${clipLabel()} ${move ? '옮기는' : '복사하는'} 중…`, 'info'), 1200);   // 큰 폴더처럼 오래 걸릴 때만
      const placed = [];
      try {
        for (const path of clip.paths) {
          // 폴더를 복사해서 바로 그 폴더(안)에 붙이면 옆에 사본을 만든다 (자기 안으로 복사는 안 되니까)
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
      if (move) shared.clipboard = null;   // 잘라내기는 한 번만, 복사는 여러 번 붙일 수 있게
      if (placed.length) toast(placed.length > 1 ? `${placed.length}개 항목을 ${move ? '옮겼어요' : '복사했어요'}.` : `${basename(placed[0])} ${move ? '옮겼어요' : '복사했어요'}.`, 'success');
      expanded.add(dir);
      saveExpanded();
      for (const d of new Set(placed.map(dirname))) await refresh(d);
      if (!placed.length) { render(); return; }
      select(placed[placed.length - 1]);
      if (placed.length > 1) { picked = new Set(placed); paintSelection(); }
    }
    // ── 옮기기 (끌어서 놓기 · 메뉴) ──
    function canMove(source, dest) {
      if (!source || !dest) return false;
      if (dirname(source) === dest) return false;                        // 같은 폴더
      if (dest === source || dest.startsWith(`${source}/`)) return false;  // 자기 안으로
      return true;
    }
    // 루트 안이면 루트 기준 경로(루트 이름부터), 밖이면 ~ 경로
    const where = (path) => (path === root || path.startsWith(`${root}/`) ? `${basename(root)}${path.slice(root.length)}` : shortHome(path));
    async function moveTo(source, dest, { copy = false } = {}) {
      if (!copy && !canMove(source, dest)) {
        if (dest === source || dest?.startsWith(`${source}/`)) toast('폴더를 자기 안으로 옮길 수 없습니다.', 'error');
        return null;
      }
      const name = basename(source);
      const ok = await ui().confirmSheet({
        title: copy ? '여기로 복사할까요?' : '여기로 옮길까요?',
        message: `${name}\n${where(dirname(source))}  →  ${where(dest)}${copy ? '' : '\n\nCtrl/Alt 를 누른 채 놓으면 복사합니다.'}`,
        confirmLabel: copy ? '복사' : '이동',
      });
      if (!ok) return null;
      const result = await op({ op: copy ? 'copy' : 'move', path: source, dest }, copy ? `${name} 을(를) 복사했습니다.` : `${name} 을(를) 옮겼습니다.`);
      if (!result) return null;
      if (!copy) {
        // 펼쳐 둔 하위 폴더 · 가린 항목 · 직접 지정 순서도 새 경로로
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
    async function moveDialog(entry) {
      const value = await askName({ title: '다른 폴더로 이동', subtitle: `${entry.name} 을(를) 옮길 폴더 경로 (~/ 가능)`, value: shortHome(dirname(entry.path)), label: '대상 폴더', submitLabel: '다음' });
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
      if (!gated) toast(`${entry.name} 을(를) 가렸습니다. ⋮ 메뉴 → 가린 항목 표시로 다시 볼 수 있어요.`, 'info');
    }
    function togglePin(path) {
      const pinned = prefs().pinned;
      prefs().pinned = pinned.includes(path) ? pinned.filter((p) => p !== path) : [...pinned, path];
      savePrefs();
      toast(pinned.includes(path) ? '고정 해제했습니다.' : '루트 목록에 고정했습니다.', 'success');
    }

    // ── 업로드 (버튼 · 드래그앤드롭) ──
    let uploadDir = null;
    const uploadInput = $('.ex-upload');
    const dropHint = $('.ex-drop-hint');
    // items: [{ file, dir, rel }] — rel 은 dir 아래 하위 폴더 경로 (폴더 업로드), 서버가 만들어 준다
    function uploadItems(items, refreshDir, emptyDirs = []) {
      if (!items.length && !emptyDirs.length) return;
      const total = items.length;
      if (total > 300 && !confirm(`파일 ${total}개를 업로드할까요?`)) return;
      const progress = (n) => toast(`${n}/${total}개 업로드 중… (${shortHome(refreshDir)})`, 'info');
      if (total) progress(0);
      let done = 0;
      let failed = 0;
      const finish = async () => {
        for (const { dir, rel } of emptyDirs) {
          try { await api('/api/fs/upload-folder', { method: 'POST', body: { dir, rel, unique: false } }); } catch (e) { /* 빈 폴더는 넘어간다 */ }
        }
        toast(`${done}개 업로드 완료${failed ? ` · ${failed}개 실패` : ''}`, failed ? 'warn' : 'success');
        expanded.add(refreshDir); saveExpanded();
        refresh(refreshDir);
      };
      const next = (index) => {
        if (index >= total) { finish(); return; }
        const { file, dir, rel } = items[index];
        // 큰 파일은 나눠 올리며 진행률을 보여 준다
        const big = file.size > 64 * 1024 * 1024;
        let shown = -1;
        const onProgress = big ? (ratio) => {
          const pct = Math.floor(ratio * 100);
          if (pct >= shown + 10) { shown = pct; toast(`${file.name} 업로드 중… ${pct}%`, 'info', 2500); }
        } : null;
        window.UnivDash.uploadFile(file, { kind: 'fs', dir, rel, onProgress }).promise
          .then(() => { done += 1; })
          .catch((error) => { failed += 1; toast(`${rel ? `${rel}/` : ''}${file.name}: ${error.message}`, 'error'); })
          .finally(() => {
            if (total > 20 && (index + 1) % 20 === 0) progress(index + 1);
            next(index + 1);
          });
      };
      next(0);
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
      toast(`이미지를 ${shortHome(dir)} 에 업로드합니다.`, 'info');
      upload(files, dir);
    });
    // 폴더 업로드: 맨 위 폴더는 새로 만든다 (같은 이름이 있으면 "이름 (2)" — 기존 폴더에 섞이지 않게)
    async function makeTop(dir, name) {
      const made = await api('/api/fs/upload-folder', { method: 'POST', body: { dir, rel: name, unique: true } });
      return made.path;
    }
    // 끌어다 놓은 항목 → 파일 · 빈 폴더 목록 (폴더는 안까지 따라 들어간다)
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
    async function uploadDropped(dataTransfer, dir) {
      // 항목 목록은 drop 이벤트가 끝나면 사라지므로 먼저 모두 꺼내 둔다
      const entries = [...(dataTransfer.items || [])].map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() : null));
      if (!entries.some((e) => e?.isDirectory)) { upload([...dataTransfer.files], dir); return; }
      const files = [...dataTransfer.files];
      toast('폴더를 읽는 중…', 'info');
      const items = [];
      const emptyDirs = [];
      for (const [index, entry] of entries.entries()) {
        if (!entry) continue;
        if (entry.isFile) { items.push({ file: files[index] || await entryFile(entry), dir, rel: '' }); continue; }
        try {
          const out = { files: [], dirs: [] };
          await walk(entry, '', out);
          const top = await makeTop(dir, entry.name);
          const inner = (rel) => rel.split('/').slice(1).join('/');   // 맨 위 폴더 이름을 뺀 나머지
          out.files.forEach(({ file, rel }) => items.push({ file, dir: top, rel: inner(rel) }));
          out.dirs.forEach((rel) => emptyDirs.push({ dir: top, rel: inner(rel) }));
          if (!out.files.length && !out.dirs.length) toast(`${entry.name}: 빈 폴더를 만들었어요.`, 'info');
        } catch (error) { toast(`${entry.name}: ${error.message || '폴더를 읽지 못했어요.'}`, 'error'); }
      }
      uploadItems(items, dir, emptyDirs);
    }
    // 폴더 선택 창으로 올리기 (webkitdirectory: 파일마다 "맨위폴더/하위/파일" 경로가 붙어 온다)
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
    // 파일 목록에 초점이 있을 때만 (터미널 · 입력창의 Backspace 와 섞이지 않게)
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
      } else if (event.key === 'Escape' && picked.size > 1 && !document.querySelector('.ex-menu')) {   // 메뉴를 닫는 Esc 는 선택을 건드리지 않는다
        event.preventDefault();
        select(selected);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        picked = new Set(visiblePaths());
        paintSelection();
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && ['c', 'x'].includes(event.key.toLowerCase())) {
        if (!picked.size || window.getSelection()?.toString()) return;   // 글자를 드래그해 골랐으면 그 글자 복사
        setClip(event.key.toLowerCase() === 'x' ? 'cut' : 'copy', [...picked]);
        // 기본 동작(copy 이벤트)은 막지 않는다 → 아래 copy 처리에서 경로를 텍스트로도 넣는다
      } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v' && shared.clipboard) {
        // 이미지가 든 시스템 클립보드는 paste 이벤트에서 업로드로. paste 이벤트가 안 오는 브라우저(Safari 등)도 붙여넣기 되게
        clearTimeout(pasteTimer);
        const dir = selectedDir();
        pasteTimer = setTimeout(() => paste(dir), 80);
      }
    });
    let pasteTimer = null;
    body.addEventListener('copy', (event) => {
      if (event.target !== body || !shared.clipboard || window.getSelection()?.toString()) return;
      event.clipboardData?.setData('text/plain', shared.clipboard.paths.join('\n'));   // 터미널 등에 붙이면 경로
      event.preventDefault();
    });
    body.addEventListener('cut', (event) => {
      if (event.target !== body || !shared.clipboard || window.getSelection()?.toString()) return;
      event.clipboardData?.setData('text/plain', shared.clipboard.paths.join('\n'));
      event.preventDefault();
    });
    // 좁아서 잘린 이름(…)은 마우스를 올리면 바로 전체 이름을 이름 위에 겹쳐 보여 준다 (VS Code 처럼).
    // 브라우저 기본 툴팁(title)은 뜨는 데 0.5~1초 걸려서 직접 그린다. 안 잘린 이름에는 띄우지 않는다.
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
      nameTip.textContent = basename(row.dataset.path) + (row.classList.contains('ignored') ? '  · .gitignore 에 의해 무시됨' : '');
      const r = name.getBoundingClientRect();
      const style = getComputedStyle(name);
      Object.assign(nameTip.style, { font: style.font, left: '0px', top: `${Math.round(r.top + r.height / 2)}px`, maxWidth: `${window.innerWidth - 16}px` });
      nameTip.hidden = false;
      // 오른쪽 사이드바처럼 오른쪽 공간이 모자라면 왼쪽으로 밀어서 전체 이름이 다 보이게
      const width = nameTip.offsetWidth;
      nameTip.style.left = `${Math.round(Math.max(8, Math.min(r.left - 4, window.innerWidth - width - 8)))}px`;
    });
    container.addEventListener('mouseout', (event) => { if (!event.relatedTarget || !event.relatedTarget.closest?.('.ex-name')) hideNameTip(); });
    body.addEventListener('scroll', hideNameTip, { passive: true });
    container.addEventListener('dragstart', hideNameTip);
    container.addEventListener('pointerdown', hideNameTip);
    // 행을 눌러도 초점이 목록에 남도록 (단축키용)
    body.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('button, input') && document.activeElement !== body) body.focus({ preventScroll: true });
    });
    body.addEventListener('scroll', () => {
      clearTimeout(treeScrollTimer);
      treeScrollTimer = setTimeout(() => { if (!pendingScroll) store.set('tree-scroll', Math.round(body.scrollTop)); }, 200);
    }, { passive: true });
    // 트리 안에서 마우스로 끌어 옮기기 (다른 폴더 위에 놓기 → 확인 → 이동, Ctrl/Alt 는 복사)
    let dragSource = null;
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
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData('application/x-univdash-path', dragSource);
      event.dataTransfer.setData('text/plain', dragSource);   // 프롬프트 입력창에 놓으면 경로가 들어간다
      row.classList.add('dragging');
    });
    container.addEventListener('dragend', () => {
      container.querySelectorAll('.ex-row.dragging').forEach((el) => el.classList.remove('dragging'));
      dragSource = null;
      clearDrop();
    });
    // 순서 직접 지정: 같은 폴더 항목 위에 놓으면 그 앞 · 뒤로 (폴더 줄은 가운데면 폴더 안으로, 위 · 아래 가장자리면 순서)
    function reorderSpot(event) {
      if (prefs().sort !== 'manual' || !dragSource || event.ctrlKey || event.altKey || event.metaKey) return null;
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
        dropHint.innerHTML = '<i class="fas fa-arrows-up-down"></i> 순서 바꾸기';
        dropHint.classList.remove('hidden');
        return;
      }
      const dir = dropDir(event);
      const copy = event.ctrlKey || event.altKey || event.metaKey;
      if (!copy && !canMove(dragSource, dir)) { event.dataTransfer.dropEffect = 'none'; clearDrop(); return; }
      event.preventDefault();
      event.dataTransfer.dropEffect = copy ? 'copy' : 'move';
      if (hoverDir !== dir) {
        clearDrop();
        hoverDir = dir;
        container.querySelector(`.ex-row[data-path="${CSS.escape(dir)}"]`)?.classList.add('drop');
        body.classList.toggle('drop-root', dir === root);
        // 접힌 폴더 위에 잠시 머물면 펼쳐서 더 깊이 넣을 수 있게 (VS Code 처럼)
        if (dir !== root && !expanded.has(dir) && entryAt(dir)?.type === 'dir') {
          hoverTimer = setTimeout(() => { expanded.add(dir); saveExpanded(); render(); hoverDir = null; }, 800);
        }
      }
      dropHint.innerHTML = `<i class="fas ${copy ? 'fa-clone' : 'fa-arrow-right-to-bracket'}"></i> 여기로 ${copy ? '복사' : '이동'}: <b>${escapeHtml(shortHome(dir))}</b>`;
      dropHint.classList.remove('hidden');
    });
    body.addEventListener('drop', (event) => {
      if (!dragSource) return;
      event.preventDefault();
      event.stopPropagation();
      const source = dragSource;
      const spot = reorderSpot(event);
      const dir = dropDir(event);
      const copy = event.ctrlKey || event.altKey || event.metaKey;
      dragSource = null;
      clearDrop();
      if (spot) { reorder(source, spot.row.dataset.path, spot.before); return; }
      moveTo(source, dir, { copy });
    });

    body.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      const dir = dropDir(event);
      container.querySelectorAll('.ex-row.drop').forEach((el) => el.classList.remove('drop'));
      container.querySelector(`.ex-row[data-path="${CSS.escape(dir)}"]`)?.classList.add('drop');
      body.classList.toggle('drop-root', dir === root);
      dropHint.innerHTML = `<i class="fas fa-cloud-arrow-up"></i> 여기에 업로드: <b>${escapeHtml(shortHome(dir))}</b>`;
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

    // 폴더 다운로드: 서버가 zip 을 만든 뒤(너무 크면 여기서 오류 안내) 브라우저가 바로 내려받는다.
    async function downloadFolder(entry, skipIgnored) {
      toast(`${entry.name} 폴더를 압축하는 중…${skipIgnored ? ' (.gitignore 제외)' : ''}`, 'info');
      const made = await op2('/api/fs/zip', { path: entry.path, skip_ignored: skipIgnored });
      if (!made) return;
      toast(`${made.name} (${formatSize(made.size)}) 다운로드를 시작합니다.`, 'success');
      window.location.href = `/api/fs/zip/${encodeURIComponent(made.token)}`;
    }
    async function op2(url, body) {
      try { return await api(url, { method: 'POST', body }); } catch (error) { toast(error.message, 'error'); return null; }
    }

    // ── 속성: 종류 · 크기(폴더는 전체 크기를 서버 du 로 빠르게) · 권한 · 소유자 · 시각 · git ──
    async function showProperties(entry) {
      let info;
      try { info = await api(`/api/fs/stat?path=${encodeURIComponent(entry.path)}`); } catch (error) { toast(error.message, 'error'); return; }
      const isDir = info.type === 'dir';
      const when = (t) => (t ? new Date(t * 1000).toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
      const exact = (n) => `${Number(n).toLocaleString('ko-KR')} 바이트`;
      const row = (label, value, extra = '') => `<div class="prop-row ${extra}"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
      const rows = [
        row('종류', escapeHtml(isDir ? '폴더' : `${info.kind}${entry.ext ? ` (.${entry.ext})` : ''}`)),
        row('위치', `<button type="button" class="prop-copy" data-copy="${escapeHtml(info.path)}" title="경로 복사">${escapeHtml(shortHome(info.path))} <i class="fas fa-copy"></i></button>`),
        info.link ? row('링크 대상', escapeHtml(info.link_target || '')) : '',
        isDir
          ? row('크기', '<span data-du-size><i class="fas fa-circle-notch fa-spin"></i> 계산 중…</span>', 'strong') + row('디스크 사용', '<span data-du-disk>…</span>') + row('안에 든 항목', `<span data-du-items>…</span><span class="opacity-60"> (바로 아래 ${info.children ?? '?'}개 · 폴더 ${info.child_dirs ?? '?'}개)</span>`)
          : row('크기', `${escapeHtml(formatSize(info.size))} <span class="opacity-60">(${exact(info.size)})</span>`, 'strong') + row('디스크 사용', escapeHtml(formatSize(info.disk))),
        row('수정한 날짜', escapeHtml(when(info.mtime))),
        row('마지막으로 연 날짜', escapeHtml(when(info.atime))),
        row('상태 변경', escapeHtml(when(info.ctime))),
        info.birth ? row('만든 날짜', escapeHtml(when(info.birth))) : '',
        row('권한', `<code>${escapeHtml(info.mode)}</code> <span class="opacity-60">(${escapeHtml(info.octal)})</span> · ${[info.readable && '읽기', info.writable && '쓰기', info.executable && '실행'].filter(Boolean).join(' · ') || '접근 불가'}`),
        row('소유자', escapeHtml(`${info.owner} : ${info.group}`)),
        info.git_repo ? row('Git 저장소', `${escapeHtml(shortHome(info.git_repo))}${info.git_ignored ? ' <span class="prop-tag">.gitignore 로 무시됨</span>' : ''}`) : '',
      ].join('');
      ui().infoSheet({
        title: info.name, subtitle: isDir ? '폴더 속성' : '파일 속성',
        bodyHtml: `<dl class="prop-list">${rows}</dl>`,
        async onMount(body) {
          body.querySelector('[data-copy]')?.addEventListener('click', (event) => copyText(event.currentTarget.dataset.copy, '경로 복사'));
          if (!isDir) return;
          try {
            const du = await api(`/api/fs/du?path=${encodeURIComponent(entry.path)}`);
            const set = (sel, html) => { const el = body.querySelector(sel); if (el) el.innerHTML = html; };
            if (du.timed_out) { set('[data-du-size]', '너무 커서 30초 안에 다 세지 못했습니다'); set('[data-du-disk]', '—'); set('[data-du-items]', '—'); return; }
            const note = du.partial ? ' <span class="prop-tag warn">권한 없는 하위 폴더 제외</span>' : '';
            set('[data-du-size]', `${escapeHtml(formatSize(du.size))} <span class="opacity-60">(${exact(du.size)})</span>${note}`);
            set('[data-du-disk]', escapeHtml(formatSize(du.disk)));
            set('[data-du-items]', `${Number(du.items).toLocaleString('ko-KR')}개`);
          } catch (error) {
            const el = body.querySelector('[data-du-size]');
            if (el) el.textContent = `계산 실패: ${error.message}`;
          }
        },
      });
    }

    // ── 메뉴 ──
    function entryMenu(entry, x, y) {
      if (picked.size > 1 && picked.has(entry.path)) {
        const paths = [...picked];
        openMenu({
          title: `${paths.length}개 선택`, x, y,
          items: [
            { icon: 'fa-copy', label: '경로 모두 복사', onClick: () => copyText(paths.join('\n'), `${paths.length}개 경로 복사`) },
            options.onInsert && { icon: 'fa-paper-plane', label: '프롬프트에 경로 모두 넣기', onClick: () => options.onInsert(paths.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')) },
            'sep',
            { icon: 'fa-trash-can', label: `${paths.length}개 삭제 (휴지통으로)`, danger: true, onClick: () => removeMany(paths) },
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
          isDir ? { icon: 'fa-file-circle-plus', label: '새 파일', onClick: () => create(entry.path, 'file') } : { icon: 'fa-eye', label: '열기', onClick: () => options.onOpen?.(entry) },
          isDir && { icon: 'fa-folder-plus', label: '새 폴더 · Git clone', onClick: () => folderSheet(entry.path) },
          isDir && { icon: 'fa-upload', label: '파일 업로드', onClick: () => { uploadDir = entry.path; uploadInput.click(); } },
          isDir && { icon: 'fa-folder-plus', label: '폴더 업로드', onClick: () => { uploadDir = entry.path; uploadDirInput.click(); } },
          isDir && clip && { icon: 'fa-paste', label: '붙여넣기', sub: clipLabel(), onClick: () => paste(entry.path) },
          'sep',
          { icon: 'fa-copy', label: '경로 복사', onClick: () => copyText(entry.path, '경로 복사') },
          { icon: 'fa-code-branch', label: '상대 경로 복사', onClick: () => copyText(relative(entry.path), '상대 경로 복사') },
          { icon: 'fa-font', label: '이름 복사', onClick: () => copyText(entry.name, '이름 복사') },
          options.onInsert && { icon: 'fa-paper-plane', label: '프롬프트에 경로 넣기', onClick: () => options.onInsert(entry.path) },
          !isDir && { icon: 'fa-download', label: '다운로드', onClick: () => { window.location.href = `/api/fs/raw?download=1&path=${encodeURIComponent(entry.path)}`; } },
          isDir && { icon: 'fa-file-zipper', label: '폴더 다운로드 (.zip)', onClick: () => downloadFolder(entry, false) },
          isDir && { icon: 'fa-filter', label: '다운로드 (.gitignore 항목 제외)', sub: 'node_modules · .venv 등 빼고', onClick: () => downloadFolder(entry, true) },
          isDir && { icon: 'fa-terminal', label: '여기서 Terminal 열기', onClick: () => { if (window.UnivDashWs?.newTerminal) window.UnivDashWs.newTerminal(entry.path); else location.href = `/?newterm=1&cwd=${encodeURIComponent(entry.path)}`; } },
          isDir && ui().newSession && { icon: 'fa-layer-group', label: '여기서 새 tmux 세션', onClick: () => ui().newSession(entry.path) },
          isDir && { icon: 'fa-arrow-right-to-bracket', label: '이 폴더를 루트로 보기', onClick: () => setRoot(entry.path) },
          isDir && { icon: 'fa-thumbtack', label: prefs().pinned.includes(entry.path) ? '루트 목록에서 고정 해제' : '루트 목록에 고정', onClick: () => togglePin(entry.path) },
          'sep',
          { icon: 'fa-arrow-right-to-bracket', label: '다른 폴더로 이동…', onClick: () => moveDialog(entry) },
          { icon: 'fa-scissors', label: '잘라내기', sub: `${isMac ? '⌘' : 'Ctrl+'}X`, onClick: () => setClip('cut', clipTargets(entry)) },
          { icon: 'fa-clone', label: '복사', sub: `${isMac ? '⌘' : 'Ctrl+'}C`, onClick: () => setClip('copy', clipTargets(entry)) },
          { icon: 'fa-pen', label: '이름 바꾸기', onClick: () => rename(entry) },
          { icon: isGated(entry.path) ? 'fa-eye' : 'fa-eye-slash', label: isGated(entry.path) ? '다시 보이기' : '가리기', onClick: () => toggleGate(entry) },
          manual && { icon: 'fa-arrow-up', label: '위로 이동', onClick: () => moveInOrder(entry, -1) },
          manual && { icon: 'fa-arrow-down', label: '아래로 이동', onClick: () => moveInOrder(entry, 1) },
          'sep',
          { icon: 'fa-circle-info', label: '속성', onClick: () => showProperties(entry) },
          'sep',
          { icon: 'fa-trash-can', label: '삭제 (휴지통으로)', danger: true, onClick: () => remove(entry) },
        ],
      });
    }
    function sortSheet() {
      const current = prefs().sort;
      ui().actionSheet({
        title: '정렬 기준', subtitle: '모든 폴더에 적용됩니다. 직접 지정은 폴더마다 순서를 기억해요.',
        actions: Object.entries(SORTS).map(([id, s]) => ({ icon: s.icon, label: s.label, desc: s.desc, sub: id === current ? '✓' : '', current: id === current, onClick: () => { prefs().sort = id; savePrefs(); render(); } })),
      });
    }
    function moreMenu(x, y) {
      const p = prefs();
      openMenu({
        title: '보기 · 정렬', x, y,
        items: [
          { icon: 'fa-arrow-down-wide-short', label: '정렬 기준', sub: SORTS[p.sort].label, onClick: sortSheet },
          { icon: p.show_dotfiles ? 'fa-toggle-on' : 'fa-toggle-off', label: '숨김 파일(. 파일) 표시', sub: p.show_dotfiles ? '켜짐' : '꺼짐', onClick: () => { p.show_dotfiles = !p.show_dotfiles; savePrefs(); render(); } },
          { icon: p.show_hidden ? 'fa-toggle-on' : 'fa-toggle-off', label: '가린 항목 표시', sub: `${p.hidden.length}개`, onClick: () => { p.show_hidden = !p.show_hidden; savePrefs(); render(); } },
          'sep',
          { icon: 'fa-upload', label: '루트에 파일 업로드', onClick: () => { uploadDir = root; uploadInput.click(); } },
          { icon: 'fa-folder-plus', label: '루트에 폴더 업로드', onClick: () => { uploadDir = root; uploadDirInput.click(); } },
          shared.clipboard && { icon: 'fa-paste', label: '루트에 붙여넣기', sub: clipLabel(), onClick: () => paste(root) },
          { icon: 'fa-copy', label: '루트 경로 복사', onClick: () => copyText(root, '경로 복사') },
          { icon: 'fa-trash-arrow-up', label: '휴지통 열기', onClick: () => setRoot(`${shared.home}/.univdash/trash`) },
        ],
      });
    }
    function rootMenu(x, y) {
      const pinned = prefs().pinned;
      const candidates = [...new Set([...pinned, ...shared.roots, shared.home])];
      const parent = dirname(root);
      const parentAllowed = root !== '/' && shared.roots.some((r) => parent === r || parent.startsWith(`${r}/`));
      openMenu({
        title: '루트 폴더', subtitle: shortHome(root), x, y,
        items: [
          parentAllowed && { icon: 'fa-arrow-turn-up', label: '상위 폴더로', sub: shortHome(parent), onClick: () => setRoot(parent) },
          ...candidates.map((path) => ({ icon: pinned.includes(path) ? 'fa-thumbtack' : 'fa-house', label: shortHome(path), sub: path === root ? '현재' : '', onClick: () => setRoot(path) })),
          'sep',
          { icon: 'fa-keyboard', label: '경로 입력해서 열기', onClick: async () => {
            const value = await askName({ title: '폴더 열기', subtitle: '~/ 로 시작해도 됩니다.', value: shortHome(root), label: '경로', submitLabel: '열기' });
            if (value) reveal(value.replace(/\/+$/, '') || '/');
          } },
          { icon: 'fa-thumbtack', label: pinned.includes(root) ? '현재 루트 고정 해제' : '현재 루트를 목록에 고정', onClick: () => togglePin(root) },
        ],
      });
    }

    // ── 이벤트 ──
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
        else if (act === 'upload') { uploadDir = selectedDir(); toast(`업로드 위치: ${shortHome(uploadDir)}`, 'info'); uploadInput.click(); }
        else if (act === 'reset-width') options.onWidthReset?.();
        else if (act === 'refresh') refresh().then(() => toast('새로고침했습니다.', 'success'));
        else if (act === 'collapse') { expanded = new Set(); saveExpanded(); render(); }
        else if (act === 'more') moreMenu(x, y);
        return;
      }
      const row = event.target.closest('.ex-row');
      if (!row) {
        // 빈 곳을 누르면 선택 해제 → 새 파일 · 폴더 · 업로드는 루트(~)로
        if (event.target.closest('.ex-body') && !event.target.closest('.ex-results')) select(null);
        return;
      }
      const path = row.dataset.path;
      const entry = entryAt(path) || { path, name: basename(path), type: row.dataset.type, ext: '' };
      body.focus({ preventScroll: true });
      if (event.target.closest('[data-act="copy"]')) {
        copyText(path, '경로 복사');
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
    // 휴대폰: 길게 누르면 메뉴 (직접 지정 정렬일 때는 길게 눌러 끌기라서 ⋯ 버튼으로)
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

    // ── 검색 ──
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
        results.innerHTML = '<div class="ex-note"><i class="fas fa-circle-notch fa-spin"></i> 검색 중…</div>';
        try {
          const data = await api(`/api/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&hidden=${prefs().show_dotfiles ? 1 : 0}&env=${showEnv() ? 1 : 0}`);
          if (seq !== searchSeq) return;
          results.innerHTML = data.results.length ? data.results.map((entry) => `
            <div class="ex-row ex-result" data-path="${escapeHtml(entry.path)}" data-type="${entry.type}">
              ${iconFor(entry)}<span class="ex-name">${escapeHtml(entry.name)}<span class="ex-result-path">${escapeHtml(dirname(relative(entry.path)) === '.' ? '' : dirname(relative(entry.path)))}</span></span>
              <button type="button" class="ex-more ex-copy" data-act="copy" title="경로 복사" aria-label="경로 복사"><i class="far fa-copy"></i></button>
              <button type="button" class="ex-more" data-act="menu" aria-label="메뉴"><i class="fas fa-ellipsis"></i></button>
            </div>`).join('') + (data.truncated ? '<div class="ex-note">결과가 많아 일부만 보여줍니다.</div>' : '')
            : '<div class="ex-note">결과가 없습니다.</div>';
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
      if (event.target.closest('[data-act="copy"]')) { event.stopPropagation(); copyText(row.dataset.path, '경로 복사'); return; }
      event.stopPropagation();
      reveal(row.dataset.path);
      if (row.dataset.type !== 'dir') options.onOpen?.(entryAt(row.dataset.path) || { path: row.dataset.path, name: basename(row.dataset.path), type: 'file', ext: '' });
    }, true);

    // ── 시작 ──
    loadPrefs().then(async () => {
      const candidates = [...(prefs().pinned || []), ...shared.roots];
      if (!root || !shared.roots.some((r) => root === r || root.startsWith(`${r}/`))) root = candidates[0] || shared.home;
      await setRoot(root);
      if (options.initialReveal) reveal(options.initialReveal);
    }).catch((error) => { treeEl.innerHTML = `<div class="ex-note error">${escapeHtml(error.message)}</div>`; });

    return { reveal, refresh: () => refresh(), get root() { return root; } };
  }

  // ════════════════════════════════════════════════════════════════════════
  // 파일 뷰어
  // ════════════════════════════════════════════════════════════════════════
  const LANGS = {
    py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
    css: 'css', scss: 'scss', less: 'less', md: 'markdown', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'bash',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', sql: 'sql', swift: 'swift', lua: 'lua', r: 'r', pl: 'perl', diff: 'diff', patch: 'diff', graphql: 'graphql',
  };
  // 열린 탭 · 탭별 보기 상태(스크롤 · 확대)는 localStorage 에 저장 → 다른 페이지에 갔다 와도 그대로.
  // Explorer 페이지와 Workspace 파일 보기가 같은 탭 목록을 쓴다.
  const TAB_KEY = 'tabs';
  const MAX_TABS = 30;
  function loadTabState(key = TAB_KEY) {
    const saved = store.get(key, null);
    const tabs = Array.isArray(saved?.tabs) ? saved.tabs.filter((t) => t && typeof t.path === 'string').slice(0, MAX_TABS) : [];
    const active = tabs.some((t) => t.path === saved?.active) ? saved.active : tabs[0]?.path || null;
    return { tabs, active, view: saved?.view && typeof saved.view === 'object' ? saved.view : {} };
  }

  // 상대 경로(그림 · 링크) → md 파일 기준 절대 경로
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
  // HTML 파일 미리보기: 스크립트는 절대 실행하지 않고(DOMPurify), 문서 스타일은 Shadow DOM 안에만 적용해 대시보드 화면과 섞이지 않게 한다.
  // 그림 · CSS 의 상대 경로와 file:/// 주소는 서버의 같은 파일(/api/fs/raw)로 바꾼다. 외부(https) 그림은 CSP 로 막혀 보이지 않는다.
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
  // 문서 CSS → 이 문서 전용 스타일시트: html · :root · body 선택자를 Shadow DOM 안의 감싸개로 옮긴다
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
  // 편집 중 미리보기용: 원본의 여는 태그마다 줄 범위(data-md-line · data-md-end, 0부터)를 끼워 넣는다.
  // 주석 · CDATA · <script>/<style> 같은 원문 요소 안은 건너뛰고, 닫는 태그로 끝 줄을 정한다 (닫지 않은 요소는 부모가 닫힐 때까지).
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
        // 따옴표 안의 > 는 무시하고 태그 끝을 찾는다
        let j = i + m[0].length;
        let quote = '';
        for (; j < len; j++) {
          const c = src[j];
          if (quote) { if (c === quote) quote = ''; }
          else if (c === '"' || c === "'") quote = c;
          else if (c === '>') break;
        }
        const selfClose = src[j - 1] === '/';
        // 닫지 않아도 되는 요소(<li>, <p>, <tr> …)는 다음 형제가 열리면 그 앞 줄에서 끝난다
        const implied = HTML_IMPLIED[name];
        if (implied) {
          const names = stack.map((item) => item.name);
          const k = Math.max(...implied.map((n) => names.lastIndexOf(n)));
          const stop = Math.max(...HTML_SCOPE.map((n) => names.lastIndexOf(n)));   // 안쪽 목록 · 표 밖의 것은 닫지 않는다
          if (k >= 0 && k > stop) {
            const own = /^\s*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i));   // 새 태그가 줄 맨 앞이면 앞 줄까지
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
  // host 안에 문서를 그린다. onOpen(path): 문서 안 로컬 파일 링크를 눌렀을 때
  // options.lines: 줄 범위를 달아 커서 표시를 쓸 수 있게, options.cssCache: 연결된 CSS 를 다시 읽지 않게 (Map),
  // options.alive(): 늦게 끝난 이전 그리기가 새 결과를 덮지 않게
  async function mountHtmlDoc(host, content, docPath, onOpen, options = {}) {
    if (options.lines) { try { content = tagHtmlLines(content); } catch (e) { /* 줄 표시 없이 그린다 */ } }
    const doc = new DOMParser().parseFromString(content, 'text/html');   // 스크립트가 돌지 않는 문서
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
      } catch (e) { /* 못 읽는 CSS 는 건너뛴다 */ }
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
      const path = htmlLocalPath(href, docPath);
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
    // 폭이 고정된 문서(body{width:210mm} 같은 인쇄용 페이지)는 PDF 처럼 가운데 종이로 놓고 바깥은 뷰어 배경을 보인다.
    // 틀을 아주 넓게 잠깐 바꿔 재 보면 화면 폭과 상관없이 알 수 있다.
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

  // 마크다운 → HTML (뷰어와 PDF 가 같은 함수를 써서 모습이 똑같다):
  // 수식은 marked 전에 빼 두었다가(common.js) DOMPurify 정리 뒤 KaTeX 로 그리고, 코드는 highlight.js 로 색칠한다.
  // options.imageUrl(path): 상대 경로 그림 주소, options.pdf: 링크를 눌러 여는 대신 글자로 둔다,
  // options.lines: 블록마다 원본 줄 범위(data-md-line · data-md-end, 0부터)를 달아 둔다 (편집 중 커서 위치 표시용)
  function renderMarkdownHtml(content, mdPath, options = {}) {
    if (!window.marked || !window.DOMPurify) return null;
    const { text, math } = window.UnivDash.math.extract(content);
    const opts = { gfm: true, breaks: false };
    let raw;
    let marks = null;
    // 줄 수 세기: 여러 줄 수식은 한 줄짜리 자리표시로 바뀌어 있으므로 삼킨 줄 수를 더한다
    const span = (str) => {
      let n = (str.match(/\n/g) || []).length;
      str.replace(/KTXM(\d+)Z/g, (m, i) => { n += math[Number(i)]?.nl || 0; return m; });
      return n;
    };
    if (options.lines) {
      // 맨 위 블록마다 앞에 빈 표시 태그를 끼워 렌더링한 뒤, 태그 바로 다음 요소에 줄 범위를 옮겨 적고 태그는 지운다
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
      // 목록은 항목마다 (안쪽 목록까지), 표는 줄마다 따로 단다
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
          (item.tokens || []).filter((t) => t.type === 'list').forEach((sub, n) => {
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
      const path = resolveRelPath(mdPath, href);
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
    const tabKey = options.stateKey || TAB_KEY;       // 분할 화면의 두 번째 그룹은 자기 탭 목록을 따로 저장
    const tabState = loadTabState(tabKey);
    let current = null;        // 지금 보이는 탭의 entry
    let lastFile = null;       // 지금 보이는 텍스트 파일 내용 (md ↔ 코드 전환용)
    let renderSeq = 0;
    let wrap = store.get('wrap', coarse);
    let mdRendered = store.get('md-rendered', true);   // .md 는 기본으로 렌더링해서 보여준다
    container.classList.add('exv');
    container.innerHTML = `
      <div class="exv-head term-head glass border-0 border-b border-white/10 safe-top-term">
        <div class="flex items-center gap-1.5 px-2 md:px-3 h-14">
          <button type="button" data-act="back" class="term-tool ${options.backAlways ? '' : 'lg:hidden'}" aria-label="뒤로"><i class="fas fa-chevron-left"></i></button>
          <span class="exv-icon"></span>
          <div class="min-w-0 flex-1">
            <h3 class="exv-name truncate text-sm font-bold text-white/90">—</h3>
            <button type="button" data-act="copy-path" class="exv-path block max-w-full truncate text-left text-[11px] text-white/40 hover:text-white/70" title="경로 복사">—</button>
          </div>
          <div class="exv-zoom hidden"><button type="button" data-act="zoom-out" aria-label="축소"><i class="fas fa-minus"></i></button><span class="exv-zoom-label">100%</span><button type="button" data-act="zoom-in" aria-label="확대"><i class="fas fa-plus"></i></button></div>
          <button type="button" data-act="edit" class="exv-edit-btn hidden" title="편집 (수정)" aria-label="편집"><i class="fas fa-pen"></i><span>편집</span></button>
          <button type="button" data-act="revert" class="term-tool hidden" title="저장 안 한 변경 버리기" aria-label="변경 버리기"><i class="fas fa-rotate-left text-xs"></i></button>
          <button type="button" data-act="autosave" class="exv-auto-btn hidden" title="자동 저장 켜기 / 끄기" aria-label="자동 저장"></button>
          <button type="button" data-act="save" class="exv-save-btn hidden" title="저장 (Ctrl/⌘+S)" aria-label="저장"><i class="fas fa-floppy-disk"></i><span>저장</span></button>
          <button type="button" data-act="md" class="exv-md-toggle hidden" title="미리보기 / 코드 전환" aria-label="미리보기 / 코드 전환"><i class="fas fa-code"></i><span>코드</span></button>
          <button type="button" data-act="mdpdf" class="term-tool hidden" title="PDF 로 저장 · 다운로드 (보이는 모습 그대로)" aria-label="PDF 로 저장"><i class="fas fa-file-pdf text-xs"></i></button>
          <button type="button" data-act="wrap" class="term-tool" title="줄바꿈" aria-label="줄바꿈"><i class="fas fa-text-width text-xs"></i></button>
          ${options.onInsert ? '<button type="button" data-act="insert" class="term-tool" title="프롬프트에 경로 넣기" aria-label="프롬프트에 경로 넣기"><i class="fas fa-paper-plane text-xs"></i></button>' : ''}
          <button type="button" data-act="download" class="term-tool" title="다운로드" aria-label="다운로드"><i class="fas fa-download text-xs"></i></button>
          <button type="button" data-act="reload" class="term-tool hidden sm:flex" title="다시 불러오기" aria-label="다시 불러오기"><i class="fas fa-rotate-right text-xs"></i></button>
        </div>
        <div class="exv-tabs no-scrollbar" role="tablist" aria-label="열린 파일"></div>
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

    // ── 탭 줄 ──
    function renderTabs() {
      const names = tabState.tabs.map((t) => t.name);
      tabsEl.innerHTML = tabState.tabs.map((tab) => {
        const dup = names.filter((n) => n === tab.name).length > 1;   // 같은 이름이면 상위 폴더도 표시
        return `<div class="exv-tab ${tab.path === tabState.active ? 'active' : ''}" role="tab" aria-selected="${tab.path === tabState.active}" data-tab="${escapeHtml(tab.path)}" title="${escapeHtml(shortHome(tab.path))}">
            ${iconFor({ ...tab, type: 'file' })}<span class="exv-tab-name">${hasDraft(tab.path) ? '<b class="exv-dirty" title="저장 안 한 변경">●</b>' : ''}${escapeHtml(tab.name)}${dup ? `<small>${escapeHtml(basename(dirname(tab.path)))}</small>` : ''}</span>
            <button type="button" class="exv-tab-close" data-close-tab aria-label="${escapeHtml(tab.name)} 닫기"><i class="fas fa-xmark"></i></button>
          </div>`;
      }).join('');
      tabsEl.classList.toggle('hidden', !tabState.tabs.length || !!options.hideTabs);   // Workspace 는 공용 탭바를 쓴다
      tabsEl.querySelector('.exv-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      options.onTabsChange?.(tabState.tabs.length);
    }
    async function closeTab(path) {
      const index = tabState.tabs.findIndex((t) => t.path === path);
      if (index < 0) return false;
      if (autoSave && current?.path === path && editing) await flushPending();
      if (hasDraft(path)) {
        const ok = await ui().confirmSheet({ title: '저장 안 한 변경이 있어요', message: `${basename(path)} 의 수정 내용을 버리고 닫을까요?`, confirmLabel: '버리고 닫기', danger: true });
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
    // 보여주지 않고 탭만 추가 (분할을 닫을 때 다른 그룹 탭을 되돌려 받기)
    function add(entry) {
      if (tabState.tabs.some((t) => t.path === entry.path)) return;
      tabState.tabs.push({ path: entry.path, name: entry.name || basename(entry.path), ext: entry.ext || '' });
      if (!tabState.active) tabState.active = entry.path;
      saveTabs();
      renderTabs();
    }
    // 다른 그룹으로 옮길 때: 확인 없이 탭만 뺀다 (저장 안 한 초안은 파일별로 남아 있어 옮긴 쪽에서 이어진다)
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
    tabsEl.addEventListener('auxclick', (event) => {           // 가운데 클릭으로 닫기
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
          { icon: 'fa-xmark', label: '닫기', onClick: () => closeTab(path) },
          { icon: 'fa-rectangle-xmark', label: '다른 탭 모두 닫기', onClick: () => closeOthers(path) },
          { icon: 'fa-trash-can', label: '모든 탭 닫기', onClick: () => closeAll() },
          'sep',
          { icon: 'fa-copy', label: '경로 복사', onClick: () => copyText(path, '경로 복사') },
        ],
      });
    });

    // 휴지통으로 보낸 파일의 탭은 닫는다
    window.addEventListener('univdash:fs-deleted', (event) => {
      const gone = event.detail.path;
      tabState.tabs.filter((t) => t.path === gone || t.path.startsWith(`${gone}/`)).forEach((t) => { clearDraft(t.path); forget(t.path); });
    });
    // 파일 · 폴더를 옮기거나 이름을 바꾸면 열린 탭 · 보기 상태 · 초안도 따라간다
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

    // ── 스크롤 위치 저장 (탭마다) ──
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

    // ── 코드 · Markdown ──
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
      return `${file.truncated ? '<div class="exv-note">파일이 커서 앞부분(2MB)만 보여줍니다. 전체는 다운로드하세요.</div>' : ''}
        <div class="exv-code ${wrap ? 'wrap' : ''}"><pre class="exv-gutter" aria-hidden="true">${gutter}</pre><pre class="exv-pre"><code class="hljs">${html}</code></pre></div>`;
    }
    // Markdown 미리보기 (marked → DOMPurify 로 정리 → 상대 경로 이미지 · 링크를 Explorer 로 연결)
    const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);
    const isMarkdown = (entry) => MD_EXT.has((entry.ext || '').toLowerCase());
    // ── 마크다운 → PDF: 서버가 뷰어와 같은 렌더링으로 PDF 를 만들고, 쪽 그림으로 미리 보여 준다 ──
    const PDF_ZOOMS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
    function mdPdfDialog(entry) {
      const UI = window.UnivDashUI;
      let zoom = store.get('md-pdf-zoom', 1);
      if (!PDF_ZOOMS.includes(zoom)) zoom = 1;
      let job = null;
      let seq = 0;
      let timer = 0;
      const base = entry.name.replace(/\.(md|markdown|mdx)$/i, '');
      const box = () => document.querySelector('#sheetBody .mdpdf');
      const pagesEl = () => box()?.querySelector('.mdpdf-pages');
      async function build() {
        const mine = ++seq;
        job = null;
        const el = box();
        if (!el) return;
        el.querySelector('.mdpdf-zoom').textContent = `${Math.round(zoom * 100)}%`;
        el.querySelectorAll('[data-pdf-act]').forEach((b) => { b.disabled = true; });
        el.querySelector('.mdpdf-info').textContent = 'PDF 만드는 중…';
        pagesEl().classList.add('busy');
        try {
          const result = await api('/api/fs/md-pdf', { method: 'POST', body: { path: entry.path, zoom } });
          if (mine !== seq || !box()) return;
          job = result;
          const width = Math.min(1600, Math.round((pagesEl().clientWidth - 24) * Math.min(window.devicePixelRatio || 1, 2)));
          pagesEl().innerHTML = Array.from({ length: result.pages }, (_, i) => `<img class="mdpdf-page" alt="${i + 1}쪽" src="/api/fs/md-pdf/${result.token}/page/${i + 1}?w=${width}" loading="lazy">`).join('');
          box().querySelector('.mdpdf-info').textContent = `${result.pages}쪽 · ${formatSize(result.size)}`;
          box().querySelectorAll('[data-pdf-act]').forEach((b) => { b.disabled = false; });
        } catch (error) {
          if (mine !== seq || !box()) return;
          pagesEl().innerHTML = `<p class="mdpdf-error"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}</p>`;
          box().querySelector('.mdpdf-info').textContent = '';
        } finally {
          if (mine === seq) pagesEl()?.classList.remove('busy');
        }
      }
      async function save(overwrite = false) {
        if (!job) return;
        try {
          const result = await api(`/api/fs/md-pdf/${job.token}/save`, { method: 'POST', body: { path: entry.path, overwrite } });
          toast(`저장했어요: ${shortHome(result.path)}`, 'success');
          window.dispatchEvent(new CustomEvent('univdash:fs-changed', { detail: { dir: dirname(entry.path) } }));
        } catch (error) {
          if (!overwrite && /이미 있어요/.test(error.message)) {
            if (confirm(`${base}.pdf 가 이미 있어요. 덮어쓸까요?`)) save(true);
            return;
          }
          toast(error.message, 'error');
        }
      }
      UI.infoSheet({
        title: 'PDF 로 저장',
        subtitle: `${entry.name} — 화면에 보이는 모습 그대로 (A4). 배율을 정한 뒤 저장하거나 내려받으세요.`,
        bodyHtml: `<div class="mdpdf">
            <div class="mdpdf-bar">
              <span class="mdpdf-label">배율</span>
              <button type="button" data-zoom="-1" aria-label="작게"><i class="fas fa-minus"></i></button>
              <span class="mdpdf-zoom">${Math.round(zoom * 100)}%</span>
              <button type="button" data-zoom="1" aria-label="크게"><i class="fas fa-plus"></i></button>
              <span class="mdpdf-info"></span>
            </div>
            <div class="mdpdf-pages"></div>
            <div class="mdpdf-actions">
              <button type="button" data-pdf-act="save" class="btn-glow" disabled><i class="fas fa-floppy-disk"></i> 서버에 저장 <small>(${escapeHtml(base)}.pdf)</small></button>
              <button type="button" data-pdf-act="download" class="mdpdf-secondary" disabled><i class="fas fa-download"></i> 다운로드</button>
            </div>
          </div>`,
        onMount: (body) => {
          body.closest('.tdx-sheet')?.classList.add('wide');
          body.addEventListener('click', (event) => {
            const z = event.target.closest('[data-zoom]');
            if (z) {
              const index = PDF_ZOOMS.indexOf(zoom) + Number(z.dataset.zoom);
              if (index < 0 || index >= PDF_ZOOMS.length) return;
              zoom = PDF_ZOOMS[index];
              store.set('md-pdf-zoom', zoom);
              box().querySelector('.mdpdf-zoom').textContent = `${Math.round(zoom * 100)}%`;
              clearTimeout(timer);
              timer = setTimeout(build, 350);   // 여러 번 누르면 마지막 배율로 한 번만 만든다
              return;
            }
            const act = event.target.closest('[data-pdf-act]')?.dataset.pdfAct;
            if (act === 'save') save();
            else if (act === 'download' && job) {
              const a = document.createElement('a');
              a.href = `/api/fs/md-pdf/${job.token}/download?name=${encodeURIComponent(`${base}.pdf`)}`;
              a.download = `${base}.pdf`;
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
    const metaHtml = (file, extra = '') => `<div class="exv-meta">${formatSize(file.size)} · ${formatTime(file.mtime)} 수정${extra}</div>`;
    // 렌더링해서 보여줄 수 있는 텍스트 (기본은 렌더링, 코드로 전환 가능): Markdown · Jupyter · CSV
    const isHtml = (entry) => ['html', 'htm', 'xhtml'].includes((entry?.ext || '').toLowerCase());
    const htmlRenderable = (entry) => isHtml(entry) && !!(window.DOMPurify && window.CSSStyleSheet && document.adoptedStyleSheets);
    const splitable = (entry) => isMarkdown(entry) || htmlRenderable(entry);   // 편집할 때 오른쪽 실시간 미리보기를 쓰는 파일
    const renderable = (entry) => isMarkdown(entry) || isHtml(entry) || ['ipynb', 'csv', 'tsv'].includes((entry?.ext || '').toLowerCase());
    function renderRich(file, entry) {
      const ext = (entry.ext || '').toLowerCase();
      if (isMarkdown(entry)) return renderMarkdown(file, entry);
      if (ext === 'ipynb') return renderNotebook(file, entry);
      if (ext === 'csv' || ext === 'tsv') return renderCsv(file, ext === 'tsv' ? '\t' : ',');
      if (htmlRenderable(entry)) return '<div class="exv-htmldoc"></div>';   // 그린 뒤 mountHtmlDoc 이 채운다
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
      toggle.innerHTML = mdRendered ? '<i class="fas fa-code"></i><span>코드</span>' : '<i class="fas fa-book-open"></i><span>미리보기</span>';
      $('[data-act="wrap"]').classList.toggle('hidden', rich && mdRendered);
      let rendered = null;
      if (rich && mdRendered) { try { rendered = renderRich(file, entry); } catch (e) { rendered = null; } }
      bodyEl.innerHTML = metaHtml(file) + (rendered ? `<div class="exv-rich">${rendered}</div>` : renderCode({ ...file, name: entry.name, ext: file.ext || entry.ext }));
      if (rendered) { sizeRich(); showZoom(); } else $('.exv-zoom').classList.add('hidden');
      const htmlHost = rendered && bodyEl.querySelector('.exv-htmldoc');
      if (htmlHost) mountHtmlDoc(htmlHost, file.content, entry.path, openLocal).then(() => find.refresh()).catch(() => { htmlHost.textContent = 'HTML 을 그리지 못했어요. 코드 보기로 확인하세요.'; });
      $('[data-act="mdpdf"]').classList.toggle('hidden', !(rendered && isMarkdown(entry)));
    }

    // Jupyter 노트북: 마크다운 셀 · 코드 셀(강조) · 출력(텍스트 · 이미지 · 오류)
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
      return `<div class="nb">${cells || '<p class="exv-empty">빈 노트북입니다.</p>'}</div>`;
    }

    // CSV · TSV: 표 (따옴표 · 줄바꿈 포함 칸 지원, 앞 2000행)
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
        ${more ? '<p class="exv-note">앞부분만 보여줍니다. 전체는 코드 보기나 다운로드로 확인하세요.</p>' : ''}</div>`;
    }

    // ── 서버 미리보기: hwpx · 압축 · SQLite · 변환 이미지 · 헥스 ──
    async function renderPreview(file, entry, seq) {
      const q = `path=${encodeURIComponent(entry.path)}`;
      $('[data-act="wrap"]').classList.add('hidden');
      if (file.preview === 'hwpx') {
        bodyEl.innerHTML = `${metaHtml(file)}<div class="exv-note"><i class="fas fa-circle-notch fa-spin"></i> 한글 문서를 여는 중…</div>`;
        const data = await api(`/api/fs/preview/hwpx?${q}`);
        if (seq !== renderSeq) return;
        const safe = window.DOMPurify ? window.DOMPurify.sanitize(data.html, { FORBID_TAGS: ['script', 'iframe', 'form', 'style', 'link'], ADD_DATA_URI_TAGS: ['img'] }) : escapeHtml(data.html);
        bodyEl.innerHTML = `${metaHtml(file, ' · 한글(hwpx) 미리보기')}<div class="hwp-doc">${safe}</div>`;
        fitHwp();
        showZoom();
      } else if (file.preview === 'archive') {
        const data = await api(`/api/fs/preview/archive?${q}`);
        if (seq !== renderSeq) return;
        const files = data.entries.filter((e) => !e.dir);
        const total = files.reduce((sum, e) => sum + (e.size || 0), 0);
        bodyEl.innerHTML = `${metaHtml(file, ` · ${data.format.toUpperCase()} · 파일 ${files.length}개${total ? ` · 풀면 ${formatSize(total)}` : ''}`)}
          <div class="data-wrap"><table class="data-table"><thead><tr><th>이름</th><th class="num">크기</th><th class="num">수정</th></tr></thead><tbody>
          ${data.entries.map((e) => `<tr class="${e.dir ? 'dir' : ''}"><td><i class="fas ${e.dir ? 'fa-folder' : 'fa-file'} mr-1.5 opacity-60"></i>${escapeHtml(e.name)}</td><td class="num">${e.dir || e.size == null ? '' : formatSize(e.size)}</td><td class="num">${e.mtime ? formatTime(e.mtime) : ''}</td></tr>`).join('')}
          </tbody></table>${data.truncated ? '<p class="exv-note">항목이 많아 일부만 보여줍니다.</p>' : ''}</div>`;
      } else if (file.preview === 'sqlite') {
        const data = await api(`/api/fs/preview/sqlite?${q}`);
        if (seq !== renderSeq) return;
        const view = viewOf(entry.path);
        const pick = (name) => {
          view.table = name;
          saveTabs();
          const table = data.tables.find((t) => t.name === name) || data.tables[0];
          const head = `<div class="db-tabs">${data.tables.map((t) => `<button type="button" data-db-table="${escapeHtml(t.name)}" class="${t === table ? 'on' : ''}">${escapeHtml(t.name)}${typeof t.count === 'number' ? ` <small>${t.count}</small>` : ''}</button>`).join('')}</div>`;
          const body = !table ? '<p class="exv-empty">표가 없습니다.</p>' : `<div class="data-wrap"><table class="data-table"><thead><tr>${table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>${table.rows.map((r) => `<tr>${r.map((v) => `<td class="${v === null ? 'null' : ''}">${v === null ? 'NULL' : escapeHtml(String(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>
            ${typeof table.count === 'number' && table.count > table.rows.length ? `<p class="exv-note">${table.count}행 중 앞 ${table.rows.length}행 (읽기 전용)</p>` : ''}</div>`;
          bodyEl.innerHTML = `${metaHtml(file, ` · SQLite · 표 ${data.tables.length}개`)}${head}${body}`;
          bodyEl.querySelectorAll('[data-db-table]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.dbTable)));
        };
        pick(view.table);
      } else if (file.preview === 'image') {
        bodyEl.innerHTML = `${metaHtml(file, ' · 서버에서 변환')}<div class="exv-image"><img src="/api/fs/preview/image?${q}&v=${file.mtime}" alt="${escapeHtml(entry.name)}"></div>`;
        bodyEl.querySelector('.exv-image img').addEventListener('load', () => { if (seq === renderSeq) sizeImage(); }, { once: true });
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
      bodyEl.innerHTML = `${metaHtml(file)}<div class="exv-note exv-note-info"><i class="fas fa-circle-info"></i> 텍스트로 볼 수 없는 파일이라 앞부분 ${formatSize(data.shown)}을 16진수로 보여줍니다.
        <button type="button" data-act="download" class="ml-2 underline">다운로드</button></div><pre class="exv-hex">${escapeHtml(lines.join('\n'))}</pre>`;
    }

    // ── PDF: 서버가 페이지를 PNG 로 그려 보낸다 (보이는 페이지만 지연 로드) ──
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
        return `<div class="exv-pdf-page" data-page="${i + 1}" style="width:${cssWidth}px;aspect-ratio:${w} / ${h}"><img src="${pdfSrc(entry.path, info, i + 1, pixels)}" alt="${i + 1} 페이지" loading="lazy" decoding="async"></div>`;
      }).join('');
      bodyEl.innerHTML = `${metaHtml(info, ` · ${info.pages}쪽`)}<div class="exv-pdf">${pages}</div>`;
    }
    // 확대 · 축소 때는 페이지를 새로 만들지 않고 폭만 바꾼다. 새 해상도 그림은 다 받은 뒤에 바꿔 끼워 깜빡이지 않게.
    function resizePdf(zoom) {
      const { cssWidth, pixels } = pdfSize(zoom);
      bodyEl.querySelectorAll('.exv-pdf-page').forEach((page) => {
        page.style.width = `${cssWidth}px`;
        const img = page.querySelector('img');
        const src = pdfSrc(current.path, pdfInfo, page.dataset.page, pixels);
        if (!img || img.getAttribute('src') === src) return;
        if (!img.complete || !img.naturalWidth) { img.src = src; return; }   // 아직 안 받은(화면 밖) 페이지
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
    // ── 확대 · 축소: ± 버튼, 트랙패드 핀치(Chrome · Edge · Firefox 는 ctrl+휠, Safari 는 gesture 이벤트), 휴대폰 두 손가락 ──
    // 문서(PDF · 오피스 · 한글)와 그림만. 손가락을 벌리는 동안은 transform 으로 바로 키우고(부드럽게),
    // 손을 떼면 그 배율로 다시 그린 뒤(PDF 는 그 배율에 맞는 해상도) 손가락 아래 있던 지점이 그대로 있게 스크롤을 맞춘다.
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
    // 마크다운 · 노트북 · 표: 글자 · 그림 · 수식을 함께 키운다 (CSS zoom 은 줄바꿈도 다시 맞춘다)
    function sizeRich() {
      const rich = bodyEl.querySelector('.exv-rich');
      if (rich && current) rich.style.zoom = String((viewOf(current.path).zoom || 1));
    }
    // (cx, cy) 화면 지점을 기준으로 확대: 그 지점 아래 내용이 그대로 있게 한다
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
    // 트랙패드 핀치 (Chrome · Edge · Firefox): ctrlKey 가 붙은 wheel 로 온다. 브라우저 화면 확대 대신 문서만.
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
    // Safari (Mac 트랙패드): gesture 이벤트
    bodyEl.addEventListener('gesturestart', (event) => {
      if (!zoomable()) return;
      event.preventDefault();
      pinch.gesture = pinchStart(event.clientX, event.clientY);
    }, { passive: false });
    bodyEl.addEventListener('gesturechange', (event) => { if (!pinch.gesture) return; event.preventDefault(); pinchMove(event.scale); }, { passive: false });
    bodyEl.addEventListener('gestureend', (event) => { if (!pinch.gesture) return; event.preventDefault(); pinch.gesture = false; pinchEnd(); }, { passive: false });
    // 휴대폰 · 태블릿: 두 손가락
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

    // ── 편집 ──────────────────────────────────────────────────────────
    // 저장 안 한 내용은 파일별로 localStorage 에 초안으로 남겨 다른 탭 · 페이지에 갔다 와도 이어서 고친다.
    const draftKey = (path) => `draft:${path}`;
    function hasDraft(path) { return !!store.get(draftKey(path), null); }
    function clearDraft(path) { try { localStorage.removeItem(`univdash-ex-${draftKey(path)}`); } catch (e) { /* noop */ } }
    let editing = false;
    let editorEl = null;
    // 자동 저장 (기본 켜짐): 입력이 멈추고 0.8초 뒤 · 탭을 바꾸거나 페이지를 떠날 때 저장.
    // 연 뒤에 다른 곳(에이전트 등)이 파일을 바꿨으면 덮어쓰지 않고 멈춘 뒤 어떻게 할지 묻는다.
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
    // 탭 전환 · 편집 종료 · 페이지 떠나기 전에 밀린 초안과 자동 저장을 바로 처리
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
      bar.innerHTML = `<i class="fas fa-triangle-exclamation"></i><span>연 뒤에 다른 곳(에이전트 등)에서 이 파일이 바뀌어 자동 저장을 멈췄어요. 내 수정은 그대로 남아 있어요.</span>
        <button type="button" data-act="conflict-overwrite">내 것으로 덮어쓰기</button><button type="button" data-act="conflict-reload">파일 다시 불러오기</button>`;
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
      auto.innerHTML = `<i class="fas ${autoSave ? 'fa-bolt' : 'fa-hand'}"></i><span>${autoSave ? '자동 저장' : '수동 저장'}</span>`;
      $('.exv-save-btn span').textContent = autoSave && !dirty ? '저장됨' : '저장';
      $('[data-act="revert"]').classList.toggle('hidden', !editing || !dirty);
      const md = current && renderable(current);
      const toggle = $('.exv-md-toggle');
      toggle.classList.toggle('hidden', !md || (editing && !splitable(current)));
      if (editing) $('[data-act="mdpdf"]').classList.add('hidden');
      toggle.classList.toggle('off', editing && !mdSplit);
      toggle.innerHTML = editing
        ? '<i class="fas fa-table-columns"></i><span>미리보기</span>'
        : mdRendered ? '<i class="fas fa-code"></i><span>코드</span>' : '<i class="fas fa-book-open"></i><span>미리보기</span>';
      toggle.title = editing ? '실시간 미리보기 켜기 / 끄기' : '미리보기 / 코드 전환';
      if (editing) {
        $('.exv-edit-btn').classList.add('hidden');
        $('.exv-done-btn')?.remove();
        const done = document.createElement('button');
        done.type = 'button'; done.dataset.act = 'done'; done.className = 'exv-done-btn'; done.textContent = '완료';
        $('.exv-save-btn').after(done);
      } else {
        $('.exv-done-btn')?.remove();
      }
    }
    // 마크다운 편집: VS Code 처럼 왼쪽은 편집기, 오른쪽은 실시간 미리보기 (기본 켜짐, 미리보기 버튼으로 끄고 켬)
    let mdSplit = store.get('md-split', true);
    let splitRatio = store.get('md-split-ratio', 0.5);
    const livePreview = () => editing && mdSplit && current && splitable(current);
    let previewTimer = null;
    let previewHtml = '';
    let previewSeq = 0;
    let previewCss = new Map();   // HTML 미리보기: 연결된 CSS 파일 (편집기를 새로 열 때 비운다)
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
    // 편집기 커서가 있는 줄 → 미리보기에서 그 줄을 그린 블록(목록 항목 · 표 줄까지)을 표시하고, 안 보이면 그쪽으로 스크롤
    let cursorFrame = 0;
    let cursorLine = -1;
    function markPreviewCursor(rendered = false) {
      cancelAnimationFrame(cursorFrame);
      cursorFrame = requestAnimationFrame(() => {
        const pane = bodyEl.querySelector('.exv-live');
        if (!pane || !editorEl) return;
        if (document.activeElement !== editorEl && cursorLine < 0) return;   // 아직 커서를 놓은 적 없으면 표시 안 함
        const line = editorEl.value.slice(0, editorEl.selectionStart).split('\n').length - 1;
        if (!rendered && line === cursorLine) return;
        cursorLine = line;
        let best = null;
        let bestSize = Infinity;
        let prev = null;
        let prevEnd = -1;
        const scope = pane.querySelector('.exv-htmldoc')?.shadowRoot || pane;   // HTML 문서는 Shadow DOM 안에 있다
        const outer = scope !== pane;   // HTML: 같은 줄이면 바깥 요소 (<p> 안의 <b> 대신 <p>)
        scope.querySelectorAll('[data-md-line]').forEach((el) => {
          const a = Number(el.dataset.mdLine);
          const b = Number(el.dataset.mdEnd);
          if (a <= line && line <= b) { if (outer ? b - a < bestSize : b - a <= bestSize) { best = el; bestSize = b - a; } }   // 가장 좁은 것 (md 는 같으면 안쪽)
          else if (b < line && b > prevEnd) { prev = el; prevEnd = b; }                              // 빈 줄이면 바로 위 블록
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
    // 편집기를 스크롤하면 미리보기도 같은 줄로 따라간다.
    // 원본 줄 → 미리보기 위치는 블록마다 단 줄 범위(data-md-line)를 기준점으로 잇고, 스크롤한 만큼만 움직여서
    // 커서 표시로 맞춰 둔 미리보기가 휙 넘어가지 않게 한다 (차이는 스크롤하는 동안 조금씩 줄여 간다).
    let anchorCache = null;
    let lineTopCache = null;
    let syncedTop = null;   // 마지막으로 맞춘 편집기 scrollTop
    function previewAnchors(pane) {
      const key = `${pane.clientWidth}:${pane.scrollHeight}`;
      if (anchorCache?.key === key) return anchorCache.list;
      const scope = pane.querySelector('.exv-htmldoc')?.shadowRoot || pane;
      const box = pane.getBoundingClientRect();
      const raw = [];
      let bottom = 0;
      scope.querySelectorAll('[data-md-line]').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect.height && !rect.width) return;   // 숨은 요소
        const y = rect.top - box.top + pane.scrollTop;
        raw.push([Number(el.dataset.mdLine), y]);
        bottom = Math.max(bottom, rect.bottom - box.top + pane.scrollTop);
      });
      raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const list = [[0, 0]];
      for (const [line, y] of raw) {
        const last = list[list.length - 1];
        if (line === last[0]) continue;              // 같은 줄은 가장 위의 것
        if (y >= last[1]) list.push([line, y]);      // 위치가 거꾸로 가는 기준점(겹친 블록)은 버린다
      }
      list.push([editorEl.value.split('\n').length, Math.max(bottom, list[list.length - 1][1])]);
      anchorCache = { key, list };
      return list;
    }
    // 편집기 줄마다 위쪽 y (자동 줄바꿈이면 숨은 복제본으로 잰다)
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
    // 편집기 scrollTop → 미리보기 scrollTop
    function mapEditorTop(pane, top) {
      const tops = editorLineTops();
      let lo = 0;
      let hi = tops.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= top) lo = mid; else hi = mid - 1; }
      const next = lo + 1 < tops.length ? tops[lo + 1] : tops[lo] + (parseFloat(getComputedStyle(editorEl).lineHeight) || 20);
      const line = lo + Math.min(1, Math.max(0, (top - tops[lo]) / Math.max(1, next - tops[lo])));   // 소수 줄
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
        const delta = target - mapEditorTop(pane, syncedTop);   // 스크롤한 만큼 그대로
        const gap = target - (pane.scrollTop + delta);
        pane.scrollTop += delta + gap * Math.min(0.25, Math.abs(top - syncedTop) / Math.max(1, editorEl.clientHeight));   // 어긋난 만큼은 천천히
      }
      syncedTop = top;
    }
    // 미리보기를 누르면 편집기 커서를 그 부분으로 옮긴다: 누른 블록의 원본 줄 범위 안에서 누른 글자를 찾고, 못 찾으면 그 블록 첫 줄로
    function jumpFromPreview(event) {
      if (!editorEl || event.defaultPrevented || event.button !== 0) return;
      const path = event.composedPath();
      if (path.some((el) => el instanceof Element && el.matches('a, button, input, summary, label, [data-ex-open], [data-anchor]'))) return;
      if (String(window.getSelection?.() || '').length) return;   // 글자를 끌어 선택한 경우는 그대로 둔다
      const block = path.find((el) => el instanceof Element && el.dataset?.mdLine != null);
      if (!block) return;
      const value = editorEl.value;
      const lineStart = (n) => {   // n 번째 줄의 시작 위치 (줄이 모자라면 글 끝)
        let at = 0;
        for (let i = 0; i < n; i++) { const nl = value.indexOf('\n', at); if (nl < 0) return value.length; at = nl + 1; }
        return at;
      };
      const from = lineStart(Number(block.dataset.mdLine));
      const to = lineStart(Number(block.dataset.mdEnd) + 1);
      let caret = from + (value.slice(from, to).match(/^[ \t]*/)?.[0].length || 0);
      // 누른 지점의 글자 (Shadow DOM 안도 찾도록 caretPositionFromPoint 를 먼저)
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
        // 앞뒤 글자로 같이 찾아 정확한 자리를 먼저, 안 되면 뒤쪽 글자 → 앞쪽 글자
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
      // 커서 줄을 편집기 위아래 가운데로 (미리보기는 누른 자리 그대로)
      const box = caretLineBox();
      if (box) {
        editorEl.scrollTop = Math.max(0, box.top + box.height / 2 - editorEl.clientHeight / 2);
        syncedTop = editorEl.scrollTop;   // 이 스크롤로는 미리보기를 움직이지 않는다
      }
      placeCaretLine({ flash: true });
      markPreviewCursor();
    }
    // 편집기 현재 줄 표시 (VS Code 처럼 줄 전체에 옅은 띠, 미리보기에서 옮겨 오면 잠깐 반짝)
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
    let caretFlash = false;   // 같은 프레임에 다른 이벤트가 다시 불러도 반짝임은 남긴다
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
      const editorHtml = `<div class="exv-editor ${wrap ? 'wrap' : ''}"><pre class="exv-gutter" aria-hidden="true"></pre><textarea class="exv-textarea" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="${wrap ? 'soft' : 'off'}" aria-label="${escapeHtml(current.name)} 편집"></textarea></div>`;
      const live = livePreview();
      $('.exv-zoom').classList.add('hidden');
      bodyEl.innerHTML = metaHtml(lastFile, ' · 편집 중') + (live
        ? `<div class="exv-split">${editorHtml}<div class="exv-split-bar" role="separator" aria-orientation="vertical" title="끌어서 크기 조절 · 두 번 눌러 반반"></div><div class="exv-live" aria-label="미리보기"></div></div>`
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
            // 여러 줄 선택: 들여쓰기 / Shift+Tab 내어쓰기
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
      if (draft) scheduleAutoSave(300);   // 지난번에 저장 못 한 초안이 있으면 이어서 저장
      if (focus && !coarse) editorEl.focus();
    }
    async function exitEdit() {
      if (autoSave && current && hasDraft(current.path) && conflictPath !== current.path) await flushPending();
      if (current && hasDraft(current.path)) {
        const ok = await ui().confirmSheet({ title: '저장할까요?', message: `${current.name} 에 저장 안 한 변경이 있어요.`, confirmLabel: '저장하고 닫기' });
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
      if (saving) {                       // 저장 중이면 끝난 뒤 다시
        if (auto) scheduleAutoSave(400);
        return false;
      }
      if (draftTimer) writeDraft();
      const path = current.path;
      const text = editorEl.value;
      if (auto && !hasDraft(path)) return true;             // 바뀐 게 없음
      const draft = store.get(draftKey(path), null);
      const base = draft?.base ?? lastFile.mtime_ns;
      const button = $('.exv-save-btn');
      button.disabled = true;
      saving = true;
      try {
        const body = JSON.stringify({ path, content: text, mtime_ns: base, force });
        const response = await fetch('/api/fs/write', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
          keepalive: keepalive && body.length < 60000,       // 페이지를 떠나는 중에도 끝까지 보내기
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 409) {
          if (auto) { conflictPath = path; if (current?.path === path) showConflict(); return false; }
          saving = false;
          const ok = await ui().confirmSheet({ title: '파일이 바뀌었어요', message: '연 뒤에 다른 곳(에이전트 등)에서 이 파일을 고쳤습니다. 내 내용으로 덮어쓸까요? 취소하면 편집 내용은 그대로 남아요.', confirmLabel: '덮어쓰기', danger: true });
          return ok ? save(true) : false;
        }
        if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '저장하지 못했습니다.');
        if (conflictPath === path) conflictPath = null;
        // 저장하는 동안 더 입력했으면 그 초안은 남기고 새 기준 시각으로 이어서 저장
        const latest = store.get(draftKey(path), null);
        if (!latest || latest.text === text) clearDraft(path);
        else store.set(draftKey(path), { text: latest.text, base: data.mtime_ns });
        if (current?.path === path) {
          lastFile = { ...lastFile, content: text, size: data.size ?? lastFile.size, mtime: data.mtime ?? lastFile.mtime, mtime_ns: data.mtime_ns };
          bodyEl.querySelector('.exv-conflict')?.remove();
          const meta = bodyEl.querySelector('.exv-meta');
          const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          if (meta) meta.textContent = `${formatSize(lastFile.size)} · ${auto ? '자동 저장됨' : '저장함'} ${time}`;
          if (editorEl && editorEl.value !== text) scheduleAutoSave();
        }
        renderTabs();
        setEditButtons();
        if (!auto) toast(`${basename(path)} 저장했습니다.`, 'success');
        return true;
      } catch (error) {
        if (auto) {                        // 네트워크가 잠깐 끊겨도 초안은 남아 있으니 조금 뒤 다시
          const meta = bodyEl.querySelector('.exv-meta');
          if (meta && current?.path === path) meta.textContent = `자동 저장 실패 — 다시 시도하는 중 (${error.message})`;
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
      const ok = await ui().confirmSheet({ title: '변경 버리기', message: `${current.name} 의 저장 안 한 수정을 모두 버립니다.`, confirmLabel: '버리기', danger: true });
      if (!ok) return;
      clearDraft(current.path);
      renderEditor(lastFile.content);
      renderTabs();
      setEditButtons();
    }

    // ── 탭 내용 표시 ──
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
      bodyEl.innerHTML = '<div class="exv-note"><i class="fas fa-circle-notch fa-spin"></i> 불러오는 중…</div>';
      try {
        const file = await api(`/api/fs/read?path=${encodeURIComponent(entry.path)}`);
        if (seq !== renderSeq) return;
        const raw = `/api/fs/raw?path=${encodeURIComponent(entry.path)}&v=${file.mtime}`;
        if (file.pdf || file.preview === 'office') {
          $('[data-act="wrap"]').classList.add('hidden');
          if (file.preview === 'office') bodyEl.innerHTML = `${metaHtml(file)}<div class="exv-note"><i class="fas fa-circle-notch fa-spin"></i> 문서를 변환하는 중… (처음 한 번만 몇 초 걸려요)</div>`;
          const info = await api(`/api/fs/pdf/info?path=${encodeURIComponent(entry.path)}`);
          if (seq !== renderSeq) return;
          $('.exv-zoom').classList.remove('hidden');
          renderPdf(entry, info);
        } else if (file.image) {
          $('[data-act="wrap"]').classList.add('hidden');
          bodyEl.innerHTML = `${metaHtml(file)}<div class="exv-image ${viewOf(entry.path).actual ? 'actual' : ''}"><img src="${raw}" alt="${escapeHtml(entry.name)}" title="눌러서 원본 크기 / 화면 맞춤"></div>`;
          const img = bodyEl.querySelector('img');
          showZoom();
          img.addEventListener('load', () => { if (seq === renderSeq) { sizeImage(); restoreScroll(entry); } }, { once: true });
          img.addEventListener('click', () => {
            const view = viewOf(entry.path);
            if ((view.zoom || 1) !== 1) { view.actual = false; bodyEl.querySelector('.exv-image').classList.remove('actual'); applyZoom(1); return; }   // 확대해 둔 그림은 누르면 맞춤으로
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
          // 초안이 있거나 편집 중이던 탭, 빈 파일(새로 만든 파일)은 바로 편집기로 연다
          if (editable(lastFile) && (hasDraft(entry.path) || viewOf(entry.path).edit || !lastFile.content)) enterEdit({ focus: !lastFile.content });
          else renderText(lastFile, entry);
        }
        setEditButtons();
        restoreScroll(entry);
      } catch (error) {
        if (seq === renderSeq) bodyEl.innerHTML = `<div class="exv-empty"><i class="fas fa-triangle-exclamation text-2xl text-amber-400"></i><p>${escapeHtml(error.message)}</p></div>`;
      }
    }

    // 새 파일 열기: 이미 열린 탭이면 그 탭으로, 아니면 지금 탭 오른쪽에 새 탭
    function open(entry) {
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
    }
    // 저장된 탭 복원 (열린 탭이 있으면 true)
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
      else if (act === 'copy-path') copyText(current.path, '경로 복사');
      else if (act === 'insert') options.onInsert?.(current.path);
      else if (act === 'download') window.location.href = `/api/fs/raw?download=1&path=${encodeURIComponent(current.path)}`;
      else if (act === 'reload') show(current);
      else if (act === 'edit') enterEdit();
      else if (act === 'save') save();
      else if (act === 'autosave') {
        autoSave = !autoSave;
        store.set('auto-save', autoSave);
        setEditButtons();
        toast(autoSave ? '자동 저장을 켰습니다.' : '자동 저장을 껐습니다. 저장 버튼이나 Ctrl/⌘+S 로 저장하세요.', 'info');
        if (autoSave && current && hasDraft(current.path)) scheduleAutoSave(200);
      } else if (act === 'conflict-overwrite') { conflictPath = null; save(true); }
      else if (act === 'conflict-reload') { conflictPath = null; clearDraft(current.path); viewOf(current.path).edit = true; show(current); }
      else if (act === 'done') exitEdit();
      else if (act === 'revert') revert();
      else if (act === 'mdpdf' && current) mdPdfDialog(current);
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
    // 편집기를 쓰던 내용 · 커서 그대로 다시 그린다 (실시간 미리보기 켜기 / 끄기)
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
    // 설정 창(또는 다른 탭)에서 편집기 설정을 바꾸면 열린 뷰어에도 바로 적용
    window.addEventListener('univdash:settings', () => {
      const next = { auto: store.get('auto-save', true), wrap: store.get('wrap', coarse), split: store.get('md-split', true), rendered: store.get('md-rendered', true) };
      if (next.auto !== autoSave) { autoSave = next.auto; if (autoSave && current && hasDraft(current.path)) scheduleAutoSave(200); }
      if (next.wrap !== wrap) { wrap = next.wrap; applyWrap(); }
      if (next.split !== mdSplit) { mdSplit = next.split; if (editing && current && splitable(current)) rerenderEditor(); }
      if (next.rendered !== mdRendered) { mdRendered = next.rendered; if (!editing && lastFile && current) renderText(lastFile, current); }
      if (current) setEditButtons();
    });
    // 창 크기가 바뀌면 PDF 페이지 폭을 다시 맞춘다
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
    // ── 다른 곳(에이전트 등)에서 바뀐 파일 바로 반영 ──
    // 보이는 텍스트 파일만 1.5초마다 수정 시각을 확인한다 (내용은 바뀌었을 때만 읽는다).
    // - 보기: 스크롤 위치 그대로 다시 그린다.
    // - 편집 중 · 저장 안 한 입력 없음: 편집기 내용을 바꾼다 (커서 · 스크롤 유지, 미리보기도).
    // - 편집 중 · 저장 안 한 입력 있음: 서로 다른 줄을 고쳤으면 합친다. 같은 줄이면 '파일이 바뀌었어요' 안내로.
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
      editorEl.setRangeText(next.slice(a, next.length - b), a, cur.length - b, 'preserve');   // 바뀐 부분만 → 커서가 제자리에
      editorEl.scrollTop = top;
      editorEl.scrollLeft = left;
    }
    function flashMeta(text) {
      const meta = bodyEl.querySelector('.exv-meta');
      if (!meta) return;
      const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      meta.textContent = `${formatSize(lastFile.size)} · ${text} ${time}`;
      meta.classList.remove('exv-meta-flash');
      void meta.offsetWidth;
      meta.classList.add('exv-meta-flash');
    }
    async function checkExternal() {
      if (watching || saving || !current || !lastFile || typeof lastFile.content !== 'string' || lastFile.mtime_ns == null) return;
      if (document.hidden || !container.isConnected || !container.getClientRects().length) return;
      if (conflictPath === current.path) return;   // 이미 어떻게 할지 묻는 중
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
          flashMeta('다른 곳에서 바뀐 내용 반영');
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
          // 내 초안이 지금 보고 있는 파일 버전을 바탕으로 한 것일 때만 합친다
          const merged = (draft?.base ?? snap.mtime_ns) === snap.mtime_ns ? merge3(snap.content, mine, next.content) : null;
          if (merged == null) { conflictPath = path; showConflict(); return; }
          lastFile = next;
          if (merged === next.content) clearDraft(path);
          else store.set(draftKey(path), { text: merged, base: next.mtime_ns });
          replaceEditorText(merged);
        }
        editorEl.dispatchEvent(new Event('input'));   // 줄 번호 · 미리보기 · 초안 · 자동 저장
        renderTabs();
        setEditButtons();
        flashMeta(mine === snap.content ? '다른 곳에서 바뀐 내용 반영 · 편집 중' : '다른 곳의 수정과 내 수정을 합침 · 편집 중');
      } catch (e) { /* 다음 확인 때 다시 */ } finally { watching = false; }
    }
    setInterval(checkExternal, 1500);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkExternal(); });

    // +/- 키 확대 · 축소 (아래 공용 키 처리가 마지막으로 만진 뷰어를 고른다)
    zoomViewers.push({
      container,
      canZoom: () => !!current && !editing && !!zoomable(),
      step: (delta) => setZoom(delta),
      reset() { const box = bodyEl.getBoundingClientRect(); zoomAt(1, box.left + box.width / 2, box.top + box.height / 3); },
    });
    // Ctrl/⌘+W 는 브라우저 창 닫기라 가로채지 않는다. Alt+W 로 현재 탭 닫기.
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

  // ── 3-way 병합 (줄 단위): base 에서 mine · theirs 가 각자 고친 곳을 합친다. 같은 곳을 다르게 고쳤으면 null ──
  function lineMatch(a, b) {
    // a 의 각 줄이 b 의 몇 번째 줄과 짝인지 (최장 공통 부분열). 앞뒤 같은 부분은 먼저 잘라 계산을 줄인다.
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
    if (n * m > 4e6) return null;   // 너무 크게 바뀜: 합치지 않는다
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
      if (!end && (bm[x] < 0 || bt[x] < 0)) continue;   // 양쪽 모두 그대로 둔 줄을 기준점으로
      const mj = end ? M.length : bm[x];
      const tk = end ? T.length : bt[x];
      const b = B.slice(i, x);
      const m = M.slice(j, mj);
      const t = T.slice(k, tk);
      if (same(m, b)) out.push(...t);
      else if (same(t, b) || same(m, t)) out.push(...m);
      else return null;                                  // 같은 곳을 서로 다르게 고침
      if (!end) out.push(B[x]);
      i = x + 1;
      j = mj + 1;
      k = tk + 1;
    }
    return out.join('\n');
  }

  // ── 뷰어 확대 · 축소 단축키: + (=) 확대 · - 축소 · 0 원래 크기 ──
  // 입력 중이 아닐 때, Ctrl/⌘ 조합(브라우저 화면 확대)은 건드리지 않는다.
  // 대상: 마지막으로 누르거나 포커스한 뷰어, 없으면 화면에 보이는 뷰어 (Workspace 분할 화면에서도 하나만).
  const zoomViewers = [];
  let lastViewer = null;
  const viewerOf = (el) => zoomViewers.find((v) => v.container.contains(el));
  document.addEventListener('pointerdown', (event) => { lastViewer = viewerOf(event.target) || lastViewer; }, true);
  document.addEventListener('focusin', (event) => { lastViewer = viewerOf(event.target) || lastViewer; });
  const visible = (v) => v.container.isConnected && v.container.getClientRects().length > 0 && v.container.offsetParent !== null;
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat && event.key === '0') return;
    const action = { '+': 1, '=': 1, '-': -1, _: -1, '0': 0 }[event.key]
      ?? { NumpadAdd: 1, NumpadSubtract: -1, Numpad0: 0 }[event.code];
    if (action === undefined || window.UnivDash.typingOrBusy(event)) return;
    const target = [lastViewer, ...zoomViewers].find((v) => v && visible(v) && v.canZoom());
    if (!target) return;
    event.preventDefault();
    if (action === 0) target.reset(); else target.step(action);
  });

  window.UnivDashExplorer = { mountTree, mountViewer, copyText, loadPrefs, shared, renderMarkdownHtml };

  // ════════════════════════════════════════════════════════════════════════
  // Explorer 페이지 (/explorer)
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
    openChip.querySelector('span').textContent = `열린 파일 ${count}`;
  }
  // 휴대폰: 뷰어는 밀려 들어오는 패널 (뒤로 가기로 닫힘). 열려 있던 상태도 기억한다.
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
    onTabsChange: () => { if (!viewer?.count) showViewerArea(false); syncChip(); },
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
  mountTree(document.getElementById('explorerTree'), {
    initialReveal: new URLSearchParams(location.search).get('path'),
    showWidthReset: true,
    onWidthReset() { applyExplorerWidth(explorerDefaultWidth(), true); },
    onOpen(entry) { openPanel(); viewer.open(entry); },
  });
  window.addEventListener('popstate', () => { if (isOpen()) closePanel(true); });
  // 단축키 (입력 중이 아닐 때): w/ㅈ 지금 파일 탭 닫기 · 1~9 N번째 탭 · ←/→ 이전/다음 탭
  document.addEventListener('keydown', (event) => {
    const { plainKey, typingOrBusy } = window.UnivDash;
    if (typingOrBusy(event)) return;
    const tabs = viewer.tabs;
    const index = tabs.findIndex((t) => t.path === viewer.activePath);
    const go = (tab) => { if (tab && tab.path !== viewer.activePath) { openPanel(); viewer.open(tab); } };
    if (plainKey(event, 'KeyW')) {
      if (!viewer.current) return;
      event.preventDefault();
      viewer.closeTab(viewer.current.path);
      return;
    }
    const digit = /^Digit([1-9])$/.exec(event.code);
    if (digit && plainKey(event, event.code)) {
      if (!tabs[Number(digit[1]) - 1]) return;
      event.preventDefault();
      go(tabs[Number(digit[1]) - 1]);
      return;
    }
    if ((plainKey(event, 'ArrowLeft') || plainKey(event, 'ArrowRight')) && tabs.length > 1) {
      event.preventDefault();
      go(tabs[((index < 0 ? 0 : index + (event.code === 'ArrowRight' ? 1 : -1)) + tabs.length) % tabs.length]);
    }
  });
  openChip.addEventListener('click', () => { openPanel(); });
  desktop.addEventListener('change', () => { document.body.classList.toggle('panel-open', false); showViewerArea(viewer.count > 0); syncChip(); });

  // 복원: 열린 탭이 있으면 데스크톱은 바로, 휴대폰은 떠날 때 뷰어가 열려 있었으면 다시 연다
  if (viewer.count) {
    showViewerArea(true);
    if (!desktop.matches && store.get('panel-open', false)) openPanel();
    viewer.restore();
  }
  syncChip();
})();
