/**
 * WAVES PEST CONTROL — Pricing Intelligence Service
 *
 * Implements Alex Hormozi's Grand Slam Offer / Money Model framework:
 *   1. Value Equation scoring
 *   2. Customer LTV calculation & recalculation
 *   3. Upsell opportunity detection
 *   4. Money Model (attraction → core → upsell → continuity)
 */

const db = require('../models/db');
const logger = require('./logger');

// WaveGuard tier discounts
const TIER_DISCOUNT = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.20 };

// Services Waves offers — used to find gaps for upsells
const ALL_SERVICES = [
  { name: 'General Pest Control', category: 'pest', avgMonthly: 45 },
  { name: 'Lawn Care', category: 'lawn', avgMonthly: 55 },
  { name: 'Mosquito Control', category: 'mosquito', avgMonthly: 65 },
  { name: 'Termite Protection', category: 'termite', avgMonthly: 40 },
  { name: 'Rodent Control', category: 'rodent', avgMonthly: 35 },
  { name: 'Fire Ant Treatment', category: 'fire_ant', avgMonthly: 25 },
  { name: 'Ornamental Care', category: 'ornamental', avgMonthly: 40 },
];

// Health-status to estimated retention months mapping
const RETENTION_MONTHS = {
  healthy: 24,
  watch: 12,
  at_risk: 6,
  critical: 3,
};

class PricingIntelligence {

  // ─────────────────────────────────────────────
  // VALUE EQUATION
  // ─────────────────────────────────────────────

  /**
   * Hormozi Value Equation:
   *   Value = (Dream Outcome × Perceived Likelihood) /
   *           (Time Delay × Effort & Sacrifice)
   *
   * Each input is 1-10. Returns score, recommendation, positioning.
   */
  calculateValueScore({ dreamOutcome, perceivedLikelihood, timeDelay, effortSacrifice }) {
    const dO = Math.max(1, Math.min(10, Number(dreamOutcome) || 5));
    const pL = Math.max(1, Math.min(10, Number(perceivedLikelihood) || 5));
    const tD = Math.max(1, Math.min(10, Number(timeDelay) || 5));
    const eS = Math.max(1, Math.min(10, Number(effortSacrifice) || 5));

    const valueScore = Math.round(((dO * pL) / (tD * eS)) * 100) / 100;

    let positioning, priceRecommendation;

    if (valueScore >= 5) {
      positioning = 'Premium — high perceived value, charge accordingly';
      priceRecommendation = 'Price at top of market. Customers see massive value.';
    } else if (valueScore >= 2) {
      positioning = 'Competitive — good value but room to improve';
      priceRecommendation = 'Price at market rate. Improve likelihood or reduce time/effort to go premium.';
    } else if (valueScore >= 1) {
      positioning = 'Commodity — need to differentiate';
      priceRecommendation = 'Add guarantees, reduce onboarding friction, show faster results.';
    } else {
      positioning = 'Red zone — customers don\'t see enough value';
      priceRecommendation = 'Rethink the offer. Stack bonuses, add unconditional guarantee, speed up results.';
    }

    return {
      valueScore,
      inputs: { dreamOutcome: dO, perceivedLikelihood: pL, timeDelay: tD, effortSacrifice: eS },
      priceRecommendation,
      positioning,
    };
  }

  // ─────────────────────────────────────────────
  // CUSTOMER LTV
  // ─────────────────────────────────────────────

  /**
   * Calculate estimated LTV for a single customer.
   * LTV = monthly_recurring × estimated_months_retained
   */
  async calculateLTV(customerId) {
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) return null;

    // Get health status for retention estimate
    const healthRow = await db('customer_health_scores')
      .where('customer_id', customerId)
      .orderBy('score_date', 'desc')
      .first();

    const healthStatus = healthRow?.churn_risk_level || 'watch';
    const retentionMonths = RETENTION_MONTHS[healthStatus] || 12;

    // Total revenue to date
    const revenueResult = await db('payments')
      .where({ customer_id: customerId, status: 'paid' })
      .sum('amount as total')
      .first();
    const totalRevenue = parseFloat(revenueResult?.total || 0);

    // Total services
    const svcResult = await db('service_records')
      .where({ customer_id: customerId, status: 'completed' })
      .count('id as cnt')
      .first();
    const totalServices = parseInt(svcResult?.cnt || 0, 10);

    // First service date
    const firstSvc = await db('service_records')
      .where({ customer_id: customerId })
      .orderBy('service_date', 'asc')
      .first();

    const monthlyRecurring = parseFloat(customer.monthly_rate || 0);
    const estimatedLtv = monthlyRecurring * retentionMonths;

    // Acquisition cost — check referrals or default
    let acquisitionCost = 0;
    let acquisitionSource = 'organic';

    const referral = await db('referrals')
      .where('referred_customer_id', customerId)
      .first()
      .catch(() => null);

    if (referral) {
      acquisitionCost = 25; // referral bonus cost
      acquisitionSource = 'referral';
    }

