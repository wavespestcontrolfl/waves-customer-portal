/**
 * Resolve the review window for a Pest Pressure calculation.
 *
 * Window logic:
 *   monthly       — windows.monthly days back from serviceDate
 *   bimonthly     — windows.bimonthly days back
 *   quarterly     — windows.quarterly days back
 *   custom/other  — span from lastCompletedServiceDate to serviceDate.
 *                   If no prior service exists, fall back to
 *                   windows.fallbackDays back.
 *
 * Pure function: caller pre-fetches lastCompletedServiceDate and supplies
 * the configured windows. No DB access here.
 */

// Order matters: bi-monthly must be checked before monthly so the substring
// "monthly" inside "bi-monthly" doesn't capture the wrong bucket. Semi-
// annual must also be checked before any annual variants because "annual"
// is a substring of "semi-annual".
const FREQUENCY_PATTERNS = [
  { key: 'bimonthly', re: /\b(bi[-\s]?monthly|every[-\s]?other[-\s]?month|2[-\s]?month)\b/i },
  { key: 'semiannual', re: /\b(semi[-\s]?annual|every[-\s]?6[-\s]?months?|6[-\s]?month)\b/i },
  { key: 'quarterly', re: /\bquarterly\b/i },
  { key: 'monthly', re: /\bmonthly\b/i },
];

function detectFrequencyKey(serviceFrequency) {
  if (!serviceFrequency || typeof serviceFrequency !== 'string') return 'custom';
  for (const { key, re } of FREQUENCY_PATTERNS) {
    if (re.test(serviceFrequency)) return key;
  }
  return 'custom';
}

// Used by the recurring-frequency scope gate. Matches the explicit
// one-time / single-visit markers Waves uses on service_records.service_type
// ("One-Time Pest Treatment", "Single Visit Mosquito Event", "One-off
// Spot Treatment", etc.). Unknown frequencies (e.g. "General Pest Control",
// "Recurring Pest Control") are NOT one-time — those are real recurring
// jobs that just don't include a cadence word in the label, and the engine
// has a fallback review window for them. Don't widen this to "follow-up"
// or "callback" — both are extra visits between regular services on an
// active recurring plan and still deserve a Pest Pressure score.
function isOneTimeServiceLabel(serviceTypeText) {
  if (!serviceTypeText || typeof serviceTypeText !== 'string') return false;
  return /\b(one[-\s]?time|one[-\s]?off|single[-\s]?visit|just[-\s]?once|spot[-\s]?treatment)\b/i.test(serviceTypeText);
}

function subtractDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function resolveReviewWindow({ serviceFrequency, serviceDate, lastCompletedServiceDate = null, windows }) {
  const end = toDate(serviceDate);
  if (!end) {
    throw new TypeError('resolveReviewWindow: serviceDate is required');
  }
  if (!windows || typeof windows !== 'object') {
    throw new TypeError('resolveReviewWindow: windows config is required');
  }

  const key = detectFrequencyKey(serviceFrequency);

  if (key === 'monthly' || key === 'bimonthly' || key === 'quarterly' || key === 'semiannual') {
    const days = windows[key];
    return {
      start: subtractDays(end, days),
      end,
      days,
      frequencyKey: key,
      source: 'frequency',
    };
  }

  const lastDate = toDate(lastCompletedServiceDate);
  if (lastDate && lastDate < end) {
    const days = Math.max(1, Math.round((end - lastDate) / (24 * 60 * 60 * 1000)));
    return {
      start: lastDate,
      end,
      days,
      frequencyKey: 'custom',
      source: 'last_service',
    };
  }

  const fallback = windows.fallbackDays;
  return {
    start: subtractDays(end, fallback),
    end,
    days: fallback,
    frequencyKey: 'custom',
    source: 'fallback',
  };
}

module.exports = { resolveReviewWindow, detectFrequencyKey, isOneTimeServiceLabel };
