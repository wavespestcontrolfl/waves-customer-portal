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
const { technicianVisitRowInScope, TECH_DEAD_ASSIGNMENT_STATUSES, techAccessCutoff } = require('../services/technician-visit-scope');
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
  const visit = await db('scheduled_services').where({ id: scheduledServiceId }).first('id', 'technician_id', 'status', 'scheduled_date');
  if (!visit) {
    res.status(404).json({ error: 'Scheduled service not found' });
    return null;
  }
  // The canonical current/recent assignment (not a dead status, inside the
  // access window) — a cancelled or stale visit that still names the
  // technician grants nothing (codex #5568 r5 P1).
  const consultationOwner = technicianVisitRowInScope(req, visit);
  if (!consultationOwner) {
    res.status(403).json({ error: 'Not assigned to this consultation' });
    return null;
  }
  return visit;
}

// The same canonical current-assignment predicate as loadOwnedVisitOr403, as
// SQL on the visit table aliased `ss` (own row, not a dead status, inside the
// window), so a read is coupled to the CURRENT assignment in its own query. An
// admin reads any visit. One definition for every guarded read in this router;
// each caller aliases its visit table as `ss`. The three predicates travel
// together and their text is pinned (technician-scope-r8-sweep.test.js).
function scopeToCurrentAssignment(q, req) {
  if (req.techRole !== 'admin') {
    q.where('ss.technician_id', req.technicianId)
      .whereNotIn('ss.status', TECH_DEAD_ASSIGNMENT_STATUSES)
      .where('ss.scheduled_date', '>=', techAccessCutoff());
  }
  return q;
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

    // The read is coupled to the CURRENT assignment in one query (Codex
    // #4710 r6 P2): a technician reassigned after the check above never
    // receives the outcome (quote_notes are internal).
    const q = db('consultation_outcomes as co')
      .join('scheduled_services as ss', 'ss.id', 'co.scheduled_service_id')
      .where('co.scheduled_service_id', scheduledServiceId);
    scopeToCurrentAssignment(q, req);
    const row = await q.first('co.*');
    if (!row) {
      // Reassigned in between → the same 403 the check gives; else 404.
      if (!(await loadOwnedVisitOr403(req, res, scheduledServiceId))) return;
      return res.status(404).json({ error: 'No outcome recorded for that visit' });
    }
    res.json({ outcome: row });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/consultations/:scheduledServiceId/estimate
// The estimate that belongs to this assessment, read-only, for the Fast
// Complete sheet (GATE_ASSESSMENT_FAST_COMPLETE): { estimate: { state, ... } }
// (services/assessment-estimate-summary.js). Same ownership rule as the
// outcome read. No estimate token is returned, and the route does not exist
// while the gate is off.
router.get('/:scheduledServiceId/estimate', adminAuthenticate, requireTechOrAdmin, async (req, res, next) => {
  try {
    if (!require('../config/feature-gates').assessmentFastCompleteLive()) {
      return res.status(404).json({ error: 'Not found' });
    }
    const { scheduledServiceId } = req.params;
    if (!(await loadOwnedVisitOr403(req, res, scheduledServiceId))) return;
    // The visit row the summary is built from is read under the current
    // assignment (the outcome read's own guard): a technician reassigned after
    // the check above gets no estimate.
    const visit = await scopeToCurrentAssignment(
      db('scheduled_services as ss').where('ss.id', scheduledServiceId), req,
    ).first('ss.id', 'ss.customer_id', 'ss.source_estimate_id');
    if (!visit) {
      // Reassigned in between → the same 403 the check gives; else 404.
      if (!(await loadOwnedVisitOr403(req, res, scheduledServiceId))) return;
      return res.status(404).json({ error: 'Scheduled service not found' });
    }
    const estimate = await require('../services/assessment-estimate-summary').assessmentEstimateSummary(visit);
    res.json({ estimate });
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
    // The shared strict validator (Codex #4710 r17 P1): round-trip and
    // year-zero checks live in one place.
    const { validCalendarDate } = require('../utils/datetime-et');
    const isCalendarDate = (v) => Boolean(validCalendarDate(v));
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
