'use strict';

const crypto = require('crypto');
const db = require('../models/db');
const VisitGroups = require('./visit-groups');
const { portalUrl } = require('../utils/portal-url');
const { getServiceContactSmsRecipient, getServiceReportEmailRecipients, withAccountPrimaryContact } = require('./customer-contact');
const { createDefaultCustomerRows } = require('./customer-default-rows');

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

/** Members a customer may see: never a backfill, only an auto_send report posture. */
function publishableSummaryItems(items) {
  return items.filter((item) => {
    const notes = typeof item.structured_notes === 'string' ? JSON.parse(item.structured_notes) : item.structured_notes;
    return !notes?.backfill && (!notes?.typedReportDelivery || notes.typedReportDelivery === 'auto_send');
  });
}

/** An internal-only packet has no customer summary: no link is minted for it. */
async function packetHasPublishableSummary(packetId, database = db) {
  const items = await database('visit_completion_packet_items as i')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .where('i.packet_id', packetId).select('r.structured_notes');
  return publishableSummaryItems(items).length > 0;
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
  // The packet's own membership is the floor: a visit that retained
  // cancelled or skipped members can close with one recorded service.
  if (!items.length || items.some((item) => item.status !== 'done'
      || item.customer_id !== visit.customer_id || item.visit_id !== visit.id
      || item.scheduled_service_id !== item.member_id)) return null;
  const visible = publishableSummaryItems(items);
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

// A frozen bearer-link recipient must still be authorized when the queue
// runs: the visit and its link are live and the recipient still resolves to
// the frozen number. The locked handoff passes the customer it holds (with
// its held account primary); the worker's earlier recheck resolves it fresh.
async function deferredSummaryRecipient(meta, database = db, { customer: heldCustomer = null } = {}) {
  const visit = await database('service_visits').where({ id: meta.visit_id, customer_id: meta.customer_id,
    summary_token_hash: meta.summary_token_hash }).whereNull('summary_token_revoked_at')
    .whereIn('status', ['closing', 'closed'])
    .modify((query) => { if (database.isTransaction) query.forShare(); }).first('id');
  if (!visit) return { eligible: false, reason: 'visit_summary_unavailable' };
  // An unreadable account primary is a failed read (the registry keeps the
  // replay retryable), never a recipient that changed.
  const customer = heldCustomer || await withAccountPrimaryContact(await database('customers').where({ id: meta.customer_id }).first(),
    { db: database, rethrow: true, forShare: Boolean(database.isTransaction) });
  const recipient = getServiceContactSmsRecipient(customer);
  if (!recipient.phone || recipient.phone !== meta.to_phone) return { eligible: false, reason: 'visit_summary_recipient_changed' };
  return { eligible: true, visit };
}

// The recipient check plus the claim state the replay needs to dispatch.
async function recheckDeferredSummarySms(meta, database = db, options = {}) {
  const current = await deferredSummaryRecipient(meta, database, options);
  if (!current.eligible) return current;
  const { visit } = current;
  const effect = await database('visit_effects').where({ visit_id: visit.id, effect_type: 'completion_sms',
    claim_token: meta.visit_summary_claim_token }).first();
  // Only a late provider-boundary quiet-hours block proves no send occurred:
  // its durable scheduler stamp allows exactly that handoff to be retried.
  // Every provider failure after the handoff — a timeout, a 5xx, a 429 — is
  // ambiguous (the provider may hold the text) and stays on office review,
  // the same rule the tech line and the admin composer apply.
  const provenUnsentAt = meta.quiet_hours_hold_at
    && new Date(meta.quiet_hours_hold_at) >= new Date(effect?.claimed_at || 0) ? meta.quiet_hours_hold_at : null;
  if (effect?.status === 'unknown_delivery' && provenUnsentAt) {
    await database('visit_effects').where({ id: effect.id, status: 'unknown_delivery', claimed_at: effect.claimed_at,
      claim_token: meta.visit_summary_claim_token }).update({ status: 'pending', updated_at: database.fn.now() });
    effect.status = 'pending';
  }
  return { eligible: effect?.status === 'pending', reason: 'visit_summary_claim_unavailable' };
}

// Recipient authorization, the dispatch claim and the provider request share
// one transaction while the customer and preference rows are held, so a
// contact or preference edit after recipient resolution waits for the
// handoff to commit instead of handing the bearer link to the former
// destination. `authorized` re-resolves the recipient from the locked rows;
// `dispatch(trx)` is the sender's locked handoff and returns its verdict.
// Two transactions on one connection each, never nested (a small pool must
// not be pinned by a send waiting on a second slot). The first holds the
// rows, authorizes the recipient and commits the dispatch mark, so the mark
// is durable before any provider request: a process that dies mid-request
// leaves an uncertain effect, never a reclaimable one. The second holds the
// same rows again, re-authorizes the recipient on them and runs the provider
// request while they stay held. A refusal by the sender's own rechecks
// before the request returns the mark to its pre-dispatch state. `dispatch`
// receives (trx, onProviderStart) and calls onProviderStart immediately
// before its provider request: a throw before that signal (a failed recheck
// on the held connection) is provably unsent and restores the claim, while a
// throw after it is the provider outcome and propagates with the mark in place.
async function claimDispatchThroughHandoff({ visitId, customerId, kind, token, scheduled = false, phone = null, authorized, dispatch }) {
  const lost = { ok: false, code: 'VISIT_SUMMARY_CLAIM_LOST' };
  const holdAndAuthorize = async (trx, phase) => {
    // An SMS leg takes the canonical per-phone consent lock first, in the
    // order the STOP / suppression writers take it, so an opt-out that
    // commits during the request serializes behind the handoff.
    if (phone) await require('../utils/customer-comms-lock').lockSmsPhone(trx, phone);
    await trx('customers').where({ id: customerId }).forShare().first('id');
    // FOR SHARE cannot lock an absent row. The canonical seed serializes
    // missing-row creation without inventing marketing consent or replacing
    // an existing opt-out; hold the resulting row through the handoff.
    await createDefaultCustomerRows(trx, customerId);
    const prefs = await trx('notification_prefs').where({ customer_id: customerId }).forShare().first();
    // A secondary profile's blank contact fields fall back to the account
    // primary: that row is held too, and an unreadable primary is a failed
    // claim read, not a silently different recipient.
    const customer = await withAccountPrimaryContact(await trx('customers').where({ id: customerId }).first(),
      { db: trx, forShare: true, rethrow: true });
    // The visit row is held too: a revocation or status change after the
    // mark committed serializes behind the provider request instead of
    // racing it.
    const live = await trx('service_visits').where({ id: visitId }).whereNull('summary_token_revoked_at')
      .whereIn('status', ['closing', 'closed']).forShare().first('id');
    if (!live) return false;
    return authorized(customer, prefs, trx, phase);
  };
  const marked = await db.transaction(async (trx) => ((await holdAndAuthorize(trx, 'claim'))
    ? VisitGroups.beginVisitNotificationDispatch(visitId, kind, token, { scheduled, database: trx }) : false));
  if (!marked) return lost;
  // Nothing reached the provider: the mark returns to its pre-dispatch state
  // so the same claim can retry. If this write fails the effect stays
  // uncertain and reaches office review, which is the safe side.
  const unmark = () => db('visit_effects').where({ visit_id: visitId, effect_type: kind, claim_token: token, status: 'unknown_delivery' })
    .update({ status: scheduled ? 'pending' : 'claimed', claimed_at: new Date(), updated_at: db.fn.now() })
    .catch(() => {});
  let dispatching = false;
  let verdict;
  try {
    verdict = await db.transaction(async (trx) => {
      if (!(await holdAndAuthorize(trx, 'dispatch'))) return lost;
      return dispatch(trx, () => { dispatching = true; });
    });
  } catch (err) {
    // A failed read before the provider request is not a provider outcome.
    if (!dispatching) await unmark();
    throw err;
  }
  if (verdict?.ok === true) return verdict;
  await unmark();
  return verdict || lost;
}

// The deferred replay's recheck (visit, recipient, claim state), its dispatch
// claim and the provider request share the same held rows.
async function beginDeferredSummarySms(meta, dispatch) {
  return claimDispatchThroughHandoff({ visitId: meta.visit_id, customerId: meta.customer_id, kind: 'completion_sms',
    token: meta.visit_summary_claim_token, scheduled: true, phone: meta.to_phone, dispatch,
    authorized: async (customer, prefs, trx, phase) => {
      if (prefs.sms_enabled === false || prefs.service_completed === false) return false;
      // The claim phase may return a proven-unsent effect to pending; that
      // write commits with the dispatch mark. The dispatch phase re-judges
      // the visit, the link and the recipient on the freshly held rows.
      if (phase === 'claim') return (await recheckDeferredSummarySms(meta, trx, { customer })).eligible;
      return (await deferredSummaryRecipient(meta, trx, { customer })).eligible;
    } });
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
      // The bearer link is the message. Both push-routing layers key on the
      // message type, and the generic service_complete push lands on the
      // Visits tab without it — so the summary stays an SMS (its deferred
      // row already carries this type).
      metadata: { original_message_type: 'visit_summary' },
      // The sender's locked handoff: a claim that cannot be read throws
      // before any provider request, which the provider wrapper reports as
      // a retryable block, so the requested SMS stays retryable.
      withSmsHandoff: (handoff) => claimDispatchThroughHandoff({ visitId: visit.id, customerId: customer.id,
        kind: 'completion_sms', token: claim.token, phone: recipient.phone,
        authorized: (current, currentPrefs) => currentPrefs.sms_enabled !== false
          && currentPrefs.service_completed !== false
          && getServiceContactSmsRecipient(current).phone === recipient.phone,
        dispatch: (trx, onProviderStart) => handoff(trx, () => { dispatched = true; onProviderStart(); }) }),
    });
    if (result.code === 'QUIET_HOURS_HOLD' && result.deferred && result.nextAllowedAt) {
      dispatched = false; // The provider boundary can also prove it held before sending.
      await deferSummarySms({ visit, customer, recipient, body, claim, nextAllowedAt: result.nextAllowedAt });
      return;
    }
    // Once handed to a non-idempotent provider, every failure is ambiguous
    // (a timeout, a 5xx, a 429: the provider may hold the text) and stays
    // unknown for office reconciliation. Never reclaim it. A refusal before
    // the request is a block and keeps its own retry contract.
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

