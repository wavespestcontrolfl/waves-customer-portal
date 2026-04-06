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
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const PricingIntelligence = require('../services/pricing-intelligence');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');

router.use(adminAuthenticate);

// =========================================================================
// MONEY MODEL DASHBOARD
// =========================================================================

router.get('/dashboard', async (req, res, next) => {
  try {
    const model = await PricingIntelligence.getMoneyModel();

    // Top upsell opportunities — Bronze/Silver customers who could upgrade
    const upgradeOpps = await db('customers')
      .where('active', true)
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
    const updates = { ...req.body, updated_at: new Date() };
    if (updates.core_services) updates.core_services = JSON.stringify(updates.core_services);
    if (updates.bonuses) updates.bonuses = JSON.stringify(updates.bonuses);
    delete updates.id;
    delete updates.created_at;

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
    const updates = { ...req.body };
    if (updates.condition) updates.condition = JSON.stringify(updates.condition);
    delete updates.id;
    delete updates.created_at;

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
    if (!customer.phone) return res.status(400).json({ error: 'Customer has no phone number' });

    const upsell = await PricingIntelligence.findBestUpsell(customer.id);
    if (!upsell) return res.status(404).json({ error: 'No upsell opportunity found for this customer' });

    const firstName = customer.first_name || 'there';

    // Build personalized message
    let message;
    if (upsell.type === 'tier_upgrade') {
      message = `Hey ${firstName}! Adam here from Waves. Quick question — did you know upgrading to WaveGuard ${upsell.nextTier} saves you ${upsell.discountPct}% on every service? Most of our ${upsell.currentTier} members who upgrade save $20-40/mo. Want me to run the numbers for you? Reply YES and I'll send a breakdown. — Waves`;
    } else {
      message = `Hey ${firstName}! Adam here from Waves. Since you're already a WaveGuard member, I wanted to let you know we can add ${upsell.service} to your plan at ${upsell.discountPct}% off — that's just $${upsell.estimatedMonthlyAdd}/mo bundled. Most of our customers in your area add this. Want details? Reply YES. — Waves`;
    }

    // Allow custom message override
    if (req.body.message) {
      message = req.body.message;
    }

    await TwilioService.sendSMS(customer.phone, message);
    logger.info(`[pricing-strategy] Upsell SMS sent to ${firstName} (${customer.phone}): ${upsell.type} — ${upsell.service}`);

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
