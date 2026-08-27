// The ONE active-termite-bond read, shared by the portal My Plan card
// (/api/property/termite-bond) and the customer service report's warranty
// cell — both link to the same bond, so one lookup owns the feature gate,
// status filter, ordering, and date mapping (codex inline on #3516).
// termite_bonds.started_at / renews_at are ET business-calendar DATEs;
// dateOnlyString handles the pg string/UTC-midnight-Date duality and
// returns null on anything malformed. Fail-soft: gate off, no bond, or a
// query error all resolve to [] — callers render nothing, never an error.
const { gateEnvValue } = require('../config/feature-gates');
const { dateOnlyString } = require('../utils/date-only');

const TERMITE_BOND_GATE = 'GATE_PORTAL_TERMITE_BOND';

async function activeTermiteBondsForCustomer(customerId, knex = null) {
  if (!customerId || !gateEnvValue(TERMITE_BOND_GATE)) return [];
  // Lazy default: report-time callers pass their own knex (tests pass a
  // fixture stub), so the pool module is only loaded when nothing is given.
  const k = knex || require('../models/db');
  const rows = await k('termite_bonds')
    .where({ customer_id: customerId, status: 'active' })
    .orderBy('renews_at', 'desc')
    .select('service_type', 'term_years', 'started_at', 'renews_at', 'status')
    .catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      serviceType: r.service_type,
      termYears: Number(r.term_years) || 1,
      startedAt: dateOnlyString(r.started_at),
      renewsAt: dateOnlyString(r.renews_at),
      status: r.status,
    }))
    .filter((b) => b.startedAt && b.renewsAt);
}

module.exports = { activeTermiteBondsForCustomer, TERMITE_BOND_GATE };
