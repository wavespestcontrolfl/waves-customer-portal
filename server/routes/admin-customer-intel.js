const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const SignalDetector = require('../services/customer-intelligence/signal-detector');
const HealthScorer = require('../services/customer-intelligence/health-scorer');
const RetentionEngine = require('../services/customer-intelligence/retention-engine');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/customers/intelligence — full overview
router.get('/', async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get latest health scores
    const healthScores = await db('customer_health_scores as h')
      .join('customers as c', 'h.customer_id', 'c.id')
      .where('h.scored_at', today)
      .where('c.active', true)
      .select('h.*', 'c.first_name', 'c.last_name', 'c.waveguard_tier', 'c.monthly_rate', 'c.phone', 'c.member_since');

    // If no scores for today, get most recent
    let scores = healthScores;
    if (scores.length === 0) {
      scores = await db('customer_health_scores as h')
        .join('customers as c', 'h.customer_id', 'c.id')
        .where('c.active', true)
        .whereRaw('h.scored_at = (SELECT MAX(scored_at) FROM customer_health_scores WHERE customer_id = h.customer_id)')
        .select('h.*', 'c.first_name', 'c.last_name', 'c.waveguard_tier', 'c.monthly_rate', 'c.phone', 'c.member_since');
    }

    // Distribution
    const dist = { healthy: 0, watch: 0, at_risk: 0, critical: 0 };
    let mrrAtRisk = 0;
    for (const s of scores) {
      dist[s.churn_risk] = (dist[s.churn_risk] || 0) + 1;
      if (['at_risk', 'critical'].includes(s.churn_risk)) {
        mrrAtRisk += parseFloat(s.lifetime_value_estimate || 0) / 12;
      }
    }

    // At-risk and critical customers
    const atRisk = scores
      .filter(s => ['at_risk', 'critical'].includes(s.churn_risk))
      .sort((a, b) => (a.overall_score || 100) - (b.overall_score || 100))
      .map(s => ({
        ...s,
        churn_signals: typeof s.churn_signals === 'string' ? JSON.parse(s.churn_signals) : s.churn_signals,
        upsell_opportunities: typeof s.upsell_opportunities === 'string' ? JSON.parse(s.upsell_opportunities) : s.upsell_opportunities,
      }));

    // Pending retention outreach
    const pendingOutreach = await db('retention_outreach as r')
      .join('customers as c', 'r.customer_id', 'c.id')
      .where('r.status', 'pending_approval')
      .select('r.*', 'c.first_name', 'c.last_name', 'c.waveguard_tier', 'c.monthly_rate')
      .orderBy('r.created_at', 'desc');

    // Upsell opportunities
    const upsells = await db('upsell_opportunities as u')
      .join('customers as c', 'u.customer_id', 'c.id')
      .where('u.status', 'identified')
      .where('c.active', true)
      .select('u.*', 'c.first_name', 'c.last_name', 'c.waveguard_tier', 'c.monthly_rate')
      .orderBy('u.confidence', 'desc');

    // Metrics
    const metrics = await RetentionEngine.getMetrics(30);

    res.json({
      distribution: dist,
      totalCustomers: scores.length,
      mrrAtRisk: Math.round(mrrAtRisk),
      atRiskCustomers: atRisk,
      pendingOutreach,
      upsells,
      upsellTotalMonthly: Math.round(upsells.reduce((s, u) => s + parseFloat(u.estimated_monthly_value || 0), 0)),
      metrics,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/intelligence/:id/health — single customer health
router.get('/:id/health', async (req, res, next) => {
  try {
    const history = await db('customer_health_scores')
      .where('customer_id', req.params.id)
      .orderBy('scored_at', 'desc')
      .limit(30);

    const signals = await db('customer_signals')
      .where('customer_id', req.params.id)
      .orderBy('detected_at', 'desc')
      .limit(30);

    const outreach = await db('retention_outreach')
      .where('customer_id', req.params.id)
      .orderBy('created_at', 'desc')
      .limit(10);

    const upsells = await db('upsell_opportunities')
      .where('customer_id', req.params.id)
      .orderBy('created_at', 'desc');

    const latest = history[0];
    if (latest) {
      if (typeof latest.churn_signals === 'string') latest.churn_signals = JSON.parse(latest.churn_signals);
      if (typeof latest.upsell_opportunities === 'string') latest.upsell_opportunities = JSON.parse(latest.upsell_opportunities);
    }

    res.json({ current: latest, history, signals, outreach, upsells });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/intelligence/:id/retention-outreach — generate outreach
router.post('/:id/retention-outreach', async (req, res, next) => {
  try {
    const result = await RetentionEngine.generateRetentionOutreach(req.params.id);
    res.json({ outreach: result });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/intelligence/retention/:id/approve — approve and send
router.put('/retention/:id/approve', async (req, res, next) => {
  try {
    const outreach = await db('retention_outreach').where('id', req.params.id).first();
    if (!outreach) return res.status(404).json({ error: 'Outreach not found' });

    const updates = { status: 'approved', approved_by: req.body.approvedBy || 'admin', sent_at: new Date() };

    // If SMS, actually send it
    if (outreach.outreach_type === 'sms') {
      const customer = await db('customers').where('id', outreach.customer_id).first();
      if (customer?.phone) {
        try {
          const TwilioService = require('../services/twilio');
          await TwilioService.sendSMS(customer.phone, outreach.message_content, {
            customerId: customer.id, messageType: 'retention',
          });
          updates.status = 'sent';
        } catch (err) {
          logger.error(`Retention SMS failed: ${err.message}`);
        }
      }
    } else {
      updates.status = 'approved'; // Call — marked as approved, Adam calls manually
    }

    const [updated] = await db('retention_outreach').where('id', req.params.id).update(updates).returning('*');
    res.json({ outreach: updated });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/intelligence/retention/:id/skip — skip outreach
router.put('/retention/:id/skip', async (req, res, next) => {
  try {
    const [updated] = await db('retention_outreach')
      .where('id', req.params.id)
      .update({ status: 'skipped', updated_at: new Date() })
      .returning('*');
    if (!updated) return res.status(404).json({ error: 'Outreach not found' });
    res.json({ outreach: updated });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/intelligence/retention/:id/outcome — record outcome
router.put('/retention/:id/outcome', async (req, res, next) => {
  try {
    const { outcome, customerResponse, revenueSaved } = req.body;
    const updates = {
      outcome,
      customer_response: customerResponse,
      status: outcome === 'retained' ? 'save_successful' : outcome === 'cancelled' ? 'save_failed' : 'completed',
      updated_at: new Date(),
    };
    if (revenueSaved) updates.revenue_saved = revenueSaved;

    const [updated] = await db('retention_outreach').where('id', req.params.id).update(updates).returning('*');
    res.json({ outreach: updated });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/intelligence/upsells/:id — update upsell status
router.put('/upsells/:id', async (req, res, next) => {
  try {
    const { status, pitchedBy } = req.body;
    const updates = { status, updated_at: new Date() };
    if (status === 'pitched') { updates.pitched_at = new Date(); updates.pitched_by = pitchedBy || 'admin'; }
    if (['accepted', 'declined', 'deferred'].includes(status)) updates.outcome_at = new Date();

    const [updated] = await db('upsell_opportunities').where('id', req.params.id).update(updates).returning('*');
    res.json({ upsell: updated });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/intelligence/metrics — retention metrics
router.get('/metrics/summary', async (req, res, next) => {
  try {
    const metrics = await RetentionEngine.getMetrics(parseInt(req.query.days || 30));
    res.json(metrics);
  } catch (err) { next(err); }
});

// POST /api/admin/customers/intelligence/scan — trigger manual scan
router.post('/scan', async (req, res, next) => {
  try {
    const signalResult = await SignalDetector.detectAllSignals();
    const healthResult = await HealthScorer.calculateAllHealthScores();
    res.json({ signals: signalResult, health: healthResult });
  } catch (err) { next(err); }
});

module.exports = router;