// The suppression ledger the template library consulted before queuing can
// gain a do_not_email or bounce row before the provider request. It is
// rechecked at the handoff, after the recipient rows are held.
// Reads run on the caller's held transaction: a held handoff must never
// acquire a second pool connection for them.
async function summaryEmailSuppressed(email, database = db) {
  const library = require('./email-template-library');
  const loaded = await library.loadTemplateByKey('service.visit_summary', database);
  if (!loaded?.template) return true;
  return Boolean(await library.activeSuppressionFor(loaded.template, email, 'service_operational', database));
}

// The customer's Email Messages kill switch and the Service Complete Report
// toggle both apply; the SMS leg honors the latter through the sender policy.
function summaryEmailRecipients(customer, prefs) {
  if (prefs?.email_enabled === false || prefs?.service_completed === false) return [];
  return getServiceReportEmailRecipients(customer, prefs);
}

async function sendSummaryEmail({ visit, member, customer, prefs, summaryUrl, visible, database }) {
  const claim = await VisitGroups.claimVisitNotification(member, 'completion_email');
  if (claim?.state !== 'owner') return;
  const recipients = visible ? summaryEmailRecipients(customer, prefs) : [];
  try {
    const scope = { trigger_event_id: `visit_summary:${visit.id}`, recipient_id: customer.id };
    const { messages, outcomes: states } = await summaryEmailEvidence(scope, database);
    const previous = new Map(messages.map((message) => [message.idempotency_key, message]));
    // Corrected-address recovery uses its own idempotency key. A saved send
    // or uncertain handoff to that address also owns it during packet replay.
    const ownedAddresses = new Set(messages.filter((message) => summaryEmailState(message) !== 'retry')
      .map((message) => String(message.recipient_email_snapshot || '').toLowerCase()));
    let sent = states.includes('sent');
    let unknown = states.includes('unknown_delivery');
    let pending = false;
    for (const recipient of recipients) {
      const recipientKey = crypto.createHash('sha256').update(recipient.email.toLowerCase()).digest('hex').slice(0, 32);
      const idempotencyKey = `visit_summary:${visit.id}:${recipientKey}`;
      if (summaryEmailState(previous.get(idempotencyKey)) !== 'retry' || ownedAddresses.has(recipient.email.toLowerCase())) continue;
      let dispatched = false;
      try {
        const result = await require('./email-template-library').sendTemplate({
          templateKey: 'service.visit_summary', to: recipient.email,
          payload: { first_name: recipient.name || 'there', summary_url: summaryUrl },
          recipientType: 'customer', recipientId: customer.id, idempotencyKey,
          triggerEventId: `visit_summary:${visit.id}`,
          categories: ['service_visit_summary'], suppressionGroupKey: 'service_operational',
          suppressProviderErrorLog: true,
          // A stale aggregate owner cannot hand off a later recipient after
          // recovery has claimed the visit, and the recipient rows stay held
          // through the provider request. A claim that cannot be read throws
          // before dispatch, which the library records as a pre-provider abort.
          withProviderHandoff: (handoff) => claimDispatchThroughHandoff({ visitId: visit.id, customerId: customer.id,
            kind: 'completion_email', token: claim.token,
            authorized: async (current, currentPrefs, trx) => summaryEmailRecipients(current, currentPrefs)
              .some((candidate) => candidate.email.toLowerCase() === recipient.email.toLowerCase())
              && !(await summaryEmailSuppressed(recipient.email, trx)),
            dispatch: async (_trx, onProviderStart) => { onProviderStart(); dispatched = true; await handoff(); return { ok: true }; } }),
        });
        if (result.sent) { sent = true; continue; }
        if (result.blocked) continue;
        unknown ||= dispatched;
        pending ||= !dispatched;
      } catch (err) {
        // An administrator archived the template: a deliberate decision, not
        // a transient failure — the leg is suppressed rather than retried.
        if (err?.code === 'EMAIL_TEMPLATE_DISABLED') continue;
        if (dispatched) unknown = true;
        else pending = true;
      }
    }
    // The ledger, not the library's return value, decides what was accepted:
    // a bounce webhook can land between the provider handoff and the
    // library's return, in which case the row already carries its terminal
    // status while the call still reports sent.
    const { outcomes: ledger } = await summaryEmailEvidence(scope, database);
    sent = ledger.includes('sent');
    unknown ||= ledger.includes('unknown_delivery');
    // Finish proven-unsent recipients before surfacing an earlier uncertain
    // recipient. Its durable email row is always skipped on a later retry.
    const outcome = pending ? 'retry' : unknown ? 'unknown_delivery' : sent ? 'sent' : 'suppressed';
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_email', outcome, new Date(), claim.token);
  } catch {
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_email', 'retry', new Date(), claim.token);
  }
}

