'use strict';

/**
 * Bid Desk bells that a saved change has finished (docs/admin-notifications.md 4.3). One function, used by the
 * operator's save (routes/admin-bid-desk.js) and by the bid that closes itself (index.js closeLapsedBids,
 * GATE_BID_DESK_AUTO_DATES), so both close exactly the same bells.
 */
const { openAdminAlertKeys, closeAdminAlertKeys } = require('../admin-alert-episodes');
const { OPEN_STATUSES } = require('./rules');

// Notifications whose condition a successful save has met leave the bell (docs/admin-notifications.md 4.3).
async function closeDoneAlerts(conn, bidId, before, after) {
  const prefixes = [];
  const reason = [];
  // Every bell on a closed SAM.gov notice asks for a decision, not a date (addendumSpec), so confirming a date leaves
  // them open.
  const keep = [];
  if (after.due_confirmed && (before.needs_date_confirmation || !before.due_confirmed) && !after.needs_date_confirmation) {
    prefixes.push(`bid-desk:addendum:${bidId}:`);
    reason.push('due_date_confirmed');
    keep.push(...(after.source_active === false ? [`bid-desk:addendum:${bidId}:sam:`] : []));
  }
  // A changed or cleared date retires the reminders sent for the old one.
  const dateOf = (row) => (row.due_at ? new Date(row.due_at).getTime() : null);
  if (dateOf(before) !== dateOf(after)) {
    prefixes.push(`bid-desk:remind:${bidId}:`);
    reason.push('due_date_changed');
  }
  // GATE_BID_CHECKLIST reminders: a changed or cleared date retires the reminder sent for the old one. This cleanup
  // is NOT behind the gate: the gate stops NEW reminders only, and a bell rung while it was on must still close when
  // the date changes or the bid is decided after it is turned off (turning it back on cannot repair a bell left open).
  const at = (row, key) => (row[key] ? new Date(row[key]).getTime() : null);
  if (at(before, 'questions_due_at') !== at(after, 'questions_due_at')) {
    prefixes.push(`bid-desk:remind-questions:${bidId}:`);
    reason.push('questions_date_changed');
  }
  if (at(before, 'job_walk_at') !== at(after, 'job_walk_at')) {
    prefixes.push(`bid-desk:remind-jobwalk:${bidId}:`);
    reason.push('job_walk_date_changed');
  }
  if (before.status === 'new' && after.status !== 'new') {
    prefixes.push(`bid-desk:new:${bidId}`);
    reason.push('bid_decided');
  }
  if (OPEN_STATUSES.includes(before.status) && !OPEN_STATUSES.includes(after.status)) {
    prefixes.push(`bid-desk:new:${bidId}`, `bid-desk:addendum:${bidId}:`, `bid-desk:remind:${bidId}:`);
    prefixes.push(`bid-desk:remind-questions:${bidId}:`, `bid-desk:remind-jobwalk:${bidId}:`);
    reason.push('bid_closed');
    keep.length = 0;
  }
  if (!prefixes.length) return 0;
  const keys = (await Promise.all([...new Set(prefixes)].map((prefix) => openAdminAlertKeys(conn, prefix)))).flat()
    .filter((key) => !keep.some((prefix) => key.startsWith(prefix)));
  return closeAdminAlertKeys(conn, keys, reason.join(','));
}

module.exports = { closeDoneAlerts };
