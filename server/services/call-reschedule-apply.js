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
 *     scheduling_window confidence clears MIN_SCHEDULING_CONFIDENCE, and
 *     the existing trusted-speaker-label gate is enabled
 *   - confirmed_start_at is a real future instant exactly on the hour
 *   - exactly ONE live visit (pending or confirmed — a row parked at
 *     'rescheduled' awaits a real rebook and stays a card; not dispatch-
 *     owned pending, not an unactivated AI office-review booking, not
 *     grouped) of that customer's service — matched on the row's CATALOG
 *     identity, never on a label a repoint can leave stale — at the
 *     identified property sits within
 *     CANDIDATE_SPAN_DAYS of the target date — two candidates is ambiguous,
 *     zero means the call was about a visit we don't have (the booking lane
 *     owns that); coarse or ambiguous service names stay in review. A
 *     grouped visit needs the whole-visit mover's
 *     disclosure a phone call never gave
 *   - the pipeline did not itself create an appointment from this call
 *   - the customer has no open portal reschedule request for that same
 *     appointment — that is a staff-owned track with its own preferred date,
 *     lifecycle and (legacy flow) parked card hold
 *   - no unanswered reschedule-options SMS offer is outstanding on that
 *     appointment — a later '1'/'2' reply would rebook it onto the stale
 *     offered slot, and closing an offer is reschedule-sms's authority
 *
 * Apply: SmartRebooker.reschedule (same choke point the admin editor and the
 * customer self-serve reschedule use — occupancy probe, reschedule_log, CAS
 * pin on the row as read) with keepStatus so a pending
 * visit stays pending; the caller's interior/access request is appended to
 * the visit's internal_notes; an activity_log row records the move with the
 * call id (and doubles as the idempotency marker for a reprocess); the
 * call's open reschedule_or_cancel / existing_appointment_coordination
 * cards are resolved with resolution_source 'auto' and call_log.review_status
 * re-synced the way admin-triage's transitionCore does.
 *
 * Post-commit fan-out, because the rebooker itself does NOT touch
 * appointment_reminders: a moved /book visit's self_booked_appointments
 * snapshot is synced either way, then a SINGLE move mirrors the other
 * single-visit reschedule callers — appointment_reminders resync (without it
 * the 72h/24h reminder keeps texting the OLD slot, the very failure this
 * service exists to prevent) and the dispatch board broadcast. A series move
 * runs the shared durable effects pass for both instead.
 *
 * NO customer communication: no SMS, no email, no appointment card. Owner
 * directive 2026-09-08. The reminder cron picks up the new time on its own —
 * which is why the reminder resync does NOT set coverDueWindows: covering an
 * already-due window would suppress the only notice of the new time.
 *
 * Dark behind GATE_CALL_RESCHEDULE_APPLY (feature-gates.js
 * callRescheduleApply); the processor never blocks on this step.
 */

const { etParts, etDateString, etCalendarDayOf, deriveWindowEnd, windowDurationMinutes } = require('../utils/datetime-et');
const { lockTriageCall } = require('../utils/triage-locks');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS, OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');
const { hasAgentCommittedEvidence, confirmedStartOnTheHour, etWallClockOfConfirmedStart, statesNewAddress } = require('./call-triage-flags');
const { addressKey } = require('./customer-properties');
const { phoneMatchDigits } = require('../utils/phone');
const { KNOWN_CALLER_PHONE_COLS } = require('../utils/known-caller-phone');
const { stripServiceSuffixes } = require('../utils/service-normalizer');
const { serviceNameCandidates } = require('./service-completion-profiles');
const { assertAdminAppointmentWindow } = require('./scheduling/window-rules');
const { isEnabled } = require('../config/feature-gates');
const { createHash } = require('crypto');
const logger = require('./logger');

const MIN_SCHEDULING_CONFIDENCE = 0.8;
// The uniquely identified occurrence may move within this span. Destination
// proximity never identifies an occurrence among multiple recurring visits.
const CANDIDATE_SPAN_DAYS = 14;
const LIVE_STATUSES = ['pending', 'confirmed', 'rescheduled'];
// Automatic moves take ONLY these. A row parked at 'rescheduled' is out of
// dispatch awaiting a real rebook, and reviving it reaches into the card-hold
// park, the AI office-review supersession rule and job history — none of which
// this path is the authority for (GH codex #4204 r6 P1 x2). It stays a card.
const MOVABLE_STATUSES = ['pending', 'confirmed'];
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
// `direction` keeps Twilio's native values on some paths ('outbound-api',
// 'outbound-dial'), so classify by prefix the way the processor's canonical
// isOutboundCall does — an exact 'outbound' match read those as inbound and
// compared the Waves number instead of the customer's (GH codex #4204 r6 P2).
function counterpartPhone(call) {
  if (!call) return null;
  const outbound = String(call.direction || '').toLowerCase().startsWith('outbound');
  return outbound ? (call.to_phone || null) : (call.from_phone || null);
}

function skip(reason, extra = {}) {
  return { action: 'skip', reason, ...extra };
}

const OFFER_WINDOW_MS = 7 * 86400000;

