/**
 * Completion follow-up booking — book the follow-up visit a completed visit's
 * frozen verdict calls for, as a PENDING appointment (the normal pending →
 * confirmed dispatch flow is the admin confirmation step, so the full
 * scheduling validation stack isn't duplicated here). Idempotent per source
 * visit via followup_source_service_id — a retried CTA tap returns the
 * existing booking. The appointment is $0 + followup_included, which the
 * typed completion billing pre-gate bypasses (included program visit).
 *
 * One implementation for both callers: POST /api/admin/dispatch/:serviceId/
 * schedule-followup (the Dispatch completion CTA) and the Intelligence Bar
 * closeout repair's book_followup step.
 *
 * Returns { status, body } — the HTTP answer the route relays verbatim.
 * Options beyond the route's own inputs (IB closeout repair only):
 *   useSuggestedDate      book the verdict's own program-interval date
 *                         (still today-or-later) instead of a typed date.
 *   dryRun                every check above the write, then report what
 *                         would be booked (wouldBook) — no write, no alert
 *                         resolution, no notifications.
 *   expectedTechnicianId  the technician an approval showed (null =
 *                         unassigned); a different outcome refuses 409.
 *   expectedWindow        { start, end } an approval showed; a different
 *                         window refuses 409 before any write.
 *   expectedCustomerId    the customer an approval showed; checked on the
 *                         LOCKED source visit (a merge/repoint refuses 409).
 * Every pin is also checked against an already-booked child (idempotent
 * retry or 23505 winner) — a follow-up that differs from the approval is a
 * 409, never a reported success.
 *
 * Staff-side booking (owner ruling 2026-08-25): the date-wide occupancy lock
 * and the tech-blind overlap probe run FIRST (rung 1, scheduling/occupancy.js
 * ORDERING CONTRACT); an overlap is ADVISORY — the booking commits and the
 * answer carries overlapWarning. The preview reports it as wouldBook.overlap.
 */
const db = require('../models/db');
const logger = require('./logger');
const { parseJsonObject, serviceDateOnly } = require('./complete-scheduled-service');
const { resolveCompletionProfileForScheduledService } = require('./service-completion-profiles');
const { typedFollowupVerdict, FOLLOWUP_CHILD_INACTIVE_STATUSES } = require('./typed-followup-obligation');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const {
  probeSlotOverlap, slotOverlapWarning, assertAdminAppointmentWindow, ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
} = require('./scheduling/window-rules');
const { findConflictingVisits } = require('./scheduling/occupancy');
const { assertAssignableTechnician } = require('./technician-eligibility');
const { etDateString } = require('../utils/datetime-et');
const { completeScheduledServiceInsert } = require('./booking/create-scheduled-service');

const reply = (status, payload) => ({ status, body: payload });

function followupOptions(input) {
  const {
    serviceId,
    windowStart = null,
    windowEnd = null,
    technicianId = null,
    isAdmin = false,
    actorId = null,
    useSuggestedDate = false,
    dryRun = false,
    expectedTechnicianId = undefined,
    expectedWindow = undefined,
    expectedCustomerId = undefined,
    // source_action stamped by the booking contract: the Dispatch CTA is a
    // staff booking; the IB repair passes 'admin_ib'.
    sourceAction = 'admin_manual',
  } = input;
  return {
    serviceId, windowStart, windowEnd, actorId, useSuggestedDate, dryRun,
    expectedTechnicianId, expectedWindow, expectedCustomerId, sourceAction,
    // technicianId override is admin-only — a tech-authenticated caller
    // could otherwise book the follow-up onto another technician's lane
    // (Codex P2). Techs always inherit the source visit's technician.
    technicianOverride: isAdmin ? technicianId : null,
  };
}

