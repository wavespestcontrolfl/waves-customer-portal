/**
 * Tech-portal tracking routes. Mounted at /api/tech/services.
 *
 * POST /:id/en-route — tech taps "En Route" in the field. Flips
 * BOTH state machines for the service:
 *
 *   1. scheduled_services.status → 'en_route' via transitionJobStatus
 *      (the canonical sole-writer; PRs #328 / #329 / #330 migrated
 *      every other status-write call site to it). This is the
 *      admin-side state — what the dispatch board shows. Brings
 *      atomic guard, job_status_history audit, overdue-alert
 *      auto-resolve, and customer:job_update + dispatch:job_update
 *      broadcasts.
 *
 *   2. scheduled_services.track_state → 'en_route' via
 *      trackTransitions.markEnRoute. This is the customer-facing
 *      state — what /track/:token renders. Also fires the
 *      track-link SMS to the customer (idempotent on track_sms_sent_at).
 *
 * Pre-migration this route only flipped track_state, leaving the
 * admin-side status stuck at 'pending' / 'confirmed' until an admin
 * also touched the dispatch board. After this migration the two
 * state machines stay in sync regardless of which surface the
 * actor uses.
 *
 * Race + atomicity:
 *   transitionJobStatus runs inside a trx with a WHERE status =
 *   fromStatus guard. A concurrent admin transition between our
 *   SELECT and our UPDATE rejects with 409 + a refresh-and-retry
 *   message. markEnRoute is internally idempotent so a retry from
 *   any path is safe.
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('../models/db');
const config = require('../config');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const trackTransitions = require('../services/track-transitions');
const { transitionJobStatus } = require('../services/job-status');
const { isPendingOutboundReviewBooking } = require('../services/call-booking-source-actions');
const { runOutboundReviewConfirmHook } = require('../services/outbound-review-confirm');

// ── Dispatch-implies-confirm phases (owner decision 2026-08-11) ──
//
// A pending outbound-callback booking used to 409 the tech's En Route /
// On Site taps ("pending office review"). With one owner-operator running
// both portals, the assigned tech's field tap IS the review, so these taps
// auto-confirm first. Three phases, shared by both routes:
//
//   1. confirm  — row-locked trx: recheck ownership + review state, stamp
//                 customer_confirmed, pending → confirmed.
//   2. hook     — the SAME post-commit best-effort side effects the admin
//                 confirm paths run (arm deferred reminders, convert the
//                 originating call lead, resolve the outbound_booking_review
//                 card, inspection-credit evidence, card-on-file request).
//                 MUST run while status is still 'confirmed': the card
//                 funnel rejects visits past confirmed, and the previsit
//                 sweep has the same status list. Day-of reminder arming
//                 sends nothing (72h leg fires only >24.25h out; 24h leg
//                 only for tomorrow-ET visits).
//   3. advance  — row-locked trx: recheck ownership + future-date, then the
//                 status CAS to en_route / on_site.
//
// The card-on-file leg is SKIPPED on this path (owner decision 2026-08-11,
// Codex rounds 1/3/4 on PR #3356): the funnel's pending/confirmed
// eligibility window can't survive a confirm that immediately advances, and
// the tech is driving to meet the customer anyway — card collected in
// person. Office-confirmed bookings keep the full funnel. The remaining
// hook legs (reminders, lead, triage, inspection credit) are status-
// insensitive and idempotent, so no cross-request fence is needed.

// Phases 1 + 2. Throws TECH_OWNERSHIP_LOST / FUTURE_SCHEDULED_DATE /
// REVIEW_STATE_CHANGED (the routes translate to 403 / 409).
async function autoConfirmOutboundReviewBooking(req, svc) {
  await db.transaction(async (trx) => {
    // Recheck INSIDE the trx, row-locked: the pre-trx ownership check alone
    // leaves a window where dispatch reassigns the visit (same race admin-
    // schedule's status route locks against), and the office can resolve
    // the review concurrently.
    const fresh = await trx('scheduled_services')
      .where({ id: svc.id })
      .forUpdate()
      .first('technician_id', 'status', 'customer_confirmed', 'source_action', 'scheduled_date');
    if (!fresh || fresh.technician_id !== req.technicianId) {
      const e = new Error('Not assigned to this service');
      e.code = 'TECH_OWNERSHIP_LOST';
      throw e;
    }
    // Re-run the stale-tap date guard under the row lock (Codex P1 round 4):
    // the route-entry check used the pre-lock snapshot, and a visit moved to
    // a future day must not be APPROVED by a stale tap — phase 3 rejecting
    // the advance later doesn't help once the confirmation is permanent.
    if (trackTransitions.isFutureScheduledDate(fresh.scheduled_date)) {
      const e = new Error('Rescheduled to a future date');
      e.code = 'FUTURE_SCHEDULED_DATE';
      throw e;
    }
    if (!isPendingOutboundReviewBooking(fresh)) {
      const e = new Error('Review state changed');
      e.code = 'REVIEW_STATE_CHANGED';
      throw e;
    }
    // ⭐ NO STAMP IN HERE. `customer_confirmed` is the completion RECEIPT for
    // the activation legs, not merely a lifecycle flag: the legacy activation
    // helper skips a stamped row and the hourly sweep selects on unstamped
    // ones. Stamping in this transaction and then running a best-effort hook
    // meant a failed leg left the field-confirmed booking half-armed with NO
    // retry rail — the same hole the two admin confirm routes had, and voice
    // rows reach this path too now that the office-review set includes them.
    // The stamp moved to the hook's success, below.
    // ⭐ THE FIELD-CONFIRM MODE IS PERSISTED, NOT JUST PASSED. skipCardRequest
    // used to live only in this route's call — a failed core leg then left the
    // row for the hourly sweep, whose retry ran WITHOUT it and pushed the
    // field-confirmed booking through the card funnel the owner rule says to
    // skip. Stamped in the same transaction as the confirmation; every
    // activation rail reads it.
    await trx('scheduled_services')
      .where({ id: svc.id })
      .whereNull('field_confirmed_at')
      .update({ field_confirmed_at: new Date() });
    await transitionJobStatus({
      jobId: svc.id,
      fromStatus: 'pending',
      toStatus: 'confirmed',
      transitionedBy: req.technicianId,
      // This route owns the activation (field semantics: the card funnel is
      // skipped because the tech collects in person), so the shared writer
      // must not fire its lazy one too.
      legacyOutboundActivation: 'caller',
      trx,
    });
  });

  // Re-read AFTER the confirm commit so the hook arms reminders with the
  // CURRENT schedule (Codex P1 round 3): a reschedule landing between
  // phase 1 and the hook would otherwise leave the moved visit carrying a
  // reminder clock built from the stale snapshot — registerAppointment
  // persists the supplied time and returns existing rows unchanged.
  const hookRow = await db('scheduled_services')
    .where({ id: svc.id })
    .first(
      'id', 'customer_id', 'scheduled_date', 'window_start', 'service_type',
      'source_call_log_id', 'is_callback', 'estimated_price',
    );

  // Hook FIRST, stamp on success — the stamp deferred out of the transaction
  // above lands inside this helper, and only when the core legs ran. A failure
  // leaves the row confirmed-but-unstamped, which is exactly what the hourly
  // legacy-activation sweep exists to drain. skipCardRequest — see the header
  // comment above (a field confirm collects the card in person).
  const { runOfficeConfirmActivation } = require('../services/outbound-review-confirm');
  await runOfficeConfirmActivation(db, hookRow || svc, 'tech-track', { skipCardRequest: true });

  // Post-hook reminder repair (Codex P1 rounds 4–5): an office action can
  // commit between the hookRow snapshot and registerAppointment's insert —
  // that writer saw no reminder row to move/close, so the just-armed row
  // needs reconciling against the CURRENT visit. One re-read, three cases:
  //
  //   • Cancelled during the hook → close the reminder row (the cancel path
  //     found nothing to close). handleCancellation is internally guarded —
  //     it no-ops unless the visit is still 'cancelled' at write time — and
  //     sendNotification:false sends nothing (the cancel route owns any
  //     customer notice; one skipped for lack of a row can't be conjured
  //     retroactively — the owner sends comms, never this route).
  //   • Moved to a slot WITH a real window → silently sync the reminder
  //     clock (sendNotification:false — the reschedule path owns any
  //     notice; expectSchedule makes the sync atomically miss if yet
  //     another move lands, since that newer move now finds the row and
  //     syncs it itself).
  //   • Window CLEARED (null) → deliberately do nothing. The armed row
  //     keeps its now-past appointment_time and can never fire (both cron
  //     legs require the time to still be ahead), which is exactly the
  //     windowless placeholder's never-send semantics — fabricating a
  //     fallback time here would promise the customer a slot nobody
  //     selected. A later edit that sets a real window finds the row and
  //     re-arms it through the normal reschedule path.
  try {
    const post = await db('scheduled_services')
      .where({ id: svc.id })
      .first('status', 'scheduled_date', 'window_start');
    const dateOnly = (v) => (v instanceof Date ? v.toISOString().split('T')[0] : String(v || '').split('T')[0]);
    const AppointmentReminders = require('../services/appointment-reminders');
    if (post && String(post.status) === 'cancelled') {
      await AppointmentReminders.handleCancellation(svc.id, { sendNotification: false });
      logger.info(`[tech-track] Closed reminder for ${svc.id} — visit cancelled during confirm hook`);
    } else if (post && hookRow && post.window_start
      && (dateOnly(post.scheduled_date) !== dateOnly(hookRow.scheduled_date)
        || String(post.window_start) !== String(hookRow.window_start || ''))) {
      await AppointmentReminders.handleReschedule(
        svc.id,
        `${dateOnly(post.scheduled_date)}T${post.window_start}`,
        {
          sendNotification: false,
          expectSchedule: { date: dateOnly(post.scheduled_date), windowStart: post.window_start },
        },
      );
      logger.info(`[tech-track] Synced reminder clock for ${svc.id} — schedule moved during confirm hook`);
    }
  } catch (e) {
    logger.error(`[tech-track] post-hook reminder repair failed for ${svc.id}: ${e.message}`);
  }
}

// Phase-3 entry guard. The status CAS alone is NOT enough (Codex P1
// round 2): the phase-2 window admits a reassignment (technician_id only —
// status stays 'confirmed') or a future-date reschedule (date/window only),
// and either stale advance would text the customer a tracking notice.
// Throws TECH_OWNERSHIP_LOST / FUTURE_SCHEDULED_DATE.
async function guardAdvance(trx, req, svc) {
  const fresh = await trx('scheduled_services')
    .where({ id: svc.id })
    .forUpdate()
    .first('technician_id', 'scheduled_date');
  if (!fresh || fresh.technician_id !== req.technicianId) {
    const e = new Error('Not assigned to this service');
    e.code = 'TECH_OWNERSHIP_LOST';
    throw e;
  }
  if (trackTransitions.isFutureScheduledDate(fresh.scheduled_date)) {
    const e = new Error('Rescheduled to a future date');
    e.code = 'FUTURE_SCHEDULED_DATE';
    throw e;
  }
}

// Shared 403/409 translations for the phase errors above plus the shared
// writer's typed conflicts. Returns true if the response was sent.
function respondToTransitionConflict(res, err, fromStatus) {
  if (err && err.code === 'TECH_OWNERSHIP_LOST') {
    // Same contract as the routes' pre-trx ownership check.
    res.status(403).json({ error: 'Not assigned to this service' });
    return true;
  }
  if (err && err.code === 'FUTURE_SCHEDULED_DATE') {
    // Same contract as the pre-trx stale-tap guard.
    res.status(409).json({
      error: 'This job has been rescheduled to a future date. Refresh your route.',
      code: 'future_scheduled_date',
    });
    return true;
  }
  if (err && err.code === 'REVIEW_STATE_CHANGED') {
    res.status(409).json({
      error: 'This booking was just updated by the office. Refresh your route and try again.',
      code: 'review_state_changed',
    });
    return true;
  }
  // The shared writer's review-booking guard should no longer fire on these
  // routes (auto-confirm above) — kept as a safety net for a race with a
  // concurrent office reject.
  if (err && err.code === 'OUTBOUND_REVIEW_UNCONFIRMED') {
    res.status(409).json({
      error: 'This outbound-callback booking is pending office review — confirm it before dispatching.',
      code: 'outbound_review_unconfirmed',
    });
    return true;
  }
  if (err && err.message && err.message.includes('not in state')) {
    res.status(409).json({
      error: `Job is no longer in state ${fromStatus} (concurrent transition). Refresh and try again.`,
    });
    return true;
  }
  return false;
}
const {
  buildOnSiteLifecycleUpdates,
} = require('../utils/service-duration-capture');
const {
  promoteStagedPhotosForCompletedVisit,
  sanitizeCustomerFacingPhotoCaption,
  uploadServicePhotoBuffer,
  uploadStagedServicePhotoBuffer,
  VALID_PHOTO_TYPES,
} = require('../services/service-photos');
const {
  photoMarksGateOn,
  markKindsForLane,
  defaultKindForLane,
  laneSupportsMarks,
  validateMarks,
  saveMarksForPhoto,
  loadMarksByS3Key,
  MAX_MARKS_PER_PHOTO,
} = require('../services/service-report/photo-marks');

router.use(adminAuthenticate, requireTechOrAdmin);

// Photo upload setup. Same shape as admin-projects.js so prod ops
// only has one S3 bucket + credentials path to manage.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});

// POST /api/tech/services/:id/en-route
router.post('/:id/en-route', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first(
        'id', 'technician_id', 'status', 'scheduled_date',
        // Stale-attempt evidence for the on_site heal delegation below.
        'track_state', 'en_route_at', 'arrived_at', 'actual_start_time', 'check_in_time',
        // The trailing columns feed the outbound-review auto-confirm below
        // (detection + the confirm hook's reminder/lead/credit legs).
        'source_action', 'customer_confirmed', 'customer_id', 'window_start',
        'service_type', 'source_call_log_id', 'is_callback', 'estimated_price',
      );

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Tech can only flip their own assigned services. Admins with
    // requireTechOrAdmin go through admin-dispatch; don't bypass here.
    if (svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

    // Stale-tap guard: a live job force-rescheduled to a future day
    // (rebooker allowLive) looks confirmed again — a tap from a tech
    // page opened before the reschedule must not advance the future
    // visit. See track-transitions.isFutureScheduledDate.
    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: 'This job has been rescheduled to a future date. Refresh your route.',
        code: 'future_scheduled_date',
      });
    }

    // Source-status gate: transitionJobStatus is permissive (it
    // accepts any from→to pair as long as the atomic guard matches),
    // so without a route-level check a tech could hit /en-route on a
    // completed/cancelled/skipped job and regress status backwards.
    // Codex P1 on PR #335.
    //
    // Allowed sources for going en_route:
    //   - pending / confirmed / rescheduled : a real forward flip
    //   - en_route                          : idempotent re-tap; we
    //                                         skip the trx entirely
    //                                         and let markEnRoute's
    //                                         own idempotency handle
    //                                         it (avoids a noisy
    //                                         same-status row in
    //                                         job_status_history)
    // Not allowed: on_site, completed, cancelled, skipped — all 409,
    // with ONE exception: a STALE 'on_site' left behind by a legacy date
    // move (lifecycle evidence predates the row's own scheduled day) is
    // not today's real on-site — it is exactly the shape markEnRoute's
    // self-heal rewinds, and rejecting it here would leave the visit
    // permanently unable to go en route. Delegate it: skip this route's
    // own status flip (the heal rewinds on_site→confirmed with its
    // history row inside its own trx) and let markEnRoute run the fresh
    // flip with the operational sync.
    const fromStatus = svc.status;
    const PRE_EN_ROUTE = new Set(['pending', 'confirmed', 'rescheduled']);
    const staleOnSiteHeal = fromStatus === 'on_site' && trackTransitions.isStaleLiveAttempt(svc);
    if (!PRE_EN_ROUTE.has(fromStatus) && fromStatus !== 'en_route' && !staleOnSiteHeal) {
      return res.status(409).json({
        error: `Cannot mark en-route from status '${fromStatus}'`,
      });
    }

    // Dispatch-implies-confirm — see the phase helpers at the top of this
    // file. The shared-writer guard still blocks every other caller; the
    // admin surfaces keep their explicit review flow.
    const autoConfirmReview = isPendingOutboundReviewBooking(svc);

    // 1. Admin-side status flip via transitionJobStatus. Same
    // migration pattern as PRs #328 / #329 / #330. The trx + atomic
    // guard rejects on a concurrent transition; we surface as 409.
    // Skipped on the en_route → en_route idempotent path so we don't
    // write a same-status job_status_history row + re-fire broadcasts
    // for a no-op tap.
    if (fromStatus !== 'en_route' && !staleOnSiteHeal) {
      try {
        if (autoConfirmReview) {
          await autoConfirmOutboundReviewBooking(req, svc);
        }
        await db.transaction(async (trx) => {
          await guardAdvance(trx, req, svc);
          await transitionJobStatus({
            jobId: svc.id,
            fromStatus: autoConfirmReview ? 'confirmed' : fromStatus,
            toStatus: 'en_route',
            transitionedBy: req.technicianId,
            trx,
          });
        });
      } catch (err) {
        if (respondToTransitionConflict(res, err, fromStatus)) return undefined;
        throw err;
      }
    }

    // 2. Customer-facing track_state flip + SMS. Post-trx,
    // idempotent — markEnRoute checks track_state and returns
    // alreadyEnRoute=true (no SMS re-fire) if already advanced.
    // We don't roll back the admin-side status flip if this fails;
    // the dispatch board reflecting reality is more important than
    // the customer SMS firing.
    const result = await trackTransitions.markEnRoute(svc.id, {
      actorType: 'tech',
      actorId: req.technicianId,
      // Stale-heal delegation: this route skipped its own status flip, so
      // the healed re-entry syncs the operational side (confirmed →
      // en_route, with history) itself.
      ...(staleOnSiteHeal ? { syncOperationalStatus: true } : {}),
    });

    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.reason });
    }

    // Delegated stale heal: markEnRoute's operational sync is best-effort
    // (it logs and continues), so verify the status actually landed before
    // reporting success — a sync failure would leave status='confirmed'
    // beside track_state='en_route'. A re-tap converges: confirmed is a
    // valid en-route source, and the tracker side is idempotent.
    if (staleOnSiteHeal) {
      const after = await db('scheduled_services').where({ id: svc.id }).first('status');
      if (after?.status !== 'en_route') {
        return res.status(409).json({
          error: 'The stale visit was reset but the status update did not complete — tap En Route again.',
          code: 'stale_heal_status_sync_incomplete',
        });
      }
    }

    logger.info(
      `[tech-track] en-route service=${svc.id} tech=${req.technicianId} ` +
      `fromStatus=${fromStatus} smsSent=${result.smsSent} alreadyEnRoute=${!!result.alreadyEnRoute} ` +
      `outboundReviewAutoConfirmed=${autoConfirmReview}`
    );

    res.json({
      state: result.state,
      enRouteAt: result.enRouteAt,
      smsSent: result.smsSent,
      alreadyEnRoute: !!result.alreadyEnRoute,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/tech/services/:id/on-site
//
// Manual companion to geofence arrival. Tech Home needs a reliable way
// to stamp the customer-facing "Arrived on site" report event when the
// geofence prompt does not appear or the tech is working without a
// precise location signal.
router.post('/:id/on-site', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    if (svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

    // Stale-tap guard — same as /en-route above.
    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: 'This job has been rescheduled to a future date. Refresh your route.',
        code: 'future_scheduled_date',
      });
    }

    const fromStatus = svc.status;
    const PRE_ON_SITE = new Set(['pending', 'confirmed', 'rescheduled', 'en_route']);
    if (!PRE_ON_SITE.has(fromStatus) && fromStatus !== 'on_site') {
      return res.status(409).json({
        error: `Cannot mark on-site from status '${fromStatus}'`,
      });
    }

    // Dispatch-implies-confirm — same phase helpers as the en-route leg.
    // Arrival without a prior En Route tap (geofence or manual) must not
    // dead-end on the review popup either.
    const autoConfirmReview = isPendingOutboundReviewBooking(svc);

    if (fromStatus !== 'on_site') {
      const arrivedAt = new Date();
      try {
        if (autoConfirmReview) {
          await autoConfirmOutboundReviewBooking(req, svc);
        }
        await db.transaction(async (trx) => {
          await guardAdvance(trx, req, svc);
          const lifecycleUpdates = buildOnSiteLifecycleUpdates(svc, arrivedAt);
          if (Object.keys(lifecycleUpdates).length > 0) {
            await trx('scheduled_services').where({ id: svc.id }).update(lifecycleUpdates);
          }
          await transitionJobStatus({
            jobId: svc.id,
            fromStatus: autoConfirmReview ? 'confirmed' : fromStatus,
            toStatus: 'on_site',
            transitionedBy: req.technicianId,
            trx,
          });
        });
      } catch (err) {
        if (respondToTransitionConflict(res, err, fromStatus)) return undefined;
        throw err;
      }
    }

    const result = await trackTransitions.markOnProperty(svc.id, { actingTechId: req.technicianId });
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.reason });
    }

    logger.info(
      `[tech-track] on-site service=${svc.id} tech=${req.technicianId} ` +
      `fromStatus=${fromStatus} arrivedAt=${result.arrivedAt || 'n/a'}`
    );

    return res.json({
      state: result.state,
      arrivedAt: result.arrivedAt,
      alreadyOnSite: fromStatus === 'on_site',
    });
  } catch (err) {
    next(err);
  }
});

// ── Rain-out: weather hits mid-route, the tech moves the visit (or the
// rest of today's route) and the customer gets a "we moved you" text
// they can adjust by replying 1/2 (existing reschedule-sms webhook).
// All heavy lifting in services/rain-out.js.

// GET /api/tech/services/:id/rain-out-options
router.get('/:id/rain-out-options', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'technician_id', 'scheduled_date');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

    // Stale-tap guard — same as /en-route and /on-site: a job dispatch
    // already moved to a future day must not be rain-out'd back to
    // today from a stale Tech Home tab.
    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: 'This job has been rescheduled to a future date. Refresh your route.',
        code: 'future_scheduled_date',
      });
    }

    const RainOut = require('../services/rain-out');
    const options = await RainOut.getOptions(req.params.id);
    if (!options.ok) {
      return res.status(options.reason === 'not_found' ? 404 : 409).json({ error: options.reason });
    }
    return res.json(options);
  } catch (err) {
    next(err);
  }
});

// POST /api/tech/services/:id/rain-out
// body: { reasonCode, scope: 'job'|'route', target: { date, window?, deltaMinutes? },
//         notifyCustomer? }
router.post('/:id/rain-out', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'technician_id', 'scheduled_date');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

    // Stale-tap guard — same as /en-route and /on-site. The guard is on
    // the job's CURRENT date (acting on a job that's no longer today's),
    // not on the rain-out target, which may legitimately be future.
    if (trackTransitions.isFutureScheduledDate(svc.scheduled_date)) {
      return res.status(409).json({
        error: 'This job has been rescheduled to a future date. Refresh your route.',
        code: 'future_scheduled_date',
      });
    }

    const { reasonCode, scope, target, notifyCustomer } = req.body || {};
    if (target?.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(target.date))) {
      return res.status(400).json({ error: 'target.date must be YYYY-MM-DD' });
    }

    const RainOut = require('../services/rain-out');
    const result = await RainOut.commit({
      serviceId: req.params.id,
      technicianId: req.technicianId,
      reasonCode,
      scope: scope === 'route' ? 'route' : 'job',
      target,
      notifyCustomer: notifyCustomer !== false,
      // Authenticated tech quick-move tap — the moved SMS is exempt from
      // the 8AM-8PM send window (operator-initiated, not machine-initiated).
      operatorInitiated: true,
    });

    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404
        : ['bad_reason', 'bad_target', 'noshow_route_scope', 'target_not_later',
          'custom_route_scope', 'custom_requires_note', 'note_too_many_segments'].includes(result.reason) ? 400
          : 409;
      return res.status(code).json({ error: result.reason, results: result.results || [] });
    }

    // Re-arm each moved stop's appointment reminder onto the new slot —
    // mirrors the admin-dispatch rain-out route. Without this, a tech
    // moving a stop to a future day left appointment_reminders on the old
    // slot, so the 24h/72h reminders fired for a time nobody was coming.
    // The rain-out sends its own "we moved you" SMS inside commit(), so
    // sendNotification is always false; coverDueWindows + notice-sent only
    // when that SMS actually went out (otherwise leave the reminder
    // pending so the cron still reminds the customer on the new slot).
    const AppointmentReminders = require('../services/appointment-reminders');
    for (const moved of result.results || []) {
      if (!moved.ok) continue;
      try {
        const startHHMM = (moved.newWindow && moved.newWindow.start) || '08:00';
        await AppointmentReminders.handleReschedule(
          moved.id,
          `${String(moved.newDate).split('T')[0]}T${startHHMM}`,
          { sendNotification: false, coverDueWindows: moved.smsSent === true },
        );
        if (moved.smsSent === true) {
          await AppointmentReminders.markRescheduleNoticeSent(moved.id);
        }
      } catch (err) {
        logger.warn(`[tech-track] rain-out committed for ${moved.id}, but reminder sync failed: ${err.message}`);
      }
    }

    logger.info(
      `[tech-track] rain-out service=${req.params.id} tech=${req.technicianId} ` +
      `scope=${scope === 'route' ? 'route' : 'job'} moved=${result.movedCount} failed=${result.failedCount}`
    );
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/tech/services/:id/photos — tech-portal field photo upload.
//
// Multipart upload. Photos captured before completion are staged against the
// scheduled visit; completed visits write directly to service_photos.
//
// Why service_record_id and not scheduled_service_id directly:
//   service_records is the canonical "completion happened" audit
//   record. service_photos has been keyed off it since the initial
//   schema (20260401000001). Photos belong to a specific completion
//   visit, not to a scheduled future visit.
//
// What unlocks: missed_photo dispatch_alert detector. With photos
// landing here, a future cron can flag completions where no photo
// was attached within N minutes — see action-queue spec.
router.post('/:id/photos', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });

    const photoType = req.body.photoType || 'progress';
    if (!VALID_PHOTO_TYPES.has(photoType)) {
      return res.status(400).json({
        error: `Invalid photoType — must be one of: ${[...VALID_PHOTO_TYPES].join(', ')}`,
      });
    }
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'customer_id', 'technician_id', 'scheduled_date');

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Techs can only attach photos to their own assigned services.
    // Admin dispatch can attach completion-panel photos for any route row.
    if (req.techRole !== 'admin' && svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }
    const caption = sanitizeCustomerFacingPhotoCaption(req.body.caption);

    // Find the service_record for this scheduled_service via the
    // direct FK (migration 20260427000007). The completion route
    // (POST /:serviceId/complete, PR #330) populates
    // scheduled_service_id on the new row so this lookup is
    // unambiguous — no collisions when a single tech has two
    // visits for the same customer on the same day.
    const serviceRecord = await db('service_records')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first('id');

    if (!serviceRecord) {
      const row = await uploadStagedServicePhotoBuffer({
        scheduledServiceId: svc.id,
        technicianId: req.technicianId,
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        photoType,
        sortOrder: req.body.sortOrder,
        caption,
        gpsLat: req.body.gpsLat,
        gpsLng: req.body.gpsLng,
        capturedAt: req.body.capturedAt,
      });
      logger.info(
        `[tech-track] photo staged service=${svc.id} tech=${req.technicianId} ` +
        `type=${photoType} size=${req.file.size}`
      );
      // Completion may have committed after the record lookup above. Recover
      // immediately when visible; GET /photos repeats this recovery so an
      // upload that raced an uncommitted completion cannot remain stranded.
      const recovery = await promoteStagedPhotosForCompletedVisit({
        scheduledServiceId: svc.id,
      });
      if (recovery) {
        const promoted = recovery.photos.find((photo) => photo.s3_key === row.s3_key)
          || await db('service_photos')
            .where({ service_record_id: recovery.serviceRecordId, s3_key: row.s3_key })
            .first();
        return res.json({ photo: promoted || { ...row, staged: true } });
      }
      return res.json({ photo: { ...row, staged: true } });
    }

    const row = await uploadServicePhotoBuffer({
      serviceRecordId: serviceRecord.id,
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      photoType,
      sortOrder: req.body.sortOrder,
      caption,
      thumbnailKey: req.body.thumbnailKey,
      stateBadge: req.body.stateBadge,
      zoneId: req.body.zoneId,
      findingId: req.body.findingId,
      gpsLat: req.body.gpsLat,
      gpsLng: req.body.gpsLng,
      // Old camera-roll metadata would sort ahead of the existing hash-chain
      // tail. Post-completion attachments use upload time instead.
      capturedAt: undefined,
      device: req.body.device,
      appVersion: req.body.appVersion,
      aiTags: req.body.aiTags,
      annotation: req.body.annotation,
    });

    logger.info(
      `[tech-track] photo uploaded service=${svc.id} record=${serviceRecord.id} ` +
      `tech=${req.technicianId} type=${photoType} size=${req.file.size}`
    );

    res.json({ photo: row });
  } catch (err) {
    logger.error(`[tech-track] photo upload failed: ${err.message}`);
    next(err);
  }
});

// GET /api/tech/services/:id/photos — list photos already attached
// to this service's service_record. Returns presigned S3 URLs (1h
// expiry) so the tech UI can render thumbnails of what they've
// already uploaded for this visit.
router.get('/:id/photos', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'customer_id', 'technician_id', 'scheduled_date');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (req.techRole !== 'admin' && svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }

    // Direct FK lookup, same shape as POST. Migration 20260427000007.
    const serviceRecord = await db('service_records')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first('id');
    if (!serviceRecord) {
      const staged = await db('scheduled_service_photo_staging')
        .where({ scheduled_service_id: svc.id })
        .orderBy('captured_at', 'asc')
        .orderBy('sort_order', 'asc');
      if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });
      const photos = await Promise.all(staged.map(async (p) => ({
        ...p,
        staged: true,
        url: await getSignedUrl(s3, new GetObjectCommand({
          Bucket: config.s3.bucket, Key: p.s3_key,
        }), { expiresIn: 3600 }),
      })));
      return res.json({ photos, staged: true });
    }

    // Recovery for the narrow race where completion inserted its record after
    // POST /photos staged the file but had already passed its promotion step.
    await promoteStagedPhotosForCompletedVisit({ scheduledServiceId: svc.id });

    const photos = await db('service_photos')
      .where({ service_record_id: serviceRecord.id })
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc')
      .select('id', 'photo_type', 's3_key', 'caption', 'sort_order', 'created_at');

    // Presigned URLs are signed per-photo. Bucket misconfiguration
    // surfaces as 500 here — same shape as the upload endpoint, kept
    // explicit instead of swallowed.
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });
    const enriched = await Promise.all(photos.map(async (p) => {
      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: config.s3.bucket, Key: p.s3_key,
      }), { expiresIn: 3600 });
      return { ...p, url };
    }));

    res.json({ photos: enriched });
  } catch (err) {
    logger.error(`[tech-track] photos list failed: ${err.message}`);
    next(err);
  }
});

// ── Treated-point marks on a service photo (GATE_PHOTO_MARKS, dark) ────────────
// The technician photographs the area they actually treated and taps the
// treated points on it. Marks are metadata keyed on the photo's S3 KEY — never
// composited into the image (that would break the service_photos hash chain)
// and never keyed on service_photos.id (promotion of a staged photo deletes
// and re-inserts that row under a new id mid-visit).
//
// Marks are OPTIONAL by owner ruling: a visit with none is complete, so these
// endpoints exist to be skipped without consequence.
// 'before' is definitionally pre-treatment, so it can never carry treated
// points. The rest ('after', 'progress', 'issue') depict the visit's own work
// or findings and can legitimately show where treatment was applied.
const MARKABLE_PHOTO_TYPES = new Set(['after', 'progress', 'issue']);

// The lane whose mark vocabulary applies to this visit. The PRIMARY wins when
// it supports marks; otherwise any ADD-ON line that resolves to a photo lane
// does (codex P1 r3) — a termite-bait primary with a foam add-on is a foam
// visit for marking purposes, and checking only the primary left those techs
// with no way to record the points they drilled.
async function markLaneForService(svc) {
  const { addonVerdictsFromLines, resolveAddonVerdicts } = require('../services/service-report/trace-eligibility');

  // A COMPLETED visit resolves from the identity frozen into its record, not
  // from the mutable schedule row (codex P2 r4). The report renders from
  // completedServiceKey / completedAddonLines, so resolving live here lets an
  // admin repoint via update-details desynchronize the two: the route would
  // accept marks for a lane that never renders, or reject a clear for a
  // removed lane while its old pins stay customer-visible.
  let frozen = null;
  try {
    const record = await db('service_records')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first('service_data');
    const data = record?.service_data
      ? (typeof record.service_data === 'string' ? JSON.parse(record.service_data) : record.service_data)
      : null;
    // The primary and the add-on snapshot freeze INDEPENDENTLY (codex P2 r7).
    // Completion's add-on freezer is fail-soft, so a record can carry
    // completedServiceKey with no completedAddonLines. Requiring both
    // discarded a perfectly good frozen primary and fell back to the mutable
    // schedule row — so after an admin repoint the report still resolved the
    // frozen foam key and showed its pins while this route reported marks
    // unsupported. Mirrors report-data: frozen primary wins, absent add-on
    // snapshot falls back to live rows.
    if (data && Object.prototype.hasOwnProperty.call(data, 'completedServiceKey')) frozen = data;
  } catch { /* fall through to the live resolution below */ }

  let primaryKey = null;
  let addonVerdicts = null;   // null = not yet resolved
  if (frozen) {
    primaryKey = frozen.completedServiceKey || null;
    // Only when the add-on snapshot actually froze; otherwise leave null so
    // the live fallback below still runs (codex P2 r7).
    if (Array.isArray(frozen.completedAddonLines)) {
      addonVerdicts = await addonVerdictsFromLines(frozen.completedAddonLines, db).catch(() => []);
    }
  } else {
    const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
    const profile = await resolveCompletionProfileForScheduledService(svc, db);
    primaryKey = profile?.serviceKey || null;
  }
  if (laneSupportsMarks(primaryKey)) return primaryKey;

  try {
    // Scan every line for a photo lane — not combineLineVerdicts, which stops
    // at the primary or the first eligible add-on (codex P1 r4). Must match
    // the report's scan or the two disagree about whether marks may exist.
    if (addonVerdicts === null) addonVerdicts = await resolveAddonVerdicts(svc.id, db);
    const photoLine = (addonVerdicts || []).find(
      (v) => v?.eligible && v.variant === 'photo' && laneSupportsMarks(v.serviceKey),
    );
    if (photoLine) return photoLine.serviceKey;
  } catch { /* fail-soft: the primary key stands, marks simply aren't offered */ }
  return primaryKey;
}

