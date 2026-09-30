/**
 * Source guards for the self-serve arrival grace lane (owner ruling
 * 2026-09-28, "I'd rather be more lenient than strict"), scoped to the
 * ESTIMATE PICKER ONLY after Codex r1 P1 (#5314) — and, since 2026-09-29
 * (GATE_BOOK_ARRIVAL_GRACE, owner-approved), ALSO the /book surfaces through
 * a SEPARATE opt-in (`bookArrivalGrace`, guarded at the bottom of this file)
 * whose offer and commit apply the same waiver: /book (createSelfBooking)
 * and public reschedule (the rebooker's single-visit move) both run a
 * STRICT pre-verify travel probe ahead of their capacity commit check, so a
 * grace-kept slot there would 409 SLOT_TAKEN before ever reaching
 * verifyArrivalCapacity — the estimate picker's own commit
 * (slot-reservation.js) has no such probe under capacity.
 *
 * Per-CALL-SITE, not per-file (Codex r2 P0, #5314): slot-reservation.js
 * itself now has BOTH kinds of call — reserveSlot passes arrivalGraceMinutes,
 * commitReservation deliberately never does (a hold is certified ONCE, at
 * reserve; re-applying a freshly re-read grace at accept could fail a hold
 * that a since-lowered env value would refuse today even though it was
 * validly reserved). A blanket per-FILE allowlist can't express "this file
 * has one of each," so a documented non-grace call site is marked with a
 * literal `GRACE-EXEMPT` comment immediately before it instead.
 *
 * 1. Every non-test call to verifyArrivalCapacity either passes
 *    `arrivalGraceMinutes` or is immediately preceded by a `GRACE-EXEMPT`
 *    comment explaining why (grep the file for the current reasons).
 * 2. `packEnds: true` (packCapacityEnds' own admission) is only ever passed
 *    by the two self-serve availability builders.
 * 3. `arrivalGrace: true` (packCapacityEnds' GRACE opt-in) is only ever
 *    passed by estimate-slot-availability.js — never booking.js, even
 *    though it shares packEnds:true.
 *
 * A NEW call site that forgets the right signal fails until it is reviewed
 * and either wired or marked GRACE-EXEMPT with a reason — same shape as
 * stamped-zero-charge-fallback-guard.test.js.
 */
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'routes'];
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist']);
// A GRACE-EXEMPT marker is honored either INSIDE the call's own argument
// object (booking.js/rebooker.js's style — a comment beside the options it
// explains) or shortly BEFORE the call itself (slot-reservation.js's style —
// a comment on the statement as a whole). This window covers "shortly
// before": generous enough for a multi-line reason, tight enough that it
// must actually sit right above THIS call, not some earlier unrelated one.
const EXEMPT_MARKER_LOOKBACK = 700;

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

// Extract every `verifyArrivalCapacity(...)` call's start index + argument
// text — matching parens by hand since the options object itself contains
// nested parens/braces (arrow functions, template calls) a regex can't
// balance.
function callSites(source) {
  const sites = [];
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
    sites.push({ at, span: source.slice(at, i) });
    from = i;
  }
  return sites;
}

function scanFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(SERVER_ROOT, dir), files);
  return files;
}

test('every verifyArrivalCapacity call site passes arrivalGraceMinutes or carries a GRACE-EXEMPT marker', () => {
  const offenders = [];
  let totalCalls = 0;
  let exemptCalls = 0;
  for (const file of scanFiles()) {
    const rel = path.relative(SERVER_ROOT, file).replace(/\\/g, '/');
    if (rel === 'services/scheduling/arrival-route.js') continue; // the function's own definition/export
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('verifyArrivalCapacity(')) continue;
    for (const { at, span } of callSites(source)) {
      totalCalls++;
      // A real KEY (`arrivalGraceMinutes:`), never a bare mention — the
      // GRACE-EXEMPT reason comments below say "no arrivalGraceMinutes
      // here", which would otherwise false-match a plain substring check.
      if (/arrivalGraceMinutes\s*:/.test(span)) continue;
      const lookback = source.slice(Math.max(0, at - EXEMPT_MARKER_LOOKBACK), at);
      if (span.includes('GRACE-EXEMPT') || lookback.includes('GRACE-EXEMPT')) { exemptCalls++; continue; }
      offenders.push(`${rel}:${at}`);
    }
  }
  // Sanity: this scan actually finds calls, and finds the exempt ones too —
  // a refactor that renamed the function or moved a marker too far from its
  // call would otherwise make this test vacuously pass.
  expect(totalCalls).toBeGreaterThanOrEqual(4);
  // rebooker.js single-visit move and slot-reservation.js commitReservation
  // (the P0 fix, Codex r2 #5314). booking.js createSelfBooking left the
  // exempt list 2026-09-29: it now passes `arrivalGraceMinutes` (the offer's
  // own grace, GATE_BOOK_ARRIVAL_GRACE — undefined while the gate is off).
  expect(exemptCalls).toBe(2);
  expect(offenders).toEqual([]);
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

// The /book opt-in (GATE_BOOK_ARRIVAL_GRACE, owner-approved 2026-09-29) is a
// DIFFERENT flag from arrivalGrace above, so the estimate-picker guard keeps
// meaning what it says. It is passed ONLY by the redeemable /book surfaces
// whose commit is createSelfBooking (which applies the matching waiver and
// grace bound): the booking routes themselves, re-service and inspection
// booking — never the voice agent (phone stays end-of-day only) or public
// reschedule (its rebooker commit still runs the strict travel probe).
test('bookArrivalGrace is only ever passed by the /book surfaces whose commit is createSelfBooking', () => {
  const ALLOWED = new Set([
    'routes/booking.js', 'routes/reservice-public.js', 'routes/inspection-public.js',
  ]);
  const hits = [];
  for (const file of scanFiles()) {
    const rel = path.relative(SERVER_ROOT, file).replace(/\\/g, '/');
    if (rel === 'services/scheduling/find-time.js') continue; // the option's own consumer
    const source = fs.readFileSync(file, 'utf8');
    if (/bookArrivalGrace:/.test(source)) hits.push(rel);
  }
  expect(hits.sort()).toEqual([...ALLOWED].sort());
  for (const forbidden of [
    'routes/reschedule-public.js', 'services/rebooker.js',
    'services/voice-agent/relay-booking.js', 'services/voice-agent/relay-tools.js',
    'services/estimate-slot-availability.js',
  ]) {
    const source = fs.readFileSync(path.join(SERVER_ROOT, forbidden), 'utf8');
    expect(source).not.toMatch(/bookArrivalGrace/);
  }
});

// createSelfBooking's ONE verifyArrivalCapacity call passes the offer's grace
// (a real key, not a bare mention) so the bound the offer screened for is the
// bound the commit enforces.
test('createSelfBooking passes the offer grace to verifyArrivalCapacity', () => {
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'routes/booking.js'), 'utf8');
  const sites = callSites(source);
  expect(sites).toHaveLength(1);
  expect(sites[0].span).toMatch(/arrivalGraceMinutes:\s*offerGrace > 0 \? offerGrace : undefined/);
});
