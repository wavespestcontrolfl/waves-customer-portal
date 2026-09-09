'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { parseETDateTime } = require('../utils/datetime-et');
const { normalizePhone, phoneMatchDigits } = require('../utils/phone');
const { isWithinSendWindowET, nextSendWindowOpenET } = require('./messaging/send-window');
const { lockTriageCall } = require('../utils/triage-locks');
const { recordAuditEvent } = require('./audit-log');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');

const KIND = 'send_reschedule_link';
const sendContext = new AsyncLocalStorage();
function mode() {
  const value = String(process.env.GATE_RESCHEDULE_LINK_ON_PROMISE || '').toLowerCase();
  return isEnabled('callCommitments') && ['shadow', 'true'].includes(value) ? value : 'off';
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dateOnly = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10);
const snapshot = (v) => ({ id: v.id, customer_id: v.customer_id, date: dateOnly(v.scheduled_date),
  start: String(v.window_start || '').slice(0, 5), end: String(v.window_end || '').slice(0, 5), property_id: v.property_id || null });

const sameVisitSnapshot = (a, b) => ['id', 'customer_id', 'date', 'start', 'end', 'property_id']
  .every((key) => (a[key] ?? null) === (b[key] ?? null));

function selectDiscussedVisit({ commitment, call, customer, candidates = [], now = new Date() }) {
  const skip = (reason) => ({ reason });
  if (!call?.customer_id || call.customer_id !== customer?.id || !normalizePhone(customer.phone)
    || !phoneMatchDigits(customer.phone).length
    || normalizePhone(customer.phone) !== normalizePhone(String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone)) return skip('customer_identity');
  if (call.v2_extraction_status !== 'valid' || call.ai_extraction_enriched?.meta?.is_spam
    || call.ai_extraction_enriched?.meta?.is_voicemail || call.processing_token) return skip('call_not_ready');
  const { speakerTurns } = require('./call-commitments');
  const turns = speakerTurns(call.transcription);
  const conditional = /\b(?:not|never|unless|if|until|once|maybe|might|cannot)\b|\b(?:don|won|can) t\b/;
  const revoked = (turns?.caller || []).some((turn) => /\b(?:don t|do not|no need|never mind)\b/.test(turn) && /\b(?:link|text|send|email)\b/.test(turn));
  const promised = (commitment.evidence || []).some((e) => e.speaker === 'agent' && turns?.agent.some((t) => t.includes(norm(e.quote)) && !conditional.test(t))
    && /\blink\b/.test(norm(e.quote)) && /\b(send|text|email|sending|texting)\b/.test(norm(e.quote))
    && /\b(?:i|we) (?:ll|will|am going to|are going to|am sending|m sending)\b|\blet me\b/.test(norm(e.quote)));
  if (revoked || !promised || !Number.isFinite(Number(commitment.confidence)) || Number(commitment.confidence) < 0.9) return skip('promise_needs_review');
  let selected = candidates;
  const subject = commitment.subject;
  if (subject && (!subject.quote || !norm(call.transcription).includes(norm(subject.quote))
    || [subject.service, subject.address].some((value) => value && !norm(subject.quote).includes(norm(value))))) return skip('subject_not_grounded');
  if (subject?.visit_date) {
    const { quoteBindsConfirmedSlot, normalizeCommitmentText } = require('./call-triage-flags');
    selected = selected.filter((v) => dateOnly(v.scheduled_date) === subject.visit_date
      && quoteBindsConfirmedSlot(normalizeCommitmentText(subject.quote), `${subject.visit_date}T${String(v.window_start || '').slice(0, 5)}`, call.created_at));
  }
  if (subject?.service) selected = selected.filter((v) => norm(v.service_type || v.service_name).includes(norm(subject.service)));
  if (subject?.address) selected = selected.filter((v) => require('./estimator-engine/address-compare').sameStreetAddress(
    [v.service_address_line1 || v.property_address, v.service_address_line2 || v.property_unit].filter(Boolean).join(' '),
    subject.address, { requireExactUnit: true }));
  if (selected.length !== 1) return skip(selected.length ? 'ambiguous_visit' : 'discussed_visit_unavailable');
  const visit = selected[0];
  if (!['pending', 'confirmed'].includes(visit.status) || !visit.reschedule_token || (visit.visit_id && visit.follow_through_group_eligible !== true)
    || (visit.status === 'pending' && !visit.customer_confirmed && DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(visit.source_action))) return skip('visit_not_self_service');
  const start = visit.window_start ? parseETDateTime(`${dateOnly(visit.scheduled_date)}T${String(visit.window_start).slice(0, 5)}`) : null;
  if (!start || !Number.isFinite(start.getTime()) || start.getTime() + 120 * 60000 <= now.getTime()) return skip('visit_elapsed');
  return { visit };
}

