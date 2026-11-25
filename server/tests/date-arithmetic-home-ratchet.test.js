/**
 * Ratchet: calendar-day arithmetic lives in the shared date helpers.
 *
 * Code outside the helpers calls them instead of writing its own addDays, its
 * own setDate(getDate() + n) or its own n * 86400000. A private copy picks a
 * different clock (UTC, the server's zone, a fixed 24 hours), and Codex then
 * finds the gap one PR at a time: #8456, #8401 and #8012 each had a P1 where a
 * hand-rolled day step landed on the wrong day around midnight ET, a DST seam
 * or a month end.
 *
 * Homes (exempt from every rule below):
 *   server/utils/datetime-et.js          addETDays, addETBusinessDays,
 *                                        addETDaysAtWallClock, etDateString,
 *                                        etCalendarDaysUntil, validCalendarDate
 *   server/utils/staff-time-work-date.js addStaffWorkDays, staffWorkDate
 *   server/utils/date-only.js            dateOnlyString, validDateOnly,
 *                                        addMonthsSameDay
 *
 * Each rule is the code signature of day math written outside its home.
 * fixtures/date-arithmetic-homes.json is an upper bound per rule and per file:
 * a file may not gain a match, and a new file may not have one. A file that
 * loses matches passes as it is; lower its number when you are in there. A
 * file that reaches 0 must leave the baseline (the test fails until it does).
 * Comment lines and trailing // comments do not count. Deterministic,
 * filesystem only, no DB.
 *
 * Counts are per line, so a signature split over two lines is not seen.
 * False-positive shapes this skips on purpose:
 *   - addDay(totals, d), addedDays, addMonthsSameDay: not a day step, the name
 *     must be add<Qualifier>Days.
 *   - const { addETDays } = require(...) and const addETDays = require(...):
 *     an import, not a copy; the three helper names are never counted.
 *   - windowMs: 24 * 60 * 60 * 1000, new Date(Date.now() - 7 * 86400000) and
 *     other elapsed windows from now: a day-ms literal counts only on a line
 *     with no Date.now() that builds a Date
 *     (new Date(, Date.parse(, Date.UTC(, toISOString(, etDateString(,
 *     parseETDateTime() or as a one-day constant (const DAY_MS = 86400000;).
 *   - /^\d{4}-\d{2}-\d{2}T.../ and other timestamp patterns: a timestamp is not
 *     a date-only value; only a pattern that is the whole date counts.
 * Shapes it still counts (so the baseline holds them): new Date(x.getTime() +
 * n * 86400000) rolling windows, one-day TTL constants, and setUTCDate week math.
 *
 * Set DATE_ARITHMETIC_WRITE=<file> to write the current counts there as baseline JSON.
 */
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'date-arithmetic-homes.json');
const SKIP_DIRS = new Set([
  'node_modules', 'tests', '__tests__', '__mocks__', 'fixtures', 'contract-tests',
  'migrations', 'seeds', 'coverage', 'dist',
]);

const HOMES = [
  'utils/datetime-et.js',
  'utils/staff-time-work-date.js',
  'utils/date-only.js',
];
const USE = [
  'Use addETDays / etDateString / etCalendarDaysUntil / validCalendarDate (server/utils/datetime-et.js),',
  'addStaffWorkDays (server/utils/staff-time-work-date.js)',
  'or dateOnlyString / validDateOnly (server/utils/date-only.js).',
].join(' ');
const HELPER_NAMES = new Set(['addETDays', 'addETBusinessDays', 'addStaffWorkDays']);

