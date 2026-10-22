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
 *   - the AUTOMATIC path (not humanOverride) moves only on the extraction's
 *     own judgement that the caller accepted the final slot
 *     (scheduling.caller_accepted_slot, schema 1.16.0), grounded by
 *     call-reschedule-agreement.js: the agent's commitment, the caller's
 *     acceptance and the agreed-slot quote each appear word for word in a
 *     turn of their speaker, and the words the extraction recorded for the
 *     agreed time (scheduling.agreed_slot_words, schema 1.17.0) sit in that
 *     quote and state the slot
 *   - confirmed_start_at is a real future instant exactly on the hour
 *   - exactly ONE upcoming live visit (pending or confirmed — a row parked
 *     at 'rescheduled' awaits a real rebook and stays a card; not dispatch-
 *     owned pending, not an unactivated AI office-review booking, not
 *     grouped) of the service the call names — matched on the row's CATALOG
 *     identity, never on a label a repoint can leave stale — at the
 *     identified property, on the date of the appointment being moved when
 *     the extraction grounded one (scheduling.moved_appointment_date),
 *     within CANDIDATE_SPAN_DAYS of the target date. Two is ambiguous; none
 *     in span means the call was about a visit we don't have (the booking
 *     lane owns that). A call naming no service or one
 *     that matches nothing, a call V2 files under more than one service
 *     category, or a visit at the property with no service identity to weigh
 *     (its catalog row gone, or the catch-all placeholder) stays in review.
 *     A grouped visit needs the whole-visit mover's disclosure a phone call
 *     never gave
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

const { etParts, etDateString, addETDays, etCalendarDayOf, deriveWindowEnd, windowDurationMinutes } = require('../utils/datetime-et');
const { callStartedAt } = require('../utils/call-timeline');
const { lockTriageCall } = require('../utils/triage-locks');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS, OFFICE_REVIEW_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');
const { confirmedStartOnTheHour, etWallClockOfConfirmedStart, statesNewAddress } = require('./call-triage-flags');
const { groundRescheduleAgreement } = require('./call-reschedule-agreement');
const { lineOfV2Category, lineOfServiceName, linesOfServiceName } = require('./call-estimate-service-match');
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
// A visit is a candidate only within this span of the target date. Nearness
// never picks among several upcoming visits (planRescheduleFromCall).
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
// The catch-all booking placeholder ("Waves Pest Control Appointment"): its
// real service is assigned after the first assessment.
const PLACEHOLDER_SERVICE_KEY = 'general_appointment';

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

function isOutboundDirection(call) {
  return String(call?.direction || '').toLowerCase().startsWith('outbound');
}

