'use strict';

const db = require('../models/db');
const logger = require('./logger');
const { redactContact } = require('../utils/redact-contact');
const ContactLedger = require('./collections/contact-ledger');
const { readStoredBillingReplayContext } = require('./email-template-library');
const { storedEmailAcceptedAt } = require('./messaging/billing-channel-routing');
const DunningKeys = require('./customer-dunning/constants');
const BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX = 'Billing email terminal refusal: ';
const BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX = 'Billing email re-quote required: ';
const LEDGER_SOURCE_BY_ENTRY_POINT = Object.freeze({
  invoice_followup_sequence: 'invoice_followups',
});

function replayContext(message) {
  try {
    const context = readStoredBillingReplayContext(message);
    return context?.collections_ledger_id ? context : null;
  } catch (err) {
    logger.warn(`[billing-email-reservation] stored context unreadable: ${redactContact(err.message)}`);
    return null;
  }
}

function reservationMatch(context) {
  return {
    customerId: context.customer_id,
    channel: 'email',
    source: LEDGER_SOURCE_BY_ENTRY_POINT[context.source_entry_point] || context.source_entry_point,
    notificationEventKey: context.notificationEventKey,
    ...(context.invoice_id ? { invoiceId: context.invoice_id } : {}),
  };
}

// Accepted provider bookkeeping and a verified delivered webhook both call
// this best-effort writer. It never throws back into accepted-send handling:
// a missed stamp leaves the reservation held for reminderProgress repair.
async function markBillingEmailReservationDelivered(message, database = db) {
  if (!message?.id || !hasAcceptedEvidence(message)) return false;
  try {
    const stampCurrentAttempt = async (trx) => {
      const query = trx('email_messages').where({ id: message.id });
      if (message.send_attempt_token == null) query.whereNull('send_attempt_token');
      else query.where({ send_attempt_token: message.send_attempt_token });
      const current = await query.forUpdate().first();
      if (!current || !hasAcceptedEvidence(current)) return false;
      const context = replayContext(current);
      if (!context) return false;
      const stamped = await ContactLedger.markDelivered(
        { id: context.collections_ledger_id },
        { database: trx, match: reservationMatch(context) },
      );
      // markDelivered is best-effort and converts its own SQL failure to
      // false. Abort this surrounding savepoint as well before the outer
      // catch returns false, so a webhook's parent transaction stays usable.
      if (!stamped) throw new Error('accepted reservation was not stamped');
      return true;
    };
    // A supplied webhook transaction gets a savepoint. If either the current
    // attempt read or ledger write fails, catching below must not leave the
    // caller's held transaction aborted.
    return await database.transaction(stampCurrentAttempt);
  } catch (err) {
    logger.warn(`[billing-email-reservation] delivered stamp failed: ${redactContact(err.message)}`);
    return false;
  }
}

// A permanent pre-send refusal resolves only the bound Email leg. It remains
// explicitly undelivered, and temporary/unknown outcomes never call here.
async function resolveBillingEmailReservationRefusal(message, database = db) {
  const context = replayContext(message);
  if (!context) return false;
  try {
    return await ContactLedger.markSendFailed(
      { id: context.collections_ledger_id },
      { resolved: true, resolution: 'email_terminal_refusal' },
      { database, match: reservationMatch(context) },
    );
  } catch (err) {
    logger.warn(`[billing-email-reservation] refusal stamp failed: ${redactContact(err.message)}`);
    return false;
  }
}

function hasAcceptedEvidence(message) {
  return !!(message?.sent_at || message?.delivered_at || message?.opened_at || message?.clicked_at);
}

function hasTerminalRefusalEvidence(message) {
  return message?.status === 'blocked' && !!message.provider_retry_exhausted_at
    && String(message.error_message || '').startsWith(BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX);
}

function hasRequoteRefusalEvidence(message) {
  return message?.status === 'failed' && !!message.provider_retry_exhausted_at
    && !message.provider_retry_next_at && !hasAcceptedEvidence(message)
    && ['pending', 'rejected'].includes(message.provider_handoff_phase)
    && !!message.send_attempt_token && message.provider_handoff_attempt_token === message.send_attempt_token
    && String(message.error_message || '').startsWith(BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX);
}

