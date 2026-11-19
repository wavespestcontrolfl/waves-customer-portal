'use strict';

// Hourly check: an invoice paid at its visit that still has no receipt after 2 hours (owner 2026-11-18, "the daily
// check"). A customer paid by check at the tech's checkout; the dispatch check and cash tender sheets recorded
// the payment with sendReceipt: false, no receipt went out and nobody noticed until the customer texted. This is the live-data
// check that would have found it without the owner (portal .claude/commands/lesson.md, "Check it on live data").
//
// A hit is an invoice where ALL hold:
//   - status paid, no receipt_sent_at and no receipt_sms_sent_at (an accepted receipt text, stamped on its own), not
//     archived, total above 0, not a payer statement child (payer_statement_id) and not billed to a third-party payer
//     (payer_id);
//   - it links to a visit (scheduled_service_id, or through its service record: service_records.scheduled_service_id, as
//     invoice.js resolves a post-completion invoice) and the ET calendar day of paid_at is that visit's scheduled_date
//     ("paid at the visit": a back-office reconciliation of an old check is skipped);
//   - paid_at is between 7 days and 2 hours ago;
//   - the customer is not an internal test customer and has not turned payment receipts off
//     (notification_prefs.payment_receipt = false);
//   - its receipt_delivery_jobs row (one per invoice) is not still in flight (any status but completed or failed) and did
//     not deliver a leg (email_result.ok or sms_result.sent: a delivered receipt the stamp missed). A Text leg carried by
//     the visit summary text that was never accepted is a hit, unless the queue's own carried-receipt alert
//     (CARRIED_RECEIPT_ALERT_PREFIX) stands for it: one bell per invoice. A failed job that delivered nothing IS a hit.
//     A failed job parked for reconciliation (RECONCILIATION_HOLD_ERROR: an operator send whose outcome is unknown) is a
//     hit with other words: check that the customer got the receipt before sending it again.
//
// ONE Billing bell per invoice (category billing, dedupeKey `paid-visit-no-receipt:<invoice id>`, bell: true because
// billing is silenced by default), raised once per episode (raiseAdminAlertWithReopen: a standing row is a silent
// dedupe, a person's Done stays done). Each run first closes every open bell whose invoice now has a receipt stamp
// (email or text), is no longer paid, is archived or is gone, or whose receipt a job delivered, or whose carried
// receipt the queue's alert now covers, or whose customer turned payment receipts off since. A lookup that throws fails CLOSED for that row (no raise, no close) and the
// run throws after the other rows, so job_health shows it. Standing down while ALERT_EPISODES is off, as every
// episode closer does.
// Read-only except admin notification rows; texts, emails and calls no one, no paid call. No GATE_* (owner rule
// 2026-11-05).

