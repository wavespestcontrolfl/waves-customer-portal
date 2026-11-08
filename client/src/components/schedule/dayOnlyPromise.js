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

const SHORT_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Tue, Nov 10" from a 'YYYY-MM-DD' (or ISO) date text; '' when it is not a calendar date. */
function shortDay(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return SHORT_DAY.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

/**
 * The badge text for what the customer was told (`told` from the admin schedule feed), or '' for nothing to show. It shows
 * the PROMISE, never the visit's current window (a visit's window is the job's length, and a silent move changes it):
 * level 'day' -> "Told: day only"; level 'hour' -> "Told: {told.window}" (the arrival range the customer heard), or
 * "Told: time not recorded" when the slot is unknown; level 'none' or no `told` (gate off, outside the next 14 days, or a
 * failed read) -> ''. When the promised date (told.date) is known and differs from the visit's current date
 * (`currentDate`, 'YYYY-MM-DD'), the short date leads: "Told: Tue, Nov 10, 9:00 AM - 11:00 AM".
 */
export function toldBadgeText(told, currentDate) {
  if (!told || typeof told !== 'object') return '';
  if (told.level !== 'day' && told.level !== 'hour') return '';
  const body = told.level === 'day' ? 'day only' : (told.window || 'time not recorded');
  const promisedDay = told.date && String(told.date).slice(0, 10) !== String(currentDate || '').slice(0, 10) ? shortDay(told.date) : '';
  return `Told: ${promisedDay ? `${promisedDay}, ` : ''}${body}`;
}
