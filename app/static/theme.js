// ============================================================================
// UnivDash shared theme system (based on the LecAI theme system)
// - Attaches the theme settings modal to pages that have a [data-theme-settings] button.
// - Theme style: <html data-ui-theme="mesh|apple|mono"> (the default 'Aurora' has no attribute)
// - Dark/light: <html data-ui-theme-mode="light"> (dark is the default)
// - The actual colors live in /static/theme.css.
// - Applying before first paint is handled first by the inline snippet in _theme.html.
// ============================================================================
(function () {
  'use strict';

  var STYLE_KEY = 'univdash-theme-style';
  var MODE_KEY = 'univdash-theme';
  var THEMES = [
    { id: 'default', label: t('오로라') },
    { id: 'mesh', label: t('그라디언트 메시') },
    { id: 'apple', label: t('애플 글래스') },
    { id: 'mono', label: t('미니멀 플랫') },
  ];

  var html = document.documentElement;

  function get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function set(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* noop */ } }

  function currentStyle() {
    var saved = get(STYLE_KEY);
    return THEMES.some(function (theme) { return theme.id === saved; }) ? saved : 'default';
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

  // Lite mode: reduces blur, continuously running animations and off-screen rendering to lighten the load on the device (GPU, CPU, RAM). Off by default.
  var LITE_KEY = 'univdash-lite';
  function currentLite() { return get(LITE_KEY) === '1'; }
  function applyLite(on, persist) {
    if (on) html.setAttribute('data-ui-lite', '');
    else html.removeAttribute('data-ui-lite');
    if (persist) set(LITE_KEY, on ? '1' : '0');
    try { window.dispatchEvent(new CustomEvent('univdash:litechange', { detail: { lite: on } })); } catch (e) { /* noop */ }
  }

  applyStyle(currentStyle(), false);
  applyMode(currentMode(), false);
  applyLite(currentLite(), false);

  // Toggling it in another tab applies to this tab right away
  window.addEventListener('storage', function (e) {
    if (e.key === LITE_KEY) applyLite(e.newValue === '1', false);
  });

  window.UnivDashTheme = {
    current: function () { return html.getAttribute('data-ui-theme-mode') === 'light' ? 'light' : 'dark'; },
    toggle: function () { applyMode(currentMode() === 'dark' ? 'light' : 'dark', true); },
    lite: function () { return html.hasAttribute('data-ui-lite'); },
    setLite: function (on) { applyLite(!!on, true); },
  };
  if (window.UnivDashKeys) window.UnivDashKeys.register('app.toggleMode', function () { window.UnivDashTheme.toggle(); });

  function buildModal() {
    var overlay = document.createElement('div');
    overlay.className = 'pmd-theme-overlay';
    overlay.hidden = true;

    var optionsHtml = THEMES.map(function (theme) {
      return (
        '<button type="button" class="pmd-theme-option" data-theme="' + theme.id + '">'
        + '<span class="pmd-theme-swatch pmd-swatch-' + theme.id + '"></span>'
        + '<span><span class="pmd-theme-check">✓</span>' + theme.label + '</span>'
        + '</button>'
      );
    }).join('');

    overlay.innerHTML =
      '<div class="pmd-theme-modal" role="dialog" aria-modal="true" aria-label="' + t('테마 설정') + '">'
      + '<div class="pmd-theme-head">'
      + '<div><h3>' + t('테마 설정') + '</h3><p>' + t('원하는 테마를 선택하십시오. 모든 페이지에 동일하게 적용됩니다.') + '</p></div>'
      + '<button type="button" class="pmd-theme-close" aria-label="' + t('닫기') + '">&times;</button>'
      + '</div>'
      + '<div class="pmd-theme-body">' + optionsHtml + '</div>'
      + '<div class="pmd-theme-mode-row"><span>' + t('다크 모드') + '</span>'
      + '<button type="button" class="pmd-mode-switch" aria-label="' + t('다크 모드 전환') + '"></button></div>'
      + '<div class="pmd-theme-mode-row pmd-lite-row"><span>' + t('가벼운 모드') + '<small>' + t('블러 · 반짝임 효과를 줄여 GPU · CPU · 메모리를 아낍니다') + '</small></span>'
      + '<button type="button" class="pmd-mode-switch pmd-lite-switch" aria-label="' + t('가벼운 모드 전환') + '"></button></div>'
      + '</div>';

    document.body.appendChild(overlay);
    return overlay;
  }

  function markSelected(overlay) {
    var active = currentStyle();
    overlay.querySelectorAll('.pmd-theme-option').forEach(function (btn) {
      btn.classList.toggle('selected', btn.getAttribute('data-theme') === active);
    });
    var modeSwitch = overlay.querySelector('.pmd-mode-switch:not(.pmd-lite-switch)');
    var dark = currentMode() === 'dark';
    modeSwitch.classList.toggle('on', dark);
    modeSwitch.setAttribute('aria-pressed', String(dark));
    var liteSwitch = overlay.querySelector('.pmd-lite-switch');
    var lite = currentLite();
    liteSwitch.classList.toggle('on', lite);
    liteSwitch.setAttribute('aria-pressed', String(lite));
  }

  function init() {
    var btns = document.querySelectorAll('[data-theme-settings]');
    if (!btns.length) return;

    var overlay = buildModal();

    function open() { markSelected(overlay); overlay.hidden = false; }
    function close() { overlay.hidden = true; }

    btns.forEach(function (b) { b.addEventListener('click', open); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('.pmd-theme-close').addEventListener('click', close);
    overlay.querySelectorAll('.pmd-theme-option').forEach(function (opt) {
      opt.addEventListener('click', function () {
        applyStyle(opt.getAttribute('data-theme'), true);
        markSelected(overlay);
        close();
      });
    });
    overlay.querySelector('.pmd-mode-switch:not(.pmd-lite-switch)').addEventListener('click', function () {
      applyMode(currentMode() === 'dark' ? 'light' : 'dark', true);
      markSelected(overlay);
    });
    overlay.querySelector('.pmd-lite-switch').addEventListener('click', function () {
      applyLite(!currentLite(), true);
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
