const DEFAULT_TIME_ZONE = 'America/New_York';

function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// DATE-only columns (service_date, assessment dates) parse to UTC midnight,
// which America/New_York formatting rolls back to the previous day. Anchor
// them at UTC noon before formatting — same shape as report-page-metadata's
// serviceDateToNoonUtc. True timestamps pass through normalizeDate untouched.
function dateOnlyToNoonUtc(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 12));
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (dateOnly) {
    return new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12));
  }
  return normalizeDate(value);
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

// Bare YYYY-MM-DD for filenames and stamps. pg hydrates DATE columns at the
// process's LOCAL midnight (pg-types parseDate does new Date(y, m, d)), so
// local getters read the calendar date back correctly whatever timezone the
// server runs in — toISOString would shift a day for zones ahead of UTC.
// Naive interpolation of the hydrated Date printed the full Date.toString()
// into customer-visible attachment names.
function dateOnlyStamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || '').trim());
  return m ? m[1] : '';
}

module.exports = {
  DEFAULT_TIME_ZONE,
  dateOnlyStamp,
  dateOnlyToNoonUtc,
  formatReadyTime,
  formatVisitLabel,
  normalizeDate,
};