    // Check if there's an existing ad attribution (from lead sources)
    const lead = await db('leads')
      .where('customer_id', customerId)
      .first()
      .catch(() => null);

    if (lead?.source) {
      acquisitionSource = lead.source;
      if (['google_ads', 'facebook', 'meta'].includes(lead.source)) {
        acquisitionCost = lead.acquisition_cost || 50; // default ad cost
      }
    }

    const ltvToCac = acquisitionCost > 0 ? Math.round((estimatedLtv / acquisitionCost) * 100) / 100 : null;
    const churnRisk = healthStatus === 'healthy' ? 'low' : healthStatus === 'watch' ? 'medium' : 'high';

    const record = {
      customer_id: customerId,
      acquisition_cost: acquisitionCost,
      acquisition_source: acquisitionSource,
      first_service_date: firstSvc?.service_date || null,
      total_revenue: totalRevenue,
      total_services: totalServices,
      monthly_recurring: monthlyRecurring,
      estimated_ltv: estimatedLtv,
      ltv_to_cac_ratio: ltvToCac,
      churn_risk: churnRisk,
      last_calculated: new Date(),
    };

    // Upsert
    const existing = await db('customer_ltv').where('customer_id', customerId).first();
    if (existing) {
      await db('customer_ltv').where('id', existing.id).update(record);
    } else {
      await db('customer_ltv').insert(record);
    }

