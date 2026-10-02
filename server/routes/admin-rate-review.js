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

function lockBusy(res, locked) {
  if (locked.reason === 'lease_held') return res.status(409).json({ error: 'A rate review build is running right now — try again in a minute.', reason: 'build_in_progress' });
  return res.status(503).json({ error: 'The rate review build lock is unavailable — try again shortly.', reason: 'lock_unavailable' });
}

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
      let digestStatus = null;
      if (result.digestReset) {
        try {
          const sent = await rateReview.sendBatchEmail({ batchKey: key });
          digest = sent && sent.sent ? 'resent' : 'reset';
        } catch (err) {
          digest = 'failed';
          digestStatus = Number.isInteger(err && err.status) ? err.status : 'network';
          logger.error(`[admin-rate-review] updated digest for ${key} could not be sent (status ${digestStatus})`);
        }
      }
      return { result, digest, digestStatus };
    }, { recordHealth: false, waitForSlot: false });
    if (wasLockSkipped(locked)) return lockBusy(res, locked);
    const { result, digest, digestStatus } = locked;
    if (!result.ok && result.reason === 'batch_has_sent_rows') {
      return res.status(409).json({ error: 'This batch already has rows that were sent to customers — it cannot be recomputed.', reason: result.reason });
    }
    if (!result.ok) return res.status(409).json({ error: 'Rate review batch could not be built', reason: result.reason });
    const built = { batchKey: result.batchKey, window: result.window, rows: result.rows, summary: result.summary, allowances: result.allowances, digest };
    // The rebuild landed but the owner's updated digest did not. The batch
    // now carries no delivery marker, so a later rebuild sees nothing to
    // reset and would never resend: the failure is answered as one (502,
    // with the batch), and POST …/digest below delivers it on demand.
    if (digest === 'failed') {
      return res.status(502).json({ ...built, ok: false, built: true, reason: 'digest_delivery_failed', digestStatus, error: 'The batch was rebuilt, but its updated digest could not be delivered — send it again from the batch.' });
    }
    return res.json({ ok: true, ...built });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] build failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not build the rate review batch' });
  }
});

// On-demand delivery of a batch's owner digest — the same ops email the
// monthly tick sends to contact@ (never a customer send): the retry for a
// rebuild whose updated digest failed, or a catch-up batch built by hand.
// Under the tick's lock, like the build.
router.post('/batches/:key/digest', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  try {
    const locked = await runExclusive(BUILD_LOCK, async () => {
      // the one-email marker, read under the lock: a retried or double-clicked
      // send after a success delivers nothing more; a rebuild clears it
      if (await rateReview.batchEmailed(key)) return { sent: false, skipped: 'already_sent' };
      return rateReview.sendBatchEmail({ batchKey: key });
    }, { recordHealth: false, waitForSlot: false });
    if (wasLockSkipped(locked)) return lockBusy(res, locked);
    const sent = locked || {};
    if (sent.skipped === 'no_batch') return res.status(404).json({ error: 'No rate review batch has that key', reason: 'no_batch' });
    return res.json({ ok: true, batchKey: key, sent: !!sent.sent, stamped: !!sent.stamped, skipped: sent.skipped || null, subject: sent.subject || null });
  } catch (err) {
    const status = Number.isInteger(err && err.status) ? err.status : 'network';
    logger.error(`[admin-rate-review] digest for ${key} could not be sent (status ${status})`);
    return res.status(502).json({ error: 'The rate review digest could not be delivered — try again.', reason: 'digest_delivery_failed', digestStatus: status });
  }
});

module.exports = router;
