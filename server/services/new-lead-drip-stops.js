/**
 * Stops for the new_lead drip's later steps (GATE_NEW_LEAD_DRIP_STEPS, owner 2026-11-24).
 *
 * Step 0 of new_lead goes out at once. Steps 1 (a price email, 48 hours later) and 2 (a one-question email, 72 hours after
 * step 1) are read at delivery, once, just before the send; each ends the enrollment with nothing sent when the lead has
 * since moved on to a person at the office or another sequence:
 *   1. an estimate exists, made since the enrollment or linked to the enrolling lead at any time (the estimate follow-up
 *      sequence takes over),
 *   2. a visit is booked (any scheduled service that is not cancelled, rescheduled, skipped or a no-show),
 *   3. the lead is a paying customer (a paid invoice, a customer pipeline stage) or the lead row is converted,
 *   4. the enrolling lead row is closed (not an open status), removed or missing,
 *   5. the lead is a commercial inquiry (the price email is residential),
 *   6. the address unsubscribed through the portal's newsletter unsubscribe page,
 *   7. the lead replied by text or email since the enrollment (the engine's two reply arms, estimate-follow-up.hasRepliedSince).
 * The existing suppression and email-off checks run before this in automation-runner.js.
 *
 * Any doubt defers, never sends: a failed read returns { defer: true } and the runner leaves the step due for a later tick.
 * The reply stop is silent on purpose. An inbound text or email already rings the office when it arrives (the SMS and email
 * reply alerts), so this module raises no alert of its own. Only the error code or name is logged (a knex message carries
 * phone numbers and addresses).
 */

const db = require('../models/db');
const logger = require('./logger');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { NON_LIVE_APPOINTMENT_STATUSES } = require('./estimate-conversion-guard');
const { isOpenLeadRow } = require('./lead-statuses');

// The two steps migration 20261124140000_new_lead_drip_steps seeds (and 20261124140100 stores disabled), by their fixed ids (the migrations carry the same ids).
// Only these exist for the runner while GATE_NEW_LEAD_DRIP_STEPS is on (automation-runner.js enabledSequenceSteps), and only
// these get the stops below: a step the owner adds to new_lead in Admin by hand is neither hidden by the gate nor stopped by it.
const NEW_LEAD_DRIP_STEP_IDS = Object.freeze(['c215d7f2-8052-47ac-94ac-e5c049ed2ca2', '04ca91c9-8bcf-49f2-95a3-5b6c3a359602']);
// Extended new_lead drip steps 3 (Day 10) & 4 (Day 21) seeded by migration 20261128031000_new_lead_drip_extended_steps
// (stored enabled=false; loaded ONLY while GATE_NEW_LEAD_DRIP_EXTENDED is on, guarded by the exact same 7 stop rules).
const NEW_LEAD_EXTENDED_STEP_IDS = Object.freeze(['6f4b2c10-9e3a-4b18-8c2d-7a1e5f903401', '8d9c4e21-3f5b-4a29-9d3e-1b2c6a804502']);

const isGateControlledNewLeadStepId = (id) => (
  NEW_LEAD_DRIP_STEP_IDS.includes(String(id)) || NEW_LEAD_EXTENDED_STEP_IDS.includes(String(id))
);

const isNewLeadDripStep = (templateKey, step) => templateKey === 'new_lead' && isGateControlledNewLeadStepId(step?.id);

