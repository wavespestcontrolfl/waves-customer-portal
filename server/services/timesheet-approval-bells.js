/**
 * The admin bell for a timesheet week that waits for approval (owner "fix all", 2026-11-01), raised through
 * raiseAdminAlert (docs/admin-notifications.md) in category `payroll` with `bellDefault: true`. It replaces the
 * Monday 5 AM text to the owner's cell, which production silences (an owner-phone internal_alert is redirected to
 * internal_admin_alert, which the admin bell policy mutes), so nobody was told a week waited.
 * One bell per week (dedupeKey timesheets-approve:<weekStart>), who: person. It closes itself: the Monday cron closes it
 * when no week is pending, and approveWeek closes it after the last pending week is approved (settleWeekBell). Sends
 * nothing to a customer or staff member. A bell never blocks the cron or an approval: every function here swallows
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

// Weekly summaries of a week that are not approved and have worked time (a daily summary inside the week), the same
// set the Monday cron counts.
async function countPendingWeeks(conn, weekStart) {
  const row = await conn('time_weekly_summary')
    .where('time_weekly_summary.week_start', weekStart)
    .whereRaw("time_weekly_summary.status IS DISTINCT FROM 'approved'")
    .whereExists(function worked() {
      this.select(conn.raw('1')).from('time_entry_daily_summary')
        .whereRaw('time_entry_daily_summary.technician_id = time_weekly_summary.technician_id')
        .whereRaw('time_entry_daily_summary.work_date >= time_weekly_summary.week_start')
        .whereRaw('time_entry_daily_summary.work_date <= time_weekly_summary.week_end');
    })
    .count('* as n')
    .first();
  return Number(row && row.n) || 0;
}

// After an approval: close the week's bell once no weekly summary of that week still waits. Never throws.
async function settleWeekBell(weekStart, { conn = db, countPending = countPendingWeeks, episodes } = {}) {
  try {
    if (await countPending(conn, weekStart) > 0) return 0;
  } catch (err) {
    logger.warn(`[timesheet-approval] pending weeks not counted (${errTag(err)})`);
    return 0;
  }
  return closeWeekBell(weekStart, { conn, ...(episodes ? { episodes } : {}) });
}

module.exports = { raiseWeekBell, closeWeekBell, settleWeekBell, countPendingWeeks, specFor, keyFor };
