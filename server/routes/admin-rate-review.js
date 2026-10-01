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
const { validCalendarDate } = require('../utils/datetime-et');
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
const logger = require('../services/logger');
const rateReview = require('../services/rate-review');

// The same advisory lock the monthly tick holds (scheduler.js
// runExclusive('rate-review-monthly')): a build and its digest never
// interleave across the two entry points. No job_health row for an admin
// build, and no waiting — a held lock answers 409.
const BUILD_LOCK = 'rate-review-monthly';

const BATCH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/; // a real month, never 2026-13

router.use(adminAuthenticate, requireAdmin);

router.use((req, res, next) => {
  if (!rateReviewLive()) return res.status(404).json({ error: 'Rate review is not enabled' });
  return next();
});

function validBatchKey(req, res) {
  const key = String(req.params.key || '');
  if (!BATCH_KEY_RE.test(key)) {
    res.status(400).json({ error: 'batch key must be YYYY-MM with a real month' });
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
  // Optional window; both absent → the service's standing window (anniversaries
  // 35–65 days out from today). A shape-only check is not enough: 2026-02-31
  // would reach the DATE write, so each value must be a real calendar date.
  const from = req.body && req.body.anniversaryFrom != null ? String(req.body.anniversaryFrom) : null;
  const to = req.body && req.body.anniversaryTo != null ? String(req.body.anniversaryTo) : null;
  if ((from && !validCalendarDate(from)) || (to && !validCalendarDate(to))) {
    return res.status(400).json({ error: 'anniversaryFrom / anniversaryTo must be real calendar dates, YYYY-MM-DD' });
  }
  try {
    const locked = await runExclusive(BUILD_LOCK, async () => {
      const result = await rateReview.buildBatch({ batchKey: key, anniversaryFrom: from, anniversaryTo: to });
      if (!result.ok) return { result };
      // The owner already read this batch's digest → it is stale now: deliver
      // the updated one (the same ops email to contact@; never a customer
      // send) — inside the same lock, so no tick interleaves.
      let digest = result.digestReset ? 'reset' : 'unchanged';
      if (result.digestReset) {
        try {
          const sent = await rateReview.sendBatchEmail({ batchKey: key });
          digest = sent && sent.sent ? 'resent' : 'reset';
        } catch (err) {
          logger.error(`[admin-rate-review] updated digest for ${key} could not be sent (status ${Number.isInteger(err && err.status) ? err.status : 'network'})`);
        }
      }
      return { result, digest };
    }, { recordHealth: false, waitForSlot: false });
    if (wasLockSkipped(locked)) {
      if (locked.reason === 'lease_held') return res.status(409).json({ error: 'A rate review build is running right now — try again in a minute.', reason: 'build_in_progress' });
      return res.status(503).json({ error: 'The rate review build lock is unavailable — try again shortly.', reason: 'lock_unavailable' });
    }
    const { result, digest } = locked;
    if (!result.ok && result.reason === 'batch_has_sent_rows') {
      return res.status(409).json({ error: 'This batch already has rows that were sent to customers — it cannot be recomputed.', reason: result.reason });
    }
    if (!result.ok) return res.status(409).json({ error: 'Rate review batch could not be built', reason: result.reason });
    return res.json({ ok: true, batchKey: result.batchKey, window: result.window, rows: result.rows, summary: result.summary, allowances: result.allowances, digest });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] build failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not build the rate review batch' });
  }
});

module.exports = router;
