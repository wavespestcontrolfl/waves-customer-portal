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
const { takeSendClaim, releaseSendClaim } = require('./sms-send-claims');
const { etDateString } = require('../utils/datetime-et');
const { isCallTodayEstimate } = require('../../shared/estimate-call-today.cjs');
const { undeliveredSelfServeSql, selfServeDeliveredAtSql } = require('./self-serve-estimates');
const {
  ESTIMATE_LIST_LIMIT, estimateListQuery, clickStatsByEstimateId, lastCalledAtByEstimateId, callTodayFields,
} = require('./estimate-call-list');

const CLAIM_PREFIX = 'estimate_call_today:';
// The dispatcher's `pushFailed` markers for a throw before any push reached a provider: its recipient lookup, or the
// push block before the first device send (the subscription lookup). 'push_dispatch' may have reached a phone.
const PRE_HANDOFF_FAILURES = new Set(['recipient_lookup', 'before_handoff']);
// The columns the count reads: callTodayFields, lastCalledAtByEstimateId (id, status, customer_phone) and the filter in
// candidateRows. The rows and their order stay the list route's; estimate_data is not loaded for 2,000 rows: the
// undelivered self-serve flag and a delivered one's first delivery are the list route's rules as SQL
// (undeliveredSelfServeSql, selfServeDeliveredAtSql).
const CALL_TODAY_COLUMNS = Object.freeze([
  'estimates.id', 'estimates.status', 'estimates.customer_phone', 'estimates.archived_at',
  'estimates.sent_at', 'estimates.viewed_at', 'estimates.last_viewed_at', 'estimates.last_follow_up_at',
]);

// The rows the Estimates page loads (its sent list: the list route's own selection, newest ESTIMATE_LIST_LIMIT, the
// selection BEFORE any filtering), then the ones the rule can pass: viewed, not archived, with a phone. Only the
// columns the count reads are fetched (CALL_TODAY_COLUMNS).
async function candidateRows() {
  // One more column, not another filter: the rows and their order stay the list route's, and isCallTodayEstimate
  // reads the flag through callTodayFields, as the page does (zero-follow-up contract).
  const undeliveredSelfServe = db.raw(`${undeliveredSelfServeSql('estimates')} AS undelivered_self_serve`);
  const selfServeDeliveredAt = db.raw(`${selfServeDeliveredAtSql('estimates')} AS self_serve_delivered_at`);
  const rows = await estimateListQuery(db, { sentOnly: true }).clearSelect().select(CALL_TODAY_COLUMNS)
    .select(undeliveredSelfServe).select(selfServeDeliveredAt).limit(ESTIMATE_LIST_LIMIT);
  return rows.filter((row) => row.status === 'viewed' && !row.archived_at && String(row.customer_phone || '').trim());
}

// Newest short-link click per estimate: the list route's own read for lastClickedAt (estimate-call-list.js
// clickStatsByEstimateId, one batched query), so a change to which clicks count moves the page and the push together.
async function lastClickedAtById(ids) {
  const stats = await clickStatsByEstimateId(db, ids);
  return new Map([...stats].map(([id, row]) => [id, row.last_clicked_at]));
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
    callTodayFields(row, {
      lastClickedAt: clicked.get(row.id),
      lastCalledAt: called.get(row.id),
      undeliveredSelfServe: row.undelivered_self_serve,
      selfServeDeliveredAt: row.self_serve_delivered_at,
    }),
    nowMs,
  )).length;
}

// The day's claim, shared with the morning banner (sms-send-claims.js); the release policy below is this banner's own.
async function claimDay(day) {
  return takeSendClaim(`${CLAIM_PREFIX}${day}`);
}

// True when the claim row is gone. A failed delete leaves the row, which blocks a same-day retry, so the caller must say so.
async function releaseDay(day) {
  try {
    await releaseSendClaim(`${CLAIM_PREFIX}${day}`);
    return true;
  } catch (err) {
    logger.error(`[estimate-call-today] claim release failed for ${day} (${err?.code || 'no code'})`);
    return false;
  }
}

