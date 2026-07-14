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
      .whereNull('dismissed_at');
    if (unreadOnly) q = q.where({ read: false });
    const rows = await q.orderBy('created_at', 'desc').limit(20);
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
      .update({ read: true, dismissed_at: new Date(), updated_at: new Date() });

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
