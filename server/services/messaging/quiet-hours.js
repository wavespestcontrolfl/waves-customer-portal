const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 20;
const DEFAULT_REVIEW_REQUEST_START_HOUR = 9;
const DEFAULT_REVIEW_REQUEST_END_HOUR = 17;
const TIME_ZONE = 'America/New_York';

const QUIET_ENFORCED_PURPOSES = new Set([
  'estimate_followup',
  'booking_abandonment_followup',
  'missed_call_followup',
  'review_request',
  'referral',
  'retention',
  'marketing',
]);

function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function etParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

function dateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function nthWeekdayOfMonth(year, month, weekdayIndex, nth) {
  const date = new Date(Date.UTC(year, month - 1, 1, 12));
  const first = date.getUTCDay();
  const offset = (weekdayIndex - first + 7) % 7;
  return 1 + offset + (nth - 1) * 7;
}

function lastWeekdayOfMonth(year, month, weekdayIndex) {
  const date = new Date(Date.UTC(year, month, 0, 12));
  const lastDay = date.getUTCDate();
  const last = date.getUTCDay();
  return lastDay - ((last - weekdayIndex + 7) % 7);
}

function observedFixedHoliday(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const dow = date.getUTCDay();
  if (dow === 0) {
    const observed = new Date(Date.UTC(year, month - 1, day + 1, 12));
    return `${observed.getUTCFullYear()}-${String(observed.getUTCMonth() + 1).padStart(2, '0')}-${String(observed.getUTCDate()).padStart(2, '0')}`;
  }
  if (dow === 6) {
    const observed = new Date(Date.UTC(year, month - 1, day - 1, 12));
    return `${observed.getUTCFullYear()}-${String(observed.getUTCMonth() + 1).padStart(2, '0')}-${String(observed.getUTCDate()).padStart(2, '0')}`;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function federalHolidayKeys(year) {
  return new Set([
    `${year}-01-01`,
    observedFixedHoliday(year, 1, 1),
    `${year}-01-${String(nthWeekdayOfMonth(year, 1, 1, 3)).padStart(2, '0')}`,
    `${year}-02-${String(nthWeekdayOfMonth(year, 2, 1, 3)).padStart(2, '0')}`,
    `${year}-05-${String(lastWeekdayOfMonth(year, 5, 1)).padStart(2, '0')}`,
    `${year}-06-19`,
    observedFixedHoliday(year, 6, 19),
    `${year}-07-04`,
    observedFixedHoliday(year, 7, 4),
    `${year}-09-${String(nthWeekdayOfMonth(year, 9, 1, 1)).padStart(2, '0')}`,
    `${year}-10-${String(nthWeekdayOfMonth(year, 10, 1, 2)).padStart(2, '0')}`,
    `${year}-11-11`,
    observedFixedHoliday(year, 11, 11),
    `${year}-11-${String(nthWeekdayOfMonth(year, 11, 4, 4)).padStart(2, '0')}`,
    `${year}-12-25`,
    observedFixedHoliday(year, 12, 25),
  ]);
}

function isFederalHolidayET(date) {
  const parts = etParts(date);
  const key = dateKey(parts);
  return federalHolidayKeys(parts.year - 1).has(key)
    || federalHolidayKeys(parts.year).has(key)
    || federalHolidayKeys(parts.year + 1).has(key);
}

function shouldEnforceQuietHours(input, policy) {
  if (process.env.SMS_QUIET_HOURS_ENABLED === 'false') return false;
  if (!input || input.channel !== 'sms') return false;
  if (input.metadata?.quietHoursOverride === true) return false;
  if (input.audience === 'internal' || input.audience === 'admin' || input.audience === 'tech') return false;
  if (policy?.requireConsent === 'marketing') return true;
  return QUIET_ENFORCED_PURPOSES.has(input.purpose);
}

function quietWindowFor(input) {
  if (input?.purpose === 'review_request') {
    return {
      startHour: intEnv('SMS_REVIEW_REQUEST_START_HOUR', DEFAULT_REVIEW_REQUEST_START_HOUR),
      endHour: intEnv('SMS_REVIEW_REQUEST_END_HOUR', DEFAULT_REVIEW_REQUEST_END_HOUR),
    };
  }
  return {
    startHour: intEnv('SMS_FL_QUIET_START_HOUR', DEFAULT_START_HOUR),
    endHour: intEnv('SMS_FL_QUIET_END_HOUR', DEFAULT_END_HOUR),
  };
}

function nextAllowedSendAt(fromDate = new Date(), input = null) {
  const { startHour, endHour } = quietWindowFor(input);
  const candidate = new Date(fromDate.getTime());
  candidate.setUTCSeconds(0, 0);

  for (let i = 0; i < 7 * 24 * 4; i += 1) {
    const parts = etParts(candidate);
    if (!isFederalHolidayET(candidate) && parts.hour >= startHour && parts.hour < endHour) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 15);
  }

  return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
}

function checkFloridaQuietHours(input, policy, now = new Date()) {
  if (!shouldEnforceQuietHours(input, policy)) return { ok: true };
  const { startHour, endHour } = quietWindowFor(input);
  const parts = etParts(now);

  if (isFederalHolidayET(now)) {
    return {
      ok: false,
      code: 'QUIET_HOURS_HOLD',
      reason: 'Florida SMS quiet-hours policy holds non-urgent sends on federal holidays.',
      nextAllowedAt: nextAllowedSendAt(now, input),
    };
  }

  if (parts.hour < startHour || parts.hour >= endHour) {
    return {
      ok: false,
      code: 'QUIET_HOURS_HOLD',
      reason: `Florida SMS quiet-hours policy allows non-urgent sends from ${startHour}:00 to ${endHour}:00 ET.`,
      nextAllowedAt: nextAllowedSendAt(now, input),
    };
  }

  return { ok: true };
}

module.exports = {
  checkFloridaQuietHours,
  shouldEnforceQuietHours,
  nextAllowedSendAt,
  isFederalHolidayET,
  _internals: { etParts, federalHolidayKeys, quietWindowFor },
};
