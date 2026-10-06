/**
 * Commercial dictated booking — the SECOND path (beside, never a relaxation
 * of, hasAgentCommittedEvidence in call-triage-flags.js) that clears the
 * commercial_requires_quote hold.
 *
 * Owner ruling 2026-09-30 (call-booker gates review, item 8): a commercial
 * job that Waves staff dictate on the call — and the caller accepts —
 * auto-books instead of always going to the office. INBOUND calls only for now
 * (owner ruling, same day: outbound diarization has swapped Agent:/Caller:
 * labels, so it waits until staff identity on an outbound recording can be
 * established independently of the labels — the processor applies
 * !isOutboundCall at both call sites). This builds on the owner's 2026-09-24
 * rule ("staff booking a commercial job on the recording clears the quote
 * hold"), whose strict agent-commit check rejected nearly every real call.
 *
 * Safety (owner-approved, the grounding method of reschedules): BOTH the staff
 * commitment quote and the caller's acceptance quote must be found word for
 * word in a turn of the right speaker. call-reschedule-agreement.js
 * groundNewBookingAgreement does that with the reschedule module's own turn
 * parser, quote grounding, screens and slot-word checks (groundRescheduleAgreement
 * itself is unchanged); it fails closed on an unlabeled or one-speaker
 * transcript and when a quote appears only in the other speaker's turn. It
 * also covers the new-booking shapes a move never has: "Sure, that works."
 * as the caller's acceptance or as staff's reply to the caller's exact
 * proposal, and a final time turn that omits the day.
 *
 * On top of that grounding, this path adds what a NEW commercial booking needs:
 *   - a price agreed on the call, grounded in the transcript: the
 *     extraction's quoted_price_usd (the field booking consumes — an accepted
 *     price entry alone is not enough: it carries billing units the visit
 *     price cannot), the extraction's judgements that staff offered that amount
 *     as Waves' own quote, the caller accepted it and it was final (schema
 *     1.21.0), and pinned quotes for the offer and the acceptance that the code
 *     verifies (right speaker, offer states the amount, acceptance later). No
 *     price agreed → the job still goes to the office for a quote.
 *   - it books a NEW visit: an extraction that also names an existing
 *     appointment being moved is a reschedule, never a commercial booking.
 * canAutoRoute (call-triage-flags.js) applies the rest — a confirmed start on
 * the hour, GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS — and the processor requires
 * GATE_CALL_AGENT_COMMIT_BOOKING (the kill switch of the commercial exception)
 * too; every other hold, address validation and capacity check stays exactly as
 * it was. Only commercial_requires_quote is cleared, and it rides in
 * failedOpenFlags so the office still gets the advisory card (book-and-flag).
 *
 * SECOND mode, no price (owner ruling 2026-10-06, GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING):
 * a commercial Waves Assessment that staff book on the call with NO price
 * discussed books at the catalog price, on outbound callback calls (lead_auto_bridge)
 * as well as inbound. It skips the price terms (there is no price to ground) and
 * keeps everything else: the same word-for-word grounding of the staff
 * commitment and the caller's acceptance (here also the shape where STAFF
 * proposes the slot, the caller says yes and staff commits), the confirmed
 * on-the-hour slot canAutoRoute checks, and the catalog check that EVERY service
 * view of the call resolves to the Waves Assessment row. Any price at all (an
 * extracted amount, a price judgement, or a "$"/"dollars" in the transcript)
 * sends the call to the priced path above, unchanged.
 * Outbound recordings need one more proof. Speaker labels are LLM-inferred and
 * have swapped on outbound calls, so a customer's own line could ground as a
 * staff commitment. Recordings are single-channel, so staff identity is anchored
 * on the words: an Agent-labeled turn says "this is <name> with|from|at Waves"
 * and no Caller-labeled turn does (outboundStaffIdentityProven); otherwise the
 * call holds ('outbound_staff_identity_unproven'). ONE predicate: canAutoRoute
 * reaches this function from the live lane, the shadow pass and the audit
 * reconstruction alike.
 *
 * Contract: commercialDictatedBookingGrounded({ v2, transcript, callStartedAt, quoteBookable,
 *   pricedPath = true, assessmentBooking = null })   // assessmentBooking: { bookable(v2), outbound }
 *   -> { ok, reason }
 */
