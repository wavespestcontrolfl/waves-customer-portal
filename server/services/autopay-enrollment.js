// Shared consent-gated autopay enrollment.
//
// One routine, three call sites (stripe-webhook save-card mirror, the pay
// page's /consent + /setup-complete endpoints, and the portal add-card
// route), so the enrollment semantics can't drift between save surfaces
// (Codex #2507): a saved method is enrolled in Auto Pay only when an
// immutable payment_method_consents row EXISTS for it — the consent row is
// the authorization artifact, never PI metadata alone.
//
// Semantics (extracted verbatim from the stripe-webhook mirror, rounds 2-11):
//  - The incumbent = the customer's default + autopay-enabled chargeable
//    Stripe row. An incumbent bank method (either alias: 'ach' /
//    'us_bank_account') does NOT count while customers.ach_status is
//    non-empty and not 'active' — collection refuses it, so deferring to it
//    would point the customer at a method that never charges.
//  - The target row gets autopay_enabled=true. It claims is_default only
//    when there is no healthy incumbent (unsetting other rows' is_default
//    first); a healthy incumbent keeps the default role.
//  - customers.autopay_enabled flips true and autopay_payment_method_id
//    points at whichever method is actually in charge (incumbent || target).
//  - Logged as autopay_enabled with the caller's source tag. Skipped when
//    the customer is already enrolled on the same method (idempotent — the
//    /consent endpoint and the webhook may both complete the same signup).
const db = require('../models/db');
const logger = require('./logger');

const BANK_ALIASES = ['ach', 'us_bank_account'];

/**
 * Enroll an already-saved payment method in autopay. The CALLER is
 * responsible for the consent gate (a payment_method_consents row must
 * exist / have just been recorded) and for ownership checks on how the
 * method row was resolved.
 *
 * @param {object} opts
 * @param {string} opts.customerId
 * @param {string} [opts.paymentMethodId]        payment_methods.id of the target row
 * @param {string} [opts.stripePaymentMethodId]  alternative lookup key
 * @param {string} opts.source                   autopay_log source tag
 * @param {object} [opts.details]                extra autopay_log details
 * @param {Date}   [opts.authorizedAt]           when the customer actually
 *   authorized this save (SetupIntent/PaymentIntent `created`). Passed by the
 *   DELAYED completion paths (ACH micro-deposits verify days later): an
 *   explicit Auto Pay disable recorded AFTER that moment wins — the stale
 *   authorization must not silently re-enroll the customer.
 * @param {object} [opts.dbh] Knex handle to open the enrollment transaction
 *   on — pass an OUTER transaction to run the enrollment as a savepoint
 *   inside it (the appointment auto-secure serializes enrollment with its
 *   visit-row lock this way, Codex #3361 r26 P1). In that mode the side
 *   effects honor the outer transaction's fate (Codex #3361 r27 P1): the
 *   autopay_log audit row is written THROUGH the outer handle (required —
 *   an audit failure rolls the enrollment back with it, all-or-nothing),
 *   and the gated confirmation email is NOT sent here — it is returned as
 *   `sendEnrollmentConfirmation` for the caller to fire after its actual
 *   commit, so a rolled-back enrollment can never have already told the
 *   customer "Auto Pay enabled". Default: the global pool, the existing
 *   standalone behavior (immediate warn-only log + immediate email) for
 *   every other caller.
 * @returns {{ enrolled: boolean, reason?: string, methodId?: string, inChargeMethodId?: string, sendEnrollmentConfirmation?: Function }}
 */