async function bookCompletionFollowup(input = {}) {
  const {
    serviceId, windowStart, windowEnd, technicianOverride, actorId, useSuggestedDate, dryRun,
    expectedTechnicianId, expectedWindow, expectedCustomerId, sourceAction,
  } = followupOptions(input);
  const early = useSuggestedDate ? null : typedDateRefusal(input.date);
  if (early) return early;

  const gate = await followupVerdictGate(serviceId);
  if (gate.reply) return gate.reply;
  const { svc, profile, suggestion } = gate;
  const dated = followupDate(input.date, suggestion, useSuggestedDate);
  if (dated.reply) return dated.reply;
  const { date } = dated;

  const cols = await db('scheduled_services').columnInfo().catch(() => ({}));
  if (!cols.followup_source_service_id || !cols.followup_included) {
    return reply(503, { error: 'Follow-up booking is not available yet (pending migration).', code: 'followup_columns_missing' });
  }
  const pins = { expectedWindow, expectedTechnicianId, expectedCustomerId };
  const resolveOpenFollowupAlerts = followupAlertResolver(svc, actorId);

  const existing = await db('scheduled_services')
    .where({ followup_source_service_id: svc.id })
    .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
    .orderBy('created_at', 'desc')
    .first();
  if (existing) {
    // A preview never writes — not even the alert resolution. A follow-up
    // exists either way, so the parked alert is resolved before any pin
    // mismatch is reported.
    if (!dryRun) await resolveOpenFollowupAlerts();
    return pinDriftReply(existing, pins) || reply(200, { ...(dryRun ? { dryRun: true } : { success: true }), alreadyScheduled: true, appointment: { id: existing.id, scheduledDate: serviceDateOnly(existing.scheduled_date), status: existing.status } });
  }

  const insertData = buildFollowupInsert(svc, cols, { date, windowStart, windowEnd, technicianOverride });
  const badWindow = windowRefusal(insertData, expectedWindow);
  if (badWindow) return badWindow;
  if (dryRun) return followupPreview({ date, insertData, technicianOverride });

  let committed;
  try {
    committed = await commitFollowup({ svc, date, cols, insertData, technicianOverride, expectedTechnicianId, expectedCustomerId, sourceAction });
  } catch (err) {
    // Partial unique index on followup_source_service_id — a concurrent
    // CTA tap lost the race; return the winner's booking idempotently.
    if (err && err.code === '23505') {
      const winner = await db('scheduled_services')
        .where({ followup_source_service_id: svc.id })
        .whereNotIn('status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
        .orderBy('created_at', 'desc')
        .first();
      if (winner) {
        await resolveOpenFollowupAlerts();
        return pinDriftReply(winner, pins) || reply(200, {
          success: true,
          alreadyScheduled: true,
          appointment: { id: winner.id, scheduledDate: serviceDateOnly(winner.scheduled_date), status: winner.status },
        });
      }
    }
    throw err;
  }
  return afterFollowupBooked(committed, { svc, profile, date, insertData, actorId, resolveOpenFollowupAlerts });
}

// The CTA's typed date: a real YYYY-MM-DD, today or later.
function typedDateRefusal(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    return reply(400, { error: 'date (YYYY-MM-DD) is required', code: 'followup_date_invalid' });
  }
  if (String(date) < etDateString()) {
    return reply(400, { error: 'Follow-up date must be today or later', code: 'followup_date_past' });
  }
  return null;
}

// The server-side gate for the completion CTA, not a generic booking API:
// the source visit must be completed and its persisted completion must
// actually call for a follow-up. Returns { reply } or { svc, profile, suggestion }.
async function followupVerdictGate(serviceId) {
  const svc = await db('scheduled_services').where({ id: serviceId }).first();
  if (!svc) return { reply: reply(404, { error: 'Service not found' }) };

  const profile = await resolveCompletionProfileForScheduledService(svc).catch(() => null);

  // This is the server-side gate for the completion CTA, not a generic
  // booking API — the source visit must be completed and its persisted
  // completion must actually call for a follow-up (mirrors the /complete
  // followupSuggestion logic, incl. the cockroach German-only rule on the
  // stored snapshot). A stale or crafted POST can't mint included $0
  // appointments for visits that never owed one (Codex P2).
  if (svc.status !== 'completed') {
    return { reply: reply(409, {
      error: 'Follow-ups can only be booked from a completed visit.',
      code: 'followup_source_not_completed',
    }) };
  }
  const evidence = await followupSourceEvidence(svc);
  const laneRefusal = followupLaneRefusal(profile, evidence);
  if (laneRefusal) return { reply: laneRefusal };
  const verdict = followupSuggestion(svc, profile, evidence);
  if (verdict.reply) return verdict;
  return { svc, profile, suggestion: verdict.suggestion };
}

// The completion must have actually run the typed flow: after cutover a
// service's older completions have no typed snapshot — they never earned
// the CTA, so they can't mint an included $0 follow-up (Codex P2). The
// snapshot type must match the profile that owes the follow-up.
async function followupSourceEvidence(svc) {
  const sourceRecord = await db('service_records')
    .where({ scheduled_service_id: svc.id })
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
  const snapshot = parseJsonObject(sourceRecord?.service_data)?.typedReportSnapshot;
  const preAuthFrozenVerdict = parseJsonObject(sourceRecord?.structured_notes)?.typedFollowupVerdict;
  const frozenVerdictPresent = !!(preAuthFrozenVerdict && typeof preAuthFrozenVerdict.required === 'boolean');
  return { snapshot, preAuthFrozenVerdict, frozenVerdictPresent };
}

