/**
 * The ONE reading of "a price was already agreed on this call" (owner
 * ruling 2026-09-24 — the $300 flea call: "just to confirm one more time,
 * it's $300, that's two treatments" / "Yep" still spawned a $387 estimator
 * draft two minutes later). The spoken word beats the estimator.
 *
 * Shared by the call-recording-processor's primary gate and the estimator
 * engine's entry backstop (codex #4815 r6 P2): the two used to carry
 * mirrored copies that had to be "kept in sync" by hand, and both dropped
 * the billing unit. Dependency-free on purpose — both callers' tests mock
 * their persistence layers.
 *
 * V2 ONLY (codex #4815 r1 P1): callers pass the validated V2 extraction.
 * Downstream composer decisions read the V2 canonical extraction plus the
 * raw transcript, never the unvalidated V1 blob — a hallucinated V1 price
 * must never suppress a legitimate draft.
 *
 * Two independent V2 signals, either one enough:
 *   - service_request.quoted_price_usd: the schema's own narrower
 *     accepted-total-only field (validate-extraction.js 1.12.0 note:
 *     "quoted_price_usd keeps its existing semantics"). NEVER a range and
 *     carries no unit (call-extraction-v1.js prompt), so an accepted
 *     prices[] entry with the SAME amount supplies the unit when present.
 *   - service_request.price(s)[].accepted === true: the normalizer
 *     (utils/normalize-extraction-v2.js) has already put the accepted entry
 *     first, and `price` is a copy of prices[0]. amount_usd is the LOW end
 *     of a stated range and amount_max_usd the HIGH end — "$90 to 100"
 *     agreed is a range, never "$90" (codex #4815 r3 P2).
 *
 * Every ACCEPTED entry is carried, not just the primary one, with its
 * billing unit (codex #4815 r6 P2): an accepted "$90 per quarter" must not
 * be reported as "$90.00", and an upfront + recurring agreement ("$150 to
 * start, then $50 a month") must not collapse to its first number.
 *
 * Returns null, or { amount, amountMax?, unit?, additionalTerms?: [term] }
 * where each term is { amount, amountMax?, unit? }.
 */

// Units as the extraction schema spells them ("unknown" = a price with no
// spoken unit, which renders as the bare amount).
const AGREED_PRICE_UNIT_SUFFIXES = Object.freeze({
  one_time: ' one-time',
  per_application: ' per application',
  per_month: '/month',
  per_quarter: '/quarter',
  per_year: '/year',
});

function positiveAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function acceptedPriceTerm(entry) {
  if (!entry || typeof entry !== 'object' || entry.accepted !== true) return null;
  if (!positiveAmount(entry.amount_usd)) return null;
  const term = { amount: entry.amount_usd };
  if (positiveAmount(entry.amount_max_usd) && entry.amount_max_usd > entry.amount_usd) {
    term.amountMax = entry.amount_max_usd;
  }
  if (Object.prototype.hasOwnProperty.call(AGREED_PRICE_UNIT_SUFFIXES, entry.unit)) term.unit = entry.unit;
  return term;
}

function resolveCallAgreedPrice(v2Extraction = null) {
  const svc = v2Extraction?.service_request;
  if (!svc || typeof svc !== 'object') return null;
  // `price` is a copy of prices[0] — walk the array when there is one so
  // the primary entry is not counted twice.
  const entries = Array.isArray(svc.prices) && svc.prices.length ? svc.prices : [svc.price];
  const accepted = entries.map(acceptedPriceTerm).filter(Boolean);
  let primary = null;
  if (positiveAmount(svc.quoted_price_usd)) {
    primary = accepted.find((t) => t.amount === svc.quoted_price_usd && t.amountMax == null)
      || { amount: svc.quoted_price_usd };
  } else {
    [primary] = accepted;
  }
  if (!primary) return null;
  const additionalTerms = accepted.filter((t) => t !== primary);
  return additionalTerms.length ? { ...primary, additionalTerms } : { ...primary };
}

// Every price term a call carries, for resolveStatedOneTimeCallPrice. A term
// counts as soon as it holds a number ($0 too: a waived fee is a term) or was
// accepted with no number: a term that is dropped before it is counted could
// make two agreed terms read as one.
function statedPriceTerms(svc) {
  return (Array.isArray(svc.prices) && svc.prices.length ? svc.prices : [svc.price])
    .filter((entry) => entry && typeof entry === 'object'
      && (typeof entry.amount_usd === 'number' || typeof entry.amount_max_usd === 'number' || entry.accepted === true));
}

