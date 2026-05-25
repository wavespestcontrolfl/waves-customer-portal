const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { getIntegrationHealth } = require('../services/integration-health');

router.use(adminAuthenticate);
router.use(requireAdmin);

router.get('/health', async (req, res, next) => {
  try {
    res.json(await getIntegrationHealth());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
