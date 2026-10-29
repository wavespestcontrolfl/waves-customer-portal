/**
 * Office bell before a prepaid year ends (GATE_PREPAY_YEAR_END_BELL, ships dark).
 *
 * An annual prepay customer paid for 12 months. When the year ends, nothing
 * charges them again: the nightly booking stops (or bills the visit price) and
 * nobody has asked the customer for next year's prepay. This daily job posts ONE
 * office bell per prepaid year, from 30 days before the year ends until 60 days
 * after, so a person sends next year's prepay invoice in time.
 *
 * Owner rulings that bind the text:
 *   - The word "renewal" is reserved for termite bonds (owner 2026-07-13). The bell
 *     says "prepaid year" and "next year's prepay".
 *   - Next year's prepay price = visits x visit price, minus 5% for paying the year
 *     up front (owner 2026-10-26). The bell states the rule; code computes no amount.
 *
 * It sends nothing to a customer and charges nothing. Termite annual plans
 * (annual_plan_version set) are out of scope: they have their own notice flow.
 *
 * A year is SETTLED, so its bell closes and is never raised, when any of these hold:
 *   a. the customer has a LATER term that is paid and live (coveredTermsAsOf);
 *   b. the term's decision is cancel or switch plan, or its status says so;
 *   c. the customer's billing mode is no longer annual_prepay;
 *   d. the customer is deleted.
 * A "renew" decision alone does not settle it (the new term must be paid), and time
 * passing never closes a bell. Every bell still open is judged on every run, at any
 * age, so a year settled long after it ended still closes; a bell whose year changed
 * (the term is gone or its end date moved) closes, and a moved year gets its own bell.
 */
const db = require('../models/db');
const logger = require('./logger');
const { raiseAdminAlert } = require('./admin-alert-compose');
// Through the module object, so a unit test can stand its SQL in.
const AlertEpisodes = require('./admin-alert-episodes');
const { fitAction, fullName, shortDateET, tidyName } = require('./admin-alert-names');
const { etDateString } = require('../utils/datetime-et');

const LOG = '[prepay-year-end-bell]';
// The bell shows from this many days before the year ends ...
const TERM_END_LEAD_DAYS = 30;
// ... until this many days after (a late raise still helps: the year just ended).
const LATE_RAISE_DAYS = 60;
const KEY_PREFIX = 'prepay-year-end:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAISE_STATUSES = Object.freeze(['active', 'renewal_pending', 'renewed']);
const DECLINED_STATUSES = Object.freeze(['cancelled', 'canceled', 'switch_plan']);
const DECLINED_DECISIONS = Object.freeze(['cancel', 'switch_plan']);
const SKIPPED_VISIT_STATUSES = Object.freeze(['cancelled', 'skipped']);
const UNVERIFIED_CODE = 'RECURRING_BILLING_UNVERIFIED';
const DONE_WHEN = 'prepay_year_settled';

const STOPS = 'the plan stops booking';
const CHECK_PRICE = "check the plan's visit price";

function alertKey(termId, termEnd) {
  return `${KEY_PREFIX}${termId}:${termEnd}`;
}

// The term id inside an open bell's key, or null when the key is not one of ours.
function termIdOfKey(key) {
  const id = String(key || '').slice(KEY_PREFIX.length).split(':')[0];
  return String(key || '').startsWith(KEY_PREFIX) && UUID_RE.test(id) ? id : null;
}

const usd = (value) => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const dayDate = (day) => new Date(`${day}T12:00:00Z`);

function longDateET(day) {
  const at = dayDate(day);
  return Number.isNaN(at.getTime())
    ? String(day)
    : at.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
}

// The distinct series roots of the visits stamped to this term that are still on the calendar,
// narrowed to the ones that keep booking on their own (recurring_ongoing).
async function ongoingRoots(conn, termId) {
  const rows = await conn('scheduled_services as s')
    .where('s.annual_prepay_term_id', termId)
    .whereNotIn('s.status', SKIPPED_VISIT_STATUSES)
    .select(conn.raw('distinct coalesce(s.recurring_parent_id, s.id) as root_id'));
  const ids = rows.map((row) => row.root_id).filter(Boolean);
  if (!ids.length) return [];
  const ongoing = await conn('scheduled_services').whereIn('id', ids).where('recurring_ongoing', true).select('id');
  return ongoing.map((row) => row.id);
}

