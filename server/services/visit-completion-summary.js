'use strict';

const crypto = require('crypto');
const db = require('../models/db');
const VisitGroups = require('./visit-groups');
const { portalUrl } = require('../utils/portal-url');
const { getRecipientsForPurpose, getServiceReportEmailRecipients, withAccountPrimaryContact } = require('./customer-contact');

const VISIT_SUMMARY_TOKEN_RE = /^[a-f0-9]{64}$/;

/** Issue once. Creation gates never revoke an already issued customer link. */
async function ensureVisitSummaryToken(packetId, database = db) {
  const key = process.env.DATA_HYGIENE_VAULT_KEY;
  if (!key) throw new Error('Visit summary encryption key is unavailable');
  try {
    return await database.transaction(async (trx) => {
      const packet = await trx('visit_completion_packets').where({ id: packetId }).first();
      if (!packet || !['processing', 'done'].includes(packet.status)) throw new Error('Packet unavailable');
      const visit = await trx('service_visits').where({ id: packet.visit_id }).forUpdate().first();
      if (!visit || visit.summary_token_revoked_at || !['closing', 'closed'].includes(visit.status)) {
        throw new Error('Visit unavailable');
      }
      const pending = await trx('visit_completion_packet_items').where({ packet_id: packet.id })
        .whereNot('status', 'done').first('id');
      if (pending) throw new Error('Member reports are still pending');
      if (visit.summary_token_enc) {
        const result = await trx.raw('SELECT pgp_sym_decrypt(?, ?) AS token', [visit.summary_token_enc, key]);
        const token = result.rows[0].token;
        if (!VISIT_SUMMARY_TOKEN_RE.test(token)
            || crypto.createHash('sha256').update(token).digest('hex') !== visit.summary_token_hash) {
          throw new Error('Stored summary token does not match');
        }
        return token;
      }
      if (visit.summary_token_hash || visit.summary_token_issued_at) throw new Error('Incomplete token identity');
      const token = crypto.randomBytes(32).toString('hex');
      await trx('service_visits').where({ id: visit.id }).update({
        summary_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
        summary_token_enc: trx.raw('pgp_sym_encrypt(?, ?)', [token, key]),
        summary_token_issued_at: trx.fn.now(), updated_at: trx.fn.now(),
      });
      return token;
    });
  } catch {
    // Knex errors interpolate bindings. Never propagate the key, token,
    // ciphertext, original message or cause to route/worker logs.
    throw new Error('Visit summary link could not be prepared');
  }
}

/** Explicit customer projection. Notes, addresses and billing tokens stay out. */
async function getVisitCompletionSummary(token, database = db) {
  if (!VISIT_SUMMARY_TOKEN_RE.test(String(token || ''))) return null;
  const visit = await database('service_visits').where({
    summary_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
  }).whereNull('summary_token_revoked_at').whereNotNull('summary_token_issued_at')
    .whereIn('status', ['closing', 'closed']).first();
  if (!visit) return null;
  const packet = await database('visit_completion_packets').where({ visit_id: visit.id })
    .whereIn('status', ['processing', 'done']).first('id');
  if (!packet) return null;
  const items = await database('visit_completion_packet_items as i')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .where('i.packet_id', packet.id).orderBy('s.window_start').orderBy('s.id')
    .select('i.status', 'r.id', 'r.service_type', 'r.structured_notes', 'r.report_view_token',
      'r.customer_id', 'r.scheduled_service_id', 's.id as member_id', 's.visit_id');
  if (items.length < 2 || items.some((item) => item.status !== 'done'
      || item.customer_id !== visit.customer_id || item.visit_id !== visit.id
      || item.scheduled_service_id !== item.member_id)) return null;
  const visible = items.filter((item) => {
    const notes = typeof item.structured_notes === 'string' ? JSON.parse(item.structured_notes) : item.structured_notes;
    return !notes?.backfill && (!notes?.typedReportDelivery || notes.typedReportDelivery === 'auto_send');
  });
  if (!visible.length) return null;
  return {
    serviceDate: VisitGroups.dateOnly(visit.scheduled_date),
    services: visible.map((item) => {
      const notes = typeof item.structured_notes === 'string' ? JSON.parse(item.structured_notes) : item.structured_notes;
      return {
        id: item.id, serviceType: item.service_type,
        outcome: notes?.visitOutcome || 'completed',
        reportUrl: /^[a-f0-9]{32}$/.test(item.report_view_token || '')
          ? `/report/${item.report_view_token}` : null,
      };
    }),
  };
}

