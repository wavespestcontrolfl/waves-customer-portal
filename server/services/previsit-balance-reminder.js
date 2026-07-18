/**
 * Pre-visit late-balance reminder (owner directive 2026-07-17).
 *
 * A few days before an upcoming RECURRING-service visit, remind the customer
 * of a late balance from the RECURRING relationship — and only then:
 *
 *   - The upcoming visit must be recurring (`is_recurring`). A customer who
 *     is behind on a recurring invoice but has a ONE-TIME visit coming up
 *     gets nothing (owner rule: don't chase recurring debt ahead of an
 *     unrelated one-time job).
 *   - The late balance must itself be recurring-lane debt: monthly dues not
 *     collected past the billing day + grace, or OVERDUE invoices linked to
 *     recurring visits. One-time invoice debt never triggers this (the
 *     invoice follow-up sequence engine owns generic invoice dunning).
 *   - Payer-billed visits are skipped — the homeowner doesn't owe the AR.
 *
 * DARK BY DEFAULT (same two-lever pattern as appointment-card-request):
 * inert unless PREVISIT_BALANCE_REMINDER=true AND the
 * previsit_balance_reminder SMS template is active (seeded inactive). Both
 * levers are owner flips. Email rides the same eligibility through the
 * billing.previsit_balance email template.
 *
 * One reminder per appointment, ever: scheduled_services.
 * balance_reminder_sent_at is an atomic claim (UPDATE ... WHERE NULL); a
 * send that never left releases the claim so a later sweep can retry.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { resolveBillingLane, monthlyDuesCollected } = require('./billing-lane');
const { invoiceAmountDue } = require('./invoice-helpers');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');

const TEMPLATE_KEY = 'previsit_balance_reminder';
const EMAIL_TEMPLATE_KEY = 'billing.previsit_balance';
const BILLING_PORTAL_URL = 'https://portal.wavespestcontrol.com/?tab=billing';
// Days before the visit the reminder goes out — far enough to pay, close
// enough to matter.
const LEAD_DAYS = 3;
// Dues are "late" this many days after the billing day, not the moment the
// cron runs — the 2-day retry ladder gets a chance first.
const DUES_GRACE_DAYS = 3;
// Don't stack on the invoice follow-up engine: if the overdue invoice was
// touched this recently, this sweep stays quiet for it.
const RECENT_TOUCH_HOURS = 72;

function gateEnabled() {
  return process.env.PREVISIT_BALANCE_REMINDER === 'true';
}

/**
 * Pure eligibility predicate (exported for tests). Answers: given this
 * upcoming visit + customer money state, should the reminder send?
 */
function previsitBalanceReminderEligible({
  isRecurringVisit,
  payerBilled,
  alreadySent,
  laneMode,
  duesCollected,
  todayEtDay,
  billingDay,
  overdueRecurringDue,
}) {
  if (!isRecurringVisit) return { send: false, reason: 'one_time_visit' };
  if (payerBilled) return { send: false, reason: 'payer_billed' };
  if (alreadySent) return { send: false, reason: 'already_sent' };
  const duesLate = laneMode === 'monthly_membership'
    && duesCollected === false
    && Number(todayEtDay) >= (Number(billingDay) || 1) + DUES_GRACE_DAYS;
  const overdueDue = Number(overdueRecurringDue) || 0;
  if (!duesLate && !(overdueDue > 0)) return { send: false, reason: 'no_recurring_late_balance' };
  return { send: true, duesLate, overdueDue };
}

async function smsTemplateActive() {
  try {
    const row = await db('sms_templates').where({ template_key: TEMPLATE_KEY }).first('is_active');
    return row?.is_active === true;
  } catch {
    return false;
  }
}

// OVERDUE invoices that belong to the recurring relationship: linked to a
// recurring scheduled visit, homeowner-billed (payer AR excluded). One-time
// invoice debt deliberately never counts here.
async function overdueRecurringInvoices(customerId) {
  return db('invoices')
    .join('scheduled_services as ss', 'invoices.scheduled_service_id', 'ss.id')
    .where('invoices.customer_id', customerId)
    .where('invoices.status', 'overdue')
    .whereNull('invoices.payer_id')
    .where('ss.is_recurring', true)
    .select('invoices.*');
}

