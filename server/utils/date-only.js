const { TZ } = require('./datetime-et');

function dateOnlyString(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return match ? match[1] : null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getUTCFullYear(),
      String(value.getUTCMonth() + 1).padStart(2, '0'),
      String(value.getUTCDate()).padStart(2, '0'),
    ].join('-');
  }

  return null;
}

// Calendar-exact "+ N months" on a date-only value, clamped to the target
// month's last day (Jan 31 + 1 → Feb 28/29). Returns the YYYY-MM-DD string or
// null for an unparseable input. Shared by the prepay renewal schedule and the
// termite annual agreement's coverage end date so the clamping rule can't
// drift between them.
function addMonthsSameDay(value, months) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnlyString(value) || '');
  if (!match) return null;
  const year = Number(match[1]);
  const day = Number(match[3]);
  const monthIndex = Number(match[2]) - 1 + Number(months || 0);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = (((monthIndex % 12) + 12) % 12) + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0, 12, 0, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

function dateOnlyAtNoonUtc(value) {
  const ymd = dateOnlyString(value);
  return ymd ? new Date(`${ymd}T12:00:00Z`) : null;
}

function formatDateOnly(value, options = {}) {
  const { fallback = '', ...intlOptions } = options;
  const dt = dateOnlyAtNoonUtc(value);
  if (!dt) return fallback;
  return dt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: TZ,
    ...intlOptions,
  });
}

function formatDisplayDate(value, options = {}) {
  const { fallback = '', ...intlOptions } = options;
  if (!value) return fallback;

  if (
    typeof value === 'string' &&
    /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.000)?)?(?:Z|[+-]00:00)?)?$/.test(value)
  ) {
    return formatDateOnly(value, options);
  }

  if (
    value instanceof Date &&
    !Number.isNaN(value.getTime()) &&
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  ) {
    return formatDateOnly(value, options);
  }

  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return fallback;
  return dt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: TZ,
    ...intlOptions,
  });
}

// Strict YYYY-MM-DD validator for date-only INPUT (calendar round-trip via
// Date.UTC; rejects shapes an ISO parse would accept but PostgreSQL `date`
// cannot store, e.g. year 0000). Shared by the compliance licensing surface
// and staff registration so the two routes can never disagree on what a
// valid license_expiry is.
function validDateOnly(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

module.exports = {
  addMonthsSameDay,
  dateOnlyString,
  dateOnlyAtNoonUtc,
  formatDateOnly,
  formatDisplayDate,
  validDateOnly,
};
