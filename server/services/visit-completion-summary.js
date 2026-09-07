'use strict';

const crypto = require('crypto');
const db = require('../models/db');
const VisitGroups = require('./visit-groups');
const { portalUrl } = require('../utils/portal-url');
const { getServiceContactSmsRecipient, getServiceReportEmailRecipients, withAccountPrimaryContact } = require('./customer-contact');

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
      if (!visit || !['closing', 'closed'].includes(visit.status)) {
        throw new Error('Visit unavailable');
      }
      if (visit.summary_token_revoked_at) return null;
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

// Queue ownership and the visit marker commit together. Packet recovery then
// waits on this row; only the existing scheduled-SMS worker dispatches it.
async function deferSummarySms({ visit, customer, recipient, body, claim, nextAllowedAt }) {
  await db.transaction(async (trx) => {
    const owned = await trx('visit_effects').where({ visit_id: visit.id, effect_type: 'completion_sms',
      claim_token: claim.token }).whereIn('status', ['claimed', 'unknown_delivery'])
      .update({ status: 'pending', scheduled_at: new Date(nextAllowedAt), updated_at: trx.fn.now() });
    if (!owned) return;
    await trx('sms_log').insert({ customer_id: customer.id, direction: 'outbound',
      from_phone: require('../config/twilio-numbers').getOutboundNumber(), to_phone: recipient.phone,
      message_body: body, message_type: 'visit_summary', status: 'scheduled', scheduled_for: new Date(nextAllowedAt),
      metadata: JSON.stringify({ entry_point: 'visit_summary_deferred', visit_id: visit.id,
        visit_summary_claim_token: claim.token, summary_token_hash: visit.summary_token_hash,
        customer_id: customer.id, to_phone: recipient.phone, resolve_from_by_customer: true }),
    });
  });
}

// A frozen bearer-link recipient must still be authorized when the queue runs.
async function recheckDeferredSummarySms(meta) {
  const visit = await db('service_visits').where({ id: meta.visit_id, customer_id: meta.customer_id,
    summary_token_hash: meta.summary_token_hash }).whereNull('summary_token_revoked_at')
    .whereIn('status', ['closing', 'closed']).first('id');
  if (!visit) return { eligible: false, reason: 'visit_summary_unavailable' };
  const customer = await withAccountPrimaryContact(await db('customers').where({ id: meta.customer_id }).first());
  const recipient = getServiceContactSmsRecipient(customer);
  if (!recipient.phone || recipient.phone !== meta.to_phone) return { eligible: false, reason: 'visit_summary_recipient_changed' };
  const effect = await db('visit_effects').where({ visit_id: visit.id, effect_type: 'completion_sms',
    claim_token: meta.visit_summary_claim_token }).first();
  // A late provider-boundary quiet-hours block proves no send occurred.
  // Its durable scheduler stamp allows exactly that handoff to be retried.
  if (effect?.status === 'unknown_delivery' && meta.quiet_hours_hold_at
    && new Date(meta.quiet_hours_hold_at) >= new Date(effect.claimed_at)) {
    await db('visit_effects').where({ id: effect.id, status: 'unknown_delivery', claimed_at: effect.claimed_at,
      claim_token: meta.visit_summary_claim_token }).update({ status: 'pending', updated_at: db.fn.now() });
    effect.status = 'pending';
  }
  return { eligible: effect?.status === 'pending', reason: 'visit_summary_claim_unavailable' };
}

async function beginDeferredSummarySms(meta) {
  if (!(await recheckDeferredSummarySms(meta)).eligible) return { ok: false, code: 'VISIT_SUMMARY_CLAIM_LOST' };
  const owned = await VisitGroups.beginVisitNotificationDispatch(meta.visit_id, 'completion_sms',
    meta.visit_summary_claim_token, { scheduled: true });
  return { ok: owned, code: 'VISIT_SUMMARY_CLAIM_LOST' };
}

