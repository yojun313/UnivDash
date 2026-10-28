// UnivDash 설정 창: [data-app-settings] 버튼을 누르면 가운데에 뜬다.
// - 이 기기 설정(화면 · 편집기 · 알림)은 localStorage 에 두고 바로 적용한다 (common.js 의 UnivDash.settings).
// - 서버 설정(업로드 최대 크기 등)은 /api/settings 에 저장한다 — 모든 기기에 똑같이 적용된다.
// - 왼쪽 사이드바에서 항목(화면 · 파일 · 편집기 · 알림 · 서버 상태 · 업로드)을 고르면 오른쪽에 그 설정이 보인다. 휴대폰은 위쪽 가로 탭.
(function () {
  'use strict';
  const U = () => window.UnivDash;
  const esc = (s) => U().escapeHtml(String(s));
  const raw = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* noop */ } },
  };
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const changed = (key) => window.dispatchEvent(new CustomEvent('univdash:settings', { detail: { key } }));

  // 이 기기 설정: [제목, 설명, 읽기, 쓰기]
  const SWITCHES = {
    editor: [
      ['auto-save', '자동 저장', '입력을 멈추면 0.8초 뒤 저장해요.', () => raw.get('univdash-ex-auto-save', true), (v) => raw.set('univdash-ex-auto-save', v)],
      ['md-split', '마크다운 실시간 미리보기', '편집할 때 오른쪽(휴대폰은 아래)에 렌더링 결과를 바로 보여 줘요.', () => raw.get('univdash-ex-md-split', true), (v) => raw.set('univdash-ex-md-split', v)],
      ['md-rendered', '마크다운 · 노트북 렌더링해서 열기', '끄면 파일을 코드로 먼저 보여 줘요.', () => raw.get('univdash-ex-md-rendered', true), (v) => raw.set('univdash-ex-md-rendered', v)],
      ['show-env', '.env 파일 항상 보이기', '숨김 파일(. 파일)을 꺼 둬도 파일 탐색기에 .env · .env.local 같은 파일은 보여 줘요.', () => raw.get('univdash-ex-show-env', true), (v) => raw.set('univdash-ex-show-env', v)],
      ['wrap', '긴 줄 줄바꿈', '코드 보기와 편집기에서 긴 줄을 화면 폭에 맞춰 접어요.', () => raw.get('univdash-ex-wrap', coarse), (v) => raw.set('univdash-ex-wrap', v)],
    ],
    notify: [
      ['notify-desktop', '시스템 알림 (푸시)', '다른 앱 · 다른 화면을 보거나 브라우저를 닫아 둬도, 에이전트 작업이 끝나거나 응답이 필요하면 맥 · 윈도우 · 휴대폰 알림으로 알려 줘요.', () => U().settings.get('notify-desktop'), (v) => U().settings.set('notify-desktop', v)],
      ['notify-agents', '화면 안 알림', '대시보드를 보고 있을 때, 다른 창에서 응답이 필요하거나 작업이 끝나면 화면 아래에 알려 줘요.', () => U().settings.get('notify-agents'), (v) => U().settings.set('notify-agents', v)],
      ['notify-git', 'Git 푸시 완료 알림', '자동 커밋 · 푸시가 끝나면 알려 줘요. 실패는 항상 알려요.', () => U().settings.get('notify-git'), (v) => U().settings.set('notify-git', v)],
      ['haptics', '진동', '버튼을 누르거나 알림이 올 때 짧게 진동해요 (지원하는 기기만).', () => U().settings.get('haptics'), (v) => U().settings.set('haptics', v)],
    ],
    monitor: [
      ['show-overview', 'OVERVIEW', '창 · 에이전트 · 작업 중 · 응답 필요 숫자 카드', () => U().settings.get('show-overview'), (v) => U().settings.set('show-overview', v)],
      ['sysmon-detail', '자세히 보기', '끄면 한 줄씩 간단히 (막대 · %), 켜면 코어 · 온도 · 용량 · 그래프까지. 사이드바의 자세히/간단히 버튼과 같아요.', () => U().settings.get('sysmon-detail'), (v) => U().settings.set('sysmon-detail', v)],
      ['sysmon-cpu', 'CPU', '사용률 · 코어 수 · 온도 · 부하, 최근 변화 그래프', () => U().settings.get('sysmon-cpu'), (v) => U().settings.set('sysmon-cpu', v)],
      ['sysmon-gpu', 'GPU', 'GPU 사용률 · VRAM 점유율 · 온도 · 전력 (NVIDIA)', () => U().settings.get('sysmon-gpu'), (v) => U().settings.set('sysmon-gpu', v)],
      ['sysmon-mem', '메모리', 'RAM 사용량 · 스왑', () => U().settings.get('sysmon-mem'), (v) => U().settings.set('sysmon-mem', v)],
      ['sysmon-disk', '디스크', '디스크마다 사용량 (막대에 마우스를 올리면 자세히)', () => U().settings.get('sysmon-disk'), (v) => U().settings.set('sysmon-disk', v)],
      ['sysmon-net', '네트워크', '초당 받기 · 보내기 속도', () => U().settings.get('sysmon-net'), (v) => U().settings.set('sysmon-net', v)],
    ],
  };
  const MONITOR_INTERVALS = [1, 2, 3, 5, 10, 30];
  const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18];
  const UPLOAD_PRESETS = [100, 500, 1024, 5 * 1024, 10 * 1024, 50 * 1024];
  const TABS = [
    { id: 'display', icon: 'fa-display', label: '화면', desc: '테마 · 배치 · 글자 크기' },
    { id: 'editor', icon: 'fa-pen-to-square', label: '파일 · 편집기', desc: '저장 · 미리보기 · 줄바꿈' },
    { id: 'notify', icon: 'fa-bell', label: '알림', desc: '에이전트 · Git · 진동' },
    { id: 'monitor', icon: 'fa-gauge-high', label: '사이드바', desc: 'Overview · 서버 상태 (CPU · GPU …)' },
    { id: 'keys', icon: 'fa-keyboard', label: '단축키', desc: '키 바꾸기 · 설정 내보내기 / 불러오기' },
    { id: 'upload', icon: 'fa-cloud-arrow-up', label: '업로드 · 파일', desc: '최대 크기 · 보관 · 뷰어', server: true },
  ];
  const TAB_KEY = 'univdash-settings-tab';
  let tab = raw.get(TAB_KEY, 'display');
  if (!TABS.some((t) => t.id === tab)) tab = 'display';
  const bytes = (n) => (n >= 1024 ** 4 ? `${(n / 1024 ** 4).toFixed(1)}TB` : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}GB` : `${Math.round(n / 1024 ** 2)}MB`);
  const TTL_OPTIONS = [[0.5, '12시간'], [1, '1일'], [3, '3일'], [7, '7일'], [14, '14일'], [30, '30일']];
  const VIEWER_OPTIONS = [1, 2, 5, 10, 20];
  const EDIT_OPTIONS = [5, 10, 20, 50];

  const mb = (n) => (n >= 1024 && n % 1024 === 0 ? `${n / 1024}GB` : n >= 1024 ? `${(n / 1024).toFixed(1)}GB` : `${n}MB`);
  const switchHtml = (id, title, desc, on) => `
    <div class="ud-set-row">
      <div class="ud-set-text"><p class="ud-set-title">${esc(title)}</p><p class="ud-set-desc">${esc(desc)}</p></div>
      <button type="button" class="pmd-mode-switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(title)}" data-switch="${id}"></button>
    </div>`;
  const selectHtml = (name, options, value) => `<select class="ud-set-select" data-server="${name}">${options.map(([v, label]) => `<option value="${v}" ${Number(v) === Number(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;

  let overlay = null;
  let server = null;      // { settings, defaults, limits }
  let lastFocus = null;

  function section(id) {
    const s = server?.settings;
    if (id === 'display') {
      const swapped = document.documentElement.classList.contains('ws-swapped');
      const font = Number(U().settings.get('editor-font')) || 13;
      return `
        <div class="ud-set-row">
          <div class="ud-set-text"><p class="ud-set-title">테마</p><p class="ud-set-desc">배경 스타일과 다크 · 라이트 모드</p></div>
          <button type="button" class="ud-set-btn" data-open-theme><i class="fas fa-palette"></i> 테마 설정</button>
        </div>
        <div class="ud-set-row">
          <div class="ud-set-text"><p class="ud-set-title">Workspace 배치</p><p class="ud-set-desc">파일 탐색기와 에이전트 목록의 좌우 위치 (데스크톱)</p></div>
          <div class="ud-set-seg" role="group" aria-label="Workspace 배치">
            <button type="button" data-layout="files-left" class="${swapped ? 'on' : ''}">파일 왼쪽</button>
            <button type="button" data-layout="files-right" class="${swapped ? '' : 'on'}">파일 오른쪽</button>
          </div>
        </div>
        <div class="ud-set-row">
          <div class="ud-set-text"><p class="ud-set-title">편집기 글자 크기</p><p class="ud-set-desc">파일 편집기의 글자 크기예요.</p></div>
          <div class="ud-set-stepper">
            <button type="button" data-font="-1" aria-label="작게"><i class="fas fa-minus"></i></button>
            <span>${font}px</span>
            <button type="button" data-font="1" aria-label="크게"><i class="fas fa-plus"></i></button>
          </div>
        </div>`;
    }
    if (id === 'monitor') {
      const every = Number(U().settings.get('sysmon-interval')) || 2;
      return `
        <p class="ud-set-note">왼쪽 사이드바에 보일 항목이에요. 서버 상태(CPU · GPU · 메모리 · 디스크 · 네트워크)는 실시간으로 바뀌고, 모두 끄면 숨겨요.</p>
        <div class="ud-set-row">
          <div class="ud-set-text"><p class="ud-set-title">업데이트 주기</p><p class="ud-set-desc">짧을수록 자주 새로 고쳐요. 탭이 안 보이거나 사이드바를 접으면 멈춰요.</p></div>
          <div class="ud-set-seg" role="group" aria-label="업데이트 주기">
            ${MONITOR_INTERVALS.map((n) => `<button type="button" data-interval="${n}" class="${n === every ? 'on' : ''}">${n}초</button>`).join('')}
          </div>
        </div>
        ${SWITCHES.monitor.map(([key, title, desc, read]) => switchHtml(key, title, desc, read())).join('')}`;
    }
    if (id === 'notify') {
      return `${SWITCHES.notify.map(([key, title, desc, read]) => switchHtml(key, title, desc, read())).join('')}
        <div class="ud-set-row">
          <div class="ud-set-text"><p class="ud-set-title">이 기기 푸시 상태</p><p class="ud-set-desc" data-push-status>확인하는 중…</p></div>
          <button type="button" class="ud-set-btn" data-push-test><i class="fas fa-bell"></i> 테스트 알림</button>
        </div>`;
    }
    if (id === 'keys') return keysSection();
    if (id === 'editor') return SWITCHES[id].map(([key, title, desc, read]) => switchHtml(key, title, desc, read())).join('');
    if (!server) return '<p class="ud-set-note"><i class="fas fa-circle-notch fa-spin"></i> 서버 설정을 불러오는 중…</p>';
    const limit = server.limits.upload_max_mb;
    const gb = s.upload_max_mb >= 1024 && s.upload_max_mb % 1024 === 0;
    return `
      <div class="ud-set-row ud-set-col">
        <div class="ud-set-text"><p class="ud-set-title">업로드 최대 파일 크기</p><p class="ud-set-desc">프롬프트 첨부와 파일 탐색기 업로드에서 한 파일당 최대 크기예요. 큰 파일은 나눠서 올라가요.${server.disk_free != null ? ` 서버 디스크 남은 공간 <b>${bytes(server.disk_free)}</b>.` : ''}</p></div>
        <div class="ud-set-upload">
          <div class="ud-set-chips">${UPLOAD_PRESETS.filter((n) => n <= limit).map((n) => `<button type="button" data-upload="${n}" class="${n === s.upload_max_mb ? 'on' : ''}">${mb(n)}</button>`).join('')}</div>
          <div class="ud-set-number">
            <input type="number" inputmode="decimal" min="1" step="any" value="${gb ? s.upload_max_mb / 1024 : s.upload_max_mb}" data-upload-input aria-label="업로드 최대 크기">
            <select data-upload-unit aria-label="단위"><option value="MB" ${gb ? '' : 'selected'}>MB</option><option value="GB" ${gb ? 'selected' : ''}>GB</option></select>
          </div>
        </div>
      </div>
      <div class="ud-set-row">
        <div class="ud-set-text"><p class="ud-set-title">첨부 파일 보관 기간</p><p class="ud-set-desc">프롬프트에 첨부한 원본을 서버에 두는 기간이에요. 지나면 자동으로 지워요.</p></div>
        ${selectHtml('upload_ttl_days', TTL_OPTIONS, s.upload_ttl_days)}
      </div>
      <div class="ud-set-row">
        <div class="ud-set-text"><p class="ud-set-title">뷰어에서 열 텍스트 최대 크기</p><p class="ud-set-desc">이보다 큰 텍스트 파일은 앞부분만 보여 주고 편집할 수 없어요.</p></div>
        ${selectHtml('viewer_max_mb', VIEWER_OPTIONS.map((n) => [n, `${n}MB`]), s.viewer_max_mb)}
      </div>
      <div class="ud-set-row">
        <div class="ud-set-text"><p class="ud-set-title">편집기 저장 최대 크기</p><p class="ud-set-desc">편집기에서 저장할 수 있는 파일 크기예요.</p></div>
        ${selectHtml('edit_max_mb', EDIT_OPTIONS.map((n) => [n, `${n}MB`]), s.edit_max_mb)}
      </div>`;
  }

  // ── 단축키 (keys.js) · 설정 내보내기 / 불러오기 ─────────────────────────
  const K = () => window.UnivDashKeys;
  let keyQuery = '';
  let recording = null;        // { id, mode: 'edit' | 'add', strokes: [] }
  let importing = null;        // 고른 파일에서 읽은 내용 (확인 전)
  // 내보낼 이 기기 설정 (localStorage 키). 단축키는 따로 keybindings 에 담는다.
  const EXPORT_KEYS = () => [
    ...Object.keys(U().settings.defaults).map((key) => `univdash-set-${key}`),
    ...SWITCHES.editor.map(([key]) => `univdash-ex-${key}`),
    'univdash-theme', 'univdash-theme-style', 'univdash-ws-swapped',
  ];
  const kbd = (binding) => K().label(binding).map((stroke) => `<kbd>${esc(stroke)}</kbd>`).join('<i class="ud-kb-then">,</i>');
  const searchText = (action) => [action.label, action.id, K().SCOPES[action.scope], ...K().keysOf(action.id).flatMap((b) => [b, K().label(b).join(' ')])].join(' ').toLowerCase();

  function keyRow(action) {
    const keys = K().keysOf(action.id);
    const modified = !K().isDefault(action.id);
    const rec = recording?.id === action.id ? recording : null;
    let binds;
    if (rec) {
      const binding = rec.strokes.join(' ');
      const clash = binding ? K().conflicts(action.id, binding) : [];
      binds = `<div class="ud-keys-rec" role="status" aria-live="polite">
          ${binding ? `<span class="ud-kb">${kbd(binding)}</span>` : '<span class="ud-keys-wait">원하는 키를 누르세요…</span>'}
          <small>${binding ? (clash.length ? `⚠ ${esc(clash.map((a) => a.label).join(', '))} 와(과) 겹쳐요` : '두 번째 키를 이어 누를 수도 있어요') : `${rec.mode === 'add' ? '키 추가' : '키 바꾸기'} · Enter 저장 · Esc 취소`}</small>
          <span class="ud-keys-rec-btns"><button type="button" class="ud-set-btn" data-key-save ${binding ? '' : 'disabled'}>저장</button><button type="button" class="ud-set-btn" data-key-cancel>취소</button></span>
        </div>`;
    } else {
      binds = keys.length
        ? keys.map((b) => `<span class="ud-kb">${kbd(b)}<button type="button" data-key-remove="${esc(b)}" aria-label="${esc(K().label(b).join(' '))} 지우기" title="이 키 지우기">&times;</button></span>`).join('')
        : '<span class="ud-keys-none">—</span>';
    }
    return `<div class="ud-keys-row${modified ? ' modified' : ''}${rec ? ' recording' : ''}" data-key-id="${esc(action.id)}">
        <div class="ud-keys-name"><span>${esc(action.label)}</span>${modified ? '<em>사용자</em>' : ''}</div>
        <div class="ud-keys-binds">${binds}</div>
        <div class="ud-keys-acts">
          <button type="button" data-key-edit title="키 바꾸기" aria-label="${esc(action.label)} 키 바꾸기"><i class="fas fa-pen"></i></button>
          <button type="button" data-key-add title="키 추가" aria-label="${esc(action.label)} 키 추가"><i class="fas fa-plus"></i></button>
          <button type="button" data-key-reset title="기본값으로" aria-label="${esc(action.label)} 기본값으로" ${modified ? '' : 'disabled'}><i class="fas fa-rotate-left"></i></button>
        </div>
      </div>`;
  }
  function keyList() {
    const words = keyQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const groups = Object.entries(K().SCOPES).map(([scope, title]) => {
      const rows = K().actions.filter((a) => a.scope === scope && words.every((w) => searchText(a).includes(w)));
      return rows.length ? `<h5 class="ud-keys-scope">${esc(title)}<span>${rows.length}</span></h5>${rows.map(keyRow).join('')}` : '';
    }).join('');
    return groups || '<p class="ud-set-note">찾는 명령이 없어요.</p>';
  }
  function importPanel() {
    if (!importing) return '';
    const date = importing.exported_at ? new Date(importing.exported_at) : null;
    return `<div class="ud-keys-import">
        <p><b>${esc(importing.name)}</b>${date && !Number.isNaN(date.getTime()) ? ` · ${esc(date.toLocaleString())} 에 내보냄` : ''}</p>
        <p>단축키 ${importing.keyCount}개 · 이 기기 설정 ${importing.settingCount}개를 불러와 지금 값을 덮어써요.${importing.settingCount ? ' 적용하려고 화면을 새로 고쳐요.' : ''}</p>
        <div><button type="button" class="ud-set-btn primary" data-import-apply>불러오기</button><button type="button" class="ud-set-btn" data-import-cancel>취소</button></div>
      </div>`;
  }
  function keysSection() {
    if (!K()) return '<p class="ud-set-note">단축키 모듈을 불러오지 못했어요.</p>';
    return `
      <div class="ud-keys-top">
        <label class="ud-keys-search"><i class="fas fa-magnifying-glass"></i><input type="search" data-keys-search value="${esc(keyQuery)}" placeholder="명령 · 키 검색 (예: 사이드바, ctrl+b)" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="단축키 검색"></label>
        <div class="ud-keys-tools">
          <button type="button" class="ud-set-btn" data-keys-export title="단축키와 이 기기 설정을 JSON 파일로 저장"><i class="fas fa-file-export"></i> 내보내기</button>
          <button type="button" class="ud-set-btn" data-keys-import title="내보낸 JSON 파일로 한 번에 설정"><i class="fas fa-file-import"></i> 불러오기</button>
          <button type="button" class="ud-set-btn" data-keys-reset-all title="모든 단축키를 기본값으로"><i class="fas fa-rotate-left"></i> 모두 기본값</button>
          <input type="file" accept="application/json,.json" data-keys-file hidden>
        </div>
      </div>
      <div data-import-panel>${importPanel()}</div>
      <p class="ud-set-note ud-keys-help">✎ 를 누르거나 줄을 두 번 누른 뒤 원하는 키를 누르고 <kbd>Enter</kbd>. 두 키를 이어 누르는 조합(예: <kbd>G</kbd><i class="ud-kb-then">,</i><kbd>W</kbd>)도 돼요. 글자 키 단축키는 입력칸에 쓰는 중이거나 터미널에 직접 입력할 때는 동작하지 않아요. 내보내기 파일에는 화면 · 편집기 · 알림 · 사이드바 설정과 테마도 함께 담겨요.</p>
      <div class="ud-keys-list" data-keys-list>${keyList()}</div>`;
  }
  function refreshKeys() {
    const listEl = overlay?.querySelector('[data-keys-list]');
    if (!listEl) return;
    listEl.innerHTML = keyList();
    overlay.querySelector('[data-import-panel]').innerHTML = importPanel();
    overlay.querySelector('.ud-keys-row.recording')?.scrollIntoView({ block: 'nearest' });
  }

  function startRecording(id, mode) {
    if (!recording) K().pause();
    recording = { id, mode, strokes: [] };
    refreshKeys();
  }
  function stopRecording(saveIt) {
    if (!recording) return;
    const { id, mode, strokes } = recording;
    recording = null;
    K().resume();
    if (saveIt && strokes.length) {
      const binding = strokes.join(' ');
      const clash = K().conflicts(id, binding);
      K().setKeys(id, mode === 'add' ? [...K().keysOf(id), binding] : [binding]);
      U().toast(clash.length ? `저장했어요. ${clash.map((a) => a.label).join(', ')} 와(과) 키가 겹쳐요.` : '단축키를 저장했어요.', clash.length ? 'error' : 'success', clash.length ? 5000 : 1600);
    }
    refreshKeys();
  }
  // 녹화 중에는 모든 키를 가로챈다 (설정 창의 Esc 닫기 등보다 먼저)
  window.addEventListener('keydown', (event) => {
    if (!recording) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) { stopRecording(false); return; }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && recording.strokes.length) { stopRecording(true); return; }
    const stroke = K().strokeOf(event);
    if (!stroke) return;
    recording.strokes = recording.strokes.length >= 2 ? [stroke] : [...recording.strokes, stroke];
    refreshKeys();
  }, true);

  // 저장된 값, 없으면 지금 적용 중인 기본값 (불러온 기기가 똑같아지도록)
  function currentSetting(key) {
    try { const value = localStorage.getItem(key); if (value !== null) return value; } catch (e) { /* noop */ }
    if (key.startsWith('univdash-set-')) return JSON.stringify(U().settings.get(key.slice('univdash-set-'.length)));
    const editor = SWITCHES.editor.find(([id]) => `univdash-ex-${id}` === key);
    if (editor) return JSON.stringify(editor[3]());
    if (key === 'univdash-theme') return window.UnivDashTheme?.current() || null;
    if (key === 'univdash-theme-style') return document.documentElement.getAttribute('data-ui-theme') || 'default';
    if (key === 'univdash-ws-swapped') return JSON.stringify(document.documentElement.classList.contains('ws-swapped'));
    return null;
  }
  function exportSettings() {
    const settings = {};
    for (const key of EXPORT_KEYS()) {
      const value = currentSetting(key);
      if (value !== null && value !== undefined) settings[key] = value;
    }
    const data = { app: 'univdash', kind: 'settings', version: 1, exported_at: new Date().toISOString(), keybindings: K().overrides(), settings };
    const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    a.href = url;
    a.download = `univdash-settings-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    U().toast(`내보냈어요 · 바꾼 단축키 ${Object.keys(data.keybindings).length}개 · 설정 ${Object.keys(settings).length}개`, 'success', 2600);
  }
  // 불러올 값 검사: 아는 키만, 값은 짧은 문자열만 (테마는 정해진 값만)
  function validSetting(key, value) {
    if (typeof value !== 'string' || value.length > 2000) return false;
    if (key === 'univdash-theme') return value === 'light' || value === 'dark';
    if (key === 'univdash-theme-style') return /^[a-z]{1,20}$/.test(value);
    try { const parsed = JSON.parse(value); return parsed === null || ['boolean', 'number', 'string'].includes(typeof parsed); } catch (e) { return false; }
  }
  async function readImport(file) {
    if (!file) return;
    if (file.size > 1024 * 1024) { U().toast('파일이 너무 커요 (1MB 이하).', 'error'); return; }
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { U().toast('JSON 파일이 아니에요.', 'error'); return; }
    if (!data || typeof data !== 'object' || data.app !== 'univdash') { U().toast('UnivDash 에서 내보낸 설정 파일이 아니에요.', 'error'); return; }
    const allowed = new Set(EXPORT_KEYS());
    const keybindings = data.keybindings && typeof data.keybindings === 'object' && !Array.isArray(data.keybindings) ? data.keybindings : null;
    const settings = Object.fromEntries(Object.entries(data.settings && typeof data.settings === 'object' ? data.settings : {})
      .filter(([key, value]) => allowed.has(key) && validSetting(key, value)));
    if (!keybindings && !Object.keys(settings).length) { U().toast('불러올 단축키나 설정이 없어요.', 'error'); return; }
    importing = { name: file.name, exported_at: data.exported_at, keybindings, settings, keyCount: keybindings ? Object.keys(keybindings).length : 0, settingCount: Object.keys(settings).length };
    refreshKeys();
  }
  function applyImport() {
    if (!importing) return;
    const { keybindings, settings, settingCount } = importing;
    importing = null;
    const result = keybindings ? K().replaceAll(keybindings) : { applied: 0, skipped: 0 };
    for (const [key, value] of Object.entries(settings)) {
      try { localStorage.setItem(key, value); } catch (e) { /* noop */ }
    }
    U().toast(`불러왔어요 · 단축키 ${result.applied}개${result.skipped ? ` (모르는 항목 ${result.skipped}개는 건너뜀)` : ''} · 설정 ${settingCount}개`, 'success', 3000);
    if (settingCount) setTimeout(() => location.reload(), 900);
    else refreshKeys();
  }

  function onKeysClick(event) {
    if (event.target.closest('[data-keys-export]')) { exportSettings(); return true; }
    if (event.target.closest('[data-keys-import]')) { overlay.querySelector('[data-keys-file]').click(); return true; }
    if (event.target.closest('[data-keys-reset-all]')) {
      if (window.confirm('모든 단축키를 기본값으로 되돌릴까요?')) { K().resetAll(); U().toast('모든 단축키를 기본값으로 되돌렸어요.', 'success', 1800); }
      return true;
    }
    if (event.target.closest('[data-import-apply]')) { applyImport(); return true; }
    if (event.target.closest('[data-import-cancel]')) { importing = null; refreshKeys(); return true; }
    if (event.target.closest('[data-key-save]')) { stopRecording(true); return true; }
    if (event.target.closest('[data-key-cancel]')) { stopRecording(false); return true; }
    const row = event.target.closest('[data-key-id]');
    if (!row) return false;
    const id = row.dataset.keyId;
    const remove = event.target.closest('[data-key-remove]');
    if (remove) { K().setKeys(id, K().keysOf(id).filter((k) => k !== remove.dataset.keyRemove)); return true; }
    if (event.target.closest('[data-key-edit]')) { startRecording(id, 'edit'); return true; }
    if (event.target.closest('[data-key-add]')) { startRecording(id, 'add'); return true; }
    if (event.target.closest('[data-key-reset]')) { K().reset(id); return true; }
    return true;
  }

  function render() {
    if (!overlay) return;
    const current = TABS.find((t) => t.id === tab);
    overlay.querySelector('.ud-settings-modal').classList.toggle('wide', tab === 'keys');
    if (tab !== 'keys' && recording) { recording = null; K()?.resume(); }
    overlay.querySelectorAll('[data-tab]').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    overlay.querySelector('.ud-set-pane-title').innerHTML = `<i class="fas ${current.icon}"></i> ${esc(current.label)}${current.server ? '<span class="ud-set-badge">서버 · 모든 기기</span>' : '<span class="ud-set-badge local">이 기기</span>'}`;
    const scroller = overlay.querySelector('.ud-set-body');
    const same = scroller.dataset.shown === tab;
    const top = scroller.scrollTop;
    scroller.dataset.shown = tab;
    scroller.innerHTML = section(tab);
    scroller.scrollTop = same ? top : 0;
    if (tab === 'notify') showPush();
  }
  // 이 기기 웹 푸시 상태 (push.js)
  function showPush(promise) {
    const el = overlay?.querySelector('[data-push-status]');
    if (!el) return;
    const push = window.UnivDashPush;
    (promise || push?.status() || Promise.resolve({ text: '알림 모듈을 불러오지 못했어요.' }))
      .then((info) => { const now = overlay?.querySelector('[data-push-status]'); if (now) { now.textContent = info.text; now.dataset.state = info.state || ''; } })
      .catch((error) => { const now = overlay?.querySelector('[data-push-status]'); if (now) now.textContent = error.message; });
  }
  function selectTab(id) {
    if (!TABS.some((t) => t.id === id)) return;
    tab = id;
    raw.set(TAB_KEY, id);
    render();
    overlay.querySelector('.ud-set-tabs .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  let saveSeq = 0;
  async function saveServer(changes) {
    const seq = ++saveSeq;
    try {
      const data = await U().api('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      if (seq !== saveSeq) return;
      server = data;
      render();
      U().toast('설정을 저장했어요.', 'success', 1800);
    } catch (error) {
      U().toast(error.message, 'error');
      render();
    }
  }

  function onClick(event) {
    if (event.target === overlay || event.target.closest('[data-close]')) { close(); return; }
    const tabBtn = event.target.closest('[data-tab]');
    if (tabBtn) { selectTab(tabBtn.dataset.tab); return; }
    if (tab === 'keys' && event.target.closest('.ud-set-body') && onKeysClick(event)) return;
    const sw = event.target.closest('[data-switch]');
    if (sw) {
      const all = Object.values(SWITCHES).flat();
      const item = all.find(([id]) => id === sw.dataset.switch);
      if (!item) return;
      const next = !item[3]();
      item[4](next);
      if (SWITCHES.editor.includes(item)) changed(item[0]);
      sw.classList.toggle('on', next);
      sw.setAttribute('aria-checked', String(next));
      if (item[0] === 'haptics' && next) U().haptic(10);
      // 권한 요청은 이 클릭 안에서 해야 브라우저가 물어본다
      if (item[0] === 'notify-desktop' && window.UnivDashPush) showPush(window.UnivDashPush.sync({ ask: next }));
      return;
    }
    if (event.target.closest('[data-push-test]')) {
      const push = window.UnivDashPush;
      if (!push) return;
      if (!U().settings.get('notify-desktop')) {
        U().settings.set('notify-desktop', true);
        render();
      }
      const test = push.test();
      showPush(test.then(() => push.status()));
      test.then(() => U().toast('테스트 알림을 보냈어요. 안 보이면 OS 알림 설정에서 브라우저 알림이 켜져 있는지 확인해 주세요.', 'success', 6000))
        .catch((error) => U().toast(error.message, 'error'));
      return;
    }
    const layout = event.target.closest('[data-layout]');
    if (layout) {
      const swapped = layout.dataset.layout === 'files-left';
      document.documentElement.classList.toggle('ws-swapped', swapped);
      raw.set('univdash-ws-swapped', swapped);
      window.dispatchEvent(new Event('resize'));   // 터미널 크기 다시 맞추기
      render();
      return;
    }
    const every = event.target.closest('[data-interval]');
    if (every) { U().settings.set('sysmon-interval', Number(every.dataset.interval)); render(); return; }
    const font = event.target.closest('[data-font]');
    if (font) {
      const now = Number(U().settings.get('editor-font')) || 13;
      const index = FONT_SIZES.indexOf(now);
      const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, (index < 0 ? 2 : index) + Number(font.dataset.font)))];
      U().settings.set('editor-font', next);
      render();
      return;
    }
    const upload = event.target.closest('[data-upload]');
    if (upload) { saveServer({ upload_max_mb: Number(upload.dataset.upload) }); return; }
    if (event.target.closest('[data-open-theme]')) {
      close();
      document.querySelector('[data-theme-settings]')?.click();
    }
  }

  function onChange(event) {
    if (!server) return;
    if (event.target.closest('[data-upload-input], [data-upload-unit]')) {
      const box = event.target.closest('.ud-set-number');
      const amount = Number(box.querySelector('[data-upload-input]').value);
      const unit = box.querySelector('[data-upload-unit]').value;
      const value = Math.round(amount * (unit === 'GB' ? 1024 : 1));
      const limit = server.limits.upload_max_mb;
      if (!Number.isFinite(amount) || value < 1 || value > limit) {
        U().toast(`1MB ~ ${mb(limit)} 사이로 넣어 주세요.`, 'error');
        render();
        return;
      }
      if (value !== server.settings.upload_max_mb) saveServer({ upload_max_mb: value });
      return;
    }
    const field = event.target.closest('[data-server]');
    if (!field) return;
    const name = field.dataset.server;
    const value = Number(field.value);
    if (value === server.settings[name]) return;
    saveServer({ [name]: value });
  }

  function build() {
    overlay = document.createElement('div');
    overlay.className = 'ud-settings-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="ud-settings-modal" role="dialog" aria-modal="true" aria-labelledby="udSettingsTitle">
        <nav class="ud-set-nav" aria-label="설정 항목">
          <h3 id="udSettingsTitle"><i class="fas fa-gear"></i> 설정</h3>
          <div class="ud-set-tabs" role="tablist">
            ${TABS.map((t) => `<button type="button" role="tab" data-tab="${t.id}"><i class="fas ${t.icon}"></i><span><b>${esc(t.label)}</b><small>${esc(t.desc)}</small></span></button>`).join('')}
          </div>
        </nav>
        <div class="ud-set-pane">
          <div class="ud-set-head">
            <h4 class="ud-set-pane-title"></h4>
            <button type="button" class="pmd-theme-close" data-close aria-label="닫기">&times;</button>
          </div>
          <div class="ud-set-body" role="tabpanel"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('change', (event) => {
      if (event.target.matches('[data-keys-file]')) { readImport(event.target.files?.[0]); event.target.value = ''; return; }
      onChange(event);
    });
    overlay.addEventListener('input', (event) => {
      if (!event.target.matches('[data-keys-search]')) return;
      keyQuery = event.target.value;
      overlay.querySelector('[data-keys-list]').innerHTML = keyList();
    });
    overlay.addEventListener('dblclick', (event) => {
      const row = event.target.closest('.ud-keys-row');
      if (row && !event.target.closest('button')) startRecording(row.dataset.keyId, 'edit');
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target.matches('input')) { event.preventDefault(); event.target.blur(); }
      const tabBtn = event.target.closest?.('[data-tab]');
      if (tabBtn && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const i = TABS.findIndex((t) => t.id === tab) + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1);
        selectTab(TABS[(i + TABS.length) % TABS.length].id);
        overlay.querySelector(`[data-tab="${tab}"]`).focus();
      }
    });
  }

  async function open(tabId) {
    if (!overlay) build();
    if (tabId && TABS.some((t) => t.id === tabId)) { tab = tabId; raw.set(TAB_KEY, tabId); }
    lastFocus = document.activeElement;
    // 휴대폰: 사이드바에서 열었으면 사이드바를 닫는다
    if (!window.matchMedia('(min-width: 768px)').matches) document.getElementById('closeSidebarBtn')?.click();
    overlay.hidden = false;
    document.body.classList.add('ud-settings-open');
    render();
    overlay.querySelector('.ud-set-body').scrollTop = 0;
    if (!coarse) overlay.querySelector('[data-close]').focus({ preventScroll: true });
    overlay.querySelector('.ud-set-tabs .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    try {
      server = await U().api('/api/settings');
    } catch (error) {
      U().toast(error.message, 'error');
    }
    if (!overlay.hidden) render();
  }
  function close() {
    if (!overlay || overlay.hidden) return;
    if (recording) { recording = null; K()?.resume(); }
    importing = null;
    overlay.hidden = true;
    document.body.classList.remove('ud-settings-open');
    lastFocus?.focus?.({ preventScroll: true });
  }

  function init() {
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-app-settings]')) { event.preventDefault(); open(); }
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && overlay && !overlay.hidden) { event.preventDefault(); close(); }
    });
    // 다른 탭에서 바꾼 값도 열린 창에 반영
    window.addEventListener('univdash:settings', () => { if (overlay && !overlay.hidden) render(); });
    window.addEventListener('univdash:keybindings', () => { if (overlay && !overlay.hidden && tab === 'keys' && !recording) refreshKeys(); });
    window.UnivDashKeys?.register('app.settings', () => { open(); });
    window.UnivDashKeys?.register('app.keybindings', () => { open('keys'); });
    window.UnivDashSettings = { open, close };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
