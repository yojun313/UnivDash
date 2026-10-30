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
    const base = 'self-start lg:self-auto inline-flex px-2.5 py-1.5 rounded-lg text-[10px] font-bold border';
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

// CPU 온도 배지: 경고 온도(high) 기준으로 초록 → 주황(10°C 이내) → 빨강(넘음)
function renderCpuTemp(temp) {
    const badge = document.getElementById('srvCpuTemp');
    if (!badge) return;
    if (!temp) { badge.classList.add('hidden'); return; }
    const high = temp.high || 85;
    const level = temp.current >= high ? 'border-red-500/40 bg-red-500/15 text-red-400'
        : temp.current >= high - 10 ? 'border-amber-500/40 bg-amber-500/15 text-amber-400'
        : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
    badge.className = `text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${level}`;
    badge.innerHTML = `<i class="fas fa-temperature-half mr-1"></i>${Math.round(temp.current)}°C`;
    badge.title = `CPU 온도 ${temp.current}°C${temp.hottest_core ? ` · 가장 뜨거운 코어 ${temp.hottest_core}°C` : ''}${temp.high ? ` · 경고 ${temp.high}°C` : ''}${temp.critical ? ` · 위험 ${temp.critical}°C` : ''}`;
}

async function updateServerStats() {
    if (!document.getElementById('srvCpuText')) return;
    try {
        const response = await fetch('/server-stats');
        if (!response.ok) return;
        const data = await response.json();

        document.getElementById('srvCpuText').innerText = `${data.cpu_percent.toFixed(1)} %`;
        document.getElementById('srvCpuCount').innerText = `CORES: ${data.cpu_count_physical}P / ${data.cpu_count_logical}L`;
        renderCpuTemp(data.cpu_temp);

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
        'restart': '재시작(환경 변수 갱신 --update-env)',
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

async function restartAllPM2() {
    const count = document.querySelectorAll('.proc-row').length;
    if (!confirm(`PM2 앱 ${count}개를 모두 재시작할까요? (환경 변수 갱신 --update-env)\n대시보드도 마지막에 재시작되어 잠깐 연결이 끊깁니다.`)) return;
    const button = document.getElementById('pm2RestartAllButton');
    button.disabled = true;
    button.classList.add('opacity-50');
    try {
        const data = await UnivDash.api('/restart-all', { method: 'POST' });
        const failed = data.failed.length ? ` · 실패: ${data.failed.join(', ')}` : '';
        UnivDash.toast(`${data.restarted.length}개 재시작 완료${failed}${data.self ? ' · 대시보드 재시작 중…' : ''}`, data.failed.length ? 'error' : 'success');
        if (data.self) setTimeout(() => location.reload(), 5000);   // 대시보드가 다시 뜨면 새로고침
        else updateStats();
    } catch (error) {
        UnivDash.toast(error.message || '전체 재시작에 실패했습니다.', 'error');
    } finally {
        button.disabled = false;
        button.classList.remove('opacity-50');
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

const procBusy = new Set();

function showOutput(title, text, cls = '') {
    const modal = document.getElementById('logModal');
    const container = document.getElementById('logContainer');
    if (logSocket) { logSocket.close(); logSocket = null; }
    modal.classList.remove('hidden');
    document.getElementById('logTitle').innerText = title;
    container.innerHTML = '';
    String(text || '(출력 없음)').split('\n').forEach((t) => {
        const line = document.createElement('div');
        line.className = `terminal-line pl-3 py-0.5 whitespace-pre-wrap break-all ${cls}`;
        line.innerText = t;
        container.appendChild(line);
    });
    container.scrollTop = container.scrollHeight;
}

// 버튼 아이콘을 스피너로 바꾸고, 같은 앱에서 같은 작업이 겹치지 않게 한다
async function procTask(key, button, icon, run) {
    if (procBusy.has(key)) return;
    procBusy.add(key);
    const i = button?.querySelector('i');
    i?.classList.replace(icon, 'fa-spinner');
    i?.classList.add('fa-spin');
    if (button) button.disabled = true;
    try { await run(); } finally {
        procBusy.delete(key);
        i?.classList.remove('fa-spin');
        i?.classList.replace('fa-spinner', icon);
        if (button) button.disabled = false;
    }
}

async function restartAfter(name, what) {
    if (!confirm(`${name} ${what} 완료. 지금 재시작할까요? (--update-env)`)) return;
    const res = await fetch(`/control/restart/${encodeURIComponent(name)}`, { method: 'POST' });
    UnivDash.toast(res.ok ? `${name} 재시작됨` : '재시작 실패', res.ok ? 'success' : 'error');
    updateStats();
}

// 성공하면 true. then 이 false 면 재시작을 묻지 않는다 (git pull 에서 이어 부를 때)
async function uvSync(name, button, { ask = true, then = true } = {}) {
    if (ask && !confirm(`${name} 작업 폴더에서 uv sync 를 실행할까요?\n(uv.lock 이 있는 폴더 기준 · 끝나면 재시작 여부를 묻습니다)`)) return false;
    button = button || document.querySelector(`[data-proc-action="uv-sync"][data-name="${CSS.escape(name)}"]`);
    let ok = false;
    await procTask(`uv:${name}`, button, 'fa-box-open', async () => {
        showOutput(`UV SYNC: ${name}`, 'uv sync 실행 중...', 'terminal-muted italic');
        try {
            const data = await UnivDash.api(`/uv-sync/${encodeURIComponent(name)}`, { method: 'POST' });
            showOutput(`UV SYNC: ${name}`, data.output, data.ok ? '' : 'text-red-400');
            ok = data.ok;
            UnivDash.toast(`${name} uv sync ${ok ? '완료' : '실패'}`, ok ? 'success' : 'error');
        } catch (error) {
            showOutput(`UV SYNC: ${name}`, error.message || 'uv sync 요청 실패', 'text-red-400');
            UnivDash.toast(error.message || 'uv sync 실패', 'error');
        }
    });
    if (ok && then) await restartAfter(name, 'uv sync');
    return ok;
}

async function gitPull(name, button) {
    if (!confirm(`${name} 저장소에서 git pull 할까요?\n(--ff-only · 로컬 커밋과 갈라져 있으면 실패하고 아무것도 바꾸지 않습니다)`)) return;
    let data = null;
    await procTask(`git:${name}`, button, 'fa-code-pull-request', async () => {
        showOutput(`GIT PULL: ${name}`, 'git pull 실행 중...', 'terminal-muted italic');
        try {
            data = await UnivDash.api(`/git-pull/${encodeURIComponent(name)}`, { method: 'POST' });
            const files = data.changed.length ? `\n\n바뀐 파일 ${data.changed.length}개:\n${data.changed.join('\n')}` : '';
            showOutput(`GIT PULL: ${name}${data.branch ? ` (${data.branch})` : ''}`, data.output + files, data.ok ? '' : 'text-red-400');
            UnivDash.toast(!data.ok ? `${name} git pull 실패` : data.updated ? `${name} 업데이트됨` : `${name} 이미 최신`, data.ok ? 'success' : 'error');
        } catch (error) {
            showOutput(`GIT PULL: ${name}`, error.message || 'git pull 요청 실패', 'text-red-400');
            UnivDash.toast(error.message || 'git pull 실패', 'error');
        }
    });
    if (!data?.ok || !data.updated) return;
    const uvButton = document.querySelector(`[data-proc-action="uv-sync"][data-name="${CSS.escape(name)}"]`);
    if (data.deps_changed && uvButton && confirm(`${name} 의존성(uv.lock / pyproject.toml)이 바뀌었습니다. uv sync 를 실행할까요?`)) {
        if (!await uvSync(name, uvButton, { ask: false, then: false })) return;
    }
    await restartAfter(name, 'git pull');
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
        else if (action === 'uv-sync') uvSync(name, button);
        else if (action === 'git-pull') gitPull(name, button);
        else controlPM2(action, name);
    });
    document.getElementById('procSearch')?.addEventListener('input', filterProcesses);
    document.getElementById('pm2SaveButton')?.addEventListener('click', savePM2);
    document.getElementById('pm2RestartAllButton')?.addEventListener('click', restartAllPM2);
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
        <button type="button" data-eco-edit="${escapeHtml(app.name)}" class="flex-shrink-0 w-9 h-9 rounded-xl bg-white/5 text-white/60 hover:bg-white/10 hover:text-white transition" title="수정" aria-label="${escapeHtml(app.name)} 수정"><i class="fas fa-pen text-xs"></i></button>
        ${app.self ? '' : `<button type="button" data-eco-delete="${escapeHtml(app.name)}" class="flex-shrink-0 w-9 h-9 rounded-xl bg-white/5 text-red-400/70 hover:bg-red-500/15 hover:text-red-400 transition" title="삭제" aria-label="${escapeHtml(app.name)} 삭제"><i class="fas fa-trash text-xs"></i></button>`}
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
  async function remove(name) {
    const app = apps.find((item) => item.name === name);
    const check = app?.status ? { label: 'pm2 에서도 지우기', desc: '돌고 있는 프로세스를 멈추고 pm2 목록에서 뺍니다.', checked: true } : null;
    if (!await ui().confirmSheet({ title: `${name} 삭제`, message: 'ecosystem.config.js 에서 이 항목을 지웁니다. 원본은 .bak 으로 백업됩니다.', confirmLabel: '삭제', danger: true, check })) return;
    try {
      const pm2 = check?.checked ? '?pm2=true' : '';
      const result = await api(`/api/ecosystem/apps/${encodeURIComponent(name)}${pm2}`, { method: 'DELETE' });
      if (result.pm2_deleted === false) ui().toast(`${name} 을(를) ecosystem 에서 지웠지만 pm2 에서는 지우지 못했습니다.`, 'error', null, 8000);
      else ui().toast(`${name} 을(를) 지웠습니다${result.pm2_deleted ? ' · pm2 에서도 삭제' : ''}.`, 'ok', result.pm2_deleted ? { label: '새로고침', onClick: () => location.reload() } : null, 6000);
      load();
    } catch (error) { ui().toast(error.message, 'error', null, 8000); }
  }

  async function edit(name) {
    let app;
    try { app = await api(`/api/ecosystem/apps/${encodeURIComponent(name)}`); } catch (error) { ui().toast(error.message, 'error', null, 8000); return; }
    const running = !!apps.find((item) => item.name === name)?.status;
    const notes = [
      app.kept.length ? `폼에 없는 설정(${app.kept.join(', ')})은 그대로 둡니다.` : '',
      app.watch_custom ? 'watch 가 폴더 목록으로 되어 있습니다. 체크를 풀지 않으면 그대로 둡니다.' : '',
      app.env_editable ? '' : 'env 가 객체가 아니라 여기서 고칠 수 없습니다.',
    ].filter(Boolean);
    ui().formSheet({
      title: `${name} 수정`,
      subtitle: '바꾼 설정만 고칩니다. 원본은 .bak 으로 백업됩니다.',
      fields: [
        { name: 'name', label: '앱 이름', value: app.name, maxlength: 64 },
        { name: 'cwd', label: '작업 폴더 (cwd)', value: app.cwd, maxlength: 1024 },
        { name: 'script', label: '실행 파일 (script)', value: app.script, maxlength: 500 },
        { name: 'interpreter', label: '인터프리터 (비우면 pm2 기본값)', value: app.interpreter, maxlength: 500 },
        { name: 'args', label: '실행 인자 (선택)', value: app.args, maxlength: 500 },
      ],
      extraHtml: `
        <label>환경 변수 (한 줄에 KEY=VALUE)<textarea name="env" rows="3" maxlength="20000" autocapitalize="off" spellcheck="false" ${app.env_editable ? '' : 'disabled'}>${escapeHtml(app.env)}</textarea></label>
        <div class="grid gap-2">
          <label class="check-row"><input type="checkbox" name="watch" ${app.watch ? 'checked' : ''}> 파일이 바뀌면 자동 재시작 (watch)</label>
          <label class="check-row"><input type="checkbox" name="time" ${app.time ? 'checked' : ''}> 로그에 시간 표시 (time)</label>
          ${running && !app.self ? '<label class="check-row"><input type="checkbox" name="apply" checked> 저장한 뒤 새 설정으로 다시 시작</label>' : ''}
        </div>
        ${app.self ? '<p class="text-[11px] text-amber-300/80">이 대시보드 자신입니다. 이름은 바꿀 수 없고, 저장한 설정은 직접 다시 시작해야 반영됩니다. 잘못 고치면 대시보드가 켜지지 않을 수 있어요.</p>' : ''}
        ${notes.map((note) => `<p class="text-[11px] opacity-60">${escapeHtml(note)}</p>`).join('')}`,
      submitLabel: '저장',
      onMount(body) {
        if (app.self) body.querySelector('[name="name"]').readOnly = true;
      },
      async onSubmit(values) {
        const payload = {
          name: values.name.trim(), cwd: values.cwd.trim(), script: values.script.trim(),
          interpreter: values.interpreter.trim(), args: values.args.trim(),
          env: app.env_editable ? (values.env || '') : app.env,
          watch: values.watch === 'on', time: values.time === 'on', apply: values.apply === 'on',
        };
        const result = await api(`/api/ecosystem/apps/${encodeURIComponent(name)}`, { method: 'PUT', body: payload });
        if (!result.changed.length) ui().toast('바뀐 설정이 없습니다.', 'ok');
        else if (result.applied === false) ui().toast(`저장했지만 다시 시작하지 못했습니다:\n${result.output || ''}`, 'error', null, 9000);
        else if (result.applied === 'self') ui().toast(`저장했습니다. 반영하려면 pm2 delete ${name} && pm2 start ecosystem.config.js --only ${name} 를 직접 실행하세요.`, 'ok', null, 10000);
        else ui().toast(`${payload.name} 설정을 저장했습니다${result.applied ? ' · 새 설정으로 다시 시작' : ''}.`, 'ok', result.applied ? { label: '새로고침', onClick: () => location.reload() } : null, 6000);
        load();
      },
    });
  }

  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-eco-start], [data-eco-edit], [data-eco-delete]');
    if (!button) return;
    if (button.dataset.ecoStart) start(button.dataset.ecoStart);
    else if (button.dataset.ecoEdit) edit(button.dataset.ecoEdit);
    else remove(button.dataset.ecoDelete);
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
