// server/services/rodent-trap-check.js
//
// Rodent trapping visit allowance (owner ruling 2026-09-26): the $350
// Standard trapping plan covers TWO visits for the same active trapping
// job — the setup visit plus one trap check. Visit 3 and later are billed
// as the separate "Rodent Trap Check - Additional" catalog row at $95.
//
// Counting is an office call, not an automatic re-price (ruling: separate
// $95 service, booked by the office). This module only ADVISES: the
// create-appointment modal asks how many trapping visits the customer's
// current job already has and nudges toward the $95 row once the two
// included visits are used.
//
// Grandfathering (ruling 2026-09-26): jobs sold before the change keep
// unlimited included checks. A job is grandfathered when its opener's
// source estimate was accepted before TRAP_CHECK_FEE_EFFECTIVE_DATE, or —
// with no estimate link — when the opener was scheduled before that date.

const TRAP_CHECK_ADDITIONAL_KEY = 'rodent_trap_check_additional';
const TRAP_CHECK_ADDITIONAL_PRICE = 95;
const INCLUDED_TRAPPING_VISITS = 2;
// ET calendar date the 2-visit rule starts applying to newly sold jobs.
const TRAP_CHECK_FEE_EFFECTIVE_DATE = '2026-09-27';

// Rows that OPEN a trapping job (the sold program).
const TRAPPING_OPENER_KEYS = [
  'rodent_trapping',
  'rodent_trapping_exclusion',
  'rodent_trapping_sanitation',
  'rodent_trapping_exclusion_sanitation',
];
// Every row that counts as a visit of the job.
const TRAPPING_VISIT_KEYS = [
  ...TRAPPING_OPENER_KEYS,
  'rodent_trapping_followup',
  TRAP_CHECK_ADDITIONAL_KEY,
];
// Program checks stretch across weeks; an opener older than this starts a
// fresh job rather than extending the old one.
const JOB_LOOKBACK_DAYS = 60;
const INACTIVE_STATUSES = ['cancelled', 'rescheduled', 'skipped'];

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isGrandfathered({ acceptedAt, openerDate }) {
  const basis = dateOnly(acceptedAt) || dateOnly(openerDate);
  if (!basis) return false;
  return basis < TRAP_CHECK_FEE_EFFECTIVE_DATE;
}

/**
 * Current trapping job for a customer: the most recent opener inside the
 * lookback window, and every active (not cancelled/rescheduled/skipped)
 * trapping visit on or after it. Read-only.
 */
async function trappingJobStatus(db, customerId, { today } = {}) {
  const anchor = today || dateOnly(new Date());
  const floor = new Date(`${anchor}T12:00:00Z`);
  floor.setUTCDate(floor.getUTCDate() - JOB_LOOKBACK_DAYS);
  const floorStr = floor.toISOString().slice(0, 10);

  const visits = await db('scheduled_services as ss')
    .join('services as sv', 'ss.service_id', 'sv.id')
    .leftJoin('estimates as e', 'ss.source_estimate_id', 'e.id')
    .where('ss.customer_id', customerId)
    .where('ss.scheduled_date', '>=', floorStr)
    .whereIn('sv.service_key', TRAPPING_VISIT_KEYS)
    .whereNotIn('ss.status', INACTIVE_STATUSES)
    .orderBy('ss.scheduled_date', 'asc')
    .select('ss.id', 'ss.scheduled_date', 'ss.status', 'sv.service_key', 'e.accepted_at');

  const openers = visits.filter((v) => TRAPPING_OPENER_KEYS.includes(v.service_key));
  const opener = openers[openers.length - 1] || null;
  const jobVisits = opener
    ? visits.filter((v) => dateOnly(v.scheduled_date) >= dateOnly(opener.scheduled_date))
    : visits;
  const visitCount = jobVisits.length;
  const grandfathered = opener
    ? isGrandfathered({ acceptedAt: opener.accepted_at, openerDate: opener.scheduled_date })
    : false;

  return {
    hasJob: visitCount > 0,
    openerDate: opener ? dateOnly(opener.scheduled_date) : null,
    visitCount,
    includedVisits: INCLUDED_TRAPPING_VISITS,
    grandfathered,
    additionalCheckKey: TRAP_CHECK_ADDITIONAL_KEY,
    additionalCheckPrice: TRAP_CHECK_ADDITIONAL_PRICE,
    // The next booking is visit visitCount+1; it is billable once the
    // included visits are used, unless the job predates the rule.
    nextVisitBillable: !grandfathered && visitCount >= INCLUDED_TRAPPING_VISITS,
  };
}

module.exports = {
  TRAP_CHECK_ADDITIONAL_KEY,
  TRAP_CHECK_ADDITIONAL_PRICE,
  INCLUDED_TRAPPING_VISITS,
  TRAP_CHECK_FEE_EFFECTIVE_DATE,
  TRAPPING_OPENER_KEYS,
  TRAPPING_VISIT_KEYS,
  isGrandfathered,
  trappingJobStatus,
};
