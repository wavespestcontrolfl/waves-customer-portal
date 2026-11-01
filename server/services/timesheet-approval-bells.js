/**
 * The admin bell for a timesheet week that waits for approval (owner "fix all", 2026-11-01), raised through
 * raiseAdminAlert (docs/admin-notifications.md) in category `payroll` with `bellDefault: true`. It replaces the
 * Monday 5 AM text to the owner's cell, which production silences (an owner-phone internal_alert is redirected to
 * internal_admin_alert, which the admin bell policy mutes), so nobody was told a week waited.
 * One bell per week (dedupeKey timesheets-approve:<weekStart>), who: person. It closes itself: the Monday cron closes it
 * when the Approvals page lists no waiting week, and approveWeek closes it after the last pending week is approved
 * (settleWeekBell). Both count with the Approvals page's own list (getPendingWeeks). Sends nothing to a customer or
 * staff member. A bell never blocks the cron or an approval: every function here swallows
 * its own error.
 */
const db = require('../models/db');
const logger = require('./logger');
const { shortDateET } = require('./admin-alert-names');

const CATEGORY = 'payroll';
const KEY_PREFIX = 'timesheets-approve:';
const RESOLUTION = 'Every timesheet for that week is approved';

const keyFor = (weekStart) => `${KEY_PREFIX}${weekStart}`;
const errTag = (err) => (err && (err.code || err.name)) || 'error';

// The bell copy. The headline is "Billing — <action>" (60 characters at most); the why is one sentence of 110 or fewer.
function specFor(weekStart, pendingCount) {
  const day = shortDateET(`${weekStart}T12:00:00Z`);
  const many = pendingCount !== 1;
  return {
    area: 'Billing',
    action: `approve the timesheets for the week of ${day}`,
    why: `${pendingCount} timesheet${many ? 's' : ''} for the week of ${day} ${many ? 'wait' : 'waits'}, and pay needs ${many ? 'them' : 'it'} approved first.`,
    severity: 'needs-you',
    link: `/admin/timetracking?tab=approvals&weekStart=${weekStart}`,
    subject: { type: 'check', id: `timesheets-week:${weekStart}` },
    doneWhen: 'timesheets_approved',
    who: 'person',
  };
}

// One bell for a week that waits. Never throws. Returns true when a bell was written.
async function raiseWeekBell(weekStart, pendingCount, { raise = require('./admin-alert-compose').raiseAdminAlert } = {}) {
  try {
    const result = await raise(CATEGORY, specFor(weekStart, pendingCount), {
      dedupeKey: keyFor(weekStart),
      bellDefault: true,
      metadata: { weekStart, pendingCount, reminder: 'timesheet_approval' },
    });
    return Boolean(result && result.id);
  } catch (err) {
    logger.error(`[timesheet-approval] bell not raised (${errTag(err)})`);
    return false;
  }
}

// Closes the bell of one week. Never throws. Returns the number of bell rows closed.
async function closeWeekBell(weekStart, { conn = db, episodes = require('./admin-alert-episodes') } = {}) {
  try {
    return Number(await episodes.closeAdminAlertKeys(conn, [keyFor(weekStart)], 'timesheets_approved', { resolution: RESOLUTION })) || 0;
  } catch (err) {
    logger.warn(`[timesheet-approval] bell not closed (${errTag(err)})`);
    return 0;
  }
}

// How many weeks of this payroll week still wait for approval: the Approvals page's own list (getPendingWeeks), so the
// bell and the page agree. That list covers every technician with worked time (deactivated ones too) and builds a
// missing weekly summary on demand. Required at call time: timesheet-approval.js requires this module.
async function countPendingWeeks(weekStart) {
  const { getPendingWeeks } = require('./timesheet-approval');
  return (await getPendingWeeks(weekStart)).filter((week) => week.status !== 'approved').length;
}

// After an approval: close the week's bell once the Approvals page lists no week that still waits. A count that fails
// closes nothing. Never throws.
async function settleWeekBell(weekStart, { conn = db, countPending = countPendingWeeks, episodes } = {}) {
  try {
    if (await countPending(weekStart) > 0) return 0;
  } catch (err) {
    logger.warn(`[timesheet-approval] pending weeks not counted (${errTag(err)})`);
    return 0;
  }
  return closeWeekBell(weekStart, { conn, ...(episodes ? { episodes } : {}) });
}

// The Monday cron: one bell while the Approvals page lists a week that waits, none (and an open one closes) when it
// lists none. When the count fails, nothing closes; the cron's own count of its active technicians (fallbackCount)
// still raises the bell, so a week that waits is never missed. Never throws.
async function reconcileWeekBell(weekStart, { fallbackCount = 0, countPending = countPendingWeeks, raise, conn, episodes } = {}) {
  let waiting = null;
  try {
    waiting = await countPending(weekStart);
  } catch (err) {
    logger.warn(`[timesheet-approval] pending weeks not counted (${errTag(err)})`);
  }
  const count = waiting === null ? fallbackCount : waiting;
  if (count > 0) return raiseWeekBell(weekStart, count, raise ? { raise } : {});
  if (waiting === null) return false;
  return (await closeWeekBell(weekStart, { ...(conn ? { conn } : {}), ...(episodes ? { episodes } : {}) })) > 0;
}

module.exports = { raiseWeekBell, closeWeekBell, settleWeekBell, reconcileWeekBell, countPendingWeeks, specFor, keyFor };
