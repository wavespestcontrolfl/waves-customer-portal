/**
 * Admin API for the recruiting queue (/admin/recruiting).
 *
 *   GET   /            list (status/role filters, newest first, ai fields)
 *   GET   /:id         full application detail
 *   PATCH /:id/status  owner status transition + optional note
 *
 * Owner-only (requireAdmin): applications hold applicant PII and hiring
 * decisions. Every transition appends to status_history — the AI screen
 * never changes status; the owner decides every outcome.
 */

const express = require('express');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { ROLES, STATUSES } = require('../services/job-applications');

router.use(adminAuthenticate, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_CHARS = 1000;

router.get('/', async (req, res) => {
  try {
    // Offset pagination so a >200-row status can never permanently hide
    // lower-ranked or unscored applicants behind the AI ordering (codex P1)
    // — the ranking is assist-only; every row must stay reachable.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let query = db('job_applications')
      .select(
        'id', 'role', 'status', 'language', 'contact_snapshot',
        'ai_score', 'ai_recommendation', 'ai_screen', 'created_at', 'updated_at'
      )
      // Best-first: the AI screen exists so the owner reads the queue in
      // ranked order; unscored rows sink, recency breaks ties.
      .orderByRaw('ai_score DESC NULLS LAST, created_at DESC')
      .limit(limit)
      .offset(offset);

    if (STATUSES.includes(req.query.status)) {
      query = query.where({ status: req.query.status });
    }
    if (ROLES.includes(req.query.role)) {
      query = query.where({ role: req.query.role });
    }

    const rows = await query;
    const counts = await db('job_applications')
      .select('status')
      .count('* as n')
      .groupBy('status');

    res.json({
      applications: rows.map((row) => ({
        ...row,
        // List payload stays skimmable: summary only, full screen on detail.
        ai_screen: undefined,
        ai_summary: row.ai_screen?.summary || null,
      })),
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      limit,
      offset,
    });
  } catch (err) {
    logger.error(`[admin-careers] list failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load applications' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const row = await db('job_applications').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ application: row });
  } catch (err) {
    logger.error(`[admin-careers] detail failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load application' });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const status = req.body && req.body.status;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Unknown status' });
    }
    const note = typeof req.body.note === 'string'
      ? req.body.note.trim().slice(0, MAX_NOTE_CHARS)
      : '';

    // Row lock inside one transaction: concurrent transitions must not both
    // derive from the same snapshot and silently drop a history entry.
    const updated = await db.transaction(async (trx) => {
      const row = await trx('job_applications')
        .where({ id: req.params.id })
        .forUpdate()
        .first();
      if (!row) return null;
      if (row.status === status && !note) return row;

      const history = Array.isArray(row.status_history) ? row.status_history : [];
      history.push({
        from: row.status,
        to: status,
        note: note || null,
        by: req.technicianId,
        at: new Date().toISOString(),
      });

      const [next] = await trx('job_applications')
        .where({ id: req.params.id })
        .update({
          status,
          status_history: JSON.stringify(history),
          updated_at: new Date(),
        })
        .returning('*');
      return next;
    });

    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ application: updated });
  } catch (err) {
    logger.error(`[admin-careers] status update failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to update application' });
  }
});

module.exports = router;
