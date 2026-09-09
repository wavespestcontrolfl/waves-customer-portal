/**
 * Call reschedule apply — when an EXISTING customer calls and the agent
 * moves a visit that is already on the books ("9 is early, can you make it
 * noon?" → "we'll switch it to noon"), apply that move to the visit instead
 * of parking it as a time_ambiguous triage card nobody works.
 *
 * Why: the V2 extraction already pins the outcome (scheduling.status =
 * reschedule_requested, agent_committed_booking, confirmed_start_at, quoted
 * evidence), but nothing consumed it — the visit kept its old window, the
 * 72h/24h reminders would have texted the OLD time, and the office learned
 * about the change only if someone opened the card.
 *
 * Contract (fail-closed — any doubt leaves the card open, untouched):
 *   - the caller is a matched, trusted customer: call_log.customer_id is
 *     set AND the call's counterpart number is that customer's phone on file
 *   - V2 extraction is valid, not spam, not voicemail, scheduling.status is
 *     reschedule_requested, the agent committed the booking, and the
 *     scheduling_window confidence clears MIN_SCHEDULING_CONFIDENCE
 *   - confirmed_start_at is a real future instant on the hour or half hour
 *   - exactly ONE live visit (pending/confirmed/rescheduled, not dispatch-
 *     owned pending, not grouped) of that customer sits within
 *     CANDIDATE_SPAN_DAYS of the target date — two candidates is ambiguous,
 *     zero means the call was about a visit we don't have (the booking lane
 *     owns that), and a grouped visit needs the whole-visit mover's
 *     disclosure a phone call never gave
 *   - the pipeline did not itself create an appointment from this call
 *
 * Apply: SmartRebooker.reschedule (same choke point the admin editor and the
 * customer self-serve reschedule use — occupancy probe, reminder resync,
 * reschedule_log, CAS pin on the row as read) with keepStatus so a pending
 * visit stays pending; the caller's interior/access request is appended to
 * the visit's internal_notes; an activity_log row records the move with the
 * call id (and doubles as the idempotency marker for a reprocess); the
 * call's open reschedule_or_cancel / existing_appointment_coordination
 * cards are resolved with resolution_source 'auto' and call_log.review_status
 * re-synced the way admin-triage's transitionCore does.
 *
 * NO customer communication: no SMS, no email, no appointment card. Owner
 * directive 2026-09-08. The reminder cron picks up the new time on its own.
 *
 * Dark behind GATE_CALL_RESCHEDULE_APPLY (feature-gates.js
 * callRescheduleApply); the processor never blocks on this step.
 */

const logger = require('./logger');
const { etParts, etDateString, etCalendarDayOf, deriveWindowEnd, windowDurationMinutes } = require('../utils/datetime-et');
const { lockTriageCall } = require('../utils/triage-locks');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');

const MIN_SCHEDULING_CONFIDENCE = 0.8;
// A visit within this many days of the requested date is a candidate for
// "the visit the caller meant". Wide enough for "push Thursday to Monday",
// narrow enough that a quarterly cadence (~90 days) never yields two.
const CANDIDATE_SPAN_DAYS = 14;
const LIVE_STATUSES = ['pending', 'confirmed', 'rescheduled'];
const CARD_REASON_CODES = ['reschedule_or_cancel', 'existing_appointment_coordination'];
const ACTIVITY_ACTION = 'call_reschedule_applied';
const RESCHEDULE_REASON_CODE = 'ai_call_reschedule'; // reschedule_log.reason_code varchar(30)
const INITIATED_BY = 'ai_call_pipeline'; // reschedule_log.initiated_by varchar(20)
const DEFAULT_DURATION_MINUTES = 60;

