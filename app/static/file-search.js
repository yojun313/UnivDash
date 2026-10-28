// Shared find bar for Explorer and every Workspace file pane.
(function () {
  'use strict';
  const viewers = [];
  let last = null;
  let serial = 0;
  const visible = (v) => v.container.isConnected && v.container.getClientRects().length && getComputedStyle(v.container).visibility !== 'hidden';
  const fromEvent = (event) => viewers.find((v) => event.composedPath().includes(v.container));
  document.addEventListener('pointerdown', (e) => { last = fromEvent(e) || last; }, true);
  document.addEventListener('focusin', (e) => { last = fromEvent(e) || last; }, true);
  // 찾기 · 바꾸기 · 다음/이전 찾기는 단축키 설정(keys.js)을 따른다. 기본: Ctrl/⌘+F · Ctrl+H(⌘⌥F) · F3 / Shift+F3
  const targetOf = (event) => [event && fromEvent(event), last, ...viewers].find((v) => v && visible(v) && v.hasFile());
  const keys = window.UnivDashKeys;
  keys?.register('find.open', (event) => {
    const target = targetOf(event);
    if (!target) return false;
    last = target; target.open();
    return true;
  });
  keys?.register('find.replace', (event) => {
    const target = targetOf(event);
    if (!target?.canReplace()) return false;
    last = target; target.open({ replace: true });
    return true;
  });
  [['find.next', 1], ['find.prev', -1]].forEach(([id, step]) => keys?.register(id, (event) => {
    const target = targetOf(event);
    if (!target?.isOpen()) return false;
    target.next(step);
    return true;
  }));
  document.addEventListener('keydown', (event) => {
    if (event.isComposing || event.key !== 'Escape') return;
    const target = targetOf(event);
    if (target?.isOpen()) { event.preventDefault(); event.stopImmediatePropagation(); target.close(); }
  }, true);

  function mount(container, body, getState) {
    const name = `exfind${++serial}`;
    const bar = document.createElement('div');
    bar.className = 'exv-find'; bar.hidden = true;
    bar.setAttribute('role', 'search'); bar.setAttribute('aria-label', '파일 내용 검색');
    bar.innerHTML = '<button type="button" data-find="toggle-replace" class="exv-find-expand" aria-label="바꾸기 열기 / 닫기" aria-expanded="false" title="바꾸기 열기 / 닫기 (Ctrl+H · ⌘⌥F)"><i class="fas fa-chevron-right"></i></button>'
      + '<div class="exv-find-rows"><div class="exv-find-row">'
      + '<div class="exv-find-field"><input type="search" class="exv-find-query" placeholder="찾기" aria-label="검색어" autocomplete="off" spellcheck="false">'
      + '<button type="button" data-find="case" class="exv-find-opt" aria-label="대/소문자 구분" aria-pressed="false" title="대/소문자 구분 (Alt+C)">Aa</button>'
      + '<button type="button" data-find="word" class="exv-find-opt" aria-label="단어 단위로" aria-pressed="false" title="단어 단위로 (Alt+W)"><u>ab</u></button>'
      + '<button type="button" data-find="regex" class="exv-find-opt" aria-label="정규식 사용" aria-pressed="false" title="정규식 사용 (Alt+R)">.*</button></div>'
      + '<span class="exv-find-count" role="status" aria-live="polite"></span>'
      + '<button type="button" data-find="prev" aria-label="이전 결과" title="이전 결과 (Shift+Enter)">↑</button>'
      + '<button type="button" data-find="next" aria-label="다음 결과" title="다음 결과 (Enter)">↓</button>'
      + '<button type="button" data-find="close" aria-label="검색 닫기" title="닫기 (Esc)">×</button></div>'
      + '<div class="exv-find-row exv-replace-row" hidden>'
      + '<div class="exv-find-field"><input type="text" class="exv-replace-query" placeholder="바꾸기" aria-label="바꿀 내용" autocomplete="off" spellcheck="false"></div>'
      + '<button type="button" data-find="replace" class="exv-find-act" aria-label="바꾸기" title="바꾸기 (Enter)"><i class="fas fa-arrow-right-arrow-left"></i></button>'
      + '<button type="button" data-find="replace-all" class="exv-find-act" aria-label="모두 바꾸기" title="모두 바꾸기 (Ctrl/⌘+Alt+Enter)"><i class="fas fa-check-double"></i></button>'
      + '</div></div>';
    body.before(bar);
    const input = bar.querySelector('.exv-find-query');
    const replaceInput = bar.querySelector('.exv-replace-query');
    const replaceRow = bar.querySelector('.exv-replace-row');
    const expand = bar.querySelector('.exv-find-expand');
    const count = bar.querySelector('.exv-find-count');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'term-tool'; button.title = '파일에서 찾기 (Ctrl/⌘+F)';
    button.setAttribute('aria-label', '파일에서 찾기'); button.innerHTML = '<i class="fas fa-magnifying-glass"></i>';
    container.querySelector('[data-act="wrap"]')?.before(button);
    let matches = [], index = -1, request = 0, timer = 0, caseSensitive = false, wholeWord = false, useRegex = false, returnFocus = null;
    let replaceOpen = false, nextFrom = null;
    let signature = '', pdfCache = null, selectedRange = null;
    const styles = new Map();
    const highlightCss = `::highlight(${name}){background:#facc1566;color:inherit}::highlight(${name}active){background:#fb923c;color:#111827}`;
    const highlighter = !!(window.CSS?.highlights && window.Highlight);
    const escaped = (q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const status = (message) => {
      count.textContent = message;
      count.classList.toggle('none', !matches.length && !!input.value);
      bar.querySelectorAll('[data-find="prev"], [data-find="next"]').forEach((b) => { b.disabled = !matches.length; });
      bar.querySelectorAll('[data-find="replace"], [data-find="replace-all"]').forEach((b) => { b.disabled = !matches.length || !getState().editor; });
    };
    // VS Code 와 같은 검색 규칙: 대/소문자 · 단어 단위 · 정규식 (정규식이면 ^ $ 는 줄마다)
    const WORD = '[\\p{L}\\p{N}_]';
    function buildRegex(query, global = true) {
      let source = useRegex ? query : escaped(query);
      if (wholeWord) source = `(?<!${WORD})(?:${source})(?!${WORD})`;
      return new RegExp(source, `${global ? 'g' : ''}u${caseSensitive ? '' : 'i'}${useRegex ? 'm' : ''}`);
    }
    // 바꿀 내용: 정규식이면 $1 · $& · $<이름> 과 \n · \t 를 VS Code 처럼 풀어 쓴다
    function expandReplacement(hit, text) {
      const template = replaceInput.value;
      if (!useRegex) return template;
      const unescaped = template.replace(/\\(\\|n|t)/g, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));
      return unescaped.replace(/\$(\$|&|`|'|<([^>]*)>|\d{1,2})/g, (m, token, group) => {
        if (token === '$') return '$';
        if (token === '&') return hit[0];
        if (token === '`') return text.slice(0, hit.index);
        if (token === "'") return text.slice(hit.index + hit[0].length);
        if (group != null) return hit.groups?.[group] ?? m;
        let n = Number(token);
        if (n >= hit.length && token.length === 2) { n = Number(token[0]); return n && n < hit.length ? (hit[n] ?? '') + token[1] : m; }
        return n && n < hit.length ? (hit[n] ?? '') : m;
      });
    }
    // 편집기(textarea)는 글자에 색을 칠할 수 없어서, 같은 글꼴 · 줄바꿈의 복제 층을 뒤에 깔고 그 위에 표시한다
    let layer = null, layerEditor = null;
    const scrolled = new WeakSet();
    function placeLayer() {
      const editor = layerEditor;
      if (!layer || !editor?.isConnected) return;
      Object.assign(layer.style, { left: `${editor.offsetLeft}px`, top: `${editor.offsetTop}px`, width: `${editor.clientWidth}px`, height: `${editor.clientHeight}px` });
      layer.firstChild.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    }
    function paintEditor(editor) {
      if (!editor?.parentElement) return;
      if (!layer || layerEditor !== editor || !layer.isConnected) {
        layer?.remove();
        layer = document.createElement('div'); layer.className = 'exv-find-layer'; layer.setAttribute('aria-hidden', 'true');
        layer.appendChild(document.createElement('div'));
        editor.before(layer); layerEditor = editor;
        if (!scrolled.has(editor)) { scrolled.add(editor); editor.addEventListener('scroll', () => { if (layerEditor === editor) placeLayer(); }); }
      }
      const css = getComputedStyle(editor), inner = layer.firstChild;
      for (const prop of ['font', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'wordBreak', 'overflowWrap', 'whiteSpace', 'textIndent']) inner.style[prop] = css[prop];
      inner.style.minWidth = `${editor.clientWidth}px`;
      inner.style.width = /pre-wrap/.test(css.whiteSpace) ? `${editor.clientWidth}px` : 'max-content';
      const text = editor.value, frag = document.createDocumentFragment();
      let at = 0;
      matches.forEach((m, i) => {
        if (m.start == null) return;
        if (m.start > at) frag.append(text.slice(at, m.start));
        const mark = document.createElement('mark'); mark.textContent = text.slice(m.start, m.end);
        if (i === index) mark.className = 'active';
        frag.append(mark); at = m.end;
      });
      frag.append(text.slice(at) + '\n');
      inner.replaceChildren(frag);
      placeLayer();
    }
    function markActiveInEditor() {
      if (!layer) return;
      layer.querySelectorAll('mark').forEach((mark, i) => mark.classList.toggle('active', i === index));
    }
    function clearHighlights() {
      layer?.remove(); layer = null; layerEditor = null;
      if (highlighter) { CSS.highlights.delete(name); CSS.highlights.delete(name + 'active'); }
      body.querySelectorAll('.exv-find-hit').forEach((el) => el.remove());
      if (selectedRange) {
        const selection = window.getSelection();
        if (selection?.rangeCount && selection.getRangeAt(0) === selectedRange) selection.removeAllRanges();
        selectedRange = null;
      }
    }
    function styleRoot(root) {
      if (!highlighter || styles.has(root)) return;
      const style = document.createElement('style'); style.textContent = highlightCss;
      (root === document ? document.head : root).append(style); styles.set(root, style);
    }
    function collect() {
      const pieces = [];
      let text = '', previousBlock = null;
      const scan = (root) => {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE && node.matches('script,style,noscript,.exv-meta,.exv-gutter,.exv-note,.exv-conflict,.exv-find-hit,[aria-hidden="true"],[hidden]')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        while (walk.nextNode()) {
          const node = walk.currentNode;
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.shadowRoot) { styleRoot(node.shadowRoot); scan(node.shadowRoot); }
            continue;
          }
          if (!node.data || !node.parentElement?.getClientRects().length || getComputedStyle(node.parentElement).visibility === 'hidden') continue;
          const block = node.parentElement.closest('p,li,pre,td,th,h1,h2,h3,h4,h5,h6,div');
          if (previousBlock && block !== previousBlock) text += '\n';
          previousBlock = block;
          pieces.push({ node, start: text.length, end: text.length + node.length }); text += node.data;
        }
      };
      styleRoot(document); scan(body);
      return { text, pieces };
    }
    function rangeFor(pieces, start, end) {
      const a = pieces.find((p) => p.end > start), b = pieces.find((p) => p.end >= end);
      if (!a || !b || a.node.getRootNode() !== b.node.getRootNode()) return null;
      const range = document.createRange(); range.setStart(a.node, start - a.start); range.setEnd(b.node, end - b.start); return range;
    }
    function paint() {
      clearHighlights();
      const { editor } = getState();
      if (editor) { paintEditor(editor); return; }
      const ranges = matches.map((m) => m.range).filter(Boolean);
      if (highlighter && ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
      matches.forEach((m, i) => {
        if (!m.page) return;
        const page = body.querySelector(`.exv-pdf-page[data-page="${m.page}"]`);
        if (!page) return;
        for (const [x, y, w, h] of m.rects) {
          const hit = document.createElement('span'); hit.className = 'exv-find-hit'; hit.dataset.findIndex = i;
          Object.assign(hit.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }); page.append(hit);
        }
      });
    }
    function reveal() {
      const match = matches[index]; if (!match) return;
      const { editor } = getState();
      if (editor && match.start != null) {
        editor.setSelectionRange(match.start, match.end);
        markActiveInEditor();
        // A mirror uses the textarea's actual wrapping, tabs, and font metrics.
        const mirror = document.createElement('div'), marker = document.createElement('span');
        const css = getComputedStyle(editor);
        for (const prop of ['font','lineHeight','letterSpacing','tabSize','padding','boxSizing','wordBreak','overflowWrap','textIndent']) mirror.style[prop] = css[prop];
        Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', width: `${editor.clientWidth}px`, whiteSpace: editor.wrap === 'off' ? 'pre' : 'pre-wrap' });
        mirror.textContent = editor.value.slice(0, match.start); marker.textContent = editor.value.slice(match.start, match.end) || ' '; mirror.append(marker); document.body.append(mirror);
        const rect = marker.getBoundingClientRect(), base = mirror.getBoundingClientRect();
        editor.scrollTop = Math.max(0, rect.top - base.top - editor.clientHeight / 2);
        editor.scrollLeft = Math.max(0, rect.left - base.left - editor.clientWidth / 2);
        mirror.remove(); editor.dispatchEvent(new Event('scroll')); placeLayer();
      } else if (match.range) {
        if (highlighter) CSS.highlights.set(name + 'active', new Highlight(match.range));
        else { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(match.range); selectedRange = match.range; }
        const rect = match.range.getBoundingClientRect();
        let node = match.range.startContainer.parentElement;
        while (node && node !== container) {
          if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
            const box = node.getBoundingClientRect(); node.scrollTop += rect.top - box.top - node.clientHeight / 2;
          }
          node = node.parentElement || node.getRootNode().host;
        }
      } else if (match.page) {
        body.querySelectorAll('.exv-find-hit').forEach((el) => el.classList.toggle('active', Number(el.dataset.findIndex) === index));
        const hit = body.querySelector(`.exv-find-hit[data-find-index="${index}"]`);
        if (hit) { const rect = hit.getBoundingClientRect(), box = body.getBoundingClientRect(); body.scrollTop += rect.top - box.top - body.clientHeight / 2; }
      }
      status(`${index + 1} / ${matches.length}${pdfCache?.truncated ? '+' : ''}`);
    }
    async function refresh(reset = false) {
      if (bar.hidden) return;
      const mine = ++request, state = getState(), query = input.value;
      if (!state.entry) { clearHighlights(); matches = []; status('파일을 열어 주세요'); return; }
      const key = `${state.entry.path}\0${!!state.editor}\0${state.pdf?.version || ''}\0${query}\0${caseSensitive}${wholeWord}${useRegex}`;
      reset ||= key !== signature; signature = key;
      const old = matches[index];
      let hasText = true;
      clearHighlights(); matches = []; pdfCache = null;
      if (!query) { index = -1; status('검색어를 입력하세요'); return; }
      try {
        if (state.pdf) {
          status('검색 중…');
          const data = await window.UnivDash.api(`/api/fs/pdf/search?path=${encodeURIComponent(state.entry.path)}&q=${encodeURIComponent(query)}&case_sensitive=${caseSensitive}`);
          if (mine !== request || bar.hidden || state.entry.path !== getState().entry?.path) return;
          matches = data.matches; pdfCache = data;
        } else {
          const doc = state.editor ? { text: state.editor.value } : collect();
          hasText = !!doc.text.trim();
          let re;
          try { re = buildRegex(query); } catch (e) { index = -1; status('잘못된 정규식'); return; }
          for (const hit of doc.text.matchAll(re)) {
            if (!hit[0].length) continue;   // 빈 일치(a* 같은)는 건너뛴다
            const start = hit.index, end = start + hit[0].length;
            const range = doc.pieces ? rangeFor(doc.pieces, start, end) : null;
            if (!doc.pieces || range) matches.push({ start, end, range });
            if (matches.length === 3000) break;
          }
        }
        if (!matches.length) { index = -1; status(!hasText || state.pdf && !pdfCache.has_text ? '검색할 텍스트가 없습니다' : '결과 없음'); return; }
        if (nextFrom != null) {
          const from = nextFrom; nextFrom = null;
          index = matches.findIndex((m) => m.start >= from); if (index < 0) index = 0;
        } else if (reset && state.editor) {
          // 커서 뒤의 첫 결과부터 (VS Code 처럼)
          const from = state.editor.selectionStart;
          index = matches.findIndex((m) => m.start >= from); if (index < 0) index = 0;
        } else index = reset ? 0 : Math.max(0, matches.findIndex((m) => m.start === old?.start && m.page === old?.page));
        paint(); reveal();
      } catch (error) { if (mine === request) status(error.message || '검색하지 못했습니다'); }
    }
    const schedule = () => { if (!bar.hidden) { clearTimeout(timer); timer = setTimeout(() => refresh(), 180); } };
    const controller = {
      container, hasFile: () => !!getState().entry, isOpen: () => !bar.hidden,
      canReplace: () => !!getState().editor,
      open({ replace = false } = {}) {
        setReplace(replace || (replaceOpen && !!getState().editor));
        if (bar.hidden) returnFocus = document.activeElement;
        const editor = getState().editor;
        const selection = editor ? editor.value.slice(editor.selectionStart, editor.selectionEnd) : window.getSelection()?.toString();
        if (bar.hidden && selection && selection.length <= 200 && !selection.includes('\n')) input.value = selection;
        bar.hidden = false; last = controller;
        const field = replace && input.value ? replaceInput : input;
        field.focus(); field.select(); refresh();
      },
      close() {
        bar.hidden = true; request++; clearTimeout(timer); clearHighlights();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      },
      next(delta = 1) { if (matches.length) { index = (index + delta + matches.length) % matches.length; reveal(); } },
      refresh: schedule,
    };
    function setReplace(open) {
      replaceOpen = open && !!getState().editor;
      replaceRow.hidden = !replaceOpen;
      expand.setAttribute('aria-expanded', String(replaceOpen));
      expand.classList.toggle('open', replaceOpen);
      expand.hidden = !getState().editor;   // 바꾸기는 편집 중일 때만
    }
    // 편집기 글자를 바꾼다: 되돌리기(Ctrl+Z)가 되게 insertText 를 먼저 쓰고, 안 되면 setRangeText
    function editText(editor, start, end, text) {
      const focused = document.activeElement;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(start, end);
      let done = false;
      try { done = document.execCommand('insertText', false, text); } catch (e) { done = false; }
      if (!done || editor.value.slice(start, start + text.length) !== text) {
        editor.setRangeText(text, start, end, 'end');
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
      focused?.focus?.({ preventScroll: true });
    }
    function replaceOne() {
      const editor = getState().editor;
      if (!editor || !input.value) return;
      const match = matches[index];
      if (!match) { refresh(true); return; }
      let re;
      try { re = buildRegex(input.value); } catch (e) { return; }
      re.lastIndex = match.start;
      const hit = re.exec(editor.value);
      if (!hit || hit.index !== match.start || hit[0].length !== match.end - match.start) { refresh(true); return; }   // 글이 바뀌었으면 다시 찾기
      const text = expandReplacement(hit, editor.value);
      editText(editor, match.start, match.end, text);
      nextFrom = match.start + text.length;
      clearTimeout(timer); signature = ''; refresh();
    }
    function replaceAll() {
      const editor = getState().editor;
      if (!editor || !input.value) return;
      let re;
      try { re = buildRegex(input.value); } catch (e) { return; }
      const source = editor.value;
      let out = '', at = 0, n = 0;
      for (const hit of source.matchAll(re)) {
        if (!hit[0].length) continue;
        out += source.slice(at, hit.index) + expandReplacement(hit, source);
        at = hit.index + hit[0].length; n++;
      }
      if (!n) return;
      out += source.slice(at);
      // 바뀐 부분만 감싸서 한 번에 넣는다 (한 번의 Ctrl+Z 로 되돌림)
      let head = 0;
      while (head < source.length && head < out.length && source[head] === out[head]) head++;
      let tail = 0;
      while (tail < source.length - head && tail < out.length - head && source[source.length - 1 - tail] === out[out.length - 1 - tail]) tail++;
      editText(editor, head, source.length - tail, out.slice(head, out.length - tail));
      clearTimeout(timer); signature = ''; refresh();
      status(`${n}개 바꿈`);
    }
    button.addEventListener('click', () => controller.open());
    input.addEventListener('input', () => {
      request++; signature = ''; clearHighlights(); matches = []; index = -1;
      status(input.value ? '검색 중…' : '검색어를 입력하세요'); schedule();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && (event.ctrlKey || event.metaKey) && event.altKey) { event.preventDefault(); replaceAll(); return; }
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); clearTimeout(timer); if (signature.includes(`\0${input.value}\0`)) controller.next(event.shiftKey ? -1 : 1); else refresh(true); }
    });
    replaceInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      if ((event.ctrlKey || event.metaKey) && event.altKey) replaceAll(); else replaceOne();
    });
    // VS Code 단축키: Alt+C 대/소문자, Alt+W 단어 단위, Alt+R 정규식 (검색창 안에서)
    bar.addEventListener('keydown', (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const opt = { KeyC: 'case', KeyW: 'word', KeyR: 'regex' }[event.code];
      if (!opt) return;
      event.preventDefault(); event.stopPropagation();
      bar.querySelector(`[data-find="${opt}"]`).click();
    });
    bar.addEventListener('click', (event) => {
      const action = event.target.closest('[data-find]')?.dataset.find;
      if (action === 'close') controller.close();
      else if (action === 'next' || action === 'prev') controller.next(action === 'prev' ? -1 : 1);
      else if (action === 'case' || action === 'word' || action === 'regex') {
        const btn = event.target.closest('[data-find]');
        const on = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(on));
        if (action === 'case') caseSensitive = on; else if (action === 'word') wholeWord = on; else useRegex = on;
        refresh(true);
      } else if (action === 'toggle-replace') { setReplace(!replaceOpen); (replaceOpen ? replaceInput : input).focus(); }
      else if (action === 'replace') replaceOne();
      else if (action === 'replace-all') replaceAll();
    });
    body.addEventListener('input', schedule);
    new MutationObserver((records) => {
      const ours = (n) => n.nodeType !== 1 ? !!n.parentElement?.closest('.exv-find-layer') : n.matches('.exv-find-hit, .exv-find-layer') || !!n.closest('.exv-find-layer');
      if (records.some((r) => !r.target.closest?.('.exv-find-hit, .exv-find-layer') && [...r.addedNodes, ...r.removedNodes].some((n) => !ours(n)) || r.type === 'characterData' && !ours(r.target))) {
        if (!getState().editor) setReplace(false); else expand.hidden = false;
        schedule();
      }
    }).observe(body, { childList: true, subtree: true, characterData: true });
    viewers.push(controller);
    return controller;
  }
  window.UnivDashFileSearch = { mount };
})();
