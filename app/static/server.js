// 서버 & 프로세스 페이지: 서버 자원, PM2 프로세스 상태 · 제어 · 실시간 로그
(function () {
'use strict';

let logSocket = null;
const charts = {};
const maxDataPoints = 20;

function getChartThemeColors() {
    const isLight = window.UnivDashTheme
        ? window.UnivDashTheme.current() === 'light'
        : document.documentElement.getAttribute('data-ui-theme-mode') === 'light';
    return isLight
        ? { grid: 'rgba(15, 23, 42, 0.08)', ticks: '#5a6781' }
        : { grid: 'rgba(255, 255, 255, 0.07)', ticks: 'rgba(255, 255, 255, 0.45)' };
}

function initChart(name) {
    const ctx = document.getElementById(`chart-${name}`).getContext('2d');
    const themeColors = getChartThemeColors();
    charts[name] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array(maxDataPoints).fill(''),
            datasets: [
                {
                    label: 'CPU (%)',
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.12)',
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 0,
                    data: Array(maxDataPoints).fill(0),
                    tension: 0.3,
                    yAxisID: 'y-cpu'
                },
                {
                    label: 'Mem (MB)',
                    borderColor: '#60a5fa',
                    borderWidth: 2,
                    pointRadius: 0,
                    data: Array(maxDataPoints).fill(0),
                    tension: 0.3,
                    yAxisID: 'y-mem'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { display: false },
                'y-cpu': {
                    type: 'linear',
                    position: 'left',
                    min: 0,
                    max: 100,
                    grid: { color: themeColors.grid },
                    ticks: { color: themeColors.ticks, font: { size: 9 } }
                },
                'y-mem': {
                    type: 'linear',
                    position: 'right',
                    grid: { drawOnChartArea: false },
                    ticks: { color: themeColors.ticks, font: { size: 9 } }
                }
            }
        }
    });
}

function toggleChart(name) {
    const row = document.getElementById(`chart-row-${name}`);
    if (!row) return;
    if (row.classList.contains('hidden')) {
        row.classList.remove('hidden');
        if (!charts[name]) initChart(name);
    } else {
        row.classList.add('hidden');
    }
}

