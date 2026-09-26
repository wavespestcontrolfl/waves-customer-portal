'use strict';

const db = require('../models/db');
const logger = require('./logger');
const ContactLedger = require('./collections/contact-ledger');
const { readStoredBillingReplayContext } = require('./email-template-library');
const BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX = 'Billing email terminal refusal: ';

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
    source: context.source_entry_point,
    notificationEventKey: context.notificationEventKey,
    ...(context.invoice_id ? { invoiceId: context.invoice_id } : {}),
  };
}

// Accepted provider bookkeeping and a verified delivered webhook both call
// this best-effort writer. It never throws back into accepted-send handling:
// a missed stamp leaves the reservation held for reminderProgress repair.
async function markBillingEmailReservationDelivered(message, database = db) {
  if (!hasAcceptedEvidence(message)) return false;
  const context = replayContext(message);
  if (!context) return false;
  try {
    return await ContactLedger.markDelivered(
      { id: context.collections_ledger_id },
      { database, match: reservationMatch(context) },
    );
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
      && metadata.delivered !== true && metadata.resolved !== true;
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
      if (!accepted && !terminal) continue;
      const context = replayContext(message);
      const candidate = context && byLedgerId.get(String(context.collections_ledger_id));
      if (!candidate) continue;
      if (accepted) {
        if (await markBillingEmailReservationDelivered(message, database)) repaired.add(String(candidate.id));
      } else {
        await resolveBillingEmailReservationRefusal(message, database);
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
  hasAcceptedEvidence,
  markBillingEmailReservationDelivered,
  resolveBillingEmailReservationRefusal,
  repairAcceptedBillingEmailReservations,
};
