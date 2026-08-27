const db = require('../models/db');
const logger = require('./logger');
const { logAutopay, eventExistsRecently } = require('./autopay-log');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const PaymentLifecycleEmail = require('./payment-lifecycle-email');
const { isPaused } = require('./autopay-eligibility');

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
  let customersQuery = db('customers')
    .where({ active: true, autopay_enabled: true })
    .where('monthly_rate', '>', 0)
    .where('billing_day', targetDay)
    .whereNull('deleted_at')
    .select('id', 'first_name', 'phone', 'monthly_rate', 'autopay_paused_until', 'waveguard_tier');
  // Non-monthly billing modes keep monthly_rate populated (legacy surfaces)
  // but the monthly cron never charges them (GUARD 3b) — never text a
  // reminder for a monthly charge that will not run (Codex round-2 + 5):
  // per_application collects per completed visit, annual_prepay is
  // term-covered and collects at renewal. NULL rows follow the lane
  // resolver's inference exactly as the cron's GUARD 3c does — a tier-less
  // or sentinel-tier row resolves per_visit and gets no pre-charge text
  // (Codex r8). Column-guarded pre-migration.
  try {
    if (await db.schema.hasColumn('customers', 'billing_mode')) {
      const { MONTHLY_LANE_SQL } = require('./billing-lane');
      customersQuery = customersQuery.whereRaw(MONTHLY_LANE_SQL);
    }
  } catch { /* billing_mode column absent — keep legacy selection */ }
  const customers = await customersQuery;

  let sent = 0;
  let skipped = 0;

  for (const c of customers) {
    try {
      if (!c.phone) { skipped++; continue; }

      // Skip if paused through the charge date
      if (isPaused(c, target)) {
        skipped++; continue;
      }

      // Dedup: one reminder per customer per billing cycle
      const already = await eventExistsRecently(c.id, 'pre_charge_reminder_sent', 25);
      if (already) { skipped++; continue; }

      const dateStr = target.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
      // Plan-aware branding (owner ruling 2026-07-30): the monthly lane
      // includes explicit monthly-membership customers WITHOUT a WaveGuard
      // tier, so the old hardcoded "WaveGuard auto-pay" copy misbranded them
      // — the sms-guard stopgap blocked every pre-charge text over it.
      const { isMembershipTier } = require('./billing-lane');
      const autopayLabel = isMembershipTier(c.waveguard_tier) ? 'WaveGuard auto-pay' : 'Waves auto-pay';
      const body = await renderSmsTemplate(
        'autopay_pre_charge',
        { first_name: c.first_name, charge_date: dateStr, autopay_label: autopayLabel },
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

// ET calendar parts, not local Date construction (hook #3495 P1):
// `new Date(y, m, 0) < now` runs in Railway's UTC and marks the card
// expired throughout its final calendar day. Charge-path semantics: a card
// is valid through the END of its expiry month in ET, so diff the month's
// last day against ET-today as plain dates (UTC-midnight anchors both
// sides — the timezone cancels out of the difference). expYear arrives
// already +2000-normalized by the caller.
function cardExpiryOutlook(expYear, expMonth, now) {
  const lastDayOfExpMonth = new Date(Date.UTC(expYear, Number(expMonth), 0));
  const etTodayUtc = new Date(`${etDateString(now)}T00:00:00Z`);
  const daysUntil = Math.round((lastDayOfExpMonth.getTime() - etTodayUtc.getTime()) / 86400000);
  return { daysUntil, expired: daysUntil < 0 };
}

async function sendCardExpiryWarnings() {
  const now = new Date();
  const sixty = addETDays(now, 60);

  logger.info(`[autopay-notifications] Card expiry warnings — scanning next 60 days`);

  // Current-method selection, charge-path semantics (codex #3495 r17): the
  // old scan warned on EVERY autopay_enabled payment_methods row inside the
  // expiry window — replaced non-default cards and legacy bank rows with
  // populated expiry fields all generated false customer warnings. The one
  // method that matters is the method charge() would use, so reuse the
  // existing walk (getChargeableAutopayMethod) instead of a third SQL
  // mirror of the pointer/default predicate:
  //   - chargeable CURRENT method is a card  → warn if it expires soon;
  //   - chargeable CURRENT method is a bank  → the customer is charged via
  //     ACH — a card notice is noise, skip;
  //   - NOTHING chargeable → the card charge() WOULD have wanted (pointer
  //     first, else newest default card) is expired/expiring — that is
  //     exactly the "autopay will fail" warning this job exists for.
  const { getChargeableAutopayMethod, isBankMethodType } = require('./autopay-eligibility');
  const customers = await db('customers')
    .where({ active: true, autopay_enabled: true })
    .whereNull('deleted_at')
    .select('id', 'first_name', 'phone', 'ach_status', 'autopay_payment_method_id');

  // Prepay-covered customers get NO card warning (getCardExpiryExemptCustomerIds,
  // shared with the dashboard alert and the daily payment-expiry workflow):
  // coverage still active at the end of the 60-day outlook means no card
  // charge inside it, so "your card expires, autopay will fail" would be a
  // false alarm to a customer who paid the year up front. Coverage ending
  // inside the window is not covered at the horizon and keeps its warning
  // (that card is needed to renew); so does a covered customer with a
  // still-collectible pre-term retry.
  let coveredIds = new Set();
  try {
    const { getCardExpiryExemptCustomerIds } = require('./annual-prepay-renewals');
    coveredIds = await getCardExpiryExemptCustomerIds(etDateString(sixty));
  } catch (coverErr) {
    logger.warn(`[autopay-notifications] prepay exemption lookup failed, not excluding: ${coverErr.message}`);
  }
  let prepayCovered = 0;

  const rows = [];
  for (const customer of customers) {
    if (coveredIds.has(String(customer.id))) { prepayCovered += 1; continue; }
    try {
      let target = null;
      const current = await getChargeableAutopayMethod(customer, db, { now });
      if (current) {
        if (!isBankMethodType(current.method_type)) {
          // The walk's select has no display columns — refetch for the SMS.
          target = await db('payment_methods')
            .where({ id: current.id })
            .first('id', 'method_type', 'card_brand', 'last_four', 'exp_month', 'exp_year') || current;
        }
      } else {
        // Nothing chargeable — surface the card charge() would have used.
        const methods = await db('payment_methods')
          .where({ customer_id: customer.id, processor: 'stripe', autopay_enabled: true })
          .whereNotNull('stripe_payment_method_id')
          .orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'id', order: 'asc' }])
          .select('id', 'method_type', 'is_default', 'card_brand', 'last_four', 'exp_month', 'exp_year');
        const pointer = methods.find((m) => String(m.id) === String(customer.autopay_payment_method_id));
        if (pointer && !isBankMethodType(pointer.method_type)) target = pointer;
        else target = methods.find((m) => m.is_default === true && !isBankMethodType(m.method_type)) || null;
      }
      if (!target) continue;
      // Same guarded parsing as the charge path — malformed expiry fields
      // are payment-expiry's unchargeable story, not a dated card warning.
      const expMonth = Number(target.exp_month);
      const rawYear = Number(target.exp_year);
      const expYear = Number.isFinite(rawYear) && rawYear > 0 && rawYear < 100 ? rawYear + 2000 : rawYear;
      if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isInteger(expYear)) continue;
      // Window: first day of the expiry month within the next 60 ET days
      // (expired cards stay included — daysUntil goes negative).
      const firstOfExpMonth = new Date(Date.UTC(expYear, expMonth - 1, 1));
      if (firstOfExpMonth > new Date(`${etDateString(sixty)}T00:00:00Z`)) continue;
      rows.push({
        customer_id: customer.id,
        first_name: customer.first_name,
        phone: customer.phone,
        payment_method_id: target.id,
        brand: target.card_brand,
        last4: target.last_four,
        exp_month: target.exp_month,
        exp_year: target.exp_year,
      });
    } catch (walkErr) {
      logger.error(`[autopay-notifications] expiry candidate walk failed for ${customer.id}: ${walkErr.message}`);
    }
  }

  let sent = 0;
  let skipped = 0;

  for (const r of rows) {
    try {
      // Same +2000 normalization as the SQL window and the charge path.
      const rawExpYear = Number(r.exp_year);
      const expYear = Number.isFinite(rawExpYear) && rawExpYear > 0 && rawExpYear < 100 ? rawExpYear + 2000 : rawExpYear;
      const { daysUntil, expired } = cardExpiryOutlook(expYear, r.exp_month, now);
      const eventType = expired ? 'card_expired' : 'card_expiring_soon';
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

  logger.info(`[autopay-notifications] Expiry warnings: ${sent} sent, ${skipped} skipped of ${rows.length}; ${prepayCovered} prepay-covered customer(s) exempt`);
  return { sent, skipped, total: rows.length };
}

module.exports = { sendPreChargeReminders, sendCardExpiryWarnings, cardExpiryOutlook };