router.get('/:id/photo-marks', async (req, res, next) => {
  try {
    if (!photoMarksGateOn()) return res.status(404).json({ error: 'Not found' });
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'customer_id', 'technician_id', 'scheduled_date', 'service_type', 'service_id');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (req.techRole !== 'admin' && svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }
    // Lane resolution failure is not a 500: the tech simply gets no marking
    // affordance, same fail-soft posture as the rest of the tech portal.
    const serviceKey = await markLaneForService(svc).catch(() => null);
    const byKey = await loadMarksByS3Key({ scheduledServiceId: svc.id });
    res.json({
      supported: laneSupportsMarks(serviceKey),
      kinds: markKindsForLane(serviceKey),
      defaultKind: defaultKindForLane(serviceKey),
      maxMarks: MAX_MARKS_PER_PHOTO,
      marksByS3Key: Object.fromEntries(byKey),
    });
  } catch (err) {
    logger.error(`[tech-track] photo-marks list failed: ${err.message}`);
    next(err);
  }
});

// Whole-set replace for ONE photo: the stored set always equals what the tech
// last saw. An empty array clears the marks, which is how Skip is honoured
// after a previous save.
router.put('/:id/photo-marks', async (req, res, next) => {
  try {
    if (!photoMarksGateOn()) return res.status(404).json({ error: 'Not found' });
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'customer_id', 'technician_id', 'scheduled_date', 'service_type', 'service_id');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (req.techRole !== 'admin' && svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }
    const s3Key = typeof req.body?.s3Key === 'string' ? req.body.s3Key.trim() : '';
    if (!s3Key) return res.status(400).json({ error: 's3Key is required' });

    // The posted key must belong to THIS visit — either a staged photo or a
    // promoted one. Without this check a caller could attach marks to another
    // customer's photo by guessing its key.
    const visitPhoto = await findVisitPhotoByKey(svc.id, s3Key);
    if (!visitPhoto) return res.status(404).json({ error: 'Photo not found on this service' });
    // A 'before' photo documents the state BEFORE any treatment, so marks on
    // it would publish a pre-treatment image under copy calling it the treated
    // area (codex P1). Rejected server-side, not merely hidden in the UI —
    // the render is the customer-facing guarantee.
    if (!MARKABLE_PHOTO_TYPES.has(String(visitPhoto.photo_type || ''))) {
      return res.status(400).json({
        error: 'Treated-point marks can only go on a photo taken during or after treatment.',
        code: 'photo_not_markable',
      });
    }

    const serviceKey = await markLaneForService(svc).catch(() => null);
    const validation = validateMarks(req.body?.marks, { serviceKey });
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const saved = await saveMarksForPhoto({
      scheduledServiceId: svc.id,
      s3Key,
      marks: validation.marks,
      technicianId: req.technicianId || null,
    });
    logger.info(
      `[tech-track] photo marks saved service=${svc.id} tech=${req.technicianId} count=${saved.length}`
    );

    // Marks render on the report, so a completed visit's cached PDF is stale
    // the moment they are saved, edited, or cleared — and the cache key is
    // content-insensitive, so without this the customer keeps downloading a
    // PDF with the old pins (or no card at all) indefinitely (codex P1).
    // Same best-effort contract as the treatment-zone write below.
    try {
      const completedRecord = await db('service_records')
        .where({ scheduled_service_id: svc.id })
        .orderBy('created_at', 'desc')
        .first('id');
      if (completedRecord) await invalidateServiceReportPdfCache(completedRecord.id);
    } catch (err) {
      // Never fail the save on a cache-invalidation hiccup; the marks are
      // written and the live report is already correct.
      logger.warn(`[tech-track] pdf cache invalidation after marks failed: ${err.message}`);
    }

    res.json({ marks: validation.marks });
  } catch (err) {
    logger.error(`[tech-track] photo-marks save failed: ${err.message}`);
    next(err);
  }
});

