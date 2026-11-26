/* global window, document */
// Runs before first paint (classic script, CSP-safe because it is a same-origin file) so the panel never flashes
// the wrong palette. The React app keeps `data-theme` in sync afterwards (OS scheme or the user's override) and
// remembers the last effective theme here for the next launch.
(function () {
  var stored = null;
  try {
    stored = window.localStorage.getItem('claudeos.effectiveTheme');
  } catch {
    // Storage unavailable: fall through to the media query.
  }
  var theme =
    stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.setAttribute('data-theme', theme);
})();
