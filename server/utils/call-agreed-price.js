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

module.exports = {
  resolveCallAgreedPrice,
  formatAgreedPriceLabel,
};
