const db = require('../models/db');
const StripeService = require('./stripe');
const logger = require('./logger');
const PaymentLifecycleEmail = require('./payment-lifecycle-email');
const { logAutopay } = require('./autopay-log');
const { isPaused, getAutopaySelectedMethodIds } = require('./autopay-eligibility');

/**
 * Remove one saved payment method — the single removal path shared by the
 * customer portal (DELETE /api/billing/cards/:id) and the admin customer
 * profile (DELETE /api/admin/customers/:id/payment-methods/:methodId).
 *
 * With `guard` on (owner ruling 2026-08-27) the method Auto Pay is USING →
 * 409 autopay_method_in_use; anything else → detach with NO Auto Pay
 * mutation. "Using" comes from getAutopaySelectedMethodIds — the charge
 * resolver's pick plus the enrollment pointer (expired included, paused
 * included) — so removal, display, and charging can never disagree about
 * which card is Auto Pay's. Guard off is the legacy portal path: remove
 * unconditionally and let removeCard cascade-disable Auto Pay.
 *
 * The guard check and the detach run under ONE transaction holding FOR
 * UPDATE on the customer row and the card row (pre-push r1 P0): PUT
 * /billing/autopay, PUT /cards/:id/default and enrollConsentedMethod all
 * write those rows inside their own transactions, so an Auto Pay switch
 * onto this card cannot land between "not in use" and the detach — it waits
 * for this commit and then re-validates the row. Holding the lock across
 * the Stripe detach is bounded by the Stripe client timeout and is the price
 * of a guard that cannot be raced.
 *
 * Resolves `{ status, body, removedMethod }` — the caller sends status/body.
 */
async function removePaymentMethod({ customerId, methodId, guard, source }) {
  let outcome = null; // { status, body } when the request ends early
  let removedMethod = null;
  let autopayDisabled = false;
  await db.transaction(async (trx) => {
    const customer = await trx('customers')
      .where({ id: customerId })
      .forUpdate()
      .first('id', 'autopay_enabled', 'autopay_payment_method_id', 'autopay_paused_until', 'ach_status');
    const card = await trx('payment_methods')
      .where({ id: methodId, customer_id: customerId })
      .forUpdate()
      .first();

    if (!card) {
      outcome = { status: 404, body: { error: 'Payment method not found' } };
      return;
    }

    if (guard) {
      // Fail CLOSED on a broken read: refusing a removal is recoverable
      // (the caller retries); detaching the in-charge card is not.
      let selectedIds;
      try {
        selectedIds = await getAutopaySelectedMethodIds(customer, trx, { rethrow: true });
      } catch (readErr) {
        logger.error(`[payment-method-removal] removal guard read failed for customer ${customerId}: ${readErr.message}`);
        outcome = { status: 503, body: { error: 'Could not check Auto Pay right now — please try again.' } };
        return;
      }
      if (selectedIds.includes(String(card.id))) {
        // Same ET-aware predicate the display and collection use — a
        // stale past autopay_paused_until is NOT paused (GH codex r1 P2).
        const paused = isPaused(customer);
        outcome = {
          status: 409,
          body: {
            code: 'autopay_method_in_use',
            error: paused
              ? 'Auto Pay is paused, not off, and it is using this payment method. Add another payment method or turn off Auto Pay before removing it.'
              : 'This payment method is currently used for Auto Pay. Add another payment method or turn off Auto Pay before removing it.',
            autopay: { enabled: true, paused, methodId: card.id },
          },
        };
        return;
      }
    }

    // Nullable flag: only explicit false is off (resolver parity, GH codex r4 P2).
    const wasEnabled = customer?.autopay_enabled !== false;
    await StripeService.removeCard(customerId, methodId, { cascadeAutopay: !guard, db: trx });
    removedMethod = card;
    // Did Auto Pay actually go off with this removal? Only the legacy
    // cascade (guard off) can do that, and it swallows its own failures —
    // so the answer comes from a re-read of the customer row under the
    // lock, never from the removed row's stale flag (GH codex r1 P1).
    if (wasEnabled) {
      const after = await trx('customers').where({ id: customerId }).first('autopay_enabled');
      // Only explicit false is a transition (nullable rule) — GH codex r4 hook P1.
      autopayDisabled = after?.autopay_enabled === false;
    }
  });

  if (outcome) {
    // Make the refusal observable (owner ask 2026-08-28): audit only, not
    // guard input — written after the transaction, best-effort. The
    // firsts watch (payment-method-firsts-watch) reports the first one.
    if (outcome.body?.code === 'autopay_method_in_use') {
      void logAutopay(customerId, 'removal_refused', {
        paymentMethodId: outcome.body.autopay?.methodId || null,
        details: { source, paused: !!outcome.body.autopay?.paused },
      }).catch((logErr) => {
        logger.warn(`[payment-method-removal] removal_refused log failed for customer ${customerId}: ${logErr.message}`);
      });
    }
    return { ...outcome, removedMethod: null };
  }

  // Lifecycle notice (gated inside the sender). The customer cares about the
  // resulting account state, not which surface removed the method (owner
  // ruling 2026-08-27). The row is gone — pass the snapshot. Under the guard
  // a removed method was never in charge, so no autopay note; the legacy
  // cascade case reports what committed. The sender's idempotency key is the
  // method row id, so the detached webhook that follows this detach cannot
  // send a second notice.
  void PaymentLifecycleEmail.sendPaymentMethodRemoved({
    customerId,
    method: removedMethod,
    autopayDisabled,
    removedAt: new Date(),
  }).catch((emailErr) => {
    logger.warn(`[payment-method-removal] payment method removed email failed for customer ${customerId}: ${emailErr.message}`);
  });

  return { status: 200, body: { success: true, message: 'Payment method removed' }, removedMethod };
}

module.exports = { removePaymentMethod };
