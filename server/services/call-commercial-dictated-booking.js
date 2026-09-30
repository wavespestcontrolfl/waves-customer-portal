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
 * Contract: commercialDictatedBookingGrounded({ v2, transcript, callStartedAt })
 *   -> { ok, reason }
 */
'use strict';

const { groundNewBookingAgreement, groundingTools } = require('./call-reschedule-agreement');
const { resolveCallAgreedPrice } = require('../utils/call-agreed-price');
// The same validation appointment creation applies to the quoted total
// (resolveCallBookingPrice drops one outside its bounds and books at the
// catalog price or none): reuse it, never copy the bounds.
const { sanitizeQuotedCallPrice } = require('./call-booking-catalog');

const { parseTurns, turnsHolding } = groundingTools;

// Dollar figures said in a text, as numbers ("$1,500", "150", "150.00").
function figuresIn(text) {
  return [...String(text || '').matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)]
    .map((m) => Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`));
}

// The agreed price is real. The extraction JUDGES the language (schema 1.21.0:
// staff offered this amount as Waves' own quote, the caller accepted it, it was
// the final price) and pins a quote for the offer and the acceptance; this code
// only verifies: every judgement is true (a missing one fails closed), each
// quote is word for word in a turn of its required speaker, the offer's turn
// states exactly the recorded amount as a figure (and no other figure), and the
// acceptance comes in a LATER turn than the offer.
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
    .filter(({ turn, quote }) => figuresIn(quote).length > 0 && [quote, turn.raw].every((text) => figuresIn(text).every((n) => n === amount)));
  if (!offers.length) return 'price_not_stated_by_staff';
  // The acceptance answers an offer: it is in a later turn, and no staff turn
  // between the two says another figure (a correction before the "yes").
  const answers = (offer, turn) => {
    const from = turns.indexOf(offer.turn);
    const to = turns.indexOf(turn);
    return to > from && turns.slice(from + 1, to).every((t) => !t.agent || figuresIn(t.raw).every((n) => n === amount));
  };
  const accepted = pinned('/service_request/price_accepted_by_caller', 'caller')
    .some(({ turn }) => offers.some((offer) => answers(offer, turn)));
  return accepted ? null : 'price_not_accepted_by_caller';
}

function commercialDictatedBookingGrounded({ v2, transcript, callStartedAt } = {}) {
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
  // The booking path discards a total outside its accepted range (or with
  // sub-cent precision) and books at the catalog price or none, so the
  // caller's accepted amount would never reach the appointment: the office
  // books it instead.
  if (sanitizeQuotedCallPrice(quoted) !== quoted) return fail('quoted_total_not_bookable');
  const grounding = groundNewBookingAgreement({ v2, transcript, callStartedAt });
  if (!grounding.ok) return fail(grounding.reason);
  const priceFailure = priceGrounded(v2, transcript, quoted);
  if (priceFailure) return fail(priceFailure);
  return { ok: true, reason: 'dictated_booking_grounded', mode: grounding.mode };
}

module.exports = { commercialDictatedBookingGrounded };