// What the dispatch did. Sent only when a phone accepted it (push.sent > 0). An error before the push block (the
// dispatcher's outer catch) or unreadable preferences, push off (push null) or a RECOGNIZED nothing-to-send-to result
// (no device, expired devices, a policy skip: sent 0 with no failure counted) is a skip: the claim is released so a
// later run may try. Anything else (no result at all, a device failed, a retry is pending, or a result shape we do not
// recognize, such as missing counters) is uncertain: the claim stays, so there is never a second banner that day. The dispatcher's own `pushFailed` marker (its recipient lookup or push block threw,
// which also leaves push null) is a failure, not a disabled push, and the run reports an error. A throw before any
// push reached a provider (PRE_HANDOFF_FAILURES) releases the claim, so a same-day rerun may send once the database
// recovers; a thrown push dispatch after a device send began may have reached a phone, so its claim stays. A claim
// release that fails is reported as claim_release_failed, never as a released claim. The log lines are fixed text.
// A device the push service skipped because its provider has no credentials (APNs, FCM or web push not configured) is
// a delivery failure, not a quiet skip: with every phone on an unconfigured provider, each day's banner would be lost
// while the job reads healthy. The claim is released (nothing reached a provider), and the run reports an error.
const PROVIDER_NOT_CONFIGURED = new Set(['apns_not_configured', 'fcm_not_configured', 'push_not_configured']);
function providerNotConfigured(push) {
  return Array.isArray(push?.results) && push.results.some((r) => r?.skipped && PROVIDER_NOT_CONFIGURED.has(r.reason));
}

// The dispatcher's own pre-send skips (notification-triggers.js): each returns before any device send. Any other skip
// text is not recognized, so its claim stays.
const PRE_SEND_SKIPS = new Set(['claude_queue', 'bell_policy', 'superseded_before_push']);
function isRecognizedNoDelivery(push) {
  if (push === null) return true;
  if (!push || typeof push !== 'object' || push.sent !== 0) return false;
  // Failure counters first: a failed or retrying device may have reached a provider, whatever else the result says.
  if (Number(push.retryable) > 0 || (push.failed !== undefined && push.failed !== 0)) return false;
  if (typeof push.skipped === 'string') return PRE_SEND_SKIPS.has(push.skipped); // { sent: 0, skipped: 'reason' }
  return push.failed === 0; // the push service's own summary with its counters
}

async function settle(day, count, result) {
  // No result is no evidence that the push stopped before a handoff: keep the claim.
  if (!result || typeof result !== 'object') {
    logger.error(`[estimate-call-today] ${day}: delivery uncertain (no dispatch result); claim kept`);
    return { count, sent: false, error: 'delivery_uncertain' };
  }
  // The push block's own marker comes first: its throw can also set `error` (a deduped dispatch), and only the marker
  // says whether a provider may have been reached.
  if (PRE_HANDOFF_FAILURES.has(result.pushFailed)) {
    const released = await releaseDay(day);
    logger.error(`[estimate-call-today] ${day}: push failed before any handoff (${result.pushFailed}); ${released ? 'claim released' : 'claim release failed'}`);
    return { count, sent: false, error: released ? 'push_failed_before_handoff' : 'claim_release_failed' };
  }
  if (result.pushFailed) {
    logger.error(`[estimate-call-today] ${day}: push dispatch failed (${String(result.pushFailed)}); claim kept`);
    return { count, sent: false, error: 'push_dispatch_failed' };
  }
  // Without a push marker, `error` is the dispatcher's outer catch (before its push block), and unreadable preferences
  // deliver to nobody: nothing reached a provider, so the claim is released.
  if (result.error || result.prefsUnavailable) {
    const released = await releaseDay(day);
    logger.error(`[estimate-call-today] ${day}: banner not sent (${result.error ? 'dispatch error' : 'preferences unavailable'})${released ? '' : '; claim release failed'}`);
    return { count, sent: false, error: released ? 'dispatch_failed' : 'claim_release_failed' };
  }
  const push = result.push;
  if (push && Number(push.sent) > 0) {
    logger.info(`[estimate-call-today] ${day}: ${count} on the list, banner sent`);
    return { count, sent: true, result };
  }
  if (isRecognizedNoDelivery(push)) {
    if (!(await releaseDay(day))) {
      logger.error(`[estimate-call-today] ${day}: banner skipped (push off or no device to send to) but the claim release failed; claim kept`);
      return { count, sent: false, error: 'claim_release_failed' };
    }
    if (providerNotConfigured(push)) {
      logger.error(`[estimate-call-today] ${day}: banner not delivered (a push provider is not configured); claim released`);
      return { count, sent: false, error: 'push_not_configured' };
    }
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
    // triggerNotification catches every throw in its body and returns { error }, so a rejection here comes before it
    // ran (its require or its call): no push was attempted, and the claim is released.
    const released = await releaseDay(day);
    logger.error(`[estimate-call-today] ${day}: banner failed (${err?.code || 'no code'})${released ? '' : '; claim release failed'}`);
    return { count, sent: false, error: released ? 'dispatch_failed' : 'claim_release_failed' };
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

module.exports = { runEstimateCallTodayPush, countCallToday, CALL_TODAY_COLUMNS };
