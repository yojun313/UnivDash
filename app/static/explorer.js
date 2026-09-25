// Explorer: VS Code 탐색기처럼 서버의 폴더 · 파일을 보고 관리한다.
// - UnivDashExplorer.mountTree(container, options)   폴더 트리 (Explorer 페이지 · Workspace [파일] 탭 공용)
// - UnivDashExplorer.mountViewer(container, options) 파일 뷰어 (코드 강조 · 이미지 · 다운로드)
// 설정(고정 폴더 · 가린 항목 · 폴더별 순서 · 정렬 · 숨김 파일)은 서버에 저장되어 휴대폰 · PC 가 같이 쓴다.
(function () {
  'use strict';
  const { escapeHtml, api, toast } = window.UnivDash;
  const ui = () => window.UnivDashUI;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
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
          <button type="button" data-act="refresh" title="새로고침" aria-label="새로고침"><i class="fas fa-rotate-right"></i></button>
          <button type="button" data-act="collapse" title="모두 접기" aria-label="모두 접기"><i class="fas fa-down-left-and-up-right-to-center"></i></button>
          <button type="button" data-act="more" title="보기 · 정렬" aria-label="보기 · 정렬"><i class="fas fa-ellipsis-vertical"></i></button>
        </div>
      </div>
      <label class="ex-search"><i class="fas fa-magnifying-glass"></i><input type="search" placeholder="파일 · 폴더 이름 검색" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <div class="ex-status"></div>
      <div class="ex-body" tabindex="0" aria-label="파일 목록 (Shift 로 여러 개 선택 · Backspace 로 삭제)"><div class="ex-tree" role="tree" aria-multiselectable="true"></div><div class="ex-results hidden"></div><div class="ex-drop-hint hidden"></div></div>
      <input type="file" class="hidden ex-upload" multiple>`;
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
      return entries.filter((e) => (p.show_dotfiles || !e.name.startsWith('.')) && (p.show_hidden || !isGated(e.path)));
    }
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
      const cut = shared.clipboard?.mode === 'cut' && shared.clipboard.path === entry.path;
      const dim = entry.name.startsWith('.') || isGated(entry.path);
      const drag = !coarse && prefs().sort !== 'manual' ? 'draggable="true"' : '';
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
      const flags = [SORTS[p.sort]?.label, p.show_dotfiles ? '숨김 파일 표시' : '', p.show_hidden ? '가린 항목 표시' : '', shared.clipboard ? `${shared.clipboard.mode === 'cut' ? '잘라낸' : '복사한'} 항목: ${basename(shared.clipboard.path)}` : ''].filter(Boolean);
      statusEl.innerHTML = `<i class="fas fa-location-dot"></i> ${escapeHtml(shortHome(root))}<span class="opacity-60"> · ${escapeHtml(flags.join(' · '))}</span>`;
      body.scrollTop = top;
      if (pendingScroll && !pending.size) { body.scrollTop = pendingScroll; pendingScroll = 0; }
      paintSelection();
      setupSortables();
    }

    // 직접 지정 정렬: 같은 폴더 안에서 끌어서 순서 변경 (휴대폰은 길게 눌러 끌기)
    function setupSortables() {
      sortables.forEach((s) => s.destroy());
      sortables = [];
      if (prefs().sort !== 'manual' || !window.Sortable) return;
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
    async function paste(dir) {
      const clip = shared.clipboard;
      if (!clip) return;
      const result = await op({ op: clip.mode === 'cut' ? 'move' : 'copy', path: clip.path, dest: dir }, clip.mode === 'cut' ? '옮겼습니다.' : '복사했습니다.');
      if (!result) return;
      if (clip.mode === 'cut') {
        shared.clipboard = null;
        cache.delete(dirname(clip.path));
        window.dispatchEvent(new CustomEvent('univdash:fs-moved', { detail: { from: clip.path, to: result.path } }));
      }
      expanded.add(dir);
      saveExpanded();
      await refresh(dir);
      select(result.path);
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
        if (shared.clipboard?.path === source) shared.clipboard = null;
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
    function upload(files, dir) {
      if (!files.length) return;
      toast(`${files.length}개 업로드 중… (${shortHome(dir)})`, 'info');
      let done = 0;
      const next = (index) => {
        if (index >= files.length) {
          toast(`${done}개 업로드 완료`, 'success');
          expanded.add(dir); saveExpanded();
          refresh(dir);
          return;
        }
        const file = files[index];
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/fs/upload?dir=${encodeURIComponent(dir)}`);
        xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) done += 1;
          else { let msg = '업로드 실패'; try { msg = JSON.parse(xhr.responseText).detail || msg; } catch (e) { /* noop */ } toast(`${file.name}: ${msg}`, 'error'); }
          next(index + 1);
        };
        xhr.onerror = () => { toast(`${file.name}: 네트워크 오류`, 'error'); next(index + 1); };
        xhr.send(file);
      };
      next(0);
    }
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
      if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.altKey) {
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
      }
    });
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
      container.querySelectorAll('.ex-row.drop').forEach((el) => el.classList.remove('drop'));
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
    body.addEventListener('dragover', (event) => {
      if (!dragSource) return;
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
      const dir = dropDir(event);
      const copy = event.ctrlKey || event.altKey || event.metaKey;
      dragSource = null;
      clearDrop();
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
      upload([...event.dataTransfer.files], dropDir(event));
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
          isDir && { icon: 'fa-upload', label: '업로드', onClick: () => { uploadDir = entry.path; uploadInput.click(); } },
          isDir && clip && { icon: 'fa-paste', label: '붙여넣기', sub: basename(clip.path), onClick: () => paste(entry.path) },
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
          { icon: 'fa-scissors', label: '잘라내기', onClick: () => { shared.clipboard = { mode: 'cut', path: entry.path }; render(); } },
          { icon: 'fa-clone', label: '복사', onClick: () => { shared.clipboard = { mode: 'copy', path: entry.path }; render(); } },
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
          { icon: 'fa-upload', label: '루트에 업로드', onClick: () => { uploadDir = root; uploadInput.click(); } },
          shared.clipboard && { icon: 'fa-paste', label: '루트에 붙여넣기', sub: basename(shared.clipboard.path), onClick: () => paste(root) },
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
        if (entry) { navigator.vibrate?.(10); select(entry.path); entryMenu(entry); row.dataset.pressed = '1'; }
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
          const data = await api(`/api/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&hidden=${prefs().show_dotfiles ? 1 : 0}`);
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
    function resolveRel(base, href) {
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
    function renderMarkdown(file, entry) {
      if (!window.marked || !window.DOMPurify) return null;
      const raw = window.marked.parse(file.content, { gfm: true, breaks: false });
      const html = window.DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] });
      const box = document.createElement('div');
      box.className = 'exv-md';
      box.innerHTML = html;
      box.querySelectorAll('img[src]').forEach((img) => {
        const src = img.getAttribute('src');
        if (/^(https?:|data:|\/\/)/i.test(src)) return;
        const path = resolveRel(entry.path, src);
        if (path) img.src = `/api/fs/raw?path=${encodeURIComponent(path)}`;
        img.loading = 'lazy';
      });
      box.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href');
        if (href.startsWith('#')) { a.dataset.anchor = href.slice(1); return; }
        if (/^(https?:|mailto:)/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; return; }
        const path = resolveRel(entry.path, href);
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
    const metaHtml = (file, extra = '') => `<div class="exv-meta">${formatSize(file.size)} · ${formatTime(file.mtime)} 수정${extra}</div>`;
    // 렌더링해서 보여줄 수 있는 텍스트 (기본은 렌더링, 코드로 전환 가능): Markdown · Jupyter · CSV
    const renderable = (entry) => isMarkdown(entry) || ['ipynb', 'csv', 'tsv'].includes((entry?.ext || '').toLowerCase());
    function renderRich(file, entry) {
      const ext = (entry.ext || '').toLowerCase();
      if (isMarkdown(entry)) return renderMarkdown(file, entry);
      if (ext === 'ipynb') return renderNotebook(file, entry);
      if (ext === 'csv' || ext === 'tsv') return renderCsv(file, ext === 'tsv' ? '\t' : ',');
      return null;
    }
    function renderText(file, entry) {
      const rich = renderable(entry);
      const toggle = $('.exv-md-toggle');
      toggle.classList.toggle('hidden', !rich);
      toggle.innerHTML = mdRendered ? '<i class="fas fa-code"></i><span>코드</span>' : '<i class="fas fa-book-open"></i><span>미리보기</span>';
      $('[data-act="wrap"]').classList.toggle('hidden', rich && mdRendered);
      let rendered = null;
      if (rich && mdRendered) { try { rendered = renderRich(file, entry); } catch (e) { rendered = null; } }
      bodyEl.innerHTML = metaHtml(file) + (rendered || renderCode({ ...file, name: entry.name, ext: file.ext || entry.ext }));
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
      }
    }
    function fitHwp() {
      const doc = bodyEl.querySelector('.hwp-doc');
      if (!doc) return;
      const widest = Math.max(...[...doc.querySelectorAll('.hwp-page')].map((p) => parseFloat(p.style.width) || 794), 300);
      doc.style.zoom = String(Math.min(1, (bodyEl.clientWidth - 24) / widest));
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
    const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
    function renderPdf(entry, info) {
      pdfInfo = info;
      const zoom = viewOf(entry.path).zoom || 1;
      $('.exv-zoom-label').textContent = `${Math.round(zoom * 100)}%`;
      const available = Math.max(200, bodyEl.clientWidth - 24);
      const cssWidth = Math.round(Math.min(available, 1000) * zoom);
      const pixels = Math.min(2000, Math.round(cssWidth * Math.min(window.devicePixelRatio || 1, 2)));
      const pages = Array.from({ length: info.pages }, (_, i) => {
        const [w, h] = info.sizes[i] || info.sizes[0];
        const src = `/api/fs/pdf/page?path=${encodeURIComponent(entry.path)}&page=${i + 1}&w=${pixels}&v=${info.version}`;
        return `<div class="exv-pdf-page" data-page="${i + 1}" style="width:${cssWidth}px;aspect-ratio:${w} / ${h}"><img src="${src}" alt="${i + 1} 페이지" loading="lazy" decoding="async"></div>`;
      }).join('');
      bodyEl.innerHTML = `${metaHtml(info, ` · ${info.pages}쪽`)}<div class="exv-pdf">${pages}</div>`;
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
    function setZoom(delta) {
      if (!current || !pdfInfo) return;
      const view = viewOf(current.path);
      const index = ZOOMS.indexOf(view.zoom || 1);
      const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (index < 0 ? 3 : index) + delta))];
      const ratio = bodyEl.scrollHeight > bodyEl.clientHeight ? bodyEl.scrollTop / (bodyEl.scrollHeight - bodyEl.clientHeight) : 0;
      view.zoom = next;
      renderPdf(current, pdfInfo);
      bodyEl.scrollTop = ratio * (bodyEl.scrollHeight - bodyEl.clientHeight);
      saveTabs();
    }

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
      $('.exv-md-toggle').classList.toggle('hidden', !md || editing);
      $('.exv-md-toggle').innerHTML = mdRendered ? '<i class="fas fa-code"></i><span>코드</span>' : '<i class="fas fa-book-open"></i><span>미리보기</span>';
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
    function renderEditor(text) {
      const lines = text.split('\n').length;
      bodyEl.innerHTML = `${metaHtml(lastFile, ' · 편집 중')}<div class="exv-editor ${wrap ? 'wrap' : ''}"><pre class="exv-gutter" aria-hidden="true"></pre><textarea class="exv-textarea" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="${wrap ? 'soft' : 'off'}" aria-label="${escapeHtml(current.name)} 편집"></textarea></div>`;
      editorEl = bodyEl.querySelector('.exv-textarea');
      editorEl.value = text;
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
      });
      editorEl.addEventListener('scroll', () => {
        gutter.style.transform = `translateY(${-editorEl.scrollTop}px)`;
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
          img.addEventListener('load', () => { if (seq === renderSeq) restoreScroll(entry); }, { once: true });
          img.addEventListener('click', () => {
            const view = viewOf(entry.path);
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
        const path = link.dataset.exOpen;
        const name = basename(path);
        const dot = name.lastIndexOf('.');
        (options.onOpen || open)({ path, name, type: 'file', ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' });
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
      else if (act === 'zoom-in') setZoom(1);
      else if (act === 'zoom-out') setZoom(-1);
      else if (act === 'md') {
        mdRendered = !mdRendered;
        store.set('md-rendered', mdRendered);
        if (lastFile) { renderText(lastFile, current); bodyEl.scrollTop = 0; }
      } else if (act === 'wrap') {
        wrap = !wrap;
        store.set('wrap', wrap);
        container.querySelector('.exv-code')?.classList.toggle('wrap', wrap);
        container.querySelector('.exv-editor')?.classList.toggle('wrap', wrap);
        editorEl?.setAttribute('wrap', wrap ? 'soft' : 'off');
      }
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

  window.UnivDashExplorer = { mountTree, mountViewer, copyText, loadPrefs, shared };

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
  mountTree(document.getElementById('explorerTree'), {
    initialReveal: new URLSearchParams(location.search).get('path'),
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
