/**
 * Admin rate review — read routes + recompute over rate_review_snapshots
 * (annual rate review ranking backend, plan annual-rate-review-2026-09-30
 * step 2). Admin-only; dark behind GATE_RATE_REVIEW (rateReviewLive(), read
 * per request — off = 404 on every route, nothing read or written).
 *
 *   GET  /api/admin/rate-review/batches             every batch with counts
 *   GET  /api/admin/rate-review/batches/:key        rows + summary + the batch's references
 *   POST /api/admin/rate-review/batches/:key/build  recompute (refused 409 once any row was sent)
 *
 * No sends, no rate writes, no approval parsing here — the reply-APPROVE
 * path, the apply job and the notices are later PRs. The admin screen
 * (Pricing hub → Rate review) is waiting on the owner's mockup approval.
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { rateReviewLive } = require('../config/feature-gates');
const logger = require('../services/logger');
const rateReview = require('../services/rate-review');

const BATCH_KEY_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.use(adminAuthenticate, requireAdmin);

router.use((req, res, next) => {
  if (!rateReviewLive()) return res.status(404).json({ error: 'Rate review is not enabled' });
  return next();
});

function validBatchKey(req, res) {
  const key = String(req.params.key || '');
  if (!BATCH_KEY_RE.test(key)) {
    res.status(400).json({ error: 'batch key must be YYYY-MM' });
    return null;
  }
  return key;
}

router.get('/batches', async (req, res) => {
  try {
    res.json({ enabled: true, batches: await rateReview.listBatches(), config: await rateReview.loadConfig() });
  } catch (err) {
    logger.error(`[admin-rate-review] list failed: ${err.message}`);
    res.status(500).json({ error: 'Could not list rate review batches' });
  }
});

router.get('/batches/:key', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  try {
    res.json(await rateReview.getBatch(key));
  } catch (err) {
    logger.error(`[admin-rate-review] read failed for ${key}: ${err.message}`);
    res.status(500).json({ error: 'Could not read the rate review batch' });
  }
});

router.post('/batches/:key/build', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  const from = req.body && req.body.anniversaryFrom != null ? String(req.body.anniversaryFrom) : null;
  const to = req.body && req.body.anniversaryTo != null ? String(req.body.anniversaryTo) : null;
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return res.status(400).json({ error: 'anniversaryFrom / anniversaryTo must be YYYY-MM-DD' });
  }
  try {
    const result = await rateReview.buildBatch({ batchKey: key, anniversaryFrom: from, anniversaryTo: to });
    if (!result.ok && result.reason === 'batch_has_sent_rows') {
      return res.status(409).json({ error: 'This batch already has rows that were sent to customers — it cannot be recomputed.', reason: result.reason });
    }
    if (!result.ok) return res.status(409).json({ error: 'Rate review batch could not be built', reason: result.reason });
    return res.json({ ok: true, batchKey: result.batchKey, window: result.window, rows: result.rows, summary: result.summary, allowances: result.allowances });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] build failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not build the rate review batch' });
  }
});

module.exports = router;