async function summaryEmailEvidence(message, database) {
  const messages = await database('email_messages').where({ trigger_event_id: message.trigger_event_id,
    template_key: 'service.visit_summary', recipient_id: message.recipient_id })
    .select('id', 'idempotency_key', 'recipient_email_snapshot', 'status', 'sent_at', 'provider_message_id', 'error_message');
  const states = new Map(messages.map((row) => [row.id, summaryEmailState(row)]));
  // A corrected-address resend has a new ledger row. Only its successful
  // outcome can supersede the original; another recipient's delivery cannot.
  const recoveries = await database('email_bounce_recoveries').whereIn('original_message_id', messages.map((row) => row.id))
    .select('original_message_id', 'recovery_message_id');
  for (const recovery of recoveries) {
    if (states.get(recovery.recovery_message_id) === 'sent') states.delete(recovery.original_message_id);
  }
  return { messages, outcomes: [...states.values()] };
}

// A provider bounce arrives after the aggregate closed as sent. When the
// recipient ledger contains any unresolved send, the effect returns to
// the uncertain bucket the office already reviews, once per closed packet.
async function reconcileSummaryEmailBounce(message, database = db) {
  const match = /^visit_summary:([0-9a-f-]{36})$/.exec(String(message?.trigger_event_id || ''));
  if (!match || message.template_key !== 'service.visit_summary') return { reconciled: false };
  const visitId = match[1];
  // Two recipients can bounce in concurrent webhook transactions; holding
  // the shared effect serializes them so the second reads the first's
  // committed outcome instead of its stale 'sent'.
  // The packet row is held first so this reconciliation serializes with the
  // coordinator's close: a bounce that lands while the packet is closing
  // waits for the close (and then alerts on the done packet), and a close
  // that starts after this commits sees the uncertain effect under its lock.
  await database('visit_completion_packets').where({ visit_id: visitId }).forUpdate().first('id');
  const effect = await database('visit_effects').where({ visit_id: visitId, effect_type: 'completion_email', status: 'sent' })
    .forUpdate().first('id');
  if (!effect) return { reconciled: false };
  const { outcomes } = await summaryEmailEvidence(message, database);
  if (!outcomes.includes('unknown_delivery')) return { reconciled: false };
  const flipped = await database('visit_effects').where({ id: effect.id, status: 'sent' })
    .update({ status: 'unknown_delivery', last_error: 'provider_bounce', updated_at: database.fn.now() }).returning('id');
  if (!flipped.length) return { reconciled: false };
  // The review ask follows the summary. Outreach enrolled while the summary
  // looked delivered is parked now that a required recipient failed, whether
  // the packet already closed or is still closing (the coordinator's close
  // re-reads the effects under its lock); the coordinator resumes it when
  // the recovery settles the summary.
  const anyPacket = await database('visit_completion_packets').where({ visit_id: visitId }).first('id', 'status');
  if (anyPacket) await parkVisitReviewOutreach(anyPacket.id, database);
  const packet = anyPacket?.status === 'done' ? anyPacket : null;
  const member = packet ? await VisitGroups.recordedPacketMember(packet.id, database) : null;
  if (packet && member) {
    // Same transaction as the effect flip: a webhook that fails after this
    // point rolls both back, and SendGrid's redelivery cannot leave an alert
    // for an effect that never changed.
    await require('./dispatch-alerts').createAlert({
      type: 'visit_closeout_review', severity: 'warn', techId: member.technician_id, jobId: member.id,
      payload: { visitId, packetId: packet.id, delivery: 'delivery_review', reason: 'summary_email_bounced' }, trx: database,
    });
  }
  return { reconciled: true };
}