// Stop the frozen snapshot while allowing a fresh rendering to claim both
// ledgers. Consume the repair marker atomically: repeating an old repair must
// not release a newer reservation that has already been reclaimed.
async function releaseBillingEmailReservationForRequote(message, database = db, { propagateErrors = false } = {}) {
  if (!hasRequoteRefusalEvidence(message)) return false;
  try {
    return await database.transaction(async (trx) => {
      // Match the producer's scheduler/service lease on this separate work
      // connection. An active producer may have snapshotted Email delivery;
      // do not change its progress or claim until the entire sweep is idle.
      const lease = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked',
        ['cron:previsit-balance-reminder']);
      if (lease?.rows?.[0]?.locked !== true) return false;
      const current = await trx('email_messages')
        .where({ id: message.id, send_attempt_token: message.send_attempt_token }).forUpdate().first();
      if (!hasRequoteRefusalEvidence(current)) return false;
      const context = replayContext(current);
      if (!context || context.source_entry_point !== 'previsit_balance_reminder' || !context.appointment_id) return false;
      // A provider-accepted attempt may already have completed the reminder
      // episode before SendGrid later blocks the address. Retiring that
      // provider snapshot must reopen the exact Email reservation; the
      // ordinary markSendFailed merge intentionally preserves delivery.
      const released = await trx('collections_contact_ledger')
        .where({
          id: context.collections_ledger_id,
          customer_id: context.customer_id,
          channel: 'email',
          source: context.source_entry_point,
        })
        .whereRaw("metadata->>'notificationEventKey' = ?", [context.notificationEventKey])
        .whereRaw("NOT (COALESCE(metadata, '{}'::jsonb) @> ?::jsonb)", [JSON.stringify({ resolved: true })])
        .update({
          metadata: trx.raw(
            "(COALESCE(metadata, '{}'::jsonb) - 'delivered') || '{\"send_failed\": true}'::jsonb",
          ),
        });
      if (Number(released) !== 1) return false;
      const claimReleased = await trx('scheduled_services')
        .where({ id: context.appointment_id, customer_id: context.customer_id })
        .update({ balance_reminder_sent_at: null });
      if (Number(claimReleased) !== 1) throw Object.assign(new Error('pinned previsit claim was not released'), { reservationNoop: true });
      const retired = await trx('email_messages').where({ id: current.id }).update({
        error_message: String(current.error_message).replace(BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX,
          'Billing email old quote retired: '),
        updated_at: new Date(),
      });
      if (Number(retired) !== 1) throw Object.assign(new Error('old quote marker was not retired'), { reservationNoop: true });
      return true;
    });
  } catch (err) {
    logger.warn(`[billing-email-reservation] changed-quote release failed: ${redactContact(err.message)}`);
    // A caller that terminalized the row in its own transaction needs a real failure to roll back
    // with. A refused invariant (a pinned appointment that is gone, a marker already retired) is a
    // no-op the recovery sweep owns, never a reason to fail the caller.
    if (propagateErrors && !err.reservationNoop) throw err;
    return false;
  }
}

// A stored billing copy the retry rail STOPPED because the customer's address
// was corrected (not refused): the reservation must stay claimable, so the
// owning sender's next attempt renders fresh to the live address. A resolved
// leg is never claimed again (claimVerdict) and an unsettled one is held, so
// the leg is reopened with the plain failed-attempt flag, the same
// definite-non-send outcome a bound customer-dunning row reaches
// (DUNNING_OUTCOME_PATCH.unsent). A previsit reminder pinned to an appointment
// goes through the re-quote release instead, which also frees its appointment
// claim.
function isPrevisitReissue(message) {
  const context = replayContext(message);
  return !!context && context.source_entry_point === 'previsit_balance_reminder' && !!context.appointment_id;
}

// The stopped row's CURRENT attempt never reached a mailbox: settled failed by
// the retry rail, exhausted, no schedule, positive handoff evidence that the
// provider rejected (or never received) this very attempt, and no provider
// acceptance or delivery stamp on the row. The webhook's block event leaves the
// acceptance-time stamps on the row it re-arms, and the rail clears `sent_at`
// when it stops such a row, so a stamp that is still present means the attempt
// really was accepted and is never reopened here.
function hasStoppedUnsentEvidence(message) {
  return message?.status === 'failed' && !!message.provider_retry_exhausted_at
    && !message.provider_retry_next_at && !hasAcceptedEvidence(message)
    && ['pending', 'rejected'].includes(message.provider_handoff_phase)
    && !!message.send_attempt_token && message.provider_handoff_attempt_token === message.send_attempt_token;
}

