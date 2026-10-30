'use strict';

// Quiet overdue invoices: one standing office bell (owner 2026-10-24).
//
// An audit on 2026-10-24 found open self-pay invoices that no reminder reaches.
// Their follow-up sequence is paused with no end, stopped by staff, finished
// at its last step, or held for Auto Pay that never charged, or the invoice
// never got a sequence at all (orphan adoption leaves legacy-history and
// past-final-step invoices "for a person" and only logs them). None of those
// states has a timer or an office alert, so a $996 invoice sat for months.
// A pause with an end date does not end on its own either: runPending only
// selects `active` rows, so `paused_until` is a label, not a timer.
//
// This job lists them on ONE needs-you Billing bell row. A standing list is a
// standing condition (docs/admin-notifications.md section 1): the row is
// refreshed every weekday, rings again only when an invoice joins the list
// (or the list comes back after it was empty), and closes itself (done) once
// the list is empty. A person's own done stays done until a new invoice
// joins. It sends nothing to a customer and changes no invoice or reminder.
//
// Listed: a published (sent / viewed / overdue), homeowner-billed, unarchived
// invoice with money due, no active payment plan, and no open customer-level
// reminder schedule (a customer that engine owns is held and alerted by it,
// owner rulings D3/D10), when
//   - its sequence is on Auto Pay hold 7+ days (counted from the later of the
//     row's last change and the due date): the owner's "an autopay hold alerts
//     the office after 7 days with no charge"; a held invoice that is paid
//     normally clears in about 2 days. The row's last change is when it
//     entered the hold: every writer that sets `autopay_hold` stamps
//     `updated_at` (the follow-up file's rule), and nothing writes a held row
//     again except a failed Auto Pay charge, which restarts the 7 days.
//     `created_at` would not do: a paused or stopped row can enter the hold
//     weeks after it was created (visit-completion-packets.js, a resume);
//   - or any other quiet state once it is 14+ days past due.
// Not quiet: an active sequence with a next touch, or a pause whose end date
// is still ahead (staff chose that wait).
//
// Only while the legacy sender is retired (balance-reminder.js's account late
// check, by its own full rule): it can still contact an invoice with no
// sequence, a finished one or a stopped one, so "no overdue reminder is scheduled" would not hold. Otherwise the run
// is skipped and the standing row is left as it is.
//
// GATE_QUIET_OVERDUE_LIST (strict 'true', read at call time). Off = the
// weekday cron returns before any read.

const db = require('../models/db');
const { invoiceAmountDue } = require('./invoice-helpers');
const { quietOverdueListLive, alertEpisodesLive } = require('../config/feature-gates');
const { OPEN_STATUSES: OPEN_CUSTOMER_SCHEDULE_STATUSES } = require('./customer-dunning/constants');
const { MAX_WHY_CHARS, breaksAlertRules, composeAdminAlert, raiseAdminAlert } = require('./admin-alert-compose');

const DEDUPE_KEY = 'quiet-overdue-invoices';
const CATEGORY = 'billing';
const QUIET_AFTER_DAYS = 14;
const AUTOPAY_HOLD_DAYS = 7;
const ET = 'America/New_York';
// The delivered statuses orphan adoption (invoice-followups.js) and the
// legacy checker select from: an invoice the customer has.
const PUBLISHED_INVOICE_STATUSES = ['sent', 'viewed', 'overdue'];
// The bell's "Show full text" lists at most this many invoices (oldest first).
const DETAIL_MAX_LINES = 25;
// ops-digest's own itemKeys cap; far above any real list.
const ITEM_KEYS_MAX = 200;

// What the office reads for each quiet state (the detail list only).
const REASON_TEXT = Object.freeze({
  autopay_hold: 'on Auto Pay hold, not charged',
  paused: 'reminders paused, no end date',
  pause_ended: 'pause ended, reminders never restarted',
  stopped: 'reminders stopped',
  finished: 'every reminder sent, nothing next',
  never_set_up: 'no reminders were ever set up',
  unscheduled: 'reminders on, none scheduled',
  unknown: 'reminders in an unknown state',
});

// Which quiet state a row is in, or null when a reminder is still coming (pure).
function quietReason(row, now = new Date()) {
  switch (row.seq_status) {
    case null:
    case undefined:
      return 'never_set_up';
    case 'active':
      return row.next_touch_at ? null : 'unscheduled';
    case 'paused':
      if (!row.paused_until) return 'paused';
      return new Date(row.paused_until).getTime() > now.getTime() ? null : 'pause_ended';
    case 'stopped':
      return 'stopped';
    case 'completed':
      return 'finished';
    case 'autopay_hold':
      return 'autopay_hold';
    default:
      return 'unknown';
  }
}

function listedReason(row, now = new Date()) {
  const reason = quietReason(row, now);
  if (!reason) return null;
  if (reason === 'autopay_hold') return Number(row.hold_days) >= AUTOPAY_HOLD_DAYS ? reason : null;
  return Number(row.days_late) >= QUIET_AFTER_DAYS ? reason : null;
}

