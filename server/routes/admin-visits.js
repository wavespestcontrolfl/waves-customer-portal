/**
 * Admin visit-group actions (visit-group-scope.md §2, Phase 1). Staff-only.
 * Grouping is retired (owner ruling 2026-10-22); split/separate keep working
 * on existing visits, per the "existing visits keep their created behavior"
 * rule.
 */
const express = require('express');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const VisitGroups = require('../services/visit-groups');

const router = express.Router();
// Splitting is an OFFICE action (doc §3: "The office keeps one exception
// action"); techs never regroup visits from the field.
router.use(adminAuthenticate, requireAdmin);

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
