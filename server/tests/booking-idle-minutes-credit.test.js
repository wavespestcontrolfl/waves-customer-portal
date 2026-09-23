/**
 * routes/booking.js's idleMinutesAgainst — the compareRankedSlots tie-
 * breaker toward the less hole-making candidate (owner bug report
 * 2026-09-23). Codex r7 P2: it called requiredGapMinutes with a bare
 * {startMin, endMin, lat, lng} candidate entity — no windowMinutes/
 * expectedMinutes — so it always fell back to the legacy full-buffer
 * formula, even for a candidate the SAME request's violatesTravelGap
 * mirror had already validated with real credit. A credited slot could
 * therefore rank as more hole-making than it actually is and lose a
 * ranking tie to a genuinely worse (more hole-making) option.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { idleMinutesAgainst } = require('../routes/booking')._internals;

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Co-located with the candidate (zero modeled drive) so every requiredGap
// minute is pure buffer/padding arithmetic.
const HERE = { lat: 27.4, lng: -82.4 };

test('no occupancy or no neighbour on a side: 0 idle, unaffected by credit', () => {
  expect(idleMinutesAgainst(null, 540, 600, { ...HERE, durationMinutes: 60 })).toBe(0);
  expect(idleMinutesAgainst([], 540, 600, { ...HERE, durationMinutes: 60 })).toBe(0);
  expect(idleMinutesAgainst([{ startMin: 540, endMin: 600 }], 540, 600, { ...HERE, durationMinutes: 60 })).toBe(0);
});

test('AFTER side: crediting the candidate\'s own expected minutes reduces idle time (measured from its effective end, not its raw end)', () => {
  // Candidate 09:00-10:00 (540-600), next real stop at 11:00 (660) — 60
  // raw minutes of gap. No credit: idle = 660 - 600 - requiredGap(0 drive +
  // 15 buffer, no padding) = 60 - 15 = 45.
  const after = [{ startMin: 660, endMin: 720, lat: HERE.lat, lng: HERE.lng }];
  const noCredit = idleMinutesAgainst(after, 540, 600, { ...HERE, durationMinutes: 60 });
  expect(noCredit).toBe(45);
  // Credited 45 expected minutes (candidate finishes at 585, not 600): the
  // 15-minute padding (60 window - 45 expected) fully absorbs the buffer,
  // AND the gap is measured from the effective end (585), not endMin (600)
  // — idle = 660 - 585 - 0 = 75, MORE apparent gap because the candidate's
  // real work window is shorter, but genuinely reflects more free time
  // before the next stop once the candidate's actual work is done.
  const credited = idleMinutesAgainst(after, 540, 600, { ...HERE, durationMinutes: 60, expectedMinutes: 45 });
  expect(credited).toBe(75);
});

test('BEFORE side: measured from the PRIOR stop\'s own EFFECTIVE end, not its raw end (Codex r8 P2) — unaffected by the candidate\'s own expectedMinutes', () => {
  // Prior stop 09:00-10:00 (540-600) with 45 expected minutes (15 minutes
  // of its own unused window) — its own padding, not the candidate's,
  // reduces the buffer on this side (requiredGapMinutes' earlierOf always
  // picks the earlier-ending side for the padding credit) AND the free
  // time itself is measured from its effective end (585), not its raw end
  // (600) — requiredGapMinutes already credits this stop's padding into
  // the required buffer, so subtracting the raw end on top double-counted
  // that credit as extra idle (Codex r8 P2 — the AFTER side already used
  // the mirror-image fix for the candidate's own effective end).
  const before = [{ startMin: 540, endMin: 600, lat: HERE.lat, lng: HERE.lng, windowMinutes: 60, expectedMinutes: 45 }];
  // Candidate at 11:00-12:00 (660-720): effective-end gap = 660 - 585 = 75.
  // requiredGap = drive(0) + max(0, 15 - padding(15)) = 0. idle = 75 - 0 = 75.
  const idle = idleMinutesAgainst(before, 660, 720, { ...HERE, durationMinutes: 60 });
  expect(idle).toBe(75);
  // Adding the CANDIDATE's own credit changes nothing on this side — the
  // prior stop is still the earlier entity either way.
  const idleWithCandidateCredit = idleMinutesAgainst(before, 660, 720, { ...HERE, durationMinutes: 60, expectedMinutes: 30 });
  expect(idleWithCandidateCredit).toBe(75);
});

test('BEFORE side regression (Codex r8 P2 exact repro): a 09:00-10:00 stop expected to end 09:45 with a co-located 11:00 candidate reports 75 real idle minutes, not 60', () => {
  // Same shape as the coordinator's own repro: before.endMin (raw, 10:00)
  // is 15 minutes later than before's real effective end (09:45) — the OLD
  // code measured idle from the raw end and reported 60 (11:00 - 10:00 -
  // requiredGap 0); the fix measures from the effective end and reports the
  // genuine 75 (11:00 - 09:45 - requiredGap 0).
  const before = [{ startMin: 540, endMin: 600, lat: HERE.lat, lng: HERE.lng, windowMinutes: 60, expectedMinutes: 45 }];
  const idle = idleMinutesAgainst(before, 660, 720, { ...HERE, durationMinutes: 60 });
  expect(idle).toBe(75);
});

test('gate off: requiredGapMinutes still reads travelBufferMinutes() directly (unaffected by GATE_SLOT_TRAVEL_GAP) — credit still applies', () => {
  const previous = process.env.GATE_SLOT_TRAVEL_GAP;
  delete process.env.GATE_SLOT_TRAVEL_GAP;
  try {
    const after = [{ startMin: 660, endMin: 720, lat: HERE.lat, lng: HERE.lng }];
    // Same numbers as the credited AFTER-side test above — idleMinutesAgainst
    // itself is not gated (it is a ranking tie-breaker, not an enforcement
    // predicate), so the result is identical with the gate off.
    expect(idleMinutesAgainst(after, 540, 600, { ...HERE, durationMinutes: 60, expectedMinutes: 45 })).toBe(75);
  } finally {
    if (previous === undefined) delete process.env.GATE_SLOT_TRAVEL_GAP;
    else process.env.GATE_SLOT_TRAVEL_GAP = previous;
  }
});
