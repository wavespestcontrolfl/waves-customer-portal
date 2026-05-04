const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { buildPlanForService } = require('../services/waveguard-plan-engine');

router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

function plannerOptions(req) {
  return {
    equipmentSystemId: req.body?.equipmentSystemId || req.query.equipmentSystemId || null,
    calibrationId: req.body?.calibrationId || req.query.calibrationId || null,
    selectedConditionalProductIds: req.body?.selectedConditionalProductIds || req.query.selectedConditionalProductIds || null,
    selectedConditionalProductNames: req.body?.selectedConditionalProductNames || req.query.selectedConditionalProductNames || null,
    selectedConditionalRaw: req.body?.selectedConditionalRaw || req.query.selectedConditionalRaw || null,
  };
}

// Read-only WaveGuard planner.
// Returns the six field cards for a scheduled service without creating
// completion records, deducting inventory, or approving exceptions.
router.get('/:serviceId', async (req, res, next) => {
  try {
    const plan = await buildPlanForService(req.params.serviceId, plannerOptions(req));
    res.json({ plan });
  } catch (err) {
    next(err);
  }
});

router.post('/:serviceId/build', async (req, res, next) => {
  try {
    const plan = await buildPlanForService(req.params.serviceId, plannerOptions(req));
    res.json({ plan });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