// Every invoice that could be listed, with its ET-calendar age. Ages are
// computed in SQL against `now` so a DATE due_date never shifts with the
// server's time zone.
function candidatesQuery(now = new Date(), database = db) {
  const today = database.raw(`(?::timestamptz AT TIME ZONE '${ET}')::date`, [now.toISOString()]);
  const dueDay = `COALESCE(i.due_date::date, (COALESCE(i.sent_at, i.sms_sent_at, i.created_at) AT TIME ZONE '${ET}')::date)`;
  return database('invoices as i')
    .join('customers as c', 'c.id', 'i.customer_id')
    .leftJoin('invoice_followup_sequences as s', 's.invoice_id', 'i.id')
    .whereIn('i.status', PUBLISHED_INVOICE_STATUSES)
    .whereNull('i.payer_id')
    .where(function notWithdrawn() {
      this.whereNull('i.scheduled_send_error').orWhereNot('i.scheduled_send_error', 'like', 'payer_billed:%');
    })
    .whereNull('i.archived_at')
    .whereNull('c.deleted_at')
    .whereRaw('COALESCE(i.total, 0) - COALESCE(i.credit_applied, 0) - COALESCE(i.amount_paid, 0) > 0')
    .whereRaw(`${dueDay} <= ? - ?::int`, [today, AUTOPAY_HOLD_DAYS])
    .whereNotExists(function noActivePlan() {
      this.select(1).from('payment_plans')
        .whereRaw('payment_plans.invoice_id = i.id')
        .andWhere('payment_plans.status', 'active');
    })
    .whereNotExists(function noOpenCustomerSchedule() {
      this.select(1).from('customer_dunning_schedules as d')
        .whereRaw('d.customer_id = i.customer_id')
        .whereIn('d.status', OPEN_CUSTOMER_SCHEDULE_STATUSES);
    })
    .select(
      'i.id', 'i.invoice_number', 'i.customer_id', 'i.total', 'i.credit_applied', 'i.amount_paid',
      'c.first_name', 'c.last_name',
      's.status as seq_status', 's.next_touch_at', 's.paused_until', 's.stopped_by_admin_id', 's.stopped_reason',
      's.autopay_failures_observed',
      database.raw(`? - ${dueDay} AS days_late`, [today]),
      database.raw(`? - GREATEST((s.updated_at AT TIME ZONE '${ET}')::date, ${dueDay}) AS hold_days`, [today]),
    );
}