function followupLaneRefusal(profile, { snapshot, frozenVerdictPresent }) {
  // Untyped alert-policy profiles (bed_bug post-20260731400000) book from
  // the FROZEN verdict their completion persisted; the typed-snapshot
  // gates below stay authoritative for typed profiles (codex P1 r1).
  // A frozen verdict ALSO authorizes the lane by itself: ops deactivating,
  // repointing, or clearing the alert policy after the completion must not
  // reject the promise the completion already made — the frozen-promise
  // contract below applies to this gate too (codex P2 r4).
  const untypedAlertProfile = !profile?.findingsType
    && (profile?.followupPolicy === 'alert' || frozenVerdictPresent);
  if (!profile?.findingsType && !untypedAlertProfile) {
    return reply(409, {
      error: 'Follow-up booking from completion is only available for typed specialty services.',
      code: 'followup_not_typed',
    });
  }
  if (untypedAlertProfile) {
    // Untyped completions always freeze their verdict; a legacy TYPED
    // completion on the now-untyped profile still carries its snapshot.
    // Neither present → the visit never earned the CTA — same "can't mint
    // an included $0 follow-up" guarantee as the typed gate.
    return !frozenVerdictPresent && !snapshot
      ? reply(409, { error: 'This visit was not completed through the follow-up flow.', code: 'followup_no_typed_completion' })
      : null;
  }
  if (!frozenVerdictPresent && (!snapshot || String(snapshot.type || '') !== String(profile.findingsType))) {
    // A frozen verdict bypasses the snapshot gate in BOTH directions: an
    // untyped completion followed by a rollback/repoint that restores the
    // typed pointer has a frozen promise but no snapshot — the mutable
    // profile must not reject it (codex P2 r5). Without a frozen verdict
    // the typed gate stays exactly as before.
    return reply(409, {
      error: 'This visit was not completed through the typed report flow.',
      code: 'followup_no_typed_completion',
    });
  }
  return null;
}

function followupSuggestion(svc, profile, { snapshot, preAuthFrozenVerdict }) {
  // The completion FROZE its final verdict into structured_notes — the
  // CTA must book exactly the promise that was made, so a later profile
  // change (interval, policy, deactivation) can neither reject the
  // original CTA nor authorize a follow-up the completion withheld.
  // Legacy records without a frozen verdict re-derive through the SAME
  // shared override chain the completion ran (species rule incl. the
  // cockroach_control exemption, two-treatment visit-2 stop, German
  // "No"/window selection, palmetto "Yes" upgrade) — a stale or crafted
  // POST still can't mint an included $0 follow-up the verdict withheld.
  const frozenCtaVerdict = preAuthFrozenVerdict;
  const suggestion = (frozenCtaVerdict && typeof frozenCtaVerdict.required === 'boolean')
    ? frozenCtaVerdict
    : typedFollowupVerdict({
      scheduledService: svc,
      profile: profile || {},
      // Pre-freeze legacy records on a now-untyped profile re-derive
      // through their own snapshot's type — the pointer was cleared, not
      // the record (codex P1 r1). The snapshot-presence gate above makes
      // this reachable only with a snapshot in the untyped case.
      findingsType: profile?.findingsType || snapshot?.type || null,
      values: snapshot?.values || {},
    });
  if (!suggestion?.required) {
    return { reply: reply(409, {
      error: 'This completed visit does not call for a follow-up appointment.',
      code: 'followup_not_required',
    }) };
  }
  return { suggestion };
}

