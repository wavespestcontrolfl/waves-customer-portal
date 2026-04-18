const db = require('../models/db');
const logger = require('./logger');
const PaymentRouter = require('./payment-router');
const TwilioService = require('./twilio');
const { logAutopay } = require('./autopay-log');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');
const smsTemplatesRouter = require('../routes/admin-sms-templates');

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

const WAVES_OFFICE_PHONE = '+19413187612';
const BILLING_PORTAL_URL = 'https://portal.wavespestcontrol.com/?tab=billing';

// Render an SMS template from the DB, falling back to an inline body. Keeps
// billing-cron copy editable from the admin UI without a deploy.
async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body && !body.includes('{first_name}')) return body;
    }
  } catch { /* fall through */ }
  return fallback;
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
      .select(
        'id', 'first_name', 'last_name', 'phone', 'monthly_rate', 'waveguard_tier',
        'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id',
        'billing_day',
      );

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

        // GUARD 3: wrong billing day — skip silently (no log; not an anomaly)
        // Note: the cron currently runs only on the 1st, so this only matters
        // for customers whose billing_day is NOT 1. When scheduler flips to
        // daily, this guard activates for all custom days.
        if (customer.billing_day && customer.billing_day !== todayDay) {
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
          const amount = parseFloat(customer.monthly_rate).toFixed(2);
          const body = await renderTemplate('autopay_charge_success',
            { first_name: customer.first_name, amount, receipt_line: receiptLine },
            `Hi ${customer.first_name}, your WaveGuard monthly payment of $${amount} was successfully processed. Thank you!${receiptLine}`
          );
          await TwilioService.sendSMS(customer.phone, body);
        } catch (smsErr) {
          logger.error(`[billing-cron] Payment confirmation SMS failed: ${smsErr.message}`);
        }

        logger.info(`[billing-cron] Charged $${customer.monthly_rate} for ${customer.first_name} ${customer.last_name}`);
      } catch (err) {
        failed++;
        logger.error(`[billing-cron] Failed to charge ${customer.first_name} ${customer.last_name} (${customer.id}): ${err.message}`);

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
          const amount = parseFloat(customer.monthly_rate).toFixed(2);
          const body = await renderTemplate('autopay_charge_failed',
            { first_name: customer.first_name, amount, update_card_url: BILLING_PORTAL_URL },
            `Hi ${customer.first_name}, your WaveGuard monthly payment of $${amount} couldn't be processed. We'll retry automatically in a few days — update your card here if you'd like to fix it now: ${BILLING_PORTAL_URL}\n\nQuestions? (941) 318-7612`
          );
          await TwilioService.sendSMS(customer.phone, body);
        } catch (smsErr) {
          logger.error(`[billing-cron] SMS notification failed: ${smsErr.message}`);
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

      try {
        // Get the correct processor
        const service = await PaymentRouter.getServiceForCustomer(payment.customer_id);

        // Re-attempt the charge
        const amount = parseFloat(payment.amount);
        const description = payment.description.replace(' — FAILED', '');
        let newPayment;

        if (description.includes('WaveGuard Monthly')) {
          newPayment = await service.chargeMonthly(payment.customer_id);
        } else {
          newPayment = await service.chargeOneTime(payment.customer_id, amount, description);
        }

        // Mark original failed payment as superseded
        await db('payments')
          .where({ id: payment.id })
          .update({
            status: 'paid',
            retry_count: payment.retry_count + 1,
            next_retry_at: null,
            metadata: JSON.stringify({
              ...(payment.metadata ? (typeof payment.metadata === 'string' ? JSON.parse(payment.metadata) : payment.metadata) : {}),
              retried_at: now,
              retry_payment_id: newPayment?.id || null,
            }),
          });

        succeeded++;

        await logAutopay(payment.customer_id, 'retry_success', {
          amountCents: Math.round(parseFloat(payment.amount) * 100),
          paymentId: newPayment?.id || null,
          details: { source: 'autopay', retry_count: payment.retry_count + 1, original_payment_id: payment.id },
        });

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
            { first_name: customer.first_name, amount: amount.toFixed(2), receipt_line: receiptLine },
            `Hi ${customer.first_name}, great news — your payment of $${amount.toFixed(2)} just went through. Thank you for being a Waves customer!${receiptLine}`
          );
          await TwilioService.sendSMS(customer.phone, body);
        } catch (smsErr) {
          logger.error(`[billing-cron] Success SMS failed: ${smsErr.message}`);
        }

        logger.info(`[billing-cron] Retry succeeded for ${customer.first_name} ${customer.last_name}: $${amount}`);
      } catch (err) {
        failedAgain++;
        const newRetryCount = payment.retry_count + 1;

        logger.error(`[billing-cron] Retry #${newRetryCount} failed for ${customer.first_name} ${customer.last_name}: ${err.message}`);

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
              { first_name: customer.first_name, amount, update_card_url: BILLING_PORTAL_URL },
              `Hi ${customer.first_name}, after several attempts we still couldn't process your payment of $${amount}. Please update your card to keep your service active: ${BILLING_PORTAL_URL}\n\nQuestions? Call (941) 318-7612 or reply to this message.`
            );
            await TwilioService.sendSMS(customer.phone, body);
          } catch (smsErr) {
            logger.error(`[billing-cron] Final SMS failed: ${smsErr.message}`);
          }

          // Pause service so we stop burning charges (next month's cron skips
          // customers with service_paused_at set) and so dispatch can see the
          // billing issue before dispatching the next visit.
          try {
            await db('customers').where({ id: payment.customer_id }).update({
              service_paused_at: new Date(),
              service_pause_reason: 'autopay_final_failure',
            });
          } catch (pauseErr) {
            logger.error(`[billing-cron] Service pause failed: ${pauseErr.message}`);
          }

          // Alert the office so Virginia can reach out (health alert alone
          // sat on a dashboard — push-style SMS makes sure it lands).
          try {
            await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
              `🚨 Autopay exhausted: ${customer.first_name} ${customer.last_name} — $${amount} failed 3x. Service paused until card is updated. Last error: ${err.message}`
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
              metadata: JSON.stringify({
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

          logger.warn(`[billing-cron] ESCALATED: ${customer.first_name} ${customer.last_name} — 3 retries exhausted, service paused`);
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
            const amount = parseFloat(payment.amount).toFixed(2);
            const body = await renderTemplate('autopay_retry_failed',
              { first_name: customer.first_name, amount, update_card_url: BILLING_PORTAL_URL },
              `Hi ${customer.first_name}, your payment of $${amount} still didn't go through. We'll try again in a few days — or update your card here to fix it now: ${BILLING_PORTAL_URL}\n\nQuestions? (941) 318-7612`
            );
            await TwilioService.sendSMS(customer.phone, body);
          } catch (smsErr) {
            logger.error(`[billing-cron] Retry SMS failed: ${smsErr.message}`);
          }
        }
      }
    }

    logger.info(`[billing-cron] Retries complete: ${retried} attempted, ${succeeded} succeeded, ${failedAgain} failed again`);

    return { retried, succeeded, failed: failedAgain };
  },
};

module.exports = BillingCron;