function moneyCents(amount) {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function moneyWhole(amount) {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function customerName(row) {
  return [row.first_name, row.last_name].map((part) => String(part || '').trim()).filter(Boolean).join(' ') || 'Unknown customer';
}

function reasonWords(item) {
  const base = REASON_TEXT[item.reason] || REASON_TEXT.unknown;
  if (item.reason === 'stopped') {
    // Staff write their own reason ("Check"); a system stop carries a code, which stays out of the copy.
    const note = item.stoppedByStaff ? String(item.stoppedReason || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return item.stoppedByStaff ? `${base} by staff${note ? ` ("${note}")` : ''}` : `${base} by the system`;
  }
  if (item.reason === 'autopay_hold') {
    const failures = Number(item.autopayFailures) || 0;
    return failures ? `on Auto Pay hold, ${failures} failed charge${failures === 1 ? '' : 's'}` : base;
  }
  return base;
}

// The listed invoices, oldest first (pure, for tests).
function listItems(rows, now = new Date()) {
  const items = [];
  for (const row of rows || []) {
    const reason = listedReason(row, now);
    if (!reason) continue;
    const due = invoiceAmountDue(row);
    if (!(due > 0)) continue;
    items.push({
      invoiceId: String(row.id),
      invoiceNumber: row.invoice_number || String(row.id).slice(0, 8),
      customerName: customerName(row),
      amountDue: due,
      daysLate: Number(row.days_late) || 0,
      holdDays: Number(row.hold_days) || 0,
      reason,
      stoppedByStaff: Boolean(row.stopped_by_admin_id),
      stoppedReason: row.stopped_reason || null,
      autopayFailures: Number(row.autopay_failures_observed) || 0,
    });
  }
  return items.sort((a, b) => b.daysLate - a.daysLate || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
}

// The bell for a non-empty list (pure): the composeAdminAlert spec plus the
// detail text and the ring stamps.
// One invoice names its customer; a name the rule cannot carry (too long, an
// initial that reads as a sentence end) falls back to the plain wording.
function whyFor(items, total) {
  const oldest = items[0];
  if (items.length > 1) return `${moneyWhole(total)} is owed with no overdue reminder scheduled on any of them; the oldest is ${oldest.daysLate} days late.`;
  const named = `${oldest.customerName} owes ${moneyWhole(total)} with no overdue reminder scheduled; it is ${oldest.daysLate} days late.`;
  if (named.length <= MAX_WHY_CHARS && !breaksAlertRules(named)) return named;
  return `${moneyWhole(total)} is owed on one invoice with no overdue reminder scheduled; it is ${oldest.daysLate} days late.`;
}

function composeList(items) {
  const count = items.length;
  const total = items.reduce((sum, item) => sum + item.amountDue, 0);
  const oldest = items[0];
  const plural = count === 1 ? '' : 's';
  const why = whyFor(items, total);
  const lines = items.slice(0, DETAIL_MAX_LINES).map((item) => (
    `${item.invoiceNumber} · ${item.customerName} · ${moneyCents(item.amountDue)} · ${item.daysLate} days late · ${reasonWords(item)}`
  ));
  if (count > DETAIL_MAX_LINES) lines.push(`…and ${count - DETAIL_MAX_LINES} more.`);
  const detail = [
    `${count} open invoice${plural}, ${moneyCents(total)} owed. No overdue reminder is scheduled on ${count === 1 ? 'it' : 'any of them'}, and nothing was sent by this check.`,
    'Oldest first:',
    ...lines,
  ].join('\n');
  const spec = {
    area: 'Billing',
    action: `follow up on ${count} quiet overdue invoice${plural}`,
    why,
    severity: 'needs-you',
    // One invoice: open it. Several: the Invoices page.
    link: count === 1 ? `/admin/invoices?invoice=${encodeURIComponent(oldest.invoiceId)}` : '/admin/invoices',
    subject: { type: 'check', id: DEDUPE_KEY },
    doneWhen: 'count_zero',
    who: 'person',
  };
  const itemKeys = items.map((item) => item.invoiceId).sort().slice(0, ITEM_KEYS_MAX);
  return { spec, detail, itemKeys, count, total: Math.round(total * 100) / 100 };
}

// A refresh rings only when an invoice joins the list. (A comeback after the
// row was closed rings through raiseAdminAlertWithReopen, which ignores this.)
function ringOnNewInvoice(itemKeys) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return itemKeys.some((key) => !prior.has(key));
  };
}

async function raiseList(composed, dedupeKey) {
  const opts = {
    dedupeKey,
    // GATE_ADMIN_BELL_POLICY admits a billing row only when the site asks: ring
    // unless the owner silenced the category (notification-bell-policy.js).
    bellDefault: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewInvoice(composed.itemKeys),
    // A refresh that rings moves the row to the top of the newest-first bell.
    bumpOnRefresh: true,
    detail: composed.detail,
    metadata: { itemKeys: composed.itemKeys, count: composed.count, totalDue: composed.total },
  };
  if (!alertEpisodesLive()) return raiseAdminAlert(CATEGORY, composed.spec, opts);
  const alert = composeAdminAlert(composed.spec);
  return require('./admin-alert-episodes').raiseAdminAlertWithReopen(CATEGORY, alert.headline, alert.why, {
    ...opts, link: alert.link, metadata: { ...opts.metadata, ...alert.metadata },
  });
}

async function closeList(database, dedupeKey) {
  if (!alertEpisodesLive()) return 0;
  return require('./admin-alert-episodes').closeAdminAlertKeys(database, [dedupeKey], 'count_zero', {
    resolution: 'Every overdue invoice has reminders going out or is settled',
  });
}

// The legacy sender retired: the balance reminder's account late check (its
// full retirement test: gate, ladder, orphan adoption, no legacy `unpaid`
// invoice, an unreadable count reads as running).
async function legacySendersRetired() {
  return require('./workflows/balance-reminder').latePaymentCheckRetired({ log: false });
}

/**
 * Weekday cron entry point. Returns { skipped } when the gate is off or a
 * legacy sender still runs, otherwise { count, outcome }: raised | refreshed |
 * unchanged | suppressed | closed | clear. A read failure throws
 * (runExclusive records it in job_health) and never closes the row.
 * `loadRows` is the row source and `dedupeKey` the row's key (tests set both).
 */
async function runQuietOverdueList({ now = new Date(), database = db, gateEnabled, loadRows = candidatesQuery, dedupeKey = DEDUPE_KEY } = {}) {
  if (!(gateEnabled ?? quietOverdueListLive())) return { skipped: 'disabled' };
  if (!(await legacySendersRetired())) return { skipped: 'legacy_sender_live' };
  const items = listItems(await loadRows(now, database), now);
  if (!items.length) {
    const closed = Number(await closeList(database, dedupeKey)) || 0;
    return { count: 0, outcome: closed ? 'closed' : 'clear' };
  }
  const composed = composeList(items);
  const result = await raiseList(composed, dedupeKey);
  if (!result) throw new Error('quiet overdue invoice bell was not written');
  let outcome = 'unchanged';
  // The owner silenced billing bells: the bell policy wrote nothing.
  if (result.suppressed) outcome = 'suppressed';
  else if (!result.deduped) outcome = 'raised';
  else if (result.refreshed) outcome = result.rung === false ? 'refreshed' : 'raised';
  return { count: composed.count, total: composed.total, outcome };
}

module.exports = {
  runQuietOverdueList,
  DEDUPE_KEY,
  _private: {
    quietReason, listedReason, listItems, composeList, ringOnNewInvoice, candidatesQuery, reasonWords,
    QUIET_AFTER_DAYS, AUTOPAY_HOLD_DAYS, DETAIL_MAX_LINES,
  },
};
