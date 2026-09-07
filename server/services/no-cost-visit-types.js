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
 * Patterns match on WORD BOUNDARIES, case-insensitively. They used to be bare
 * substrings, and 're service' matched "Lawn Ca-re Service": every "Monthly /
 * Every 6 Weeks Lawn Care Service" visit read as always-free from 2026-06-19
 * (#1926) — skipped by the completion billing gates, hidden from the leak
 * queue, and flagged by the closeout fact as an invoice on a free visit.
 * SQL consumers use ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX (`~*`) so the two
 * paths keep the same semantics.
 */
const ALWAYS_FREE_SERVICE_TYPE_PATTERNS = [
  'appointment',
  'estimate',
  're-service', 'reservice', 're service',
  'follow-up', 'followup', 'follow up', 're-visit', 'revisit',
];

const escapeRe = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALWAYS_FREE_SERVICE_TYPE_RE = new RegExp(`\\b(?:${ALWAYS_FREE_SERVICE_TYPE_PATTERNS.map(escapeRe).join('|')})\\b`, 'i');
// Postgres ARE: \m / \M are the word-start / word-end anchors. Pass as a
// bound parameter to `~*` — never interpolate.
const ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX = `\\m(?:${ALWAYS_FREE_SERVICE_TYPE_PATTERNS.map(escapeRe).join('|')})\\M`;

function isAlwaysFreeServiceType(serviceType) {
  return ALWAYS_FREE_SERVICE_TYPE_RE.test(String(serviceType || ''));
}

module.exports = { ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX, isAlwaysFreeServiceType };
