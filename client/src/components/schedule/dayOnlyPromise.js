// GATE_DAY_ONLY_PROMISE part E (owner 2026-11-05 "D2 a", 2026-11-06 "office"): the office's words and request fields for
// the "Customer asked for this time" box and the "Told: ..." badge. Pure helpers, no styles, so the Tier 1 dialogs and the
// legacy inline-style windows share one set of words. The gate reaches the client as the `day_only_promise` flag on
// GET /api/admin/feature-flags (useFeatureFlag). Gate off: no box, no field, no badge.

export const ASKED_TIME_LABEL = 'Customer asked for this time';
export const PHONE_SCRIPT_HINT = "Promise the day only: 'We'll text your arrival window the day before.'";
export const ASKED_TIME_CHECKED_HINT = 'Tell the customer this time.';

/** The helper line under the time picker: the phone script while the box is off, the set-time line while it is on. */
export function askedTimeHint(checked) {
  return checked === true ? ASKED_TIME_CHECKED_HINT : PHONE_SCRIPT_HINT;
}

/** The create request field: only a checked box sends it (the server stores true; nothing else is written). */
export function askedTimeCreateFields(enabled, checked) {
  return enabled === true && checked === true ? { customerAskedTime: true } : {};
}

/** The edit and reschedule request field: with the gate on, a move sends the box as true or false. Gate off: nothing. */
export function askedTimeMoveFields(enabled, checked) {
  return enabled === true ? { customerAskedTime: checked === true } : {};
}

/**
 * The badge text for what the customer was told (`told` from the admin schedule feed), or '' for nothing to show.
 * level 'day' -> "Told: day only"; level 'hour' -> "Told: {window}" (the visit's current window); level 'none' or no
 * `told` (gate off, outside the next 14 days, or a failed read) -> ''.
 */
export function toldBadgeText(told, windowLabel) {
  if (!told || typeof told !== 'object') return '';
  if (told.level === 'day') return 'Told: day only';
  if (told.level === 'hour') return windowLabel ? `Told: ${windowLabel}` : 'Told: an arrival window';
  return '';
}
