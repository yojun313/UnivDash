// Tailwind 를 CDN 대신 빌드된 CSS 로 쓴다 (보안: 외부 스크립트 없이 script-src 'self' 만 허용).
// 템플릿이나 JS 에 새 Tailwind 클래스를 쓰면 tools/build_css.sh 를 다시 실행하세요.
module.exports = {
  content: ['./app/templates/**/*.html', './app/static/*.js'],
  // hover: 유틸리티를 마우스가 있는 기기에서만 — 휴대폰에서 탭한 뒤 hover 색이 남는(sticky hover) 것을 막는다
  future: { hoverOnlyWhenSupported: true },
  theme: { extend: {} },
  plugins: [],
};
