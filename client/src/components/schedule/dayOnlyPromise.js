// GATE_DAY_ONLY_PROMISE part E (owner 2026-11-05 "D2 a", 2026-11-06 "office"): the office's words and request fields for
// the "Customer asked for this time" box and the "Told: ..." badge. Pure helpers, no styles, so the Tier 1 dialogs and the
// legacy inline-style windows share one set of words. The gate reaches the client as the `day_only_promise` flag on
// GET /api/admin/feature-flags (useFeatureFlag). Gate off: no box, no field, no badge.
import { etDatetimeLocalToISO } from '../../lib/timezone';

export const ASKED_TIME_LABEL = 'Customer asked for this time';
export const PHONE_SCRIPT_HINT = "Promise the day only: 'We'll text your arrival window the day before.'";
export const ASKED_TIME_CHECKED_HINT = 'Tell the customer this time.';

// The server's DAY_PROMISE_CUTOFF_HOURS (services/time-promise.js): inside this many hours the 24-hour text takes over, so no
// sender promises only the day. A server test pins this number to the server's.
export const DAY_PROMISE_CUTOFF_HOURS = 24.25;

/** Does the chosen slot start more than the cutoff from now? `slot` = { date 'YYYY-MM-DD', start 'HH:MM' (ET), timeChosen }.
 *  No date, no start or a time not chosen yet: false (the server's rule for a missing start: window copy stays). */
export function startsBeyondCutoff(slot, now = new Date()) {
  if (!slot || slot.timeChosen === false) return false;
  const iso = etDatetimeLocalToISO(`${String(slot.date || '').slice(0, 10)}T${String(slot.start || '').slice(0, 5)}`);
  return iso !== null && (Date.parse(iso) - now.getTime()) / 3600000 > DAY_PROMISE_CUTOFF_HOURS;
}

/** Will the office be able to promise only the day for this slot? The server's rule (time-promise.shouldPromiseDayOnly): the
 *  slot starts after the cutoff AND the customer's 24-hour reminder will go out (`slot.reminder24hOn === true`). A missing or
 *  unknown reminder answer reads as "will not go out", as the senders read unreadable preferences. */
export function dayScriptApplies(slot, now = new Date()) {
  return !!slot && slot.reminder24hOn === true && changesDate(slot) && startsBeyondCutoff(slot, now);
}

/** The MOVE rule of time-promise.dayOnlyMoveDecision: a same-date re-time always names the new window, so only a change of
 *  DATE can be promised as the day. `slot.originalDate` (the visit's date before this save) is given by the edit and
 *  reschedule windows; the booking window has none and is not a move. Both are plain 'YYYY-MM-DD' ET dates. */
function changesDate(slot) {
  if (!slot.originalDate) return true;
  return String(slot.date || '').slice(0, 10) !== String(slot.originalDate).slice(0, 10);
}

/** The helper line under the time picker. Box checked: "Tell the customer this time." Box unchecked: the day-only phone
 *  script only while the server would really promise only the day (dayScriptApplies); otherwise the same "Tell the customer
 *  this time." line, since the text with the window never comes. */
export function askedTimeHint(checked, slot, now = new Date()) {
  if (checked === true) return ASKED_TIME_CHECKED_HINT;
  return dayScriptApplies(slot, now) ? PHONE_SCRIPT_HINT : ASKED_TIME_CHECKED_HINT;
}

/** The slot the reschedule window's hint judges: the custom date and time while that picker is open, else the EARLIEST
 *  suggested option (if even that starts after the cutoff, every option does). `options` = the dialog's suggestions
 *  ({ date, suggestedWindow: { start } }). `originalDate`: the visit's date before the move. */
export function rescheduleHintSlot({ options, showManual, manualDate, manualTime, reminder24hOn, originalDate }) {
  if (showManual) return { date: manualDate, start: manualTime, reminder24hOn, originalDate };
  const picks = (options || []).map((o) => ({ date: o.date, start: String(o.suggestedWindow?.start || '').slice(0, 5) }));
  const earliest = picks.map((o) => `${o.date}T${o.start}`).sort()[0] || 'T';
  const [date, start] = earliest.split('T');
  // A suggestion on the visit's own date is a same-date re-time (window wording): the hint judges that one.
  const sameDate = originalDate ? picks.find((o) => String(o.date).slice(0, 10) === String(originalDate).slice(0, 10)) : null;
  return { date: sameDate ? sameDate.date : date, start: sameDate ? sameDate.start : start, reminder24hOn, originalDate };
}

/** The booking window's answer for the chosen customer (`answer` = { id, on, byProperty } from the schedule-estimates reply):
 *  no customer yet reads as a new customer with the table defaults (reminder on); an answer for another customer, or none yet,
 *  reads off. While property texts are enforced the reply carries each saved property's own answer (`byProperty`): the
 *  property the modal books decides, and with none selected (or none listed) the customer row does. */
export function reminderAnswerFor(answer, customer, propertyId) {
  if (!customer) return true;
  if (!answer || answer.id !== customer.id) return false;
  const own = answer.byProperty && propertyId ? answer.byProperty[propertyId] : undefined;
  return (own === undefined ? answer.on : own) === true;
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
