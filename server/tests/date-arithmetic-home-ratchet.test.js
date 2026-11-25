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
 *     must be add/plus<Qualifier>Days.
 *   - const { addETDays } = require(...) and const addDays = require(...): an
 *     import, not a copy. A local DEFINITION counts whatever its name is, even
 *     one called addETDays: the real helpers live in the exempt home files.
 *   - TTLs, age limits and rolling windows: const MAX_AGE_MS = 86400000,
 *     windowMs: 24 * 60 * 60 * 1000, new Date(now.getTime() - 7 * DAY_MS),
 *     new Date(Date.now() - 86400000). 24 hours is the right answer there.
 *     day-ms-math counts a line only when a one-day step (literal or a day
 *     constant name) sits on the same line as a calendar-day sink: any export
 *     of the three helper modules whose name matches /date|day/i (read at
 *     runtime, so a new helper is covered), or .toISOString().slice(...),
 *     .substring(...), .split(...), or .slice(0, 10).
 *   - /^\d{4}-\d{2}-\d{2}T.../ and other timestamp patterns: a timestamp is not
 *     a date-only value; only a pattern that is the whole date counts.
 * Shapes it still counts (so the baseline holds them): setUTCDate week math
 * and a day-ms step that ends in a calendar-day sink.
 *
 * The matcher tables at the bottom (shapes that must count, shapes that must
 * not) run on sample strings, so a change to a pattern is checked there first.
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
// One day in ms, as a literal: 86400000, 24 * 60 * 60 * 1000, ...
const ONE_DAY_MS = '(?:86400000|86_400_000|864e5|8\\.64e7|24 *\\* *60 *\\* *60 *\\* *1000|60 *\\* *60 *\\* *24 *\\* *1000|1000 *\\* *60 *\\* *60 *\\* *24|60 *\\* *24 *\\* *60 *\\* *1000|24 *\\* *3600 *\\* *1000|3600 *\\* *24 *\\* *1000|1000 *\\* *3600 *\\* *24|86400 *\\* *1000|1000 *\\* *86400)';
const ANY_DAY_MS = new RegExp(`(?<![\\w.])${ONE_DAY_MS}(?![\\w.])`, 'g');
// n * DAY_MS written with a named constant (local or imported)
const DAY_MS_NAME = /\b(?:(?:[A-Z][A-Z0-9_]*_)?DAY_?(?:MS|MILLIS|MILLISECONDS)|(?:MS|MILLIS)_(?:PER|IN)_DAY|ONE_DAY\w*|dayMs|DAY_IN_MS)\b\b/g;

// Calendar-day sinks: every export of the helper modules whose name mentions a
// date or a day, read from the modules so a new helper is covered at once.
const SINK_NAMES = [...new Set(HOMES.flatMap((home) => {
  const mod = require(path.join(SERVER_ROOT, home));
  return Object.keys(mod).filter((name) => typeof mod[name] === 'function' && /date|day/i.test(name));
}))];
const CALENDAR_DAY_SINK = new RegExp(
  `\\b(?:${SINK_NAMES.join('|')})\\(|\\.toISOString\\(\\)\\s*\\.(?:slice|substring|split)\\(|\\.slice\\(\\s*0\\s*,\\s*10\\s*\\)`,
);

const DAY_STEP_NAME = '(?:add|plus)(?:[A-Z]\\w*)?Days(?:[A-Z]\\w*)?';
// function addDays( | const addDays = | x.addDays = ( | addDays: ( | addDays(a, b) {
const ADD_DAYS_DEFINITION = new RegExp([
  `\\bfunction\\s+(${DAY_STEP_NAME})\\b`,
  `\\b(?:const|let|var)\\s+(${DAY_STEP_NAME})\\b(?!\\s*=\\s*require)`,
  `\\.(${DAY_STEP_NAME})\\s*=\\s*(?:async\\s+)?(?:function\\b|\\(|\\w+\\s*=>)`,
  `^\\s*(${DAY_STEP_NAME})\\s*:\\s*(?:async\\s+)?(?:function\\b|\\(|\\w+\\s*=>)`,
  `^\\s*(?:async\\s+)?(${DAY_STEP_NAME})\\s*\\([^)]*\\)\\s*\\{`,
].join('|'), 'g');

