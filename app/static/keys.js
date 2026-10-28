// UnivDash 단축키 (VS Code 처럼): 명령 목록 · 기본 키 · 사용자 키 · 키 입력 처리.
// - 사용자 키는 localStorage(univdash-keybindings)에 { 명령 id: [키, …] } 로 둔다. 있는 명령만 기본 키를 덮어쓴다 ([] = 키 없음).
// - 키는 "ctrl+shift+k" 처럼 쓰고, 두 번 이어 누르는 조합은 "g w" 처럼 공백으로 잇는다. mod 는 맥에서 ⌘, 그 밖에는 Ctrl.
//   자리(event.code)로 보므로 한/영 상관없이 같은 자리 키가 눌린다 (t · ㅅ).
// - 명령은 화면의 버튼을 대신 누르거나(click) 입력칸에 초점을 주거나(focus), 페이지 스크립트가 register 로 붙인 동작을 한다.
//   지금 화면에 해당 버튼이 없으면 그 명령은 건너뛰고, 같은 키의 다른 명령이나 브라우저 기본 동작이 이어진다.
(function () {
  'use strict';
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const STORE = 'univdash-keybindings';
  const CHORD_MS = 1500;   // 두 키 조합에서 두 번째 키를 기다리는 시간
  const SINGLE_MS = 350;   // 같은 키로 시작하는 두 키 조합도 있을 때, 한 번만 누른 것으로 볼 때까지 기다리는 시간

  const SCOPES = {
    global: '전역',
    workspace: 'Workspace',
    tabs: '탭',
    viewer: '파일 뷰어 · 탐색기',
    git: 'Git',
    server: 'Servers',
    ai: 'AI Usage',
  };
  // 같은 화면에 함께 있는 범위끼리만 키가 겹치면 안 된다
  const GROUP = { global: '*', workspace: 'ws', tabs: 'ws', viewer: 'ws', git: 'git', server: 'server', ai: 'ai' };

  // [id, 범위, 이름, 기본 키, 동작] — 동작: { click | focus | href } 선택자, typing: 입력칸에서도, repeat: 누르고 있으면 반복
  const ACTIONS = [
    ['app.settings', 'global', '설정 열기', ['mod+,'], { typing: true }],
    ['app.keybindings', 'global', '단축키 설정 열기', ['mod+k mod+s', 'shift+/'], { typing: true }],
    ['app.theme', 'global', '테마 설정 열기', ['mod+k mod+t'], { click: '[data-theme-settings]', hiddenOk: true }],
    ['app.toggleMode', 'global', '다크 · 라이트 모드 바꾸기', ['mod+k mod+d']],
    ['app.sidebar', 'global', '메인 사이드바 접기 / 펼치기', ['mod+b']],
    ['app.search', 'global', '이 화면의 검색창으로', ['/'], { focus: '#windowSearch, #gitRepositorySearch, #procSearch, body[data-page="explorer"] .ex-search input' }],
    ['app.newTerminal', 'global', '새 Terminal', ['t']],
    ['app.newSession', 'global', '새 tmux 세션', ['t t']],
    ['nav.workspace', 'global', 'Workspace 로 가기', ['g w'], { href: '/' }],
    ['nav.explorer', 'global', 'Explorer 로 가기', ['g e'], { href: '/explorer' }],
    ['nav.git', 'global', 'Git 으로 가기', ['g g'], { href: '/git' }],
    ['nav.ai', 'global', 'AI Usage 로 가기', ['g a'], { href: '/ai-usage' }],
    ['nav.server', 'global', 'Servers 로 가기', ['g s'], { href: '/server' }],
    ['app.logout', 'global', '로그아웃', [], { click: '.sb-logout', hiddenOk: true }],

    ['ws.toggleLeft', 'workspace', '창 목록 사이드바 접기 / 펼치기', ['['], { click: '[data-side-toggle="left"]' }],
    ['ws.toggleRight', 'workspace', '파일 사이드바 접기 / 펼치기', [']'], { click: '[data-side-toggle="right"]' }],
    ['ws.swap', 'workspace', '창 · 파일 사이드바 좌우 바꾸기', ['\\'], { click: '[data-ws-swap]' }],
    ['ws.modeWindows', 'workspace', '창 목록 보기', ['shift+w'], { click: '[data-ws-mode="windows"]' }],
    ['ws.modeFiles', 'workspace', '파일 목록 보기', ['shift+e'], { click: '[data-ws-mode="files"]' }],
    ['ws.nextWindow', 'workspace', '다음 창 열기', ['j'], { repeat: true }],
    ['ws.prevWindow', 'workspace', '이전 창 열기', ['k'], { repeat: true }],
    ['ws.filterAll', 'workspace', '창 목록: 전체', ['f a'], { click: '[data-filter="all"]' }],
    ['ws.filterWaiting', 'workspace', '창 목록: 응답 필요', ['f w'], { click: '[data-filter="waiting"]' }],
    ['ws.filterBusy', 'workspace', '창 목록: 작업 중', ['f b'], { click: '[data-filter="busy"]' }],
    ['ws.filterAgent', 'workspace', '창 목록: 에이전트', ['f g'], { click: '[data-filter="agent"]' }],
    ['ws.toggleHidden', 'workspace', '창 목록: 숨긴 창 보기 / 감추기', ['f h'], { click: '#toggleHiddenBtn' }],
    ['ws.sort', 'workspace', '창 목록 정렬 기준', ['f s'], { click: '#sortBtn' }],
    ['ws.openFiles', 'workspace', '열린 파일 목록', [], { click: '#wsOpenFiles' }],
    ['ws.fileWidthReset', 'workspace', '파일 사이드바 기본 폭으로', [], { click: '[data-file-width-reset]' }],
    ['term.chat', 'workspace', '채팅으로 보기', ['c'], { click: '#termModes [data-mode="log"]' }],
    ['term.screen', 'workspace', '터미널 화면으로 보기', ['v'], { click: '#termModes [data-mode="screen"]' }],
    ['term.focusInput', 'workspace', '프롬프트 입력칸으로', ['i'], { focus: '#promptInput' }],
    ['term.jumpBottom', 'workspace', '최신 출력으로 이동', ['end'], { click: '#jumpBottomBtn' }],
    ['term.loadMore', 'workspace', '이전 기록 더 불러오기', ['home'], { click: '#loadMoreBtn' }],
    ['term.menu', 'workspace', '창 메뉴', ['m'], { click: '#termMoreBtn' }],
    ['term.view', 'workspace', '보기 설정', ['shift+v'], { click: '#termViewBtn' }],
    ['term.history', 'workspace', '히스토리 (최근 프롬프트 · 빠른 문구)', ['h'], { click: '#snippetBtn' }],
    ['term.model', 'workspace', '모델 바꾸기', ['shift+m'], { click: '#modelBtn' }],
    ['term.attach', 'workspace', '사진 · 파일 첨부', ['shift+a'], { click: '#attachBtn' }],
    ['term.direct', 'workspace', '터미널 직접 입력 모드', ['d'], { click: '#directBtn' }],
    ['term.keyBar', 'workspace', '키 버튼 줄 접기 / 펼치기', ['shift+k'], { click: '#keyBarToggle' }],
    ['term.sendEsc', 'workspace', '에이전트에 Esc 보내기', [], { click: '#keyBar [data-keys="Escape"]' }],
    ['term.sendShiftTab', 'workspace', '에이전트에 Shift+Tab 보내기 (모드 전환)', [], { click: '#keyBar [data-keys="BTab"]' }],
    ['term.sendCtrlC', 'workspace', '에이전트에 Ctrl+C 보내기', [], { click: '#keyBar [data-keys="C-c"]' }],
    ['term.update', 'workspace', '에이전트 업데이트 후 다시 켜기', [], { click: '#agentUpdateBtn' }],
    ['term.codexAccount', 'workspace', 'Codex 계정 바꾸기', [], { click: '#codexAccountBtn' }],
    ['term.agentSwitch', 'workspace', '다른 에이전트로 바꾸기', [], { click: '#agentSwitchBtn' }],
    ['term.back', 'workspace', '목록으로 돌아가기 (휴대폰)', [], { click: '#termBack, #ptyBack' }],
    ['pty.kill', 'workspace', '이 Terminal 끝내기', [], { click: '#ptyKill' }],

    ['tab.close', 'tabs', '지금 탭 닫기', ['w']],
    ['tab.next', 'tabs', '다음 탭', ['right'], { repeat: true }],
    ['tab.prev', 'tabs', '이전 탭', ['left'], { repeat: true }],
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab.${n}`, 'tabs', `${n}번째 탭`, [String(n)]]),

    ['view.zoomIn', 'viewer', '확대', ['=', 'shift+=', 'numpad_add'], { repeat: true }],
    ['view.zoomOut', 'viewer', '축소', ['-', 'numpad_subtract'], { repeat: true }],
    ['view.zoomReset', 'viewer', '원래 크기', ['0', 'numpad0']],
    ['find.open', 'viewer', '파일 안에서 찾기', ['mod+f'], { typing: true }],
    ['find.replace', 'viewer', '파일 안에서 바꾸기', isMac ? ['meta+alt+f'] : ['ctrl+h'], { typing: true }],
    ['find.next', 'viewer', '다음 찾기', ['f3'], { typing: true, repeat: true }],
    ['find.prev', 'viewer', '이전 찾기', ['shift+f3'], { typing: true, repeat: true }],
    ['view.edit', 'viewer', '편집 시작', ['e'], { click: '[data-act="edit"]' }],
    ['view.mdToggle', 'viewer', '미리보기 / 코드 전환', ['p'], { click: '[data-act="md"]' }],
    ['view.wrap', 'viewer', '줄바꿈 켜기 / 끄기', ['alt+z'], { click: '[data-act="wrap"]' }],
    ['view.reload', 'viewer', '파일 다시 불러오기', ['r'], { click: '[data-act="reload"]' }],
    ['view.download', 'viewer', '파일 다운로드', ['shift+d'], { click: '[data-act="download"]' }],
    ['view.copyPath', 'viewer', '파일 경로 복사', ['y'], { click: '[data-act="copy-path"]' }],
    ['view.insertPath', 'viewer', '프롬프트에 파일 경로 넣기', ['shift+i'], { click: '[data-act="insert"]' }],
    ['view.pdf', 'viewer', 'PDF 로 저장', ['shift+p'], { click: '[data-act="mdpdf"]' }],
    ['view.autosave', 'viewer', '자동 저장 켜기 / 끄기', [], { click: '[data-act="autosave"]' }],
    ['view.revert', 'viewer', '저장 안 한 변경 버리기', [], { click: '[data-act="revert"]' }],
    ['tree.search', 'viewer', '파일 · 폴더 이름 검색', ['mod+p'], { focus: '.ex-search input' }],
    ['tree.newFile', 'viewer', '새 파일', ['n'], { click: '[data-act="new-file"]' }],
    ['tree.newFolder', 'viewer', '새 폴더', ['shift+n'], { click: '[data-act="new-folder"]' }],
    ['tree.upload', 'viewer', '선택한 폴더에 업로드', ['shift+u'], { click: '[data-act="upload"]' }],
    ['tree.refresh', 'viewer', '파일 트리 새로고침', ['shift+r'], { click: '[data-act="refresh"]' }],
    ['tree.collapse', 'viewer', '폴더 모두 접기', [], { click: '[data-act="collapse"]' }],
    ['tree.root', 'viewer', '루트 폴더 바꾸기', [], { click: '[data-act="root"]' }],
    ['tree.more', 'viewer', '파일 트리 보기 · 정렬', [], { click: '[data-act="more"]' }],

    ['git.refresh', 'git', '저장소 목록 새로고침', ['r'], { click: '#gitRefreshRepositories' }],
    ['git.fetch', 'git', 'Fetch', ['shift+f'], { click: '[data-git-action="fetch"]' }],
    ['git.pull', 'git', 'Pull', ['shift+l'], { click: '[data-git-action="pull"]' }],
    ['git.push', 'git', 'Push', ['shift+u'], { click: '[data-git-action="push"]' }],
    ['git.more', 'git', '추가 작업 메뉴', ['m'], { click: '#gitMoreButton' }],
    ['git.commit', 'git', '커밋', ['shift+c'], { click: '#gitCommitButton' }],
    ['git.commitPush', 'git', '커밋 후 푸시', [], { click: '#gitCommitPushButton' }],
    ['git.aiMessage', 'git', 'AI 커밋 메시지 쓰기', ['shift+m'], { click: '#gitAiMessage' }],
    ['git.allInOne', 'git', '정리 → AI 메시지 → 커밋 → 푸시', [], { click: '#gitAllInOneButton' }],
    ['git.ruff', 'git', 'ruff format 실행', [], { click: '#gitRuffButton' }],
    ['git.stageAll', 'git', '모두 스테이징', ['shift+s'], { click: '#gitStageAll' }],
    ['git.unstageAll', 'git', '모두 스테이징 취소', [], { click: '#gitUnstageAll' }],
    ['git.discardAll', 'git', '모든 변경 되돌리기', [], { click: '#gitDiscardAll' }],
    ['git.tabChanges', 'git', '변경 사항 탭', ['1'], { click: '[data-git-tab="changes"]' }],
    ['git.tabCommits', 'git', '커밋 탭', ['2'], { click: '[data-git-tab="commits"]' }],
    ['git.tabBranches', 'git', '브랜치 탭', ['3'], { click: '[data-git-tab="branches"]' }],
    ['git.tabStashes', 'git', 'Stash 탭', ['4'], { click: '[data-git-tab="stashes"]' }],
    ['git.tabConsole', 'git', '콘솔 탭', ['5'], { click: '[data-git-tab="console"]' }],
    ['git.filterAll', 'git', '저장소: 전체', [], { click: '[data-git-filter="all"]' }],
    ['git.filterDirty', 'git', '저장소: 변경 있음', [], { click: '[data-git-filter="dirty"]' }],
    ['git.filterSync', 'git', '저장소: 동기화 필요', [], { click: '[data-git-filter="sync"]' }],
    ['git.sort', 'git', '저장소 정렬 기준', [], { click: '#gitSortBtn' }],
    ['git.toggleHidden', 'git', '숨긴 저장소 보기 / 감추기', ['shift+h'], { click: '#gitToggleHidden' }],
    ['git.newFolder', 'git', '새 폴더', [], { click: '#gitNewFolder' }],

    ['server.reload', 'server', '새로고침', ['r'], { click: '#pageReloadButton' }],
    ['server.save', 'server', 'PM2 목록 저장 (pm2 save)', ['shift+s'], { click: '#pm2SaveButton' }],
    ['server.restartAll', 'server', '모든 PM2 앱 재시작', [], { click: '#pm2RestartAllButton' }],
    ['server.ecoAdd', 'server', 'ecosystem 에 새 앱 추가', ['n'], { click: '#ecoAddBtn' }],

    ['ai.refresh', 'ai', '새로고침', ['r'], { click: '#aiUsageRefresh' }],
    ['ai.days1', 'ai', '최근 1일', ['1'], { click: '[data-ai-days="1"]' }],
    ['ai.days7', 'ai', '최근 7일', ['2'], { click: '[data-ai-days="7"]' }],
    ['ai.days30', 'ai', '최근 30일', ['3'], { click: '[data-ai-days="30"]' }],
  ].map(([id, scope, label, keys, extra = {}]) => ({ id, scope, label, defaults: keys, ...extra }));
  const byId = new Map(ACTIONS.map((a) => [a.id, a]));

  // ── 키 이름 ───────────────────────────────────────────────────────────
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
  // 눌린 키 한 번 → "ctrl+shift+k". 수정 키만 누른 것이면 null
  function strokeOf(event) {
    const key = keyName(event.code);
    if (!key) return null;
    return [...MODS.filter((mod) => event[`${mod}Key`]), key].join('+');
  }
  // 글로 쓴 키 → 정해진 모양 ("Ctrl+K  Ctrl+S" → "ctrl+k ctrl+s"). 잘못된 키면 null
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
  // 저장 · 내보내기용: 이 기기의 주 수정 키(맥 ⌘ · 그 밖 Ctrl)를 mod 로 바꿔 다른 OS 에서도 같은 자리로 쓰이게
  const portable = (binding) => binding.split(' ').map((s) => s.split('+').map((p) => (p === (isMac ? 'meta' : 'ctrl') ? 'mod' : p)).join('+')).join(' ');

  const SHOW = {
    ctrl: isMac ? '⌃' : 'Ctrl', shift: isMac ? '⇧' : 'Shift', alt: isMac ? '⌥' : 'Alt', meta: isMac ? '⌘' : 'Meta',
    left: '←', right: '→', up: '↑', down: '↓', escape: 'Esc', enter: 'Enter', space: 'Space', backspace: 'Backspace',
    tab: 'Tab', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
    numpad_add: 'Num +', numpad_subtract: 'Num -', numpad_multiply: 'Num *', numpad_divide: 'Num /', numpad_decimal: 'Num .',
  };
  const showPart = (p) => SHOW[p] || (/^numpad\d$/.test(p) ? `Num ${p.slice(6)}` : p.toUpperCase());
  // 화면에 보일 글: 키 조합마다 배열 (["Ctrl+K", "Ctrl+S"])
  const label = (binding) => binding.split(' ').map((s) => s.split('+').map(showPart).join(isMac ? '' : '+'));

  // ── 사용자 키 ─────────────────────────────────────────────────────────
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
  let prefixes = new Map();   // "g" → [id, …] (두 키 조합의 첫 키)
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
    // 기본과 같은 것은 지워 둔다 (나중에 기본 키가 바뀌면 따라가게)
    for (const id of Object.keys(user)) if (!byId.has(id) || same(unique(user[id]), defaultsOf(id))) delete user[id];
    try {
      if (Object.keys(user).length) localStorage.setItem(STORE, JSON.stringify(user));
      else localStorage.removeItem(STORE);
    } catch (e) { /* 저장 불가 환경 */ }
    rebuild();
    window.dispatchEvent(new CustomEvent('univdash:keybindings'));
  }
  function setKeys(id, keys) {
    if (!byId.has(id)) return;
    save({ ...user, [id]: unique(keys).map(portable) });
  }
  function reset(id) { const next = { ...user }; delete next[id]; save(next); }
  function resetAll() { save({}); }
  // 다른 탭에서 바꾼 키도 따른다
  window.addEventListener('storage', (event) => {
    if (event.key !== STORE && event.key !== null) return;
    user = readUser();
    rebuild();
    window.dispatchEvent(new CustomEvent('univdash:keybindings'));
  });

  // 같은 화면에서 같은 키(또는 한쪽이 다른 쪽 두 키 조합의 첫 키)를 쓰는 다른 명령
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

  // ── 실행 ──────────────────────────────────────────────────────────────
  // 화면에 버튼이 여럿이면(분할 화면의 뷰어 등) 마지막으로 누르거나 초점을 준 곳에 가까운 것
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
  // 페이지 스크립트가 명령의 동작을 붙인다. run 이 false 를 돌려주면 처리하지 않은 것으로 본다.
  function register(id, run, when = () => true) {
    if (!byId.has(id)) { console.warn('알 수 없는 단축키 명령', id); return; }
    (handlers.get(id) || handlers.set(id, []).get(id)).push({ run, when });
  }
  function target(action) {
    if (action.click) return pick(action.click, action.hiddenOk);
    if (action.focus) return pick(action.focus);
    return null;
  }
  // 지금 이 명령을 할 수 있는지 (실행하지 않고)
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
  let paused = 0;   // 설정 창에서 키를 녹화하는 동안
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
    // 터미널(직접 입력 포함)에는 모든 키를 그대로 보낸다
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