// What the nightly booking does once the year ends, in words a person can act on.
// Roots that fail the billing check stop booking; the rest bill their next visit's price.
// Anything the helpers cannot answer reads as "check the plan's visit price".
async function consequenceFor(conn, termId) {
  const roots = await ongoingRoots(conn, termId);
  if (!roots.length) return STOPS;
  const { seriesNextOccurrencesUnbillable, seriesNextOccurrencesPrice } = require('../routes/admin-schedule');
  let highest = null;
  for (const rootId of roots) {
    const verdict = await seriesNextOccurrencesUnbillable(conn, rootId);
    // The walk that could not finish comes back as a verdict too: it is unknown, not "stops".
    if (verdict && verdict.code === UNVERIFIED_CODE) return CHECK_PRICE;
    if (verdict) continue;
    const priced = await seriesNextOccurrencesPrice(conn, rootId);
    if (!priced || priced.unverified) return CHECK_PRICE;
    const price = Number(priced.price);
    if (!Number.isFinite(price) || price <= 0) return CHECK_PRICE;
    if (highest === null || price > highest) highest = price;
  }
  return highest === null ? STOPS : `the next visit bills ${usd(highest)}`;
}

function customerName(row) {
  return fullName(row) || tidyName(row.company_name) || 'the customer';
}

function alertSpec(row, consequence) {
  const due = shortDateET(dayDate(row.term_end));
  return {
    area: 'Billing',
    action: fitAction('Billing', customerName(row), [(n) => `send ${n} next year's prepay`, (n) => `send ${n} a prepay invoice`]),
    why: `Prepaid year ends ${due}; if nobody acts, ${consequence}.`,
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(row.customer_id)}`,
    subject: { type: 'customer', id: String(row.customer_id) },
    // Closes itself once next year is paid, the customer chose another plan, or the account ended.
    doneWhen: DONE_WHEN,
    who: 'person',
  };
}

function alertDetail(row) {
  const thisYear = row.prepay_amount != null && row.prepay_amount !== ''
    ? ` This year: ${usd(row.prepay_amount)}, ${longDateET(row.term_start)} to ${longDateET(row.term_end)}.`
    : ` This year: ${longDateET(row.term_start)} to ${longDateET(row.term_end)}.`;
  return "Next year's prepay = visits x visit price - 5% (e.g. $117 x 4 = $468 - 5% = $444.60). "
    + 'Send it from Customer 360 > Send annual prepay invoice. '
    + `If the customer declines, set billing to per application and check the plan's visit price.${thisYear}`;
}

// Why this year is settled, or null while it still needs a person.
function settledReason(row, laterPaidTerm) {
  if (row.customer_deleted_at) return 'customer_deleted';
  if (row.billing_mode !== 'annual_prepay') return 'billing_mode_changed';
  if (DECLINED_DECISIONS.includes(row.renewal_decision) || DECLINED_STATUSES.includes(row.status)) return 'declined';
  if (laterPaidTerm) return 'next_year_paid';
  return null;
}

