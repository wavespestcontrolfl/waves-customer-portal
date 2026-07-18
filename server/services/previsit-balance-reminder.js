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
 * The most recent dues due-date on or before todayEt (ET 'YYYY-MM-DD'), the
 * grace date after which unpaid dues count as LATE, and the obligation month
 * key those dues belong to. Real DATE math, not day-of-month integers, so a
 * billing day near month end rolls over correctly (a Feb-28 obligation's
 * grace lands in March and February's dues are still the ones checked —
 * Codex r2). Billing days beyond a month's length clamp to its last day,
 * matching isBillingDayMatch's clamping contract.
 */
function duesObligation(todayEt, billingDay) {
  const [y, m, d] = String(todayEt).split('-').map(Number);
  const clampDue = (yy, mm) => Math.min(Number(billingDay) || 1, new Date(Date.UTC(yy, mm, 0)).getUTCDate());
  let yy = y;
  let mm = m;
  let due = clampDue(yy, mm);
  if (d < due) {
    mm -= 1;
    if (mm === 0) { mm = 12; yy -= 1; }
    due = clampDue(yy, mm);
  }
  const dueDate = new Date(Date.UTC(yy, mm - 1, due));
  const grace = new Date(dueDate);
  grace.setUTCDate(grace.getUTCDate() + DUES_GRACE_DAYS);
  const iso = (dt) => dt.toISOString().slice(0, 10);
  return { dueDateEt: iso(dueDate), graceDateEt: iso(grace), monthKey: `${yy}-${String(mm).padStart(2, '0')}` };
}

/**
 * Pure eligibility predicate (exported for tests). Answers: given this
 * upcoming visit + customer money state, should the reminder send?
 * duesCollected refers to the OBLIGATION month (duesObligation), not the
 * calendar month the sweep runs in.
 */
function previsitBalanceReminderEligible({
  isRecurringVisit,
  payerBilled,
  alreadySent,
  laneMode,
  duesCollected,
  todayEt,
  graceDateEt,
  overdueRecurringDue,
}) {
  if (!isRecurringVisit) return { send: false, reason: 'one_time_visit' };
  if (payerBilled) return { send: false, reason: 'payer_billed' };
  if (alreadySent) return { send: false, reason: 'already_sent' };
  const duesLate = laneMode === 'monthly_membership'
    && duesCollected === false
    && !!graceDateEt
    && String(todayEt) >= String(graceDateEt);
  const overdueDue = Number(overdueRecurringDue) || 0;
  if (!duesLate && !(overdueDue > 0)) return { send: false, reason: 'no_recurring_late_balance' };
  return { send: true, duesLate, overdueDue };
}

// scheduled_date is a DATE column that arrives as a JS Date or a
// 'YYYY-MM-DD' string depending on the driver — either way the customer
// copy must render a friendly date ('July 28, 2026'), never an ISO string
// or a GMT timestamp (Codex r9). Noon-Z anchor keeps the calendar day
// stable in ET; anything unparseable passes through untouched.
function friendlyVisitDate(value) {
  const dateStr = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return String(value || '');
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
  });
}

async function smsTemplateActive() {
  try {
    const row = await db('sms_templates').where({ template_key: TEMPLATE_KEY }).first('is_active');
    return row?.is_active === true;
  } catch {
    return false;
  }
}

// Nothing flips an invoice's stored status to 'overdue' automatically — the
// late-payment checker treats sent/viewed invoices as overdue purely by
// due_date (or old created_at when due_date is null). Mirror its predicate
// and its 7-day default here, or past-due recurring invoices sitting at
// 'sent'/'viewed' never count and non-member customers get no reminder
// (Codex r5; late-payment-checker.js checkAndNotify).
const OVERDUE_AFTER_DAYS = 7;

