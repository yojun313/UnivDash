// Sidebar server status: shows CPU, GPU (usage, VRAM), memory, disk and network live below OVERVIEW.
// - What to show and the update interval are set in the settings window under 'Server status' (this-device settings, sysmon-* in UnivDash.settings).
// - Does not poll while the tab is hidden or the sidebar is collapsed. The server caches briefly, so several screens polling together is fine.
(function () {
  'use strict';
  const U = () => window.UnivDash;
  const KEYS = ['cpu', 'gpu', 'mem', 'disk', 'net'];
  const HISTORY = 40;
  const history = new Map();   // 'cpu' · 'gpu0' … → recent usage (for the small graph)
  let el = null;
  let timer = null;
  let busy = false;
  let last = null;
  let shape = '';
  let failures = 0;

  const on = (key) => !!U().settings.get(`sysmon-${key}`);
  // Lite mode: double the refresh interval (at least 4 seconds)
  const lite = () => document.documentElement.hasAttribute('data-ui-lite');
  const interval = () => {
    const base = Math.min(60, Math.max(1, Number(U().settings.get('sysmon-interval')) || 2));
    return (lite() ? Math.max(4, base * 2) : base) * 1000;
  };
  const anyOn = () => KEYS.some(on);
  const wide = window.matchMedia('(min-width: 768px)');
  // Do not poll while the tab is hidden, the sidebar is collapsed (desktop), or the sidebar is closed on a phone
  const visible = () => !document.hidden && !!el?.getClientRects().length
    && (wide.matches || !document.getElementById('sidebar')?.classList.contains('-translate-x-full'));
  const esc = (s) => U().escapeHtml(String(s));
  const pct = (n) => (n == null ? '—' : `${Math.round(n)}%`);
  const level = (n) => (n == null ? '' : n >= 90 ? 'hot' : n >= 70 ? 'warn' : 'ok');
  function size(n, digits = 1) {
    if (n == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${n >= 100 || i < 2 ? Math.round(n) : n.toFixed(digits)}${units[i]}`;
  }
  // In the same unit: "16.2 / 125GB"
  function pair(used, total) {
    if (used == null || total == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0;
    let all = total;
    while (all >= 1024 && i < units.length - 1) { all /= 1024; i += 1; }
    const u = used / 1024 ** i;
    const f = (x) => (x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, ''));
    return `${f(u)} / ${f(all)}${units[i]}`;
  }
  function push(key, value) {
    if (value == null) return;
    const list = history.get(key) || [];
    list.push(value);
    if (list.length > HISTORY) list.shift();
    history.set(key, list);
  }
  function spark(key) {
    const list = history.get(key) || [];
    if (list.length < 2) return '';
    const step = 100 / (HISTORY - 1);
    const start = 100 - (list.length - 1) * step;
    const pts = list.map((v, i) => `${(start + i * step).toFixed(1)},${(30 - (Math.min(100, Math.max(0, v)) / 100) * 28).toFixed(1)}`);
    return `<polygon points="${start.toFixed(1)},30 ${pts.join(' ')} 100,30"/><polyline points="${pts.join(' ')}"/>`;
  }

  const line = (k, label, title) => `
    <div class="sm-line" data-k="${k}" ${title ? `title="${esc(title)}"` : ''}>
      <span class="sm-name">${esc(label)}</span>
      <span class="sm-bar"><i></i></span>
      <span class="sm-val"></span>
    </div>`;
  const item = (k, icon, title, body, sparkKey) => `
    <div class="sm-item" data-item="${k}">
      ${sparkKey ? `<svg class="sm-spark" data-spark="${sparkKey}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"></svg>` : ''}
      <p class="sm-head"><i class="fas ${icon}"></i><span class="sm-title">${esc(title)}</span><span class="sm-extra" data-extra="${k}"></span></p>
      ${body}
    </div>`;

  const short = (name) => name.replace(/^NVIDIA\s+/, '');
  // Compact: one per line (name, bar, %). Detailed values on hover.
  function compact(d) {
    const rows = [];
    if (on('cpu')) rows.push(line('cpu', 'CPU'));
    if (on('gpu')) {
      if (d.gpus.length) d.gpus.forEach((g, i) => { const n = d.gpus.length > 1 ? g.index : ''; rows.push(line(`gpu${i}-util`, `GPU${n}`), line(`gpu${i}-mem`, `VRAM${n}`)); });
      else rows.push(`<p class="sm-sub" title="${t('nvidia-smi 를 찾지 못했습니다.')}">${t('GPU 없음')}</p>`);
    }
    if (on('mem')) rows.push(line('mem', 'RAM'));
    if (on('disk')) d.disks.forEach((x, i) => rows.push(line(`disk${i}`, x.mount === '/' ? t('디스크') : x.mount.split('/').pop() || x.mount)));
    if (on('net')) rows.push('<div class="sm-line sm-netline"><span class="sm-name">NET</span><span class="sm-sub sm-net" data-sub="net"></span></div>');
    return `<div class="sm-item sm-compact">${rows.join('')}</div>`;
  }
  function skeleton(d) {
    if (!U().settings.get('sysmon-detail')) return caption() + compact(d);
    const parts = [];
    if (on('cpu')) parts.push(item('cpu', 'fa-microchip', 'CPU', line('cpu', t('사용률')) + '<p class="sm-sub" data-sub="cpu"></p>', 'cpu'));
    if (on('gpu')) {
      if (d.gpus.length) {
        d.gpus.forEach((g, i) => parts.push(item(`gpu${i}`, 'fa-bolt', d.gpus.length > 1 ? `GPU ${g.index} · ${short(g.name)}` : short(g.name),
          line(`gpu${i}-util`, t('사용률')) + line(`gpu${i}-mem`, 'VRAM') + `<p class="sm-sub" data-sub="gpu${i}"></p>`, `gpu${i}`)));
      } else parts.push(item('gpu', 'fa-bolt', 'GPU', `<p class="sm-sub">${t('GPU 를 찾지 못했습니다 (nvidia-smi).')}</p>`));
    }
    if (on('mem')) parts.push(item('mem', 'fa-memory', t('메모리'), line('mem', 'RAM') + '<p class="sm-sub" data-sub="mem"></p>'));
    if (on('disk')) parts.push(item('disk', 'fa-hard-drive', t('디스크'), d.disks.map((x, i) => line(`disk${i}`, x.mount === '/' ? '/' : x.mount.split('/').pop() || x.mount, x.mount)).join('')));
    if (on('net')) parts.push(item('net', 'fa-arrow-right-arrow-left', t('네트워크'), '<p class="sm-sub sm-net" data-sub="net"></p>'));
    return `${caption()}<div class="sm-list">${parts.join('')}</div>`;
  }
  const caption = () => {
    const detail = !!U().settings.get('sysmon-detail');
    return `<p class="sm-caption"><span>Server</span><span class="sm-tools">
      <button type="button" class="sm-toggle" data-sm-detail aria-pressed="${detail}" title="${detail ? t('간단히 보기') : t('자세히 보기')}">${detail ? t('간단히') : t('자세히')}</button>
      <span class="sm-live" title="${t('업데이트 주기 (설정 → 서버 상태)')}"><i class="sm-dot"></i>${t('{n}초', { n: interval() / 1000 })}</span></span></p>`;
  };
  function setLine(k, percent, text) {
    const row = el.querySelector(`[data-k="${k}"]`);
    if (!row) return;
    const bar = row.querySelector('.sm-bar i');
    bar.style.width = `${Math.min(100, Math.max(0, percent || 0))}%`;
    row.dataset.level = level(percent);
    row.querySelector('.sm-val').textContent = text ?? pct(percent);
  }
  const setTitle = (k, text) => { const row = el.querySelector(`[data-k="${k}"]`); if (row) row.title = text; };
  const setText = (sel, text) => { const node = el.querySelector(sel); if (node) node.textContent = text; };

  function paint(d) {
    const next = `${KEYS.map((k) => (on(k) ? 1 : 0)).join('')}|${U().settings.get('sysmon-detail') ? 'd' : 'c'}|${d.gpus.length}|${d.disks.map((x) => x.mount).join(',')}|${interval()}`;
    if (next !== shape) { shape = next; el.innerHTML = skeleton(d); }
    el.classList.toggle('stale', failures > 0);
    if (on('cpu')) {
      setLine('cpu', d.cpu.percent);
      const bits = [t('{n}코어', { n: d.cpu.cores })];
      if (d.cpu.temp != null) bits.push(`${Math.round(d.cpu.temp)}°C`);
      if (d.cpu.load) bits.push(t('부하 {load}', { load: d.cpu.load[0] }));
      setText('[data-sub="cpu"]', bits.join(' · '));
      setTitle('cpu', `CPU ${pct(d.cpu.percent)} · ${bits.join(' · ')}`);
    }
    if (on('gpu')) d.gpus.forEach((g, i) => {
      setLine(`gpu${i}-util`, g.util);
      const memPct = g.mem_total ? (g.mem_used / g.mem_total) * 100 : null;
      setLine(`gpu${i}-mem`, memPct);
      setTitle(`gpu${i}-mem`, `VRAM ${pair(g.mem_used, g.mem_total)} (${pct(memPct)})`);
      setTitle(`gpu${i}-util`, [t('{name} 사용률 {percent}', { name: short(g.name), percent: pct(g.util) }), g.temp != null ? `${Math.round(g.temp)}°C` : '', g.power != null ? `${Math.round(g.power)}${g.power_limit ? `/${Math.round(g.power_limit)}` : ''}W` : ''].filter(Boolean).join(' · '));
      setText(`[data-sub="gpu${i}"]`, [`VRAM ${pair(g.mem_used, g.mem_total)}`, g.power != null ? `${Math.round(g.power)}${g.power_limit ? `/${Math.round(g.power_limit)}` : ''}W` : ''].filter(Boolean).join(' · '));
      setText(`[data-extra="gpu${i}"]`, g.temp != null ? `${Math.round(g.temp)}°C` : '');
    });
    if (on('mem')) {
      setLine('mem', d.memory.percent);
      const memText = `${pair(d.memory.used, d.memory.total)}${d.memory.swap_total ? ` · ${t('스왑 {size}', { size: size(d.memory.swap_used) })}` : ''}`;
      setText('[data-sub="mem"]', memText);
      setTitle('mem', `RAM ${pct(d.memory.percent)} · ${memText}`);
    }
    if (on('disk')) d.disks.forEach((x, i) => {
      setLine(`disk${i}`, x.percent);
      setTitle(`disk${i}`, `${x.mount} · ${pair(x.used, x.total)} (${pct(x.percent)})`);
    });
    if (on('net')) setText('[data-sub="net"]', d.net ? `↓ ${size(d.net.rx)}/s   ↑ ${size(d.net.tx)}/s` : t('재는 중…'));
    el.querySelectorAll('[data-spark]').forEach((svg) => { svg.innerHTML = spark(svg.dataset.spark); });
  }

  function schedule(delay = interval()) {
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }
  async function tick() {
    timer = null;
    if (!anyOn()) { el.hidden = true; el.innerHTML = ''; shape = ''; return; }
    el.hidden = false;
    if (!visible() || busy) { schedule(); return; }
    busy = true;
    try {
      const response = await fetch('/api/sysmon', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) return;   // signed out → stop
      if (!response.ok) throw new Error(String(response.status));
      last = await response.json();
      failures = 0;
      push('cpu', last.cpu.percent);
      last.gpus.forEach((g, i) => push(`gpu${i}`, g.util));
      paint(last);
    } catch (error) {
      failures += 1;
      if (last) paint(last); else el.innerHTML = `<p class="sm-caption"><span>Server</span></p><p class="sm-sub">${t('서버 상태를 불러오지 못했습니다.')}</p>`;
    } finally { busy = false; }
    schedule(failures ? Math.min(30000, interval() * 2 ** Math.min(failures, 4)) : interval());
  }

  function init() {
    el = document.getElementById('sysMon');
    if (!el || !window.UnivDash) return;
    window.addEventListener('univdash:settings', (event) => {
      const key = event.detail?.key || '';
      if (!key.startsWith('sysmon-')) return;
      if (last && anyOn()) { el.hidden = false; paint(last); }
      schedule(0);
    });
    el.addEventListener('click', (event) => {
      if (event.target.closest('[data-sm-detail]')) U().settings.set('sysmon-detail', !U().settings.get('sysmon-detail'));
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
    // Right away when a collapsed sidebar is expanded
    let shown = visible();
    const observer = new MutationObserver(() => {
      const now = visible();
      if (now && !shown && !busy) schedule(0);
      shown = now;
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const sidebar = document.getElementById('sidebar');
    if (sidebar) observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
    wide.addEventListener?.('change', () => { if (visible() && !busy) schedule(0); });
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
