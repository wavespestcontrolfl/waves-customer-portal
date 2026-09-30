/**
 * Commercial dictated booking — the SECOND path (beside, never a relaxation
 * of, hasAgentCommittedEvidence in call-triage-flags.js) that clears the
 * commercial_requires_quote hold.
 *
 * Owner ruling 2026-09-30 (call-booker gates review, item 8): a commercial
 * job that Waves staff dictate on the call — and the caller accepts —
 * auto-books instead of always going to the office, on inbound AND outbound
 * calls. This builds on the owner's 2026-09-24 rule ("staff booking a
 * commercial job on the recording clears the quote hold"), whose strict
 * agent-commit check rejected nearly every real call.
 *
 * Safety (owner-approved, the same method as reschedules): BOTH the staff
 * commitment quote and the caller's acceptance quote must be found word for
 * word in a turn of the right speaker. That is exactly what
 * call-reschedule-agreement.js groundRescheduleAgreement checks, and it is
 * reused here UNCHANGED (no new matcher): the pinned agent commitment, the
 * caller's acceptance, the agreed slot and its words, and the extraction's
 * own language judgements (definite_commitment, relative_date_used). It fails
 * closed on an unlabeled transcript, on a transcript with one speaker, and
 * when a quote appears only in the other speaker's turn — so a swapped
 * speaker label cannot ground a caller's own sentence as staff's promise.
 *
 * On top of that grounding, this path adds only what a NEW commercial booking
 * needs:
 *   - a price was agreed on the call (the one shared reading,
 *     utils/call-agreed-price.js; a range is not a price). No price agreed →
 *     the job still goes to the office for a quote.
 *   - it books a NEW visit: an extraction that also names an existing
 *     appointment being moved is a reschedule, never a commercial booking.
 * canAutoRoute (call-triage-flags.js) applies the rest — a confirmed start on
 * the hour, GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS — and keeps every other
 * hold, address validation and capacity check exactly as they were. Only
 * commercial_requires_quote is cleared, and it rides in failedOpenFlags so the
 * office still gets the advisory card (book-and-flag, never book-and-hide).
 *
 * Contract: commercialDictatedBookingGrounded({ v2, transcript, callStartedAt })
 *   -> { ok, reason }
 */
'use strict';

const { groundRescheduleAgreement } = require('./call-reschedule-agreement');
const { resolveCallAgreedPrice } = require('../utils/call-agreed-price');

function commercialDictatedBookingGrounded({ v2, transcript, callStartedAt } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const scheduling = v2?.scheduling;
  if (!scheduling || typeof scheduling !== 'object') return fail('no_scheduling');
  if (scheduling.status !== 'confirmed' || !scheduling.confirmed_start_at) return fail('not_confirmed');
  // A NEW booking: naming an existing visit being moved (or a relative form of
  // it) is a reschedule — the reschedule apply path owns that, never this one.
  if (scheduling.moved_appointment_date || scheduling.moved_appointment_relative_date_used === true) return fail('moves_existing_visit');
  // A price was agreed on the call. A range ("$90 to $100") is not one price.
  const agreed = resolveCallAgreedPrice(v2);
  if (!agreed) return fail('no_price_agreed');
  if (agreed.amountMax != null || (agreed.additionalTerms || []).some((t) => t.amountMax != null)) return fail('price_is_a_range');
  const grounding = groundRescheduleAgreement({ v2, transcript, callStartedAt });
  if (!grounding.ok) return fail(grounding.reason);
  return { ok: true, reason: 'dictated_booking_grounded' };
}

module.exports = { commercialDictatedBookingGrounded };