'use strict';

const { groundNewBookingAgreement, groundingTools } = require('./call-reschedule-agreement');
const { resolveCallAgreedPrice } = require('../utils/call-agreed-price');
// The same validation appointment creation applies to the quoted total
// (resolveCallBookingPrice drops one outside its bounds and books at the
// catalog price or none): reuse it, never copy the bounds.
const { sanitizeQuotedCallPrice } = require('./call-booking-catalog');

const { parseTurns, turnsHolding, spokenFiguresIn, spokenNumbersIn } = groundingTools;

// Does a text state this amount, as digits ("$1,500", "150.00") or as spoken words
// ("a hundred forty nine dollars")? The ONLY number reading left in this file: it
// grounds the booked amount in the staff's own offer quote. It does NOT scan for
// other figures: whether a later correction or an added charge happened is the
// extraction's judgement (price_is_final), per the owner ruling of 2026-10-01.
function amountsIn(text) {
  const str = String(text || '');
  const digits = [...str.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)]
    .map((m) => Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`));
  return [...digits, ...spokenFiguresIn(str)];
}
// Cents spoken after "dollars and": 0–99 as digits or words ("five", "fifteen",
// "ninety-nine"). spokenFiguresIn skips values below 20, so cents get their own reader.
const CENT_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const CENT_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function centsIn(phrase) {
  const p = String(phrase || '').trim().toLowerCase();
  if (/^\d{1,2}$/.test(p)) return Number(p);
  const words = p.split(/[\s-]+/).filter(Boolean);
  if (words.length === 1 && CENT_ONES.includes(words[0])) return CENT_ONES.indexOf(words[0]);
  const tens = CENT_TENS.indexOf(words[0]);
  if (tens < 2) return null;
  if (words.length === 1) return tens * 10;
  const ones = CENT_ONES.indexOf(words[1]);
  return words.length === 2 && ones >= 1 && ones <= 9 ? tens * 10 + ones : null;
}
// The amount written immediately before a position ("For twenty rooms it is 150" -> 150,
// "... one hundred fifty" -> 150): the digit group or the run of number words that ends the
// text, never an earlier figure in the sentence.
const NUMBER_WORD_RUN = /((?:\b(?:a|and|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b[\s-]*)+)$/i;
function amountEndingAt(prefix) {
  const digits = /(\d{1,3}(?:,\d{3})+|\d+)\s*$/.exec(prefix);
  if (digits) return Number(digits[1].replace(/,/g, ''));
  const words = NUMBER_WORD_RUN.exec(prefix);
  return words ? spokenFiguresIn(words[1]).at(-1) ?? null : null;
}
function statesAmount(text, amount) {
  const str = String(text || '');
  const amounts = amountsIn(str);
  // A dollars-and-cents compound ("one hundred fifty dollars and five cents", "150 dollars
  // and 50 cents") reads as two figures: the last figure before "dollars and" and the cents
  // after it become ONE amount (150.05), and neither part counts on its own. A compound
  // that cannot be read fails closed: the quote does not state the amount.
  for (const m of str.matchAll(/\bdollars?\s+and\s+([a-z0-9 -]+?)\s+cents?\b/gi)) {
    const dollars = amountEndingAt(str.slice(0, m.index));
    const cents = centsIn(m[1]);
    if (dollars == null || cents == null) return false;
    for (const part of [dollars, ...amountsIn(m[1])]) {
      const i = amounts.indexOf(part);
      if (i >= 0) amounts.splice(i, 1);
    }
    amounts.push(Math.round(dollars * 100 + cents) / 100);
  }
  return amounts.includes(amount);
}

// The agreed price is real. The extraction JUDGES the price language (schema 1.21.0:
// staff offered this amount as Waves' own quote, the caller accepted it, and it was
// FINAL: no later correction or added charge) and pins a quote for the offer and the
// acceptance; this code only verifies: every judgement is true (a missing one fails
// closed), each quote is word for word in a turn of its required speaker, the OFFER
// quote states the booked amount (quoted_price_usd), and the acceptance comes in a
// LATER turn than the offer.
function priceGrounded(v2, transcript, amount) {
  const svc = v2.service_request || {};
  if (svc.price_offered_by_staff !== true) return 'price_offer_unjudged';
  if (svc.price_accepted_by_caller !== true) return 'price_acceptance_unjudged';
  if (svc.price_is_final !== true) return 'price_not_final';
  const turns = parseTurns(transcript);
  if (!turns || new Set(turns.map((t) => t.agent)).size < 2) return 'price_ungrounded';
  const pinned = (path, speaker) => (Array.isArray(v2.evidence) ? v2.evidence : [])
    .filter((e) => e?.field_path === path && e.speaker === speaker && typeof e.quote === 'string')
    .flatMap((e) => turnsHolding(turns, e.quote, speaker).map((turn) => ({ turn, quote: e.quote })));
  // The quote AND its whole turn state the amount: a quote clipped inside the spoken
  // amount ("The service is $150" from "The service is $150.50.") reads 150 while the
  // turn reads 150.50, so it does not ground $150 (codex #5377 local r1 P1).
  const offers = pinned('/service_request/price_offered_by_staff', 'agent')
    .filter(({ quote, turn }) => statesAmount(quote, amount) && statesAmount(turn.raw, amount));
  if (!offers.length) return 'price_not_stated_by_staff';
  const accepted = pinned('/service_request/price_accepted_by_caller', 'caller')
    .some(({ turn }) => offers.some((offer) => turns.indexOf(turn) > turns.indexOf(offer.turn)));
  return accepted ? null : 'price_not_accepted_by_caller';
}

// The agreed-price terms, checked in order; the first that fails is the reason.
// `t` carries { v2, agreed, quoted, entry, quoteBookable }.
const PRICE_TERM_CHECKS = [
  // A price was agreed on the call. A range ("$90 to $100") is not one price.
  ['no_price_agreed', (t) => !t.agreed],
  ['price_is_a_range', (t) => [t.agreed, ...(t.agreed.additionalTerms || [])].some((term) => term.amountMax != null)],
  // More than one accepted term ("$150 to start plus $50/month") is not one
  // price either: booking stamps quoted_price_usd only, so the extra accepted
  // charge would never reach the appointment. The office books it.
  ['price_has_multiple_terms', (t) => (t.agreed.additionalTerms || []).length > 0],
  // Booking stamps the visit price from quoted_price_usd alone (one accepted
  // total, extraction-compat's quoted_price); an accepted price entry with a
  // billing unit and no quoted total would unlock the booking without that
  // amount ever reaching the appointment, so it is not enough.
  ['no_quoted_total', (t) => typeof t.quoted !== 'number' || !(t.quoted > 0) || t.agreed.amount !== t.quoted],
  // The booked row carries one per-visit price. A recurring billing unit
  // ("$150 a month") stamped as that price would lose the recurring term, so
  // only a one-time / per-application / unitless amount books here. The
  // schema records a bare "$150" with unit 'unknown' — that is unitless.
  // The unit is read from an ACCEPTED price entry for this exact total:
  // resolveCallAgreedPrice synthesizes a unitless term from quoted_price_usd
  // when no entry matches, so a missing, unaccepted or unit-less entry would
  // otherwise let "$150 a month" book as a bare $150 visit (codex #5377 r15 P1).
  ['no_accepted_price_entry', (t) => !t.entry],
  ['price_unit_not_bookable', (t) => !['one_time', 'per_application', 'unknown'].includes(t.entry.unit)],
  // The booking path discards a total outside its accepted range (or with
  // sub-cent precision) and books at the catalog price or none, so the
  // caller's accepted amount would never reach the appointment: the office
  // books it instead.
  ['quoted_total_not_bookable', (t) => sanitizeQuotedCallPrice(t.quoted) !== t.quoted],
  // ...and the catalog-aware half of the same resolver (resolveCallBookingPrice):
  // it discards every quote when the resolved catalog row is recurring or a
  // covered re-service. The caller supplies the check (it alone can load and
  // resolve the catalog row the way the booking does); without one, or when the
  // quote does not survive it, the office books it.
  ['price_not_bookable_for_service', (t) => typeof t.quoteBookable !== 'function' || t.quoteBookable(t.quoted, t.v2) !== true],
];

// The accepted price entry for exactly this total (no range), or undefined.
function acceptedEntryFor(svc, quoted) {
  const entries = Array.isArray(svc.prices) && svc.prices.length ? svc.prices : [svc.price];
  return entries.find((e) => e && e.accepted === true && e.amount_usd === quoted && !(e.amount_max_usd > e.amount_usd));
}

// Did a price come up on the call at all? Fail closed on EVERY view of the call:
//  - the V2 service_request: the quoted total, a price entry with an amount or a range end,
//    and ANY price judgement (a false one means price talk happened too: only null means none);
//  - every V1 view the processor hands in (the merged record AND the one before V2 adoption):
//    a quoted price, a price amount, a price entry, quote_requested or quote_promised;
//  - the transcript, in ANY turn: a price noun (price, cost, charge, fee, total, quote, rate,
//    pay, payment, invoice, bill, deposit) or a currency word / figure ($, dollars, bucks).
//    "free" and "no charge" / "no cost" / "no fee" are not price talk;
//  - ANY number in an agent-labeled turn, bare amounts included (agentSaidNumber), except the
//    recorded slot words of the grounded slot turn.
// The no-price assessment mode needs ALL of these quiet; one of them sends the call to the
// priced path.
const PRICE_TALK = /\$\s*\d|\b(?:dollars?|bucks?|price[sd]?|pricing|costs?|charg(?:e|es|ed|ing)|fees?|totals?|quot(?:e|es|ed|ing)|estimat(?:e|es|ed|ing)|rates?|pay|pays|paying|paid|payments?|invoic(?:e|es|ed|ing)|bill|bills|billed|billing|deposits?)\b/i;
const NO_CHARGE = /\b(?:no|without|free of)\s+(?:extra\s+|additional\s+|any\s+)?(?:charge|charges|cost|costs|fee|fees)\b/gi;
const hasAmount = (e) => !!e && typeof e === 'object' && (e.amount_usd != null || e.amount_max_usd != null);
function v1ViewPriced(view) {
  if (!view || typeof view !== 'object') return false;
  const entries = [view.price, ...(Array.isArray(view.prices) ? view.prices : [])];
  return [view.quoted_price, view.quoted_price_usd, view.price_amount_usd, view.price_amount_max_usd].some((v) => v != null)
    || view.quote_requested === true || view.quote_promised === true || entries.some(hasAmount);
}
// A bare amount ("It'll be 149." / "one forty-nine" / "a hundred and fifty") says no price noun,
// so the screen above misses it. The class is closed instead: ANY number in an AGENT-labeled turn
// (digits, or number words of any size, including the ambiguous runs and "one"/"two" as words)
// means price may have come up. The ONE exemption is the grounded slot turn itself: the agent
// turn holding the pinned slot proposal or commitment quote may carry the recorded hour, day and
// period words (and ordinal dates) of the agreed slot, and nothing else numeric. Caller turns are
// not screened (addresses, zips, sizes). An article "one" ("one second") fails closed too.
const ORDINAL_DATE = /\b(?:\d{1,2}(?:st|nd|rd|th)|(?:twenty|thirty)[\s-]?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth))\b/gi;
const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function withoutSlotWords(text, words) {
  let out = String(text || '').replace(ORDINAL_DATE, ' ');
  for (const w of [words?.hour, words?.day, words?.period]) {
    if (typeof w === 'string' && w.trim()) out = out.replace(new RegExp(`(?<![\\w])${escapeRe(w.trim())}(?::00)?(?![\\w])`, 'gi'), ' ');
  }
  return out.replace(/\bo['’]?\s?clock\b/gi, ' ');
}
const hasNumber = (text) => /\d/.test(text) || spokenNumbersIn(text).length > 0;
function agentSaidNumber(v2, transcript) {
  const turns = parseTurns(transcript);
  if (!turns) return false; // an unlabeled transcript never grounds the agreement anyway
  const words = v2?.scheduling?.agreed_slot_words;
  const slotQuotes = (Array.isArray(v2?.evidence) ? v2.evidence : [])
    .filter((e) => e?.speaker === 'agent' && typeof e.quote === 'string'
      && ['/scheduling/confirmed_start_at', '/scheduling/agent_committed_booking'].includes(e.field_path));
  const slotTurns = new Set(slotQuotes.flatMap((e) => turnsHolding(turns, e.quote, 'agent')));
  return turns.some((t) => t.agent && hasNumber(slotTurns.has(t) ? withoutSlotWords(t.raw, words) : t.raw));
}

function priceDiscussed(svc = {}, transcript = '', v1Views = [], v2 = null) {
  const entries = [svc.price, ...(Array.isArray(svc.prices) ? svc.prices : [])];
  return svc.quoted_price_usd != null
    || [svc.price_offered_by_staff, svc.price_accepted_by_caller, svc.price_is_final].some((j) => j != null)
    // V2 quote signals: true counts (any value other than false / null / undefined fails closed)
    || [svc.quote_requested, svc.quote_promised].some((q) => q !== false && q != null)
    || entries.some(hasAmount)
    || (Array.isArray(v1Views) ? v1Views : []).some(v1ViewPriced)
    || PRICE_TALK.test(String(transcript || '').replace(NO_CHARGE, ' '))
    || agentSaidNumber(v2, transcript);
}

// Staff identity on an OUTBOUND recording, independent of who the labels say is who:
// an Agent-labeled turn introduces itself as Waves and no Caller-labeled turn does. A
// swapped or mixed labeling puts the introduction on the Caller side (or on neither),
// and the call holds. The introduction is a plain first-person ASSERTION that OPENS
// the turn (an optional greeting and the customer's name first): "Hey Jennifer, this
// is Adam with Waves." Not a question ("this is Adam with Waves?"), not a negation
// ("this is not Adam with Waves"), not reported speech ("you told me this is Adam
// with Waves": the turn does not start with it).
const NAME_WORD = "(?!(?:not|never|no)\\b)[a-z][a-z'.-]*";
const STAFF_INTRO = new RegExp(
  "^\\s*(?:(?:hi|hello|hey|good\\s+(?:morning|afternoon|evening))\\b[\\s,.!-]*(?:(?!this\\b)[a-z][a-z'.-]*[\\s,.!-]*)?)?"
  + `this\\s+is\\s+${NAME_WORD}(?:\\s+${NAME_WORD}){0,2}\\s*,?\\s+(?:with|from|at)\\s+waves\\b[^.!?]*([.!?]|$)`,
  'i',
);
const ANY_STAFF_INTRO = /\bthis is\s+[a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*){0,2}\s*,?\s+(?:with|from|at)\s+waves\b/i;
function outboundStaffIdentityProven(transcript) {
  const turns = parseTurns(transcript);
  if (!turns) return false;
  const introduces = (turn) => {
    const m = STAFF_INTRO.exec(String(turn.raw || ''));
    return !!m && m[1] !== '?';
  };
  // The exclusion is the LOOSE reading: a Caller turn that says it anywhere ("... this is
  // Jordan with Waves too") already puts the labels in doubt, so it fails closed.
  return turns.some((t) => t.agent && introduces(t)) && !turns.some((t) => !t.agent && ANY_STAFF_INTRO.test(String(t.raw || '')));
}

// The schedule the call must carry before any price or agreement is read.
const SCHEDULE_CHECKS = [
  ['no_scheduling', (sched) => !sched || typeof sched !== 'object'],
  ['not_confirmed', (sched) => sched.status !== 'confirmed' || !sched.confirmed_start_at],
];

// What the no-price assessment mode needs before it grounds the agreement, in order;
// the first that fails is the reason. `t` carries { v2, transcript, assessmentBooking }.
const ASSESSMENT_CHECKS = [
  // The offline audit has no record of the V1 price before V2 adoption: the V1 view is unknown, so hold.
  ['pre_adoption_price_unknown', (t) => t.assessmentBooking.priceRecordMissing === true],
  // A NEW visit only: an extraction that names an existing appointment being moved is a
  // reschedule (call-reschedule-apply.js), never a commercial assessment booking.
  ['moves_existing_visit', (t) => !!t.v2.scheduling.moved_appointment_date || !!t.v2.scheduling.moved_appointment_words
    || t.v2.scheduling.moved_appointment_relative_date_used === true || t.v2.scheduling.status === 'reschedule_requested'],
  // Every service view must resolve to the Waves Assessment row (the caller's check).
  ['assessment_service_not_resolved', (t) => typeof t.assessmentBooking.bookable !== 'function' || t.assessmentBooking.bookable(t.v2) !== true],
  ['outbound_staff_identity_unproven', (t) => t.assessmentBooking.outbound === true && !outboundStaffIdentityProven(t.transcript)],
];
// A price came up (or the assessment mode is off): only the priced path may book it.
const PRICED_PATH_CHECKS = [['price_discussed', (t) => !t.pricedPath], ...PRICE_TERM_CHECKS];

function commercialDictatedBookingGrounded({ v2, transcript, callStartedAt, quoteBookable, pricedPath = true, assessmentBooking = null } = {}) {
  const early = SCHEDULE_CHECKS.find(([, fails]) => fails(v2?.scheduling));
  if (early) return { ok: false, reason: early[0] };
  const svc = v2.service_request || {};
  const noPriceMode = !!assessmentBooking && !priceDiscussed(svc, transcript, assessmentBooking.v1Views, v2);
  const terms = { v2, transcript, assessmentBooking, pricedPath, agreed: resolveCallAgreedPrice(v2), quoted: svc.quoted_price_usd, entry: acceptedEntryFor(svc, svc.quoted_price_usd), quoteBookable };
  const failedTerm = (noPriceMode ? ASSESSMENT_CHECKS : PRICED_PATH_CHECKS).find(([, fails]) => fails(terms));
  if (failedTerm) return { ok: false, reason: failedTerm[0] };
  const grounding = groundNewBookingAgreement({ v2, transcript, callStartedAt, allowAgentProposed: noPriceMode });
  // The priced path also grounds the amount in the staff's own offer quote; no-price has none.
  const reason = (!grounding.ok && grounding.reason) || (grounding.ok && !noPriceMode && priceGrounded(v2, transcript, terms.quoted));
  if (reason) return { ok: false, reason };
  return { ok: true, reason: noPriceMode ? 'assessment_booking_grounded' : 'dictated_booking_grounded', mode: grounding.mode, ...(noPriceMode ? { assessment: true } : {}) };
}

module.exports = { commercialDictatedBookingGrounded, outboundStaffIdentityProven, priceDiscussed };
