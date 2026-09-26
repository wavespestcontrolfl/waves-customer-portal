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
const { dateOnlyString } = require('../utils/date-only');
const { resolveBillingLane, monthlyDuesCollected } = require('./billing-lane');
const { invoiceAmountDue } = require('./invoice-helpers');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { collectionsChannelVerdict } = require('./collections/rail-guard');
const ContactLedger = require('./collections/contact-ledger');
const { accountBillingChannels } = require('./billing-delivery-channels');
const { reminderProgress, sendReminderChannels } = require('./billing-reminder-delivery');

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

// Explicit per-channel choice (PR #4843 router core): the collections policy
// judges only the selected channels. This appointment's own earlier
// reservations (a released-claim retry) must not trip recent-contact spacing
// against the episode being resumed; unrelated contacts still count.
// Returns { skip: true } or { eligibleIds } (null = no filtering).
async function explicitChannelPolicyGate({ visit, consult, explicitChannels }) {
  let episodeLedgerIds;
  try {
    const progress = await reminderProgress(visit.customer_id, 'previsit_balance_reminder', explicitChannels);
    const episode = progress.find((event) => event.metadata.notificationEventKey === previsitEventKey(visit));
    episodeLedgerIds = (episode?.entries || []).map((entry) => entry.id);
  } catch (progressErr) {
    logger.warn(`[previsit-balance] reminder progress read failed for visit ${visit.id}: ${progressErr.message}`);
    return { skip: true };
  }
  const verdicts = [];
  for (const channel of explicitChannels) {
    verdicts.push(await collectionsChannelVerdict({ ...consult, channel, excludeLedgerIds: episodeLedgerIds }));
  }
  const permitted = verdicts.filter((v) => v.permitted);
  if (!permitted.length) return { skip: true };
  // Every permitted leg sends the same copy, so quote only debt that EVERY
  // permitted selected channel holds eligible (null = no filtering).
  const lists = permitted.map((v) => v.eligibleInvoiceIds).filter((ids) => ids !== null && ids !== undefined);
  if (!lists.length) return { eligibleIds: null };
  const eligibleIds = lists.reduce((acc, ids) => acc.filter((id) => ids.map(String).includes(String(id))));
  return { eligibleIds };
}

// One episode per appointment, stable across a released-claim retry, so a
// rerun resumes the same reservation set (reminderProgress finds it by
// customer_id + source + this key).
function previsitEventKey(visit) {
  return `previsit-balance:${visit.id}`;
}

async function releasePrevisitClaim(visitId) {
  await db('scheduled_services')
    .where({ id: visitId })
    .update({ balance_reminder_sent_at: null })
    .catch((err) => logger.warn(`[previsit-balance] claim release failed for visit ${visitId}: ${err.message}`));
}

// Every leg, Email included, goes through sendCustomerMessage: an explicit
// Email leg dispatches via the billing email adapter under the email
// authority (which rechecks the selection at handoff), keyed
// billing_channel_email:<eventKey>:email and bound to this leg's reservation
// (collections_ledger_id), so an acceptance whose stamp is lost is repaired
// by reminderProgress.
async function sendPrevisitLeg({ visit, amount, eventKey, channel, ledger, preDispatchCheck }) {
  const body = await renderSmsTemplate(TEMPLATE_KEY, {
    first_name: visit.first_name || 'there',
    amount: amount.toFixed(2),
    service_type: visit.service_type || 'service',
    visit_date: friendlyVisitDate(visit.scheduled_date),
    billing_url: BILLING_PORTAL_URL,
  });
  if (!body) {
    return {
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'TEMPLATE_UNAVAILABLE',
      reason: 'template rendered empty (inactive or missing)',
    };
  }
  return sendCustomerMessage({
    // Only the Text leg is addressed by phone; App and Email identify the
    // recipient by customerId (a stale phone would read as a changed choice).
    to: channel === 'sms' ? visit.phone : null,
    body,
    channel,
    audience: 'customer',
    purpose: 'billing',
    customerId: visit.customer_id,
    appointmentId: visit.id,
    entryPoint: 'previsit_balance_reminder',
    // Explicit routing already decided the channel set — never the legacy
    // hasEmailLeg suppression heuristic (balance-reminder.js's
    // sendExplicitLatePaymentReminder contract).
    hasEmailLeg: true,
    preDispatchCheck,
    metadata: {
      original_message_type: 'balance_reminder',
      billingDeliveryCategory: 'billing',
      notificationEventKey: eventKey,
      billingDeliveryLeg: channel,
      scheduled_service_id: visit.id,
      amount,
      // Visit pin for a retried Email (billing-email-replay-eligibility):
      // refused once the visit moves or the copy is from an earlier day.
      appointment_date: dateOnlyString(visit.scheduled_date),
      appointment_service_type: visit.service_type || 'service',
      appointment_rendered_on: etDateString(),
      ...(ledger?.id ? { collections_ledger_id: ledger.id } : {}),
      ...(channel === 'push' ? { appOnly: true } : {}),
    },
  });
}

