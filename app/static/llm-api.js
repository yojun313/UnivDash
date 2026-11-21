// AI 페이지: 탭 (AI 사용량 · OpenAI 호환 API) 과 API 서버 관리 화면.
// 서버: app/routes/llm_api_routes.py (/api/llm/*). 토큰 값은 만들 때 · 다시 만들 때 한 번만 받는다.
(function () {
  'use strict';
  const { escapeHtml, api, toast, formatNumber } = window.UnivDash;
  const $ = (id) => document.getElementById(id);
  const panel = $('llm-api');
  const usagePanel = $('ai-usage');
  if (!panel || !usagePanel) return;
  const ui = () => window.UnivDashUI;
  const num = (value) => (formatNumber ? formatNumber(value || 0) : Number(value || 0).toLocaleString('ko-KR'));

  let state = null;
  let example = 'curl';
  let timer = 0;

  // ── 탭 ──
  const tabs = [...document.querySelectorAll('[data-ai-tab]')];
  function showTab(name, push) {
    const isApi = name === 'api';
    tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.aiTab === name)));
    panel.classList.toggle('hidden', !isApi);
    usagePanel.classList.toggle('hidden', isApi);
    if (push) history.replaceState(null, '', isApi ? '#api' : location.pathname);
    clearInterval(timer);
    if (isApi) {
      load();
      timer = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, 10000);
    } else {
      window.dispatchEvent(new Event('resize'));   // 숨겨져 있던 차트가 크기를 다시 잡게
    }
  }
  tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.aiTab, true)));

  // ── 불러오기 · 그리기 ──
  async function load(quiet) {
    try {
      state = await api('/api/llm/state');
      render();
    } catch (error) {
      if (!quiet) toast(error.message, 'error');
    }
  }
  async function change(url, method, body, done) {
    try {
      const result = await api(url, { method, body });
      if (result && result.providers) { state = result; render(); } else await load(true);
      if (done) toast(done, 'success');
      return result;
    } catch (error) {
      toast(error.message, 'error');
      await load(true);
      return null;
    }
  }
  const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const baseUrl = () => `${location.origin}/llm/v1`;
  const sw = (on, attrs, label) => `<button type="button" class="pmd-mode-switch${on ? ' on' : ''}" aria-pressed="${on}" aria-label="${escapeHtml(label)}" ${attrs}></button>`;

  function render() {
    if (!state) return;
    const usable = state.providers.some((p) => p.enabled && p.installed && p.accounts.some((a) => a.enabled && !a.expired));
    const liveTokens = state.tokens.filter((t) => t.enabled && !t.expired).length;
    const status = $('llmStatus');
    const sandboxProblem = state.sandbox?.problem || '';
    status.textContent = sandboxProblem ? '격리 실행 불가' : !state.enabled ? '꺼짐' : !usable ? '켜짐 · 쓸 계정 없음' : !liveTokens ? '켜짐 · 토큰 없음' : '켜짐';
    status.className = `llm-badge ${sandboxProblem ? 'warn' : !state.enabled ? 'off' : usable && liveTokens ? 'on' : 'warn'}`;
    $('llmTabDot').classList.toggle('hidden', !state.enabled);
    const toggle = $('llmEnabled');
    toggle.classList.toggle('on', state.enabled);
    toggle.setAttribute('aria-pressed', String(state.enabled));
    $('llmBaseUrl').textContent = baseUrl();
    $('llmNow').textContent = sandboxProblem ? `${sandboxProblem} 격리 없이는 실행하지 않아요.` : state.enabled
      ? `처리 중 ${state.active}건 · 동시에 최대 ${state.max_concurrency}건 · 쓸 수 있는 토큰 ${liveTokens}개`
      : '서버가 꺼져 있어요. 켜면 토큰을 가진 프로그램이 바로 쓸 수 있어요.';

    $('llmProviders').innerHTML = state.providers.map((p) => {
      const accounts = p.accounts.length ? p.accounts.map((a) => `
          <div class="llm-acc"><div class="grow"><div class="mail">${escapeHtml(a.email || a.id)}</div>
            <small>${[a.plan, a.active ? '지금 로그인된 계정' : '저장된 계정', a.expired ? '다시 로그인 필요' : ''].filter(Boolean).map(escapeHtml).join(' · ')}</small></div>
            ${sw(a.enabled, `data-llm-account="${escapeHtml(a.id)}" data-provider="${p.id}"${a.expired ? ' disabled' : ''}`, `${a.email || a.id} 계정을 API 에 쓰기`)}</div>`).join('')
        : '<div class="llm-acc"><small>로그인된 계정이 없어요. AI 사용량 탭에서 계정을 추가하세요.</small></div>';
      return `<div class="llm-prov"><div class="llm-prov-head"><div class="grow"><b>${escapeHtml(p.label)}</b>
            <small>${p.installed ? `모델 이름: ${p.id}${p.id === 'claude' ? ' · claude/opus · claude/sonnet …' : ' · codex/<모델>'}` : 'CLI 가 설치되어 있지 않아요'}</small></div>
          ${sw(p.enabled, `data-llm-provider="${p.id}"`, `${p.label} 을 API 로 내어 주기`)}</div>${accounts}</div>`;
    }).join('');

    const aliases = Object.entries(state.aliases || {});
    $('llmSettings').innerHTML = [
      ['기본 모델', state.default_model, '요청에 model 이 없을 때'],
      ['계정 고르는 방법', state.strategy === 'round_robin' ? '돌아가며 (요청마다 다음 계정)' : '순서대로 (지금 로그인된 계정 먼저, 한도가 차면 다음 계정)'],
      ['동시에 처리할 요청', `${state.max_concurrency}건`],
      ['응답 제한 시간', `${state.timeout}초`],
      ['모델 별칭', aliases.length ? aliases.map(([a, t]) => `${a} → ${t}`).join(', ') : '없음'],
    ].map(([k, v, hint]) => `<div class="llm-set"><span>${escapeHtml(k)}${hint ? ` <span style="opacity:.5;font-weight:500">(${escapeHtml(hint)})</span>` : ''}</span><span>${escapeHtml(v)}</span></div>`).join('');

    $('llmTokens').innerHTML = state.tokens.length ? state.tokens.map((t) => {
      const limits = [t.providers.map((p) => (p === 'claude' ? 'Claude' : 'Codex')).join(' + '), t.rpm ? `분당 ${t.rpm}회` : '횟수 제한 없음',
        t.expires ? (t.expired ? '만료됨' : `${when(t.expires)} 만료`) : '만료 없음'];
      const pinned = Object.entries(t.accounts || {}).filter(([, id]) => id).map(([p, id]) => {
        const account = state.providers.find((x) => x.id === p)?.accounts.find((a) => a.id === id);
        return `${p === 'claude' ? 'Claude' : 'Codex'} 계정 고정: ${account?.email || '없는 계정'}`;
      });
      return `<div class="llm-token${t.enabled && !t.expired ? '' : ' off'}" data-llm-token="${escapeHtml(t.id)}">
          <div class="grow"><div class="name">${escapeHtml(t.name)} <code>${escapeHtml(t.hint)}</code>${t.expired ? ' <span class="llm-badge warn">만료</span>' : ''}</div>
            <small>${limits.concat(pinned).map(escapeHtml).join(' · ')}</small>
            <small>요청 ${num(t.requests)}회 (오류 ${num(t.errors)}) · 입력 ${num(t.input_tokens)} · 출력 ${num(t.output_tokens)} 토큰 · 마지막 사용 ${escapeHtml(when(t.last_used))}${t.last_ip ? ` · ${escapeHtml(t.last_ip)}` : ''}</small></div>
          <div class="acts">${sw(t.enabled, 'data-act="toggle"', `${t.name} 토큰 켜기 · 끄기`)}
            <button type="button" class="llm-btn" data-act="edit"><i class="fas fa-pen"></i> 설정</button>
            <button type="button" class="llm-btn" data-act="rotate"><i class="fas fa-rotate"></i> 다시 만들기</button>
            <button type="button" class="llm-btn danger" data-act="delete"><i class="fas fa-trash-can"></i></button></div></div>`;
    }).join('') : '<p class="llm-empty">토큰이 없어요. 토큰을 만들어야 API 를 쓸 수 있어요.</p>';

    const select = $('llmTestModel');
    const chosen = select.value || state.default_model;
    select.innerHTML = state.models.map((m) => `<option value="${escapeHtml(m)}"${m === chosen ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('');

    $('llmLog').innerHTML = state.log.length ? `<table class="llm-log"><thead><tr><th>시각</th><th>토큰</th><th>모델</th><th>계정</th><th>결과</th><th>걸린 시간</th><th>입력</th><th>출력</th><th>IP</th></tr></thead><tbody>${
      state.log.map((e) => `<tr><td>${escapeHtml(when(e.ts))}</td><td>${escapeHtml(e.token || '')}</td><td>${escapeHtml(e.model || '')}${e.stream ? ' <span style="opacity:.5">stream</span>' : ''}</td><td>${escapeHtml(e.account || '—')}</td>
        <td class="${e.status < 400 ? 'ok' : 'bad'}">${e.status}${e.error ? ` ${escapeHtml(e.error)}` : ''}</td><td>${(e.ms / 1000).toFixed(1)}초</td><td>${num(e.input_tokens)}</td><td>${num(e.output_tokens)}</td><td>${escapeHtml(e.ip || '')}</td></tr>`).join('')
    }</tbody></table>` : '<p class="llm-empty">아직 요청이 없어요.</p>';
    renderExample();
  }

  function renderExample() {
    const url = baseUrl();
    const model = state?.default_model || 'claude';
    const samples = {
      curl: `curl ${url}/chat/completions \\\n  -H "Authorization: Bearer $UNIVDASH_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${model}", "messages": [{"role": "user", "content": "안녕!"}]}'`,
      python: `from openai import OpenAI\n\nclient = OpenAI(base_url="${url}", api_key="ud-...")\nstream = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "안녕!"}],\n    stream=True,\n)\nfor chunk in stream:\n    if chunk.choices:\n        print(chunk.choices[0].delta.content or "", end="")`,
      node: `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${url}", apiKey: "ud-..." });\nconst res = await client.chat.completions.create({\n  model: "${model}",\n  messages: [{ role: "user", content: "안녕!" }],\n});\nconsole.log(res.choices[0].message.content);`,
    };
    $('llmExample').textContent = samples[example];
    document.querySelectorAll('[data-llm-ex]').forEach((b) => b.classList.toggle('on', b.dataset.llmEx === example));
  }
  document.querySelectorAll('[data-llm-ex]').forEach((b) => b.addEventListener('click', () => { example = b.dataset.llmEx; renderExample(); }));

  async function copy(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done, 'success'); } catch (e) { toast('복사하지 못했어요 (HTTPS 에서만 가능).', 'error'); }
  }
  $('llmCopyUrl').addEventListener('click', () => copy(baseUrl(), 'Base URL 을 복사했어요.'));

  // ── 서버 켜고 끄기 ──
  $('llmEnabled').addEventListener('click', async () => {
    if (!state) return;
    if (!state.enabled) {
      const ok = await ui().confirmSheet({
        title: 'API 서버를 켤까요?',
        message: `토큰을 가진 프로그램이 ${baseUrl()} 로 이 서버의 Claude · Codex 를 쓸 수 있게 돼요. 사용량은 켜 둔 계정의 구독 한도에서 나가요.`,
        confirmLabel: '켜기',
      });
      if (!ok) return;
    }
    change('/api/llm/settings', 'PUT', { enabled: !state.enabled }, state.enabled ? 'API 서버를 껐어요.' : 'API 서버를 켰어요.');
  });

  // ── 제공자 · 계정 ──
  $('llmProviders').addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !state) return;
    const on = !button.classList.contains('on');
    if (button.dataset.llmProvider) change('/api/llm/settings', 'PUT', { providers: { [button.dataset.llmProvider]: on } });
    else if (button.dataset.llmAccount) change('/api/llm/accounts', 'PUT', { provider: button.dataset.provider, id: button.dataset.llmAccount, enabled: on });
  });

  // ── 설정 ──
  $('llmEditSettings').addEventListener('click', () => {
    if (!state) return;
    const aliasText = Object.entries(state.aliases || {}).map(([a, t]) => `${a} = ${t}`).join('\n');
    ui().formSheet({
      title: 'API 설정', subtitle: '바꾸면 다음 요청부터 적용돼요',
      fields: [{ name: 'default_model', label: '기본 모델 (예: claude, claude/sonnet, codex)', value: state.default_model, maxlength: 80 }],
      extraHtml: `<label>계정 고르는 방법<select name="strategy">
            <option value="order"${state.strategy === 'order' ? ' selected' : ''}>순서대로 — 지금 로그인된 계정 먼저, 한도가 차면 다음 계정</option>
            <option value="round_robin"${state.strategy === 'round_robin' ? ' selected' : ''}>돌아가며 — 요청마다 다음 계정 (한도를 고르게 씀)</option></select></label>
        <label>동시에 처리할 요청 (1–8)<input name="max_concurrency" inputmode="numeric" value="${state.max_concurrency}" maxlength="1" autocomplete="off"></label>
        <label>응답 제한 시간 (초, 10–1800)<input name="timeout" inputmode="numeric" value="${state.timeout}" maxlength="4" autocomplete="off"></label>
        <label>모델 별칭 — 한 줄에 하나, "받을 이름 = 실제 모델"<textarea name="aliases" rows="4" spellcheck="false" placeholder="gpt-4o = claude/sonnet&#10;gpt-4o-mini = claude/haiku">${escapeHtml(aliasText)}</textarea></label>
        <p class="text-[11px] opacity-60 leading-5">별칭을 두면 모델 이름이 gpt-4o 로 고정된 프로그램도 그대로 쓸 수 있어요.</p>`,
      async onSubmit(values) {
        const aliases = {};
        String(values.aliases || '').split('\n').map((line) => line.trim()).filter(Boolean).forEach((line) => {
          const at = line.indexOf('=');
          if (at < 1) throw new Error(`별칭 줄을 "이름 = 모델" 로 적어 주세요: ${line}`);
          aliases[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        });
        state = await api('/api/llm/settings', { method: 'PUT', body: {
          default_model: String(values.default_model || '').trim(), strategy: values.strategy,
          max_concurrency: Math.max(1, Math.min(8, Number(values.max_concurrency) || 2)),
          timeout: Math.max(10, Math.min(1800, Number(values.timeout) || 300)), aliases,
        } });
        render();
        toast('설정을 저장했어요.', 'success');
      },
    });
  });

  // ── 토큰 ──
  const EXPIRES = [[0, '만료 없음'], [1, '1일'], [7, '7일'], [30, '30일'], [90, '90일'], [365, '1년']];
  function tokenFormHtml(token) {
    const has = (p) => !token || token.providers.includes(p);
    const accountSelect = (p) => {
      const provider = state.providers.find((x) => x.id === p);
      const current = token?.accounts?.[p] || '';
      return `<label>${escapeHtml(provider.label)} 계정<select name="account_${p}"><option value="">자동 — 켜 둔 계정 중에서</option>${
        provider.accounts.map((a) => `<option value="${escapeHtml(a.id)}"${a.id === current ? ' selected' : ''}>${escapeHtml(a.email || a.id)}${a.enabled ? '' : ' (꺼져 있음)'}</option>`).join('')}</select></label>`;
    };
    return `<label class="check-row"><input type="checkbox" name="p_claude"${has('claude') ? ' checked' : ''}> Claude 모델 쓰기</label>
      <label class="check-row"><input type="checkbox" name="p_codex"${has('codex') ? ' checked' : ''}> Codex 모델 쓰기</label>
      <label>분당 요청 수 제한 (0 = 제한 없음)<input name="rpm" inputmode="numeric" value="${token ? token.rpm : 30}" maxlength="3" autocomplete="off"></label>
      <label>${token ? '만료 다시 정하기' : '만료'}<select name="expires_days">${token ? '<option value="-1" selected>그대로 두기</option>' : ''}${
        EXPIRES.map(([d, label]) => `<option value="${d}"${!token && d === 0 ? ' selected' : ''}>${label}${d ? ' 뒤' : ''}</option>`).join('')}</select></label>
      ${accountSelect('claude')}${accountSelect('codex')}`;
  }
  function tokenBody(values) {
    const body = {
      name: String(values.name || '').trim(),
      providers: ['claude', 'codex'].filter((p) => values[`p_${p}`]),
      rpm: Math.max(0, Math.min(600, Number(values.rpm) || 0)),
      accounts: { claude: values.account_claude || '', codex: values.account_codex || '' },
    };
    if (Number(values.expires_days) >= 0) body.expires_days = Number(values.expires_days);
    return body;
  }
  function showToken(token, info, title) {
    ui().infoSheet({
      title, subtitle: info.name,
      bodyHtml: `<div class="share-box"><div class="share-link"><input readonly value="${escapeHtml(token)}" aria-label="API 토큰" spellcheck="false">
          <button type="button" class="btn-glow" data-copy><i class="fas fa-copy mr-1"></i>복사</button></div>
        <p class="text-[11px] opacity-60 leading-5 mt-3"><i class="fas fa-triangle-exclamation mr-1"></i>토큰은 지금만 보여요. 서버에는 알아볼 수 없는 형태(해시)로만 저장해서 나중에 다시 볼 수 없어요. 잃어버리면 "다시 만들기"로 새 값을 받으세요.</p></div>`,
      onMount(body) {
        const input = body.querySelector('input');
        input.addEventListener('focus', () => input.select());
        body.querySelector('[data-copy]').addEventListener('click', () => copy(token, 'API 토큰을 복사했어요.'));
      },
    });
  }
  $('llmNewToken').addEventListener('click', () => {
    if (!state) return;
    ui().formSheet({
      title: '새 API 토큰', subtitle: '프로그램 · 사람마다 하나씩 만들면 따로 끊을 수 있어요', submitLabel: '만들기',
      fields: [{ name: 'name', label: '이름 (어디에 쓰는 토큰인지)', placeholder: '예: 내 노트북 스크립트', maxlength: 40 }],
      extraHtml: tokenFormHtml(null),
      async onSubmit(values) {
        const result = await api('/api/llm/tokens', { method: 'POST', body: tokenBody(values) });
        await load(true);
        setTimeout(() => showToken(result.token, result.info, 'API 토큰을 만들었어요'), 0);
        return false;
      },
    });
  });
  $('llmTokens').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    const row = event.target.closest('[data-llm-token]');
    if (!button || !row || !state) return;
    const token = state.tokens.find((t) => t.id === row.dataset.llmToken);
    if (!token) return;
    const url = `/api/llm/tokens/${encodeURIComponent(token.id)}`;
    if (button.dataset.act === 'toggle') {
      change(url, 'PATCH', { enabled: !token.enabled }, token.enabled ? '토큰을 껐어요. 이 토큰으로는 요청할 수 없어요.' : '토큰을 켰어요.');
    } else if (button.dataset.act === 'edit') {
      ui().formSheet({
        title: '토큰 설정', subtitle: `${token.name} · ${token.hint}`,
        fields: [{ name: 'name', label: '이름', value: token.name, maxlength: 40 }],
        extraHtml: tokenFormHtml(token),
        async onSubmit(values) {
          await api(url, { method: 'PATCH', body: tokenBody(values) });
          await load(true);
          toast('토큰 설정을 저장했어요.', 'success');
        },
      });
    } else if (button.dataset.act === 'rotate') {
      const ok = await ui().confirmSheet({ title: '토큰 값을 다시 만들까요?', message: `"${token.name}" 의 지금 값은 바로 못 쓰게 되고 새 값이 나와요. 설정과 사용 기록은 그대로예요.`, confirmLabel: '다시 만들기', danger: true });
      if (!ok) return;
      const result = await change(`${url}/rotate`, 'POST');
      if (result?.token) showToken(result.token, result.info, '새 토큰 값이에요');
    } else if (button.dataset.act === 'delete') {
      const ok = await ui().confirmSheet({ title: '토큰을 지울까요?', message: `"${token.name}" 토큰으로는 더 이상 요청할 수 없어요.`, confirmLabel: '지우기', danger: true });
      if (ok) change(url, 'DELETE', undefined, '토큰을 지웠어요.');
    }
  });

  // ── 시험 · 기록 ──
  $('llmTestRun').addEventListener('click', async () => {
    const out = $('llmTestOut');
    const button = $('llmTestRun');
    const prompt = $('llmTestPrompt').value.trim();
    if (!prompt) return;
    button.disabled = true;
    out.classList.remove('hidden', 'error');
    out.textContent = '답을 기다리는 중…';
    try {
      const result = await api('/api/llm/test', { method: 'POST', body: { model: $('llmTestModel').value, prompt } });
      out.textContent = `${result.text}\n\n— ${result.model} · ${result.account || ''} · ${(result.ms / 1000).toFixed(1)}초 · 입력 ${num(result.usage.prompt_tokens)} / 출력 ${num(result.usage.completion_tokens)} 토큰`;
    } catch (error) {
      out.classList.add('error');
      out.textContent = error.message;
    }
    button.disabled = false;
    load(true);
  });
  $('llmRefresh').addEventListener('click', () => load());
  $('llmClearLog').addEventListener('click', async () => {
    const ok = await ui().confirmSheet({ title: '요청 기록을 비울까요?', message: '토큰별 누적 사용량은 그대로 남아요.', confirmLabel: '비우기', danger: true });
    if (ok) change('/api/llm/log', 'DELETE', undefined, '기록을 비웠어요.');
  });

  showTab(location.hash === '#api' ? 'api' : 'usage', false);
  // 사용량 탭에 있어도 서버가 켜져 있는지는 탭의 초록 점으로 보여 준다
  if (location.hash !== '#api') api('/api/llm/state').then((data) => { state = data; $('llmTabDot').classList.toggle('hidden', !data.enabled); }).catch(() => {});
})();
