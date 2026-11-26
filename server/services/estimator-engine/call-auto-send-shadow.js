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
 *   - any other lane review reason         -> hold (the draft lane is the
 *                                             pricing authority: fallback lot,
 *                                             heuristic turf, low pricing
 *                                             confidence, comps band, ...)
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
// Free-text fallback for a payer other than the caller. It needs a payer AND
// payment words: "landlord must approve access" alone is not a payer.
const PAYER_WORDS = '(?:landlord|property[_ -]?manag\\w*|realty|realtor|hoa|home[_ -]?owner|owner)';
const PAY_WORDS = '(?:pay\\w*|bill\\w*|invoice\\w*|cover\\w*)';
const THIRD_PARTY_PAYER_RE = new RegExp(`third[_ -]?party[_ -]?pay|${PAYER_WORDS}[^|]{0,40}${PAY_WORDS}|${PAY_WORDS}[^|]{0,40}${PAYER_WORDS}`, 'i');

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

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// BOTH original extractions of the call. context.extraction holds only the
// selected one, and the call processor decides a promise from either
// (resolveCallQuoteSignals), so the shadow reads the same two. Only a VALID
// v2 payload may speak (an invalid one is audit data).
function callExtractions(context) {
  const call = context?.call || {};
  const v1 = parseMaybeJson(call.ai_extraction);
  const v2 = call.v2_extraction_status === 'valid' ? parseMaybeJson(call.ai_extraction_enriched) : null;
  return [v1, v2, context?.extraction].filter((x) => x && typeof x === 'object');
}

// The agent committed on the call to send a quote (v1 flat, v2 service_request).
function quotePromisedOnCall(extractions) {
  return extractions.some((x) => x.quote_promised === true || x.service_request?.quote_promised === true);
}

// A contact slot the extraction marked as the paying party.
function billingPartyNamed(extractions) {
  return extractions.some((x) => Object.entries(x)
    .filter(([key]) => /contact/i.test(key))
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .some((c) => c && c.is_billing_party === true));
}

// The phone is not a delivery channel: the caller said the line cannot get
// texts, or declined texts on the call (TCPA: no SMS without consent).
function smsBlocked(extractions) {
  return extractions.some((x) => x.caller?.ani_cannot_text === true
    || x.consent?.sms_declined === true || x.sms_declined === true);
}

// Termite or WDO work the call asked for, even when the composed intent
// carries no termite key (WDO has none) and no flag names it. Requested
// scope only: a termite job in the caller's treatment history is not a
// termite request.
function termiteRequested(extractions) {
  return extractions.some((x) => {
    const sr = x.service_request || {};
    const scope = [
      sr.primary_category, sr.category, sr.service_name, sr.requested_service,
      ...(Array.isArray(sr.secondary_categories) ? sr.secondary_categories : []),
      x.requested_service, x.matched_service, x.service_interest,
    ].filter((v) => typeof v === 'string');
    return /termite|wdo/i.test(scope.join(' '));
  });
}

// The draft lane is the pricing authority: every review reason it raised is
// a hold, except the ones the owner ruled are not (visit count, an unpriced
// manual item) and the ones a named rule below already grades (composer
// confidence, constraint flags, open questions, current customer, home
// size, new construction). New lane reasons therefore hold by default.
const LANE_REASONS_NOT_HOLDS = [
  /^pest visit count:/, /^partial draft:/, /^constraints the engine can't express:/,
  /^composer confidence (medium|high)$/, /^open questions:/, /^existing active customer/,
  /^home\/building sqft from fallback source/, /^new construction/,
];

function laneReviewHolds(laneReasons) {
  return (Array.isArray(laneReasons) ? laneReasons : [])
    .filter((r) => typeof r === 'string' && !LANE_REASONS_NOT_HOLDS.some((re) => re.test(r)));
}

function homeSizeFound(propertyFacts) {
  const home = propertyFacts?.home || {};
  return positive(home.value) && !FALLBACK_SQFT_SOURCES.has(home.source);
}

