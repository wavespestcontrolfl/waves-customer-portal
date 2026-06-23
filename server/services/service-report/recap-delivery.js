// Sends the "Your Visit, in Motion" recap to the customer once the tech approves
// it. Token-gated public player link (no auth), SMS via the shared messaging
// contract. Idempotent (guards on sent_at) and best-effort — a send failure never
// breaks the approve flow; the owner can re-approve to retry.
const db = require('../../models/db');
const logger = require('../logger');
const { publicPortalUrl } = require('../../utils/portal-url');
const { sendCustomerMessage } = require('../messaging/send-customer-message');
const { ensureReportToken } = require('./pdf-queue');

async function sendRecap(serviceRecordId, { knex = db } = {}) {
  const recap = await knex('service_recaps').where({ service_record_id: serviceRecordId }).first().catch(() => null);
  if (!recap) return { ok: false, reason: 'no_recap' };
  if (recap.status !== 'approved') return { ok: false, reason: `not_approved (${recap.status})` };
  if (recap.sent_at) return { ok: false, reason: 'already_sent' };

  const service = await knex('service_records')
    .where({ 'service_records.id': serviceRecordId })
    .leftJoin('customers', 'service_records.customer_id', 'customers.id')
    .select(
      'service_records.id',
      'service_records.customer_id',
      'service_records.report_view_token',
      'customers.first_name',
      'customers.phone',
    )
    .first();
  if (!service) return { ok: false, reason: 'no_service' };
  if (!service.phone) return { ok: false, reason: 'no_phone' };

  const token = service.report_view_token || await ensureReportToken(serviceRecordId, knex);
  if (!token) return { ok: false, reason: 'no_token' };

  const url = `${publicPortalUrl()}/recap/${token}`;
  const first = String(service.first_name || '').trim().split(/\s+/)[0] || 'there';
  const body = `Hi ${first} — here's a quick 30-second recap of today's visit: ${url}`;

  let msg;
  try {
    msg = await sendCustomerMessage({
      to: service.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'service_completion',
      customerId: service.customer_id,
      identityTrustLevel: 'admin_operator',
      metadata: { original_message_type: 'visit_recap', service_record_id: serviceRecordId },
    });
  } catch (err) {
    logger.warn(`[recap-delivery] send threw for service ${serviceRecordId}: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  if (msg && msg.ok === false) return { ok: false, reason: msg.reason || 'send_blocked' };

  await knex('service_recaps').where({ id: recap.id }).update({ sent_at: new Date(), updated_at: new Date() });
  return { ok: true, url };
}

module.exports = { sendRecap };
