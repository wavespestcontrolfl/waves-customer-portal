// WebKit before 15.4 (inside Capacitor's iOS 14 deployment floor) has no dvh
// unit. An inline style declaration that uses it is DISCARDED rather than
// fallen back from, so a max-height written as `90dvh` silently becomes no
// cap at all and a tall panel can push its controls out of the viewport.
// Detect once at module load; vh is the degraded but safe unit on old engines.
export function detectDynamicViewportUnit(cssApi = typeof CSS !== 'undefined' ? CSS : undefined) {
  try {
    if (cssApi && typeof cssApi.supports === 'function' && cssApi.supports('height', '100dvh')) return 'dvh';
  } catch {
    // Treat a throwing supports() like an absent one.
  }
  return 'vh';
}

export const DVH = detectDynamicViewportUnit();
