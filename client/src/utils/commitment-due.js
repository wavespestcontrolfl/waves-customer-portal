// The moment a commitment row is owed, as the server judges it: the stated
// or staffed deadline, pushed out to the end of an active snooze. Every
// client overdue check and label reads this so a snoozed callback is never
// recomputed as overdue while the server says it is not.
export function dueMoment(row) {
  const due = row?.effective_due_at || row?.due_at || null;
  if (!due) return null;
  const snoozed = row.snoozed_until ? new Date(row.snoozed_until).getTime() : NaN;
  return snoozed > new Date(due).getTime() ? row.snoozed_until : due;
}

export function isSnoozed(row, now = Date.now()) {
  return Boolean(row?.snoozed_until) && new Date(row.snoozed_until).getTime() > now;
}
