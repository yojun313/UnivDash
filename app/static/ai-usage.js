// AI usage page: remaining limits (session/weekly), summary metrics, daily/hourly charts, model/project rankings
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

  function providerLabel(provider) {
    return provider.id === 'codex' && provider.account
      ? `Codex · ${provider.account}` : provider.name;
  }

  function renderWindow(window) {
    // This account has no 5-hour limit (Anthropic does not provide the value)
    if (window.unlimited) {
      return `
      <div class="glass-soft rounded-xl p-3.5">
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-xs font-bold text-white/70">${t('{label} (5시간)', { label: escapeHtml(window.label) })}</p>
          <p class="font-mono text-sm font-bold text-emerald-300">${t('제한 없음')}</p>
        </div>
        <p class="mt-1.5 text-[10px] text-white/40">${t('이 계정은 지금 5시간 한도가 적용되지 않습니다. 주간 한도만 있습니다.')}</p>
      </div>`;
    }
    const color = levelColor(window.remaining_percent);
    const reset = window.resets_at
      ? t('{time} 후 리셋 · {date}', { time: duration(new Date(window.resets_at) - Date.now()), date: new Date(window.resets_at).toLocaleString(t.locale, { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) })
      : (window.expired ? t('리셋됨 — 새 창이 시작되었습니다') : t('리셋 시각 정보 없음'));
    return `
      <div class="glass-soft rounded-xl p-3.5">
        <div class="flex items-baseline justify-between gap-2">
          <p class="text-xs font-bold text-white/70">${escapeHtml(window.label)}${window.active ? `<span class="ml-1.5 rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] text-blue-300">${t('적용 중')}</span>` : ''}</p>
          <p class="font-mono text-lg font-bold ${color.text}">${t('{n}<span class="text-xs">% 남음</span>', { n: window.remaining_percent.toFixed(0) })}</p>
        </div>
        <div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
          <div class="h-full rounded-full bg-gradient-to-r ${color.bar} transition-all duration-700" style="width:${window.remaining_percent}%"></div>
        </div>
        <div class="mt-1.5 flex justify-between gap-2 text-[10px] text-white/40">
          <span>${t('{n}% 사용', { n: window.used_percent.toFixed(0) })}</span>
          <span class="truncate text-right">${escapeHtml(reset)}</span>
        </div>
      </div>`;
  }

  // The server names usage records without account info "계정 미확인 (이전 기록)"; it may arrive translated.
  const unknownAccount = (provider) => provider.unknown === true || /^(계정 미확인|Unknown account)/i.test(provider.account || '');
  const canRelogin = (provider) => (provider.id === 'claude' && !provider.saved) || (provider.id === 'codex' && !unknownAccount(provider));
  // Saved (not currently signed-in) Claude accounts get a limit card only: placed right after the current Claude card.
  // Same for Gemini (right after the current Gemini card).
  function limitCards(providers, savedClaude, savedGemini = []) {
    let cards = [...providers];
    for (const [id, name, accent, list] of [['claude', 'Claude Code', '#d97757', savedClaude], ['gemini', 'Gemini', '#4285f4', savedGemini]]) {
      const current = cards.find((p) => p.id === id && !p.saved);
      const saved = list.map((a) => ({
        id, saved: true, accountId: a.id, name, account: a.email,
        accent: current?.accent || accent, limits: a.limits, login_expired: a.login_expired, active: false,
      }));
      const index = cards.findIndex((p) => p.id === id);
      cards = index < 0 ? [...cards, ...saved] : [...cards.slice(0, index + 1), ...saved, ...cards.slice(index + 1)];
    }
    return cards;
  }
  function renderLimits(providers, savedClaude = [], savedGemini = []) {
    $('aiLimits').innerHTML = limitCards(providers, savedClaude, savedGemini).map((provider) => {
      const limits = provider.limits;
      const windows = limits?.windows || [];
      const breakdown = (limits?.breakdown || []).filter((row) => row.percent > 0);
      const credits = limits?.credits;
      return `
        <article class="glass rounded-2xl p-5 shadow-xl">
          <div class="mb-4 flex items-start justify-between gap-3">
            <div class="flex items-center gap-2.5">
              <span class="flex h-9 w-9 items-center justify-center rounded-xl text-white" style="background:${provider.accent}"><i class="fas ${{ claude: 'fa-asterisk', gemini: 'fa-gem' }[provider.id] || 'fa-terminal'} text-sm"></i></span>
              <div>
                <h3 class="font-bold text-white/90">${escapeHtml(provider.name)}</h3>
                ${provider.account ? `<p class="ai-account text-[11px] font-semibold text-white/60 break-all"><i class="far fa-user text-[9px] mr-1 opacity-70"></i>${escapeHtml(provider.account)}</p>` : `<p class="text-[11px] text-white/35">${t('로그인 계정 정보 없음')}</p>`}
                <div class="ai-account-actions">
                  ${provider.id === 'codex' && provider.active !== false ? `<button type="button" class="ai-accounts-btn" data-codex-accounts><i class="fas fa-right-left"></i> ${t('계정 전환 · 추가')}</button>` : ''}
                  ${provider.id === 'claude' && !provider.saved ? `<button type="button" class="ai-accounts-btn" data-claude-accounts><i class="fas fa-right-left"></i> ${t('계정 전환 · 추가')}</button>` : ''}
                  ${provider.id === 'gemini' && !provider.saved ? `<button type="button" class="ai-accounts-btn" data-gemini-accounts><i class="fas fa-right-left"></i> ${t('계정 전환 · 추가')}</button>` : ''}
                  ${provider.saved && !provider.login_expired ? `<button type="button" class="ai-accounts-btn" data-provider="${provider.id}" data-claude-switch="${escapeHtml(provider.accountId)}" data-email="${escapeHtml(provider.account || '')}"><i class="fas fa-right-left"></i> ${t('이 계정으로 바꾸기')}</button>` : ''}
                  ${canRelogin(provider) ? `<button type="button" class="ai-accounts-btn" data-relogin="${provider.id}" data-email="${escapeHtml(provider.account || '')}"><i class="fas fa-right-to-bracket"></i> ${t('다시 로그인')}</button>` : ''}
                </div>
                ${provider.active ? `<p class="text-[10px] font-bold text-emerald-400">${t('현재 사용 중')}</p>` : ''}
                <p class="text-[10px] text-white/40">${limits?.updated_at ? t('기준 {time}', { time: relativeTime(limits.updated_at) }) : t('한도 정보 없음')}</p>
              </div>
            </div>
            ${limits?.plan ? `<span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-white/60">${escapeHtml(limits.plan)}</span>` : ''}
          </div>
          ${provider.saved && provider.login_expired ? `
            <div class="ai-login-alert">
              <p><i class="fas fa-triangle-exclamation"></i> ${t('저장된 로그인이 만료됐습니다.')}</p>
              <button type="button" class="btn-glow" ${provider.id === 'gemini' ? 'data-gemini-accounts' : 'data-claude-accounts'}>${t('계정 추가로 다시 로그인')}</button>
            </div>` : provider.login_expired ? `
            <div class="ai-login-alert">
              <p><i class="fas fa-triangle-exclamation"></i> ${t('로그인이 만료됐습니다.')}</p>
              <button type="button" class="btn-glow" data-relogin="${provider.id}" data-email="${escapeHtml(provider.account || '')}">${t('다시 로그인')}</button>
            </div>` : ''}
          ${windows.length ? `<div class="space-y-2.5">${windows.map(renderWindow).join('')}</div>` : provider.login_expired ? '' : `
            <div class="rounded-xl border border-dashed border-white/15 p-4 text-center text-xs text-white/40">
              ${provider.saved ? t('이 계정의 한도를 불러오지 못했습니다. 잠시 뒤 새로 고쳐 보십시오.') : provider.id === 'claude' && provider.login_stale && !provider.login_expired ? t('한도를 읽지 못했습니다. 로그인 기한이 지났습니다. Claude Code 를 실행하면 대개 자동으로 이어지고, 안 되면 다시 로그인하십시오.') : provider.id === 'claude' ? t('사용량 서버가 잠시 조회를 막았습니다 (요청이 몰리면 발생합니다). 잠시 뒤 다시 불러옵니다.') : unknownAccount(provider) ? t('이전 기록에는 계정 정보가 없어 한도를 연결할 수 없습니다.') : t('이 계정의 한도 정보를 불러오지 못했습니다.')}
            </div>`}
          ${breakdown.length ? `
            <div class="mt-4 border-t border-white/10 pt-3">
              <p class="mb-2 text-[10px] font-bold uppercase tracking-wider text-white/40">${t('이번 주 사용처')}</p>
              <div class="space-y-1.5">${breakdown.map((row) => `
                <div class="flex items-center gap-2 text-[11px]">
                  <span class="w-20 truncate text-white/60">${escapeHtml(row.name)}</span>
                  <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10"><div class="h-full rounded-full" style="width:${row.percent}%;background:${provider.accent}"></div></div>
                  <span class="w-9 text-right font-mono text-white/50">${row.percent.toFixed(0)}%</span>
                </div>`).join('')}</div>
            </div>` : ''}
          ${credits ? `<p class="mt-3 text-[10px] text-white/40"><i class="fas fa-coins mr-1"></i>${t('크레딧 {value}', { value: credits.unlimited ? t('무제한') : escapeHtml(credits.balance) })}</p>` : ''}
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
      { label: t('전체 토큰'), value: formatNumber(sum('total_tokens')), sub: t('오늘 {n}', { n: formatNumber(sum('today_tokens')) }), icon: 'fa-coins', color: 'text-blue-400' },
      { label: t('요청 수'), value: formatNumber(sum('requests')), sub: t('평균 {n} 토큰/요청', { n: formatNumber(sum('requests') ? sum('total_tokens') / sum('requests') : 0) }), icon: 'fa-bolt', color: 'text-amber-400' },
      { label: t('세션 수'), value: formatNumber(sum('sessions')), sub: t('활동일 {active}/{total}일', { active: Math.max(...providers.map((p) => p.active_days || 0)), total: state.data.window_days }), icon: 'fa-layer-group', color: 'text-purple-400' },
      { label: t('캐시 적중률'), value: cacheWeighted.weight ? percent(cacheWeighted.value / cacheWeighted.weight) : '—', sub: t('토큰 가중 평균'), icon: 'fa-database', color: 'text-emerald-400' },
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
    const peakDay = (p) => (p.peak_day ? `${new Date(`${p.peak_day.date}T00:00:00`).toLocaleDateString(t.locale, { month: 'numeric', day: 'numeric' })} · ${formatNumber(p.peak_day.total_tokens)}` : '—');
    const rows = [
      [t('전체 토큰'), (p) => formatNumber(p.total_tokens)],
      [t('오늘'), (p) => formatNumber(p.today_tokens)],
      [t('입력'), (p) => formatNumber(p.input_tokens)],
      [t('출력'), (p) => formatNumber(p.output_tokens)],
      [t('캐시 읽기'), (p) => formatNumber(p.cache_read_tokens)],
      [t('캐시 쓰기'), (p) => (p.id === 'claude' ? formatNumber(p.cache_write_tokens) : '—')],
      [t('추론 토큰'), (p) => (p.id === 'codex' || p.id === 'gemini' ? formatNumber(p.reasoning_tokens) : '—')],
      [t('캐시 적중률'), (p) => percent(p.cache_hit_rate)],
      [t('요청 수'), (p) => formatNumber(p.requests)],
      [t('세션 수'), (p) => formatNumber(p.sessions)],
      [t('평균 토큰 / 요청'), (p) => formatNumber(p.avg_tokens_per_request)],
      [t('평균 출력 / 요청'), (p) => formatNumber(p.avg_output_per_request)],
      [t('평균 토큰 / 세션'), (p) => formatNumber(p.avg_tokens_per_session)],
      [t('활동일'), (p) => t('{days}일', { days: p.active_days })],
      [t('최다 사용일'), peakDay],
      [t('피크 시간대'), peakHour],
      [t('주 사용 모델'), (p) => escapeHtml(p.model || '—')],
      [t('마지막 활동'), (p) => relativeTime(p.last_activity)],
    ];
    $('aiCompare').innerHTML = `
      <table class="w-full text-left text-xs">
        <thead><tr class="border-b border-white/10 text-[10px] uppercase tracking-wider text-white/40">
          <th class="py-2.5 pr-3 font-bold">${t('지표')}</th>
          ${providers.map((p) => `<th class="py-2.5 px-3 text-right font-bold"><span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-full" style="background:${p.accent}"></span>${escapeHtml(providerLabel(p))}</span></th>`).join('')}
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
      const parts = p.id === 'gemini'
        ? [[t('입력'), p.input_tokens, '#60a5fa'], [t('출력'), p.output_tokens, '#f472b6'], [t('캐시 읽기'), p.cache_read_tokens, '#34d399']]
        : p.id === 'claude'
        ? [[t('입력'), p.input_tokens, '#60a5fa'], [t('출력'), p.output_tokens, '#f472b6'], [t('캐시 읽기'), p.cache_read_tokens, '#34d399'], [t('캐시 쓰기'), p.cache_write_tokens, '#fbbf24']]
        : [[t('입력(비캐시)'), Math.max(p.input_tokens - p.cache_read_tokens, 0), '#60a5fa'], [t('출력'), p.output_tokens, '#f472b6'], [t('캐시 입력'), p.cache_read_tokens, '#34d399']];
      const total = parts.reduce((sum, part) => sum + part[1], 0) || 1;
      return `
        <div>
          <div class="mb-1.5 flex items-center justify-between text-[11px]"><span class="font-bold text-white/70">${escapeHtml(providerLabel(p))}</span><span class="font-mono text-white/40">${formatNumber(total)}</span></div>
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
          <span class="w-24 text-right text-[10px] text-white/35">${row.sessions !== undefined ? t('{requests}회 · {sessions}세션', { requests: formatNumber(row.requests), sessions: row.sessions }) : t('{requests}회', { requests: formatNumber(row.requests) })}</span>
        </div>
      </div>`).join('') : `<p class="py-6 text-center text-xs text-white/35">${t('기록이 없습니다.')}</p>`;
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
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.raw).toLocaleString(t.locale)} tokens` },
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
    const labels = providers[0].daily.map((day) => new Date(`${day.date}T00:00:00`).toLocaleDateString(t.locale, { month: 'numeric', day: 'numeric' }));
    upsertChart('daily', 'aiUsageChart', {
      type: 'bar',
      data: {
        labels,
        datasets: providers.map((p) => ({
          label: providerLabel(p), data: p.daily.map((day) => day.total_tokens),
          backgroundColor: `${p.accent}cc`, borderColor: p.accent, borderWidth: 1, borderRadius: 6, maxBarThickness: 36,
        })),
      },
      options: baseOptions(colors),
    });

    const hourly = baseOptions(colors);
    upsertChart('hourly', 'aiHourlyChart', {
      type: 'bar',
      data: {
        labels: Array.from({ length: 24 }, (_, h) => t('{h}시', { h })),
        datasets: providers.map((p) => ({
          label: providerLabel(p), data: p.hourly, backgroundColor: `${p.accent}b3`, borderRadius: 4, maxBarThickness: 18,
        })),
      },
      options: hourly,
    });

    // Monday-first short weekday names in the interface language (2024-01-01 is a Monday; ko-KR gives 월 … 일)
    const weekdayLabels = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(t.locale, { weekday: 'short' }));
    upsertChart('weekday', 'aiWeekdayChart', {
      type: 'bar',
      data: {
        labels: weekdayLabels,
        datasets: providers.map((p) => ({
          label: providerLabel(p), data: p.weekday, backgroundColor: `${p.accent}b3`, borderRadius: 4, maxBarThickness: 28,
        })),
      },
      options: baseOptions(colors),
    });
  }

  function render() {
    const data = state.data;
    if (!data) return;
    const providers = data.providers;
    renderLimits(providers, data.claude_accounts || [], data.gemini_accounts || []);
    renderKpis(providers);
    renderCompare(providers);
    renderComposition(providers);
    renderRanking('aiModels', providers, 'models');
    renderRanking('aiProjects', providers, 'projects');
    renderCharts(providers);
    const withData = providers.filter((p) => p.has_data).length;
    $('aiUsageCaption').textContent = withData
      ? t('{count}개 기록 그룹 · 최근 {days}일 · {time} 집계', { count: withData, days: data.window_days, time: new Date(data.generated_at).toLocaleTimeString(t.locale) })
      : t('선택한 기간에 로컬 세션 기록이 없습니다.');
  }

  let loadGeneration = 0;
  async function load() {
    const generation = ++loadGeneration;
    const button = $('aiUsageRefresh');
    button.disabled = true;
    button.querySelector('i')?.classList.add('fa-spin');
    try {
      const data = await api(`/api/ai-usage?days=${state.days}`);
      if (generation !== loadGeneration) return;
      state.data = data;
      render();
    } catch (error) {
      if (generation !== loadGeneration) return;
      $('aiUsageCaption').textContent = t('AI 사용량 정보를 불러오지 못했습니다.');
      toast(error.message, 'error');
    } finally {
      if (generation === loadGeneration) {
        button.disabled = false;
        button.querySelector('i')?.classList.remove('fa-spin');
      }
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

  // ── Multiple Codex accounts: switch · add (device-auth login) · remove ──
  // The server keeps a copy of the login file per account and swaps ~/.codex/auth.json on switch (tokens never reach the browser).
  const ui = () => window.UnivDashUI;
  const planName = (plan) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '');
  async function codexAccounts() {
    let data;
    let auto = null;
    try {
      [data, auto] = await Promise.all([api('/api/accounts/codex'), api('/api/accounts/codex/auto-switch')]);
    } catch (error) { toast(error.message, 'error'); return; }
    ui().actionSheet({
      title: t('Codex 계정'),
      subtitle: t('고르면 그 계정으로 바뀝니다. 새로 여는 Codex 세션부터 적용됩니다.'),
      actions: [
        ...data.accounts.map((a) => ({
          icon: 'fa-user', label: a.email, current: a.active, sub: a.active ? t('사용 중') : '',
          desc: [planName(a.plan), a.active ? t('지금 로그인된 계정') : t('저장 {time}', { time: relativeTime(new Date(a.saved_at * 1000).toISOString()) })].filter(Boolean).join(' · '),
          onClick: () => { if (!a.active) switchCodex(a); },
          side: logoutSide('codex', 'Codex', a),
        })),
        ...(data.accounts.length ? ['sep'] : []),
        {
          icon: 'fa-shuffle', label: t('사용량이 다 떨어지면 자동 전환'), sub: auto.enabled ? t('켜짐') : t('꺼짐'),
          desc: auto.message || (data.accounts.length < 2 ? t('계정이 2개 이상일 때 동작합니다') : t('남은 계정으로 바꾸고 멈춘 창을 이어서 진행합니다')),
          onClick: () => toggleAutoSwitch(!auto.enabled),
        },
        { icon: 'fa-plus', label: t('계정 추가'), desc: t('다른 ChatGPT 계정으로 로그인 (지금 로그인은 그대로)'), onClick: () => addCodexAccount() },
        { icon: 'fa-rotate', label: t('모든 Codex 창에 지금 계정 적용'), desc: t("'다른 계정으로 로그인했다' 토큰 오류가 날 때 · 같은 대화로 다시 켜기"), onClick: applyCodexAccount },
      ],
    });
  }
  async function toggleAutoSwitch(enabled) {
    try {
      await api('/api/accounts/codex/auto-switch', { method: 'PUT', body: { enabled } });
      toast(enabled ? t('자동 전환을 켰습니다.') : t('자동 전환을 껐습니다.'), 'success');
    } catch (error) { toast(error.message, 'error'); }
  }

  async function switchCodex(account) {
    const ok = await ui().confirmSheet({
      title: t('Codex 계정 바꾸기'),
      message: t('{email} 로 바꾸시겠습니까?\n모든 Codex 창을 잠깐 껐다가 Codex 를 최신으로 업데이트하고, 새 계정으로 같은 대화를 이어서 다시 켭니다 (공유 데몬도 다시 시작). 작업 중인 Codex 창이 있으면 모두 끝난 뒤 자동으로 진행합니다. 지금 계정은 목록에 남아 언제든 다시 고를 수 있습니다.', { email: account.email }),
      confirmLabel: t('바꾸기'),
    });
    if (!ok) return;
    try {
      const result = await api('/api/accounts/codex/switch', { method: 'POST', body: { id: account.id } });
      toast(t('Codex 계정을 {email} 로 바꿨습니다.', { email: account.email }), 'success');
      ui().codexAccountChanged(result.limits);
      if (result.applied) window.UnivDash.followCodexApply(result.applied);
    } catch (error) { toast(error.message, 'error'); }
  }
  async function applyCodexAccount() {
    const ok = await ui().confirmSheet({
      title: t('모든 Codex 창에 지금 계정 적용'),
      message: t("Codex 창을 모두 잠깐 껐다가 Codex 를 최신으로 업데이트하고, 지금 로그인된 계정으로 같은 대화를 이어서 다시 켭니다 (공유 데몬도 다시 시작). 작업 중인 창이 있으면 끝난 뒤 자동으로 진행합니다.\n'다른 계정으로 로그인했다'는 토큰 오류가 날 때 사용하십시오."),
      confirmLabel: t('적용'),
    });
    if (!ok) return;
    try {
      const result = await api('/api/accounts/codex/apply', { method: 'POST' });
      window.UnivDash.followCodexApply(result);
    } catch (error) { toast(error.message, 'error'); }
  }
  // ── Multiple Claude Code accounts: switch · add · remove ──
  // The server keeps a copy of the login token per account and swaps only the login in ~/.claude/.credentials.json on switch.
  // A running Claude Code notices the file change and continues with the new account (tokens never reach the browser).
  async function claudeAccounts() {
    let data;
    try { data = await api('/api/accounts/claude'); } catch (error) { toast(error.message, 'error'); return; }
    const label = (a) => [a.email, a.org && !a.org.includes(a.email || '\u0000') ? a.org : ''].filter(Boolean).join(' · ');
    ui().actionSheet({
      title: t('Claude Code 계정'),
      subtitle: data.accounts.length ? t('고르면 그 계정으로 바뀝니다. 실행 중인 Claude Code 창도 다시 켜지 않고 새 계정으로 이어집니다.') : t('계정을 추가하면 여기서 바꿀 수 있습니다.'),
      actions: [
        ...data.accounts.map((a) => ({
          icon: 'fa-user', label: label(a) || t('이름 없는 계정'), current: a.active, sub: a.active ? t('사용 중') : a.expired ? t('만료') : '',
          desc: [planName(a.plan), a.active ? t('지금 로그인된 계정') : a.expired ? t('로그인이 만료됐습니다 · 다시 추가하십시오') : t('저장 {time}', { time: relativeTime(new Date(a.saved_at * 1000).toISOString()) })].filter(Boolean).join(' · '),
          onClick: () => { if (!a.active) switchClaude(a); },
          side: logoutSide('claude', 'Claude Code', a),
        })),
        ...(data.accounts.length ? ['sep'] : []),
        { icon: 'fa-plus', label: t('계정 추가'), desc: t('다른 Claude 계정으로 로그인 (지금 로그인은 그대로)'), onClick: () => reloginClaude(true) },
      ],
    });
  }
  async function switchClaude(account) {
    const ok = await ui().confirmSheet({
      title: t('Claude Code 계정 바꾸기'),
      message: t('{email} 로 바꾸시겠습니까?\n실행 중인 Claude Code 창은 끄지 않습니다. 다음 요청부터 새 계정을 사용합니다. 지금 계정은 최신 로그인을 저장해 두므로 언제든 다시 고를 수 있습니다.', { email: account.email }),
      confirmLabel: t('바꾸기'),
    });
    if (!ok) return;
    try {
      const result = await api('/api/accounts/claude/switch', { method: 'POST', body: { id: account.id } });
      toast(result.changed ? t('Claude Code 계정을 {email} 로 바꿨습니다.', { email: result.email }) : t('이미 그 계정입니다.'), 'success');
      refreshAfterLogin();
    } catch (error) { toast(error.message, 'error'); }
  }
  // kind: 'claude' (Claude Code) · 'gemini' (Antigravity CLI — only adds accounts)
  function reloginClaude(add = false, kind = 'claude') {
    const who = kind === 'gemini' ? 'Gemini' : 'Claude';        // account name
    const product = kind === 'gemini' ? 'Gemini' : 'Claude Code';
    const site = kind === 'gemini' ? 'Google' : 'Claude';
    let login = null;
    let timer = null;
    let finished = false;
    const body = () => document.getElementById('sheetBody');
    const box = () => body()?.querySelector('.cx-login');
    const endpoint = () => `/api/accounts/${kind}/login/${login.id}`;
    const stop = () => { clearInterval(timer); timer = null; finished = true; };
    const retryButton = `<button type="button" class="btn-glow" data-claude-retry>${t('다시 시도')}</button>`;
    const paint = () => {
      const el = box();
      if (!el || !login) return;
      if (login.state === 'done') {
        el.innerHTML = add && !login.live
          ? `<p class="cx-done"><i class="fas fa-circle-check"></i> ${t('{name} 계정을 저장했습니다.', { name: escapeHtml(login.email || who) })}</p><p class="cx-note">${t('지금 사용 중인 계정은 그대로입니다. 계정 전환에서 선택해 바꿀 수 있습니다.')}</p>`
          : `<p class="cx-done"><i class="fas fa-circle-check"></i> ${t('{name} (으)로 로그인했습니다.', { name: escapeHtml(login.email || who) })}</p><p class="cx-note">${add ? t('지금 사용 중인 계정과 같거나 로그인이 비어 있어, 이 계정이 지금 로그인으로 적용됐습니다.') : t('실행 중인 {product} 창에도 곧 적용됩니다.', { product })}</p>`;
        return;
      }
      if (login.state === 'error' || login.state === 'cancelled') {
        el.innerHTML = `<p class="cx-error"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(login.error || t('로그인이 취소됐습니다.'))}</p>${retryButton}`;
        return;
      }
      if (login.state === 'verifying') {
        el.innerHTML = `<p class="cx-wait"><i class="fas fa-circle-notch fa-spin"></i> ${t('로그인 확인 중…')}</p>`;
        return;
      }
      el.innerHTML = `<ol class="cx-steps">
          <li><span>${t('이 링크를 열고 {site} 계정으로 로그인하십시오', { site })}</span><a href="${escapeHtml(login.url)}" target="_blank" rel="noopener noreferrer" class="cx-link">${t('로그인 페이지 열기')} <i class="fas fa-arrow-up-right-from-square"></i></a></li>
          <li><span>${t('화면에 나온 코드를 복사해 붙여 넣으십시오')}</span>
            <form class="cx-code-form" data-claude-code><input type="text" class="input-glass" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" placeholder="${t('코드 붙여넣기')}" aria-label="${t('로그인 코드')}" required><button type="submit" class="btn-glow">${t('확인')}</button></form></li>
        </ol><p class="cx-note">${add ? t('추가할 계정으로 로그인하십시오. 지금 로그인은 바뀌지 않습니다. 로그인하려는 계정이 맞는지 확인하십시오.') : t('로그인이 끝나기 전에는 지금 로그인이 그대로 유지됩니다. 다른 계정으로 로그인하면 Claude Code 전체가 그 계정으로 바뀝니다.')}</p>`;
    };
    const poll = () => {
      clearInterval(timer);
      timer = setInterval(async () => {
        try {
          login = await api(endpoint());
          if (['done', 'error', 'cancelled'].includes(login.state)) {
            stop();
            paint();
            if (login.state === 'done') { toast(add && !login.live ? t('{name} 계정을 저장했습니다.', { name: login.email || who }) : t('{product} 에 로그인했습니다.', { product }), 'success'); refreshAfterLogin(); }
          } else if (login.state === 'verifying') paint();
        } catch (error) { stop(); }
      }, 1500);
    };
    const start = () => {
      finished = false;
      login = null;
      const el = box();
      if (el) el.innerHTML = `<p class="cx-wait"><i class="fas fa-circle-notch fa-spin"></i> ${t('로그인 링크를 받는 중…')}</p>`;
      api(add ? `/api/accounts/${kind}/add` : '/api/accounts/claude/login', { method: 'POST' }).then((result) => {
        login = result;
        if (!body()) { api(endpoint(), { method: 'DELETE' }).catch(() => {}); return; }
        paint();
        poll();
      }).catch((error) => {
        finished = true;
        const target = box();
        if (target) target.innerHTML = `<p class="cx-error"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}</p>${retryButton}`;
      });
    };
    ui().infoSheet({
      title: add ? t('{product} 계정 추가', { product }) : t('Claude Code 다시 로그인'),
      subtitle: t('이 기기(휴대폰 · PC)의 브라우저에서 로그인하고 코드를 붙여 넣으십시오.'),
      bodyHtml: '<div class="cx-login"></div>',
      onClose: () => { clearInterval(timer); if (login && !finished) api(endpoint(), { method: 'DELETE' }).catch(() => {}); },
    });
    const el = box();
    el?.addEventListener('click', (event) => { if (event.target.closest('[data-claude-retry]')) start(); });
    el?.addEventListener('submit', async (event) => {
      const form = event.target.closest('[data-claude-code]');
      if (!form) return;
      event.preventDefault();
      const input = form.querySelector('input');
      const button = form.querySelector('button');
      const code = input.value.trim();
      if (!/^[A-Za-z0-9_\-.~#+/=%]{8,2048}$/.test(code)) { toast(t('코드 형식이 올바르지 않습니다. 복사한 코드를 그대로 붙여 넣어 주십시오.'), 'error'); return; }
      button.disabled = true;
      try {
        login = await api(`${endpoint()}/code`, { method: 'POST', body: { code } });
        paint();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    });
    start();
  }
  // ── Multiple Gemini (Antigravity CLI) accounts: switch · add · delete ──
  // The server keeps a copy of the login token per account and swaps the Antigravity CLI token file on switch (tokens never reach the browser).
  // Sign out: removes the current login and also the login info the server kept for that account (shared by Claude · Codex · Gemini)
  // Sign-out button on the right of an account row. The currently signed-in account is signed out (one confirmation); an account that is only saved has its saved login info deleted right away.
  function logoutSide(kind, product, account) {
    return {
      icon: 'fa-right-from-bracket', label: t('로그아웃'),
      onClick: () => (account.active ? logoutAccount(kind, product, account) : forgetAccount(kind, product, account)),
    };
  }
  async function forgetAccount(kind, product, account) {
    try {
      await api(`/api/accounts/${kind}/${account.id}`, { method: 'DELETE' });
      toast(t('{account} 의 저장된 {product} 로그인 정보를 삭제했습니다.', { account: account.email || t('선택한 계정'), product }), 'success');
      refreshAfterLogin();
      load();
    } catch (error) { toast(error.message, 'error'); }
  }
  async function logoutAccount(kind, product, account) {
    const ok = await ui().confirmSheet({
      title: t('{product} 로그아웃', { product }),
      message: t('{account} 에서 로그아웃하고, 이 서버에 저장된 이 계정의 로그인 정보와 백업을 삭제합니다.\n실행 중인 {product} 창도 더 이상 이 계정을 사용할 수 없으며, 다시 사용하려면 로그인해야 합니다. 저장해 둔 다른 계정은 그대로 남습니다.', { account: account.email || t('지금 계정'), product }),
      confirmLabel: t('로그아웃'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/accounts/${kind}/logout`, { method: 'POST' });
      toast(t('{product} 계정에서 로그아웃하고 저장된 정보를 삭제했습니다.', { product }), 'success');
      refreshAfterLogin();
      load();
    } catch (error) { toast(error.message, 'error'); }
  }
  async function geminiAccounts() {
    let data;
    try { data = await api('/api/accounts/gemini'); } catch (error) { toast(error.message, 'error'); return; }
    ui().actionSheet({
      title: t('Gemini 계정'),
      subtitle: data.accounts.length ? t('선택하면 그 계정으로 바뀝니다. 쉬고 있는 Gemini 창은 같은 대화로 다시 켜집니다.') : t('계정을 추가하면 여기에서 바꿀 수 있습니다.'),
      actions: [
        ...data.accounts.map((a) => ({
          icon: a.active ? 'fa-circle-check' : 'fa-user', label: a.email || t('이름 없는 계정'), desc: [a.plan, a.active ? t('현재 사용 중') : ''].filter(Boolean).join(' · '), current: a.active,
          onClick: () => { if (!a.active) switchGemini(a); },
          side: logoutSide('gemini', 'Gemini', a),
        })),
        ...(data.accounts.length ? ['sep'] : []),
        { icon: 'fa-plus', label: t('계정 추가'), desc: t('다른 Google 계정으로 로그인 (지금 로그인은 그대로)'), onClick: () => reloginClaude(true, 'gemini') },
      ],
    });
  }
  async function switchGemini(account) {
    const ok = await ui().confirmSheet({
      title: t('Gemini 계정 바꾸기'),
      message: t('{account} (으)로 바꾸시겠습니까?\n쉬고 있는 Gemini 창은 잠깐 껐다가 같은 대화로 다시 켭니다. 작업 중인 창은 그대로 두므로, 끝난 뒤 직접 다시 켜야 새 계정이 적용됩니다.', { account: account.email || t('선택한 계정') }),
      confirmLabel: t('바꾸기'),
    });
    if (!ok) return;
    try {
      const result = await api('/api/accounts/gemini/switch', { method: 'POST', body: { id: account.id } });
      const skipped = result.windows?.skipped?.length || 0;
      const email = result.email || t('선택한 계정');
      const message = !result.changed ? t('이미 그 계정입니다.')
        : skipped ? t('Gemini 계정을 {email} (으)로 바꿨습니다. 다시 켜지 못한 창이 {count}개 있습니다.', { email, count: skipped })
        : t('Gemini 계정을 {email} (으)로 바꿨습니다.', { email });
      toast(message, skipped ? 'warn' : 'success');
      refreshAfterLogin();
    } catch (error) { toast(error.message, 'error'); }
  }
  // When the login changes, re-read the header gauge and this page
  function refreshAfterLogin() { ui().codexAccountChanged(); }
  function addCodexAccount(relogin = null) {
    let login = null;
    let timer = null;
    let finished = false;
    const body = () => document.getElementById('sheetBody');
    ui().infoSheet({
      title: relogin === null ? t('Codex 계정 추가') : t('Codex 다시 로그인'),
      subtitle: relogin === null ? t('다른 기기(휴대폰 · PC)의 브라우저에서 로그인하면 여기에 추가됩니다.') : t('이 기기(휴대폰 · PC)의 브라우저에서 {account} 으로 로그인하십시오.', { account: relogin || t('ChatGPT 계정') }),
      bodyHtml: `<div class="cx-login"><p class="cx-wait"><i class="fas fa-circle-notch fa-spin"></i> ${t('로그인 코드를 받는 중…')}</p></div>`,
      onClose: () => { clearInterval(timer); if (login && !finished) api(`/api/accounts/codex/login/${login.id}`, { method: 'DELETE' }).catch(() => {}); },
    });
    const paint = () => {
      const box = body()?.querySelector('.cx-login');
      if (!box || !login) return;
      if (login.state === 'done') {
        const message = login.live
          ? `<p class="cx-done"><i class="fas fa-circle-check"></i> ${t('{email} 로 다시 로그인했습니다.', { email: escapeHtml(login.email) })}</p><p class="cx-note">${t('실행 중인 Codex 창은 그대로 두고 새 로그인으로 이어집니다.')}</p>`
          : `<p class="cx-done"><i class="fas fa-circle-check"></i> ${t('{name} 계정을 저장했습니다.', { name: escapeHtml(login.email) })}</p><p class="cx-note">${t('지금 쓰는 계정과 달라서 바꾸지 않았습니다. 계정 목록에서 골라 바꿀 수 있습니다.')}</p>`;
        box.innerHTML = message;
        return;
      }
      if (login.state === 'error' || login.state === 'cancelled') {
        box.innerHTML = `<p class="cx-error"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(login.error || t('로그인이 취소됐습니다.'))}</p>`;
        return;
      }
      const minutes = Math.ceil((login.expires_in || 0) / 60);
      box.innerHTML = `<ol class="cx-steps">
          <li><span>${relogin === null ? t('이 링크를 열고, 추가할 ChatGPT 계정으로 로그인하십시오') : t('이 링크를 열고, {account}으로 로그인하십시오', { account: escapeHtml(relogin || t('ChatGPT 계정')) })}</span><a href="${escapeHtml(login.url)}" target="_blank" rel="noopener noreferrer" class="cx-link">${escapeHtml(login.url)} <i class="fas fa-arrow-up-right-from-square"></i></a></li>
          <li><span>${t('이 코드를 입력하십시오 <small>({minutes}분 안에)</small>', { minutes })}</span><button type="button" class="cx-code" data-copy-code title="${t('눌러서 복사')}">${escapeHtml(login.code)} <i class="far fa-copy"></i></button></li>
        </ol><p class="cx-wait"><i class="fas fa-circle-notch fa-spin"></i> ${t('로그인을 기다리는 중…')}</p>
        <p class="cx-note">${t('다른 사람이 보내 준 코드라면 입력하지 마십시오.')}</p>`;
      box.querySelector('[data-copy-code]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(login.code); toast(t('코드를 복사했습니다.'), 'success'); } catch (e) { toast(login.code, 'info'); }
      });
    };
    api('/api/accounts/codex/login', { method: 'POST' }).then((result) => {
      login = result;
      if (!body()) return;
      paint();
      timer = setInterval(async () => {
        try {
          login = await api(`/api/accounts/codex/login/${login.id}`);
          if (['done', 'error', 'cancelled'].includes(login.state)) {
            clearInterval(timer);
            finished = true;
            paint();
            if (login.state === 'done') {
              toast(login.live ? t('{email} 로 다시 로그인했습니다.', { email: login.email }) : t('{name} 계정을 저장했습니다.', { name: login.email }), 'success');
              refreshAfterLogin();
            }
          }
        } catch (error) { clearInterval(timer); }
      }, 2000);
    }).catch((error) => {
      finished = true;
      const box = body()?.querySelector('.cx-login');
      if (box) box.innerHTML = `<p class="cx-error"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}</p>`;
    });
  }
  $('aiLimits').addEventListener('click', (event) => {
    if (event.target.closest('[data-codex-accounts]')) { codexAccounts(); return; }
    if (event.target.closest('[data-claude-accounts]')) { claudeAccounts(); return; }
    if (event.target.closest('[data-gemini-accounts]')) { geminiAccounts(); return; }
    const pick = event.target.closest('[data-claude-switch]');
    if (pick) { (pick.dataset.provider === 'gemini' ? switchGemini : switchClaude)({ id: pick.dataset.claudeSwitch, email: pick.dataset.email }); return; }
    const relogin = event.target.closest('[data-relogin]');
    if (!relogin) return;
    if (relogin.dataset.relogin === 'claude') reloginClaude();
    else addCodexAccount(relogin.dataset.email || '');
  });
  window.addEventListener('univdash:codex-account-changed', () => {
    state.data = null;
    $('aiLimits').innerHTML = `<div class="text-sm text-white/50">${t('계정별 사용량을 불러오는 중…')}</div>`;
    for (const id of ['aiKpis', 'aiCompare', 'aiComposition', 'aiModels', 'aiProjects']) $(id).innerHTML = '';
    for (const chart of Object.values(state.charts)) chart.destroy();
    state.charts = {};
    load();
  });

  document.querySelectorAll('[data-ai-days]').forEach((btn) => btn.addEventListener('click', () => setPeriod(Number(btn.dataset.aiDays))));
  $('aiUsageRefresh').addEventListener('click', load);
  window.addEventListener('univdash:themechange', () => { if (state.data) renderCharts(state.data.providers); });

  let saved = 7;
  try { saved = Number(localStorage.getItem('univdash-ai-days')) || 7; } catch (e) { /* noop */ }
  setPeriod([1, 7, 30].includes(saved) ? saved : 7);
  // Refresh every 60 seconds (including remaining limits and time until reset)
  setInterval(load, 60000);
})();
