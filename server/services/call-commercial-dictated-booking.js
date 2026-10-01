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

const { parseTurns, turnsHolding, spokenFigureRuns } = groundingTools;

// PRICE-LIKE figures said in a text: "$1,500", "150", "150.00", or in words ("a hundred
// forty nine dollars"). A number is NOT a price when its own context says it is a
// time ("at 2:30", "2 PM", "two o'clock", "in the afternoon"), a date ("October 8",
// "the 24th"), a quantity ("2 visits", "three bedrooms") or part of an address or a
// phone number — those must not trip the "no other figure" rules. A dollar-marked
// figure ("$", "dollars", "bucks", "USD") is always a price; any other number with no
// such context counts (fail closed: a bare "250" in a staff turn is a possible
// correction). An ambiguous spoken run ("one fifty") is NaN, never equal to the
// amount, so the offer is not grounded and the office books it (codex #5377 r12 + r13).
const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_RE = new RegExp(`^${MONTHS}$`, 'i');
const DOLLAR_WORDS = new Set(['dollar', 'dollars', 'buck', 'bucks', 'usd']);
const TIME_AFTER = new Set(['am', 'pm', 'oclock', 'clock', 'morning', 'afternoon', 'evening', 'noon', 'tonight']);
const TIME_BEFORE = new Set(['at', 'by', 'around', 'until', 'till', 'before', 'after', 'about']);
const QUANTITY_AFTER = new Set(['visit', 'visits', 'time', 'times', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'minute', 'minutes', 'hour', 'hours', 'treatment', 'treatments', 'unit', 'units', 'bedroom', 'bedrooms', 'bathroom', 'bathrooms',
  'building', 'buildings', 'property', 'properties', 'location', 'locations', 'room', 'rooms', 'story', 'stories', 'floor', 'floors',
  'foot', 'feet', 'ft', 'square', 'sq', 'acre', 'acres', 'people', 'person', 'technician', 'technicians', 'truck', 'trucks',
  'percent', 'employee', 'employees', 'tenant', 'tenants', 'door', 'doors', 'window', 'windows', 'service', 'services', 'application', 'applications']);
const STREET_WORDS = new Set(['st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'blvd', 'boulevard', 'ln', 'lane', 'way', 'ct', 'court', 'pkwy', 'parkway', 'hwy', 'highway', 'circle', 'cir', 'trail', 'trl', 'place', 'pl', 'terrace']);

function nonPriceContext(prev, next) {
  const n0 = next[0];
  if (TIME_AFTER.has(n0)) return true;
  if (n0 === 'in' && ['the', 'a'].includes(next[1]) && TIME_AFTER.has(next[2])) return true;
  if (TIME_BEFORE.has(prev[prev.length - 1])) return true;
  if (['st', 'nd', 'rd', 'th'].includes(n0)) return true;
  if (MONTH_RE.test(prev[prev.length - 1] || '') || MONTH_RE.test(n0 || '')) return true;
  if (prev[prev.length - 1] === 'of' && MONTH_RE.test(next[0] || '')) return true;
  if (QUANTITY_AFTER.has(n0) && !(next[1] && DOLLAR_WORDS.has(next[1]))) return true;
  if (STREET_WORDS.has(n0) || STREET_WORDS.has(next[1])) return true;
  return false;
}

function figuresIn(text) {
  const src = String(text || '');
  const figures = [];
  for (const m of src.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
    const before = src.slice(Math.max(0, m.index - 14), m.index);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const words = (str) => str.toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean);
    const next = words(after).slice(0, 3);
    const prev = words(before).slice(-3);
    const marked = /\$\s*$/.test(before) || DOLLAR_WORDS.has(next[0]) || /^\s*(?:dollars?|bucks?|usd)\b/i.test(after);
    if (!marked) {
      // clock "2:30", a number glued to a suffix ("24th", "2pm") or a phone-number group
      if (/:\s*$/.test(before) || /^\s*:\d/.test(after) || /^(?:st|nd|rd|th|am|pm|a\.m|p\.m)\b/i.test(after)) continue;
      if (/\d-$/.test(before) || /^-\d/.test(after)) continue;
      if (nonPriceContext(prev, next)) continue;
    }
    figures.push(Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`));
  }
  for (const run of spokenFigureRuns(src)) {
    const marked = DOLLAR_WORDS.has(run.next[0]);
    if (!marked && nonPriceContext(run.prev, run.next)) continue;
    figures.push(run.value);
  }
  return figures;
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
  if (agreed.unit && !['one_time', 'per_application', 'unknown'].includes(agreed.unit)) return fail('price_unit_not_bookable');
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
