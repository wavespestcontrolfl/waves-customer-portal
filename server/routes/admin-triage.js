/**
 * Triage Inbox — review queue for calls the AI pipeline flagged for a human.
 *
 * triage_items rows are written by the call-recording-processor when
 * CALL_EXTRACTION_V2_DRIVES_ROUTING is enabled and a call can't be safely
 * auto-routed (out-of-area, ambiguous scheduling, missing address, low
 * confidence, etc.). This route lets Virginia list + resolve/dismiss them.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

const OPEN_STATES = ['open', 'in_progress'];
const ALL_STATES = ['open', 'in_progress', 'resolved', 'dismissed'];

// GET /api/admin/triage?status=open  → list items + per-status counts
router.get('/', async (req, res) => {
  try {
    const status = ALL_STATES.includes(req.query.status) ? req.query.status : 'open';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const items = await db('triage_items')
      .leftJoin('call_log', 'triage_items.call_log_id', 'call_log.id')
      .leftJoin('customers', 'call_log.customer_id', 'customers.id')
      .where('triage_items.status', status)
      .orderBy('triage_items.created_at', 'desc')
      .limit(limit)
      .select(
        'triage_items.id',
        'triage_items.call_log_id',
        'triage_items.category',
        'triage_items.severity',
        'triage_items.reason_code',
        'triage_items.status',
        'triage_items.summary',
        'triage_items.payload',
        'triage_items.assigned_to',
        'triage_items.resolution_note',
        'triage_items.resolved_at',
        'triage_items.created_at',
        'call_log.lead_synopsis',
        'call_log.call_summary',
        'call_log.from_phone',
        'call_log.to_phone',
        'call_log.direction',
        'call_log.recording_sid',
        'call_log.recording_url',
        'call_log.created_at as call_created_at',
        'call_log.customer_id',
        'customers.first_name',
        'customers.last_name',
        'customers.phone as customer_phone',
        'customers.email as customer_email',
      );

    const countRows = await db('triage_items')
      .select('status')
      .count('* as n')
      .groupBy('status');
    const counts = { open: 0, in_progress: 0, resolved: 0, dismissed: 0 };
    for (const r of countRows) {
      if (counts[r.status] !== undefined) counts[r.status] = parseInt(r.n, 10);
    }

    res.json({ items, counts });
  } catch (err) {
    logger.error(`[admin-triage] list failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load triage items' });
  }
});

async function transition(req, res, nextStatus) {
  const { id } = req.params;
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null;

  const item = await db('triage_items').where({ id }).first();
  if (!item) return res.status(404).json({ error: 'Triage item not found' });
  if (!OPEN_STATES.includes(item.status)) {
    return res.status(409).json({ error: `Item already ${item.status}` });
  }

  await db('triage_items').where({ id }).update({
    status: nextStatus,
    resolution_note: note,
    assigned_to: req.technicianId,
    resolved_at: new Date(),
    updated_at: new Date(),
  });

  // Keep call_log.review_status in sync with the call's remaining open items.
  if (item.call_log_id) {
    const stillOpen = await db('triage_items')
      .where({ call_log_id: item.call_log_id })
      .whereIn('status', OPEN_STATES)
      .count('* as n')
      .first();
    const remaining = parseInt(stillOpen?.n || 0, 10);
    await db('call_log')
      .where({ id: item.call_log_id })
      .update({ review_status: remaining > 0 ? 'open' : nextStatus, updated_at: new Date() });
  }

  return res.json({ ok: true, id, status: nextStatus });
}

// PUT /api/admin/triage/:id/resolve   { note? }
router.put('/:id/resolve', async (req, res) => {
  try {
    await transition(req, res, 'resolved');
  } catch (err) {
    logger.error(`[admin-triage] resolve failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to resolve item' });
  }
});

// PUT /api/admin/triage/:id/dismiss   { note? }
router.put('/:id/dismiss', async (req, res) => {
  try {
    await transition(req, res, 'dismissed');
  } catch (err) {
    logger.error(`[admin-triage] dismiss failed: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to dismiss item' });
  }
});

module.exports = router;
