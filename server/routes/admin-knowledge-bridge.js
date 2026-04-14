/**
 * Admin Knowledge Bridge Routes
 *
 * Manage cross-links between Claudeopedia and Agronomic Wiki.
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const KnowledgeBridge = require('../services/knowledge-bridge');

router.use(adminAuthenticate, requireAdmin);

// GET /api/admin/knowledge-bridge/stats
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await KnowledgeBridge.getStats();
    res.json(stats);
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge-bridge/auto-link — scan + create links
router.post('/auto-link', async (req, res, next) => {
  try {
    const result = await KnowledgeBridge.autoLink();
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/knowledge-bridge/sync — push wiki data to claudeopedia
router.post('/sync', async (req, res, next) => {
  try {
    const result = await KnowledgeBridge.syncToClaudeopedia();
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
