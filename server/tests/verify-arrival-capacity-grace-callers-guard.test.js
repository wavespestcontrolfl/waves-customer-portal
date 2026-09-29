/**
 * Source guard: every non-test call to verifyArrivalCapacity (arrival-
 * route.js) either passes `arrivalGraceMinutes` (a self-serve caller opting
 * into the owner's 2026-09-28 arrival-grace ruling) or is explicitly listed
 * on the ALLOWLIST below as a documented non-self-serve caller (staff/voice
 * — verifyArrivalCapacity's own 120-minute arrival promise is their only
 * bound, unchanged by this lane).
 *
 * As of this lane there are exactly four production call sites, and all
 * four are self-serve (or, for the rebooker, self-serve-only when the ONE
 * opted-in caller — reschedule-public.js — is the one invoking it; the
 * ALLOWLIST is empty today). A NEW call site that forgets the option fails
 * this test until it is reviewed and either wired or allowlisted, the same
 * shape as stamped-zero-charge-fallback-guard.test.js.
 */
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'routes'];
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist']);

// { 'relative/path.js': 'why every verifyArrivalCapacity call there is a
// documented non-self-serve (staff/voice) caller' }. Empty today — see the
// header comment.
const ALLOWLIST = {};

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
}

// Extract every `verifyArrivalCapacity(...)` call's argument text — matching
// parens by hand since the options object itself contains nested parens/
// braces (arrow functions, template calls) a regex can't balance.
function callArgSpans(source) {
  const spans = [];
  const needle = 'verifyArrivalCapacity(';
  let from = 0;
  while (true) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    // Skip the function's OWN declaration/export line, never a call — every
    // real call is either a bare reference (import) or a method access
    // (`.verifyArrivalCapacity(`, `arrival-route.verifyArrivalCapacity(`).
    const precedingWord = source.slice(Math.max(0, at - 10), at);
    if (/function\s*$/.test(precedingWord)) {
      from = at + needle.length;
      continue;
    }
    let depth = 1;
    let i = at + needle.length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    spans.push(source.slice(at, i));
    from = i;
  }
  return spans;
}

test('every verifyArrivalCapacity call site passes arrivalGraceMinutes or is allowlisted as non-self-serve', () => {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(SERVER_ROOT, dir), files);
  const offenders = [];
  let totalCalls = 0;
  for (const file of files) {
    const rel = path.relative(SERVER_ROOT, file).replace(/\\/g, '/');
    if (rel === 'services/scheduling/arrival-route.js') continue; // the function's own definition/export
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('verifyArrivalCapacity(')) continue;
    const spans = callArgSpans(source);
    for (const span of spans) {
      totalCalls++;
      if (span.includes('arrivalGraceMinutes')) continue;
      if (ALLOWLIST[rel]) continue;
      offenders.push(rel);
    }
  }
  // Sanity: this scan actually finds calls (a refactor that renamed the
  // function everywhere would otherwise make this test vacuously pass).
  expect(totalCalls).toBeGreaterThanOrEqual(4);
  expect(offenders).toEqual([]);
});

// The offer-side mirror: packCapacityEnds' self-serve grace only ever runs
// under findCapacitySlots' opts.packEnds === true, and packEnds:true is
// ONLY ever passed by the two documented self-serve builders — never a
// voice/staff/assistant surface (server/services/availability.js is a
// SEPARATE, unrelated module with its own unrelated `packEnds` concept and
// is deliberately excluded here).
test('packEnds: true is only ever passed by the two self-serve availability builders', () => {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(SERVER_ROOT, dir), files);
  const ALLOWED = new Set(['services/estimate-slot-availability.js', 'routes/booking.js']);
  const hits = [];
  for (const file of files) {
    const rel = path.relative(SERVER_ROOT, file).replace(/\\/g, '/');
    if (rel === 'services/scheduling/find-time.js') continue; // packEnds's own consumer/contract
    const source = fs.readFileSync(file, 'utf8');
    if (/packEnds:\s*true/.test(source)) hits.push(rel);
  }
  expect(hits.sort()).toEqual([...ALLOWED].sort());
});
