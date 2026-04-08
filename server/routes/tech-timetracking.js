const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const timeTracking = require('../services/time-tracking');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

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

module.exports = router;
