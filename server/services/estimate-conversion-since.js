/**
 * Lead-side and phone-evidence conversion checks for estimates that carry no
 * customer_id. Used by the estimate engagement engine
 * (services/estimate-engagement-engine.js) before it sends a follow-up email.
 *
 * customerConvertedSince(est) (estimate-conversion-guard.js) short-circuits to
 * false when the estimate has no customer_id, but conversion marks the lead
 * won or creates the customer WITHOUT backfilling the estimate. These two
 * helpers cover that gap. Moved out of the removed click-followup gate.
 *
 * Both fail CLOSED: a lookup error returns { converted: true,
 * reason: 'guard-error' } so the caller retries instead of sending.
 */

const db = require('../models/db');
const logger = require('./logger');
const {
  customerConvertedSince,
  NON_LIVE_APPOINTMENT_STATUSES,
} = require('./estimate-conversion-guard');

function last10(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

// Lead-side conversion for lead-only estimates. Evidence, in order: the
// lead's own conversion stamp / terminal 'won' status, else the linked
// customer (leads.customer_id) run through the same guard.
async function leadConvertedSince(leadId, est) {
  if (!leadId) return { converted: false };
  try {
    const lead = await db('leads')
      .where({ id: leadId })
      .first('id', 'status', 'customer_id', 'converted_at');
    if (!lead) return { converted: false };
    if (lead.converted_at || lead.status === 'won') {
      return { converted: true, reason: lead.converted_at ? 'lead-converted' : 'lead-won' };
    }
    if (lead.customer_id) {
      return await customerConvertedSince({
        id: est.id,
        customer_id: lead.customer_id,
        created_at: est.created_at,
      });
    }
    return { converted: false };
  } catch (e) {
    logger.warn(`[estimate-conversion-since] lead conversion check failed — failing closed: ${e.message}`);
    return { converted: true, reason: 'guard-error' };
  }
}

// Phone-evidence conversion — a customers row created after `sinceTs`, or a
// live scheduled_services booking created after it whose customer matches the
// contact's last-10 phone, counts as converted. Deliberately biased to
// suppress: a false-positive phone match (shared household number) costs one
// nudge; emailing someone who already booked costs trust.
async function phoneConvertedSince(phone, sinceTs) {
  const ten = last10(phone);
  if (!ten) return { converted: false };
  const since = sinceTs ? new Date(sinceTs) : null;
  if (!since || Number.isNaN(since.getTime())) return { converted: false };
  try {
    const cust = await db('customers')
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
      .where('created_at', '>=', since)
      .first('id');
    if (cust) return { converted: true, reason: 'phone-customer-created' };

    const booked = await db('scheduled_services as ss')
      .join('customers as c', 'ss.customer_id', 'c.id')
      .whereNotIn('ss.status', NON_LIVE_APPOINTMENT_STATUSES)
      .where('ss.created_at', '>=', since)
      .whereRaw("RIGHT(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
      .first('ss.id');
    if (booked) return { converted: true, reason: 'phone-booking' };

    return { converted: false };
  } catch (e) {
    logger.warn(`[estimate-conversion-since] phone conversion check failed — failing closed: ${e.message}`);
    return { converted: true, reason: 'guard-error' };
  }
}

module.exports = { leadConvertedSince, phoneConvertedSince };
