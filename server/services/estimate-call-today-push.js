'use strict';

// The 9:00 AM "Call today" banner (owner 2026-11-19, plan page "Lead to Customer Plan", phase 1, "do phase 1 first":
// "Estimates: a 9 AM push with the 'Call today' list (estimates sent the day before and not yet won)").
//
// ONE phone banner a day to the admin phones: "Call today: N estimates", and a tap opens the Estimates page on its
// "Call today" filter (/admin/estimates?view=call_today). The count is the page's own list: it applies
// isCallTodayEstimate from shared/estimate-call-today.cjs, the same function the page filters with, to rows built by
// the same field mapping the list route uses (estimate-call-list.js callTodayFields). Nobody to call = no banner.
//
// The banner carries a count only, never a customer name or phone: it shows on a lock screen.
//
// It goes through the trigger registry (estimate_call_today) pushOnly: no bell row, the per-admin Push Settings
// switch, sound and badge are triggerNotification's, admin-role phones only. Once per ET day: scheduler.js runs this
// under runExclusive, and the send first takes an atomic sms_send_claims row keyed to the ET date, the way
// morning-banner.js does. The claim is released when the send definitely did not happen; after any other outcome it
// stays, because a missed banner beats a doubled one. A day missed because the server was down at 9:00 is not made up.
//
// Sends nothing to a customer and calls no paid API.

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { isCallTodayEstimate } = require('../../shared/estimate-call-today.cjs');
const { lastCalledAtByEstimateId, callTodayFields } = require('./estimate-call-list');

const CLAIM_PREFIX = 'estimate_call_today:';

// The rows the rule can pass: viewed, not archived, with a phone. Every other status or an archived row fails the
// rule's first test, so it is never read.
function candidateRows() {
  return db('estimates')
    .where({ status: 'viewed' })
    .whereNull('archived_at')
    .whereRaw("COALESCE(BTRIM(customer_phone), '') <> ''")
    .select('id', 'status', 'customer_phone', 'archived_at', 'sent_at', 'viewed_at', 'last_viewed_at', 'last_follow_up_at');
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
    logger.error(`[estimate-call-today] claim release failed for ${day}: ${err?.code || err?.message || 'error'}`);
  }
}

// The send for a day with a list: claim the day, then the pushOnly banner. Never throws.
async function claimAndSend(day, count) {
  let claimed;
  try {
    claimed = await claimDay(day);
  } catch (err) {
    logger.error(`[estimate-call-today] claim failed for ${day}: ${err?.code || err?.message || 'error'}`);
    return { count, sent: false, error: 'claim_failed' };
  }
  if (!claimed) {
    logger.info(`[estimate-call-today] ${day}: already sent or in flight, skipped`);
    return { count, sent: false, skipped: 'already_claimed' };
  }
  try {
    const { triggerNotification } = require('./notification-triggers');
    const result = await triggerNotification('estimate_call_today', { count, day }, { pushOnly: true });
    if (!result || result.error || result.prefsUnavailable) {
      await releaseDay(day);
      logger.error(`[estimate-call-today] ${day}: banner not sent (${result?.error ? 'dispatch error' : result?.prefsUnavailable ? 'preferences unavailable' : 'no result'})`);
      return { count, sent: false, error: 'dispatch_failed' };
    }
    logger.info(`[estimate-call-today] ${day}: ${count} on the list, banner sent`);
    return { count, sent: true, result };
  } catch (err) {
    await releaseDay(day);
    logger.error(`[estimate-call-today] ${day}: banner failed: ${err?.message || 'error'}`);
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
    logger.error(`[estimate-call-today] count failed: ${err?.code || err?.message || 'error'}`);
    return { count: 0, sent: false, error: 'count_failed' };
  }
  if (count === 0) {
    logger.info(`[estimate-call-today] ${day}: 0 on the list, no banner`);
    return { count: 0, sent: false, skipped: 'nothing_to_call' };
  }
  return claimAndSend(day, count);
}

module.exports = { runEstimateCallTodayPush, countCallToday };
