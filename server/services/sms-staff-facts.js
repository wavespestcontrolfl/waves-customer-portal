'use strict';
// Facts staff know and the texting agent may state (owner 2026-11-25, texting AI fix step 2: "feed the facts staff know"): a customer's
// prepaid visits left. This module only READS the numbers; the AI never sees them raw: each plan becomes one finished sentence in
// payment-status-contract.js (the same copy-verbatim contract as the plan price and the balance, PR #5331), so a count the AI writes in
// its own words is held. Counts only, never a technician note or a visit note. A read that fails is "no fact" (null), never a guess.

const logger = require('./logger');

/**
 * The customer's prepaid recurring plans (prepaid-series.listCustomerPrepaidPlans, the same rollup the appointment screens show), as
 * { label, remaining, paid }. A series any of whose visits an ANNUAL prepay term covers or is linked to is left out: its stamped visits
 * are not the term's funded entitlement (a replacement visit may not be stamped yet), so a person answers. null when the read failed;
 * [] when there is none.
 */
async function loadPrepaidPlanFacts(customerId, { db } = {}) {
  if (!customerId || !db) return null;
  try {
    const series = require('./prepaid-series');
    const plans = await series.listCustomerPrepaidPlans(db, customerId);
    const annualRows = await db('scheduled_services')
      .where({ customer_id: customerId })
      .where((qb) => qb.whereNotNull('annual_prepay_term_id').orWhere('prepaid_method', series.ANNUAL_PREPAY_METHOD))
      .select('id', 'recurring_parent_id');
    const annualSeries = new Set(annualRows.map((row) => String(series.resolveSeriesParentId(row))));
    // a label shared with ANY other series (an annual renewal beside an exhausted manual plan included) is ambiguous: it renders for none of them
    const sameLabel = (plan) => plans.filter((other) => String(other.serviceType).toLowerCase() === String(plan.serviceType).toLowerCase()).length;
    return plans
      .filter((plan) => !annualSeries.has(String(plan.seriesParentId)) && sameLabel(plan) === 1)
      .map((plan) => ({ label: String(plan.serviceType || ''), remaining: Number(plan.remainingVisits), paid: Number(plan.paidVisits) }))
      .filter((plan) => plan.label && Number.isInteger(plan.remaining) && Number.isInteger(plan.paid) && plan.paid > 0 && plan.remaining >= 0 && plan.remaining <= plan.paid);
  } catch (err) {
    logger.warn(`[sms-staff-facts] prepaid plans unavailable for customer ${customerId}: ${err.message}`);
    return null;
  }
}

module.exports = { loadPrepaidPlanFacts };
