const logger = require('./logger');
const { logAutopay } = require('./autopay-log');
const { getChargeableAutopayMethod } = require('./autopay-eligibility');
const PaymentLifecycleEmail = require('./payment-lifecycle-email');

/**
 * Turn a customer's Auto Pay OFF — the single disable path shared by the
 * customer portal (PUT /api/billing/autopay with autopay_enabled:false) and
 * the Intelligence Bar's staff Auto Pay-off step (remove_saved_payment_method).
 *
 * The customer-row update every disable writes. Turning Auto Pay off also
 * clears a pause: there is nothing left to pause or resume.
 */
const AUTOPAY_OFF_UPDATES = Object.freeze({
  autopay_enabled: false,
  autopay_paused_until: null,
  autopay_pause_reason: null,
});

/**
 * The locked half, run INSIDE the caller's transaction. `updates` is the full
 * customers-row patch (the portal may add a method pointer or billing day to
 * the same request; staff pass AUTOPAY_OFF_UPDATES alone).
 *
 * Lock order = CUSTOMER first, then the method rows (pre-push r2 P1: every
 * Auto Pay mutation — enrollment, removal, set-default, the detached webhook
 * — takes the same order, so removal vs replacement can never deadlock).
 *
 * Resolves { transition, methodId }:
 *  - transition is true only for the call that performs the enabled→disabled
 *    flip under the lock: two overlapping disables both read "enabled" before
 *    either locks, and the second must not send a second Auto Pay-off email
 *    (GH codex r1 P2). Nullable flag: only explicit false is "off"
 *    (customerOnAutopay parity, GH codex r3 P2) — a NULL-flag customer turning
 *    Auto Pay off IS a transition and gets the notice.
 *  - methodId is the method the notice names: the one in charge immediately
 *    before the disable, read under the lock — a pre-lock read can be stale if
 *    a switch landed in between (GH codex r2 P2).
 */
async function disableAutopayInTransaction(trx, customerId, { updates, details = {} }) {
  const locked = await trx('customers').where({ id: customerId }).forUpdate().first('id', 'autopay_enabled', 'autopay_payment_method_id');
  const transition = locked?.autopay_enabled !== false;
  let methodId = locked?.autopay_payment_method_id || null;
  if (transition && !methodId) {
    // Legacy enrollment without a pointer: the method in charge is the
    // default+enabled fallback collection would bill — resolve it under the
    // lock BEFORE the flags are cleared below (GH codex r4 P2).
    const fallback = await getChargeableAutopayMethod({ id: customerId, ...locked }, trx);
    methodId = fallback?.id || null;
  }

  await trx('customers').where({ id: customerId }).update(updates);
  await trx('payment_methods').where({ customer_id: customerId }).update({ autopay_enabled: false });
  // The opt-out EVENT commits with the opt-out STATE: this row is what
  // enrollConsentedMethod's opted_out_after_authorization guard reads (by
  // event_type alone, so `details` may carry a source), so a post-commit
  // best-effort write left a gap where a delayed webhook enrollment could
  // land after the disable committed but before (or without) the event row —
  // overwriting a real opt-out.
  await logAutopay(customerId, 'autopay_disabled', { details, db: trx, required: true });
  return { transition, methodId };
}

/**
 * Negative counterpart of the Auto Pay-enabled notice (gated inside the
 * sender, GATE_PAYMENT_METHOD_CHANGE_EMAILS); the pointer that was in charge
 * names the method. Send it only when the disable reported a transition.
 * Never rejects: the portal fires it and forgets, staff await it so the
 * method row is still there to name when the removal that follows deletes it.
 */
function sendAutopayDisabledNotice({ customerId, paymentMethodId }) {
  return PaymentLifecycleEmail.sendAutopayDisabled({
    customerId,
    paymentMethodId,
    disabledAt: new Date(),
  }).catch((emailErr) => {
    logger.warn(`[autopay-disable] autopay disabled email failed for customer ${customerId}: ${emailErr.message}`);
  });
}

module.exports = { AUTOPAY_OFF_UPDATES, disableAutopayInTransaction, sendAutopayDisabledNotice };
