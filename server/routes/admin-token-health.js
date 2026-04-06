const express = require('express');
const router = express.Router();
const { adminAuthenticate } = require('../middleware/admin-auth');
const tokenHealth = require('../services/token-health');

router.use(adminAuthenticate);

// GET / — return all credential statuses from DB
router.get('/', async (req, res, next) => {
  try {
    const credentials = await tokenHealth.getAll();
    res.json({ credentials });
  } catch (err) { next(err); }
});

// POST /check — trigger full health check across all platforms
router.post('/check', async (req, res, next) => {
  try {
    const results = await tokenHealth.checkAll();
    res.json({ results });
  } catch (err) { next(err); }
});

// POST /check/:platform — check a single platform
router.post('/check/:platform', async (req, res, next) => {
  try {
    const result = await tokenHealth.checkSingle(req.params.platform);
    res.json({ result });
  } catch (err) { next(err); }
});

module.exports = router;
