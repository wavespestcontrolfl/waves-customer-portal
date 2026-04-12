const db = require('../../models/db');
const logger = require('../logger');
const { SIGNAL_TYPES } = require('./signal-detector');

class HealthScorer {

  async calculateAllHealthScores() {
    const customers = await db('customers').where('active', true).select('id');
    logger.info(`Health scoring: ${customers.length} customers`);

    let atRisk = 0, critical = 0;
    for (const c of customers) {
      const result = await this.calculateHealth(c.id);
      if (result.riskLevel === 'at_risk') atRisk++;
      if (result.riskLevel === 'critical') critical++;
    }

    logger.info(`Health scoring complete: ${atRisk} at-risk, ${critical} critical`);
    return { scored: customers.length, atRisk, critical };
  }

  async calculateHealth(customerId) {
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) return { score: 0, riskLevel: 'unknown' };

    const signals = await db('customer_signals')
      .where('customer_id', customerId)
      .where('resolved', false);

    // Start at 70 (healthy baseline)
    let score = 70;
    const riskFactors = [];

    for (const signal of signals) {
      const config = SIGNAL_TYPES[signal.signal_type];
      if (config) {
        score += config.weight;
        if (config.weight < 0) {
          riskFactors.push({
            signal: signal.signal_type,
            value: signal.signal_value,
            severity: signal.severity,
            impact: config.weight,
          });
        }
      }
    }

    // Tenure bonus
    const memberSince = customer.member_since || customer.created_at;
    if (memberSince) {
      const months = Math.floor((Date.now() - new Date(memberSince).getTime()) / (86400000 * 30));
      if (months > 24) score += 10;
      else if (months > 12) score += 5;
    }

    // Tier bonus
    const tierBonus = { Platinum: 8, Gold: 5, Silver: 3, Bronze: 0 };
    score += tierBonus[customer.waveguard_tier] || 0;

    score = Math.max(0, Math.min(100, score));

    // Risk level + churn probability
    let riskLevel, churnProbability;
    if (score < 30) { riskLevel = 'critical'; churnProbability = 0.8; }
    else if (score < 50) { riskLevel = 'at_risk'; churnProbability = 0.5; }
    else if (score < 65) { riskLevel = 'watch'; churnProbability = 0.25; }
    else { riskLevel = 'healthy'; churnProbability = 0.05; }

    // Engagement trend
    const recent = signals.filter(s => new Date(s.detected_at) > new Date(Date.now() - 30 * 86400000));
    const prior = signals.filter(s => {
      const d = new Date(s.detected_at);
      return d > new Date(Date.now() - 60 * 86400000) && d <= new Date(Date.now() - 30 * 86400000);
    });
    const recentNeg = recent.filter(s => SIGNAL_TYPES[s.signal_type]?.weight < 0).length;
    const priorNeg = prior.filter(s => SIGNAL_TYPES[s.signal_type]?.weight < 0).length;

    let trend = 'stable';
    if (recentNeg > priorNeg + 3) trend = 'disengaging';
    else if (recentNeg > priorNeg + 1) trend = 'declining';
    else if (recentNeg < priorNeg) trend = 'improving';

    // Upsell opportunities
    const upsellOpps = await this.identifyUpsells(customer);

    // Next best action
    const nextAction = this.determineNextAction(customer, riskLevel, riskFactors, upsellOpps);

    // LTV
    const ltv = customer.monthly_rate ? parseFloat(customer.monthly_rate) * 12 * (1 - churnProbability) : 0;

    // Save (upsert for today)
    const today = new Date().toISOString().split('T')[0];
    const existing = await db('customer_health_scores')
      .where('customer_id', customerId)
      .where('scored_at', today)
      .first();

    const record = {
      overall_score: score,
      churn_probability: churnProbability,
      churn_risk: riskLevel,
      churn_signals: JSON.stringify(riskFactors),
      upsell_opportunities: JSON.stringify(upsellOpps),
      next_best_action: nextAction,
      engagement_trend: trend,
      lifetime_value_estimate: ltv,
    };

    if (existing) {
      await db('customer_health_scores').where('id', existing.id).update({ ...record, updated_at: new Date() });
    } else {
      await db('customer_health_scores').insert({ customer_id: customerId, scored_at: today, ...record });
    }