// A photo belongs to the visit if it is still staged against the scheduled
// service, or was promoted onto that visit's service_record. Returns the
// photo_type too — the card publishes the image as the TREATED area, so the
// type is a correctness input, not metadata.
async function findVisitPhotoByKey(scheduledServiceId, s3Key) {
  const staged = await db('scheduled_service_photo_staging')
    .where({ scheduled_service_id: scheduledServiceId, s3_key: s3Key })
    .first('id', 'photo_type')
    .catch(() => null);
  if (staged) return staged;
  const record = await db('service_records')
    .where({ scheduled_service_id: scheduledServiceId })
    .orderBy('created_at', 'desc')
    .first('id')
    .catch(() => null);
  if (!record) return null;
  return db('service_photos')
    .where({ service_record_id: record.id, s3_key: s3Key })
    .first('id', 'photo_type')
    .catch(() => null);
}

// ── Recap clip capture DURING the visit (pest-recap lane, P4b) ──────────────────
// Mirrors the admin-dispatch recap-media endpoints but tech-portal-scoped to the
// tech's OWN assigned job. Keyed on the scheduled-service id (:id), same as the rest
// of the recap lane. Direct browser→S3 via presigned PUT (reuses recap-media service).
const recapMedia = require('../services/service-report/recap-media');

