/**
 * Dead-number alert (owner 2026-11-04, "fix check", GATE_DEAD_NUMBER_ALERT, dark by default).
 *
 * A customer's phone on file can be dead: every text to it fails with Twilio 30003 (unreachable handset)
 * or 30005 (unknown handset). Nothing used to tell staff. When a text to a customer's number fails with one
 * of those two codes and the customer has had 2 or more failed texts to the same number (last 10 digits)
 * in 180 days, ONE bell row says so by name: "Customers - <Name>'s phone can't get texts".
 *
 * - Called from the Twilio delivery callback (routes/twilio-webhook.js POST /status). Both entry points never
 *   throw: the callback and its other handlers must not feel a failure here. Logs carry codes only, never a
 *   name or a phone number.
 * - Dedupe: one OPEN row per customer + number (`dead-number:<customerId>:<last10>`, dedupeOpenOnly). A person's
 *   Done lets a later failed text raise a fresh row (RERING in admin-alert-retention.js, kind 'event').
 * - Close (done-when `phone_replaced`): the row closes when a later text to that number is delivered, or when the
 *   customer's phone and secondary phone no longer end in those 10 digits. Both are judged at the customer's next
 *   delivered text (closeDeadNumberAlerts), which is when a new number first gets used.
 * - Sends nothing to anyone. Only the bell.
 */
'use strict';

const db = require('../models/db');
const logger = require('./logger');
const { deadNumberAlertLive } = require('../config/feature-gates');

const UNREACHABLE_CODES = new Set(['30003', '30005']);
const FAILED_STATUSES = ['failed', 'undelivered'];
const WINDOW_DAYS = 180;
const MIN_FAILURES = 2;
const KEY_PREFIX = 'dead-number:';
const DAY_MS = 24 * 60 * 60 * 1000;

// The last 10 digits of a phone, or '' when it has fewer than 10 digits.
function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

const dedupeKeyFor = (customerId, key) => `${KEY_PREFIX}${customerId}:${key}`;
const holdsNumber = (customer, key) => [customer?.phone, customer?.secondary_phone].some((p) => phoneKey(p) === key);

// "Jane D." from a customer row; the first name alone when there is no last name.
function shortName(customer) {
  const first = String(customer?.first_name || '').trim();
  const last = String(customer?.last_name || '').trim();
  return [first, last ? last[0].toUpperCase() : ''].filter(Boolean).join(' ');
}

function actionFor(customer) {
  const { fitAction } = require('./admin-alert-names');
  const name = shortName(customer);
  if (!name) return "a customer's phone can't get texts";
  // tidyName (inside fitAction) drops the dot of the last initial; put it back.
  const withDot = (who) => (/ [A-Z]$/.test(who) ? `${who}.` : who);
  return fitAction('Customers', name, [(who) => `${withDot(who)}'s phone can't get texts`]);
}

// What this failure's code says, and the next step. 30005 = the number is unknown to the carrier;
// 30003 = the phone is off or out of reach, so the number may still be good.
const CARRIER_SAYS = {
  30005: { says: 'the carrier says the number does not exist', next: 'Get a new number from the customer.' },
  30003: { says: "the carrier can't reach the phone", next: 'Check the number with the customer.' },
};

function copyFor({ count, key, since, errorCode }) {
  const { shortDateET } = require('./admin-alert-names');
  const when = shortDateET(since);
  const { says, next } = CARRIER_SAYS[String(errorCode)] || CARRIER_SAYS[30005];
  const why = `${count} texts to …${key.slice(-4)} failed${when ? ` since ${when}` : ''}: ${says}.`;
  return { why, detail: `${why} ${next}` };
}

// The outbound text behind a callback, or null: { customer_id, to_phone } for a text sent to a customer.
async function outboundCustomerText(sid) {
  const row = await db('sms_log').where({ twilio_sid: sid }).first('customer_id', 'direction', 'to_phone');
  return row && row.customer_id && row.direction === 'outbound' ? row : null;
}

