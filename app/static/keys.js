// UnivDash shortcuts (like VS Code): command list, default keys, user keys, key handling.
// - User keys live in localStorage (univdash-keybindings) as { command id: [key, …] }. Only the commands present override their default keys ([] = no key).
// - Keys are written like "ctrl+shift+k"; a two-stroke chord is joined with a space like "g w". mod is ⌘ on Mac, Ctrl elsewhere.
//   Matching is by position (event.code), so the same physical key fires regardless of Korean/English input (t · ㅅ).
// - A command clicks a button on screen (click), focuses an input (focus), or runs an action a page script attached with register.
//   If the button is not on the current screen the command is skipped, and another command on the same key or the browser default follows.
(function () {
  'use strict';
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const STORE = 'univdash-keybindings';
  const CHORD_MS = 1500;   // how long to wait for the second key of a chord
  const SINGLE_MS = 350;   // when a chord also starts with the same key, how long to wait before treating it as a single press

  const SCOPES = {
    global: t('전역'),
    workspace: 'Workspace',
    tabs: t('탭'),
    viewer: t('파일 뷰어 · 탐색기'),
    git: 'Git',
    server: 'Servers',
    ai: 'AI',
  };
  // Keys must not clash only between scopes that share a screen
  const GROUP = { global: '*', workspace: 'ws', tabs: 'ws', viewer: 'ws', git: 'git', server: 'server', ai: 'ai' };

  // [id, scope, name, default keys, action] — action: { click | focus | href } selector, typing: also inside inputs, repeat: repeats while held
  const ACTIONS = [
    ['app.settings', 'global', t('설정 열기'), ['mod+,'], { typing: true }],
    ['app.keybindings', 'global', t('단축키 설정 열기'), ['mod+k mod+s', 'shift+/'], { typing: true }],
    ['app.theme', 'global', t('테마 설정 열기'), ['mod+k mod+t'], { click: '[data-theme-settings]', hiddenOk: true }],
    ['app.toggleMode', 'global', t('다크 · 라이트 모드 바꾸기'), ['mod+k mod+d']],
    ['app.sidebar', 'global', t('메인 사이드바 접기 / 펼치기'), ['mod+b']],
    ['app.search', 'global', t('이 화면의 검색창으로'), ['/'], { focus: '#windowSearch, #gitRepositorySearch, #procSearch, #domainSearch, body[data-page="explorer"] .ex-search input' }],
    ['app.newTerminal', 'global', t('새 Terminal'), ['t']],
    ['app.newSession', 'global', t('새 tmux 세션'), ['t t']],
    ['nav.workspace', 'global', t('Workspace 로 가기'), ['g w'], { href: '/' }],
    ['nav.git', 'global', t('Git 으로 가기'), ['g g'], { href: '/git' }],
    ['nav.ai', 'global', t('AI 로 가기'), ['g a'], { href: '/ai-usage' }],
    ['nav.server', 'global', t('Servers 로 가기'), ['g s'], { href: '/server' }],
    ['nav.domains', 'global', t('Domains 로 가기'), ['g d'], { href: '/domains' }],
    ['app.logout', 'global', t('로그아웃'), []],

    ['ws.toggleLeft', 'workspace', t('창 목록 사이드바 접기 / 펼치기'), ['['], { click: '[data-side-toggle="left"]' }],
    ['ws.toggleRight', 'workspace', t('파일 사이드바 접기 / 펼치기'), [']'], { click: '[data-side-toggle="right"]' }],
    ['ws.swap', 'workspace', t('창 · 파일 사이드바 좌우 바꾸기'), ['\\'], { click: '[data-ws-swap]' }],
    ['ws.modeWindows', 'workspace', t('창 목록 보기'), ['shift+w'], { click: '[data-ws-mode="windows"]' }],
    ['ws.modeFiles', 'workspace', t('파일 목록 보기'), ['shift+e'], { click: '[data-ws-mode="files"]' }],
    ['ws.nextWindow', 'workspace', t('다음 창 열기'), ['j'], { repeat: true }],
    ['ws.prevWindow', 'workspace', t('이전 창 열기'), ['k'], { repeat: true }],
    ['ws.filterAll', 'workspace', t('창 목록: 전체'), ['f a'], { click: '[data-filter="all"]' }],
    ['ws.filterWaiting', 'workspace', t('창 목록: 응답 필요'), ['f w'], { click: '[data-filter="waiting"]' }],
    ['ws.filterBusy', 'workspace', t('창 목록: 작업 중'), ['f b'], { click: '[data-filter="busy"]' }],
    ['ws.filterAgent', 'workspace', t('창 목록: 에이전트'), ['f g'], { click: '[data-filter="agent"]' }],
    ['ws.toggleHidden', 'workspace', t('창 목록: 숨긴 창 보기 / 감추기'), ['f h'], { click: '#toggleHiddenBtn' }],
    ['ws.sort', 'workspace', t('창 목록 정렬 기준'), ['f s'], { click: '#sortBtn' }],
    ['ws.openFiles', 'workspace', t('열린 파일 목록'), [], { click: '#wsOpenFiles' }],
    ['ws.closeAllTabs', 'workspace', t('탭 모두 닫기'), []],
    ['ws.fileWidthReset', 'workspace', t('파일 사이드바 기본 폭으로'), [], { click: '[data-file-width-reset]' }],
    ['term.chat', 'workspace', t('채팅으로 보기'), ['c'], { click: '#termModes [data-mode="log"]' }],
    ['term.screen', 'workspace', t('터미널 화면으로 보기'), ['v'], { click: '#termModes [data-mode="screen"]' }],
    ['term.focusInput', 'workspace', t('프롬프트 입력칸으로'), ['i'], { focus: '#promptInput' }],
    ['term.search', 'workspace', t('채팅 검색 (내 프롬프트 · 최종 답변)'), ['s'], { click: '#chatSearchBtn' }],
    ['term.jumpBottom', 'workspace', t('최신 출력으로 이동'), ['end'], { click: '#jumpBottomBtn' }],
    ['term.loadMore', 'workspace', t('이전 기록 더 불러오기'), ['home'], { click: '#loadMoreBtn' }],
    ['term.menu', 'workspace', t('창 메뉴'), ['m'], { click: '#termMoreBtn' }],
    ['term.view', 'workspace', t('보기 설정'), ['shift+v'], { click: '#termViewBtn' }],
    ['term.history', 'workspace', t('히스토리 (최근 프롬프트 · 빠른 문구)'), ['h'], { click: '#snippetBtn' }],
    ['term.model', 'workspace', t('모델 바꾸기'), ['shift+m'], { click: '#modelBtn' }],
    ['term.attach', 'workspace', t('사진 · 파일 첨부'), ['shift+a'], { click: '#attachBtn' }],
    ['term.direct', 'workspace', t('터미널 직접 입력 모드'), ['d'], { click: '#directBtn' }],
    ['term.keyBar', 'workspace', t('키 버튼 줄 접기 / 펼치기'), ['shift+k'], { click: '#keyBarToggle' }],
    ['term.sendEsc', 'workspace', t('에이전트에 Esc 보내기'), [], { click: '#keyBar [data-keys="Escape"]' }],
    ['term.sendShiftTab', 'workspace', t('에이전트에 Shift+Tab 보내기 (모드 전환)'), [], { click: '#keyBar [data-keys="BTab"]' }],
    ['term.sendCtrlC', 'workspace', t('에이전트에 Ctrl+C 보내기'), [], { click: '#keyBar [data-keys="C-c"]' }],
    ['term.update', 'workspace', t('에이전트 업데이트 후 다시 켜기'), [], { click: '#agentUpdateBtn' }],
    ['term.codexAccount', 'workspace', t('계정 바꾸기 (Claude · Codex · Gemini)'), [], { click: '#codexAccountBtn' }],
    ['term.agentSwitch', 'workspace', t('다른 에이전트로 바꾸기'), [], { click: '#agentSwitchBtn' }],
    ['term.back', 'workspace', t('목록으로 돌아가기 (휴대폰)'), [], { click: '#termBack, #ptyBack' }],
    ['pty.kill', 'workspace', t('이 Terminal 끝내기'), [], { click: '#ptyKill' }],

    ['tab.close', 'tabs', t('지금 탭 닫기'), ['w']],
    ['tab.next', 'tabs', t('다음 탭'), ['right'], { repeat: true }],
    ['tab.prev', 'tabs', t('이전 탭'), ['left'], { repeat: true }],
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab.${n}`, 'tabs', t('{n}번째 탭', { n }), [String(n)]]),

    ['view.zoomIn', 'viewer', t('확대'), ['=', 'shift+=', 'numpad_add'], { repeat: true }],
    ['view.zoomOut', 'viewer', t('축소'), ['-', 'numpad_subtract'], { repeat: true }],
    ['view.zoomReset', 'viewer', t('원래 크기'), ['0', 'numpad0']],
    ['view.prevImage', 'viewer', t('이전 그림 (같은 폴더)'), [','], { repeat: true }],
    ['view.nextImage', 'viewer', t('다음 그림 (같은 폴더)'), ['.'], { repeat: true }],
    ['find.open', 'viewer', t('파일 안에서 찾기'), ['mod+f'], { typing: true }],
    ['find.replace', 'viewer', t('파일 안에서 바꾸기'), isMac ? ['meta+alt+f'] : ['ctrl+h'], { typing: true }],
    ['find.next', 'viewer', t('다음 찾기'), ['f3'], { typing: true, repeat: true }],
    ['find.prev', 'viewer', t('이전 찾기'), ['shift+f3'], { typing: true, repeat: true }],
    ['view.edit', 'viewer', t('편집 시작'), ['e'], { click: '[data-act="edit"]' }],
    ['view.mdToggle', 'viewer', t('미리보기 / 코드 전환'), ['p'], { click: '[data-act="md"]' }],
    ['view.wrap', 'viewer', t('줄바꿈 켜기 / 끄기'), ['alt+z'], { click: '[data-act="wrap"]' }],
    ['view.reload', 'viewer', t('파일 다시 불러오기'), ['r'], { click: '[data-act="reload"]' }],
    ['view.download', 'viewer', t('파일 다운로드'), ['shift+d'], { click: '[data-act="download"]' }],
    ['view.copyPath', 'viewer', t('파일 경로 복사'), ['y'], { click: '[data-act="copy-path"]' }],
    ['view.insertPath', 'viewer', t('프롬프트에 파일 경로 넣기'), ['shift+i'], { click: '[data-act="insert"]' }],
    ['view.pdf', 'viewer', t('PDF 로 저장'), ['shift+p'], { click: '[data-act="mdpdf"]' }],
    ['view.autosave', 'viewer', t('자동 저장 켜기 / 끄기'), [], { click: '[data-act="autosave"]' }],
    ['view.revert', 'viewer', t('저장 안 한 변경 버리기'), [], { click: '[data-act="revert"]' }],
    ['tree.search', 'viewer', t('파일 · 폴더 이름 검색'), ['mod+p'], { focus: '.ex-search input' }],
    ['tree.newFile', 'viewer', t('새 파일'), ['n'], { click: '[data-act="new-file"]' }],
    ['tree.newFolder', 'viewer', t('새 폴더'), ['shift+n'], { click: '[data-act="new-folder"]' }],
    ['tree.upload', 'viewer', t('선택한 폴더에 업로드'), ['shift+u'], { click: '[data-act="upload"]' }],
    ['tree.refresh', 'viewer', t('파일 트리 새로고침'), ['shift+r'], { click: '[data-act="refresh"]' }],
    ['tree.collapse', 'viewer', t('폴더 모두 접기'), [], { click: '[data-act="collapse"]' }],
    ['tree.root', 'viewer', t('루트 폴더 바꾸기'), [], { click: '[data-act="root"]' }],
    ['tree.more', 'viewer', t('파일 트리 보기 · 정렬'), [], { click: '[data-act="more"]' }],

    ['git.refresh', 'git', t('저장소 목록 새로고침'), ['r'], { click: '#gitRefreshRepositories' }],
    ['git.fetch', 'git', 'Fetch', ['shift+f'], { click: '[data-git-action="fetch"]' }],
    ['git.pull', 'git', 'Pull', ['shift+l'], { click: '[data-git-action="pull"]' }],
    ['git.push', 'git', 'Push', ['shift+u'], { click: '[data-git-action="push"]' }],
    ['git.more', 'git', t('추가 작업 메뉴'), ['m'], { click: '#gitMoreButton' }],
    ['git.commit', 'git', t('커밋'), ['shift+c'], { click: '#gitCommitButton' }],
    ['git.commitPush', 'git', t('커밋 후 푸시'), [], { click: '#gitCommitPushButton' }],
    ['git.aiMessage', 'git', t('AI 커밋 메시지 쓰기'), ['shift+m'], { click: '#gitAiMessage' }],
    ['git.allInOne', 'git', t('정리 → AI 메시지 → 커밋 → 푸시'), [], { click: '#gitAllInOneButton' }],
    ['git.ruff', 'git', t('ruff format 실행'), [], { click: '#gitRuffButton' }],
    ['git.stageAll', 'git', t('모두 스테이징'), ['shift+s'], { click: '#gitStageAll' }],
    ['git.unstageAll', 'git', t('모두 스테이징 취소'), [], { click: '#gitUnstageAll' }],
    ['git.discardAll', 'git', t('모든 변경 되돌리기'), [], { click: '#gitDiscardAll' }],
    ['git.tabChanges', 'git', t('변경 사항 탭'), ['1'], { click: '[data-git-tab="changes"]' }],
    ['git.tabCommits', 'git', t('커밋 탭'), ['2'], { click: '[data-git-tab="commits"]' }],
    ['git.tabBranches', 'git', t('브랜치 탭'), ['3'], { click: '[data-git-tab="branches"]' }],
    ['git.tabStashes', 'git', t('Stash 탭'), ['4'], { click: '[data-git-tab="stashes"]' }],
    ['git.tabConsole', 'git', t('콘솔 탭'), ['5'], { click: '[data-git-tab="console"]' }],
    ['git.filterAll', 'git', t('저장소: 전체'), [], { click: '[data-git-filter="all"]' }],
    ['git.filterDirty', 'git', t('저장소: 변경 있음'), [], { click: '[data-git-filter="dirty"]' }],
    ['git.filterSync', 'git', t('저장소: 동기화 필요'), [], { click: '[data-git-filter="sync"]' }],
    ['git.sort', 'git', t('저장소 정렬 기준'), [], { click: '#gitSortBtn' }],
    ['git.toggleHidden', 'git', t('숨긴 저장소 보기 / 감추기'), ['shift+h'], { click: '#gitToggleHidden' }],
    ['git.newFolder', 'git', t('새 폴더'), [], { click: '#gitNewFolder' }],

    ['server.reload', 'server', t('새로고침'), ['r'], { click: '#pageReloadButton' }],
    ['server.save', 'server', t('PM2 목록 저장 (pm2 save)'), ['shift+s'], { click: '#pm2SaveButton' }],
    ['server.restartAll', 'server', t('모든 PM2 앱 재시작'), [], { click: '#pm2RestartAllButton' }],
    ['server.ecoAdd', 'server', t('ecosystem 에 새 앱 추가'), ['n'], { click: '#ecoAddBtn' }],

    ['ai.refresh', 'ai', t('새로고침'), ['r'], { click: '#aiUsageRefresh' }],
    ['ai.days1', 'ai', t('최근 1일'), ['1'], { click: '[data-ai-days="1"]' }],
    ['ai.days7', 'ai', t('최근 7일'), ['2'], { click: '[data-ai-days="7"]' }],
    ['ai.days30', 'ai', t('최근 30일'), ['3'], { click: '[data-ai-days="30"]' }],
  ].map(([id, scope, label, keys, extra = {}]) => ({ id, scope, label, defaults: keys, ...extra }));
  const byId = new Map(ACTIONS.map((a) => [a.id, a]));

  // ── Key names ─────────────────────────────────────────────────────────
  const CODE_NAMES = {
    Space: 'space', Enter: 'enter', NumpadEnter: 'enter', Escape: 'escape', Backspace: 'backspace', Tab: 'tab',
    Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Backquote: '`', IntlBackslash: '\\',
    NumpadAdd: 'numpad_add', NumpadSubtract: 'numpad_subtract', NumpadMultiply: 'numpad_multiply',
    NumpadDivide: 'numpad_divide', NumpadDecimal: 'numpad_decimal',
  };
  const VALID = new Set([
    ...Object.values(CODE_NAMES),
    ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
    ...Array.from({ length: 10 }, (_, n) => `numpad${n}`),
    ...Array.from({ length: 24 }, (_, n) => `f${n + 1}`),
  ]);
  const MODS = ['ctrl', 'shift', 'alt', 'meta'];
  const MOD_ALIAS = { control: 'ctrl', cmd: 'meta', command: 'meta', super: 'meta', win: 'meta', option: 'alt', opt: 'alt', mod: isMac ? 'meta' : 'ctrl' };

  function keyName(code) {
    if (!code) return null;
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1].toLowerCase();
    m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (m) return code.startsWith('Numpad') ? `numpad${m[1]}` : m[1];
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
    return CODE_NAMES[code] || null;
  }
  // One key press → "ctrl+shift+k". null when only modifier keys were pressed
  function strokeOf(event) {
    const key = keyName(event.code);
    if (!key) return null;
    return [...MODS.filter((mod) => event[`${mod}Key`]), key].join('+');
  }
  // Key written as text → canonical form ("Ctrl+K  Ctrl+S" → "ctrl+k ctrl+s"). null for an invalid key
  function normalize(text) {
    if (typeof text !== 'string' || text.length > 80) return null;
    const strokes = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!strokes.length || strokes.length > 2) return null;
    const out = [];
    for (const stroke of strokes) {
      const parts = stroke.split('+');
      const key = parts.pop();
      const mods = new Set(parts.map((p) => MOD_ALIAS[p] || p));
      if (![...mods].every((m) => MODS.includes(m)) || !VALID.has(key)) return null;
      out.push([...MODS.filter((m) => mods.has(m)), key].join('+'));
    }
    return out.join(' ');
  }
  // For saving / exporting: turn this device's primary modifier (⌘ on Mac, Ctrl elsewhere) into mod so it maps to the same place on another OS
  const portable = (binding) => binding.split(' ').map((s) => s.split('+').map((p) => (p === (isMac ? 'meta' : 'ctrl') ? 'mod' : p)).join('+')).join(' ');

  const SHOW = {
    ctrl: isMac ? '⌃' : 'Ctrl', shift: isMac ? '⇧' : 'Shift', alt: isMac ? '⌥' : 'Alt', meta: isMac ? '⌘' : 'Meta',
    left: '←', right: '→', up: '↑', down: '↓', escape: 'Esc', enter: 'Enter', space: 'Space', backspace: 'Backspace',
    tab: 'Tab', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
    numpad_add: 'Num +', numpad_subtract: 'Num -', numpad_multiply: 'Num *', numpad_divide: 'Num /', numpad_decimal: 'Num .',
  };
  const showPart = (p) => SHOW[p] || (/^numpad\d$/.test(p) ? `Num ${p.slice(6)}` : p.toUpperCase());
  // Display text: an array with one entry per stroke (["Ctrl+K", "Ctrl+S"])
  const label = (binding) => binding.split(' ').map((s) => s.split('+').map(showPart).join(isMac ? '' : '+'));

  // ── User keys ─────────────────────────────────────────────────────────
  function readUser() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (e) { return {}; }
  }
  let user = readUser();
  const has = (id) => Object.prototype.hasOwnProperty.call(user, id) && Array.isArray(user[id]);
  const unique = (list) => [...new Set(list.map(normalize).filter(Boolean))];
  const keysOf = (id) => unique(has(id) ? user[id] : byId.get(id)?.defaults || []);
  const defaultsOf = (id) => unique(byId.get(id)?.defaults || []);
  const same = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);
  const isDefault = (id) => !has(id) || same(keysOf(id), defaultsOf(id));

  let index = new Map();      // "g w" → [id, …]
  let prefixes = new Map();   // "g" → [id, …] (first key of a chord)
  function rebuild() {
    index = new Map();
    prefixes = new Map();
    for (const action of ACTIONS) {
      for (const binding of keysOf(action.id)) {
        (index.get(binding) || index.set(binding, []).get(binding)).push(action.id);
        const [first, second] = binding.split(' ');
        if (second) (prefixes.get(first) || prefixes.set(first, []).get(first)).push(action.id);
      }
    }
  }
  rebuild();

  function save(next) {
    user = next;
    // Entries equal to the default are removed (so they follow if the default key changes later)
    for (const id of Object.keys(user)) if (!byId.has(id) || same(unique(user[id]), defaultsOf(id))) delete user[id];
    try {
      if (Object.keys(user).length) localStorage.setItem(STORE, JSON.stringify(user));
      else localStorage.removeItem(STORE);
    } catch (e) { /* storage unavailable */ }
    rebuild();
    window.dispatchEvent(new CustomEvent('univdash:keybindings'));
  }
  function setKeys(id, keys) {
    if (!byId.has(id)) return;
    save({ ...user, [id]: unique(keys).map(portable) });
  }
  function reset(id) { const next = { ...user }; delete next[id]; save(next); }
  function resetAll() { save({}); }
  // Keys changed in another tab are followed too
  window.addEventListener('storage', (event) => {
    if (event.key !== STORE && event.key !== null) return;
    user = readUser();
    rebuild();
    window.dispatchEvent(new CustomEvent('univdash:keybindings'));
  });

  // Other commands on the same screen that use the same key (or where one is the first key of the other's chord)
  function conflicts(id, binding) {
    const group = GROUP[byId.get(id)?.scope];
    const first = binding.split(' ')[0];
    return ACTIONS.filter((other) => {
      if (other.id === id) return false;
      const otherGroup = GROUP[other.scope];
      if (group !== '*' && otherGroup !== '*' && group !== otherGroup) return false;
      return keysOf(other.id).some((k) => k === binding || (binding.includes(' ') && k === first) || k.split(' ')[0] === binding && k.includes(' '));
    });
  }

  // ── Running ───────────────────────────────────────────────────────────
  // With several matching buttons on screen (viewers in a split, etc.), the one closest to where the user last pressed or focused
  let lastTarget = null;
  document.addEventListener('pointerdown', (event) => { lastTarget = event.target; }, true);
  document.addEventListener('focusin', (event) => { lastTarget = event.target; }, true);
  const shown = (el) => el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.disabled;
  function pick(selector, hiddenOk = false) {
    const all = [...document.querySelectorAll(selector)];
    const list = all.filter(shown);
    if (!list.length) return hiddenOk ? all[0] || null : null;
    if (list.length === 1 || !lastTarget?.isConnected) return list[0];
    const score = (el) => {
      let node = el;
      while (node && !node.contains(lastTarget)) node = node.parentElement;
      let depth = 0;
      for (; node; node = node.parentElement) depth += 1;
      return depth;
    };
    return list.reduce((best, el) => (score(el) > score(best) ? el : best));
  }

  const handlers = new Map();   // id → [{ run, when }]
  // Page scripts attach a command's action. If run returns false it counts as not handled.
  function register(id, run, when = () => true) {
    if (!byId.has(id)) { console.warn('Unknown shortcut command', id); return; }
    (handlers.get(id) || handlers.set(id, []).get(id)).push({ run, when });
  }
  function target(action) {
    if (action.click) return pick(action.click, action.hiddenOk);
    if (action.focus) return pick(action.focus);
    return null;
  }
  // Whether this command can run right now (without running it)
  function available(action) {
    if ((handlers.get(action.id) || []).some((h) => h.when())) return true;
    if (action.href) return location.pathname !== action.href;
    return !!target(action);
  }
  function attempt(id, event) {
    const action = byId.get(id);
    for (const handler of handlers.get(id) || []) {
      if (handler.when() && handler.run(event) !== false) return true;
    }
    if (action.href) {
      if (location.pathname === action.href) return false;
      location.href = action.href;
      return true;
    }
    const el = target(action);
    if (!el) return false;
    if (action.focus) { el.focus(); el.select?.(); } else el.click();
    return true;
  }
  function run(id, event = null) { return byId.has(id) && attempt(id, event); }

  const modalOpen = () => [...document.querySelectorAll('[aria-modal="true"], .pmd-theme-overlay:not([hidden])')].some(shown);
  let paused = 0;   // while a key is being recorded in the settings window
  let pending = null;
  function clearPending() { if (pending) clearTimeout(pending.timer); pending = null; }
  function usable(id, event, typing) {
    const action = byId.get(id);
    return action && (!typing || action.typing) && (!event.repeat || action.repeat) && available(action);
  }
  const firstOf = (ids, event) => ids.some((id) => attempt(id, event));
  const stop = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };

  function onKey(event) {
    if (paused || event.isComposing || event.keyCode === 229) return;
    const stroke = strokeOf(event);
    if (!stroke) return;
    // Every key goes straight through to the terminal (including direct input)
    if (event.target?.closest?.('.xterm, #directInput') || modalOpen()) { clearPending(); return; }
    const typing = window.UnivDash?.typingOrBusy(event) ?? false;
    if (pending) {
      const before = pending;
      clearPending();
      const ids = (index.get(`${before.stroke} ${stroke}`) || []).filter((id) => usable(id, event, typing));
      if (ids.length && firstOf(ids, event)) { stop(event); return; }
      if (before.singles.length) firstOf(before.singles, before.event);
    }
    const singles = (index.get(stroke) || []).filter((id) => usable(id, event, typing));
    const chords = (prefixes.get(stroke) || []).filter((id) => usable(id, event, typing));
    if (chords.length) {
      stop(event);
      pending = {
        stroke, singles, event,
        timer: setTimeout(() => {
          const was = pending;
          pending = null;
          if (was?.singles.length) firstOf(was.singles, was.event);
        }, singles.length ? SINGLE_MS : CHORD_MS),
      };
      return;
    }
    if (singles.length && firstOf(singles, event)) stop(event);
  }
  window.addEventListener('keydown', onKey, true);

  window.UnivDashKeys = {
    isMac, SCOPES, actions: ACTIONS, register, run,
    keysOf, defaultsOf, isDefault, setKeys, reset, resetAll, conflicts,
    strokeOf, normalize, label, portable,
    overrides: () => JSON.parse(JSON.stringify(user)),
    replaceAll(next) {
      const clean = {};
      let skipped = 0;
      for (const [id, keys] of Object.entries(next || {})) {
        if (!byId.has(id) || !Array.isArray(keys) || keys.length > 8) { skipped += 1; continue; }
        const valid = keys.filter((k) => normalize(k));
        if (valid.length !== keys.length) skipped += 1;
        clean[id] = valid.slice(0, 8).map((k) => portable(normalize(k)));
      }
      save(clean);
      return { applied: Object.keys(clean).length, skipped };
    },
    pause() { paused += 1; clearPending(); },
    resume() { paused = Math.max(0, paused - 1); },
  };
})();
