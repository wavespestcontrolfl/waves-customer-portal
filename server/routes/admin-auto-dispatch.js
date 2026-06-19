/**
 * Admin API for the Auto-Dispatch optimizer.
 *
 *   GET   /api/admin/auto-dispatch/runs              list recent runs
 *   GET   /api/admin/auto-dispatch/runs/:id          run + its decision log
 *   GET   /api/admin/auto-dispatch/services/:id/audit per-service decision history
 *   POST  /api/admin/auto-dispatch/run               manually trigger (body: {mode})
 *   PATCH /api/admin/auto-dispatch/services/:id/lock      body: {locked}
 *   PATCH /api/admin/auto-dispatch/services/:id/exclusion body: {excluded}
 *
 * Owner/operator tool — requireAdmin on every route. The manual run endpoint
 * works regardless of the GATE_AUTO_DISPATCH cron gate (that gate only governs
 * the scheduled job).
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const db = require('../models/db');
const logger = require('../services/logger');
const { runAutoDispatch } = require('../services/auto-dispatch');
const { VALID_MODES, isApplyAllowed } = require('../services/auto-dispatch/config');
const { runExclusive } = require('../utils/cron-lock');

router.use(adminAuthenticate, requireAdmin);

// List recent runs (newest first).
router.get('/runs', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const runs = await db('auto_dispatch_runs')
      .orderBy('started_at', 'desc')
      .limit(limit);
    res.json({ runs });
  } catch (err) {
    logger.error(`[auto-dispatch] GET /runs failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load runs' });
  }
});

// One run with its decision log.
router.get('/runs/:id', async (req, res) => {
  try {
    const run = await db('auto_dispatch_runs').where({ id: req.params.id }).first();
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const logs = await db('auto_dispatch_audit_logs')
      .where({ auto_dispatch_run_id: req.params.id })
      .orderBy('created_at', 'asc');
    res.json({ run, logs });
  } catch (err) {
    logger.error(`[auto-dispatch] GET /runs/:id failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load run' });
  }
});

// Per-service decision history.
router.get('/services/:id/audit', async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const logs = await db('auto_dispatch_audit_logs')
      .where({ scheduled_service_id: req.params.id })
      .orderBy('created_at', 'desc')
      .limit(limit);
    res.json({ logs });
  } catch (err) {
    logger.error(`[auto-dispatch] GET /services/:id/audit failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load service audit' });
  }
});

// Manually trigger a run (dry_run | apply).
router.post('/run', async (req, res) => {
  const mode = (req.body && req.body.mode) || 'dry_run';
  if (!VALID_MODES.has(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${Array.from(VALID_MODES).join(', ')}` });
  }
  // Apply must clear the server-side gate even for requireAdmin callers, so the
  // dry-run validation period can't be bypassed via the manual endpoint.
  if (mode === 'apply' && !isApplyAllowed()) {
    return res.status(403).json({ error: 'Apply mode is disabled. Set AUTO_DISPATCH_ALLOW_APPLY=true to enable.' });
  }
  try {
    logger.info(`[auto-dispatch] manual run requested by tech ${req.technicianId} mode=${mode}`);
    // Share the cron's advisory lock so a manual run can't overlap the 4:10 cron
    // (or another manual run) and double-apply past the per-run cap / stale guard.
    const result = await runExclusive('auto-dispatch-recurring', () => runAutoDispatch({ mode, triggeredBy: 'manual' }));
    if (result && result.skipped) {
      return res.status(409).json({ error: 'Another auto-dispatch run is already in progress', reason: result.reason });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error(`[auto-dispatch] manual run failed: ${err.message}`);
    res.status(500).json({ error: 'Run failed', detail: err.message });
  }
});

function boolFrom(value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

// Lock / unlock a specific recurring visit from auto-dispatch.
router.patch('/services/:id/lock', async (req, res) => {
  const locked = boolFrom(req.body && req.body.locked);
  if (locked === null) return res.status(400).json({ error: 'locked (boolean) is required' });
  try {
    const updated = await db('scheduled_services')
      .where({ id: req.params.id })
      .update({ auto_dispatch_locked: locked, updated_at: db.fn.now() });
    if (!updated) return res.status(404).json({ error: 'Scheduled service not found' });
    res.json({ ok: true, id: req.params.id, auto_dispatch_locked: locked });
  } catch (err) {
    logger.error(`[auto-dispatch] PATCH lock failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to update lock' });
  }
});

// Permanently exclude / re-include a visit from auto-dispatch.
router.patch('/services/:id/exclusion', async (req, res) => {
  const excluded = boolFrom(req.body && req.body.excluded);
  if (excluded === null) return res.status(400).json({ error: 'excluded (boolean) is required' });
  try {
    const updated = await db('scheduled_services')
      .where({ id: req.params.id })
      .update({ auto_dispatch_excluded: excluded, updated_at: db.fn.now() });
    if (!updated) return res.status(404).json({ error: 'Scheduled service not found' });
    res.json({ ok: true, id: req.params.id, auto_dispatch_excluded: excluded });
  } catch (err) {
    logger.error(`[auto-dispatch] PATCH exclusion failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to update exclusion' });
  }
});

module.exports = router;
