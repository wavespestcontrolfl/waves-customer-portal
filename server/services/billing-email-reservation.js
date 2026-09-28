'use strict';

const db = require('../models/db');
const logger = require('./logger');
const ContactLedger = require('./collections/contact-ledger');
const { readStoredBillingReplayContext } = require('./email-template-library');
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
    logger.warn(`[billing-email-reservation] stored context unreadable: ${err.message}`);
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
    logger.warn(`[billing-email-reservation] delivered stamp failed: ${err.message}`);
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
    logger.warn(`[billing-email-reservation] refusal stamp failed: ${err.message}`);
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
async function releaseBillingEmailReservationForRequote(message, database = db) {
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
      if (Number(claimReleased) !== 1) throw new Error('pinned previsit claim was not released');
      const retired = await trx('email_messages').where({ id: current.id }).update({
        error_message: String(current.error_message).replace(BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX,
          'Billing email old quote retired: '),
        updated_at: new Date(),
      });
      if (Number(retired) !== 1) throw new Error('old quote marker was not retired');
      return true;
    });
  } catch (err) {
    logger.warn(`[billing-email-reservation] changed-quote release failed: ${err.message}`);
    return false;
  }
}

function metadataOf(row) {
  if (typeof row?.metadata !== 'string') return row?.metadata || {};
  try { return JSON.parse(row.metadata) || {}; } catch { return {}; }
}

// Repair a missed post-acceptance stamp from the canonical email ledger. A
// provider id or handoff phase alone is deliberately insufficient evidence.
async function repairAcceptedBillingEmailReservations(rows, database = db) {
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
    logger.warn(`[billing-email-reservation] accepted-evidence repair failed: ${err.message}`);
    return new Set();
  }
}

module.exports = {
  BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX,
  BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX,
  hasAcceptedEvidence,
  markBillingEmailReservationDelivered,
  resolveBillingEmailReservationRefusal,
  releaseBillingEmailReservationForRequote,
  repairAcceptedBillingEmailReservations,
};