// The date that gets booked: the verdict's own (useSuggestedDate, IB repair —
// the same today-or-later rule the CTA's typed date gets) or the CTA's typed
// date, which must be exactly the program-interval date the completion
// computed; any other date is normal scheduling, not an included $0
// follow-up (Codex P2 — this is not a generic booking API).
function followupDate(typedDate, suggestion, useSuggestedDate) {
  let date = typedDate;
  if (useSuggestedDate) {
    date = suggestion.suggestedDate || null;
    if (!date) return { reply: reply(409, { error: 'The follow-up verdict carries no program-interval date.', code: 'followup_date_mismatch', suggestedDate: null }) };
    if (String(date) < etDateString()) {
      return { reply: reply(400, { error: 'Follow-up date must be today or later', code: 'followup_date_past', suggestedDate: String(date) }) };
    }
  }
  if (!suggestion.suggestedDate || String(date) !== String(suggestion.suggestedDate)) {
    return { reply: reply(409, {
      error: `Follow-up must be booked for the program-interval date${suggestion.suggestedDate ? ` (${suggestion.suggestedDate})` : ''}.`,
      code: 'followup_date_mismatch',
      suggestedDate: suggestion.suggestedDate || null,
    }) };
  }
  return { date };
}

// A booked follow-up clears the parked exception — resolve the
// completion-minted follow_up_needed alert(s) so they don't linger as
// stale bells for a visit that is now on the schedule. Called on EVERY
// path that answers "the follow-up exists" (fresh insert, idempotent
// retry, 23505 race winner): a crash or failed resolve after the insert
// must not strand the alert open forever (Codex r1 P2). Best-effort —
// the booking is the durable outcome and never fails on this.
function followupAlertResolver(svc, actorId) {
  const resolveOpenFollowupAlerts = async () => {
    try {
      const { resolveAlert } = require('./dispatch-alerts');
      const openFollowupAlerts = await db('dispatch_alerts')
        .where({ type: 'follow_up_needed', job_id: svc.id })
        .whereNull('resolved_at')
        .select('id');
      for (const alert of openFollowupAlerts) {
        await resolveAlert({ id: alert.id, resolvedBy: actorId || null });
      }
    } catch (e) {
      logger.warn(`[dispatch] follow-up alert resolve failed for ${svc.id}: ${e.message}`);
    }
  };
  return resolveOpenFollowupAlerts;
}

// Appointment windows start on the hour (AGENTS.md scheduling invariant):
// the resolved window — typed or inherited from a legacy/imported source
// visit — passes the same admin validator every staff booking uses before
// it is previewed or written; an off-hour start refuses instead of being
// copied onto the new visit.
// expectedWindow (IB closeout repair): the approved window must still be
// the resolved one.
function windowRefusal(insertData, expectedWindow) {
  if (insertData.window_start) {
    try {
      assertAdminAppointmentWindow({ windowStart: insertData.window_start, windowEnd: insertData.window_end });
    } catch (err) {
      return reply(409, { error: `${err.message} — book this follow-up from Dispatch with a valid window.`, code: 'followup_window_invalid' });
    }
  }
  if (expectedWindow !== undefined && windowDiffers(insertData, expectedWindow)) {
    return reply(409, { error: 'The follow-up window changed since it was approved — ask again for a fresh card.', code: 'followup_window_changed' });
  }
  return null;
}

function windowDiffers(row, expectedWindow) {
  return String(row.window_start || '') !== String(expectedWindow?.start || '')
    || String(row.window_end || '') !== String(expectedWindow?.end || '');
}

// An already-booked child (idempotent retry / 23505 winner) must match every
// approval pin the caller passed — otherwise it is not the approved booking.
function pinDriftReply(row, { expectedWindow, expectedTechnicianId, expectedCustomerId }) {
  const drift = (expectedWindow !== undefined && windowDiffers(row, expectedWindow))
    || (expectedTechnicianId !== undefined && String(row.technician_id || '') !== String(expectedTechnicianId || ''))
    || (expectedCustomerId !== undefined && String(row.customer_id || '') !== String(expectedCustomerId || ''));
  if (!drift) return null;
  return reply(409, {
    error: 'A follow-up is already booked, but not the one that was approved (window, technician or customer differ) — check it on Dispatch.',
    code: 'followup_exists_differs',
    appointment: { id: row.id, scheduledDate: serviceDateOnly(row.scheduled_date), status: row.status },
  });
}