// The provider-retry rail resends a stored recipient snapshot. A summary is a
// bearer link, so before that handoff the recipient must STILL be one of the
// customer's current summary recipients under their current preferences, and
// the link must not have been revoked; the rail's own template and
// suppression checks know nothing about visits.
// `destination` is the address the provider will actually receive when it
// differs from the recipient snapshot (a corrected-address recovery): the
// suppression ledger is judged on the destination, since the bounced
// original carries the very suppression the recovery exists to route around.
async function summaryRetryAuthorized(message, database = db, { destination = null } = {}) {
  const match = /^visit_summary:([0-9a-f-]{36})$/.exec(String(message?.trigger_event_id || ''));
  if (!match || message.template_key !== 'service.visit_summary') return { ok: true };
  const held = Boolean(database.isTransaction);
  // On a held transaction the visit row is locked with the recipient rows so
  // a revocation serializes behind the provider request.
  const visit = await database('service_visits').where({ id: match[1] }).whereNull('summary_token_revoked_at')
    .whereIn('status', ['closing', 'closed']).modify((query) => { if (held) query.forShare(); }).first('id', 'customer_id');
  if (!visit) return { ok: false, reason: 'visit_summary_unavailable' };
  const customer = await withAccountPrimaryContact(
    await database('customers').where({ id: visit.customer_id }).first(), { db: database, forShare: held, rethrow: held },
  );
  if (!customer) return { ok: false, reason: 'visit_summary_unavailable' };
  const prefs = await database('notification_prefs').where({ customer_id: visit.customer_id }).first() || {};
  const email = String(message.recipient_email_snapshot || '').trim().toLowerCase();
  const current = summaryEmailRecipients(customer, prefs).some((recipient) => recipient.email.toLowerCase() === email);
  if (!current) return { ok: false, reason: 'visit_summary_recipient_changed' };
  if (await summaryEmailSuppressed(String(destination || email).trim().toLowerCase(), database)) {
    return { ok: false, reason: 'visit_summary_recipient_suppressed' };
  }
  return { ok: true };
}

