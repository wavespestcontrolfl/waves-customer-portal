const db = require('../models/db');
const logger = require('./logger');
const { logAutopay, eventExistsRecently } = require('./autopay-log');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const PaymentLifecycleEmail = require('./payment-lifecycle-email');

/**
 * Autopay Notifications
 *
 * Proactive customer SMS about autopay state.
 *  sendPreChargeReminders()  — daily 9 AM: 3 days before scheduled charge
 *  sendCardExpiryWarnings()  — Monday 9 AM: cards expiring within 60 days
 *
 * Both functions are idempotent — they use autopay_log.eventExistsRecently
 * to avoid duplicate sends.
 */

async function sendPreChargeReminders() {
  // Target = ET calendar date, 3 days from now. billing_day is a calendar
  // day-of-month (1-31), so this match must be done in ET.
  const today = new Date();
  const target = addETDays(today, 3);
  const targetParts = etParts(target);
  const targetDay = targetParts.day;

  logger.info(`[autopay-notifications] Pre-charge reminders for billing_day=${targetDay}`);

  // Active autopay customers whose billing_day matches 3 days from now
  const customers = await db('customers')
    .where({ active: true, autopay_enabled: true })
    .where('monthly_rate', '>', 0)
    .where('billing_day', targetDay)
    .whereNull('deleted_at')
    .select('id', 'first_name', 'phone', 'monthly_rate', 'autopay_paused_until');

  let sent = 0;
  let skipped = 0;

  for (const c of customers) {
    try {
      if (!c.phone) { skipped++; continue; }

      // Skip if paused through the charge date
      if (c.autopay_paused_until && new Date(c.autopay_paused_until) >= target) {
        skipped++; continue;
      }

      // Dedup: one reminder per customer per billing cycle
      const already = await eventExistsRecently(c.id, 'pre_charge_reminder_sent', 25);
      if (already) { skipped++; continue; }

      const dateStr = target.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
      const body = await renderSmsTemplate(
        'autopay_pre_charge',
        { first_name: c.first_name, charge_date: dateStr },
        { workflow: 'autopay_pre_charge', entity_type: 'customer', entity_id: c.id },
      );
      if (!body) {
        logger.warn(`[autopay-notifications] autopay_pre_charge template missing/disabled for customer ${c.id}`);
        skipped++; continue;
      }
      const sendResult = await sendCustomerMessage({
        to: c.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'autopay',
        customerId: c.id,
        entryPoint: 'autopay_pre_charge_reminder',
        metadata: { original_message_type: 'autopay_pre_charge' },
      });
      if (sendResult.blocked || sendResult.sent === false) {
        throw new Error(`autopay reminder SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
      }

      await logAutopay(c.id, 'pre_charge_reminder_sent', {
        amountCents: Math.round(parseFloat(c.monthly_rate) * 100),
        details: { charge_date: etDateString(target) },
      });
      sent++;
    } catch (err) {
      logger.error(`[autopay-notifications] reminder failed for ${c.id}: ${err.message}`);
    }
  }

  logger.info(`[autopay-notifications] Pre-charge reminders: ${sent} sent, ${skipped} skipped of ${customers.length}`);
  return { sent, skipped, total: customers.length };
}

async function sendCardExpiryWarnings() {
  const now = new Date();
  const sixty = addETDays(now, 60);

  logger.info(`[autopay-notifications] Card expiry warnings — scanning next 60 days`);

  // Active autopay customers with a designated autopay payment method expiring soon
  const rows = await db('payment_methods')
    .join('customers', 'customers.id', 'payment_methods.customer_id')
    .where('customers.active', true)
    .where('customers.autopay_enabled', true)
    .whereNull('customers.deleted_at')
    .where('payment_methods.autopay_enabled', true)
    .whereRaw(
      "make_date(payment_methods.exp_year::int, payment_methods.exp_month::int, 1) <= ?",
      [etDateString(sixty)]
    )
    .select(
      'customers.id as customer_id', 'customers.first_name', 'customers.phone',
      'payment_methods.id as payment_method_id',
      'payment_methods.card_brand as brand',
      'payment_methods.last_four as last4',
      'payment_methods.exp_month', 'payment_methods.exp_year',
    );

  let sent = 0;
  let skipped = 0;

  for (const r of rows) {
    try {
      const expDate = new Date(r.exp_year, r.exp_month, 0);
      const expired = expDate < now;
      const eventType = expired ? 'card_expired' : 'card_expiring_soon';
      const daysUntil = Math.ceil((expDate.getTime() - now.getTime()) / 86400000);
      const reminderStage = expired ? 'expired' : (daysUntil <= 7 ? '7_day' : (daysUntil <= 30 ? '30_day' : null));

      const emailPromise = reminderStage
        ? PaymentLifecycleEmail.sendPaymentMethodExpiring({
          customerId: r.customer_id,
          paymentMethodId: r.payment_method_id,
          reminderStage,
          now,
        }).catch((emailErr) => {
          logger.warn(`[autopay-notifications] expiry email failed for ${r.customer_id}: ${emailErr.message}`);
        })
        : Promise.resolve();

      if (!r.phone) { await emailPromise; skipped++; continue; }

      // Dedup: one per card per 30 days
      const already = await eventExistsRecently(r.customer_id, eventType, 30, r.payment_method_id);
      if (already) { await emailPromise; skipped++; continue; }

      const expStr = `${String(r.exp_month).padStart(2, '0')}/${String(r.exp_year).slice(-2)}`;
      const templateKey = expired ? 'autopay_card_expired' : 'autopay_card_expiring';
      const body = await renderSmsTemplate(
        templateKey,
        {
          first_name: r.first_name,
          card_brand: r.brand || 'payment',
          last_four: r.last4,
          exp_date: expStr,
        },
        { workflow: templateKey, entity_type: 'payment_method', entity_id: r.payment_method_id },
      );
      if (!body) {
        logger.warn(`[autopay-notifications] ${templateKey} template missing/disabled for customer ${r.customer_id}`);
        await emailPromise;
        skipped++; continue;
      }

      const sendResult = await sendCustomerMessage({
        to: r.phone,
        body,
        channel: 'sms',
        audience: 'customer',
        purpose: 'autopay',
        customerId: r.customer_id,
        entryPoint: 'autopay_card_expiry_warning',
        metadata: { original_message_type: 'payment_expiry' },
      });
      if (sendResult.blocked || sendResult.sent === false) {
        throw new Error(`card expiry SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
      }

      await logAutopay(r.customer_id, eventType, {
        paymentMethodId: r.payment_method_id,
        details: { exp_month: r.exp_month, exp_year: r.exp_year, brand: r.brand, last4: r.last4 },
      });
      await emailPromise;
      sent++;
    } catch (err) {
      logger.error(`[autopay-notifications] expiry warning failed for ${r.customer_id}: ${err.message}`);
    }
  }

  logger.info(`[autopay-notifications] Expiry warnings: ${sent} sent, ${skipped} skipped of ${rows.length}`);
  return { sent, skipped, total: rows.length };
}

module.exports = { sendPreChargeReminders, sendCardExpiryWarnings };
