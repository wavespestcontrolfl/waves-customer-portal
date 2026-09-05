/**
 * Scoped Hermes Promise Keeper read of the existing Owed queue.
 * Never calls refreshFulfillment: this read must not mutate business records.
 * The shared HMAC nonce/audit writes are the only writes on this route.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const { linkWorkerAuth, finalizeWorkerRequest } = require('../middleware/link-worker-auth');
const { noStore } = require('../middleware/no-store');
const { gateEnvValue, isEnabled } = require('../config/feature-gates');
const { listOpenCommitments, implicitDueAt } = require('../services/call-commitments');
const router = express.Router();

function commitmentsGate(req, res, next) {
  if (!gateEnvValue('GATE_HERMES_COMMITMENTS')) return res.status(404).json({ error: 'commitments lane disabled' });
  next();
}

router.use(noStore);
router.use(commitmentsGate);
router.use(rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));
router.use(linkWorkerAuth('commitments_read'));

router.get('/open', async (req, res, next) => {
  try {
    const { limit = '50', offset = '0' } = req.query;
    if (Object.keys(req.query).some((key) => !['limit', 'offset'].includes(key))
      || typeof limit !== 'string' || !/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100
      || typeof offset !== 'string' || !/^\d{1,6}$/.test(offset)) {
      return res.status(400).json({ error: 'limit must be 1–100 and offset a non-negative integer up to 999999; no other parameters' });
    }
    const now = new Date();
    const rows = await listOpenCommitments(db, { party: 'waves', limit: Number(limit) + 1, offset: Number(offset), includeHints: true, now });
    const hasMore = rows.length > Number(limit);
    const commitments = rows.slice(0, Number(limit)).map((row) => ({
      id: row.id, call_log_id: row.call_log_id, customer_id: row.customer_id,
      party: row.party, kind: row.kind, channel: row.channel, status: row.status, source: row.source,
      description: String(row.description || '').slice(0, 2000),
      description_truncated: String(row.description || '').length > 2000,
      due_at: row.due_at, effective_due_at: row.due_at || implicitDueAt(row),
      overdue: row.overdue, updated_at: row.updated_at, call_started_at: row.call_started_at,
      confidence: row.confidence, human_state: row.human_state,
      evidence: (row.evidence || []).slice(0, 8).map((item) => ({
        quote: String(item.quote || '').slice(0, 1200),
        quote_truncated: String(item.quote || '').length > 1200,
        speaker: item.speaker, matched: item.matched,
        start_ms: item.start_ms, end_ms: item.end_ms, segment_index: item.segment_index, char_offset: item.char_offset,
      })),
      evidence_truncated: (row.evidence || []).length > 8,
      possibly_kept: row.fulfillment ? {
        kind: row.fulfillment.kind, strength: row.fulfillment.strength,
        record_type: row.fulfillment.record_type, record_id: row.fulfillment.record_id,
        matched_at: row.fulfillment.matched_at,
      } : null,
    }));
    if (!await finalizeWorkerRequest(req, 'observed')) return res.status(503).json({ error: 'read audit not recorded' });
    res.json({
      observed_at: now.toISOString(), extraction_enabled: isEnabled('callCommitments'),
      coverage: 'stored_open_waves_call_commitments', fulfillment_refreshed: false,
      pagination_is_snapshot: false, absence_proves_completion: false,
      limit: Number(limit), offset: Number(offset), has_more: hasMore,
      next_offset: hasMore ? Number(offset) + Number(limit) : null,
      commitments, review_path: '/admin/communications#tab=owed',
    });
  } catch (err) { next(err); }
});

module.exports = router;
