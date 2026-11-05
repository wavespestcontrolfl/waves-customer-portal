'use strict';

// The 8:00 AM banner (GATE_MORNING_BANNER, owner 2026-11-03, "ok add", choice C: "At 8 AM, one banner tells you how
// many items wait for you, and it opens your alert list. This takes the place of a banner for each of your other
// action items").
//
// ONE phone banner a day to the admin phones: "N items wait for you", with the three busiest areas in the body
// ("Comms 6 · Schedule 3 · Billing 2"). A tap opens the dashboard with the alert list showing (?bell=open, read by
// NotificationBell).
//
// What counts is what the bell's list shows as work for a person, judged by needs-me.js mapAlertRow like the Monday
// review bell does: an open (not done) admin alert row, a known needs-you or broken severity, `who` = person, never an
// "unsorted" row, never an Activity-only row (the bell never shows it), never a row the owner sent to Claude. The
// dashboard's standing counts are left out on purpose: each one is already echoed by an alert row or is a number on a
// page the owner opens anyway, and counting both would double the total. Nothing waiting = no banner.
//
// The banner goes out through the trigger registry (waiting_summary) pushOnly: no bell row, the per-admin Push Settings
// switch, sound and badge are triggerNotification's, and only admin-role phones get it (the type is not techVisible).
// The title and body carry counts and area names only, no customer data.
//
// Once per ET day: scheduler.js runs this under runExclusive, which only stops two instances running AT THE SAME TIME.
// A second instance that starts after the first finished (a deploy overlap, a restart inside the minute) would send a
// second banner, so the send first takes an atomic sms_send_claims row keyed to the ET date, the same cross-process
// claim bi-briefing-sms.js uses. Only the claim holder sends. The claim is released when the send definitely did not
// happen (a thrown error, an error result, preferences unreadable); after any other outcome it stays, because a missed
// banner beats a doubled one. A day missed because the server was down at 8:00 is not made up.
//
// Sends nothing to a customer and calls no paid API. Off (the gate) = returns before any read.

const db = require('../models/db');
const logger = require('./logger');
const { morningBannerLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { AREAS } = require('./admin-alert-compose');

const CLAIM_PREFIX = 'morning_banner:';

// Open alert rows that wait for a person, as the bell's list judges them.
function waitsForPerson(item) {
  return item.kind === 'alert'
    && !item.unsorted
    && !item.activityOnly
    && !item.sent
    && item.who === 'person'
    && (item.severity === 'needs-you' || item.severity === 'broken');
}

// { count, total, areas: [{ area, count }] }. count = the waiting items nobody has read yet (owner 2026-11-04, "fix
// count": the first banner said 334, the whole open backlog, most of it read weeks before); total = every waiting item;
// areas = the unread ones by area, busiest first (ties in the catalog's own area order), every area listed.
function summarize(items) {
  const waiting = items.filter(waitsForPerson);
  const tally = new Map();
  for (const item of waiting.filter((w) => !w.readAt)) tally.set(item.area, (tally.get(item.area) || 0) + 1);
  const order = (area) => { const i = AREAS.indexOf(area); return i === -1 ? AREAS.length : i; };
  const areas = [...tally.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => (b.count - a.count) || (order(a.area) - order(b.area)));
  return { count: areas.reduce((sum, a) => sum + a.count, 0), total: waiting.length, areas };
}

async function countWaiting() {
  const { openAlertRows, mapAlertRow } = require('./needs-me');
  const rows = await openAlertRows('admin');
  return summarize(rows.map(mapAlertRow));
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
    logger.error(`[morning-banner] claim release failed for ${day}: ${err?.code || err?.message || 'error'}`);
  }
}

// The send for a day that has something waiting: claim the day, then the pushOnly banner. Never throws.
async function claimAndSend(day, { count, total, areas }) {
  let claimed;
  try {
    claimed = await claimDay(day);
  } catch (err) {
    logger.error(`[morning-banner] claim failed for ${day}: ${err?.code || err?.message || 'error'}`);
    return { count, sent: false, error: 'claim_failed' };
  }
  if (!claimed) {
    logger.info(`[morning-banner] ${day}: already sent or in flight, skipped`);
    return { count, sent: false, skipped: 'already_claimed' };
  }
  try {
    const { triggerNotification } = require('./notification-triggers');
    const result = await triggerNotification('waiting_summary', { count, total, areas, day }, { pushOnly: true });
    if (!result || result.error || result.prefsUnavailable) {
      await releaseDay(day);
      logger.error(`[morning-banner] ${day}: banner not sent (${result?.error ? 'dispatch error' : result?.prefsUnavailable ? 'preferences unavailable' : 'no result'})`);
      return { count, sent: false, error: 'dispatch_failed' };
    }
    logger.info(`[morning-banner] ${day}: ${count} unread of ${total} waiting, banner sent`);
    return { count, sent: true, result };
  } catch (err) {
    await releaseDay(day);
    logger.error(`[morning-banner] ${day}: banner failed: ${err?.message || 'error'}`);
    return { count, sent: false, error: 'dispatch_failed' };
  }
}

// Never throws. { skipped } | { count, sent: false, skipped | error } | { count, sent: true, result }.
async function runMorningBanner({ now = new Date() } = {}) {
  if (!morningBannerLive()) return { skipped: 'gate_off' };
  const day = etDateString(now);
  let summary;
  try {
    summary = await countWaiting();
  } catch (err) {
    logger.error(`[morning-banner] count failed: ${err?.message || 'error'}`);
    return { count: 0, sent: false, error: 'count_failed' };
  }
  // Nothing unread = no banner, even with read items still open: the bell already shows those.
  if (summary.count === 0) {
    logger.info(`[morning-banner] ${day}: 0 unread of ${summary.total} waiting, no banner`);
    return { count: 0, sent: false, skipped: 'nothing_waiting' };
  }
  return claimAndSend(day, summary);
}

module.exports = { runMorningBanner, summarize, waitsForPerson };
