/**
 * Admin bells for Mercury paychecks (owner plan A, 2026-10-30), raised through raiseAdminAlert
 * (docs/admin-notifications.md) in category `payroll` with `bellDefault: true`: they ring unless the owner turned the
 * category off in Settings. One bell per payment and event (dedupeKey payroll-pay:<payment id>:<event>), who: person.
 * A payment bell closes when the payment is settled or a new attempt starts (closePaymentBells). Sends nothing to a
 * customer or staff member. A bell never blocks payroll: every function here swallows its own error.
 */
const db = require('../models/db');
const logger = require('./logger');
const { fitAction, shortDateET } = require('./admin-alert-names');

const CATEGORY = 'payroll';
const KEY_PREFIX = 'payroll-pay:';
// Two key bells: a refused READ (closed by the next good read) and a refused SEND request (a read proves nothing about
// the Send Money with Approval permission, so it closes only when a request is accepted).
const KEY_KEYS = { read: 'payroll-mercury-key', send: 'payroll-mercury-key-send' };
const LINK = '/admin/timetracking?tab=payroll';

const money = (cents) => `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// event -> { action templates (each takes the name), why(payment, ctx) }. Every why is one sentence of at most 110 characters.
const EVENTS = {
  failed: {
    action: [(n) => `check why ${n}'s pay did not go out`, (n) => `check ${n}'s failed pay`],
    why: (p) => `Mercury did not take the ${money(p.amountCents)} payment, so nothing was sent.`,
    doneWhen: 'payment_settled',
  },
  rejected: {
    action: [(n) => `send ${n}'s rejected pay again`, (n) => `redo ${n}'s pay`],
    why: (p) => `The ${money(p.amountCents)} request was rejected in Mercury; send it again when ready.`,
    doneWhen: 'payment_settled',
  },
  cancelled: {
    action: [(n) => `send ${n}'s cancelled pay again`, (n) => `redo ${n}'s pay`],
    why: (p) => `The ${money(p.amountCents)} request was cancelled in Mercury; send it again when ready.`,
    doneWhen: 'payment_settled',
  },
  returned: {
    action: [(n) => `get ${n}'s returned pay paid again`, (n) => `redo ${n}'s pay`],
    why: (p) => `The ${money(p.amountCents)} bank transfer came back; wages and taxes stay as filed.`,
    doneWhen: 'payment_settled',
  },
  unknown: {
    action: [(n) => `check Mercury for ${n}'s pay`, (n) => `check ${n}'s pay`],
    why: (p) => `We cannot tell if the ${money(p.amountCents)} request reached Mercury; it is not sent again by itself.`,
    doneWhen: 'payment_settled',
  },
  probably_ours: {
    action: [(n) => `check Mercury for ${n}'s pay`, (n) => `check ${n}'s pay`],
    why: (p) => `Mercury has a ${money(p.amountCents)} request to this person that is probably ours; check it.`,
    doneWhen: 'payment_settled',
  },
  account_changed: {
    action: [(n) => `check Mercury for ${n}'s pay`, (n) => `check ${n}'s pay`],
    why: (p) => `The Mercury account changed, so the ${money(p.amountCents)} payment is no longer read; check the old account.`,
    doneWhen: 'payment_settled',
  },
  pending_noon: {
    action: [(n) => `approve ${n}'s pay in Mercury`, (n) => `approve ${n}'s pay`],
    why: (p) => `The ${money(p.amountCents)} request still waits for approval and the next business day is pay day.`,
    doneWhen: 'payment_approved',
  },
  month_mismatch: {
    action: [(n) => `tell Claude ${n}'s pay posted in a new month`, (n) => `tell Claude ${n}'s pay month is off`],
    why: (p, ctx) => `It posted ${shortDateET(`${p.postedOn}T12:00:00Z`)} but the pay date was ${shortDateET(`${ctx.payDate}T12:00:00Z`)}; the tax figures need a fix.`,
    doneWhen: 'payment_settled',
    who: 'either',
  },
};

function specFor(event, payment, ctx) {
  const def = EVENTS[event];
  return {
    area: 'Billing',
    action: fitAction('Billing', ctx.name || 'employee', def.action),
    why: def.why(payment, ctx),
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: payment.id },
    doneWhen: def.doneWhen,
    who: def.who || 'person',
  };
}

async function contextOf(conn, payment) {
  const row = await conn('payroll_checks').where({ id: payment.check_id }).first('employee_name', conn.raw("to_char(pay_date, 'YYYY-MM-DD') as pay_date"));
  return { name: row ? row.employee_name : '', payDate: row ? row.pay_date : '' };
}

const shaped = (row) => ({
  id: row.id,
  check_id: row.check_id,
  amountCents: Number(row.amount_cents),
  postedOn: row.posted_on ? String(row.posted_on).slice(0, 10) : null,
});

// One bell for a payment event. Never throws. Returns true when a bell was written.
async function raisePaymentAlert(event, row, { conn = db, raise = require('./admin-alert-compose').raiseAdminAlert } = {}) {
  try {
    const payment = shaped(row);
    const ctx = await contextOf(conn, row);
    const result = await raise(CATEGORY, specFor(event, payment, ctx), {
      dedupeKey: `${KEY_PREFIX}${payment.id}:${event}`,
      bellDefault: true,
      metadata: { paymentId: payment.id, checkId: row.check_id, event, reminder: 'payroll_payment' },
    });
    return Boolean(result && result.id);
  } catch (err) {
    logger.error(`[payroll-mercury] bell ${event} not raised (${(err && (err.code || err.name)) || 'error'})`);
    return false;
  }
}

// The key was deleted or lowered to read-only: one bell until a read works again.
async function raiseKeyAlert({ kind = 'read', raise = require('./admin-alert-compose').raiseAdminAlert } = {}) {
  try {
    const result = await raise(CATEGORY, {
      area: 'Billing',
      action: 'make a new Mercury key',
      why: kind === 'send'
        ? 'Mercury refused a payment request, so our key lost its send permission; a second person must make a new one.'
        : 'Mercury refused our key, so it was deleted or lowered to read-only; a second person must make a new one.',
      severity: 'needs-you',
      link: LINK,
      subject: { type: 'check', id: KEY_KEYS[kind] },
      doneWhen: 'key_working',
      who: 'person',
    }, { dedupeKey: KEY_KEYS[kind], dedupeOpenOnly: true, bellDefault: true, metadata: { event: 'key_problem', reminder: 'payroll_payment' } });
    return Boolean(result && result.id);
  } catch (err) {
    logger.error(`[payroll-mercury] key bell not raised (${(err && (err.code || err.name)) || 'error'})`);
    return false;
  }
}

// Closes the bells of one payment (or the key bell) once what they were about is settled. Never throws.
async function closeBells({ paymentId = null, key = null, resolution, conn = db, episodes = require('./admin-alert-episodes') }) {
  try {
    const keys = key ? [key] : await episodes.openAdminAlertKeys(conn, `${KEY_PREFIX}${paymentId}:`);
    if (!keys.length) return 0;
    return Number(await episodes.closeAdminAlertKeys(conn, keys, 'payroll_payment_settled', { resolution })) || 0;
  } catch (err) {
    logger.warn(`[payroll-mercury] bells not closed (${(err && (err.code || err.name)) || 'error'})`);
    return 0;
  }
}

const closePaymentBells = (paymentId, resolution, opts = {}) => closeBells({ paymentId, resolution, ...opts });
const closeKeyBell = ({ kind = 'read', ...opts } = {}) => closeBells({ key: KEY_KEYS[kind], resolution: kind === 'send' ? 'Mercury accepted a payment request again' : 'Mercury accepted the key again', ...opts });

module.exports = {
  CATEGORY, LINK, EVENTS, specFor, raisePaymentAlert, raiseKeyAlert, closePaymentBells, closeKeyBell,
};
