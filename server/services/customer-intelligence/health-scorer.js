const db = require('../../models/db');
const logger = require('../logger');
const { SIGNAL_TYPES } = require('./signal-detector');

// Intelligence ENRICHMENT layer.
//
// The canonical health SCORE — overall_score, score_grade, the 6 sub-scores,
// churn_risk/probability/signals, per-day history, and alerts — is owned
// solely by customer-health.js (the nightly diagnostic engine, which also
// folds in this module's behavioral signals). This pass runs AFTER it and only
// ADDS intelligence columns to the current customer_health_scores row:
// upsell_opportunities, next_best_action, lifetime_value_estimate. It never
// recomputes or overwrites the score. This eliminates the prior two-engine
// collision where this file and customer-health.js wrote the same row with
// different algorithms.
class HealthScorer {

  async enrichAllCustomers() {
    const customers = await db('customers').where('active', true).select('id');
    logger.info(`Customer enrichment: ${customers.length} customers`);

    let enriched = 0, upsells = 0;
    for (const c of customers) {
      try {
        const result = await this.enrichCustomer(c.id);
        if (result) { enriched++; upsells += result.upsellCount; }
      } catch (err) {
        logger.error(`Enrichment failed for customer ${c.id}: ${err.message}`);
      }
    }

    logger.info(`Customer enrichment complete: ${enriched} enriched, ${upsells} upsell opportunities`);
    return { enriched, upsells };
  }

  async enrichCustomer(customerId) {
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) return null;

    // Canonical health row (written by customer-health.js earlier in the
    // pipeline). Latest row per customer.
    const row = await db('customer_health_scores')
      .where('customer_id', customerId)
      .orderByRaw('scored_at DESC NULLS LAST')
      .first();

    // Behavioral signals → next best action (unresolved only)
    const signals = await db('customer_signals')
      .where('customer_id', customerId)
      .where('resolved', false);
    const riskFactors = signals
      .filter(s => (SIGNAL_TYPES[s.signal_type]?.weight ?? 0) < 0)
      .map(s => ({
        signal: s.signal_type,
        value: s.signal_value,
        severity: s.severity,
        impact: SIGNAL_TYPES[s.signal_type]?.weight,
      }));

    // Upsell opportunities (also persisted to the upsell_opportunities table).
    const upsellOpps = await this.identifyUpsells(customer);

    // Read risk/probability from the canonical row — never recompute them here.
    const churnRisk = row?.churn_risk || 'low';
    const churnProbability = row?.churn_probability != null ? parseFloat(row.churn_probability) : 0.1;
    const nextAction = this.determineNextAction(customer, churnRisk, riskFactors, upsellOpps);
    const ltv = customer.monthly_rate ? parseFloat(customer.monthly_rate) * 12 * (1 - churnProbability) : 0;

    // Write ONLY enrichment columns onto the canonical row. If no row exists
    // yet (scorer hasn't run for this customer), skip the update — writing a
    // score is not this layer's job. Upsells were still persisted above.
    // engagement_trend is mirrored from the canonical score_trend (which the
    // scorer just refreshed) so consumers that surface engagement_trend — e.g.
    // retention-agent-tools get_at_risk_customers — never read a stale value
    // left over from the old engine.
    if (row) {
      await db('customer_health_scores').where('id', row.id).update({
        upsell_opportunities: JSON.stringify(upsellOpps),
        next_best_action: nextAction,
        lifetime_value_estimate: ltv,
        engagement_trend: row.score_trend || 'stable',
        updated_at: new Date(),
      });
    }

    return { upsellCount: upsellOpps.length, nextAction, hadRow: !!row };
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
        opps.push({ service: 'lawn_care', reason: 'Has pest but no lawn — bundling saves 15% with WaveGuard Gold', confidence: 0.7, monthly_value: 72.50, trigger: 'service_pattern' });
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
        opps.push({ service: 'tier_upgrade_gold', reason: `Has ${svcCount} services on Silver — Gold saves 15%`, confidence: 0.8, monthly_value: parseFloat(customer.monthly_rate || 0) * 0.15, trigger: 'tier_upgrade' });
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

  // Risk vocabulary is the canonical engine's: low / moderate / high / critical.
  determineNextAction(customer, riskLevel, riskFactors, upsells) {
    if (riskLevel === 'critical') {
      const top = riskFactors[0];
      if (top?.signal === 'COMPETITOR_MENTIONED') return `CALL: Retention save — ${customer.first_name} mentioned competitor`;
      if (top?.signal === 'PAYMENT_FAILED_TWICE') return `CALL: Payment issue — offer card update or payment plan`;
      if (top?.signal === 'COMPLAINT_FILED') return `CALL: Resolve complaint for ${customer.first_name}`;
      return `CALL: Urgent retention check-in with ${customer.first_name}`;
    }

    if (riskLevel === 'high') {
      if (riskFactors.some(f => f.signal.includes('SERVICE_GAP'))) return `SMS: Re-engage — hasn't had service in 60+ days`;
      if (riskFactors.some(f => f.signal === 'PRICE_COMPLAINT')) return `SMS: Value reminder — highlight plan perks + savings`;
      return `SMS: Check-in — ask if everything is going well`;
    }

    if (riskLevel === 'moderate') return `MONITOR: Watch ${customer.first_name} — minor signals detected`;

    if (upsells.length > 0) {
      const best = upsells.sort((a, b) => b.confidence - a.confidence)[0];
      return `UPSELL: Recommend ${best.service.replace(/_/g, ' ')} (+$${best.monthly_value}/mo)`;
    }

    return 'MAINTAIN: Healthy customer — continue standard service';
  }
}

module.exports = new HealthScorer();
