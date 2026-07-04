// The arrival window quoted to customers is ALWAYS 2 hours from the window
// start (owner directive). scheduled_services.window_end (and slot end times)
// is the job-duration block that drives scheduling/overlap — never quote it
// to a customer as the arrival window.
const ARRIVAL_WINDOW_MINUTES = 120;

function parseHHMM(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function formatSmsTime(value) {
  const parsed = parseHHMM(value);
  if (!parsed) return value;
  const suffix = parsed.hour >= 12 ? 'PM' : 'AM';
  const hour12 = parsed.hour % 12 || 12;
  return `${hour12}:${String(parsed.minute).padStart(2, '0')} ${suffix}`;
}

function formatSmsTimeRange(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);
  if (!match) return value;
  return `${formatSmsTime(match[1])} - ${formatSmsTime(match[2])}`;
}

// '09:00' / '09:00:00' → '09:00-11:00' — the customer-facing arrival range
// for a visit starting at `start`, ready for formatSmsTimeRange. Returns
// null when the start time is missing or malformed.
function arrivalWindowRange(start) {
  const parsed = parseHHMM(String(start || '').slice(0, 5));
  if (!parsed) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const endTotal = (parsed.hour * 60 + parsed.minute + ARRIVAL_WINDOW_MINUTES) % (24 * 60);
  return `${pad(parsed.hour)}:${pad(parsed.minute)}-${pad(Math.floor(endTotal / 60))}:${pad(endTotal % 60)}`;
}

function formatSmsTimeValue(value) {
  if (typeof value !== 'string') return value;
  if (parseHHMM(value)) return formatSmsTime(value);
  return formatSmsTimeRange(value);
}

function formatSmsTemplateVars(vars = {}) {
  return Object.fromEntries(
    Object.entries(vars || {}).map(([key, value]) => [key, formatSmsTimeValue(value)])
  );
}

module.exports = {
  ARRIVAL_WINDOW_MINUTES,
  arrivalWindowRange,
  formatSmsTime,
  formatSmsTimeRange,
  formatSmsTimeValue,
  formatSmsTemplateVars,
};
