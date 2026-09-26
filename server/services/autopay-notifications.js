const db = require('../models/db');
const logger = require('./logger');
const { logAutopay, eventExistsRecently } = require('./autopay-log');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const PaymentLifecycleEmail = require('./payment-lifecycle-email');
const { isPaused } = require('./autopay-eligibility');
const { MONTHLY_LANE_SQL, isMembershipTier, resolveBillingLane } = require('./billing-lane');
const { billingChannelAllowed } = require('./billing-delivery-channels');

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

// A customer without a phone is reachable only through an explicit App or
// Email choice. Each selected leg is dispatched on its own, keyed like the
// other billing workflows (billingDeliveryLeg + appOnly for App), and each
// accepted leg records its own autopay_log progress so an unfinished sibling
// still sends on a later run instead of being retired by the accepted one.
const NO_PHONE_LEGS = ['push', 'email'];

// Selected legs that have not yet been accepted for this billing cycle.
async function pendingPreChargeLegs(customerId) {
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
  const pending = [];
  for (const channel of NO_PHONE_LEGS) {
    if (billingChannelAllowed(prefs || {}, 'billing', channel) !== true) continue;
    if (await eventExistsRecently(customerId, 'pre_charge_reminder_sent', 25, null, { channel })) continue;
    pending.push(channel);
  }
  return pending;
}

async function sendPreChargeLegs({ customer, target, legs, sendInput, amountCents }) {
  const chargeDate = etDateString(target);
  const eventKey = `autopay-pre-charge:${customer.id}:${chargeDate}`;
  let delivered = 0;
  let code = null;
  for (const channel of legs) {
    let result;
    try {
      result = await sendCustomerMessage({
        ...sendInput,
        to: null,
        channel,
        metadata: {
          ...sendInput.metadata,
          billingDeliveryCategory: 'billing',
          notificationEventKey: eventKey,
          // The queued Email owner re-checks eligibility against this date.
          charge_date: chargeDate,
          billingDeliveryLeg: channel,
          ...(channel === 'push' ? { appOnly: true } : {}),
        },
      });
    } catch (err) {
      // One leg's failure never skips its sibling; a throw after the
      // provider may have accepted carries its own outcome and is not
      // stamped as progress.
      result = err.providerOutcome || { sent: false, deliveryOutcome: 'uncertain', code: err.message };
    }
    if (result.code === 'lane_changed') return { laneChanged: true, reason: result.reason };
    if (result.deliveryOutcome === 'accepted') {
      await logAutopay(customer.id, 'pre_charge_reminder_sent', {
        amountCents,
        details: { charge_date: chargeDate, channel },
      });
      delivered++;
    } else {
      code = result.code || result.reason || 'unknown';
      logger.warn(`[autopay-notifications] pre-charge ${channel} leg not delivered for ${customer.id}: ${code}`);
    }
  }
  return { delivered, code };
}