function pad2(n) { return String(n).padStart(2, '0'); }

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function hhmm(value) {
  if (value == null) return null;
  const m = String(value).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad2(Number(m[1]))}:${m[2]}` : null;
}

function calendarDaysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// The number the customer spoke from: the caller on an inbound call, the
// dialed party on an outbound one.
function counterpartPhone(call) {
  if (!call) return null;
  return call.direction === 'outbound' ? (call.to_phone || null) : (call.from_phone || null);
}

function skip(reason, extra = {}) {
  return { action: 'skip', reason, ...extra };
}

/**
 * Pure decision. `candidates` are the customer's live scheduled_services
 * rows (already filtered to LIVE_STATUSES by the loader); `now` is the
 * clock the future-instant check uses.
 */
function planRescheduleFromCall({ v2, call, customer, candidates = [], appointmentCreated = false, now = new Date() } = {}) {
  if (!v2 || typeof v2 !== 'object') return skip('no_v2_extraction');
  if (appointmentCreated) return skip('pipeline_created_appointment');
  if (v2.meta?.is_spam === true) return skip('spam');
  if (v2.meta?.is_voicemail === true) return skip('voicemail');

  const scheduling = v2.scheduling || {};
  if (scheduling.status === 'canceled') return skip('cancel_not_automated');
  if (scheduling.status !== 'reschedule_requested') return skip('not_a_reschedule');
  if (scheduling.agent_committed_booking !== true) return skip('agent_did_not_commit');
  if (!scheduling.confirmed_start_at) return skip('no_confirmed_start');
  const confidence = v2.confidence?.scheduling_window;
  if (typeof confidence !== 'number' || confidence < MIN_SCHEDULING_CONFIDENCE) return skip('low_scheduling_confidence');
  if (v2.caller?.decision_maker_present === false) return skip('caller_not_decision_maker');
  if (v2.consent?.do_not_contact_request === true) return skip('do_not_contact_requested');

  // Identity: matched at ingest AND the spoken-from number is the number on
  // file. A relative calling from their own phone about the customer's
  // visit stays a card.
  if (!call?.customer_id || !customer?.id || String(call.customer_id) !== String(customer.id)) return skip('customer_not_matched');
  const phone = counterpartPhone(call);
  if (!phone || !customer.phone || String(customer.phone) !== String(phone)) return skip('caller_phone_not_on_file');

  const target = new Date(scheduling.confirmed_start_at);
  if (Number.isNaN(target.getTime())) return skip('unparseable_confirmed_start');
  if (target.getTime() <= now.getTime()) return skip('confirmed_start_in_past');
  const parts = etParts(target);
  if (parts.minute !== 0 && parts.minute !== 30) return skip('off_grid_start_time');
  const newDate = etDateString(target);
  const newStart = `${pad2(parts.hour)}:${pad2(parts.minute)}`;

  const nearby = candidates.filter((row) => {
    const d = dateOnly(row.scheduled_date);
    return d && Math.abs(calendarDaysBetween(d, newDate)) <= CANDIDATE_SPAN_DAYS;
  });
  if (nearby.length === 0) return skip('no_visit_on_books');
  if (nearby.length > 1) return skip('ambiguous_visit', { candidateIds: nearby.map((r) => r.id) });
  const visit = nearby[0];
  if (!LIVE_STATUSES.includes(visit.status)) return skip('visit_not_live', { visitId: visit.id });
  if (visit.visit_id) return skip('grouped_visit', { visitId: visit.id });
  if (visit.source_action && DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(visit.source_action) && visit.status === 'pending') {
    return skip('dispatch_owned_pending', { visitId: visit.id });
  }

  const currentDate = dateOnly(visit.scheduled_date);
  const currentStart = hhmm(visit.window_start);
  const duration = windowDurationMinutes(visit.window_start, visit.window_end, visit.estimated_duration_minutes)
    || DEFAULT_DURATION_MINUTES;
  const newEnd = deriveWindowEnd(newStart, duration);
  if (!newEnd) return skip('window_runs_past_midnight', { visitId: visit.id });

  const interiorNote = typeof v2.property?.access_notes === 'string' && v2.property.access_notes.trim()
    ? v2.property.access_notes.trim().slice(0, 300)
    : null;

  if (currentDate === newDate && currentStart === newStart) {
    return { action: 'already_at_requested_time', visitId: visit.id, newDate, newWindow: { start: newStart, end: newEnd }, interiorNote };
  }
  return {
    action: 'apply',
    visitId: visit.id,
    dateMove: currentDate !== newDate,
    from: { date: currentDate, start: currentStart, end: hhmm(visit.window_end) },
    newDate,
    newWindow: { start: newStart, end: newEnd },
    interiorNote,
  };
}

async function loadCandidates(conn, customerId, now = new Date()) {
  return conn('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('status', LIVE_STATUSES)
    .where('scheduled_date', '>=', etDateString(now))
    .orderBy('scheduled_date', 'asc')
    .select('id', 'scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes', 'status', 'source_action', 'visit_id', 'internal_notes', 'is_recurring');
}

// Resolve the call's open reschedule cards and re-sync review_status —
// admin-triage transitionCore's rule: open/in_progress cards remaining keep
// the call 'open', otherwise it takes the applied status.
async function resolveRescheduleCards(conn, callLogId, note) {
  const now = new Date();
  return conn.transaction(async (trx) => {
    await lockTriageCall(trx, callLogId);
    const resolved = await trx('triage_items')
      .where({ call_log_id: callLogId, status: 'open' })
      .whereIn('reason_code', CARD_REASON_CODES)
      .update({ status: 'resolved', resolution_note: note, resolution_source: 'auto', resolved_at: now, updated_at: now })
      .returning('id');
    if (!resolved.length) return 0;
    const remaining = await trx('triage_items')
      .where({ call_log_id: callLogId })
      .whereIn('status', ['open', 'in_progress'])
      .count({ n: '*' })
      .first();
    const next = Number(remaining?.n || 0) > 0 ? 'open' : 'resolved';
    await trx('call_log').where({ id: callLogId }).update({ review_status: next, updated_at: now });
    return resolved.length;
  });
}

// Leave a breadcrumb on the still-open card so the office sees WHY the
// automation stood down instead of wondering whether it ran.
async function stampSkipOnCards(conn, callLogId, plan) {
  const stamp = JSON.stringify({ reschedule_apply: { skipped: plan.reason, at: new Date().toISOString(), ...(plan.candidateIds ? { candidate_visit_ids: plan.candidateIds } : {}) } });
  await conn('triage_items')
    .where({ call_log_id: callLogId, status: 'open' })
    .whereIn('reason_code', CARD_REASON_CODES)
    .update({ payload: conn.raw('COALESCE(payload, \'{}\'::jsonb) || ?::jsonb', [stamp]), updated_at: new Date() });
}

/**
 * Entry point for the processor. Runs after finalization; `procGeneration`
 * fences the pass (a peer that reclaimed the call owns the outcome). Never
 * throws for business reasons — returns { outcome, reason?, visitId? }.
 */
async function applyCallReschedule({ conn, call, customerId, v2, procGeneration = null, appointmentCreated = false, now = new Date(), rebooker = null } = {}) {
  if (!conn || !call?.id) return { outcome: 'skipped', reason: 'missing_context' };

  // Ownership fence: the generation this pass stamped must still be the
  // call's, with no live token (same rule as call-commitments).
  if (procGeneration != null) {
    const owned = await conn('call_log').where({ id: call.id, processing_generation: procGeneration }).whereNull('processing_token').first('id');
    if (!owned) return { outcome: 'skipped', reason: 'superseded_by_newer_pass' };
  }

  // Idempotency: a reprocess of the same call must not move the visit twice.
  const prior = await conn('activity_log')
    .where({ action: ACTIVITY_ACTION })
    .whereRaw("metadata->>'call_log_id' = ?", [String(call.id)])
    .first('id');
  if (prior) return { outcome: 'skipped', reason: 'already_applied' };

  const effectiveCustomerId = call.customer_id || customerId || null;
  const customer = effectiveCustomerId
    ? await conn('customers').where({ id: effectiveCustomerId }).first('id', 'phone')
    : null;
  const candidates = effectiveCustomerId ? await loadCandidates(conn, effectiveCustomerId, now) : [];
  const plan = planRescheduleFromCall({
    v2,
    call: { ...call, customer_id: call.customer_id || effectiveCustomerId },
    customer,
    candidates,
    appointmentCreated,
    now,
  });

  if (plan.action === 'skip') {
    if (plan.reason !== 'not_a_reschedule' && plan.reason !== 'no_v2_extraction') {
      try { await stampSkipOnCards(conn, call.id, plan); } catch (err) { logger.warn(`[call-reschedule] skip stamp failed for call ${call.id}: ${err.message}`); }
    }
    return { outcome: 'skipped', reason: plan.reason, visitId: plan.visitId || null };
  }

  if (plan.action === 'already_at_requested_time') {
    const n = await resolveRescheduleCards(conn, call.id, `Visit ${plan.visitId} already at the requested time (${plan.newDate} ${plan.newWindow.start}); nothing to move.`);
    return { outcome: 'noop', reason: 'already_at_requested_time', visitId: plan.visitId, cardsResolved: n };
  }

  const mover = rebooker || require('./rebooker');
  const visit = candidates.find((r) => r.id === plan.visitId);
  await mover.reschedule(
    plan.visitId,
    plan.newDate,
    { start: plan.newWindow.start, end: plan.newWindow.end },
    RESCHEDULE_REASON_CODE,
    INITIATED_BY,
    {
      keepStatus: true,
      // A same-day window edit is single-row by the rebooker's own rule; pin
      // it explicitly so a cadence visit never fans out to its series from a
      // phone call. A date move on a recurring visit follows the owner's
      // "schedule follows the last treatment" ruling via the default policy.
      ...(plan.dateMove ? {} : { seriesPolicy: 'single' }),
      // CAS on the row as read: a concurrent operator move between our read
      // and the write surfaces as the rebooker's SLOT/409 instead of a
      // silent overwrite.
      expect: {
        scheduled_date: dateOnly(visit.scheduled_date),
        window_start: visit.window_start,
        window_end: visit.window_end,
      },
    },
  );

  const callDay = etCalendarDayOf(call.created_at || now);
  if (plan.interiorNote) {
    const line = `Call ${callDay}: ${plan.interiorNote}`;
    const existing = visit.internal_notes ? String(visit.internal_notes).trimEnd() : '';
    if (!existing.includes(plan.interiorNote)) {
      await conn('scheduled_services').where({ id: plan.visitId }).update({
        internal_notes: existing ? `${existing}\n${line}` : line,
        updated_at: new Date(),
      });
    }
  }

  const moveText = plan.dateMove
    ? `${plan.from.date} ${plan.from.start || '--'} → ${plan.newDate} ${plan.newWindow.start}`
    : `${plan.from.start || '--'} → ${plan.newWindow.start} on ${plan.newDate}`;
  await conn('activity_log').insert({
    customer_id: effectiveCustomerId,
    action: ACTIVITY_ACTION,
    description: `Visit moved from the customer's call (${moveText})${plan.interiorNote ? '; access note added' : ''}. No customer message sent.`,
    metadata: JSON.stringify({
      call_log_id: String(call.id),
      scheduled_service_id: String(plan.visitId),
      from: plan.from,
      to: { date: plan.newDate, ...plan.newWindow },
      interior_note_added: !!plan.interiorNote,
      processing_generation: procGeneration,
    }),
  });

  let cardsResolved = 0;
  try {
    cardsResolved = await resolveRescheduleCards(conn, call.id, `Applied from the call: visit ${plan.visitId} moved ${moveText}. No customer message sent.`);
  } catch (err) {
    logger.warn(`[call-reschedule] card resolve failed for call ${call.id} (visit moved): ${err.message}`);
  }
  logger.info(`[call-reschedule] call ${call.id}: visit ${plan.visitId} moved ${moveText}; cards resolved=${cardsResolved}`);
  return { outcome: 'applied', visitId: plan.visitId, newDate: plan.newDate, newWindow: plan.newWindow, cardsResolved };
}

module.exports = {
  applyCallReschedule,
  planRescheduleFromCall,
  loadCandidates,
  resolveRescheduleCards,
  MIN_SCHEDULING_CONFIDENCE,
  CANDIDATE_SPAN_DAYS,
  CARD_REASON_CODES,
  ACTIVITY_ACTION,
  RESCHEDULE_REASON_CODE,
  INITIATED_BY,
};
