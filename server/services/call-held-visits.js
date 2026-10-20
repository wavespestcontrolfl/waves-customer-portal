/**
 * Held visits: the "Promised on a call, not booked" strip on admin Dispatch.
 *
 * Owner 2026-10-12: when staff agree a visit with a caller on a recorded call
 * and nothing is on the calendar for it, show that visit on the day as a
 * display-only HELD row with a "Book it" button. Display only: it writes no
 * visit, no customer and no message.
 *
 * Two kinds of row, both read from the stored V2 extraction
 * (call_log.ai_extraction_enriched, a jsonb object or a JSON string):
 *   confirmed - scheduling.status 'confirmed' with a concrete slot on the
 *               requested ET date (the same slot the booking-miss watchdog
 *               pages on; its helpers are reused here, not copied).
 *   day_only  - a requested / offered / ambiguous visit on a two-party call whose date
 *               range is exactly the requested day, with no time ("time not set"). It is
 *               NOT a confirmed visit: the strip labels it "Day discussed on a call" and
 *               staff decide whether to book it (owner 2026-10-12, "day too").
 *               Never a voicemail, spam, or a call that ended with nothing to do
 *               (the canonical callEndedWithNothingToDo rule).
 * One row per call; confirmed wins when a call qualifies as both.
 *
 * A "reschedule" with no visit on file is a confirmed row too (call audit 2026-10-13). A
 * caller who says "I booked yesterday and got no confirmation" is read as moving a visit
 * (scheduling.status 'reschedule_requested'), and that status never books. When staff
 * committed to the new slot (agent_committed_booking, or definite_commitment with no explicit
 * "did not commit"), the caller accepted it, and the call's own customer has no other
 * visit on file from the call day on (live, or parked at 'rescheduled' for a rebook), there
 * is nothing to move: the agreed slot is a promised visit that is not on the calendar. A
 * customer with any such visit stays with the reschedule card, and so does an unlinked call
 * (nothing says whether a visit exists).
 *
 * A third kind, move_day_only (owner 2026-10-19, call audit 2026-10-19): staff and an EXISTING
 * customer agreed to MOVE a visit to a new day but set no time. The call's extraction reads
 * scheduling.status 'reschedule_requested' with moved_appointment_date (the visit to move) and a
 * one-day range on the new day; call-reschedule-apply skips it because that apply needs an exact
 * hour, so the visit stayed where it was and only a blocking reschedule_or_cancel card exists. It
 * shows on the TARGET day as "Move discussed on a call - from <old day>, time not set" (NOT
 * CONFIRMED), beside a link to the visit to move. Display only: nothing moves and no text goes.
 * It needs no commitment evidence (the extractor fills agent_committed_booking / caller_accepted_slot
 * only for a timed slot; the day_only kind asks for none either): only that staff did not explicitly
 * refuse (agent_committed_booking false) and the caller did not (caller_accepted_slot false). It also
 * needs a linked customer, a target day that is today or later, and a
 * live visit of that customer on the old day. It clears when that visit is gone from the old day
 * (moved, cancelled, rescheduled), when the customer has a live visit on the target day, when a
 * visit carries the call, or when the office closed the call's cards.
 *
 * A held row clears when the office has acted:
 *   - a visit carries the call: source_call_log_id, or a call marker in its notes or internal
 *     notes ("Call ID: <call_log id>", which "Book it" prefills, or the pipeline's "Call SID:"),
 *     on any date, under any customer;
 *   - the call's customer has a live visit on the promised day (for a confirmed slot, inside
 *     the watchdog's window tolerance of the agreed time);
 *   - a namesake account booked the confirmed slot after the call (the watchdog rule);
 *   - the office closed the call's triage cards.
 * "Live" is on the calendar or done, or a legacy row with no status; a skipped, cancelled or
 * rescheduled visit never counts. Nothing is inferred from a phone number or an address: a
 * shared number or a same-street address is not proof. Known limit: an UNLINKED call that staff
 * book by hand, outside "Book it", keeps its row until they close the call's cards or the day
 * passes.
 * Dates come from to_char in SQL, never a JS
 * Date round-trip. Dark behind GATE_CALL_HELD_VISIT; read-only.
 */

const db = require('../models/db');
const {
  extractConfirmedSlot,
  rowCarriesCall,
  rowClearsSlot,
  namesakeRowClearsSlot,
  loadNamesakeAccounts,
  officeClosedCall,
  NAMESAKE_LIVE_STATUSES: LIVE_STATUSES,
} = require('./call-booking-miss-watchdog');
const { etDateString } = require('../utils/datetime-et');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
const { callEndedWithNothingToDo } = require('./call-triage-flags');

