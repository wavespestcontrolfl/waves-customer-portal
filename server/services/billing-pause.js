/**
 * Billing pause — automatic clear on payment (owner ruling 2026-08-01:
 * "billing goes back to normal once they pay").
 *
 * billing-cron sets customers.service_paused_at + service_pause_reason
 * 'autopay_final_failure' when the 3-retry ladder exhausts, and
 * processMonthlyBilling then skips the customer. #3148 added the manual
 * "Clear billing pause" control; this module is the automatic path: a
 * successful payment from the customer proves the tender works and the
 * debt is being paid, so the pause clears on its own.
 *
 * Contracts, mirroring the manual endpoint (admin-customers resume-service):
 *   - ONLY 'autopay_final_failure' pauses auto-clear. A pause an operator
 *     set by hand (any other reason value) is a human decision and stays
 *     until a human clears it.
 *   - Compare-and-swap on the exact pause that was read, so a NEWER pause
 *     applied between the read and the write is never wiped.
 *   - The clear, the customer-timeline note and the critical audit event
 *     share one transaction. The function itself never throws; an
 *     infrastructure failure comes back as { reason: 'error', error } and
 *     the caller chooses — the webhook dispatch rethrows it so Stripe
 *     redelivers the event and the clear is retried.
 *   - Clearing the pause claims nothing about future collection (the
 *     #3148 lesson): dues resume on the next billing day at most, other
 *     billing guards still apply, and the paused months are never
 *     back-billed (isBillingDayMatch + the already-charged-this-month
 *     guard mean at most one charge).
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { recordAuditEvent } = require('./audit-log');

const AUTO_CLEARABLE_REASON = 'autopay_final_failure';

/**
 * Clear a customer's billing pause because a payment of theirs settled.
 * Never throws. Returns { resumed, reason }.
 *
 * @param {string} customerId
 * @param {object} [context] — { paymentIntentId, source, settledAt } for the
 *   audit trail and the ordering guard. settledAt (Date) is REQUIRED to
 *   clear: webhooks can arrive late, and a success that predates the pause
 *   proves nothing about the tender that later exhausted the ladder.
 */
async function maybeResumeBillingPauseOnPayment(customerId, context = {}) {
  if (!customerId) return { resumed: false, reason: 'no_customer' };
  try {
    // The ordering guard needs a real settlement time. Without one we
    // cannot tell a fresh payment from a delayed redelivery, so we do not
    // clear — the manual button covers it (fail toward the pause staying).
    const settledAt = context.settledAt instanceof Date && !Number.isNaN(context.settledAt.getTime())
      ? context.settledAt
      : null;
    if (!settledAt) return { resumed: false, reason: 'no_settlement_time' };

    // Read INSIDE the transaction with a row lock: billing-cron's pause
    // UPDATE may have acquired this customer row and not yet committed, and
    // an unlocked read would see the pre-pause version, answer not_paused,
    // and let the cron commit its pause AFTER this webhook finishes —
    // stranding a customer who just paid. FOR UPDATE waits for any
    // in-flight pause write to commit before deciding. The mirror ordering
    // is covered by the cron itself: when THIS lock is held first, its
    // atomic whereNotExists sees the (already committed) paid row and
    // vetoes the pause.
    const outcome = await db.transaction(async (trx) => {
      const customer = await trx('customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .forUpdate()
        .first('id', 'service_paused_at', 'service_pause_reason');
      if (!customer?.service_paused_at) return { resumed: false, reason: 'not_paused' };
      if (customer.service_pause_reason !== AUTO_CLEARABLE_REASON) {
        // An operator set this pause for their own reasons — a payment does
        // not overrule a human decision.
        return { resumed: false, reason: 'manual_pause' };
      }
      // A pause applied AFTER this payment settled was caused by failures
      // this payment does not answer for — a delayed webhook for an old
      // success must not clear it. With one exception: the clear runs AFTER
      // the webhook's durable ledger writes, so a pause the cron applied
      // SECONDS after the settlement (the exhaustion racing the payment)
      // legitimately postdates settledAt. The retry ladder is DAY-spaced
      // (RETRY_DELAYS_DAYS), so no genuinely newer failure cycle can
      // produce a pause within minutes of a settlement — an hour of slack
      // separates the race (clear it) from a stale redelivery (leave it)
      // with three orders of magnitude to spare on each side.
      const RACE_SLACK_MS = 60 * 60 * 1000;
      if (new Date(customer.service_paused_at).getTime() > settledAt.getTime() + RACE_SLACK_MS) {
        return { resumed: false, reason: 'pause_newer_than_payment' };
      }

      const pausedAt = customer.service_paused_at;
      const pausedSince = etDateString(new Date(pausedAt));

      // Row is locked, but keep the CAS shape anyway — it is free, and it
      // documents the invariant the manual endpoint shares.
      const cleared = await trx('customers')
        .where({ id: customerId, service_paused_at: pausedAt })
        .whereNull('deleted_at')
        .update({ service_paused_at: null, service_pause_reason: null });
      if (!cleared) return { resumed: false, reason: 'pause_changed' };

      await trx('customer_interactions').insert({
        customer_id: customerId,
        interaction_type: 'note',
        subject: 'Billing pause cleared',
        body: `Billing pause cleared automatically — a payment succeeded (paused ${pausedSince}, reason: ${AUTO_CLEARABLE_REASON}). `
          + 'This removes the pause block only — other billing guards (autopay state, '
          + 'plan type, prepaid coverage) still apply. The paused months are not back-billed.',
        admin_user_id: null,
      });

      await recordAuditEvent({
        actor_type: 'system',
        // actor_id is a UUID column — a string here fails the INSERT in
        // Postgres, rolls back the transaction, and the never-throw catch
        // would hide it: the feature would silently never fire. System
        // actors pass null (repo convention); the source lives in metadata.
        actor_id: null,
        action: 'customer.billing_pause_cleared',
        resource_type: 'customer',
        resource_id: customerId,
        metadata: {
          paused_since: pausedSince,
          pause_reason: AUTO_CLEARABLE_REASON,
          trigger: 'payment_succeeded',
          source: context.source || 'stripe_webhook',
          payment_intent_id: context.paymentIntentId || null,
          settled_at: settledAt.toISOString(),
        },
        critical: true,
        trx,
      });

      return { resumed: true, pausedSince };
    });

    if (outcome.resumed) {
      logger.info(`[billing-pause] auto-cleared for customer ${customerId} on payment ${context.paymentIntentId || '(unknown PI)'} (was paused ${outcome.pausedSince})`);
    }
    return outcome;
  } catch (err) {
    // Infrastructure failure, not a business outcome. The pause stays for
    // now; the CALLER decides whether to surface it — the stripe-webhook
    // dispatch throws on this reason so the event 500s and Stripe
    // redelivers, retrying the clear (handlers are idempotent by contract).
    logger.error(`[billing-pause] auto-clear failed for customer ${customerId}: ${err.message}`);
    return { resumed: false, reason: 'error', error: err };
  }
}

module.exports = { maybeResumeBillingPauseOnPayment, AUTO_CLEARABLE_REASON };
