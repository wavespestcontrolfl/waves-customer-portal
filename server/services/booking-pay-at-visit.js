// Booking "pay per application" — resolve a per-application price for a
// self-booking, bound to the booked service, so the visit can be stamped with
// estimated_price + payment_method_preference='pay_at_visit' +
// create_invoice_on_complete (see booking.js). No charge/card capture here;
// billing rides the existing completion → invoice → /pay path.
//
// Price sources, both service-bound and never a mischarge:
//   1. the estimate the booking is explicitly linked to (estimate_id), or
//   2. the RESOLVED customer's own recent quote-wizard drafts (passed in by the
//      caller) — used only when EXACTLY ONE matches the booked service AND
//      address. Bound to the verified customer (not a forgeable id).
//
// AMOUNT is the estimate-level NET recurring annual (estimate.annual_total,
// falling back to monthly_total × 12) ÷ cadence — authoritative and
// shape-independent. Line-item fields are NOT used for the amount: discounts
// live in different places across shapes (line-level for engine lineItems,
// estimate-level for mapped result.recurring.services), so only the estimate
// total is reliably net. The recurring service line is used solely for
// eligibility (a single per-application-billable line), cadence, and the key.
//
// Recurring-service extraction reuses the converter's authoritative multi-shape
// reader so every estimate shape is covered. The service key comes from the
// seeder's serviceKeyFor on BOTH sides (estimate service AND booked
// service_type) so the binding compares one vocabulary.
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
// is present so we never divide a combined total by one service's cadence.
function hasSupplementalRecurring(estimate) {
  const data = estimate.estimate_data || {};
  const rec = data.recurring || data.result?.recurring || {};
  const res = data.results || data.result?.results || {};
  return Number(rec.rodentBaitMo) > 0 || Number(rec.palmInjectionMo) > 0
    || Number(res.rodBaitMo) > 0 || Number(res.palmInjectionMo) > 0;
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
// preserved. Uses the authoritative estimate total, not line fields.
function perVisitAmountForEstimate(estimate, picked) {
  const netAnnual = Number(estimate.annual_total) > 0
    ? Number(estimate.annual_total)
    : (Number(estimate.monthly_total) > 0 ? Number(estimate.monthly_total) * 12 : 0);
  if (!(netAnnual > 0)) return null;
  const perVisit = Math.round((netAnnual / picked.visits) * 100) / 100;
  return perVisit > 0 ? perVisit : null;
}

// Exposed for tests: net per-application amount for an estimate.
function derivePerApplicationAmount(estimate) {
  const picked = pickRecurringService(recurringServicesFromEstimate(estimate));
  return picked ? perVisitAmountForEstimate(estimate, picked) : null;
}

function serviceKeyOf(svc) {
  const { serviceKeyFor } = require('./recurring-appointment-seeder');
  return serviceKeyFor(svc);
}

// Canonical street suffixes (mirrors booking.js's address normalization) so
// "Main Street" == "Main St", "8th Place" == "8th Pl", etc.
const STREET_SUFFIXES = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave', road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln', court: 'ct', ct: 'ct', place: 'pl', pl: 'pl',
  boulevard: 'blvd', blvd: 'blvd', circle: 'cir', cir: 'cir', terrace: 'ter', ter: 'ter',
  way: 'way', trail: 'trl', trl: 'trl', parkway: 'pkwy', pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy',
  square: 'sq', sq: 'sq',
};
function normalizeAddr(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean).map((t) => STREET_SUFFIXES[t] || t).join(' ');
}

// Fail-CLOSED address bind for the candidate (fallback) path: the candidate
// quote's street line and 5-digit zip must match the booked address after
// suffix canonicalization (so "St"/"Street" variants and ZIP+4 are treated as
// equal, consistent with booking.js). Substring matching is deliberately
// avoided so "112 Main St" can't match a booking for "12 Main St". Not applied
// to an explicitly-linked estimate.
function estimateAddressMatches(estimate, bookingAddress) {
  const bookStreet = normalizeAddr(bookingAddress?.line1);
  const bookZip = String(bookingAddress?.zip || '').replace(/\D/g, '').slice(0, 5); // ZIP+4 → first 5
  if (!bookStreet || bookZip.length !== 5) return false;
  const estStreet = normalizeAddr(String(estimate?.address || '').split(',')[0]);
  // The zip is the LAST 5-digit group — a 5-digit street number (e.g. "15715")
  // must not be mistaken for it.
  const estZips = String(estimate?.address || '').match(/\b\d{5}\b/g) || [];
  const estZip = estZips.length ? estZips[estZips.length - 1] : '';
  return !!estStreet && estStreet === bookStreet && estZip === bookZip;
}

// Price from a single estimate, only when its recurring service matches the
// booked service key. Returns { amount, sourceEstimateId, serviceKey } or null.
function priceFromEstimate(estimate, serviceKey) {
  const picked = pickRecurringService(recurringServicesFromEstimate(estimate));
  if (!picked) return null;
  if (!serviceKey || serviceKeyOf(picked.svc) !== serviceKey) return null;
  // annual_total (the amount basis) would also cover any supplemental recurring
  // program, so pricing a single service off it would overbill → fail closed.
  if (hasSupplementalRecurring(estimate)) return null;
  const amount = perVisitAmountForEstimate(estimate, picked);
  return amount ? { amount, sourceEstimateId: estimate.id || null, serviceKey } : null;
}

// Resolve a per-application price bound to the booked service. Prefer the linked
// estimate (explicitly chosen — no address bind needed); else the customer's
// recent quote-wizard drafts (candidateEstimates), which must ALSO match the
// booked address, pricing only when EXACTLY ONE such candidate matches the
// booked service. Never throws.
function resolveBookingVisitPrice({ estimate = null, candidateEstimates = [], serviceKey = null, bookingAddress = null } = {}) {
  try {
    if (estimate) {
      const linked = priceFromEstimate(estimate, serviceKey);
      if (linked) return linked;
    }
    const matches = (Array.isArray(candidateEstimates) ? candidateEstimates : [])
      .filter((e) => estimateAddressMatches(e, bookingAddress))
      .map((e) => priceFromEstimate(e, serviceKey))
      .filter(Boolean);
    if (matches.length === 1) return matches[0];
  } catch (err) {
    logger.warn(`[booking-pay-at-visit] price resolution failed: ${err.message}`);
  }
  return null;
}

module.exports = { derivePerApplicationAmount, resolveBookingVisitPrice };