// One exact one-time number that no plan claims: unit one_time, a positive
// amount, no range field at all (a malformed range, high end under the low
// end, is not exact), and no plan mark on the term. A one-time fee the reading
// ties to a WaveGuard tier or to an annual prepay is a plan's fee (a setup
// fee, a year paid up front), not the price of a one-time job.
function exactOneTimeAmount(entry) {
  if (entry.tier_mentioned || entry.prepay_term === 'annual') return null;
  return entry.unit === 'one_time' && entry.amount_max_usd == null && positiveAmount(entry.amount_usd) ? entry.amount_usd : null;
}

/**
 * The one-time price STAFF stated and the caller went ahead on, for a call whose
 * strict agreed-price field (quoted_price_usd) stayed empty. 2026-11-21: staff
 * said "One-time service is $250, but it varies" and the caller booked. The
 * hedge kept quoted_price_usd null, so the visit got no price, and nothing told
 * the office which number the call held.
 *
 * Narrow on purpose. Returns the amount only when ALL of these hold, else null:
 *   - quoted_price_usd is null or absent. Any strict total keeps its own path,
 *     a $0 one too (a free booking stays free);
 *   - the call carries exactly ONE price term that is not the caller's own
 *     number (a second one is a correction, an add-on or a waived fee, and
 *     nothing here can tell which one stands), and the extraction says staff
 *     stated it;
 *   - that term is the ONLY term accepted on the call, whoever stated the
 *     others ("$99 to start, then $31 a month" is two agreed terms);
 *   - its unit is one_time and it is one exact positive amount, never a range,
 *     with no plan tier and no annual prepay on the term.
 * A number the CALLER spoke (a competitor's quote) is never a Waves price, and
 * does not count against the one-price rule unless it was accepted.
 *
 * This is NOT a price to bill. The extraction marks a hedge ("it varies") and
 * an added charge ("plus a trip fee") the same way (price_is_final false), and
 * the price block is call-wide: it does not say which service a price covers.
 * Its one reader is the call booking check (services/call-booking-check.js),
 * which shows the number to the office and changes nothing.
 */
function resolveStatedOneTimeCallPrice(v2Extraction = null) {
  const svc = v2Extraction?.service_request;
  if (!svc || typeof svc !== 'object' || svc.quoted_price_usd != null) return null;
  const terms = statedPriceTerms(svc);
  const accepted = terms.filter((entry) => entry.accepted === true);
  const notCallers = terms.filter((entry) => entry.stated_by !== 'caller');
  if (accepted.length !== 1 || notCallers.length !== 1 || accepted[0] !== notCallers[0] || accepted[0].stated_by !== 'agent') return null;
  return exactOneTimeAmount(accepted[0]);
}

/**
 * The ONE exact one-time price a call agreed, or null: the evidence that staff
 * priced a one-time job on the call (the call booker's agreed-one-time-job
 * hold, call-recording-processor.js callAgreedOneTimeJob). Null for anything
 * that is not one number for one job: a range, two agreed terms, an agreed
 * term that is not one-time (a plan rate, a price with no unit) or that a plan
 * claims (a tier, an annual prepay). The call must hold exactly one accepted
 * term, exact and one-time. Then:
 *   - no strict total: the price staff stated (resolveStatedOneTimeCallPrice);
 *   - a strict total (quoted_price_usd, "the total the caller accepted for the
 *     service being booked"): that total, only when it is the same number as
 *     the accepted term. A $0 total, or one that differs, is not this price;
 *     nor is a caller's number when the extraction contradicts the total (not
 *     final, not accepted, or not offered by staff).
 * This is evidence, not a price to bill: see resolveStatedOneTimeCallPrice.
 */
