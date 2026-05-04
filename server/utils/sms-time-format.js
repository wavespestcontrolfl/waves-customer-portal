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
  formatSmsTime,
  formatSmsTimeRange,
  formatSmsTimeValue,
  formatSmsTemplateVars,
};
