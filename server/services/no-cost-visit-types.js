/**
 * Single source of truth for service types that are ALWAYS no-cost — never
 * auto-invoiced at completion and never surfaced as a billable leak, even if a
 * stale/inherited positive estimated_price is present.
 *
 *   appointment   general_appointment ("Waves Pest Control Appointment Service")
 *   estimate      estimate visits
 *   re-service    free re-services / re-treats
 *   follow-up     follow-up re-visits
 *
 * Shared by the completion auto-invoice gate (server/routes/admin-dispatch.js)
 * and the Billing Recovery workbench (server/routes/admin-billing-recovery.js)
 * so the two paths can't drift. NOTE: inspection / trap / rodent are NOT here —
 * those CAN be paid (WDO inspection, rodent trapping setup); the workbench routes
 * them to needs-review, and at completion an explicit price is authoritative.
 *
 * Terms match as WHOLE WORDS, case-insensitively. They used to be bare
 * substrings, and 're service' matched "Lawn Ca-re Service": every "Monthly /
 * Every 6 Weeks Lawn Care Service" visit read as always-free from 2026-06-19
 * (#1926) — skipped by the completion billing gates, hidden from the leak
 * queue, and flagged by the closeout fact as an invoice on a free visit.
 * SQL consumers use ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX (`~*`) so the two
 * paths keep the same semantics.
 */
// One regex source for JS and Postgres (both ARE-compatible): a term is
// free when it stands alone between non-alphanumerics, string edges
// included. "-", " " and "_" are all separators — `_` is a word character
// to \b / \m, so the key-shaped forms the header documents
// (general_appointment, pest_re_service, follow_up) would slip past word
// anchors (codex P0 on #4101). Compound terms accept any single separator
// or none: re-service / reservice / re service / re_service.
const ALWAYS_FREE_SERVICE_TYPE_TERMS = [
  'appointment',
  'estimate',
  're[-_ ]?service',
  'follow[-_ ]?up',
  're[-_ ]?visit',
];
const ALWAYS_FREE_SERVICE_TYPE_REGEX_SOURCE = `(^|[^a-z0-9])(?:${ALWAYS_FREE_SERVICE_TYPE_TERMS.join('|')})($|[^a-z0-9])`;
const ALWAYS_FREE_SERVICE_TYPE_RE = new RegExp(ALWAYS_FREE_SERVICE_TYPE_REGEX_SOURCE, 'i');
// Bind to `~*` (case-insensitive) as a parameter — never interpolate.
const ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX = ALWAYS_FREE_SERVICE_TYPE_REGEX_SOURCE;

function isAlwaysFreeServiceType(serviceType) {
  return ALWAYS_FREE_SERVICE_TYPE_RE.test(String(serviceType || ''));
}

module.exports = { ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX, isAlwaysFreeServiceType };
