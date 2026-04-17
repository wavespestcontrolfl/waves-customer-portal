const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const CSRCoach = require('../services/csr/csr-coach');
const { etDateString, addETDays } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// POST /api/admin/csr/score — score a call
router.post('/score', async (req, res, next) => {
  try {
    const result = await CSRCoach.scoreCall(req.body);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/csr/overview?days=30 — team overview
router.get('/overview', async (req, res, next) => {
  try {
    const result = await CSRCoach.getTeamOverview(parseInt(req.query.days || 30));
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/csr/scores — recent call scores
router.get('/scores', async (req, res, next) => {
  try {
    const { csr, days = 30, limit = 50 } = req.query;
    const since = etDateString(addETDays(new Date(), -parseInt(days)));
    let query = db('csr_call_scores').where('call_date', '>=', since);
    if (csr) query = query.where('csr_name', csr);
    const scores = await query.orderBy('created_at', 'desc').limit(parseInt(limit));
    res.json({ scores });
  } catch (err) { next(err); }
});

// GET /api/admin/csr/scores/:id — single score detail
router.get('/scores/:id', async (req, res, next) => {
  try {
    const score = await db('csr_call_scores').where('id', req.params.id).first();
    if (!score) return res.status(404).json({ error: 'Score not found' });
    if (typeof score.point_details === 'string') score.point_details = JSON.parse(score.point_details);
    if (typeof score.better_phrasings === 'string') score.better_phrasings = JSON.parse(score.better_phrasings);
    res.json({ score });
  } catch (err) { next(err); }
});

// GET /api/admin/csr/follow-up-tasks — pending/overdue tasks
router.get('/follow-up-tasks', async (req, res, next) => {
  try {
    const { status } = req.query;
    let query = db('ai_follow_up_tasks')
      .leftJoin('customers', 'ai_follow_up_tasks.customer_id', 'customers.id')
      .select('ai_follow_up_tasks.*', 'customers.first_name', 'customers.last_name', 'customers.phone');

    if (status) query = query.where('ai_follow_up_tasks.status', status);
    else query = query.whereIn('ai_follow_up_tasks.status', ['pending', 'in_progress']);

    const tasks = await query.orderBy('ai_follow_up_tasks.deadline', 'asc');

    const overdue = tasks.filter(t => t.status === 'pending' && new Date(t.deadline) < new Date());
    const pending = tasks.filter(t => t.status === 'pending' && new Date(t.deadline) >= new Date());

    res.json({ tasks, overdue: overdue.length, pending: pending.length });
  } catch (err) { next(err); }
});

// PUT /api/admin/csr/follow-up-tasks/:id — update task
router.put('/follow-up-tasks/:id', async (req, res, next) => {
  try {
    const { status, assigned_to } = req.body;
    const updates = { updated_at: new Date() };
    if (status) {
      updates.status = status;
      if (status === 'completed') {
        updates.action_verified = true;
        updates.verification_method = 'manual_confirm';
        updates.completed_at = new Date();
      }
    }
    if (assigned_to) updates.assigned_to = assigned_to;

    const [task] = await db('ai_follow_up_tasks').where('id', req.params.id).update(updates).returning('*');
    res.json({ task });
  } catch (err) { next(err); }
});

// GET /api/admin/csr/lead-quality — lead quality vs CSR performance breakdown
router.get('/lead-quality', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || 30);
    const since = etDateString(addETDays(new Date(), -days));

    const scores = await db('csr_call_scores').where('call_date', '>=', since);
    const losses = scores.filter(s => s.call_outcome !== 'booked');

    // By lead quality bucket
    const qualityBuckets = { high: { min: 7, max: 10, total: 0, booked: 0 }, medium: { min: 4, max: 6, total: 0, booked: 0 }, low: { min: 1, max: 3, total: 0, booked: 0 } };
    for (const s of scores) {
      const q = s.lead_quality_score || 5;
      for (const [, bucket] of Object.entries(qualityBuckets)) {
        if (q >= bucket.min && q <= bucket.max) {
          bucket.total++;
          if (s.call_outcome === 'booked') bucket.booked++;
        }
      }
    }

    // Loss breakdown
    const lossReasons = {};
    for (const s of losses) {
      const reason = s.loss_reason || 'unknown';
      lossReasons[reason] = (lossReasons[reason] || 0) + 1;
    }

    res.json({
      qualityBuckets: Object.entries(qualityBuckets).map(([label, b]) => ({
        label, ...b, bookingRate: b.total > 0 ? Math.round(b.booked / b.total * 100) : 0,
      })),
      lossReasons: Object.entries(lossReasons).map(([reason, count]) => ({
        reason, count, pct: losses.length > 0 ? Math.round(count / losses.length * 100) : 0,
      })).sort((a, b) => b.count - a.count),
      totalCalls: scores.length,
      totalLosses: losses.length,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/csr/weekly-recommendation
router.get('/weekly-recommendation', async (req, res, next) => {
  try {
    const rec = await CSRCoach.generateWeeklyTeamRecommendation();
    res.json(rec);
  } catch (err) { next(err); }
});

// GET /api/admin/csr/leaderboard
router.get('/leaderboard', async (req, res, next) => {
  try {
    const board = await CSRCoach.getLeaderboard();
    res.json(board);
  } catch (err) { next(err); }
});

// GET /api/admin/csr/first-call-rates
router.get('/first-call-rates', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days || 30);
    const since = etDateString(addETDays(new Date(), -days));

    const scores = await db('csr_call_scores')
      .where('call_date', '>=', since)
      .where('is_first_call_from_lead', true);

    const byCSR = {};
    for (const s of scores) {
      const name = s.csr_name || 'Unknown';
      if (!byCSR[name]) byCSR[name] = { firstCalls: 0, booked: 0 };
      byCSR[name].firstCalls++;
      if (s.call_outcome === 'booked') byCSR[name].booked++;
    }

    res.json({
      rates: Object.entries(byCSR).map(([name, d]) => ({
        name, firstCalls: d.firstCalls, booked: d.booked,
        rate: d.firstCalls > 0 ? Math.round(d.booked / d.firstCalls * 100) : 0,
      })).sort((a, b) => b.rate - a.rate),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/csr/verify-followups — manually trigger verification
router.post('/verify-followups', async (req, res, next) => {
  try {
    const result = await CSRCoach.verifyFollowUps();
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
