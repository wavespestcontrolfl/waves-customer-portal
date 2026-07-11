// Safari 18+ reuses an idle keep-alive socket the server has already closed
// and — unlike other browsers — does not resend a POST on a fresh connection;
// the customer sees a bare "Load failed" TypeError (hit live on a real
// abandoned payment, 2026-07). Retry only when fetch() itself rejects, i.e. no HTTP
// response was ever received, so the server can't have half-processed
// anything ambiguous. Reserved for idempotent calls (/update-amount, /quote)
// — never money-moving ones (/finalize, /setup-complete), where a lost
// response could hide a completed charge.
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
      lastErr = err;
    }
  }
  throw lastErr;
}