async function finalizeDeferredSummarySms(meta) {
  return VisitGroups.finalizeVisitNotification(meta.visit_id, 'completion_sms', 'sent', new Date(), meta.visit_summary_claim_token);
}

async function terminalDeferredSummarySms(meta) {
  const effect = await db('visit_effects').where({ visit_id: meta.visit_id, effect_type: 'completion_sms',
    claim_token: meta.visit_summary_claim_token }).first('status');
  if (!effect || ['sent', 'suppressed'].includes(effect.status)) return;
  const result = await VisitGroups.finalizeVisitNotification(meta.visit_id, 'completion_sms',
    effect.status === 'unknown_delivery' ? 'unknown_delivery' : 'suppressed', new Date(), meta.visit_summary_claim_token);
  if (!result.ok) throw new Error('Visit summary terminal state could not be saved');
}

async function sendSummarySms({ visit, member, customer, summaryUrl, requested }) {
  const claim = await VisitGroups.claimVisitNotification(member, 'completion_sms');
  if (claim?.state !== 'owner') return;
  const recipient = getServiceContactSmsRecipient(customer);
  let dispatched = false;
  try {
    if (!requested || !recipient?.phone) {
      await VisitGroups.finalizeVisitNotification(visit.id, 'completion_sms', 'suppressed', new Date(), claim.token);
      return;
    }
    const body = `Waves Pest Control: Your visit summary is ready. Review each service and its report: ${summaryUrl}`;
    const result = await require('./messaging/send-customer-message').sendCustomerMessage({
      channel: 'sms', audience: 'customer', purpose: 'service_completion',
      to: recipient.phone, customerId: customer.id, appointmentId: member.id,
      body,
      identityTrustLevel: 'service_contact_authorized', entryPoint: 'visit_closeout_summary',
      preDispatchCheck: async () => {
        dispatched = await VisitGroups.beginVisitNotificationDispatch(visit.id, 'completion_sms', claim.token);
        return { ok: dispatched, code: 'VISIT_SUMMARY_CLAIM_LOST' };
      },
    });
    if (result.code === 'QUIET_HOURS_HOLD' && result.deferred && result.nextAllowedAt) {
      dispatched = false; // The provider boundary can also prove it held before sending.
      await deferSummarySms({ visit, customer, recipient, body, claim, nextAllowedAt: result.nextAllowedAt });
      return;
    }
    // Once handed to a non-idempotent provider, an ambiguous result stays
    // unknown for office reconciliation. Never reclaim it after a timeout.
    if (!result.sent && !result.blocked && dispatched) {
      await VisitGroups.finalizeVisitNotification(visit.id, 'completion_sms', 'unknown_delivery', new Date(), claim.token);
      return;
    }
    const retryable = result.retryable || result.code === 'CONSENT_LOOKUP_FAILED';
    const outcome = result.sent ? 'sent' : retryable ? 'retry' : 'suppressed';
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_sms', outcome, new Date(), claim.token);
  } catch {
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_sms', dispatched ? 'unknown_delivery' : 'retry', new Date(), claim.token);
  }
}

// The template library saves each recipient before provider handoff. Only an
// absent row or its explicit pre-dispatch abort proves another send is safe.
function summaryEmailState(message) {
  if (!message) return 'retry';
  if (['sent', 'delivered', 'opened', 'clicked'].includes(message.status)) return 'sent';
  if (message.status === 'blocked') return 'suppressed';
  if (message.status === 'failed' && !message.sent_at && !message.provider_message_id
    && message.error_message === require('./email-template-library').ABORTED_BEFORE_DISPATCH) return 'retry';
  return 'unknown_delivery';
}