function offerOptions(row) {
  try {
    const notes = typeof row.notes === 'string' ? JSON.parse(row.notes) : (row.notes || {});
    return !!(notes && (notes.option1 || notes.option2));
  } catch {
    // Unparseable notes are not actionable to reschedule-sms either — its
    // parseOptions helper degrades to {} on the same input.
    return false;
  }
}

async function pendingSmsOffer(conn, customerId, serviceId, now) {
  const rows = await conn('reschedule_log')
    .where({ customer_id: customerId, scheduled_service_id: serviceId })
    .whereNull('customer_response')
    .where('created_at', '>', new Date(now.getTime() - OFFER_WINDOW_MS))
    .select('id', 'notes');
  return (rows || []).find(offerOptions) || null;
}

// Canonical predicate shared by the automatic and staff-reviewed paths. A
// resolved request is only history; every other lifecycle remains owned by
// the portal request workflow and must stand a reschedule down.
function openPortalRequest(conn, customerId, serviceId) {
  return conn('service_requests')
    .where({ customer_id: customerId, category: 'schedule_change' })
    .whereNotIn('status', ['resolved', 'closed', 'cancelled'])
    .where('description', 'like', `Appointment ${serviceId}:%`)
    .first('id');
}

/**
 * Pure decision. `candidates` are the customer's live scheduled_services
 * rows (already filtered to LIVE_STATUSES by the loader); `now` is the
 * clock the future-instant check uses.
 */