    return { ...record, retentionMonths };
  }

  // ─────────────────────────────────────────────
  // RECALCULATE ALL LTVs
  // ─────────────────────────────────────────────

  async recalculateAllLTV() {
    const customers = await db('customers').where('active', true).select('id');
    let processed = 0;
    let errors = 0;

    for (const c of customers) {
      try {
        await this.calculateLTV(c.id);
        processed++;
      } catch (err) {
        errors++;
        logger.error(`[pricing-intel] LTV calc failed for ${c.id}: ${err.message}`);
      }
    }

    logger.info(`[pricing-intel] LTV recalculation complete: ${processed} processed, ${errors} errors`);
    return { processed, errors, total: customers.length };
  }

  // ─────────────────────────────────────────────
  // BEST UPSELL FOR A CUSTOMER
  // ─────────────────────────────────────────────

  /**
   * Find the best upsell for a customer based on what they're missing.
   * Priority: value to customer > margin > likelihood of acceptance.
   */
  async findBestUpsell(customerId) {
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) return null;

    // Get current services from service_records or estimate data
    const activeServices = await db('service_records')
      .where({ customer_id: customerId })
      .whereIn('status', ['completed', 'scheduled'])
      .select('service_type')
      .distinct();

    const currentServiceTypes = activeServices.map(s => (s.service_type || '').toLowerCase());

    // Find services they don't have
    const missingServices = ALL_SERVICES.filter(svc =>
      !currentServiceTypes.some(cur =>
        cur.includes(svc.category) || cur.includes(svc.name.toLowerCase())
      )
    );

    if (missingServices.length === 0) {
      // Already has everything — try tier upgrade
      const currentTier = customer.waveguard_tier || 'Bronze';
      const tiers = ['Bronze', 'Silver', 'Gold', 'Platinum'];
      const currentIdx = tiers.indexOf(currentTier);

      if (currentIdx < tiers.length - 1) {
        const nextTier = tiers[currentIdx + 1];
        const discount = TIER_DISCOUNT[nextTier] - TIER_DISCOUNT[currentTier];
        return {
          type: 'tier_upgrade',
          service: `WaveGuard ${nextTier}`,
          pitch: `Upgrade to ${nextTier} and save an extra ${discount * 100}% on all services — that's real money back every month.`,
          estimatedMonthlyAdd: 0,
          discountPct: discount * 100,
          currentTier,
          nextTier,
        };
      }
      return null; // Platinum with all services
    }

    // Score missing services by priority for SW Florida
    const scored = missingServices.map(svc => {
      let priority = svc.avgMonthly; // base = revenue potential
      // Boost mosquito in FL — huge demand
      if (svc.category === 'mosquito') priority *= 1.5;
      // Boost termite — high margin, high value to customer
      if (svc.category === 'termite') priority *= 1.4;
      // Boost lawn for pest customers (natural cross-sell)
      if (svc.category === 'lawn' && currentServiceTypes.some(s => s.includes('pest'))) priority *= 1.3;
      return { ...svc, priority };
    });

    scored.sort((a, b) => b.priority - a.priority);
    const best = scored[0];

    // Find matching upsell rule for discount
    const rule = await db('upsell_rules')
      .where('enabled', true)
      .where('offer_service', 'ilike', `%${best.category}%`)
      .first();

    const discountPct = rule?.discount_pct || 10;

    return {
      type: 'cross_sell',
      service: best.name,
      category: best.category,
      pitch: `Add ${best.name} to your WaveGuard plan — bundled customers save ${discountPct}% and get priority scheduling.`,
      estimatedMonthlyAdd: Math.round(best.avgMonthly * (1 - discountPct / 100) * 100) / 100,
      discountPct,
      rule: rule || null,
    };
  }

  // ─────────────────────────────────────────────
  // MONEY MODEL (4-stage revenue breakdown)
  // ─────────────────────────────────────────────

  async getMoneyModel() {
    // Stage 1: Attraction — lead gen & first service
    const totalCustomers = await db('customers').where('active', true).count('id as cnt').first();
    const totalLeads = await db('leads').count('id as cnt').first().catch(() => ({ cnt: 0 }));
    const totalEstimates = await db('estimates').count('id as cnt').first();
    const acceptedEstimates = await db('estimates').where('status', 'accepted').count('id as cnt').first();

    // One-time service revenue (attraction stage)
    const onetimeRevenue = await db('payments')
      .where('status', 'paid')
      .whereNotNull('service_record_id')
      .sum('amount as total')
      .first()
      .catch(() => ({ total: 0 }));

    // Stage 2: Core — WaveGuard recurring revenue
    const recurringCustomers = await db('customers')
      .where('active', true)
      .whereNotNull('monthly_rate')
      .where('monthly_rate', '>', 0)
      .select('monthly_rate', 'waveguard_tier');

    const monthlyRecurring = recurringCustomers.reduce((sum, c) => sum + parseFloat(c.monthly_rate || 0), 0);
    const tierBreakdown = {};
    for (const c of recurringCustomers) {
      const tier = c.waveguard_tier || 'Bronze';
      if (!tierBreakdown[tier]) tierBreakdown[tier] = { count: 0, revenue: 0 };
      tierBreakdown[tier].count++;
      tierBreakdown[tier].revenue += parseFloat(c.monthly_rate || 0);
    }

    // Stage 3: Upsell — additional services beyond core
    const avgServicesPerCustomer = await db('service_records')
      .where('status', 'completed')
      .countDistinct('service_type as types')
      .count('id as total')
      .first()
      .catch(() => ({ types: 0, total: 0 }));

    // Stage 4: Continuity — retention metrics
    const retainedCustomers = await db('customers')
      .where('active', true)
      .whereNotNull('member_since')
      .select('member_since');

    const now = new Date();
    const retentionBuckets = { '0-3mo': 0, '3-6mo': 0, '6-12mo': 0, '12-24mo': 0, '24mo+': 0 };
    for (const c of retainedCustomers) {
      const months = (now - new Date(c.member_since)) / (30 * 86400000);
      if (months <= 3) retentionBuckets['0-3mo']++;
      else if (months <= 6) retentionBuckets['3-6mo']++;
      else if (months <= 12) retentionBuckets['6-12mo']++;
      else if (months <= 24) retentionBuckets['12-24mo']++;
      else retentionBuckets['24mo+']++;
    }

    // LTV averages
    const ltvStats = await db('customer_ltv')
      .avg('estimated_ltv as avgLtv')
      .avg('acquisition_cost as avgCac')
      .avg('ltv_to_cac_ratio as avgRatio')
      .first()
      .catch(() => ({ avgLtv: 0, avgCac: 0, avgRatio: 0 }));

    return {
      overview: {
        totalCustomers: parseInt(totalCustomers?.cnt || 0, 10),
        avgLTV: Math.round(parseFloat(ltvStats?.avgLtv || 0) * 100) / 100,
        avgCAC: Math.round(parseFloat(ltvStats?.avgCac || 0) * 100) / 100,
        ltvToCacRatio: Math.round(parseFloat(ltvStats?.avgRatio || 0) * 100) / 100,
        monthlyRecurringRevenue: Math.round(monthlyRecurring * 100) / 100,
        annualizedRecurring: Math.round(monthlyRecurring * 12 * 100) / 100,
      },
      stages: {
        attraction: {
          totalLeads: parseInt(totalLeads?.cnt || 0, 10),
          totalEstimates: parseInt(totalEstimates?.cnt || 0, 10),
          acceptedEstimates: parseInt(acceptedEstimates?.cnt || 0, 10),
          conversionRate: totalEstimates?.cnt > 0
            ? Math.round((acceptedEstimates?.cnt / totalEstimates?.cnt) * 10000) / 100
            : 0,
        },
        core: {
          recurringCustomers: recurringCustomers.length,
          monthlyRecurring: Math.round(monthlyRecurring * 100) / 100,
          tierBreakdown,
        },
        upsell: {
          avgServicesPerCustomer: parseInt(avgServicesPerCustomer?.types || 0, 10),
          totalCompletedServices: parseInt(avgServicesPerCustomer?.total || 0, 10),
        },
        continuity: {
          retentionBuckets,
          totalRetained: retainedCustomers.length,
        },
      },
      funnel: {
        leads: parseInt(totalLeads?.cnt || 0, 10),
        estimates: parseInt(totalEstimates?.cnt || 0, 10),
        accepted: parseInt(acceptedEstimates?.cnt || 0, 10),
        active: parseInt(totalCustomers?.cnt || 0, 10),
      },
    };
  }
}

module.exports = new PricingIntelligence();
