const db = require('../models/db');
const logger = require('./logger');
const PaymentRouter = require('./payment-router');
const TwilioService = require('./twilio');

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
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString().split('T')[0];
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString().split('T')[0];

    logger.info(`[billing-cron] Starting monthly billing for ${monthStart}`);

    // Get active customers with a monthly rate
    const customers = await db('customers')
      .where({ active: true })
      .where('monthly_rate', '>', 0)
      .select('id', 'first_name', 'last_name', 'phone', 'monthly_rate', 'waveguard_tier');

    let charged = 0;
    let skipped = 0;
    let failed = 0;

    for (const customer of customers) {
      try {
        // Check if already charged this month (paid or processing)
        const existingCharge = await db('payments')
          .where({ customer_id: customer.id })
          .where('payment_date', '>=', monthStart)
          .where('payment_date', '<=', monthEnd)
          .where('description', 'like', '%WaveGuard Monthly%')
          .whereIn('status', ['paid', 'processing'])
          .first();

        if (existingCharge) {
          skipped++;
          continue;
        }

        // Get the correct processor for this customer
        const service = await PaymentRouter.getServiceForCustomer(customer.id);

        // Charge
        await service.chargeMonthly(customer.id);
        charged++;

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

        // Send failure SMS
        try {
          await TwilioService.sendSMS(
            customer.phone,
            `Hi ${customer.first_name}, your WaveGuard monthly payment of $${customer.monthly_rate} could not be processed. We'll retry in a few days. Please update your payment method at your customer portal if needed.`
          );
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
              ...(payment.metadata ? JSON.parse(payment.metadata) : {}),
              retried_at: now,
              retry_payment_id: newPayment?.id || null,
            }),
          });

        succeeded++;

        // Send success SMS
        try {
          await TwilioService.sendSMS(
            customer.phone,
            `Hi ${customer.first_name}, great news! Your payment of $${amount.toFixed(2)} has been successfully processed. Thank you for being a Waves customer!`
          );
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

          // Send final failure SMS
          try {
            await TwilioService.sendSMS(
              customer.phone,
              `Hi ${customer.first_name}, we've been unable to process your payment of $${parseFloat(payment.amount).toFixed(2)} after multiple attempts. Please update your payment method in your Waves customer portal or contact us at (239) 300-9283. Thank you.`
            );
          } catch (smsErr) {
            logger.error(`[billing-cron] Final SMS failed: ${smsErr.message}`);
          }

          // Create health alert for admin review
          try {
            await db('customer_health_alerts').insert({
              customer_id: payment.customer_id,
              alert_type: 'payment_failure',
              severity: 'high',
              title: `Payment failed after 3 retries — $${parseFloat(payment.amount).toFixed(2)}`,
              description: `Monthly payment for ${customer.first_name} ${customer.last_name} failed 3 times. Last error: ${err.message}`,
              metadata: JSON.stringify({
                payment_id: payment.id,
                amount: payment.amount,
                retry_count: newRetryCount,
              }),
            });
          } catch (alertErr) {
            logger.error(`[billing-cron] Health alert creation failed: ${alertErr.message}`);
          }

          logger.warn(`[billing-cron] ESCALATED: ${customer.first_name} ${customer.last_name} — 3 retries exhausted`);
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

          // Send retry SMS
          try {
            await TwilioService.sendSMS(
              customer.phone,
              `Hi ${customer.first_name}, your payment of $${parseFloat(payment.amount).toFixed(2)} could not be processed. We'll try again soon. Please update your payment method if needed.`
            );
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
