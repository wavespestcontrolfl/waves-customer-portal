'use strict';

// The 8:00 AM banner (owner 2026-11-03, "ok add", choice C: "At 8 AM, one banner tells you how
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
// Sends nothing to a customer and calls no paid API.

const logger = require('./logger');
const db = require('../models/db');
const { takeSendClaim, releaseSendClaim, claimScopedDay, releaseScopedDay } = require('./sms-send-claims');
const { etDateString } = require('../utils/datetime-et');
const { AREAS } = require('./admin-alert-compose');
const { isFullAccessEmail } = require('./intelligence-bar/ib-access');

const CLAIM_PREFIX = 'morning_banner:';

function isOwnerOnlyRow(row) {
  let meta = row?.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { return false; }
  }
  return Boolean(meta && typeof meta === 'object' && (meta.ownerOnly === true || meta.ownerOnly === 'true'));
}

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
  const rows = await openAlertRows('admin', null, true);
  const owner = summarize(rows.map(mapAlertRow));
  const sharedRows = rows.filter((r) => !isOwnerOnlyRow(r));
  const shared = sharedRows.length === rows.length ? owner : summarize(sharedRows.map(mapAlertRow));
  return { ...owner, shared };
}

async function claimKey(key) {
  return takeSendClaim(key);
}

async function releaseKey(key) {
  try {
    await releaseSendClaim(key);
  } catch (err) {
    logger.error(`[morning-banner] claim release failed for ${key}: ${err?.code || err?.message || 'error'}`);
  }
}

async function splitAdminIdsByOwnerAccess() {
  const admins = await db('technicians')
    .where({ active: true, role: 'admin' })
    .select('id', 'email');
  const ownerIds = [];
  const otherAdminIds = [];
  for (const admin of admins || []) {
    if (isFullAccessEmail(admin.email)) ownerIds.push(admin.id);
    else otherAdminIds.push(admin.id);
  }
  return { ownerIds, otherAdminIds };
}

function classifyDelivery(result) {
  if (!result || result.error || result.prefsUnavailable
    || result.pushFailed === 'recipient_lookup'
    || result.pushFailed === 'before_handoff') {
    return 'failed';
  }
  if (result.pushFailed) return 'uncertain';
  const sent = Number(result.push?.sent) || 0;
  const failed = Number(result.push?.failed) || 0;
  if (sent > 0) return 'sent';
  if (failed > 0) return 'failed';
  return 'skipped';
}

function deliveryFailureReason(result) {
  if (result?.error) return 'dispatch error';
  if (result?.prefsUnavailable) return 'preferences unavailable';
  if (result?.pushFailed) return result.pushFailed;
  if (result?.push?.failed > 0) return 'all devices failed';
  return 'no result';
}

async function sendClaimedAudience({ key, payload, triggerOptions }) {
  let claimed;
  try {
    claimed = await claimKey(key);
  } catch (err) {
    logger.error(`[morning-banner] claim failed for ${key}: ${err?.code || err?.message || 'error'}`);
    return { status: 'claim_failed' };
  }
  if (!claimed) return { status: 'already_claimed' };
  try {
    const { triggerNotification } = require('./notification-triggers');
    const result = await triggerNotification('waiting_summary', payload, triggerOptions);
    const verdict = classifyDelivery(result);
    if (verdict === 'failed') {
      await releaseKey(key);
      logger.error(`[morning-banner] ${key}: banner not sent (${deliveryFailureReason(result)})`);
      return { status: 'dispatch_failed' };
    }
    if (verdict === 'uncertain') {
      logger.warn(`[morning-banner] ${key}: banner delivery uncertain (${result.pushFailed}); keeping claim to avoid duplicates`);
    } else if (verdict === 'skipped') {
      logger.info(`[morning-banner] ${key}: no device accepted banner (opted out or no active subscription)`);
    }
    return { status: verdict, result };
  } catch (err) {
    await releaseKey(key);
    logger.error(`[morning-banner] ${key}: banner failed: ${err?.message || 'error'}`);
    return { status: 'dispatch_failed' };
  }
}

