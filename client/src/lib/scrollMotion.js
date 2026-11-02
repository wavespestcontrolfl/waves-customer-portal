// Programmatic scrolls follow the device's Reduce Motion setting. A behavior
// passed from script overrides the CSS scroll-behavior rule, so the glass
// theme's reduced-motion block cannot reach these calls (motion audit
// 2026-11-02, M04): callers ask here instead of passing 'smooth'.
// 'auto', not 'instant': older iOS Safari rejects an enum value it does not
// know, and 'auto' resolves to the page's own (reduced) scroll-behavior.
export function scrollBehavior() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'smooth';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