const PARKED_REVIEW_REASON = 'visit_summary_bounced';

// True while the visit that recorded this service record has a summary leg
// parked as uncertain: review outreach for it must not reach a provider.
async function visitSummaryUncertainForRecord(serviceRecordId, database = db) {
  if (!serviceRecordId) return false;
  try {
    const item = await database('visit_completion_packet_items as i').join('visit_completion_packets as p', 'p.id', 'i.packet_id')
      .where('i.service_record_id', serviceRecordId).first('p.visit_id');
    if (!item) return false;
    const uncertain = await database('visit_effects').where({ visit_id: item.visit_id, status: 'unknown_delivery' })
      .whereIn('effect_type', ['completion_sms', 'completion_email']).first('id');
    return Boolean(uncertain);
  } catch (err) {
    // A read failure here must not park a sequence for good; the parking
    // operation itself is durable and the coordinator resumes it.
    require('./logger').warn(`[visit-closeout] summary uncertainty check failed for record ${serviceRecordId}: ${err.message}`);
    return false;
  }
}

// Parks the cadence sequences enrolled for this packet's recorded service
// records (stopped with a reason of their own and their schedule kept, so
// the recovery can resume them without a fresh enrollment that the cadence
// cooldown might refuse) and removes the pending legacy asks.
async function parkVisitReviewOutreach(packetId, database = db) {
  const records = await database('visit_completion_packet_items').where({ packet_id: packetId })
    .whereNotNull('service_record_id').pluck('service_record_id');
  if (!records.length) return { parked: 0 };
  const parked = await database('review_sequences').whereIn('service_record_id', records).where({ status: 'active' })
    .update({ status: 'stopped', stop_reason: PARKED_REVIEW_REASON, completed_at: database.fn.now(), updated_at: database.fn.now() });
  const removed = await database('review_requests').whereIn('service_record_id', records).where({ status: 'pending' }).del();
  return { parked: Number(parked || 0) + Number(removed || 0) };
}

