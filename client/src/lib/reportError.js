// Fire-and-forget client error telemetry. Posts to /api/client-errors, which
// forwards to Sentry server-side. Must NEVER throw into the caller — a broken
// reporter can't be allowed to break an error boundary or a handler catch.
//
// reportError(error, context)
//   context: a string label, or { context, componentStack } from a boundary.
// Replace any token-like path segment (≥16 chars of URL-safe/hex/uuid) with
// ":token" — public routes like /report/:token, /receipt/:token, /track/:token,
// and /service-outlines/:token carry long-lived bearer tokens in the path, and
// telemetry must not ship those. Route structure is preserved.
function safePath(pathname) {
  if (typeof pathname !== 'string' || !pathname) return undefined;
  return pathname
    .split('/')
    .map((seg) => (/^[A-Za-z0-9_-]{16,}$/.test(seg) ? ':token' : seg))
    .join('/');
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

    // sendBeacon survives page unload (the typical case for a crash); fall back
    // to keepalive fetch. Either way, swallow any failure.
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(
        '/api/client-errors',
        new Blob([payload], { type: 'application/json' }),
      );
    } else if (typeof fetch === 'function') {
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