function planRescheduleFromCall({ v2, call, customer, properties = [], candidates = [], appointmentCreated = false, now = new Date(), transcriptLabelsTrusted = false, humanOverride = null } = {}) {
  if (!v2 || typeof v2 !== 'object') return skip('no_v2_extraction');
  if (appointmentCreated) return skip('pipeline_created_appointment');
  if (v2.meta?.is_spam === true) return skip('spam');
  if (v2.meta?.is_voicemail === true) return skip('voicemail');

  const scheduling = v2.scheduling || {};
  if (scheduling.status === 'canceled') return skip('cancel_not_automated');
  if (scheduling.status !== 'reschedule_requested') return skip('not_a_reschedule');
  if (!humanOverride && scheduling.agent_committed_booking !== true) return skip('agent_did_not_commit');
  const targetStart = humanOverride ? scheduling.proposed_start_at : scheduling.confirmed_start_at;
  if (!targetStart) return skip(humanOverride ? 'no_proposed_start' : 'no_confirmed_start');
  const confidence = v2.confidence?.scheduling_window;
  if (!humanOverride && (typeof confidence !== 'number' || confidence < MIN_SCHEDULING_CONFIDENCE)) return skip('low_scheduling_confidence');
  if (v2.caller?.decision_maker_present === false) return skip('caller_not_decision_maker');
  if (v2.consent?.do_not_contact_request === true) return skip('do_not_contact_requested');

  // Identity: matched at ingest AND the spoken-from number is the number on
  // file. A relative calling from their own phone about the customer's
  // visit stays a card.
  if (!call?.customer_id || !customer?.id || String(call.customer_id) !== String(customer.id)) return skip('customer_not_matched');
  // ALL five identity columns the pipeline itself treats as on-file (primary,
  // secondary, the three service-contact slots) — the canonical set in
  // known-caller-phone.js. A primary-only check rejected a caller the linker
  // had matched through their secondary/service-contact number and left a
  // valid committed reschedule unapplied (GH codex #4204 r5 P2).
  const phoneKeys = phoneMatchDigits(counterpartPhone(call));
  const onFileKeys = new Set(KNOWN_CALLER_PHONE_COLS.flatMap((col) => phoneMatchDigits(customer[col])));
  if (!phoneKeys.some((key) => onFileKeys.has(key))) return skip('caller_phone_not_on_file');

  const target = new Date(targetStart);
  if (Number.isNaN(target.getTime())) return skip('unparseable_confirmed_start');
  if (target.getTime() <= now.getTime()) return skip('confirmed_start_in_past');
  const parts = etParts(target);
  const onHour = humanOverride ? parts.minute === 0 && target.getUTCSeconds() === 0 : confirmedStartOnTheHour(scheduling.confirmed_start_at);
  if (!onHour || target.getUTCMilliseconds() !== 0) return skip('off_grid_start_time');
  if (!humanOverride && !transcriptLabelsTrusted) return skip('untrusted_speaker_labels');
  if (!humanOverride && !hasAgentCommittedEvidence(v2, call.transcription, call.created_at)) return skip('ungrounded_agent_commitment');
  const newDate = etDateString(target);
  const newStart = `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  if (!humanOverride && etWallClockOfConfirmedStart(scheduling.confirmed_start_at) !== `${newDate}T${newStart}`) return skip('inconsistent_start_offset');

  let targetKey = null;
  let nearby;
  if (humanOverride) {
    nearby = candidates.filter((row) => String(row.id) === String(humanOverride.visitId)
      && String(row.customer_id) === String(customer.id));
  } else {
    const saved = properties.filter((p) => p.active !== false);
    const primaryKey = customer.address_line1 ? addressKey(customer) : null;
    const knownKeys = new Set([primaryKey, ...saved.map((p) => addressKey(p))].filter(Boolean));
    const stated = v2.property?.service_address || {};
    targetKey = statesNewAddress(v2)
      ? (stated.street_line_1 ? addressKey({ address_line1: stated.street_line_1, address_line2: stated.street_line_2,
        city: stated.city, zip: stated.postal_code }) : null)
      : (knownKeys.size === 1 ? [...knownKeys][0] : null);
    if (!targetKey || !knownKeys.has(targetKey)) return skip('property_needs_review');
    const atProperty = candidates.filter((row) => {
      if (row.property_id) return saved.some((p) => String(p.id) === String(row.property_id) && addressKey(p) === targetKey);
      const key = row.service_address_line1 ? addressKey({ address_line1: row.service_address_line1,
        address_line2: row.service_address_line2, city: row.service_address_city, zip: row.service_address_zip }) : primaryKey;
      return key === targetKey;
    });
    if (!atProperty.length) return skip('no_visit_on_books');
    // Match the named service BEFORE proximity. A different program near the
    // destination cannot stand in for the requested visit outside the span.
    // Coarse categories cannot distinguish programs, so absent/ambiguous
    // catalog identity stays in office review.
    const namedServices = new Set(serviceNameCandidates(v2.service_request?.specific_service_name)
      .map((name) => stripServiceSuffixes(name).toLowerCase()));
    // A row that names a catalog service is matched on THAT catalog name only:
    // a repoint leaves scheduled_services.service_type stale, so the label alone
    // can name the requested program while the row now belongs to a different
    // one (admin-schedule.js:14115-14118 documents the same hazard; GH codex
    // #4204 r8 P1). A row whose service_id no longer resolves to a catalog row
    // has no authoritative identity and matches nothing. A row with NO
    // service_id cannot have been repointed — its free-text label is the only
    // identity it ever had, so it keeps matching on that.
    const matchingServices = atProperty.filter((row) => {
      const authoritative = row.service_id ? row.catalog_service_name : row.service_type;
      if (!authoritative) return false;
      return serviceNameCandidates(authoritative).some((name) => namedServices.has(stripServiceSuffixes(name).toLowerCase()));
    });
    const programIds = new Set(matchingServices.map((row) => row.service_id || stripServiceSuffixes(row.catalog_service_name || row.service_type).toLowerCase()));
    if (programIds.size !== 1) return skip('service_needs_review');
    if (matchingServices.length > 1) return skip('ambiguous_visit', { candidateIds: matchingServices.map((r) => r.id) });
    nearby = matchingServices.filter((row) => {
      const d = dateOnly(row.scheduled_date);
      return d && Math.abs(calendarDaysBetween(d, newDate)) <= CANDIDATE_SPAN_DAYS;
    });
  }
  if (nearby.length === 0) return skip('no_visit_on_books');
  const visit = nearby[0];
  if (!LIVE_STATUSES.includes(visit.status)) return skip('visit_not_live', { visitId: visit.id });
  if (!humanOverride && !MOVABLE_STATUSES.includes(visit.status)) return skip('visit_parked_for_rebook', { visitId: visit.id });
  if (visit.visit_id && !(humanOverride && visit.follow_through_group_eligible === true)) return skip('grouped_visit', { visitId: visit.id });
  // An AI office-review booking the office has not activated is not an
  // ordinary visit whatever its status: moving it trips the rebooker's lazy
  // activation, which resolves its review card, arms customer reminders and
  // can open the card-on-file funnel for a booking nobody has vetted — and
  // outbound-review-confirm.js, the authority for that lane, classifies these
  // rows by source membership + customer_confirmed rather than by status
  // (outbound-review-confirm.js:703 and :866-876, which also treats a
  // 'rescheduled' one as superseded). The status-scoped dispatch-owned check
  // below sees only the pending ones (GH codex #4204 r6 P1).
  if (visit.source_action && OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(visit.source_action)
    && (humanOverride || visit.customer_confirmed !== true)) {
    return skip('office_review_unconfirmed', { visitId: visit.id });
  }
  if (visit.source_action && DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(visit.source_action) && visit.status === 'pending') {
    return skip('dispatch_owned_pending', { visitId: visit.id });
  }

  const currentDate = dateOnly(visit.scheduled_date);
  const currentStart = hhmm(visit.window_start);
  const duration = windowDurationMinutes(visit.window_start, visit.window_end, visit.estimated_duration_minutes)
    || DEFAULT_DURATION_MINUTES;
  const newEnd = deriveWindowEnd(newStart, duration);
  if (!newEnd) return skip('window_runs_past_midnight', { visitId: visit.id });
  if (humanOverride) {
    // This is an admin-authored move even though the requested wall clock came
    // from a call. Keep it on the same hour/day-end contract as every other
    // admin schedule writer; the rebooker option below repeats the rule for
    // every independently-sized occurrence in a recurring move.
    assertAdminAppointmentWindow({ windowStart: newStart, windowEnd: newEnd });
  }

  const interiorNote = typeof v2.property?.access_notes === 'string' && v2.property.access_notes.trim()
    ? v2.property.access_notes.trim().slice(0, 300)
    : null;

  if (currentDate === newDate && currentStart === newStart) {
    return { action: 'already_at_requested_time', propertyKey: targetKey, visitId: visit.id, newDate, newWindow: { start: newStart, end: newEnd }, interiorNote };
  }
  return {
    action: 'apply',
    propertyKey: targetKey,
    visitId: visit.id,
    dateMove: currentDate !== newDate,
    from: { date: currentDate, start: currentStart, end: hhmm(visit.window_end) },
    newDate,
    newWindow: { start: newStart, end: newEnd },
    interiorNote,
  };
}

async function loadCandidates(conn, customerId, now = new Date(), { includePast = false } = {}) {
  return conn('scheduled_services')
    .where({ 'scheduled_services.customer_id': customerId })
    .whereIn('scheduled_services.status', LIVE_STATUSES)
    .where('scheduled_services.scheduled_date', '>=', includePast ? etDateString(new Date(now.getTime() - 60 * 86400000)) : etDateString(now))
    .orderBy('scheduled_services.scheduled_date', 'asc')
    // The catalog row is joined because a repoint leaves scheduled_services
    // .service_type stale: matching the label alone can move a DIFFERENT
    // catalog service that happens to still carry the requested name (GH
    // codex #4204 r8 P1). Base table stays unaliased so the column list below
    // is the only qualified part.
    .leftJoin('services', 'services.id', 'scheduled_services.service_id')
    .select('scheduled_services.id', 'scheduled_services.customer_id', 'scheduled_services.property_id',
      'scheduled_services.service_id', 'scheduled_services.service_type', 'scheduled_services.scheduled_date',
      'scheduled_services.window_start', 'scheduled_services.window_end', 'scheduled_services.estimated_duration_minutes',
      'scheduled_services.status', 'scheduled_services.source_action', 'scheduled_services.visit_id',
      'scheduled_services.customer_confirmed',
      'scheduled_services.internal_notes', 'scheduled_services.is_recurring', 'scheduled_services.self_booking_id',
      'scheduled_services.service_address_line1', 'scheduled_services.service_address_line2',
      'scheduled_services.service_address_city', 'scheduled_services.service_address_zip',
      'services.name as catalog_service_name');
}

// Human review chooses the source visit and requested time, then shares the
// automatic path's planner and SmartRebooker choke point. The proposal guard,
// note and audit all commit in the move transaction, including a series move.
async function applyReviewedCallReschedule({ conn, call, v2, customer, candidates, visitId, actorId,
  operationKey, guard, occurrenceIds = [], occurrences, now = new Date(), rebooker = null } = {}) {
  if (!actorId || !operationKey || typeof guard !== 'function') {
    throw new Error('Reviewed reschedule requires an authenticated, uniquely identified proposal guard');
  }
  const plan = planRescheduleFromCall({ call, v2, customer, candidates, now, humanOverride: { visitId } });
  if (plan.action === 'skip') return { outcome: 'skipped', reason: plan.reason };
  const visit = candidates.find((row) => String(row.id) === String(plan.visitId));
  // A date move can sweep the exact recurring set the operator previewed.
  // Lock every affected appointment before checking any competing workflow:
  // the portal request producer holds the same appointment lock through its
  // insert, so each request is either visible here or starts after this move.
  const affectedVisitIds = [...new Set(plan.dateMove && occurrenceIds.length
    ? [visit.id, ...occurrenceIds].map(String) : [String(visit.id)])].sort();
  const beforeMove = async (trx) => {
    await trx('customers').where({ id: customer.id }).forShare().first('id');
    await trx('customer_properties').where({ customer_id: customer.id, active: true }).forShare().select('id');
    await lockTriageCall(trx, call.id);
    await trx('call_log').where({ id: call.id }).forUpdate().first('id');
  };
  const writeReview = async ({ trx }) => {
    const snapshotColumns = ['customer_id', 'property_id', 'service_id', 'service_type', 'status', 'visit_id',
      'is_recurring', 'source_action', 'customer_confirmed', 'self_booking_id', 'window_start', 'window_end',
      'estimated_duration_minutes', 'service_address_line1', 'service_address_line2', 'service_address_city',
      'service_address_zip'];
    const lockedServices = await trx('scheduled_services').whereIn('id', affectedVisitIds)
      .orderBy('id').forUpdate().select();
    const lockedService = lockedServices.find((row) => String(row.id) === String(visit.id));
    if (lockedServices.length !== affectedVisitIds.length || !lockedService
      || dateOnly(lockedService.scheduled_date) !== dateOnly(visit.scheduled_date)
      || snapshotColumns.some((key) => (lockedService[key] ?? null) !== (visit[key] ?? null))) {
      throw Object.assign(new Error('The visit changed. Refresh the proposal.'), { status: 409 });
    }
    for (const affectedVisitId of affectedVisitIds) {
      if (await openPortalRequest(trx, customer.id, affectedVisitId)) {
        throw Object.assign(new Error('A customer portal reschedule request is still open. Use the schedule editor.'), { status: 409 });
      }
      if (await pendingSmsOffer(trx, customer.id, affectedVisitId, now)) {
        throw Object.assign(new Error('A text-message reschedule offer is still open. Use the schedule editor.'), { status: 409 });
      }
    }
    await guard(trx);
    if (plan.interiorNote) {
      // Append against the locked row's current notes so a simultaneous note
      // edit that happened before this transaction is preserved.
      await trx('scheduled_services').where({ id: visit.id }).update({
        internal_notes: trx.raw("concat_ws(E'\\n', NULLIF(internal_notes, ''), ?)",
          [`Call ${etCalendarDayOf(call.created_at || now)}: ${plan.interiorNote}`]),
      });
    }
    await trx('activity_log').insert({
      customer_id: customer.id,
      action: ACTIVITY_ACTION,
      description: 'Requested time applied by staff. No immediate customer message; normal appointment reminders continue.',
      metadata: {
        call_log_id: call.id,
        scheduled_service_id: visit.id,
        actor_id: actorId,
        from: plan.from || null,
        to: { date: plan.newDate, ...plan.newWindow },
        human_override: true,
      },
    });
  };
  if (plan.action === 'already_at_requested_time') {
    await conn.transaction(async (trx) => {
      await beforeMove(trx);
      await writeReview({ trx });
    });
    return { outcome: 'noop', visitId: visit.id };
  }
  const result = await (rebooker || require('./rebooker')).reschedule(
    visit.id,
    plan.newDate,
    occurrenceIds.length ? { start: plan.newWindow.start } : plan.newWindow,
    RESCHEDULE_REASON_CODE,
    'admin',
    {
      actorId,
      pendingConfirmation: true,
      notifyRequested: false,
      skipCallFollowUpShift: true,
      sourceSurface: 'call_reschedule',
      operationKey,
      adminWindowRules: true,
      overlapAdvisory: true,
      // Rechecked by the unit mover under its planning lock, before any
      // member moves. A newly joined sibling was never part of this approval.
      memberGuard: async ({ members }) => {
        if (members.length !== 1 || String(members[0].id) !== String(visit.id)) {
          throw Object.assign(new Error('The visit group changed. Use the schedule editor.'), { status: 409 });
        }
      },
      beforeMove,
      ...(plan.dateMove ? { expectOccurrenceIds: occurrenceIds, expectOccurrences: occurrences } : { seriesPolicy: 'single' }),
      expect: {
        scheduled_date: dateOnly(visit.scheduled_date),
        window_start: visit.window_start,
        window_end: visit.window_end,
        estimated_duration_minutes: visit.estimated_duration_minutes,
        customer_id: visit.customer_id,
        property_id: visit.property_id,
        service_id: visit.service_id,
        service_type: visit.service_type,
        status: visit.status,
        visit_id: visit.visit_id || null,
        source_action: visit.source_action,
        is_recurring: visit.is_recurring,
      },
      moveGuard: writeReview,
    },
  );
  if (visit.self_booking_id) {
    try {
      await conn('self_booked_appointments').where({ id: visit.self_booking_id }).update({
        date: plan.newDate,
        start_time: plan.newWindow.start,
        end_time: plan.newWindow.end,
        updated_at: new Date(),
      });
    } catch (err) {
      logger.warn(`[call-reschedule] self-booking snapshot sync failed for ${visit.id}: ${err.message}`);
    }
  }
  if (result?.seriesMoveId) {
    await require('../routes/admin-dispatch').applySeriesMoveEffects({
      result,
      serviceId: visit.id,
      newDate: plan.newDate,
      newWindow: plan.newWindow,
      notify: false,
      actorId,
      reasonText: null,
    });
  } else {
    try {
      await require('./appointment-reminders').handleReschedule(
        visit.id,
        `${plan.newDate}T${plan.newWindow.start}`,
        { sendNotification: false, expectSchedule: { date: plan.newDate, windowStart: plan.newWindow.start } },
      );
    } catch (err) {
      logger.warn(`[call-reschedule] reminder sync failed for ${visit.id}: ${err.message}`);
    }
    try {
      await require('./dispatch-assignment').emitDispatchJobUpdate({ jobId: visit.id, actorId });
    } catch (err) {
      logger.warn(`[call-reschedule] board broadcast failed for ${visit.id}: ${err.message}`);
    }
  }
  return { outcome: 'applied', visitId: visit.id, newDate: plan.newDate, newWindow: plan.newWindow, warnings: result?.warnings || [] };
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
async function applyCallReschedule({ conn, call, procGeneration = null, appointmentCreated = false, now = new Date(), rebooker = null } = {}) {
  if (!conn || !call?.id) return { outcome: 'skipped', reason: 'missing_context' };
  const settled = await conn('call_log').where({ id: call.id }).whereNull('processing_token')
    .modify((q) => { if (procGeneration != null) q.where('processing_generation', procGeneration); }).first();
  if (!settled) return { outcome: 'skipped', reason: 'superseded_by_newer_pass' };
  if (!settled.customer_id || settled.customer_id !== call.customer_id) return { outcome: 'skipped', reason: 'customer_link_changed' };
  const v2 = settled.v2_extraction_status === 'valid' ? settled.ai_extraction_enriched : null;
  const sourceHash = createHash('sha256').update(JSON.stringify([settled.transcription, v2])).digest('hex');
  // The caller-supplied pre-move guard: customer → property → call locks.
  // The mover runs it AFTER its date-occupancy/tech locks (rung 1) and before
  // its first row lock — taking the customer row first inverted the scheduling
  // ORDERING CONTRACT against a staff create and deadlocked (rebooker.js:1253-
  // 1260 single, :1899-1909 series; GH codex #4204 r5 P1).
  const beforeMove = async (trx) => {
    await trx('customers').where({ id: settled.customer_id }).forShare().first('id');
    await trx('customer_properties').where({ customer_id: settled.customer_id, active: true }).forShare().select('id');
    await lockTriageCall(trx, call.id);
    await trx('call_log').where({ id: call.id }).forUpdate().first('id');
  };
  const prior = await conn('activity_log').where({ action: ACTIVITY_ACTION })
    .whereRaw("metadata->>'call_log_id' = ?", [String(call.id)]).first('metadata');
  if (prior) {
    return conn.transaction(async (trx) => {
      await beforeMove(trx);
      const liveCall = await trx('call_log').where({ id: call.id }).first();
      const proof = typeof prior.metadata === 'string' ? JSON.parse(prior.metadata) : prior.metadata;
      const liveVisit = proof?.scheduled_service_id
        ? await trx('scheduled_services').where({ id: proof.scheduled_service_id }).forShare().first() : null;
      const sameDecision = liveCall && !liveCall.processing_token && liveCall.customer_id === settled.customer_id
        && liveCall.v2_extraction_status === 'valid' && Number(liveCall.processing_generation) === Number(proof?.processing_generation)
        && createHash('sha256').update(JSON.stringify([liveCall.transcription, liveCall.ai_extraction_enriched])).digest('hex') === proof?.source_hash;
      const sameVisit = liveVisit && liveVisit.customer_id === settled.customer_id && LIVE_STATUSES.includes(liveVisit.status)
        && dateOnly(liveVisit.scheduled_date) === proof?.to?.date && hhmm(liveVisit.window_start) === proof?.to?.start
        && hhmm(liveVisit.window_end) === proof?.to?.end;
      if (!sameDecision || !sameVisit) return { outcome: 'skipped', reason: 'prior_application_requires_review' };
      const cardsResolved = await resolveRescheduleCards(trx, call.id, 'This request was already applied from the call.');
      return { outcome: 'skipped', reason: 'already_applied', cardsResolved };
    });
  }
  // The customer's own portal reschedule request for the SAME appointment is a
  // second, staff-owned track for the same ask: it carries its own preferred
  // date, its own lifecycle (acknowledged/scheduled) and, on the legacy flow,
  // a parked card hold. Resolving it from here raced the office and could bury
  // a newer customer preference (GH codex #4204 r6 P1); the automation stands
  // down and leaves the whole request to staff. Predicate mirrors the dedup
  // lookup routes/schedule.js runs against its own rows.
  // An unanswered reschedule-OPTIONS text is a live offer: reschedule-sms's
  // reply handler still honors a '1' or '2' for seven days and rebooks that
  // row's own visit onto the offered slot, which would drag the visit this
  // call just moved straight back to the stale time — the call's new reminder
  // row included (GH codex #4204 r8 P1). Retiring an offer is reschedule-sms's
  // authority, not this path's, so the automation stands down while one is
  // outstanding for the visit it wants to move.
  //
  // The predicate mirrors what reschedule-sms ACTS on, not just its first
  // SELECT: pending (no customer_response), inside its 7-day window, AND
  // carrying the option payload that makes a reply actionable. The window
  // alone is far too broad — every rebooker move writes a response-less
  // reschedule_log audit row (rebooker.js:1526, :2897), so an ordinary staff
  // move last Tuesday would stand this path down for a week. Rows with no
  // options are exactly the ones reschedule-sms skips (its modern rain-out
  // rows ask for no reply).
  const OFFER_WINDOW_MS = 7 * 86400000;
  const offerOptions = (row) => {
    try {
      const notes = typeof row.notes === 'string' ? JSON.parse(row.notes) : (row.notes || {});
      return !!(notes && (notes.option1 || notes.option2));
    } catch {
      // Unparseable notes are not an actionable offer to reschedule-sms
      // either — its own parseOptions degrades to {} on the same input.
      return false;
    }
  };
  const pendingSmsOffer = async (trx, serviceId) => {
    const rows = await trx('reschedule_log')
      .where({ customer_id: settled.customer_id, scheduled_service_id: serviceId })
      .whereNull('customer_response')
      .where('created_at', '>', new Date(now.getTime() - OFFER_WINDOW_MS))
      .select('id', 'notes');
    return (rows || []).find(offerOptions) || null;
  };
  const newerMove = (trx) => trx('reschedule_log')
    .whereIn('scheduled_service_id', trx('scheduled_services').where({ customer_id: settled.customer_id }).select('id'))
    .where('created_at', '>', settled.created_at).first('id');
  if (await newerMove(conn)) return { outcome: 'skipped', reason: 'handled_after_call' };
  const customer = await conn('customers').where({ id: settled.customer_id }).first();
  const properties = await conn('customer_properties').where({ customer_id: settled.customer_id, active: true }).select('*');
  const candidates = await loadCandidates(conn, settled.customer_id, now);
  const plan = planRescheduleFromCall({ v2, call: settled, customer, properties, candidates, appointmentCreated, now, transcriptLabelsTrusted: isEnabled('callAgentCommitTrustedLabels') });
  if (plan.action === 'skip') {
    if (plan.reason !== 'not_a_reschedule' && plan.reason !== 'no_v2_extraction') await stampSkipOnCards(conn, call.id, plan);
    return { outcome: 'skipped', reason: plan.reason, visitId: plan.visitId || null };
  }
  const visit = candidates.find((r) => r.id === plan.visitId);
  if (await openPortalRequest(conn, settled.customer_id, plan.visitId)) {
    await stampSkipOnCards(conn, call.id, { reason: 'portal_request_open', visitId: plan.visitId });
    return { outcome: 'skipped', reason: 'portal_request_open', visitId: plan.visitId };
  }
  if (await pendingSmsOffer(conn, plan.visitId)) {
    await stampSkipOnCards(conn, call.id, { reason: 'pending_sms_offer', visitId: plan.visitId });
    return { outcome: 'skipped', reason: 'pending_sms_offer', visitId: plan.visitId };
  }
  let cardsResolved = 0;
  const note = `Applied from the call: visit ${plan.visitId} at ${plan.newDate} ${plan.newWindow.start}. No customer message sent.`;
  // beforeMove established the customer/call locks before the mover locked
  // the visit. The final fence and all side effects commit with the move.
  const writeDecision = async ({ trx, service }) => {
    await lockTriageCall(trx, call.id);
    const current = await trx('call_log').where({ id: call.id }).forUpdate().first();
    if (!current || current.processing_token || current.customer_id !== settled.customer_id
      || Number(current.processing_generation) !== Number(settled.processing_generation)
      || current.v2_extraction_status !== 'valid'
      || JSON.stringify(current.ai_extraction_enriched) !== JSON.stringify(v2)
      || current.transcription !== settled.transcription) {
      throw Object.assign(new Error('The call changed before its reschedule could apply'), { code: 'CALL_RESCHEDULE_CHANGED' });
    }
    const applied = await trx('activity_log').where({ action: ACTIVITY_ACTION })
      .whereRaw("metadata->>'call_log_id' = ?", [String(call.id)]).first('id');
    if (applied) throw Object.assign(new Error('This call was already applied'), { code: 'CALL_RESCHEDULE_ALREADY_APPLIED' });
    const handled = await trx('triage_items').where({ call_log_id: call.id })
      .whereIn('reason_code', CARD_REASON_CODES)
      .where((q) => q.where('status', 'in_progress').orWhere((closed) => closed
        .where('resolution_source', 'human').whereIn('status', ['resolved', 'dismissed']))).first('id');
    const moved = await newerMove(trx);
    // Under the visit's OWN row lock: routes/schedule.js holds that lock while
    // it inserts the request, so locking here makes a portal submission either
    // visible to this check or forced to start after the move. Its transaction
    // touches only notes/updated_at, neither of which is in this path's CAS,
    // so an unserialized check could be overwritten (GH codex #4204 r7 P2).
    await trx('scheduled_services').where({ id: visit.id }).forUpdate().first('id');
    const portalRequest = await openPortalRequest(trx, settled.customer_id, visit.id);
    // Under the visit's row lock, taken just above. The rebooker writes its
    // own reschedule_log row AFTER this guard, and that row carries no
    // options, so this never stands down on the move it is guarding.
    const smsOffer = await pendingSmsOffer(trx, visit.id);
    if (handled || moved || portalRequest || smsOffer) throw Object.assign(new Error('The request was handled after this call'), { code: 'CALL_RESCHEDULE_HANDLED' });
    const latestCustomer = await trx('customers').where({ id: settled.customer_id }).forShare().first();
    const latestProperties = await trx('customer_properties').where({ customer_id: settled.customer_id, active: true }).forShare().select('*');
    const latestCandidates = await loadCandidates(trx, settled.customer_id, now);
    const checked = planRescheduleFromCall({ v2, call: current, customer: latestCustomer, properties: latestProperties,
      candidates: latestCandidates.map((row) => row.id === visit.id ? { ...row, ...service } : row), appointmentCreated, now, transcriptLabelsTrusted: isEnabled('callAgentCommitTrustedLabels') });
    const unchanged = service && dateOnly(service.scheduled_date) === dateOnly(visit.scheduled_date)
      && ['customer_id', 'property_id', 'service_id', 'service_type', 'status', 'source_action', 'visit_id', 'is_recurring', 'window_start', 'window_end', 'estimated_duration_minutes']
        .every((key) => (service[key] ?? null) === (visit[key] ?? null));
    if (!unchanged || checked.action !== plan.action || checked.visitId !== plan.visitId || checked.propertyKey !== plan.propertyKey) {
      throw Object.assign(new Error('The visit changed before its reschedule could apply'), { code: 'CALL_RESCHEDULE_CHANGED' });
    }
    if (plan.interiorNote) {
      await trx('scheduled_services').where({ id: visit.id }).update({
        internal_notes: trx.raw("CASE WHEN strpos(COALESCE(internal_notes, ''), ?) > 0 THEN internal_notes ELSE concat_ws(E'\\n', NULLIF(internal_notes, ''), ?::text) END",
          [plan.interiorNote, `Call ${etCalendarDayOf(settled.created_at)}: ${plan.interiorNote}`]),
      });
    }
    await trx('activity_log').insert({ customer_id: settled.customer_id, action: ACTIVITY_ACTION, description: note,
      metadata: JSON.stringify({ call_log_id: String(call.id), scheduled_service_id: String(visit.id),
        from: plan.from || null, to: { date: plan.newDate, ...plan.newWindow }, interior_note_added: !!plan.interiorNote,
        processing_generation: current.processing_generation, source_hash: sourceHash }) });
    cardsResolved = await resolveRescheduleCards(trx, call.id, note);
  };
  try {
    if (plan.action === 'already_at_requested_time') {
      await conn.transaction(async (trx) => {
        await beforeMove(trx);
        const service = await trx('scheduled_services').where({ id: visit.id }).forUpdate().first();
        await writeDecision({ trx, service });
      });
      return { outcome: 'noop', reason: 'already_at_requested_time', visitId: visit.id, cardsResolved };
    }
    const result = await (rebooker || require('./rebooker')).reschedule(visit.id, plan.newDate, plan.newWindow, RESCHEDULE_REASON_CODE, INITIATED_BY, {
      keepStatus: true, beforeMove, ...(plan.dateMove ? {} : { seriesPolicy: 'single' }), moveGuard: writeDecision,
      sourceSurface: 'call_reschedule', notifyRequested: false,
      expect: { scheduled_date: dateOnly(visit.scheduled_date), window_start: visit.window_start, window_end: visit.window_end,
        estimated_duration_minutes: visit.estimated_duration_minutes, customer_id: visit.customer_id,
        property_id: visit.property_id, service_id: visit.service_id, service_type: visit.service_type,
        status: visit.status, visit_id: visit.visit_id, source_action: visit.source_action, is_recurring: visit.is_recurring },
    });
    // Post-commit fan-out. A series move runs the shared durable pass; a
    // SINGLE move had NO fan-out at all (GH codex #4204 r8), which defeated
    // this service's own purpose: SmartRebooker never touches
    // appointment_reminders, so the 72h/24h reminder kept the OLD slot — the
    // exact failure this path exists to prevent. Each effect is best-effort
    // after a committed move, the way every other reschedule caller treats
    // them: a socket or snapshot hiccup must not undo the visit move.
    //
    // The /book snapshot first, and for BOTH shapes — the anchor moved either
    // way, and reschedule-public.js:823-839 syncs it ahead of the same split.
    // The public availability builder counts self_booked_appointments for the
    // day cap and GET /api/booking/status/:code reads the date and times back
    // to the customer, so a stale row leaves their confirmation code showing
    // the old appointment forever (GH codex #4204 r8 P2).
    if (visit.self_booking_id) {
      try {
        await conn('self_booked_appointments').where({ id: visit.self_booking_id }).update({
          date: plan.newDate,
          start_time: plan.newWindow.start,
          end_time: plan.newWindow.end,
          updated_at: new Date(),
        });
      } catch (err) {
        logger.warn(`[call-reschedule] self-booking snapshot sync failed for ${visit.id}: ${err.message}`);
      }
    }
    if (result?.seriesMoveId) {
      await require('../routes/admin-dispatch').applySeriesMoveEffects({
        result, serviceId: visit.id, newDate: plan.newDate, newWindow: plan.newWindow,
        notify: false, actorId: null, reasonText: null,
      });
    } else {
      // sendNotification false — this path never messages the customer (owner
      // directive 2026-09-08). Unlike reschedule-sms, coverDueWindows is NOT
      // set: that caller sends its own confirmation text, so it covers the
      // already-due window. We send nothing, so covering it would suppress
      // the only notice the customer gets about the new time. Letting the
      // cron fire the standard reminder at the new slot IS the design.
      try {
        await require('./appointment-reminders').handleReschedule(
          visit.id,
          `${plan.newDate}T${plan.newWindow.start}`,
          { sendNotification: false },
        );
      } catch (err) {
        logger.warn(`[call-reschedule] reminder sync failed for ${visit.id}: ${err.message}`);
      }
      try {
        await require('./dispatch-assignment').emitDispatchJobUpdate({ jobId: visit.id, actorId: null });
      } catch (err) {
        logger.warn(`[call-reschedule] board broadcast failed for ${visit.id}: ${err.message}`);
      }
    }
  } catch (err) {
    const reasons = { CALL_RESCHEDULE_CHANGED: 'changed_before_apply', CALL_RESCHEDULE_HANDLED: 'handled_after_call', CALL_RESCHEDULE_ALREADY_APPLIED: 'already_applied' };
    if (!reasons[err.code]) throw err;
    return { outcome: 'skipped', reason: reasons[err.code], visitId: visit.id };
  }
  return { outcome: 'applied', visitId: visit.id, newDate: plan.newDate, newWindow: plan.newWindow, cardsResolved };
}

module.exports = {
  applyReviewedCallReschedule,
  applyCallReschedule,
  planRescheduleFromCall,
  loadCandidates,
  resolveRescheduleCards,
  MIN_SCHEDULING_CONFIDENCE,
  CANDIDATE_SPAN_DAYS,
  CARD_REASON_CODES,
  MOVABLE_STATUSES,
  ACTIVITY_ACTION,
  RESCHEDULE_REASON_CODE,
  INITIATED_BY,
};
