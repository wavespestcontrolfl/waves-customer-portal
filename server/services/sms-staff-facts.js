'use strict';
// Facts staff know and the texting agent may state (owner 2026-11-25, texting AI fix step 2: "feed the facts staff know"; owner ruling
// 2026-09-30: price and fee questions are explained from the estimate and invoice on file): the open estimate's per-application price and
// applications a year, and a customer's prepaid visits left. This module only READS the numbers; the AI never sees them raw: each becomes one
// finished sentence in payment-status-contract.js (the same copy-verbatim contract as the plan price and the balance, PR #5331), so a figure
// the AI writes in its own words is held. Never a technician note or a visit note. A read that fails is null, never a guess.

const logger = require('./logger');

// The service name a proposal line carries is "<name> — <n> applications/yr" (estimate-proposal.js): the cadence rides the sentence's own count.
const cleanLabel = (label) => String(label || '').replace(/\s+[\u2014\u2013-]\s+\d{1,2}\s+applications?\/yr\s*$/i, '').replace(/\s+/g, ' ').trim();

const parsedData = (estimate) => {
  const raw = estimate?.estimate_data;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
};

/**
 * True only when the customer's own estimate page would show this estimate, judged from the ESTIMATE ROW alone: not expired, not held off the
 * customer surface (a quarantine marker, an invalidated linkage, a pending reprice or an unverified address: estimateOffCustomerSurface), and
 * not an estimate whose visibility also depends on OTHER rows (a call-drafted estimate's call and lead, a new-home estimate's move: the public
 * routes' callSideBlockForEstimateData). Those can change with the estimate row untouched, so the send fingerprint (which hashes the estimate
 * row) could not see the change: they render no price here, and staff answer.
 */
function estimateOnCustomerSurface(estimate) {
  if (estimate.expires_at && new Date(estimate.expires_at).getTime() < Date.now()) return false;
  const data = parsedData(estimate);
  if (data?.estimatorEngine?.callLogId || data?.move?.moveId) return false;
  return !require('../utils/estimate-claim-sql').estimateOffCustomerSurface(estimate);
}

const toCents = (value) => {
  const n = Math.round(Number(value) * 100);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * What the open estimate lists per application, as { perApplication: [{ label, cents, applications }] }: the lines and the applications a
 * year of the per-application average model, the SAME model the estimate page and the delivery email read (estimate-monthly-average: it
 * reconciles each line against the stored plan total, so a line that does not add up is withheld). Only a price LISTED on the estimate, never
 * a total: the prepay invoice total, the setup fee and the one-time lines each have their own authority and stay with staff.
 * { perApplication: [] } when there is no estimate, it is not on the customer's own page (or depends on a call or move: see above), or it lists
 * none (a successful read of nothing); null when the read failed. Never throws.
 */
async function loadEstimateFacts(estimate, { db } = {}) {
  const none = { perApplication: [] };
  if (!estimate?.id) return none;
  if (!db) return null;
  try {
    if (!estimateOnCustomerSurface(estimate)) return none;
    const average = await require('./estimate-monthly-average').perApplicationAverageFor(estimate, { rethrow: true });
    const perApplication = [];
    for (const service of average?.model?.services || []) {
      const cents = toCents(service.perApplication);
      const applications = Math.round(Number(service.visits));
      if (cents && applications > 0 && cleanLabel(service.label)) perApplication.push({ label: cleanLabel(service.label), cents, applications });
    }
    return { perApplication };
  } catch (err) {
    logger.warn(`[sms-staff-facts] per-application price unavailable for estimate ${estimate.id}: ${err.message}`);
    return null;
  }
}

/**
 * The customer's prepaid recurring plans (prepaid-series.listCustomerPrepaidPlans, the same rollup the appointment screens show), as
 * { label, remaining, paid }. Left out, so a person answers: a series an ANNUAL prepay term covers or is linked to (its stamped visits are not
 * the term's funded entitlement: a replacement visit may not be stamped yet), a series carrying an independently prepaid BOOSTER (a visit with
 * no cadence that bills its own price: it is not a plan visit), and a series whose label another series shares (an exhausted series beside its
 * renewal, an annual-linked renewal included). null when the read failed; [] when there is none.
 */
async function loadPrepaidPlanFacts(customerId, { db } = {}) {
  if (!customerId || !db) return null;
  try {
    const series = require('./prepaid-series');
    const plans = await series.listCustomerPrepaidPlans(db, customerId);
    const rows = await db('scheduled_services')
      .where({ customer_id: customerId })
      .where((qb) => qb.whereNotNull('annual_prepay_term_id').orWhere('prepaid_method', series.ANNUAL_PREPAY_METHOD).orWhere('prepaid_amount', '>', 0))
      .select('id', 'recurring_parent_id', 'service_type', 'annual_prepay_term_id', 'prepaid_method', 'prepaid_amount', 'is_recurring', 'recurring_pattern');
    const annual = rows.filter((row) => series.hasAnnualCoverage(row));
    const boosters = rows.filter((row) => Number(row.prepaid_amount) > 0 && row.is_recurring === false && !row.recurring_pattern);
    const excluded = new Set([...annual, ...boosters].map((row) => String(series.resolveSeriesParentId(row))));
    const label = (value) => String(value || '').toLowerCase();
    const annualLabels = new Set(annual.map((row) => label(row.service_type)));
    const sameLabel = (plan) => plans.filter((other) => label(other.serviceType) === label(plan.serviceType)).length;
    return plans
      .filter((plan) => !excluded.has(String(plan.seriesParentId)) && !annualLabels.has(label(plan.serviceType)) && sameLabel(plan) === 1)
      .map((plan) => ({ label: String(plan.serviceType || ''), remaining: Number(plan.remainingVisits), paid: Number(plan.paidVisits) }))
      .filter((plan) => plan.label && Number.isInteger(plan.remaining) && Number.isInteger(plan.paid) && plan.paid > 0 && plan.remaining >= 0 && plan.remaining <= plan.paid);
  } catch (err) {
    logger.warn(`[sms-staff-facts] prepaid plans unavailable for customer ${customerId}: ${err.message}`);
    return null;
  }
}

module.exports = { loadEstimateFacts, loadPrepaidPlanFacts };