// Past-due invoices that belong to the recurring relationship: linked to a
// recurring scheduled visit, homeowner-billed (payer AR excluded). One-time
// invoice debt deliberately never counts here.
async function overdueRecurringInvoices(customerId, now = new Date()) {
  const dueCutoff = new Date(now.getTime() - OVERDUE_AFTER_DAYS * 86400000);
  // The follow-up engine records its sends on
  // invoice_followup_sequences.last_touch_at, NOT invoices.last_reminder_at
  // — the recent-touch guard must read the real timestamp or the 10:00
  // dun and this 10:05 sweep double-text the same invoice (Codex r4).
  return db('invoices')
    .join('scheduled_services as ss', 'invoices.scheduled_service_id', 'ss.id')
    .leftJoin('invoice_followup_sequences as ifs', 'ifs.invoice_id', 'invoices.id')
    .where('invoices.customer_id', customerId)
    .whereIn('invoices.status', ['sent', 'viewed', 'overdue'])
    .where(function pastDue() {
      this.where('invoices.due_date', '<=', dueCutoff)
        .orWhere(function noDueDate() {
          this.whereNull('invoices.due_date').andWhere('invoices.created_at', '<=', dueCutoff);
        });
    })
    .whereNull('invoices.payer_id')
    // A STOPPED sequence is an explicit admin "stop dunning this invoice"
    // instruction (customer mailing a check, etc.) — both existing dunning
    // engines honor it, and this sweep must not resurrect those customers
    // ahead of a visit (Codex r5; invoice-followups.isDunningStopped).
    .where(function sequenceNotStopped() {
      this.whereNull('ifs.status').orWhereNot('ifs.status', 'stopped');
    })
    .where('ss.is_recurring', true)
    .select('invoices.*', 'ifs.last_touch_at as followup_last_touch_at');
}