async function checkStartupStatus() {
    const badge = document.getElementById('startupBadge');
    if (!badge) return;
    const base = 'hidden sm:inline-flex px-2.5 py-1.5 rounded-lg text-[10px] font-bold border';
    try {
        const response = await fetch('/startup-status');
        if (!response.ok) return;
        const data = await response.json();
        if (data.is_registered) {
            badge.innerText = "STARTUP: REGISTERED";
            badge.className = `${base} border-emerald-500/25 bg-emerald-500/10 text-emerald-400`;
        } else {
            badge.innerText = "STARTUP: NOT REGISTERED";
            badge.className = `${base} border-orange-500/25 bg-orange-500/10 text-orange-400`;
        }
    } catch (err) {
        console.error("Startup check failed");
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function updateServerStats() {
    if (!document.getElementById('srvCpuText')) return;
    try {
        const response = await fetch('/server-stats');
        if (!response.ok) return;
        const data = await response.json();

        document.getElementById('srvCpuText').innerText = `${data.cpu_percent.toFixed(1)} %`;
        document.getElementById('srvCpuCount').innerText = `CORES: ${data.cpu_count_physical}P / ${data.cpu_count_logical}L`;

        const coresContainer = document.getElementById('srvCpuCoresContainer');
        coresContainer.innerHTML = '';
        data.cpu_cores.forEach((corePer, idx) => {
            const percent = Math.max(0, Math.min(100, Number(corePer) || 0));
            const coreRow = document.createElement('div');
            coreRow.className = 'flex items-center gap-2 text-[10px] font-mono text-white/40';
            coreRow.innerHTML = `
                <span class="w-5 text-white/35">#${String(idx).padStart(2, '0')}</span>
                <div class="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
                    <div class="h-full bg-emerald-500/70" style="width: ${percent}%"></div>
                </div>
                <span class="w-7 text-right text-white/60">${percent.toFixed(0)}%</span>
            `;
            coresContainer.appendChild(coreRow);
        });

        const ramTotalGB = (data.memory_total / 1024 / 1024 / 1024).toFixed(1);
        const ramUsedGB = (data.memory_used / 1024 / 1024 / 1024).toFixed(1);
        const swapTotalGB = (data.swap_total / 1024 / 1024 / 1024).toFixed(1);
        const swapUsedGB = (data.swap_used / 1024 / 1024 / 1024).toFixed(1);

        document.getElementById('srvMemText').innerText = `${ramUsedGB}G / ${swapUsedGB}G`;
        document.getElementById('srvMemPercent').innerText = `${data.memory_percent}%`;
        document.getElementById('srvMemDetail').innerText = `${ramUsedGB}/${ramTotalGB} GB`;
        document.getElementById('srvMemBar').style.width = `${data.memory_percent}%`;

        document.getElementById('srvSwapPercent').innerText = `${data.swap_percent}%`;
        document.getElementById('srvSwapDetail').innerText = `${swapUsedGB}/${swapTotalGB} GB`;
        document.getElementById('srvSwapBar').style.width = `${data.swap_percent}%`;

        document.getElementById('srvDiskText').innerText = `${data.disk_percent}%`;
        document.getElementById('srvDiskBar').style.width = `${data.disk_percent}%`;
        const diskTotalGB = (data.disk_total / 1024 / 1024 / 1024).toFixed(1);
        const diskUsedGB = (data.disk_used / 1024 / 1024 / 1024).toFixed(1);
        const diskFreeGB = (data.disk_free / 1024 / 1024 / 1024).toFixed(1);
        document.getElementById('srvDiskDetail').innerText = `Used: ${diskUsedGB} GB / Free: ${diskFreeGB} GB (Total: ${diskTotalGB} GB)`;

        document.getElementById('srvNetRecv').innerText = formatBytes(data.net_bytes_recv);
        document.getElementById('srvNetSent').innerText = formatBytes(data.net_bytes_sent);

    } catch (err) {
        console.error("Server stats configuration error:", err);
    }
}

async function updateStats() {
    if (!document.getElementById('pm2-list-body')) return;
    try {
        const response = await fetch('/status');
        if (!response.ok) return;
        const processes = await response.json();

        processes.forEach(proc => {
            const row = document.getElementById(`proc-${proc.name}`);
            if (!row) return;

            const statusCell = row.querySelector('.status-cell');
            const status = String(proc.pm2_env.status || 'unknown');
            const isOnline = status === 'online';
            statusCell.innerHTML = `
                <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold ${isOnline ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25' : 'bg-red-500/10 text-red-400 border border-red-500/25'}">
                    <span class="w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}"></span> ${UnivDash.escapeHtml(status.toUpperCase())}
                </span>
            `;

            const currentCpu = proc.monit.cpu;
            const currentMemMB = parseFloat((proc.monit.memory / 1024 / 1024).toFixed(1));

            row.querySelector('.cpu-cell').innerText = `${currentCpu}%`;
            row.querySelector('.mem-cell').innerText = `${currentMemMB} MB`;
            row.querySelector('.uptime-cell').innerText = formatUptime(proc.pm2_env.pm_uptime);

            const watchBadge = row.querySelector('.watch-status-badge');
            const isWatching = proc.pm2_env.watch;
            watchBadge.innerText = isWatching ? "WATCH ON" : "WATCH OFF";
            watchBadge.className = `watch-status-badge inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold ${
                isWatching
                ? 'bg-blue-500/10 text-blue-400 border border-blue-500/25'
                : 'bg-white/10 text-white/40 border border-white/10'
            }`;

            if (charts[proc.name]) {
                const chart = charts[proc.name];
                chart.data.datasets[0].data.push(currentCpu);
                chart.data.datasets[0].data.shift();
                chart.data.datasets[1].data.push(currentMemMB);
                chart.data.datasets[1].data.shift();
                chart.update('none');
            }
        });
    } catch (err) {
        console.error("Update failed:", err);
    }
}

function filterProcesses() {
    const query = document.getElementById('procSearch').value.toLowerCase();
    const rows = document.getElementsByClassName('proc-row');
    for (let row of rows) {
        const name = row.getAttribute('data-name').toLowerCase();
        const chartRow = document.getElementById(`chart-row-${row.getAttribute('data-name')}`);
        if (name.includes(query)) {
            row.style.display = "";
            if (chartRow) chartRow.style.display = "";
        } else {
            row.style.display = "none";
            if (chartRow) chartRow.style.display = "none";
        }
    }
}

function formatUptime(ms) {
    if (!ms) return "-";
    const seconds = Math.floor((Date.now() - ms) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

async function controlPM2(action, name) {
    const actionKo = {
        'restart': '재시작',
        'stop': '중지',
        'delete': '삭제(리스트에서 제거)'
    }[action] || action;

    if (!confirm(`${name} 프로세스를 ${actionKo} 하시겠습니까?`)) return;

    try {
        const response = await fetch(`/control/${encodeURIComponent(action)}/${encodeURIComponent(name)}`, { method: 'POST' });
        if (response.ok) {
            if (action === 'delete') {
                location.reload();
            } else {
                updateStats();
            }
        } else {
            alert('명령 실행 실패');
        }
    } catch (err) {
        alert('서버 통신 오류');
    }
}

async function savePM2() {
    if (!confirm("현재 프로세스 리스트를 저장하시겠습니까? 재부팅 시 이 상태로 자동 복구됩니다.")) return;
    try {
        const response = await fetch('/save', { method: 'POST' });
        if (response.ok) {
            alert("성공적으로 저장되었습니다 (pm2 save 완료)");
        } else {
            alert("저장 실패");
        }
    } catch (err) {
        alert("서버 통신 오류");
    }
}

async function toggleWatch(name) {
    try {
        const response = await fetch(`/toggle-watch/${encodeURIComponent(name)}`, { method: 'POST' });
        if (response.ok) {
            updateStats();
        } else {
            alert('Watch 모드 변경 실패');
        }
    } catch (err) {
        alert('서버 통신 오류');
    }
}

function openLogModal(name) {
    const modal = document.getElementById('logModal');
    const container = document.getElementById('logContainer');
    const title = document.getElementById('logTitle');

    modal.classList.remove('hidden');
    title.innerText = `REAL-TIME LOGS: ${name}`;
    container.innerHTML = '<div class="terminal-muted italic px-2">데이터를 불러오는 중입니다...</div>';

    if (logSocket) logSocket.close();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    logSocket = new WebSocket(`${protocol}//${window.location.host}/ws/logs/${encodeURIComponent(name)}`);

    logSocket.onmessage = function(event) {
        const line = document.createElement('div');
        line.className = 'terminal-line pl-3 py-0.5 transition-colors whitespace-pre-wrap break-all';
        line.innerText = event.data;
        container.appendChild(line);
        container.scrollTop = container.scrollHeight;
    };

    logSocket.onclose = function() {
        const msg = document.createElement('div');
        msg.className = 'terminal-muted text-[10px] mt-4 text-center border-t border-white/10 pt-4 font-bold tracking-widest';
        msg.innerText = "로그 스트림 종료됨 (STREAM ENDED)";
        container.appendChild(msg);
    };

    logSocket.onerror = function() {
        container.innerHTML = '<div class="text-red-400 font-bold p-2">WebSocket 연결 오류 발생</div>';
    };
}

function closeLogModal() {
    if (logSocket) {
        logSocket.close();
        logSocket = null;
    }
    const modal = document.getElementById('logModal');
    if (!modal) return;
    modal.classList.add('hidden');
}

if (document.getElementById('pm2-list-body')) {
    updateStats();
    checkStartupStatus();
    setInterval(updateStats, 1000);

    // 프로세스 이름을 인라인 onclick 문자열에 넣지 않고 data 속성 + 이벤트 위임으로 처리한다
    document.getElementById('pm2-list-body').addEventListener('click', (event) => {
        const button = event.target.closest('[data-proc-action]');
        if (!button) return;
        const name = button.dataset.name;
        const action = button.dataset.procAction;
        if (action === 'chart') toggleChart(name);
        else if (action === 'watch') toggleWatch(name);
        else if (action === 'logs') openLogModal(name);
        else controlPM2(action, name);
    });
    document.getElementById('procSearch')?.addEventListener('input', filterProcesses);
    document.getElementById('pm2SaveButton')?.addEventListener('click', savePM2);
    document.getElementById('pageReloadButton')?.addEventListener('click', () => location.reload());
    document.getElementById('logCloseButton')?.addEventListener('click', closeLogModal);
    document.getElementById('logModal')?.addEventListener('click', (event) => {
        if (event.target.id === 'logModal') closeLogModal();
    });
}
if (document.getElementById('srvCpuText')) {
    updateServerStats();
    setInterval(updateServerStats, 1000);
}
window.addEventListener('univdash:themechange', () => {
    const themeColors = getChartThemeColors();
    Object.values(charts).forEach((chart) => {
        chart.options.scales['y-cpu'].grid.color = themeColors.grid;
        chart.options.scales['y-cpu'].ticks.color = themeColors.ticks;
        chart.options.scales['y-mem'].ticks.color = themeColors.ticks;
        chart.update('none');
    });
});

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeLogModal();
});
})();

