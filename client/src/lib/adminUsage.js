// =============================================================================
// Admin usage tracking — first-party page-view beacons.
// =============================================================================
// PostHog is deliberately never initialized on /admin (privacy gate in
// lib/analytics/posthog.js), so nothing recorded which admin surfaces
// actually get used. This module is the replacement: AdminLayoutV2 calls
// trackAdminPageView() on every admin route change, which fires a
// fire-and-forget POST /api/admin/usage/track. The Settings → Portal Usage
// tab reads the aggregate back so the owner can arrange the dashboard/nav
// around real recurring usage.
//
// Privacy contract (mirrored server-side in routes/admin-usage.js): only
// normalized route metadata leaves the browser — page key, ID-stripped path
// pattern, a sanitized tab slug, and a navigation source. Never query
// strings, search text, customer ids, or tokens.
// =============================================================================

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Segments that are record identifiers, not route structure: UUIDs, numeric
// ids, and long opaque tokens all collapse to ':id'.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const OPAQUE_RE = /^[A-Za-z0-9_-]{20,}$/;

const TAB_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PAGE_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// How long a marked navigation source stays valid before falling back to
// 'in-app'. Route transitions land well inside this.
const SOURCE_TTL_MS = 3000;
// Identical consecutive views inside this window are dropped (StrictMode
// double-mounts, query-param churn on the same tab).
const DEDUPE_MS = 30000;
// Beacons are held briefly so an instant client-side redirect (e.g.
// /admin/schedule → /admin/dispatch?tab=schedule, /admin → /admin/dashboard)
// collapses into ONE row for the page the user actually lands on — and that
// row keeps the ORIGINAL navigation source instead of degrading to 'in-app'.
// Without this, every legacy redirect route logs a phantom page and steals
// the attribution of a core destination.
const REDIRECT_SETTLE_MS = 800;

let pendingSource = null; // { source, ts }
let lastLogged = null; // { key, ts }
let hasLoggedThisSession = false;
let pendingBeacon = null; // { key, body }
let pendingTimer = null;

/** Call from a navigation control's click handler just before the SPA
 *  navigates, so the resulting page view is attributed to that control. */
export function markUsageSource(source) {
  pendingSource = { source, ts: Date.now() };
}

/** '/admin/customers/8f3…e2/notes' → { pageKey: 'customers',
 *  path: '/admin/customers/:id/notes' }. Returns null off /admin. */
export function normalizeAdminPath(pathname) {
  if (typeof pathname !== 'string' || !/^\/admin(\/|$)/.test(pathname)) return null;
  const segments = pathname.split('/').filter(Boolean).slice(1); // drop 'admin'
  const normalized = segments.map((seg) => (
    UUID_RE.test(seg) || NUMERIC_RE.test(seg) || OPAQUE_RE.test(seg) ? ':id' : seg
  ));
  const first = normalized[0] || 'dashboard';
  const pageKey = first.toLowerCase();
  if (!PAGE_KEY_RE.test(pageKey)) return null;
  const path = `/admin${normalized.length ? `/${normalized.join('/')}` : ''}`.slice(0, 160);
  return { pageKey, path };
}

/** Extract the active tab slug from a query string. Reads `tab` (most pages)
 *  and falls back to `area` (pricing-logic / knowledge hubs). Anything that
 *  doesn't look like a short slug is dropped — a uuid or search text never
 *  qualifies. */
export function safeTab(search) {
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch {
    return null;
  }
  const raw = params.get('tab') || params.get('area');
  if (!raw) return null;
  const tab = raw.toLowerCase();
  return TAB_RE.test(tab) ? tab : null;
}

function flushPendingBeacon() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (!pendingBeacon) return;
  const { key, body } = pendingBeacon;
  pendingBeacon = null;

  let token;
  try {
    token = localStorage.getItem('waves_admin_token');
  } catch {
    return;
  }
  if (!token) return;

  lastLogged = { key, ts: Date.now() };

  // Deliberately NOT adminFetch: the shared helper hard-redirects to
  // /admin/login on 401, and a background beacon must never navigate.
  fetch(`${API_BASE}/admin/usage/track`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// Tab close / app switch before the settle timer fires: flush immediately so
// the last page view isn't lost (keepalive lets the request outlive the page).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingBeacon);
}

/** Record one admin page view. Safe to call on every route change — dedupes
 *  identical consecutive views, collapses instant redirect chains, no-ops
 *  without an auth token, and never throws or redirects (a failed beacon
 *  must not disturb the page). */
export function trackAdminPageView({ pathname, search } = {}) {
  const norm = normalizeAdminPath(pathname);
  if (!norm) return;

  const tab = safeTab(search);
  const key = `${norm.pageKey}|${norm.path}|${tab || ''}`;
  const now = Date.now();
  if (lastLogged && lastLogged.key === key && now - lastLogged.ts < DEDUPE_MS) {
    // The navigation chain landed on an already-counted view — drop any
    // intermediate hop still settling, or it flushes as a phantom row.
    // (Re-tapping the active Schedule item queues /admin/schedule, the
    // redirect returns here via dedupe, and the legacy hop would otherwise
    // survive the collapse. Codex #2961 P2.)
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingBeacon = null;
    pendingSource = null;
    return;
  }

  let source;
  if (pendingSource && now - pendingSource.ts < SOURCE_TTL_MS) {
    source = pendingSource.source;
  } else if (pendingBeacon && pendingBeacon.body.source !== 'in-app') {
    // Superseding a still-pending view = we're the redirect target of the
    // navigation that queued it — inherit its source (and its session-open
    // 'load' marker).
    source = pendingBeacon.body.source;
  } else {
    // First view of the session = the page the app was opened on (bookmark,
    // PWA icon, refresh). Everything after that without a marked control is
    // an in-page link or programmatic navigation.
    source = hasLoggedThisSession ? 'in-app' : 'load';
  }
  pendingSource = null;
  hasLoggedThisSession = true;

  if (pendingTimer) clearTimeout(pendingTimer);
  pendingBeacon = {
    key,
    body: {
      pageKey: norm.pageKey,
      path: norm.path,
      tab: tab || undefined,
      source,
    },
  };
  pendingTimer = setTimeout(flushPendingBeacon, REDIRECT_SETTLE_MS);
}

/** Test-only: reset module state between cases. */
export function __resetAdminUsageForTests() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingSource = null;
  lastLogged = null;
  hasLoggedThisSession = false;
  pendingBeacon = null;
  pendingTimer = null;
}
