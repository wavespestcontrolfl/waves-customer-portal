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

// The kind label alone never proves the promised link MOVES this
// appointment — "I'll text you a link" fits a website or a new-booking link
// just as well, and an account with one eligible visit would then be sent a
// live reschedule link for a conversation that never asked for one (codex
// #4293 r1 P1). Either the promise quote itself speaks about moving an
// existing appointment, or the commitment carries a grounded subject that
// names the visit; anything else is office-review work.
const RESCHEDULE_INTENT = /\breschedul\w*\b|\bre schedul\w*\b|\b(?:move|moving|change|changing|switch|switching|push|pushing|pick|picking|choose|choosing|select|selecting)\b[a-z0-9 ]{0,40}\b(?:time|times|day|days|date|dates|slot|slots|window|appointment|appt|visit|service)\b|\b(?:new|another|different|better) (?:time|day|date|slot|window)\b/;

function selectDiscussedVisit({ commitment, call, customer, candidates = [], now = new Date() }) {
  const skip = (reason) => ({ reason });
  if (!call?.customer_id || call.customer_id !== customer?.id || !normalizePhone(customer.phone)
    || !phoneMatchDigits(customer.phone).length
    || normalizePhone(customer.phone) !== normalizePhone(String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone)) return skip('customer_identity');
  // /reschedule/:token refuses a non-active account (accountInactive), so a
  // link promising a cancelled customer a new time is a dead end — hold the
  // same explicit `active === true` the page requires (codex #4293 r1 P1).
  if (customer.active !== true) return skip('customer_inactive');
  if (call.v2_extraction_status !== 'valid' || call.ai_extraction_enriched?.meta?.is_spam
    || call.ai_extraction_enriched?.meta?.is_voicemail || call.processing_token) return skip('call_not_ready');
  const { speakerTurns } = require('./call-commitments');
  const turns = speakerTurns(call.transcription);
  const conditional = /\b(?:not|never|unless|if|until|once|maybe|might|cannot)\b|\b(?:don|won|can) t\b/;
  const revoked = (turns?.caller || []).some((turn) => /\b(?:don t|do not|no need|never mind)\b/.test(turn) && /\b(?:link|text|send|email)\b/.test(turn));
  const promisedQuotes = (commitment.evidence || []).filter((e) => e.speaker === 'agent' && turns?.agent.some((t) => t.includes(norm(e.quote)) && !conditional.test(t))
    && /\blink\b/.test(norm(e.quote)) && /\b(send|text|email|sending|texting)\b/.test(norm(e.quote))
    && /\b(?:i|we) (?:ll|will|am going to|are going to|am sending|m sending)\b|\blet me\b/.test(norm(e.quote))).map((e) => norm(e.quote));
  const subject = commitment.subject;
  if (subject && (!subject.quote || !norm(call.transcription).includes(norm(subject.quote))
    || [subject.service, subject.address].some((value) => value && !norm(subject.quote).includes(norm(value))))) return skip('subject_not_grounded');
  // A subject is grounded only when it NAMES the visit — a bare quote with no
  // date/service/address binds nothing, so it cannot stand in for
  // rescheduling language.
  const groundedSubject = !!subject && [subject.visit_date, subject.service, subject.address].some(Boolean);
  const aboutThisAppointment = groundedSubject || promisedQuotes.some((quote) => RESCHEDULE_INTENT.test(quote));
  if (revoked || !promisedQuotes.length || !aboutThisAppointment
    || !Number.isFinite(Number(commitment.confidence)) || Number(commitment.confidence) < 0.9) return skip('promise_needs_review');
  let selected = candidates;
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

// An attempt that already reached the provider OWNS the row until its
// outcome is known: delivery settles it, a failure or a receipt that never
// arrives parks it for the office, and an accepted-but-undecided send waits
// for the next sweep. Returns false when the row is still the worker's to
// plan. Never resends — the claim is what survives process death.
async function reconcileAttempt(conn, row, now) {
  const sms = await conn('sms_log').where({ twilio_sid: row.provider_message_id })
    .first('id', 'twilio_sid', 'status', 'created_at', 'customer_id', 'to_phone', 'message_body');
  const failed = sms && ['failed', 'undelivered'].includes(sms.status);
  const unparked = row.status !== 'review';
  if (failed && unparked) await parkReview(conn, row, 'delivery_failed');
  else if (sms && ['delivered', 'read'].includes(sms.status)) await settleDelivery(conn, row, sms);
  else if (unparked && new Date(row.sent_at || row.last_attempt_at).getTime() + 24 * 3600000 < now.getTime()) await parkReview(conn, row, 'delivery_receipt_unavailable');
  else if (sms && !failed && unparked) await settleDelivery(conn, row, sms);
  else if (unparked) await conn('outbox_messages').where({ id: row.id }).update({ updated_at: now });
  else return false;
  return true;
}

// The promise is no longer sendable: a closed promise cancels the row, shadow
// mode records the reason without touching the customer, and live mode hands
// the promise to the office.
async function applyContextSkip(conn, row, reason, now) {
  if (reason === 'promise_closed') return conn('outbox_messages').where({ id: row.id }).whereNotIn('status', ['delivered', 'cancelled'])
    .update({ status: 'cancelled', updated_at: now });
  if (mode() === 'shadow') return conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow'])
    .update({ status: 'shadow', last_error: reason, updated_at: now });
  return parkReview(conn, row, reason);
}

// The one customer handoff: render, claim, hand to the central send pipeline
// with a final source recheck at both the dispatch and provider boundaries,
// then record what the provider said. Anything unknown parks.
async function dispatch(conn, row, context, { now, send, buildLink, render, planned, evidenceSince }) {
  const { commitment, call, customer, visit } = context;
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
    manual = await matchingSend(conn, live, evidenceSince);
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
      return conn('outbox_messages').where({ id: row.id, status: 'sending' }).update({ status: 'sent',
        provider_message_id: result.providerMessageId, sent_at: new Date(), updated_at: new Date() });
    }
    if (result.blocked && ['LINK_QUIET_HOURS', 'QUIET_HOURS_HOLD', 'LINK_GATE_OFF'].includes(result.code)) return conn('outbox_messages').where({ id: row.id, status: 'sending' })
      .update({ status: 'pending', available_at: nextSendWindowOpenET(new Date()), last_error: result.code, updated_at: new Date() });
    return parkReview(conn, row, result.code || 'provider_outcome_unknown');
  } catch {
    return parkReview(conn, row, 'provider_outcome_unknown');
  }
}

