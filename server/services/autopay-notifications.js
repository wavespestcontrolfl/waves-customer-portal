const db = require('../models/db');
const logger = require('./logger');
const { logAutopay, eventExistsRecently } = require('./autopay-log');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

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
      const body = `Hi ${c.first_name}, this is a friendly reminder from Waves: your WaveGuard auto-pay will process on ${dateStr}. Need to update your card or pause? Log in at your customer portal. Thank you!`;
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
      if (!r.phone) { skipped++; continue; }

      const expDate = new Date(r.exp_year, r.exp_month, 0);
      const expired = expDate < now;
      const eventType = expired ? 'card_expired' : 'card_expiring_soon';

      // Dedup: one per card per 30 days
      const already = await eventExistsRecently(r.customer_id, eventType, 30, r.payment_method_id);
      if (already) { skipped++; continue; }

      const expStr = `${String(r.exp_month).padStart(2, '0')}/${String(r.exp_year).slice(-2)}`;
      const body = expired
        ? `Hi ${r.first_name}, your ${r.brand || 'card'} ending in ${r.last4} on file with Waves has expired (${expStr}). Please update it in your customer portal to keep auto-pay active. Thank you!`
        : `Hi ${r.first_name}, heads up - your ${r.brand || 'card'} ending in ${r.last4} on file with Waves expires ${expStr}. Update it in your customer portal to avoid any auto-pay disruption. Thank you!`;

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
      sent++;
    } catch (err) {
      logger.error(`[autopay-notifications] expiry warning failed for ${r.customer_id}: ${err.message}`);
    }
  }

  logger.info(`[autopay-notifications] Expiry warnings: ${sent} sent, ${skipped} skipped of ${rows.length}`);
  return { sent, skipped, total: rows.length };
}

module.exports = { sendPreChargeReminders, sendCardExpiryWarnings };
