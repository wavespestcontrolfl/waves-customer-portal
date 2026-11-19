'use strict';

// Hourly check: an invoice paid at its visit that still has no receipt after 2 hours (owner 2026-11-18, "the daily
// check"). A customer paid by check at the tech's checkout; the dispatch check and cash tender sheets recorded
// the payment with sendReceipt: false, no receipt went out and nobody noticed until the customer texted. This is the live-data
// check that would have found it without the owner (portal .claude/commands/lesson.md, "Check it on live data").
//
// A hit is an invoice where ALL hold:
//   - status paid, no receipt_sent_at, not archived, total above 0, not a payer statement child (payer_statement_id)
//     and not billed to a third-party payer (payer_id);
//   - it links to a visit (scheduled_service_id) and the ET calendar day of paid_at is that visit's scheduled_date
//     ("paid at the visit": a back-office reconciliation of an old check is skipped);
//   - paid_at is between 7 days and 2 hours ago;
//   - the customer is not an internal test customer and has not turned payment receipts off
//     (notification_prefs.payment_receipt = false);
//   - no receipt_delivery_jobs row for it is still in flight (any status but completed or failed; a failed job with no
//     receipt stamp IS a hit), and its job's Text leg was not carried by the visit summary text (the summary sent the
//     receipt link; the queue rings its own bell when that receipt's email did not go).
//
// ONE Billing bell per invoice (category billing, dedupeKey `paid-visit-no-receipt:<invoice id>`, bell: true because
// billing is silenced by default), raised once per episode (raiseAdminAlertWithReopen: a standing row is a silent
// dedupe, a person's Done stays done). Each run first closes every open bell whose invoice now has a receipt stamp, is
// no longer paid, is archived or is gone. A lookup that throws fails CLOSED for that row (no raise, no close) and the
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
const { TEXT_CARRIED_BY_SUMMARY } = require('./receipt-delivery-queue');
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
  if (row.receipt_sent_at) return 'receipt sent';
  if (String(row.status || '').toLowerCase() !== 'paid') return `invoice ${String(row.status || 'changed').toLowerCase()}`;
  if (row.archived_at) return 'invoice archived';
  return null;
}

// Paid invoices that look like a hit before the per-row lookups: the SQL holds every fixed rule, paidAtVisit the
// calendar-day one (an ET day, never a fixed offset).
async function loadCandidates(conn, now) {
  const rows = await conn('invoices as i')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .leftJoin('customers as c', 'c.id', 'i.customer_id')
    .where('i.status', 'paid').whereNull('i.receipt_sent_at').whereNull('i.archived_at')
    .where('i.total', '>', 0)
    .whereNull('i.payer_statement_id').whereNull('i.payer_id')
    .where('i.paid_at', '>=', new Date(now.getTime() - MAX_AGE_MS))
    .where('i.paid_at', '<=', new Date(now.getTime() - MIN_AGE_MS))
    .select('i.id', 'i.customer_id', 'i.invoice_number', 'i.total', 'i.payment_method', 'i.paid_at', 'i.status',
      'i.receipt_sent_at', 'i.archived_at', 's.scheduled_date', 'c.first_name', 'c.last_name');
  return rows.filter((row) => !settledReason(row) && paidAtVisit(row) && !isInternalTestCustomerId(row.customer_id));
}

// The job's Text-leg reason; sms_result is jsonb (an object from pg, a string from some drivers).
function smsReasonOf(job) {
  let sms = job?.sms_result;
  if (typeof sms === 'string') { try { sms = JSON.parse(sms); } catch { sms = null; } }
  return sms?.reason || null;
}

// True while a receipt may still go out by itself (a job in flight), when the visit summary text carried it, or when the
// customer turned receipts off. Throws on a failed read; the caller fails the row closed.
async function receiptNotOwed(conn, row) {
  // One job row per invoice (receipt_delivery_jobs.invoice_id is the enqueue's conflict key).
  const job = await conn('receipt_delivery_jobs').where({ invoice_id: row.id }).first('status', 'sms_result');
  if (job && !DONE_JOB_STATUSES.includes(job.status)) return true;
  if (smsReasonOf(job) === TEXT_CARRIED_BY_SUMMARY) return true;
  const prefs = row.customer_id ? await conn('notification_prefs').where({ customer_id: row.customer_id }).first('payment_receipt') : null;
  return prefs?.payment_receipt === false;
}

function specFor(row, name) {
  const method = METHOD_WORDS[String(row.payment_method || '').toLowerCase()];
  const amount = `$${Number(row.total).toFixed(2)}`;
  return {
    area: AREA,
    action: fitAction(AREA, name, [(who) => `send ${who}'s receipt`, (who) => `send ${who} a receipt`]),
    why: `Paid ${amount}${method ? ` ${method}` : ''} at the ${shortDateET(row.paid_at)} visit; no receipt has gone out.`,
    severity: 'needs-you',
    link: `/admin/invoices?invoice=${row.id}`,
    subject: { type: 'invoice', id: String(row.id) },
    doneWhen: 'receipt_sent',
    who: 'person',
  };
}

async function raiseBell(row) {
  const name = realName(row) || 'a customer';
  let composed;
  try {
    composed = composeAdminAlert(specFor(row, name));
  } catch {
    // A name that breaks the alert rules (an emoji, say) becomes "a customer".
    composed = composeAdminAlert(specFor(row, 'a customer'));
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
  return result.suppressed ? 0 : 1;
}

// Close every open bell whose invoice no longer needs a receipt sent. Returns { closed, failed }.
async function closeSettled(conn, now) {
  const tally = { closed: 0, failed: 0 };
  const keys = await episodes.openAdminAlertKeys(conn, KEY_PREFIX);
  for (const key of keys) {
    try {
      const id = idOf(key);
      const row = UUID_RE.test(id) ? await conn('invoices').where({ id }).first('id', 'status', 'receipt_sent_at', 'archived_at') : null;
      const why = settledReason(row);
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
      if (!(await receiptNotOwed(conn, row))) tally.raised += await raiseBell(row);
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
  _private: { settledReason, paidAtVisit, specFor, receiptNotOwed },
};