async function sendPreChargeReminders() {
  // Target = ET calendar date, 3 days from now. billing_day is a calendar
  // day-of-month (1-31), so this match must be done in ET. The two days
  // after that re-select ONLY a no-phone customer, whose selected App /
  // Email leg may have been refused on the first pass: the per-leg cooldown
  // keeps an accepted leg from repeating, so a refused leg is retried each
  // remaining day before the charge instead of waiting a whole cycle.
  const today = new Date();
  const targets = [3, 2, 1].map((days) => addETDays(today, days));
  const dayOf = (date) => Number(etParts(date).day);
  const targetDay = dayOf(targets[0]);
  const retryDays = targets.slice(1).map(dayOf);

  logger.info(`[autopay-notifications] Pre-charge reminders for billing_day=${targetDay}`);

  // Active autopay customers whose billing_day matches 3 days from now.
  // Non-monthly billing modes keep monthly_rate populated (legacy surfaces)
  // but the monthly cron never charges them (GUARD 3b) — never text a
  // reminder for a monthly charge that will not run (Codex round-2 + 5):
  // per_application collects per completed visit, annual_prepay is
  // term-covered and collects at renewal. NULL rows follow the lane
  // resolver's inference exactly as the cron's GUARD 3c does — a tier-less
  // or sentinel-tier row resolves per_visit and gets no pre-charge text
  // (Codex r8).
  //
  // FAIL CLOSED (2026-08-29 incident): this filter used to sit behind a
  // `db.schema.hasColumn` probe wrapped in try/catch that fell back to the
  // unfiltered legacy select. A Railway deploy swap at 09:00:53 made the
  // probe throw exactly as the 09:00 cron fired, the filter silently
  // dropped, and 12 prepay / per-application customers were texted about a
  // "monthly charge" that would never run. billing_mode has existed since
  // migration 20260709000010, so the probe is gone: the lane filter is
  // unconditional (the .whereRaw(MONTHLY_LANE_SQL) in the chain below),
  // and if the column were ever missing the query throws and
  // the run aborts instead of texting everyone.
  const customersQuery = db('customers')
    .where({ active: true, autopay_enabled: true })
    .where('monthly_rate', '>', 0)
    .whereRaw(MONTHLY_LANE_SQL)
    .where(function eligibleBillingDay() {
      this.where('billing_day', targetDay)
        .orWhere(function noPhoneRetry() {
          this.whereRaw("COALESCE(phone, '') = ''").whereIn('billing_day', retryDays);
        });
    })
    .whereNull('deleted_at')
    .select('id', 'first_name', 'phone', 'monthly_rate', 'autopay_paused_until', 'waveguard_tier', 'billing_mode', 'billing_day');
  const customers = await customersQuery;

  let sent = 0;
  let skipped = 0;

  for (const c of customers) {
    try {
      // The charge date this row was selected for (T+3 for a phone
      // customer; a retry day only re-selects a no-phone customer).
      const target = targets.find((date) => dayOf(date) === Number(c.billing_day)) || targets[0];
      // No phone: only an explicit App / Email choice can carry the
      // reminder, and each selected leg is dispatched on its own below
      // (null = the customer has a phone and gets the single Text).
      const pendingLegs = c.phone ? null : await pendingPreChargeLegs(c.id);

      // Skip if paused through the charge date
      if (isPaused(c, target)) {
        skipped++; continue;
      }

      // Dedup: one reminder per customer per billing cycle (per selected
      // leg for a no-phone customer, so an accepted App never retires an
      // unfinished Email).
      const already = pendingLegs ? !pendingLegs.length : await eventExistsRecently(c.id, 'pre_charge_reminder_sent', 25);
      if (already) { skipped++; continue; }

      const dateStr = target.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' });
      // Plan-aware branding (owner ruling 2026-07-30): the monthly lane
      // includes explicit monthly-membership customers WITHOUT a WaveGuard
      // tier, so the old hardcoded "WaveGuard auto-pay" copy misbranded them
      // — the sms-guard stopgap blocked every pre-charge text over it.
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
      const sendInput = {
        body,
        audience: 'customer',
        purpose: 'autopay',
        customerId: c.id,
        entryPoint: 'autopay_pre_charge_reminder',
        // Lane AT SEND TIME (codex #3607 r2 + r5 + r7 + r8): the stamp is
        // the verdict preDispatchCheck below enforces at the wrapper's last
        // caller-visible abort point — the send only proceeds when the
        // customer resolves monthly_membership there, so a legacy NULL-mode
        // member stamps 'monthly_membership', never a null the owner digest
        // would flag. The digest classifies against this stamp, not the
        // customer's lane at read time.
        metadata: { original_message_type: 'autopay_pre_charge', billing_mode_at_send: 'monthly_membership' },
        // Fresh verdict at the wrapper's final abort point (codex #3607 r7
        // + r8): the lane filter ran once for the whole batch, and render +
        // validators are further awaits — a customer moved out of the
        // monthly lane, off autopay, or deleted in the meantime must not get
        // a monthly-charge reminder stamped as valid. Null refetch = block
        // (fail closed).
        preDispatchCheck: async () => {
          const fresh = await db('customers')
            .where({ id: c.id })
            .first('billing_mode', 'waveguard_tier', 'monthly_rate', 'autopay_enabled', 'active', 'deleted_at');
          if (!fresh || fresh.deleted_at || fresh.active === false) return { ok: false, code: 'lane_changed', reason: 'customer no longer active' };
          if (fresh.autopay_enabled === false) return { ok: false, code: 'lane_changed', reason: 'autopay disabled before dispatch' };
          if (!(Number(fresh.monthly_rate || 0) > 0)) return { ok: false, code: 'lane_changed', reason: 'no monthly rate before dispatch' };
          const mode = resolveBillingLane(fresh).mode;
          return mode === 'monthly_membership'
            ? { ok: true }
            : { ok: false, code: 'lane_changed', reason: `lane is ${mode} at dispatch` };
        },
      };
      const amountCents = Math.round(parseFloat(c.monthly_rate) * 100);
      if (pendingLegs) {
        const outcome = await sendPreChargeLegs({ customer: c, target, legs: pendingLegs, sendInput, amountCents });
        if (outcome.laneChanged) {
          logger.info(`[autopay-notifications] pre-charge skipped for ${c.id}: ${outcome.reason}`);
          skipped++; continue;
        }
        if (!outcome.delivered) throw new Error(`autopay reminder blocked: ${outcome.code || 'unknown'}`);
        sent++; continue;
      }
      const sendResult = await sendCustomerMessage({ to: c.phone, channel: 'sms', ...sendInput });
      if (sendResult.code === 'lane_changed') {
        logger.info(`[autopay-notifications] pre-charge skipped for ${c.id}: ${sendResult.reason}`);
        skipped++; continue;
      }
      if (sendResult.blocked || sendResult.sent === false) {
        throw new Error(`autopay reminder SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
      }

      await logAutopay(c.id, 'pre_charge_reminder_sent', {
        amountCents,
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
    .select('id', 'first_name', 'phone', 'ach_status', 'autopay_payment_method_id', 'billing_mode', 'waveguard_tier', 'monthly_rate');

  // Prepay-covered customers get NO card warning (getCardExpiryExemptions,
  // shared with the dashboard alert and the daily payment-expiry workflow):
  // coverage still active at the end of the 60-day outlook means no card
  // charge inside it, so "your card expires, autopay will fail" would be a
  // false alarm to a customer who paid the year up front. Coverage ending
  // inside the window is not covered at the horizon and keeps its warning
  // (that card is needed to renew); so does a covered customer with a
  // still-collectible pre-term retry. PER METHOD (#3533 follow-up): a
  // covered customer whose only forthcoming charge rides a DIFFERENT card
  // (an estimate hold's frozen card) still gets no warning about the Auto
  // Pay card the charge will never use — isCardExpiryExemptMethod decides
  // for the method this job actually evaluates.
  const { emptyCardExpiryExemptions, isCardExpiryExemptMethod } = require('./card-expiry-exemptions');
  let exemptions = emptyCardExpiryExemptions();
  try {
    const { getCardExpiryExemptions } = require('./annual-prepay-renewals');
    exemptions = await getCardExpiryExemptions(etDateString(sixty));
  } catch (coverErr) {
    logger.warn(`[autopay-notifications] prepay exemption lookup failed, not excluding: ${coverErr.message}`);
  }
  let prepayCovered = 0;

  const rows = [];
  for (const customer of customers) {
    if (exemptions.customerIds.has(String(customer.id))) { prepayCovered += 1; continue; }
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
      if (isCardExpiryExemptMethod(exemptions, customer.id, target.id)) { prepayCovered += 1; continue; }
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
        billing_mode_at_send: resolveBillingLane(customer).mode,
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
      const reminderStage = expired ? 'expired' : (daysUntil <= 7 ? '7_day' : (daysUntil <= 30 ? '30_day' : '60_day'));

      const emailPromise = reminderStage !== '60_day'
        ? PaymentLifecycleEmail.sendPaymentMethodExpiring({
          customerId: r.customer_id,
          paymentMethodId: r.payment_method_id,
          reminderStage,
          now,
        }).catch((emailErr) => {
          logger.warn(`[autopay-notifications] expiry email failed for ${r.customer_id}: ${emailErr.message}`);
        })
        : Promise.resolve();

      if (!r.phone) {
        const prefs = await db('notification_prefs').where({ customer_id: r.customer_id }).first();
        const routesEmail = reminderStage === '60_day' && billingChannelAllowed(prefs || {}, 'billing', 'email') === true;
        if (!routesEmail && billingChannelAllowed(prefs || {}, 'billing', 'push') !== true) { await emailPromise; skipped++; continue; }
      }

      // Keep each escalation reachable: the cooldown is keyed by stage, so a
      // 60-day notice cannot delay the 30-day pass and a 30-day notice
      // cannot suppress the distinct 7-day stage roughly three weeks later.
      const cooldownDays = reminderStage === '7_day' ? 7 : 30;
      const already = await eventExistsRecently(r.customer_id, eventType, cooldownDays, r.payment_method_id, { reminder_stage: reminderStage });
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
        metadata: {
          original_message_type: 'payment_expiry',
          billingDeliveryCategory: 'billing',
          notificationEventKey: `payment-expiry:${r.payment_method_id}:${r.exp_month}:${expYear}:${reminderStage}`,
          billing_mode_at_send: r.billing_mode_at_send,
        },
        hasEmailLeg: reminderStage !== '60_day',
      });
      if (sendResult.blocked || sendResult.sent === false) {
        throw new Error(`card expiry SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
      }

      await logAutopay(r.customer_id, eventType, {
        paymentMethodId: r.payment_method_id,
        details: { exp_month: r.exp_month, exp_year: r.exp_year, brand: r.brand, last4: r.last4, reminder_stage: reminderStage },
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