function enrollmentMeta(enrollment) {
  const raw = enrollment.metadata;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// An estimate made OR SENT for this person since the enrollment: by customer id, or by the address the sequence mails. A draft
// made before the enrollment and sent after it counts (the lead webhook can make a draft without linking it to the lead).
async function estimateSince(enrollment, email) {
  if (!enrollment.customer_id && !email) return false;
  const row = await db('estimates')
    .where((when) => when.where('created_at', '>=', enrollment.enrolled_at).orWhere('sent_at', '>=', enrollment.enrolled_at))
    .where((who) => {
      if (enrollment.customer_id) who.orWhere('customer_id', enrollment.customer_id);
      if (email) who.orWhereRaw('lower(trim(customer_email)) = ?', [email]);
    })
    .first('id');
  return !!row;
}

// An estimate linked to the enrolling lead, whenever it was made: the website quote flow can publish the estimate before the
// lead is enrolled (or a double opt-in can delay the enrollment), so the creation-time cutoff above would miss a lead who already
// has an exact price. Linkage as estimate-lead-linkage.js reads it: leads.estimate_id, or the mirror estimate_data.lead_id.
async function leadHasEstimate(leadId, lead) {
  if (!leadId) return false;
  if (lead?.estimate_id) return true;
  const mirrored = await db('estimates').whereRaw("estimate_data->>'lead_id' = ?", [String(leadId)]).first('id');
  return !!mirrored;
}

async function visitBooked(customerId) {
  if (!customerId) return false;
  const row = await db('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', NON_LIVE_APPOINTMENT_STATUSES)
    .first('id');
  return !!row;
}

async function isPayingCustomer(customerId, lead) {
  if (customerId) {
    const paid = await db('invoices').where({ customer_id: customerId, status: 'paid' }).first('id');
    if (paid) return true;
    const customer = await db('customers').where({ id: customerId }).first('pipeline_stage');
    if (customer && CUSTOMER_STAGES.includes(customer.pipeline_stage)) return true;
  }
  return !!lead?.converted_at;
}

// The portal's own newsletter unsubscribe (public-newsletter.js) sets newsletter_subscribers.status. new_lead goes out under the
// newsletter unsubscribe group, so a lead who unsubscribed there after the first email gets no more of the drip.
// Checked for the enrollment's address AND the address the step is actually delivered to (a contact who turned email off reroutes it).
async function newsletterUnsubscribed(emails) {
  if (!emails.length) return false;
  const row = await db('newsletter_subscribers').whereRaw('lower(email) = ANY(?)', [emails]).where({ status: 'unsubscribed' }).first('id');
  return !!row;
}

// The engine's reply arms read an estimate-shaped row (customer id, phone, email). The phone is the customer's on file, else the
// enrolling lead's (the lead webhook can enroll a lead with no customer id; its texts are found by phone alone).
async function repliedSince(enrollment, email, lead) {
  const customer = enrollment.customer_id
    ? await db('customers').where({ id: enrollment.customer_id }).first('phone')
    : null;
  const asker = { id: enrollment.id, customer_id: enrollment.customer_id || null, customer_phone: customer?.phone || lead?.phone || null, customer_email: email };
  return require('./estimate-follow-up').hasRepliedSince(asker, new Date(enrollment.enrolled_at), { throwOnError: true });
}

// The stops, in the order they are read. Each one reads what it needs from { who, email, emails, leadId, lead }.
const leadGone = ({ leadId, lead }) => !!leadId && (!lead || !!lead.deleted_at || !isOpenLeadRow(lead));
const STOPS = [
  { cancelReason: 'new_lead_estimate', reason: 'The lead has an estimate since enrolling',
    hit: async (c) => await estimateSince(c.who, c.email) || leadHasEstimate(c.leadId, c.lead) },
  { cancelReason: 'new_lead_booked', reason: 'The lead has a booked visit', hit: (c) => visitBooked(c.who.customer_id) },
  { cancelReason: 'new_lead_customer', reason: 'The lead is a customer', hit: (c) => isPayingCustomer(c.who.customer_id, c.lead) },
  // The price email states a residential price and residential terms: a commercial inquiry waits for an office quote.
  { cancelReason: 'new_lead_commercial', reason: 'The lead is a commercial inquiry', hit: ({ lead }) => lead?.is_commercial === true },
  // The office closed, marked spam or lost, or removed the enrolling lead (or the row is gone): no more emails.
  { cancelReason: 'new_lead_lead_closed', reason: 'The enrolling lead is closed or removed', hit: leadGone },
  { cancelReason: 'new_lead_unsubscribed', reason: 'The lead unsubscribed from the newsletter', hit: (c) => newsletterUnsubscribed(c.emails) },
  { cancelReason: 'new_lead_replied', reason: 'The lead replied since enrolling', hit: (c) => repliedSince(c.who, c.email, c.lead) },
];

/**
 * @returns {Promise<null | { reason: string, cancelReason: string } | { defer: true, reason: string }>}
 *   null = no stop, send. A stop ends the enrollment. defer = read failed or enrollment time unreadable, try again later.
 */
async function newLeadDripStop(enrollment, recipient = null) {
  const enrolledMs = enrollment.enrolled_at ? new Date(enrollment.enrolled_at).getTime() : NaN;
  if (!Number.isFinite(enrolledMs)) return { defer: true, reason: 'The new lead enrollment time is unreadable; email deferred' };
  const leadId = enrollmentMeta(enrollment).lead_id || null;
  try {
    const lead = leadId ? (await db('leads').where({ id: leadId }).first('phone', 'converted_at', 'estimate_id', 'customer_id', 'status', 'deleted_at', 'is_commercial')) || null : null;
    // The lead webhook can enroll a lead with no customer id, and booking an assessment later links the lead to a customer
    // without converting it: the lead's current customer id stands in for the enrollment's missing one in every read.
    const context = {
      leadId,
      lead,
      email: String(enrollment.email || '').trim().toLowerCase(),
      emails: [...new Set([enrollment.email, recipient].map((a) => String(a || '').trim().toLowerCase()).filter(Boolean))],
      who: { ...enrollment, customer_id: enrollment.customer_id || lead?.customer_id || null },
    };
    for (const stop of STOPS) {
      if (await stop.hit(context)) return { reason: stop.reason, cancelReason: stop.cancelReason };
    }
    return null;
  } catch (e) {
    logger.warn(`[new-lead-drip] stop check failed for enrollment ${enrollment.id}: ${(e && (e.code || e.name)) || 'error'}`);
    return { defer: true, reason: 'The new lead stop check failed; email deferred' };
  }
}

module.exports = { newLeadDripStop, isNewLeadDripStep, isGateControlledNewLeadStepId, NEW_LEAD_DRIP_STEP_IDS, NEW_LEAD_EXTENDED_STEP_IDS };
