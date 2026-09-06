const { toDateStr } = require('../auto-dispatch/dates');

// Manual schedule writers share this lifecycle; auto-dispatch itself keeps
// the original bound. Never create a handoff or clear one on an echoed save.
function recurringDispatchDuePatch(row, changes) {
  if (!row?.recurring_dispatch_due_date) return {};
  const date = changes.scheduled_date !== undefined ? changes.scheduled_date : row.scheduled_date;
  const start = changes.window_start !== undefined ? changes.window_start : row.window_start;
  if (toDateStr(date) === toDateStr(row.scheduled_date)
    && String(start || '').slice(0, 5) === String(row.window_start || '').slice(0, 5)) return {};
  return { recurring_dispatch_due_date: start ? null : toDateStr(date) };
}

module.exports = { recurringDispatchDuePatch };