async function sendSummarySms({ visit, member, customer, prefs, summaryUrl, requested }) {
  const claim = await VisitGroups.claimVisitNotification(member, 'completion_sms');
  if (claim?.state !== 'owner') return;
  const recipient = getRecipientsForPurpose(customer, prefs, 'service_report', 'sms')[0];
  let dispatched = false;
  try {
    if (!requested || !recipient?.phone) {
      await VisitGroups.finalizeVisitNotification(visit.id, 'completion_sms', 'suppressed', new Date(), claim.token);
      return;
    }
    const result = await require('./messaging/send-customer-message').sendCustomerMessage({
      channel: 'sms', audience: 'customer', purpose: 'service_completion',
      to: recipient.phone, customerId: customer.id, appointmentId: member.id,
      body: `Waves Pest Control: Your visit summary is ready. Review each service and its report: ${summaryUrl}`,
      identityTrustLevel: 'service_contact_authorized', entryPoint: 'visit_closeout_summary',
      preDispatchCheck: async () => {
        dispatched = await VisitGroups.beginVisitNotificationDispatch(visit.id, 'completion_sms', claim.token);
        return { ok: dispatched, code: 'VISIT_SUMMARY_CLAIM_LOST' };
      },
    });
    // Once handed to a non-idempotent provider, an ambiguous result stays
    // unknown for office reconciliation. Never reclaim it after a timeout.
    if (!result.sent && !result.blocked && dispatched) return;
    const outcome = result.sent ? 'sent' : result.retryable ? 'retry' : 'suppressed';
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_sms', outcome, new Date(), claim.token);
  } catch {
    if (!dispatched) await VisitGroups.finalizeVisitNotification(visit.id, 'completion_sms', 'retry', new Date(), claim.token);
  }
}

async function sendSummaryEmail({ visit, member, customer, prefs, summaryUrl, visible }) {
  const claim = await VisitGroups.claimVisitNotification(member, 'completion_email');
  if (claim?.state !== 'owner') return;
  const recipients = visible ? getServiceReportEmailRecipients(customer, prefs) : [];
  let dispatched = false;
  let sent = false;
  try {
    for (const recipient of recipients) {
      const recipientKey = crypto.createHash('sha256').update(recipient.email.toLowerCase()).digest('hex').slice(0, 32);
      const result = await require('./email-template-library').sendTemplate({
        templateKey: 'service.visit_summary', to: recipient.email,
        payload: { first_name: recipient.name || 'there', summary_url: summaryUrl },
        recipientType: 'customer', recipientId: customer.id,
        idempotencyKey: `visit_summary:${visit.id}:${recipientKey}`,
        triggerEventId: `visit_summary:${visit.id}`,
        categories: ['service_visit_summary'], suppressionGroupKey: 'service_operational',
        suppressProviderErrorLog: true,
        onQueued: async () => {
          // The email library treats a thrown callback as advisory; return
          // false on failure so losing this claim always stops dispatch.
          try {
            const owned = await VisitGroups.beginVisitNotificationDispatch(visit.id, 'completion_email', claim.token);
            dispatched ||= owned;
            return owned;
          } catch { return false; }
        },
      });
      if (result.sent) sent = true;
      else if (!result.blocked) return;
    }
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_email', sent ? 'sent' : 'suppressed', new Date(), claim.token);
  } catch {
    if (!dispatched) await VisitGroups.finalizeVisitNotification(visit.id, 'completion_email', 'retry', new Date(), claim.token);
  }
}

async function deliverVisitCompletionSummary(packetId, token, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  const visit = await database('service_visits').where({ id: packet.visit_id }).first();
  const customer = await withAccountPrimaryContact(
    await database('customers').where({ id: visit.customer_id }).first(), { db: database },
  );
  const prefs = await database('notification_prefs').where({ customer_id: customer.id }).first() || {};
  const member = await database('scheduled_services').where({ visit_id: visit.id }).orderBy('id').first();
  const payload = typeof packet.payload === 'string' ? JSON.parse(packet.payload) : packet.payload;
  const visible = Boolean(await getVisitCompletionSummary(token, database));
  const context = { visit, member, customer, prefs, visible, summaryUrl: portalUrl(`/visit/${token}`),
    requested: visible && payload.items.some((item) => item.body.sendCompletionSms !== false) };
  await sendSummarySms(context);
  await sendSummaryEmail(context);
  const effects = await database('visit_effects').where({ visit_id: visit.id })
    .whereIn('effect_type', ['completion_sms', 'completion_email']);
  const unknown = effects.some((effect) => effect.status === 'unknown_delivery');
  const complete = effects.length === 2 && effects.every((effect) => ['sent', 'suppressed'].includes(effect.status));
  return { state: unknown ? 'delivery_review' : complete ? 'delivered' : 'delivery_pending' };
}

module.exports = { VISIT_SUMMARY_TOKEN_RE, ensureVisitSummaryToken, getVisitCompletionSummary, deliverVisitCompletionSummary };