function buildAudiences(day, ownerSummary, sharedSummary, { ownerIds, otherAdminIds }) {
  const audiences = [];
  if (ownerSummary.count > 0 && ownerIds.length > 0) {
    audiences.push({
      key: `${CLAIM_PREFIX}${day}:owner`,
      payload: { count: ownerSummary.count, total: ownerSummary.total, areas: ownerSummary.areas, day },
      triggerOptions: { pushOnly: true, onlyUserIds: ownerIds },
    });
  }
  if (sharedSummary.count > 0 && otherAdminIds.length > 0) {
    audiences.push({
      key: `${CLAIM_PREFIX}${day}:shared`,
      payload: { count: sharedSummary.count, total: sharedSummary.total, areas: sharedSummary.areas, day },
      triggerOptions: { pushOnly: true, onlyUserIds: otherAdminIds },
    });
  }
  return audiences;
}

function summarizeOutcomes(day, ownerSummary, outcomes) {
  const byStatus = (s) => outcomes.find((o) => o.status === s);
  if (byStatus('claim_failed')) return { count: ownerSummary.count, sent: false, error: 'claim_failed' };
  if (byStatus('dispatch_failed')) return { count: ownerSummary.count, sent: false, error: 'dispatch_failed' };
  const uncertain = byStatus('uncertain');
  if (uncertain) return { count: ownerSummary.count, sent: false, uncertain: true, result: uncertain.result };
  const sent = byStatus('sent');
  if (sent) {
    logger.info(`[morning-banner] ${day}: ${ownerSummary.count} unread of ${ownerSummary.total} waiting, banner sent`);
    return { count: ownerSummary.count, sent: true, result: sent.result };
  }
  const skipped = byStatus('skipped');
  if (skipped) return { count: ownerSummary.count, sent: false, skipped: 'no_delivery', result: skipped.result };
  logger.info(`[morning-banner] ${day}: already sent or in flight, skipped`);
  return { count: ownerSummary.count, sent: false, skipped: 'already_claimed' };
}

// Always claim stable per-audience keys (`:owner` and `:shared`) so a same-day
// alert-mix change (shared-only -> mixed, or owner-only -> mixed) can never
// re-notify an audience that already received today's banner. Look up
// recipients BEFORE reserving any claim so a DB lookup failure leaves no
// stranded daily claim; reserve the legacy bare-date key alongside a `:scoped`
// marker in one transaction so both rollout orders never duplicate a banner AND
// an interrupted new run can safely resume unclaimed audiences.
async function dispatchScopedBanners(day, ownerSummary, sharedSummary) {
  const audiences = buildAudiences(day, ownerSummary, sharedSummary, await splitAdminIdsByOwnerAccess());
  if (audiences.length === 0) return { count: ownerSummary.count, sent: false, skipped: 'no_recipients' };

  const legacyKey = `${CLAIM_PREFIX}${day}`;
  const markerKey = `${CLAIM_PREFIX}${day}:scoped`;
  let gate;
  try {
    gate = await claimScopedDay(legacyKey, markerKey);
  } catch (err) {
    logger.error(`[morning-banner] legacy claim gate failed for ${day}: ${err?.code || err?.message || 'error'}`);
    return { count: ownerSummary.count, sent: false, error: 'claim_failed' };
  }
  if (!gate.allowed) {
    logger.info(`[morning-banner] ${day}: already sent or in flight, skipped`);
    return { count: ownerSummary.count, sent: false, skipped: 'already_claimed' };
  }

  const outcomes = await Promise.all(audiences.map(sendClaimedAudience));
  const keptStatuses = new Set(['sent', 'uncertain', 'skipped', 'already_claimed']);
  if (gate.reservedHere && !outcomes.some((o) => keptStatuses.has(o.status))) {
    try {
      await releaseScopedDay(legacyKey, markerKey);
    } catch (err) {
      logger.error(`[morning-banner] scoped day claim release failed for ${day}: ${err?.code || err?.message || 'error'}`);
    }
  }
  return summarizeOutcomes(day, ownerSummary, outcomes);
}

// The send for a day that has something waiting: claim per audience, then send pushOnly banners. Never throws.
async function claimAndSend(day, { count, total, areas, shared }) {
  const sharedSummary = shared || { count, total, areas };
  try {
    return await dispatchScopedBanners(day, { count, total, areas }, sharedSummary);
  } catch (err) {
    logger.error(`[morning-banner] ${day}: scoped banner failed: ${err?.message || 'error'}`);
    return { count, sent: false, error: 'dispatch_failed' };
  }
}

// Never throws. { skipped } | { count, sent: false, skipped | error } | { count, sent: true, result }.
async function runMorningBanner({ now = new Date() } = {}) {
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
