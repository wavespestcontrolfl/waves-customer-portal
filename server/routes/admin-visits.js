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
    const visit = await VisitGroups.createOrJoinVisit({
      rows: serviceIds.map((id) => ({ id })),
      createdBy: `admin:${(req.technician && req.technician.id) || 'unknown'}`,
    });
    return res.json({ visit });
  } catch (err) {
    if (/row not found/.test(String(err.message))) {
      // Stale admin selection (row deleted mid-flight) is a request race,
      // not a server failure (codex P2).
      return res.status(404).json({ error: 'One of the selected appointments no longer exists — refresh and retry.' });
    }
    if (/not mutually groupable|membership conflict/.test(String(err.message))) {
      return res.status(409).json({ error: err.message, code: 'visit_group_refused' });
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
