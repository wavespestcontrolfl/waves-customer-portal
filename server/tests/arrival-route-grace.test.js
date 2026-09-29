/**
 * Arrival grace in CAPACITY mode, at its ONE chokepoint (Codex round 3 on
 * #5310, STRUCTURAL fix in round 4): three separate rounds each found
 * another caller of verifyArrivalCapacity silently skipping a per-caller
 * grace helper (slot-reservation.js's reserve/commit, then rebooker.js's
 * reschedule, then booking.js's createSelfBooking). The predicate now lives
 * INSIDE verifyArrivalCapacity itself, behind an explicit `enforceArrivalGrace`
 * option every self-serve caller passes — a future caller that forgets the
 * option simply gets no grace enforcement (fails closed to the existing
 * 120-minute promise, never silently loosens it), and there is exactly one
 * place left for this predicate to drift from.
 *
 * verifyArrivalCapacity itself does real row locks and a DB-backed route
 * simulation (loadArrivalRouteContext, evaluateArrivalPlacement,
 * assertCapacityEligibility) — it can only be proven end-to-end against
 * real Postgres (booking-capacity-commit-db.test.js). `_internals.checkArrivalGrace`
 * is the grace half of that check, pulled out as a pure function purely so
 * it can be unit-tested directly with no DB at all.
 */
const { _internals } = require('../services/scheduling/arrival-route');
const { checkArrivalGrace } = _internals;
const { etDateString } = require('../utils/datetime-et');

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SELF_SERVE_ARRIVAL_GRACE_MINUTES'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const FUTURE_DATE = '2099-01-01';

describe('checkArrivalGrace — the one chokepoint verifyArrivalCapacity enforces grace through', () => {
  test('enforceArrivalGrace: false (a caller that did not opt in) never throws, whatever the delay', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: 100 }, FUTURE_DATE, false)).not.toThrow();
  });

  test('grace 90, opted in: a 100-minute simulated arrival delay is refused (SLOT_UNAVAILABLE, reason arrival_grace)', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: 100 }, FUTURE_DATE, true))
      .toThrow(expect.objectContaining({ code: 'SLOT_UNAVAILABLE', reason: 'arrival_grace', statusCode: 409 }));
  });

  test('grace 90, opted in: an 80-minute simulated arrival delay is fine', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: 80 }, FUTURE_DATE, true)).not.toThrow();
  });

  test('grace 90: exactly 90 minutes late is the inclusive boundary — not a violation, 91 is', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: 90 }, FUTURE_DATE, true)).not.toThrow();
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: 91 }, FUTURE_DATE, true)).toThrow();
  });

  test('grace 0 (dark/unset), even opted in: capacity mode is untouched — a 119-minute delay (inside the legacy 120-minute promise) never throws', () => {
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: 119 }, FUTURE_DATE, true)).not.toThrow();
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '0';
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: 119 }, FUTURE_DATE, true)).not.toThrow();
  });

  test('GATE_SLOT_TRAVEL_GAP off forces grace to 0 here too (the one reader) — a 100-minute delay is fine even opted in', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    delete process.env.GATE_SLOT_TRAVEL_GAP;
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: 100 }, FUTURE_DATE, true)).not.toThrow();
  });

  test('same-day (today, ET) stays strict per decision 2 — grace is forced to 0 for today\'s own commits even with a configured value', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: 100 }, etDateString(), true)).not.toThrow();
  });

  test('a non-finite arrivalDelayMinutes never throws (fail-open on a malformed fit)', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(() => checkArrivalGrace({ arrivalDelayMinutes: undefined }, FUTURE_DATE, true)).not.toThrow();
    expect(() => checkArrivalGrace({}, FUTURE_DATE, true)).not.toThrow();
  });
});

// The STRUCTURAL guarantee this round adds: every non-test caller of
// verifyArrivalCapacity either passes the grace option, or is one of the
// documented non-self-serve exceptions below. A future capacity-mode
// commit site that forgets the option fails this test instead of silently
// shipping a fourth undiscovered gap.
describe('every verifyArrivalCapacity caller either opts into grace or is a documented non-self-serve exception', () => {
  const fs = require('fs');
  const path = require('path');
  const glob = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') glob(full, out); }
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  const serverDir = path.join(__dirname, '..');
  const files = glob(serverDir).filter((f) => !f.includes(`${path.sep}tests${path.sep}`)
    && path.basename(f) !== 'arrival-route.js'); // the definition itself

  // Every self-serve commit site (ALWAYS the self-serve surface — passes
  // enforceArrivalGrace: true unconditionally).
  const UNCONDITIONAL_SELF_SERVE = new Set([
    path.join(serverDir, 'services/slot-reservation.js'),
    path.join(serverDir, 'routes/booking.js'),
  ]);
  // Mixed-caller commit sites (serve staff/SMS/voice/auto-dispatch too) —
  // gate the option on the caller's own per-call opt-in signal instead of
  // passing `true` unconditionally (decision 6: non-self-serve callers stay
  // byte-identical). Documented here so this test can tell "opts in
  // correctly" apart from "never heard of the option."
  const MIXED_CALLER_GATED = new Set([
    path.join(serverDir, 'services/rebooker.js'),
  ]);

  test('every call site is one of: unconditional self-serve, mixed-caller gated, or absent (documented set is exhaustive and current)', () => {
    const callers = files.filter((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return /verifyArrivalCapacity\(/.test(src) && !/async function verifyArrivalCapacity\(/.test(src);
    });
    const documented = new Set([...UNCONDITIONAL_SELF_SERVE, ...MIXED_CALLER_GATED]);
    const undocumented = callers.filter((f) => !documented.has(f));
    expect(undocumented).toEqual([]);
    // And the documented set isn't stale in the OTHER direction either —
    // every file it names still actually calls verifyArrivalCapacity.
    for (const f of documented) {
      expect(callers).toContain(f);
    }
  });

  test('unconditional self-serve call sites pass enforceArrivalGrace: true (never gated on anything)', () => {
    for (const f of UNCONDITIONAL_SELF_SERVE) {
      const src = fs.readFileSync(f, 'utf8');
      const calls = [...src.matchAll(/verifyArrivalCapacity\(preparedCapacity, \{/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const m of calls) {
        const closeIdx = src.indexOf('}) : null;', m.index);
        const closeBrace = closeIdx === -1 ? src.indexOf('});', m.index) : closeIdx;
        expect(src.slice(m.index, closeBrace)).toMatch(/enforceArrivalGrace: true,/);
      }
    }
  });

  test('mixed-caller call sites gate enforceArrivalGrace on their own per-call opt-in, never a bare true/false literal', () => {
    for (const f of MIXED_CALLER_GATED) {
      const src = fs.readFileSync(f, 'utf8');
      const callIdx = src.indexOf('verifyArrivalCapacity(preparedCapacity, {');
      expect(callIdx).toBeGreaterThan(-1);
      const closeIdx = src.indexOf('}) : null;', callIdx);
      const block = src.slice(callIdx, closeIdx);
      expect(block).toMatch(/enforceArrivalGrace: Number\(options\.arrivalGraceMinutes\) > 0,/);
    }
  });
});
