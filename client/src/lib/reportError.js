// Fire-and-forget client error telemetry. Posts to /api/client-errors, which
// forwards to Sentry server-side. Must NEVER throw into the caller — a broken
// reporter can't be allowed to break an error boundary or a handler catch.
//
// reportError(error, context)
//   context: a string label, or { context, componentStack } from a boundary.
// Public routes carry long-lived bearer tokens in the path (/report/:token,
// /estimate/:token, /pay/:token, … — and legacy estimate slugs can be as short
// as 3 chars, so a length heuristic is unsafe). Telemetry must never ship a
// token. Policy by ROUTE STRUCTURE, not length: the admin/tech surfaces have no
// path tokens, so keep them for triage; every other route keeps only its root
// segment and redacts whatever follows.
export function safePath(pathname) {
  if (typeof pathname !== 'string' || !pathname) return undefined;
  if (/^\/(admin|tech)(\/|$)/.test(pathname)) return pathname;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length <= 1) return pathname;
  return `/${segments[0]}/:token`;
}

export function reportError(error, context) {
  try {
    const meta = typeof context === 'string' ? { context } : context || {};
    const payload = JSON.stringify({
      message: error?.message || String(error || 'Unknown error'),
      stack: error?.stack,
      componentStack: meta.componentStack,
      context: meta.context,
      url: typeof window !== 'undefined' ? safePath(window.location?.pathname) : undefined,
    });

    // sendBeacon survives page unload (the typical case for a crash) but returns
    // false when it can't queue the payload — fall back to keepalive fetch then.
    // Either way, swallow any failure.
    let queued = false;
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      queued = navigator.sendBeacon(
        '/api/client-errors',
        new Blob([payload], { type: 'application/json' }),
      );
    }
    if (!queued && typeof fetch === 'function') {
      fetch('/api/client-errors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    /* telemetry must never break the app */
  }
}