// Whether a channel exists at all. Recipient-specific SMS consent and
// number ownership are decided by the send path at send time (step 2);
// this only rules out drafts that have nothing to send to.
// The contact the draft row actually stores: the resolved draft phone (a
// blocked caller ID or a short callback number resolves to none) or a
// post-quarantine email. A phone the caller cannot or will not get texts on
// does not count.
function hasContact(f) {
  const { context } = f;
  const hasEmail = !!((context?.leadIsForThisCall && context?.lead?.email)
    || (!context?.customerPhoneAmbiguous && context?.customer?.email));
  // A do-not-contact request vetoes both channels.
  if (f.extractions.some((x) => x.consent?.do_not_contact_request === true || x.do_not_contact_request === true)) return false;
  return (!!f.draftPhone && !smsBlocked(f.extractions)) || hasEmail;
}

// One row per owner hold rule: [reason, predicate over the gathered facts].
const HOLD_RULES = [
  // Keyed on the call's confirmed appointment, not the persisted booking:
  // the draft composes while the processor is still routing, so no booking
  // outcome exists yet. A confirmed time whose booking was then blocked
  // also holds, which is the safe side (the office already owns that call).
  // Either original extraction may be the one that drives the booking.
  ['booked_on_call', (f) => f.extractions.some(bookedOnCall)],
  ['quote_not_promised', (f) => !quotePromisedOnCall(f.extractions)],
  ['termite_hold', (f) => f.serviceKeys.some((k) => /termite|wdo/i.test(k)) || /termite|wdo|swarmer/i.test(f.flags)
    || termiteRequested(f.extractions)],
  ['commercial_hold', (f) => f.intent.is_commercial === true || f.intent.category === 'COMMERCIAL'],
  ['home_size_not_found', (f) => f.homeSizeDrivesPrice !== false && !homeSizeFound(f.propertyFacts)],
  ['lane_review_reason', (f) => f.laneHolds.length > 0],
  ['new_construction', (f) => !!f.propertyFacts?.newConstruction],
  ['ambiguous_phone', (f) => !!f.context?.customerPhoneAmbiguous],
  // context.isExistingCustomer is the classification: an active customer
  // can hold zero qualifying services, and a failed lookup reads as none.
  ['current_customer_reprice_pending', (f) => f.context?.isExistingCustomer === true
    || (Array.isArray(f.priorQualifyingServices) && f.priorQualifyingServices.length > 0)],
  ['low_confidence', (f) => f.intent.confidence === 'low'],
  ['yard_changed_book_assessment', (f) => f.hasLawn && YARD_CHANGED_RE.test(f.flags)],
  ['lawn_declining_book_assessment', (f) => f.hasLawn && LAWN_DECLINE_RE.test(f.flags)],
  ['third_party_payer', (f) => billingPartyNamed(f.extractions) || THIRD_PARTY_PAYER_RE.test(f.flags)],
  ['no_contact', (f) => !hasContact(f)],
];

/**
 * @returns {null | { version: number, verdict: 'would_send'|'would_hold',
 *   reasons: string[], fixes: string[] }} null for a non-call origin.
 */
function callAutoSendShadowVerdict({
  origin = null, intent = null, propertyFacts = null, context = null, priorQualifyingServices = [],
  draftPhone = null, homeSizeDrivesPrice = true, laneReasons = [],
} = {}) {
  if (origin?.channel && origin.channel !== 'call') return null;
  if (!intent || intent.decision !== 'draft') return null;

  const services = intent.services || {};
  const serviceKeys = Object.keys(services);
  const facts = {
    intent, propertyFacts, context, priorQualifyingServices, serviceKeys,
    draftPhone, homeSizeDrivesPrice,
    laneHolds: laneReviewHolds(laneReasons),
    extractions: callExtractions(context),
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
    // The lane reasons behind lane_review_reason, for the shadow report.
    ...(facts.laneHolds.length ? { laneHolds: facts.laneHolds } : {}),
  };
}

module.exports = { callAutoSendShadowVerdict, SHADOW_VERSION };