async function runSweep({ now = new Date() } = {}) {
  if (!gateEnabled()) return { skipped: true, reason: 'gate_off' };
  if (!(await smsTemplateActive())) return { skipped: true, reason: 'template_inactive' };

  const todayEt = etDateString(now);
  const target = new Date(`${todayEt}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + LEAD_DAYS);
  const targetDate = target.toISOString().slice(0, 10);
  const todayEtDay = Number(todayEt.slice(8, 10));

  const visits = await db('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.scheduled_date', targetDate)
    .whereIn('scheduled_services.status', ['pending', 'confirmed'])
    .where('scheduled_services.is_recurring', true)
    .whereNull('scheduled_services.balance_reminder_sent_at')
    .whereNull('customers.deleted_at')
    .select(
      'scheduled_services.id',
      'scheduled_services.customer_id',
      'scheduled_services.service_type',
      'scheduled_services.scheduled_date',
      'scheduled_services.payer_id',
      'customers.first_name',
      'customers.phone',
      'customers.billing_mode',
      'customers.waveguard_tier',
      'customers.monthly_rate',
      'customers.billing_day',
    );

  let sent = 0;
  let skipped = 0;
  for (const visit of visits) {
    try {
      const lane = resolveBillingLane(visit);
      let duesCollected = null;
      if (lane.mode === 'monthly_membership') {
        duesCollected = await monthlyDuesCollected(db, visit.customer_id, now);
      }
      const overdue = await overdueRecurringInvoices(visit.customer_id);
      // Recently-touched overdue invoices stay with the follow-up engine.
      const cutoff = new Date(now.getTime() - RECENT_TOUCH_HOURS * 3600 * 1000);
      const fresh = overdue.filter((inv) => !inv.last_reminder_at || new Date(inv.last_reminder_at) < cutoff);
      const overdueRecurringDue = fresh.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0);

      const verdict = previsitBalanceReminderEligible({
        isRecurringVisit: true,
        payerBilled: !!visit.payer_id,
        alreadySent: false,
        laneMode: lane.mode,
        duesCollected,
        todayEtDay,
        billingDay: visit.billing_day,
        overdueRecurringDue,
      });
      if (!verdict.send) { skipped++; continue; }

      const amount = verdict.duesLate
        ? (Number(visit.monthly_rate) || 0) + verdict.overdueDue
        : verdict.overdueDue;
      if (!(amount > 0)) { skipped++; continue; }

      // Atomic one-per-appointment claim.
      const claimed = await db('scheduled_services')
        .where({ id: visit.id })
        .whereNull('balance_reminder_sent_at')
        .update({ balance_reminder_sent_at: new Date() });
      if (!claimed) { skipped++; continue; }

      let delivered = false;
      try {
        const body = await renderSmsTemplate(TEMPLATE_KEY, {
          first_name: visit.first_name || 'there',
          amount: amount.toFixed(2),
          service_type: visit.service_type || 'service',
          visit_date: visit.scheduled_date,
          billing_url: BILLING_PORTAL_URL,
        });
        if (!body) throw new Error('template rendered empty (inactive or missing)');
        const result = await sendCustomerMessage({
          to: visit.phone,
          body,
          channel: 'sms',
          audience: 'customer',
          purpose: 'billing',
          customerId: visit.customer_id,
          entryPoint: 'previsit_balance_reminder',
          metadata: { scheduled_service_id: visit.id, amount },
        });
        delivered = !result.blocked && result.sent !== false;
      } catch (smsErr) {
        logger.warn(`[previsit-balance] SMS failed for visit ${visit.id}: ${smsErr.message}`);
      }

      // Email rides the same eligibility; failure is non-fatal (SMS may
      // still have landed).
      try {
        const AccountMembershipEmail = require('./account-membership-email');
        await AccountMembershipEmail.sendPrevisitBalanceReminder({
          customerId: visit.customer_id,
          amount: `$${amount.toFixed(2)}`,
          serviceType: visit.service_type || 'service',
          visitDate: visit.scheduled_date,
          billingUrl: BILLING_PORTAL_URL,
          idempotencyKey: `${EMAIL_TEMPLATE_KEY}:${visit.id}`,
        });
      } catch (emailErr) {
        logger.warn(`[previsit-balance] email failed for visit ${visit.id}: ${emailErr.message}`);
      }

      if (!delivered) {
        // A text that never left releases the claim so a later sweep retries.
        await db('scheduled_services')
          .where({ id: visit.id })
          .update({ balance_reminder_sent_at: null })
          .catch(() => {});
        skipped++;
        continue;
      }
      sent++;
    } catch (err) {
      logger.error(`[previsit-balance] sweep failed for visit ${visit.id}: ${err.message}`);
      skipped++;
    }
  }
  logger.info(`[previsit-balance] sweep for ${targetDate}: ${sent} sent, ${skipped} skipped of ${visits.length}`);
  return { sent, skipped, considered: visits.length, targetDate };
}

module.exports = {
  runSweep,
  previsitBalanceReminderEligible,
  overdueRecurringInvoices,
  TEMPLATE_KEY,
  EMAIL_TEMPLATE_KEY,
  LEAD_DAYS,
  DUES_GRACE_DAYS,
};
