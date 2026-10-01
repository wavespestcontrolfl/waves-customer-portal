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
 * Contract: commercialDictatedBookingGrounded({ v2, transcript, callStartedAt, quoteBookable })
 *   -> { ok, reason }
 */
'use strict';

const { groundNewBookingAgreement, groundingTools } = require('./call-reschedule-agreement');
const { resolveCallAgreedPrice } = require('../utils/call-agreed-price');
// The same validation appointment creation applies to the quoted total
// (resolveCallBookingPrice drops one outside its bounds and books at the
// catalog price or none): reuse it, never copy the bounds.
const { sanitizeQuotedCallPrice } = require('./call-booking-catalog');

const { parseTurns, turnsHolding, spokenFiguresIn } = groundingTools;

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
function statesAmount(text, amount) {
  const str = String(text || '');
  const amounts = amountsIn(str);
  // A dollars-and-cents compound ("one hundred fifty dollars and fifty cents", "150 dollars
  // and 50 cents") reads as two figures: the last figure before "dollars and" and the cents
  // figure after it become ONE amount (150.5), and neither part counts on its own.
  for (const m of str.matchAll(/\bdollars?\s+and\s+([a-z0-9 -]+?)\s+cents?\b/gi)) {
    const dollars = amountsIn(str.slice(0, m.index)).at(-1);
    const cents = amountsIn(m[1]);
    if (dollars == null || cents.length !== 1 || !(cents[0] < 100)) continue;
    for (const part of [dollars, cents[0]]) {
      const i = amounts.indexOf(part);
      if (i >= 0) amounts.splice(i, 1);
    }
    amounts.push(Math.round(dollars * 100 + cents[0]) / 100);
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
  const offers = pinned('/service_request/price_offered_by_staff', 'agent')
    .filter(({ quote }) => statesAmount(quote, amount));
  if (!offers.length) return 'price_not_stated_by_staff';
  const accepted = pinned('/service_request/price_accepted_by_caller', 'caller')
    .some(({ turn }) => offers.some((offer) => turns.indexOf(turn) > turns.indexOf(offer.turn)));
  return accepted ? null : 'price_not_accepted_by_caller';
}

function commercialDictatedBookingGrounded({ v2, transcript, callStartedAt, quoteBookable } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const scheduling = v2?.scheduling;
  if (!scheduling || typeof scheduling !== 'object') return fail('no_scheduling');
  if (scheduling.status !== 'confirmed' || !scheduling.confirmed_start_at) return fail('not_confirmed');
  // A price was agreed on the call. A range ("$90 to $100") is not one price.
  const agreed = resolveCallAgreedPrice(v2);
  if (!agreed) return fail('no_price_agreed');
  if (agreed.amountMax != null || (agreed.additionalTerms || []).some((t) => t.amountMax != null)) return fail('price_is_a_range');
  // More than one accepted term ("$150 to start plus $50/month") is not one
  // price either: booking stamps quoted_price_usd only, so the extra accepted
  // charge would never reach the appointment. The office books it.
  if ((agreed.additionalTerms || []).length) return fail('price_has_multiple_terms');
  // Booking stamps the visit price from quoted_price_usd alone (one accepted
  // total, extraction-compat's quoted_price); an accepted price entry with a
  // billing unit and no quoted total would unlock the booking without that
  // amount ever reaching the appointment, so it is not enough.
  const quoted = v2.service_request?.quoted_price_usd;
  if (typeof quoted !== 'number' || !(quoted > 0) || agreed.amount !== quoted) return fail('no_quoted_total');
  // The booked row carries one per-visit price. A recurring billing unit
  // ("$150 a month") stamped as that price would lose the recurring term, so
  // only a one-time / per-application / unitless amount books here. The
  // schema records a bare "$150" with unit 'unknown' — that is unitless.
  // The unit is read from an ACCEPTED price entry for this exact total:
  // resolveCallAgreedPrice synthesizes a unitless term from quoted_price_usd
  // when no entry matches, so a missing, unaccepted or unit-less entry would
  // otherwise let "$150 a month" book as a bare $150 visit (codex #5377 r15 P1).
  const svc = v2.service_request || {};
  const entries = Array.isArray(svc.prices) && svc.prices.length ? svc.prices : [svc.price];
  const entry = entries.find((e) => e && e.accepted === true && e.amount_usd === quoted && !(e.amount_max_usd > e.amount_usd));
  if (!entry) return fail('no_accepted_price_entry');
  if (!['one_time', 'per_application', 'unknown'].includes(entry.unit)) return fail('price_unit_not_bookable');
  // The booking path discards a total outside its accepted range (or with
  // sub-cent precision) and books at the catalog price or none, so the
  // caller's accepted amount would never reach the appointment: the office
  // books it instead.
  if (sanitizeQuotedCallPrice(quoted) !== quoted) return fail('quoted_total_not_bookable');
  // ...and the catalog-aware half of the same resolver (resolveCallBookingPrice):
  // it discards every quote when the resolved catalog row is recurring or a
  // covered re-service. The caller supplies the check (it alone can load and
  // resolve the catalog row the way the booking does); without one, or when the
  // quote does not survive it, the office books it.
  if (typeof quoteBookable !== 'function' || quoteBookable(quoted, v2) !== true) return fail('price_not_bookable_for_service');
  const grounding = groundNewBookingAgreement({ v2, transcript, callStartedAt });
  if (!grounding.ok) return fail(grounding.reason);
  const priceFailure = priceGrounded(v2, transcript, quoted);
  if (priceFailure) return fail(priceFailure);
  return { ok: true, reason: 'dictated_booking_grounded', mode: grounding.mode };
}

module.exports = { commercialDictatedBookingGrounded };
