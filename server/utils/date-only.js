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

module.exports = {
  dateOnlyString,
  dateOnlyAtNoonUtc,
  formatDateOnly,
  formatDisplayDate,
};
