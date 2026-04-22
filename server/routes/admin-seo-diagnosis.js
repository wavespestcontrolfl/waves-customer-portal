/**
 * SEO Diagnosis Agent — admin surface (Phase 1).
 *
 * Phase 1 only wires a tool-exercise endpoint so the two implemented tools
 * (fetch_gsc_data + classify_query_intent + fetch_rubric) can be validated
 * before the agent session runner lands in Phase 2.
 *
 *   GET  /api/admin/seo-diagnosis/tools             — list available tools
 *   POST /api/admin/seo-diagnosis/tools/:name       — execute one tool
 *   GET  /api/admin/seo-diagnosis                   — list recent runs (empty until Phase 2)
 *
 * Mounted at /api/admin/seo-diagnosis in server/index.js.
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { TOOLS, executeSeoDiagnosisTool } = require('../services/seo/seo-diagnosis-tools');
const db = require('../models/db');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireAdmin);

router.get('/tools', (_req, res) => {
  res.json({ tools: TOOLS });
});

router.post('/tools/:name', async (req, res, next) => {
  try {
    const out = await executeSeoDiagnosisTool(req.params.name, req.body || {});
    res.json(out);
  } catch (e) {
    if (e.message?.startsWith('Unknown SEO diagnosis tool')) {
      return res.status(404).json({ error: e.message });
    }
    next(e);
  }
});

// List recent runs — empty now, populated in Phase 2.
router.get('/', async (_req, res, next) => {
  try {
    const rows = await db('seo_diagnoses')
      .orderBy('created_at', 'desc')
      .limit(25)
      .catch(() => []);
    res.json({
      diagnoses: rows,
      note: 'Phase 1 ships tool exercises only. Full agent runs land in Phase 2.',
    });
  } catch (err) { next(err); }
});

module.exports = router;
