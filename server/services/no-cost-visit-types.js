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
 * Patterns are bare substrings (case-insensitive). The workbench wraps them as
 * `%pattern%` for SQL ILIKE.
 */
const ALWAYS_FREE_SERVICE_TYPE_PATTERNS = [
  'appointment',
  'estimate',
  're-service', 'reservice', 're service',
  'follow-up', 'followup', 'follow up', 're-visit', 'revisit',
];

function isAlwaysFreeServiceType(serviceType) {
  const s = String(serviceType || '').toLowerCase();
  return ALWAYS_FREE_SERVICE_TYPE_PATTERNS.some((p) => s.includes(p));
}

module.exports = { ALWAYS_FREE_SERVICE_TYPE_PATTERNS, isAlwaysFreeServiceType };