// ── ecosystem.config.js: 등록된 앱 목록 · 새 앱 추가 · 시작 ─────────────────────
(function () {
  'use strict';
  const list = document.getElementById('ecoList');
  if (!list) return;
  const { escapeHtml, api } = window.UnivDash;
  const ui = () => window.UnivDashUI;
  let apps = [];

  function statusBadge(status) {
    if (status === 'online') return '<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>ONLINE</span>';
    if (status) return `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-red-500/10 text-red-400 border border-red-500/25">${escapeHtml(String(status).toUpperCase())}</span>`;
    return '<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-bold bg-white/10 text-white/40 border border-white/10">미실행</span>';
  }

  function render(data) {
    document.getElementById('ecoPath').textContent = data.path + (data.exists ? '' : ' (아직 없음 — 첫 앱을 추가하면 만들어집니다)');
    if (data.error) {
      list.innerHTML = `<div class="p-5 text-xs text-red-300">${escapeHtml(data.error)}</div>`;
      return;
    }
    apps = data.apps;
    if (!apps.length) {
      list.innerHTML = '<div class="p-5 text-xs text-white/40">등록된 앱이 없습니다. <b>새 앱</b>으로 추가하세요.</div>';
      return;
    }
    list.innerHTML = apps.map((app) => `
      <article class="flex items-center gap-3 px-4 py-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0"><span class="truncate text-sm font-bold text-white/90">${escapeHtml(app.name)}</span>${statusBadge(app.status)}${app.watch ? '<i class="fas fa-eye text-[10px] text-white/35" title="watch"></i>' : ''}</div>
          <p class="mt-0.5 truncate font-mono text-[10px] text-white/40">${escapeHtml([app.cwd, [app.interpreter ? app.interpreter.split('/').pop() : '', app.script, app.args || ''].filter(Boolean).join(' ')].filter(Boolean).join(' · '))}</p>
        </div>
        ${app.status ? '' : `<button type="button" data-eco-start="${escapeHtml(app.name)}" class="flex-shrink-0 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 px-3 py-2 text-xs font-bold text-white"><i class="fas fa-play mr-1"></i>시작</button>`}
      </article>`).join('');
  }

  async function load() {
    try { render(await api('/api/ecosystem')); } catch (error) { list.innerHTML = `<div class="p-5 text-xs text-red-300">${escapeHtml(error.message)}</div>`; }
  }

  async function start(name) {
    if (!await ui().confirmSheet({ title: `${name} 시작`, message: `pm2 start ecosystem.config.js --only ${name}`, confirmLabel: '시작' })) return;
    try {
      await api(`/api/ecosystem/apps/${encodeURIComponent(name)}/start`, { method: 'POST' });
      ui().toast(`${name} 을(를) 시작했습니다. 새로고침하면 프로세스 목록에 보입니다.`, 'ok', { label: '새로고침', onClick: () => location.reload() }, 6000);
      load();
    } catch (error) { ui().toast(error.message, 'error', null, 8000); }
  }
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-eco-start]');
    if (button) start(button.dataset.ecoStart);
  });

  document.getElementById('ecoAddBtn').addEventListener('click', () => {
    ui().formSheet({
      title: 'ecosystem 에 새 앱 추가',
      subtitle: '파일 끝에 항목을 추가합니다. 원본은 .bak 으로 백업됩니다.',
      fields: [
        { name: 'cwd', label: '작업 폴더 (cwd)', placeholder: '/home/user/my-app', maxlength: 1024 },
        { name: 'name', label: '앱 이름', placeholder: 'my-app', maxlength: 64 },
        { name: 'script', label: '실행 파일 (script)', placeholder: 'run.py / index.js', maxlength: 500 },
        { name: 'interpreter', label: '인터프리터 (비우면 pm2 기본값)', placeholder: '/home/user/my-app/.venv/bin/python', maxlength: 500 },
        { name: 'args', label: '실행 인자 (선택)', placeholder: '--port 9000', maxlength: 500 },
      ],
      extraHtml: `
        <label>환경 변수 (선택, 한 줄에 KEY=VALUE)<textarea name="env" rows="3" maxlength="20000" placeholder="PORT=9000" autocapitalize="off" spellcheck="false"></textarea></label>
        <div class="grid gap-2">
          <label class="check-row"><input type="checkbox" name="watch"> 파일이 바뀌면 자동 재시작 (watch)</label>
          <label class="check-row"><input type="checkbox" name="time" checked> 로그에 시간 표시 (time)</label>
          <label class="check-row"><input type="checkbox" name="start" checked> 추가한 뒤 바로 pm2 로 시작</label>
        </div>
        <p data-eco-hint class="text-[11px] opacity-60"></p>`,
      submitLabel: '추가',
      onMount(body) {
        const field = (name) => body.querySelector(`[name="${name}"]`);
        const touched = new Set();
        ['name', 'script', 'interpreter'].forEach((name) => field(name).addEventListener('input', () => touched.add(name)));
        let timer = null;
        field('cwd').addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            const hint = body.querySelector('[data-eco-hint]');
            if (!field('cwd').value.trim()) { hint.textContent = ''; return; }
            try {
              const info = await api(`/api/ecosystem/inspect?cwd=${encodeURIComponent(field('cwd').value.trim())}`);
              if (!info.exists) { hint.textContent = '폴더를 찾을 수 없습니다.'; return; }
              hint.textContent = `✓ ${info.cwd}`;
              ['name', 'script', 'interpreter'].forEach((name) => { if (!touched.has(name) && info[name]) field(name).value = info[name]; });
            } catch (error) { /* 무시 */ }
          }, 350);
        });
      },
      async onSubmit(values) {
        const payload = {
          name: values.name.trim(), cwd: values.cwd.trim(), script: values.script.trim(),
          interpreter: values.interpreter.trim(), args: values.args.trim(), env: values.env || '',
          watch: values.watch === 'on', time: values.time === 'on', start: values.start === 'on',
        };
        const result = await api('/api/ecosystem/apps', { method: 'POST', body: payload });
        if (result.started === false) ui().toast(`추가했지만 시작하지 못했습니다:\n${result.output || ''}`, 'error', null, 9000);
        else ui().toast(`${payload.name} 을(를) ecosystem 에 추가했습니다${result.started ? ' · pm2 시작됨' : ''}.`, 'ok', result.started ? { label: '새로고침', onClick: () => location.reload() } : null, 6000);
        load();
      },
    });
  });

  load();
})();
