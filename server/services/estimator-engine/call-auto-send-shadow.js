/**
 * Call estimate auto-send — SHADOW verdict (watch only).
 *
 * Owner ruling 2026-11-25 (*build*): step 1 stamps every call-origin draft
 * with "would send" or "would hold: <reasons>". Nothing here sends, texts,
 * emails or changes a price; the stamp is operator-only review data inside
 * estimate_data.estimatorEngine.autoSendShadow. Step 2 (the real send,
 * behind its own owner-flipped gate) reads the same rule.
 *
 * The rule (owner rulings 2026-11-23 / 11-25):
 *   - a visit booked on the call           -> no estimate (hold)
 *   - termite work                         -> hold (termite is on hold)
 *   - commercial                           -> hold (proposals need more work)
 *   - no promise to send a quote           -> hold (read from the call's own
 *                                             extraction, never the pipeline's
 *                                             notification flag: a re-price
 *                                             re-draft sets that one to true)
 *   - home size not found / fallback       -> hold (every >10% price miss in
 *                                             the 90-day backtest was this);
 *                                             a draft priced only by the
 *                                             bedroom band is exempt
 *   - a priced line needs review           -> hold (the estimator authority
 *                                             rule: fallback turf, low pricing
 *                                             confidence, guessed footprint)
 *   - current customer                     -> hold until re-pricing ships
 *   - yard changed recently / lawn dying   -> hold, book an assessment
 *   - landlord or realty company pays      -> hold until the wording ships
 *   - one-time pest ask with no plan line  -> fix: add recurring pest
 * A pest visit-count difference and the "partial draft" reason are NOT
 * holds (37 of the 62 send-worthy calls carried "partial draft").
 *
 * Pure: no I/O, no env reads. Free-text constraint flags are matched by
 * pattern, so the lawn and payer holds are best-effort signals for the
 * shadow comparison, not a contract.
 */
const { FALLBACK_SQFT_SOURCES } = require('./source-arbitration');

const SHADOW_VERSION = 1;

const YARD_CHANGED_RE = /new[_ -]?sod|re[_ -]?sod|sod[_ -]?(install|replac)|pool[_ -]?(build|construction|install)|construction|re[_ -]?grad|yard[_ -]?(changed|torn|redone)|new[_ -]?landscap/i;
const LAWN_DECLINE_RE = /dying|dead[_ -]?(grass|lawn|sod|patch)|declin|brown[_ -]?patch|fungus|disease|diagnos/i;
const THIRD_PARTY_PAYER_RE = /landlord|property[_ -]?manag|realty|realtor|third[_ -]?party[_ -]?pay|owner[_ -]?pays|hoa[_ -]?pays/i;

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function flagText(intent) {
  const flags = Array.isArray(intent?.constraint_flags) ? intent.constraint_flags : [];
  return flags
    .map((f) => [f?.flag, f?.note].filter((s) => typeof s === 'string').join(' '))
    .join(' | ');
}

function bookedOnCall(extraction) {
  return extraction?.appointment_confirmed === true || extraction?.scheduling?.status === 'confirmed';
}

// The agent committed on the call to send a quote. Same two shapes as the
// call processor's resolveCallQuoteSignals (v1 flat, v2 service_request).
function quotePromisedOnCall(extraction) {
  return extraction?.quote_promised === true || extraction?.service_request?.quote_promised === true;
}

function homeSizeFound(propertyFacts) {
  const home = propertyFacts?.home || {};
  return positive(home.value) && !FALLBACK_SQFT_SOURCES.has(home.source);
}

// The contact the draft row actually stores: the resolved draft phone (a
// blocked caller ID or a short callback number resolves to none) or a
// post-quarantine email.
function hasContact(f) {
  const { context } = f;
  const hasEmail = !!((context?.leadIsForThisCall && context?.lead?.email)
    || (!context?.customerPhoneAmbiguous && context?.customer?.email));
  return !!f.draftPhone || hasEmail;
}

// One row per owner hold rule: [reason, predicate over the gathered facts].
const HOLD_RULES = [
  ['booked_on_call', (f) => bookedOnCall(f.context?.extraction)],
  ['quote_not_promised', (f) => !quotePromisedOnCall(f.context?.extraction)],
  ['termite_hold', (f) => f.serviceKeys.some((k) => /termite|wdo/i.test(k)) || /termite|wdo|swarmer/i.test(f.flags)],
  ['commercial_hold', (f) => f.intent.is_commercial === true || f.intent.category === 'COMMERCIAL'],
  ['home_size_not_found', (f) => f.homeSizeDrivesPrice !== false && !homeSizeFound(f.propertyFacts)],
  ['priced_line_needs_review', (f) => f.pricedLineNeedsReview === true],
  ['new_construction', (f) => !!f.propertyFacts?.newConstruction],
  ['ambiguous_phone', (f) => !!f.context?.customerPhoneAmbiguous],
  // context.isExistingCustomer is the classification: an active customer
  // can hold zero qualifying services, and a failed lookup reads as none.
  ['current_customer_reprice_pending', (f) => f.context?.isExistingCustomer === true
    || (Array.isArray(f.priorQualifyingServices) && f.priorQualifyingServices.length > 0)],
  ['low_confidence', (f) => f.intent.confidence === 'low'],
  ['yard_changed_book_assessment', (f) => f.hasLawn && YARD_CHANGED_RE.test(f.flags)],
  ['lawn_declining_book_assessment', (f) => f.hasLawn && LAWN_DECLINE_RE.test(f.flags)],
  ['third_party_payer', (f) => THIRD_PARTY_PAYER_RE.test(f.flags)],
  ['no_contact', (f) => !hasContact(f)],
];

/**
 * @returns {null | { version: number, verdict: 'would_send'|'would_hold',
 *   reasons: string[], fixes: string[] }} null for a non-call origin.
 */
function callAutoSendShadowVerdict({
  origin = null, intent = null, propertyFacts = null, context = null, priorQualifyingServices = [],
  draftPhone = null, homeSizeDrivesPrice = true, pricedLineNeedsReview = false,
} = {}) {
  if (origin?.channel && origin.channel !== 'call') return null;
  if (!intent || intent.decision !== 'draft') return null;

  const services = intent.services && typeof intent.services === 'object' ? intent.services : {};
  const serviceKeys = Object.keys(services);
  const facts = {
    intent, propertyFacts, context, priorQualifyingServices, serviceKeys,
    draftPhone, homeSizeDrivesPrice, pricedLineNeedsReview,
    flags: flagText(intent),
    hasLawn: serviceKeys.some((k) => /lawn/i.test(k)),
  };
  const reasons = HOLD_RULES.filter(([, test]) => test(facts)).map(([reason]) => reason);
  const fixes = services.oneTimePest && !services.pest ? ['add_recurring_pest'] : [];

  return {
    version: SHADOW_VERSION,
    verdict: reasons.length ? 'would_hold' : 'would_send',
    reasons,
    fixes,
  };
}

module.exports = { callAutoSendShadowVerdict, SHADOW_VERSION };
