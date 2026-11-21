// 화면 공유 보기 (읽기 전용) — 화면을 1초마다 받아 그리기만 한다. 서버로 보내는 것은 화면 요청뿐이다.
// - 링크 토큰은 주소의 # 뒤에 있다 (서버로 가지 않음). 읽은 뒤 주소창에서 지우고 이 탭에만 기억한다.
// - 접근 코드(공유한 사람이 따로 전달)를 넣어야 화면이 나온다. 코드를 넣기 전에는 제목조차 받지 않는다.
// - 터미널 내용은 textContent 로만 넣고, 색은 직접 계산한 값만 style 에 넣는다 (내용이 HTML 로 해석되지 않는다).
(function () {
  'use strict';

  const TOKEN_KEY = 'univdash-view-token';
  const CODE_KEY = 'univdash-view-code';
  const TOKEN = /^[A-Za-z0-9_-]{43}$/;
  const store = {
    get(key) { try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch (e) { /* 저장 불가 */ } },
    drop(key) { try { sessionStorage.removeItem(key); } catch (e) { /* noop */ } },
  };
  let token = '';
  const fromHash = location.hash.slice(1);
  if (TOKEN.test(fromHash)) {
    if (store.get(TOKEN_KEY) !== fromHash) store.drop(CODE_KEY);
    token = fromHash;
    store.set(TOKEN_KEY, token);
  } else {
    token = store.get(TOKEN_KEY);
  }
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* noop */ }
  let code = store.get(CODE_KEY);

  const $ = (id) => document.getElementById(id);
  const term = $('vwTerm');
  const main = $('vwMain');
  const note = $('vwNote');
  const dot = $('vwDot');
  const meta = $('vwMeta');
  const fitBtn = $('vwFit');
  const pauseBtn = $('vwPause');
  const latest = $('vwLatest');
  const codeForm = $('vwCode');
  const codeInput = $('vwCodeInput');
  const codeBtn = $('vwCodeBtn');
  const codeErr = $('vwCodeErr');

  let hash = '';
  let paused = false;
  let fit = true;
  let follow = true;
  let stopped = false;
  let timer = 0;
  let last = null;
  let expires = 0;
  let mode = 'term';   // 'chat' (에이전트 대화 기록) | 'term' (터미널 화면)

  function setNote(text) { note.textContent = text; note.classList.toggle('hidden', !text); }
  function setDot(kind) { dot.className = `vw-dot ${kind}`; }
  function end(text) {
    stopped = true;
    clearTimeout(timer);
    setDot('off');
    document.body.classList.add('vw-gone');
    codeForm.classList.add('hidden');
    setNote(text);
    meta.textContent = '';
    store.drop(TOKEN_KEY);
    store.drop(CODE_KEY);
  }
  function askCode(message) {
    clearTimeout(timer);
    code = '';
    store.drop(CODE_KEY);
    term.replaceChildren();
    last = null;
    hash = '';
    resetChat();
    tabs.classList.add('hidden');
    chatBox.classList.add('hidden');
    setNote('');
    setDot('wait');
    meta.textContent = '';
    codeForm.classList.remove('hidden');
    codeErr.textContent = message || '';
    codeBtn.disabled = false;
    setTimeout(() => codeInput.focus(), 30);
  }

  // ── ANSI SGR → 스타일 ──
  const PALETTE = ['#1f2430', '#f07178', '#a6da95', '#eed49f', '#7aa2f7', '#c6a0f6', '#7dcfff', '#cad3f5',
    '#5b6078', '#ff8a92', '#b8f0a8', '#ffe0a8', '#9ab8ff', '#dcb8ff', '#a4e0ff', '#ffffff'];
  const CUBE = [0, 95, 135, 175, 215, 255];
  const byte = (v) => Math.max(0, Math.min(255, Number(v) | 0));
  function color256(n) {
    n = byte(n);
    if (n < 16) return PALETTE[n];
    if (n < 232) { n -= 16; return `rgb(${CUBE[Math.floor(n / 36)]},${CUBE[Math.floor(n / 6) % 6]},${CUBE[n % 6]})`; }
    const v = 8 + 10 * (n - 232);
    return `rgb(${v},${v},${v})`;
  }
  function applySGR(params, st) {
    const codes = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : parseInt(x, 10) || 0));
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
        else if (codes[i + 1] === 2) { color = `rgb(${byte(codes[i + 2])},${byte(codes[i + 3])},${byte(codes[i + 4])})`; i += 4; }
        if (c === 38) st.fg = color; else if (c === 48) st.bg = color;
      }
    }
  }
  const plain = (st) => !st.fg && !st.bg && !st.b && !st.d && !st.i && !st.u && !st.inv && !st.s;
  function piece(text, st) {
    if (plain(st)) return document.createTextNode(text);
    const span = document.createElement('span');
    span.textContent = text;
    let fg = st.fg;
    let bg = st.bg;
    if (st.inv) { const t = fg || '#d4d8e1'; fg = bg || '#05070c'; bg = t; }
    if (fg) span.style.color = fg;
    if (bg) span.style.background = bg;
    if (st.b) span.style.fontWeight = '700';
    if (st.d) span.style.opacity = '.62';
    if (st.i) span.style.fontStyle = 'italic';
    if (st.u || st.s) span.style.textDecoration = `${st.u ? 'underline ' : ''}${st.s ? 'line-through' : ''}`;
    return span;
  }
  const OTHER_ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-ln-z]|\x1b[()][A-Za-z0-9]|\x1b[=>78]|[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g;
  const SGR = /\x1b\[([0-9;:]*)m/g;

  function renderLine(raw, st, frag) {
    const line = raw.replace(OTHER_ESCAPES, '');
    let index = 0;
    let match;
    SGR.lastIndex = 0;
    while ((match = SGR.exec(line))) {
      if (match.index > index) frag.append(piece(line.slice(index, match.index), st));
      applySGR(match[1], st);
      index = SGR.lastIndex;
    }
    if (index < line.length) frag.append(piece(line.slice(index), st));
  }

  function render(data) {
    last = data;
    const lines = String(data.content || '').split('\n');
    while (lines.length > 1 && !lines[lines.length - 1].replace(OTHER_ESCAPES, '').replace(SGR, '').trim()) lines.pop();
    const st = {};
    const frag = document.createDocumentFragment();
    lines.forEach((raw, i) => {
      renderLine(raw, st, frag);
      if (i < lines.length - 1) frag.append('\n');
    });
    const stick = follow;
    term.replaceChildren(frag);
    applyFit();
    if (stick) main.scrollTop = main.scrollHeight;
  }

  // ── 너비: pane 칸 수만큼에서 줄을 접는다. '맞춤'이면 그 너비가 화면에 들어가게 글자 크기를 줄인다 (8–14px) ──
  let charRatio = 0;
  function measure() {
    const probe = document.createElement('span');
    probe.textContent = 'MMMMMMMMMM';
    probe.style.cssText = 'position:absolute;visibility:hidden;font-size:100px;white-space:pre';
    term.append(probe);
    charRatio = probe.getBoundingClientRect().width / 1000 || 0.6;
    probe.remove();
  }
  function applyFit() {
    if (!last) return;
    const cols = Math.max(20, Math.min(500, Number(last.width) || 80));
    term.style.width = `${cols}ch`;
    term.style.minWidth = '0';
    if (!fit) { term.style.fontSize = ''; return; }
    if (!charRatio) measure();
    const room = main.clientWidth - 32;
    term.style.fontSize = `${Math.max(8, Math.min(14, room / (cols * charRatio))).toFixed(2)}px`;
  }

  // ── 받아 오기 ──
  function call(path) {
    const headers = { 'X-View-Token': token };
    if (code) headers['X-View-Code'] = code;
    return fetch(path, { headers, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  }
  function leftText() {
    const minutes = Math.max(0, Math.ceil((expires * 1000 - Date.now()) / 60000));
    if (minutes >= 1440) return `${Math.floor(minutes / 1440)}일 ${Math.floor((minutes % 1440) / 60)}시간 남음`;
    if (minutes >= 60) return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 남음`;
    return `${minutes}분 남음`;
  }
  function schedule(ms) {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(tick, ms);
  }
  async function lockedText(response) {
    let wait = Number(response.headers.get('Retry-After')) || 900;
    try { wait = Number((await response.json()).wait) || wait; } catch (e) { /* noop */ }
    return `코드가 여러 번 틀려 잠시 막혔어요. 약 ${Math.ceil(wait / 60)}분 뒤 다시 넣어 주세요.`;
  }
  // 화면 · 채팅 요청 공통: 받은 데이터(JSON)를 돌려준다. 바뀐 게 없으면 'same', 여기서 처리가 끝났으면 null.
  async function fetchData(path, interval) {
    let response;
    try {
      response = await call(path);
    } catch (e) {
      setDot('wait'); meta.textContent = '연결이 끊겼어요 · 다시 시도하는 중'; schedule(3000); return null;
    }
    if (response.status === 204) { setDot('live'); meta.textContent = leftText(); schedule(interval); return 'same'; }
    if (response.status === 404) { end('공유가 끝났거나 없는 링크예요.'); return null; }
    if (response.status === 410) { end('공유한 창이 닫혔어요.'); return null; }
    if (response.status === 403) { askCode('접근 코드가 맞지 않아요. 다시 넣어 주세요.'); return null; }
    if (response.status === 429) {
      let state = '';
      try { state = (await response.clone().json()).state; } catch (e) { /* noop */ }
      if (state === 'code_locked') { askCode(await lockedText(response)); return null; }
      const wait = Number(response.headers.get('Retry-After')) || 5;
      setDot('wait'); schedule(Math.min(60, wait) * 1000); return null;
    }
    if (!response.ok) { setDot('wait'); schedule(3000); return null; }
    let data;
    try { data = await response.json(); } catch (e) { schedule(3000); return null; }
    if (data.expires) expires = Number(data.expires);
    setDot('live');
    meta.textContent = leftText();
    return data;
  }
  async function termTick() {
    const data = await fetchData(`/api/view/screen?h=${encodeURIComponent(hash)}`, 1000);
    if (!data || data === 'same') return;
    hash = typeof data.hash === 'string' ? data.hash : '';
    setNote('');
    render(data);
    schedule(1000);
  }
  let ticking = false;
  async function tick() {
    if (stopped || !code) return;
    if (paused || document.hidden) { schedule(1000); return; }
    if (ticking) return;
    ticking = true;
    const mine = mode;
    try { await (mine === 'chat' ? chatTick() : termTick()); } finally { ticking = false; }
    if (mine !== mode) schedule(0);   // 받는 사이 탭을 바꿨다 → 바로 그 탭 것을 받는다
  }

  // ════════════════════════════════════════════════════════════════════
  // 채팅: 에이전트 대화 기록 (읽기만). 처음엔 마지막 100개, 위로 올리면 이전 기록을 이어 받아 처음까지 볼 수 있다.
  // ════════════════════════════════════════════════════════════════════
  const chatBox = $('vwChat');
  const list = $('vwList');
  const olderBtn = $('vwOlder');
  const tabs = $('vwTabs');
  const tabChat = $('vwTabChat');
  const tabTerm = $('vwTabTerm');
  const chat = { items: new Map(), ids: [], total: 0, hash: '', query: '', agent: '', loadingOlder: false };
  const OUTPUT_FOLD = 24;
  const DIFF_FOLD = 60;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function timeOf(ts) {
    const date = ts ? new Date(ts) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    const sameDay = date.toDateString() === new Date().toDateString();
    return date.toLocaleString('ko-KR', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  // 마크다운 → 걸러 낸 HTML. 허용한 태그 · 속성만 남기고(스크립트 · 그림 · 스타일 · 이벤트 속성 없음) 링크는 새 탭 · http(s) 만.
  const MD_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'span', 'sub', 'sup'];
  function markdown(text) {
    const body = el('div', 'vm-body');
    const parse = window.marked && (window.marked.parse || window.marked);
    if (typeof parse !== 'function' || !window.DOMPurify) { body.style.whiteSpace = 'pre-wrap'; body.textContent = text; return body; }
    try {
      const html = parse(String(text), { gfm: true, breaks: true });
      body.innerHTML = window.DOMPurify.sanitize(html, { ALLOWED_TAGS: MD_TAGS, ALLOWED_ATTR: ['href', 'title', 'align', 'start'], ALLOW_DATA_ATTR: false });
      body.querySelectorAll('a').forEach((a) => {
        if (/^https?:\/\//i.test(a.getAttribute('href') || '')) { a.target = '_blank'; a.rel = 'noopener noreferrer nofollow'; }
        else a.removeAttribute('href');
      });
    } catch (e) {
      body.style.whiteSpace = 'pre-wrap';
      body.textContent = text;
    }
    return body;
  }
  // 긴 내용은 앞부분만 그리고 '더 보기'로 나머지를 붙인다 (내용은 버리지 않는다)
  function folded(host, nodes, limit) {
    const cut = nodes.length > limit + 8 ? limit : nodes.length;
    nodes.slice(0, cut).forEach((n) => host.append(n));
    if (cut >= nodes.length) return null;
    const more = el('button', 'vw-more', `나머지 ${nodes.length - cut}줄 더 보기`);
    more.type = 'button';
    more.addEventListener('click', () => { nodes.slice(cut).forEach((n) => host.append(n)); more.remove(); });
    return more;
  }
  function toolNode(item, old) {
    const box = el('details', `vt${item.error ? ' err' : ''}${item.output == null || item.running ? ' run' : ''}`);
    const summary = el('summary');
    const diffs = Array.isArray(item.diffs) ? item.diffs : [];
    summary.append(el('span', 'vt-name', item.name === 'exec' && diffs.length ? 'apply_patch' : (item.name || '도구')));
    if (diffs.length) {
      const names = diffs.map((d) => String(d.file || '').split('/').pop()).filter(Boolean);
      summary.append(el('span', 'vt-sum', names.slice(0, 3).join(', ') + (names.length > 3 ? ` 외 ${names.length - 3}` : '')));
      const stat = el('span', 'vt-stat');
      stat.append(el('b', 'a', `+${diffs.reduce((n, d) => n + (d.add || 0), 0)}`), ' ', el('b', 'd', `−${diffs.reduce((n, d) => n + (d.del || 0), 0)}`));
      summary.append(stat);
    } else {
      summary.append(el('span', 'vt-sum', item.summary || ''));
    }
    summary.append(el('span', 'vt-state', item.output == null || item.running ? '⋯' : item.error ? '✕' : '✓'));
    box.append(summary);
    diffs.forEach((d) => {
      const file = el('div', 'vd-file');
      const head = el('div', 'vd-head');
      head.append(el('span', 'p', d.file || ''), el('span', '', { add: '새 파일', delete: '삭제' }[d.op] || ''));
      file.append(head);
      const rows = [];
      (d.hunks || []).forEach((h, index) => {
        let oldNo = Number.isInteger(h.o) ? h.o : null;
        let newNo = Number.isInteger(h.n) ? h.n : null;
        if (index > 0) rows.push(el('span', 'vd-row vd-gap', '      ⋯'));
        (h.lines || []).forEach((line) => {
          const sign = String(line)[0];
          const kind = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
          const no = kind === 'del' ? oldNo : newNo;
          if (kind !== 'add' && oldNo !== null) oldNo += 1;
          if (kind !== 'del' && newNo !== null) newNo += 1;
          const row = el('span', `vd-row vd-${kind}`);
          row.append(el('span', 'no', no == null ? '' : String(no)), el('span', 'sg', kind === 'ctx' ? '' : sign), document.createTextNode(String(line).slice(1) || ' '));
          rows.push(row);
        });
      });
      if (rows.length) {
        const bodyEl = el('div', 'vd-body');
        const more = folded(bodyEl, rows, DIFF_FOLD);
        file.append(bodyEl);
        if (more) file.append(more);
      }
      if (d.cut) file.append(el('div', 'vd-cut', '… 길어서 일부만 보여요'));
      box.append(file);
    });
    if (item.output && (!diffs.length || item.error)) {
      const pre = el('pre');
      const lines = String(item.output).split('\n').map((line, i, all) => document.createTextNode(i < all.length - 1 ? `${line}\n` : line));
      const more = folded(pre, lines, OUTPUT_FOLD);
      box.append(pre);
      if (more) box.append(more);
    }
    // 기본은 펼침. 보는 사람이 접거나 편 것은 다시 그려도 그대로 둔다
    box.open = old && old.dataset.toggled ? old.open : true;
    if (old && old.dataset.toggled) box.dataset.toggled = '1';
    summary.addEventListener('click', () => { box.dataset.toggled = '1'; });
    return box;
  }
  function itemNode(item, old) {
    if (item.kind === 'user') {
      const box = el('div', 'vm vm-user');
      box.append(el('div', 'vm-meta', `사용자 · ${timeOf(item.ts)}`));
      const text = [item.images ? `[그림 ${item.images}개]` : '', item.text || ''].filter(Boolean).join('\n');
      box.append(el('div', 'vm-body', text));
      return box;
    }
    if (item.kind === 'assistant') {
      const box = el('div', 'vm');
      box.append(el('div', 'vm-meta', `${{ claude: 'Claude', codex: 'Codex' }[chat.agent] || 'Agent'} · ${timeOf(item.ts)}`), markdown(item.text || ''));
      return box;
    }
    if (item.kind === 'system') return el('div', 'vm-sys', item.text || '');
    if (item.kind === 'subagent') {
      const box = el('details', 'vt');
      const summary = el('summary');
      summary.append(el('span', 'vt-name', item.name || '서브에이전트'), el('span', 'vt-sum', String(item.text || '').replace(/\s+/g, ' ').slice(0, 160)), el('span', 'vt-state', timeOf(item.ts)));
      const body = markdown(item.text || '(내용 없음)');
      body.style.padding = '8px 12px';
      box.append(summary, body);
      if (old && old.dataset.toggled) { box.open = old.open; box.dataset.toggled = '1'; }
      summary.addEventListener('click', () => { box.dataset.toggled = '1'; });
      return box;
    }
    return toolNode(item, old);
  }
  function upsert(item) {
    if (!item || !Number.isInteger(item.id)) return;
    const sig = JSON.stringify(item);
    const known = chat.items.get(item.id);
    if (known && known.sig === sig) return;
    const node = itemNode(item, known && known.node);
    if (known) { known.node.replaceWith(node); chat.items.set(item.id, { sig, node }); return; }
    // id 순서대로 끼워 넣는다
    let at = chat.ids.length;
    while (at > 0 && chat.ids[at - 1] > item.id) at -= 1;
    const next = at < chat.ids.length ? chat.items.get(chat.ids[at]).node : null;
    list.insertBefore(node, next);
    chat.ids.splice(at, 0, item.id);
    chat.items.set(item.id, { sig, node });
  }
  function resetChat() {
    chat.items.clear();
    chat.ids = [];
    chat.total = 0;
    chat.hash = '';
    chat.query = '';
    list.replaceChildren();
    olderBtn.classList.add('hidden');
  }
  function chatUnavailable() {
    tabs.classList.add('hidden');
    setMode('term');
  }
  async function chatTick() {
    const first = !chat.ids.length;
    const maxId = first ? -1 : chat.ids[chat.ids.length - 1];
    // 뒤쪽 40개는 다시 받는다 (도구 결과가 나중에 채워지므로). 새 항목이 많으면 이어서 계속 받는다.
    const query = first ? 'limit=100' : `start=${Math.max(chat.ids[0], maxId - 40)}&limit=200`;
    const sameQuery = query === chat.query;
    const data = await fetchData(`/api/view/chat?${query}${sameQuery && chat.hash ? `&h=${encodeURIComponent(chat.hash)}` : ''}`, 2000);
    if (!data || data === 'same') return;
    if (mode !== 'chat') return;
    if (!data.available) { chatUnavailable(); return; }
    if (Number(data.total) < chat.total) resetChat();   // 대화가 바뀌었다 (/clear · 새 세션) → 처음부터 다시
    chat.agent = String(data.agent || '');
    chat.total = Number(data.total) || 0;
    chat.query = query;
    chat.hash = typeof data.hash === 'string' ? data.hash : '';
    const stick = follow;
    (data.items || []).forEach(upsert);
    (data.related || []).forEach((item) => { if (chat.items.has(item.id)) upsert(item); });
    setNote(chat.ids.length ? '' : '아직 대화가 없어요.');
    olderBtn.classList.toggle('hidden', !chat.ids.length || chat.ids[0] === 0);
    if (stick) { main.scrollTop = main.scrollHeight; requestAnimationFrame(() => { if (follow) main.scrollTop = main.scrollHeight; }); }
    const newest = chat.ids.length ? chat.ids[chat.ids.length - 1] : -1;
    schedule(newest + 1 < chat.total ? 300 : 2000);
  }
  async function loadOlder() {
    if (chat.loadingOlder || !chat.ids.length || chat.ids[0] === 0 || stopped) return;
    chat.loadingOlder = true;
    olderBtn.disabled = true;
    olderBtn.textContent = '불러오는 중…';
    try {
      const first = chat.ids[0];
      const start = Math.max(0, first - 150);
      const response = await call(`/api/view/chat?start=${start}&limit=${first - start}`);
      if (response.ok) {
        const data = await response.json();
        if (data.available && mode === 'chat') {
          const before = main.scrollHeight;
          const top = main.scrollTop;
          (data.items || []).filter((item) => item.id < first).forEach(upsert);
          main.scrollTop = top + (main.scrollHeight - before);   // 보던 자리 그대로
          olderBtn.classList.toggle('hidden', chat.ids[0] === 0);
        }
      }
    } catch (e) { /* 다음에 다시 */ }
    chat.loadingOlder = false;
    olderBtn.disabled = false;
    olderBtn.textContent = '이전 대화 더 보기';
  }
  olderBtn.addEventListener('click', loadOlder);

  function setMode(next) {
    mode = next;
    const isChat = mode === 'chat';
    tabChat.setAttribute('aria-selected', String(isChat));
    tabTerm.setAttribute('aria-selected', String(!isChat));
    chatBox.classList.toggle('hidden', !isChat);
    term.classList.toggle('hidden', isChat);
    fitBtn.classList.toggle('hidden', isChat);
    hash = '';
    chat.hash = '';
    follow = true;
    latest.classList.add('hidden');
    setNote((isChat ? chat.ids.length : last) ? '' : '불러오는 중…');
    if (!isChat) applyFit();
    main.scrollTop = main.scrollHeight;
    if (!stopped && code) { clearTimeout(timer); tick(); }
  }
  tabChat.addEventListener('click', () => { if (mode !== 'chat') setMode('chat'); });
  tabTerm.addEventListener('click', () => { if (mode !== 'term') setMode('term'); });

  // 코드를 확인하고 (맞으면) 보기 시작
  async function open() {
    let response;
    try { response = await call('/api/view/info'); } catch (e) { setNote('연결하지 못했어요. 잠시 뒤 새로 고쳐 주세요.'); return; }
    if (response.status === 401) { askCode(''); return; }
    if (response.status === 403) { askCode('접근 코드가 맞지 않아요.'); return; }
    if (response.status === 429) {
      let state = '';
      try { state = (await response.clone().json()).state; } catch (e) { /* noop */ }
      if (state === 'code_locked') { askCode(await lockedText(response)); return; }
      if (code) { askCode('잠시 뒤 다시 시도해 주세요.'); return; }
      setNote('잠시 뒤 새로 고쳐 주세요.');
      return;
    }
    if (!response.ok) { end('공유가 끝났거나 없는 링크예요.'); return; }
    const info = await response.json();
    const title = String(info.title || '터미널 화면');
    $('vwTitle').textContent = title;
    document.title = `${title} · 화면 보기`;
    expires = Number(info.expires) || 0;
    store.set(CODE_KEY, code);
    codeForm.classList.add('hidden');
    // 에이전트(Claude · Codex) 창이면 채팅 · 터미널 탭을 둘 다 보여 주고 채팅부터 연다
    tabs.classList.toggle('hidden', !info.chat);
    setMode(info.chat ? 'chat' : 'term');
  }

  codeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (value.length !== 12) { codeErr.textContent = '코드는 12자리예요 (예: ABCD-EFGH-JKLM).'; return; }
    code = value;
    codeBtn.disabled = true;
    codeErr.textContent = '';
    open().finally(() => { codeBtn.disabled = false; });
  });

  // ── 조작 (보기 설정만) ──
  fitBtn.addEventListener('click', () => {
    fit = !fit;
    fitBtn.setAttribute('aria-pressed', String(fit));
    applyFit();
  });
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.textContent = paused ? '이어 보기' : '멈춤';
    if (paused) { setDot('wait'); meta.textContent = '멈춤'; } else tick();
  });
  main.addEventListener('scroll', () => {
    const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 4;
    if (atBottom) follow = true;
    latest.classList.toggle('hidden', atBottom || !(mode === 'chat' ? chat.ids.length : last));
    // 채팅: 맨 위 가까이 올리면 이전 대화를 이어서 불러온다 (처음까지)
    if (mode === 'chat' && main.scrollTop < 300) loadOlder();
  }, { passive: true });
  main.addEventListener('wheel', (event) => { if (event.deltaY < 0) follow = false; }, { passive: true });
  main.addEventListener('touchmove', () => { follow = false; }, { passive: true });
  latest.addEventListener('click', () => { follow = true; main.scrollTop = main.scrollHeight; });
  window.addEventListener('resize', applyFit);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !stopped && !paused && code) tick(); });

  if (!TOKEN.test(token)) end('링크가 올바르지 않아요. 받은 주소 전체를 그대로 열어 주세요.');
  else open();
})();
