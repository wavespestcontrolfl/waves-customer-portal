const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const tokenHealth = require('../services/token-health');
const { getEnvPresence } = require('../services/integration-health');

router.use(adminAuthenticate);
router.use(requireAdmin);

// GET /env-presence — report which known integration env keys are set.
// Returns presence only (boolean); values are never exposed.
router.get('/env-presence', (req, res) => {
  res.json({ present: getEnvPresence() });
});

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