const db = require('../models/db');
const logger = require('./logger');
const { alertEpisodesLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { composeAdminAlert } = require('./admin-alert-compose');
const { fitAction, realName, shortDateET } = require('./admin-alert-names');
const { isInternalTestCustomerId } = require('./internal-test-customers');
const { TEXT_CARRIED_BY_SUMMARY, CARRIED_RECEIPT_ALERT_PREFIX, RECONCILIATION_HOLD_ERROR } = require('./receipt-delivery-queue');
const episodes = require('./admin-alert-episodes');

const KEY_PREFIX = 'paid-visit-no-receipt:';
const AREA = 'Billing';
const CATEGORY = 'billing';
const MIN_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_JOB_STATUSES = ['completed', 'failed'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (key) => String(key).slice(KEY_PREFIX.length);
// Tender words for the why; any other method reads without one.
const METHOD_WORDS = { check: 'by check', cash: 'in cash', card: 'by card', zelle: 'by Zelle', venmo: 'by Venmo', paypal: 'by PayPal', ach: 'by bank transfer' };
const capital = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const errCode = (err) => String(err?.code || err?.name || 'error').slice(0, 40);

// "Paid at the visit": the ET calendar day of the payment is the visit's own day.
function paidAtVisit(row) {
  const visitDay = dateOnlyString(row.scheduled_date);
  return Boolean(row.paid_at && visitDay) && etDateString(new Date(row.paid_at)) === visitDay;
}

// Why the invoice's bell is done, or null while it stands.
function settledReason(row) {
  if (!row) return 'invoice gone';
  if (row.receipt_sent_at || row.receipt_sms_sent_at) return 'receipt sent';
  if (String(row.status || '').toLowerCase() !== 'paid') return `invoice ${String(row.status || 'changed').toLowerCase()}`;
  if (row.archived_at) return 'invoice archived';
  return null;
}

// Paid invoices that look like a hit before the per-row lookups: the SQL holds every fixed rule, paidAtVisit the
// calendar-day one (an ET day, never a fixed offset).
async function loadCandidates(conn, now) {
  const rows = await conn('invoices as i')
    .leftJoin('service_records as sr', 'sr.id', 'i.service_record_id')
    .joinRaw('JOIN scheduled_services AS s ON s.id = COALESCE(i.scheduled_service_id, sr.scheduled_service_id)')
    .leftJoin('customers as c', 'c.id', 'i.customer_id')
    .where('i.status', 'paid').whereNull('i.receipt_sent_at').whereNull('i.receipt_sms_sent_at').whereNull('i.archived_at')
    .where('i.total', '>', 0)
    .whereNull('i.payer_statement_id').whereNull('i.payer_id')
    .where('i.paid_at', '>=', new Date(now.getTime() - MAX_AGE_MS))
    .where('i.paid_at', '<=', new Date(now.getTime() - MIN_AGE_MS))
    .select('i.id', 'i.customer_id', 'i.invoice_number', 'i.total', 'i.payment_method', 'i.paid_at', 'i.status',
      'i.receipt_sent_at', 'i.receipt_sms_sent_at', 'i.archived_at', 's.scheduled_date', 'c.first_name', 'c.last_name');
  return rows.filter((row) => !settledReason(row) && paidAtVisit(row) && !isInternalTestCustomerId(row.customer_id));
}

// A jsonb leg result (an object from pg, a string from some drivers).
function legOf(value) {
  if (typeof value !== 'string') return value || null;
  try { return JSON.parse(value); } catch { return null; }
}

// { notOwed, unknownOutcome }. notOwed: why no receipt is owed for this invoice, or null when one is. 'in flight' is the
// one passing reason (a job may still deliver); the others are final, and the close pass closes an open bell on them.
// unknownOutcome: an operator send parked for reconciliation (it may have reached the customer). Throws on a failed
// read; the caller fails the row closed.
async function receiptState(conn, row) {
  // One job row per invoice (receipt_delivery_jobs.invoice_id is the enqueue's conflict key).
  const job = await conn('receipt_delivery_jobs').where({ invoice_id: row.id }).first('status', 'sms_result', 'email_result', 'last_error');
  if (job && !DONE_JOB_STATUSES.includes(job.status)) return { notOwed: 'in flight', unknownOutcome: false };
  const sms = legOf(job?.sms_result);
  if (legOf(job?.email_result)?.ok === true || sms?.sent === true) return { notOwed: 'receipt delivered', unknownOutcome: false };
  // The summary text carried the receipt link but was never accepted (an accepted one stamps receipt_sms_sent_at): the
  // queue's own alert covers it when one stands; with none, this bell does.
  if (sms?.reason === TEXT_CARRIED_BY_SUMMARY && (await episodes.openAdminAlertKeys(conn, `${CARRIED_RECEIPT_ALERT_PREFIX}${row.id}`)).length) {
    return { notOwed: 'the visit text alert covers it', unknownOutcome: false };
  }
  const prefs = row.customer_id ? await conn('notification_prefs').where({ customer_id: row.customer_id }).first('payment_receipt') : null;
  if (prefs?.payment_receipt === false) return { notOwed: 'receipts turned off', unknownOutcome: false };
  return { notOwed: null, unknownOutcome: job?.status === 'failed' && job.last_error === RECONCILIATION_HOLD_ERROR };
}

function specFor(row, name, { unknownOutcome = false } = {}) {
  const method = METHOD_WORDS[String(row.payment_method || '').toLowerCase()];
  const paid = `The $${Number(row.total).toFixed(2)} invoice was paid${method ? ` ${method}` : ''} at the ${shortDateET(row.paid_at)} visit`;
  return {
    area: AREA,
    action: unknownOutcome
      ? fitAction(AREA, name, [(who) => `check that ${who} got the receipt`, (who) => `check ${who}'s receipt`])
      : fitAction(AREA, name, [(who) => `send ${who}'s receipt`, (who) => `send ${who} a receipt`]),
    why: unknownOutcome
      ? `${paid}; an earlier receipt send may have gone out.`
      : `${paid}; no receipt has gone out.`,
    severity: 'needs-you',
    link: `/admin/invoices?invoice=${row.id}`,
    subject: { type: 'invoice', id: String(row.id) },
    doneWhen: 'receipt_sent',
    who: 'person',
  };
}

async function raiseBell(row, { unknownOutcome = false } = {}) {
  const name = realName(row) || 'a customer';
  let composed;
  try {
    composed = composeAdminAlert(specFor(row, name, { unknownOutcome }));
  } catch {
    // A name that breaks the alert rules (an emoji, say) becomes "a customer".
    composed = composeAdminAlert(specFor(row, 'a customer', { unknownOutcome }));
  }
  const result = await episodes.raiseAdminAlertWithReopen(CATEGORY, composed.headline, composed.why, {
    dedupeKey: `${KEY_PREFIX}${row.id}`,
    link: composed.link,
    // billing is silenced by default (bell-policy): the explicit tag rings it. customerId sits at the top level for the
    // central test-customer suppression.
    bell: true,
    metadata: { ...composed.metadata, invoiceId: String(row.id), customerId: row.customer_id || null },
  });
  if (!result) throw new Error('paid-visit receipt bell was not written');
  // rang: a new row or a re-ring; a standing row's silent dedupe and a suppressed write count nothing.
  return result.rang === true ? 1 : 0;
}

// Close every open bell whose invoice no longer needs a receipt sent. Returns { closed, failed }.
async function closeSettled(conn, now) {
  const tally = { closed: 0, failed: 0 };
  const keys = await episodes.openAdminAlertKeys(conn, KEY_PREFIX);
  for (const key of keys) {
    try {
      const id = idOf(key);
      const row = UUID_RE.test(id) ? await conn('invoices').where({ id }).first('id', 'customer_id', 'status', 'receipt_sent_at', 'receipt_sms_sent_at', 'archived_at') : null;
      const owed = row && !settledReason(row) ? (await receiptState(conn, row)).notOwed : null;
      const why = settledReason(row) || (owed && owed !== 'in flight' ? owed : null);
      if (why) tally.closed += Number(await episodes.closeAdminAlertKeys(conn, [key], why, { now, resolution: capital(why) })) || 0;
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[paid-visit-receipt-check] close check failed for ${key}: ${errCode(err)}`);
    }
  }
  return tally;
}

/**
 * Cron entry point (hourly at :50, 9 AM to 7 PM ET). Returns { candidates, raised, closed, failed } and throws after
 * finishing when a lookup failed, so runExclusive records it in job_health. `now` and `conn` are for tests.
 */
async function runPaidVisitReceiptCheck({ now = new Date(), conn = db } = {}) {
  const tally = { candidates: 0, raised: 0, closed: 0, failed: 0 };
  if (!alertEpisodesLive()) return { ...tally, skipped: 'episodes_off' };
  const closing = await closeSettled(conn, now);
  tally.closed = closing.closed;
  tally.failed = closing.failed;
  const rows = await loadCandidates(conn, now);
  tally.candidates = rows.length;
  for (const row of rows) {
    try {
      const state = await receiptState(conn, row);
      if (!state.notOwed) tally.raised += await raiseBell(row, state);
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[paid-visit-receipt-check] check failed for invoice ${row.id}: ${errCode(err)}`);
    }
  }
  logger.info(`[paid-visit-receipt-check] ${tally.candidates} paid at the visit with no receipt, ${tally.raised} raised, ${tally.closed} closed, ${tally.failed} failed`);
  if (tally.failed) throw new Error(`${tally.failed} paid-visit receipt check${tally.failed === 1 ? '' : 's'} failed`);
  return tally;
}

module.exports = {
  runPaidVisitReceiptCheck,
  KEY_PREFIX,
  _private: { settledReason, paidAtVisit, specFor, receiptState },
};
