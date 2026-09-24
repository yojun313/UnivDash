// ============================================================================
// UnivDash 공통 테마 시스템 (LecAI 테마 시스템 기반)
// - #themeSettingsBtn 이 있는 페이지에 테마 설정 모달을 붙인다.
// - 테마 스타일: <html data-ui-theme="mesh|apple|mono"> (기본 '오로라'는 속성 없음)
// - 다크/라이트: <html data-ui-theme-mode="light"> (다크가 기본)
// - 실제 배색은 /static/theme.css 가 담당한다.
// - 첫 페인트 전 적용은 _theme.html 의 인라인 스니펫이 먼저 처리한다.
// ============================================================================
(function () {
  'use strict';

  var STYLE_KEY = 'univdash-theme-style';
  var MODE_KEY = 'univdash-theme';
  var THEMES = [
    { id: 'default', label: '오로라' },
    { id: 'mesh', label: '그라디언트 메시' },
    { id: 'apple', label: '애플 글래스' },
    { id: 'mono', label: '미니멀 플랫' },
  ];

  var html = document.documentElement;

  function get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function set(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* noop */ } }

  function currentStyle() {
    var saved = get(STYLE_KEY);
    return THEMES.some(function (t) { return t.id === saved; }) ? saved : 'default';
  }
  function currentMode() {
    var saved = get(MODE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }

  function applyStyle(id, persist) {
    if (id === 'default') html.removeAttribute('data-ui-theme');
    else html.setAttribute('data-ui-theme', id);
    if (persist) set(STYLE_KEY, id);
  }

  function applyMode(mode, persist) {
    if (mode === 'light') html.setAttribute('data-ui-theme-mode', 'light');
    else html.removeAttribute('data-ui-theme-mode');
    html.style.colorScheme = mode;
    if (persist) set(MODE_KEY, mode);
    try {
      window.dispatchEvent(new CustomEvent('univdash:themechange', { detail: { theme: mode, style: currentStyle() } }));
    } catch (e) { /* noop */ }
  }

  applyStyle(currentStyle(), false);
  applyMode(currentMode(), false);

  window.UnivDashTheme = {
    current: function () { return html.getAttribute('data-ui-theme-mode') === 'light' ? 'light' : 'dark'; },
  };

  function buildModal() {
    var overlay = document.createElement('div');
    overlay.className = 'pmd-theme-overlay';
    overlay.hidden = true;

    var optionsHtml = THEMES.map(function (t) {
      return (
        '<button type="button" class="pmd-theme-option" data-theme="' + t.id + '">'
        + '<span class="pmd-theme-swatch pmd-swatch-' + t.id + '"></span>'
        + '<span><span class="pmd-theme-check">✓</span>' + t.label + '</span>'
        + '</button>'
      );
    }).join('');

    overlay.innerHTML =
      '<div class="pmd-theme-modal" role="dialog" aria-modal="true" aria-label="테마 설정">'
      + '<div class="pmd-theme-head">'
      + '<div><h3>테마 설정</h3><p>원하는 테마를 골라보세요. 모든 페이지에 동일하게 적용됩니다.</p></div>'
      + '<button type="button" class="pmd-theme-close" aria-label="닫기">&times;</button>'
      + '</div>'
      + '<div class="pmd-theme-body">' + optionsHtml + '</div>'
      + '<div class="pmd-theme-mode-row"><span>다크 모드</span>'
      + '<button type="button" class="pmd-mode-switch" aria-label="다크 모드 전환"></button></div>'
      + '</div>';

    document.body.appendChild(overlay);
    return overlay;
  }

  function markSelected(overlay) {
    var active = currentStyle();
    overlay.querySelectorAll('.pmd-theme-option').forEach(function (btn) {
      btn.classList.toggle('selected', btn.getAttribute('data-theme') === active);
    });
    var modeSwitch = overlay.querySelector('.pmd-mode-switch');
    var dark = currentMode() === 'dark';
    modeSwitch.classList.toggle('on', dark);
    modeSwitch.setAttribute('aria-pressed', String(dark));
  }

  function init() {
    var btn = document.getElementById('themeSettingsBtn');
    if (!btn) return;

    var overlay = buildModal();

    function open() { markSelected(overlay); overlay.hidden = false; }
    function close() { overlay.hidden = true; }

    btn.addEventListener('click', open);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.pmd-theme-close').addEventListener('click', close);
    overlay.querySelectorAll('.pmd-theme-option').forEach(function (opt) {
      opt.addEventListener('click', function () {
        applyStyle(opt.getAttribute('data-theme'), true);
        markSelected(overlay);
        close();
      });
    });
    overlay.querySelector('.pmd-mode-switch').addEventListener('click', function () {
      applyMode(currentMode() === 'dark' ? 'light' : 'dark', true);
      markSelected(overlay);
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.hidden) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
