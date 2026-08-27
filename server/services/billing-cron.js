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
const { resolveBillingLane } = require('./billing-lane');
const {
  REASONS: RETRY_REASONS,
  DISPOSITIONS: RETRY_DISPOSITIONS,
  loadRetryContext,
  armedRetryQuery,
  classifyFailedPaymentRetry,
} = require('./retry-collectibility');
const { isEnabled } = require('../config/feature-gates');

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
const { isPaused } = require('./autopay-eligibility');

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

/**
 * Resolve the dollar figure for an autopay SMS.
 *
 * All five autopay templates render a literal '$' immediately before
 * {amount} ("your payment of ${amount}"), so this must return a BARE
 * "NN.NN" — never a pre-formatted "$12.34", which would send "$$12.34".
 *
 * Every call site passed the literal string 'your payment' into that slot,
 * which sent "your payment of $your payment" to 14 real customers on
 * 2026-06-01 (13 autopay_charge_failed, 1 autopay_charge_success). The
 * amount was already in scope at every one of them.
 *
 * ONE operand, deliberately — no fallback chain. The only acceptable value
 * is the authoritative payments-row amount for the EXACT attempt the message
 * describes: paymentResult.amount for a successful charge,
 * err.paymentRecord.amount for a declined one, newPayment.amount for a
 * successful retry. Every plausible fallback misstates it. customer
 * .monthly_rate and baseAmount are pre-surcharge, so a card customer would
 * be quoted less than Stripe took; the original payment.amount carries the
 * OLD tender's gross, so a card-to-ACH switch between retries quotes a
 * figure Stripe never saw. AGENTS.md requires the displayed amount, the
 * PaymentIntent and the payments row to agree to the cent, and that rule
 * does not stop at the screen.
 *
 * Returns null when the value is unusable, which callers MUST treat as "do
 * not send". A text reading "$NaN" is worse than silence, and so is a
 * confidently wrong dollar figure — a payments row with no amount is a data
 * problem that deserves the error log the callers' catch already writes.
 */
function resolveSmsAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return num.toFixed(2);
}

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
    // billing_mode ships in migration 20260709000010 — selecting it
    // unconditionally would abort the WHOLE monthly run on a pre-migration
    // database (Codex round-9); absent column leaves customer.billing_mode
    // undefined and GUARD 3b inert, exactly the legacy behavior.
    let billingModeColumnExists = false;
    try {
      billingModeColumnExists = await db.schema.hasColumn('customers', 'billing_mode');
    } catch { /* keep false — legacy select shape */ }
    const customers = await db('customers')
      .where({ active: true })
      .where('monthly_rate', '>', 0)
      .whereNull('service_paused_at')
      .whereNull('deleted_at')
      .select(
        'id', 'first_name', 'last_name', 'phone', 'monthly_rate', 'waveguard_tier',
        'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id',
        'billing_day', ...(billingModeColumnExists ? ['billing_mode'] : []),
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
        if (isPaused(customer, now)) {
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

        // GUARD 3b: billing mode — this cron is the MONTHLY MEMBERSHIP
        // subscription biller only. Estimate-flow customers bill per visit
        // (billing_mode 'per_application' — completion collects the
        // application fee; owner ruling 2026-07-09): charging them here
        // would bill a monthly subscription ON TOP of their per-visit
        // invoices. 'annual_prepay' is ALSO never this cron's customer
        // (Codex round-5 P1): with autopay enrolled at signup, a naturally
        // EXPIRED term would sail past the coverage-dated guards below and
        // hit chargeMonthly — but the renewal flow is notice + annual
        // invoice (roll-to-per-app is the follow-up build), never silent
        // monthly dues. The unbilled-forever risk that once justified
        // coverage-dating this skip is now closed at the term choke point:
        // a true void/refund resets billing_mode
        // (resetBillingModeAfterTermCancel), returning the customer to
        // per-visit (estimate-flow terms) or legacy monthly (manual
        // prepays). NULL/'monthly_membership' = legacy behavior unchanged.
        // 'per_visit' and 'one_time' are explicit owner-set lanes (billing
        // lane build, 2026-07-17): a customer classified into either must
        // never be monthly-charged no matter what tier/rate fields linger.
        if (['per_application', 'annual_prepay', 'per_visit', 'one_time'].includes(customer.billing_mode)) {
          await logAutopay(customer.id, 'skipped_billing_mode', {
            details: { billing_mode: customer.billing_mode },
          });
          skipped++;
          continue;
        }

        // GUARD 3c: unclassified rows follow the ONE lane classifier (Codex
        // r7 P1). The legacy select (rate > 0) predates the resolver: a
        // tier-less or sentinel-tier NULL row resolves per_visit, and
        // booking/completion treat its visits as per-visit — dues-charging
        // it here would recreate the exact two-lanes double-bill this build
        // kills. Prod-verified 2026-07-17: every currently cron-billable
        // customer resolves monthly (the 4 tier-less rate>0 rows all have
        // autopay off), so this guard changes no live charge; it closes the
        // divergence by construction. The skip is logged loudly so an
        // unclassified customer who enables autopay surfaces for the owner
        // to classify instead of silently double-billing.
        const resolvedLane = resolveBillingLane(customer);
        if (resolvedLane.mode !== 'monthly_membership') {
          await logAutopay(customer.id, 'skipped_unclassified_lane', {
            details: { resolved_mode: resolvedLane.mode, waveguard_tier: customer.waveguard_tier || null },
          });
          skipped++;
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

        // Check if already charged this month (paid or processing).
        // Month-of-obligation attribution: rows stamped with
        // metadata.billed_month match on the month they COLLECT FOR, not
        // the date the money landed — a July obligation whose retry rung
        // succeeds Aug 1 must not satisfy August (it silently skipped the
        // whole next month before the stamp existed). Stamped manual
        // collections (admin charge-now at the monthly rate) count too.
        // Legacy rows without the stamp keep the old payment_date-window
        // + description-marker match.
        const monthKey = `${year}-${String(month).padStart(2, '0')}`;
        const existingCharge = await db('payments')
          .where({ customer_id: customer.id })
          .whereIn('status', ['paid', 'processing'])
          .where(function () {
            this.whereRaw("metadata->>'billed_month' = ?", [monthKey])
              .orWhere(function () {
                this.whereRaw("(metadata IS NULL OR metadata->>'billed_month' IS NULL)")
                  .andWhere('payment_date', '>=', monthStart)
                  .andWhere('payment_date', '<=', monthEnd)
                  .andWhere('description', 'like', '%WaveGuard Monthly%');
              });
          })
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
          // What was actually COLLECTED. Not monthly_rate: that is the
          // pre-surcharge base, so a card customer would get a receipt for
          // less than we took.
          const amountText = resolveSmsAmount(paymentResult?.amount);
          if (!amountText) throw new Error(`no collected amount for customer ${customer.id} (payment ${paymentResult?.id || 'none'})`);
          const body = await renderTemplate('autopay_charge_success',
            { first_name: customer.first_name, amount: amountText, receipt_line: receiptLine },
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
          // The row charge() just inserted for THIS attempt. Not
          // failedPayment — that query can select an older monthly failure
          // — and not monthly_rate, which omits the surcharge. Either would
          // quote a figure the PaymentIntent never carried.
          const amountText = resolveSmsAmount(err.paymentRecord?.amount);
          if (!amountText) throw new Error(`no attempt amount for customer ${customer.id} (paymentRecord ${err.paymentRecord?.id || 'missing'})`);
          const body = await renderTemplate('autopay_charge_failed',
            { first_name: customer.first_name, amount: amountText, update_card_url: BILLING_PORTAL_URL },
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
          // One email per failure (owner rule 2026-07-11): with the gate on,
          // the Automations-tab payment_failed sequence (editable; its copy
          // matches the Day-3 retry + portal card-update CTA) REPLACES the
          // transactional retry-notice email. The failure SMS above, with the
          // card-update link, is unchanged either way. 14-day dedupe = one
          // enrollment per failure episode across the retry ladder; a repeat
          // failure months later re-enrolls via reactivation.
          //
          // DUNNING NEVER GOES EMAIL-SILENT: the sequence only counts as
          // covering the failure when it enrolled, this episode already
          // enrolled (deduped), or no email exists anywhere (the transactional
          // notice couldn't send either). A paused/empty sequence
          // (not_sendable), an unsubscribe suppression the runner would
          // cancel on (suppressed), or an error all fall back to the
          // transactional retry notice, which has its own delivery rules.
          let emailed = false;
          if (isEnabled('paymentFailedEnroll')) {
            const { enrollSequenceFromEvent } = require('./automation-enroll');
            const enrollResult = await enrollSequenceFromEvent({
              templateKey: 'payment_failed',
              customerId: customer.id,
              dedupe: 14,
              recipient: 'billing',
              checkSuppression: true,
              retryFailedUnsent: false,
              source: 'autopay_failure',
            });
            emailed = ['enrolled', 'deduped', 'no_email', 'no_customer'].includes(enrollResult.reason);
          }
          if (!emailed) {
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

    // Durable repair leg for the on-site prepay switch (Codex P0 r13): a
    // superseded per-application invoice whose restore failed transiently
    // during a prepay void/refund is found again through its persistent
    // marker and re-minted here. Idempotent + lock-guarded inside the
    // service; best-effort so a sweep blip never blocks the retries.
    try {
      await require('./invoice').sweepOrphanedPrepaySwitchRestores();
    } catch (err) {
      logger.warn(`[billing-cron] prepay-switch restore sweep failed: ${err.message} — next run retries`);
    }

    // Setup-fee alert daily reconcile (PR #3476): webhook refund paths flip
    // invoices at many sites — this sweep guarantees a coverage regression
    // reopens its parked alert within a day even where no tap fired.
    try {
      await require('./setup-fee-alert-reconcile').sweepSetupFeeAlerts();
    } catch (err) {
      logger.warn(`[billing-cron] setup-fee alert sweep failed: ${err.message} — next run retries`);
    }

    // Stranded prepay auto-charge recovery (GATE_PREPAY_CARD_AND_CHARGE):
    // an accept that crashed between commit and its in-flow charge left a
    // 'pending' prepayAutoChargeJob stamp — resume it under the frozen
    // authorization, or deliver the pay link + alert. No-op while the gate
    // is off; idempotent + best-effort inside the service.
    try {
      await require('./recurring-card-on-file').sweepStrandedPrepayAutoCharges();
    } catch (err) {
      logger.warn(`[billing-cron] stranded prepay auto-charge sweep failed: ${err.message} — next run retries`);
    }

    // Collectibility is decided by the shared verdict (retry-collectibility.js)
    // — the same classifier the card-expiry exemption consults — so the two
    // can never drift. Everything below that MOVES MONEY or WRITES stays here,
    // keyed off the verdict's disposition.
    const ctx = loadRetryContext();
    const failedPayments = await armedRetryQuery(db, { dueBy: now }).select('*');

    let retried = 0;
    let succeeded = 0;
    let failedAgain = 0;

    for (const payment of failedPayments) {
      retried++;
      // Anchor for the concurrent-settlement guard at the final-failure
      // pause write below: a payment that settles while this attempt is in
      // flight must veto the pause (owner ruling 2026-08-01 — paying
      // resumes billing; racing webhook order must not strand a customer
      // who just paid behind a pause their payment would have cleared).
      const attemptStartedAt = new Date();
      const customer = await db('customers')
        .where({ id: payment.customer_id })
        .first();

      const verdict = await classifyFailedPaymentRetry({ payment, customer, ctx });
      const { obligationMonth } = verdict;

      if (verdict.reason === RETRY_REASONS.CUSTOMER_MISSING) {
        logger.warn(`[billing-cron] Customer ${payment.customer_id} not found for retry — skipping`);
        continue;
      }
      if (verdict.reason === RETRY_REASONS.CUSTOMER_DELETED) {
        logger.warn(`[billing-cron] Customer ${payment.customer_id} is soft-deleted — skipping retry for payment ${payment.id}`);
        continue;
      }

      // RESOLUTION: obligation month already collected through another door
      // — resolve the row against the collecting payment.
      if (verdict.reason === RETRY_REASONS.ALREADY_COLLECTED) {
        const collectedId = verdict.collectedByPaymentId;
        await db('payments')
          .where({ id: payment.id })
          .update({
            next_retry_at: null,
            superseded_by_payment_id: collectedId,
            failure_reason: db.raw(
              'COALESCE(failure_reason, \'\') || ? ',
              [` — resolved: ${obligationMonth} already collected by payment ${collectedId}`],
            ),
          }).catch((updErr) => logger.error(`[billing-cron] retry disarm (already collected) failed for payment ${payment.id}: ${updErr.message}`));
        await logAutopay(payment.customer_id, 'skipped_already_paid', {
          paymentId: payment.id,
          details: { source: 'autopay_retry', collected_by_payment_id: collectedId, billed_month: obligationMonth, ladder_stopped: true },
        }).catch(() => {});
        logger.info(`[billing-cron] Retry for payment ${payment.id} skipped — ${obligationMonth} already collected by payment ${collectedId}`);
        continue;
      }

      // RESOLUTION: an annual prepay covering the OBLIGATION absorbs it —
      // self-superseding convention, same as the parked states.
      if (verdict.reason === RETRY_REASONS.ABSORBED_ANNUAL_PREPAY) {
        await db('payments')
          .where({ id: payment.id })
          .update({
            next_retry_at: null,
            superseded_by_payment_id: payment.id,
            failure_reason: db.raw(
              "COALESCE(failure_reason, '') || ' — resolved: absorbed by active annual prepay coverage'",
            ),
          }).catch((updErr) => logger.error(`[billing-cron] retry absorb (annual prepay) failed for payment ${payment.id}: ${updErr.message}`));
        await logAutopay(payment.customer_id, 'skipped_annual_prepay', {
          paymentId: payment.id,
          details: { source: 'autopay_retry', ladder_stopped: true },
        }).catch(() => {});
        logger.info(`[billing-cron] Retry for payment ${payment.id} absorbed by annual prepay coverage`);
        continue;
      }

      // STATE: lane not monthly — ladder STOPS (disarm) but the row is
      // deliberately NOT superseded (Codex round-6 P2): "never paid monthly"
      // cannot prove misclassification; the row stays visible for triage.
      if (verdict.reason === RETRY_REASONS.LANE_NOT_MONTHLY) {
        await db('payments')
          .where({ id: payment.id })
          .update({
            next_retry_at: null,
            failure_reason: db.raw(
              "COALESCE(failure_reason, '') || ' — retry ladder stopped: customer's billing lane is not monthly (review manually — likely mis-created monthly obligation)'",
            ),
          }).catch((updErr) => logger.error(`[billing-cron] retry disarm (billing mode) failed for payment ${payment.id}: ${updErr.message}`));
        await logAutopay(payment.customer_id, 'skipped_billing_mode', {
          paymentId: payment.id,
          details: {
            source: 'autopay_retry',
            billing_mode: customer.billing_mode || null,
            resolved_mode: verdict.resolvedLaneMode,
            ladder_stopped: true,
            superseded: false,
          },
        }).catch(() => {});
        logger.info(`[billing-cron] Retry ladder stopped for payment ${payment.id} — lane not monthly (mode ${customer.billing_mode || 'NULL/inferred'}); row left visible for manual review`);
        continue;
      }

      // STATE: autopay disabled — disarm, no supersede (visible debt for
      // manual follow-up; never touch a card the customer said not to).
      if (verdict.reason === RETRY_REASONS.AUTOPAY_DISABLED) {
        await db('payments')
          .where({ id: payment.id })
          .update({
            next_retry_at: null,
            failure_reason: db.raw(
              "COALESCE(failure_reason, '') || ' — retry ladder stopped: autopay disabled (collect manually)'",
            ),
          }).catch((updErr) => logger.error(`[billing-cron] retry disarm (autopay disabled) failed for payment ${payment.id}: ${updErr.message}`));
        await logAutopay(payment.customer_id, 'skipped_disabled', {
          paymentId: payment.id,
          details: { source: 'autopay_retry', ladder_stopped: true },
        }).catch(() => {});
        logger.info(`[billing-cron] Retry skipped for payment ${payment.id} — autopay disabled, ladder disarmed`);
        continue;
      }

      // STATE: paused — skip WITHOUT disarming; collection resumes when the
      // pause lapses.
      if (verdict.reason === RETRY_REASONS.AUTOPAY_PAUSED) {
        await logAutopay(payment.customer_id, 'skipped_paused', {
          paymentId: payment.id,
          details: { source: 'autopay_retry', paused_until: customer.autopay_paused_until },
        }).catch(() => {});
        continue;
      }

      // STATE: a pending prepay commitment holds the ladder (skip, stay
      // armed) until it activates or cancels.
      if (verdict.reason === RETRY_REASONS.PENDING_PREPAY_HOLD) {
        await logAutopay(payment.customer_id, 'skipped_annual_prepay_pending', {
          paymentId: payment.id,
          details: { source: 'autopay_retry' },
        }).catch(() => {});
        continue;
      }

      // Ambiguous no-PI failure: Stripe may have accepted the charge even
      // though we never saw the PI — park the ladder for manual
      // reconciliation against the Stripe dashboard.
      if (verdict.reason === RETRY_REASONS.AMBIGUOUS_OUTCOME_PARKED) {
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

      if (verdict.disposition !== RETRY_DISPOSITIONS.CHARGE) {
        // A reason this sweep does not know how to act on must never fall
        // through into a charge. Fail closed: leave the row armed, log.
        logger.error(`[billing-cron] Unhandled retry verdict ${verdict.reason}/${verdict.disposition} for payment ${payment.id} — left armed`);
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
          // Month-of-obligation stamp: this retry collects the ORIGINAL
          // failed attempt's month (obligationMonth, resolved above), not
          // the month the rung happens to land in — a July decline
          // recovered Aug 1 must not satisfy August's month-window dedupe
          // and skip a whole billing cycle.
          newPayment = await service.charge(payment.customer_id, baseAmount, monthlyDescription, {
            type: 'monthly_autopay',
            tier: monthlyCustomer?.waveguard_tier || '',
            billed_month: obligationMonth || undefined,
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
            // THIS attempt's gross, not the original obligation's.
            // charge() recomputes the total for the customer's CURRENT
            // tender and attaches the row it inserted as err.paymentRecord,
            // so a customer who moved from card to ACH between attempts is
            // quoted what we actually just tried to take. payment.amount
            // would still carry the old surcharged gross and disagree with
            // Stripe to the cent. No fallback: every other value in scope
            // can misstate the current attempt, and the amount-agreement
            // rule makes a wrong figure worse than no text (the catch below
            // logs it).
            const amountText = resolveSmsAmount(err.paymentRecord?.amount);
            if (!amountText) throw new Error(`no attempt amount for retry of payment ${payment.id} (paymentRecord ${err.paymentRecord?.id || 'missing'})`);
            const body = await renderTemplate('autopay_retry_final_failed',
              { first_name: customer.first_name, amount: amountText, update_card_url: BILLING_PORTAL_URL },
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
          // billing issue before dispatching the next visit. pauseOutcome
          // drives every downstream message — three DISTINCT states,
          // because "a payment settled" (veto) and "the write blew up"
          // (error) demand opposite operator reactions: the first needs
          // nothing, the second needs someone to look at the pause that
          // never landed.
          let pauseOutcome = 'error';
          try {
            // Concurrent-settlement guard, IN the UPDATE's predicate: if
            // any payment of this customer's settled since this attempt
            // began (a portal payment racing the exhaustion), pausing would
            // strand them — the auto-clear in billing-pause.js only fires on
            // settlements whose webhook ARRIVES after a pause exists.
            // status='paid' ONLY (an ACH 'processing' row is accepted, not
            // settled, and can still bounce; when it does settle, its
            // succeeded webhook finds the pause and auto-clears it).
            //
            // WHEN it settled: webhook-recorded rows carry Stripe's own
            // settlement moment in metadata.settled_event_at — local write
            // times lie for those (a delayed redelivery of a days-old
            // success creates/touches its row NOW and must not pose as
            // fresh money). Rows WITHOUT the stamp are synchronous local
            // recordings (stripe.js charge()), where created_at IS the
            // settlement moment. One atomic statement, so no
            // settled-and-committed payment slips between a check and the
            // write; a webhook transaction still uncommitted at the
            // UPDATE's snapshot is caught by its own post-commit clear.
            // The pause is stamped with the ATTEMPT ANCHOR, not "now":
            // service_paused_at then MEANS "the failure cycle this pause
            // answers to began here", and the auto-clear's ordering guard
            // becomes exact causality — a payment settling at-or-after this
            // moment raced the pause and clears it; anything earlier is
            // evidence the exhaustion already superseded. No heuristic
            // window, no extra column. (Cosmetics unaffected: the Customer
            // 360 banner renders the ET calendar date, and the attempt runs
            // for seconds, not days.)
            const pausedAt = attemptStartedAt;
            // Stripe's event.created is INTEGER SECONDS; a settlement later
            // in the same second as attemptStartedAt would stamp a floored
            // settled_event_at that compares as earlier and slip the veto.
            // Floor the anchor to the second — widening the veto by <1s is
            // the safe direction (an extra veto self-heals via the clear;
            // a missed one strands the customer).
            const attemptAnchor = new Date(Math.floor(attemptStartedAt.getTime() / 1000) * 1000);
            const pausedRows = await db('customers')
              .where({ id: payment.customer_id })
              // Never OVERWRITE an existing pause: a manual pause set while
              // this retry was in flight would be silently converted into an
              // auto-clearable autopay_final_failure one — and a later
              // payment would clear a pause the UI promises only clears
              // manually.
              .whereNull('service_paused_at')
              .whereNotExists(
                db('payments')
                  .select(db.raw('1'))
                  .whereRaw('payments.customer_id = customers.id')
                  .where('payments.status', 'paid')
                  // MIRRORS the auto-clear's eligibility (stripe-webhook
                  // maybeAutoClearBillingPauseForIntent): money the clear
                  // would never fire on must not veto the pause either, or
                  // the two sides disagree about the same dollar. A no-show
                  // fee is not a balance payment, and statement/payer rows
                  // are the PAYER's tender — neither says anything about
                  // the homeowner's dead card.
                  .whereRaw("(payments.metadata->>'purpose') IS DISTINCT FROM 'card_hold_no_show_fee'")
                  .whereNull('payments.statement_id')
                  .whereRaw("(payments.metadata->>'payer_id') IS NULL")
                  .where(function settledSinceAttempt() {
                    this.whereRaw("(payments.metadata->>'settled_event_at')::timestamptz >= ?", [attemptAnchor])
                      .orWhere(function unstampedLocalRecording() {
                        this.whereRaw("(payments.metadata->>'settled_event_at') IS NULL")
                          .andWhere('payments.created_at', '>=', attemptAnchor);
                      });
                  }),
              )
              .update({
                service_paused_at: pausedAt,
                service_pause_reason: 'autopay_final_failure',
              });
            if (!pausedRows) {
              // Two distinct reasons the UPDATE matched nothing, and they
              // demand different messages: an existing pause (preserved) vs
              // a settlement veto (customer just paid).
              const existing = await db('customers')
                .where({ id: payment.customer_id })
                .first('service_paused_at', 'service_pause_reason');
              if (existing?.service_paused_at) {
                pauseOutcome = 'already_paused';
                logger.warn(`[billing-cron] NOT pausing customer ${payment.customer_id} — an existing pause (${existing.service_pause_reason || 'no reason'}) is preserved`);
              } else {
                pauseOutcome = 'settlement_veto';
                logger.warn(`[billing-cron] NOT pausing customer ${payment.customer_id} — a payment settled during the final retry attempt`);
              }
            } else {
              pauseOutcome = 'applied';
              void AccountMembershipEmail.sendMembershipPaused({
                customerId: payment.customer_id,
                effectiveDate: pausedAt,
                reason: 'Payment retry attempts were exhausted',
              }).catch((emailErr) => logger.warn(`[billing-cron] service pause email failed for customer ${payment.customer_id}: ${emailErr.message}`));
            }
          } catch (pauseErr) {
            logger.error(`[billing-cron] Service pause failed: ${pauseErr.message}`);
          }

          // Alert the office so Virginia can reach out (health alert alone
          // sat on a dashboard — push-style SMS makes sure it lands).
          try {
            await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
              `🚨 Autopay exhausted: ${customer.first_name} ${customer.last_name} — $${amount} failed 3x. ${pauseOutcome === 'applied' ? 'Service paused until card is updated.' : pauseOutcome === 'settlement_veto' ? 'NOT paused — a payment settled during the attempt.' : pauseOutcome === 'already_paused' ? 'Existing pause preserved.' : 'PAUSE WRITE FAILED — customer is NOT paused, check logs.'} Last error: ${err.message}`,
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
              description: `Monthly payment for ${customer.first_name} ${customer.last_name} failed 3 times. ${pauseOutcome === 'applied' ? 'Service auto-paused.' : pauseOutcome === 'settlement_veto' ? 'Not paused — a payment settled during the attempt.' : pauseOutcome === 'already_paused' ? 'Existing pause preserved.' : 'PAUSE WRITE FAILED — customer is not paused; investigate.'} Last error: ${err.message}`,
              trigger_data: JSON.stringify({
                payment_id: payment.id,
                amount: payment.amount,
                retry_count: newRetryCount,
                service_paused: pauseOutcome === 'applied',
                pause_outcome: pauseOutcome,
              }),
            });
          } catch (alertErr) {
            logger.error(`[billing-cron] Health alert creation failed: ${alertErr.message}`);
          }

          await logAutopay(payment.customer_id, 'retry_failed', {
            amountCents: Math.round(parseFloat(payment.amount) * 100),
            paymentId: payment.id,
            details: { source: 'autopay', retry_count: newRetryCount, reason: err.message, final: true, service_paused: pauseOutcome === 'applied', pause_outcome: pauseOutcome },
          });

          logger.warn(`[billing-cron] ESCALATED: customer id=${customer.id} — 3 retries exhausted, pause outcome: ${pauseOutcome}`);
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
            // Same rule as the final-failure site above: this attempt's
            // recomputed gross, never the original obligation's.
            const amountText = resolveSmsAmount(err.paymentRecord?.amount);
            if (!amountText) throw new Error(`no attempt amount for retry of payment ${payment.id} (paymentRecord ${err.paymentRecord?.id || 'missing'})`);
            const body = await renderTemplate('autopay_retry_failed',
              { first_name: customer.first_name, amount: amountText, update_card_url: BILLING_PORTAL_URL },
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

          // Same gate swap as the initial-failure path: with the sequence
          // covering this failure episode (14-day dedupe means this call is
          // usually a no-op re-enroll, which is the point — one email per
          // episode), the per-retry transactional notice stays quiet. The
          // retry SMS above is unchanged. Same covered-reasons contract as
          // the initial-failure site: paused sequence, suppression, or error
          // fall back to the transactional notice — dunning never goes
          // email-silent.
          let retryEmailed = false;
          if (isEnabled('paymentFailedEnroll')) {
            const { enrollSequenceFromEvent } = require('./automation-enroll');
            const enrollResult = await enrollSequenceFromEvent({
              templateKey: 'payment_failed',
              customerId: customer.id,
              dedupe: 14,
              recipient: 'billing',
              checkSuppression: true,
              retryFailedUnsent: false,
              source: 'autopay_retry_failure',
            });
            retryEmailed = ['enrolled', 'deduped', 'no_email', 'no_customer'].includes(enrollResult.reason);
          }
          if (!retryEmailed) {
            await PaymentLifecycleEmail.sendPaymentRetryNotice({
              customerId: customer.id,
              paymentId: payment.id,
              retryDate: nextRetry,
            }).catch((emailErr) => {
              logger.warn(`[billing-cron] Retry notice email failed for payment ${payment.id}: ${emailErr.message}`);
            });
          }
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
        // The row the successful retry wrote. Not baseAmount: that is the
        // pre-surcharge base this attempt was computed FROM, not what the
        // customer was charged.
        const amountText = resolveSmsAmount(newPayment?.amount);
        if (!amountText) throw new Error(`no collected amount for retry of payment ${payment.id} (newPayment ${newPayment?.id || 'missing'})`);
        const body = await renderTemplate('autopay_retry_success',
          { first_name: customer.first_name, amount: amountText, receipt_line: receiptLine },
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
// Exposed for the stripe-webhook async-bounce arming path, which mirrors the
// synchronous catch's first-rung cadence (RETRY_DELAYS_DAYS[0]) exactly.
module.exports.RETRY_DELAYS_DAYS = RETRY_DELAYS_DAYS;
module.exports.resolveSmsAmount = resolveSmsAmount;
