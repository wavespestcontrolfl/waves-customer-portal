/**
 * Shared cadence → annual-prepay coverage math, extracted verbatim from
 * admin-schedule.js (prepay-on-book preflight) so the /secure plan-choice
 * lane (secure-appointment-plans.js) derives coverage from a booked series
 * with the SAME numbers the admin path uses. Pure functions, no DB.
 */

// The number of covered visits an annual-prepay term should carry, derived
// from the booked recurring cadence. The operator can override in the modal.
// Returns null for non-recurring / unknown cadences (the caller then requires
// an explicit count or downgrades to a standard accept). Values mirror the
// converter's CADENCE_VISITS map so a booked cadence and a converter-derived
// cadence produce the same coverage count.
function visitsPerYearForCadence(cadence) {
  switch (String(cadence || '').trim().toLowerCase()) {
    // monthly_nth_weekday is a 1-month interval (12/year) — kept here so the
    // preflight reaches the SPECIFIC unsupported-cadence downgrade for it
    // (prepayCoverageCadenceForPattern rejects it) instead of the generic
    // unknown-cadence message.
    case 'monthly': case 'monthly_nth_weekday': return 12;
    case 'every_6_weeks': return 9;
    case 'bimonthly': case 'bi_monthly': return 6;
    case 'quarterly': return 4;
    case 'triannual': case 'every_4_months': return 3;
    case 'semiannual': case 'biannual': return 2;
    case 'annual': case 'yearly': return 1;
    default: return null;
  }
}

// The COVERAGE cadence stored on an annual-prepay term for a booked recurring
// pattern (also normalizes a QUOTE row's frequency label for the cadence-match
// guard, hence the separator normalization). MUST be a value
// annual-prepay-renewals' normalizeCoverageCadence accepts — an unsupported
// value normalizes to null there and the term's renewal/stamping math silently
// falls back to a visit-count-derived schedule, seeding wrong dates so paid
// covered visits can complete-bill again. Patterns with no supported mapping
// return null and the prepay-on-book preflight downgrades to a standard
// accept — fail closed, even when the operator supplied an explicit visit
// count. monthly_nth_weekday is deliberately UNSUPPORTED: an ongoing booking
// pre-seeds only the first visits, and the coverage seeder fills the rest
// from the stored cadence with same-day-of-month math and no nth/weekday
// context — a "3rd Tuesday" route would get its remaining prepaid visits on
// arbitrary dates.
function prepayCoverageCadenceForPattern(cadence) {
  switch (String(cadence || '').trim().toLowerCase().replace(/[\s-]+/g, '_')) {
    case 'monthly': return 'monthly';
    case 'every_6_weeks': return 'every_6_weeks';
    case 'bimonthly': case 'bi_monthly': return 'bimonthly';
    case 'quarterly': return 'quarterly';
    case 'triannual': case 'every_4_months': return 'triannual';
    case 'semiannual': case 'biannual': return 'semiannual';
    case 'annual': case 'yearly': return 'annual';
    default: return null;
  }
}

module.exports = { visitsPerYearForCadence, prepayCoverageCadenceForPattern };