async function loadOwnedServiceOr403(req, res) {
  const svc = await db('scheduled_services').where({ id: req.params.id }).first('id', 'technician_id');
  if (!svc) { res.status(404).json({ error: 'Service not found' }); return null; }
  if (req.techRole !== 'admin' && svc.technician_id !== req.technicianId) {
    res.status(403).json({ error: 'Not assigned to this service' });
    return null;
  }
  return svc;
}

router.post('/:id/recap-media/presign', async (req, res, next) => {
  try {
    if (process.env.PEST_RECAP !== 'true') return res.status(409).json({ error: 'recap capture is disabled' });
    if (!(await loadOwnedServiceOr403(req, res))) return undefined;
    const { role, mediaType, contentType } = req.body || {};
    const result = await recapMedia.presignUpload({
      scheduledServiceId: req.params.id, role, mediaType, contentType,
      capturedBy: req.technician?.name || req.technicianId || null,
    });
    return res.json(result);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    return next(err);
  }
});

router.post('/:id/recap-media/:mediaId/confirm', async (req, res, next) => {
  try {
    if (!(await loadOwnedServiceOr403(req, res))) return undefined;
    const result = await recapMedia.confirmUpload(req.params.mediaId, { scheduledServiceId: req.params.id, durationMs: req.body?.durationMs });
    if (!result.ok) {
      if (result.reason === 'too_large') return res.status(413).json({ error: 'Clip too large — keep it under ~20 seconds.' });
      if (result.reason === 'bad_duration') return res.status(422).json({ error: 'Couldn’t read the clip length — re-record a short clip and try again.' });
      if (result.reason === 'not_uploaded') return res.status(409).json({ error: 'Upload not found — try again.' });
      return res.status(404).json({ error: 'media not found' });
    }
    return res.json({ ok: true, id: result.row.id, status: result.row.status });
  } catch (err) { return next(err); }
});