// Sends the selected legs through the shared per-channel rail after the
// appointment claim. Returns 'sent' when a leg delivered now, else 'skipped'.
// The claim is released while the episode is still open (a replay hold, an
// uncertain outcome, or a transient denial on ANY selected leg — even when a
// sibling delivered) so the next sweep in the window retries only the
// pending legs; sendReminderChannels never re-sends a delivered or resolved
// leg. A helper throw releases the claim too (its reservations still guard
// any leg whose outcome is uncertain). A COMPLETE episode keeps the claim.
async function deliverExplicitPrevisitReminder({ visit, amount, duesCents, explicitChannels, quotedInvoices }) {
  const eventKey = previsitEventKey(visit);
  const invoiceIds = quotedInvoices.map((inv) => inv.id);
  const preDispatchCheck = quotedBalanceStillOwed({
    customerId: visit.customer_id, quotedInvoices, quotedDuesCents: duesCents,
  });
  let result;
  try {
    result = await sendReminderChannels({
      customerId: visit.customer_id,
      invoiceId: null, // aggregate balance rail, no single target invoice (rail-guard.js)
      invoiceIds, // ...but the ledger still records the debts this reminder quotes
      offLedgerBalanceCents: duesCents,
      source: 'previsit_balance_reminder',
      purpose: 'balance_reminder',
      eventKey,
      channels: explicitChannels,
      metadata: { scheduled_service_id: visit.id, amount },
      send: (channel, ledger) => sendPrevisitLeg({ visit, amount, eventKey, channel, ledger, preDispatchCheck }),
    });
  } catch (helperErr) {
    logger.warn(`[previsit-balance] explicit-channel send failed for visit ${visit.id}: ${helperErr.message}`);
    await releasePrevisitClaim(visit.id);
    return 'skipped';
  }
  if (!result.complete) await releasePrevisitClaim(visit.id);
  return result.deliveredNow.length ? 'sent' : 'skipped';
}

// Late monthly dues are debt the ledger does not hold (not invoiced), so the
// collections policy counts them as an off-ledger balance.
function lateDuesCents({ lane, duesCollected, todayEt, obligation, monthlyRate }) {
  const duesLate = lane.mode === 'monthly_membership'
    && duesCollected === false
    && String(todayEt) >= String(obligation.graceDateEt);
  return duesLate ? Math.round((Number(monthlyRate) || 0) * 100) : 0;
}

// The same allowance, recomputed from the customer's current state for a
// retried previsit Email (billing-email-replay-eligibility): the replay
// consult must count unpaid dues exactly as the original send did.
async function currentDuesAllowanceCents(customerId, database = db, now = new Date()) {
  const customer = await database('customers').where({ id: customerId })
    .first('billing_mode', 'waveguard_tier', 'monthly_rate', 'billing_day');
  if (!customer) return 0;
  const todayEt = etDateString(now);
  const lane = resolveBillingLane(customer);
  const obligation = duesObligation(todayEt, customer.billing_day);
  const duesCollected = lane.mode === 'monthly_membership'
    ? await monthlyDuesCollected(database, customerId, new Date(`${obligation.dueDateEt}T12:00:00Z`))
    : null;
  return lateDuesCents({ lane, duesCollected, todayEt, obligation, monthlyRate: customer.monthly_rate });
}

