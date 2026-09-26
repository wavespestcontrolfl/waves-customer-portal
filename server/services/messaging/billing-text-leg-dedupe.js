'use strict';

/**
 * Text-leg idempotency for the explicit billing-channel router
 * (billing-channel-routing.js's dispatchBillingChannels -> sendBillingLeg
 * -> the per-leg recursive sendCustomerMessageCore in
 * send-customer-message.js).
 *
 * Email and App already dedupe an explicit billing leg against the SAME
 * notificationEventKey a replay (a producer's deferred replay row
 * re-entering the router) re-fans-out under:
 *   - Email: idempotencyKey `billing_channel_email:${notificationEventKey}:email`
 *     (billing-channel-email.js), enforced by email-template-library.js's
 *     idempotency_key lookup + unique-violation collision handling
 *     (email_messages.idempotency_key is a real UNIQUE index).
 *   - App:   notifyCustomer(..., { dedupeKey: notificationEventKey })
 *     (push-channel-routing.js ~475), enforced by notification-service.js's
 *     pg_advisory_xact_lock(hashtext('<customerId>:<dedupeKey>')) + a
 *     metadata dedupeKey lookup, both inside one transaction.
 * Text had NO event dedupe at all — a replay re-texted a customer whose
 * Text already went out. This module closes that gap.
 *
 * There is no unique index backing this lookup the way email_messages has
 * one for idempotency_key (adding one is a migration, and pushed
 * migrations are frozen — see docs), so correctness here comes from an
 * advisory lock, not a constraint: `withBillingTextLegLock` holds
 * pg_advisory_xact_lock('billing_text_leg:<customerId>:<notificationEventKey>')
 * across the check AND the actual provider handoff, so a second, genuinely
 * concurrent replay on the exact same key blocks until this attempt's
 * outcome — and, on acceptance, twilio.js's own sms_log insert — is
 * durably committed, rather than racing it. Holding a transaction across
 * the Twilio HTTP call is not a new shape in this codebase:
 * server/utils/customer-comms-lock.js's withSmsConsentLock already does
 * exactly this for other SMS callers (lead-response-tools.js,
 * reschedule-link-promises.js, visit-completion-summary.js) — "The
 * callback covers final authority reads and the SDK call only." This
 * reuses that same posture for a new, narrow key, not a new mechanism.
 *
 * Scope: explicit billing Text legs ONLY —
 * metadata.billingDeliveryLeg === 'sms' with a non-empty
 * metadata.notificationEventKey and a customerId. A legacy SMS send (no
 * billingDeliveryLeg — every other caller of send-customer-message.js /
 * TwilioService.sendSMS) or a non-billing send never reaches the lookup at
 * all and is byte-identical to before this lane.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { excludeUnresolvedSendReservations } = require('./review-ask-reservation');

// A provider handoff Twilio genuinely accepted for this exact notice.
// Never 'failed'/'blocked' (a refused attempt still owes a resend) and
// never 'scheduled'/'sending' — a producer's own queued/in-flight replay
// row for this same key IS the replay currently under way, not prior
// acceptance evidence, and must not dedupe itself away.
const ACCEPTED_STATUSES = ['queued', 'sent', 'delivered'];

function lockKey(customerId, notificationEventKey) {
  return `billing_text_leg:${customerId}:${notificationEventKey}`;
}

// Durable evidence a Text leg for this exact customer + notice already
// reached the provider. Status-scoped to ACCEPTED_STATUSES (excludes
// 'sending'/'scheduled'), so an unresolved review-ask/reply send
// reservation cannot match structurally either way —
// excludeUnresolvedSendReservations applied on top regardless, matching
// this codebase's sms_log general-reader source guard
// (server/tests/sms-log-general-reader-source-guard.test.js).
async function findAcceptedBillingTextLeg(conn, customerId, notificationEventKey) {
  return excludeUnresolvedSendReservations(
    conn('sms_log')
      .where({ customer_id: customerId, direction: 'outbound' })
      .whereRaw("metadata->>'billingDeliveryLeg' = 'sms'")
      .whereRaw("metadata->>'notificationEventKey' = ?", [notificationEventKey])
      .whereIn('status', ACCEPTED_STATUSES),
  )
    .orderBy('created_at', 'desc')
    .first(['twilio_sid', 'created_at']);
}

// Same shape family as the Email/App deduped results (billing-channel-
// email.js's acceptedResult spreading result.deduped;
// email-template-library.js's dedupedResultForExistingMessage;
// push-channel-routing.js's appNotification?.push?.deduped branch): sent +
// accepted + deduped, carrying the ORIGINAL provider evidence so
// downstream readers (e.g. send-customer-message.js's
// recordReceiptSmsDelivery, which regex-matches providerMessageId against
// a real Twilio SID) see the real sid, not a synthetic one.
function dedupedAcceptance(row) {
  return {
    sent: true,
    provider: 'twilio',
    deliveryOutcome: 'accepted',
    deduped: true,
    providerMessageId: row.twilio_sid || null,
    sentAt: row.created_at,
  };
}

/**
 * Runs an explicit billing Text leg's check-then-send under one advisory
 * lock. `send` is the caller's actual provider dispatch (a zero-arg
 * thunk) — invoked EXACTLY ONCE, whether or not this guard applies.
 *
 * Not an explicit billing Text leg (no billingDeliveryLeg === 'sms', no
 * notificationEventKey, or no customerId) -> `send()` runs unprotected,
 * byte-identical to before this lane — no lock, no lookup.
 *
 * An explicit billing Text leg with a prior accepted send for this exact
 * key -> `send()` never runs; the deduped acceptance is returned instead.
 * Otherwise the lock stays held across `send()` itself (the actual Twilio
 * handoff), so a second, truly concurrent replay on the SAME key blocks on
 * the lock rather than racing this one.
 */
const DEDUPE_RETRY_MS = 5 * 60 * 1000;

async function withBillingTextLegLock(input, send) {
  const metadata = input?.metadata || {};
  if (metadata.billingDeliveryLeg !== 'sms') return send();
  const notificationEventKey = String(metadata.notificationEventKey || '').trim();
  const customerId = input?.customerId;
  if (!notificationEventKey || !customerId) return send();

  // Tracks whether `send()` was already handed off before a throw, so the
  // fail-open catch below can never invoke it a second time (double-send).
  let sendInvoked = false;
  const runSend = () => {
    sendInvoked = true;
    return send();
  };

  try {
    return await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [lockKey(customerId, notificationEventKey)]);
      const prior = await findAcceptedBillingTextLeg(trx, customerId, notificationEventKey);
      if (prior) return dedupedAcceptance(prior);
      return runSend();
    });
  } catch (err) {
    if (sendInvoked) throw err;
    // The lock or the lookup failed before any send. Without the lookup we
    // can't rule out a prior accepted text, so fail closed with a
    // schedulable hold (in REPLAY_HOLD_CODES): nothing is sent now and the
    // producer's replay retries once the database is reachable.
    logger.warn(`[billing-text-leg-dedupe] lock/lookup failed before send, holding for retry: ${err.message}`);
    return {
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_TEXT_DEDUPE_UNAVAILABLE',
      error: 'Billing text dedupe state is unavailable', retryable: true, deferred: true,
      nextAllowedAt: new Date(Date.now() + DEDUPE_RETRY_MS).toISOString(),
    };
  }
}

module.exports = {
  withBillingTextLegLock,
  findAcceptedBillingTextLeg,
  ACCEPTED_STATUSES,
};
