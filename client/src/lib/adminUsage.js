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
// ids, and long opaque tokens all collapse to ':id'. Opaque = ≥20 chars with
// at least one uppercase/digit/underscore — hyphenated lowercase route words
// ('pricing-reality-check') are route structure, not tokens. Mirrored
// server-side in routes/admin-usage.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const OPAQUE_RE = /^(?=[A-Za-z0-9_-]*[A-Z0-9_])[A-Za-z0-9_-]{20,}$/;

// Tabs are route-structure words: letter-first, lowercase, hyphenated.
// Digits-only ('5551234567') and underscore values ('john_smith') are not
// tabs anywhere in this app — reject them so a crafted ?tab= link can't
// smuggle an identifier. Mirrored server-side.
const TAB_RE = /^(?=.{1,32}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
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
// Pages that emit their own AUTHORITATIVE leaf beacon after mount
// (currently only Settings). Their raw route beacon settles longer: the
// page chunk is lazy-loaded, and on a cold load the authoritative beacon
// can arrive well after 800ms — flushing the raw one first would record a
// duplicate untabbed row (or an invalid deep-link tab) that the page's
// beacon was supposed to supersede (Codex #2961 r12). Any page that
// adopts authoritative beacons must be listed here.
const SELF_REPORTING_PAGES = new Set(['settings']);
const SELF_REPORT_SETTLE_MS = 5000;

let pendingSource = null; // { source, ts }
let lastLogged = null; // { key, ts }
let hasLoggedThisSession = false;
let pendingBeacon = null; // { key, body }
let pendingTimer = null;
// Identity fingerprint: on a shared browser, a login switch must reset the
// dedupe/session state (or B's first view is dropped by A's 30s window) and
// drop A's still-settling beacon (or it flushes under B's token).
let lastAuthToken = null;

/** Call from a navigation control's click handler just before the SPA
 *  navigates, so the resulting page view is attributed to that control. */
export function markUsageSource(source) {
  pendingSource = { source, ts: Date.now() };
}

/** '/admin/customers/8f3…e2/notes' → { pageKey: 'customers',
 *  path: '/admin/customers/:id/notes' }. Returns null off /admin. */
// Route STRUCTURE is lowercase slug words; anything else is an identifier
// regardless of length ('John_Smith'). The segment after an entity list
// route is an identifier unless it's a known static subpage ('acme' after
// /customers). Mirrored server-side in routes/admin-usage.js — the server
// is the authoritative privacy backstop.
const ROUTE_WORD_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENTITY_ROUTES = new Set(['customers', 'estimates', 'invoices', 'leads', 'calls', 'technicians', 'requests']);
const ENTITY_STATIC_SUBPAGES = new Set(['new', 'import', 'map', 'directory', 'kanban', 'search', 'settings', 'duplicates']);

// The one real underscore-prefixed route family: /admin/_design-system(/flags)
// hosts the design reference and the "Early feature access" flags page linked
// from mobile Settings. Canonicalize it to a trackable slug instead of letting
// the underscore read as an identifier (which dropped its usage entirely).
const UNDERSCORE_ROUTE_ALIASES = { '_design-system': 'design-system' };

export function normalizeAdminPath(pathname) {
  if (typeof pathname !== 'string' || !/^\/admin(\/|$)/.test(pathname)) return null;
  const segments = pathname.split('/').filter(Boolean).slice(1); // drop 'admin'
  const normalized = segments.map((seg, i, arr) => {
    if (UNDERSCORE_ROUTE_ALIASES[seg]) return UNDERSCORE_ROUTE_ALIASES[seg];
    if (UUID_RE.test(seg) || NUMERIC_RE.test(seg) || OPAQUE_RE.test(seg)) return ':id';
    // Malformed segments stay as-is (the length/shape guards downstream
    // drop the beacon) — mirroring the server backstop.
    if (!/^[A-Za-z0-9_-]+$/.test(seg)) return seg;
    if (!ROUTE_WORD_RE.test(seg)) return ':id';
    const prev = i > 0 ? arr[i - 1] : null;
    if (prev && ENTITY_ROUTES.has(prev) && !ENTITY_STATIC_SUBPAGES.has(seg)) return ':id';
    return seg;
  });
  const first = normalized[0] || 'dashboard';
  const pageKey = first.toLowerCase();
  if (!PAGE_KEY_RE.test(pageKey)) return null;
  const path = `/admin${normalized.length ? `/${normalized.join('/')}` : ''}`.slice(0, 160);
  return { pageKey, path };
}

/** Extract the active subview slug from a query string. Admin pages use a
 *  small set of keys for their rendered subview — `tab` (most pages),
 *  `area` (pricing-logic / knowledge hubs), `view` (customers), `section`
 *  (pricing) — checked in that precedence order. Anything that doesn't
 *  look like a short slug is dropped — a uuid or search text never
 *  qualifies. */
const TAB_QUERY_KEYS = ['tab', 'area', 'view', 'section'];
// Nested tab keys follow the camelCase *Tab convention (protocolTab /
// kbTab / wikiTab) and name the DEEPEST rendered leaf — they outrank the
// constant parent ?tab=, or switching protocolTab would dedupe into the
// unchanging 'protocols' and vanish (Codex #2961 r11). Pattern-matched,
// not enumerated, so future nested tabs are picked up without a registry.
const NESTED_TAB_KEY_RE = /^[a-z][a-zA-Z]*Tab$/;

export function safeTab(search) {
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch {
    return null;
  }
  for (const [key, raw] of params) {
    if (!NESTED_TAB_KEY_RE.test(key) || !raw) continue;
    const tab = raw.toLowerCase();
    return TAB_RE.test(tab) ? tab : null;
  }
  for (const key of TAB_QUERY_KEYS) {
    const raw = params.get(key);
    if (!raw) continue;
    const tab = raw.toLowerCase();
    return TAB_RE.test(tab) ? tab : null;
  }
  return null;
}

function flushPendingBeacon() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (!pendingBeacon) return;
  const { key, body, token: queuedToken } = pendingBeacon;
  pendingBeacon = null;

  let token;
  try {
    token = localStorage.getItem('waves_admin_token');
  } catch {
    return;
  }
  // The beacon is bound to the identity that queued it. A login switch in
  // ANOTHER tab can change the token between queue and flush with no
  // track() call in between — never send one identity's view under
  // another's token; drop it instead.
  if (!token || token !== queuedToken) return;

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
 *  must not disturb the page).
 *
 *  `authoritative: true` marks a beacon emitted by the PAGE about what it
 *  actually rendered (e.g. SettingsPage's validated leaf). Within the
 *  settle window it wins over the layout's raw-URL beacon for the same
 *  page — so an invalid deep link (?tab=typo) records the rendered
 *  fallback, never a tab the user did not see. */
export function trackAdminPageView({ pathname, search, authoritative = false } = {}) {
  const norm = normalizeAdminPath(pathname);
  if (!norm) return;

  let token;
  try {
    token = localStorage.getItem('waves_admin_token');
  } catch {
    return;
  }
  if (!token) return;
  if (token !== lastAuthToken) {
    // Signed-in identity changed (login, logout+login, user switch on a
    // shared browser): the previous identity's pending beacon must not
    // flush under this token, and this identity starts a fresh session
    // (own dedupe window, first view = 'load'). pendingSource is left
    // alone — the 3s TTL already kills stale marks, and the mark preceding
    // this identity's FIRST track is its own click. Codex #2961 r4.
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingBeacon = null;
    lastLogged = null;
    hasLoggedThisSession = false;
    lastAuthToken = token;
  }

  const tab = safeTab(search);
  const key = `${norm.pageKey}|${norm.path}|${tab || ''}`;
  const now = Date.now();

  // A page-emitted (authoritative) beacon describes what actually RENDERED;
  // the layout's raw-URL beacon for the same page never overrides it inside
  // the settle window (?tab=typo must not beat the rendered fallback).
  if (
    pendingBeacon
    && pendingBeacon.authoritative
    && !authoritative
    && pendingBeacon.body.pageKey === norm.pageKey
    && pendingBeacon.body.path === norm.path
  ) {
    return;
  }

  // Likewise a tab-less view never downgrades a still-settling tabbed view
  // of the SAME page: on a query-less Settings open, the page's mount
  // effect records the rendered leaf BEFORE the layout's route beacon
  // fires (child effects run first), and the coarse layout beacon must
  // refine into that row, not replace it. Codex #2961 r4.
  if (
    pendingBeacon
    && !tab
    && pendingBeacon.body.tab
    && pendingBeacon.body.pageKey === norm.pageKey
    && pendingBeacon.body.path === norm.path
  ) {
    return;
  }

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

  // A pending beacon that has outlived the redirect window is a REAL dwell
  // (only possible under the longer self-reporting settle) — a navigation
  // to a DIFFERENT page must flush it, not swallow it. Same-page arrivals
  // (the authoritative refinement) still replace it at any age.
  if (pendingBeacon) {
    const samePage = pendingBeacon.body.pageKey === norm.pageKey
      && pendingBeacon.body.path === norm.path;
    if (!samePage && now - pendingBeacon.queuedAt > REDIRECT_SETTLE_MS) {
      flushPendingBeacon();
    }
  }

  if (pendingTimer) clearTimeout(pendingTimer);
  pendingBeacon = {
    key,
    authoritative,
    queuedAt: now,
    token, // flush drops the beacon if the signed-in token changed meanwhile
    body: {
      pageKey: norm.pageKey,
      path: norm.path,
      tab: tab || undefined,
      source,
    },
  };
  pendingTimer = setTimeout(
    flushPendingBeacon,
    !authoritative && SELF_REPORTING_PAGES.has(norm.pageKey)
      ? SELF_REPORT_SETTLE_MS
      : REDIRECT_SETTLE_MS,
  );
}

/** Test-only: reset module state between cases. */
export function __resetAdminUsageForTests() {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingSource = null;
  lastLogged = null;
  hasLoggedThisSession = false;
  pendingBeacon = null;
  pendingTimer = null;
  lastAuthToken = null;
}
