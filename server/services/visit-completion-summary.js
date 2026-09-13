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
  // The projection runs in one transaction that holds the visit row FOR
  // SHARE from the authorization read to the response data: a revocation
  // (an UPDATE of that row) either committed before this read, which then
  // refuses the link, or waits behind it — never a read that authorized on
  // a stale row while the revocation committed underneath it.
  if (!database.isTransaction) return database.transaction((trx) => getVisitCompletionSummary(token, trx));
  const visit = await database('service_visits').where({
    summary_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
  }).whereNull('summary_token_revoked_at').whereNotNull('summary_token_issued_at')
    .whereIn('status', ['closing', 'closed']).forShare().first();
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

// Two phone strings name the same destination when they normalize to the
// same E.164 number (the canonical sender normalizes before Twilio).
function sameSmsDestination(a, b) {
  const { toE164 } = require('../utils/phone');
  const left = toE164(a);
  return Boolean(left) && left === toE164(b);
}

// Queue ownership and the visit marker commit together. Packet recovery then
// waits on this row; only the existing scheduled-SMS worker dispatches it.
async function deferSummarySms({ visit, member, customer, recipient, body, claim, nextAllowedAt }) {
  await db.transaction(async (trx) => {
    const owned = await trx('visit_effects').where({ visit_id: visit.id, effect_type: 'completion_sms',
      claim_token: claim.token }).whereIn('status', ['claimed', 'unknown_delivery'])
      .update({ status: 'pending', scheduled_at: new Date(nextAllowedAt), updated_at: trx.fn.now() });
    if (!owned) return;
    await trx('sms_log').insert({ customer_id: customer.id, direction: 'outbound',
      from_phone: require('../config/twilio-numbers').getOutboundNumber(), to_phone: recipient.phone,
      message_body: body, message_type: 'visit_summary', status: 'scheduled', scheduled_for: new Date(nextAllowedAt),
      // The recorded member rides along: the scheduled worker passes it as
      // the replay's appointmentId, so the consent validator applies the
      // same per-property toggles the immediate attempt judged.
      metadata: JSON.stringify({ entry_point: 'visit_summary_deferred', visit_id: visit.id,
        visit_summary_claim_token: claim.token, summary_token_hash: visit.summary_token_hash,
        customer_id: customer.id, to_phone: recipient.phone, resolve_from_by_customer: true,
        scheduled_service_id: member?.id || null }),
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
  // An archived visit customer is never reauthorized (the archive keeps the
  // contact columns, so the recipient comparison alone would pass).
  const row = heldCustomer || await database('customers').where({ id: meta.customer_id }).whereNull('deleted_at').first();
  if (!row) return { eligible: false, reason: 'visit_summary_unavailable' };
  const customer = heldCustomer || await withAccountPrimaryContact(row, { db: database, rethrow: true, forShare: Boolean(database.isTransaction) });
  const recipient = getServiceContactSmsRecipient(customer);
  // Contact saves keep their formatting and the canonical sender normalizes
  // before Twilio, so the frozen number and the live one are compared by
  // destination identity, not by string.
  if (!sameSmsDestination(recipient.phone, meta.to_phone)) return { eligible: false, reason: 'visit_summary_recipient_changed' };
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
  // A dispatch mark still carrying its pre-provider marker past the lease is
  // the other proof: the worker died before its provider request.
  const abandonedHandoff = effect?.status === 'unknown_delivery' && VisitGroups.isHandoffPending(effect.last_error)
    && new Date(effect.claimed_at).getTime() <= Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS;
  if (effect?.status === 'unknown_delivery' && (provenUnsentAt || abandonedHandoff)) {
    await database('visit_effects').where({ id: effect.id, status: 'unknown_delivery', claimed_at: effect.claimed_at,
      claim_token: meta.visit_summary_claim_token }).update({ status: 'pending', last_error: null, updated_at: database.fn.now() });
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
async function claimDispatchThroughHandoff({ visitId, customerId, kind, token, scheduled = false, phone = null, email = null, pendingRef = null, authorized, dispatch }) {
  const lost = { ok: false, code: 'VISIT_SUMMARY_CLAIM_LOST' };
  const holdAndAuthorize = async (trx, phase) => {
    // Lock order (customer-comms-lock.js): the per-customer comms lock
    // first — the per-property toggle writer commits under it, so a
    // property opt-out that lands during the request serializes behind the
    // handoff instead of slipping past the consent recheck — then the SMS
    // phone lock (customer-comms → phone → rows, the STOP / suppression
    // writers' order), then the rows. The email-address key comes AFTER
    // every row hold: its other holders (contact correction, the email
    // fanout claim guard, the Customer-360 and IB writers) lock the customer
    // row first and take the key second, so taking it before the rows would
    // deadlock against them.
    const locks = require('../utils/customer-comms-lock');
    await locks.lockCustomerComms(trx, customerId);
    if (phone) await locks.lockSmsPhone(trx, phone);
    await trx('customers').where({ id: customerId }).forShare().first('id');
    // FOR SHARE cannot lock an absent row. The canonical seed serializes
    // missing-row creation without inventing marketing consent or replacing
    // an existing opt-out; hold the resulting row through the handoff.
    await createDefaultCustomerRows(trx, customerId);
    const prefs = await trx('notification_prefs').where({ customer_id: customerId }).forShare().first();
    // A secondary profile's blank contact fields fall back to the account
    // primary: that row is held too, and an unreadable primary is a failed
    // claim read, not a silently different recipient.
    const liveCustomer = await trx('customers').where({ id: customerId }).whereNull('deleted_at').first();
    if (!liveCustomer) return false;
    const customer = await withAccountPrimaryContact(liveCustomer, { db: trx, forShare: true, rethrow: true });
    // The visit row is held too: a revocation or status change after the
    // mark committed serializes behind the provider request instead of
    // racing it.
    const live = await trx('service_visits').where({ id: visitId }).whereNull('summary_token_revoked_at')
      .whereIn('status', ['closing', 'closed']).forShare().first('id');
    if (!live) return false;
    // Held through the request so a suppression or an address claim that
    // commits during it serializes behind the handoff; the ledger fence in
    // `authorized` reads a settled ledger.
    if (email) await locks.lockCustomerEmail(trx, email);
    return authorized(customer, prefs, trx, phase);
  };
  const marked = await db.transaction(async (trx) => ((await holdAndAuthorize(trx, 'claim'))
    ? VisitGroups.beginVisitNotificationDispatch(visitId, kind, token, { scheduled, database: trx, pendingRef }) : false));
  if (!marked) return lost;
  // Nothing reached the provider: the mark returns to its pre-dispatch state
  // so the same claim can retry. Only a mark still carrying its pre-provider
  // marker is returned; if this write fails the effect stays uncertain until
  // the lease proves it unsent (or reaches office review), the safe side.
  const unmark = () => db('visit_effects').where({ visit_id: visitId, effect_type: kind, claim_token: token, status: 'unknown_delivery' })
    .where('last_error', 'like', `${VisitGroups.HANDOFF_PENDING}%`)
    .update({ status: scheduled ? 'pending' : 'claimed', last_error: null, claimed_at: new Date(), updated_at: db.fn.now() })
    .catch(() => {});
  let dispatching = false;
  let verdict;
  try {
    verdict = await db.transaction(async (trx) => {
      if (!(await holdAndAuthorize(trx, 'dispatch'))) return lost;
      // The sender awaits this immediately before its provider request:
      // the pre-provider marker is cleared durably first (a crash after it
      // is uncertain, a crash before it reclaimable); a mark recovery has
      // already reclaimed throws here, before anything reaches the provider.
      return dispatch(trx, async () => {
        if (!(await VisitGroups.markVisitNotificationProviderStart(visitId, kind, token))) {
          throw Object.assign(new Error('Visit summary dispatch mark was reclaimed before the provider request'), { code: 'VISIT_SUMMARY_CLAIM_LOST' });
        }
        dispatching = true;
      });
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
  // The handoff's pre-provider marker clears before the provider request, so
  // a throw from the request itself (the only way this hook's row reaches
  // 'unknown_delivery' straight from the claim) leaves the effect reading
  // unknown even when the scheduler already knows better: a synchronous
  // Twilio rejection with a terminal code (21610/21211/21614/...) proves
  // nothing was accepted. Carry that proof in and settle definitively
  // instead of leaving a proven-unsent leg parked for the office.
  const status = effect.status === 'unknown_delivery' && meta.provider_terminal_rejection !== true
    ? 'unknown_delivery' : 'suppressed';
  const result = await VisitGroups.finalizeVisitNotification(meta.visit_id, 'completion_sms',
    status, new Date(), meta.visit_summary_claim_token);
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
        // Compared by destination identity: a resave of the same number with
        // different punctuation between resolution and the locked recheck is
        // not a recipient change.
        authorized: (current, currentPrefs) => currentPrefs.sms_enabled !== false
          && currentPrefs.service_completed !== false
          && sameSmsDestination(getServiceContactSmsRecipient(current).phone, recipient.phone),
        dispatch: (trx, onProviderStart) => handoff(trx, async () => { await onProviderStart(); dispatched = true; }) }),
    });
    if (result.code === 'QUIET_HOURS_HOLD' && result.deferred && result.nextAllowedAt) {
      dispatched = false; // The provider boundary can also prove it held before sending.
      await deferSummarySms({ visit, member, customer, recipient, body, claim, nextAllowedAt: result.nextAllowedAt });
      return;
    }
    // Once handed to a non-idempotent provider, every failure is ambiguous
    // (a timeout, a 5xx, a 429: the provider may hold the text) and stays
    // unknown for office reconciliation. Never reclaim it. A refusal before
    // the request is a block and keeps its own retry contract, and so is a
    // definitive synchronous rejection (an unsubscribed, invalid or
    // non-mobile number: the adapter's terminal codes), which proves the
    // provider accepted nothing.
    if (!result.sent && !result.blocked && dispatched && result.terminal !== true) {
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
// SendGrid drops a message for a recipient who opted out (a group or
// address unsubscribe, a spam report) under one of these reasons. The
// address is reachable; the customer declined. Such a leg settles as
// suppressed, never as an unknown delivery for the office to chase.
const SUMMARY_OPT_OUT_DROP_REASONS = ['group unsubscribe', 'unsubscribed address', 'spam reporting address'];
function summaryEmailOptOutDrop(reason) {
  return SUMMARY_OPT_OUT_DROP_REASONS.includes(String(reason || '').trim().toLowerCase());
}

function summaryEmailState(message) {
  if (!message) return 'retry';
  // unsubscribed/spam_report are recipient-generated events that land only
  // AFTER the recipient received the message — the same sent evidence as
  // opened/clicked. Without this a multi-recipient summary where one leg
  // unsubscribes and the other bounces can never fully settle: this row
  // reads unknown_delivery forever, so reconcileSummaryEmailRecovery's
  // "every recipient row settled" gate never closes even after the bounced
  // leg is corrected.
  if (['sent', 'delivered', 'opened', 'clicked', 'unsubscribed', 'spam_report'].includes(message.status)) return 'sent';
  if (message.status === 'blocked') return 'suppressed';
  if (message.status === 'dropped' && summaryEmailOptOutDrop(message.error_message)) return 'suppressed';
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

// One recipient's dispatch through the library and the locked handoff.
// Returns 'sent' | 'blocked' | 'unknown' (a provider request may have
// happened) | 'pending' (nothing reached the provider; retry later).
async function sendSummaryEmailRecipient({ visit, customer, claim, summaryUrl, recipient, idempotencyKey }) {
  let dispatched = false;
  let queued = null;
  try {
    const result = await require('./email-template-library').sendTemplate({
      // The queued ledger row's id rides on the dispatch mark's pre-provider
      // marker: a crash before the request leaves a queued row that packet
      // replay would otherwise skip as uncertain (see sendSummaryEmail).
      onQueued: (message) => { queued = message; },
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
        kind: 'completion_email', token: claim.token, email: recipient.email, pendingRef: queued?.id || null,
        authorized: async (current, currentPrefs, trx) => summaryEmailRecipients(current, currentPrefs)
          .some((candidate) => candidate.email.toLowerCase() === recipient.email.toLowerCase())
          && !(await summaryEmailSuppressed(recipient.email, trx)),
        dispatch: async (_trx, onProviderStart) => { await onProviderStart(); dispatched = true; await handoff(); return { ok: true }; } }),
    });
    if (result.sent) return 'sent';
    if (result.blocked) return 'blocked';
    return dispatched ? 'unknown' : 'pending';
  } catch (err) {
    // An administrator archived the template: a deliberate decision, not
    // a transient failure — the leg is suppressed rather than retried.
    if (err?.code === 'EMAIL_TEMPLATE_DISABLED') return 'blocked';
    return dispatched ? 'unknown' : 'pending';
  }
}

// A handoff that died between its durable dispatch mark and its provider
// request left the recipient's ledger row queued; the mark's marker names
// that row and, past the lease, proves no request was made, so the row is
// settled as a pre-dispatch abort and the replay finishes that recipient
// instead of skipping it as uncertain. Read AND settled before the claim
// (which reclaims such a mark and would lose the marker): the settlement is
// provable on its own (marker past the lease, row queued with no provider
// id) and idempotent, so a crash between it and the claim leaves a row the
// next owner re-sends, never one it skips as uncertain.
async function settleAbandonedSummaryEmailRow(visitId, database) {
  const effect = await database('visit_effects').where({ visit_id: visitId, effect_type: 'completion_email', status: 'unknown_delivery' }).first('last_error', 'claimed_at');
  if (!effect || !VisitGroups.isHandoffPending(effect.last_error)) return null;
  if (new Date(effect.claimed_at).getTime() > Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS) return null;
  const messageId = effect.last_error.split(':')[1] || null;
  const marker = effect.last_error;
  // The settlement re-reads the marker under the effect row FOR UPDATE: a
  // still-live owner delayed past the lease clears that marker on its own
  // connection right before its provider request (markVisitNotificationProviderStart),
  // and that clear either committed first — the proof is gone and the row
  // is left alone — or waits for this transaction and finds the row
  // already settled. The proof and the settlement cannot cross.
  return async () => {
    if (!messageId) return 0;
    const settle = async (trx) => {
      const held = await trx('visit_effects').where({ visit_id: visitId, effect_type: 'completion_email', status: 'unknown_delivery' })
        .forUpdate().first('last_error');
      if (!held || held.last_error !== marker) return 0;
      return trx('email_messages').where({ id: messageId, status: 'queued', trigger_event_id: `visit_summary:${visitId}` })
        .whereNull('provider_message_id').whereNull('sent_at')
        .update({ status: 'failed', error_message: require('./email-template-library').ABORTED_BEFORE_DISPATCH, updated_at: trx.fn.now() });
    };
    return database.isTransaction ? settle(database) : database.transaction(settle);
  };
}

async function sendSummaryEmail({ visit, member, customer, prefs, summaryUrl, visible, database }) {
  const abandoned = await settleAbandonedSummaryEmailRow(visit.id, database);
  if (abandoned) await abandoned();
  const claim = await VisitGroups.claimVisitNotification(member, 'completion_email');
  if (claim?.state !== 'owner') return;
  const recipients = visible ? summaryEmailRecipients(customer, prefs) : [];
  try {
    const scope = { trigger_event_id: `visit_summary:${visit.id}`, recipient_id: customer.id };
    const { messages } = await summaryEmailEvidence(scope, database);
    const previous = new Map(messages.map((message) => [message.idempotency_key, message]));
    // Corrected-address recovery uses its own idempotency key. A saved send
    // or uncertain handoff to that address also owns it during packet replay.
    const ownedAddresses = new Set(messages.filter((message) => summaryEmailState(message) !== 'retry')
      .map((message) => String(message.recipient_email_snapshot || '').toLowerCase()));
    const outcomes = [];
    for (const recipient of recipients) {
      const recipientKey = crypto.createHash('sha256').update(recipient.email.toLowerCase()).digest('hex').slice(0, 32);
      const idempotencyKey = `visit_summary:${visit.id}:${recipientKey}`;
      if (summaryEmailState(previous.get(idempotencyKey)) !== 'retry' || ownedAddresses.has(recipient.email.toLowerCase())) continue;
      outcomes.push(await sendSummaryEmailRecipient({ visit, customer, claim, summaryUrl, recipient, idempotencyKey }));
    }
    // The ledger, not the library's return value, decides what was accepted:
    // a bounce webhook can land between the provider handoff and the
    // library's return, in which case the row already carries its terminal
    // status while the call still reports sent.
    const { outcomes: ledger } = await summaryEmailEvidence(scope, database);
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_email',
      summaryEmailAggregateOutcome(outcomes, ledger), new Date(), claim.token);
  } catch {
    await VisitGroups.finalizeVisitNotification(visit.id, 'completion_email', 'retry', new Date(), claim.token);
  }
}

// Finish proven-unsent recipients before surfacing an earlier uncertain
// recipient. Its durable email row is always skipped on a later retry.
function summaryEmailAggregateOutcome(outcomes, ledger) {
  if (outcomes.includes('pending')) return 'retry';
  if (outcomes.includes('unknown') || ledger.includes('unknown_delivery')) return 'unknown_delivery';
  return ledger.includes('sent') ? 'sent' : 'suppressed';
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
  // A caller outside a transaction (the retry rail's exhaustion) gets one
  // here: the packet and effect locks below must outlive their SELECTs, or a
  // review handoff can take the packet row between the read and the flip,
  // see the still-sent effect and send the ask this parks.
  if (!database.isTransaction) return database.transaction((trx) => reconcileSummaryEmailBounce(message, trx));
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
    await database('customers').where({ id: visit.customer_id }).whereNull('deleted_at').first(), { db: database, forShare: held, rethrow: held },
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
// The review asks the closeout owns: the packet's own enrollment and the
// cadence touches it starts. An admin- or technician-triggered ask is the
// operator's (its copy, channel and timing cannot be rebuilt by the
// recovery), so parking leaves it pending for the scheduler to defer.
const PACKET_OWNED_REVIEW_TRIGGERS = ['auto', 'sequence'];
// stop_reason is varchar(24).
const PARKED_SUPERSEDED_REASON = 'summary_park_superseded';

// True while the visit that recorded this service record has a summary leg
// parked as uncertain: review outreach for it must not reach a provider.
// true = parked, false = clear, null = the state could not be read (callers
// defer rather than send on a guess).
async function visitSummaryUncertainForRecord(serviceRecordId, database = db) {
  if (!serviceRecordId) return false;
  try {
    const item = await database('visit_completion_packet_items').where({ service_record_id: serviceRecordId }).first('packet_id');
    if (!item) return false;
    const packet = await database('visit_completion_packets').where({ id: item.packet_id }).first('visit_id');
    if (!packet) return false;
    const uncertain = await database('visit_effects').where({ visit_id: packet.visit_id, status: 'unknown_delivery' })
      .whereIn('effect_type', ['completion_sms', 'completion_email']).first('id');
    return Boolean(uncertain);
  } catch (err) {
    require('./logger').warn(`[visit-closeout] summary uncertainty check failed for record ${serviceRecordId}: ${err.message}`);
    return null;
  }
}

// Parks the cadence sequences enrolled for this packet's recorded service
// records (stopped with a reason of their own and their schedule kept, so
// the recovery can resume them without a fresh enrollment that the cadence
// cooldown might refuse) and removes the pending automatic asks. An ask whose
// provider handoff has started is `sending` (see reviewSendThroughSummaryHandoff)
// and is kept: its delivery is recorded by its own sender. A manual ask is
// kept too (PACKET_OWNED_REVIEW_TRIGGERS). A delivered ask's follow-up is
// held by processFollowups while the summary stays uncertain.
async function parkVisitReviewOutreach(packetId, database = db) {
  const records = await database('visit_completion_packet_items').where({ packet_id: packetId })
    .whereNotNull('service_record_id').pluck('service_record_id');
  if (!records.length) return { parked: 0 };
  const parked = await database('review_sequences').whereIn('service_record_id', records).where({ status: 'active' })
    .update({ status: 'stopped', stop_reason: PARKED_REVIEW_REASON, completed_at: database.fn.now(), updated_at: database.fn.now() });
  const removed = await database('review_requests').whereIn('service_record_id', records).where({ status: 'pending' })
    .whereIn('triggered_by', PACKET_OWNED_REVIEW_TRIGGERS).del();
  return { parked: Number(parked || 0) + Number(removed || 0) };
}

// Resumes the sequences parkVisitReviewOutreach stopped, at their kept
// schedule or now, whichever is later, unless the customer has since gained
// another active sequence. Returns how many resumed.
async function resumeVisitReviewOutreach(packetId, database = db) {
  // With the cadence gate off the sequence cron advances nothing: a parked
  // cadence stays parked, and the enrollment that follows takes the
  // documented legacy single-ask path instead.
  if (!require('../config/feature-gates').isEnabled('reviewSequences')) return 0;
  const packet = await database('visit_completion_packets').where({ id: packetId }).first('visit_id');
  const records = await database('visit_completion_packet_items').where({ packet_id: packetId })
    .whereNotNull('service_record_id').pluck('service_record_id');
  if (!packet || !records.length) return 0;
  const visit = await database('service_visits').where({ id: packet.visit_id }).first('customer_id');
  if (await database('review_sequences').where({ customer_id: visit.customer_id, status: 'active' }).first('id')) return 0;
  // A customer holds at most one active sequence (uq_review_sequences_active_customer):
  // when several were parked for this packet (a later member's enrollment
  // parked on arrival), the most recently parked one resumes and the others
  // retire under a reason of their own, so nothing re-parks them again.
  const parked = await database('review_sequences').whereIn('service_record_id', records)
    .where({ status: 'stopped', stop_reason: PARKED_REVIEW_REASON }).orderBy('updated_at', 'desc').orderBy('id').select('id');
  if (!parked.length) return 0;
  const [chosen, ...others] = parked.map((row) => row.id);
  if (others.length) {
    await database('review_sequences').whereIn('id', others).where({ status: 'stopped', stop_reason: PARKED_REVIEW_REASON })
      .update({ stop_reason: PARKED_SUPERSEDED_REASON, updated_at: database.fn.now() });
  }
  // A step whose send is still UNRESOLVED keeps its empty schedule (local
  // audit): the parked sequence may hold a request left `sending` by a send
  // whose outcome was never proven, and scheduling it now would let the
  // runner build a second request for the same step — a no-link check-in
  // bypasses ask spacing, so the customer could get two. It would also strand
  // the original, since _advanceStrandedSequenceStep only advances a sequence
  // with no schedule. The stranded-send reconciliation owns that row: it
  // advances the step on proof of delivery, or releases it and schedules the
  // retry itself.
  const seq = await database('review_sequences').where({ id: chosen }).first('id', 'current_step');
  const unresolved = await database('review_requests').where({ sequence_id: chosen, status: 'sending' })
    .modify((q) => { if (seq?.current_step !== null && seq?.current_step !== undefined) q.where({ sequence_step: seq.current_step }); })
    .first('id');
  const resumed = await database('review_sequences').where({ id: chosen, status: 'stopped', stop_reason: PARKED_REVIEW_REASON })
    .update({ status: 'active', stop_reason: null, completed_at: null, updated_at: database.fn.now(),
      ...(unresolved ? {} : { next_run_at: database.raw('GREATEST(COALESCE(next_run_at, NOW()), NOW())') }) });
  return Number(resumed || 0);
}

// A review ask's provider request runs while the packet row of the visit
// that recorded its service record is shared, so a summary bounce (which
// takes that row FOR UPDATE before parking outreach) serializes with the
// send: the ask goes out before the bounce lands, or is parked before it
// could go out. Records outside a combined visit dispatch unfenced.
// `requestId` names the legacy/touch row the send belongs to: it becomes
// `sending` in this same transaction immediately before the request, so a
// bounce reconciliation that waits on the packet row and then parks the
// outreach removes only asks that have not reached a provider, never one
// whose delivery is about to be recorded (a throw from the request rolls
// the mark back with the transaction).
async function reviewSendThroughSummaryHandoff(serviceRecordId, dispatch, database = db, { requestId = null, claimRef = null } = {}) {
  // The pre-provider mark is durable BEFORE the held handoff, on the marker
  // connection (never inside the transaction it would roll back with): a
  // worker lost after the provider accepted but before this transaction
  // commits leaves a `sending` row the stranded-send reconciliation
  // (review-request.js) proves or releases, never a pending row the
  // scheduler would send again. claimed_at is written at JavaScript
  // precision so the reconciliation's guards compare it losslessly.
  const claimedAt = new Date();
  const marked = requestId
    ? Number(await require('../models/marker-db')()('review_requests').where({ id: requestId, status: 'pending' })
      .update({ status: 'sending', claimed_at: claimedAt })) : 0;
  // A claim that moved NO row is not a send permit (audit P1): the row is
  // already `sending` under another sender, or it was suppressed, parked or
  // deleted between batching and here. Dispatching anyway lets two senders
  // reach the provider for one ask, or sends an ask that has been withdrawn.
  // The verdict is decided INSIDE the transaction below, after the summary
  // check, so a park (which removes the row) still reports itself as a park
  // rather than as a lost claim. Nothing is written either way — the row
  // belongs to whoever holds the claim, or to the state that replaced it.
  // The caller's handle on the claim THIS send took (local audit): any
  // bookkeeping it does afterwards must name this exact claim, or it can
  // reset a `sending` marker belonging to another sender — including one that
  // already reached the provider.
  if (claimRef) {
    claimRef.claimedAt = claimedAt;
    claimRef.marked = marked > 0;
  }
  let claimLost = !!requestId && !marked;
  const release = () => database('review_requests').where({ id: requestId, status: 'sending', claimed_at: claimedAt })
    .update({ status: 'pending', claimed_at: null });
  let dispatched = false;
  let verdict;
  try {
    verdict = await database.transaction(async (trx) => {
      const item = serviceRecordId
        ? await trx('visit_completion_packet_items').where({ service_record_id: serviceRecordId }).first('packet_id') : null;
      const packet = item && await trx('visit_completion_packets').where({ id: item.packet_id }).forShare().first('visit_id');
      // The claim is re-verified on the row itself once the packet row is
      // held (Codex r27 P1): a wait on that row longer than the stranded-send
      // window lets the reconciliation release this `sending` mark and a
      // later worker claim the same ask, and `marked` only records the update
      // that ran before the wait. FOR UPDATE, not a plain read (r29 P1): the
      // row stays locked through the provider request, so the reconciliation
      // cannot flip this claim back to `pending` between the check and the
      // send and let a second sender take it.
      if (!claimLost && marked) {
        const held = await trx('review_requests').where({ id: requestId, status: 'sending', claimed_at: claimedAt }).forUpdate().first('id');
        claimLost = !held;
      }
      // A claim held by ANOTHER SENDER outranks the summary verdict (r29 P1):
      // reporting a park here would have the caller delete any
      // `pending`/`sending` row for this ask — the durable marker of the
      // worker that does own the claim, which may already have reached the
      // provider. A row that is simply GONE (a bounce reconciliation parked
      // it) is not that case, and still reports itself as a park below, so
      // the cadence is parked rather than left running.
      if (claimLost) {
        const live = await trx('review_requests').where({ id: requestId }).forUpdate().first('id', 'status');
        if (live?.status === 'sending') {
          return { ok: false, code: 'REVIEW_CLAIM_LOST', reason: 'This review ask is being sent by another worker' };
        }
      }
      if (packet) {
        const uncertain = await trx('visit_effects').where({ visit_id: packet.visit_id, status: 'unknown_delivery' })
          .whereIn('effect_type', ['completion_sms', 'completion_email']).first('id');
        if (uncertain) return { ok: false, code: 'VISIT_SUMMARY_UNCERTAIN', reason: 'The visit summary this review follows is awaiting recovery' };
      }
      // No claim and no summary verdict to explain it: the row was suppressed,
      // deleted or re-claimed since it was batched. Nothing is sent and
      // nothing is written — the row belongs to whatever replaced this claim.
      if (claimLost) {
        return { ok: false, code: 'REVIEW_CLAIM_LOST', reason: 'This review ask is already being sent or is no longer pending' };
      }
      // `dispatched` flips at the PROVIDER BOUNDARY, not here (Codex #4311
      // r35 P2): the sender's own fresh consent/suppression/window rechecks
      // run inside dispatch() before the Twilio request, and a throw from one
      // of those is provably unsent — marking dispatch started up front left
      // such a row `sending` with nothing to prove its absence (a no-link
      // cadence touch has no sms_log for the evidence reader). The callback
      // the send layer invokes immediately before the request is what sets it.
      return dispatch(trx, () => { dispatched = true; });
    });
  } catch (err) {
    // A throw before the request is provably unsent; one from the request
    // is not, and the row stays marked for the reconciliation to judge.
    if (marked && !dispatched) await release().catch(() => {});
    throw err;
  }
  // A refusal before the request (consent, suppression, send window, an
  // uncertain summary) is provably unsent: the row returns to pending, so a
  // worker lost before the sender's own bookkeeping strands nothing. The
  // release names this sender's own claim, so a mark that was taken over in
  // the meantime (claim lost above) is left to its new holder.
  if (marked && verdict && verdict.ok === false) {
    await release();
    // The claim is NO LONGER OWNED once it is released (Codex #4311 r45 P1):
    // another worker can take the row in the gap before the caller's
    // bookkeeping runs, and a caller that still believed it held the claim
    // would write by id and could reset or suppress that replacement's live
    // `sending` row. Reporting the release makes the caller's writes skip a
    // `sending` row while still moving its own, now-`pending` one.
    if (claimRef) claimRef.marked = false;
  }
  return verdict;
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
    const customer = await trx('customers').where({ id: visit.customer_id }).whereNull('deleted_at').forShare().first();
    if (!customer) return { ok: false, reason: 'visit_summary_unavailable' };
    await createDefaultCustomerRows(trx, visit.customer_id);
    await trx('notification_prefs').where({ customer_id: visit.customer_id }).forShare().first('customer_id');
    // The account-primary row is held before the address key too (an
    // unreadable primary is a failed claim read, not a different recipient).
    await withAccountPrimaryContact(customer, { db: trx, forShare: true, rethrow: true });
    // The destination address key is taken after every row hold — its other
    // holders lock the customer row first, so the reverse order would
    // deadlock against a contact correction — and stays held through the
    // request: suppression and address writers serialize on it, so the
    // fence below reads a settled ledger and the request cannot be overtaken
    // by an opt-out or an address claim.
    await require('../utils/customer-comms-lock').lockCustomerEmail(trx, destination || message.recipient_email_snapshot);
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
  const run = async (trx) => {
    // PACKET ROW FIRST, then the effect (local audit): the bounce
    // reconciliation takes them in exactly that order, and this path updates
    // the packet below — holding the effect first is the inverse order, and
    // a bounce and a recovery running side by side deadlock-abort one
    // reconciliation.
    await trx('visit_completion_packets').where({ visit_id: visitId }).forUpdate().first('id');
    // provider_bounce: a bounce reopened a sent aggregate. provider_outcome_unknown:
    // the bounce landed before the initial send returned, or the handoff was
    // ambiguous — a delivery event is the proof either lacked.
    // A still-sent aggregate is judged too: a provider block that scheduled
    // a retry never reopened it (the rail owns the block), so when that
    // retry is refused and the ledger holds no accepted send any more, the
    // aggregate settles as suppressed instead of reading as delivered.
    const effect = await trx('visit_effects').where({ visit_id: visitId, effect_type: 'completion_email' })
      .where(function () {
        this.where({ status: 'sent' })
          .orWhere(function () { this.where({ status: 'unknown_delivery' }).whereIn('last_error', ['provider_bounce', 'provider_outcome_unknown']); });
      }).forUpdate().first('id', 'status');
    if (!effect) return { reconciled: false };
    const { outcomes } = await summaryEmailEvidence(message, trx);
    // Every recipient row must be settled: a delivery proves sent, and a
    // ledger that ended entirely in suppressions (a refused retry with no
    // provider request to reconcile it) settles as suppressed.
    if (!outcomes.length || outcomes.some((state) => !['sent', 'suppressed'].includes(state))) {
      return { reconciled: false };
    }
    const settled = outcomes.includes('sent') ? 'sent' : 'suppressed';
    if (effect.status === settled) return { reconciled: false };
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
      // A packet closed for office review of its payment (a payer owns the
      // invoice, the visit is on billing hold) owes no review enrollment:
      // reopening it would only re-record the payer alert it already holds.
      const closed = await trx('visit_completion_packets').where({ visit_id: visitId, status: 'done' }).first('id', 'error');
      const state = require('./visit-completion-packets').parseOfficeReviewState(closed?.error);
      if (closed && state?.payment !== 'office_required') {
        await trx('visit_completion_packets').where({ id: closed.id, status: 'done' })
          .update({ status: 'processing', error: 'review_enrollment_pending', updated_at: trx.fn.now() });
      }
    }
    return { reconciled: true };
  };
  // Composable with a caller's own transaction (the retry rail's stopRetry
  // commits the ledger's terminal update and this settlement together), or
  // opens its own when called standalone (the webhook and the recovery
  // handoff's post-commit best-effort call).
  return database.isTransaction ? run(database) : database.transaction(run);
}

async function deliverVisitCompletionSummary(packetId, token, database = db) {
  const packet = await database('visit_completion_packets').where({ id: packetId }).first();
  const visit = await database('service_visits').where({ id: packet.visit_id }).first();
  // An unreadable account primary is a failed read the coordinator retries,
  // never a secondary profile with no recipient.
  const row = await database('customers').where({ id: visit.customer_id }).first();
  // An archived customer receives nothing: both legs settle as suppressed.
  const archived = !row || Boolean(row.deleted_at);
  const customer = await withAccountPrimaryContact(row, { db: database, rethrow: true });
  const prefs = await database('notification_prefs').where({ customer_id: customer.id }).first() || {};
  // A recorded member owns the effects; retained history never qualifies.
  const member = await VisitGroups.recordedPacketMember(packet.id, database);
  const payload = require('./visit-completion-packets').packetPayload(packet);
  const summary = token ? await getVisitCompletionSummary(token, database) : null;
  const visibleMembers = await database('visit_completion_packet_items').where({ packet_id: packet.id })
    .whereIn('service_record_id', (summary?.services || []).map((service) => service.id)).pluck('scheduled_service_id');
  const context = { visit, member, customer, prefs, database, visible: !archived && Boolean(summary),
    summaryUrl: token ? portalUrl(`/visit/${token}`) : null,
    requested: !archived && payload.items.some((item) => visibleMembers.includes(item.serviceId) && item.body.sendCompletionSms === true) };
  await sendSummarySms(context);
  await sendSummaryEmail(context);
  const effects = await database('visit_effects').where({ visit_id: visit.id })
    .whereIn('effect_type', ['completion_sms', 'completion_email']);
  // Keep the packet on recovery while either channel has proven-unsent work
  // or a live provider handoff, even if the other channel needs office review.
  // A stale mark that still carries its pre-provider marker is provably
  // unsent (the next replay reclaims it), so it stays pending, not review.
  const stale = (effect) => new Date(effect.claimed_at).getTime() <= Date.now() - VisitGroups.NOTIFICATION_CLAIM_LEASE_MS;
  const unknown = effects.some((effect) => effect.status === 'unknown_delivery'
    && (effect.last_error === 'provider_outcome_unknown' || (stale(effect) && !VisitGroups.isHandoffPending(effect.last_error))));
  const pending = effects.length !== 2 || effects.some((effect) => !['sent', 'suppressed', 'unknown_delivery'].includes(effect.status)
    || (effect.status === 'unknown_delivery' && effect.last_error !== 'provider_outcome_unknown'
      && (!stale(effect) || VisitGroups.isHandoffPending(effect.last_error))));
  return { state: pending ? 'delivery_pending' : unknown ? 'delivery_review' : 'delivered' };
}

module.exports = { VISIT_SUMMARY_TOKEN_RE, ensureVisitSummaryToken, packetHasPublishableSummary, getVisitCompletionSummary,
  deliverVisitCompletionSummary, reconcileSummaryEmailBounce, reconcileSummaryEmailRecovery, summaryRetryAuthorized,
  recheckDeferredSummarySms, beginDeferredSummarySms, finalizeDeferredSummarySms, terminalDeferredSummarySms,
  retrySummaryThroughHandoff, parkVisitReviewOutreach, resumeVisitReviewOutreach, visitSummaryUncertainForRecord,
  reviewSendThroughSummaryHandoff, PARKED_REVIEW_REASON, PACKET_OWNED_REVIEW_TRIGGERS, summaryEmailOptOutDrop,
  _settleAbandonedSummaryEmailRow: settleAbandonedSummaryEmailRow };