// \d{4}-\d{2}-\d{2} or [0-9]{4}-[0-9]{2}-[0-9]{2}, groups optional, whole pattern is the date
const DATE_ONLY_LITERAL = /\/\^\(?(?:\\d|\[0-9\])\{4\}\)?-\(?(?:\\d|\[0-9\])\{2\}\)?-\(?(?:\\d|\[0-9\])\{2\}\)?\$?\/[a-z]*/g;
// the same pattern inside a string: new RegExp('^\\d{4}-\\d{2}-\\d{2}$')
const DATE_ONLY_STRING = /RegExp\(\s*['"`]\^\(?(?:\\\\d|\[0-9\])\{4\}\)?-\(?(?:\\\\d|\[0-9\])\{2\}\)?-\(?(?:\\\\d|\[0-9\])\{2\}\)?\$?['"`]/g;
const DATE_ONLY_REGEX = new RegExp(`${DATE_ONLY_LITERAL.source}|${DATE_ONLY_STRING.source}`, 'g');

const RULES = [
  {
    id: 'add-days-function',
    countLine: (rel, line) => [...line.matchAll(ADD_DAYS_DEFINITION)].length,
    use: `Do not write your own addDays, even one named addETDays. ${USE}`,
  },
  {
    id: 'calendar-day-mutation',
    // d.setDate(d.getDate() + n), d.setUTCDate(d.getUTCDate() - n)
    signature: /\bset(?:UTC)?Date\((?:(?!\bset(?:UTC)?Date\()[^;])*?\bget(?:UTC)?Date\(\)\s*[+-]/g,
    use: `Do not step a Date a day at a time with setDate(getDate() + n). ${USE}`,
  },
  {
    id: 'day-ms-math',
    // each one-day ms step (literal or DAY_MS-style name) on a line that has a calendar-day sink
    countLine: (rel, line) => (CALENDAR_DAY_SINK.test(line)
      ? (line.match(ANY_DAY_MS) || []).length + (line.match(DAY_MS_NAME) || []).length
      : 0),
    use: `Do not add or subtract n * 86400000 (24 * 60 * 60 * 1000) to move a calendar day; a day is 23 or 25 hours across a DST seam. ${USE}`,
  },
  {
    id: 'date-only-regex',
    // /^\d{4}-\d{2}-\d{2}$/, /^(\d{4}-\d{2}-\d{2})/, [0-9] forms, new RegExp('^\\d{4}-...')
    signature: DATE_ONLY_REGEX,
    use: 'Do not write your own YYYY-MM-DD regex. To validate strictly, use validDateOnly (server/utils/date-only.js) or validCalendarDate (server/utils/datetime-et.js). To extract the YYYY-MM-DD prefix of a value, use dateOnlyString (server/utils/date-only.js).',
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

// Drops comments: whole // lines, /* ... */ blocks (a line that starts one, up
// to the line that ends it) and trailing ` // note` text. A continuation line
// that starts with `* 86400000` is code, not a JSDoc line, so it is kept.
function codeLines(source) {
  const out = [];
  let inBlock = false;
  for (const raw of source.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, ' ');
    if (/^\s*\/\*/.test(line)) { inBlock = true; continue; }
    if (/^\s*\/\//.test(line)) continue;
    out.push(line.replace(/\s\/\/\s.*$/, ''));
  }
  return out;
}
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

// Matcher tables: sample code against each rule. A change to a pattern edits
// these rows first; the repo scan above then only reports real files.
const countSample = (id, text) => {
  const rule = RULES.find((r) => r.id === id);
  const countLine = rule.countLine || signatureCount(rule.signature);
  return codeLines(text).reduce((sum, line) => sum + countLine('sample.js', line), 0);
};

const MUST_COUNT = [
  // add-days-function: any local definition, whatever its name or form
  ['add-days-function', 'function addDays(d, n) { return d; }'],
  ['add-days-function', 'const addDays = (day, n) => day;'],
  ['add-days-function', 'const addDateStringDays = (v, n) => v;'],
  ['add-days-function', 'const addBusinessDays = (v, n) => v;'],
  ['add-days-function', 'function addETDays(date, days) { return date; }'],
  ['add-days-function', 'const addETDays = (date, days) => new Date(date);'],
  ['add-days-function', 'const addStaffWorkDays = (day, n) => day;'],
  ['add-days-function', 'function addStaffWorkDays(day, n) {'],
  ['add-days-function', 'module.exports.addDays = (d, n) => d;'],
  ['add-days-function', '  addDays: (d, n) => d,'],
  ['add-days-function', '  addDays(d, n) {'],
  ['add-days-function', 'function plusDays(d, n) {'],
  // calendar-day-mutation
  ['calendar-day-mutation', 'd.setDate(d.getDate() + 1);'],
  ['calendar-day-mutation', 'a.setDate(a.getDate() + 1), b.setUTCDate(b.getUTCDate() - 2);'],
  ['calendar-day-mutation', 'd.setUTCDate(d.getUTCDate() - n);'],
  ['calendar-day-mutation', 'const x = new Date(s); x.setDate(start.getDate() + i);'],
  // day-ms-math
  ['day-ms-math', "const next = new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);"],
  ['day-ms-math', 'return etDateString(new Date(d.getTime() + n * 24 * 60 * 60 * 1000));'],
  ['day-ms-math', 'const t = formatETDate(new Date(base.getTime() + n * DAY_MS));'],
  ['day-ms-math', 'const t = dateOnlyString(new Date(base.getTime() + n * 24 * 3600 * 1000));'],
  ['day-ms-math', 'x([etDateString(new Date(now.getTime() - 60 * 86400000)), etDateString(new Date(now.getTime() + 100 * 86400000))]);'],
  ['day-ms-math', 'const label = formatETDate(new Date(Date.now() + 86400000));'],
  ['day-ms-math', 'const days = etCalendarDaysUntil(new Date(x.getTime() + 86400000));'],
  ['day-ms-math', 'const d = new Date(t + 86400000).toISOString().substring(0, 10);'],
  ['day-ms-math', "const d = new Date(t + 86400000).toISOString().split('T')[0];"],
  // Date.now() on the line does not exempt a step that lands on a calendar day
  ['day-ms-math', 'const tomorrow = etDateString(new Date(Date.now() + 86400000));'],
  ['day-ms-math', 'const d = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);'],
  ['day-ms-math', 'const d = dateOnlyString(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));'],
  ['day-ms-math', 'const d = etDateString(new Date(Date.now() + 2 * DAY_MS));'],
  // date-only-regex
  ['date-only-regex', 'if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(v)) return null;'],
  ['date-only-regex', 'const m = /^(\\d{4}-\\d{2}-\\d{2})/.exec(v);'],
  ['date-only-regex', 'const m = /^\\d{4}-\\d{2}-\\d{2}/.test(v);'],
  ['date-only-regex', 'const m = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);'],
  ['date-only-regex', 'const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(v);'],
  ['date-only-regex', "const re = new RegExp('^\\\\d{4}-\\\\d{2}-\\\\d{2}$');"],
];

const MUST_NOT_COUNT = [
  // add-days-function: imports, other names, comments
  ['add-days-function', "const { addETDays, etDateString } = require('../utils/datetime-et');"],
  ['add-days-function', "const addETDays = require('../utils/datetime-et').addETDays;"],
  ['add-days-function', "const { addStaffWorkDays } = require('../utils/staff-time-work-date');"],
  ['add-days-function', "const addDays = require('date-fns/addDays');"],
  ['add-days-function', 'const next = addETDays(date, 3);'],
  ['add-days-function', 'function addDay(totals, d) {'],
  ['add-days-function', 'let addedDays = new Map();'],
  ['add-days-function', 'const shiftDays = (rows) => rows.map((r) => r.workDate);'],
  ['add-days-function', 'function addMonthsSameDay(value, months) {'],
  ['add-days-function', '// function addDays(d, n) {'],
  ['add-days-function', '/**\n * const addDays = (d, n) => d;\n */'],
  // calendar-day-mutation
  ['calendar-day-mutation', 'd.setDate(15);'],
  ['calendar-day-mutation', 'const day = d.getDate() + 1;'],
  ['calendar-day-mutation', '// d.setDate(d.getDate() + 1);'],
  // day-ms-math: elapsed windows from now and bare durations
  ['day-ms-math', 'windowMs: 24 * 60 * 60 * 1000, // 24 hours'],
  ['day-ms-math', 'const since = new Date(Date.now() - 7 * 86400000);'],
  ['day-ms-math', 'const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);'],
  ['day-ms-math', 'const stale = Date.now() - row.at > 86400000;'],
  ['day-ms-math', 'const ttl = 7 * 24 * 60 * 60 * 1000;'],
  ['day-ms-math', 'const X_MAX_AGE_MS = 86400000;'],
  ['day-ms-math', 'const DAY_MS = 24 * 60 * 60 * 1000;'],
  ['day-ms-math', 'new Date(now.getTime() - 7 * DAY_MS)'],
  ['day-ms-math', 'return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);'],
  ['day-ms-math', "const next = new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000);"],
  ['day-ms-math', 'const ms = 86400;'],
  ['day-ms-math', 'const big = 1186400000;'],
  ['day-ms-math', '// new Date(x.getTime() + 86400000)'],
  ['day-ms-math', 'const iso = new Date(Date.now() + 86400000).toISOString();'],
  // date-only-regex: timestamps and unanchored scrubbing
  ['date-only-regex', 'const re = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/;'],
  ['date-only-regex', 'const re = /^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}/;'],
  ['date-only-regex', "s.replace(/\\d{4}-\\d{2}-\\d{2}/g, ' ');"],
  ['date-only-regex', 'const re = /^\\d{4}-\\d{2}$/;'],
  ['date-only-regex', "const ok = validDateOnly(value);"],
];

describe('matcher tables', () => {
  test.each(MUST_COUNT)('%s counts: %s', (id, sample) => {
    expect(countSample(id, sample)).toBeGreaterThan(0);
  });

  test.each(MUST_NOT_COUNT)('%s skips: %s', (id, sample) => {
    expect(countSample(id, sample)).toBe(0);
  });

  test('a continuation line that starts with * is code, a JSDoc line is not', () => {
    expect(codeLines('const t = a +\n  n\n  * 86400000;')).toContain('  * 86400000;');
    expect(codeLines('/**\n * adds 86400000\n */\nconst x = 1;').filter(Boolean)).toEqual(['const x = 1;']);
    expect(codeLines('const x = 1; /* 86400000 */ const y = 2;').join('')).not.toContain('86400000');
  });

  test('the day sinks come from the real helper exports', () => {
    expect(SINK_NAMES).toEqual(expect.arrayContaining(['etDateString', 'formatETDate', 'addETDays', 'dateOnlyString', 'validDateOnly', 'staffWorkDate', 'addStaffWorkDays']));
    expect(SINK_NAMES).not.toContain('TZ');
  });

  test('a line with two matches counts both', () => {
    expect(countSample('add-days-function', 'const addDays = (a) => a; const addBusinessDays = (a) => a;')).toBe(2);
    expect(countSample('calendar-day-mutation', 'a.setDate(a.getDate() + 1), b.setUTCDate(b.getUTCDate() - 2);')).toBe(2);
    expect(countSample('day-ms-math', 'f(etDateString(new Date(t - 60 * 86400000)), etDateString(new Date(t + 100 * 86400000)));')).toBe(2);
    expect(countSample('date-only-regex', 'const ok = /^\\d{4}-\\d{2}-\\d{2}$/.test(a) && /^(\\d{4})-(\\d{2})-(\\d{2})/.test(b);')).toBe(2);
  });

  test('the date-only-regex message separates strict validation from prefix extraction', () => {
    const { use } = RULES.find((rule) => rule.id === 'date-only-regex');
    expect(use).toMatch(/validate strictly, use validDateOnly .*validCalendarDate/);
    expect(use).toMatch(/extract the YYYY-MM-DD prefix.*dateOnlyString/);
  });

  test('a local addETDays definition counts and a shared import passes', () => {
    expect(countSample('add-days-function', 'function addETDays(d, n) {')).toBe(1);
    expect(countSample('add-days-function', "const { addETDays } = require('../utils/datetime-et');")).toBe(0);
  });
});
