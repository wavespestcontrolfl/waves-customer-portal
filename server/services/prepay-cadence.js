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
    // lawn_rounds_9 is the same 9x lawn plan as every_6_weeks (nine fixed
    // rounds a year); its coverage cadence is lawn_rounds_9 below.
    case 'lawn_rounds_9': return 9;
    // seasonal_feb_oct (mosquito 9x) is deliberately absent — see
    // prepayCoverageCadenceForPattern below.
    case 'seasonal_feb_oct': return 9;
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
//
// seasonal_feb_oct (mosquito 9x, 2026-07-27) is UNSUPPORTED for the same
// reason: its gap is 1 month in season and 4 across the winter, but the
// coverage seeder fills remaining visits with same-day-of-month math from a
// single stored cadence — it would place prepaid visits in Nov-Jan, the exact
// months the program excludes, and those mis-dated visits could complete-bill
// again. Returning null downgrades the sale to a standard accept (fail closed).
// Supporting it means teaching the coverage seeder the season first.
//
// lawn_rounds_9 (lawn 9x, nine fixed rounds a year) IS supported: the coverage
// seeder places its covered visits on the round calendar (annual-prepay-renewals
// coverageScheduleDates, lawnRoundDate), the same dates the series is seeded
// with. The term stores coverage_cadence 'lawn_rounds_9'.
function prepayCoverageCadenceForPattern(cadence) {
  switch (String(cadence || '').trim().toLowerCase().replace(/[\s-]+/g, '_')) {
    case 'monthly': return 'monthly';
    case 'every_6_weeks': return 'every_6_weeks';
    case 'lawn_rounds_9': return 'lawn_rounds_9';
    case 'bimonthly': case 'bi_monthly': return 'bimonthly';
    case 'quarterly': return 'quarterly';
    case 'triannual': case 'every_4_months': return 'triannual';
    case 'semiannual': case 'biannual': return 'semiannual';
    case 'annual': case 'yearly': return 'annual';
    default: return null;
  }
}

// Lawn 9x rounds (lawn_rounds_9) is the lawn plan's own calendar. A term staff
// set up may carry it only when it covers a lawn service: the seeder's
// serviceKeyFor family 'lawn_care', the same test that writes a series as
// rounds. Any other service on that cadence would seed its visits on the lawn
// round calendar (Codex #7008 r6). Returns { error, code } for the 400, or
// null. Lives here, not in annual-prepay-renewals, so a route test that mocks
// that module whole still runs the real check.
function lawnRoundsCoverageError(coverageCadence, coverageServiceType) {
  if (prepayCoverageCadenceForPattern(coverageCadence) !== 'lawn_rounds_9') return null;
  const { serviceKeyFor } = require('./recurring-appointment-seeder');
  if (serviceKeyFor({ service_type: String(coverageServiceType || '') }) === 'lawn_care') return null;
  return {
    error: 'Lawn rounds (9 a year) covers a lawn plan only. Pick the visit cadence of the service covered.',
    code: 'LAWN_ROUNDS_NOT_LAWN',
  };
}

// The same check for an edit that may send only one of the two fields: the
// stored term supplies whichever one was not submitted (undefined = keep the
// stored value), so a partial edit cannot pair rounds with another service.
function lawnRoundsCoverageErrorForEdit({ submittedCadence, submittedServiceType, storedTerm } = {}) {
  const cadence = submittedCadence !== undefined ? submittedCadence : storedTerm?.coverage_cadence;
  const serviceType = submittedServiceType !== undefined ? submittedServiceType : storedTerm?.coverage_service_type;
  return lawnRoundsCoverageError(cadence, serviceType);
}

module.exports = { visitsPerYearForCadence, prepayCoverageCadenceForPattern, lawnRoundsCoverageError, lawnRoundsCoverageErrorForEdit };
