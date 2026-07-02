/**
 * Editable KPI-target store — /api/admin/kpi-targets
 *
 * GET returns every kpi_targets row (dashboard tiles + the Settings "KPI
 * Targets" tab both read it); PUT upserts owner edits. Metric keys are
 * validated against SNAPSHOT_METRICS (services/kpi-snapshot.js) — the same
 * stable keys kpi_snapshots and the tiles join on — so a typo can't create an
 * orphan row no tile reads.
 *
 * The client keeps the pre-store hardcoded thresholds as fallbacks
 * (DEFAULT_KPI_TARGETS), so an empty table or a failed fetch renders exactly
 * the dashboard that shipped before this store existed.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { cacheRoute, clearRouteCacheForRequest } = require('../utils/route-cache');
const { SNAPSHOT_METRICS } = require('../services/kpi-snapshot');

const VALID_METRICS = new Set(SNAPSHOT_METRICS.map(([key]) => key));

router.use(adminAuthenticate);

router.get('/', cacheRoute(60), async (req, res, next) => {
  try {
    const rows = await db('kpi_targets').select(
      'metric', 'target', 'amber_band_pct', 'lower_is_better', 'updated_by', 'updated_at',
    );
    res.json({
      targets: rows.map((r) => ({
        metric: r.metric,
        target: r.target == null ? null : parseFloat(r.target),
        amberBandPct: r.amber_band_pct == null ? 10 : parseFloat(r.amber_band_pct),
        lowerIsBetter: !!r.lower_is_better,
        updatedBy: r.updated_by || null,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) { next(err); }
});

// Upsert a batch of {metric, target, amberBandPct?, lowerIsBetter?}. All rows
// validate before any write so a bad entry can't leave a half-saved batch.
router.put('/', requireAdmin, async (req, res, next) => {
  try {
    const targets = Array.isArray(req.body?.targets) ? req.body.targets : null;
    if (!targets || targets.length === 0) {
      return res.status(400).json({ error: 'targets array required' });
    }
    const clean = [];
    for (const t of targets) {
      const metric = String(t?.metric || '');
      if (!VALID_METRICS.has(metric)) {
        return res.status(400).json({ error: `Unknown metric: ${metric || '(empty)'}` });
      }
      const target = Number(t?.target);
      if (!Number.isFinite(target)) {
        return res.status(400).json({ error: `Invalid target for ${metric}` });
      }
      const amber = t?.amberBandPct == null ? 10 : Number(t.amberBandPct);
      if (!Number.isFinite(amber) || amber < 0 || amber > 100) {
        return res.status(400).json({ error: `Invalid amber band for ${metric} (0-100)` });
      }
      clean.push({
        metric,
        target,
        amber_band_pct: amber,
        lower_is_better: !!t?.lowerIsBetter,
      });
    }

    const updatedBy = req.technician?.name || req.technician?.email || null;
    for (const row of clean) {
      await db('kpi_targets')
        .insert({ ...row, updated_by: updatedBy, updated_at: new Date() })
        .onConflict('metric')
        .merge();
    }
    // The saving admin must see their change immediately (60s GET cache).
    clearRouteCacheForRequest(req, ['/admin/kpi-targets']);
    res.json({ updated: clean.length });
  } catch (err) { next(err); }
});

module.exports = router;