async function contextFor(conn, commitmentId, now) {
  const raw = await conn('call_commitments').where({ id: commitmentId, kind: KIND, party: 'waves' }).first();
  const commitment = raw ? require('./call-commitments').normalizeRow(raw) : null;
  if (!commitment?.call_log_id || commitment.status !== 'open' || commitment.human_state) return { reason: 'promise_closed' };
  const call = await conn('call_log').where({ id: commitment.call_log_id }).first();
  if (!call || (commitment.source === 'ai' && Number(commitment.last_seen_generation) !== Number(call.processing_generation))) return { reason: 'stale_extraction' };
  const customer = call.customer_id ? await conn('customers').where({ id: call.customer_id }).whereNull('deleted_at').first() : null;
  if (require('./internal-test-customers').isInternalTestCustomerId(customer?.id)) return { reason: 'internal_test_customer' };
  const candidates = customer ? await conn('scheduled_services as s').leftJoin('customer_properties as p', 'p.id', 's.property_id')
    .where('s.customer_id', customer.id).whereIn('s.status', ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'])
    .select('s.*', 'p.address_line1 as property_address', 'p.address_line2 as property_unit') : [];
  for (const candidate of candidates) {
    candidate.follow_through_group_eligible = await require('./reschedule-link').hasUnblockedVisitGroup(conn, candidate.visit_id);
  }
  return { commitment, call, customer, ...selectDiscussedVisit({ commitment, call, customer, candidates, now }) };
}

async function visitLinkNeedles(conn, visit) {
  const target = require('../utils/portal-url').portalUrl(`/reschedule/${visit.reschedule_token}`);
  const codes = await conn('short_codes').where({ kind: 'reschedule', entity_type: 'scheduled_services', entity_id: visit.id, target_url: target }).pluck('code');
  return [target, ...codes.map((code) => `${require('./short-url').baseUrl()}/l/${code}`)].map((url) => url.replace(/^https?:\/\//, ''));
}

function carriesVisitLink(body, needles) {
  return needles.some((needle) => new RegExp(`(?:^|[\\s<(\"'])(?:https?:\\/\\/)?${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s>),.!?;:#])`).test(String(body || '')));
}

async function matchingSend(conn, context, since) {
  if (!context.visit || !context.customer) return null;
  const needles = await visitLinkNeedles(conn, context.visit);
  const messages = await conn('sms_log').where({ customer_id: context.customer.id, direction: 'outbound' })
    .where('created_at', '>=', since).whereIn('status', ['queued', 'accepted', 'sending', 'sent', 'delivered', 'read'])
    .whereIn(conn.raw("regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g')"), phoneMatchDigits(context.customer.phone))
    .where(function carriesLink() { for (const needle of needles) this.orWhere('message_body', 'like', `%${needle}%`); })
    .orderBy('created_at', 'desc').limit(201).select('id', 'twilio_sid', 'status', 'created_at', 'customer_id', 'to_phone', 'message_body');
  if (messages.length > 200) throw new Error('Promised-link delivery evidence is truncated');
  return messages.find((sms) => carriesVisitLink(sms.message_body, needles)) || null;
}

async function parkReview(conn, row, reason) {
  await conn.transaction(async (trx) => {
    await lockTriageCall(trx, row.related_call_log_id);
    const changed = await trx('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
      .whereRaw("(status <> 'review' OR last_error IS DISTINCT FROM ?)", [reason])
      .update({ status: 'review', last_error: reason, updated_at: new Date() });
    if (!changed) return;
    const existing = await trx('triage_items').where({ call_log_id: row.related_call_log_id, reason_code: 'reschedule_link_promise' })
      .whereIn('status', ['open', 'in_progress']).first('id');
    if (!existing) await trx('triage_items').insert({ call_log_id: row.related_call_log_id, related_customer_id: row.related_customer_id,
      related_scheduled_service_id: row.related_scheduled_service_id, category: 'customer_followup', severity: 'advisory',
      reason_code: 'reschedule_link_promise', status: 'open', summary: 'A promised reschedule link needs attention.',
      payload: { reschedule_link_promise: { commitment_id: row.commitment_id, reason } } });
    await trx('call_log').where({ id: row.related_call_log_id }).update({ review_status: 'open', updated_at: new Date() });
    await recordAuditEvent({ actor_type: 'system', action: 'reschedule_link_needs_review', resource_type: 'call_commitment', resource_id: row.commitment_id,
      metadata: { reason, outbox_id: row.id }, critical: true, trx });
  });
}

async function settleDelivery(conn, row, sms, context = null) {
  const delivered = ['delivered', 'read'].includes(sms.status);
  return conn.transaction(async (trx) => {
    await lockTriageCall(trx, row.related_call_log_id);
    const call = await trx('call_log').where({ id: row.related_call_log_id }).forShare().first();
    const commitment = await trx('call_commitments').where({ id: row.commitment_id }).forUpdate().first();
    const current = await trx('outbox_messages').where({ id: row.id }).forUpdate().first();
    if (!current || !commitment || ['delivered', 'cancelled'].includes(current.status)) return null;
    const visitId = current.related_scheduled_service_id || context?.visit?.id;
    const generation = current.payload?.call_generation ?? context?.call?.processing_generation;
    const visit = visitId ? await trx('scheduled_services').where({ id: visitId }).first('customer_id') : null;
    const customer = call?.customer_id ? await trx('customers').where({ id: call.customer_id }).whereNull('deleted_at').first('phone') : null;
    const link = current.payload?.link;
    const identityMatches = !!customer && call.customer_id === current.related_customer_id
      && sms.customer_id === call.customer_id && visit?.customer_id === call.customer_id
      && normalizePhone(customer.phone) === normalizePhone(sms.to_phone)
      && normalizePhone(customer.phone) === normalizePhone(String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone)
      && Number(call.processing_generation) === Number(generation)
      && Number(commitment.last_seen_generation) === Number(generation)
      && (context?.visit?.id === visitId || (current.provider_message_id && current.provider_message_id === sms.twilio_sid) || (link && String(sms.message_body).includes(link.replace(/^https?:\/\//, ''))));
    if (!identityMatches) return { needsReview: true };
    await trx('outbox_messages').where({ id: row.id }).update({ status: delivered ? 'delivered' : (current.status === 'review' ? 'review' : 'sent'),
      ...(delivered ? { last_error: null } : {}),
      related_scheduled_service_id: visitId, provider_message_id: sms.twilio_sid, sent_at: sms.created_at,
      payload: { ...current.payload, call_generation: generation, visit_snapshot: current.payload?.visit_snapshot || (context?.visit ? snapshot(context.visit) : null) }, updated_at: new Date() });
    if (!delivered) return null;
    const updated = await trx('call_commitments').where({ id: row.commitment_id, status: 'open' }).whereNull('human_state')
      .update({ status: 'fulfilled', fulfilled_at: new Date(), updated_at: new Date(), fulfillment: {
        kind: 'reschedule_link_delivered', strength: 'direct', record_type: 'sms_log', record_id: sms.id,
        matched_at: new Date().toISOString(), basis: 'linked_visit_reschedule_link_delivered',
      } });
    if (updated) await recordAuditEvent({ actor_type: 'system', action: 'reschedule_link_delivered', resource_type: 'call_commitment', resource_id: row.commitment_id,
      metadata: { sms_log_id: sms.id, outbox_id: row.id }, critical: true, trx });
    // The provider recovered (or staff sent the exact link). Clear its
    // exception card without touching unrelated call flags.
    await trx('triage_items').where({ call_log_id: call.id, reason_code: 'reschedule_link_promise' }).whereIn('status', ['open', 'in_progress'])
      .whereRaw("payload->'reschedule_link_promise'->>'commitment_id' = ?", [row.commitment_id])
      .update({ status: 'resolved', resolution_source: 'auto', resolution_note: 'The promised link was delivered.', resolved_at: new Date(), updated_at: new Date() });
    const remaining = await trx('triage_items').where({ call_log_id: call.id }).whereIn('status', ['open', 'in_progress']).first('id');
    await trx('call_log').where({ id: call.id }).update({ review_status: remaining ? 'open' : 'resolved', updated_at: new Date() });
    return null;
  }).then((result) => result?.needsReview ? parkReview(conn, row, 'delivery_scope_changed') : result);
}

async function stagePromises(conn) {
  if (mode() === 'off') return 0;
  const rows = await conn('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
    .leftJoin('outbox_messages as o', 'o.commitment_id', 'cc.id').whereNull('o.id')
    .where({ 'cc.kind': KIND, 'cc.party': 'waves', 'cc.status': 'open' }).whereNull('cc.human_state')
    .select('cc.id', 'cc.call_log_id', 'cl.customer_id').limit(200);
  for (const row of rows) await conn('outbox_messages').insert({ channel: 'sms', status: mode() === 'shadow' ? 'shadow' : 'pending',
    payload: { kind: KIND }, commitment_id: row.id, related_call_log_id: row.call_log_id, related_customer_id: row.customer_id,
    available_at: new Date() }).onConflict('commitment_id').ignore();
  return rows.length;
}

async function runOne(conn, row, { now = new Date(), send = null, buildLink = null, render = null } = {}) {
  if (mode() === 'off') return;
  // Another sweep may have completed this item since it was listed.
  row = await conn('outbox_messages').where({ id: row.id }).first();
  if (!row || ['delivered', 'cancelled'].includes(row.status)) return;
  // Reconcile accepted/ambiguous attempts before planning any new send.
  if (row.provider_message_id) {
    const sms = await conn('sms_log').where({ twilio_sid: row.provider_message_id }).first('id', 'twilio_sid', 'status', 'created_at', 'customer_id', 'to_phone', 'message_body');
    if (sms && ['failed', 'undelivered'].includes(sms.status) && row.status !== 'review') return parkReview(conn, row, 'delivery_failed');
    if (sms && ['delivered', 'read'].includes(sms.status)) return settleDelivery(conn, row, sms);
    if (row.status !== 'review' && new Date(row.sent_at || row.last_attempt_at).getTime() + 24 * 3600000 < now.getTime()) return parkReview(conn, row, 'delivery_receipt_unavailable');
    if (sms && !['failed', 'undelivered'].includes(sms.status) && row.status !== 'review') return settleDelivery(conn, row, sms);
    if (row.status !== 'review') return conn('outbox_messages').where({ id: row.id }).update({ updated_at: now });
  }
  const context = await contextFor(conn, row.commitment_id, now);
  if (context.reason) {
    if (context.reason === 'promise_closed') return conn('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
      .update({ status: 'cancelled', updated_at: now });
    if (mode() === 'shadow') return conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow'])
      .update({ status: 'shadow', last_error: context.reason, updated_at: now });
    return parkReview(conn, row, context.reason);
  }
  const { commitment, call, customer, visit } = context;
  const prior = await matchingSend(conn, context, call.created_at);
  if (prior) return settleDelivery(conn, row, prior, context);
  if (row.status === 'review') return conn('outbox_messages').where({ id: row.id }).update({ updated_at: now });
  if (row.status === 'sending') {
    if (new Date(row.last_attempt_at).getTime() + 20 * 60000 <= now.getTime()) return parkReview(conn, row, 'provider_outcome_unknown');
    return;
  }
  const planned = snapshot(visit);
  if (row.payload.visit_snapshot && !sameVisitSnapshot(row.payload.visit_snapshot, planned)) return parkReview(conn, row, 'appointment_changed');
  if (mode() === 'shadow') {
    await conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow']).update({ status: 'shadow', last_error: null,
      related_scheduled_service_id: visit.id, payload: { ...row.payload, call_generation: call.processing_generation, visit_snapshot: planned, would_send_at: (isWithinSendWindowET(now) ? now : nextSendWindowOpenET(now)).toISOString() }, updated_at: now });
    return;
  }
  if (!isWithinSendWindowET(now)) return conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow']).update({ status: 'pending',
    related_scheduled_service_id: visit.id, payload: { ...row.payload, call_generation: call.processing_generation, visit_snapshot: planned }, available_at: nextSendWindowOpenET(now), updated_at: now });
  const link = await (buildLink || require('./reschedule-link').buildRescheduleLink)(visit.id, { customerId: customer.id });
  if (!link?.url) return parkReview(conn, row, 'link_unavailable');
  const body = await (render || require('../routes/admin-sms-templates').getTemplate)('reschedule_link_promise', {
    first: customer.first_name || 'there', link: link.url,
  }, { customerId: customer.id }, { noVariants: true, requiredVars: ['link'] });
  if (!body) return parkReview(conn, row, 'template_unavailable');
  // A committed claim survives process death. Unknown provider outcomes are
  // reconciled from delivery evidence or parked, never blindly resent.
  const claimed = await conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow'])
    .update({ status: 'sending', attempts: conn.raw('attempts + 1'), last_attempt_at: now, updated_at: now,
      related_scheduled_service_id: visit.id, payload: { ...row.payload, call_generation: call.processing_generation, visit_snapshot: planned, link: link.url } });
  if (!claimed) return;
  row.related_scheduled_service_id = visit.id;
  let manual = null;
  const check = async () => {
    if (mode() !== 'true') return { ok: false, code: 'LINK_GATE_OFF', reason: 'Reschedule link automation is off' };
    if (!isWithinSendWindowET()) return { ok: false, code: 'LINK_QUIET_HOURS', reason: 'Waiting for the next send window' };
    const live = await contextFor(conn, commitment.id, new Date());
    if (live.reason || !sameVisitSnapshot(snapshot(live.visit), planned)) return { ok: false, code: 'LINK_SOURCE_CHANGED', reason: 'The discussed visit changed' };
    manual = await matchingSend(conn, live, call.created_at);
    return manual ? { ok: false, code: 'LINK_ALREADY_SENT', reason: 'The link was already sent' } : { ok: true };
  };
  try {
    const result = await (send || require('./messaging/send-customer-message').sendCustomerMessage)({
      to: customer.phone, body, channel: 'sms', audience: 'customer', purpose: 'appointment', customerId: customer.id,
      appointmentId: visit.id, entryPoint: 'reschedule-link-promise', identityTrustLevel: 'phone_matches_customer',
      metadata: { original_message_type: 'reschedule_link_promise', followThroughCommitmentId: commitment.id, outbox_id: row.id },
      preDispatchCheck: check, preProviderCheck: check,
    });
    if (manual) return settleDelivery(conn, row, manual, context);
    if (result.sent && /^SM[0-9a-f]{32}$/i.test(result.providerMessageId || '')) {
      await conn('outbox_messages').where({ id: row.id, status: 'sending' }).update({ status: 'sent',
        provider_message_id: result.providerMessageId, sent_at: new Date(), updated_at: new Date() });
      return;
    }
    if (result.blocked && ['LINK_QUIET_HOURS', 'QUIET_HOURS_HOLD', 'LINK_GATE_OFF'].includes(result.code)) return conn('outbox_messages').where({ id: row.id, status: 'sending' })
      .update({ status: 'pending', available_at: nextSendWindowOpenET(new Date()), last_error: result.code, updated_at: new Date() });
    return parkReview(conn, row, result.code || 'provider_outcome_unknown');
  } catch {
    return parkReview(conn, row, 'provider_outcome_unknown');
  }
}

async function sweep(conn = db, options = {}) {
  if (mode() === 'off') return { processed: 0 };
  await stagePromises(conn);
  const rows = await conn('outbox_messages').whereNotNull('commitment_id').whereIn('status', ['pending', 'shadow', 'sending', 'sent', 'review'])
    .where(function due() { this.whereNull('available_at').orWhere('available_at', '<=', options.now || new Date()); }).orderBy('updated_at').limit(100);
  for (const row of rows) await runOne(conn, row, options);
  return { processed: rows.length, mode: mode() };
}

// The automatic promise send and manual Comms send serialize for this
// customer. A manual message already underway wins; the automated final
// check sees its receipt. An overlapping manual duplicate is held visibly.
async function withSendLock(input, sendCore) {
  const automatic = !!input?.metadata?.followThroughCommitmentId;
  const manual = input?.operatorInitiated === true || input?.metadata?.humanAuthored === true || !!input?.metadata?.adminUserId;
  if (mode() !== 'true' || !input?.customerId || (!automatic && !manual)
    || sendContext.getStore()?.customerId === input.customerId) return sendCore(input);
  const started = new Date();
  // This session holds only the advisory interlock. The provider pipeline
  // needs the normal pool for consent/audit; holding a pool transaction
  // here deadlocks two simultaneous sends when that pool has two slots.
  const connection = await db.client.acquireRawConnection();
  try {
    await connection.query("SET statement_timeout = '10s'");
    await connection.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', ['reschedule-link-send', String(input.customerId)]);
    if (manual && !automatic) {
      const active = await db('outbox_messages').where({ related_customer_id: input.customerId }).whereNotNull('commitment_id')
        .whereIn('status', ['sending', 'sent', 'delivered']).select('status', 'sent_at', 'related_scheduled_service_id');
      for (const row of active) {
        if (row.status !== 'sending' && new Date(row.sent_at) < started) continue;
        const visit = await db('scheduled_services').where({ id: row.related_scheduled_service_id, customer_id: input.customerId }).first('id', 'reschedule_token');
        if (visit && carriesVisitLink(input.body, await visitLinkNeedles(db, visit))) return { sent: false, blocked: true,
          code: 'PROMISED_LINK_IN_PROGRESS', reason: 'The promised link is already being sent. Refresh the conversation before sending it again.' };
      }
    }
    const lockedInput = { ...input, preProviderCheck: async (args) => {
      const verdict = typeof input.preProviderCheck === 'function' ? await input.preProviderCheck(args) : { ok: true };
      if (connection.__knex__disposed) return { ok: false, code: 'LINK_LOCK_LOST', reason: 'The send interlock was lost. Refresh before retrying.' };
      return verdict;
    } };
    return await sendContext.run({ customerId: input.customerId }, () => sendCore(lockedInput));
  } finally {
    await db.client.destroyRawConnection(connection).catch((err) => {
      require('./logger').warn(`[reschedule-link-promises] send interlock close failed (${err.code || err.name || 'error'})`);
    });
  }
}

async function resolveUsedLink(conn, visitId) {
  const rows = await conn('outbox_messages').where({ related_scheduled_service_id: visitId }).whereNotNull('commitment_id')
    .whereIn('status', ['sent', 'delivered']).select('related_call_log_id');
  for (const row of rows) await require('./triage-auto-resolve').resolveRescheduleCards(conn, row.related_call_log_id, 'Customer chose a new time using the promised reschedule link.');
}

module.exports = { mode, selectDiscussedVisit, snapshot, stagePromises, runOne, sweep, withSendLock, resolveUsedLink };
