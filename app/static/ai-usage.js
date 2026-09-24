// AI 사용량 페이지: 남은 한도(세션/주간), 요약 지표, 일별·시간대 차트, 모델/프로젝트 순위
(function () {
  'use strict';
  const { escapeHtml, api, formatNumber, relativeTime, duration, chartColors, toast } = window.UnivDash;

  const state = { days: 7, data: null, charts: {} };
  const $ = (id) => document.getElementById(id);
  if (!$('ai-usage')) return;

  function levelColor(remaining) {
    if (remaining >= 50) return { bar: 'from-emerald-500 to-teal-400', text: 'text-emerald-400' };
    if (remaining >= 20) return { bar: 'from-amber-500 to-yellow-400', text: 'text-amber-400' };
    return { bar: 'from-red-500 to-orange-400', text: 'text-red-400' };
  }

  function percent(value) {
    return value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
  }

  function renderWindow(window) {
    const color = levelColor(window.remaining_percent);
    const reset = window.resets_at
      ? `${duration(new Date(window.resets_at) - Date.now())} 후 리셋 · ${new Date(window.resets_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : (window.expired ? '리셋됨 — 새 창이 시작되었습니다' : '리셋 시각 정보 없음');
    return `
      <div class="glass-soft rounded-xl p-3.5">
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-xs font-bold text-white/70">${escapeHtml(window.label)}${window.active ? '<span class="ml-1.5 rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] text-blue-300">적용 중</span>' : ''}</p>
          <p class="font-mono text-lg font-bold ${color.text}">${window.remaining_percent.toFixed(0)}<span class="text-xs">% 남음</span></p>
        </div>
        <div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div class="h-full rounded-full bg-gradient-to-r ${color.bar} transition-all duration-700" style="width:${window.remaining_percent}%"></div>
        </div>
        <div class="mt-1.5 flex justify-between gap-2 text-[10px] text-white/40">
          <span>${window.used_percent.toFixed(0)}% 사용</span>
          <span class="truncate text-right">${escapeHtml(reset)}</span>
        </div>
      </div>`;
  }

  function renderLimits(providers) {
    $('aiLimits').innerHTML = providers.map((provider) => {
      const limits = provider.limits;
      const windows = limits?.windows || [];
      const breakdown = (limits?.breakdown || []).filter((row) => row.percent > 0);
      const credits = limits?.credits;
      return `
        <article class="glass rounded-2xl p-5 shadow-xl">
          <div class="mb-4 flex items-start justify-between gap-3">
            <div class="flex items-center gap-2.5">
              <span class="flex h-9 w-9 items-center justify-center rounded-xl text-white" style="background:${provider.accent}"><i class="fas ${provider.id === 'claude' ? 'fa-asterisk' : 'fa-terminal'} text-sm"></i></span>
              <div>
                <h3 class="font-bold text-white/90">${escapeHtml(provider.name)}</h3>
                <p class="text-[10px] text-white/40">${limits?.updated_at ? `기준 ${relativeTime(limits.updated_at)}` : '한도 정보 없음'}</p>
              </div>
            </div>
            ${limits?.plan ? `<span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-white/60">${escapeHtml(limits.plan)}</span>` : ''}
          </div>
          ${windows.length ? `<div class="space-y-2.5">${windows.map(renderWindow).join('')}</div>` : `
            <div class="rounded-xl border border-dashed border-white/15 p-4 text-center text-xs text-white/40">
              ${provider.id === 'claude' ? 'Claude Code 를 실행하면 ~/.claude.json 에 한도 정보가 기록됩니다.' : 'Codex 세션 기록에서 한도 정보를 찾지 못했습니다.'}
            </div>`}
          ${breakdown.length ? `
            <div class="mt-4 border-t border-white/10 pt-3">
              <p class="mb-2 text-[10px] font-bold uppercase tracking-wider text-white/40">이번 주 사용처</p>
              <div class="space-y-1.5">${breakdown.map((row) => `
                <div class="flex items-center gap-2 text-[11px]">
                  <span class="w-20 truncate text-white/60">${escapeHtml(row.name)}</span>
                  <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10"><div class="h-full rounded-full" style="width:${row.percent}%;background:${provider.accent}"></div></div>
                  <span class="w-9 text-right font-mono text-white/50">${row.percent.toFixed(0)}%</span>
                </div>`).join('')}</div>
            </div>` : ''}
          ${credits ? `<p class="mt-3 text-[10px] text-white/40"><i class="fas fa-coins mr-1"></i>크레딧 ${credits.unlimited ? '무제한' : escapeHtml(credits.balance)}</p>` : ''}
        </article>`;
    }).join('');
  }

  function renderKpis(providers) {
    const sum = (key) => providers.reduce((total, provider) => total + (provider[key] || 0), 0);
    const cacheWeighted = providers.reduce((acc, provider) => {
      if (provider.cache_hit_rate === null || provider.cache_hit_rate === undefined) return acc;
      acc.value += provider.cache_hit_rate * provider.total_tokens;
      acc.weight += provider.total_tokens;
      return acc;
    }, { value: 0, weight: 0 });
    const tiles = [
      { label: '전체 토큰', value: formatNumber(sum('total_tokens')), sub: `오늘 ${formatNumber(sum('today_tokens'))}`, icon: 'fa-coins', color: 'text-blue-400' },
      { label: '요청 수', value: formatNumber(sum('requests')), sub: `평균 ${formatNumber(sum('requests') ? sum('total_tokens') / sum('requests') : 0)} 토큰/요청`, icon: 'fa-bolt', color: 'text-amber-400' },
      { label: '세션 수', value: formatNumber(sum('sessions')), sub: `활동일 ${Math.max(...providers.map((p) => p.active_days || 0))}/${state.data.window_days}일`, icon: 'fa-layer-group', color: 'text-purple-400' },
      { label: '캐시 적중률', value: cacheWeighted.weight ? percent(cacheWeighted.value / cacheWeighted.weight) : '—', sub: '토큰 가중 평균', icon: 'fa-database', color: 'text-emerald-400' },
    ];
    $('aiKpis').innerHTML = tiles.map((tile) => `
      <div class="glass rounded-2xl p-4 shadow-xl">
        <p class="text-[10px] font-bold uppercase tracking-wider text-white/40"><i class="fas ${tile.icon} mr-1.5 ${tile.color}"></i>${tile.label}</p>
        <p class="mt-2 font-mono text-2xl font-bold text-white">${tile.value}</p>
        <p class="mt-1 text-[10px] text-white/40">${escapeHtml(tile.sub)}</p>
      </div>`).join('');
  }

  function renderCompare(providers) {
    const peakHour = (p) => (p.peak_hour === null || p.peak_hour === undefined ? '—' : `${String(p.peak_hour).padStart(2, '0')}:00`);
    const peakDay = (p) => (p.peak_day ? `${new Date(`${p.peak_day.date}T00:00:00`).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} · ${formatNumber(p.peak_day.total_tokens)}` : '—');
    const rows = [
      ['전체 토큰', (p) => formatNumber(p.total_tokens)],
      ['오늘', (p) => formatNumber(p.today_tokens)],
      ['입력', (p) => formatNumber(p.input_tokens)],
      ['출력', (p) => formatNumber(p.output_tokens)],
      ['캐시 읽기', (p) => formatNumber(p.cache_read_tokens)],
      ['캐시 쓰기', (p) => (p.id === 'claude' ? formatNumber(p.cache_write_tokens) : '—')],
      ['추론 토큰', (p) => (p.id === 'codex' ? formatNumber(p.reasoning_tokens) : '—')],
      ['캐시 적중률', (p) => percent(p.cache_hit_rate)],
      ['요청 수', (p) => formatNumber(p.requests)],
      ['세션 수', (p) => formatNumber(p.sessions)],
      ['평균 토큰 / 요청', (p) => formatNumber(p.avg_tokens_per_request)],
      ['평균 출력 / 요청', (p) => formatNumber(p.avg_output_per_request)],
      ['평균 토큰 / 세션', (p) => formatNumber(p.avg_tokens_per_session)],
      ['활동일', (p) => `${p.active_days}일`],
      ['최다 사용일', peakDay],
      ['피크 시간대', peakHour],
      ['주 사용 모델', (p) => escapeHtml(p.model || '—')],
      ['마지막 활동', (p) => relativeTime(p.last_activity)],
    ];
    $('aiCompare').innerHTML = `
      <table class="w-full text-left text-xs">
        <thead><tr class="border-b border-white/10 text-[10px] uppercase tracking-wider text-white/40">
          <th class="py-2.5 pr-3 font-bold">지표</th>
          ${providers.map((p) => `<th class="py-2.5 px-3 text-right font-bold"><span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-full" style="background:${p.accent}"></span>${escapeHtml(p.name)}</span></th>`).join('')}
        </tr></thead>
        <tbody>${rows.map(([label, fn]) => `
          <tr class="border-b border-white/5 last:border-0">
            <td class="py-2 pr-3 text-white/50">${label}</td>
            ${providers.map((p) => `<td class="py-2 px-3 text-right font-mono text-white/80">${fn(p)}</td>`).join('')}
          </tr>`).join('')}</tbody>
      </table>`;
  }

  function renderComposition(providers) {
    $('aiComposition').innerHTML = providers.map((p) => {
      const parts = p.id === 'claude'
        ? [['입력', p.input_tokens, '#60a5fa'], ['출력', p.output_tokens, '#f472b6'], ['캐시 읽기', p.cache_read_tokens, '#34d399'], ['캐시 쓰기', p.cache_write_tokens, '#fbbf24']]
        : [['입력(비캐시)', Math.max(p.input_tokens - p.cache_read_tokens, 0), '#60a5fa'], ['출력', p.output_tokens, '#f472b6'], ['캐시 입력', p.cache_read_tokens, '#34d399']];
      const total = parts.reduce((sum, part) => sum + part[1], 0) || 1;
      return `
        <div>
          <div class="mb-1.5 flex items-center justify-between text-[11px]"><span class="font-bold text-white/70">${escapeHtml(p.name)}</span><span class="font-mono text-white/40">${formatNumber(total)}</span></div>
          <div class="flex h-3 w-full overflow-hidden rounded-full bg-white/10">${parts.map(([label, value, color]) => `<div title="${label} ${formatNumber(value)}" style="width:${(value / total) * 100}%;background:${color}"></div>`).join('')}</div>
          <div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-white/50">${parts.map(([label, value, color]) => `<span class="inline-flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full" style="background:${color}"></span>${label} ${((value / total) * 100).toFixed(1)}%</span>`).join('')}</div>
        </div>`;
    }).join('');
  }

  function renderRanking(elementId, providers, key) {
    const rows = providers.flatMap((p) => (p[key] || []).map((item) => ({ ...item, provider: p })));
    rows.sort((a, b) => b.total_tokens - a.total_tokens);
    const top = rows.slice(0, 10);
    const max = top[0]?.total_tokens || 1;
    $(elementId).innerHTML = top.length ? top.map((row) => `
      <div class="py-2">
        <div class="flex items-center justify-between gap-3 text-xs">
          <span class="flex min-w-0 items-center gap-2"><span class="h-2 w-2 flex-shrink-0 rounded-full" style="background:${row.provider.accent}"></span><span class="truncate font-semibold text-white/80">${escapeHtml(row.name)}</span></span>
          <span class="flex-shrink-0 font-mono text-white/60">${formatNumber(row.total_tokens)}</span>
        </div>
        <div class="mt-1 flex items-center gap-2">
          <div class="h-1 flex-1 overflow-hidden rounded-full bg-white/10"><div class="h-full rounded-full" style="width:${(row.total_tokens / max) * 100}%;background:${row.provider.accent}"></div></div>
          <span class="w-24 text-right text-[10px] text-white/35">${formatNumber(row.requests)}회${row.sessions !== undefined ? ` · ${row.sessions}세션` : ''}</span>
        </div>
      </div>`).join('') : '<p class="py-6 text-center text-xs text-white/35">기록이 없습니다.</p>';
  }

  function baseOptions(colors) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.tooltipBg, titleColor: colors.tooltipText, bodyColor: colors.tooltipText,
          borderColor: colors.grid, borderWidth: 1,
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.raw).toLocaleString('ko-KR')} tokens` },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: colors.ticks, font: { size: 10 } } },
        y: { stacked: true, beginAtZero: true, grid: { color: colors.grid }, ticks: { color: colors.ticks, font: { size: 9 }, callback: (v) => formatNumber(v) } },
      },
    };
  }

  function upsertChart(key, canvasId, config) {
    const canvas = $(canvasId);
    if (!canvas || !window.Chart) return;
    if (state.charts[key]) state.charts[key].destroy();
    state.charts[key] = new Chart(canvas.getContext('2d'), config);
  }

  function renderCharts(providers) {
    const colors = chartColors();
    const labels = providers[0].daily.map((day) => new Date(`${day.date}T00:00:00`).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }));
    upsertChart('daily', 'aiUsageChart', {
      type: 'bar',
      data: {
        labels,
        datasets: providers.map((p) => ({
          label: p.name, data: p.daily.map((day) => day.total_tokens),
          backgroundColor: `${p.accent}cc`, borderColor: p.accent, borderWidth: 1, borderRadius: 6, maxBarThickness: 36,
        })),
      },
      options: baseOptions(colors),
    });

    const hourly = baseOptions(colors);
    upsertChart('hourly', 'aiHourlyChart', {
      type: 'bar',
      data: {
        labels: Array.from({ length: 24 }, (_, h) => `${h}시`),
        datasets: providers.map((p) => ({
          label: p.name, data: p.hourly, backgroundColor: `${p.accent}b3`, borderRadius: 4, maxBarThickness: 18,
        })),
      },
      options: hourly,
    });

    const weekdayLabels = ['월', '화', '수', '목', '금', '토', '일'];
    upsertChart('weekday', 'aiWeekdayChart', {
      type: 'bar',
      data: {
        labels: weekdayLabels,
        datasets: providers.map((p) => ({
          label: p.name, data: p.weekday, backgroundColor: `${p.accent}b3`, borderRadius: 4, maxBarThickness: 28,
        })),
      },
      options: baseOptions(colors),
    });
  }

  function render() {
    const data = state.data;
    if (!data) return;
    const providers = data.providers;
    renderLimits(providers);
    renderKpis(providers);
    renderCompare(providers);
    renderComposition(providers);
    renderRanking('aiModels', providers, 'models');
    renderRanking('aiProjects', providers, 'projects');
    renderCharts(providers);
    const withData = providers.filter((p) => p.has_data).length;
    $('aiUsageCaption').textContent = withData
      ? `${withData}개 서비스 · 최근 ${data.window_days}일 · ${new Date(data.generated_at).toLocaleTimeString('ko-KR')} 집계`
      : '선택한 기간에 로컬 세션 기록이 없습니다.';
  }

  async function load() {
    const button = $('aiUsageRefresh');
    button.disabled = true;
    button.querySelector('i')?.classList.add('fa-spin');
    try {
      state.data = await api(`/api/ai-usage?days=${state.days}`);
      render();
    } catch (error) {
      $('aiUsageCaption').textContent = 'AI 사용량 정보를 불러오지 못했습니다.';
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.querySelector('i')?.classList.remove('fa-spin');
    }
  }

  function setPeriod(days) {
    state.days = days;
    document.querySelectorAll('[data-ai-days]').forEach((btn) => {
      const active = Number(btn.dataset.aiDays) === days;
      btn.classList.toggle('bg-white/10', active);
      btn.classList.toggle('text-white', active);
      btn.classList.toggle('text-white/50', !active);
      btn.setAttribute('aria-pressed', String(active));
    });
    try { localStorage.setItem('univdash-ai-days', String(days)); } catch (e) { /* noop */ }
    load();
  }

  document.querySelectorAll('[data-ai-days]').forEach((btn) => btn.addEventListener('click', () => setPeriod(Number(btn.dataset.aiDays))));
  $('aiUsageRefresh').addEventListener('click', load);
  window.addEventListener('univdash:themechange', () => { if (state.data) renderCharts(state.data.providers); });

  let saved = 7;
  try { saved = Number(localStorage.getItem('univdash-ai-days')) || 7; } catch (e) { /* noop */ }
  setPeriod([1, 7, 30].includes(saved) ? saved : 7);
  // 60초마다 갱신 (남은 한도 · 리셋까지 남은 시간 포함)
  setInterval(load, 60000);
})();
