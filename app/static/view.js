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
  async function tick() {
    if (stopped || !code) return;
    if (paused || document.hidden) { schedule(1000); return; }
    let response;
    try {
      response = await call(`/api/view/screen?h=${encodeURIComponent(hash)}`);
    } catch (e) {
      setDot('wait'); meta.textContent = '연결이 끊겼어요 · 다시 시도하는 중'; schedule(3000); return;
    }
    if (response.status === 204) { setDot('live'); meta.textContent = leftText(); schedule(1000); return; }
    if (response.status === 404) { end('공유가 끝났거나 없는 링크예요.'); return; }
    if (response.status === 410) { end('공유한 창이 닫혔어요.'); return; }
    if (response.status === 403) { askCode('접근 코드가 맞지 않아요. 다시 넣어 주세요.'); return; }
    if (response.status === 429) {
      let state = '';
      try { state = (await response.clone().json()).state; } catch (e) { /* noop */ }
      if (state === 'code_locked') { askCode(await lockedText(response)); return; }
      const wait = Number(response.headers.get('Retry-After')) || 5;
      setDot('wait'); schedule(Math.min(60, wait) * 1000); return;
    }
    if (!response.ok) { setDot('wait'); schedule(3000); return; }
    let data;
    try { data = await response.json(); } catch (e) { schedule(3000); return; }
    hash = typeof data.hash === 'string' ? data.hash : '';
    if (data.expires) expires = Number(data.expires);
    setNote('');
    setDot('live');
    meta.textContent = leftText();
    render(data);
    schedule(1000);
  }

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
    setNote('불러오는 중…');
    tick();
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
    latest.classList.toggle('hidden', atBottom || !last);
  }, { passive: true });
  main.addEventListener('wheel', (event) => { if (event.deltaY < 0) follow = false; }, { passive: true });
  main.addEventListener('touchmove', () => { follow = false; }, { passive: true });
  latest.addEventListener('click', () => { follow = true; main.scrollTop = main.scrollHeight; });
  window.addEventListener('resize', applyFit);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !stopped && !paused && code && last) tick(); });

  if (!TOKEN.test(token)) end('링크가 올바르지 않아요. 받은 주소 전체를 그대로 열어 주세요.');
  else open();
})();
