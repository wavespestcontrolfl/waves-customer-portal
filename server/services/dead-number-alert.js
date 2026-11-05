/**
 * Dead-number alert (owner 2026-11-04, "fix check", GATE_DEAD_NUMBER_ALERT, dark by default).
 *
 * A customer's phone on file can be dead: every text to it fails with Twilio 30003 (unreachable handset)
 * or 30005 (unknown handset). Nothing used to tell staff. When a text to a customer's number fails with one
 * of those two codes and it is the 2nd failed text in a row to that number (last 10 digits; no delivered text
 * in between) in 180 days, ONE bell row says so by name: "Customers - <Name>'s phone can't get texts".
 * Order is by when each text was sent, so a late callback for an older text never counts as news.
 *
 * - Called from the Twilio delivery callback (routes/twilio-webhook.js POST /status). Both entry points never
 *   throw: the callback and its other handlers must not feel a failure here. Logs carry codes only, never a
 *   name or a phone number.
 * - Both paths run in one transaction under a per-customer advisory lock and read the text history and the
 *   rows inside it, so a failure and a delivery for the same customer never interleave.
 * - Dedupe: one OPEN row per customer + number (`dead-number:<customerId>:<last10>`, dedupeOpenOnly); a newer
 *   failure updates the open row's count without ringing. Each row stores the send time of its newest failure
 *   (`lastFailureAt`), so after a person's Done only a failure sent later raises a fresh row; a retried or late
 *   callback raises nothing (RERING in admin-alert-retention.js, kind 'event').
 * - Close (done-when `phone_replaced`): the row closes when a text sent after the number's last failure is
 *   delivered, or when the customer's phone and secondary phone no longer end in those 10 digits. Both are judged
 *   at the customer's next delivered text (closeDeadNumberAlerts), which is when a new number first gets used.
 * - Sends nothing to anyone. Only the bell.
 */
'use strict';

const db = require('../models/db');
const logger = require('./logger');
const { deadNumberAlertLive } = require('../config/feature-gates');

const UNREACHABLE_CODES = new Set(['30003', '30005']);
const FAILED_STATUSES = ['failed', 'undelivered'];
// The statuses that settle a text: Twilio reported it failed, undelivered or delivered.
const SETTLED_STATUSES = [...FAILED_STATUSES, 'delivered'];
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
  const why = `${count} texts in a row to …${key.slice(-4)} failed${when ? ` since ${when}` : ''}: ${says}.`;
  return { why, detail: `${why} ${next}` };
}

// A callback can beat the sender's own sms_log insert (services/twilio.js logs a text after messages.create
// returns), so a sid with no row yet is tried again in this process after these delays, never dropped on the
// first miss. A retry that finds the row writes the status the route's own update missed (it ran before the row
// existed), so the text counts in later runs too.
const RETRY_DELAYS_MS = [15 * 1000, 60 * 1000];
const UNSETTLED_STATUSES = ['queued', 'sending', 'sent'];
const NOT_LOGGED = Symbol('dead-number: sid not logged yet');

// The outbound text behind a callback: { customer_id, to_phone } for a text sent to a customer, null for any
// other text, or NOT_LOGGED while the sender has not logged the sid.
async function outboundCustomerText(sid, { status, attempt = 0 } = {}) {
  const row = await db('sms_log').where({ twilio_sid: sid }).first('customer_id', 'direction', 'to_phone');
  if (!row) return NOT_LOGGED;
  if (attempt > 0) {
    await db('sms_log').where({ twilio_sid: sid }).whereIn('status', UNSETTLED_STATUSES).update({ status: String(status) });
  }
  return row.customer_id && row.direction === 'outbound' ? row : null;
}

function retryLater(handler, callback) {
  const attempt = Number(callback.attempt) || 0;
  if (attempt >= RETRY_DELAYS_MS.length) return;
  const timer = setTimeout(() => {
    Promise.resolve().then(() => handler({ ...callback, attempt: attempt + 1 })).catch(() => {});
  }, RETRY_DELAYS_MS[attempt]);
  if (typeof timer.unref === 'function') timer.unref();
}

