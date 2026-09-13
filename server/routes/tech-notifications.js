/**
 * Tech in-app notifications (polled by the tech PWA).
 * Currently used by the geofence arrival/exit prompts.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const timeTracking = require('../services/time-tracking');
const matcher = require('../services/geofence-matcher');
const geofenceHandler = require('../services/geofence-handler');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/tech/notifications?unreadOnly=true
router.get('/', async (req, res, next) => {
  try {
    const unreadOnly = req.query.unreadOnly !== 'false';
    let q = db('tech_notifications')
      .where({ technician_id: req.technicianId })
      .whereNull('dismissed_at')
      // Storm-watch nudges are only actionable for a couple of hours
      // (sweep lookahead + service window). Without an age cutoff, unread
      // alerts from earlier days pile up into a wall of cards that buries
      // the tech home screen on the next load.
      .where(function stormFreshness() {
        this.whereNot({ type: 'storm_watch_alert' })
          .orWhereRaw("created_at >= now() - interval '6 hours'");
      });
    // GATE_NOSHOW_DETECTOR is the feature's kill switch, and turning it off
    // stops the sweep — which is the only thing that dismisses a tracking
    // notice when its visit completes, moves or is reassigned. Undismissed
    // rows would otherwise keep showing (and, since round 8, leading the
    // window) with no reconciliation behind them, so a disabled feature
    // would leave stale cards on techs' phones indefinitely (codex P1, PR
    // #4403 round 9). Read at request time, like every other gate here: a
    // flip needs no redeploy, and re-enabling hands the rows straight back
    // to the sweep, which reconciles them on its next tick.
    if (!require('../config/feature-gates').gateEnvValue('GATE_NOSHOW_DETECTOR')) {
      q = q.whereNot({ type: 'follow_through_tracking' });
    }
    if (unreadOnly) q = q.where({ read: false });
    // FRESH non-storm rows outrank everything inside the 20-row window: a
    // storm burst must never crowd an actionable geofence/timer prompt out
    // of the poll result. The priority is freshness-scoped, though — a stale
    // backlog of ≥20 unread non-storm rows must not displace a live storm
    // warning either, so aged rows compete with storms purely on recency.
    // Visit notices (visit_* — tech-visit-notifications.js) never expire and
    // a bulk assign can mint dozens at once, so they must not push an
    // arrival/Undo prompt (bucket 0) or a fresh storm warning (bucket 1)
    // past the limit — the client shows two at a time and promotes the rest
    // as they clear. They share the LAST bucket with stale rows and compete
    // there on recency: a backlog of ≥20 stale legacy rows (e.g. the old
    // `new_appointment` type the client never rendered) must not starve
    // every schedule-change card out of the window either. Texts on a tech's
    // own line (tech_line_sms — tech-line.js) are kept the same way and sit
    // in the same bucket. Missing-tracking notices (follow_through_tracking
    // — no-show-detector.js) are their OWN bucket 0, regardless of age: they
    // are undismissed only while the visit is still overdue with no arrival
    // evidence (the sweep's reconcile pass dismisses them the moment that
    // stops being true), and the generic recency rule dropped one past six
    // hours into the routine kept-card bucket — so a tech who was offline
    // while a stage-2 notice aged, then collected 20 newer assignment or text
    // cards, never received the row at all and the client's own MAX_VISIT_CARDS
    // ranking could not rescue what the server never returned (codex P2
    // round 8). Its OWN bucket, ahead of every other fresh row: sharing
    // bucket 0 with them meant an offline tech who collected 20 newer
    // geofence/timer prompts — two events across ten stops — still lost the
    // stage-2 card from the window (codex P2 round 17). The other buckets
    // keep their relative order, one step down.
    const rows = await q
      .orderByRaw("CASE WHEN type = 'follow_through_tracking' THEN 0 WHEN type LIKE 'visit\\_%' OR type = 'tech_line_sms' THEN 3 WHEN type = 'storm_watch_alert' THEN 2 WHEN created_at >= now() - interval '6 hours' THEN 1 ELSE 3 END")
      // Stage 2 before stage 1 INSIDE the tracking bucket, before the limit
      // truncates: a tech with more than 20 undismissed tracking cards would
      // otherwise lose an older critical arrival check behind 20 newer
      // stage-1 warnings, and the client's own stage-2-first sort cannot
      // rescue a row the window never returned (codex P2, PR #4403 round 20).
      .orderByRaw("CASE WHEN type = 'follow_through_tracking' THEN COALESCE((payload->>'stage')::int, 0) ELSE 0 END DESC")
      .orderBy('created_at', 'desc')
      .limit(20);
    res.json({ notifications: rows.map(parseRow) });
  } catch (err) { next(err); }
});

// POST /:id/read — mark read (tech saw it)
router.post('/:id/read', async (req, res, next) => {
  try {
    await db('tech_notifications')
      .where({ id: req.params.id, technician_id: req.technicianId })
      .update({ read: true, updated_at: new Date() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/dismiss — tech tapped "Not here yet" or close
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    const row = await db('tech_notifications')
      .where({ id: req.params.id, technician_id: req.technicianId })
      .first();
    if (!row) return res.status(404).json({ error: 'Notification not found' });

    await db('tech_notifications')
      .where({ id: row.id })
      // A tech's own dismissal CLEARS any automatic supersession stamp the
      // sweep may have written in the meantime: the sweep reads that stamp as
      // "this card was retired by the system, so an identical one may be
      // raised again", and leaving it would let the next cycle resurrect a
      // card the tech had already cleared — and push it again (codex P2, PR
      // #4403 round 24).
      .update({ read: true, dismissed_at: new Date(), updated_at: new Date(),
        payload: db.raw("COALESCE(payload, '{}'::jsonb) - 'superseded_at'") });

    // If it was an arrival reminder, log the dismissal in geofence_events
    if (row.type === 'geofence_arrival_reminder') {
      const payload = parsePayload(row.payload);
      await matcher.logEvent({
        bouncie_imei: 'n/a',
        technician_id: row.technician_id,
        event_type: 'ENTER',
        action_taken: 'dismissed',
        matched_customer_id: payload.customer_id || null,
        matched_job_id: payload.job_id || null,
        event_timestamp: new Date(),
      });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/confirm-start — tech tapped "Start Timer" on an arrival reminder
// For multi-select notifications, pass { customer_id, job_id } in body to pick one candidate.
router.post('/:id/confirm-start', async (req, res, next) => {
  try {
    const { lat, lng, customer_id: bodyCustomerId, job_id: bodyJobId } = req.body || {};
    const row = await db('tech_notifications')
      .where({ id: req.params.id, technician_id: req.technicianId })
      .first();
    if (!row) return res.status(404).json({ error: 'Notification not found' });

    const payload = parsePayload(row.payload);
    // Body override takes priority (multi-select); otherwise use the payload's primary pick.
    const jobId = bodyJobId !== undefined ? bodyJobId : (payload.job_id || null);
    const customerId = bodyCustomerId || payload.customer_id || null;

    let entry;
    try {
      entry = await timeTracking.startJob(req.technicianId, jobId, { lat, lng });
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }

    if (jobId) {
      // markOnProperty (via markOnPropertyFromGeofence → track-transitions) is
      // the sole owner of the customer arrival SMS now — it fires once,
      // idempotently when the tracker flips to on-site. Don't double-send here.
      // startJob above already fired it as the acting tech; pass req.technicianId
      // again so that if that first send was released for retry, this no-op-or-
      // retry call still names the tech who confirmed the start, not a stale one.
      await geofenceHandler.markOnPropertyFromGeofence(jobId, new Date(), { actingTechId: req.technicianId });
    }

    await db('tech_notifications')
      .where({ id: row.id })
      .update({ read: true, dismissed_at: new Date(), updated_at: new Date() });

    await matcher.logEvent({
      bouncie_imei: 'n/a',
      technician_id: req.technicianId,
      event_type: 'ENTER',
      action_taken: 'timer_started',
      matched_customer_id: customerId,
      matched_job_id: jobId,
      time_entry_id: entry.id,
      event_timestamp: new Date(),
    });

    res.json({ timeEntry: entry });
  } catch (err) { next(err); }
});

// POST /:id/undo-stop — tech tapped "Undo" on a timer-stopped toast
router.post('/:id/undo-stop', async (req, res, next) => {
  try {
    let reopened;
    try {
      reopened = await db.transaction(async (trx) => {
        // Claim the notification row first and keep that claim in the same
        // transaction as the timer reopen. Read receipts are advisory and may
        // race with an Undo tap; only an explicit dismissal (or a prior undo)
        // is terminal. A concurrent dismissal either wins before this lock or
        // waits until the handled state commits.
        const row = await trx('tech_notifications')
          .where({ id: req.params.id, technician_id: req.technicianId })
          .forUpdate()
          .first();
        if (!row || row.type !== 'geofence_timer_stopped') {
          throw notificationHttpError(404, 'Stop notification not found');
        }
        if (row.dismissed_at) {
          throw notificationHttpError(409, 'Stop notification was already handled');
        }
        const createdAt = new Date(row.created_at).getTime();
        if (!Number.isFinite(createdAt) || Date.now() - createdAt > 30 * 60 * 1000) {
          throw notificationHttpError(410, 'Undo window expired');
        }

        const payload = parsePayload(row.payload);
        const stoppedEntryId = payload.time_entry_id;
        if (!stoppedEntryId) {
          throw notificationHttpError(400, 'No time entry to restore');
        }

        const entry = await timeTracking.reopenStoppedEntryInTransaction(
          trx,
          req.technicianId,
          stoppedEntryId,
        );
        const claimed = await trx('tech_notifications')
          .where({ id: row.id, technician_id: req.technicianId })
          .whereNull('dismissed_at')
          .update({ read: true, dismissed_at: new Date(), updated_at: new Date() });
        if (claimed !== 1) {
          throw notificationHttpError(409, 'Stop notification was already handled');
        }
        return entry;
      });
    } catch (error) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      throw error;
    }

    res.json({ timeEntry: reopened });
  } catch (err) { next(err); }
});

function notificationHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
}

function parsePayload(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function parseRow(r) {
  return { ...r, payload: parsePayload(r.payload) };
}

module.exports = router;
