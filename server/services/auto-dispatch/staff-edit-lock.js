/**
 * The edit form's "Keep auto-dispatch off this visit" box → auto-dispatch lock.
 *
 * PUT /:id/update-details writes a visit's date and window straight to the row (no rebooker, no reschedule_log row).
 * The box is the staff lock every auto-dispatch path honors (eligibility MANUALLY_LOCKED, apply.js re-read). Staff tick
 * it when the customer asked for the day or time, and clear it the same way; the form sends it with the same save.
 *
 * A staff date or time change no longer ticks the box by itself (owner 2026-11-22, the fixed-visit rule: "i dont think
 * it matters if staff pick it", and that evening "this is all too limiting"). Until then a slot change on this screen
 * locked the occurrence, because this path writes no reschedule_log row for the old person-placed hold to read. That
 * hold is gone too: a staff placement alone no longer holds a visit (eligibility.isPersonPlacedVisit).
 *
 * Pure. Merged where the edit route builds `updates`, so a save that only flips the box is a real change.
 */

// The box's value now and the value the form opened with. Only a box the person actually flipped is a decision (that is
// how staff set or clear a lock). An untouched box says nothing, even when the form's copy of the row is stale, so it can
// never undo a lock another save set.
function autoDispatchBoxPatch(box = {}) {
  const flipped = typeof box.now === 'boolean' && typeof box.was === 'boolean' && box.now !== box.was;
  return flipped ? { auto_dispatch_locked: box.now } : {};
}

module.exports = { autoDispatchBoxPatch };