// Every reason this promise does NOT hand off to the customer on this pass:
// the office already owns it, an in-flight claim has not timed out, the
// discussed visit changed under the plan, shadow mode only records, or the
// send window is closed. Returns true when the row is settled for now.
async function holdBeforeSend(conn, row, context, planned, now) {
  const { call, visit } = context;
  const plan = { ...row.payload, call_generation: call.processing_generation, visit_snapshot: planned };
  if (row.status === 'review') {
    await conn('outbox_messages').where({ id: row.id }).update({ updated_at: now });
    return true;
  }
  if (row.status === 'sending') {
    if (new Date(row.last_attempt_at).getTime() + 20 * 60000 <= now.getTime()) await parkReview(conn, row, 'provider_outcome_unknown');
    return true;
  }
  if (row.payload.visit_snapshot && !sameVisitSnapshot(row.payload.visit_snapshot, planned)) {
    await parkReview(conn, row, 'appointment_changed');
    return true;
  }
  if (mode() === 'shadow') {
    await conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow']).update({ status: 'shadow', last_error: null,
      related_scheduled_service_id: visit.id, payload: { ...plan, would_send_at: (isWithinSendWindowET(now) ? now : nextSendWindowOpenET(now)).toISOString() }, updated_at: now });
    return true;
  }
  if (!isWithinSendWindowET(now)) {
    await conn('outbox_messages').where({ id: row.id }).whereIn('status', ['pending', 'shadow']).update({ status: 'pending',
      related_scheduled_service_id: visit.id, payload: plan, available_at: nextSendWindowOpenET(now), updated_at: now });
    return true;
  }
  return false;
}

