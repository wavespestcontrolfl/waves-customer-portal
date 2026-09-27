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
const { storedBillingChannels } = require('./billing-delivery-channels');
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
async function overdueRecurringInvoices(customerId, now = new Date(), database = db) {
  const dueCutoff = new Date(now.getTime() - OVERDUE_AFTER_DAYS * 86400000);
  // The follow-up engine records its sends on
  // invoice_followup_sequences.last_touch_at, NOT invoices.last_reminder_at
  // — the recent-touch guard must read the real timestamp or the 10:00
  // dun and this 10:05 sweep double-text the same invoice (Codex r4).
  return database('invoices')
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

// Apply every recent-touch exclusion to the recurring debt set in one place.
// Both the sweep that renders the reminder and the final provider boundary
// use this helper, so a follow-up or legacy late-payment touch landing during
// preparation makes the frozen quote ineligible before delivery.
async function freshOverdueRecurringInvoices(customerId, now = new Date(), database = db) {
  const overdue = await overdueRecurringInvoices(customerId, now, database);
  const cutoff = new Date(now.getTime() - RECENT_TOUCH_HOURS * 3600 * 1000);
  const legacyTouches = await database('activity_log')
    .where({ customer_id: customerId, action: 'late_payment_reminder' })
    .where('created_at', '>=', cutoff)
    .select('metadata');
  const legacyDunnedIds = new Set(legacyTouches.map((row) => {
    try {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      return meta?.invoiceId == null ? null : String(meta.invoiceId);
    } catch {
      return null;
    }
  }).filter(Boolean));
  return overdue.filter((invoice) => !legacyDunnedIds.has(String(invoice.id))
    && [invoice.last_reminder_at, invoice.followup_last_touch_at]
      .filter(Boolean)
      .every((touch) => new Date(touch) < cutoff));
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
async function sendPrevisitLeg({ visit, amount, invoiceIds, eventKey, channel, ledger, preSendCheck }) {
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
    channel: channel === 'push' ? 'sms' : channel,
    audience: 'customer',
    purpose: 'billing',
    customerId: visit.customer_id,
    appointmentId: visit.id,
    entryPoint: 'previsit_balance_reminder',
    // Explicit routing already decided the channel set — never the legacy
    // hasEmailLeg suppression heuristic (balance-reminder.js's
    // sendExplicitLatePaymentReminder contract).
    hasEmailLeg: true,
    // App and Email reuse their boundary guard; SMS also checks after its
    // notice-scope preparation and annual-offer guard inside dispatch().
    preSendCheck,
    ...(channel === 'sms' ? { providerPreSendCheck: preSendCheck } : {}),
    metadata: {
      original_message_type: 'balance_reminder',
      billingDeliveryCategory: 'billing',
      notificationEventKey: eventKey,
      billingDeliveryLeg: channel,
      scheduled_service_id: visit.id,
      amount,
      rendered_amount: amount.toFixed(2),
      invoice_ids: invoiceIds,
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
  const preSendCheck = quotedBalanceStillOwed({
    visit, quotedInvoices, quotedDuesCents: duesCents,
  });
  let result;
  try {
    result = await sendReminderChannels({
      customerId: visit.customer_id,
      invoiceId: null, // aggregate balance rail, no single target invoice (rail-guard.js)
      invoiceIds, // ...but the ledger still records the debts this reminder quotes
      policyInvoiceIds: invoiceIds,
      offLedgerBalanceCents: duesCents,
      source: 'previsit_balance_reminder',
      purpose: 'balance_reminder',
      eventKey,
      channels: explicitChannels,
      metadata: { scheduled_service_id: visit.id, amount },
      send: (channel, ledger) => sendPrevisitLeg({ visit, amount, invoiceIds, eventKey, channel, ledger, preSendCheck }),
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

// At each leg's provider handoff, re-read everything the copy quotes: every
// overdue invoice must still be collectible, self-pay and owe exactly what
// was quoted, and the late dues must still be owed. Any change holds the leg
// (retryable) so the next sweep re-quotes from current state.
function quotedBalanceStillOwed({ visit, quotedInvoices, quotedDuesCents }) {
  const customerId = visit.customer_id;
  const visitPin = {
    source_entry_point: TEMPLATE_KEY,
    customer_id: customerId,
    appointment_id: visit.id,
    appointment_date: dateOnlyString(visit.scheduled_date),
    appointment_service_type: visit.service_type || 'service',
    appointment_rendered_on: etDateString(),
  };
  const changed = (reason) => ({ ok: false, code: 'PREVISIT_QUOTE_CHANGED', reason, retryable: true });
  const recheck = async (database) => {
    const visitRefusal = await require('./messaging/billing-email-replay-eligibility')
      .balanceReminderVisitRefusal(visitPin, database);
    if (visitRefusal) return changed(visitRefusal.reason);
    const helpers = require('./invoice-helpers');
    const live = quotedInvoices.length ? await freshOverdueRecurringInvoices(customerId, new Date(), database) : [];
    for (const quoted of quotedInvoices) {
      const row = live.find((inv) => String(inv.id) === String(quoted.id));
      if (!row || String(row.customer_id) !== String(customerId)
        || !helpers.isInvoiceCollectibleStatus(row.status)
        || row.payer_id || helpers.invoiceWithdrawnFromCustomer(row)
        || Math.round(helpers.invoiceAmountDue(row) * 100) !== Math.round(quoted.due * 100)) {
        return changed(`quoted invoice ${quoted.id} changed before dispatch`);
      }
      if (await require('./invoice-followups').isDunningStopped(row.id, database)) {
        return changed('dunning stopped for a quoted invoice');
      }
    }
    if (quotedDuesCents > 0 && (await currentDuesAllowanceCents(customerId, database)) !== quotedDuesCents) {
      return changed('quoted monthly dues changed before dispatch');
    }
    return { ok: true };
  };
  // The Email authority passes the transaction it holds under the customer
  // lock: read through it instead of a second pooled connection, inside a
  // savepoint so a failed read cannot abort that held transaction.
  return async ({ database, dbi } = {}) => {
    // Email supplies `database`; the SMS handoff supplies `dbi`.
    const connection = database || dbi || db;
    try {
      return connection.isTransaction
        ? await connection.transaction((savepoint) => recheck(savepoint))
        : await recheck(connection);
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
    explicitChannels = await storedBillingChannels(visit.customer_id, 'billing', db);
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

async function visitPayerBilled(visit) {
  try {
    const resolved = await require('./payer').resolveForInvoice({
      customerId: visit.customer_id,
      scheduledServiceId: visit.id,
    });
    return !!resolved?.payerId;
  } catch (payerErr) {
    // A resolve outage fails toward SKIP: a billing dun must never reach a
    // homeowner whose visits a third party pays for.
    logger.warn(`[previsit-balance] payer resolve failed for visit ${visit.id} — skipping to be safe: ${payerErr.message}`);
    return true;
  }
}

async function collectedDuesForVisit(visit, lane, obligation) {
  if (lane.mode !== 'monthly_membership') return null;
  // Check the obligation month, not the sweep month. The noon-Z anchor keeps
  // the ET month stable when a month-end billing day rolls into the next one.
  return monthlyDuesCollected(db, visit.customer_id, new Date(`${obligation.dueDateEt}T12:00:00Z`));
}

function policyEligibleInvoices(invoices, eligibleIds) {
  if (eligibleIds === null || eligibleIds === undefined) return invoices;
  const eligible = new Set(eligibleIds.map(String));
  return invoices.filter((invoice) => eligible.has(String(invoice.id)));
}

async function prepareVisitReminder(visit, { now, todayEt }) {
  const lane = resolveBillingLane(visit);
  const obligation = duesObligation(todayEt, visit.billing_day);
  const duesCollected = await collectedDuesForVisit(visit, lane, obligation);
  const payerBilled = await visitPayerBilled(visit);
  const freshAll = await freshOverdueRecurringInvoices(visit.customer_id, now);
  const duesCents = lateDuesCents({ lane, duesCollected, todayEt, obligation, monthlyRate: visit.monthly_rate });
  const gate = await previsitPolicyGate({
    visit,
    consult: {
      customerId: visit.customer_id,
      purpose: 'balance_reminder',
      offLedgerBalanceCents: duesCents,
      logTag: 'previsit-balance',
    },
  });
  if (gate.skip) return null;
  const fresh = policyEligibleInvoices(freshAll, gate.eligibleIds);
  const overdueRecurringDue = fresh.reduce((sum, invoice) => sum + invoiceAmountDue(invoice), 0);
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
  if (!verdict.send) return null;
  const amount = verdict.duesLate
    ? (Number(visit.monthly_rate) || 0) + verdict.overdueDue
    : verdict.overdueDue;
  if (!(amount > 0)) return null;
  return { ...gate, amount, duesCents, fresh };
}

async function claimVisitReminder(visitId) {
  return db('scheduled_services')
    .where({ id: visitId })
    .whereNull('balance_reminder_sent_at')
    .update({ balance_reminder_sent_at: new Date() });
}

async function legacyEmailAvailable(customerId) {
  try {
    const result = await require('./account-membership-email')
      .resolvePrevisitBalanceEmailRecipient(customerId);
    return !!result.recipient;
  } catch {
    return false;
  }
}

function legacyLedgerInput(visit, amount, fresh, channel) {
  return {
    customerId: visit.customer_id,
    channel,
    purpose: 'balance_reminder',
    invoiceIds: fresh.map((invoice) => invoice.id),
    source: 'previsit_balance_reminder',
    metadata: { scheduled_service_id: visit.id, amount },
  };
}

async function deliverLegacySms({ visit, amount, fresh, smsPolicyPermitted, emailLegAvailable }) {
  if (!smsPolicyPermitted) return false;
  try {
    const body = await renderSmsTemplate(TEMPLATE_KEY, {
      first_name: visit.first_name || 'there',
      amount: amount.toFixed(2),
      service_type: visit.service_type || 'service',
      visit_date: friendlyVisitDate(visit.scheduled_date),
      billing_url: BILLING_PORTAL_URL,
    });
    if (!body) throw new Error('template rendered empty (inactive or missing)');
    const smsLedger = await ContactLedger.recordContact(legacyLedgerInput(visit, amount, fresh, 'sms'));
    const result = await sendCustomerMessage({
      to: visit.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'billing',
      customerId: visit.customer_id,
      entryPoint: 'previsit_balance_reminder',
      hasEmailLeg: emailLegAvailable,
      metadata: { scheduled_service_id: visit.id, amount },
    });
    const delivered = !result.blocked && result.sent !== false;
    if (!delivered) await ContactLedger.markSendFailed(smsLedger, { code: result.code || 'blocked' });
    return delivered;
  } catch (smsErr) {
    logger.warn(`[previsit-balance] SMS failed for visit ${visit.id}: ${smsErr.message}`);
    return false;
  }
}

async function deliverLegacyEmail({ visit, amount, fresh, emailLegAvailable }) {
  if (!emailLegAvailable) return false;
  try {
    const emailLedger = await ContactLedger.recordContact(legacyLedgerInput(visit, amount, fresh, 'email'));
    const emailResult = await require('./account-membership-email').sendPrevisitBalanceReminder({
      customerId: visit.customer_id,
      amount: `$${amount.toFixed(2)}`,
      serviceType: visit.service_type || 'service',
      visitDate: friendlyVisitDate(visit.scheduled_date),
      billingUrl: BILLING_PORTAL_URL,
      idempotencyKey: `${EMAIL_TEMPLATE_KEY}:${visit.id}`,
    });
    const delivered = emailResult?.ok === true;
    if (!delivered) {
      await ContactLedger.markSendFailed(emailLedger, { reason: emailResult?.reason || 'email_not_sent' });
    }
    return delivered;
  } catch (emailErr) {
    logger.warn(`[previsit-balance] email failed for visit ${visit.id}: ${emailErr.message}`);
    return false;
  }
}

async function deliverLegacyPrevisitReminder({ visit, amount, fresh, smsPolicyPermitted, emailPolicyPermitted }) {
  // Declare the Email sidecar to the SMS gate only when it can actually send;
  // otherwise an Email-preferring customer could lose both legs.
  const emailLegAvailable = emailPolicyPermitted && await legacyEmailAvailable(visit.customer_id);
  const smsDelivered = await deliverLegacySms({
    visit, amount, fresh, smsPolicyPermitted, emailLegAvailable,
  });
  const emailDelivered = await deliverLegacyEmail({ visit, amount, fresh, emailLegAvailable });
  if (smsDelivered || emailDelivered) return 'sent';
  await releasePrevisitClaim(visit.id);
  return 'skipped';
}

async function processVisitReminder(visit, context) {
  const prepared = await prepareVisitReminder(visit, context);
  if (!prepared) return 'skipped';
  if (!await claimVisitReminder(visit.id)) return 'skipped';
  if (prepared.explicitChannels !== null) {
    return deliverExplicitPrevisitReminder({
      visit,
      amount: prepared.amount,
      duesCents: prepared.duesCents,
      explicitChannels: prepared.explicitChannels,
      quotedInvoices: prepared.fresh.map((invoice) => ({ id: invoice.id, due: invoiceAmountDue(invoice) })),
    });
  }
  return deliverLegacyPrevisitReminder({ visit, ...prepared });
}

function sweepWindow(todayEt) {
  const iso = (date) => date.toISOString().slice(0, 10);
  // Tomorrow → today+LEAD_DAYS gives a released failed claim another sweep
  // while the appointment claim still enforces one completed reminder.
  const windowStart = new Date(`${todayEt}T12:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() + 1);
  const target = new Date(`${todayEt}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + LEAD_DAYS);
  return { windowStartDate: iso(windowStart), targetDate: iso(target) };
}

async function sweepVisits(windowStartDate, targetDate) {
  return db('scheduled_services')
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
}

async function runSweep({ now = new Date() } = {}) {
  if (!gateEnabled()) return { skipped: true, reason: 'gate_off' };
  if (!(await smsTemplateActive())) return { skipped: true, reason: 'template_inactive' };
  const todayEt = etDateString(now);
  const { windowStartDate, targetDate } = sweepWindow(todayEt);
  const visits = await sweepVisits(windowStartDate, targetDate);
  const counts = { sent: 0, skipped: 0 };
  for (const visit of visits) {
    try {
      const outcome = await processVisitReminder(visit, { now, todayEt });
      if (outcome === 'sent') counts.sent++;
      else counts.skipped++;
    } catch (err) {
      logger.error(`[previsit-balance] sweep failed for visit ${visit.id}: ${err.message}`);
      counts.skipped++;
    }
  }
  logger.info(`[previsit-balance] sweep for ${windowStartDate}..${targetDate}: ${counts.sent} sent, ${counts.skipped} skipped of ${visits.length}`);
  return { ...counts, considered: visits.length, targetDate };
}

module.exports = {
  runSweep,
  currentDuesAllowanceCents,
  quotedBalanceStillOwed,
  previsitBalanceReminderEligible,
  duesObligation,
  friendlyVisitDate,
  overdueRecurringInvoices,
  freshOverdueRecurringInvoices,
  TEMPLATE_KEY,
  EMAIL_TEMPLATE_KEY,
  LEAD_DAYS,
  DUES_GRACE_DAYS,
  OVERDUE_AFTER_DAYS,
};
