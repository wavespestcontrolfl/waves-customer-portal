const express = require('express');
const router = express.Router();
const { adminAuthenticate } = require('../middleware/admin-auth');
const ga4 = require('../services/analytics/ga4');

router.use(adminAuthenticate);

// GET /api/admin/analytics/overview?days=30
router.get('/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const result = await ga4.getOverview(days);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/analytics/traffic?days=30
router.get('/traffic', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const result = await ga4.getTrafficSources(days);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/analytics/pages?days=30
router.get('/pages', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const result = await ga4.getTopPages(days);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/analytics/conversions?days=30
router.get('/conversions', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const result = await ga4.getConversions(days);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
