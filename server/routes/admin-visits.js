/**
 * Admin visit-group actions (visit-group-scope.md §2, Phase 1).
 * Staff-only; gate-checked for grouping (creation gate — split/separate
 * keep working on existing visits regardless of the gate, per the
 * "existing visits keep their created behavior" rule).
 */
const express = require('express');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { gates } = require('../config/feature-gates');
const VisitGroups = require('../services/visit-groups');
const { combineRows } = require('../services/visit-combine');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');

const router = express.Router();
// Grouping/splitting is an OFFICE action (doc §3: "The office keeps one
// exception action"); techs never regroup visits from the field.
router.use(adminAuthenticate, requireAdmin);

// POST /api/admin/visits/group { serviceIds: [uuid, uuid, ...] }
router.post('/group', async (req, res, next) => {
  try {
    if (!gates.visitGroups) return res.status(404).json({ error: 'Not found' });
    const serviceIds = Array.isArray(req.body && req.body.serviceIds) ? req.body.serviceIds : [];
    if (serviceIds.length < 2) {
      return res.status(400).json({ error: 'serviceIds needs at least two rows' });
    }
    // Autopay exclusion — same rule as automatic stamping (spec rev-2:
    // "autopay customers are not grouped until grouped autopay ships");
    // fail-closed inside the helper. FAST PATH for a clean 409 message —
    // the authoritative check re-runs inside createOrJoinVisit under the
    // customer row lock (pre-push codex P0 TOCTOU), whose refusal maps to
    // the same visit_group_refused below. Creation-time only:
    // split/separate on existing visits stays unrestricted.
    const anchor = await require('../models/db')('scheduled_services')
      .whereIn('id', serviceIds).first('customer_id');
    if (!anchor || await VisitGroups.customerExcludedByAutopay(anchor.customer_id)) {
      return res.status(409).json({
        error: 'This customer is on autopay — visits are not grouped until grouped autopay ships.',
        code: 'visit_group_refused',
      });
    }
    // Combine moves later rows to abut the earlier ones when the window
    // rule is the only refusal (owner ruling 2026-09-03) — the response
    // names every row it moved so the office sees the new stop time.
    const { visit, moved } = await combineRows({
      serviceIds,
      createdBy: `admin:${(req.technician && req.technician.id) || 'unknown'}`,
      actorId: req.technicianId || null,
    });
    // Other dispatch boards patch window_start/window_end from
    // dispatch:job_update (useDispatchBoard) — the same broadcast the
    // admin reschedule route sends; without it they keep the old slots
    // until a full reload (GH codex #3843 r1 P2). Best-effort, after the
    // grouping succeeded.
    for (const m of moved) {
      try { await emitDispatchJobUpdate({ jobId: m.id, actorId: req.technicianId }); } catch {}
    }
    return res.json({ visit, moved });
  } catch (err) {
    if (/row not found/.test(String(err.message))) {
      // Stale admin selection (row deleted mid-flight) is a request race,
      // not a server failure (codex P2).
      return res.status(404).json({ error: 'One of the selected appointments no longer exists — refresh and retry.' });
    }
    if (/not mutually groupable|membership conflict/.test(String(err.message))) {
      return res.status(409).json({ error: err.message, code: 'visit_group_refused' });
    }
    // The abut move's own refusals (window rules, a row no longer
    // reschedulable, a taken slot) are request outcomes, not server
    // failures — same shape as the dispatch reschedule route.
    if (err && (err.statusCode === 409 || err.statusCode === 422)) {
      return res.status(err.statusCode).json({ error: err.message, code: 'visit_group_refused' });
    }
    return next(err);
  }
});

// POST /api/admin/visits/:visitId/split { serviceId }
// "Split this service into a separate visit" — explicit action, subject to
// the rev-5d membership freeze enforced in the service.
router.post('/:visitId/split', async (req, res, next) => {
  try {
    const serviceId = req.body && req.body.serviceId;
    if (!serviceId) return res.status(400).json({ error: 'serviceId required' });
    const fresh = await VisitGroups.splitChild({
      visitId: req.params.visitId,
      scheduledServiceId: serviceId,
      createdBy: `admin:${(req.technician && req.technician.id) || 'unknown'}`,
    });
    return res.json({ visit: fresh });
  } catch (err) {
    if (err && err.code === 'VISIT_SPLIT_REFUSED') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (/not found|not a member/.test(String(err.message))) {
      return res.status(404).json({ error: err.message });
    }
    return next(err);
  }
});

module.exports = router;
