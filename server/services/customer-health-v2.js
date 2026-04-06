const db = require('../models/db');
const logger = require('./logger');

/**
 * Customer Health Scoring v2
 * Score 0-100 based on recency, payment, SMS responsiveness,
 * service frequency, review status, and lifetime revenue.
 */

async function calculateHealthScore(customerId) {
  const customer = await db('customers').where('id', customerId).first();
  if (!customer) return null;

  const factors = {
    recency: 0,
    payment: 0,
    responsiveness: 0,
    frequency: 0,
    review: 0,
    revenue: 0,
  };

  // --- Recency: days since last completed service ---
  const lastService = await db('service_records')
    .where({ customer_id: customerId, status: 'completed' })
    .orderBy('service_date', 'desc')
    .first();

  if (lastService) {
    const daysSince = Math.floor((Date.now() - new Date(lastService.service_date).getTime()) / 86400000);
    if (daysSince <= 30) factors.recency = 30;
    else if (daysSince <= 60) factors.recency = 20;
    else if (daysSince <= 90) factors.recency = 10;
    else factors.recency = 0;
  } else {
    factors.recency = 0;
  }

  // --- Payment history ---
  const payments = await db('payments')
    .where({ customer_id: customerId })
    .orderBy('payment_date', 'desc')
    .limit(20);

  if (payments.length > 0) {
    const hasUnpaid = payments.some(p => ['failed', 'upcoming'].includes(p.status));
    const allPaid = payments.every(p => p.status === 'paid' || p.status === 'refunded');
    if (allPaid) factors.payment = 20;
    else if (hasUnpaid) factors.payment = 0;
    else factors.payment = 10; // some late
  } else {
    factors.payment = 0;
  }

  // --- SMS responsiveness ---
  const recentOutbound = await db('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    .orderBy('created_at', 'desc')
    .limit(3);

  if (recentOutbound.length === 0) {
    // No SMS sent — neutral score
    factors.responsiveness = 5;
  } else {
    // Check for inbound replies after each outbound
    let replies = 0;
    for (const msg of recentOutbound) {
      const reply = await db('sms_log')
        .where({ customer_id: customerId, direction: 'inbound' })
        .where('created_at', '>', msg.created_at)
        .first();
      if (reply) replies++;
    }

    if (replies === recentOutbound.length) factors.responsiveness = 15;
    else if (replies > 0) factors.responsiveness = 10;
    else factors.responsiveness = 5;
  }

  // --- Service frequency ---
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const serviceCount = await db('service_records')
    .where({ customer_id: customerId, status: 'completed' })
    .where('service_date', '>=', oneYearAgo.toISOString().split('T')[0])
    .count('* as count')
    .first();

  const count = parseInt(serviceCount.count) || 0;
  if (count >= 12) factors.frequency = 15;       // monthly+
  else if (count >= 4) factors.frequency = 10;    // quarterly
  else if (count >= 2) factors.frequency = 5;     // 2x/yr
  else factors.frequency = 0;                     // 1x or less

  // --- Review given ---
  const review = await db('google_reviews')
    .where({ customer_id: customerId })
    .first();

  factors.review = review ? 10 : 0;

  // --- Lifetime revenue ---
  const ltv = parseFloat(customer.lifetime_revenue || 0);
  if (ltv > 2000) factors.revenue = 10;
  else if (ltv > 500) factors.revenue = 5;
  else factors.revenue = 0;

  // --- Total score ---
  const score = factors.recency + factors.payment + factors.responsiveness
    + factors.frequency + factors.review + factors.revenue;

  let risk;
  if (score >= 70) risk = 'healthy';
  else if (score >= 50) risk = 'watch';
  else if (score >= 30) risk = 'at_risk';
  else risk = 'critical';

  return { score, factors, risk };
}

async function calculateAllHealthScores() {
  const customers = await db('customers').where('active', true).select('id');
  logger.info(`Health scoring v2: processing ${customers.length} customers`);

  let counts = { healthy: 0, watch: 0, at_risk: 0, critical: 0 };

  for (const c of customers) {
    try {
      const result = await calculateHealthScore(c.id);
      if (!result) continue;

      await db('customers').where({ id: c.id }).update({
        health_score: result.score,
        health_risk: result.risk,
      });

      counts[result.risk]++;
    } catch (err) {
      logger.error(`Health score failed for customer ${c.id}: ${err.message}`);
    }
  }

  logger.info(`Health scoring v2 complete: ${JSON.stringify(counts)}`);
  return { scored: customers.length, ...counts };
}

module.exports = { calculateHealthScore, calculateAllHealthScores };