// This customer's settled outbound texts to one number in the window, plus this callback's own row, oldest
// sent first. Only texts Twilio took (a sid): a queued send that failed before reaching the provider is not a
// carrier failure.
async function settledTextsTo(conn, customerId, key, sid) {
  return conn('sms_log')
    .where({ customer_id: customerId, direction: 'outbound' })
    .whereNotNull('twilio_sid')
    .where('created_at', '>=', new Date(Date.now() - WINDOW_DAYS * DAY_MS))
    .whereRaw("right(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key])
    .where(function settledOrThis() { this.whereIn('status', SETTLED_STATUSES).orWhere('twilio_sid', sid); })
    .orderBy('created_at', 'asc')
    .select('created_at', 'status', 'twilio_sid');
}

// The send dates of the failed texts after the last delivered one ("in a row"), oldest first. The callback's
// own row counts as what the callback reports (`failedSid` / `deliveredSid`): the status update at the top of
// the callback may not have landed.
function failuresInARow(rows, { failedSid = null, deliveredSid = null } = {}) {
  const stateOf = (r) => {
    if (failedSid && r.twilio_sid === failedSid) return 'failed';
    if (deliveredSid && r.twilio_sid === deliveredSid) return 'delivered';
    return r.status;
  };
  let run = [];
  for (const r of rows) {
    const state = stateOf(r);
    if (FAILED_STATUSES.includes(state)) run.push(new Date(r.created_at));
    else if (state === 'delivered') run = [];
  }
  return run;
}

// Both callback paths judge and write for one customer under one lock, and read the text history and the rows
// inside it: a failure and a delivery for the same customer never interleave their reads and writes.
const withCustomerLock = (customerId, fn) => db.transaction(async (trx) => {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${KEY_PREFIX}${customerId}`]);
  return fn(trx);
});

// Inside the customer's lock: raise the row for one number, or refresh the open one quietly, unless it is no news.
async function raiseForNumber(trx, { customerId, key, sid, errorCode }) {
  // Only the customer's current number: a number since replaced needs no one.
  const customer = await trx('customers').where({ id: customerId })
    .first('id', 'first_name', 'last_name', 'phone', 'secondary_phone', 'active', 'deleted_at');
  if (!customer || customer.active === false || customer.deleted_at || !holdsNumber(customer, key)) return null;

  const failed = failuresInARow(await settledTextsTo(trx, customer.id, key, sid), { failedSid: sid });
  if (failed.length < MIN_FAILURES) return null;

  // A row, open or Done, already raised for this run's newest failure: a retried or late callback is no news.
  const lastFailureAt = failed[failed.length - 1].toISOString();
  const dedupeKey = dedupeKeyFor(customer.id, key);
  const prior = await trx('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first(trx.raw("max(metadata->>'lastFailureAt') as at"));
  if (prior?.at && prior.at >= lastFailureAt) return null;

  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { why, detail } = copyFor({ count: failed.length, key, since: failed[0], errorCode });
  return raiseAdminAlert('customer', {
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
    dedupeKey,
    dedupeOpenOnly: true,
    // An open row takes the newer count and newest failure without ringing: a person already has it.
    refreshOnDedupe: true,
    standingRefresh: () => ({ quiet: true }),
    trx,
    detail,
    metadata: { customerId: customer.id, phoneLast4: key.slice(-4), failedCount: failed.length, lastFailureAt },
  });
}

/**
 * Called for a failed or undelivered delivery callback. Raises the bell when the text went to a customer's
 * number with error 30003 / 30005 and this is the 2nd or later failure in a row to that number in 180 days.
 * @returns {Promise<object|null>} the alert result, or null when nothing was raised
 */
async function handleDeadNumberFailure({ sid, status, errorCode, to, attempt = 0 } = {}) {
  try {
    if (!deadNumberAlertLive()) return null;
    if (!sid || !FAILED_STATUSES.includes(String(status)) || !UNREACHABLE_CODES.has(String(errorCode))) return null;

    const row = await outboundCustomerText(sid, { status, attempt });
    if (row === NOT_LOGGED) {
      retryLater(handleDeadNumberFailure, { sid, status, errorCode, to, attempt });
      return null;
    }
    const key = row ? phoneKey(row.to_phone) || phoneKey(to) : '';
    if (!key) return null;
    return await withCustomerLock(row.customer_id, (trx) => raiseForNumber(trx, { customerId: row.customer_id, key, sid, errorCode }));
  } catch (err) {
    logger.warn(`[dead-number-alert] not raised (${err?.code || err?.name || 'error'})`);
    return null;
  }
}

// Inside the customer's lock: close the open rows a delivered text disproves.
async function closeForDelivery(trx, { customerId, deliveredKey, sid }) {
  const open = await trx('notifications')
    .where({ recipient_type: 'admin' })
    .whereNull('done_at')
    .whereRaw("starts_with(metadata->>'dedupeKey', ?)", [`${KEY_PREFIX}${customerId}:`])
    .select(trx.raw("metadata->>'dedupeKey' as dedupe_key"));
  const keys = [...new Set(open.map((r) => r.dedupe_key).filter(Boolean))];
  if (!keys.length) return 0;

  const customer = await trx('customers').where({ id: customerId }).first('phone', 'secondary_phone', 'active', 'deleted_at');
  const gone = !customer || customer.active === false || Boolean(customer.deleted_at);
  const numberOf = (k) => k.slice(k.lastIndexOf(':') + 1);
  const sameNumber = keys.filter((k) => deliveredKey && numberOf(k) === deliveredKey);
  const working = sameNumber.length
    && !failuresInARow(await settledTextsTo(trx, customerId, deliveredKey, sid), { deliveredSid: sid }).length;
  const delivered = working ? sameNumber : [];
  const replaced = keys.filter((k) => !delivered.includes(k) && (gone || !holdsNumber(customer, numberOf(k))));
  const { closeAdminAlertKeys } = require('./admin-alert-episodes');
  const now = new Date();
  let closed = 0;
  if (delivered.length) {
    closed += await closeAdminAlertKeys(trx, delivered, 'text_delivered', { now, resolution: 'A later text to this number was delivered' });
  }
  if (replaced.length) {
    closed += await closeAdminAlertKeys(trx, replaced, 'phone_replaced', { now, resolution: 'The customer no longer has this number on file' });
  }
  return closed;
}

/**
 * Called for a delivered callback. Closes this customer's open dead-number rows whose number now has no failure
 * after its last delivered text (so a late callback for a text sent before the failures closes nothing), or is no
 * longer the customer's phone or secondary phone. Cheap when there is none: one indexed read of the sms_log row,
 * then one short locked read of the open dead-number keys.
 * @returns {Promise<number>} rows closed
 */
async function closeDeadNumberAlerts({ sid, status, attempt = 0 } = {}) {
  try {
    if (!deadNumberAlertLive()) return 0;
    if (!sid || String(status) !== 'delivered') return 0;

    const row = await outboundCustomerText(sid, { status, attempt });
    if (row === NOT_LOGGED) {
      retryLater(closeDeadNumberAlerts, { sid, status, attempt });
      return 0;
    }
    if (!row) return 0;
    return await withCustomerLock(row.customer_id, (trx) => closeForDelivery(trx, { customerId: row.customer_id, deliveredKey: phoneKey(row.to_phone), sid }));
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
  __private: { phoneKey, dedupeKeyFor, holdsNumber, shortName, actionFor, copyFor, failuresInARow, KEY_PREFIX, RETRY_DELAYS_MS },
};