async function sendSummaryEmail({ visit, member, customer, prefs, summaryUrl, visible, database }) {
  const claim = await VisitGroups.claimVisitNotification(member, 'completion_email');
  if (claim?.state !== 'owner') return;
  const recipients = visible ? getServiceReportEmailRecipients(customer, prefs) : [];
  try {
    const messages = await database('email_messages').where({
      trigger_event_id: `visit_summary:${visit.id}`, template_key: 'service.visit_summary', recipient_id: customer.id,
    }).select('idempotency_key', 'status', 'sent_at', 'provider_message_id', 'error_message');
    const previous = new Map(messages.map((message) => [message.idempotency_key, message]));
    const states = messages.map(summaryEmailState);
    let sent = states.includes('sent');
    let unknown = states.includes('unknown_delivery');
    let pending = false;
    for (const recipient of recipients) {
      const recipientKey = crypto.createHash('sha256').update(recipient.email.toLowerCase()).digest('hex').slice(0, 32);
      const idempotencyKey = `visit_summary:${visit.id}:${recipientKey}`;
      if (summaryEmailState(previous.get(idempotencyKey)) !== 'retry') continue;
      let dispatched = false;
      try {
        const result = await require('./email-template-library').sendTemplate({
          templateKey: 'service.visit_summary', to: recipient.email,
          payload: { first_name: recipient.name || 'there', summary_url: summaryUrl },
          recipientType: 'customer', recipientId: customer.id, idempotencyKey,
          triggerEventId: `visit_summary:${visit.id}`,
          categories: ['service_visit_summary'], suppressionGroupKey: 'service_operational',
          suppressProviderErrorLog: true,
          onQueued: async () => {
            // A stale aggregate owner cannot hand off a later recipient after
            // recovery has claimed the visit. A thrown callback is advisory in
            // the library, so convert it to an explicit dispatch refusal.
            try {
              dispatched = await VisitGroups.beginVisitNotificationDispatch(visit.id, 'completion_email', claim.token);
              return dispatched;
            } catch { return false; }
          },
        });
        if (result.sent) { sent = true; continue; }
        if (result.blocked) continue;
        unknown ||= dispatched;
        pending ||= !dispatched;
      } catch {
        if (dispatched) unknown = true;
        else pending = true;
      }
    }
    // Finish proven-unsent recipients before surfacing an earlier uncertain
    // recipient. Its durable email row is always skipped on a later retry.
    const outcome = pending ? 'retry' : unknown ? 'unknown_delivery' : sent ? 'sent' : 'suppressed';
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_email', outcome, new Date(), claim.token);
  } catch {
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_email', 'retry', new Date(), claim.token);
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
  const summary = await getVisitCompletionSummary(token, database);
  const visibleMembers = await database('visit_completion_packet_items').where({ packet_id: packet.id })
    .whereIn('service_record_id', (summary?.services || []).map((service) => service.id)).pluck('scheduled_service_id');
  const context = { visit, member, customer, prefs, database, visible: Boolean(summary), summaryUrl: token ? portalUrl(`/visit/${token}`) : null,
    requested: payload.items.some((item) => visibleMembers.includes(item.serviceId) && item.body.sendCompletionSms === true) };
  await sendSummarySms(context);
  await sendSummaryEmail(context);
  const effects = await database('visit_effects').where({ visit_id: visit.id })
    .whereIn('effect_type', ['completion_sms', 'completion_email']);
  // Keep the packet on recovery while either channel has proven-unsent work
  // or a live provider handoff, even if the other channel needs office review.
  const unknown = effects.some((effect) => effect.status === 'unknown_delivery'
    && (effect.last_error === 'provider_outcome_unknown'
      || new Date(effect.claimed_at).getTime() <= Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS));
  const pending = effects.length !== 2 || effects.some((effect) => !['sent', 'suppressed', 'unknown_delivery'].includes(effect.status)
    || (effect.status === 'unknown_delivery' && effect.last_error !== 'provider_outcome_unknown'
      && new Date(effect.claimed_at).getTime() > Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS));
  return { state: pending ? 'delivery_pending' : unknown ? 'delivery_review' : 'delivered' };
}

module.exports = { VISIT_SUMMARY_TOKEN_RE, ensureVisitSummaryToken, getVisitCompletionSummary, deliverVisitCompletionSummary,
  recheckDeferredSummarySms, beginDeferredSummarySms, finalizeDeferredSummarySms, terminalDeferredSummarySms };
