/**
 * Ops-crons check → destination map (admin-alerts-brevity scope, owner
 * ruling 2026-09-28). server/routes/ops-digest-ingest.js uses this for
 * checks the Mac ops-crons haven't yet been converted to send their own
 * `headline`/`summary`/`link` — the map supplies a fallback title's area,
 * where tapping the bell should land, and who the finding is for.
 *
 * Keyed on the CHECK id: the part of the ingest payload's `key` before its
 * first ':' (checkId()). The data-hygiene sweep's key looks like
 * `local:data-hygiene_sweep_N_fixed_N_exceptions_N_new_`, so an entry's `id`
 * may be a RegExp tested against both the check id and the full key.
 *
 * `link: null` means "no better page than the Activity feed" — routeFor()
 * resolves it to ACTIVITY_LINK.
 *
 * An entry may also carry `headline(subject) => string|null`: a
 * check-specific fallback title, tried before the generic
 * `${area} — ${subject}` when the caller (ops-crons) sent no headline of
 * its own. Return null to fall through to the generic form.
 */

const ACTIVITY_LINK = '/admin/agents?tab=activity';

// data-hygiene sweep subject shape (local/agents/data-hygiene runner):
// "data-hygiene sweep — N fixed, M exceptions (K new)".
const DATA_HYGIENE_SUBJECT_RE = /—\s*\d+\s+fixed,\s*(\d+)\s+exceptions?\s*\((\d+)\s+new\)/i;

// "Data hygiene — 2 new issues, 66 open" / "Data hygiene — 63 open issues,
// none new" — parsed straight from the sweep's own subject, never the body
// (which lists customer names). Null when the subject doesn't match this
// shape, so the generic `${area} — ${subject}` fallback applies instead.
function dataHygieneHeadline(subject) {
  const m = DATA_HYGIENE_SUBJECT_RE.exec(String(subject || ''));
  if (!m) return null;
  const open = Number(m[1]);
  const fresh = Number(m[2]);
  if (!Number.isFinite(open) || !Number.isFinite(fresh)) return null;
  if (fresh > 0) return `Data hygiene — ${fresh} new issue${fresh === 1 ? '' : 's'}, ${open} open`;
  return `Data hygiene — ${open} open issue${open === 1 ? '' : 's'}, none new`;
}

// admin-alerts-ring scope (2026-09-28): the sweep's own subject already
// carries both numbers the ring decision needs — the open backlog size
// (`count`) and how many of those are new (`newCount`) — so a "0 new" day
// goes quiet instead of the generic first-integer-in-the-subject fallback
// (which would read the FIXED count, not the open backlog). Null when the
// subject doesn't match, same as dataHygieneHeadline above.
function dataHygieneCounts(subject) {
  const m = DATA_HYGIENE_SUBJECT_RE.exec(String(subject || ''));
  if (!m) return null;
  const open = Number(m[1]);
  const fresh = Number(m[2]);
  if (!Number.isFinite(open) || !Number.isFinite(fresh)) return null;
  return { count: open, newCount: fresh };
}

// Owner audience: the fix happens somewhere specific, and that's where the
// bell should land.
const OWNER_ROUTES = [
  { id: 'd15-voicemail-callbacks', area: 'Calls', link: '/admin/communications' },
  { id: 'd19-committed-bookings', area: 'Schedule', link: '/admin/dispatch' },
  { id: 'e22-schedule-integrity', area: 'Schedule', link: '/admin/dispatch' },
  // No dedicated admin Properties page exists yet — Activity feed stays the
  // destination until one does (owner ask 2026-09-28).
  { id: 'e36-property-links', area: 'Properties', link: null },
  { id: 'b08-uncharged-collectibles', area: 'Billing', link: '/admin/invoices' },
  { id: 'c10-membership-truth', area: 'Members', link: '/admin/customers' },
  { id: 'd16-drafts-pipeline-aging', area: 'Drafts', link: '/admin/communications' },
  // Regex: the data-hygiene sweep's key carries its own generated suffix —
  // counters embedded MID-key ("..._sweep_1_fixed_63_exceptions_0_new_"),
  // not just at the end, so ops-digest.js's trailing-token trim can never
  // produce a stable alertClass for it on its own. `alertClass` is this
  // route's own stable id, used instead whenever a route defines `counts`
  // (admin-alerts-ring scope, alertClassFor).
  { id: /^local:data-hygiene/i, area: 'Data hygiene', link: null, headline: dataHygieneHeadline, counts: dataHygieneCounts, alertClass: 'data-hygiene' },
];

// Engineering audience: broken plumbing, Activity feed only — never the bell.
const ENGINEERING_ROUTES = [
  { id: 'c01-job-health', area: 'Jobs' },
  { id: 'c19-prefs-reconciler', area: 'Preferences' },
  { id: 'c32-gate-drift', area: 'Gates' },
  { id: 'c35-error-signatures', area: 'Errors' },
  { id: 'd14-sms-delivery', area: 'SMS delivery' },
  { id: 'd17-duplicate-sends', area: 'Sends' },
  { id: 'd18-suppression-sync', area: 'Suppression sync' },
];

const ROUTES = [
  ...OWNER_ROUTES.map((r) => ({ ...r, audience: 'owner' })),
  ...ENGINEERING_ROUTES.map((r) => ({ ...r, audience: 'engineering', link: r.link || null })),
];

// The part of `key` before its first ':'. A key with no ':' is its own id.
function checkId(key) {
  const s = String(key || '');
  const i = s.indexOf(':');
  return i === -1 ? s : s.slice(0, i);
}

function matches(entry, id, fullKey) {
  if (entry.id instanceof RegExp) return entry.id.test(id) || entry.id.test(fullKey);
  return entry.id === id;
}

function resolveRoute(key) {
  const id = checkId(key);
  const fullKey = String(key || '');
  return ROUTES.find((entry) => matches(entry, id, fullKey)) || null;
}

// "e40-my-new-check" -> "My new check": drop a leading letter+digits code,
// split on -/_ and title-case the first word only (a plain area label, not
// a heading). No match anywhere -> a generic "Ops" area rather than nothing.
function humanizeCheckId(id) {
  const words = String(id || '').replace(/^[a-z]\d+-/i, '').split(/[-_]+/).filter(Boolean);
  if (!words.length) return 'Ops';
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

// { area, link, audience, headline, counts } for a check id/kind. A matched
// route wins outright; an unknown check falls back to a humanized area, the
// Activity feed, and an audience derived from `kind` (ACT -> owner, FIX ->
// engineering — the only two kinds the ingest route accepts). `headline` is
// the matched entry's own headline(subject) function, or null; `counts` is
// its own counts(subject) => {count, newCount}|null function, or null (the
// admin-alerts-ring scope's fallback when the caller sent neither number).
function routeFor(key, kind) {
  const matched = resolveRoute(key);
  if (matched) {
    return {
      area: matched.area,
      link: matched.link || ACTIVITY_LINK,
      audience: matched.audience,
      headline: typeof matched.headline === 'function' ? matched.headline : null,
      counts: typeof matched.counts === 'function' ? matched.counts : null,
    };
  }
  return {
    area: humanizeCheckId(checkId(key)),
    link: ACTIVITY_LINK,
    audience: kind === 'FIX' ? 'engineering' : 'owner',
    headline: null,
    counts: null,
  };
}

module.exports = { ACTIVITY_LINK, ROUTES, checkId, humanizeCheckId, resolveRoute, routeFor, dataHygieneHeadline, dataHygieneCounts };
