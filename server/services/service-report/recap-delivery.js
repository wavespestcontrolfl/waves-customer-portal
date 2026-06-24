// Sends the "Your Visit, in Motion" recap to the customer once the tech approves
// it. Keyed on the scheduled-service id (same as the rest of the recap lane). The
// link is a token-gated public player (no auth). Idempotent via an atomic sent_at
// claim, skips suppressed/internal typed reports, and best-effort — a send failure
// never breaks the approve flow (the claim is released so a retry can re-send).
const db = require('../../models/db');
const logger = require('../logger');
const { publicPortalUrl } = require('../../utils/portal-url');
const { sendCustomerMessage } = require('../messaging/send-customer-message');
const { ensureReportToken } = require('./pdf-queue');

// Mirror of reports-public.suppressedTypedReport: internal_only / disabled typed
// completions must not receive a customer link (the public report 404s for them).
function suppressedTypedReport(structuredNotes) {
  let notes = structuredNotes;
  if (typeof notes === 'string') { try { notes = JSON.parse(notes); } catch { notes = null; } }
  const mode = notes && typeof notes === 'object' ? notes.typedReportDelivery : null;
  return Boolean(mode) && mode !== 'auto_send';
}

async function sendRecap(scheduledServiceId, { knex = db } = {}) {
  const recap = await knex('service_recaps').where({ scheduled_service_id: scheduledServiceId }).first().catch(() => null);
  if (!recap) return { ok: false, reason: 'no_recap' };
  if (recap.status !== 'approved') return { ok: false, reason: `not_approved (${recap.status})` };
  if (recap.sent_at) return { ok: false, reason: 'already_sent' };

  const service = await knex('service_records')
    .where({ scheduled_service_id: scheduledServiceId })
    .leftJoin('customers', 'service_records.customer_id', 'customers.id')
    .orderBy('service_records.created_at', 'desc')
    .select(
      'service_records.id',
      'service_records.customer_id',
      'service_records.report_view_token',
      'service_records.structured_notes',
      'customers.first_name',
      'customers.phone',
    )
    .first();
  if (!service) return { ok: false, reason: 'no_service' };
  if (suppressedTypedReport(service.structured_notes)) return { ok: false, reason: 'suppressed_report' };
  if (!service.phone) return { ok: false, reason: 'no_phone' };

  const token = service.report_view_token || await ensureReportToken(service.id, knex);
  if (!token) return { ok: false, reason: 'no_token' };

  // Atomic claim — only one approval wins the send (idempotent vs double-click /
  // concurrent retries). Released below if the provider call fails.
  const claimed = await knex('service_recaps').where({ id: recap.id }).whereNull('sent_at')
    .update({ sent_at: knex.fn.now(), updated_at: knex.fn.now() });
  if (!claimed) return { ok: false, reason: 'already_sent' };

  const releaseClaim = () => knex('service_recaps').where({ id: recap.id })
    .update({ sent_at: null, updated_at: knex.fn.now() }).catch(() => {});

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
      metadata: { original_message_type: 'visit_recap', service_record_id: service.id },
    });
  } catch (err) {
    await releaseClaim();
    logger.warn(`[recap-delivery] send threw for scheduled service ${scheduledServiceId}: ${err.message}`);
    return { ok: false, reason: err.message };
  }

  if (msg && msg.ok === false) {
    await releaseClaim();
    return { ok: false, reason: msg.reason || 'send_blocked' };
  }
  return { ok: true, url };
}

module.exports = { sendRecap };
