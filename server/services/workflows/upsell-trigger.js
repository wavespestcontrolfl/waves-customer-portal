const db = require('../../models/db');
const logger = require('../logger');
const { sendCustomerMessage } = require('../messaging/send-customer-message');

const TIER_PRICING = {
  silver: { monthly: 49, label: 'Silver' },
  gold: { monthly: 79, label: 'Gold' },
  platinum: { monthly: 109, label: 'Platinum' },
};

class UpsellTrigger {
  /**
   * After a service is completed, check if a non-WaveGuard customer
   * qualifies for an upsell based on frequency + spend thresholds.
   */
  async checkAfterService(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return null;

    // Only target non-WaveGuard customers (Bronze tier or no tier)
    if (customer.waveguard_tier && !['bronze', null].includes(customer.waveguard_tier)) {
      return null;
    }

    // 60-day cooldown on upsell messages
    const recentUpsell = await db('sms_log')
      .where({ customer_id: customerId, message_type: 'upsell' })
      .where('created_at', '>', db.raw("NOW() - INTERVAL '60 days'"))
      .first();

    if (recentUpsell) return null;

    // Count one-time services and total spend in last 12 months.
    // service_records has no amount column — pull totals from paid invoices.
    const serviceStats = await db('service_records')
      .where({ customer_id: customerId })
      .where('service_date', '>', db.raw("NOW() - INTERVAL '12 months'"))
      .count('* as c')
      .first();
    const spendStats = await db('invoices')
      .where({ customer_id: customerId })
      .whereIn('status', ['paid', 'viewed', 'sent'])
      .where('service_date', '>', db.raw("NOW() - INTERVAL '12 months'"))
      .select(db.raw('COALESCE(SUM(total), 0) as total_spent'))
      .first();

    const serviceCount = parseInt(serviceStats?.c || 0, 10);
    const totalSpent = parseFloat(spendStats?.total_spent || 0);

    // Trigger thresholds: 2+ services AND $200+ spent
    if (serviceCount < 2 || totalSpent < 200) return null;

    // Recommend a tier based on spend level
    const recommendedTier = totalSpent > 600 ? 'platinum'
      : totalSpent > 350 ? 'gold' : 'silver';

    const tier = TIER_PRICING[recommendedTier];
    const annualCost = tier.monthly * 12;
    const savings = Math.round(totalSpent - annualCost);

    const body = `Hi ${customer.first_name}! Based on your recent services, our ${tier.label} WaveGuard plan may be a better fit with unlimited coverage and predictable billing. Reply INFO to learn more. - Waves Pest Control`;

    const smsResult = await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'marketing',
      customerId,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'upsell_trigger',
      consentBasis: {
        status: 'opted_in',
        source: 'customer_marketing_preferences',
        capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
      },
      metadata: {
        original_message_type: 'upsell',
        customerLocationId: customer.location_id,
        recommended_tier: recommendedTier,
      },
    });
    if (!smsResult.sent) {
      logger.warn(`Upsell blocked/failed for customer ${customerId}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      return { sent: false, blocked: true, reason: smsResult.code || smsResult.reason, recommendedTier };
    }

    await db('customer_interactions').insert({
      customer_id: customerId,
      type: 'sms_outbound',
      channel: 'sms',
      subject: `Upsell — ${tier.label} WaveGuard recommended`,
      notes: `Auto-triggered: ${serviceCount} services, $${totalSpent.toFixed(0)} spent in 12mo`,
    });

    logger.info(`Upsell sent to customer ${customerId}: ${tier.label} plan recommended`);
    return { sent: true, recommendedTier: recommendedTier, savings };
  }
}

module.exports = new UpsellTrigger();
