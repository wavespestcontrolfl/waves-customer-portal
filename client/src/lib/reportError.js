// Fire-and-forget client error telemetry. Posts to /api/client-errors, which
// forwards to Sentry server-side. Must NEVER throw into the caller — a broken
// reporter can't be allowed to break an error boundary or a handler catch.
//
// The endpoint is public, so the SERVER strictly transforms every field into a
// non-sensitive shape (validated error name, allowlisted route root, validated
// context label, component-name-only stack). We therefore send ONLY those
// structured fields — never the free-form error message or stack, which can
// carry bearer tokens, card/SSN data, or PII.
//
// reportError(error, context)
//   context: a string label, or { context, componentStack } from a boundary.
export function reportError(error, context) {
  try {
    const meta = typeof context === 'string' ? { context } : context || {};
    const payload = JSON.stringify({
      name: error?.name,
      context: meta.context,
      route: typeof window !== 'undefined' ? window.location?.pathname : undefined,
      componentStack: meta.componentStack,
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
