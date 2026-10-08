/**
 * Staff edit-screen placement → auto-dispatch lock.
 *
 * PUT /:id/update-details writes a visit's date and window straight to the row:
 * no rebooker, no reschedule_log row, and a date-exception stamp only when the
 * date moves. So the person-placed guard (eligibility.isPersonPlacedVisit) cannot
 * see a staff window-only edit, and the nightly auto-dispatch run could move a
 * time staff just chose (known limit of #6055). The edit now sets the visit's
 * own auto_dispatch_locked flag instead — the existing staff lock every
 * auto-dispatch path already honors (eligibility MANUALLY_LOCKED, apply.js
 * re-read). Staff see and clear it with the "Keep auto-dispatch off this visit"
 * box on the edit form (PATCH /admin/auto-dispatch/services/:id/lock). No reschedule_log
 * row is written, so the ~20 readers of that table see no change.
 *
 * Pure: decides from the locked row before the edit and the update about to be
 * written. The edit route merges staffEditLockPatch() in its occupancy step, next
 * to recurringDispatchDuePatch().
 */
const { toDateStr } = require('./dates');

// en_route / on_site count too: the edit route rewinds a moved live visit to
// 'confirmed' later in the same save, so the status this save persists is live.
const LIVE_STATUSES = new Set(['pending', 'confirmed', 'en_route', 'on_site']);
const hhmm = (t) => (t == null || t === '' ? null : String(t).slice(0, 5));

// True when this edit puts a live recurring child occurrence on a slot a person
// chose: its date or its window actually changes. A same-slot save, a field-only
// edit, a cleared window (unplacing) and non-recurring / template / terminal rows
// never lock.
function staffEditLocksVisit(before, updates) {
  if (!before || !updates) return false;
  if (before.is_recurring !== true || before.recurring_parent_id == null) return false;
  if (!LIVE_STATUSES.has(String(updates.status || before.status || ''))) return false;
  const dateChanged = updates.scheduled_date !== undefined
    && toDateStr(updates.scheduled_date) !== toDateStr(before.scheduled_date);
  const startChanged = updates.window_start !== undefined && hhmm(updates.window_start) !== hhmm(before.window_start);
  const endChanged = updates.window_end !== undefined && hhmm(updates.window_end) !== hhmm(before.window_end);
  if (!dateChanged && !startChanged && !endChanged) return false;
  const landsWithoutWindow = updates.window_start === null
    || (updates.window_start === undefined && before.window_start == null);
  return !landsWithoutWindow;
}

// The update patch for the edit route, in the same shape as
// recurringDispatchDuePatch: the columns to merge into this save.
function staffEditLockPatch(row, updates) {
  return staffEditLocksVisit(row, updates) ? { auto_dispatch_locked: true } : {};
}

module.exports = { staffEditLocksVisit, staffEditLockPatch };