async function enrollConsentedMethod({ customerId, paymentMethodId, stripePaymentMethodId, source, details = {}, authorizedAt = null, scheduledServiceId = null, dbh = db }) {
  if (!customerId || (!paymentMethodId && !stripePaymentMethodId)) {
    return { enrolled: false, reason: 'missing_args' };
  }

  let target;
  let inChargeMethodId;
  const outcome = await dbh.transaction(async (trx) => {
    // Serialize per customer: FOR UPDATE on the customer row makes the
    // read → unset-defaults → set-target → customer-pointer sequence below
    // atomic against a concurrent enrollment. Without it, two completions
    // racing (e.g. /consent and the webhook) could interleave and leave
    // multiple is_default rows — and collection picks its method with an
    // unordered .first(), i.e. charges whichever the planner returns.
    const custRow = await trx('customers')
      .where({ id: customerId })
      .forUpdate()
      .first('id', 'ach_status', 'autopay_enabled', 'autopay_payment_method_id');
    if (!custRow) return { enrolled: false, reason: 'customer_not_found' };

    // Payer routing UNDER the enrollment lock (Codex #3395 r10 P1): the
    // callers' payer pre-checks run outside this transaction, so an admin
    // payer assignment can commit between their read and this lock —
    // enrolling the homeowner's method on a payer-billed account points
    // self-pay charging at the wrong party. Re-check against the locked
    // snapshot; a resolver failure THROWS (fail closed) so the transaction
    // rolls back and each caller's retry semantics apply. scheduledServiceId
    // scopes the check to the visit being secured (r11 P1): a per-visit
    // self_pay_override on a payer-billed account is customer-paid — the
    // previsit auto-secure path must still enroll for it.
    const resolvedPayer = await require('./payer').resolveForInvoice({
      database: trx,
      customerId,
      scheduledServiceId,
      throwOnError: true,
    });
    if (resolvedPayer?.payerId) {
      return { enrolled: false, reason: 'payer_billed' };
    }

    if (authorizedAt instanceof Date && !Number.isNaN(authorizedAt.getTime())) {
      const laterOptOut = await trx('autopay_log')
        .where({ customer_id: customerId, event_type: 'autopay_disabled' })
        .where('created_at', '>', authorizedAt)
        .first('id');
      if (laterOptOut) {
        return { enrolled: false, reason: 'opted_out_after_authorization' };
      }
    }

    const targetQuery = trx('payment_methods').where({ customer_id: customerId, processor: 'stripe' });
    if (paymentMethodId) targetQuery.where({ id: paymentMethodId });
    else targetQuery.where({ stripe_payment_method_id: stripePaymentMethodId });
    target = await targetQuery.whereNotNull('stripe_payment_method_id').first();
    if (!target) return { enrolled: false, reason: 'method_not_found' };

    // The customer-level ACH block applies to the TARGET too, not just the
    // incumbent (Codex #2507 round-5 P2): while ach_status is
    // needs_verification/suspended, customerOnAutopay refuses every non-card
    // method, so enrolling a fresh bank account would flip the flags onto a
    // method collection keeps rejecting. The method stays saved
    // card-on-file; enrollment happens through the normal surfaces once the
    // bank state clears.
    const achUnhealthy = !!(custRow.ach_status && custRow.ach_status !== 'active');
    if (BANK_ALIASES.includes(target.method_type) && achUnhealthy) {
      return { enrolled: false, reason: 'ach_blocked', methodId: target.id };
    }

    let incumbent = await trx('payment_methods')
      .where({
        customer_id: customerId,
        processor: 'stripe',
        is_default: true,
        autopay_enabled: true,
      })
      .whereNotNull('stripe_payment_method_id')
      .orderBy('updated_at', 'desc')
      .first('id', 'method_type');
    if (BANK_ALIASES.includes(incumbent?.method_type) && achUnhealthy) {
      incumbent = null;
    }

    const alreadyInCharge = incumbent && incumbent.id === target.id;
    if (alreadyInCharge && custRow.autopay_enabled && custRow.autopay_payment_method_id === target.id) {
      return { enrolled: false, reason: 'already_enrolled', methodId: target.id, inChargeMethodId: target.id };
    }

    if (!incumbent) {
      // No healthy method in charge — the target takes the default slot.
      await trx('payment_methods')
        .where({ customer_id: customerId })
        .whereNot({ id: target.id })
        .update({ is_default: false });
      await trx('payment_methods')
        .where({ id: target.id })
        .update({ autopay_enabled: true, is_default: true });
    } else if (!alreadyInCharge) {
      // A healthy incumbent keeps the default role; the target is enrolled
      // but does not displace it.
      await trx('payment_methods')
        .where({ id: target.id })
        .update({ autopay_enabled: true });
    }

    inChargeMethodId = incumbent ? incumbent.id : target.id;
    await trx('customers')
      .where({ id: customerId })
      .update({ autopay_enabled: true, autopay_payment_method_id: inChargeMethodId });
    return null; // enrolled — post-commit side effects run below
  });
  if (outcome) return outcome;
  // Savepoint mode (dbh is a caller's open transaction): every side effect
  // must share the OUTER transaction's fate (Codex #3361 r27 P1) — after
  // the savepoint releases the enrollment is not committed yet, so a
  // global-pool audit write or an immediate email here would survive an
  // outer rollback that undoes the Auto Pay flags themselves.
  const runningInCallerTrx = dbh.isTransaction === true;
  if (runningInCallerTrx) {
    // Audit through the outer handle, REQUIRED: inside an open Postgres
    // transaction a failed insert poisons the transaction anyway, so
    // swallowing it would only produce a confusing later failure — surface
    // it and let the whole enrollment roll back atomically with its audit.
    await require('./autopay-log').logAutopay(customerId, 'autopay_enabled', {
      paymentMethodId: inChargeMethodId,
      details: { source, ...details },
      db: dbh,
      required: true,
    });
  } else {
    try {
      await require('./autopay-log').logAutopay(customerId, 'autopay_enabled', {
        paymentMethodId: inChargeMethodId,
        details: { source, ...details },
      });
    } catch (logErr) {
      logger.warn(`[autopay-enrollment] log failed for customer ${customerId}: ${logErr.message}`);
    }
  }
  logger.info(`[autopay-enrollment] customer ${customerId} enrolled (source=${source}, method=${inChargeMethodId})`);
  // Enrollment-confirmation email (owner 2026-07-13; GATED OFF until
  // GATE_CARD_ENROLLMENT_EMAILS): the customer's copy of the authorization
  // they just granted — card-network stored-credential guidance. Fresh
  // enrollments only (already_enrolled returned above); fire-and-forget,
  // never blocks or fails the enrollment. Sent ONLY when the enrolled
  // target IS the method in charge (Codex #2698 r1): with a healthy
  // incumbent kept in the default role, the email's "your card is
  // charged after each completed service" would describe the WRONG card.
  // In savepoint mode the send is DEFERRED to the caller's post-commit
  // (returned below, never fired here) — an email announcing an enrollment
  // the outer transaction then rolls back is a customer-facing lie.
  const sendEnrollmentConfirmation = String(target.id) === String(inChargeMethodId)
    ? () => {
      try {
        const { sendAutopayEnrollmentConfirmation } = require('./card-enrollment-email');
        void sendAutopayEnrollmentConfirmation({ customerId, paymentMethodRowId: target.id });
      } catch { /* best-effort */ }
    }
    : null;
  if (sendEnrollmentConfirmation && !runningInCallerTrx) {
    sendEnrollmentConfirmation();
  }
  return {
    enrolled: true,
    methodId: target.id,
    inChargeMethodId,
    ...(runningInCallerTrx && sendEnrollmentConfirmation ? { sendEnrollmentConfirmation } : {}),
  };
}

module.exports = { enrollConsentedMethod };
