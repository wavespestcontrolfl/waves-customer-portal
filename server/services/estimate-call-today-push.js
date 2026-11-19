'use strict';

// The 9:00 AM "Call today" banner (owner 2026-11-19, plan page "Lead to Customer Plan", phase 1, "do phase 1 first").
// The plan names it "a 9 AM push with the 'Call today' list" and describes that list loosely in a parenthetical
// ("estimates sent the day before and not yet won"). The list is the Estimates page's EXISTING Call today list:
// a viewed, unarchived estimate with a phone, last touched by the customer 2 h to 48 h ago, with no call or follow-up
// since (shared/estimate-call-today.cjs). The push counts that list, and the link opens it; it does not count a
// different cohort.
//
// ONE phone banner a day to the admin phones: "Call today: N estimates", and a tap opens the Estimates page on its
// "Call today" filter (/admin/estimates?view=call_today). The count is the page's own list: the rows are the ones the
// page loads (estimate-call-list.js estimateListQuery, the list route's own row selection: sent-list rows, newest
// ESTIMATE_LIST_LIMIT, unarchived), built by the same field mapping (callTodayFields), judged by isCallTodayEstimate
// from shared/estimate-call-today.cjs, the function the page filters with. Nothing on the list = no banner.
//
// The banner carries a count only, never a customer name or phone: it shows on a lock screen.
//
// It goes through the trigger registry (estimate_call_today) pushOnly: no bell row, the per-admin Push Settings
// switch, sound and badge are triggerNotification's, admin-role phones only. Once per ET day: scheduler.js runs this
// under runExclusive, and the send first takes an atomic sms_send_claims row keyed to the ET date, the way
// morning-banner.js does. The banner counts as sent only when a phone accepted it (push.sent > 0). The claim is
// released when the send definitely did not happen (an error, preferences unreadable, push off or no device to send to);
// after a failed or uncertain delivery it stays, because a missed banner beats a doubled one. A day missed because the
// server was down at 9:00 is not made up.
//
// Sends nothing to a customer and calls no paid API.

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { isCallTodayEstimate } = require('../../shared/estimate-call-today.cjs');
const { ESTIMATE_LIST_LIMIT, estimateListQuery, lastCalledAtByEstimateId, callTodayFields } = require('./estimate-call-list');

const CLAIM_PREFIX = 'estimate_call_today:';

// The rows the Estimates page loads (its sent list: the list route's own selection, newest ESTIMATE_LIST_LIMIT, the
// selection BEFORE any filtering), then the ones the rule can pass: viewed, not archived, with a phone. The row
// selection keeps its full width, so the column list stays the list route's.
async function candidateRows() {
  const rows = await estimateListQuery(db, { sentOnly: true }).limit(ESTIMATE_LIST_LIMIT);
  return rows.filter((row) => row.status === 'viewed' && !row.archived_at && String(row.customer_phone || '').trim());
}

// Newest short-link click per estimate: the same read the list route makes for lastClickedAt (one batched query).
async function lastClickedAtById(ids) {
  if (!ids.length) return new Map();
  const rows = await db('short_codes')
    .where({ entity_type: 'estimates' })
    .whereIn('entity_id', ids)
    .groupBy('entity_id')
    .select('entity_id')
    .max({ last_clicked_at: 'last_clicked_at' });
  return new Map(rows.map((r) => [r.entity_id, r.last_clicked_at]));
}

// How many estimates are on the Call today list right now. Throws when a read fails: a count that missed the
// "somebody already called" read would be too high, so the caller sends nothing.
async function countCallToday(nowMs) {
  const rows = await candidateRows();
  if (!rows.length) return 0;
  const [clicked, called] = await Promise.all([
    lastClickedAtById(rows.map((r) => r.id)),
    lastCalledAtByEstimateId(db, rows, nowMs),
  ]);
  return rows.filter((row) => isCallTodayEstimate(
    callTodayFields(row, { lastClickedAt: clicked.get(row.id), lastCalledAt: called.get(row.id) }),
    nowMs,
  )).length;
}

async function claimDay(day) {
  const claim = await db.raw(
    `INSERT INTO sms_send_claims (claim_key) VALUES (?)
     ON CONFLICT (claim_key) DO NOTHING
     RETURNING id`,
    [`${CLAIM_PREFIX}${day}`],
  );
  return (claim?.rows || []).length > 0;
}

