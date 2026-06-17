const db = require('../models/db');
const logger = require('./logger');
const PaymentRouter = require('./payment-router');
const TwilioService = require('./twilio');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { logAutopay } = require('./autopay-log');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const PaymentLifecycleEmail = require('./payment-lifecycle-email');
const AccountMembershipEmail = require('./account-membership-email');
const AnnualPrepayRenewals = require('./annual-prepay-renewals');

/**
 * Billing Cron Service
 *
 * processMonthlyBilling() — Run on the 1st of each month at 8 AM
 * processPaymentRetries() — Run daily at 10 AM
 *
 * Hook these into server/services/scheduler.js:
 *   cron.schedule('0 8 1 * *', () => BillingCron.processMonthlyBilling());
 *   cron.schedule('0 10 * * *', () => BillingCron.processPaymentRetries());
 */

// Retry schedule: Day 1 → retry Day 3, Day 3 → retry Day 5
const RETRY_DELAYS_DAYS = [2, 2]; // cumulative: +2, +2 more

const { isBillingDayMatch } = require('./billing-helpers');

async function sendCustomerBillingSms({ customer, body, purpose = 'billing', messageType, entryPoint }) {
  const sendResult = await sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose,
    customerId: customer.id,
    entryPoint,
    metadata: { original_message_type: messageType },
  });
  if (sendResult.blocked || sendResult.sent === false) {
    throw new Error(`billing SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
  }
  return sendResult;
}

// Admin alert recipient — must be a real cell, never one of our own Twilio
// numbers (an SMS from the HQ line to itself fails with Twilio error 21266).
const ADMIN_ALERT_PHONE = process.env.ADAM_PHONE || '+19415993489';
const BILLING_PORTAL_URL = 'https://portal.wavespestcontrol.com/?tab=billing';

// Render customer billing SMS from the editable template table.
async function renderTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body && !body.includes('{first_name}')) return body;
    }
  } catch (err) {
    throw new Error(`SMS template ${templateKey} could not be rendered: ${err.message}`);
  }
  throw new Error(`SMS template ${templateKey} is missing or inactive`);
}

const BillingCron = {
  // =========================================================================
  // MONTHLY BILLING — 1st at 8 AM
  // =========================================================================

  /**
   * Charge all active customers with monthly_rate > 0.
   * Skips customers already charged this month.
   */
  async processMonthlyBilling() {
    const now = new Date();
    const { year, month } = etParts(now);
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    // Last day of ET month — new Date(y, m, 0) uses UTC constructor which is
    // fine for day-count math, but we format via UTC getters below so it's ET-safe.
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    logger.info(`[billing-cron] Starting monthly billing for ${monthStart}`);

    // Get active customers with a monthly rate — include autopay + pause state.
    // service_paused_at is set when the 3-retry ladder exhausts; skip those so
    // we don't keep burning charges against a dead card until billing is fixed.
    const customers = await db('customers')
      .where({ active: true })
      .where('monthly_rate', '>', 0)
      .whereNull('service_paused_at')
      .whereNull('deleted_at')
      .select(
        'id', 'first_name', 'last_name', 'phone', 'monthly_rate', 'waveguard_tier',
        'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id',
        'billing_day',
      );

    // Annual-prepay customers paid for the whole period up front. The paid
    // coverage term is the source of truth for billing suppression — they keep
    // their monthly_rate (renewal/reporting) but must never be monthly-charged
    // while covered. First reconcile any paid-but-pending terms (webhook lag),
    // then resolve the covered set once per run and enforce it per-customer.
    try {
      await AnnualPrepayRenewals.activatePaidPendingTerms();
    } catch (err) {
      logger.warn(`[billing-cron] annual-prepay paid-pending sync skipped: ${err.message}`);
    }
    const annualPrepayCoveredIds =
      await AnnualPrepayRenewals.getActivelyCoveredCustomerIds(etDateString());
    const annualPrepayPendingIds =
      await AnnualPrepayRenewals.getPaymentPendingCustomerIds();

    const todayDay = etParts(now).day;
    let charged = 0;
    let skipped = 0;
    let failed = 0;

    for (const customer of customers) {
      try {
        // GUARD 1: autopay disabled — skip, log
        if (customer.autopay_enabled === false) {
          await logAutopay(customer.id, 'skipped_disabled');
          skipped++;
          continue;
        }

        // GUARD 2: autopay paused — skip, log
        if (customer.autopay_paused_until && new Date(customer.autopay_paused_until) >= new Date(now.toDateString())) {
          await logAutopay(customer.id, 'skipped_paused', {
            details: { paused_until: customer.autopay_paused_until },
          });
          skipped++;
          continue;
        }

        // GUARD 3: wrong billing day — skip silently (no log; not an anomaly).
        // The cron now runs daily (scheduler.js), so this guard is what
        // shapes "charge today vs. skip" for every customer regardless
        // of their billing_day. See isBillingDayMatch for the NULL-default
        // contract.
        if (!isBillingDayMatch(customer.billing_day, todayDay)) {
          continue;
        }

        // GUARD 4: active annual-prepay coverage — the customer paid for this
        // period up front. Skip even when active + monthly_rate > 0 + autopay
        // on; charging here would double-bill on top of the prepayment.
        if (annualPrepayCoveredIds.has(String(customer.id))) {
          await logAutopay(customer.id, 'skipped_annual_prepay');
          skipped++;
          continue;
        }

        // GUARD 5: pending annual-prepay commitment — office/customer still
        // needs to complete or cancel the annual invoice. Do not monthly-charge
        // in the meantime, even though active coverage has not started.
        if (annualPrepayPendingIds.has(String(customer.id))) {
          await logAutopay(customer.id, 'skipped_annual_prepay_pending');
          skipped++;
          continue;
        }

        // Check if already charged this month (paid or processing)
        const existingCharge = await db('payments')
          .where({ customer_id: customer.id })
          .where('payment_date', '>=', monthStart)
          .where('payment_date', '<=', monthEnd)
          .where('description', 'like', '%WaveGuard Monthly%')
          .whereIn('status', ['paid', 'processing'])
          .first();

        if (existingCharge) {
          await logAutopay(customer.id, 'skipped_already_paid', { paymentId: existingCharge.id });
          skipped++;
          continue;
        }

        // Get the correct processor for this customer
        const service = await PaymentRouter.getServiceForCustomer(customer.id);

        // Charge
        const paymentResult = await service.chargeMonthly(customer.id);
        charged++;

        // Log success + update next_charge_date (next month, same billing_day)
        await logAutopay(customer.id, 'charge_success', {
          amountCents: Math.round(parseFloat(customer.monthly_rate) * 100),
          paymentMethodId: customer.autopay_payment_method_id || null,
          paymentId: paymentResult?.id || null,
          details: { source: 'autopay', tier: customer.waveguard_tier },
        });

        // Next charge = same billing_day in the next ET calendar month.
        const et = etParts(now);
        const nextMonth = et.month === 12 ? 1 : et.month + 1;
        const nextYear = et.month === 12 ? et.year + 1 : et.year;
        const billingDay = customer.billing_day || 1;
        const daysInNextMonth = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
        const day = Math.min(billingDay, daysInNextMonth);
        const nextChargeDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        await db('customers').where({ id: customer.id })
          .update({ next_charge_date: nextChargeDate });

        // Extract receipt URL and include in confirmation SMS
        let receiptUrl = null;
        try {
          const raw = paymentResult.metadata;
          const meta = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
          receiptUrl = meta.stripe_receipt_url || null;
        } catch (e) { logger.warn(`[billing-cron] metadata parse error: ${e.message}`); }

        try {
          const receiptLine = receiptUrl ? ` View your receipt: ${receiptUrl}` : '';
          const body = await renderTemplate('autopay_charge_success',
            { first_name: customer.first_name, amount: 'your payment', receipt_line: receiptLine },
            { workflow: 'monthly_billing_success', entity_type: 'customer', entity_id: customer.id },
          );
          await sendCustomerBillingSms({
            customer,
            body,
            purpose: 'payment_receipt',
            messageType: 'autopay_charge_success',
            entryPoint: 'monthly_billing_success',
          });
        } catch (smsErr) {
          logger.error(`[billing-cron] Payment confirmation SMS failed: ${smsErr.message}`);
        }

        logger.info(`[billing-cron] Charged $${customer.monthly_rate} for customer id=${customer.id}`);
      } catch (err) {
        failed++;
        logger.error(`[billing-cron] Failed to charge customer id=${customer.id}: ${err.message}`);

        // STRIPE_CHARGED_DB_FAILED — Stripe accepted the charge but the
        // payments-table write failed; the orphan was already recorded
        // in stripe_orphan_charges by the service. The customer was
        // billed, so DO NOT schedule a retry (would double-charge),
        // DO NOT send the "your card failed, update it" SMS, DO surface
        // the orphan for manual reconciliation.
        if (err.code === 'STRIPE_CHARGED_DB_FAILED') {
          await logAutopay(customer.id, 'orphan_charge', {
            amountCents: Math.round(parseFloat(customer.monthly_rate) * 100),
            paymentMethodId: customer.autopay_payment_method_id || null,
            details: { source: 'autopay', stripe_payment_intent_id: err.stripePaymentIntentId, reason: err.message },
          }).catch(() => {});

          try {
            await db('customer_health_alerts').insert({
              customer_id: customer.id,
              alert_type: 'stripe_orphan_charge',
              severity: 'high',
              title: `Charge succeeded but unrecorded — $${err.amount} (PI ${err.stripePaymentIntentId})`,
              description: `Stripe accepted the autopay charge but our DB ledger insert failed. The customer WAS billed; reconcile via stripe_orphan_charges before next month's run. DO NOT manually retry — that would double-charge.`,
              trigger_data: JSON.stringify({
                stripe_payment_intent_id: err.stripePaymentIntentId,
                amount: err.amount,
                source: 'autopay_orphan',
              }),
            });
          } catch (alertErr) {
            logger.error(`[billing-cron] Orphan alert creation failed: ${alertErr.message}`);
          }

          try {
            await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
              `🚨 Stripe orphan charge: customer id=${customer.id} — $${err.amount} charged via PI ${err.stripePaymentIntentId} but not in our DB. Reconcile via stripe_orphan_charges. DO NOT retry.`,
              { messageType: 'internal_alert', link: '/admin/revenue' },
            );
          } catch (smsErr) {
            logger.error(`[billing-cron] Office orphan SMS failed: ${smsErr.message}`);
          }

          // Skip the retry-scheduling + customer-facing failure SMS.
          // From the customer's perspective the charge succeeded.
          continue;
        }

        // STRIPE_REQUIRES_ACTION — cardholder bank requires 3DS / step-up
        // auth. The PI lands in requires_action state and Stripe fires
        // payment_intent.requires_action, which the webhook handler
        // already turns into a customer SMS asking them to log in and
        // authenticate. Do NOT schedule a retry — the next cron tick
        // would hit the exact same SCA wall and burn the retry slot
        // without ever reaching a card-update path.
        if (err.code === 'STRIPE_REQUIRES_ACTION') {
          await logAutopay(customer.id, 'sca_required', {
            amountCents: Math.round(parseFloat(customer.monthly_rate) * 100),
            paymentMethodId: customer.autopay_payment_method_id || null,
            paymentId: err.paymentRecord?.id || null,
            details: { source: 'autopay', stripe_payment_intent_id: err.stripePaymentIntentId },
          }).catch(() => {});
          logger.warn(`[billing-cron] SCA required for customer id=${customer.id} — webhook handles SMS, skipping retry`);
          continue;
        }

        // STRIPE_AMBIGUOUS_OUTCOME — the create() call died on a
        // connection/API error with no PI returned. Stripe may have
        // processed the charge, so arming the retry ladder (fresh
        // idempotency key in 2 days) is a double-charge vector, and the
        // "payment failed" SMS may be false. Park non-collectible for
        // manual reconciliation against the Stripe dashboard.
        if (err.code === 'STRIPE_AMBIGUOUS_OUTCOME') {
          if (err.paymentRecord?.id) {
            await db('payments').where({ id: err.paymentRecord.id }).update({
              next_retry_at: null,
              superseded_by_payment_id: err.paymentRecord.id,
              failure_reason: 'Ambiguous Stripe outcome — reconcile against the Stripe dashboard before re-charging',
            }).catch((parkErr) => logger.error(`[billing-cron] Could not park ambiguous payment ${err.paymentRecord.id}: ${parkErr.message}`));
          }
          await logAutopay(customer.id, 'charge_failed', {
            amountCents: Math.round(parseFloat(customer.monthly_rate) * 100),
            paymentId: err.paymentRecord?.id || null,
            details: { source: 'autopay', reason: 'ambiguous_stripe_outcome', parked: true },
          }).catch(() => {});
          try {
            await db('customer_health_alerts').insert({
              customer_id: customer.id,
              alert_type: 'payment_failure',
              severity: 'high',
              title: `Autopay outcome AMBIGUOUS — $${customer.monthly_rate} (${customer.first_name} ${customer.last_name})`,
              description: `The Stripe request failed without returning a PaymentIntent — the charge may or may not have gone through. Verify in the Stripe dashboard, then re-charge or mark reconciled. No retry was scheduled and no failure SMS was sent.`,
              trigger_data: JSON.stringify({ payment_id: err.paymentRecord?.id || null, amount: customer.monthly_rate, source: 'autopay_ambiguous_parked' }),
            });
          } catch (alertErr) {
            logger.error(`[billing-cron] Ambiguous-outcome alert creation failed: ${alertErr.message}`);
          }
          try {
            await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
              `⚠️ Ambiguous autopay outcome: ${customer.first_name} ${customer.last_name} — $${customer.monthly_rate}. Stripe request died without a PaymentIntent; verify in the Stripe dashboard before re-charging. Parked, no retry scheduled.`,
              { messageType: 'internal_alert', link: '/admin/revenue' },
            );
          } catch (smsErr) {
            logger.error(`[billing-cron] Ambiguous-outcome office SMS failed: ${smsErr.message}`);
          }
          logger.warn(`[billing-cron] AMBIGUOUS outcome for customer id=${customer.id} — parked, no retry`);
          continue;
        }

        // Schedule first retry (Day 3)
        const retryAt = new Date();
        retryAt.setDate(retryAt.getDate() + RETRY_DELAYS_DAYS[0]);

        // Find the failed payment record (created by the charge method)
        const failedPayment = await db('payments')
          .where({ customer_id: customer.id, status: 'failed' })
          .where('payment_date', '>=', monthStart)
          .where('description', 'like', '%WaveGuard Monthly%')
          .orderBy('created_at', 'desc')
          .first();

        if (failedPayment) {
          await db('payments')
            .where({ id: failedPayment.id })
            .update({
              retry_count: 0,
              next_retry_at: retryAt.toISOString(),
            });
        }

        await logAutopay(customer.id, 'charge_failed', {
          amountCents: Math.round(parseFloat(customer.monthly_rate) * 100),
          paymentMethodId: customer.autopay_payment_method_id || null,
          paymentId: failedPayment?.id || null,
          details: { source: 'autopay', reason: err.message, next_retry_at: retryAt.toISOString() },
        });

        // Send failure SMS with actionable card-update link
        try {
          const body = await renderTemplate('autopay_charge_failed',
            { first_name: customer.first_name, amount: 'your payment', update_card_url: BILLING_PORTAL_URL },
            { workflow: 'monthly_billing_failure', entity_type: 'customer', entity_id: customer.id },
          );
          await sendCustomerBillingSms({
            customer,
            body,
            purpose: 'payment_failure',
            messageType: 'autopay_charge_failed',
            entryPoint: 'monthly_billing_failure',
          });
        } catch (smsErr) {
          logger.error(`[billing-cron] SMS notification failed: ${smsErr.message}`);
        }

        if (failedPayment) {
          await PaymentLifecycleEmail.sendPaymentRetryNotice({
            customerId: customer.id,
            paymentId: failedPayment.id,
            retryDate: retryAt,
          }).catch((emailErr) => {
            logger.warn(`[billing-cron] Retry notice email failed for payment ${failedPayment.id}: ${emailErr.message}`);
          });
        }
      }
    }

    logger.info(`[billing-cron] Monthly billing complete: ${charged} charged, ${skipped} skipped, ${failed} failed out of ${customers.length} customers`);

    return { charged, skipped, failed, total: customers.length };
  },

  // =========================================================================
  // PAYMENT RETRIES — Daily at 10 AM
  // =========================================================================

  /**
   * Retry failed payments that have a next_retry_at <= now and retry_count < 3.
   */
  async processPaymentRetries() {
    const now = new Date().toISOString();

    logger.info(`[billing-cron] Starting payment retries`);

    const failedPayments = await db('payments')
      .where({ status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .where('retry_count', '<', 3)
      .whereNotNull('next_retry_at')
      .where('next_retry_at', '<=', now)
      .select('*');

    let retried = 0;
    let succeeded = 0;
    let failedAgain = 0;

    for (const payment of failedPayments) {
      retried++;
      const customer = await db('customers')
        .where({ id: payment.customer_id })
        .first();

      if (!customer) {
        logger.warn(`[billing-cron] Customer ${payment.customer_id} not found for retry — skipping`);
        continue;
      }

      if (customer.deleted_at) {
        logger.warn(`[billing-cron] Customer ${payment.customer_id} is soft-deleted — skipping retry for payment ${payment.id}`);
        continue;
      }

      // Ambiguous no-PI failure: paymentIntents.create() died on a
      // connection/API error without Stripe returning an intent, so
      // Stripe may have accepted the charge even though we never saw
      // the PI — retrying with a fresh idempotency key could
      // double-charge. Park the ladder for manual reconciliation
      // against the Stripe dashboard. Deterministic no-PI failures
      // (invalid params, detached payment method — classified at
      // record time via metadata.ambiguous_outcome) moved no money and
      // keep retrying normally.
      let guardMeta = {};
      try {
        guardMeta = payment.metadata
          ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata)
          : {};
      } catch (e) { /* unparseable legacy metadata — treat as unclassified */ }
      if (!payment.stripe_payment_intent_id && guardMeta.ambiguous_outcome) {
        await db('payments')
          .where({ id: payment.id })
          .update({
            next_retry_at: null,
            // Self-referencing superseded marker (same convention as the
            // orphan path): the outcome is AMBIGUOUS — Stripe may have
            // taken the money — so the row must not be presented as
            // collectible until an admin reconciles it against the
            // Stripe dashboard (re-arm or re-charge manually from there).
            superseded_by_payment_id: payment.id,
            failure_reason: `${payment.failure_reason || 'Charge failed without a PaymentIntent'} — parked: ambiguous Stripe outcome, reconcile manually before re-charging`,
          }).catch(() => {});
        try {
          await db('customer_health_alerts').insert({
            customer_id: payment.customer_id,
            alert_type: 'payment_failure',
            severity: 'high',
            title: `Autopay retry parked — ambiguous Stripe outcome ($${parseFloat(payment.amount).toFixed(2)})`,
            description: `Failed payment ${payment.id} has no PaymentIntent id, so Stripe may or may not have accepted the original charge. Verify in the Stripe dashboard before charging ${customer.first_name} ${customer.last_name} again.`,
            trigger_data: JSON.stringify({ payment_id: payment.id, amount: payment.amount, source: 'autopay_retry_parked' }),
          });
        } catch (alertErr) {
          logger.error(`[billing-cron] Parked-retry alert creation failed: ${alertErr.message}`);
        }
        logger.warn(`[billing-cron] Parked retry for payment ${payment.id} (no PI — ambiguous outcome)`);
        continue;
      }

      // Declared outside the try so the post-success section below can
      // use them: once the charge has gone through, control must NEVER
      // re-enter the failure ladder (a post-charge DB error would arm
      // another retry against money already taken).
      let newPayment = null;
      let originalMeta = {};
      let baseAmount = parseFloat(payment.amount);

      try {
        // Get the correct processor
        const service = await PaymentRouter.getServiceForCustomer(payment.customer_id);

        // Re-attempt the charge. payment.amount is the GROSS the failed
        // attempt asked for — it includes the 2.9% credit-card surcharge
        // when that attempt ran on a credit card. chargeOneTime treats
        // its amount as a fresh base and surcharges again, so replaying
        // the gross compounds the surcharge (2.9% on 102.9% — past the
        // network cap). Re-derive the base from the recorded breakdown;
        // fall back to the gross only for legacy rows that predate base
        // tracking.
        originalMeta = {};
        try {
          originalMeta = payment.metadata
            ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata)
            : {};
        } catch (e) { /* unparseable legacy metadata — fall through */ }
        baseAmount = payment.base_amount_cents != null
          ? payment.base_amount_cents / 100
          : (originalMeta.base_amount != null ? parseFloat(originalMeta.base_amount) : parseFloat(payment.amount));
        const description = payment.description
          .replace(' — FAILED', '')
          .replace(/ \(includes \$[\d.]+ credit card surcharge\)/, '');

        // Key on the failed payment + ladder rung: overlapping sweep
        // instances replay the same PI, while the next scheduled rung
        // (retry_count incremented) mints a fresh charge. The monthly
        // branch must NOT use chargeMonthly's default date key — two
        // distinct failed monthly rows retried the same day would
        // replay one PaymentIntent while both originals get marked
        // superseded.
        const retryIdempotencyKey = `autopay_retry_${payment.id}_${payment.retry_count}`;

        if (description.includes('WaveGuard Monthly')) {
          // Charge the failed row's own base — chargeMonthly re-reads the
          // customer's CURRENT monthly_rate, so a rate change between the
          // attempt and the retry would collect a different amount than
          // the obligation being retried (and then supersede the original
          // as if it had been collected in full).
          const monthlyCustomer = await db('customers').where({ id: payment.customer_id }).first();
          const monthlyDescription = description
            || `${monthlyCustomer?.waveguard_tier || 'WaveGuard'} WaveGuard Monthly — ${monthlyCustomer?.first_name} ${monthlyCustomer?.last_name}`;
          newPayment = await service.charge(payment.customer_id, baseAmount, monthlyDescription, {
            type: 'monthly_autopay',
            tier: monthlyCustomer?.waveguard_tier || '',
          }, retryIdempotencyKey);
        } else {
          newPayment = await service.chargeOneTime(
            payment.customer_id,
            baseAmount,
            description,
            retryIdempotencyKey,
          );
        }

      } catch (err) {
        // STRIPE_CHARGED_DB_FAILED — Stripe accepted the retry charge but
        // the ledger write failed. The customer WAS billed (orphan row
        // already recorded by the service), so the ladder must STOP: the
        // generic failure path below would schedule another retry and
        // take the money again, plus text the customer that their
        // payment failed when it succeeded. Mirror of the same guard in
        // processMonthlyBilling.
        if (err.code === 'STRIPE_CHARGED_DB_FAILED') {
          // Self-referencing superseded marker: the customer WAS
          // charged (the collected row is missing — that's the orphan),
          // so this failed row must drop out of every outstanding-
          // balance sum immediately or the portal shows the already-
          // taken amount as owed and lets the customer pay it again.
          // superseded_by = own id is the queryable "resolved, not
          // collectible — see stripe_orphan_charges" state. This write
          // is what keeps the row out of the retry queue, so it must
          // NOT be swallowed: retry a minimal disarm and escalate hard
          // if both fail.
          let orphanDisarmed = false;
          try {
            await db('payments')
              .where({ id: payment.id })
              .update({
                retry_count: payment.retry_count + 1,
                next_retry_at: null,
                superseded_by_payment_id: payment.id,
                failure_reason: `Retry charged but unrecorded (PI ${err.stripePaymentIntentId}) — reconcile via stripe_orphan_charges`,
              });
            orphanDisarmed = true;
          } catch (disarmErr) {
            logger.error(`[billing-cron] Orphan disarm failed for payment ${payment.id}: ${disarmErr.message} — retrying minimal disarm`);
            await db('payments')
              .where({ id: payment.id })
              .update({ next_retry_at: null, superseded_by_payment_id: payment.id })
              .then(() => { orphanDisarmed = true; })
              .catch(() => {});
          }
          if (!orphanDisarmed) {
            logger.error(`[billing-cron] CRITICAL: payment ${payment.id} was charged at Stripe (PI ${err.stripePaymentIntentId}) but could NOT be disarmed — it remains in the retry queue and balance sums`);
            try {
              await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
                `🚨🚨 URGENT: payment ${payment.id} (customer id=${payment.customer_id}) was CHARGED at Stripe but could not be removed from the retry queue. It WILL be re-charged and shows as owed. Fix the payments row now (PI ${err.stripePaymentIntentId}).`,
                { messageType: 'internal_alert', link: '/admin/revenue' },
              );
            } catch (smsErr) {
              logger.error(`[billing-cron] Urgent disarm-failure SMS failed: ${smsErr.message}`);
            }
          }
          await logAutopay(payment.customer_id, 'orphan_charge', {
            amountCents: Math.round(parseFloat(payment.amount) * 100),
            paymentId: payment.id,
            details: { source: 'autopay_retry', stripe_payment_intent_id: err.stripePaymentIntentId, reason: err.message },
          }).catch(() => {});
          try {
            await db('customer_health_alerts').insert({
              customer_id: payment.customer_id,
              alert_type: 'stripe_orphan_charge',
              severity: 'high',
              title: `Retry charge succeeded but unrecorded — $${err.amount} (PI ${err.stripePaymentIntentId})`,
              description: `Stripe accepted the retry charge but our DB ledger insert failed. The customer WAS billed; reconcile via stripe_orphan_charges. DO NOT manually retry — that would double-charge.`,
              trigger_data: JSON.stringify({
                stripe_payment_intent_id: err.stripePaymentIntentId,
                amount: err.amount,
                source: 'autopay_retry_orphan',
                original_payment_id: payment.id,
              }),
            });
          } catch (alertErr) {
            logger.error(`[billing-cron] Retry orphan alert creation failed: ${alertErr.message}`);
          }
          try {
            await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
              `🚨 Stripe orphan charge (retry): customer id=${payment.customer_id} — $${err.amount} charged via PI ${err.stripePaymentIntentId} but not in our DB. Reconcile via stripe_orphan_charges. DO NOT retry.`,
              { messageType: 'internal_alert', link: '/admin/revenue' },
            );
          } catch (smsErr) {
            logger.error(`[billing-cron] Office orphan SMS failed: ${smsErr.message}`);
          }
          logger.error(`[billing-cron] ORPHAN on retry: customer id=${customer.id}, PI ${err.stripePaymentIntentId} — ladder stopped`);
          continue;
        }

        // STRIPE_REQUIRES_ACTION — the bank demands 3DS step-up. The
        // requires_action webhook already texts the customer a link to
        // authenticate; burning the remaining retry slots against the
        // same SCA wall only generates repeat "payment failed" SMS.
        // Park the ladder; collection resumes through the customer's
        // authenticated payment.
        if (err.code === 'STRIPE_REQUIRES_ACTION') {
          await db('payments')
            .where({ id: payment.id })
            .update({
              retry_count: payment.retry_count + 1,
              next_retry_at: null,
              // charge() already inserted a fresh REQUIRES AUTH failed
              // row for the retry PI; that row is the one collectible
              // representation of this obligation (the webhook flips it
              // to paid once the customer authenticates). Supersede the
              // original so the same amount isn't shown as owed twice —
              // and doesn't remain payable after authentication. Guard
              // against the replay-dedupe case where the failure record
              // IS this row: self-superseding would hide real debt.
              superseded_by_payment_id: (err.paymentRecord?.id && err.paymentRecord.id !== payment.id)
                ? err.paymentRecord.id
                : null,
              failure_reason: 'Customer authentication required (3DS) — webhook prompted customer',
            }).catch(() => {});
          await logAutopay(payment.customer_id, 'sca_required', {
            amountCents: Math.round(parseFloat(payment.amount) * 100),
            paymentId: payment.id,
            details: { source: 'autopay_retry', stripe_payment_intent_id: err.stripePaymentIntentId },
          }).catch(() => {});
          logger.warn(`[billing-cron] SCA required on retry for customer id=${customer.id} — ladder parked, webhook handles customer SMS`);
          continue;
        }

        // STRIPE_AMBIGUOUS_OUTCOME — the retry attempt died without a
        // PI; Stripe may have processed it. A further rung with a fresh
        // key is a double-charge vector. Park BOTH rows non-collectible
        // for manual reconciliation.
        if (err.code === 'STRIPE_AMBIGUOUS_OUTCOME') {
          if (err.paymentRecord?.id && err.paymentRecord.id !== payment.id) {
            await db('payments').where({ id: err.paymentRecord.id }).update({
              next_retry_at: null,
              superseded_by_payment_id: err.paymentRecord.id,
              failure_reason: 'Ambiguous Stripe outcome on retry — reconcile before re-charging',
            }).catch((parkErr) => logger.error(`[billing-cron] Could not park ambiguous attempt row ${err.paymentRecord.id}: ${parkErr.message}`));
          }
          await db('payments').where({ id: payment.id }).update({
            retry_count: payment.retry_count + 1,
            next_retry_at: null,
            superseded_by_payment_id: payment.id,
            failure_reason: 'Retry outcome ambiguous at Stripe — parked for manual reconciliation',
          }).catch((parkErr) => logger.error(`[billing-cron] Could not park original row ${payment.id} after ambiguous retry: ${parkErr.message}`));
          await logAutopay(payment.customer_id, 'retry_failed', {
            amountCents: Math.round(parseFloat(payment.amount) * 100),
            paymentId: payment.id,
            details: { source: 'autopay_retry', reason: 'ambiguous_stripe_outcome', parked: true },
          }).catch(() => {});
          try {
            await db('customer_health_alerts').insert({
              customer_id: payment.customer_id,
              alert_type: 'payment_failure',
              severity: 'high',
              title: `Autopay retry outcome AMBIGUOUS — $${parseFloat(payment.amount).toFixed(2)}`,
              description: `The retry of payment ${payment.id} failed without Stripe returning a PaymentIntent — the charge may or may not have gone through. Verify in the Stripe dashboard, then re-charge or mark reconciled. The ladder is parked.`,
              trigger_data: JSON.stringify({ payment_id: payment.id, attempt_payment_id: err.paymentRecord?.id || null, source: 'autopay_retry_ambiguous_parked' }),
            });
          } catch (alertErr) {
            logger.error(`[billing-cron] Ambiguous-retry alert creation failed: ${alertErr.message}`);
          }
          logger.warn(`[billing-cron] AMBIGUOUS retry outcome for payment ${payment.id} — both rows parked`);
          continue;
        }

        failedAgain++;
        const newRetryCount = payment.retry_count + 1;

        logger.error(`[billing-cron] Retry #${newRetryCount} failed for customer id=${customer.id}: ${err.message}`);

        // charge() inserted a fresh failed row for this declined retry
        // attempt. The ORIGINAL row stays canonical — it carries the
        // retry ladder — so supersede the new attempt row, otherwise
        // one obligation is summed twice by /balance and the AI
        // billing tools (and could be paid twice).
        if (err.paymentRecord?.id && err.paymentRecord.id !== payment.id) {
          await db('payments')
            .where({ id: err.paymentRecord.id })
            .update({ superseded_by_payment_id: payment.id })
            .catch((updateErr) => logger.error(`[billing-cron] Could not supersede retry-attempt row ${err.paymentRecord.id}: ${updateErr.message}`));
        }

        if (newRetryCount >= 3) {
          // Final failure — escalate
          await db('payments')
            .where({ id: payment.id })
            .update({
              retry_count: newRetryCount,
              next_retry_at: null,
              failure_reason: `Final retry failed: ${err.message}`,
            });

          const amount = parseFloat(payment.amount).toFixed(2);

          // Send final failure SMS — carries the actionable update-card link
          // and the correct Waves callback number. (Previous copy had the
          // wrong area code — 239 instead of 941.)
          try {
            const body = await renderTemplate('autopay_retry_final_failed',
              { first_name: customer.first_name, amount: 'your payment', update_card_url: BILLING_PORTAL_URL },
              { workflow: 'autopay_retry_final_failed', entity_type: 'payment', entity_id: payment.id },
            );
            await sendCustomerBillingSms({
              customer,
              body,
              purpose: 'payment_failure',
              messageType: 'autopay_retry_final_failed',
              entryPoint: 'autopay_retry_final_failed',
            });
          } catch (smsErr) {
            logger.error(`[billing-cron] Final SMS failed: ${smsErr.message}`);
          }

          // Pause service so we stop burning charges (next month's cron skips
          // customers with service_paused_at set) and so dispatch can see the
          // billing issue before dispatching the next visit.
          try {
            const pausedAt = new Date();
            await db('customers').where({ id: payment.customer_id }).update({
              service_paused_at: pausedAt,
              service_pause_reason: 'autopay_final_failure',
            });
            void AccountMembershipEmail.sendMembershipPaused({
              customerId: payment.customer_id,
              effectiveDate: pausedAt,
              reason: 'Payment retry attempts were exhausted',
            }).catch((emailErr) => logger.warn(`[billing-cron] service pause email failed for customer ${payment.customer_id}: ${emailErr.message}`));
          } catch (pauseErr) {
            logger.error(`[billing-cron] Service pause failed: ${pauseErr.message}`);
          }

          // Alert the office so Virginia can reach out (health alert alone
          // sat on a dashboard — push-style SMS makes sure it lands).
          try {
            await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
              `🚨 Autopay exhausted: ${customer.first_name} ${customer.last_name} — $${amount} failed 3x. Service paused until card is updated. Last error: ${err.message}`,
              { messageType: 'internal_alert', link: '/admin/revenue' },
            );
          } catch (officeErr) {
            logger.error(`[billing-cron] Office alert SMS failed: ${officeErr.message}`);
          }

          // Create health alert for admin review
          try {
            await db('customer_health_alerts').insert({
              customer_id: payment.customer_id,
              alert_type: 'payment_failure',
              severity: 'high',
              title: `Payment failed after 3 retries — $${amount}`,
              description: `Monthly payment for ${customer.first_name} ${customer.last_name} failed 3 times. Service auto-paused. Last error: ${err.message}`,
              trigger_data: JSON.stringify({
                payment_id: payment.id,
                amount: payment.amount,
                retry_count: newRetryCount,
                service_paused: true,
              }),
            });
          } catch (alertErr) {
            logger.error(`[billing-cron] Health alert creation failed: ${alertErr.message}`);
          }

          await logAutopay(payment.customer_id, 'retry_failed', {
            amountCents: Math.round(parseFloat(payment.amount) * 100),
            paymentId: payment.id,
            details: { source: 'autopay', retry_count: newRetryCount, reason: err.message, final: true, service_paused: true },
          });

          logger.warn(`[billing-cron] ESCALATED: customer id=${customer.id} — 3 retries exhausted, service paused`);
        } else {
          // Schedule next retry
          const nextRetry = new Date();
          const delayIndex = Math.min(newRetryCount, RETRY_DELAYS_DAYS.length - 1);
          nextRetry.setDate(nextRetry.getDate() + RETRY_DELAYS_DAYS[delayIndex]);

          await db('payments')
            .where({ id: payment.id })
            .update({
              retry_count: newRetryCount,
              next_retry_at: nextRetry.toISOString(),
              failure_reason: err.message,
            });

          await logAutopay(payment.customer_id, 'retry_failed', {
            amountCents: Math.round(parseFloat(payment.amount) * 100),
            paymentId: payment.id,
            details: { source: 'autopay', retry_count: newRetryCount, reason: err.message, next_retry_at: nextRetry.toISOString() },
          });

          // Send retry SMS with update-card link
          try {
            const body = await renderTemplate('autopay_retry_failed',
              { first_name: customer.first_name, amount: 'your payment', update_card_url: BILLING_PORTAL_URL },
              { workflow: 'autopay_retry_failed', entity_type: 'payment', entity_id: payment.id },
            );
            await sendCustomerBillingSms({
              customer,
              body,
              purpose: 'payment_failure',
              messageType: 'autopay_retry_failed',
              entryPoint: 'autopay_retry_failed',
            });
          } catch (smsErr) {
            logger.error(`[billing-cron] Retry SMS failed: ${smsErr.message}`);
          }

          await PaymentLifecycleEmail.sendPaymentRetryNotice({
            customerId: customer.id,
            paymentId: payment.id,
            retryDate: nextRetry,
          }).catch((emailErr) => {
            logger.warn(`[billing-cron] Retry notice email failed for payment ${payment.id}: ${emailErr.message}`);
          });
        }
        continue;
      }

      // ── Charge succeeded — from here on, NEVER re-enter the failure
      // ladder. A post-charge DB error must not arm another retry
      // against money already taken.

      // Resolve the original attempt WITHOUT flipping it to 'paid' —
      // the retry charge inserted its own paid row, and one Stripe
      // charge must produce exactly one paid ledger row (the old
      // status flip double-counted revenue and showed a duplicate
      // charge in the customer's payment history, with the FAILED
      // attempt's PI id wearing status='paid'). The attempt stays
      // 'failed' (it did fail); superseded_by_payment_id is what
      // takes it out of every outstanding-balance sum (billing-v2
      // /balance, AI tools), and next_retry_at=null drops it out of
      // the sweep.
      try {
        await db('payments')
          .where({ id: payment.id })
          .update({
            retry_count: payment.retry_count + 1,
            next_retry_at: null,
            superseded_by_payment_id: newPayment?.id || null,
            metadata: JSON.stringify({
              ...originalMeta,
              retried_at: now,
              retry_payment_id: newPayment?.id || null,
              superseded_by_retry: true,
            }),
          });
      } catch (supersedeErr) {
        logger.error(`[billing-cron] CRITICAL: retry charged (payment ${newPayment?.id}) but supersede update on original ${payment.id} failed: ${supersedeErr.message}`);
        // Minimal fallback: disarm the sweep AND mark the row
        // superseded so it can't be shown as owed (the full update may
        // have failed on the metadata write). If even this fails, the
        // durable rung key makes the next run replay the same PI and
        // land back here.
        await db('payments').where({ id: payment.id }).update({
          next_retry_at: null,
          superseded_by_payment_id: newPayment?.id || payment.id,
          failure_reason: `Collected by retry payment ${newPayment?.id || '(id unknown)'} — full supersede update failed, reconcile metadata manually`,
        }).catch(() => {});
        try {
          await db('customer_health_alerts').insert({
            customer_id: payment.customer_id,
            alert_type: 'payment_failure',
            severity: 'high',
            title: `Retry collected but original payment ${payment.id} not superseded`,
            description: `The retry charge succeeded (payment ${newPayment?.id || 'unknown'}) but the original failed row could not be marked superseded — it may still show as owed. Reconcile manually.`,
            trigger_data: JSON.stringify({ payment_id: payment.id, retry_payment_id: newPayment?.id || null, source: 'autopay_retry_supersede_failed' }),
          });
        } catch (alertErr) {
          logger.error(`[billing-cron] Supersede-failure alert creation failed: ${alertErr.message}`);
        }
      }

      succeeded++;

      // Log what was ACTUALLY collected — the retry recomputes the
      // total for the customer's current tender (a credit-card failure
      // retried on ACH/debit collects less than the old surcharged
      // gross), and autopay_log is the billing-dispute audit trail.
      await logAutopay(payment.customer_id, 'retry_success', {
        amountCents: Math.round(parseFloat(newPayment?.amount ?? baseAmount) * 100),
        paymentId: newPayment?.id || null,
        details: { source: 'autopay', retry_count: payment.retry_count + 1, original_payment_id: payment.id, original_amount: payment.amount },
      }).catch((logErr) => logger.error(`[billing-cron] retry_success log failed: ${logErr.message}`));

      // Send success SMS with receipt
      let retryReceiptUrl = null;
      try {
        const rawMeta = newPayment?.metadata;
        const meta = rawMeta ? (typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta) : {};
        retryReceiptUrl = meta.stripe_receipt_url || null;
      } catch (e) { /* ignore */ }
      try {
        const receiptLine = retryReceiptUrl ? ` View your receipt: ${retryReceiptUrl}` : '';
        const body = await renderTemplate('autopay_retry_success',
          { first_name: customer.first_name, amount: 'your payment', receipt_line: receiptLine },
          { workflow: 'autopay_retry_success', entity_type: 'payment', entity_id: payment.id },
        );
        await sendCustomerBillingSms({
          customer,
          body,
          purpose: 'payment_receipt',
          messageType: 'autopay_retry_success',
          entryPoint: 'autopay_retry_success',
        });
      } catch (smsErr) {
        logger.error(`[billing-cron] Success SMS failed: ${smsErr.message}`);
      }

      logger.info(`[billing-cron] Retry succeeded for customer id=${customer.id}: $${newPayment?.amount ?? baseAmount}`);
    }

    logger.info(`[billing-cron] Retries complete: ${retried} attempted, ${succeeded} succeeded, ${failedAgain} failed again`);

    return { retried, succeeded, failed: failedAgain };
  },
};

module.exports = BillingCron;