// Reopen the exact reservation the stopped attempt owns, in one transaction
// that holds the email row: the attempt must still be the current one with its
// unsent evidence, and the ledger write is a compare-and-set on the
// reservation's identity that leaves a resolved reservation alone. A delivery
// stamp the acceptance wrote (late-payment-checker stamps `delivered` when
// SendGrid accepts) belongs to the attempt that was just rejected, so it is
// cleared with the failed flag; claimVerdict would refuse a delivered leg.
// Returns false when there is nothing to reopen (not a replay, the attempt is
// no longer current, the reservation is resolved or gone) and throws when the
// write itself failed.
async function reopenBillingEmailReservationForReissue(message, database = db) {
  const context = replayContext(message);
  if (!context || !message?.id) return false;
  try {
    return await database.transaction(async (trx) => {
      const query = trx('email_messages').where({ id: message.id });
      if (message.send_attempt_token == null) query.whereNull('send_attempt_token');
      else query.where({ send_attempt_token: message.send_attempt_token });
      const current = await query.forUpdate().first();
      if (!hasStoppedUnsentEvidence(current)) return false;
      const match = reservationMatch(context);
      const reopen = trx('collections_contact_ledger')
        .where({ id: context.collections_ledger_id, customer_id: match.customerId, channel: match.channel, source: match.source })
        .whereRaw("metadata->>'notificationEventKey' = ?", [match.notificationEventKey])
        .whereRaw("NOT (COALESCE(metadata, '{}'::jsonb) @> ?::jsonb)", [JSON.stringify({ resolved: true })]);
      if (match.invoiceId) reopen.whereRaw('invoice_ids @> ?::jsonb', [JSON.stringify([match.invoiceId])]);
      const changed = await reopen.update({
        metadata: trx.raw(
          "(COALESCE(metadata, '{}'::jsonb) - 'delivered') || ?::jsonb",
          [JSON.stringify({ send_failed: true, code: 'email_not_sent' })],
        ),
      });
      return Number(changed) === 1;
    });
  } catch (err) {
    logger.warn(`[billing-email-reservation] reissue reopen failed: ${redactContact(err.message)}`);
    // Never swallowed: the stop that terminalized the row commits or fails together with this write,
    // so an error here must reach its transaction. "Nothing to reopen" returns false above instead.
    throw err;
  }
}

function metadataOf(row) {
  if (typeof row?.metadata !== 'string') return row?.metadata || {};
  try { return JSON.parse(row.metadata) || {}; } catch { return {}; }
}

// ── customer-level dunning emails (customer_dunning_email:<schedule>:<episode>:<step>) ──
// These do not use the billing.notice replay context: the sender binds the
// email row to its ledger reservation by carrying the reservation's id in the
// stored payload (`collections_ledger_id`), and the identity below is derived
// from the reservation's own notificationEventKey with the SAME key builders
// the sender uses. An accepted-but-unstamped email is therefore repaired to
// `delivered`, never re-sent (the template library's own idempotency key would
// dedupe a second send anyway; this closes the ambiguous-reservation hold).
function customerDunningEmailIdentity(notificationEventKey) {
  const match = /^customer-dunning:([^:]+):(\d+):([A-Za-z0-9_-]+)$/.exec(String(notificationEventKey || ''));
  if (!match) return null;
  const schedule = { id: match[1], episode: match[2] };
  return {
    idempotencyKey: DunningKeys.emailIdempotencyKey(schedule, match[3]),
    triggerEventId: DunningKeys.triggerEventId(schedule, match[3]),
  };
}