async function releaseDay(day) {
  try {
    await db('sms_send_claims').where({ claim_key: `${CLAIM_PREFIX}${day}` }).del();
  } catch (err) {
    logger.error(`[estimate-call-today] claim release failed for ${day} (${err?.code || 'no code'})`);
  }
}

// What the dispatch did. Sent only when a phone accepted it (push.sent > 0). An error or unreadable preferences, push
// off (push null) or a RECOGNIZED nothing-to-send-to result (no device, expired devices, a policy skip: sent 0 with no
// failure counted) is a skip: the claim is released so a later run may try. Anything else (a device failed, a retry is
// pending, or a result shape we do not recognize, such as missing counters) is uncertain: the claim stays, so there is
// never a second banner that day. The log lines are fixed text.
function isRecognizedNoDelivery(push) {
  if (push === null) return true;
  if (!push || typeof push !== 'object' || push.sent !== 0) return false;
  if (Number(push.retryable) > 0) return false;
  if (typeof push.skipped === 'string' && push.skipped) return true; // { sent: 0, skipped: 'reason' }
  return push.failed === 0; // the push service's own summary with its counters
}

async function settle(day, count, result) {
  const push = result?.push;
  if (!result || result.error || result.prefsUnavailable) {
    await releaseDay(day);
    logger.error(`[estimate-call-today] ${day}: banner not sent (${result?.error ? 'dispatch error' : result?.prefsUnavailable ? 'preferences unavailable' : 'no result'})`);
    return { count, sent: false, error: 'dispatch_failed' };
  }
  if (push && Number(push.sent) > 0) {
    logger.info(`[estimate-call-today] ${day}: ${count} on the list, banner sent`);
    return { count, sent: true, result };
  }
  if (isRecognizedNoDelivery(push)) {
    await releaseDay(day);
    logger.warn(`[estimate-call-today] ${day}: banner skipped (push off or no device to send to); claim released`);
    return { count, sent: false, skipped: 'no_push_delivered' };
  }
  logger.error(`[estimate-call-today] ${day}: delivery uncertain (no device accepted it, or the result was not recognized); claim kept`);
  return { count, sent: false, error: 'delivery_uncertain' };
}

// The send for a day with a list: claim the day, then the pushOnly banner. Never throws.
async function claimAndSend(day, count) {
  let claimed;
  try {
    claimed = await claimDay(day);
  } catch (err) {
    logger.error(`[estimate-call-today] claim failed for ${day} (${err?.code || 'no code'})`);
    return { count, sent: false, error: 'claim_failed' };
  }
  if (!claimed) {
    logger.info(`[estimate-call-today] ${day}: already sent or in flight, skipped`);
    return { count, sent: false, skipped: 'already_claimed' };
  }
  try {
    const { triggerNotification } = require('./notification-triggers');
    const result = await triggerNotification('estimate_call_today', { count, day }, { pushOnly: true });
    return settle(day, count, result);
  } catch (err) {
    await releaseDay(day);
    logger.error(`[estimate-call-today] ${day}: banner failed (${err?.code || 'no code'})`);
    return { count, sent: false, error: 'dispatch_failed' };
  }
}

// Never throws. { count: 0, sent: false, skipped | error } | { count, sent: false, skipped | error } | { count, sent: true, result }.
async function runEstimateCallTodayPush({ now = new Date() } = {}) {
  const day = etDateString(now);
  let count;
  try {
    count = await countCallToday(now.getTime());
  } catch (err) {
    // Never err.message: a Knex error carries the SQL with its bindings, i.e. customer phones (AGENTS.md, PII in logs).
    logger.error(`[estimate-call-today] count failed (${err?.code || 'no code'})`);
    return { count: 0, sent: false, error: 'count_failed' };
  }
  if (count === 0) {
    logger.info(`[estimate-call-today] ${day}: 0 on the list, no banner`);
    return { count: 0, sent: false, skipped: 'nothing_to_call' };
  }
  return claimAndSend(day, count);
}

module.exports = { runEstimateCallTodayPush, countCallToday };