router.get('/:id/recap-media', async (req, res, next) => {
  try {
    if (!(await loadOwnedServiceOr403(req, res))) return undefined;
    const items = await recapMedia.listMedia(req.params.id);
    return res.json({ items });
  } catch (err) { return next(err); }
});

router.delete('/:id/recap-media/:mediaId', async (req, res, next) => {
  try {
    if (!(await loadOwnedServiceOr403(req, res))) return undefined;
    await recapMedia.deleteMedia(req.params.mediaId, { scheduledServiceId: req.params.id });
    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ── Treatment Zone Mapper (traced perimeter over the satellite photo) ────────
// The tech traces the treated perimeter over a satellite view of the property;
// we store the path (image px + lat/lng), linear feet, and the composited
// snapshot PNG. Keyed on the scheduled-service id like the recap lane so it
// works before or after completion — the report joins back through
// service_records.scheduled_service_id. Gated: GATE_TREATMENT_ZONE_MAP.
const featureGates = require('../config/feature-gates');
const {
  saveTreatmentZoneMap,
  getTreatmentZoneMapForScheduledService,
} = require('../services/treatment-zone-maps');
const { invalidateServiceReportPdfCache } = require('../services/service-report/pdf-storage');
const { traceCaptureBlockPayload } = require('../services/service-report/trace-eligibility');
const { geocodeAddress } = require('../services/geocoder');

router.post('/:id/treatment-zone', upload.fields([
  { name: 'snapshot', maxCount: 1 },
  // Transparent grass-highlight layer (lawn_highlight saves) — the report
  // animates it over the snapshot (owner 2026-07-30).
  { name: 'mask', maxCount: 1 },
]), async (req, res, next) => {
  try {
    if (!featureGates.isEnabled('treatmentZoneMap')) {
      return res.status(404).json({ error: 'Not enabled' });
    }
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'customer_id', 'technician_id', 'service_id', 'service_type');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (req.techRole !== 'admin' && svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }
    // Centralized trace eligibility (GATE_TRACE_ELIGIBILITY, dark): a trace
    // on a bait/trapping/inspection visit asserts a spray the report will
    // suppress anyway — reject the save with the reason so the tech knows,
    // instead of silently publishing nothing. Fail-open inside the helper:
    // a profile hiccup must never block a legitimate field capture.
    let payload;
    try {
      payload = JSON.parse(req.body?.payload || '');
    } catch {
      return res.status(400).json({ error: 'payload must be valid JSON' });
    }
    {
      // Eligibility AND capture-mode agreement (codex P2 r19) — the
      // render path trusts the saved mode for its presentation.
      const traceBlock = await traceCaptureBlockPayload(svc, db, { captureMode: payload.captureMode });
      if (traceBlock) return res.status(traceBlock.status).json(traceBlock.payload);
    }
    const snapshotFile = req.files?.snapshot?.[0] || null;
    const maskFile = req.files?.mask?.[0] || null;
    if (snapshotFile && snapshotFile.mimetype !== 'image/png') {
      return res.status(400).json({ error: 'snapshot must be a PNG' });
    }
    if (maskFile && maskFile.mimetype !== 'image/png') {
      return res.status(400).json({ error: 'mask must be a PNG' });
    }

    const row = await saveTreatmentZoneMap({
      scheduledServiceId: svc.id,
      customerId: svc.customer_id,
      technicianId: req.technicianId,
      pathPoints: payload.pathPoints,
      closedLoop: payload.closedLoop,
      linearFt: payload.linearFt,
      centerLat: payload.lat,
      centerLng: payload.lng,
      zoom: payload.zoom,
      address: payload.address,
      snapshotPngBuffer: snapshotFile?.buffer || null,
      maskPngBuffer: maskFile?.buffer || null,
      captureMode: payload.captureMode,
    });

    logger.info(
      `[tech-track] treatment zone saved service=${svc.id} tech=${req.technicianId} ` +
      `points=${Array.isArray(payload.pathPoints) ? payload.pathPoints.length : 0} ` +
      `linearFt=${row.linear_ft ?? 'n/a'}`
    );

    // The traced map renders on the report, so a completed visit's cached
    // PDF is stale the moment a trace is saved or replaced (the cache key is
    // content-insensitive — see pdf-storage.js). Best-effort by contract.
    const completedRecord = await db('service_records')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first('id');
    if (completedRecord) await invalidateServiceReportPdfCache(completedRecord.id);

    return res.json({ treatmentZone: row });
  } catch (err) {
    logger.error(`[tech-track] treatment zone save failed: ${err.message}`);
    return next(err);
  }
});

// POST /api/tech/services/:id/treatment-zone/suggest — vision auto-trace
// (owner 2026-07-21): the client uploads the visit's satellite PNG and gets
// back a suggested building-perimeter loop (normalized 0-1 coords) that
// INCLUDES any attached lanai / pool cage. Pure suggestion — the tech
// adjusts and confirms; nothing persists until the normal save route runs.
router.post('/:id/treatment-zone/suggest', upload.single('map'), async (req, res, next) => {
  try {
    if (!featureGates.isEnabled('treatmentZoneMap')) {
      return res.status(404).json({ error: 'Not enabled' });
    }
    const svc = await db('scheduled_services')
      .where({ id: req.params.id })
      .first('id', 'technician_id', 'service_id', 'service_type');
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (req.techRole !== 'admin' && svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }
    // Same eligibility gate as the save route — the auto-trace suggestion
    // is the same capture flow one step earlier.
    {
      const traceBlock = await traceCaptureBlockPayload(svc, db);
      if (traceBlock) return res.status(traceBlock.status).json(traceBlock.payload);
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'map image is required' });
    }
    if (req.file.mimetype !== 'image/png') {
      return res.status(400).json({ error: 'map must be a PNG' });
    }
    const { suggestTreatmentZone } = require('../services/treatment-zone-suggest');
    // mode=lawn traces the property's turf boundary instead of the building
    // footprint — a building suggestion saved in lawn mode would publish a
    // house outline labeled "treated lawn area" (pre-push audit P1 2026-07-28).
    // mode=yard is the mosquito boundary: turf plus the landscape beds
    // (owner 2026-08-11).
    const mode = ['lawn', 'yard'].includes(req.body?.mode) ? req.body.mode : 'perimeter';
    const suggestion = await suggestTreatmentZone(req.file.buffer, { mode });
    if (!suggestion) {
      return res.status(422).json({
        error: mode === 'lawn'
          ? 'Could not detect the lawn outline — trace it manually.'
          : mode === 'yard'
            ? 'Could not detect the yard outline — trace it manually.'
            : 'Could not detect the building outline — trace it manually.',
      });
    }
    logger.info(
      `[tech-track] treatment zone suggested service=${svc.id} tech=${req.technicianId} `
      + `points=${suggestion.perimeter.length} pool=${suggestion.includesPoolEnclosure}`
    );
    return res.json({ suggestion });
  } catch (err) {
    logger.error(`[tech-track] treatment zone suggest failed: ${err.message}`);
    return next(err);
  }
});

