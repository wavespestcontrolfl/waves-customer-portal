const express = require('express');
const router = express.Router();
const { adminAuthenticate } = require('../middleware/admin-auth');
const db = require('../models/db');
const logger = require('../services/logger');
const healthService = require('../services/customer-health');
const alertService = require('../services/health-alerts');
const saveSequences = require('../services/save-sequences');

router.use(adminAuthenticate);

// Auto-create health tables if missing
async function ensureHealthTables() {
  if (!(await db.schema.hasTable('customer_health_scores'))) {
    await db.schema.createTable('customer_health_scores', t => {
      t.uuid('id').primary().defaultTo(db.raw("gen_random_uuid()"));
      t.uuid('customer_id').notNullable().unique();
      t.integer('health_score').defaultTo(50);
      t.integer('overall_score').defaultTo(50);
      t.string('score_grade', 1).defaultTo('C');
      t.integer('payment_score').defaultTo(50); t.integer('service_score').defaultTo(50);
      t.integer('engagement_score').defaultTo(50); t.integer('satisfaction_score').defaultTo(50);
      t.integer('loyalty_score').defaultTo(50); t.integer('growth_score').defaultTo(50);
      t.jsonb('payment_details'); t.jsonb('service_details'); t.jsonb('engagement_details');
      t.jsonb('satisfaction_details'); t.jsonb('loyalty_details'); t.jsonb('growth_details');
      t.string('churn_risk', 10).defaultTo('low'); t.string('churn_risk_level', 20).defaultTo('low');
      t.decimal('churn_probability', 5, 4); t.jsonb('churn_signals');
      t.integer('days_until_predicted_churn');
      t.string('score_trend', 10).defaultTo('stable');
      t.integer('previous_score'); t.integer('score_change_30d');
      t.timestamp('scored_at').defaultTo(db.fn.now());
      t.timestamps(true, true);
      t.index('churn_risk'); t.index('overall_score'); t.index('score_grade');
    });
    console.log('[health] Auto-created customer_health_scores table');
  }
  if (!(await db.schema.hasTable('customer_health_alerts'))) {
    await db.schema.createTable('customer_health_alerts', t => {
      t.uuid('id').primary().defaultTo(db.raw("gen_random_uuid()"));
      t.uuid('customer_id').notNullable();
      t.string('alert_type', 30).notNullable(); t.string('severity', 10).notNullable();
      t.string('title', 300).notNullable(); t.text('description');
      t.jsonb('trigger_data'); t.jsonb('recommended_actions');
      t.string('status', 20).defaultTo('new'); t.string('resolved_by', 100);
      t.timestamp('resolved_at'); t.text('resolution_notes'); t.jsonb('auto_action_taken');
      t.timestamps(true, true);
      t.index('status'); t.index('severity'); t.index('customer_id');
    });
    console.log('[health] Auto-created customer_health_alerts table');
  }
  if (!(await db.schema.hasTable('customer_save_sequences'))) {
    await db.schema.createTable('customer_save_sequences', t => {
      t.uuid('id').primary().defaultTo(db.raw("gen_random_uuid()"));
      t.uuid('customer_id').notNullable(); t.uuid('trigger_alert_id');
      t.string('sequence_type', 30).notNullable(); t.string('status', 20).defaultTo('active');
      t.integer('current_step').defaultTo(1); t.integer('total_steps').notNullable();
      t.jsonb('steps').notNullable(); t.timestamp('started_at').defaultTo(db.fn.now());
      t.timestamp('completed_at'); t.string('outcome', 20); t.text('outcome_notes');
      t.timestamps(true, true); t.index('customer_id'); t.index('status');
    });
    console.log('[health] Auto-created customer_save_sequences table');
  }
  if (!(await db.schema.hasTable('customer_health_history'))) {
    await db.schema.createTable('customer_health_history', t => {
      t.increments('id'); t.uuid('customer_id').notNullable();
      t.integer('overall_score').notNullable();
      t.integer('payment_score'); t.integer('service_score'); t.integer('engagement_score');
      t.integer('satisfaction_score'); t.integer('loyalty_score'); t.integer('growth_score');
      t.string('churn_risk', 10); t.date('scored_at').notNullable();
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.index(['customer_id', 'scored_at']); t.index('scored_at');
    });
    console.log('[health] Auto-created customer_health_history table');
  }
  // Ensure score_grade and churn_risk columns exist on customer_health_scores
  try {
    if (!(await db.schema.hasColumn('customer_health_scores', 'score_grade'))) {
      await db.schema.alterTable('customer_health_scores', t => { t.string('score_grade', 1).defaultTo('C'); });
    }
    if (!(await db.schema.hasColumn('customer_health_scores', 'churn_risk'))) {
      await db.schema.alterTable('customer_health_scores', t => { t.string('churn_risk', 10).defaultTo('low'); });
    }
    if (!(await db.schema.hasColumn('customer_health_scores', 'overall_score'))) {
      await db.schema.alterTable('customer_health_scores', t => { t.integer('overall_score').defaultTo(50); });
    }
  } catch (e) { logger.error('[health] Column check error:', e.message); }
}

