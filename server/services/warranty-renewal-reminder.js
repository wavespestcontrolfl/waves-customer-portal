/**
 * Office reminder before a new construction termite warranty renews
 * (GATE_WARRANTY_RENEWAL_REMINDER, owner 10-23 option A on #6515).
 *
 * The signed warranty says "We send a renewal notice about 30 days before."
 * Nothing tracked that date, so this daily job:
 *   1. fills customer_contracts.renewal_date (and auto_renewal_notice_required)
 *      on each signed warranty from its signed text ("The first renewal is due
 *      on MM/DD/YYYY");
 *   2. moves a renewal date that has passed to the same date next year (later
 *      renewals fall on the same date each year) and clears its "notice sent";
 *   3. posts ONE admin notification per warranty per renewal, 45 days before;
 *   4. closes that notification once staff mark the notice sent (the existing
 *      Customer 360 "Notice" button) or the warranty is cancelled.
 * It sends nothing to a customer and charges nothing. A cancelled warranty
 * stops it. Off: the job returns before any query.
 */
const db = require('../models/db');
const logger = require('./logger');
const { raiseAdminAlert } = require('./admin-alert-compose');
const { closeAdminAlertKeys } = require('./admin-alert-episodes');
const { fitAction, fullName, shortDateET } = require('./admin-alert-names');
const { etDateString } = require('../utils/datetime-et');
const { warrantyRenewalReminderLive } = require('../config/feature-gates');
const { NEW_CONSTRUCTION_WARRANTY_KEY } = require('./new-construction-warranty');

const LOG = '[warranty-renewal-reminder]';
const NOTICE_LEAD_DAYS = 45;

function alertKey(contractId, renewalDay) {
  return `warranty-renewal:${contractId}:${renewalDay}`;
}

// "10/01/2027" from the signed snapshot → "2027-10-01", or null.
function isoFromUs(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[1]}-${match[2]}`;
  const check = new Date(`${iso}T12:00:00Z`);
  return check.toISOString().slice(0, 10) === iso ? iso : null;
}

function snapshotOf(row) {
  const raw = row.document_variables_snapshot;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

function signedWarranties(conn) {
  return conn('customer_contracts').where({ document_template_key: NEW_CONSTRUCTION_WARRANTY_KEY, status: 'signed' });
}

async function fillRenewalDates(conn) {
  const rows = await signedWarranties(conn).whereNull('renewal_date').select('id', 'document_variables_snapshot');
  let filled = 0;
  for (const row of rows) {
    const day = isoFromUs(snapshotOf(row).warranty?.renewal_due);
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
async function rollPastRenewals(conn, today) {
  // One transaction: the rows are locked, moved and their old reminders
  // closed together, so a failure leaves neither a moved date with an open
  // reminder nor a closed reminder on an unmoved date.
  return conn.transaction(async (trx) => {
    const rows = await signedWarranties(trx).where('renewal_date', '<', today).forUpdate()
      .select('id', trx.raw("to_char(renewal_date, 'YYYY-MM-DD') as day"));
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
    await closeAdminAlertKeys(trx, rows.map((row) => alertKey(row.id, row.day)), 'renewal_date_passed', {
      resolution: 'The renewal date passed; next year\'s reminder starts on its own.',
    });
    return rows.length;
  });
}

function alertSpec(row) {
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
}

async function raiseDueReminders(conn, today) {
  const rows = await conn('customer_contracts as cc')
    .join('customers as c', 'c.id', 'cc.customer_id')
    .where('cc.document_template_key', NEW_CONSTRUCTION_WARRANTY_KEY)
    .where('cc.status', 'signed')
    .where('cc.auto_renewal_notice_required', true)
    .whereNull('cc.auto_renewal_notice_sent_at')
    .whereNull('c.deleted_at')
    .whereRaw('cc.renewal_date between ?::date and ?::date + ?::int', [today, today, NOTICE_LEAD_DAYS])
    .select('cc.id', 'cc.customer_id', conn.raw("to_char(cc.renewal_date, 'YYYY-MM-DD') as day"), 'c.first_name', 'c.last_name', 'c.company_name');
  let raised = 0;
  for (const row of rows) {
    const posted = await raiseAdminAlert('customer', alertSpec(row), {
      bell: true,
      dedupeKey: alertKey(row.id, row.day),
      metadata: { customerId: row.customer_id, contractId: row.id, renewalDate: row.day },
    });
    if (posted?.id && !posted.deduped) raised += 1;
  }
  return raised;
}

// Notice marked sent (this renewal), or the warranty cancelled or voided (any
// date: an ended warranty is never rolled forward): its reminder closes.
async function closeSentReminders(conn, today) {
  const rows = await conn('customer_contracts')
    .where({ document_template_key: NEW_CONSTRUCTION_WARRANTY_KEY })
    .whereNotNull('renewal_date')
    .where((builder) => builder
      .whereNot('status', 'signed')
      .orWhere((sent) => sent.whereNotNull('auto_renewal_notice_sent_at')
        .whereRaw('renewal_date between ?::date and ?::date + ?::int', [today, today, NOTICE_LEAD_DAYS])))
    .select('id', 'status', conn.raw("to_char(renewal_date, 'YYYY-MM-DD') as day"));
  if (!rows.length) return 0;
  return closeAdminAlertKeys(conn, rows.map((row) => alertKey(row.id, row.day)), 'renewal_notice_sent', {
    resolution: 'Renewal notice marked sent, or the warranty ended.',
  });
}

async function runWarrantyRenewalReminder({ conn = db, today = etDateString() } = {}) {
  if (!warrantyRenewalReminderLive()) return { skipped: 'gated' };
  const filled = await fillRenewalDates(conn);
  const rolled = await rollPastRenewals(conn, today);
  const closed = await closeSentReminders(conn, today);
  const raised = await raiseDueReminders(conn, today);
  return { filled, rolled, closed, raised };
}

module.exports = { runWarrantyRenewalReminder, _private: { alertKey, alertSpec, isoFromUs, NOTICE_LEAD_DAYS } };
