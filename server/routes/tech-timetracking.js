const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const timeTracking = require('../services/time-tracking');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// ET-anchored Monday for a YYYY-MM-DD reference (or "today in ET" if
// dateStr is missing). Railway runs UTC, so a naive new Date() + getDay()
// near midnight ET picks the wrong week — always go through the
// ET helpers.
function mondayOfET(dateStr) {
  const ref = dateStr ? new Date(`${dateStr}T12:00:00Z`) : new Date();
  const dayOfWeek = etParts(ref).dayOfWeek; // 0 = Sun, 1 = Mon, ...
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return etDateString(addETDays(ref, mondayOffset));
}

// ---------------------------------------------------------------------------
// POST /clock-in
// ---------------------------------------------------------------------------
router.post('/clock-in', async (req, res, next) => {
  try {
    const { lat, lng, notes } = req.body;
    const entry = await timeTracking.clockIn(req.technicianId, { lat, lng, notes, source: 'app' });
    res.json(entry);
  } catch (err) {
    if (err.message.includes('Already clocked in')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /clock-out
// ---------------------------------------------------------------------------
router.post('/clock-out', async (req, res, next) => {
  try {
    const { lat, lng, notes } = req.body;
    const entry = await timeTracking.clockOut(req.technicianId, { lat, lng, notes });
    res.json(entry);
  } catch (err) {
    if (err.message.includes('Not currently clocked in')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /start-job/:jobId
// ---------------------------------------------------------------------------
router.post('/start-job/:jobId', async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    const entry = await timeTracking.startJob(req.technicianId, req.params.jobId, { lat, lng });
    res.json(entry);
  } catch (err) {
    if (err.message.includes('Must be clocked in')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /end-job
// ---------------------------------------------------------------------------
router.post('/end-job', async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    const entry = await timeTracking.endJob(req.technicianId, { lat, lng });
    res.json(entry);
  } catch (err) {
    if (err.message.includes('No active job')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /start-break
// ---------------------------------------------------------------------------
router.post('/start-break', async (req, res, next) => {
  try {
    const entry = await timeTracking.startBreak(req.technicianId);
    res.json(entry);
  } catch (err) {
    if (err.message.includes('Must be clocked in')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /end-break
// ---------------------------------------------------------------------------
router.post('/end-break', async (req, res, next) => {
  try {
    const entry = await timeTracking.endBreak(req.technicianId);
    res.json(entry);
  } catch (err) {
    if (err.message.includes('No active break')) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /status
// ---------------------------------------------------------------------------
router.get('/status', async (req, res, next) => {
  try {
    const status = await timeTracking.getStatus(req.technicianId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /history — paginated entries for this tech
// ---------------------------------------------------------------------------
router.get('/history', async (req, res, next) => {
  try {
    const { startDate, endDate, entryType, limit, offset } = req.query;
    const result = await timeTracking.getEntries({
      technicianId: req.technicianId,
      startDate,
      endDate,
      entryType,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /weekly — weekly summaries for this tech
// ---------------------------------------------------------------------------
router.get('/weekly', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const summaries = await timeTracking.getWeeklySummaries({
      technicianId: req.technicianId,
      startDate,
      endDate,
    });
    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /sign-week { weekStart: 'YYYY-MM-DD', signature: 'Tech Name' }
//
// Tech acknowledges their own week before admin approval. Sign-off is
// informational; admin still has to approve to lock entries. A
// previously-signed week that's later disputed or unlocked has these
// columns cleared so the tech re-signs after the correction.
// ---------------------------------------------------------------------------
router.post('/sign-week', async (req, res, next) => {
  try {
    const { weekStart, signature } = req.body || {};
    if (!signature || !String(signature).trim()) {
      return res.status(400).json({ error: 'signature required (typed name)' });
    }
    if (weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
    }
    const start = mondayOfET(weekStart);

    let weekly = await db('time_weekly_summary')
      .where({ technician_id: req.technicianId, week_start: start })
      .first();
    if (!weekly) {
      try { await timeTracking.computeWeeklySummary(req.technicianId, start); } catch (_) { /* noop */ }
      weekly = await db('time_weekly_summary')
        .where({ technician_id: req.technicianId, week_start: start })
        .first();
    }
    if (!weekly) return res.status(404).json({ error: 'No timecard for that week' });

    if (weekly.status === 'approved') {
      return res.status(409).json({ error: 'Week already approved by admin — cannot sign after lock' });
    }

    // Atomic guard: if an admin approves between our read above and
    // this update, the whereNot predicate makes the update affect 0
    // rows so we don't stamp tech_signed_at onto a now-locked week.
    // Returning 409 lets the tech retry / refresh.
    const updatedRows = await db('time_weekly_summary')
      .where({ id: weekly.id })
      .whereNot({ status: 'approved' })
      .update({
        tech_signed_at: new Date(),
        tech_signature: String(signature).trim().slice(0, 200),
        updated_at: new Date(),
      })
      .returning('*');

    if (!updatedRows.length) {
      return res.status(409).json({ error: 'Week was approved before sign-off completed — refresh and try again' });
    }

    logger.info(`[timetracking] Tech ${req.technicianId} signed week ${start}`);
    res.json({ success: true, weekly: updatedRows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
