/**
 * Admin rate review — read routes + recompute over rate_review_snapshots
 * (annual rate review ranking backend, plan annual-rate-review-2026-09-30
 * step 2). Admin-only; dark behind GATE_RATE_REVIEW (rateReviewLive(), read
 * per request — off = 404 on every route, nothing read or written).
 *
 *   GET  /api/admin/rate-review/batches                    every batch with counts + the config
 *   GET  /api/admin/rate-review/batches/:key               rows + summary + digest + the batch's references
 *   POST /api/admin/rate-review/batches/:key/build         recompute (refused 409 once any row was sent,
 *                                                          approved, or scheduled)
 *   PUT  /api/admin/rate-review/batches/:key/rows/:id      proposed amount / green ↔ skipped (409 once sent, on a locked
 *                                                          row, or on an exception without includeException)
 *   POST /api/admin/rate-review/batches/:key/approve       { expectedDigest } → green rows become 'approved' (NO send)
 *   PUT  /api/admin/rate-review/config                     the knobs + the owner's cost block (audit_log row)
 *   POST /api/admin/rate-review/batches/:key/schedule      draft notice rows for the batch's
 *        approved rows (services/rate-review-apply.js scheduleNoticeRows —
 *        NOTHING is sent; 409 when nothing is approved); body
 *        { plannedSendDate?: 'YYYY-MM-DD' } (default today) — the 30-day
 *        rule is measured from it
 *   DELETE /api/admin/rate-review/batches/:key/schedule    retire the batch's DRAFT
 *        (never delivered) notice rows, unlink their ranking rows and return
 *        every approved row left without a notice to green — the undo before
 *        the send, and what an edit or rebuild of a scheduled batch needs first
 *   GET  /api/admin/rate-review/apply-holds                rate-review notices the nightly
 *        apply refused, with the reason
 *   GET  /api/admin/rate-review/batches/:key/send-preview  who would get a letter,
 *        on which channels, every suppression with its reason, and the digest
 *        the send must match (services/rate-review-comms.js) — reads only
 *   GET  /api/admin/rate-review/batches/:key/rows/:rowId/letter-preview  the
 *        rendered letter for that row's customer ({ subject, html }); 404 until
 *        the row has a scheduled notice — sends nothing
 *   POST /api/admin/rate-review/batches/:key/send   send the batch's letters
 *        (email + SMS pointer) against { expectedDigest } from the preview;
 *        409 when the list or the cost block changed since, or no cost block
 *
 * Approval and send happen ONLY here, from the authenticated Rate review
 * screen — never by email reply (CLAUDE.md rule 14: email approval is never
 * extended to customer comms or money). The nightly apply lives in
 * services/rate-review-apply.js (scheduler 3:10 AM ET). The admin screen is
 * client/src/pages/admin/RateReviewPage.jsx (Pricing hub → Rate review).
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { rateReviewLive } = require('../config/feature-gates');
const { validCalendarDate } = require('../utils/datetime-et');
const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
const logger = require('../services/logger');
const rateReview = require('../services/rate-review');
const rateReviewApply = require('../services/rate-review-apply');
const rateReviewComms = require('../services/rate-review-comms');

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
    res.json({ enabled: true, batches: await rateReview.listBatches(), config: await rateReview.readConfig() });
  } catch (err) {
    logger.error(`[admin-rate-review] list failed: ${err.message}`);
    res.status(500).json({ error: 'Could not list rate review batches' });
  }
});

// Service refusals → HTTP: conflicts are 409, a missing row/batch 404, bad
// input 400. The reason rides along so the screen can word its feedback.
const REASON_STATUS = {
  batch_has_sent_rows: 409,
  row_locked: 409,
  row_is_exception: 409,
  no_visits_per_year: 409,
  digest_mismatch: 409,
  row_not_found: 404,
  batch_not_found: 404,
};

function refuse(res, result) {
  const status = REASON_STATUS[result.reason] || 400;
  const body = { error: result.error || 'Request refused', reason: result.reason };
  if (result.approvalDigest) body.approvalDigest = result.approvalDigest;
  if (result.errors) body.errors = result.errors;
  return res.status(status).json(body);
}

router.put('/batches/:key/rows/:id', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await rateReview.updateRow({
      batchKey: key,
      rowId: String(req.params.id || ''),
      proposedRateCents: body.proposed_rate_cents != null ? body.proposed_rate_cents : null,
      status: body.status != null ? String(body.status) : null,
      includeException: body.includeException === true,
      actorId: req.technicianId || null,
    });
    if (!result.ok) return refuse(res, result);
    return res.json({ ok: true, row: result.row, summary: result.summary, approvalDigest: result.approvalDigest });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] row update failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not update the rate review row' });
  }
});

router.post('/batches/:key/approve', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  const expectedDigest = req.body && req.body.expectedDigest != null ? String(req.body.expectedDigest) : '';
  try {
    const result = await rateReview.approveBatch({ batchKey: key, expectedDigest, actorId: req.technicianId || null });
    if (!result.ok) return refuse(res, result);
    return res.json({ ok: true, approved: result.approved, annual_delta_cents: result.annual_delta_cents, approved_at: result.approved_at, approvalDigest: result.approvalDigest, summary: result.summary });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] approve failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not approve the rate review batch' });
  }
});

router.put('/config', async (req, res) => {
  try {
    const result = await rateReview.updateConfig({ patch: req.body, actorId: req.technicianId || null });
    if (!result.ok) return refuse(res, { ...result, error: (result.errors && result.errors[0]) || 'Settings refused' });
    return res.json({ ok: true, config: result.config, changed: result.changed });
  } catch (err) {
    logger.error(`[admin-rate-review] config update failed: ${err.message}`);
    return res.status(500).json({ error: 'Could not save the rate review settings' });
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

// A build the service refused → 409, worded for the owner where the reason
// is a decision of theirs (anything else keeps the generic line).
const BUILD_REFUSALS = {
  batch_has_sent_rows: 'This batch already has rows that were sent to customers — it cannot be recomputed.',
  batch_has_approved_rows: 'This batch has rows you approved — it cannot be recomputed over your decision.',
  batch_changed: 'This batch was edited while it was being recomputed — build it again.',
  batch_has_scheduled_rows: 'This batch has notice rows scheduled — retire its draft notices first (DELETE …/schedule), then recompute.',
};

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
    if (!result.ok) return res.status(409).json({ error: BUILD_REFUSALS[result.reason] || 'Rate review batch could not be built', reason: result.reason });
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

// Draft notice rows for the batch's approved rows. Nothing is sent here —
// the comms PR sends and marks them sent; the nightly apply writes rates.
router.post('/batches/:key/schedule', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  const plannedSendDate = req.body && req.body.plannedSendDate != null ? String(req.body.plannedSendDate) : null;
  if (plannedSendDate && !validCalendarDate(plannedSendDate)) {
    return res.status(400).json({ error: 'plannedSendDate must be a real calendar date, YYYY-MM-DD' });
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
    return res.json({ ok: true, batchKey: key, retired: result.retired, keptDelivered: result.keptDelivered, revoked: result.revoked });
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
    // channel: where a sent digest went — 'email' (contact@) or 'in_app' (the
    // admin bell, GATE_OPS_DIGESTS_IN_APP) — so the screen never claims an inbox
    // delivery the bell took.
    return res.json({ ok: true, batchKey: key, sent: !!sent.sent, stamped: !!sent.stamped, channel: sent.sent ? sent.channel || null : null, skipped: sent.skipped || null, subject: sent.subject || null });
  } catch (err) {
    const status = Number.isInteger(err && err.status) ? err.status : 'network';
    logger.error(`[admin-rate-review] digest for ${key} could not be sent (status ${status})`);
    return res.status(502).json({ error: 'The rate review digest could not be delivered — try again.', reason: 'digest_delivery_failed', digestStatus: status });
  }
});

// ── comms: preview, letter, send (services/rate-review-comms.js) ─────────

router.get('/batches/:key/send-preview', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  try {
    const preview = await rateReviewComms.sendPreview(key);
    if (!preview.ok) return res.status(404).json({ error: 'Rate review is not enabled', reason: preview.reason });
    return res.json(preview);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] send preview failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not build the send preview' });
  }
});

router.get('/batches/:key/rows/:rowId/letter-preview', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  const rowId = String(req.params.rowId || '');
  if (!/^[0-9a-f-]{36}$/i.test(rowId)) return res.status(400).json({ error: 'row id must be a uuid' });
  try {
    const letter = await rateReviewComms.letterPreview(key, rowId);
    if (!letter.ok) return res.status(404).json({ error: 'Rate review is not enabled', reason: letter.reason });
    return res.json({ subject: letter.subject, html: letter.html, costBlockReady: letter.costBlockReady, suppressed: letter.suppressed });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] letter preview failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not render the letter' });
  }
});

const SEND_REFUSALS = {
  cost_block_missing: 'Write the cost block before sending — the letter prints it.',
  list_changed: 'The send list or the cost block changed since the preview — review it again.',
  nothing_to_send: 'Nothing in this batch can be sent right now.',
};

router.post('/batches/:key/send', async (req, res) => {
  const key = validBatchKey(req, res);
  if (!key) return;
  const expectedDigest = req.body && typeof req.body.expectedDigest === 'string' ? req.body.expectedDigest : '';
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) return res.status(400).json({ error: 'expectedDigest from the send preview is required' });
  try {
    const result = await rateReviewComms.sendBatch(key, { expectedDigest, actorId: req.technicianId || null });
    if (!result.ok && SEND_REFUSALS[result.reason]) return res.status(409).json({ error: SEND_REFUSALS[result.reason], reason: result.reason });
    if (!result.ok && result.reason === 'gate_off') return res.status(404).json({ error: 'Rate review is not enabled', reason: result.reason });
    return res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[admin-rate-review] send failed for ${key}: ${err.message}`);
    return res.status(500).json({ error: 'Could not send the rate review letters' });
  }
});

module.exports = router;
