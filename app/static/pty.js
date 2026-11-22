// Terminal (not tmux): an xterm.js screen attached to a server PTY over WebSocket.
// UnivDashPty.create(cwd) → starts a shell on the server and returns { id }.
// UnivDashPty.attach(container, id, { onTitle, onExit, onGone }) → attaches a screen (reconnects when dropped and continues from the recent output).
(function () {
  'use strict';
  const { api } = window.UnivDash;

  const THEME = {
    background: '#0b0f19', foreground: '#d4d8e1', cursor: '#e2e8f0', cursorAccent: '#0b0f19', selectionBackground: 'rgba(59,130,246,0.35)',
    black: '#1e293b', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e2e8f0',
    brightBlack: '#64748b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f8fafc',
  };

  const LIGHT = {
    background: '#f8fafc', foreground: '#1e293b', cursor: '#0f172a', cursorAccent: '#f8fafc', selectionBackground: 'rgba(37,99,235,0.22)',
    black: '#1e293b', red: '#c0262d', green: '#15803d', yellow: '#a16207', blue: '#1d4ed8', magenta: '#9333ea', cyan: '#0e7490', white: '#64748b',
    brightBlack: '#475569', brightRed: '#dc2626', brightGreen: '#16a34a', brightYellow: '#ca8a04', brightBlue: '#2563eb', brightMagenta: '#a855f7', brightCyan: '#0891b2', brightWhite: '#0f172a',
  };
  const isLight = () => document.documentElement.getAttribute('data-ui-theme-mode') === 'light';

  async function create(cwd = '') {
    const cols = 100;
    const rows = 30;
    return api('/api/pty', { method: 'POST', body: { cwd, cols, rows } });
  }
  async function list() { return (await api('/api/pty')).terminals; }
  async function kill(id) { try { await api(`/api/pty/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) { /* already gone */ } }

  function attach(container, id, handlers = {}) {
    const el = document.createElement('div');
    el.className = 'pty-screen';
    container.appendChild(el);
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const term = new window.Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, 'D2Coding', monospace", fontSize: coarse ? 12 : 13, lineHeight: 1.15,
      cursorBlink: true, scrollback: 8000, theme: isLight() ? LIGHT : THEME, allowProposedApi: false, macOptionIsMeta: true, convertEol: false,
      minimumContrastRatio: isLight() ? 4.5 : 1,   // light mode: keep colors meant for dark backgrounds readable
    });
    const themeWatch = new MutationObserver(() => {
      term.options.theme = isLight() ? LIGHT : THEME;
      term.options.minimumContrastRatio = isLight() ? 4.5 : 1;
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-theme-mode'] });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    if (window.WebLinksAddon) term.loadAddon(new window.WebLinksAddon.WebLinksAddon((event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    term.open(el);

    let ws = null;
    let dead = false;
    let gone = false;
    let retry = 0;
    let disposed = false;
    const send = (message) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    function connect() {
      if (disposed || gone) return;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/pty/${encodeURIComponent(id)}`);
      ws.onopen = () => { retry = 0; send({ t: 'resize', cols: term.cols, rows: term.rows }); };
      ws.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (e) { return; }
        if (message.t === 'out') {
          if (message.replay) term.reset();   // on reattach, redraw the screen from the recent output kept on the server
          term.write(message.d);
        } else if (message.t === 'exit') {
          dead = true;
          term.write(`\r\n\x1b[2m${message.code != null ? t('[Terminal 이 종료되었습니다 (코드 {code})]', { code: message.code }) : t('[Terminal 이 종료되었습니다]')}\x1b[0m\r\n`);
          handlers.onExit?.(message.code);
        } else if (message.t === 'gone') {
          gone = true;
          term.write(`\r\n\x1b[2m${t('[이 Terminal 은 더 이상 없습니다 — 서버가 다시 시작되었을 수 있습니다]')}\x1b[0m\r\n`);
          handlers.onGone?.();
        }
      };
      ws.onclose = () => {
        if (disposed || gone || dead) return;
        retry += 1;
        setTimeout(connect, Math.min(8000, 600 * retry));
      };
    }
    term.onData((data) => { if (!dead) send({ t: 'in', d: data }); });
    term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));
    term.onTitleChange((title) => handlers.onTitle?.(title));

    function refit() {
      if (!el.offsetParent) return;   // a hidden tab cannot be measured
      try { fit.fit(); } catch (e) { /* noop */ }
    }
    const observer = new ResizeObserver(() => refit());
    observer.observe(el);
    document.fonts?.ready.then(() => { term.options.fontFamily = term.options.fontFamily; refit(); });
    connect();

    return {
      el, term, refit,
      focus() { term.focus(); },
      sendKeys(data) { if (!dead) send({ t: 'in', d: data }); term.focus(); },
      get dead() { return dead || gone; },
      dispose() { disposed = true; observer.disconnect(); themeWatch.disconnect(); try { ws?.close(); } catch (e) { /* noop */ } term.dispose(); el.remove(); },
    };
  }

  // Keys missing from phone keyboards (special key row)
  const KEYS = {
    Esc: '\x1b', Tab: '\t', '^C': '\x03', '^D': '\x04', '^Z': '\x1a', '^L': '\x0c', '^R': '\x12',
    '↑': '\x1b[A', '↓': '\x1b[B', '←': '\x1b[D', '→': '\x1b[C', Home: '\x1b[H', End: '\x1b[F', PgUp: '\x1b[5~', PgDn: '\x1b[6~',
    '|': '|', '~': '~', '/': '/', '-': '-',
  };

  window.UnivDashPty = { create, list, kill, attach, KEYS };
})();