    return { score, riskLevel, churnProbability, trend, riskFactors, upsellOpps, nextAction };
  }

  async identifyUpsells(customer) {
    const opps = [];

    try {
      const currentServices = await db('service_records')
        .where('customer_id', customer.id)
        .where('service_date', '>', new Date(Date.now() - 365 * 86400000))
        .select('service_type')
        .groupBy('service_type');

      const hasService = new Set(currentServices.map(s => (s.service_type || '').toLowerCase()));
      const month = new Date().getMonth();

      // Pest but no lawn
      if (Array.from(hasService).some(s => s.includes('pest')) && !Array.from(hasService).some(s => s.includes('lawn'))) {
        opps.push({ service: 'lawn_care', reason: 'Has pest but no lawn — bundling saves 15% with Gold WaveGuard', confidence: 0.7, monthly_value: 72.50, trigger: 'service_pattern' });
      }

      // Lawn but no pest
      if (Array.from(hasService).some(s => s.includes('lawn')) && !Array.from(hasService).some(s => s.includes('pest'))) {
        opps.push({ service: 'pest_control', reason: 'Has lawn but no pest — Silver saves 10%', confidence: 0.7, monthly_value: 39.50, trigger: 'service_pattern' });
      }

      // Multi-service, no mosquito, peak season
      if (currentServices.length >= 2 && !Array.from(hasService).some(s => s.includes('mosquito')) && month >= 2 && month <= 9) {
        opps.push({ service: 'mosquito_control', reason: 'Peak mosquito season + multi-service customer = easy Gold tier add', confidence: 0.6, monthly_value: 49, trigger: 'seasonal' });
      }

      // No termite protection
      if (Array.from(hasService).some(s => s.includes('pest')) && !Array.from(hasService).some(s => s.includes('termite'))) {
        opps.push({ service: 'termite_monitoring', reason: 'Every SWFL home should have termite monitoring', confidence: 0.5, monthly_value: 35, trigger: 'service_pattern' });
      }

      // Tier upgrade
      const svcCount = currentServices.length;
      if (customer.waveguard_tier === 'Bronze' && svcCount >= 2) {
        opps.push({ service: 'tier_upgrade_silver', reason: `Has ${svcCount} services on Bronze — Silver saves 10%`, confidence: 0.8, monthly_value: parseFloat(customer.monthly_rate || 0) * 0.1, trigger: 'tier_upgrade' });
      } else if (customer.waveguard_tier === 'Silver' && svcCount >= 3) {
        opps.push({ service: 'tier_upgrade_gold', reason: `Has ${svcCount} services on Silver — Gold saves 15%`, confidence: 0.8, monthly_value: parseFloat(customer.monthly_rate || 0) * 0.05, trigger: 'tier_upgrade' });
      }

      // Save to upsell_opportunities table
      for (const opp of opps) {
        const exists = await db('upsell_opportunities')
          .where('customer_id', customer.id)
          .where('recommended_service', opp.service)
          .where('status', 'identified')
          .first();

        if (!exists) {
          await db('upsell_opportunities').insert({
            customer_id: customer.id,
            recommended_service: opp.service,
            reason: opp.reason,
            confidence: opp.confidence,
            estimated_monthly_value: opp.monthly_value,
            estimated_close_probability: opp.confidence * 0.6,
            trigger: opp.trigger,
            status: 'identified',
          });
        }
      }
    } catch { /* service_records may not exist for all customers */ }

    return opps;
  }

  determineNextAction(customer, riskLevel, riskFactors, upsells) {
    if (riskLevel === 'critical') {
      const top = riskFactors[0];
      if (top?.signal === 'COMPETITOR_MENTIONED') return `CALL: Retention save — ${customer.first_name} mentioned competitor`;
      if (top?.signal === 'PAYMENT_FAILED_TWICE') return `CALL: Payment issue — offer card update or payment plan`;
      if (top?.signal === 'COMPLAINT_FILED') return `CALL: Resolve complaint for ${customer.first_name}`;
      return `CALL: Urgent retention check-in with ${customer.first_name}`;
    }

    if (riskLevel === 'at_risk') {
      if (riskFactors.some(f => f.signal.includes('SERVICE_GAP'))) return `SMS: Re-engage — hasn't had service in 60+ days`;
      if (riskFactors.some(f => f.signal === 'PRICE_COMPLAINT')) return `SMS: Value reminder — highlight plan perks + savings`;
      return `SMS: Check-in — ask if everything is going well`;
    }

    if (riskLevel === 'watch') return `MONITOR: Watch ${customer.first_name} — minor signals detected`;

    if (upsells.length > 0) {
      const best = upsells.sort((a, b) => b.confidence - a.confidence)[0];
      return `UPSELL: Recommend ${best.service.replace(/_/g, ' ')} (+$${best.monthly_value}/mo)`;
    }

    return 'MAINTAIN: Healthy customer — continue standard service';
  }
}

module.exports = new HealthScorer();