// Resumes the sequences parkVisitReviewOutreach stopped, at their kept
// schedule or now, whichever is later, unless the customer has since gained
// another active sequence. Returns how many resumed.
async function resumeVisitReviewOutreach(packetId, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first('visit_id');
  const records = await database('visit_completion_packet_items').where({ packet_id: packetId })
    .whereNotNull('service_record_id').pluck('service_record_id');
  if (!packet || !records.length) return 0;
  const visit = await database('service_visits').where({ id: packet.visit_id }).first('customer_id');
  if (await database('review_sequences').where({ customer_id: visit.customer_id, status: 'active' }).first('id')) return 0;
  const resumed = await database('review_sequences').whereIn('service_record_id', records)
    .where({ status: 'stopped', stop_reason: PARKED_REVIEW_REASON })
    .update({ status: 'active', stop_reason: null, completed_at: null, updated_at: database.fn.now(),
      next_run_at: database.raw('GREATEST(COALESCE(next_run_at, NOW()), NOW())') });
  return Number(resumed || 0);
}

// The retry rail's provider request runs while the customer and preference
// rows are held, so the recipient the fence approved is the recipient the
// provider receives. `dispatch()` performs the request.
async function retrySummaryThroughHandoff(message, dispatch, { destination = null, database = db } = {}) {
  const match = /^visit_summary:([0-9a-f-]{36})$/.exec(String(message?.trigger_event_id || ''));
  if (!match || message.template_key !== 'service.visit_summary') return { ok: false, reason: 'visit_summary_unavailable' };
  return database.transaction(async (trx) => {
    const visit = await trx('service_visits').where({ id: match[1] }).forShare().first('customer_id');
    if (!visit) return { ok: false, reason: 'visit_summary_unavailable' };
    await trx('customers').where({ id: visit.customer_id }).forShare().first('id');
    await createDefaultCustomerRows(trx, visit.customer_id);
    await trx('notification_prefs').where({ customer_id: visit.customer_id }).forShare().first('customer_id');
    const fence = await summaryRetryAuthorized(message, trx, { destination });
    if (!fence.ok) return fence;
    // The caller may refuse at the last moment (a corrected destination that
    // another party now owns); a refusal is a verdict, not a dispatch.
    const verdict = await dispatch(trx);
    return verdict && verdict.ok === false ? verdict : { ok: true };
  });
}

