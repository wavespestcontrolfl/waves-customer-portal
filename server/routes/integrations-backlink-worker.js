/**
 * Hermes acquisition worker — claim/report contract (Backlink Manager M3a).
 *
 * Machine-to-machine endpoints (service-token auth, NOT admin bearer). Mounted
 * at /api/integrations/backlink-worker. Hermes claims unworked prospects, does
 * the signup/outreach, and reports back; the portal verifies independently.
 */
const express = require('express');
const router = express.Router();
const { hermesAuth } = require('../middleware/hermes-auth');
const { isEnabled } = require('../config/feature-gates');
const worker = require('../services/seo/link-prospect-worker');

router.use(hermesAuth);

// GET /claim?n=10&type=signup|outreach — lease unworked prospects
router.get('/claim', async (req, res, next) => {
  try {
    const type = req.query.type === 'outreach' ? 'outreach' : 'signup';
    // Outreach stays approval-gated: don't hand outreach prospects to the worker
    // until linkProspectOutreach is enabled (M3b).
    if (type === 'outreach' && !isEnabled('linkProspectOutreach')) {
      return res.json({ prospects: [], note: 'outreach is approval-gated (linkProspectOutreach off)' });
    }
    const prospects = await worker.claim({ n: req.query.n, type });
    res.json({ prospects, business_profile: worker.businessProfile() });
  } catch (err) { next(err); }
});

// POST /report — { prospect_id, outcome: placed|failed|skipped, live_url, claimed_anchor, evidence_url, notes }
router.post('/report', async (req, res, next) => {
  try {
    const { prospect_id, outcome } = req.body || {};
    if (!prospect_id) return res.status(400).json({ error: 'prospect_id required' });
    if (!['placed', 'failed', 'skipped'].includes(outcome)) {
      return res.status(400).json({ error: "outcome must be 'placed', 'failed', or 'skipped'" });
    }
    const result = await worker.report(req.body);
    if (!result.ok) {
      const status = { not_found: 404, stale_lease: 409 }[result.code] || 400;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
