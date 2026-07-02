// Booking "pay per application" — resolve a per-application price for a
// self-booking from the estimate it is EXPLICITLY linked to (estimate_id),
// bound to the booked service AND the booking's series cadence, so the visit can
// be stamped with estimated_price + payment_method_preference='pay_at_visit' +
// create_invoice_on_complete (booking.js). No charge/card capture here; billing
// rides the existing completion → invoice → /pay path.
//
// Scope: LINKED estimates only. Lighting up the common quote-wizard booking
// (which carries no estimate_id) is a separate follow-up that passes a
// server-trusted estimate reference from the quote flow into /book — inferring
// which quote a booking came from proved unsafe/ineffective (the real /book UI
// is address-prelinked and sends no phone to verify identity).
const logger = require('./logger');

// A recurring line's monthly price (any positive value across shape aliases) —
// used ONLY to identify a priced recurring line, never as the billed amount.
function lineMonthlyOf(s) {
  return Number(s.monthlyAfterCredits ?? s.monthlyAfterDiscount ?? s.monthly ?? s.mo ?? s.monthlyTotal ?? s.monthly_total);
}
function perAppOf(s) {
  return Number(s.perApp ?? s.perTreatment ?? s.perVisit ?? s.pa);
}

// Supplemental recurring programs (rodent bait, palm injection) are persisted
// OUTSIDE recurring.services (result.recurring.rodentBaitMo / palmInjectionMo)
// and NOT surfaced by recurringServicesFromEstimateData — but estimate.annual_total
// still includes them. So a pest+rodent quote could show a single pest service
// row while annual_total covers both. Fail closed when any supplemental program
// is present (in ANY recurring container) so we never divide a combined total by
// one service's cadence.
function hasSupplementalRecurring(estimate) {
  const data = estimate.estimate_data || {};
  const containers = [data.recurring, data.result?.recurring, data.results, data.result?.results].filter(Boolean);
  return containers.some((c) => Number(c.rodentBaitMo) > 0 || Number(c.palmInjectionMo) > 0 || Number(c.rodBaitMo) > 0);
}

const VISITS_PER_YEAR_BY_PATTERN = {
  weekly: 52, biweekly: 26, monthly: 12, bimonthly: 6,
  quarterly: 4, triannual: 3, semiannual: 2, biannual: 2, annual: 1, yearly: 1,
};
function resolveVisitsPerYear(s) {
  if (Number(s.visitsPerYear) > 0) return Number(s.visitsPerYear);
  if (Number(s.frequency) > 0) return Number(s.frequency);
  const { normalizeRecurringPattern } = require('./recurring-appointment-seeder');
  const pattern = normalizeRecurringPattern(s.frequency ?? s.cadence);
  return (pattern && VISITS_PER_YEAR_BY_PATTERN[pattern]) || null;
}

// Extract recurring services from ANY estimate shape via the converter's
// authoritative extractor. Accepts a DB row (.estimate_data) or a live estimate
// object (.lineItems, wrapped so the engineResult path finds them).
function recurringServicesFromEstimate(estimate) {
  if (!estimate) return [];
  const { recurringServicesFromEstimateData } = require('./estimate-converter');
  const data = estimate.estimate_data
    || (Array.isArray(estimate.lineItems) ? { engineResult: { lineItems: estimate.lineItems } } : {});
  try {
    return recurringServicesFromEstimateData(data) || [];
  } catch (err) {
    logger.warn(`[booking-pay-at-visit] recurring-service extraction failed: ${err.message}`);
    return [];
  }
}

// The single per-application-billable recurring service + its cadence, or null.
// Eligibility: exactly one priced recurring line, a positive per-app caption
// (signals per-visit billing, not a monthly-only tier), and a resolvable cadence.
function pickRecurringService(services) {
  const priced = (Array.isArray(services) ? services : []).filter((s) => lineMonthlyOf(s) > 0);
  if (priced.length !== 1) return null;
  const svc = priced[0];
  if (!(perAppOf(svc) > 0)) return null;
  const visits = resolveVisitsPerYear(svc);
  if (!visits) return null;
  return { svc, visits };
}

// Per-visit NET amount = estimate-level net recurring annual ÷ cadence, cents
// preserved. Uses the authoritative estimate total, not line fields. Requires
// the estimate's cadence to equal the booking's series cadence (bookingVisits):
// annual_total is priced for the quote's cadence, so dividing it by a different
// number of visits (e.g. a monthly quote's annual over a quarterly series) would
// mis-bill → fail closed on any mismatch.
function perVisitAmountForEstimate(estimate, picked, bookingVisits) {
  if (!(bookingVisits > 0) || picked.visits !== bookingVisits) return null;
  const netAnnual = Number(estimate.annual_total) > 0
    ? Number(estimate.annual_total)
    : (Number(estimate.monthly_total) > 0 ? Number(estimate.monthly_total) * 12 : 0);
  if (!(netAnnual > 0)) return null;
  const perVisit = Math.round((netAnnual / bookingVisits) * 100) / 100;
  return perVisit > 0 ? perVisit : null;
}

// Exposed for tests: net per-application amount for an estimate at a cadence.
function derivePerApplicationAmount(estimate, bookingVisits) {
  const picked = pickRecurringService(recurringServicesFromEstimate(estimate));
  return picked ? perVisitAmountForEstimate(estimate, picked, bookingVisits) : null;
}

function serviceKeyOf(svc) {
  const { serviceKeyFor } = require('./recurring-appointment-seeder');
  return serviceKeyFor(svc);
}

// Price from a single estimate, only when its recurring service matches the
// booked service key AND cadence, and it carries no supplemental program.
// Returns { amount, sourceEstimateId, serviceKey } or null.
function priceFromEstimate(estimate, serviceKey, bookingVisits) {
  const picked = pickRecurringService(recurringServicesFromEstimate(estimate));
  if (!picked) return null;
  if (!serviceKey || serviceKeyOf(picked.svc) !== serviceKey) return null;
  // annual_total (the amount basis) would also cover any supplemental recurring
  // program, so pricing a single service off it would overbill → fail closed.
  if (hasSupplementalRecurring(estimate)) return null;
  const amount = perVisitAmountForEstimate(estimate, picked, bookingVisits);
  return amount ? { amount, sourceEstimateId: estimate.id || null, serviceKey } : null;
}

// Resolve a per-application price from the estimate the booking is LINKED to
// (estimate_id), bound to the booked service + series cadence. Never throws.
function resolveBookingVisitPrice({ estimate = null, serviceKey = null, bookingVisits = null } = {}) {
  try {
    if (estimate) return priceFromEstimate(estimate, serviceKey, bookingVisits);
  } catch (err) {
    logger.warn(`[booking-pay-at-visit] price resolution failed: ${err.message}`);
  }
  return null;
}

module.exports = { derivePerApplicationAmount, resolveBookingVisitPrice };
