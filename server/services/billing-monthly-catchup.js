/**
 * Monthly billing catch-up (owner 2026-11-06, O1: "Bill each missed day of this
 * month. The existing charge keys block double charges.").
 *
 * The monthly dues run (scheduler.js, 8:00 AM ET, runExclusive('billing-monthly'))
 * bills only customers whose billing_day is today. A deploy restart that drops
 * the 8:00 tick, or kills the run partway, left that day's cohort uncharged
 * until next month. This module keeps a bookmark of the last billing date a run
 * finished, and the 10:29 / 14:29 ET catch-up ticks bill each missed ET date of
 * the current month through BillingCron.processMonthlyBilling({ billingDate }):
 * the same lock name, cohort, guards and charge path, with that day's
 * billing_day. Nothing here decides who owes what.
 *
 * - Bookmark: one ops_email_send_state row (no new table). last_sent_at is
 *   noon ET of the last billing date whose run finished without throwing; the
 *   date is read back with etDateString. The 8:00 run writes it with the gate
 *   on or off, so days the gate was off are never backfilled when it is turned
 *   on. A failed write only logs: the next catch-up then repeats a day it
 *   already billed, and every customer it already charged or tried is skipped
 *   (see "No double charge").
 * - Missed dates: each ET date after the bookmark, through today, and only
 *   dates in the current calendar month. A cohort from an earlier month is
 *   never billed (processMonthlyBilling also refuses one). No bookmark (the
 *   first days after deploy) means no backfill.
 * - No double charge: a catch-up run skips a customer whose month is already
 *   collected (findCollectedMonthlyPayment, the same check the 8:00 run makes)
 *   and a customer with a failed or refunded attempt for this month dated on
 *   or after the billing date it makes up, so a card a killed run declined is
 *   not tried again and no second decline text or email goes out.
 * - Honest failure (#7700 rule): the pre-lock read answers "skip" on a failed
 *   read and records nothing. The read under the lock throws, so runExclusive
 *   records a failure, never a false success.
 * - GATE_BILLING_MONTHLY_CATCHUP off: the catch-up ticks read and charge
 *   nothing; the 8:00 run is unchanged apart from the bookmark write.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { billingMonthlyCatchupLive } = require('../config/feature-gates');

const BOOKMARK_KEY = 'billing-monthly-billed-thru';

const nextDate = (ymd) => etDateString(addETDays(parseETDateTime(`${ymd}T12:00`), 1));

// The last billing date a run finished, or null when none is recorded. Throws on a failed
// read; each caller decides what a failure means.
async function readBookmark() {
  const row = await db('ops_email_send_state').where({ email_key: BOOKMARK_KEY }).first('last_sent_at');
  return row?.last_sent_at ? etDateString(new Date(row.last_sent_at)) : null;
}

// Never throws: a lost write leaves the bookmark behind, so a later catch-up repeats a day
// (every customer already charged or tried is skipped) instead of skipping one.
async function writeBookmark(billingDate) {
  try {
    const at = parseETDateTime(`${billingDate}T12:00`);
    const now = new Date();
    await db('ops_email_send_state')
      .insert({ email_key: BOOKMARK_KEY, last_sent_at: at, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: at, updated_at: now });
  } catch (err) {
    logger.warn(`[billing-monthly-catchup] bookmark write for ${billingDate} failed (${err.code || err.name || 'error'}) — a later catch-up may repeat this day; charged and tried customers are skipped`);
  }
}

/**
 * ET dates still to bill, oldest first: each date after `bookmark` through `today`, held to
 * today's calendar month. No bookmark, or a bookmark at or after today, owes nothing.
 */
function missedBillingDates(bookmark, today) {
  if (!bookmark || bookmark >= today) return [];
  const monthStart = `${today.slice(0, 7)}-01`;
  const dates = [];
  for (let d = bookmark < monthStart ? monthStart : nextDate(bookmark); d <= today; d = nextDate(d)) dates.push(d);
  return dates;
}

/**
 * The 8:00 AM ET tick body (inside runExclusive('billing-monthly')). It runs today's billing
 * exactly as before, then moves the bookmark to today, unless the gate is on and an earlier
 * date of this month is still owed: then the bookmark stays, so the catch-up bills that date
 * (and passes over today's customers, all already charged or tried). With the gate on, a
 * failed bookmark read leaves the bookmark where it is; today's billing has already run.
 */
async function runMonthlyBillingTick() {
  const result = await require('./billing-cron').processMonthlyBilling();
  if (!billingMonthlyCatchupLive()) {
    await writeBookmark(result.billingDate);
    return result;
  }
  let owedBefore;
  try {
    owedBefore = missedBillingDates(await readBookmark(), result.billingDate).filter((d) => d < result.billingDate);
  } catch (err) {
    logger.warn(`[billing-monthly-catchup] bookmark read after the 8:00 run failed (${err.code || err.name || 'error'}) — bookmark left as it is`);
    return result;
  }
  if (owedBefore.length) {
    logger.warn(`[billing-monthly-catchup] ${owedBefore.length} earlier billing date(s) still owed (${owedBefore.join(', ')}) — bookmark left for the catch-up`);
    return { ...result, owedBefore };
  }
  await writeBookmark(result.billingDate);
  return result;
}

/**
 * True when the gate is on and the bookmark shows a date still owed. The catch-up tick asks
 * this before it takes the lock. Gate off reads nothing; a failed read answers false.
 */
async function catchUpNeeded() {
  if (!billingMonthlyCatchupLive()) return false;
  try {
    return missedBillingDates(await readBookmark(), etDateString()).length > 0;
  } catch (err) {
    logger.warn(`[billing-monthly-catchup] bookmark read failed (${err.code || err.name || 'error'}) — skipping this catch-up tick`);
    return false;
  }
}

/**
 * The catch-up tick body (inside runExclusive('billing-monthly'), the 8:00 run's own lock).
 * Re-reads the bookmark under the lock (a failed read throws), then bills each missed date in
 * order and moves the bookmark after each one, so a date that throws is retried by the next
 * tick and the dates before it are not.
 */
async function runMonthlyBillingCatchUp() {
  if (!billingMonthlyCatchupLive()) return { skipped: 'gate_off' };
  const dates = missedBillingDates(await readBookmark(), etDateString());
  if (!dates.length) return { skipped: 'nothing_owed' };
  const BillingCron = require('./billing-cron');
  const runs = [];
  for (const billingDate of dates) {
    const result = await BillingCron.processMonthlyBilling({ billingDate });
    await writeBookmark(billingDate);
    runs.push(result);
    logger.warn(`[billing-monthly-catchup] billed missed date ${billingDate}: ${result.charged} charged, ${result.processing} processing, ${result.failed} failed, ${result.skipped} skipped`);
  }
  return { runs };
}

module.exports = {
  runMonthlyBillingTick,
  catchUpNeeded,
  runMonthlyBillingCatchUp,
  _private: { missedBillingDates, readBookmark, writeBookmark, BOOKMARK_KEY },
};
