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

  function providerLabel(provider) {
    return provider.id === 'codex' && provider.account
      ? `Codex · ${provider.account}` : provider.name;
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
                ${provider.account ? `<p class="ai-account text-[11px] font-semibold text-white/60 break-all"><i class="far fa-user text-[9px] mr-1 opacity-70"></i>${escapeHtml(provider.account)}</p>` : '<p class="text-[11px] text-white/35">로그인 계정 정보 없음</p>'}
                ${provider.id === 'codex' && provider.active !== false ? '<button type="button" class="ai-accounts-btn mt-1" data-codex-accounts><i class="fas fa-right-left"></i> 계정 전환 · 추가</button>' : ''}
                ${provider.id === 'codex' && provider.active ? '<p class="text-[10px] font-bold text-emerald-400">현재 사용 중</p>' : ''}
                <p class="text-[10px] text-white/40">${limits?.updated_at ? `기준 ${relativeTime(limits.updated_at)}` : '한도 정보 없음'}</p>
              </div>
            </div>
            ${limits?.plan ? `<span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-white/60">${escapeHtml(limits.plan)}</span>` : ''}
          </div>
          ${windows.length ? `<div class="space-y-2.5">${windows.map(renderWindow).join('')}</div>` : `
            <div class="rounded-xl border border-dashed border-white/15 p-4 text-center text-xs text-white/40">
              ${provider.id === 'claude' ? 'Claude Code 를 실행하면 ~/.claude.json 에 한도 정보가 기록됩니다.' : provider.account?.startsWith('계정 미확인') ? '이전 기록에는 계정 정보가 없어 한도를 연결할 수 없습니다.' : '이 계정의 한도 정보를 불러오지 못했습니다.'}
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
      const parts = p.id === 'claude'
        ? [['입력', p.input_tokens, '#60a5fa'], ['출력', p.output_tokens, '#f472b6'], ['캐시 읽기', p.cache_read_tokens, '#34d399'], ['캐시 쓰기', p.cache_write_tokens, '#fbbf24']]
        : [['입력(비캐시)', Math.max(p.input_tokens - p.cache_read_tokens, 0), '#60a5fa'], ['출력', p.output_tokens, '#f472b6'], ['캐시 입력', p.cache_read_tokens, '#34d399']];
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
        labels: Array.from({ length: 24 }, (_, h) => `${h}시`),
        datasets: providers.map((p) => ({
          label: providerLabel(p), data: p.hourly, backgroundColor: `${p.accent}b3`, borderRadius: 4, maxBarThickness: 18,
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
    renderLimits(providers);
    renderKpis(providers);
    renderCompare(providers);
    renderComposition(providers);
    renderRanking('aiModels', providers, 'models');
    renderRanking('aiProjects', providers, 'projects');
    renderCharts(providers);
    const withData = providers.filter((p) => p.has_data).length;
    $('aiUsageCaption').textContent = withData
      ? `${withData}개 기록 그룹 · 최근 ${data.window_days}일 · ${new Date(data.generated_at).toLocaleTimeString('ko-KR')} 집계`
      : '선택한 기간에 로컬 세션 기록이 없습니다.';
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
      $('aiUsageCaption').textContent = 'AI 사용량 정보를 불러오지 못했습니다.';
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

  // ── Codex 계정 여러 개: 전환 · 추가(기기 인증 로그인) · 지우기 ──
  // 서버는 계정마다 로그인 파일 복사본을 보관하고, 전환하면 ~/.codex/auth.json 을 바꿔 끼운다 (토큰은 브라우저로 오지 않는다).
  const ui = () => window.UnivDashUI;
  const planName = (plan) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '');
  async function codexAccounts() {
    let data;
    try { data = await api('/api/accounts/codex'); } catch (error) { toast(error.message, 'error'); return; }
    const others = data.accounts.filter((a) => !a.active);
    ui().actionSheet({
      title: 'Codex 계정',
      subtitle: '고르면 그 계정으로 바뀌어요. 새로 여는 Codex 세션부터 적용돼요.',
      actions: [
        ...data.accounts.map((a) => ({
          icon: 'fa-user', label: a.email, current: a.active, sub: a.active ? '사용 중' : '',
          desc: [planName(a.plan), a.active ? '지금 로그인된 계정' : `저장 ${relativeTime(new Date(a.saved_at * 1000).toISOString())}`].filter(Boolean).join(' · '),
          onClick: () => { if (!a.active) switchCodex(a); },
        })),
        ...(data.accounts.length ? ['sep'] : []),
        { icon: 'fa-plus', label: '계정 추가', desc: '다른 ChatGPT 계정으로 로그인 (지금 로그인은 그대로)', onClick: addCodexAccount },
        { icon: 'fa-rotate', label: '모든 Codex 창에 지금 계정 적용', desc: "'다른 계정으로 로그인했다' 토큰 오류가 날 때 · 같은 대화로 다시 켜기", onClick: applyCodexAccount },
        ...(others.length ? [{ icon: 'fa-trash', label: '저장된 계정 지우기', danger: true, onClick: () => removeCodexMenu(others) }] : []),
      ],
    });
  }
  async function switchCodex(account) {
    const ok = await ui().confirmSheet({
      title: 'Codex 계정 바꾸기',
      message: `${account.email} 로 바꿀까요?\n실행 중인 Codex 창은 잠깐 껐다가 새 계정으로 같은 대화를 이어서 다시 켜요 (Codex 공유 데몬도 다시 시작). 작업 중인 Codex 가 있으면 끝난 뒤에 바꿀 수 있어요. 지금 계정은 목록에 남아 언제든 다시 고를 수 있어요.`,
      confirmLabel: '바꾸기',
    });
    if (!ok) return;
    try {
      toast('Codex 계정을 바꾸는 중… (Codex 창을 다시 켜는 데 몇 초 걸려요)', 'info');
      const result = await api('/api/accounts/codex/switch', { method: 'POST', body: { id: account.id } });
      toast(`Codex 계정을 ${account.email} 로 바꿨어요.${appliedText(result.applied)}`, result.applied?.error ? 'warn' : 'success');
      ui().codexAccountChanged(result.limits);
    } catch (error) { toast(error.message, 'error'); }
  }
  function appliedText(applied) {
    if (!applied) return '';
    if (applied.error) return ` 다만 Codex 창을 다시 켜지 못했어요: ${applied.error}`;
    const parts = [];
    if (applied.relaunched?.length) parts.push(`Codex 창 ${applied.relaunched.length}개를 같은 대화로 다시 켰어요`);
    if (applied.skipped?.length) parts.push(`다시 켜지 못한 창: ${applied.skipped.join(', ')}`);
    return parts.length ? ` ${parts.join(' · ')}.` : '';
  }
  async function applyCodexAccount() {
    const ok = await ui().confirmSheet({
      title: '모든 Codex 창에 지금 계정 적용',
      message: "Codex 창을 모두 잠깐 껐다가 지금 로그인된 계정으로 같은 대화를 이어서 다시 켜요 (공유 데몬도 다시 시작).\n'다른 계정으로 로그인했다'는 토큰 오류가 날 때 쓰세요.",
      confirmLabel: '적용',
    });
    if (!ok) return;
    try {
      toast('Codex 창을 다시 켜는 중…', 'info');
      const result = await api('/api/accounts/codex/apply', { method: 'POST' });
      toast(`적용했어요.${appliedText(result)}`, 'success');
    } catch (error) { toast(error.message, 'error'); }
  }
  function removeCodexMenu(others) {
    ui().actionSheet({
      title: '저장된 계정 지우기', subtitle: '지운 계정은 다시 쓰려면 로그인해서 추가해야 해요.',
      actions: others.map((a) => ({
        icon: 'fa-trash', danger: true, label: a.email,
        onClick: async () => {
          const ok = await ui().confirmSheet({ title: '계정 지우기', message: `${a.email} 의 저장된 로그인 정보를 지울까요?`, confirmLabel: '지우기', danger: true });
          if (!ok) return;
          try { await api(`/api/accounts/codex/${a.id}`, { method: 'DELETE' }); toast('지웠어요.', 'success'); load(); } catch (error) { toast(error.message, 'error'); }
        },
      })),
    });
  }
  function addCodexAccount() {
    let login = null;
    let timer = null;
    let finished = false;
    const body = () => document.getElementById('sheetBody');
    ui().infoSheet({
      title: 'Codex 계정 추가',
      subtitle: '다른 기기(휴대폰 · PC)의 브라우저에서 로그인하면 여기에 추가돼요.',
      bodyHtml: '<div class="cx-login"><p class="cx-wait"><i class="fas fa-circle-notch fa-spin"></i> 로그인 코드를 받는 중…</p></div>',
      onClose: () => { clearInterval(timer); if (login && !finished) api(`/api/accounts/codex/login/${login.id}`, { method: 'DELETE' }).catch(() => {}); },
    });
    const paint = () => {
      const box = body()?.querySelector('.cx-login');
      if (!box || !login) return;
      if (login.state === 'done') {
        box.innerHTML = `<p class="cx-done"><i class="fas fa-circle-check"></i> ${escapeHtml(login.email)} 계정을 추가했어요.</p><p class="cx-note">계정 목록에서 골라 바꿀 수 있어요. 지금 로그인은 그대로예요.</p>`;
        return;
      }
      if (login.state === 'error' || login.state === 'cancelled') {
        box.innerHTML = `<p class="cx-error"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(login.error || '로그인이 취소됐어요.')}</p>`;
        return;
      }
      const minutes = Math.ceil((login.expires_in || 0) / 60);
      box.innerHTML = `<ol class="cx-steps">
          <li><span>이 링크를 열고, 추가할 ChatGPT 계정으로 로그인하세요</span><a href="${escapeHtml(login.url)}" target="_blank" rel="noopener noreferrer" class="cx-link">${escapeHtml(login.url)} <i class="fas fa-arrow-up-right-from-square"></i></a></li>
          <li><span>이 코드를 입력하세요 <small>(${minutes}분 안에)</small></span><button type="button" class="cx-code" data-copy-code title="눌러서 복사">${escapeHtml(login.code)} <i class="far fa-copy"></i></button></li>
        </ol><p class="cx-wait"><i class="fas fa-circle-notch fa-spin"></i> 로그인을 기다리는 중…</p>
        <p class="cx-note">다른 사람이 보내 준 코드라면 입력하지 마세요.</p>`;
      box.querySelector('[data-copy-code]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(login.code); toast('코드를 복사했어요.', 'success'); } catch (e) { toast(login.code, 'info'); }
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
            if (login.state === 'done') { toast(`${login.email} 계정을 추가했어요.`, 'success'); load(); }
          }
        } catch (error) { clearInterval(timer); }
      }, 2000);
    }).catch((error) => {
      finished = true;
      const box = body()?.querySelector('.cx-login');
      if (box) box.innerHTML = `<p class="cx-error"><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(error.message)}</p>`;
    });
  }
  $('aiLimits').addEventListener('click', (event) => { if (event.target.closest('[data-codex-accounts]')) codexAccounts(); });
  window.addEventListener('univdash:codex-account-changed', () => {
    state.data = null;
    $('aiLimits').innerHTML = '<div class="text-sm text-white/50">계정별 사용량을 불러오는 중…</div>';
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
  // 60초마다 갱신 (남은 한도 · 리셋까지 남은 시간 포함)
  setInterval(load, 60000);
})();
