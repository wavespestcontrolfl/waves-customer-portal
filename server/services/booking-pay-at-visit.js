// Booking "pay per application" (Phase 1) — resolve a per-application price for
// a self-booking from the estimate it is EXPLICITLY linked to, so the booked
// visit can be stamped with `estimated_price` + payment_method_preference=
// 'pay_at_visit'. Those are the exact two fields an estimate accept sets on its
// recurring visits, so the existing completion → invoice → /pay → save-card
// machinery bills a self-booking identically. No charge/card capture here.
//
// Two hard safety rails on the money path:
//  - STRICT source binding: the amount comes ONLY from the estimate the booking
//    carries (estimate_id) — never guessed from a customer's other quotes.
//  - SERVICE binding: it is stamped ONLY when the estimate's recurring line is
//    the same service that was booked (service_type is client-influenced), so a
//    crafted/stale payload can't pair one service with another's price.
// Anything ambiguous or mismatched → null, and the booking stays price-less.
const logger = require('./logger');

// The quote-wizard / pricing engine stores priced lines under
// estimate_data.engineResult.lineItems (public-quote.js) or .result.lineItems
// (V2 engine); the converter reads both. Accept those, plus a live estimate
// object's top-level .lineItems.
function lineItemsFromEstimate(estimate) {
  if (!estimate) return [];
  if (Array.isArray(estimate.lineItems)) return estimate.lineItems;
  const data = estimate.estimate_data || {};
  if (Array.isArray(data.result?.lineItems)) return data.result.lineItems;
  if (Array.isArray(data.engineResult?.lineItems)) return data.engineResult.lineItems;
  if (Array.isArray(data.lineItems)) return data.lineItems;
  return [];
}

// Visits/year per canonical recurring pattern — mirrors the seeder's
// DEFAULT_ONE_YEAR_COUNTS (which is not exported).
const VISITS_PER_YEAR_BY_PATTERN = {
  weekly: 52, biweekly: 26, monthly: 12, bimonthly: 6,
  quarterly: 4, triannual: 3, semiannual: 2, biannual: 2, annual: 1, yearly: 1,
};

// Resolve visits/year for a line: a numeric visitsPerYear/frequency, else a
// STRING cadence normalized via the seeder's canonical mapper. Quote-wizard pest
// lines persist frequency:'quarterly' with no numeric visitsPerYear
// (public-quote.js), so string cadences must be handled or the common pest case
// silently stays price-less.
function resolveVisitsPerYear(line) {
  if (Number(line.visitsPerYear) > 0) return Number(line.visitsPerYear);
  if (Number(line.frequency) > 0) return Number(line.frequency);
  const { normalizeRecurringPattern } = require('./recurring-appointment-seeder');
  const pattern = normalizeRecurringPattern(line.frequency ?? line.cadence);
  return (pattern && VISITS_PER_YEAR_BY_PATTERN[pattern]) || null;
}

// Pick the single per-application-billable recurring line, or null. Eligibility:
// exactly one recurring line (positive net monthly), a positive `perApp` caption
// (signals per-visit billing, not a monthly-only tier), and a resolvable cadence.
function pickRecurringLine(lineItems) {
  const recurring = (Array.isArray(lineItems) ? lineItems : []).filter(
    (item) => Number(item?.monthlyAfterDiscount ?? item?.monthly) > 0,
  );
  if (recurring.length !== 1) return null;
  const line = recurring[0];
  if (!(Number(line.perApp) > 0)) return null;
  const visits = resolveVisitsPerYear(line);
  if (!visits) return null;
  return { line, visits };
}

// Billed amount = NET (after-discount) annual ÷ cadence, using the codebase's
// net-field precedence (annualAfterCredits → annualAfterDiscount → annual, then
// the monthly equivalents). `perApp` is stored raw/gross by the quote, so it is
// NEVER the billed amount — billing it would overcharge a discounted plan. Cents
// preserved (this is the billable estimated_price, not a display figure).
function netPerVisit(line, visits) {
  const netAnnual = Number(line.annualAfterCredits ?? line.annualAfterDiscount ?? line.annual);
  const netMonthly = Number(line.monthlyAfterCredits ?? line.monthlyAfterDiscount ?? line.monthly);
  const perVisit = netAnnual > 0
    ? netAnnual / visits
    : (netMonthly > 0 ? (netMonthly * 12) / visits : null);
  if (!(perVisit > 0)) return null;
  return Math.round(perVisit * 100) / 100;
}

// Exposed for tests: net per-application amount from a set of line items.
function derivePerApplicationAmount(lineItems) {
  const picked = pickRecurringLine(lineItems);
  return picked ? netPerVisit(picked.line, picked.visits) : null;
}

// Resolve a per-application price for a booking from its LINKED estimate, bound
// to the booked service. Returns { amount, sourceEstimateId, serviceKey } or
// null. `serviceKey` is the canonical key of the booked service; the price is
// returned only when the estimate line resolves to the same key. Never throws.
function resolveBookingVisitPrice({ estimate = null, serviceKey = null } = {}) {
  try {
    if (!estimate) return null;
    const picked = pickRecurringLine(lineItemsFromEstimate(estimate));
    if (!picked) return null;
    const { serviceKeyFor } = require('./recurring-appointment-seeder');
    const lineKey = serviceKeyFor(picked.line);
    // Fail closed: only stamp when the priced line is the booked service.
    if (!serviceKey || lineKey !== serviceKey) return null;
    const amount = netPerVisit(picked.line, picked.visits);
    if (!amount) return null;
    return { amount, sourceEstimateId: estimate.id || null, serviceKey: lineKey };
  } catch (err) {
    logger.warn(`[booking-pay-at-visit] price resolution failed: ${err.message}`);
    return null;
  }
}

module.exports = { derivePerApplicationAmount, resolveBookingVisitPrice };
