/**
 * Admin rate review — read routes + recompute over rate_review_snapshots
 * (annual rate review ranking backend, plan annual-rate-review-2026-09-30
 * step 2). Admin-only; dark behind GATE_RATE_REVIEW (rateReviewLive(), read
 * per request — off = 404 on every route, nothing read or written).
 *
 *   GET  /api/admin/rate-review/batches             every batch with counts
 *   GET  /api/admin/rate-review/batches/:key        rows + summary + the batch's references
 *   POST /api/admin/rate-review/batches/:key/build  recompute (refused 409 once any row was sent)
 *   POST /api/admin/rate-review/batches/:key/schedule  draft notice rows for the batch's
 *        approved rows (services/rate-review-apply.js scheduleNoticeRows —
 *        NOTHING is sent; 409 when nothing is approved); body
 *        { plannedSendDate?: 'YYYY-MM-DD' } (default today) — the 30-day
 *        rule is measured from it
 *   DELETE /api/admin/rate-review/batches/:key/schedule  retire the batch's DRAFT
 *        (never delivered) notice rows and unlink their ranking rows — the undo
 *        before the send, and what a rebuild of a scheduled batch needs first
 *   GET  /api/admin/rate-review/apply-holds         rate-review notices the nightly
 *        apply refused, with the reason
 *
 * No sends and no approval parsing here — approval is the admin screen's
 * POST (UI PR), the notices are sent by the comms PR, and the nightly apply
 * lives in services/rate-review-apply.js (scheduler 3:10 AM ET).
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { rateReviewLive } = require('../config/feature-gates');
const logger = require('../services/logger');
const rateReview = require('../services/rate-review');
const rateReviewApply = require('../services/rate-review-apply');

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
    if (!result.ok && result.reason === 'batch_has_scheduled_rows') {
      return res.status(409).json({ error: 'This batch has notice rows scheduled — retire its draft notices first (DELETE …/schedule), then recompute.', reason: result.reason });
    }
    if (!result.ok) return res.status(409).json({ error: 'Rate review batch could not be built', reason: result.reason });
    return res.json({ ok: true, batchKey: result.batchKey, window: result.window, rows: result.rows, summary: result.summary, allowances: result.allowances });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] build failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not build the rate review batch' });
  }
});

// Draft notice rows for the batch's approved rows. Nothing is sent here —
// the comms PR sends and marks them sent; the nightly apply writes rates.
router.post('/batches/:key/schedule', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  const plannedSendDate = req.body && req.body.plannedSendDate != null ? String(req.body.plannedSendDate) : null;
  if (plannedSendDate && !DATE_RE.test(plannedSendDate)) {
    return res.status(400).json({ error: 'plannedSendDate must be YYYY-MM-DD' });
  }
  try {
    const result = await rateReviewApply.scheduleNoticeRows(key, { plannedSendDate, actorId: req.technicianId || null });
    if (!result.ok && (result.reason === 'nothing_approved' || result.reason === 'no_positive_delta')) {
      return res.status(409).json({ error: 'No approved rate changes to schedule in this batch', reason: result.reason, approved: result.approved || 0 });
    }
    if (!result.ok) return res.status(409).json({ error: 'Notice rows could not be scheduled', reason: result.reason });
    return res.json({
      ok: true, batchKey: key, batchId: result.batchId, plannedSendDate: result.plannedSendDate,
      created: result.created, alreadyScheduled: result.alreadyScheduled, held: result.held,
      firstEffectiveDate: result.firstEffectiveDate, lastEffectiveDate: result.lastEffectiveDate, notices: result.notices,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] schedule failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not schedule the rate review notices' });
  }
});

router.delete('/batches/:key/schedule', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  try {
    const result = await rateReviewApply.retireDraftNotices(key);
    if (!result.ok) return res.status(409).json({ error: 'Draft notice rows could not be retired', reason: result.reason });
    return res.json({ ok: true, batchKey: key, retired: result.retired, keptDelivered: result.keptDelivered });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] retire drafts failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not retire the draft notice rows' });
  }
});

router.get('/apply-holds', async (req, res) => {
  try {
    res.json({ enabled: true, holds: await rateReviewApply.listApplyHolds() });
  } catch (err) {
    logger.error(`[admin-rate-review] apply-holds read failed: ${err.message}`);
    res.status(500).json({ error: 'Could not list the rate review apply holds' });
  }
});

module.exports = router;
