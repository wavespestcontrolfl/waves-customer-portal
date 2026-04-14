/**
 * Admin Assessment Analytics Routes
 *
 * Product efficacy leaderboard, protocol performance, completion rates,
 * ROI calculator, tech calibration, contradiction detection, neighborhood
 * benchmarks, and tech field knowledge surfacing.
 */

const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const analytics = require('../services/assessment-analytics');
const db = require('../models/db');

router.use(adminAuthenticate);

// =========================================================================
// POST /compute — run all analytics computations (weekly cron target)
// =========================================================================
router.post('/compute', async (req, res, next) => {
  try {
    const results = await analytics.runAll();
    res.json({ success: true, results });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /efficacy — product efficacy leaderboard
// =========================================================================
router.get('/efficacy', async (req, res, next) => {
  try {
    const { season, track, minApplications, sort } = req.query;
    let query = db('product_efficacy');

    if (minApplications) query = query.where('application_count', '>=', parseInt(minApplications));

    const orderCol = sort === 'applications' ? 'application_count'
      : sort === 'delta' ? 'avg_delta_overall'
      : 'efficacy_rank';
    const orderDir = sort === 'delta' ? 'desc' : (sort === 'applications' ? 'desc' : 'asc');

    const products = await query.orderBy(orderCol, orderDir).limit(100);

    // If filtering by season or track, parse the JSONB stats
    let filtered = products;
    if (season) {
      filtered = products.map(p => {
        let stats;
        try { stats = typeof p[`${season}_stats`] === 'string' ? JSON.parse(p[`${season}_stats`]) : p[`${season}_stats`]; } catch { stats = {}; }
        return { ...p, seasonalStats: stats };
      }).filter(p => p.seasonalStats?.count > 0);
    }

    if (track) {
      filtered = filtered.map(p => {
        let trackStats;
        try { trackStats = typeof p.track_stats === 'string' ? JSON.parse(p.track_stats) : p.track_stats; } catch { trackStats = {}; }
        return { ...p, trackSpecific: trackStats?.[track] || null };
      }).filter(p => p.trackSpecific?.count > 0);
    }

    res.json({ products: filtered, total: filtered.length });
  } catch (err) { next(err); }
});

// POST /efficacy/compute — recompute product efficacy
router.post('/efficacy/compute', async (req, res, next) => {
  try {
    const result = await analytics.computeProductEfficacy();
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /protocol — protocol performance by track
// =========================================================================
router.get('/protocol', async (req, res, next) => {
  try {
    const tracks = await db('protocol_performance').orderBy('protocol_score', 'desc');
    const parsed = tracks.map(t => ({
      ...t,
      visit_performance: typeof t.visit_performance === 'string' ? JSON.parse(t.visit_performance) : t.visit_performance,
      top_products: typeof t.top_products === 'string' ? JSON.parse(t.top_products) : t.top_products,
      bottom_products: typeof t.bottom_products === 'string' ? JSON.parse(t.bottom_products) : t.bottom_products,
    }));
    res.json({ tracks: parsed });
  } catch (err) { next(err); }
});

router.get('/protocol/:track', async (req, res, next) => {
  try {
    const track = await db('protocol_performance').where({ grass_track: req.params.track }).first();
    if (!track) return res.status(404).json({ error: 'Track not found' });

    // Get individual outcomes for this track
    const outcomes = await db('treatment_outcomes')
      .where({ grass_track: req.params.track })
      .orderBy('treatment_date', 'desc')
      .limit(50)
      .select('treatment_date', 'visit_number', 'delta_turf_density', 'delta_weed_suppression',
        'delta_color_health', 'delta_fungus_control', 'delta_thatch_level', 'products_applied', 'season');

    res.json({
      track: {
        ...track,
        visit_performance: typeof track.visit_performance === 'string' ? JSON.parse(track.visit_performance) : track.visit_performance,
        top_products: typeof track.top_products === 'string' ? JSON.parse(track.top_products) : track.top_products,
      },
      recentOutcomes: outcomes,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /completion — assessment completion rates
// =========================================================================
router.get('/completion', async (req, res, next) => {
  try {
    const { from, to, technicianId } = req.query;
    let query = db('assessment_completion_tracking').orderBy('service_date', 'desc');

    if (from) query = query.where('service_date', '>=', from);
    if (to) query = query.where('service_date', '<=', to);
    if (technicianId) query = query.where({ technician_id: technicianId });

    const rows = await query.limit(200);

    // Aggregate by tech
    const byTech = {};
    for (const r of rows) {
      const key = r.technician_name || r.technician_id || 'Unknown';
      if (!byTech[key]) byTech[key] = { name: key, scheduled: 0, confirmed: 0, days: 0 };
      byTech[key].scheduled += r.lawn_services_scheduled;
      byTech[key].confirmed += r.assessments_confirmed;
      byTech[key].days++;
    }

    for (const t of Object.values(byTech)) {
      t.rate = t.scheduled > 0 ? Math.round((t.confirmed / t.scheduled) * 10000) / 100 : 0;
    }

    res.json({
      daily: rows,
      byTechnician: Object.values(byTech).sort((a, b) => b.rate - a.rate),
    });
  } catch (err) { next(err); }
});

router.post('/completion/compute', async (req, res, next) => {
  try {
    const { from, to } = req.body;
    const result = await analytics.computeCompletionRates(from, to);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /roi — ROI calculator
// =========================================================================
router.get('/roi', async (req, res, next) => {
  try {
    const roi = await analytics.computeROI();
    if (roi.assessedRetention && roi.nonAssessedRetention) {
      roi.retentionDelta = Math.round((roi.assessedRetention - roi.nonAssessedRetention) * 100) / 100;
    }
    res.json(roi);
  } catch (err) { next(err); }
});

// =========================================================================
// GET /calibration — tech calibration summary
// =========================================================================
router.get('/calibration', async (req, res, next) => {
  try {
    const { technicianId } = req.query;
    const summary = await analytics.getTechCalibrationSummary(technicianId || null);
    res.json(summary);
  } catch (err) { next(err); }
});

// =========================================================================
// GET /contradictions — knowledge contradictions
// =========================================================================
router.get('/contradictions', async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = db('knowledge_contradictions').orderBy('severity', 'desc').orderBy('created_at', 'desc');
    if (status) query = query.where({ status });
    else query = query.where({ status: 'open' });

    const contradictions = await query.limit(100);
    res.json({ contradictions });
  } catch (err) { next(err); }
});

router.post('/contradictions/detect', async (req, res, next) => {
  try {
    const result = await analytics.detectContradictions();
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.patch('/contradictions/:id', async (req, res, next) => {
  try {
    const { status, resolution_notes } = req.body;
    const update = { status, updated_at: new Date() };
    if (resolution_notes) update.resolution_notes = resolution_notes;
    if (status === 'resolved' || status === 'dismissed') {
      update.resolved_at = new Date();
      update.resolved_by = req.technician?.name || 'admin';
    }
    const [updated] = await db('knowledge_contradictions')
      .where({ id: req.params.id })
      .update(update)
      .returning('*');
    res.json({ success: true, contradiction: updated });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /benchmarks — neighborhood benchmarks
// =========================================================================
router.get('/benchmarks', async (req, res, next) => {
  try {
    const benchmarks = await db('neighborhood_benchmarks')
      .where('customer_count', '>=', 3)
      .orderBy('customer_count', 'desc');
    res.json({ benchmarks });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /tech-context/:customerId — tech field knowledge surfacing
// =========================================================================
router.get('/tech-context/:customerId', requireTechOrAdmin, async (req, res, next) => {
  try {
    const context = await analytics.getTechFieldContext(req.params.customerId);
    res.json({ context });
  } catch (err) { next(err); }
});

module.exports = router;
