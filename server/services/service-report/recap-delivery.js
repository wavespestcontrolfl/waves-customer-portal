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

  // Durable, recoverable claim: mark the send IN-FLIGHT (send_attempt_at), NOT sent_at.
  // sent_at is set only once the provider confirms, so a crash mid-send leaves the recap
  // retryable (sent_at stays null) instead of stuck "sent". Only one approval wins, and a
  // stale in-flight marker (process died) is re-claimable after the window.
  const SEND_STALE_MS = 5 * 60 * 1000;
  const staleBefore = new Date(Date.now() - SEND_STALE_MS);
  const claimed = await knex('service_recaps').where({ id: recap.id })
    .whereNull('sent_at')
    .andWhere((b) => b.whereNull('send_attempt_at').orWhere('send_attempt_at', '<', staleBefore))
    .update({ send_attempt_at: knex.fn.now(), updated_at: knex.fn.now() });
  if (!claimed) return { ok: false, reason: 'already_sent' };

  const releaseClaim = () => knex('service_recaps').where({ id: recap.id })
    .update({ send_attempt_at: null, updated_at: knex.fn.now() }).catch(() => {});

  // The standalone /recap player was retired 2026-07-09 — link the service
  // report, anchored at the embedded RecapVideoCard (#visit-recap). Old
  // /recap/:token links keep working via a client-side redirect to the same.
  const url = `${publicPortalUrl()}/report/${token}#visit-recap`;
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

  // sendCustomerMessage signals success only as { sent: true }; holds/failures
  // return { sent: false, blocked|code, reason } and validation errors { ok: false }.
  if (!msg || msg.sent !== true) {
    await releaseClaim();
    return { ok: false, reason: msg?.reason || msg?.code || 'send_failed' };
  }
  // Confirmed sent — stamp sent_at and clear the in-flight marker. The SMS already went
  // out, so we still return ok (reporting failure here would trigger a resend); but we
  // must NOT swallow a stamp failure: until sent_at lands, the stale in-flight marker
  // could let a retry re-send the same SMS, so surface it loudly for reconciliation.
  try {
    await knex('service_recaps').where({ id: recap.id })
      .update({ sent_at: knex.fn.now(), send_attempt_at: null, updated_at: knex.fn.now() });
  } catch (stampErr) {
    logger.error(`[recap-delivery] CRITICAL: recap SMS sent for ${scheduledServiceId} but sent_at stamp failed (${stampErr.message}) — sent_at left NULL risks a duplicate send on retry; needs manual reconciliation`);
  }
  return { ok: true, url };
}

module.exports = { sendRecap };
