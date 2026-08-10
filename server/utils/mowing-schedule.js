/**
 * Formats a customer's mowing schedule (property_preferences.mowing_*) into a
 * one-line technician-facing alert.
 *
 * Lawn applications shouldn't go down right before or right after a cut, so
 * the mowing schedule the customer enters in the portal has to reach the
 * person standing on the lawn. Both day-view builders (admin-schedule.js
 * propertyAlerts and admin-dispatch.js alerts) render this text.
 *
 * mowing_days is jsonb — pg hands back a parsed array, but a legacy row could
 * hold a JSON string, so parse defensively and never throw into an alert
 * builder.
 */
const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Same wording as the portal's collapsed-section summary, so the customer and
// the technician read the identical phrase for the same stored value.
const TIME_LABELS = {
  morning: 'mornings',
  midday: 'midday',
  afternoon: 'afternoons',
  varies: 'time varies',
};

function parseDays(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const picked = new Set(raw.map((d) => String(d || '').trim()));
  return DAY_ORDER.filter((d) => picked.has(d));
}

function mowingAlertText(prefs) {
  const days = parseDays(prefs?.mowing_days);
  const timeLabel = TIME_LABELS[String(prefs?.mowing_time_of_day || '').trim()] || '';
  const notes = String(prefs?.mowing_notes || '').trim();

  let schedule = '';
  if (days.length && timeLabel) schedule = `${days.join(', ')} (${timeLabel})`;
  else if (days.length) schedule = days.join(', ');
  else if (timeLabel) schedule = timeLabel;

  if (!schedule) return notes ? `Mowing: ${notes}` : '';
  return notes ? `Mows: ${schedule} — ${notes}` : `Mows: ${schedule}`;
}

module.exports = { mowingAlertText, parseDays, DAY_ORDER, TIME_LABELS };