// Right before each leg dispatches, re-read everything the copy quotes: every
// overdue invoice must still be collectible, self-pay and owe exactly what
// was quoted, and the late dues must still be owed. Any change holds the leg
// (retryable) so the next sweep re-quotes from current state.
function quotedBalanceStillOwed({ customerId, quotedInvoices, quotedDuesCents }) {
  const changed = (reason) => ({ ok: false, code: 'PREVISIT_QUOTE_CHANGED', reason, retryable: true });
  return async () => {
    try {
      const helpers = require('./invoice-helpers');
      const ids = quotedInvoices.map((inv) => inv.id);
      const live = ids.length ? await db('invoices').whereIn('id', ids) : [];
      for (const quoted of quotedInvoices) {
        const row = live.find((inv) => String(inv.id) === String(quoted.id));
        if (!row || String(row.customer_id) !== String(customerId)
          || !helpers.isInvoiceCollectibleStatus(row.status)
          || row.payer_id || helpers.invoiceWithdrawnFromCustomer(row)
          || Math.round(helpers.invoiceAmountDue(row) * 100) !== Math.round(quoted.due * 100)) {
          return changed(`quoted invoice ${quoted.id} changed before dispatch`);
        }
      }
      if (quotedDuesCents > 0 && (await currentDuesAllowanceCents(customerId)) !== quotedDuesCents) {
        return changed('quoted monthly dues changed before dispatch');
      }
      return { ok: true };
    } catch (err) {
      return changed(`quoted balance unreadable before dispatch: ${err.message}`);
    }
  };
}

