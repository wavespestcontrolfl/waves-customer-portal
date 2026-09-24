// Consultation outcomes — record + read a won/warm/cold/lost read on a
// Waves Assessment visit, and the aggregate stats panel. No UI here; this
// is the backend for /admin/consultations.
//
// Mixed-role router (badges.js pattern, CLAUDE.md rule 15): a technician
// records/reads the outcome of THEIR OWN consultation only (tech-track.js
// "Not assigned to this service" convention — 404 for an unknown visit,
// 403 for one that exists but isn't theirs); only admin reads the
// cross-technician stats panel. adminAuthenticate/requireAdmin per handler,
// not router-wide. quote_notes is internal-only, which is exactly why this
// ownership check exists — any technician could otherwise read or overwrite
// any other tech's consultation by guessing/enumerating a scheduledServiceId.
const express = require('express');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const {
  recordOutcome,
  consultationStats,
  WON_WINDOW_DAYS,
} = require('../services/consultation-outcomes');
const { etDateString, addETDays } = require('../utils/datetime-et');

// Live assignment, not the consultation_outcomes snapshot — so a tech
// reassigned off (or onto) a visit sees access change immediately, matching
// tech-track.js's own ownership checks (svc.technician_id !== req.technicianId).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadOwnedVisitOr403(req, res, scheduledServiceId) {
  // A malformed id is a plain 404 (Codex #4710 r4 P2) — never a
  // uuid-syntax error from Postgres surfacing as a 500.
  if (!UUID_RE.test(String(scheduledServiceId || ''))) {
    res.status(404).json({ error: 'Scheduled service not found' });
    return null;
  }
  const visit = await db('scheduled_services').where({ id: scheduledServiceId }).first('id', 'technician_id');
  if (!visit) {
    res.status(404).json({ error: 'Scheduled service not found' });
    return null;
  }
  if (req.techRole !== 'admin' && visit.technician_id !== req.technicianId) {
    res.status(403).json({ error: 'Not assigned to this consultation' });
    return null;
  }
  return visit;
}

// POST /api/admin/consultations/:scheduledServiceId/outcome
router.post('/:scheduledServiceId/outcome', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    const { scheduledServiceId } = req.params;
    if (!(await loadOwnedVisitOr403(req, res, scheduledServiceId))) return;

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
      actingTechnicianId: req.technicianId || null,
      actingIsAdmin: req.techRole === 'admin',
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
    if (!(await loadOwnedVisitOr403(req, res, scheduledServiceId))) return;

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
    // Shape, calendar validity and order checked here (Codex #4710 r3 P2) —
    // a bad value must be a 400, never a Postgres invalid-date 500.
    const isCalendarDate = (v) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
      const d = new Date(`${v}T12:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
    };
    for (const [name, value] of [['from', from], ['to', to]]) {
      if (value !== undefined && value !== '' && (typeof value !== 'string' || !isCalendarDate(value))) {
        return res.status(400).json({ error: `${name} must be a real YYYY-MM-DD date` });
      }
    }
    // Ordered AFTER the service's own defaults are applied (Codex #4710 r4
    // P2): a lone future `from` or past `to` is just as reversed.
    const effectiveFrom = from || etDateString(addETDays(new Date(), -WON_WINDOW_DAYS));
    const effectiveTo = to || etDateString(new Date());
    if (effectiveFrom > effectiveTo) return res.status(400).json({ error: 'from must be on or before to' });
    const stats = await consultationStats({ from: from || undefined, to: to || undefined });
    res.json(stats);
  } catch (err) {
    logger.error(`[admin-consultations] stats failed: ${err.message}`);
    next(err);
  }
});

module.exports = router;