// The provider-retry rail can resend a blocked summary recipient later. When
// the ledger proves an accepted send again, the effect a bounce reopened
// returns to sent and the bounce alert it raised is resolved.
async function reconcileSummaryEmailRecovery(message, database = db) {
  const match = /^visit_summary:([0-9a-f-]{36})$/.exec(String(message?.trigger_event_id || ''));
  if (!match || message.template_key !== 'service.visit_summary') return { reconciled: false };
  const visitId = match[1];
  return database.transaction(async (trx) => {
    // provider_bounce: a bounce reopened a sent aggregate. provider_outcome_unknown:
    // the bounce landed before the initial send returned, or the handoff was
    // ambiguous — a delivery event is the proof either lacked.
    const effect = await trx('visit_effects').where({ visit_id: visitId, effect_type: 'completion_email', status: 'unknown_delivery' })
      .whereIn('last_error', ['provider_bounce', 'provider_outcome_unknown']).forUpdate().first('id');
    if (!effect) return { reconciled: false };
    const { outcomes } = await summaryEmailEvidence(message, trx);
    // Every recipient row must be settled: a delivery proves sent, and a
    // ledger that ended entirely in suppressions (a refused retry with no
    // provider request to reconcile it) settles as suppressed.
    if (!outcomes.length || outcomes.some((state) => !['sent', 'suppressed'].includes(state))) {
      return { reconciled: false };
    }
    const settled = outcomes.includes('sent') ? 'sent' : 'suppressed';
    await trx('visit_effects').where({ id: effect.id })
      .update({ status: settled, sent_at: settled === 'sent' ? trx.fn.now() : null, last_error: null, updated_at: trx.fn.now() });
    // The bounce alert, or the coordinator's delivery-review alert when the
    // email leg was the only reason for review: an SMS leg still parked as
    // unknown_delivery is terminal and needs the office, so that alert stays.
    // Only the summary's own legs count: an older tracker effect parked as
    // uncertain is unrelated to this delivery and its deferred review.
    const otherUncertain = await trx('visit_effects').where({ visit_id: visitId, status: 'unknown_delivery' })
      .whereIn('effect_type', ['completion_sms', 'completion_email']).whereNot('id', effect.id).first('id');
    const alerts = await trx('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereNull('resolved_at')
      .whereRaw("payload->>'visitId' = ?", [visitId])
      .where(function reviewOnlyForDelivery() {
        this.whereRaw("payload->>'reason' = 'summary_email_bounced'");
        if (!otherUncertain) {
          this.orWhere(function coordinator() {
            this.whereRaw("payload->>'delivery' = 'delivery_review'").whereRaw("COALESCE(payload->>'payment', '') <> 'office_required'");
          });
        }
      }).select('id');
    for (const alert of alerts) await require('./dispatch-alerts').resolveAlert({ id: alert.id, resolvedBy: null, trx });
    // The review ask was deferred while this delivery was uncertain. A packet
    // that already closed goes back on the recovery queue so the coordinator
    // re-observes the settled summary and enrolls the review it still owes.
    if (!otherUncertain) {
      await trx('visit_completion_packets').where({ visit_id: visitId, status: 'done' })
        .update({ status: 'processing', error: 'review_enrollment_pending', updated_at: trx.fn.now() });
    }
    return { reconciled: true };
  });
}

async function deliverVisitCompletionSummary(packetId, token, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  const visit = await database('service_visits').where({ id: packet.visit_id }).first();
  // An unreadable account primary is a failed read the coordinator retries,
  // never a secondary profile with no recipient.
  const customer = await withAccountPrimaryContact(
    await database('customers').where({ id: visit.customer_id }).first(), { db: database, rethrow: true },
  );
  const prefs = await database('notification_prefs').where({ customer_id: customer.id }).first() || {};
  // A recorded member owns the effects; retained history never qualifies.
  const member = await VisitGroups.recordedPacketMember(packet.id, database);
  const payload = typeof packet.payload === 'string' ? JSON.parse(packet.payload) : packet.payload;
  const summary = token ? await getVisitCompletionSummary(token, database) : null;
  const visibleMembers = await database('visit_completion_packet_items').where({ packet_id: packet.id })
    .whereIn('service_record_id', (summary?.services || []).map((service) => service.id)).pluck('scheduled_service_id');
  const context = { visit, member, customer, prefs, database, visible: Boolean(summary),
    summaryUrl: token ? portalUrl(`/visit/${token}`) : null,
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

module.exports = { VISIT_SUMMARY_TOKEN_RE, ensureVisitSummaryToken, packetHasPublishableSummary, getVisitCompletionSummary,
  deliverVisitCompletionSummary, reconcileSummaryEmailBounce, reconcileSummaryEmailRecovery, summaryRetryAuthorized,
  recheckDeferredSummarySms, beginDeferredSummarySms, finalizeDeferredSummarySms, terminalDeferredSummarySms,
  retrySummaryThroughHandoff, parkVisitReviewOutreach, resumeVisitReviewOutreach, visitSummaryUncertainForRecord,
  PARKED_REVIEW_REASON };
