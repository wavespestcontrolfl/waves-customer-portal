// Admin-side fetch helper with structured 401 / 429 handling.
//
// Each admin page used to inline its own `adminFetch`. Two failure modes
// were getting misreported: a 429 from the global rate limiter rendered as
// "Failed to load dashboard. Try logging in again" (which sent operators
// in circles re-authenticating) or as a raw "HTTP 429" with no recovery
// path. This helper:
//
//   1. Redirects to /admin/login on 401 (the only auth-failure case).
//   2. On 429, honours the Retry-After header and auto-retries once with
//      a small jitter, so a transient burst recovers without UI churn.
//   3. After the retry budget is spent, throws an Error tagged with
//      `.status = 429` and `.code = 'RATE_LIMITED'` so callers can render
//      a friendly "you're going too fast — try again in a few seconds"
//      message instead of "log in again".
//
// Pages that have already been migrated: DashboardPageV2, CustomersPageV2,
// DispatchPageV2. The dozens of other inline copies still work — they just
// don't get the 429 grace path. Migrate as touched.

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const MAX_RETRIES = 1;
const DEFAULT_RETRY_MS = 2000;
const MAX_RETRY_MS = 8000;

function authHeader() {
  const token = localStorage.getItem('waves_admin_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function parseRetryAfter(header) {
  if (!header) return DEFAULT_RETRY_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_MS, Math.max(500, seconds * 1000));
  }
  // RFC 7231 also allows an HTTP-date — fall back to the default if so.
  return DEFAULT_RETRY_MS;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function adminFetch(path, options = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(),
        ...(options.headers || {}),
      },
    });

    if (r.status === 401) {
      window.location.href = '/admin/login';
      const err = new Error('Session expired');
      err.status = 401;
      err.code = 'UNAUTHENTICATED';
      throw err;
    }

    if (r.status === 429) {
      if (attempt < MAX_RETRIES) {
        const wait = parseRetryAfter(r.headers.get('Retry-After'));
        // 0–250ms jitter so 11 dashboard fetches don't synchronously
        // re-fire on the exact same tick after the wait.
        await delay(wait + Math.floor(Math.random() * 250));
        attempt += 1;
        continue;
      }
      const err = new Error('Rate limited — please slow down for a moment.');
      err.status = 429;
      err.code = 'RATE_LIMITED';
      throw err;
    }

    if (!r.ok) {
      // Try to surface the server's error string when present, otherwise
      // fall back to status text. Don't blow up if the body isn't JSON.
      let serverMsg = '';
      try {
        const body = await r.clone().json();
        serverMsg = body?.error || '';
      } catch {
        try { serverMsg = await r.text(); } catch { /* ignore */ }
      }
      const err = new Error(serverMsg || `${r.status} ${r.statusText}`);
      err.status = r.status;
      throw err;
    }

    if (r.status === 204) return null;
    return r.json();
  }
}

export function isRateLimitError(err) {
  return err && (err.status === 429 || err.code === 'RATE_LIMITED');
}