async function runSweep({ now = new Date() } = {}) {
  if (!gateEnabled()) return { skipped: true, reason: 'gate_off' };
  if (!(await smsTemplateActive())) return { skipped: true, reason: 'template_inactive' };

  const todayEt = etDateString(now);
  const iso = (dt) => dt.toISOString().slice(0, 10);
  // WINDOW, not a single day: the claim releases on a failed send, and a
  // single exact-date target would never re-see that visit on later daily
  // runs (Codex r3). Tomorrow → today+LEAD_DAYS keeps one send per
  // appointment (the claim dedupes) while giving failures LEAD_DAYS-1
  // retry days.
  const windowStart = new Date(`${todayEt}T12:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() + 1);
  const target = new Date(`${todayEt}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + LEAD_DAYS);
  const windowStartDate = iso(windowStart);
  const targetDate = iso(target);

  const visits = await db('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .whereBetween('scheduled_services.scheduled_date', [windowStartDate, targetDate])
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
      const obligation = duesObligation(todayEt, visit.billing_day);
      let duesCollected = null;
      if (lane.mode === 'monthly_membership') {
        // Check the OBLIGATION month's dues (noon-Z anchor keeps the ET
        // month stable), so a Feb-28 biller checked in early March is
        // judged on February's dues, not March's (Codex r2).
        duesCollected = await monthlyDuesCollected(db, visit.customer_id, new Date(`${obligation.dueDateEt}T12:00:00Z`));
      }
      // Payer-billed resolution must include the customer's DEFAULT payer,
      // not just the per-job column — resolveForInvoice is the same
      // authority completion uses. A resolve outage fails toward SKIP: a
      // billing dun must never reach a homeowner whose visits a third
      // party pays for (Codex r2; same fail-direction as card-on-file).
      let payerBilled = !!visit.payer_id;
      try {
        const PayerService = require('./payer');
        const resolved = await PayerService.resolveForInvoice({
          customerId: visit.customer_id,
          scheduledServiceId: visit.id,
        });
        payerBilled = !!resolved?.payerId;
      } catch (payerErr) {
        logger.warn(`[previsit-balance] payer resolve failed for visit ${visit.id} — skipping to be safe: ${payerErr.message}`);
        payerBilled = true;
      }
      const overdue = await overdueRecurringInvoices(visit.customer_id, now);
      // Recently-touched overdue invoices stay with the follow-up engine.
      const cutoff = new Date(now.getTime() - RECENT_TOUCH_HOURS * 3600 * 1000);
      // The legacy 10:00 late-payment checker dedupes its sends via
      // activity_log rows (action 'late_payment_reminder', metadata
      // .invoiceId) — it stamps neither invoices.last_reminder_at nor a
      // follow-up sequence, so without this read the 10:05 sweep re-texts
      // an invoice the checker dunned five minutes earlier (Codex r5). A
      // failed read counts as untouched: the checker's own insert is
      // best-effort (.catch(() => {})), so absence never guaranteed silence.
      let legacyDunnedIds = new Set();
      try {
        const legacyTouches = await db('activity_log')
          .where({ customer_id: visit.customer_id, action: 'late_payment_reminder' })
          .where('created_at', '>=', cutoff)
          .select('metadata');
        legacyDunnedIds = new Set(legacyTouches.map((row) => {
          try {
            const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
            return meta?.invoiceId || null;
          } catch { return null; }
        }).filter(Boolean));
      } catch (activityErr) {
        logger.warn(`[previsit-balance] activity_log read failed for customer ${visit.customer_id}: ${activityErr.message}`);
      }
      const fresh = overdue.filter((inv) => !legacyDunnedIds.has(inv.id)
        && [inv.last_reminder_at, inv.followup_last_touch_at]
          .filter(Boolean)
          .every((touch) => new Date(touch) < cutoff));
      const overdueRecurringDue = fresh.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0);

      const verdict = previsitBalanceReminderEligible({
        isRecurringVisit: true,
        payerBilled,
        alreadySent: false,
        laneMode: lane.mode,
        duesCollected,
        todayEt,
        graceDateEt: obligation.graceDateEt,
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

      // The email sidecar routes through billing prefs + the billing
      // recipient (Codex r10 P1). Declare the email leg to the SMS channel
      // gate ONLY when it can actually send — otherwise an email-preferring
      // customer's SMS is suppressed in favor of an email that never
      // leaves, and the released claim retries daily forever.
      let emailLegAvailable = false;
      try {
        const AccountMembershipEmail = require('./account-membership-email');
        emailLegAvailable = !!(await AccountMembershipEmail.resolvePrevisitBalanceEmailRecipient(visit.customer_id)).recipient;
      } catch { emailLegAvailable = false; }

      let smsDelivered = false;
      try {
        const body = await renderSmsTemplate(TEMPLATE_KEY, {
          first_name: visit.first_name || 'there',
          amount: amount.toFixed(2),
          service_type: visit.service_type || 'service',
          visit_date: friendlyVisitDate(visit.scheduled_date),
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
          // This flow HAS an email sidecar (below), so the billing-channel
          // preference gate applies: an email-preferring customer gets the
          // email only, never both (Codex r4) — but only when the email leg
          // is genuinely available under the billing prefs (Codex r10).
          hasEmailLeg: emailLegAvailable,
          metadata: { scheduled_service_id: visit.id, amount },
        });
        smsDelivered = !result.blocked && result.sent !== false;
      } catch (smsErr) {
        logger.warn(`[previsit-balance] SMS failed for visit ${visit.id}: ${smsErr.message}`);
      }

      // Email rides the same eligibility. For an email-preferring customer
      // the SMS above is suppressed by the channel gate and THIS is the
      // reminder. Skipped silently when the billing prefs/recipient
      // resolution said no (the sender re-checks internally too).
      let emailDelivered = false;
      if (emailLegAvailable) try {
        const AccountMembershipEmail = require('./account-membership-email');
        const emailResult = await AccountMembershipEmail.sendPrevisitBalanceReminder({
          customerId: visit.customer_id,
          amount: `$${amount.toFixed(2)}`,
          serviceType: visit.service_type || 'service',
          visitDate: friendlyVisitDate(visit.scheduled_date),
          billingUrl: BILLING_PORTAL_URL,
          idempotencyKey: `${EMAIL_TEMPLATE_KEY}:${visit.id}`,
        });
        emailDelivered = emailResult?.ok === true;
      } catch (emailErr) {
        logger.warn(`[previsit-balance] email failed for visit ${visit.id}: ${emailErr.message}`);
      }

      // Keep the claim when EITHER leg landed (an email-only customer's
      // suppressed SMS must not release it — retries would re-email daily);
      // release only when BOTH legs failed so a later sweep day can retry.
      if (!smsDelivered && !emailDelivered) {
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
  logger.info(`[previsit-balance] sweep for ${windowStartDate}..${targetDate}: ${sent} sent, ${skipped} skipped of ${visits.length}`);
  return { sent, skipped, considered: visits.length, targetDate };
}

module.exports = {
  runSweep,
  previsitBalanceReminderEligible,
  duesObligation,
  friendlyVisitDate,
  overdueRecurringInvoices,
  TEMPLATE_KEY,
  EMAIL_TEMPLATE_KEY,
  LEAD_DAYS,
  DUES_GRACE_DAYS,
  OVERDUE_AFTER_DAYS,
};
