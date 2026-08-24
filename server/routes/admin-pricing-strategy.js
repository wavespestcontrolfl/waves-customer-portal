/**
 * WAVES PEST CONTROL — Admin Pricing Strategy Routes
 *
 * Hormozi Grand Slam Offer framework:
 *   - Money Model dashboard (attraction → core → upsell → continuity)
 *   - Offer package CRUD (Grand Slam Offers)
 *   - Upsell/downsell rule management
 *   - Value Equation calculator
 *   - Upsell opportunity finder & trigger
 *   - Customer LTV analysis & recalculation
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const PricingIntelligence = require('../services/pricing-intelligence');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');

// Admin-only: this router edits pricing/offer config and can send marketing
// SMS. adminAuthenticate alone admits any active technician.
router.use(adminAuthenticate, requireAdmin);

// Explicit column allowlists for the PUT handlers (migration 071). Never
// accept id / created_at / times_triggered / times_converted from the body.
const OFFER_PACKAGE_COLUMNS = [
  'name', 'description', 'target_market', 'core_services', 'bonuses',
  'guarantee_type', 'guarantee_text', 'scarcity_type', 'scarcity_text',
  'urgency_text', 'anchor_price', 'offer_price', 'perceived_value', 'status',
  'conversion_rate',
];
const UPSELL_RULE_COLUMNS = [
  'name', 'trigger_event', 'condition', 'offer_type', 'offer_service',
  'discount_pct', 'message_template', 'enabled',
];

function pickColumns(body, allowed) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const col of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, col)) out[col] = body[col];
  }
  return out;
}

// =========================================================================
// MONEY MODEL DASHBOARD
// =========================================================================

router.get('/dashboard', async (req, res, next) => {
  try {
    const model = await PricingIntelligence.getMoneyModel();

    // Top upsell opportunities — Bronze/Silver customers who could upgrade
    const upgradeOpps = await db('customers')
      .where('active', true)
      // Archived (soft-deleted) customers keep active=true — scope on deleted_at like whereLiveCustomer (services/customer-stages.js).
      .whereNull('deleted_at')
      .whereIn('waveguard_tier', ['Bronze', 'Silver'])
      .whereNotNull('monthly_rate')
      .where('monthly_rate', '>', 0)
      .select('id', 'first_name', 'last_name', 'waveguard_tier', 'monthly_rate', 'phone')
      .orderBy('monthly_rate', 'desc')
      .limit(20);

    res.json({ ...model, topUpgradeOpportunities: upgradeOpps });
  } catch (err) { next(err); }
});

// =========================================================================
// OFFER PACKAGES (Grand Slam Offers)
// =========================================================================

router.get('/offers', async (req, res, next) => {
  try {
    const offers = await db('offer_packages').orderBy('created_at', 'desc');
    res.json({ offers });
  } catch (err) { next(err); }
});

router.post('/offers', async (req, res, next) => {
  try {
    const {
      name, description, target_market, core_services, bonuses,
      guarantee_type, guarantee_text, scarcity_type, scarcity_text,
      urgency_text, anchor_price, offer_price, perceived_value, status,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Name is required' });

    const [offer] = await db('offer_packages').insert({
      name,
      description: description || null,
      target_market: target_market || null,
      core_services: JSON.stringify(core_services || []),
      bonuses: JSON.stringify(bonuses || []),
      guarantee_type: guarantee_type || 'unconditional',
      guarantee_text: guarantee_text || null,
      scarcity_type: scarcity_type || 'none',
      scarcity_text: scarcity_text || null,
      urgency_text: urgency_text || null,
      anchor_price: anchor_price || null,
      offer_price: offer_price || null,
      perceived_value: perceived_value || null,
      status: status || 'active',
    }).returning('*');

    res.status(201).json({ offer });
  } catch (err) { next(err); }
});

router.put('/offers/:id', async (req, res, next) => {
  try {
    const picked = pickColumns(req.body, OFFER_PACKAGE_COLUMNS);
    if (Object.keys(picked).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }
    const updates = { ...picked, updated_at: new Date() };
    if (updates.core_services) updates.core_services = JSON.stringify(updates.core_services);
    if (updates.bonuses) updates.bonuses = JSON.stringify(updates.bonuses);

    const [offer] = await db('offer_packages').where('id', req.params.id).update(updates).returning('*');
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    res.json({ offer });
  } catch (err) { next(err); }
});

router.delete('/offers/:id', async (req, res, next) => {
  try {
    const deleted = await db('offer_packages').where('id', req.params.id).del();
    if (!deleted) return res.status(404).json({ error: 'Offer not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// UPSELL / DOWNSELL RULES
// =========================================================================

router.get('/upsell-rules', async (req, res, next) => {
  try {
    const rules = await db('upsell_rules').orderBy('created_at', 'desc');
    res.json({ rules });
  } catch (err) { next(err); }
});

router.post('/upsell-rules', async (req, res, next) => {
  try {
    const {
      name, trigger_event, condition, offer_type, offer_service,
      discount_pct, message_template, enabled,
    } = req.body;

    if (!name || !trigger_event || !offer_type) {
      return res.status(400).json({ error: 'name, trigger_event, and offer_type are required' });
    }

    const [rule] = await db('upsell_rules').insert({
      name,
      trigger_event,
      condition: condition ? JSON.stringify(condition) : null,
      offer_type,
      offer_service: offer_service || null,
      discount_pct: discount_pct || 0,
      message_template: message_template || null,
      enabled: enabled !== false,
    }).returning('*');

    res.status(201).json({ rule });
  } catch (err) { next(err); }
});

router.put('/upsell-rules/:id', async (req, res, next) => {
  try {
    const updates = pickColumns(req.body, UPSELL_RULE_COLUMNS);
    if (updates.condition) updates.condition = JSON.stringify(updates.condition);
    if (Object.prototype.hasOwnProperty.call(updates, 'discount_pct') && updates.discount_pct !== null) {
      const pct = Number(updates.discount_pct);
      if (typeof updates.discount_pct === 'boolean' || String(updates.discount_pct).trim() === ''
        || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        return res.status(400).json({ error: 'discount_pct must be a number between 0 and 100' });
      }
      updates.discount_pct = pct;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const [rule] = await db('upsell_rules').where('id', req.params.id).update(updates).returning('*');
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    res.json({ rule });
  } catch (err) { next(err); }
});

// =========================================================================
// VALUE EQUATION CALCULATOR
// =========================================================================

router.post('/calculate-value', async (req, res, next) => {
  try {
    const { dreamOutcome, perceivedLikelihood, timeDelay, effortSacrifice } = req.body;
    const result = PricingIntelligence.calculateValueScore({
      dreamOutcome, perceivedLikelihood, timeDelay, effortSacrifice,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// UPSELL OPPORTUNITIES
// =========================================================================

router.get('/upsell-opportunities', async (req, res, next) => {
  try {
    // Active Bronze/Silver customers with good health
    const candidates = await db('customers')
      .where('active', true)
      .whereNull('deleted_at')
      .whereIn('waveguard_tier', ['Bronze', 'Silver'])
      .whereNotNull('monthly_rate')
      .where('monthly_rate', '>', 0)
      .select('id', 'first_name', 'last_name', 'waveguard_tier', 'monthly_rate', 'phone')
      .limit(50);

    const opportunities = [];
    for (const customer of candidates) {
      try {
        const upsell = await PricingIntelligence.findBestUpsell(customer.id);
        if (upsell) {
          opportunities.push({
            customer: {
              id: customer.id,
              name: `${customer.first_name} ${customer.last_name}`,
              tier: customer.waveguard_tier,
              monthlyRate: parseFloat(customer.monthly_rate),
              phone: customer.phone,
            },
            upsell,
          });
        }
      } catch (err) {
        logger.warn(`[pricing-strategy] Upsell lookup failed for ${customer.id}: ${err.message}`);
      }
    }

    // Sort by estimated revenue add descending
    opportunities.sort((a, b) => (b.upsell.estimatedMonthlyAdd || 0) - (a.upsell.estimatedMonthlyAdd || 0));

    res.json({ opportunities, total: opportunities.length });
  } catch (err) { next(err); }
});

// =========================================================================
// TRIGGER UPSELL SMS
// =========================================================================

router.post('/trigger-upsell/:customerId', async (req, res, next) => {
  try {
    const customer = await db('customers').where('id', req.params.customerId).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    // Action boundary re-check: the candidate list is scoped to live customers,
    // but a stale UI row (or a direct id) must never text an archived/inactive
    // customer. Archive only sets deleted_at, never active — require BOTH
    // deleted_at IS NULL and active === true (active is nullable on legacy rows).
    if (customer.deleted_at || customer.active !== true) {
      return res.status(409).json({ error: 'Customer is archived or inactive — no outreach.', code: 'CUSTOMER_NOT_LIVE' });
    }
    if (!customer.phone) return res.status(400).json({ error: 'Customer has no phone number' });

    // Marketing-grade send: consent must come from the customer's STORED
    // preferences (same basis the drafts/campaign senders assert), never
    // asserted by the admin action itself. Fail closed before any send.
    const prefs = await db('notification_prefs').where('customer_id', customer.id).first();
    if (!prefs || prefs.sms_enabled === false || prefs.seasonal_tips === false) {
      return res.status(422).json({
        error: 'Customer has not opted in to marketing SMS — no outreach.',
        code: 'NO_MARKETING_CONSENT',
      });
    }
    const consentCapturedAt = new Date(prefs.updated_at || prefs.created_at || Date.now()).toISOString();

    const upsell = await PricingIntelligence.findBestUpsell(customer.id);
    if (!upsell) return res.status(404).json({ error: 'No upsell opportunity found for this customer' });

    const firstName = customer.first_name || 'there';

    // Build personalized message
    let message;
    if (upsell.type === 'tier_upgrade') {
      message = await renderRequiredSmsTemplate('upsell_tier_upgrade', {
        first_name: firstName,
        next_tier: upsell.nextTier,
      }, {
        workflow: 'admin_pricing_upsell',
        entity_type: 'customer',
        entity_id: customer.id,
      });
    } else {
      message = await renderRequiredSmsTemplate('upsell_add_service', {
        first_name: firstName,
        service_name: upsell.service,
      }, {
        workflow: 'admin_pricing_upsell',
        entity_type: 'customer',
        entity_id: customer.id,
      });
    }

    const smsResult = await sendCustomerMessage({
      to: customer.phone,
      body: message,
      channel: 'sms',
      audience: 'customer',
      purpose: 'marketing',
      customerId: customer.id,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'admin_pricing_strategy_upsell',
      consentBasis: {
        status: 'opted_in',
        source: 'customer_marketing_preferences',
        capturedAt: consentCapturedAt,
      },
      metadata: {
        original_message_type: 'upsell',
        upsell_type: upsell.type,
        service: upsell.service,
      },
    });
    if (!smsResult.sent) {
      return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });
    }
    logger.info(`[pricing-strategy] Upsell SMS sent to customer ${customer.id}: ${upsell.type} - ${upsell.service}`);

    // Log the attempt — increment times_triggered on matching rule
    if (upsell.rule?.id) {
      await db('upsell_rules').where('id', upsell.rule.id).increment('times_triggered', 1);
    }

    // Log to communications
    await db('communications').insert({
      customer_id: customer.id,
      direction: 'outbound',
      channel: 'sms',
      message,
      status: 'sent',
      metadata: JSON.stringify({ type: 'upsell', upsell }),
    }).catch(() => {}); // non-critical

    res.json({ success: true, upsell, messageSent: message });
  } catch (err) { next(err); }
});

// =========================================================================
// LTV ANALYSIS
// =========================================================================

router.get('/ltv-analysis', async (req, res, next) => {
  try {
    // LTV distribution
    const ltvData = await db('customer_ltv')
      .select('estimated_ltv', 'acquisition_cost', 'acquisition_source',
              'total_revenue', 'monthly_recurring', 'churn_risk', 'ltv_to_cac_ratio');

    const distribution = { '<500': 0, '500-1000': 0, '1000-2000': 0, '2000-5000': 0, '5000+': 0 };
    for (const row of ltvData) {
      const ltv = parseFloat(row.estimated_ltv || 0);
      if (ltv < 500) distribution['<500']++;
      else if (ltv < 1000) distribution['500-1000']++;
      else if (ltv < 2000) distribution['1000-2000']++;
      else if (ltv < 5000) distribution['2000-5000']++;
      else distribution['5000+']++;
    }

    // CAC by acquisition source
    const cacBySource = {};
    for (const row of ltvData) {
      const src = row.acquisition_source || 'unknown';
      if (!cacBySource[src]) cacBySource[src] = { totalCost: 0, count: 0, totalRevenue: 0, totalLtv: 0 };
      cacBySource[src].totalCost += parseFloat(row.acquisition_cost || 0);
      cacBySource[src].count++;
      cacBySource[src].totalRevenue += parseFloat(row.total_revenue || 0);
      cacBySource[src].totalLtv += parseFloat(row.estimated_ltv || 0);
    }

    const channelPerformance = Object.entries(cacBySource).map(([source, data]) => ({
      source,
      avgCAC: data.count > 0 ? Math.round((data.totalCost / data.count) * 100) / 100 : 0,
      avgLTV: data.count > 0 ? Math.round((data.totalLtv / data.count) * 100) / 100 : 0,
      avgRevenue: data.count > 0 ? Math.round((data.totalRevenue / data.count) * 100) / 100 : 0,
      customerCount: data.count,
      roi: data.totalCost > 0 ? Math.round((data.totalRevenue / data.totalCost) * 100) / 100 : null,
    })).sort((a, b) => (b.roi || 0) - (a.roi || 0));

    // Churn risk breakdown
    const churnBreakdown = { low: 0, medium: 0, high: 0 };
    for (const row of ltvData) {
      const risk = row.churn_risk || 'medium';
      churnBreakdown[risk] = (churnBreakdown[risk] || 0) + 1;
    }

    // Retention curve
    const customers = await db('customers')
      .where('active', true)
      // Archived (soft-deleted) customers keep active=true — scope on deleted_at like whereLiveCustomer (services/customer-stages.js).
      .whereNull('deleted_at')
      .whereNotNull('member_since')
      .select('member_since');

    const now = new Date();
    const totalActive = customers.length;
    const retentionCurve = {
      '3mo': { retained: 0, pct: 0 },
      '6mo': { retained: 0, pct: 0 },
      '12mo': { retained: 0, pct: 0 },
      '24mo': { retained: 0, pct: 0 },
    };

    for (const c of customers) {
      const months = (now - new Date(c.member_since)) / (30 * 86400000);
      if (months >= 3) retentionCurve['3mo'].retained++;
      if (months >= 6) retentionCurve['6mo'].retained++;
      if (months >= 12) retentionCurve['12mo'].retained++;
      if (months >= 24) retentionCurve['24mo'].retained++;
    }

    // Calculate percentages relative to total
    for (const key of Object.keys(retentionCurve)) {
      retentionCurve[key].pct = totalActive > 0
        ? Math.round((retentionCurve[key].retained / totalActive) * 10000) / 100
        : 0;
    }

    res.json({
      totalTracked: ltvData.length,
      distribution,
      channelPerformance,
      churnBreakdown,
      retentionCurve,
      summary: {
        avgLTV: ltvData.length > 0
          ? Math.round(ltvData.reduce((s, r) => s + parseFloat(r.estimated_ltv || 0), 0) / ltvData.length * 100) / 100
          : 0,
        avgCAC: ltvData.length > 0
          ? Math.round(ltvData.reduce((s, r) => s + parseFloat(r.acquisition_cost || 0), 0) / ltvData.length * 100) / 100
          : 0,
        avgMonthlyRecurring: ltvData.length > 0
          ? Math.round(ltvData.reduce((s, r) => s + parseFloat(r.monthly_recurring || 0), 0) / ltvData.length * 100) / 100
          : 0,
      },
    });
  } catch (err) { next(err); }
});

// =========================================================================
// RECALCULATE LTV
// =========================================================================

router.post('/recalculate-ltv', async (req, res, next) => {
  try {
    const result = await PricingIntelligence.recalculateAllLTV();
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

module.exports = router;
