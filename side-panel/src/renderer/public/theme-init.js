// Runs before first paint (classic script, CSP-safe because it is a same-origin file) so the panel never flashes
// the wrong palette. The React app keeps `data-theme` in sync afterwards (OS scheme or the user's override) and
// remembers the last effective theme here for the next launch.
(function () {
  var theme = null;
  try {
    theme = window.localStorage.getItem('claudeos.effectiveTheme');
  } catch (_) {
    theme = null;
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
