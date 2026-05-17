const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const {
  getPricingRealityCheck,
  parsePricingRealityCheckQuery,
} = require('../services/pricing-reality-check');

router.use(adminAuthenticate, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const params = parsePricingRealityCheckQuery(req.query);
    const payload = await getPricingRealityCheck(params);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
