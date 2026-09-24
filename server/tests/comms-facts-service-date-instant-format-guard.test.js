/**
 * Source guard: invoices.service_date is a Postgres DATE column (migration
 * 20260401000082_invoices.js:16, `t.date('service_date')`), never an
 * instant. node-postgres deserializes it as a local-midnight Date, which
 * under production's TZ=UTC container is UTC midnight — routing that
 * through an America/New_York INSTANT formatter (`toLocaleDateString(...,
 * { timeZone: ... })`) renders the PREVIOUS Eastern calendar day.
 *
 * Two customer-facing dunning paths hit this exact class (ADMIN-BUG-R23,
 * ADMIN-BUG-R51): server/services/invoice-followups.js and
 * server/services/late-payment-checker.js both used to build their SMS/email
 * "completed on <date>" clause with `new Date(row.service_date)
 * .toLocaleDateString('en-US', { ..., timeZone: 'America/New_York' })`
 * instead of the calendar-day-safe helpers (`formatDateOnly` from
 * server/utils/date-only.js, or `etCalendarDayOf` from
 * server/utils/datetime-et.js) that every sibling site already uses.
 *
 * This guard pins the fix and stops the class from regressing in either
 * file: any window around a `service_date` reference that ALSO contains an
 * instant `.toLocaleDateString(` call with a `timeZone` option fails, unless
 * the window also uses one of the calendar-safe helpers.
 */

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const GUARDED_FILES = [
  'services/invoice-followups.js',
  'services/late-payment-checker.js',
];
const WINDOW_SPAN = 6; // lines around a `service_date` mention to inspect

const SERVICE_DATE_RE = /\bservice_date\b/;
const INSTANT_TZ_FORMAT_RE = /toLocaleDateString\(/;
const TIMEZONE_OPTION_RE = /timeZone\s*:/;
const SAFE_HELPER_RE = /\b(formatDateOnly|etCalendarDayOf)\b/;

function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

function findViolations(file) {
  const abs = path.join(SERVER_ROOT, file);
  const src = stripComments(fs.readFileSync(abs, 'utf8'));
  const lines = src.split('\n');
  const violations = [];

  lines.forEach((line, idx) => {
    if (!SERVICE_DATE_RE.test(line)) return;
    const start = Math.max(0, idx - WINDOW_SPAN);
    const end = Math.min(lines.length, idx + WINDOW_SPAN + 1);
    const window = lines.slice(start, end).join('\n');
    if (!INSTANT_TZ_FORMAT_RE.test(window) || !TIMEZONE_OPTION_RE.test(window)) return;
    if (SAFE_HELPER_RE.test(window)) return;
    violations.push({ file, line: idx + 1, snippet: line.trim() });
  });

  return violations;
}

describe('service_date DATE column never routed through an instant timeZone formatter (ADMIN-BUG-R23/R51)', () => {
  test('the guarded files still exist (self-check against a silently-renamed/removed target)', () => {
    for (const file of GUARDED_FILES) {
      expect(fs.existsSync(path.join(SERVER_ROOT, file))).toBe(true);
    }
  });

  test('detects the known bad shape on a synthetic fixture (self-check against a regex regression)', () => {
    const bad = "const serviceDate = row.service_date\n  ? new Date(row.service_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })\n  : '';";
    const good = "const serviceDate = formatDateOnly(row.service_date, { fallback: '' });";
    const scan = (src) => {
      const lines = src.split('\n');
      const violations = [];
      lines.forEach((line, idx) => {
        if (!SERVICE_DATE_RE.test(line)) return;
        const window = lines.slice(Math.max(0, idx - WINDOW_SPAN), idx + WINDOW_SPAN + 1).join('\n');
        if (!INSTANT_TZ_FORMAT_RE.test(window) || !TIMEZONE_OPTION_RE.test(window)) return;
        if (SAFE_HELPER_RE.test(window)) return;
        violations.push(idx);
      });
      return violations;
    };
    expect(scan(bad).length).toBeGreaterThan(0);
    expect(scan(good).length).toBe(0);
  });

  test('invoice-followups.js and late-payment-checker.js format service_date only through a calendar-safe helper', () => {
    const violations = GUARDED_FILES.flatMap(findViolations);
    const message = violations
      .map((v) => `  server/${v.file}:${v.line}  ${v.snippet}`)
      .join('\n');
    if (violations.length) {
      throw new Error(
        `service_date (a DATE column) routed through an instant toLocaleDateString(..., { timeZone }) ` +
        `call — under production's TZ=UTC this renders the PREVIOUS Eastern calendar day (ADMIN-BUG-R23/R51). ` +
        `Use formatDateOnly (server/utils/date-only.js) or etCalendarDayOf (server/utils/datetime-et.js) instead.\n` +
        `Offending site(s):\n${message}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
