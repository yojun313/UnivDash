// Tailwind is used as prebuilt CSS, not from a CDN (security: no external scripts, so script-src can stay 'self').
// After adding Tailwind classes to templates or scripts, run tools/build_css.sh again.
module.exports = {
  content: ['./app/templates/**/*.html', './app/static/*.js'],
  // Apply hover: utilities only on devices with a mouse, so a tapped element on a phone does not keep its hover color (sticky hover).
  future: { hoverOnlyWhenSupported: true },
  theme: { extend: {} },
  plugins: [],
};