// This customer's failed or undelivered outbound texts to one number in the window, as created_at dates. The
// status update at the top of the callback may have failed, so this callback's own row always counts.
async function failedTextDates(customerId, key, sid) {
  const rows = await db('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    .where('created_at', '>=', new Date(Date.now() - WINDOW_DAYS * DAY_MS))
    .whereRaw("right(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key])
    .where(function failedOrThis() { this.whereIn('status', FAILED_STATUSES).orWhere('twilio_sid', sid); })
    .select('created_at');
  return rows.map((r) => new Date(r.created_at));
}

/**
 * Called for a failed or undelivered delivery callback. Raises the bell when the text went to a customer's
 * number with error 30003 / 30005 and this is the 2nd or later such failure to that number in 180 days.
 * @returns {Promise<object|null>} the alert result, or null when nothing was raised
 */
async function handleDeadNumberFailure({ sid, status, errorCode, to } = {}) {
  try {
    if (!deadNumberAlertLive()) return null;
    if (!sid || !FAILED_STATUSES.includes(String(status)) || !UNREACHABLE_CODES.has(String(errorCode))) return null;

    const row = await outboundCustomerText(sid);
    const key = row ? phoneKey(row.to_phone) || phoneKey(to) : '';
    if (!key) return null;

    // Only the customer's current number: a number since replaced needs no one.
    const customer = await db('customers').where({ id: row.customer_id })
      .first('id', 'first_name', 'last_name', 'phone', 'secondary_phone', 'active', 'deleted_at');
    if (!customer || customer.active === false || customer.deleted_at || !holdsNumber(customer, key)) return null;

    const failed = await failedTextDates(customer.id, key, sid);
    if (failed.length < MIN_FAILURES) return null;

    const since = failed.reduce((a, b) => (b < a ? b : a));
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { why, detail } = copyFor({ count: failed.length, key, since, errorCode });
    return await raiseAdminAlert('customer', {
      area: 'Customers',
      action: actionFor(customer),
      why,
      severity: 'needs-you',
      link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
      subject: { type: 'customer', id: String(customer.id) },
      doneWhen: 'phone_replaced',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: dedupeKeyFor(customer.id, key),
      dedupeOpenOnly: true,
      detail,
      metadata: { customerId: customer.id, phoneLast4: key.slice(-4), failedCount: failed.length },
    });
  } catch (err) {
    logger.warn(`[dead-number-alert] not raised (${err?.code || err?.name || 'error'})`);
    return null;
  }
}

/**
 * Called for a delivered callback. Closes this customer's open dead-number rows whose number just received a
 * text, or is no longer the customer's phone or secondary phone. Cheap when there is none: one indexed read
 * of the sms_log row, one read of the open dead-number keys.
 * @returns {Promise<number>} rows closed
 */
async function closeDeadNumberAlerts({ sid, status } = {}) {
  try {
    if (!deadNumberAlertLive()) return 0;
    if (!sid || String(status) !== 'delivered') return 0;

    const row = await outboundCustomerText(sid);
    if (!row) return 0;
    const open = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereNull('done_at')
      .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [`${KEY_PREFIX}${row.customer_id}:`])
      .select(db.raw("metadata->>'dedupeKey' as dedupe_key"));
    const keys = [...new Set(open.map((r) => r.dedupe_key).filter(Boolean))];
    if (!keys.length) return 0;

    const deliveredKey = phoneKey(row.to_phone);
    const customer = await db('customers').where({ id: row.customer_id }).first('phone', 'secondary_phone', 'active', 'deleted_at');
    const gone = !customer || customer.active === false || Boolean(customer.deleted_at);
    const numberOf = (k) => k.slice(k.lastIndexOf(':') + 1);
    const delivered = keys.filter((k) => deliveredKey && numberOf(k) === deliveredKey);
    const replaced = keys.filter((k) => !delivered.includes(k) && (gone || !holdsNumber(customer, numberOf(k))));
    const { closeAdminAlertKeys } = require('./admin-alert-episodes');
    const now = new Date();
    let closed = 0;
    if (delivered.length) {
      closed += await closeAdminAlertKeys(db, delivered, 'text_delivered', { now, resolution: 'A later text to this number was delivered' });
    }
    if (replaced.length) {
      closed += await closeAdminAlertKeys(db, replaced, 'phone_replaced', { now, resolution: 'The customer no longer has this number on file' });
    }
    return closed;
  } catch (err) {
    logger.warn(`[dead-number-alert] close failed (${err?.code || err?.name || 'error'})`);
    return 0;
  }
}

// The one entry the delivery callback calls: a delivered text closes, a failed one may raise.
const handleDeadNumberCallback = (callback = {}) => (String(callback.status) === 'delivered'
  ? closeDeadNumberAlerts(callback)
  : handleDeadNumberFailure(callback));

module.exports = {
  handleDeadNumberCallback, handleDeadNumberFailure, closeDeadNumberAlerts,
  __private: { phoneKey, dedupeKeyFor, holdsNumber, shortName, actionFor, copyFor, KEY_PREFIX },
};