const LOOKBACK_DAYS = 30;
const NOTES_MAX_CHARS = 200;
const DAY_ONLY_STATUSES = new Set(['requested', 'offered', 'ambiguous']);
// Not a visit request at all: never a day-only row. A 'no_action_needed' call is judged by the
// canonical rule instead (callEndedWithNothingToDo): a requested visit the caller did not drop
// is still open, whatever the disposition field says.
const CLOSED_DISPOSITIONS = new Set(['spam_discarded', 'wrong_number_closed', 'vendor_logged']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAYPARTS = new Set(['morning', 'afternoon', 'evening']);
// A visit the reschedule could be moving: on the calendar or done, or parked for a rebook.
const onFileForMove = (status) => isLive(status) || status === 'rescheduled';

// Staff's side of a move agreement, and the caller's acceptance of it. Staff: the commitment flag, or
// the firm-promise judgement the extraction records beside the agreed slot; an explicit "staff did
// not commit" wins. Used by the timed move (agreedMoveSlot) only: a timed slot is what the extractor
// fills these fields for.
function staffAgreedMove(sched) {
  const staffCommitted = sched.agent_committed_booking !== false
    && (sched.agent_committed_booking === true || sched.definite_commitment === true);
  return staffCommitted && sched.caller_accepted_slot === true;
}

// The slot a 'reschedule_requested' call agreed, when staff committed to it and the caller
// accepted it on a linked customer's call. Whether there is a visit to move is decided later,
// against the customer's visits (movesAVisitOnFile).
function agreedMoveSlot(call, extraction) {
  const sched = extraction.scheduling || {};
  if (!call.customer_id || sched.status !== 'reschedule_requested') return null;
  if (!staffAgreedMove(sched)) return null;
  return extractConfirmedSlot({ ...extraction, scheduling: { ...sched, status: 'confirmed' } });
}

// Does the customer of a moved-slot candidate have a visit the call could be moving? Any visit
// of theirs from the call day on that does not carry this call.
function movesAVisitOnFile({ call }, bookedRows) {
  const callDayET = etDateString(new Date(call.created_at));
  return bookedRows.some((row) => row.customer_id === call.customer_id && onFileForMove(row.status)
    && row.sched_date >= callDayET && !rowCarriesCall(row, call));
}

function parseExtraction(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// A visit that is on the calendar or done. A legacy row with no status is an open visit, as
// everywhere else in the schedule; a skipped, cancelled or rescheduled one is not a booking.
const isLive = (status) => status == null || LIVE_STATUSES.has(status);
const externalPhone = (call) => (String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone) || null;

function timeLabel(minutes) {
  if (!Number.isFinite(minutes)) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// A two-party conversation that is not spam: only that can hold a visit staff agreed or
// discussed. A voicemail (also one that became a lead and reads 'processed') and a spam row
// never do, whatever their extraction says about scheduling.
function isRealConversation(call, extraction) {
  const spamKind = extraction.spam_verdict?.spam_kind;
  return !['voicemail', 'spam'].includes(call.processing_status)
    && extraction.meta?.is_voicemail !== true && call.answered_by !== 'voicemail'
    && (!spamKind || spamKind === 'not_spam');
}

// Is this stored extraction a day-only ask for dateET? A requested / offered / ambiguous visit
// on a two-party call whose date range is exactly that day. Each line is one reason it is not.
function isDayOnlyAsk(call, extraction, dateET, callDayET) {
  const sched = extraction.scheduling || {};
  return [
    DAY_ONLY_STATUSES.has(sched.status),
    // A missing range end is a one-day request (the stored shape triage-auto-resolve reads the same way).
    sched.requested_date_range_start === dateET && (sched.requested_date_range_end || dateET) === dateET,
    call.processing_status === 'processed',
    !CLOSED_DISPOSITIONS.has(extraction.recommended_disposition),
    !callEndedWithNothingToDo(extraction),
    dateET >= callDayET,
  ].every(Boolean);
}

// A day-only move names no time, and the extractor fills agent_committed_booking, definite_commitment
// and caller_accepted_slot only when a time slot exists (prod, 2026-10-19: call 195c40dd has all three
// null). So the row needs no commitment evidence, the bar the day_only kind already uses for a new
// visit: it is display only and labelled NOT CONFIRMED. An explicit "staff did not commit" or "caller
// did not accept" still keeps it off; null or missing passes.
const noExplicitRefusal = (sched) => sched.agent_committed_booking !== false && sched.caller_accepted_slot !== false;

// Is this stored extraction a day-only MOVE onto dateET? Returns the day of the visit to move
// (scheduling.moved_appointment_date), or null. Each line is one reason it is not. The target day
// must be today or later (todayET): a move onto a past day is not something to act on.
function moveDayOnlyFrom(call, extraction, dateET, todayET) {
  const sched = extraction.scheduling || {};
  const from = sched.moved_appointment_date;
  const ok = [
    !!call.customer_id,
    sched.status === 'reschedule_requested',
    noExplicitRefusal(sched),
    // A timed reschedule is never "time not set", even when its commitment flags are missing
    // and agreedMoveSlot returned no slot (Codex #6345 r1): it stays with the reschedule card.
    !String(sched.confirmed_start_at || '').trim() && !String(sched.proposed_start_at || '').trim(),
    sched.requested_date_range_start === dateET && (sched.requested_date_range_end || dateET) === dateET,
    ISO_DATE.test(String(from || '')) && from !== dateET,
    call.processing_status === 'processed',
    !CLOSED_DISPOSITIONS.has(extraction.recommended_disposition),
    !callEndedWithNothingToDo(extraction),
    dateET >= todayET,
  ].every(Boolean);
  return ok ? from : null;
}

// A call row this module may read at all: recent, terminal, with a valid V2 extraction.
function readableCall(call, since) {
  const createdAt = call.created_at ? new Date(call.created_at) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || createdAt.getTime() < since) return null;
  if (call.v2_extraction_status !== undefined && call.v2_extraction_status !== 'valid') return null;
  if (!call.processing_status || call.processing_status === 'processing') return null;
  return createdAt;
}

// Calls that could be held on dateET, before any booking evidence is read.
// Returns [{ call, extraction, kind, minutes, slot, movedFrom }]. confirmed beats day_only; a
// move_day_only candidate is a reschedule with no timed slot at all (movedFrom = the old day).
function heldCandidates(calls, dateET, now = new Date()) {
  const since = now.getTime() - LOOKBACK_DAYS * 86400 * 1000;
  const out = [];
  for (const call of calls) {
    const createdAt = readableCall(call, since);
    const extraction = createdAt && parseExtraction(call.ai_extraction_enriched);
    if (!extraction || !isRealConversation(call, extraction)) continue;
    const moveSlot = agreedMoveSlot(call, extraction);
    const slot = extractConfirmedSlot(extraction) || moveSlot;
    if (slot && slot.dateET === dateET) out.push({ call, extraction, kind: 'confirmed', minutes: slot.minutes, slot, moved: !!moveSlot });
    else if (ISO_DATE.test(dateET) && isDayOnlyAsk(call, extraction, dateET, etDateString(createdAt))) out.push({ call, extraction, kind: 'day_only', minutes: null, slot: null });
    else if (ISO_DATE.test(dateET) && !slot) {
      const movedFrom = moveDayOnlyFrom(call, extraction, dateET, etDateString(now));
      if (movedFrom) out.push({ call, extraction, kind: 'move_day_only', minutes: null, slot: null, movedFrom });
    }
  }
  return out;
}

// Has the office acted on this candidate? One booked row is enough (see the header for each rule).
function clearedByBooking({ call, kind, slot, moved, movedFrom }, bookedRows, { dateET, namesakes }) {
  if (moved && movesAVisitOnFile({ call }, bookedRows)) return true;
  // A day-only move needs a live visit of the customer on the old day: once it is moved,
  // cancelled or rescheduled there is nothing left to move.
  if (kind === 'move_day_only' && !visitsToMove(call, movedFrom, bookedRows).length) return true;
  const sameName = namesakes.get(call.id);
  // The call's own customer has a live visit that day. A confirmed promise has a time, so the
  // visit must sit inside the watchdog's window tolerance (rowClearsSlot): a morning lawn visit
  // never hides an unbooked afternoon slot. A day-only ask has no time.
  const ownOnDay = (row) => !!call.customer_id && row.customer_id === call.customer_id && isLive(row.status) && row.sched_date === dateET
    && (kind !== 'confirmed' || rowClearsSlot(row, call, slot));
  const namesake = (row) => kind === 'confirmed' && !!sameName && sameName.has(row.customer_id) && namesakeRowClearsSlot(row, call, slot);
  return bookedRows.some((row) => rowCarriesCall(row, call) || ownOnDay(row) || namesake(row));
}

// A visit that can still be moved: on the calendar and not started or done. A completed (or
// on-site) visit on the old day means the move is moot (Codex #6345 r1).
const MOVABLE_STATUSES = new Set(['pending', 'confirmed']);
const isMovable = (status) => status == null || MOVABLE_STATUSES.has(status);

// The movable visits a day-only move could mean: the call's customer's, on the old day.
function visitsToMove(call, movedFrom, bookedRows) {
  return bookedRows
    .filter((row) => row.customer_id === call.customer_id && isMovable(row.status) && row.sched_date === movedFrom && !rowCarriesCall(row, call));
}

// The one visit the row links to, only when it is unambiguous: with two movable visits on the
// old day the call did not say which, so the row falls back to the day link (Codex #6345 r1).
function visitToMove(call, movedFrom, bookedRows) {
  const visits = visitsToMove(call, movedFrom, bookedRows);
  return visits.length === 1 ? visits[0] : null;
}

// Who the row is for: the linked customer's name on file, else the name given on the call.
function callerName(call, caller = {}, customerNames) {
  const spoken = caller.name_full || [caller.first_name, caller.last_name].filter(Boolean).join(' ');
  return (call.customer_id && customerNames.get(call.customer_id)) || spoken || 'Unknown caller';
}

const orNull = (value) => value || null;

// The display row for one held candidate.
function heldRow({ call, extraction, kind, minutes, movedFrom }, { dateET, customerNames, bookedRows = [] }) {
  const svc = extraction.property?.service_address || {};
  const request = extraction.service_request || {};
  const sched = extraction.scheduling || {};
  const notes = String(sched.scheduling_notes_raw || '').trim().slice(0, NOTES_MAX_CHARS);
  return {
    call_log_id: call.id,
    kind,
    date_et: dateET,
    minutes,
    time_label: timeLabel(minutes),
    caller_name: callerName(call, extraction.caller, customerNames),
    phone: externalPhone(call),
    address: { line1: orNull(svc.street_line_1), line2: orNull(svc.street_line_2), city: orNull(svc.city), zip: orNull(svc.postal_code) },
    service: orNull(request.specific_service_name || request.primary_service_category),
    call_at: new Date(call.created_at).toISOString(),
    customer_id: orNull(call.customer_id),
    // The part of the day the caller asked for, when there is no agreed time.
    daypart: DAYPARTS.has(sched.preferred_time_of_day) ? sched.preferred_time_of_day : null,
    notes: orNull(notes),
    // A day-only move: the old day and the visit that would move (display and link only).
    ...(kind === 'move_day_only' ? { from_date_et: movedFrom, from_visit_id: orNull(visitToMove(call, movedFrom, bookedRows)?.id) } : {}),
  };
}

// Timed rows by time, then the rows with no time, each group oldest call first.
function byTimeThenCall(a, b) {
  if ((a.minutes === null) !== (b.minutes === null)) return a.minutes === null ? 1 : -1;
  if (a.minutes !== b.minutes) return a.minutes - b.minutes;
  return a.call_at.localeCompare(b.call_at);
}

// Pure. `calls` are call_log rows ({ id, twilio_call_sid, customer_id,
// direction, created_at, from_phone, to_phone, answered_by, processing_status,
// v2_extraction_status, ai_extraction_enriched }); `bookedRows` are
// scheduled_services rows ({ customer_id, status, sched_date ('YYYY-MM-DD'),
// window_start, created_at, source_call_log_id, notes, internal_notes });
// `triageRows` are
// triage_items ({ call_log_id, status, resolution_source }). `namesakes` is
// the watchdog's call id -> Set(customer id) map; `customerNames` maps a
// customer id to "First Last".
function computeHeldVisits(calls, bookedRows, triageRows, {
  dateET, namesakes = new Map(), customerNames = new Map(), now = new Date(),
} = {}) {
  return heldCandidates(calls, dateET, now)
    .filter((candidate) => !clearedByBooking(candidate, bookedRows, { dateET, namesakes }))
    .filter(({ call }) => !officeClosedCall(triageRows.filter((r) => r.call_log_id === call.id)))
    .map((candidate) => heldRow(candidate, { dateET, customerNames, bookedRows }))
    .sort(byTimeThenCall);
}

async function listHeldVisits(dateET, { now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callHeldVisit')) return [];

  // The date text appears verbatim in both storage eras of the extraction
  // (jsonb::text and stringified JSON). A foreign-instant confirmed stamp can
  // land on the neighbouring ET day, so scan three dates; JS decides exactly.
  const neighbour = (offset) => new Date(Date.parse(`${dateET}T12:00:00Z`) + offset * 86400 * 1000).toISOString().slice(0, 10);
  const dateTexts = [dateET, neighbour(-1), neighbour(1)].map((d) => `%${d}%`);
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000);
  const calls = await db('call_log')
    .where('created_at', '>=', since)
    .where({ v2_extraction_status: 'valid' })
    .whereRaw("processing_status IS NOT NULL AND processing_status <> 'processing'")
    .whereNotNull('ai_extraction_enriched')
    // Voice-agent sandbox test calls are ordinary inbound rows; they are never a promised visit.
    .modify((qb) => whereNotSandboxCall(qb))
    .whereRaw('ai_extraction_enriched::text LIKE ANY(?)', [dateTexts])
    .select('id', 'twilio_call_sid', 'customer_id', 'direction', 'created_at', 'from_phone', 'to_phone', 'answered_by',
      'processing_status', 'v2_extraction_status', 'ai_extraction_enriched');
  const candidates = heldCandidates(calls, dateET, now);
  if (!candidates.length) return [];

  const confirmed = candidates.filter((c) => c.kind === 'confirmed');
  const { namesakes } = confirmed.length ? await loadNamesakeAccounts(confirmed) : { namesakes: new Map() };
  const customerIds = [...new Set([
    ...candidates.map((c) => c.call.customer_id).filter(Boolean),
    ...[...namesakes.values()].flatMap((ids) => [...ids]),
  ])];
  const callIds = candidates.map((c) => c.call.id);
  const moved = candidates.filter((c) => c.moved);
  const movedCustomerIds = [...new Set(moved.map((c) => c.call.customer_id))];
  // A day-only move reads the customer's visits on the old day (the visit to move).
  const dayMoves = candidates.filter((c) => c.kind === 'move_day_only');
  const dayMoveCustomerIds = [...new Set(dayMoves.map((c) => c.call.customer_id))];
  const dayMoveFromDates = [...new Set(dayMoves.map((c) => c.movedFrom))];
  const movedSince = moved.map((c) => etDateString(new Date(c.call.created_at))).sort()[0];
  const sidPatterns = candidates.map((c) => c.call.twilio_call_sid).filter(Boolean).map((sid) => `%Call SID: ${sid}%`);

  // "Book it" writes "Call ID: <call_log id>" into the visit's internal notes; the pipeline
  // writes the Twilio SID form. Both are read in either notes column (rowCarriesCall).
  const markerPatterns = [...sidPatterns, ...callIds.map((id) => `%Call ID: ${id}%`)];
  const bookedRows = await db('scheduled_services')
    .where(function heldEvidence() {
      this.whereIn('source_call_log_id', callIds)
        .orWhereRaw('(notes LIKE ANY(?) OR internal_notes LIKE ANY(?))', [markerPatterns, markerPatterns]);
      if (customerIds.length) {
        this.orWhere(function ownOrNamesakeOnDay() {
          this.whereIn('customer_id', customerIds).whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [dateET]);
        });
      }
      if (dayMoves.length) {
        this.orWhere(function dayMoveOldDay() {
          this.whereIn('customer_id', dayMoveCustomerIds).whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ANY(?)", [dayMoveFromDates]);
        });
      }
      // A moved slot is held only when its customer has no visit on file from the call day on.
      if (movedCustomerIds.length) {
        this.orWhere(function movedCustomerVisits() {
          this.whereIn('customer_id', movedCustomerIds).whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') >= ?", [movedSince]);
        });
      }
    })
    .select(
      'id', 'customer_id', 'status', 'window_start', 'created_at', 'source_call_log_id', 'notes', 'internal_notes',
      db.raw("to_char(scheduled_date, 'YYYY-MM-DD') AS sched_date"),
    );
  const triageRows = await db('triage_items').whereIn('call_log_id', callIds).select('call_log_id', 'status', 'resolution_source');
  const linkedIds = [...new Set(candidates.map((c) => c.call.customer_id).filter(Boolean))];
  const people = linkedIds.length ? await db('customers').whereIn('id', linkedIds).select('id', 'first_name', 'last_name') : [];
  const customerNames = new Map(people
    .map((p) => [p.id, [p.first_name, p.last_name].map((v) => String(v || '').trim()).filter(Boolean).join(' ')])
    .filter(([, name]) => name));

  return computeHeldVisits(calls, bookedRows, triageRows, { dateET, namesakes, customerNames, now });
}

module.exports = { computeHeldVisits, listHeldVisits, heldCandidates };