function payloadOf(message) {
  const raw = message?.payload_snapshot;
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// The email row must be exactly this reservation's touch, to this customer,
// and name this ledger row: anything else is left held.
function boundToDunningReservation(message, row, identity) {
  return message.idempotency_key === identity.idempotencyKey
    && message.trigger_event_id === identity.triggerEventId
    && message.recipient_type === 'customer'
    && String(message.recipient_id) === String(row.customer_id)
    && String(message.template_key || '').startsWith('invoice.followup_')
    && String(payloadOf(message).collections_ledger_id || '') === String(row.id);
}

// What a bound customer-dunning email row proves about its send:
//   accepted  the provider took it (delivered)
//   terminal  the library durably refused it for a suppression (resolve the leg)
//   unsent    a definite non-send: aborted before the provider or refused by it, with no
//             provider retry scheduled (reopen the reservation for a retry)
//   null      in flight or uncertain (a started handoff, a queued row): stays held
// The "unsent" phases are the template library's own (providerRetryDefinitelyUnsent).
function dunningEmailVerdict(message) {
  if (hasAcceptedEvidence(message)) return 'accepted';
  const status = String(message.status || '').toLowerCase();
  if (status === 'blocked' && /^Suppressed: /.test(String(message.error_message || ''))) return 'terminal';
  if (status !== 'failed' || message.provider_retry_next_at) return null;
  const phase = String(message.provider_handoff_phase || '').toLowerCase();
  const attempt = String(message.send_attempt_token || '');
  if (['pending', 'rejected'].includes(phase)) return attempt && attempt === String(message.provider_handoff_attempt_token || '') ? 'unsent' : null;
  if (phase || message.provider_handoff_attempt_token) return null;
  const legacy = String(message.error_message || '');
  return legacy === 'provider_handoff_pending' || legacy.startsWith('Provider request not started: ') ? 'unsent' : null;
}

const DUNNING_OUTCOME_PATCH = Object.freeze({
  terminal: { resolved: true, resolution: 'email_terminal_refusal' },
  unsent: { code: 'email_not_sent' },
});

async function stampCustomerDunningEmail(message, row, identity, verdict, database) {
  try {
    return await database.transaction(async (trx) => {
      const query = trx('email_messages').where({ id: message.id });
      if (message.send_attempt_token == null) query.whereNull('send_attempt_token');
      else query.where({ send_attempt_token: message.send_attempt_token });
      const current = await query.forUpdate().first();
      if (!current || dunningEmailVerdict(current) !== verdict || !boundToDunningReservation(current, row, identity)) return false;
      const match = { customerId: row.customer_id, channel: 'email', source: DunningKeys.SOURCE, notificationEventKey: metadataOf(row).notificationEventKey };
      let stamped;
      if (verdict === 'accepted') {
        const occurredAt = storedEmailAcceptedAt(current);
        stamped = await ContactLedger.markDelivered({ id: row.id }, { database: trx, match, ...(occurredAt ? { occurredAt } : {}) });
      } else {
        stamped = await ContactLedger.markSendFailed({ id: row.id }, DUNNING_OUTCOME_PATCH[verdict], { database: trx, match });
      }
      if (!stamped) throw new Error('reservation outcome was not stamped');
      return true;
    });
  } catch (err) {
    logger.warn(`[billing-email-reservation] customer dunning reservation stamp failed: ${redactContact(err.message)}`);
    return false;
  }
}

// Bound evidence of a definite non-send reopens (or resolves) the reservation, so a
// worker that died between the email row and recordLegOutcome does not leave it
// neither retryable nor resolved for good. Reflected in the loaded row either way
// (a read-only view too: the caller's pass sees the verdict, nothing is written).
function reflectDunningOutcome(row, verdict) {
  row.metadata = { ...metadataOf(row), send_failed: true, ...(verdict === 'terminal' ? DUNNING_OUTCOME_PATCH.terminal : {}) };
}

// The customer-dunning Email reservations neither delivered nor resolved, by the
// idempotency key their email row carries.
function unsettledDunningReservations(rows) {
  const pending = new Map();
  for (const row of rows || []) {
    const metadata = metadataOf(row);
    if (row.channel !== 'email' || row.source !== DunningKeys.SOURCE || metadata.delivered === true || metadata.resolved === true) continue;
    const identity = customerDunningEmailIdentity(metadata.notificationEventKey);
    if (identity) pending.set(identity.idempotencyKey, { row, identity });
  }
  return pending;
}

async function repairAcceptedCustomerDunningEmails(rows, database, { readOnly = false } = {}) {
  const pending = unsettledDunningReservations(rows);
  const repaired = new Set();
  if (!pending.size) return repaired;
  try {
    const messages = await database('email_messages').whereIn('idempotency_key', [...pending.keys()]);
    for (const message of messages) {
      const hit = pending.get(message.idempotency_key);
      const verdict = hit && dunningEmailVerdict(message);
      if (!verdict || !boundToDunningReservation(message, hit.row, hit.identity)) continue;
      // Already reopened: nothing to write for a definite non-send.
      if (verdict === 'unsent' && metadataOf(hit.row).send_failed === true) continue;
      const written = readOnly || await stampCustomerDunningEmail(message, hit.row, hit.identity, verdict, database);
      if (!written) continue;
      if (verdict === 'accepted') {
        repaired.add(String(hit.row.id));
        // The loaded row keeps its RESERVATION time otherwise: reflect the provider's acceptance time (the value the
        // stamp wrote) so the progress view's deliveredAt / last_touch_at / final_notice_at carry the real one.
        const acceptedAt = storedEmailAcceptedAt(message);
        if (acceptedAt) hit.row.occurred_at = acceptedAt;
      } else reflectDunningOutcome(hit.row, verdict);
    }
  } catch (err) {
    logger.warn(`[billing-email-reservation] customer dunning evidence repair failed: ${redactContact(err.message)}`);
  }
  return repaired;
}

// The read-only twin of markBillingEmailReservationDelivered's binding: the
// stored context must name THIS row (customer, channel, source, event key, invoice).
function acceptedContextMatchesRow(context, row) {
  const match = reservationMatch(context);
  let ids = row.invoice_ids;
  if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
  return String(row.customer_id) === String(match.customerId) && row.channel === match.channel
    && row.source === match.source && metadataOf(row).notificationEventKey === match.notificationEventKey
    && (!match.invoiceId || (Array.isArray(ids) && ids.map(String).includes(String(match.invoiceId))));
}

// A read-only view: accepted evidence bound to a reservation counts as delivered
// for the caller; a terminal refusal or a re-quote release is a write and is left
// to the repairing caller.
function readOnlyAcceptedIds(messages, byLedgerId) {
  const ids = new Set();
  for (const message of messages) {
    if (!hasAcceptedEvidence(message)) continue;
    const context = replayContext(message);
    const candidate = context && byLedgerId.get(String(context.collections_ledger_id));
    if (candidate && acceptedContextMatchesRow(context, candidate)) ids.add(String(candidate.id));
  }
  return ids;
}

// Repair a missed post-acceptance stamp from the canonical email ledger. A
// provider id or handoff phase alone is deliberately insufficient evidence.
async function repairAcceptedBillingChannelEmails(rows, database, { readOnly = false } = {}) {
  const candidates = (rows || []).filter((row) => {
    const metadata = metadataOf(row);
    return row.channel === 'email' && metadata.notificationEventKey
      && metadata.resolved !== true
      // A provider block can invalidate an already accepted previsit copy.
      // Its requote marker must be allowed to retract that delivery witness.
      && (metadata.delivered !== true || row.source === 'previsit_balance_reminder');
  });
  if (!candidates.length) return new Set();
  const keys = candidates.map((row) => {
    const metadata = metadataOf(row);
    return `billing_channel_email:${metadata.notificationEventKey}:email`;
  });
  try {
    const messages = await database('email_messages').whereIn('idempotency_key', keys);
    const byLedgerId = new Map(candidates.map((row) => [String(row.id), row]));
    if (readOnly) return readOnlyAcceptedIds(messages, byLedgerId);
    const repaired = new Set();
    for (const message of messages) {
      const accepted = hasAcceptedEvidence(message);
      const terminal = hasTerminalRefusalEvidence(message);
      const requote = hasRequoteRefusalEvidence(message);
      if (!accepted && !terminal && !requote) continue;
      const context = replayContext(message);
      const candidate = context && byLedgerId.get(String(context.collections_ledger_id));
      if (!candidate) continue;
      if (accepted) {
        const stamped = await markBillingEmailReservationDelivered(message, database);
        if (stamped) repaired.add(String(candidate.id));
        else {
          // A provider retry can replace the accepted attempt after the scan.
          // Classify this pass from the reservation written by the winner.
          const current = await database('collections_contact_ledger')
            .where({ id: candidate.id }).first('metadata');
          candidate.metadata = current ? metadataOf(current) : candidate.metadata;
        }
        continue;
      }
      if (requote) {
        if (await releaseBillingEmailReservationForRequote(message, database)) {
          const reopened = { ...metadataOf(candidate), send_failed: true };
          delete reopened.delivered;
          candidate.metadata = reopened;
        }
        continue;
      }
      if (await resolveBillingEmailReservationRefusal(message, database)) {
        candidate.metadata = { ...metadataOf(candidate), send_failed: true,
          resolved: true, resolution: 'email_terminal_refusal' };
      }
    }
    return repaired;
  } catch (err) {
    logger.warn(`[billing-email-reservation] accepted-evidence repair failed: ${redactContact(err.message)}`);
    return new Set();
  }
}

// billing_channel_email reservations (unchanged) plus customer-level dunning
// email reservations; each repair swallows its own failures.
async function repairAcceptedBillingEmailReservations(rows, database = db, options = {}) {
  const billing = await repairAcceptedBillingChannelEmails(rows, database, options);
  const dunning = await repairAcceptedCustomerDunningEmails(rows, database, options);
  return new Set([...billing, ...dunning]);
}

module.exports = {
  BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX,
  BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX,
  hasAcceptedEvidence,
  markBillingEmailReservationDelivered,
  resolveBillingEmailReservationRefusal,
  releaseBillingEmailReservationForRequote,
  isPrevisitReissue,
  reopenBillingEmailReservationForReissue,
  repairAcceptedBillingEmailReservations,
};
