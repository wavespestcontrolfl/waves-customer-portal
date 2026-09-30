/**
 * Lead / estimate linkage for email_messages (migration 20260930010000).
 *
 * resolveEmailLinks() is called once, from the single send chokepoint
 * (email-template-library.js sendTemplate), and returns the two provenance
 * columns for the row it is about to write:
 *
 *   estimate_id  the estimate the mail was about: the caller's explicit
 *                estimateId / estimateIds / linkEstimateId, else the payload's
 *                own estimate_id (the automation executor's estimate events).
 *   lead_id      the lead the mail went to: recipient_id when the send is lead-typed AND that id is a
 *                real leads row (the executor's estimate events name the
 *                CUSTOMER id in a lead-typed row, which is not a lead), else
 *                the lead that owns the estimate (leads.estimate_id).
 *
 * Purely additive and fail-open: recipient_type / recipient_id are never
 * changed, a lookup error is logged (no address, no SQL) and yields whatever
 * was already known, and a send is never blocked or delayed by linkage. Test
 * sends and customer-typed sends do no lead lookup at all.
 *
 * WHO SEES IT: the customer Activity timeline
 * (customer-activity-timeline.js) reads these columns behind
 * GATE_LEAD_EMAIL_LINKS, joining through leads.customer_id and
 * estimates.customer_id at read time, so mail sent to a prospect is on the
 * customer's page the moment they convert, whichever address they used.
 */
const db = require('../models/db');
const logger = require('./logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return UUID_RE.test(s) ? s.toLowerCase() : null;
}

function firstUuid(...candidates) {
  for (const c of candidates) {
    const id = uuidOrNull(c);
    if (id) return id;
  }
  return null;
}

async function resolveEmailLinks({
  recipientType = null,
  recipientId = null,
  estimateId = null,
  estimateIds = null,
  linkEstimateId = null,
  payload = null,
  test = false,
} = {}, dbh = db) {
  const out = { lead_id: null, estimate_id: null };
  if (test) return out;

  out.estimate_id = firstUuid(
    estimateId,
    Array.isArray(estimateIds) ? estimateIds[0] : null,
    linkEstimateId,
    payload && typeof payload === 'object' ? payload.estimate_id : null,
  );

  // A customer-typed send is already owned by recipient_id; nothing to look up.
  const type = String(recipientType || '').toLowerCase();
  if (type === 'customer') return out;

  try {
    const candidate = firstUuid(type === 'lead' ? recipientId : null);
    if (candidate) {
      const lead = await dbh('leads').where({ id: candidate }).first('id');
      if (lead) out.lead_id = lead.id;
    }
    if (!out.lead_id && out.estimate_id) {
      const lead = await dbh('leads').where({ estimate_id: out.estimate_id }).whereNull('deleted_at')
        .orderBy('created_at', 'desc').first('id');
      if (lead) out.lead_id = lead.id;
    }
  } catch (err) {
    logger.warn(`[email-lead-links] lead lookup failed (code ${err?.code || 'n/a'}); recording the estimate link only`);
  }
  return out;
}

module.exports = { resolveEmailLinks, uuidOrNull };
