'use strict';
// READ-ONLY — evidence formatting for the existing terminal reports. No I/O.
const CAPABILITIES = [
  'alerts', 'dunning', 'offline', 'lawn-progress', 'portal-chat', 'pest-forecast',
  'build-operation', 'corrections', 'lawn-diagnosis', 'product-use', 'photo-id', 'sms-booking',
];
const FIELDS = ['mergedCommit', 'deployment', 'configuration', 'exposure', 'usage', 'acceptance'];
const ROW_KEYS = new Set(['id', 'nextAction', ...FIELDS]);

function isOffsetTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', offsetHourText = '0', offsetMinuteText = '0'] = match;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    [yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText].map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59
    && Number.isFinite(Date.parse(value));
}

function hasText(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function inlineText(value) {
  return JSON.stringify(value).slice(1, -1).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function buildEvidence(input) {
  if (!input || !Array.isArray(input.capabilities)) throw new Error('build evidence needs a capabilities array');
  const supplied = new Map();
  for (const row of input.capabilities) {
    if (!row || !CAPABILITIES.includes(row.id) || supplied.has(row.id)) throw new Error('unknown or duplicate capability id');
    const unknownKey = Object.keys(row).find((key) => !ROW_KEYS.has(key));
    if (unknownKey) throw new Error(`${row.id} has unknown evidence key ${unknownKey}`);
    supplied.set(row.id, row);
  }
  return {
    basis: 'operator-supplied evidence; no live reads or release decisions',
    capabilities: CAPABILITIES.map((id) => {
      const row = supplied.get(id) || {};
      const result = { id };
      for (const field of FIELDS) {
        const cell = row[field];
        if (cell == null) { result[field] = null; continue; }
        if (typeof cell.value !== 'string' || !cell.value.trim()
          || !Array.isArray(cell.sources) || !cell.sources.length
          || cell.sources.some((source) => typeof source !== 'string' || !source.trim())
          || !isOffsetTimestamp(cell.observedAt)) {
          throw new Error(`${id}.${field} needs value, sources and offset-bearing observedAt`);
        }
        result[field] = { value: cell.value, sources: cell.sources, observedAt: cell.observedAt };
      }
      if (row.nextAction != null && (typeof row.nextAction !== 'string' || !row.nextAction.trim())) throw new Error(`${id}.nextAction must be text`);
      result.nextAction = row.nextAction
        || (FIELDS.some((field) => result[field] == null) ? 'Collect missing evidence' : 'No next action supplied');
      return result;
    }),
  };
}

function alertQuality(page) {
  const alerts = page.items.filter((item) => item.kind === 'alert');
  const warnings = page.warnings || [];
  return {
    scope: 'returned page only; open non-FYI work and unsorted alerts, after requested filters',
    pageItems: page.items.length,
    alertDenominator: alerts.length,
    standingConditions: page.items.length - alerts.length,
    morePages: Boolean(page.next),
    coverage: warnings.length ? 'partial' : 'available',
    unavailableSources: warnings,
    counts: {
      derived: alerts.filter((item) => item.derived).length,
      unsorted: alerts.filter((item) => item.unsorted).length,
      missingSubject: alerts.filter((item) => !hasText(item.subject?.type)
        || !((typeof item.subject?.id === 'string' && item.subject.id.trim())
          || (typeof item.subject?.id === 'number' && Number.isFinite(item.subject.id)))).length,
      missingWhy: alerts.filter((item) => !hasText(item.why)).length,
      missingDoneWhen: alerts.filter((item) => !hasText(item.doneWhen)).length,
      missingLink: alerts.filter((item) => !hasText(item.link)).length,
    },
    unverified: ['destination focus', 'clearing predicate behavior', 'repeat episodes', 'usefulness', 'rule fallbacks'],
  };
}

function formatBuildEvidence(report) {
  const rows = report.capabilities.map((row) => {
    const cells = FIELDS.map((field) => {
      const cell = row[field];
      return `  ${field}: ${cell ? `${inlineText(cell.value)} (observed ${cell.observedAt}; ${cell.sources.map(inlineText).join(', ')})` : 'unknown'}`;
    });
    return [row.id, ...cells, `  next: ${inlineText(row.nextAction)}`].join('\n');
  });
  return [report.basis, ...rows].join('\n\n');
}

module.exports = { buildEvidence, formatBuildEvidence, alertQuality };