// The customer's explicit billing channel choice is read BEFORE the
// collections policy gate so the gate judges the channels actually selected
// (an App-only customer with Text and Email both denied is still reachable).
// A stored choice is enforced whether or not GATE_BILLING_NOTIFICATION_
// CHANNELS is live (same read-side contract as balance-reminder.js's
// latePaymentCheck). An unreadable choice must not fall through to the legacy
// SMS+Email path (that would ignore a stored selection): skip, and the next
// sweep in the window retries (no claim is held yet).
async function previsitPolicyGate({ visit, consult }) {
  let explicitChannels;
  try {
    explicitChannels = await accountBillingChannels(visit.customer_id, 'billing', db);
  } catch (prefsErr) {
    logger.warn(`[previsit-balance] billing channel choice unreadable for customer ${visit.customer_id}: ${prefsErr.message}`);
    return { skip: true };
  }
  if (explicitChannels !== null) {
    const gate = await explicitChannelPolicyGate({ visit, consult, explicitChannels });
    return gate.skip ? gate : { explicitChannels, eligibleIds: gate.eligibleIds };
  }
  const smsVerdict = await collectionsChannelVerdict({ ...consult, channel: 'sms' });
  const emailVerdict = await collectionsChannelVerdict({ ...consult, channel: 'email' });
  if (!smsVerdict.permitted && !emailVerdict.permitted) return { skip: true };
  // Gate-on: the reminder may only QUOTE debt the policy holds eligible
  // (codex r8 — an invoice the policy excludes, e.g. re-resolved as
  // payer-billed or dunning-stopped, must not ride an allowed aggregate).
  // Gate-off (null) = no filtering.
  return {
    explicitChannels: null,
    smsPolicyPermitted: smsVerdict.permitted,
    emailPolicyPermitted: emailVerdict.permitted,
    eligibleIds: smsVerdict.permitted && smsVerdict.eligibleInvoiceIds !== null
      ? smsVerdict.eligibleInvoiceIds
      : emailVerdict.eligibleInvoiceIds,
  };
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
      const freshAll = overdue.filter((inv) => !legacyDunnedIds.has(inv.id)
        && [inv.last_reminder_at, inv.followup_last_touch_at]
          .filter(Boolean)
          .every((touch) => new Date(touch) < cutoff));

      // Collections policy, per channel, BEFORE the claim (gate off ⇒ both
      // permitted without consulting, eligible set null = no filtering —
      // byte-identical, pinned). Dues are computed here (independent of the
      // invoice set) so the off-ledger carve-out covers a dues-only
      // reminder: late monthly dues aren't invoiced.
      const duesCents = lateDuesCents({ lane, duesCollected, todayEt, obligation, monthlyRate: visit.monthly_rate });
      const consult = {
        customerId: visit.customer_id,
        purpose: 'balance_reminder',
        offLedgerBalanceCents: duesCents,
        logTag: 'previsit-balance',
      };
      const gate = await previsitPolicyGate({ visit, consult });
      if (gate.skip) { skipped++; continue; }
      const { explicitChannels, eligibleIds, smsPolicyPermitted, emailPolicyPermitted } = gate;
      const fresh = eligibleIds === null || eligibleIds === undefined
        ? freshAll
        : freshAll.filter((inv) => eligibleIds.map(String).includes(String(inv.id)));
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

      if (explicitChannels !== null) {
        const outcome = await deliverExplicitPrevisitReminder({
          visit, amount, duesCents, explicitChannels,
          quotedInvoices: fresh.map((inv) => ({ id: inv.id, due: invoiceAmountDue(inv) })),
        });
        if (outcome === 'sent') sent++;
        else skipped++;
        continue;
      }

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
      if (smsPolicyPermitted) try {
        const body = await renderSmsTemplate(TEMPLATE_KEY, {
          first_name: visit.first_name || 'there',
          amount: amount.toFixed(2),
          service_type: visit.service_type || 'service',
          visit_date: friendlyVisitDate(visit.scheduled_date),
          billing_url: BILLING_PORTAL_URL,
        });
        if (!body) throw new Error('template rendered empty (inactive or missing)');
        // RECORD-THEN-SEND: the collections ledger row precedes the
        // delivery attempt; an insert failure throws into this catch and
        // the send is skipped (no unledgered customer contact, ever).
        const smsLedger = await ContactLedger.recordContact({
          customerId: visit.customer_id,
          channel: 'sms',
          purpose: 'balance_reminder',
          invoiceIds: fresh.map((inv) => inv.id),
          source: 'previsit_balance_reminder',
          metadata: { scheduled_service_id: visit.id, amount },
        });
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
          // is genuinely available under the billing prefs (Codex r10) AND
          // the collections policy permits the email channel.
          hasEmailLeg: emailLegAvailable && emailPolicyPermitted,
          metadata: { scheduled_service_id: visit.id, amount },
        });
        smsDelivered = !result.blocked && result.sent !== false;
        if (!smsDelivered) {
          await ContactLedger.markSendFailed(smsLedger, { code: result.code || 'blocked' });
        }
      } catch (smsErr) {
        logger.warn(`[previsit-balance] SMS failed for visit ${visit.id}: ${smsErr.message}`);
      }

      // Email rides the same eligibility. For an email-preferring customer
      // the SMS above is suppressed by the channel gate and THIS is the
      // reminder. Skipped silently when the billing prefs/recipient
      // resolution said no (the sender re-checks internally too).
      let emailDelivered = false;
      if (emailLegAvailable && emailPolicyPermitted) try {
        // RECORD-THEN-SEND, same discipline as the SMS leg: ledger insert
        // failure throws into this catch and the email is skipped.
        const emailLedger = await ContactLedger.recordContact({
          customerId: visit.customer_id,
          channel: 'email',
          purpose: 'balance_reminder',
          invoiceIds: fresh.map((inv) => inv.id),
          source: 'previsit_balance_reminder',
          metadata: { scheduled_service_id: visit.id, amount },
        });
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
        if (!emailDelivered) {
          await ContactLedger.markSendFailed(emailLedger, { reason: emailResult?.reason || 'email_not_sent' });
        }
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
  currentDuesAllowanceCents,
  quotedBalanceStillOwed,
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
