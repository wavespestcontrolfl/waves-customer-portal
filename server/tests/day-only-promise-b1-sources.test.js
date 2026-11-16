// GATE_DAY_ONLY_PROMISE part B1: every appointment_reminders.source a booking path registers is classified ON PURPOSE.
// A first or one-time visit is promised only the day when its source is an office source (OFFICE_BOOKING_SOURCES). Every
// other source keeps the window, because the customer picked the hour or the origin is unknown. A new booking path that
// is in neither list (services/time-promise.js) fails here until someone decides which it is.
const fs = require('fs');
const path = require('path');
const { OFFICE_BOOKING_SOURCES, CUSTOMER_OR_UNKNOWN_SOURCES } = require('../services/time-promise');

const SERVER = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'contract-tests', '__tests__', 'migrations']);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js')) out.push(path.join(dir, entry.name));
  }
  return out;
}

// The text inside the balanced parentheses that open at `openIndex`.
function balanced(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') { depth -= 1; if (depth === 0) return text.slice(openIndex + 1, i); }
  }
  return text.slice(openIndex + 1);
}

// Snake-case single-quoted words in call arguments; template strings and times ('08:00') never match.
const WORD = /'([a-z][a-z0-9_]*)'/g;
const words = (text) => [...text.matchAll(WORD)].map((m) => m[1]);

// The call's arguments without its template strings (times such as `${date}T${start || '08:00'}`) and without its
// options object: only the quoted words left can be the source.
function withoutOptions(args) {
  let text = args.replace(/`(?:[^`\\]|\\.)*`/g, '``');
  for (let i = 0; i < 8; i += 1) text = text.replace(/\{[^{}]*\}/g, '');
  return text;
}

/** Every source string a registerAppointment( call can pass, by file. */
function registeredSources() {
  const found = new Map();
  const add = (word, file) => { if (!found.has(word)) found.set(word, new Set()); found.get(word).add(path.relative(SERVER, file)); };
  for (const file of sourceFiles(SERVER)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bregisterAppointment\(/g)) {
      if (/async\s+registerAppointment\($/.test(text.slice(Math.max(0, m.index - 20), m.index + m[0].length))) continue;
      const args = balanced(text, m.index + m[0].length - 1);
      words(withoutOptions(args)).forEach((w) => add(w, file));
    }
    // The spawned-visit helper in routes/admin-schedule.js passes `source` through from its callers.
    for (const m of text.matchAll(/\bregisterSpawnedVisitReminder\(\{/g)) {
      const body = balanced(text, m.index + m[0].length - 1);
      for (const s of body.matchAll(/\bsource:\s*'([a-z][a-z0-9_]*)'/g)) add(s[1], file);
    }
  }
  return found;
}

describe('every registerAppointment source is classified', () => {
  const found = registeredSources();

  test('the scan finds the known booking paths (it is not silently empty)', () => {
    for (const known of ['admin_manual', 'admin_ib', 'estimate_followup', 'health_alert_comp', 'booking_new', 'booking_followup',
      'estimate_accept_slot', 'call_recording', 'recurring_auto_extend']) {
      expect(found.has(known)).toBe(true);
    }
  });

  test('every source string a booking path registers is in OFFICE_BOOKING_SOURCES or CUSTOMER_OR_UNKNOWN_SOURCES', () => {
    const classified = new Set([...OFFICE_BOOKING_SOURCES, ...CUSTOMER_OR_UNKNOWN_SOURCES]);
    const unclassified = [...found.keys()].filter((w) => !classified.has(w))
      .map((w) => `${w} (${[...found.get(w)].join(', ')})`);
    // A new booking path: decide whether the OFFICE picked the hour (add to OFFICE_BOOKING_SOURCES) or the customer did,
    // or the origin is unknown (add to CUSTOMER_OR_UNKNOWN_SOURCES), in server/services/time-promise.js.
    expect(unclassified).toEqual([]);
  });

  test('the self-heal source the reminder cron stamps is classified too', () => {
    expect(CUSTOMER_OR_UNKNOWN_SOURCES).toContain('cron_selfheal');
  });

  test('no list entry is stale: each classified source is still registered somewhere, except the documented legacy ones', () => {
    const LEGACY_OR_SCRIPT_ONLY = new Set(['ops_manual', 'admin']);
    const stale = [...OFFICE_BOOKING_SOURCES, ...CUSTOMER_OR_UNKNOWN_SOURCES]
      .filter((s) => !found.has(s) && !LEGACY_OR_SCRIPT_ONLY.has(s) && s !== 'cron_selfheal');
    expect(stale).toEqual([]);
  });
});
