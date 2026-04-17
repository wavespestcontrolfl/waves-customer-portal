const db = require('../models/db');
const { etDateString, addETDays } = require('../utils/datetime-et');

class LeadScorer {
  async calculateScore(customerId) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return 0;
    let score = 0;

    // Engagement (max 40)
    const estimates = await db('estimates').where({ customer_id: customerId });
    if (estimates.some(e => e.status === 'accepted')) score += 15;
    else if (estimates.some(e => e.status === 'viewed')) score += 10;
    else if (estimates.some(e => e.status === 'sent')) score += 5;

    const inboundSms = await db('sms_log').where({ customer_id: customerId, direction: 'inbound' }).count('* as count').first();
    if (parseInt(inboundSms?.count || 0) > 5) score += 10;
    else if (parseInt(inboundSms?.count || 0) > 0) score += 5;

    if (customer.last_contact_date) {
      const days = Math.floor((Date.now() - new Date(customer.last_contact_date)) / 86400000);
      if (days < 7) score += 10;
      else if (days < 30) score += 5;
      else if (days > 90) score -= 10;
    }

    // Value (max 35)
    const tierPts = { Platinum: 15, Gold: 12, Silver: 8, Bronze: 4 };
    score += tierPts[customer.waveguard_tier] || 0;

    const rate = parseFloat(customer.monthly_rate || 0);
    if (rate >= 200) score += 10;
    else if (rate >= 150) score += 7;
    else if (rate >= 100) score += 4;

    const svcTypes = await db('service_records').where({ customer_id: customerId }).select('service_type').groupBy('service_type');
    if (svcTypes.length >= 3) score += 10;
    else if (svcTypes.length >= 2) score += 5;

    // Loyalty (max 15)
    if (customer.member_since || customer.customer_since) {
      const since = customer.customer_since || customer.member_since;
      const months = Math.floor((Date.now() - new Date(since)) / (86400000 * 30));
      if (months >= 24) score += 10;
      else if (months >= 12) score += 7;
      else if (months >= 6) score += 4;
    }

    const referrals = await db('referrals').where({ referrer_customer_id: customerId }).count('* as count').first();
    if (parseInt(referrals?.count || 0) > 0) score += 5;

    // Risk deductions
    const failedPay = await db('payments').where({ customer_id: customerId, status: 'failed' })
      .where('payment_date', '>', etDateString(addETDays(new Date(), -90)))
      .count('* as count').first();
    score -= parseInt(failedPay?.count || 0) * 5;

    score = Math.max(0, Math.min(100, score));
    await db('customers').where({ id: customerId }).update({ lead_score: score });
    return score;
  }

  async recalculateAll() {
    const customers = await db('customers').select('id');
    for (const c of customers) {
      await this.calculateScore(c.id);
    }
  }
}

module.exports = new LeadScorer();
