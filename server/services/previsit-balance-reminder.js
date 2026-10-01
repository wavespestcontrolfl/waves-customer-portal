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
const { toE164 } = require('../utils/phone');
const { withSmsConsentLock } = require('../utils/customer-comms-lock');
const { runExclusive } = require('../utils/cron-lock');
const { resolveBillingLane, monthlyDuesCollected } = require('./billing-lane');
const { invoiceAmountDue, isInvoiceCollectibleStatus, invoiceWithdrawnFromCustomer } = require('./invoice-helpers');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { collectionsChannelVerdict } = require('./collections/rail-guard');
const ContactLedger = require('./collections/contact-ledger');
const { explicitBillingChannels, billingChannelAllowed } = require('./billing-delivery-channels');
const { reminderProgress, sendReminderChannels } = require('./billing-reminder-delivery');

const TEMPLATE_KEY = 'previsit_balance_reminder';
const EMAIL_TEMPLATE_KEY = 'billing.previsit_balance';
const BILLING_PORTAL_URL = 'https://portal.wavespestcontrol.com/?tab=billing';
// Days before the visit the reminder goes out — far enough to pay, close
// enough to matter. Owner decision 6 (2026-09-27, dunning unification): the
// balance note moves to 5 days before the visit — ahead of the 72-hour
// appointment reminder — under GATE_PREVISIT_BALANCE_5DAY (strict 'true',
// read at call time, unset = kill). Gate off keeps the original 3-day lead
// byte-identical. Widening the window on a gated-on run also claims 4-5-day
// -out visits that were not yet claimed, but the one-per-appointment claim
// on scheduled_services.balance_reminder_sent_at (below) guarantees no
// visit is ever sent twice.
function leadDays() {
  return process.env.GATE_PREVISIT_BALANCE_5DAY === 'true' ? 5 : 3;
}
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

// Keep the live sweep's eligibility and recent-contact filtering in one
// selector so every candidate is screened by the same evidence reads.
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
  const fresh = overdue.filter((invoice) => isInvoiceCollectibleStatus(invoice.status)
    && !invoiceWithdrawnFromCustomer(invoice)
    && invoiceAmountDue(invoice) > 0
    && !legacyDunnedIds.has(String(invoice.id))
    && [invoice.last_reminder_at, invoice.followup_last_touch_at]
      .filter(Boolean)
      .every((touch) => new Date(touch) < cutoff));
  // A customer-level overdue reminder (dunning consolidation §8) names the
  // customer's whole balance and stamps only its schedule row, never the
  // per-invoice sequence: a schedule touch inside the window covers every
  // invoice here. With no schedule rows this changes nothing.
  if (fresh.length && await customerScheduleTouchedSince(customerId, cutoff, database)) return [];
  return fresh;
}

