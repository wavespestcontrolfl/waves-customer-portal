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
 * - Unresolved customers hold the bookmark: processMonthlyBilling returns
 *   unresolvedCustomerIds, the customers it could not charge AND left nothing
 *   armed for (a read or lock error before the charge, an unpersisted
 *   deferral). A recorded decline is not one: its armed retry row is the
 *   recovery. A date with any is not marked finished, so the next catch-up
 *   re-runs it; the guards above skip everyone that run charged or tried.
 *   Bound: the hold lasts through the day after the billing date
 *   (HOLD_DAYS). A run of that date on a later day releases it (the bookmark
 *   moves past it) and raises one admin alert naming the count, so one
 *   customer who always fails re-runs the date at most about four times. The
 *   catch-up bills only this month, so the hold also ends with the month: the
 *   first bookmark read in a new month that finds an earlier month's dates
 *   unfinished raises one alert for that month. A date is released only once
 *   its alert row is saved (a new row, or the row its dedupe key already
 *   has): a failed alert write keeps the bookmark, so the next tick re-runs
 *   the date (charging nobody it already charged or tried) and raises the
 *   alert again. The same holds for the month alert.
 * - First run: with no bookmark yet, a gate-on 8:00 tick writes a boundary
 *   the day before today BEFORE it bills, so a first run that throws or
 *   leaves unresolved customers keeps today owed, and the hold and alert
 *   above cover it. No date before it is ever billed. Gate off writes no
 *   boundary.
 * - Honest failure (#7700 rule): the pre-lock read answers "skip" on a failed
 *   read and records nothing. The read under the lock throws, so runExclusive
 *   records a failure, never a false success.
 * - GATE_BILLING_MONTHLY_CATCHUP off: the catch-up ticks read and charge
 *   nothing; the 8:00 run is unchanged apart from the bookmark write.
 */
const db = require('../models/db');
const logger = require('./logger');
const {
  etDateString, addETDays, parseETDateTime, etCalendarDaysUntil, formatETDayDate,
} = require('../utils/datetime-et');
const { billingMonthlyCatchupLive } = require('../config/feature-gates');

const BOOKMARK_KEY = 'billing-monthly-billed-thru';
// A date with unresolved customers holds the bookmark through this many days after it.
const HOLD_DAYS = 1;

const nextDate = (ymd) => etDateString(addETDays(parseETDateTime(`${ymd}T12:00`), 1));
const previousDate = (ymd) => etDateString(addETDays(parseETDateTime(`${ymd}T12:00`), -1));

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

// One needs-you Billing alert, deduped on its subject for good (a date or a month rings once,
// even after a person marks it done, and a retry after a lost write finds the saved row).
// bell: true is the sanctioned opt-in for a needs-you money item (as autopay-sca-parked.js):
// with GATE_ADMIN_BELL_POLICY on, the billing category is not allowlisted and the alert would be
// dropped with no row. Never throws. Resolves true only when an alert row exists: notifyAdmin
// resolves null on a failed write and { id: null, suppressed: true } when nothing was written.
async function raiseBillingAlert(spec, detail) {
  try {
    const alert = await require('./admin-alert-compose').raiseAdminAlert('billing', {
      area: 'Billing', severity: 'needs-you', link: '/admin/invoices', who: 'person', ...spec,
    }, { detail, dedupeKey: spec.subject.id, bell: true });
    if (alert && !alert.suppressed && alert.id != null) return true;
    logger.error(`[billing-monthly-catchup] alert ${spec.subject.id} was not saved — the date stays pending and the next tick raises it again`);
  } catch (err) {
    logger.error(`[billing-monthly-catchup] alert ${spec.subject.id} failed: ${err.message} — the date stays pending and the next tick raises it again`);
  }
  return false;
}

/**
 * Whether a run's billing date counts as finished for the bookmark. A run with no
 * unresolved customers finishes it. One with unresolved customers holds the date through
 * HOLD_DAYS after it (the next catch-up re-runs it); a run on a later day raises one alert
 * naming the count and releases the date only when that alert was saved.
 */
async function finishesDate(result) {
  const ids = result.unresolvedCustomerIds || [];
  if (!ids.length) return true;
  if (-etCalendarDaysUntil(result.billingDate) <= HOLD_DAYS) {
    logger.warn(`[billing-monthly-catchup] ${ids.length} customer(s) of ${result.billingDate} failed before any charge and nothing is armed — bookmark held so the next catch-up re-runs the date`);
    return false;
  }
  const count = ids.length;
  return raiseBillingAlert({
    action: `charge ${count} Auto Pay customer${count === 1 ? '' : 's'} by hand`,
    why: `The ${formatETDayDate(parseETDateTime(`${result.billingDate}T12:00`))} monthly run failed before charging them, and two days of retries did not fix it.`,
    subject: { type: 'check', id: `billing-monthly-unbilled:${result.billingDate}` },
    doneWhen: 'dues_collected',
  }, `Monthly dues for billing date ${result.billingDate} were not charged and no retry is armed. Customer ids: ${ids.join(', ')}. Collect each with Charge now on the customer page.`);
}

// The catch-up bills only this month, so dates of an earlier month the bookmark never
// reached are not billed again. Raise one alert for that month (deduped per month). Resolves
// false only when that alert was owed and not saved: the caller then keeps the bookmark in the
// earlier month, so the next tick raises it again.
async function alertUnfinishedEarlierMonth(bookmark, today) {
  const monthStart = `${today.slice(0, 7)}-01`;
  if (!bookmark || nextDate(bookmark) >= monthStart) return true;
  const unfinished = etCalendarDaysUntil(monthStart, parseETDateTime(`${bookmark}T12:00`)) - 1;
  const lastMonth = previousDate(monthStart).slice(0, 7);
  return raiseBillingAlert({
    action: "check last month's Auto Pay run",
    why: `${unfinished} billing day${unfinished === 1 ? '' : 's'} of last month did not finish, so some monthly dues may be unpaid.`,
    subject: { type: 'check', id: `billing-monthly-unfinished:${lastMonth}` },
    doneWhen: 'month_reviewed',
  }, `The last finished monthly billing date is ${bookmark}. The ${unfinished} date(s) after it, before ${monthStart}, did not finish (a lost run, or customers the run could not charge). The catch-up does not bill an earlier month.`);
}

/**
 * The 8:00 AM ET tick body (inside runExclusive('billing-monthly')). It runs today's billing
 * exactly as before, then moves the bookmark to today, unless the gate is on and an earlier
 * date of this month is still owed: then the bookmark stays, so the catch-up bills that date
 * (and passes over today's customers, all already charged or tried). A run with unresolved
 * customers does not move it (finishesDate). With the gate on and no bookmark yet, it first
 * writes a boundary the day before today (startBoundary), so today stays owed for the catch-up
 * if the run throws or holds. An unsaved month alert keeps the bookmark. With the gate on, a failed bookmark read leaves the bookmark where it is; today's
 * billing has already run.
 */
// First gate-on 8:00 tick only: with no bookmark, mark the day before today as the boundary, so
// today is owed until a run finishes it and nothing earlier is ever billed. Never throws: a
// failed read or write leaves things as before (no bookmark, no backfill).
async function startBoundary() {
  try {
    if (!(await readBookmark())) await writeBookmark(previousDate(etDateString()));
  } catch (err) {
    logger.warn(`[billing-monthly-catchup] bookmark read before the 8:00 run failed (${err.code || err.name || 'error'}) — no boundary written`);
  }
}

async function runMonthlyBillingTick() {
  if (billingMonthlyCatchupLive()) await startBoundary();
  const result = await require('./billing-cron').processMonthlyBilling();
  if (!billingMonthlyCatchupLive()) {
    if (!result.unresolvedCustomerIds?.length) await writeBookmark(result.billingDate);
    return result;
  }
  let bookmark;
  try {
    bookmark = await readBookmark();
  } catch (err) {
    logger.warn(`[billing-monthly-catchup] bookmark read after the 8:00 run failed (${err.code || err.name || 'error'}) — bookmark left as it is`);
    return result;
  }
  if (!(await alertUnfinishedEarlierMonth(bookmark, result.billingDate))) return result;
  const owedBefore = missedBillingDates(bookmark, result.billingDate).filter((d) => d < result.billingDate);
  if (owedBefore.length) {
    logger.warn(`[billing-monthly-catchup] ${owedBefore.length} earlier billing date(s) still owed (${owedBefore.join(', ')}) — bookmark left for the catch-up`);
    return { ...result, owedBefore };
  }
  if (await finishesDate(result)) await writeBookmark(result.billingDate);
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
 * order. The bookmark moves after each finished date and stops at the first held one
 * (finishesDate), so a date that throws or holds is re-run by the next tick and the dates
 * before it are not. Later dates are still billed on time; their re-run skips everyone.
 */
async function runMonthlyBillingCatchUp() {
  if (!billingMonthlyCatchupLive()) return { skipped: 'gate_off' };
  const bookmark = await readBookmark();
  const today = etDateString();
  // An unsaved month alert keeps the bookmark in the earlier month for every date below.
  let held = !(await alertUnfinishedEarlierMonth(bookmark, today));
  const dates = missedBillingDates(bookmark, today);
  if (!dates.length) return { skipped: 'nothing_owed' };
  const BillingCron = require('./billing-cron');
  const runs = [];
  for (const billingDate of dates) {
    const result = await BillingCron.processMonthlyBilling({ billingDate });
    runs.push(result);
    logger.warn(`[billing-monthly-catchup] billed missed date ${billingDate}: ${result.charged} charged, ${result.processing} processing, ${result.failed} failed, ${result.skipped} skipped`);
    held = !(await finishesDate(result)) || held;
    if (!held) await writeBookmark(billingDate);
  }
  return { runs };
}

module.exports = {
  runMonthlyBillingTick,
  catchUpNeeded,
  runMonthlyBillingCatchUp,
  _private: { missedBillingDates, readBookmark, writeBookmark, BOOKMARK_KEY, HOLD_DAYS },
};