function callMetadata(call) {
  const meta = call?.metadata;
  if (!meta) return {};
  if (typeof meta === 'string') {
    try { return JSON.parse(meta) || {}; } catch { return {}; }
  }
  return meta;
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

function openPortalRequest(conn, customerId, serviceId) {
  return conn('service_requests')
    .where({ customer_id: customerId, category: 'schedule_change' })
    .whereNotIn('status', ['resolved', 'closed', 'cancelled'])
    .where('description', 'like', `Appointment ${serviceId}:%`)
    .first('id');
}

// A person owns or closed the card: claimed (in progress), or resolved or
// dismissed by a human.
const humanHandledCardStatus = (q) => q.where('status', 'in_progress').orWhere((closed) => closed
  .where('resolution_source', 'human').whereIn('status', ['resolved', 'dismissed']));

// Excluding the proposal under review lets staff apply a claimed card while
// another claimed or human-closed card still proves the request was handled.
function humanHandledRescheduleCard(conn, callLogId, { excludeId = null } = {}) {
  const query = conn('triage_items').where({ call_log_id: callLogId })
    .whereIn('reason_code', CARD_REASON_CODES)
    .where(humanHandledCardStatus);
  if (excludeId) query.whereNot('id', excludeId);
  return query.first('id');
}

// The catalog name a visit is matched on: its catalog row's name when it has
// one (a repoint can leave service_type stale), else, for a row that never
// had a catalog row, its own label. Null when its catalog row no longer
// resolves — including a row that lost it, whose key snapshot survives the
// catalog delete's ON DELETE SET NULL — or is the placeholder, which names
// no service yet.
function authoritativeServiceName(row) {
  if (!row.service_id) return row.service_key_snapshot ? null : row.service_type;
  return row.catalog_service_key === PLACEHOLDER_SERVICE_KEY ? null : row.catalog_service_name;
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
  if (humanOverride && scheduling.agent_committed_booking === true) return skip('agent_committed_booking');
  if (humanOverride && scheduling.confirmed_start_at) return skip('confirmed_start_supersedes_proposal');
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
  // The automatic path moves a visit only on the extraction's own judgement
  // that the caller agreed, grounded in its verbatim quotes
  // (call-reschedule-agreement.js), which also yields the appointment being
  // moved when the call named one. humanOverride is a person's decision.
  let movedDate = null;
  if (!humanOverride) {
    const agreement = groundRescheduleAgreement({ v2, transcript: call.transcription, callStartedAt: callStartedAt(call) || call.created_at });
    if (!agreement.ok) return skip('reschedule_not_agreed', { agreementReason: agreement.reason });
    movedDate = agreement.movedDate;
  }
  const newDate = etDateString(target);
  const newStart = `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  if (etWallClockOfConfirmedStart(targetStart) !== `${newDate}T${newStart}`) return skip('inconsistent_start_offset');

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
    const serviceRequest = v2.service_request || {};
    // A call V2 files under more than one service ("move my pest and lawn
    // visits to Thursday") may cover a visit this path would leave unmoved
    // while it resolves the call's card: review.
    if (serviceRequest.secondary_categories?.length) return skip('service_needs_review');
    // A visit with no service identity to weigh (its catalog row gone, or the
    // placeholder) may be the one the caller means, whatever the call names.
    if (atProperty.some((row) => !authoritativeServiceName(row))) return skip('service_needs_review');
    // Only visits of the service the call names. Coarse categories cannot
    // tell programs apart, so a call naming no service, or one the customer
    // does not have, stays in review. A row that names a catalog service is
    // matched on THAT catalog name only: a repoint leaves
    // scheduled_services.service_type stale, so the label alone can name the
    // requested program while the row now belongs to a different one.
    const namedServices = new Set(serviceNameCandidates(serviceRequest.specific_service_name)
      .map((name) => stripServiceSuffixes(name).toLowerCase()));
    const today = etDateString(now);
    const upcoming = atProperty.filter((row) => dateOnly(row.scheduled_date) >= today
      && serviceNameCandidates(authoritativeServiceName(row)).some((name) => namedServices.has(stripServiceSuffixes(name).toLowerCase())));
    if (!upcoming.length) return skip('service_needs_review');
    // Which visit the call moves: the one on the date the extraction grounded
    // as the appointment being moved (scheduling.moved_appointment_date).
    // Without it nothing on the call ties it to one of several upcoming
    // visits: nearness picks September for "move December to October 1", and
    // even a time change on the destination day can mean another ("move the
    // later one to the 24th at noon"). Only a sole candidate within the span
    // is taken; a named date with no visit of the service is one we don't have.
    const moving = upcoming.filter((row) => !movedDate || dateOnly(row.scheduled_date) === movedDate);
    if (moving.length > 1) return skip('ambiguous_visit', { candidateIds: moving.map((r) => r.id) });
    nearby = moving.filter((row) => Math.abs(calendarDaysBetween(dateOnly(row.scheduled_date), newDate)) <= CANDIDATE_SPAN_DAYS);
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
  if (OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(visit.source_action)
    && (humanOverride || visit.customer_confirmed !== true)) {
    return skip('office_review_unconfirmed', { visitId: visit.id });
  }
  // Reviewed Apply deliberately asks the mover to restore pending
  // confirmation. A dispatch-owned row may already be confirmed and visible,
  // but sending it through that contract would hide it from the customer
  // schedule again. Keep the whole source-owned workflow in the schedule
  // editor; the automatic path retains its narrower pending-row guard.
  if (humanOverride && DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(visit.source_action)) {
    return skip('dispatch_owned_workflow', { visitId: visit.id });
  }
  if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(visit.source_action) && visit.status === 'pending') {
    return skip('dispatch_owned_pending', { visitId: visit.id });
  }

  const currentDate = dateOnly(visit.scheduled_date);
  const currentStart = hhmm(visit.window_start);
  const duration = windowDurationMinutes(visit.window_start, visit.window_end, visit.estimated_duration_minutes)
    || DEFAULT_DURATION_MINUTES;
  const newEnd = deriveWindowEnd(newStart, duration);
  if (!newEnd) return skip('window_runs_past_midnight', { visitId: visit.id });
  if (humanOverride) assertAdminAppointmentWindow({ windowStart: newStart, windowEnd: newEnd });

  const interiorNote = typeof v2.property?.access_notes === 'string' && v2.property.access_notes.trim()
    ? v2.property.access_notes.trim().slice(0, 300)
    : null;

  if (currentDate === newDate && currentStart === newStart) {
    if (!MOVABLE_STATUSES.includes(visit.status)) return skip('visit_parked_for_rebook', { visitId: visit.id });
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
  const query = conn('scheduled_services');
  if (Array.isArray(customerId)) query.whereIn('scheduled_services.customer_id', customerId);
  else query.where({ 'scheduled_services.customer_id': customerId });
  return query
    .whereIn('scheduled_services.status', LIVE_STATUSES)
    .where('scheduled_services.scheduled_date', '>=', includePast ? etDateString(addETDays(now, -60)) : etDateString(now))
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
      'scheduled_services.service_key_snapshot', 'scheduled_services.status', 'scheduled_services.source_action', 'scheduled_services.visit_id',
      'scheduled_services.customer_confirmed',
      'scheduled_services.internal_notes', 'scheduled_services.is_recurring', 'scheduled_services.self_booking_id',
      'scheduled_services.service_address_line1', 'scheduled_services.service_address_line2',
      'scheduled_services.service_address_city', 'scheduled_services.service_address_state', 'scheduled_services.service_address_zip',
      'services.name as catalog_service_name', 'services.service_key as catalog_service_key');
}

// Human review chooses the source visit and requested time, then shares the
// automatic path's planner and SmartRebooker choke point. The proposal guard,
// audit, and move commit in one transaction, including for a series move.
async function applyReviewedCallReschedule({ conn, call, v2, customer, candidates, visitId, actorId,
  operationKey, guard, proposalCardId = null, occurrenceIds = [], occurrences, conflictSnapshot, now = new Date(), rebooker = null } = {}) {
  if (!actorId || !operationKey || typeof guard !== 'function') {
    throw new Error('Reviewed reschedule requires an authenticated, uniquely identified proposal guard');
  }
  const plan = planRescheduleFromCall({ call, v2, customer, candidates, now, humanOverride: { visitId } });
  if (plan.action === 'skip') return { outcome: 'skipped', reason: plan.reason };
  const visit = candidates.find((row) => String(row.id) === String(plan.visitId));
  const seriesIds = plan.dateMove ? occurrenceIds : [];
  const affectedVisitIds = [...new Set([visit.id, ...seriesIds].map(String))].sort();
  const beforeMove = async (trx) => {
    // The call-booking creator takes this canonical fence before reading the
    // primary and creating a follow-up. Take it before every identity row lock.
    await lockCustomerComms(trx, customer.id);
    await trx('customers').where({ id: customer.id }).forShare().first('id');
    await trx('customer_properties').where({ customer_id: customer.id, active: true }).forShare().select('id');
    await lockTriageCall(trx, call.id);
    await trx('call_log').where({ id: call.id }).forUpdate().first('id');
  };
  const writeReview = async ({ trx }) => {
    const snapshotColumns = ['customer_id', 'property_id', 'service_id', 'service_type', 'status', 'visit_id',
      'is_recurring', 'source_action', 'customer_confirmed', 'self_booking_id', 'window_start', 'window_end',
      'estimated_duration_minutes', 'service_address_line1', 'service_address_line2', 'service_address_city',
      'service_address_state', 'service_address_zip'];
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
    if (await humanHandledRescheduleCard(trx, call.id, { excludeId: proposalCardId })) {
      throw Object.assign(new Error('Another staff action handled this appointment request. Refresh the proposal.'), { status: 409 });
    }
    await guard(trx);
    // This approval covers the displayed scheduling change, not extracted
    // access instructions. Preserve current staff notes; automatic Apply has
    // its separate note-append contract below.
    await trx('activity_log').insert({
      customer_id: customer.id,
      action: ACTIVITY_ACTION,
      description: 'Requested time applied by staff. No immediate customer message; normal appointment reminders continue.',
      metadata: { call_log_id: call.id, scheduled_service_id: visit.id, actor_id: actorId,
        from: plan.from || null, to: { date: plan.newDate, ...plan.newWindow }, human_override: true },
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
    visit.id, plan.newDate, plan.newWindow, RESCHEDULE_REASON_CODE, 'admin', {
      actorId,
      pendingConfirmation: true,
      notifyRequested: false,
      skipCallFollowUpShift: true,
      sourceSurface: 'call_reschedule',
      operationKey,
      adminWindowRules: true,
      overlapAdvisory: true,
      ...(conflictSnapshot === undefined ? {} : { expectConflictSnapshot: conflictSnapshot }),
      memberGuard: async ({ members }) => {
        if (members.length !== 1 || String(members[0].id) !== String(visit.id)) {
          throw Object.assign(new Error('The visit group changed. Use the schedule editor.'), { status: 409 });
        }
      },
      beforeMove,
      ...(plan.dateMove ? { expectOccurrenceIds: occurrenceIds, expectOccurrences: occurrences } : { seriesPolicy: 'single' }),
      expect: {
        scheduled_date: dateOnly(visit.scheduled_date), window_start: visit.window_start, window_end: visit.window_end,
        estimated_duration_minutes: visit.estimated_duration_minutes, customer_id: visit.customer_id,
        property_id: visit.property_id, service_id: visit.service_id, service_type: visit.service_type,
        status: visit.status, visit_id: visit.visit_id || null, source_action: visit.source_action,
        is_recurring: visit.is_recurring,
      },
      moveGuard: writeReview,
    },
  );
  if (visit.self_booking_id) {
    try {
      await conn('self_booked_appointments').where({ id: visit.self_booking_id }).update({
        date: plan.newDate, start_time: plan.newWindow.start, end_time: plan.newWindow.end, updated_at: new Date(),
      });
    } catch (err) {
      logger.warn(`[call-reschedule] self-booking snapshot sync failed for ${visit.id}: ${err.message}`);
    }
  }
  if (result?.seriesMoveId) {
    await require('../routes/admin-dispatch').applySeriesMoveEffects({
      result, serviceId: visit.id, newDate: plan.newDate, newWindow: plan.newWindow,
      notify: false, actorId, reasonText: null,
    });
  } else {
    try {
      await require('./appointment-reminders').handleReschedule(
        visit.id, `${plan.newDate}T${plan.newWindow.start}`,
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
// the call 'open', otherwise it takes the applied status. The call apply
// lane resolves all its cards; a self-service move supplies a visitId option
// and resolves only cards positively bound to the visit that actually moved.
// A supplied but missing visitId must fail closed, not fall back to all cards.
async function resolveRescheduleCards(conn, callLogId, note, options = {}) {
  const visitBound = Object.hasOwn(options, 'visitId');
  const { visitId } = options;
  if (visitBound && !visitId) return 0;
  const now = new Date();
  return conn.transaction(async (trx) => {
    await lockTriageCall(trx, callLogId);
    const query = trx('triage_items')
      .where({ call_log_id: callLogId, status: 'open' })
      .whereIn('reason_code', CARD_REASON_CODES);
    if (visitBound) query.where({ related_scheduled_service_id: visitId });
    const resolved = await query
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

// The ONE request/visit-matching predicate for "does a call_reschedule_
// applied activity row for this call still describe the LIVE call and its
// destination visit" — shared by applyCallReschedule's own retry branch
// below and by callers elsewhere that only need to know whether a call's
// reschedule ask is resolved, not re-run the move itself (Codex #4721 r3
// P1: one function, so a future change to accepted visit statuses, the
// source snapshot, or the destination checks can't update one caller and
// leave the other permissive).
//
// `requireSameGeneration` is the one axis callers legitimately differ on:
//   - true (applyCallReschedule's own retry check): the LIVE call's
//     processing_generation must match the one the activity row itself
//     recorded — a retry within the SAME pass.
//   - false (a caller like call-recording-processor.js's post-move
//     disposition correction, via priorApplicationStillMatchesLiveCall
//     below): a fresh reprocess pass having bumped the generation is
//     EXPECTED and must not by itself read as a mismatch — every other
//     check (source hash, visit identity/status/date/window) still applies
//     in full.
//
// `proof`, when the caller already holds the parsed activity_log metadata
// (applyCallReschedule's retry branch does — it needs `prior` itself to
// decide whether to enter this path at all), skips a redundant lookup;
// otherwise this reads it itself. Returns null when there is no prior
// application for this call at all (a caller with requireSameGeneration
// always passes proof and never sees null, since it already gated on
// `prior` existing).
//
// `claimToken`: a caller still inside its own processing pass (the make-up
// reprocess check, priorCallMakeupDecision) holds the call's claim, so the
// live row's processing_token is that pass's own, not a peer's.
async function priorApplicationMatchesLiveCall(conn, call, { requireSameGeneration = true, proof = undefined, claimToken } = {}) {
  let resolvedProof = proof;
  if (resolvedProof === undefined) {
    const prior = await conn('activity_log').where({ action: ACTIVITY_ACTION })
      .whereRaw("metadata->>'call_log_id' = ?", [String(call.id)]).first('metadata');
    if (!prior) return null;
    resolvedProof = typeof prior.metadata === 'string' ? JSON.parse(prior.metadata) : prior.metadata;
  }
  const liveCall = await conn('call_log').where({ id: call.id }).first();
  const liveVisit = resolvedProof?.scheduled_service_id
    ? await conn('scheduled_services').where({ id: resolvedProof.scheduled_service_id }).forShare().first() : null;
  // The caller-supplied call.customer_id is what applyCallReschedule's own
  // retry branch effectively compared against (settled.customer_id, proven
  // equal to call.customer_id earlier in this function) — a caller with no
  // customer_id on hand skips this particular check rather than comparing
  // liveCall against itself.
  const referenceCustomerId = call.customer_id ?? liveCall?.customer_id;
  const sameDecision = Boolean(liveCall) && (!liveCall.processing_token || liveCall.processing_token === claimToken)
    && liveCall.customer_id === referenceCustomerId
    && liveCall.v2_extraction_status === 'valid'
    && (!requireSameGeneration || Number(liveCall.processing_generation) === Number(resolvedProof?.processing_generation))
    && createHash('sha256').update(JSON.stringify([liveCall.transcription, liveCall.ai_extraction_enriched])).digest('hex') === resolvedProof?.source_hash;
  const sameVisit = Boolean(liveVisit) && liveVisit.customer_id === referenceCustomerId && MOVABLE_STATUSES.includes(liveVisit.status)
    && dateOnly(liveVisit.scheduled_date) === resolvedProof?.to?.date && hhmm(liveVisit.window_start) === resolvedProof?.to?.start
    && hhmm(liveVisit.window_end) === resolvedProof?.to?.end;
  return sameDecision && sameVisit;
}

// Read-only, no locks beyond what priorApplicationMatchesLiveCall itself
// takes, no side effects — for a caller that only needs to know "was this
// call's reschedule resolved", not re-run the move itself. Exported for
// call-recording-processor.js's post-move disposition correction (Codex
// #4721 r2 P1 on this lookup, r3 P1 on unifying it with the predicate
// below): an activity row existing is not proof by itself when the CURRENT
// extraction or destination visit no longer matches what it recorded (a
// corrected reprocess, a since-cancelled or re-moved visit) — only the
// generation is allowed to differ.
async function priorApplicationStillMatchesLiveCall(conn, call) {
  if (!conn || !call?.id) return false;
  return (await priorApplicationMatchesLiveCall(conn, call, { requireSameGeneration: false })) === true;
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
    const proof = typeof prior.metadata === 'string' ? JSON.parse(prior.metadata) : prior.metadata;
    return conn.transaction(async (trx) => {
      await beforeMove(trx);
      const matches = await priorApplicationMatchesLiveCall(trx, call, { requireSameGeneration: true, proof });
      if (!matches) return { outcome: 'skipped', reason: 'prior_application_requires_review' };
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
  if (await pendingSmsOffer(conn, settled.customer_id, plan.visitId, now)) {
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
    const handled = await humanHandledRescheduleCard(trx, call.id);
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
    const smsOffer = await pendingSmsOffer(trx, settled.customer_id, visit.id, now);
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
    // Post-commit fan-out (afterCallMove). A SINGLE move had NO fan-out at all
    // once (GH codex #4204 r8), which defeated this service's own purpose: the
    // 72h/24h reminder kept the OLD slot.
    await afterCallMove({ conn, visit, plan, result, tag: 'call-reschedule' });
  } catch (err) {
    const reasons = { CALL_RESCHEDULE_CHANGED: 'changed_before_apply', CALL_RESCHEDULE_HANDLED: 'handled_after_call', CALL_RESCHEDULE_ALREADY_APPLIED: 'already_applied' };
    if (!reasons[err.code]) throw err;
    return { outcome: 'skipped', reason: reasons[err.code], visitId: visit.id };
  }
  return { outcome: 'applied', visitId: visit.id, newDate: plan.newDate, newWindow: plan.newWindow, cardsResolved };
}

// Post-commit fan-out after a call moved a visit (applyCallReschedule,
// applyCallMakeupMove). SmartRebooker never touches the /book snapshot, and
// the move already stands, so each effect is best-effort: a socket or
// snapshot hiccup must not undo or refuse it. The /book snapshot first, for
// both shapes (the anchor moved either way; reschedule-public.js syncs it
// ahead of the same split): the public availability builder counts
// self_booked_appointments for the day cap, and GET /api/booking/status/:code
// reads the date and times back to the customer (GH codex #4204 r8 P2). A
// series move then runs the shared durable pass, whose reconciler retries a
// failure. A SINGLE move re-syncs the reminder and broadcasts the board. The
// durable reminder sync is the scheduled_services_sync_reminder trigger
// (migration 20260716150000): it re-timed the reminder row inside the move's
// own transaction. handleReschedule is the silent re-sync every single-visit
// mover also makes, and it reports a failure by returning null. No customer
// message (owner directive 2026-09-08), so coverDueWindows stays unset:
// covering an already-due window would suppress the only notice of the new
// time, the standard reminder the cron fires at the new slot.
async function afterCallMove({ conn, visit, plan, result, tag }) {
  const attempt = async (effect, run) => {
    try {
      return await run();
    } catch (err) {
      logger.warn(`[${tag}] ${effect} failed for ${visit.id}: ${err.message}`);
      return null;
    }
  };
  if (visit.self_booking_id) {
    await attempt('self-booking snapshot sync', () => conn('self_booked_appointments').where({ id: visit.self_booking_id }).update({
      date: plan.newDate, start_time: plan.newWindow.start, end_time: plan.newWindow.end, updated_at: new Date(),
    }));
  }
  if (result?.seriesMoveId) {
    await attempt('series effects (the reconciler retries)', () => require('../routes/admin-dispatch').applySeriesMoveEffects({
      result, serviceId: visit.id, newDate: plan.newDate, newWindow: plan.newWindow,
      notify: false, actorId: null, reasonText: null,
    }));
    return;
  }
  const synced = await attempt('reminder sync', () => require('./appointment-reminders')
    .handleReschedule(visit.id, `${plan.newDate}T${plan.newWindow.start}`, { sendNotification: false }));
  if (!synced) logger.warn(`[${tag}] reminder re-sync returned nothing for ${visit.id}; the in-transaction trigger sync stands`);
  await attempt('board broadcast', () => require('./dispatch-assignment').emitDispatchJobUpdate({ jobId: visit.id, actorId: null }));
}

// ---------------------------------------------------------------------------
// MAKE-UP MOVE (owner 2026-10-22, dark behind GATE_CALL_MAKEUP_MOVE).
//
// Incident: a quarterly pest customer's recurring visit was MISSED (status
// still 'confirmed', dated in the past, an unresolved customer_noshow row from
// the 6 PM missed-appointment check). She called, the agent said "I need to
// come by", agreed Tuesday ~5 PM and she accepted. The pipeline INSERTED a new
// placeholder visit beside the missed one. The owner's ruling: the missed
// appointment is rescheduled and moved up, never booked as a new general
// service.
//
// Where it runs: inside the booking transaction, at its fresh INSERT, after
// every booking guard has passed (this call's own booking reused, the ±1-day
// attach, the same-day hold, the re-service checks, the slot-elapsed
// recheck). It never re-implements those guards: it only ever stands in for
// that insert, at the booking's own customer, property and slot.
// planCallMakeupForBooking decides:
//   skip         no missed recurring visit of the call's line at the booking's
//                property: the row is inserted as always;
//   apply        exactly one, and no MAKEUP_HOLDS check fires: the booking
//                transaction ends without inserting, and applyCallMakeupMove
//                moves THAT visit (default series policy) to the booking's
//                slot through the rebooker;
//   needs_review a missed visit of the line exists but a check fires: the
//                booking is HELD with a review card, never inserted beside it.
// Missed = recurring, ungrouped, not dispatch-owned or office-review, pending
// or confirmed, dated within MAKEUP_LOOKBACK_DAYS before today, with an open
// customer_noshow row for its own slot and proof of the miss; or a visit of
// that shape someone moved after the call (held: it was already acted on).
// A reprocess of a call whose move applied is priorCallMakeupDecision's.
// NO customer communication (owner directive 2026-09-08).
// ---------------------------------------------------------------------------
const MAKEUP_ACTIVITY_ACTION = 'call_makeup_move_applied';
const MAKEUP_REASON_CODE = 'ai_call_makeup'; // reschedule_log.reason_code varchar(30)
const MAKEUP_LOOKBACK_DAYS = 30;
const MAKEUP_INTENTS = ['follow_up_existing_service'];
const MAKEUP_NATURES = ['existing_customer_scheduling'];
// The V2 categories that name a line's recurring PROGRAM. A specialty category
// on the same line can be a different booking (a WDO inspection or a termite
// treatment beside bait monitoring, bed bugs or a wasp nest beside general
// pest, exclusion beside rodent bait): held, never moved.
const MAKEUP_PROGRAM_CATEGORIES = ['pest_general', 'lawn_care', 'mosquito'];
// Any of these on the visit, or a service record for it, means someone worked
// it: the 6 PM customer_noshow row then means "not closed out", not "missed"
// (not-closed-out.js: 27% were later completed).
const FIELD_WORK_COLUMNS = ['en_route_at', 'arrived_at', 'check_in_time', 'actual_start_time', 'completed_at'];
// The live statuses the booking's own same-day hold counts (call-recording-
// processor.js sameDayExisting).
const SAME_DAY_DONE_STATUSES = ['cancelled', 'rescheduled', 'skipped', 'completed'];

const notSandbox = (b) => require('./voice-agent/relay-protocol').whereNotSandboxCall(b);
const claimedBy = (row, procToken, procGeneration) => Boolean(row)
  && (!procToken || row.processing_token === procToken)
  && (procGeneration == null || Number(row.processing_generation) === Number(procGeneration));

// Proof the visit was really missed: a person confirmed the miss on the
// not-closed-out card, or the visit shows no field work at all. The call adds
// the rest: the customer is asking for this service and agreed a new slot.
function missedVisitEvidence(visit, log) {
  if (log?.miss_confirmed_at) return 'miss_confirmed';
  if (visit.has_service_record !== false) return null;
  if (FIELD_WORK_COLUMNS.some((col) => !Object.hasOwn(visit, col) || visit[col] != null)) return null;
  return 'no_field_work';
}

const GENERIC_SERVICE_NAME_RE = /^(?:waves pest control appointment service|waves appointment)$/i;

function needsReview(reason, extra = {}) {
  return { action: 'needs_review', reason, ...extra };
}

function windowText(row) {
  return row.window_start ? `${row.window_start}-${row.window_end}` : null;
}

// The open customer_noshow row for THIS visit's current slot. not-closed-out.js
// isSameNoShowOccurrence needs status no_show; a missed visit that was never
// marked stays pending/confirmed, so the same date + window key is matched on
// the live row. original_date is required: the nightly check always writes it.
function openNoShowForSlot(visit, logs) {
  return (logs || []).find((log) => !log.resolved_at
    && String(log.scheduled_service_id) === String(visit.id)
    && log.original_date && dateOnly(log.original_date) === dateOnly(visit.scheduled_date)
    && (!log.original_window || log.original_window === windowText(visit))) || null;
}

function serviceAddressKey(row) {
  return row.service_address_line1 ? addressKey({ address_line1: row.service_address_line1,
    address_line2: row.service_address_line2, city: row.service_address_city, zip: row.service_address_zip }) : null;
}

// The booking's own resolved property. Two rows that both carry a property id
// compare by id. Otherwise by address: a row's own service address, else its
// saved property's, else (no property id) the customer's primary address.
function atBookingProperty(row, { booking, customer, properties }) {
  if (row.property_id && booking.property_id) return String(row.property_id) === String(booking.property_id);
  const keyOf = (r) => {
    if (r.service_address_line1) return serviceAddressKey(r);
    if (!r.property_id) return customer.address_line1 ? addressKey(customer) : null;
    const saved = properties.find((p) => String(p.id) === String(r.property_id));
    return saved ? addressKey(saved) : null;
  };
  const key = keyOf(row);
  return Boolean(key) && key === keyOf(booking);
}

function isMissedAtCall(row, ctx) {
  const shape = String(row.customer_id) === String(ctx.customer.id) && MOVABLE_STATUSES.includes(row.status)
    && !row.parent_service_id && !row.visit_id && row.is_recurring === true
    && !DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(row.source_action)
    && !OFFICE_REVIEW_PENDING_SOURCE_ACTIONS.includes(row.source_action)
    && atBookingProperty(row, ctx);
  if (!shape || row.moved_after_call === true) return shape;
  const date = dateOnly(row.scheduled_date);
  const log = openNoShowForSlot(row, ctx.noshowLogs);
  return date >= etDateString(addETDays(ctx.now, -MAKEUP_LOOKBACK_DAYS)) && date < etDateString(ctx.now)
    && Boolean(log) && Boolean(missedVisitEvidence(row, log));
}

// The lines a real (non-placeholder) specific_service_name reads as.
function namedLines(v2) {
  const name = v2.service_request?.specific_service_name;
  return typeof name === 'string' && !GENERIC_SERVICE_NAME_RE.test(name.trim()) ? linesOfServiceName(name) : [];
}

// The visit keeps its own length at the booking's start.
function makeupWindow(visit, booking) {
  const start = hhmm(booking.window_start);
  const duration = windowDurationMinutes(visit.window_start, visit.window_end, visit.estimated_duration_minutes) || DEFAULT_DURATION_MINUTES;
  return { start, end: start ? deriveWindowEnd(start, duration) : null };
}

function stringDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

// Every reason a found missed visit is HELD instead of moved, in the order
// the card reports them. A move shifts a recurring series on what one call
// said, so the call itself must be unambiguous about the visit, the slot and
// the caller; none of these ever lets the insert through (the visit exists).
const MAKEUP_HOLDS = [
  ['no_v2_extraction', ({ v2 }) => !v2 || typeof v2 !== 'object'],
  ['spam_or_voicemail', ({ v2 }) => v2.meta?.is_spam === true || v2.meta?.is_voicemail === true],
  ['not_a_confirmed_slot', ({ v2 }) => v2.scheduling?.status !== 'confirmed'],
  ['not_a_follow_up_call', ({ v2 }) => !MAKEUP_INTENTS.includes(v2.service_request?.service_intent) && !MAKEUP_NATURES.includes(v2.call_nature)],
  ['service_line_unknown', ({ callLine }) => !callLine],
  ['specialty_service', ({ v2 }) => !MAKEUP_PROGRAM_CATEGORIES.includes(v2.service_request?.primary_service_category)],
  ['service_needs_review', ({ v2 }) => (v2.service_request?.secondary_categories || []).length > 0],
  ['service_line_differs', ({ v2, callLine }) => namedLines(v2).length > 0 && !namedLines(v2).includes(callLine)],
  // A row with no catalog identity to weigh (its catalog row gone, or the
  // catch-all placeholder) may be the visit the caller means.
  ['placeholder_candidate', ({ relevant }) => relevant.some((row) => !lineOfServiceName(authoritativeServiceName(row)))],
  ['ambiguous_missed_visit', ({ relevant }) => relevant.length > 1],
  ['handled_after_call', ({ visit }) => visit.moved_after_call === true],
  // A caller who names a DIFFERENT appointment date means another visit.
  ['moved_appointment_not_candidate', ({ v2, visit }) => ![null, dateOnly(visit.scheduled_date)].includes(stringDate(v2.scheduling.moved_appointment_date))],
  // The booking would have seeded a promised visit 2 (or a package follow-up)
  // beside its new row; a moved recurring visit has no such child.
  ['follow_up_visit_promised', ({ booking }) => booking.followUpPlanned === true],
  // A covered re-service call says the last treatment happened.
  ['reservice_booking', ({ booking }) => booking.reService === true],
  // The booking would have gone in pending (a street-level address the
  // office confirms first); a move would skip that review.
  ['address_needs_review', ({ booking }) => booking.status !== 'confirmed'],
  ['slot_differs_from_extraction', ({ v2, booking }) => etWallClockOfConfirmedStart(v2.scheduling.confirmed_start_at)
    !== `${dateOnly(booking.scheduled_date)}T${hhmm(booking.window_start)}`],
  ['caller_did_not_accept', ({ v2 }) => v2.scheduling.caller_accepted_slot !== true],
  ['agent_did_not_commit', ({ v2 }) => v2.scheduling.agent_committed_booking === false],
  ['low_scheduling_confidence', ({ v2 }) => typeof v2.confidence?.scheduling_window !== 'number' || v2.confidence.scheduling_window < MIN_SCHEDULING_CONFIDENCE],
  ['caller_not_decision_maker', ({ v2 }) => v2.caller?.decision_maker_present === false],
  ['do_not_contact_requested', ({ v2 }) => v2.consent?.do_not_contact_request === true],
  // This pass armed the disclaimed-number hold (the caller said the line is
  // not theirs, or cannot get texts): the booking would have carried it onto
  // its new row; a person sorts the numbers before the visit moves.
  ['caller_number_disclaimed', ({ booking }) => booking.callbackHold === true],
  ['customer_not_matched', ({ call, customer }) => !call?.customer_id || String(call.customer_id) !== String(customer.id)],
  ['caller_phone_not_on_file', ({ call, customer }) => {
    const onFile = new Set(KNOWN_CALLER_PHONE_COLS.flatMap((col) => phoneMatchDigits(customer[col])));
    return !phoneMatchDigits(counterpartPhone(call)).some((key) => onFile.has(key));
  }],
  // A matching caller ID alone does not prove an INBOUND caller owns the
  // number: only a carrier-signed STIR/SHAKEN "A" attestation vouches for it
  // (a B or C, or none, is exactly the spoofable population). An outbound
  // call reached the number we dialed.
  ['caller_not_attested', ({ call }) => !isOutboundDirection(call)
    && !require('./voice-agent/relay-context').isFullAttestation(callMetadata(call).stir_verstat)],
  ['untrusted_speaker_labels', ({ transcriptLabelsTrusted }) => !transcriptLabelsTrusted],
  ['window_runs_past_midnight', ({ visit, booking }) => !makeupWindow(visit, booking).end],
];

/**
 * Pure decision. `booking` is the row the booking transaction was about to
 * insert (customer_id, property_id, service address, scheduled_date,
 * window_start, status) plus followUpPlanned / reService / callbackHold;
 * `candidates` come from loadMakeupCandidates; `now` is the clock "missed"
 * is judged on.
 */
function planMakeupMoveFromCall({ v2, call, customer, properties, booking, candidates, noshowLogs, now, transcriptLabelsTrusted = false }) {
  const missed = candidates.filter((row) => isMissedAtCall(row, { customer, properties, booking, noshowLogs, now }));
  if (!missed.length) return skip('no_missed_visit');
  const callLine = lineOfV2Category(v2?.service_request?.primary_service_category);
  // A missed visit of ANOTHER line says nothing about this booking. One of
  // the call's line, or of no known line, is the visit the call may mean.
  const relevant = missed.filter((row) => !callLine || [callLine, null].includes(lineOfServiceName(authoritativeServiceName(row))));
  if (!relevant.length) return skip('service_line_differs');
  const visit = relevant[0];
  const hold = MAKEUP_HOLDS.find(([, holds]) => holds({ v2, call, customer, booking, relevant, visit, callLine, transcriptLabelsTrusted }));
  if (hold) return needsReview(hold[0], { visitId: relevant.length === 1 ? visit.id : null, candidateIds: relevant.map((row) => row.id) });
  return {
    action: 'apply',
    visitId: visit.id,
    visit,
    from: { date: dateOnly(visit.scheduled_date), start: hhmm(visit.window_start), end: hhmm(visit.window_end) },
    newDate: dateOnly(booking.scheduled_date),
    newWindow: makeupWindow(visit, booking),
    noshowLogId: openNoShowForSlot(visit, noshowLogs)?.id || null,
  };
}

// The customer's live visits that were missed when the call was made: dated
// in the look-back before today, or moved since the call FROM such a date
// (moved_after_call; the planner holds those), with the columns the planner
// needs beyond loadCandidates'.
async function loadMakeupCandidates(conn, customerId, now, callCreatedAt) {
  const earliest = etDateString(addETDays(now, -MAKEUP_LOOKBACK_DAYS));
  const today = etDateString(now);
  const rows = await loadCandidates(conn, customerId, now, { includePast: true });
  const movedRows = await conn('reschedule_log').where({ customer_id: customerId })
    .whereNot('reason_code', 'customer_noshow').where('created_at', '>', callCreatedAt)
    .where('original_date', '>=', earliest).where('original_date', '<', today)
    .select('scheduled_service_id');
  const movedAfterCall = new Set((movedRows || []).map((r) => String(r.scheduled_service_id)));
  const inRange = (rows || []).filter((row) => movedAfterCall.has(String(row.id))
    || (dateOnly(row.scheduled_date) >= earliest && dateOnly(row.scheduled_date) < today));
  if (!inRange.length) return [];
  const ids = inRange.map((r) => r.id);
  const extra = await conn('scheduled_services').whereIn('id', ids)
    .select('id', 'parent_service_id', 'source_call_log_id', ...FIELD_WORK_COLUMNS);
  const recorded = await conn('service_records').whereIn('scheduled_service_id', ids).select('scheduled_service_id');
  const recordedIds = new Set((recorded || []).map((r) => String(r.scheduled_service_id)));
  const byId = new Map((extra || []).map((r) => [String(r.id), r]));
  return inRange.map((row) => {
    const more = byId.get(String(row.id)) || {};
    const fieldWork = Object.fromEntries(FIELD_WORK_COLUMNS.map((col) => [col, more[col] ?? null]));
    return { ...row, ...fieldWork, parent_service_id: more.parent_service_id ?? null, source_call_log_id: more.source_call_log_id ?? null,
      has_service_record: recordedIds.has(String(row.id)), moved_after_call: movedAfterCall.has(String(row.id)) };
  });
}

function loadOpenNoShows(conn, customerId, visitIds) {
  if (!visitIds.length) return Promise.resolve([]);
  return conn('reschedule_log')
    .where({ customer_id: customerId, reason_code: 'customer_noshow' })
    .whereNull('resolved_at')
    .whereIn('scheduled_service_id', visitIds)
    .select('id', 'scheduled_service_id', 'original_date', 'original_window', 'resolved_at', 'miss_confirmed_at');
}

// The plan from the database, read through `conn`: the booking transaction's,
// then again the move's own (where it must still agree).
async function planMakeupFromDb(conn, { settled, booking, now }) {
  const customer = await conn('customers').where({ id: booking.customer_id }).first();
  if (!customer) return skip('customer_not_matched');
  const properties = await conn('customer_properties').where({ customer_id: customer.id, active: true }).select('*');
  const candidates = await loadMakeupCandidates(conn, customer.id, now, settled.created_at);
  const noshowLogs = await loadOpenNoShows(conn, customer.id, candidates.map((r) => r.id));
  return planMakeupMoveFromCall({
    v2: settled.v2_extraction_status === 'valid' ? settled.ai_extraction_enriched : null,
    call: settled, customer, properties, booking, candidates, noshowLogs, now,
    transcriptLabelsTrusted: isEnabled('callAgentCommitTrustedLabels'),
  });
}

const makeupMarker = (conn, callId) => conn('activity_log').where({ action: MAKEUP_ACTIVITY_ACTION })
  .whereRaw("metadata->>'call_log_id' = ?", [String(callId)]).first('metadata');

// A move of THE VISIT by anyone after the call, other than the missed-
// appointment check's own customer_noshow row (that row is the evidence).
const newerMove = (conn, visitId, since) => conn('reschedule_log')
  .where({ scheduled_service_id: visitId })
  .whereNot('reason_code', 'customer_noshow')
  .where('created_at', '>', since).first('id');

// What makes a found missed visit unsafe to move now, checked in the booking
// transaction and again in the move's own (there under the visit's row lock):
// this call already booked a visit (an earlier pass; live, or cancelled by
// staff), staff handled the call's reschedule card or an earlier pass's
// make-up hold card (the skipped-booking card), someone moved the visit after
// the call, or a staff-owned request or a live reply-1/2 offer is open on it.
async function makeupConflict(conn, { settled, visitId, now }) {
  const checks = [
    ['call_already_booked', () => conn('scheduled_services').where({ source_call_log_id: settled.id }).whereNot({ id: visitId }).first('id')],
    ['handled_by_staff', () => humanHandledRescheduleCard(conn, settled.id)],
    ['handled_by_staff', () => conn('triage_items').where({ call_log_id: settled.id, reason_code: 'auto_booking_skipped_after_approval' })
      .whereRaw("payload->>'skipped_reason' = ?", ['missed_visit_makeup_needs_review']).where(humanHandledCardStatus).first('id')],
    ['handled_after_call', () => newerMove(conn, visitId, settled.created_at)],
    ['portal_request_open', () => openPortalRequest(conn, settled.customer_id, visitId)],
    ['pending_sms_offer', () => pendingSmsOffer(conn, settled.customer_id, visitId, now)],
  ];
  for (const [reason, found] of checks) {
    // Sequential on purpose: the first hit decides, and the rest never run.
    if (await found()) return reason;
  }
  return null;
}

/**
 * The booking transaction's make-up check, at its fresh insert (every booking
 * guard already passed), read through that transaction. Returns the plan with
 * the booking it was judged on: skip (insert as always), apply (end the
 * transaction without inserting; the processor then runs
 * applyCallMakeupMove), or needs_review (hold, never insert).
 */
async function planCallMakeupForBooking(trx, { call, procToken = null, procGeneration = null, booking, now = new Date() }) {
  const settled = await trx('call_log').where({ id: call.id }).modify(notSandbox).first();
  if (!claimedBy(settled, procToken, procGeneration)) return skip('superseded_by_newer_pass');
  if (String(settled.customer_id) !== String(booking.customer_id)) return skip('customer_link_changed');
  const plan = await planMakeupFromDb(trx, { settled, booking, now });
  const conflict = plan.action === 'apply' ? await makeupConflict(trx, { settled, visitId: plan.visitId, now }) : null;
  return conflict ? needsReview(conflict, { visitId: plan.visitId, candidateIds: [plan.visitId] }) : { ...plan, booking };
}

/**
 * Before the booking branch: a reprocess of a call whose make-up move already
 * applied. The moved visit IS the booking (noop) while the live call and visit
 * still match what the marker recorded, judged by the reschedule path's own
 * predicate (the pass holds the claim, and a reprocess bumps the generation);
 * a changed transcript, extraction, customer or visit holds for review.
 * Null when this call never applied one.
 */
async function priorCallMakeupDecision(conn, { call, procToken = null }) {
  const prior = await makeupMarker(conn, call.id);
  if (!prior) return null;
  const proof = typeof prior.metadata === 'string' ? JSON.parse(prior.metadata) : prior.metadata;
  const visitId = proof?.scheduled_service_id || null;
  const matches = await priorApplicationMatchesLiveCall(conn, call, { requireSameGeneration: false, proof, claimToken: procToken });
  return matches ? { outcome: 'noop', reason: 'already_applied', visitId } : { outcome: 'needs_review', reason: 'prior_makeup_differs', visitId };
}

/**
 * The move, run by the processor AFTER the booking transaction returned an
 * apply plan without inserting (the rebooker opens its own transaction; it
 * must never nest in the booking's). The call is still claimed by this pass:
 * `procToken` + `procGeneration` fence it. Never throws. Outcomes:
 *   applied      the missed visit moved; the processor books nothing
 *   noop         this call's make-up move already applied; same
 *   needs_review it did not move (the call or visit changed, someone acted,
 *                the rebooker refused): the processor HOLDS the booking
 */
async function applyCallMakeupMove({ conn, call, plan, procToken = null, procGeneration = null, now = new Date(), rebooker = null }) {
  const visit = plan.visit;
  const review = (reason) => ({ outcome: 'needs_review', reason, visitId: visit.id });
  const settled = await conn('call_log').where({ id: call.id }).modify(notSandbox).first();
  if (!claimedBy(settled, procToken, procGeneration)) return review('superseded_by_newer_pass');
  if (String(settled.customer_id) !== String(plan.booking.customer_id)) return review('customer_link_changed');
  const v2 = settled.v2_extraction_status === 'valid' ? settled.ai_extraction_enriched : null;
  const sourceHash = createHash('sha256').update(JSON.stringify([settled.transcription, v2])).digest('hex');
  const fenced = (current) => claimedBy(current, settled.processing_token, settled.processing_generation)
    && current.customer_id === settled.customer_id && current.v2_extraction_status === 'valid'
    && JSON.stringify(current.ai_extraction_enriched) === JSON.stringify(v2) && current.transcription === settled.transcription;
  // Same lock order as the reviewed reschedule: the call-booking creator's
  // comms fence, then customer -> properties -> call.
  const beforeMove = async (trx) => {
    await lockCustomerComms(trx, settled.customer_id);
    await trx('customers').where({ id: settled.customer_id }).forShare().first('id');
    await trx('customer_properties').where({ customer_id: settled.customer_id, active: true }).forShare().select('id');
    await lockTriageCall(trx, call.id);
    await trx('call_log').where({ id: call.id }).modify(notSandbox).forUpdate().first('id');
  };
  const note = `Missed visit ${visit.id} moved from ${plan.from.date} to ${plan.newDate} ${plan.newWindow.start} from the call. No customer message sent.`;
  const writeDecision = async ({ trx, service }) => {
    await lockTriageCall(trx, call.id);
    const current = await trx('call_log').where({ id: call.id }).modify(notSandbox).forUpdate().first();
    if (!fenced(current)) throw Object.assign(new Error('The call changed before its make-up move could apply'), { code: 'CALL_MAKEUP_CHANGED', reason: 'changed_before_apply' });
    if (await makeupMarker(trx, call.id)) throw Object.assign(new Error('This call was already applied'), { code: 'CALL_MAKEUP_ALREADY_APPLIED' });
    // Under the visit's own row lock (as applyCallReschedule): a portal
    // request filed meanwhile is either seen here or starts after the move.
    await trx('scheduled_services').where({ id: visit.id }).forUpdate().first('id');
    // The booking's same-day hold ran in its transaction, which ended before
    // this one began: a live visit landing on the agreed day in between holds.
    const conflict = await makeupConflict(trx, { settled: current, visitId: visit.id, now })
      || (await trx('scheduled_services').where({ customer_id: settled.customer_id, scheduled_date: plan.newDate })
        .whereNull('parent_service_id').whereNotIn('status', SAME_DAY_DONE_STATUSES).whereNot({ id: visit.id }).first('id')
        ? 'existing_appointment_on_target_date' : null);
    if (conflict) throw Object.assign(new Error('The request was handled after this call'), { code: 'CALL_MAKEUP_HANDLED', reason: conflict });
    const checked = await planMakeupFromDb(trx, { settled: current, booking: plan.booking, now });
    const unchanged = service && dateOnly(service.scheduled_date) === dateOnly(visit.scheduled_date)
      && ['customer_id', 'property_id', 'service_id', 'service_type', 'status', 'source_action', 'visit_id', 'is_recurring', 'window_start', 'window_end', 'estimated_duration_minutes']
        .every((key) => (service[key] ?? null) === (visit[key] ?? null));
    if (!unchanged || checked.action !== 'apply' || checked.visitId !== visit.id) {
      throw Object.assign(new Error('The visit changed before its make-up move could apply'), { code: 'CALL_MAKEUP_CHANGED', reason: 'changed_before_apply' });
    }
    // The moved row carries the call, so the booking dedup guard and the
    // commitment tracker (visit_booked_from_this_call) find it on a reprocess.
    // Only a row no other call claimed.
    await trx('scheduled_services').where({ id: visit.id }).whereNull('source_call_log_id').update({ source_call_log_id: call.id, updated_at: new Date() });
    await trx('activity_log').insert({ customer_id: settled.customer_id, action: MAKEUP_ACTIVITY_ACTION, description: note,
      metadata: JSON.stringify({ call_log_id: String(call.id), scheduled_service_id: String(visit.id), noshow_log_id: plan.noshowLogId ? String(plan.noshowLogId) : null,
        from: plan.from, to: { date: plan.newDate, ...plan.newWindow },
        processing_generation: current.processing_generation, source_hash: sourceHash }) });
    await resolveRescheduleCards(trx, call.id, note);
  };
  let result;
  try {
    result = await (rebooker || require('./rebooker')).reschedule(visit.id, plan.newDate, plan.newWindow, MAKEUP_REASON_CODE, INITIATED_BY, {
      // DEFAULT series policy (owner rulings 2026-07-30 + 08-28): a date move of
      // a recurring visit carries its cadence; never seriesPolicy 'single'.
      keepStatus: true, beforeMove, moveGuard: writeDecision,
      sourceSurface: 'call_makeup', notifyRequested: false,
      expect: { scheduled_date: dateOnly(visit.scheduled_date), window_start: visit.window_start, window_end: visit.window_end,
        estimated_duration_minutes: visit.estimated_duration_minutes, customer_id: visit.customer_id,
        property_id: visit.property_id, service_id: visit.service_id, service_type: visit.service_type,
        status: visit.status, visit_id: visit.visit_id, source_action: visit.source_action, is_recurring: visit.is_recurring },
    });
  } catch (err) {
    // A missed visit exists, so ANY failure holds the booking (never a new visit).
    if (err.code === 'CALL_MAKEUP_ALREADY_APPLIED') return { outcome: 'noop', reason: 'already_applied', visitId: visit.id };
    logger.warn(`[call-makeup] move refused for ${visit.id}: ${err.code || err.name || 'error'}`);
    return review(err.reason || `move_failed_${err.code || err.statusCode || 'error'}`);
  }
  await afterCallMove({ conn, visit, plan, result, tag: 'call-makeup' });
  return { outcome: 'applied', visitId: visit.id, newDate: plan.newDate, newWindow: plan.newWindow };
}

module.exports = {
  applyReviewedCallReschedule,
  applyCallReschedule,
  applyCallMakeupMove,
  planCallMakeupForBooking,
  planMakeupMoveFromCall,
  priorCallMakeupDecision,
  planRescheduleFromCall,
  loadCandidates,
  // The staff-owned schedule-change request fence, shared with the SMS
  // scheduling decide step (sms-scheduling-decide.js).
  openPortalRequest,
  // The unanswered reply-1/2 reminder offer fence, shared the same way.
  pendingSmsOffer,
  resolveRescheduleCards,
  MIN_SCHEDULING_CONFIDENCE,
  CANDIDATE_SPAN_DAYS,
  CARD_REASON_CODES,
  MOVABLE_STATUSES,
  ACTIVITY_ACTION,
  MAKEUP_ACTIVITY_ACTION,
  MAKEUP_REASON_CODE,
  humanHandledRescheduleCard,
  RESCHEDULE_REASON_CODE,
  INITIATED_BY,
  priorApplicationStillMatchesLiveCall,
  priorApplicationMatchesLiveCall,
};