function inRaiseWindow(row, today) {
  const toEnd = Math.round((Date.parse(`${row.term_end}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  return toEnd <= TERM_END_LEAD_DAYS && toEnd >= -LATE_RAISE_DAYS;
}

// The years inside the raise window, plus every year that still has an open bell.
async function candidateTerms(conn, today, openTermIds = []) {
  return conn('annual_prepay_terms as t')
    .join('customers as c', 'c.id', 't.customer_id')
    .whereNull('t.annual_plan_version')
    .where((scope) => {
      scope.whereRaw('t.term_end between ?::date - ?::int and ?::date + ?::int', [today, LATE_RAISE_DAYS, today, TERM_END_LEAD_DAYS]);
      if (openTermIds.length) scope.orWhereIn('t.id', openTermIds);
    })
    .select(
      't.id', 't.customer_id', 't.status', 't.renewal_decision', 't.prepay_amount',
      conn.raw("to_char(t.term_start, 'YYYY-MM-DD') as term_start"),
      conn.raw("to_char(t.term_end, 'YYYY-MM-DD') as term_end"),
      'c.first_name', 'c.last_name', 'c.company_name', 'c.billing_mode', 'c.deleted_at as customer_deleted_at',
    );
}

// Later terms that are paid and live, per customer, from the same query the completion gate and
// the term sweep share. An unpaid next-year term is not in it.
async function paidTermsByCustomer(conn, customerIds) {
  if (!customerIds.length) return new Map();
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  const rows = await AnnualPrepayRenewals.coveredTermsAsOf(conn, null)
    .whereIn('t.customer_id', customerIds)
    .select('t.id', 't.customer_id', conn.raw("to_char(t.term_start, 'YYYY-MM-DD') as term_start"));
  const byCustomer = new Map();
  for (const row of rows) {
    const list = byCustomer.get(row.customer_id) || [];
    list.push(row);
    byCustomer.set(row.customer_id, list);
  }
  return byCustomer;
}

const hasLaterPaidTerm = (row, byCustomer) => (byCustomer.get(row.customer_id) || [])
  .some((later) => later.id !== row.id && later.term_start > row.term_start);

async function raiseOne(conn, row) {
  const consequence = await consequenceFor(conn, row.id).catch((err) => {
    logger.warn(`${LOG} term ${row.id}: the visit price check failed: ${err.message}`);
    return CHECK_PRICE;
  });
  const posted = await raiseAdminAlert('billing', alertSpec(row, consequence), {
    bell: true,
    detail: alertDetail(row),
    dedupeKey: alertKey(row.id, row.term_end),
    metadata: { customerId: row.customer_id, termId: row.id, termEnd: row.term_end },
  });
  return Boolean(posted?.id && !posted.deduped);
}

async function runPrepayYearEndBell({ conn = db, today = etDateString() } = {}) {
  if (!require('../config/feature-gates').prepayYearEndBellLive()) return { raised: 0, closed: 0 };
  const openKeys = await AlertEpisodes.openAdminAlertKeys(conn, KEY_PREFIX);
  const rows = await candidateTerms(conn, today, [...new Set(openKeys.map(termIdOfKey).filter(Boolean))]);
  if (!rows.length && !openKeys.length) return { raised: 0, closed: 0 };
  const byCustomer = await paidTermsByCustomer(conn, [...new Set(rows.map((row) => row.customer_id))]);

  const currentKeys = new Set();
  const settledKeys = [];
  const open = [];
  for (const row of rows) {
    const key = alertKey(row.id, row.term_end);
    currentKeys.add(key);
    if (settledReason(row, hasLaterPaidTerm(row, byCustomer))) settledKeys.push(key);
    else if (RAISE_STATUSES.includes(row.status) && inRaiseWindow(row, today)) open.push(row);
  }
  // An open bell whose year is no longer keyed that way: the term is gone, became a termite plan, or its
  // end date moved (the moved year is raised under its new key above).
  const staleKeys = openKeys.filter((key) => !currentKeys.has(key));

  const closed = (settledKeys.length
    ? await AlertEpisodes.closeAdminAlertKeys(conn, settledKeys, DONE_WHEN, {
      resolution: "The prepaid year is settled: next year's prepay is paid, or the customer chose another plan.",
    })
    : 0) + (staleKeys.length
    ? await AlertEpisodes.closeAdminAlertKeys(conn, staleKeys, 'prepay_year_changed', {
      resolution: 'This prepaid year changed or no longer exists; a moved year end gets its own bell.',
    })
    : 0);

  let raised = 0;
  for (const row of open) {
    try {
      if (await raiseOne(conn, row)) raised += 1;
    } catch (err) {
      logger.warn(`${LOG} term ${row.id} failed: ${err.message}`);
    }
  }
  return { raised, closed };
}

module.exports = {
  runPrepayYearEndBell,
  _private: {
    alertKey, termIdOfKey, alertSpec, alertDetail, consequenceFor, ongoingRoots, settledReason, inRaiseWindow, hasLaterPaidTerm,
    STOPS, CHECK_PRICE, TERM_END_LEAD_DAYS, LATE_RAISE_DAYS,
  },
};
