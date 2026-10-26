/**
 * Office reminder before a signed agreement renews.
 *
 * New construction termite warranty (owner 10-23 option A on #6515): the
 * signed warranty says "We send a renewal notice about 30 days before."
 * Nothing tracked that date, so this daily job:
 *   1. fills customer_contracts.renewal_date (and auto_renewal_notice_required)
 *      on each signed warranty from its signed text ("The first renewal is due
 *      on MM/DD/YYYY");
 *   2. moves a renewal date that has passed to the same date next year (later
 *      renewals fall on the same date each year) and clears its "notice sent";
 *   3. posts ONE admin notification per warranty per renewal, 45 days before;
 *   4. closes that notification once staff mark the notice sent (the existing
 *      Customer 360 "Notice" button) or the warranty is cancelled.
 *
 * Commercial Pest Service Agreement (GATE_AGREEMENT_RENEWAL_REMINDER): the
 * same four steps for every signed commercial agreement, whose template fixes
 * a 12-month term that renews for 12-month terms unless either party gives
 * written notice at least 30 days before the term ends. Its renewal date is
 * the term anchor (the customer's first visit on or after signing, else the
 * signing date) plus 12 months. Dark = warranties only, as before.
 *
 * It sends nothing to a customer and charges nothing. A cancelled agreement
 * stops it.
 */
const db = require('../models/db');
const logger = require('./logger');
const { raiseAdminAlert } = require('./admin-alert-compose');
const { closeAdminAlertKeys } = require('./admin-alert-episodes');
const { fitAction, fullName, shortDateET, tidyName } = require('./admin-alert-names');
const { etDateString } = require('../utils/datetime-et');
const { NEW_CONSTRUCTION_WARRANTY_KEY } = require('./new-construction-warranty');

const LOG = '[warranty-renewal-reminder]';
const NOTICE_LEAD_DAYS = 45;
const COMMERCIAL_AGREEMENT_KEY = 'service_agreement.commercial_pest';
const COMMERCIAL_TERM_MONTHS = 12;

// One entry per agreement kind this job tracks. `alertPrefix` keys the bell (the warranty prefix is
// unchanged so open warranty reminders keep closing); `renewalDate(conn, row)` reads the first renewal
// date ('YYYY-MM-DD') for a signed row that has none, null when it cannot; `spec(row)` is the bell.
const KINDS = Object.freeze({
  [NEW_CONSTRUCTION_WARRANTY_KEY]: Object.freeze({
    alertPrefix: 'warranty-renewal',
    live: () => true,
    renewalDate: async (_conn, row) => isoFromUs(snapshotOf(row).warranty?.renewal_due),
    spec: (row) => {
      const name = fullName(row) || 'the owner';
      const due = shortDateET(new Date(`${row.day}T12:00:00Z`));
      return {
        area: 'Customers',
        action: fitAction('Customers', name, [(n) => `send ${n} the termite renewal notice`, (n) => `send ${n} a renewal notice`]),
        why: `New construction warranty renews ${due}; it promises a notice about 30 days before.`,
        severity: 'needs-you',
        link: `/admin/customers?customerId=${encodeURIComponent(row.customer_id)}`,
        subject: { type: 'customer', id: String(row.customer_id) },
        // Closes itself once the contract's notice is marked sent (Customer 360 "Notice"), or the warranty ends.
        doneWhen: 'renewal_notice_sent',
        who: 'person',
      };
    },
  }),
  [COMMERCIAL_AGREEMENT_KEY]: Object.freeze({
    alertPrefix: 'agreement-renewal',
    live: () => require('../config/feature-gates').agreementRenewalReminderLive(),
    renewalDate: commercialRenewalDate,
    spec: (row) => {
      // A commercial account is often a business with no first/last name on the row.
      const name = fullName(row) || tidyName(row.company_name) || 'the customer';
      const due = shortDateET(new Date(`${row.day}T12:00:00Z`));
      return {
        area: 'Customers',
        action: fitAction('Customers', name, [(n) => `send ${n} the agreement renewal notice`, (n) => `send ${n} a renewal notice`]),
        why: `Commercial agreement renews ${due}; written non-renewal notice is due 30 days before.`,
        severity: 'needs-you',
        link: `/admin/customers?customerId=${encodeURIComponent(row.customer_id)}`,
        subject: { type: 'customer', id: String(row.customer_id) },
        doneWhen: 'renewal_notice_sent',
        who: 'person',
      };
    },
  }),
});

