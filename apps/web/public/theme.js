// The theme before first paint: the stored choice, or the system's (state.tsx keeps it live).
// A file, not inline, so the page's Content-Security-Policy can refuse every inline script.
try {
  var t = localStorage.getItem('lw-theme');
  document.documentElement.dataset.theme =
    t === 'light' || t === 'dark'
      ? t
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
} catch (e) {
  document.documentElement.dataset.theme = 'light';
}
