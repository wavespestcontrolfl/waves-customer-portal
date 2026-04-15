/**
 * Tech in-app notifications (polled by the tech PWA).
 * Currently used by the geofence arrival/exit prompts.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
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
      await geofenceHandler.advanceServiceTracking(jobId, 4, new Date());
      // Fire-and-forget arrival SMS to customer
      (async () => {
        try {
          const tech = await db('technicians').where({ id: req.technicianId }).first();
          const twilio = require('../services/twilio');
          if (twilio && twilio.sendTechEnRoute && customerId) {
            await twilio.sendTechEnRoute(customerId, tech ? tech.name : 'Your tech', 0);
          }
        } catch (err) {
          logger.warn(`[tech-notifications] arrival SMS failed: ${err.message}`);
        }
      })();
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
    const row = await db('tech_notifications')
      .where({ id: req.params.id, technician_id: req.technicianId })
      .first();
    if (!row || row.type !== 'geofence_timer_stopped') {
      return res.status(404).json({ error: 'Stop notification not found' });
    }

    const payload = parsePayload(row.payload);
    const stoppedEntryId = payload.time_entry_id;
    if (!stoppedEntryId) return res.status(400).json({ error: 'No time entry to restore' });

    // Reopen the stopped entry
    await db('time_entries')
      .where({ id: stoppedEntryId, technician_id: req.technicianId })
      .update({
        status: 'active',
        clock_out: null,
        clock_out_lat: null,
        clock_out_lng: null,
        duration_minutes: null,
        notes: db.raw("COALESCE(notes, '') || ' [undo-stop]'"),
        updated_at: new Date(),
      });

    await db('tech_notifications')
      .where({ id: row.id })
      .update({ read: true, dismissed_at: new Date(), updated_at: new Date() });

    const reopened = await db('time_entries').where({ id: stoppedEntryId }).first();
    res.json({ timeEntry: reopened });
  } catch (err) { next(err); }
});

function parsePayload(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function parseRow(r) {
  return { ...r, payload: parsePayload(r.payload) };
}

module.exports = router;