// Only a touch the SCHEDULE made counts: last_touch_at after the row was
// created. Promotion seeds last_touch_at from the members' own per-invoice
// touches (seed.js), which the followup_last_touch_at check above already
// judges invoice by invoice; counting the seeded copy would suppress every
// invoice right after promotion, before any combined reminder went out. Every
// engine write of last_touch_at (advance, completeFinal, markTold) is a delivery
// under a claim taken after the row existed.
async function customerScheduleTouchedSince(customerId, cutoff, database) {
  const row = await database('customer_dunning_schedules')
    .where({ customer_id: customerId })
    .where('last_touch_at', '>=', cutoff)
    .whereRaw('last_touch_at > created_at')
    .first('id');
  return !!row;
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

async function previsitPolicySnapshots(channels, consult) {
  const snapshots = [];
  for (const channel of channels) {
    const snapshot = { channel, ...await collectionsChannelVerdict({ ...consult, channel }) };
    snapshots.push(snapshot);
    if (snapshot.balanceIncomplete) break;
  }
  return snapshots;
}

function previsitInvoicePolicy(snapshots, explicit) {
  const sms = snapshots.find((snapshot) => snapshot.channel === 'sms');
  const email = snapshots.find((snapshot) => snapshot.channel === 'email');
  const lists = snapshots.filter((snapshot) => snapshot.permitted)
    .map((snapshot) => snapshot.eligibleInvoiceIds).filter((ids) => ids != null);
  return {
    invoiceIds: explicit
      ? (lists.length ? lists.reduce((ids, next) => ids.filter((id) => next.map(String).includes(String(id)))) : null)
      : (sms.permitted && sms.eligibleInvoiceIds !== null ? sms.eligibleInvoiceIds : email.eligibleInvoiceIds),
    smsPolicyPermitted: sms?.permitted,
    emailPolicyPermitted: email?.permitted,
  };
}

function retainedPrevisitQuote(episode, visit) {
  if (!episode) return undefined;
  const { sanitizeBillingReplayContext } = require('./billing-email-replay-context');
  const quotes = [];
  for (const entry of episode.entries) {
    let metadata = entry.metadata;
    try { if (typeof metadata === 'string') metadata = JSON.parse(metadata); } catch { return null; }
    if (!episode.delivered?.has(entry.channel)
      && (metadata?.send_failed === true || metadata?.resolved === true)) continue;
    const quote = sanitizeBillingReplayContext({ ...metadata,
      schema_version: 1, category: 'billing', customer_id: String(visit.customer_id),
      source_entry_point: 'previsit_balance_reminder', collections_ledger_id: String(entry.id),
      appointment_id: metadata?.scheduled_service_id,
    });
    if (!quote || quote.appointment_id !== String(visit.id)) return null;
    quotes.push({ amount: Number(quote.rendered_amount), duesCents: quote.dues_cents,
      fresh: quote.invoice_quotes.map((invoice) => ({ id: invoice.id, total: invoice.dueCents / 100 }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      quotedVisit: { scheduled_date: quote.appointment_date, service_type: quote.appointment_service_type } });
  }
  if (!quotes.length) return episode.delivered?.size ? null : undefined;
  if (quotes.some((quote) => JSON.stringify(quote) !== JSON.stringify(quotes[0]))) return null;
  return quotes[0];
}

async function prepareVisitReminder(visit, { now, todayEt }) {
  // An unreadable choice must leave the visit unclaimed. Null alone retains legacy delivery.
  const prefs = await db('notification_prefs').where({ customer_id: visit.customer_id }).first();
  const channels = explicitBillingChannels(prefs, 'billing');
  if (channels && !channels.length) return null;
  const lane = resolveBillingLane(visit);
  const obligation = duesObligation(todayEt, visit.billing_day);
  // Check the obligation month, not the sweep month. The noon-Z anchor keeps
  // the ET month stable when a month-end billing day rolls into the next one.
  const duesCollected = lane.mode === 'monthly_membership'
    ? await monthlyDuesCollected(db, visit.customer_id, new Date(`${obligation.dueDateEt}T12:00:00Z`)) : null;
  const payerBilled = await visitPayerBilled(visit);
  const freshAll = await freshOverdueRecurringInvoices(visit.customer_id, now);
  const duesLate = lane.mode === 'monthly_membership'
    && duesCollected === false
    && String(todayEt) >= String(obligation.graceDateEt);
  const monthlyRate = Number(visit.monthly_rate) || 0;
  const duesCents = duesLate ? Math.round(monthlyRate * 100) : 0;
  const consult = {
    customerId: visit.customer_id,
    purpose: 'balance_reminder',
    offLedgerBalanceCents: duesCents,
    source: 'previsit_balance_reminder',
    logTag: 'previsit-balance',
  };
  const episode = channels ? (await reminderProgress(visit.customer_id, 'previsit_balance_reminder', channels))
    .find((event) => event.metadata.notificationEventKey === `previsit-balance:${visit.id}`) : null;
  // Delivered or uncertain siblings fix this episode's debt and visit quote.
  // Pending legs may retry that quote only; their held guard checks live debt.
  const retainedQuote = retainedPrevisitQuote(episode, visit);
  if (retainedQuote === null) return null;
  const snapshots = await previsitPolicySnapshots(channels || ['sms', 'email'], {
    ...consult, ...(channels ? { excludeLedgerIds: (episode?.entries || []).map((entry) => entry.id) } : {}),
  });
  if (snapshots.some((snapshot) => snapshot.balanceIncomplete)
    || snapshots.every((snapshot) => !snapshot.permitted)) return null;
  const policy = previsitInvoicePolicy(snapshots, channels !== null);
  const eligible = policy.invoiceIds == null ? null : new Set(policy.invoiceIds.map(String));
  const fresh = eligible ? freshAll.filter((invoice) => eligible.has(String(invoice.id))) : freshAll;
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
  const amount = duesCents / 100 + verdict.overdueDue;
  if (!(amount > 0)) return null;
  return {
    smsPolicyPermitted: policy.smsPolicyPermitted,
    emailPolicyPermitted: policy.emailPolicyPermitted,
    channels,
    amount,
    duesCents,
    fresh,
    ...retainedQuote,
  };
}

async function claimVisitReminder(visitId) {
  return db('scheduled_services')
    .where({ id: visitId })
    .whereNull('balance_reminder_sent_at')
    .update({ balance_reminder_sent_at: new Date() });
}

async function releasePrevisitClaim(visitId) {
  await db('scheduled_services')
    .where({ id: visitId })
    .update({ balance_reminder_sent_at: null })
    .catch((err) => logger.warn(`[previsit-balance] claim release failed for visit ${visitId}: ${err.message}`));
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

const PREVISIT_AUTHORITY_BUSY = {
  ok: false,
  code: 'PREVISIT_AUTHORITY_UNAVAILABLE',
  reason: 'Previsit balance authority is busy; retry with a fresh quote',
  retryable: true,
};

function advisoryLockAcquired(result) {
  const row = result?.rows?.[0] || (Array.isArray(result) ? result[0] : null);
  return row?.locked === true || row?.locked === 't';
}

function frozenInvoiceQuote(invoices) {
  return invoices.map((invoice) => ({
    id: String(invoice.id),
    dueCents: Math.round(invoiceAmountDue(invoice) * 100),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function quoteMatches(current, quoted) {
  if (current.length !== quoted.length) return false;
  return current.every((invoice, index) => invoice.id === quoted[index].id
    && invoice.dueCents === quoted[index].dueCents);
}

async function lockPrevisitBillingRows(trx, visit, requirePhone = true) {
  const customer = await trx('customers').where({ id: visit.customer_id }).forUpdate().first();
  if (!customer || customer.deleted_at || (requirePhone && toE164(customer.phone) !== toE164(visit.phone))) return null;

  const billingLock = await trx.raw(
    'SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked',
    [`cron:billing-customer:${visit.customer_id}`],
  );
  if (!advisoryLockAcquired(billingLock)) return null;

  return trx.transaction(async (savepoint) => {
    await savepoint.raw("SET LOCAL lock_timeout = '500ms'");
    const invoices = await savepoint('invoices').where({ customer_id: visit.customer_id })
      .orderBy('id').forUpdate().noWait().select('*');
    await savepoint('payments').where({ customer_id: visit.customer_id })
      .orderBy('id').forUpdate().noWait().select('id');

    const visitIds = [...new Set([visit.id, ...invoices.map((row) => row.scheduled_service_id)]
      .filter(Boolean).map(String))].sort();
    const visits = await savepoint('scheduled_services').whereIn('id', visitIds)
      .orderBy('id').forUpdate().noWait().select('*');
    const payerIds = [...new Set([customer.payer_id, ...visits.map((row) => row.payer_id)]
      .filter(Boolean).map(String))].sort();
    if (payerIds.length) {
      await savepoint('payers').whereIn('id', payerIds).orderBy('id').forShare().noWait().select('id');
    }
    for (const invoice of invoices) {
      if (isInvoiceCollectibleStatus(invoice.status) && invoiceAmountDue(invoice) > 0) {
        await require('./estimate-deposits').assertInvoiceDepositSettlementReady(savepoint, invoice);
      }
    }
    await savepoint.raw('SET LOCAL lock_timeout = DEFAULT');
    return { customer, visits };
  });
}

function currentDuesCents(customer, database, now) {
  const todayEt = etDateString(now);
  const lane = resolveBillingLane(customer);
  const obligation = duesObligation(todayEt, customer.billing_day);
  return Promise.resolve(lane.mode === 'monthly_membership'
    ? monthlyDuesCollected(database, customer.id, new Date(`${obligation.dueDateEt}T12:00:00Z`))
    : null).then((collected) => (lane.mode === 'monthly_membership' && collected === false
      && todayEt >= obligation.graceDateEt
      ? Math.round((Number(customer.monthly_rate) || 0) * 100) : 0));
}

function visitMatchesPrevisitQuote(current, quoted, requireClaim) {
  return !!current && String(current.customer_id) === String(quoted.customer_id)
    && ['pending', 'confirmed'].includes(current.status) && current.is_recurring === true
    && (!requireClaim || !!current.balance_reminder_sent_at)
    && dateOnlyString(current.scheduled_date) === dateOnlyString(quoted.scheduled_date)
    && String(current.service_type || 'service') === String(quoted.service_type || 'service');
}

function previsitQuoteAuthority({ visit, quotedInvoices, quotedDuesCents, ledgerId, replayContext }) {
  const quoted = frozenInvoiceQuote(quotedInvoices);
  const changed = (reason, supersessionReason) => ({
    ...(supersessionReason ? { supersessionReason } : {}),
    ok: false, code: 'PREVISIT_QUOTE_CHANGED', reason, retryable: true,
  });
  let locked;
  return {
    withSmsHandoff: (dispatch) => withSmsConsentLock(
      db,
      { phone: visit.phone, customerId: visit.customer_id },
      async (trx) => {
        try {
          locked = await lockPrevisitBillingRows(trx, visit);
        } catch (err) {
          if (!['55P03', '57014', 'DEPOSIT_RECONCILIATION_REQUIRED'].includes(err?.code)) throw err;
          return PREVISIT_AUTHORITY_BUSY;
        }
        if (!locked) return PREVISIT_AUTHORITY_BUSY;
        return dispatch(trx);
      },
    ),
    providerPreSendCheck: async ({ dbi, channel = 'sms', readOnly = false } = {}) => {
      if (!dbi || (!readOnly && !dbi.isTransaction)) return PREVISIT_AUTHORITY_BUSY;
      try {
        if (channel !== 'sms') {
          locked = readOnly ? {
            customer: await dbi('customers').where({ id: visit.customer_id }).first(),
            visits: await dbi('scheduled_services').where({ id: visit.id }).select('*'),
          } : await lockPrevisitBillingRows(dbi, visit, false);
        }
        if (!locked?.customer || locked.customer.deleted_at) return PREVISIT_AUTHORITY_BUSY;
        const check = async (savepoint) => {
          const currentVisit = locked.visits.find((row) => String(row.id) === String(visit.id));
          if (!visitMatchesPrevisitQuote(currentVisit, visit, !replayContext)) {
            return changed('visit changed before dispatch', 'balance-reminder-visit-changed');
          }
          let excludeLedgerIds = ledgerId ? [ledgerId] : [];
          if (replayContext) {
            if (replayContext.appointment_rendered_on !== etDateString()) return changed('previsit copy is stale', 'balance-reminder-copy-stale');
            const rows = await savepoint('collections_contact_ledger')
              .where({ customer_id: visit.customer_id, source: 'previsit_balance_reminder' })
              .whereRaw("metadata->>'notificationEventKey' = ?", [replayContext.notificationEventKey]).select('id');
            if (!rows.some((row) => String(row.id) === String(ledgerId))) return changed('previsit reservation changed');
            excludeLedgerIds = rows.map((row) => row.id);
          }
          const payer = await require('./payer').resolveForInvoice({
            database: savepoint,
            customerId: visit.customer_id,
            customer: locked.customer,
            scheduledServiceId: visit.id,
            throwOnError: true,
          });
          if (payer?.payerId) return changed('visit became payer-billed before Text dispatch');

          const now = new Date();
          const duesCents = await currentDuesCents({ ...locked.customer, id: visit.customer_id }, savepoint, now);
          const policies = await previsitPolicySnapshots(replayContext?.selected_channels || [channel], {
            customerId: visit.customer_id, purpose: 'balance_reminder', offLedgerBalanceCents: duesCents,
            excludeLedgerIds, source: 'previsit_balance_reminder', logTag: 'previsit-balance', database: savepoint, now,
          });
          const incomplete = policies.find((policy) => policy.balanceIncomplete);
          if (incomplete) return { ...PREVISIT_AUTHORITY_BUSY,
            reason: `Previsit balance snapshot incomplete: ${incomplete.balanceIncomplete}` };
          if (!policies.some((policy) => policy.channel === channel && policy.permitted)) {
            return changed('collections policy denied selected channel before dispatch');
          }
          const invoices = await freshOverdueRecurringInvoices(visit.customer_id, now, savepoint);
          const lists = policies.filter((policy) => policy.permitted).map((policy) => policy.eligibleInvoiceIds)
            .filter((ids) => ids != null);
          const eligible = invoices.filter((invoice) => lists.every((ids) => ids.map(String).includes(String(invoice.id))));
          if (!quoteMatches(frozenInvoiceQuote(eligible), quoted)) {
            return changed('eligible balance changed before dispatch', 'previsit-quote-changed');
          }
          return duesCents === quotedDuesCents
            ? { ok: true }
            : changed('monthly dues changed before dispatch', 'previsit-quote-changed');
        };
        return dbi.isTransaction ? await dbi.transaction(check) : await check(dbi);
      } catch (err) {
        return { ...PREVISIT_AUTHORITY_BUSY, reason: `Previsit balance recheck failed: ${err.message}` };
      }
    },
  };
}

// Email authority and App bell delivery supply their already-held customer transaction.
// Native App work after bell commit uses the same predicate without taking new locks.
async function previsitReplayQuoteEligible(meta, database, { channel = 'email' } = {}) {
  const context = require('./billing-email-replay-context').sanitizeBillingReplayContext(meta);
  if (!context || context.source_entry_point !== 'previsit_balance_reminder') return PREVISIT_AUTHORITY_BUSY;
  if (channel === 'email') {
    if (!database?.isTransaction) return PREVISIT_AUTHORITY_BUSY;
    try {
      // This episode was created by an explicit choice. Legacy NULL Email
      // permission must not authorize it; retain the preference lock through send.
      const selected = await database.transaction(async (savepoint) => {
        const prefs = await savepoint('notification_prefs').where({ customer_id: context.customer_id })
          .forUpdate().first('billing_channels');
        return billingChannelAllowed(prefs || {}, 'billing', 'email');
      });
      if (selected !== true) return { ...PREVISIT_AUTHORITY_BUSY, reason: 'previsit-email-not-selected' };
    } catch {
      return { ...PREVISIT_AUTHORITY_BUSY, reason: 'previsit-choice-unavailable' };
    }
  }
  const guard = previsitQuoteAuthority({
    visit: { id: context.appointment_id, customer_id: context.customer_id,
      scheduled_date: context.appointment_date, service_type: context.appointment_service_type },
    quotedInvoices: context.invoice_quotes.map((quote) => ({ id: quote.id, total: quote.dueCents / 100 })),
    quotedDuesCents: context.dues_cents,
    ledgerId: context.collections_ledger_id,
    replayContext: context,
  });
  return guard.providerPreSendCheck({ dbi: database, channel,
    readOnly: channel === 'push' && !database?.isTransaction });
}

async function deliverExplicitPrevisitReminder({ visit, amount, duesCents, fresh, channels, quotedVisit }) {
  visit = { ...visit, ...quotedVisit };
  const eventKey = `previsit-balance:${visit.id}`;
  const metadata = {
    selected_channels: channels, scheduled_service_id: visit.id, amount, rendered_amount: amount.toFixed(2),
    invoice_ids: fresh.map((invoice) => String(invoice.id)), invoice_quotes: frozenInvoiceQuote(fresh), dues_cents: duesCents,
    appointment_date: dateOnlyString(visit.scheduled_date), appointment_service_type: visit.service_type || 'service',
    appointment_rendered_on: etDateString(), notificationEventKey: eventKey,
  };
  let result;
  try {
    result = await sendReminderChannels({
      customerId: visit.customer_id, invoiceId: null, invoiceIds: metadata.invoice_ids,
      policyInvoiceIds: metadata.invoice_ids, offLedgerBalanceCents: duesCents,
      source: 'previsit_balance_reminder', purpose: 'balance_reminder', eventKey, channels, metadata,
      send: async (channel, ledger) => {
        const body = await renderSmsTemplate(TEMPLATE_KEY, {
          first_name: visit.first_name || 'there', amount: amount.toFixed(2), service_type: metadata.appointment_service_type,
          visit_date: friendlyVisitDate(visit.scheduled_date), billing_url: BILLING_PORTAL_URL,
        });
        if (!body) return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'TEMPLATE_UNAVAILABLE' };
        const replayContext = { schema_version: 1, category: 'billing', customer_id: String(visit.customer_id),
          source_entry_point: 'previsit_balance_reminder', appointment_id: String(visit.id),
          ...metadata, collections_ledger_id: String(ledger.id) };
        const authority = previsitQuoteAuthority({ visit, quotedInvoices: fresh, quotedDuesCents: duesCents,
          ledgerId: ledger.id, replayContext });
        return sendCustomerMessage({
          to: channel === 'sms' ? visit.phone : null, body, channel: channel === 'push' ? 'sms' : channel,
          audience: 'customer', purpose: 'billing', customerId: visit.customer_id, appointmentId: visit.id,
          entryPoint: 'previsit_balance_reminder', hasEmailLeg: true,
          ...(channel === 'sms' ? authority : { preSendCheck: ({ database } = {}) =>
            previsitReplayQuoteEligible(replayContext, database || db, { channel }) }),
          metadata: { ...metadata, collections_ledger_id: ledger.id, original_message_type: 'balance_reminder',
            billingDeliveryCategory: 'billing', billingDeliveryLeg: channel, ...(channel === 'push' ? { appOnly: true } : {}) },
        });
      },
    });
  } finally {
    if (!result?.complete) await releasePrevisitClaim(visit.id);
  }
  return result.deliveredNow.length ? 'sent' : 'skipped';
}

async function deliverLegacySms({ visit, amount, duesCents, fresh, smsPolicyPermitted, emailLegAvailable }) {
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
    const authority = previsitQuoteAuthority({
      visit,
      quotedInvoices: fresh,
      quotedDuesCents: duesCents,
      ledgerId: smsLedger?.id,
    });
    const result = await sendCustomerMessage({
      to: visit.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'billing',
      customerId: visit.customer_id,
      entryPoint: 'previsit_balance_reminder',
      hasEmailLeg: emailLegAvailable,
      withSmsHandoff: authority.withSmsHandoff,
      providerPreSendCheck: authority.providerPreSendCheck,
      metadata: { scheduled_service_id: visit.id, amount },
    });
    const delivered = !result.blocked && result.sent !== false;
    if (!delivered) {
      // A dispute hold that landed after the preflight is a WAIT: release the reservation, no failed
      // row; the claim is released by the caller so the reminder is retried after the release.
      if (require('./collections/collection-hold').isHoldSuppression(result)) await ContactLedger.releaseHeldReservation(smsLedger);
      else await ContactLedger.markSendFailed(smsLedger, { code: result.code || 'blocked' });
    }
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
      // Dispute hold after the preflight: a WAIT (see deliverLegacySms) - release, do not stamp failed.
      if (require('./collections/collection-hold').isHoldSuppression(emailResult)) await ContactLedger.releaseHeldReservation(emailLedger);
      else await ContactLedger.markSendFailed(emailLedger, { reason: emailResult?.reason || 'email_not_sent' });
    }
    return delivered;
  } catch (emailErr) {
    logger.warn(`[previsit-balance] email failed for visit ${visit.id}: ${emailErr.message}`);
    return false;
  }
}

async function deliverLegacyPrevisitReminder({ visit, amount, duesCents, fresh, smsPolicyPermitted, emailPolicyPermitted }) {
  // Declare the Email sidecar to the SMS gate only when it can actually send;
  // otherwise an Email-preferring customer could lose both legs.
  const emailLegAvailable = emailPolicyPermitted && await legacyEmailAvailable(visit.customer_id);
  const smsDelivered = await deliverLegacySms({
    visit, amount, duesCents, fresh, smsPolicyPermitted, emailLegAvailable,
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
  return prepared.channels ? deliverExplicitPrevisitReminder({ visit, ...prepared })
    : deliverLegacyPrevisitReminder({ visit, ...prepared });
}

async function runSweep({ now = new Date() } = {}) {
  if (!gateEnabled()) return { skipped: true, reason: 'gate_off' };
  if (!(await smsTemplateActive())) return { skipped: true, reason: 'template_inactive' };
  // Reentrant with the scheduler's lease, and also protects direct callers.
  // Email retirement takes the same key on its work transaction, so it can
  // reopen an idle claim only after this producer has finished every leg.
  return runExclusive('previsit-balance-reminder', () => runSweepHeld(now),
    { recordHealth: false, waitForSlot: false });
}

async function runSweepHeld(now) {
  const todayEt = etDateString(now);
  const iso = (dt) => dt.toISOString().slice(0, 10);
  // WINDOW, not a single day: the claim releases on a failed send, and a
  // single exact-date target would never re-see that visit on later daily
  // runs (Codex r3). Tomorrow → today+leadDays() keeps one send per
  // appointment (the claim dedupes) while giving failures leadDays()-1
  // retry days.
  const windowStart = new Date(`${todayEt}T12:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() + 1);
  const target = new Date(`${todayEt}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + leadDays());
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
      'scheduled_services.status',
      'scheduled_services.is_recurring',
      'customers.first_name',
      'customers.phone',
      'customers.billing_mode',
      'customers.waveguard_tier',
      'customers.monthly_rate',
      'customers.billing_day',
    );

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
  previsitReplayQuoteEligible,
  previsitBalanceReminderEligible,
  duesObligation,
  friendlyVisitDate,
  overdueRecurringInvoices,
  TEMPLATE_KEY,
  EMAIL_TEMPLATE_KEY,
  leadDays,
  DUES_GRACE_DAYS,
  OVERDUE_AFTER_DAYS,
  // The same two dark levers runSweep() itself checks before it does
  // anything (PREVISIT_BALANCE_REMINDER=true AND the seeded SMS template
  // active) — exported so balance-reminder.js's dailyCheck() can tell
  // whether ITS replacement is actually live before retiring under
  // GATE_BALANCE_REMINDER_LEGACY_OFF (dunning unification round-2 review).
  gateEnabled,
  smsTemplateActive,
  _test: { previsitQuoteAuthority, freshOverdueRecurringInvoices, customerScheduleTouchedSince },
};
