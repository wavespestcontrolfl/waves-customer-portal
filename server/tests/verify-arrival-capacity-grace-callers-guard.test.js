/**
 * Source guards for the self-serve arrival grace lane (owner ruling
 * 2026-09-28, "I'd rather be more lenient than strict"), scoped to the
 * ESTIMATE PICKER ONLY after Codex r1 P1 (#5314): /book (createSelfBooking)
 * and public reschedule (the rebooker's single-visit move) both run a
 * STRICT pre-verify travel probe ahead of their capacity commit check, so a
 * grace-kept slot there would 409 SLOT_TAKEN before ever reaching
 * verifyArrivalCapacity — the estimate picker's own commit
 * (slot-reservation.js) has no such probe under capacity.
 *
 * 1. Every non-test call to verifyArrivalCapacity either passes
 *    `arrivalGraceMinutes` (a self-serve caller opting in) or is explicitly
 *    listed on the ALLOWLIST below as a documented non-grace caller.
 * 2. `packEnds: true` (packCapacityEnds' own admission) is only ever passed
 *    by the two self-serve availability builders.
 * 3. `arrivalGrace: true` (packCapacityEnds' GRACE opt-in) is only ever
 *    passed by estimate-slot-availability.js — never booking.js, even
 *    though it shares packEnds:true.
 *
 * A NEW call site that forgets the right signal fails until it is reviewed
 * and either wired or allowlisted — same shape as
 * stamped-zero-charge-fallback-guard.test.js.
 */
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'routes'];
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist']);

// { 'relative/path.js': 'why every verifyArrivalCapacity call there is a
// documented non-grace caller' }.
const ALLOWLIST = {
  'routes/booking.js':
    'createSelfBooking runs findConflictingVisits with a strict `travel` probe before this check — a grace-kept slot would already be refused SLOT_TAKEN (Codex r1 P1, #5314); grace is estimate-picker only',
  'services/rebooker.js':
    "the single-visit move's own pre-verify conflict probe is equally strict — the ONE caller that could opt in (reschedule-public.js) deliberately never sets arrivalGraceMinutes for the same reason (Codex r1 P1, #5314)",
};

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

function scanFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(SERVER_ROOT, dir), files);
  return files;
}

test('every verifyArrivalCapacity call site passes arrivalGraceMinutes or is allowlisted as non-grace', () => {
  const offenders = [];
  let totalCalls = 0;
  for (const file of scanFiles()) {
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
  // The two allowlisted files must each still actually call the function —
  // an allowlist entry for a call site that no longer exists is dead
  // documentation, not a guard.
  for (const rel of Object.keys(ALLOWLIST)) {
    const source = fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
    expect(callArgSpans(source).length).toBeGreaterThan(0);
  }
});

// The offer-side mirror: packCapacityEnds' own admission (packEnds:true) is
// still shared by both self-serve builders — never a voice/staff/assistant
// surface (server/services/availability.js is a SEPARATE, unrelated module
// with its own unrelated `packEnds` concept and is deliberately excluded).
test('packEnds: true is only ever passed by the two self-serve availability builders', () => {
  const ALLOWED = new Set(['services/estimate-slot-availability.js', 'routes/booking.js']);
  const hits = [];
  for (const file of scanFiles()) {
    const rel = path.relative(SERVER_ROOT, file).replace(/\\/g, '/');
    if (rel === 'services/scheduling/find-time.js') continue; // packEnds's own consumer/contract
    const source = fs.readFileSync(file, 'utf8');
    if (/packEnds:\s*true/.test(source)) hits.push(rel);
  }
  expect(hits.sort()).toEqual([...ALLOWED].sort());
});

// packCapacityEnds' GRACE opt-in is narrower than packEnds:true itself
// (Codex r1 P1, #5314): booking.js shares packEnds:true with the estimate
// picker but must NEVER also pass arrivalGrace — its commit path can't
// honor a grace-kept slot (see the ALLOWLIST reason above).
test('arrivalGrace: true is only ever passed by the estimate picker', () => {
  const ALLOWED = new Set(['services/estimate-slot-availability.js']);
  const hits = [];
  for (const file of scanFiles()) {
    const rel = path.relative(SERVER_ROOT, file).replace(/\\/g, '/');
    if (rel === 'services/scheduling/find-time.js') continue; // arrivalGrace's own consumer/contract
    const source = fs.readFileSync(file, 'utf8');
    if (/arrivalGrace:\s*true/.test(source)) hits.push(rel);
  }
  expect(hits.sort()).toEqual([...ALLOWED].sort());
  // booking.js MUST NOT carry the grace opt-in even though it shares
  // packEnds:true with the estimate picker (the whole point of this guard).
  const bookingSrc = fs.readFileSync(path.join(SERVER_ROOT, 'routes/booking.js'), 'utf8');
  expect(bookingSrc).not.toMatch(/arrivalGrace:\s*true/);
});