// GET /api/tech/services/:id/geocode — server-side geocode of the visit's
// stamped/customer address for the treatment-zone mapper. The Geocoding web
// service rejects referer-restricted keys, so once the client key is locked
// to prod origins a browser-side fallback would break; the fallback runs here
// with the server key instead. Only called when the schedule row has no
// coordinates (divergent stamp with no lat/lng).
router.get('/:id/geocode', async (req, res, next) => {
  try {
    if (!featureGates.isEnabled('treatmentZoneMap')) {
      return res.status(404).json({ error: 'Not enabled' });
    }
    const svc = await db('scheduled_services')
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .where('scheduled_services.id', req.params.id)
      .first(
        'scheduled_services.id',
        'scheduled_services.technician_id',
        db.raw('COALESCE(scheduled_services.service_address_line1, customers.address_line1) as line1'),
        db.raw('COALESCE(scheduled_services.service_address_city, customers.city) as city'),
        db.raw('COALESCE(scheduled_services.service_address_state, customers.state) as state'),
        db.raw('COALESCE(scheduled_services.service_address_zip, customers.zip) as zip')
      );
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (req.techRole !== 'admin' && svc.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service' });
    }
    const address = [svc.line1, svc.city, svc.state, svc.zip].filter(Boolean).join(', ');
    if (!address) return res.status(422).json({ error: 'No address on file for this visit' });
    // Shared server geocoder: GOOGLE_API_KEY || GOOGLE_MAPS_API_KEY chain,
    // in-process memo, ZERO_RESULTS caching. (The static-maps key can be
    // API-restricted to Static Maps, so it must not be used for geocoding.)
    const loc = await geocodeAddress(address);
    if (!loc) return res.status(422).json({ error: 'Could not locate this address on the map' });
    return res.json({ lat: loc.lat, lng: loc.lng });
  } catch (err) {
    logger.error(`[tech-track] treatment zone geocode failed: ${err.message}`);
    return next(err);
  }
});

router.get('/:id/treatment-zone', async (req, res, next) => {
  try {
    // Read stays 200 with enabled:false when the gate is off so the modal
    // can tell the tech BEFORE they trace (the write route 404s regardless).
    if (!featureGates.isEnabled('treatmentZoneMap')) {
      return res.json({ treatmentZone: null, enabled: false });
    }
    if (!(await loadOwnedServiceOr403(req, res))) return undefined;
    const row = await getTreatmentZoneMapForScheduledService(req.params.id);
    if (!row) return res.json({ treatmentZone: null, enabled: true });
    let snapshotUrl = null;
    if (row.snapshot_s3_key && config.s3?.bucket) {
      snapshotUrl = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: config.s3.bucket, Key: row.snapshot_s3_key,
      }), { expiresIn: 3600 });
    }
    return res.json({ treatmentZone: { ...row, snapshotUrl }, enabled: true });
  } catch (err) {
    logger.error(`[tech-track] treatment zone fetch failed: ${err.message}`);
    return next(err);
  }
});

module.exports = router;
