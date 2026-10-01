// Apply saved theme/language before first paint (no flash). A file, not inline, so the
// Content-Security-Policy can forbid inline scripts.
try {
  var saved = JSON.parse(localStorage.getItem('lounge-prefs') || '{}');
  var p = saved.state || {};
  // Themes saved before version 1 were the old dark default: the shop is red & white now
  // (the app migrates the saved value the same way in i18n/index.ts).
  if (p.theme && (saved.version || 0) >= 1) document.documentElement.dataset.theme = p.theme;
  if (p.lang === 'en') {
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
  }
} catch (e) {
  /* storage unavailable: defaults apply */
}
