const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const SignalDetector = require('../services/customer-intelligence/signal-detector');
const HealthScorer = require('../services/customer-intelligence/health-scorer');
const RetentionEngine = require('../services/customer-intelligence/retention-engine');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/customers/intelligence — full overview
router.get('/', async (req, res, next) => {
  try {
    const today = etDateString();

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

    // The current row may carry either scoring engine's churn vocabulary:
    // this pipeline writes healthy/watch/at_risk/critical, the v3 scorer
    // (customer-health.js) writes low/moderate/high/critical onto the same
    // row. Normalize v3 values into the intelligence buckets before
    // filtering so v3-written rows don't vanish from the at-risk views.
    const RISK_NORMALIZE = { low: 'healthy', moderate: 'watch', high: 'at_risk' };
    const normalizeRisk = (r) => RISK_NORMALIZE[r] || r;

    // Distribution
    const dist = { healthy: 0, watch: 0, at_risk: 0, critical: 0 };
    let mrrAtRisk = 0;
    for (const s of scores) {
      const risk = normalizeRisk(s.churn_risk);
      dist[risk] = (dist[risk] || 0) + 1;
      if (['at_risk', 'critical'].includes(risk)) {
        // lifetime_value_estimate is only written by the CI scorer; rows
        // last stamped by the v3 scorer won't have it — fall back to the
        // customer's monthly rate so they don't count as $0 at risk.
        const ltvMonthly = parseFloat(s.lifetime_value_estimate || 0) / 12;
        mrrAtRisk += ltvMonthly > 0 ? ltvMonthly : parseFloat(s.monthly_rate || 0);
      }
    }

    // At-risk and critical customers
    const atRisk = scores
      .filter(s => ['at_risk', 'critical'].includes(normalizeRisk(s.churn_risk)))
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
    // Current score lives in customer_health_scores (one row per customer,
    // updated in place); per-day history lives in customer_health_history.
    const current = await db('customer_health_scores')
      .where('customer_id', req.params.id)
      .orderByRaw('scored_at DESC NULLS LAST')
      .first();

    let history = [];
    try {
      history = await db('customer_health_history')
        .where('customer_id', req.params.id)
        .orderBy('scored_at', 'desc')
        .limit(30);
    } catch (err) {
      logger.warn(`[customer-intel:${req.params.id}] health history read failed: ${err.message}`);
    }

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

    if (current) {
      if (typeof current.churn_signals === 'string') current.churn_signals = JSON.parse(current.churn_signals);
      if (typeof current.upsell_opportunities === 'string') current.upsell_opportunities = JSON.parse(current.upsell_opportunities);
    }

    res.json({ current: current || null, history, signals, outreach, upsells });
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

    // Never text archived customers — retention outreach for a soft-deleted
    // customer is stale by definition.
    const customer = await db('customers')
      .where('id', outreach.customer_id)
      .whereNull('deleted_at')
      .first();
    if (!customer) {
      return res.status(409).json({ error: 'Customer is archived or missing — outreach cannot be sent' });
    }

    // sent_at / status 'sent' are only stamped AFTER a successful send so a
    // blocked or failed send leaves the row in a truthful state.
    const updates = { status: 'approved', approved_by: req.body.approvedBy || 'admin' };

    // If SMS, actually send it
    if (outreach.outreach_type === 'sms') {
      if (customer.phone) {
        try {
          const smsResult = await sendCustomerMessage({
            to: customer.phone,
            body: outreach.message_content,
            channel: 'sms',
            audience: 'customer',
            purpose: 'retention',
            customerId: customer.id,
            identityTrustLevel: 'phone_matches_customer',
            entryPoint: 'admin_customer_intel_retention_approve',
            consentBasis: {
              status: 'opted_in',
              source: 'customer_retention_preferences',
              capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
            },
            metadata: {
              original_message_type: 'retention',
              outreach_id: outreach.id,
              adminUserId: req.technicianId,
            },
          });
          if (smsResult.sent) {
            updates.status = 'sent';
            updates.sent_at = new Date();
          } else {
            updates.status = 'blocked';
            logger.warn(`Retention SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
          }
        } catch (err) {
          updates.status = 'blocked';
          logger.error(`Retention SMS failed: ${err.message}`);
        }
      } else {
        updates.status = 'blocked';
        logger.warn(`Retention SMS for customer ${outreach.customer_id} has no phone on file — marked blocked`);
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