function buildFollowupInsert(svc, cols, { date, windowStart, windowEnd, technicianOverride }) {
  const insertData = {
    customer_id: svc.customer_id,
    technician_id: technicianOverride || svc.technician_id || null,
    scheduled_date: date,
    window_start: windowStart || svc.window_start || null,
    window_end: windowEnd || svc.window_end || null,
    service_type: svc.service_type,
    status: 'pending',
    notes: `Follow-up to ${serviceDateOnly(svc.scheduled_date)} visit (booked at completion)`,
    is_recurring: false,
    followup_included: true,
    followup_source_service_id: svc.id,
  };
  if (cols.service_id && svc.service_id) insertData.service_id = svc.service_id;
  // Same address as the source visit — carry its property identity so
  // the follow-up can join a stop (maybeGroupRow refuses null-property
  // rows, and a follow-up has no estimate for the linkage regroup —
  // GH codex #3699 r6 P2).
  if (cols.property_id && svc.property_id) insertData.property_id = svc.property_id;
  if (cols.zone && svc.zone) insertData.zone = svc.zone;
  if (cols.estimated_duration_minutes && svc.estimated_duration_minutes) insertData.estimated_duration_minutes = svc.estimated_duration_minutes;
  if (cols.estimated_price) insertData.estimated_price = 0;
  if (cols.create_invoice_on_complete) insertData.create_invoice_on_complete = false;
  if (cols.time_window && svc.time_window) insertData.time_window = svc.time_window;
  return insertData;
}

// Preview (IB closeout repair plan): everything before this is read-only;
// report what would be booked, with the inherited technician resolved the
// way the write resolves it (an unassignable one lands unassigned) and the
// advisory overlap the write would warn about.
async function followupPreview({ date, insertData, technicianOverride }) {
  let wouldTechnicianId = insertData.technician_id;
  if (wouldTechnicianId) {
    try {
      await assertAssignableTechnician(wouldTechnicianId, { conn: db, date: String(date).slice(0, 10) });
    } catch (eligErr) {
      if (eligErr.code !== 'TECH_NOT_ASSIGNABLE' || technicianOverride) throw eligErr;
      wouldTechnicianId = null;
    }
  }
  const overlap = insertData.window_start && insertData.window_end
    ? await findConflictingVisits({
      db, date: String(date), windowStart: insertData.window_start, windowEnd: insertData.window_end,
      excludeStatuses: ADMIN_OCCUPANCY_EXCLUDE_STATUSES,
    })
    : [];
  return reply(200, {
    dryRun: true,
    alreadyScheduled: false,
    wouldBook: {
      date: String(date),
      windowStart: insertData.window_start,
      windowEnd: insertData.window_end,
      technicianId: wouldTechnicianId,
      status: 'pending',
      serviceType: insertData.service_type,
      overlap: overlap.length > 0,
    },
  });
}

function followupConflict(message, code) {
  const err = new Error(message);
  err.statusCode = 409;
  err.isOperational = true;
  err.code = code;
  return err;
}