let _healthTablesChecked = false;
router.use(async (req, res, next) => {
  if (!_healthTablesChecked) {
    _healthTablesChecked = true;
    try { await ensureHealthTables(); } catch (e) { console.error('[health] Auto-create error:', e.message); }
  }
  next();
});

// =========================================================================
// GET /dashboard — Summary stats for the health dashboard
// =========================================================================
router.get('/dashboard', async (req, res) => {
  try {
    // Fleet health average
    const avgResult = await db('customer_health_scores')
      .avg('overall_score as avg')
      .first().catch(() => null);
    const fleetHealthAvg = Math.round(parseFloat(avgResult?.avg || 50));

    // At-risk count (high + critical) — churn_risk column may not exist
    let atRiskCount = 0;
    try {
      const atRiskResult = await db('customer_health_scores')
        .whereIn('churn_risk', ['high', 'critical'])
        .count('* as count').first();
      atRiskCount = parseInt(atRiskResult?.count || 0);
    } catch {
      // churn_risk column may not exist — use churn_risk_level instead
      try {
        const atRiskResult = await db('customer_health_scores')
          .whereIn('churn_risk_level', ['at_risk', 'critical'])
          .count('* as count').first();
        atRiskCount = parseInt(atRiskResult?.count || 0);
      } catch { /* column doesn't exist */ }
    }

    // Healthy count (score >= 65)
    const healthyResult = await db('customer_health_scores')
      .where('overall_score', '>=', 65)
      .count('* as count')
      .first().catch(() => ({ count: 0 }));
    const healthyCount = parseInt(healthyResult?.count || 0);

    // Active sequences
    let activeSequences = 0;
    try {
      const seqResult = await db('customer_save_sequences')
        .where('status', 'active')
        .count('* as count').first();
      activeSequences = parseInt(seqResult?.count || 0);
    } catch { /* table may not exist */ }

    // 30-day churn forecast
    let predictedChurns = 0;
    try {
      const churnForecast = await db('customer_health_scores')
        .whereNotNull('churn_probability')
        .sum('churn_probability as total').first();
      predictedChurns = Math.round(parseFloat(churnForecast?.total || 0));
    } catch { /* column may not exist */ }

    // Grade distribution — score_grade may not exist, derive from health_score
    let gradeDistribution = [];
    try {
      gradeDistribution = await db('customer_health_scores')
        .select('score_grade').count('* as count').groupBy('score_grade').orderBy('score_grade');
    } catch {
      // Derive grades from health_score
      try {
        const all = await db('customer_health_scores').select('overall_score');
        const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
        all.forEach(r => {
          const s = r.overall_score || 0;
          if (s >= 80) grades.A++; else if (s >= 65) grades.B++; else if (s >= 50) grades.C++; else if (s >= 35) grades.D++; else grades.F++;
        });
        gradeDistribution = Object.entries(grades).map(([g, c]) => ({ score_grade: g, count: c }));
      } catch { /* no data */ }
    }

    // Churn risk breakdown
    let riskBreakdown = [];
    try {
      riskBreakdown = await db('customer_health_scores').select('churn_risk').count('* as count').groupBy('churn_risk');
    } catch {
      try {
        riskBreakdown = await db('customer_health_scores').select('churn_risk_level as churn_risk').count('* as count').groupBy('churn_risk_level');
      } catch { /* neither column exists */ }
    }

    // Top at-risk customers (top 10)
    let atRiskCustomers = [];
    try {
      atRiskCustomers = await db('customer_health_scores')
        .join('customers', 'customer_health_scores.customer_id', 'customers.id')
        .select('customers.id', 'customers.first_name', 'customers.last_name', 'customers.waveguard_tier', 'customer_health_scores.overall_score', 'customer_health_scores.score_grade', 'customer_health_scores.churn_risk', 'customer_health_scores.days_until_predicted_churn')
        .orderBy('customer_health_scores.overall_score', 'asc')
        .limit(10);
    } catch { /* non-critical */ }

    // Recent alerts (last 10)
    let recentAlerts = [];
    try {
    recentAlerts = await db('customer_health_alerts')
      .leftJoin('customers', 'customer_health_alerts.customer_id', 'customers.id')
      .select(
        'customer_health_alerts.*',
        'customers.first_name',
        'customers.last_name'
      )
      .orderBy('customer_health_alerts.created_at', 'desc')
      .limit(10);
    } catch { /* table may not exist */ }

    res.json({
      fleetHealthAvg,
      atRiskCount,
      healthyCount,
      activeSequences,
      predictedChurns,
      gradeDistribution: gradeDistribution.map(g => ({
        grade: g.score_grade,
        count: parseInt(g.count),
      })),
      riskBreakdown: riskBreakdown.map(r => ({
        risk: r.churn_risk,
        count: parseInt(r.count),
      })),
      atRiskCustomers: atRiskCustomers.map(c => ({
        ...c,
        churn_signals: typeof c.churn_signals === 'string' ? JSON.parse(c.churn_signals) : c.churn_signals,
      })),
      recentAlerts: recentAlerts.map(a => ({
        ...a,
        trigger_data: typeof a.trigger_data === 'string' ? JSON.parse(a.trigger_data) : a.trigger_data,
        recommended_actions: typeof a.recommended_actions === 'string' ? JSON.parse(a.recommended_actions) : a.recommended_actions,
      })),
    });
  } catch (err) {
    logger.error(`[health-api] Dashboard error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GET /scores — Paginated list with filters
// =========================================================================
router.get('/scores', async (req, res) => {
  try {
    const { grade, churn_risk, trend, search, sort = 'health_score', order = 'asc', limit = 50, offset = 0 } = req.query;

    let query = db('customer_health_scores')
      .join('customers', 'customer_health_scores.customer_id', 'customers.id')
      .select(
        'customers.id as customer_id',
        'customers.first_name',
        'customers.last_name',
        'customers.email',
        'customers.phone',
        'customers.waveguard_tier',
        'customer_health_scores.overall_score',
        'customer_health_scores.score_grade',
        'customer_health_scores.payment_score',
        'customer_health_scores.service_score',
        'customer_health_scores.engagement_score',
        'customer_health_scores.satisfaction_score',
        'customer_health_scores.loyalty_score',
        'customer_health_scores.growth_score',
        'customer_health_scores.churn_risk',
        'customer_health_scores.churn_probability',
        'customer_health_scores.score_trend',
        'customer_health_scores.score_change_30d',
        'customer_health_scores.scored_at'
      );

    if (grade) query = query.where('customer_health_scores.score_grade', grade);
    if (churn_risk) query = query.where('customer_health_scores.churn_risk', churn_risk);
    if (trend) query = query.where('customer_health_scores.score_trend', trend);
    if (search) {
      query = query.where(function() {
        this.whereILike('customers.first_name', `%${search}%`)
          .orWhereILike('customers.last_name', `%${search}%`)
          .orWhereILike('customers.email', `%${search}%`);
      });
    }

    const countQuery = query.clone().clearSelect().clearOrder().count('* as count').first();
    const total = parseInt((await countQuery)?.count || 0);

    const allowedSorts = ['overall_score', 'score_grade', 'churn_risk', 'scored_at', 'first_name'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'overall_score';
    const sortOrder = order === 'desc' ? 'desc' : 'asc';

    const scores = await query
      .orderBy(sortCol, sortOrder)
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    res.json({ scores, total });
  } catch (err) {
    logger.error(`[health-api] Scores list error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GET /scores/:customerId — Single customer detail with history
// =========================================================================
router.get('/scores/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;

    const score = await db('customer_health_scores')
      .join('customers', 'customer_health_scores.customer_id', 'customers.id')
      .where('customer_health_scores.customer_id', customerId)
      .select(
        'customers.*',
        'customer_health_scores.overall_score',
        'customer_health_scores.score_grade',
        'customer_health_scores.payment_score',
        'customer_health_scores.service_score',
        'customer_health_scores.engagement_score',
        'customer_health_scores.satisfaction_score',
        'customer_health_scores.loyalty_score',
        'customer_health_scores.growth_score',
        'customer_health_scores.payment_details',
        'customer_health_scores.service_details',
        'customer_health_scores.engagement_details',
        'customer_health_scores.satisfaction_details',
        'customer_health_scores.loyalty_details',
        'customer_health_scores.growth_details',
        'customer_health_scores.churn_risk',
        'customer_health_scores.churn_probability',
        'customer_health_scores.churn_signals',
        'customer_health_scores.days_until_predicted_churn',
        'customer_health_scores.score_trend',
        'customer_health_scores.previous_score',
        'customer_health_scores.score_change_30d',
        'customer_health_scores.scored_at'
      )
      .first();

    if (!score) return res.status(404).json({ error: 'No health score found for this customer' });

    // Parse JSON fields
    const jsonFields = ['payment_details', 'service_details', 'engagement_details', 'satisfaction_details', 'loyalty_details', 'growth_details', 'churn_signals'];
    for (const f of jsonFields) {
      if (typeof score[f] === 'string') {
        try { score[f] = JSON.parse(score[f]); } catch { /* ok */ }
      }
    }

    // History (last 90 days)
    const history = await db('customer_health_history')
      .where('customer_id', customerId)
      .orderBy('scored_at', 'desc')
      .limit(90);

    // Active alerts
    const alerts = await db('customer_health_alerts')
      .where('customer_id', customerId)
      .whereIn('status', ['new', 'acknowledged'])
      .orderBy('created_at', 'desc')
      .limit(20);

    // Active sequences
    const sequences = await db('customer_save_sequences')
      .where('customer_id', customerId)
      .orderBy('created_at', 'desc')
      .limit(5);

    res.json({
      score,
      history,
      alerts: alerts.map(a => ({
        ...a,
        trigger_data: typeof a.trigger_data === 'string' ? JSON.parse(a.trigger_data) : a.trigger_data,
        recommended_actions: typeof a.recommended_actions === 'string' ? JSON.parse(a.recommended_actions) : a.recommended_actions,
      })),
      sequences: sequences.map(s => ({
        ...s,
        steps: typeof s.steps === 'string' ? JSON.parse(s.steps) : s.steps,
      })),
    });
  } catch (err) {
    logger.error(`[health-api] Score detail error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// POST /rescore/:customerId — Trigger rescore for one customer
// =========================================================================
router.post('/rescore/:customerId', async (req, res) => {
  try {
    const result = await healthService.scoreCustomer(req.params.customerId);
    if (!result) return res.status(404).json({ error: 'Customer not found or scoring failed' });
    res.json(result);
  } catch (err) {
    logger.error(`[health-api] Rescore error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// POST /rescore-all — Batch rescore all customers (async)
// =========================================================================
router.post('/rescore-all', async (req, res) => {
  try {
    // Return immediately, run in background
    res.json({ message: 'Batch rescore started', status: 'processing' });

    // Fire and forget
    healthService.scoreAllCustomers().then(result => {
      logger.info(`[health-api] Batch rescore complete: ${result.scored} scored, ${result.failed} failed`);
    }).catch(err => {
      logger.error(`[health-api] Batch rescore failed: ${err.message}`);
    });
  } catch (err) {
    logger.error(`[health-api] Rescore-all error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GET /alerts — Paginated alerts
// =========================================================================
router.get('/alerts', async (req, res) => {
  try {
    const { status, severity, alert_type, limit = 50, offset = 0 } = req.query;
    const result = await alertService.getAlerts({
      status,
      severity,
      alertType: alert_type,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json(result);
  } catch (err) {
    logger.error(`[health-api] Alerts error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// PUT /alerts/:id — Update alert
// =========================================================================
router.put('/alerts/:id', async (req, res) => {
  try {
    const { status, resolutionNotes, resolvedBy } = req.body;
    const alert = await alertService.updateAlert(req.params.id, { status, resolutionNotes, resolvedBy });
    res.json(alert);
  } catch (err) {
    logger.error(`[health-api] Alert update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// POST /alerts/:id/action — Execute a recommended action
// =========================================================================
router.post('/alerts/:id/action', async (req, res) => {
  try {
    const { actionIndex } = req.body;
    const result = await alertService.executeAction(req.params.id, actionIndex);
    res.json(result);
  } catch (err) {
    logger.error(`[health-api] Action execution error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GET /sequences — Active save sequences
// =========================================================================
router.get('/sequences', async (req, res) => {
  try {
    const { status = 'active', limit = 50, offset = 0 } = req.query;

    let query = db('customer_save_sequences')
      .join('customers', 'customer_save_sequences.customer_id', 'customers.id')
      .select(
        'customer_save_sequences.*',
        'customers.first_name',
        'customers.last_name',
        'customers.waveguard_tier',
        'customers.phone'
      )
      .orderBy('customer_save_sequences.created_at', 'desc');

    if (status && status !== 'all') query = query.where('customer_save_sequences.status', status);

    const total = await query.clone().clearSelect().clearOrder().count('* as count').first();
    const sequences = await query.limit(parseInt(limit)).offset(parseInt(offset));

    res.json({
      sequences: sequences.map(s => ({
        ...s,
        steps: typeof s.steps === 'string' ? JSON.parse(s.steps) : s.steps,
      })),
      total: parseInt(total?.count || 0),
    });
  } catch (err) {
    logger.error(`[health-api] Sequences error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// PUT /sequences/:id — Update sequence (cancel, complete)
// =========================================================================
router.put('/sequences/:id', async (req, res) => {
  try {
    const { action, outcome, notes } = req.body;

    if (action === 'cancel') {
      await saveSequences.cancelSequence(req.params.id, notes || 'Admin cancelled');
    } else if (action === 'complete') {
      await saveSequences.completeSequence(req.params.id, outcome, notes);
    } else {
      return res.status(400).json({ error: 'Invalid action. Use "cancel" or "complete".' });
    }

    const updated = await db('customer_save_sequences').where('id', req.params.id).first();
    res.json({ ...updated, steps: typeof updated.steps === 'string' ? JSON.parse(updated.steps) : updated.steps });
  } catch (err) {
    logger.error(`[health-api] Sequence update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
