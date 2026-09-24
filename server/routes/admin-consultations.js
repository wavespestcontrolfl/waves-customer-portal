// Consultation outcomes — record + read a won/warm/cold/lost read on a
// Waves Assessment visit, and the aggregate stats panel. No UI here; this
// is the backend for /admin/consultations.
//
// Mixed-role router (badges.js pattern, CLAUDE.md rule 15): a technician
// records the outcome of their own consultation, but only admin reads the
// cross-technician stats panel. adminAuthenticate/requireAdmin per handler,
// not router-wide.
const express = require('express');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const {
  recordOutcome,
  consultationStats,
} = require('../services/consultation-outcomes');

// POST /api/admin/consultations/:scheduledServiceId/outcome
router.post('/:scheduledServiceId/outcome', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const { scheduledServiceId } = req.params;
    const {
      outcome, lostReason, interests, quotedAmount, quotedCadence,
      quoteNotes, followUpAt,
    } = req.body || {};

    const saved = await recordOutcome({
      scheduledServiceId,
      outcome,
      lostReason,
      interests,
      quotedAmount,
      quotedCadence,
      quoteNotes,
      followUpAt,
      recordedBy: req.technician?.name || req.technicianId || null,
    }, { trx: db });

    res.json({ outcome: saved });
  } catch (err) {
    if (err.isOperational && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// GET /api/admin/consultations/:scheduledServiceId/outcome
router.get('/:scheduledServiceId/outcome', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const { scheduledServiceId } = req.params;
    const row = await db('consultation_outcomes')
      .where({ scheduled_service_id: scheduledServiceId })
      .first();
    if (!row) return res.status(404).json({ error: 'No outcome recorded for that visit' });
    res.json({ outcome: row });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/consultations/stats?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/stats', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const stats = await consultationStats({ from: from || undefined, to: to || undefined });
    res.json(stats);
  } catch (err) {
    logger.error(`[admin-consultations] stats failed: ${err.message}`);
    next(err);
  }
});

module.exports = router;
