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
 *     share one transaction. On failure the pause stays (the manual button
 *     still exists) and the error is logged loudly — a caller in a webhook
 *     must never throw over this.
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
 * @param {object} [context] — { paymentIntentId, source } for the audit trail
 */
async function maybeResumeBillingPauseOnPayment(customerId, context = {}) {
  if (!customerId) return { resumed: false, reason: 'no_customer' };
  try {
    const customer = await db('customers')
      .where({ id: customerId })
      .whereNull('deleted_at')
      .first('id', 'service_paused_at', 'service_pause_reason');
    if (!customer?.service_paused_at) return { resumed: false, reason: 'not_paused' };
    if (customer.service_pause_reason !== AUTO_CLEARABLE_REASON) {
      // An operator set this pause for their own reasons — a payment does
      // not overrule a human decision.
      return { resumed: false, reason: 'manual_pause' };
    }

    const pausedAt = customer.service_paused_at;
    const pausedSince = etDateString(new Date(pausedAt));

    const resumed = await db.transaction(async (trx) => {
      const cleared = await trx('customers')
        .where({ id: customerId, service_paused_at: pausedAt })
        .whereNull('deleted_at')
        .update({ service_paused_at: null, service_pause_reason: null });
      if (!cleared) return false;

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
        actor_id: context.source || 'stripe_webhook',
        action: 'customer.billing_pause_cleared',
        resource_type: 'customer',
        resource_id: customerId,
        metadata: {
          paused_since: pausedSince,
          pause_reason: AUTO_CLEARABLE_REASON,
          trigger: 'payment_succeeded',
          payment_intent_id: context.paymentIntentId || null,
        },
        critical: true,
        trx,
      });

      return true;
    });

    if (!resumed) return { resumed: false, reason: 'pause_changed' };

    logger.info(`[billing-pause] auto-cleared for customer ${customerId} on payment ${context.paymentIntentId || '(unknown PI)'} (was paused ${pausedSince})`);
    return { resumed: true, pausedSince };
  } catch (err) {
    // The payment already settled — a bookkeeping failure here must never
    // bubble into the webhook. The pause stays; the manual button covers it.
    logger.error(`[billing-pause] auto-clear failed for customer ${customerId}: ${err.message}`);
    return { resumed: false, reason: 'error' };
  }
}

module.exports = { maybeResumeBillingPauseOnPayment, AUTO_CLEARABLE_REASON };