async function commitFollowup({ svc, date, cols, insertData, technicianOverride, expectedTechnicianId, expectedCustomerId, sourceAction }) {
  let overlapWarning = null;
  const [appointment] = await db.transaction(async (trx) => {
    // Rung 1 (scheduling/occupancy.js ORDERING CONTRACT): the date-wide
    // occupancy lock + tech-blind probe FIRST, before the comms key (rung
    // 6) and the source row lock; mirrors the IB create-appointment path. A
    // hit is advisory (owner ruling 2026-08-25 — staff-side saves never
    // block on schedule conflicts): the booking commits with a warning.
    if (insertData.window_start && insertData.window_end) {
      const overlap = await probeSlotOverlap({ trx, date, windowStart: insertData.window_start, windowEnd: insertData.window_end });
      if (overlap.length) overlapWarning = slotOverlapWarning(date);
    }
    // Rung 6: comms-lock the customer around the insert (a bare
    // pg_advisory_xact_lock outside a transaction fences nothing —
    // utils/customer-comms-lock.js).
    await lockCustomerComms(trx, svc.customer_id);
    // Ownership from the LOCKED source visit (r28): a merge-undo can
    // reverse-repoint the source while this request waits on the key —
    // inserting the pre-lock svc.customer_id would leave a follow-up on
    // the kept customer pointing at the restored customer's visit. A
    // moved owner aborts retryably (a second blocking comms acquire
    // while holding the source row would deadlock against the undo).
    const lockedSource = await trx('scheduled_services')
      .where({ id: svc.id }).forUpdate().first('customer_id');
    if (!lockedSource || !lockedSource.customer_id
      || String(lockedSource.customer_id) !== String(svc.customer_id)) {
      throw followupConflict("This appointment's customer changed while booking the follow-up (a merge was undone) — reload the job and try again.", 'VISIT_OWNER_CHANGED');
    }
    // expectedCustomerId (IB closeout repair): the card named this customer.
    if (expectedCustomerId !== undefined && String(lockedSource.customer_id) !== String(expectedCustomerId || '')) {
      throw followupConflict('The visit belongs to a different customer than the one approved — ask again for a fresh card.', 'FOLLOWUP_CUSTOMER_CHANGED');
    }
    // Follow-up bookings inherit the source visit's tech (or an admin
    // override). Assert on the writing trx: an inherited tech who has
    // since been offboarded/de-listed lands the follow-up unassigned; an
    // explicit override that is not assignable is a 422.
    if (insertData.technician_id) {
      try {
        await assertAssignableTechnician(insertData.technician_id, { conn: trx, date: String(date).slice(0, 10) });
      } catch (eligErr) {
        if (eligErr.code !== 'TECH_NOT_ASSIGNABLE' || technicianOverride) throw eligErr;
        logger.warn(`[dispatch] follow-up inherits technician ${insertData.technician_id} who is not assignable; booking unassigned`);
        insertData.technician_id = null;
      }
    }
    // expectedTechnicianId (IB closeout repair): the approval showed this
    // technician (null = unassigned) — refuse rather than book a different one.
    if (expectedTechnicianId !== undefined && String(insertData.technician_id || '') !== String(expectedTechnicianId || '')) {
      throw followupConflict('The follow-up technician changed since it was approved — ask again for a fresh card.', 'FOLLOWUP_TECH_CHANGED');
    }
    // Booking contract (booking/create-scheduled-service.js): validation +
    // source attribution (gate off — the payload otherwise inserts as
    // built above); gated catalog-identity enrichment when on.
    const followupInsert = await completeScheduledServiceInsert(insertData, {
      trx, cols, source: { sourceAction },
    });
    const inserted = await trx('scheduled_services').insert(followupInsert).returning('*');
    // Visit groups (visit-group-scope.md §2): stamp at scheduling —
    // gate-checked + best-effort + self-refusing inside maybeGroupRow
    // (savepoint on the trx; a grouping failure never poisons the
    // follow-up booking).
    if (inserted && inserted[0]) {
      await require('./visit-groups').maybeGroupRow(inserted[0].id, { database: trx, createdBy: 'dispatch' });
    }
    return inserted;
  });
  return { appointment, overlapWarning };
}

async function afterFollowupBooked({ appointment, overlapWarning }, { svc, profile, date, insertData, actorId, resolveOpenFollowupAlerts }) {
  // profile can be null on the frozen-verdict lane (transient resolver
  // failure) — a post-insert throw here would 500 AFTER the booking
  // committed and permanently skip reminder registration on the retry
  // (codex P2 r6).
  logger.info(`[dispatch] follow-up ${appointment.id} booked from ${svc.id} (${profile?.findingsType || 'untyped'}) for ${date}`);
  // Tech-facing "new visit" card (tech-visit-notifications.js): this
  // writer inserts the assigned row itself, bypassing assignDispatchJob.
  // Queued FIRST after commit (before the awaited alert resolution and
  // reminder registration); silent when the booker IS the tech; only a
  // FRESH booking — the alreadyScheduled returns above announced nothing.
  if (appointment.technician_id) {
    void require('./tech-visit-notifications').notifyTechVisitChange({
      visitId: appointment.id, kind: 'assigned', technicianId: appointment.technician_id, actorId: actorId || null,
      snapshot: { date: appointment.scheduled_date, windowStart: appointment.window_start || null, windowEnd: appointment.window_end || null },
    });
  }
  await resolveOpenFollowupAlerts();
  // Without this the visit never enters appointment_reminders, so the
  // 72h/24h reminder cron can't see it (the cron reads only that table).
  // sendConfirmation:false — no immediate SMS; the customer was told about
  // the follow-up in person at completion. Best-effort: never fails the booking.
  try {
    const AppointmentReminders = require('./appointment-reminders');
    await AppointmentReminders.registerAppointment(
      appointment.id,
      svc.customer_id,
      `${date}T${String(insertData.window_start || '08:00').slice(0, 5)}`,
      svc.service_type,
      'booking_followup',
      { sendConfirmation: false },
    );
  } catch (e) {
    logger.error(`[dispatch] Reminder registration failed for follow-up ${appointment.id}: ${e.message}`);
  }
  return reply(200, {
    success: true,
    alreadyScheduled: false,
    appointment: {
      id: appointment.id,
      scheduledDate: serviceDateOnly(appointment.scheduled_date),
      status: appointment.status,
    },
    ...(overlapWarning ? { overlapWarning } : {}),
  });
}

module.exports = { bookCompletionFollowup };
