// Safari 18+ reuses an idle keep-alive socket the server has already closed
// and — unlike other browsers — does not resend a POST on a fresh connection;
// the customer sees a bare "Load failed" TypeError (hit live on a real
// abandoned payment, 2026-07). iOS 18 Safari additionally fails a fetch
// started right as the document becomes visible (returning from an SMS link)
// the same way — 4 more live "Load failed" abandonments hit /setup between
// 2026-07-28 and 2026-08-25. Retry only when fetch() itself rejects, i.e. no
// HTTP response was ever received, so the server can't have half-processed
// anything ambiguous. Reserved for calls that are idempotent server-side
// (/update-amount, /quote, /setup, the invoice GET) — never money-moving ones
// (/finalize, /setup-complete), where a lost response could hide a completed
// charge. An AbortError is the CALLER cancelling (unmount/token change), not
// a network failure — rethrow it immediately, or a retry would refetch after
// unmount and setState against a dead page.
export const NETWORK_RETRY_DELAYS_MS = [400, 1200];

export async function fetchWithNetworkRetry(url, options) {
  let lastErr;
  for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      return await fetch(url, options);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