// A one-day constant: const DAY_MS = 86400000;  or  = 24 * 60 * 60 * 1000;
const ONE_DAY_MS = '(?:86400000|86_400_000|864e5|24 *\\* *60 *\\* *60 *\\* *1000|60 *\\* *60 *\\* *24 *\\* *1000|1000 *\\* *60 *\\* *60 *\\* *24)';
const ANY_DAY_MS = new RegExp(`(?<![\\w.])${ONE_DAY_MS}(?![\\w.])|1000 *\\* *86400\\b|86400 *\\* *1000\\b`);
const DAY_MS_CONSTANT = new RegExp(`\\b(?:const|let|var)\\s+\\w+\\s*=\\s*${ONE_DAY_MS}\\s*;`);
const DATE_MACHINERY = /new Date\(|Date\.(?:parse|UTC)\(|\.toISOString\(|etDateString\(|parseETDateTime\(/;

const RULES = [
  {
    id: 'add-days-function',
    // function addDays( / const addDays = / const addDateStringDays = ...
    countLine: (rel, line) => [...line.matchAll(/(?:\bfunction\s+|\b(?:const|let|var)\s+)(add(?:[A-Z]\w*)?Days)\b(?!\s*=\s*require)/g)]
      .filter((m) => !HELPER_NAMES.has(m[1])).length,
    use: `Do not write your own addDays. ${USE}`,
  },
  {
    id: 'calendar-day-mutation',
    // d.setDate(d.getDate() + n), d.setUTCDate(d.getUTCDate() - n)
    signature: /\bset(?:UTC)?Date\([^;]*\bget(?:UTC)?Date\(\)\s*[+-]/g,
    use: `Do not step a Date a day at a time with setDate(getDate() + n). ${USE}`,
  },
  {
    id: 'day-ms-math',
    // n * 86400000 on a line that builds or reads a Date, or a one-day constant
    countLine: (rel, line) => ((ANY_DAY_MS.test(line) && DATE_MACHINERY.test(line) && !/Date\.now\(\)/.test(line)) || DAY_MS_CONSTANT.test(line) ? 1 : 0),
    use: `Do not add or subtract n * 86400000 (24 * 60 * 60 * 1000) to move a calendar day; a day is 23 or 25 hours across a DST seam. ${USE}`,
  },
  {
    id: 'date-only-regex',
    // /^\d{4}-\d{2}-\d{2}$/, /^(\d{4}-\d{2}-\d{2})/ : the whole pattern is the date
    signature: /\/\^\(?\\d\{4\}-\\d\{2\}-\\d\{2\}\)?\$?\/[a-z]*/g,
    use: `Do not write your own YYYY-MM-DD check. Use validDateOnly or dateOnlyString (server/utils/date-only.js), or validCalendarDate (server/utils/datetime-et.js). ${USE}`,
  },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const codeLines = (source) => source
  .split('\n')
  .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
  .map((line) => line.replace(/\s\/\/\s.*$/, ''));
const signatureCount = (signature) => (rel, line) => (line.match(signature) || []).length;

const SOURCES = walk(SERVER_ROOT).map((file) => ({
  rel: path.relative(SERVER_ROOT, file).split(path.sep).join('/'),
  lines: codeLines(fs.readFileSync(file, 'utf8')),
}));

function countsFor(rule) {
  const countLine = rule.countLine || signatureCount(rule.signature);
  const counts = {};
  for (const { rel, lines } of SOURCES) {
    if (HOMES.includes(rel)) continue;
    const n = lines.reduce((sum, line) => sum + countLine(rel, line), 0);
    if (n) counts[rel] = n;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.env.DATE_ARITHMETIC_WRITE) {
  fs.writeFileSync(
    process.env.DATE_ARITHMETIC_WRITE,
    `${JSON.stringify(Object.fromEntries(RULES.map((rule) => [rule.id, countsFor(rule)])), null, 2)}\n`,
  );
}

describe('calendar-day arithmetic stays in the shared date helpers', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

  test.each(RULES.map((rule) => [rule.id, rule]))('%s: no file gains a copy', (id, rule) => {
    const was = baseline[id] || {};
    const grew = Object.entries(countsFor(rule))
      .filter(([rel, n]) => n > (was[rel] || 0))
      .map(([rel, n]) => `${id} ${rel}: ${n} (baseline ${was[rel] || 0})`);
    expect(grew.length ? `${rule.use}\n  ${grew.join('\n  ')}` : '').toBe('');
  });

  test.each(RULES.map((rule) => [rule.id, rule]))('%s: a file that reached 0 leaves the baseline', (id, rule) => {
    const now = countsFor(rule);
    const stale = Object.entries(baseline[id] || {})
      .filter(([rel, n]) => !(now[rel] > 0) || !(n > 0))
      .map(([rel, n]) => `${id} ${rel}: baseline ${n}, now ${now[rel] || 0}`);
    expect(stale.length
      ? `Delete these entries from server/tests/fixtures/date-arithmetic-homes.json (the copy is gone):\n  ${stale.join('\n  ')}`
      : '').toBe('');
  });

  test('the baseline names only known rules', () => {
    expect(Object.keys(baseline).filter((id) => !RULES.some((rule) => rule.id === id))).toEqual([]);
  });

  test('every home file exists, so no message names a moved file', () => {
    expect(HOMES.filter((home) => !fs.existsSync(path.join(SERVER_ROOT, home)))).toEqual([]);
  });

  test('every helper the message names is still exported', () => {
    const exported = (file) => Object.keys(require(path.join(SERVER_ROOT, file)));
    expect(['addETDays', 'etDateString', 'etCalendarDaysUntil', 'validCalendarDate']
      .filter((name) => !exported('utils/datetime-et.js').includes(name))).toEqual([]);
    expect(['dateOnlyString', 'validDateOnly']
      .filter((name) => !exported('utils/date-only.js').includes(name))).toEqual([]);
    expect(['addStaffWorkDays']
      .filter((name) => !exported('utils/staff-time-work-date.js').includes(name))).toEqual([]);
  });
});
