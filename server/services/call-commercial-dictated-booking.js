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
 *     price entry alone is not enough, owner-safe: it carries billing units the
 *     visit price cannot), a staff turn that states that amount, and the
 *     caller's affirmative reply as the first caller turn after it. No price
 *     agreed → the job still goes to the office for a quote.
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

const { parseTurns, turnsHolding, plainlySaid, normalize } = groundingTools;

// A caller's reply that agrees: it carries an affirmation word and, being read
// with plainlySaid(askingFails), is neither a question nor negated or hedged.
const AFFIRM_TOKENS = new Set(['yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'alright', 'deal', 'works', 'good', 'fine', 'perfect', 'great', 'agreed', 'go']);

// Dollar figures said in a text, as numbers ("$1,500", "150", "150.00").
function figuresIn(text) {
  return [...String(text || '').matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)]
    .map((m) => Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`));
}

// The agreed price is real: staff stated exactly this amount in a staff turn,
// and the FIRST caller turn after it is the caller's plain, affirmative reply.
// Both are quotes the extraction pinned to service_request.quoted_price_usd
// (prompt: "quote the agent's price and the caller's acceptance"), each found
// word for word in a turn of its speaker.
function priceGrounded(v2, transcript, amount) {
  const turns = parseTurns(transcript);
  if (!turns || new Set(turns.map((t) => t.agent)).size < 2) return 'price_ungrounded';
  const evidence = (Array.isArray(v2.evidence) ? v2.evidence : [])
    .filter((e) => e?.field_path === '/service_request/quoted_price_usd' && typeof e.quote === 'string');
  const staffTurns = evidence.filter((e) => e.speaker === 'agent').flatMap((e) => {
    const holding = turnsHolding(turns, e.quote, 'agent');
    const said = figuresIn(e.quote);
    // The quote states exactly the agreed amount, and no other dollar figure
    // is in the turns that hold it.
    const clean = holding.length > 0 && said.length > 0 && said.every((n) => n === amount)
      && holding.every((t) => figuresIn(t.raw).every((n) => n === amount) && plainlySaid(t, e.quote, {}));
    return clean ? holding : [];
  });
  if (!staffTurns.length) return 'price_not_stated_by_staff';
  const replies = evidence.filter((e) => e.speaker === 'caller').filter((e) => {
    const holding = turnsHolding(turns, e.quote, 'caller');
    return holding.length > 0 && normalize(e.quote).split(' ').some((t) => AFFIRM_TOKENS.has(t))
      && holding.every((t) => plainlySaid(t, e.quote, { askingFails: true }));
  });
  const firstCallerReply = (staffTurn) => turns.slice(turns.indexOf(staffTurn) + 1).find((t) => !t.agent);
  const accepted = staffTurns.some((st) => {
    const reply = firstCallerReply(st);
    return reply && replies.some((e) => turnsHolding(turns, e.quote, 'caller').includes(reply));
  });
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
  // Booking stamps the visit price from quoted_price_usd alone (one accepted
  // total, extraction-compat's quoted_price); an accepted price entry with a
  // billing unit and no quoted total would unlock the booking without that
  // amount ever reaching the appointment, so it is not enough.
  const quoted = v2.service_request?.quoted_price_usd;
  if (typeof quoted !== 'number' || !(quoted > 0) || agreed.amount !== quoted) return fail('no_quoted_total');
  const grounding = groundNewBookingAgreement({ v2, transcript, callStartedAt });
  if (!grounding.ok) return fail(grounding.reason);
  const priceFailure = priceGrounded(v2, transcript, quoted);
  if (priceFailure) return fail(priceFailure);
  return { ok: true, reason: 'dictated_booking_grounded', mode: grounding.mode };
}

module.exports = { commercialDictatedBookingGrounded };
