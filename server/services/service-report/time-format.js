const DEFAULT_TIME_ZONE = 'America/New_York';

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatReadyTime(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = normalizeDate(value);
  if (!date) return '';
  return date.toLocaleTimeString('en-US', {
    timeZone: timeZone || DEFAULT_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatVisitLabel(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = normalizeDate(value);
  if (!date) return '';
  return date.toLocaleDateString('en-US', {
    timeZone: timeZone || DEFAULT_TIME_ZONE,
    month: 'short',
    day: '2-digit',
  });
}

module.exports = {
  DEFAULT_TIME_ZONE,
  formatReadyTime,
  formatVisitLabel,
  normalizeDate,
};