function resolveAgreedOneTimeJobPrice(v2Extraction = null) {
  const svc = v2Extraction?.service_request;
  if (!svc || typeof svc !== 'object') return null;
  const terms = statedPriceTerms(svc);
  const accepted = terms.filter((entry) => entry.accepted === true);
  const amount = accepted.length === 1 ? exactOneTimeAmount(accepted[0]) : null;
  if (amount === null) return null;
  if (svc.quoted_price_usd == null) return resolveStatedOneTimeCallPrice(v2Extraction);
  // A total the extraction contradicts (not final, not accepted by the caller,
  // or not offered by staff) counts only as staff's own term: a caller's
  // number is then not a Waves price, even when it matches the total. This is
  // the same evidence the office card shows (agreedOneTimeJobCardPrice), so a
  // held call's card always carries the price that held it.
  // Staff's own term then has to be staff's only one, as with no total
  // (resolveStatedOneTimeCallPrice): a second staff term (a trip fee added
  // after the price) means the total is not the one price.
  const contradicted = svc.price_is_final === false || svc.price_accepted_by_caller === false || svc.price_offered_by_staff === false;
  if (contradicted) {
    const notCallers = terms.filter((entry) => entry.stated_by !== 'caller');
    if (accepted[0].stated_by !== 'agent' || notCallers.length !== 1 || notCallers[0] !== accepted[0]) return null;
  }
  return svc.quoted_price_usd === amount ? amount : null;
}

// Who stated the one accepted term that resolveAgreedOneTimeJobPrice reads:
// 'agent', 'caller', or null (none, or more than one). The office card shows a
// disputed total as staff's number only when staff stated it.
function agreedOneTimeJobPriceStatedBy(v2Extraction = null) {
  const svc = v2Extraction?.service_request;
  if (!svc || typeof svc !== 'object') return null;
  const accepted = statedPriceTerms(svc).filter((entry) => entry.accepted === true);
  return accepted.length === 1 ? (accepted[0].stated_by || null) : null;
}

function formatAgreedTerm(term) {
  const amount = term?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '$0.00';
  const amountMax = term?.amountMax;
  const base = typeof amountMax === 'number' && Number.isFinite(amountMax) && amountMax > amount
    ? `$${amount.toFixed(2)}–$${amountMax.toFixed(2)}`
    : `$${amount.toFixed(2)}`;
  return `${base}${AGREED_PRICE_UNIT_SUFFIXES[term?.unit] || ''}`;
}

// The full agreed terms for every log line and notification body: exact
// "$90.00", range "$90.00–$100.00", unit "$90.00/quarter", and every
// accepted component joined — "$150.00 one-time + $50.00/month".
function formatAgreedPriceLabel(agreedPrice) {
  const extra = Array.isArray(agreedPrice?.additionalTerms) ? agreedPrice.additionalTerms : [];
  return [agreedPrice, ...extra].map(formatAgreedTerm).join(' + ');
}

// Did this call confirm/book an appointment? Under owner ruling 2026-09-24
// (the $300 flea booking), an agreed price on a confirmed booked call ALWAYS
// suppresses estimator drafting so no conflicting estimate draft competes with
// the booking. Uses the confirmed booking status only (not a proposed slot).
function hasConfirmedBookingOnCall(extracted = null, v2Extraction = null) {
  if (extracted?.appointment_confirmed === true) return true;
  const sched = v2Extraction?.scheduling;
  if (!sched || typeof sched !== 'object') return false;
  return sched.status === 'confirmed';
}

/**
 * Should an agreed verbal price suppress estimator-engine drafting for this call?
 * - Owner ruling 2026-09-24 ("the spoken word beats the estimator"): ALWAYS
 *   suppresses when a visit IS booked/confirmed on the call OR when no written
 *   quote was promised (`quotePromised !== true`).
 * - Owner 2026-11-28 quote-closure fix: when NO visit was booked on the call
 *   AND staff explicitly promised to send a written quote (`quotePromised === true`),
 *   allow the draft to compose for staff review (yellow lane with verbal-price
 *   notice) instead of stranding the lead with zero booking and zero draft.
 */
function shouldSuppressDraftForAgreedPrice({
  agreedPrice = null,
  quotePromised = false,
  extracted = null,
  v2Extraction = null,
} = {}) {
  if (!agreedPrice) return false;
  if (hasConfirmedBookingOnCall(extracted, v2Extraction)) return true;
  return quotePromised !== true;
}

module.exports = {
  resolveCallAgreedPrice,
  resolveStatedOneTimeCallPrice,
  resolveAgreedOneTimeJobPrice,
  agreedOneTimeJobPriceStatedBy,
  formatAgreedPriceLabel,
  hasConfirmedBookingOnCall,
  shouldSuppressDraftForAgreedPrice,
};