async function runOne(conn, row, { now = new Date(), send = null, buildLink = null, render = null } = {}) {
  if (mode() === 'off') return;
  // Another sweep may have completed this item since it was listed.
  row = await conn('outbox_messages').where({ id: row.id }).first();
  if (!row || ['delivered', 'cancelled'].includes(row.status)) return;
  // Reconcile accepted/ambiguous attempts before planning any new send.
  if (row.provider_message_id && await reconcileAttempt(conn, row, now)) return;
  const context = await contextFor(conn, row.commitment_id, now);
  if (context.reason) return applyContextSkip(conn, row, context.reason, now);
  const { call, visit } = context;
  // Evidence starts at the END of the call: an exact link sent while the
  // caller was still on the line cannot keep a promise made later in that
  // same call — the boundary the commitment ledger already uses (codex
  // #4293 r1 P2).
  const evidenceSince = require('./call-commitments').callEndedAt(call) || call.created_at;
  const prior = await matchingSend(conn, context, evidenceSince);
  if (prior) return settleDelivery(conn, row, prior, context);
  const planned = snapshot(visit);
  if (await holdBeforeSend(conn, row, context, planned, now)) return;
  return dispatch(conn, row, context, { now, send, buildLink, render, planned, evidenceSince });
}

async function sweep(conn = db, options = {}) {
  if (mode() === 'off') return { processed: 0 };
  await stagePromises(conn);
  const rows = await conn('outbox_messages').whereNotNull('commitment_id').whereIn('status', ['pending', 'shadow', 'sending', 'sent', 'review'])
    .where(function due() { this.whereNull('available_at').orWhere('available_at', '<=', options.now || new Date()); }).orderBy('updated_at').limit(100);
  for (const row of rows) await runOne(conn, row, options);
  const reconciled = await reconcileUsedLinks(conn);
  return { processed: rows.length, reconciled, mode: mode() };
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

const USED_LINK_NOTE = 'Customer chose a new time using the promised reschedule link.';
// The mover stamps every /reschedule/:token commit with this initiator — the
// durable proof that the customer, not the office, moved the visit.
const SELF_SERVE_INITIATOR = 'customer_self_serve';
const SETTLED_STATUSES = ['sent', 'delivered'];

// At-most-once per promise row: the stamp is what makes the reconciliation
// safe to retry from anywhere.
async function markLinkUsed(conn, row) {
  await require('./triage-auto-resolve').resolveRescheduleCards(conn, row.related_call_log_id, USED_LINK_NOTE, row.related_scheduled_service_id);
  await conn('outbox_messages').where({ id: row.id })
    .update({ payload: conn.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ link_used_reconciled_at: new Date().toISOString() })]), updated_at: new Date() });
}

function unreconciledPromiseRows(conn) {
  return conn('outbox_messages').whereNotNull('commitment_id').whereIn('status', SETTLED_STATUSES)
    .whereNotNull('related_scheduled_service_id').whereNotNull('related_call_log_id')
    .whereRaw("(payload->>'link_used_reconciled_at') IS NULL");
}

async function resolveUsedLink(conn, visitId) {
  const rows = await unreconciledPromiseRows(conn).where({ related_scheduled_service_id: visitId })
    .select('id', 'related_call_log_id', 'related_scheduled_service_id');
  for (const row of rows) await markLinkUsed(conn, row);
}

// The post-commit hook in reschedule-public is best-effort: a transient DB
// failure or a process death after the move commits would otherwise leave the
// linked triage cards open forever, because a delivered row has left the
// worker sweep and a client retry returns from the idempotent-replay branch
// (codex #4293 r1 P2). This re-derives the same verdict from the mover's own
// reschedule_log row, so the reconciliation is retried until it lands.
async function reconcileUsedLinks(conn) {
  const rows = await unreconciledPromiseRows(conn).orderBy('updated_at')
    .limit(100).select('id', 'related_call_log_id', 'related_scheduled_service_id', 'sent_at');
  let reconciled = 0;
  for (const row of rows) {
    const used = await conn('reschedule_log')
      .where({ scheduled_service_id: row.related_scheduled_service_id, initiated_by: SELF_SERVE_INITIATOR })
      .modify((q) => { if (row.sent_at) q.where('created_at', '>=', row.sent_at); })
      .first('id');
    if (!used) continue;
    await markLinkUsed(conn, row);
    reconciled += 1;
  }
  return reconciled;
}

module.exports = { mode, selectDiscussedVisit, snapshot, stagePromises, runOne, sweep, withSendLock, resolveUsedLink, reconcileUsedLinks };