function liveKeys() {
  return Object.keys(KINDS).filter((key) => KINDS[key].live());
}

function alertKey(contractId, renewalDay, templateKey = NEW_CONSTRUCTION_WARRANTY_KEY) {
  return `${(KINDS[templateKey] || KINDS[NEW_CONSTRUCTION_WARRANTY_KEY]).alertPrefix}:${contractId}:${renewalDay}`;
}

// "10/01/2027" from the signed snapshot → "2027-10-01", or null.
function isoFromUs(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[1]}-${match[2]}`;
  const check = new Date(`${iso}T12:00:00Z`);
  // Month 13 is an Invalid Date, which toISOString would throw on.
  return !Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === iso ? iso : null;
}

function snapshotOf(row) {
  const raw = row.document_variables_snapshot;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

// 'YYYY-MM-DD' in Eastern time for a timestamp or a date-only value.
function etDay(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : etDateString(date);
}

// The commercial term anchor plus 12 months. The agreement's printed start date is "Set when we schedule your first
// visit", so the anchor is the customer's first scheduled visit (not cancelled, not a slot hold) on or after the signing
// day; a customer with no visit yet anchors on the signing day. Month arithmetic in SQL keeps Jan 31 + 12 months a date.
async function commercialRenewalDate(conn, row) {
  const signedDay = etDay(row.signed_at);
  if (!signedDay) return null;
  const visit = await conn('scheduled_services')
    .where({ customer_id: row.customer_id })
    .whereNotNull('customer_id')
    .whereNotIn('status', ['cancelled', 'canceled', 'rescheduled'])
    .where('scheduled_date', '>=', signedDay)
    .orderBy('scheduled_date', 'asc')
    .first(conn.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));
  const anchor = visit?.day || signedDay;
  const [{ day }] = await conn.select(conn.raw("to_char((?::date + make_interval(months => ?))::date, 'YYYY-MM-DD') as day", [anchor, COMMERCIAL_TERM_MONTHS]));
  return day;
}

function signedOfKinds(conn, keys) {
  return conn('customer_contracts').whereIn('document_template_key', keys).where({ status: 'signed' });
}

async function fillRenewalDates(conn, keys) {
  const rows = await signedOfKinds(conn, keys).whereNull('renewal_date')
    .select('id', 'customer_id', 'document_template_key', 'signed_at', 'document_variables_snapshot');
  let filled = 0;
  for (const row of rows) {
    const day = await KINDS[row.document_template_key].renewalDate(conn, row);
    if (!day) {
      logger.warn(`${LOG} contract ${row.id} has no readable renewal date`);
      continue;
    }
    filled += await conn('customer_contracts').where({ id: row.id }).whereNull('renewal_date')
      .update({ renewal_date: day, auto_renewal_notice_required: true, updated_at: conn.fn.now() });
  }
  return filled;
}

// A renewal date before today moves to its next anniversary on or after
// today; its open reminder closes and the next year's starts fresh.
async function rollPastRenewals(conn, today, keys) {
  // One transaction: the rows are locked, moved and their old reminders
  // closed together, so a failure leaves neither a moved date with an open
  // reminder nor a closed reminder on an unmoved date.
  return conn.transaction(async (trx) => {
    const rows = await signedOfKinds(trx, keys).where('renewal_date', '<', today).forUpdate()
      .select('id', 'document_template_key', trx.raw("to_char(renewal_date, 'YYYY-MM-DD') as day"));
    if (!rows.length) return 0;
    await trx('customer_contracts').whereIn('id', rows.map((row) => row.id)).update({
      // Whole years since the date, plus one only when that anniversary is
      // still before today: an anniversary that falls today is kept.
      renewal_date: trx.raw(`(renewal_date + make_interval(years => date_part('year', age(?::date, renewal_date))::int
        + CASE WHEN (renewal_date + make_interval(years => date_part('year', age(?::date, renewal_date))::int))::date >= ?::date THEN 0 ELSE 1 END))::date`,
      [today, today, today]),
      auto_renewal_notice_sent_at: null,
      updated_at: trx.fn.now(),
    });
    await closeAdminAlertKeys(trx, rows.map((row) => alertKey(row.id, row.day, row.document_template_key)), 'renewal_date_passed', {
      resolution: 'The renewal date passed; next year\'s reminder starts on its own.',
    });
    return rows.length;
  });
}

function alertSpec(row) {
  return (KINDS[row.document_template_key] || KINDS[NEW_CONSTRUCTION_WARRANTY_KEY]).spec(row);
}

async function raiseDueReminders(conn, today, keys) {
  const rows = await conn('customer_contracts as cc')
    .join('customers as c', 'c.id', 'cc.customer_id')
    .whereIn('cc.document_template_key', keys)
    .where('cc.status', 'signed')
    .where('cc.auto_renewal_notice_required', true)
    .whereNull('cc.auto_renewal_notice_sent_at')
    .whereNull('c.deleted_at')
    .whereRaw('cc.renewal_date between ?::date and ?::date + ?::int', [today, today, NOTICE_LEAD_DAYS])
    .select('cc.id', 'cc.customer_id', 'cc.document_template_key', conn.raw("to_char(cc.renewal_date, 'YYYY-MM-DD') as day"), 'c.first_name', 'c.last_name', 'c.company_name');
  let raised = 0;
  for (const row of rows) {
    const posted = await raiseAdminAlert('customer', alertSpec(row), {
      bell: true,
      dedupeKey: alertKey(row.id, row.day, row.document_template_key),
      metadata: { customerId: row.customer_id, contractId: row.id, renewalDate: row.day, templateKey: row.document_template_key },
    });
    if (posted?.id && !posted.deduped) raised += 1;
  }
  return raised;
}

// Notice marked sent (this renewal), or the agreement cancelled or voided (any
// date: an ended agreement is never rolled forward): its reminder closes.
async function closeSentReminders(conn, today, keys) {
  const rows = await conn('customer_contracts')
    .whereIn('document_template_key', keys)
    .whereNotNull('renewal_date')
    .where((builder) => builder
      .whereNot('status', 'signed')
      .orWhere((sent) => sent.whereNotNull('auto_renewal_notice_sent_at')
        .whereRaw('renewal_date between ?::date and ?::date + ?::int', [today, today, NOTICE_LEAD_DAYS])))
    .select('id', 'status', 'document_template_key', conn.raw("to_char(renewal_date, 'YYYY-MM-DD') as day"));
  if (!rows.length) return 0;
  return closeAdminAlertKeys(conn, rows.map((row) => alertKey(row.id, row.day, row.document_template_key)), 'renewal_notice_sent', {
    resolution: 'Renewal notice marked sent, or the agreement ended.',
  });
}

async function runWarrantyRenewalReminder({ conn = db, today = etDateString() } = {}) {
  const keys = liveKeys();
  const filled = await fillRenewalDates(conn, keys);
  const rolled = await rollPastRenewals(conn, today, keys);
  const closed = await closeSentReminders(conn, today, keys);
  const raised = await raiseDueReminders(conn, today, keys);
  return { filled, rolled, closed, raised };
}

module.exports = {
  runWarrantyRenewalReminder,
  COMMERCIAL_AGREEMENT_KEY,
  _private: { alertKey, alertSpec, isoFromUs, commercialRenewalDate, liveKeys, NOTICE_LEAD_DAYS, COMMERCIAL_TERM_MONTHS },
};
