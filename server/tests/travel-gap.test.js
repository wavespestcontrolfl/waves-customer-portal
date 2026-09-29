/**
 * scheduling/travel-gap.js — the one rule for the free time required between
 * a candidate window and a neighbouring stop: modeled drive + a fixed buffer
 * (GATE_SLOT_TRAVEL_GAP, SLOT_TRAVEL_BUFFER_MINUTES). Field report 2026-09-03:
 * the estimate picker offered 9–10 AM in Palmetto against a 10–11 AM stop in
 * Bradenton (~33 modeled minutes) because every gate was pure overlap.
 */
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const travelGap = require('../services/scheduling/travel-gap');
const { clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

const {
  DEFAULT_TRAVEL_BUFFER_MINUTES, travelBufferMinutes, requiredGapMinutes,
  travelGapViolation, travelGapConflicts, violatesTravelGap, resolveStopCoords,
  selfServeArrivalGraceMinutes, annotateProjectedArrivals,
} = travelGap;

// Candidate (Palmetto) → neighbour (Bradenton): ~11.7 straight-line miles.
const PALMETTO = { lat: 27.545, lng: -82.545 };
const BRADENTON = { lat: 27.425, lng: -82.410 };
// Real Adam route pair from the arrival-grace plan's golden table (verified
// against the live driveMin model: lawn -> Canyon Creek = 11 modeled min).
const LAWN = { lat: 27.552283, lng: -82.391734 };
const CANYON_CREEK = { lat: 27.5901921, lng: -82.4392561 };

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION', 'SELF_SERVE_ARRIVAL_GRACE_MINUTES'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const gateOn = () => { process.env.GATE_SLOT_TRAVEL_GAP = 'true'; };

describe('buffer minutes (SLOT_TRAVEL_BUFFER_MINUTES)', () => {
  test('defaults to 15 and rejects garbage / negatives', () => {
    expect(DEFAULT_TRAVEL_BUFFER_MINUTES).toBe(15);
    expect(travelBufferMinutes()).toBe(15);
    process.env.SLOT_TRAVEL_BUFFER_MINUTES = '20';
    expect(travelBufferMinutes()).toBe(20);
    process.env.SLOT_TRAVEL_BUFFER_MINUTES = 'abc';
    expect(travelBufferMinutes()).toBe(15);
    process.env.SLOT_TRAVEL_BUFFER_MINUTES = '-5';
    expect(travelBufferMinutes()).toBe(15);
    process.env.SLOT_TRAVEL_BUFFER_MINUTES = '0';
    expect(travelBufferMinutes()).toBe(0);
  });
});

describe('requiredGapMinutes', () => {
  test('modeled drive + buffer; a coordless side is drive 0 but keeps the buffer', () => {
    const required = requiredGapMinutes(PALMETTO, BRADENTON);
    // Legacy model (gate off): 11.7 mi × 1.4 ÷ 30 mph ≈ 33 min, + 15.
    expect(required).toBeGreaterThanOrEqual(45);
    expect(required).toBeLessThanOrEqual(50);
    expect(requiredGapMinutes(PALMETTO, { lat: null, lng: null })).toBe(15);
    expect(requiredGapMinutes(null, BRADENTON)).toBe(15);
    expect(requiredGapMinutes({ lat: 'x', lng: -82.5 }, BRADENTON)).toBe(15);
  });
});

describe('travelGapViolation', () => {
  test('the field-report case: 9–10 touching a 10–11 stop 33 minutes away is a violation', () => {
    const v = travelGapViolation(
      { startMin: 540, endMin: 600, ...PALMETTO },
      { startMin: 600, endMin: 660, ...BRADENTON },
    );
    expect(v).toMatchObject({ gapMin: 0 });
    expect(v.requiredMin).toBeGreaterThan(40);
  });

  test('symmetric — the stop before the candidate is measured the same way', () => {
    const before = travelGapViolation(
      { startMin: 660, endMin: 720, ...PALMETTO },
      { startMin: 600, endMin: 660, ...BRADENTON },
    );
    expect(before).toMatchObject({ gapMin: 0 });
    // 60 free minutes clears ~48 required.
    expect(travelGapViolation(
      { startMin: 480, endMin: 540, ...PALMETTO },
      { startMin: 600, endMin: 660, ...BRADENTON },
    )).toBeNull();
  });

  test('coordless stop → buffer-only: 10 free minutes fails, 15 passes', () => {
    const stop = { startMin: 600, endMin: 660, lat: null, lng: null };
    expect(travelGapViolation({ startMin: 530, endMin: 590, ...PALMETTO }, stop)).toMatchObject({ gapMin: 10, requiredMin: 15 });
    expect(travelGapViolation({ startMin: 525, endMin: 585, ...PALMETTO }, stop)).toBeNull();
  });

  test('an overlap is a violation too (negative gap)', () => {
    const v = travelGapViolation(
      { startMin: 570, endMin: 630, lat: null, lng: null },
      { startMin: 600, endMin: 660, lat: null, lng: null },
    );
    expect(v.gapMin).toBeLessThan(0);
  });

  test('malformed windows never violate', () => {
    expect(travelGapViolation({ startMin: null, endMin: 600 }, { startMin: 600, endMin: 660 })).toBeNull();
    expect(travelGapViolation(null, { startMin: 600, endMin: 660 })).toBeNull();
  });
});

describe('travelGapConflicts — route neighbours only', () => {
  // ~24 straight-line miles south of Palmetto: ~67 modeled minutes + 15.
  const FAR_SOUTH = { lat: 27.20, lng: -82.545 };
  const candidate = { startMin: 675, endMin: 735, ...PALMETTO }; // 11:15–12:15
  const farEarlier = { startMin: 540, endMin: 600, ...FAR_SOUTH, id: 'far' }; // 9–10, 75 free min
  const adjacent = { startMin: 615, endMin: 660, ...PALMETTO, id: 'adjacent' }; // 10:15–11:00, 15 free min

  test('alone, the far stop is inside its required gap (pre-push P1 baseline)', () => {
    expect(travelGapConflicts(candidate, [farEarlier]).map((c) => [c.stop.id, c.reason]))
      .toEqual([['far', 'travel_gap']]);
  });

  test('with a stop between them, only the immediate neighbour is measured — the far stop is skipped', () => {
    expect(travelGapConflicts(candidate, [farEarlier, adjacent])).toEqual([]);
    // Same on the other side of the candidate.
    const farLater = { startMin: 810, endMin: 870, ...FAR_SOUTH, id: 'far-later' }; // 13:30, 75 free min
    const adjacentAfter = { startMin: 750, endMin: 795, ...PALMETTO, id: 'adj-after' }; // 12:30, 15 free min
    expect(travelGapConflicts(candidate, [farLater, adjacentAfter])).toEqual([]);
    expect(travelGapConflicts(candidate, [farLater]).map((c) => c.stop.id)).toEqual(['far-later']);
  });

  test('stops tied at the boundary are all neighbours — the farther tied stop still sets the gap', () => {
    const nearTied = { startMin: 615, endMin: 660, ...PALMETTO, id: 'near' };
    const farTied = { startMin: 600, endMin: 660, ...FAR_SOUTH, id: 'far' }; // same 11:00 end
    expect(travelGapConflicts(candidate, [nearTied, farTied]).map((c) => c.stop.id)).toEqual(['far']);
    expect(travelGapConflicts(candidate, [farTied, nearTied]).map((c) => c.stop.id)).toEqual(['far']);
    const nearAfter = { startMin: 750, endMin: 795, ...PALMETTO, id: 'near-after' };
    const farAfter = { startMin: 750, endMin: 810, ...FAR_SOUTH, id: 'far-after' }; // same 12:30 start
    expect(travelGapConflicts(candidate, [nearAfter, farAfter]).map((c) => c.stop.id)).toEqual(['far-after']);
  });

  test('a live hold is measured but never shadows the committed neighbour behind it', () => {
    // Far committed 9–10 stop, nearby hold 10:15–11:00 in front of it.
    const hold = { startMin: 615, endMin: 660, ...PALMETTO, id: 'hold', customer_id: null, reservation_expires_at: '2099-01-01T00:00:00Z' };
    const out = travelGapConflicts(candidate, [farEarlier, hold]).map((c) => [c.stop.id, c.reason]);
    expect(out).toEqual([['far', 'travel_gap']]); // the hold itself has 15 free minutes → fine
    // A hold sitting inside the gap is still a conflict on its own.
    const nearHold = { ...hold, id: 'near-hold', startMin: 625, endMin: 670 }; // 5 free min
    expect(travelGapConflicts(candidate, [nearHold]).map((c) => c.stop.id)).toEqual(['near-hold']);
    // A hold BEHIND a committed neighbour can never become adjacent — it is
    // not measured even when far away (r4 P2).
    const farHold = { ...hold, id: 'far-hold', startMin: 540, endMin: 600, ...FAR_SOUTH };
    expect(travelGapConflicts(candidate, [farHold, adjacent])).toEqual([]);
    // Without the committed stop in front of it, the same hold is adjacent and measured.
    expect(travelGapConflicts(candidate, [farHold]).map((c) => c.stop.id)).toEqual(['far-hold']);
    // Explicit flag wins over the column heuristic; a committed row with
    // reservation_expires_at cleared is a plain neighbour.
    expect(travelGapConflicts(candidate, [{ ...hold, hold: false }, farEarlier]).map((c) => c.stop.id)).toEqual([]);
  });

  test('every overlapping stop is a conflict regardless of position; malformed stops are skipped', () => {
    const overlapA = { startMin: 700, endMin: 720, id: 'a' };
    const overlapB = { startMin: 730, endMin: 800, id: 'b' };
    const out = travelGapConflicts(candidate, [overlapA, adjacent, { startMin: null, endMin: 5 }, overlapB]);
    expect(out.map((c) => [c.stop.id, c.reason])).toEqual([['a', 'overlap'], ['b', 'overlap']]);
    expect(travelGapConflicts(candidate, [])).toEqual([]);
    expect(travelGapConflicts({ startMin: NaN, endMin: 1 }, [adjacent])).toEqual([]);
  });
});

describe('expected-minutes padding (owner ruling 2026-09-23)', () => {
  // requiredGap(early, late) = drive + max(0, buffer - (early.windowMinutes
  // - early.expectedMinutes)) — padding credited to whichever side is
  // chronologically EARLY. A 60-min window with 45 expected minutes (a
  // quarterly-pest midpoint) has 15 minutes of padding, which fully absorbs
  // the default 15-minute buffer.
  test('11:00-12:00 (45 expected) before a stop at 12:00: passes when drive <= 15, fails past it', () => {
    const candidate = { startMin: 660, endMin: 720, windowMinutes: 60, expectedMinutes: 45, ...PALMETTO };
    // ~11.7mi Palmetto->Bradenton models to ~33 min drive - too far.
    expect(travelGapViolation(candidate, { startMin: 720, endMin: 780, ...BRADENTON })).not.toBeNull();
    // A stop 0 driven-minutes away (candidate and stop at the same point) is
    // well inside the reduced (drive-only, buffer fully absorbed) required gap.
    expect(travelGapViolation(candidate, { startMin: 720, endMin: 780, ...PALMETTO })).toBeNull();
  });

  test('symmetric: an EXISTING stop\'s own expected minutes absorb the buffer on ITS side', () => {
    // The stop (not the candidate) carries the expected-minutes signal —
    // same reduction, now credited to the stop because IT is the early side.
    const stop = { startMin: 660, endMin: 720, windowMinutes: 60, expectedMinutes: 45, ...PALMETTO };
    expect(travelGapViolation({ startMin: 720, endMin: 780, ...PALMETTO }, stop)).toBeNull();
    expect(travelGapViolation({ startMin: 720, endMin: 780, ...BRADENTON }, stop)).not.toBeNull();
  });

  test('the 2026-09-03 Palmetto/Bradenton case is still blocked — no expected-minutes signal on either side means zero padding', () => {
    gateOn();
    // Neither side carries windowMinutes/expectedMinutes (plain legacy
    // shape) -> padding 0 -> the untouched drive+buffer gap, same as the
    // pre-existing field-report regression test.
    const v = travelGapViolation(
      { startMin: 540, endMin: 600, ...PALMETTO },
      { startMin: 600, endMin: 660, ...BRADENTON },
    );
    expect(v).not.toBeNull();
    expect(v.requiredMin).toBeGreaterThan(40); // drive (~33) + full 15 buffer
  });

  test('a real overlap is never masked by expected-minutes padding', () => {
    gateOn();
    const candidate = { startMin: 600, endMin: 660, windowMinutes: 60, expectedMinutes: 20, ...PALMETTO };
    const stop = { startMin: 630, endMin: 690, windowMinutes: 60, expectedMinutes: 20, ...PALMETTO };
    const v = travelGapViolation(candidate, stop);
    expect(v).not.toBeNull();
    expect(v.gapMin).toBeLessThan(0);
  });

  test('padding never exceeds the window (a bogus expectedMinutes > window clamps to zero padding)', () => {
    gateOn();
    const candidate = { startMin: 660, endMin: 720, windowMinutes: 60, expectedMinutes: 999, ...PALMETTO };
    const v = travelGapViolation(candidate, { startMin: 720, endMin: 780, ...BRADENTON });
    expect(v).not.toBeNull();
    expect(v.requiredMin).toBeGreaterThan(40); // no padding credit — full buffer applies
  });
});

describe('violatesTravelGap (gate-checked)', () => {
  const candidate = { startMin: 540, endMin: 600, ...PALMETTO };
  const stops = [{ startMin: 600, endMin: 660, ...BRADENTON }];

  test('gate off → never violates, even on an overlap', () => {
    expect(violatesTravelGap(candidate, stops)).toBe(false);
    expect(violatesTravelGap({ startMin: 570, endMin: 630 }, [{ startMin: 600, endMin: 660 }])).toBe(false);
  });

  test('gate on → any stop inside the required gap violates; far stops do not', () => {
    gateOn();
    expect(violatesTravelGap(candidate, stops)).toBe(true);
    expect(violatesTravelGap(candidate, [{ startMin: 780, endMin: 840, ...BRADENTON }])).toBe(false);
    expect(violatesTravelGap(candidate, [])).toBe(false);
    expect(violatesTravelGap(candidate, null)).toBe(false);
  });

  test('the buffer env is read at call time', () => {
    gateOn();
    const near = { startMin: 610, endMin: 670, lat: null, lng: null };
    expect(violatesTravelGap({ startMin: 540, endMin: 600, lat: null, lng: null }, [near])).toBe(true);
    process.env.SLOT_TRAVEL_BUFFER_MINUTES = '10';
    expect(violatesTravelGap({ startMin: 540, endMin: 600, lat: null, lng: null }, [near])).toBe(false);
  });
});

describe('resolveStopCoords', () => {
  function chain(row) {
    const c = {
      where: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(row),
    };
    return c;
  }

  beforeEach(() => clearExpectedServiceMinutesCache());

  test('gate off → undefined with NO query (legacy statement set stays byte-identical)', async () => {
    expect(await resolveStopCoords(db, 'svc-1')).toBeUndefined();
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on → one guarded read (stamped pin, else non-divergent customer coords), plus the row\'s own expected-minutes credit', async () => {
    gateOn();
    // No service_key_snapshot/service_type on this row and no reachable
    // catalog (db mocked to one chain regardless of table) — degrades to
    // the window length (here estimated_duration_minutes' own 60 default),
    // i.e. no credit, same as every other reader with nothing to match.
    const c = chain({ lat: '27.5', lng: '-82.5' });
    db.mockReturnValue(c);
    db.raw = jest.fn((sql) => sql);
    expect(await resolveStopCoords(db, 'svc-1')).toEqual({ lat: 27.5, lng: -82.5, expectedMinutes: 60 });
    expect(c.leftJoin).toHaveBeenCalledWith('customers', 'scheduled_services.customer_id', 'customers.id');
    expect(db.raw.mock.calls.some(([sql]) => /COALESCE\(scheduled_services\.lat/.test(sql))).toBe(true);
  });

  // Codex r6 P1 — every rebooker probe (single reschedule AND rescheduleSeries,
  // both read this function's return as their `travel`) used to measure a
  // co-located candidate against the stop's FULL window regardless of how
  // little of it the stop's own catalog service actually expects to use,
  // rejecting a packed move availability.js/find-time.js had already offered.
  test('gate on → resolves the STOP\'s own catalog credit from its service_key_snapshot, clamped to its own duration', async () => {
    gateOn();
    const c = chain({
      lat: '27.5', lng: '-82.5',
      estimated_duration_minutes: 60,
      service_key_snapshot: 'quarterly_pest',
      service_type: 'Quarterly Pest Control Service',
    });
    const servicesChain = {
      select: jest.fn().mockResolvedValue([
        { service_key: 'quarterly_pest', name: 'Quarterly Pest Control Service', min_duration_minutes: 30, max_duration_minutes: 60 },
      ]),
    };
    db.mockImplementation((table) => (table === 'services' ? servicesChain : c));
    db.raw = jest.fn((sql) => sql);
    // Catalog midpoint (30+60)/2 = 45, clamped to the row's own 60-minute window.
    expect(await resolveStopCoords(db, 'svc-1')).toEqual({ lat: 27.5, lng: -82.5, expectedMinutes: 45 });
  });

  test('gate on → unknown pin or a failing read degrades to nulls (fail-open)', async () => {
    gateOn();
    db.raw = jest.fn((sql) => sql);
    db.mockReturnValue(chain({ lat: null, lng: null }));
    expect(await resolveStopCoords(db, 'svc-1')).toEqual({ lat: null, lng: null, expectedMinutes: 60 });
    db.mockImplementation(() => { throw new Error('boom'); });
    expect(await resolveStopCoords(db, 'svc-1')).toEqual({ lat: null, lng: null });
    expect(await resolveStopCoords(db, null)).toEqual({ lat: null, lng: null });
  });
});

describe('selfServeArrivalGraceMinutes (SELF_SERVE_ARRIVAL_GRACE_MINUTES, A1)', () => {
  const { etDateString } = require('../utils/datetime-et');
  // GATE_SLOT_TRAVEL_GAP on for every test in this block except the
  // dedicated "gate off" test below, which explicitly unsets it.
  beforeEach(gateOn);

  test('unset/blank/garbage/negative -> 0; a clean value passes through', () => {
    expect(selfServeArrivalGraceMinutes()).toBe(0);
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '';
    expect(selfServeArrivalGraceMinutes()).toBe(0);
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = 'abc';
    expect(selfServeArrivalGraceMinutes()).toBe(0);
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '-5';
    expect(selfServeArrivalGraceMinutes()).toBe(0);
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(selfServeArrivalGraceMinutes()).toBe(90);
  });

  test('clamps above the 120-minute arrival promise, with one warning', () => {
    const warn = jest.spyOn(require('../services/logger'), 'warn').mockImplementation(() => {});
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '200';
    expect(selfServeArrivalGraceMinutes()).toBe(120);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  // Claude fallback pre-push review (2026-09-28) P1: this reader runs on
  // every candidate slot, so a misconfigured value must not flood the log.
  test('the clamp warning never repeats for the SAME misconfigured value, but fires again for a NEW one', () => {
    const warn = jest.spyOn(require('../services/logger'), 'warn').mockImplementation(() => {});
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '250';
    expect(selfServeArrivalGraceMinutes({ date: '2099-01-01' })).toBe(120);
    expect(selfServeArrivalGraceMinutes({ date: '2099-01-02' })).toBe(120);
    expect(selfServeArrivalGraceMinutes()).toBe(120);
    expect(warn).toHaveBeenCalledTimes(1);
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '300';
    expect(selfServeArrivalGraceMinutes()).toBe(120);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test('returns 0 for today (ET) regardless of the configured value; a future date passes through', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(selfServeArrivalGraceMinutes({ date: etDateString() })).toBe(0);
    expect(selfServeArrivalGraceMinutes({ date: '2099-01-01' })).toBe(90);
  });

  test('no date given (multi-date caller) returns the raw configured value — the caller zeros today itself', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(selfServeArrivalGraceMinutes({})).toBe(90);
    expect(selfServeArrivalGraceMinutes()).toBe(90);
  });

  test('read at call time, not cached', () => {
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '30';
    expect(selfServeArrivalGraceMinutes()).toBe(30);
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '60';
    expect(selfServeArrivalGraceMinutes()).toBe(60);
    delete process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES;
    expect(selfServeArrivalGraceMinutes()).toBe(0);
  });

  // Codex round 1 on #5310: with the gate off, the commit-side probes fall
  // back to plain overlap SQL (no concept of "arrival" at all), so grace
  // can never be enforced there — an offer must not promise lateness the
  // commit gate can't check for. Forced to 0 regardless of the configured
  // value, the date, or whether it would otherwise have been clamped/warned.
  test('GATE_SLOT_TRAVEL_GAP off forces grace to 0 regardless of the configured value or date', () => {
    delete process.env.GATE_SLOT_TRAVEL_GAP;
    process.env.SELF_SERVE_ARRIVAL_GRACE_MINUTES = '90';
    expect(selfServeArrivalGraceMinutes()).toBe(0);
    expect(selfServeArrivalGraceMinutes({ date: '2099-01-01' })).toBe(0);
    expect(selfServeArrivalGraceMinutes({ date: etDateString() })).toBe(0);
    // Explicitly off (not just unset) behaves the same.
    process.env.GATE_SLOT_TRAVEL_GAP = 'false';
    expect(selfServeArrivalGraceMinutes()).toBe(0);
    // Flipping the gate back on (read at call time, no caching) restores it.
    gateOn();
    expect(selfServeArrivalGraceMinutes({ date: '2099-01-01' })).toBe(90);
  });
});

describe('annotateProjectedArrivals (A2 — the cascade fix)', () => {
  // Every stop below starts well after SHIFT.startMinutes (480, 08:00) and
  // carries no coords (driveMin(HQ, stop) fail-opens to 0), so the new
  // round-4 HQ-seed floor (max(startMin, SHIFT.startMinutes + driveHome))
  // is a no-op here — 480+0 never binds against an 08:00-or-later start.
  // These tests are therefore unchanged in INTENT from before that fix;
  // only the absolute minute-of-day values moved off midnight, which the
  // fix's floor now makes meaningful. The HQ-seed's own effect (both the
  // day-open floor and the drive term) is covered in its own describe
  // block below with real numbers.
  test('an isolated stop is on time; a chain of back-to-back stops compounds lateness forward', () => {
    // Three coordless (buffer-only) stops, default 15-min buffer, no padding
    // on any of them (windowMinutes === expectedMinutes) — each leg's
    // required gap is a clean 15.
    const A = { id: 'A', startMin: 480, endMin: 530, windowMinutes: 50, expectedMinutes: 50 }; // 08:00
    const B = { id: 'B', startMin: 540, endMin: 590, windowMinutes: 50, expectedMinutes: 50 }; // 09:00
    const C = { id: 'C', startMin: 600, endMin: 650, windowMinutes: 50, expectedMinutes: 50 }; // 10:00
    const out = annotateProjectedArrivals([A, B, C]).map((s) => ({ id: s.id, arrivalMin: s.arrivalMin }));
    // A: no prior neighbour -> on time (its own 08:00 start already clears
    //    the HQ-seed floor of 480 + 0 drive = 480).
    // B: A effectively ends at 530; +15 required = 545 > B's own 540 start -> 5 min late.
    // C: B (late) effectively ends at 545+50=595; +15 required = 610 > C's own
    //    600 start -> 10 min late — B's OWN 5 minutes of lateness compounds
    //    into a full 10 for C, not the 5 a first-stop-only model would give.
    expect(out).toEqual([{ id: 'A', arrivalMin: 480 }, { id: 'B', arrivalMin: 545 }, { id: 'C', arrivalMin: 610 }]);
  });

  test('input order does not matter — the chain always sorts by start first', () => {
    const A = { id: 'A', startMin: 480, endMin: 530, windowMinutes: 50, expectedMinutes: 50 };
    const B = { id: 'B', startMin: 540, endMin: 590, windowMinutes: 50, expectedMinutes: 50 };
    const C = { id: 'C', startMin: 600, endMin: 650, windowMinutes: 50, expectedMinutes: 50 };
    expect(annotateProjectedArrivals([C, A, B]).map((s) => s.arrivalMin)).toEqual([480, 545, 610]);
  });

  test('a coordless stop stays buffer-only (fail-open) inside the chain', () => {
    const A = { id: 'A', startMin: 480, endMin: 530, windowMinutes: 50, expectedMinutes: 50, lat: null, lng: null };
    const B = { id: 'B', startMin: 535, endMin: 580, windowMinutes: 45, expectedMinutes: 45, lat: null, lng: null };
    // required(A,B) = 0 drive + 15 buffer = 15; A ends at 530, so B's real
    // arrival floors at 545, 10 minutes past its own 535 start.
    expect(annotateProjectedArrivals([A, B])[1].arrivalMin).toBe(545);
  });
});

// The HQ-seed fix itself (Codex round 4 P1 on #5310): the FIRST stop in the
// chain floors at max(startMin, SHIFT.startMinutes + driveMin(HQ, stop)) —
// mirroring find-time.js's own hqStartArrivalFloor formula exactly (same
// SHIFT.startMinutes anchor, same HQ coords) — rather than assuming that
// stop itself starts on time.
describe('annotateProjectedArrivals — the first stop is seeded from its own HQ arrival, not assumed on time (Codex round 4 on #5310)', () => {
  test('a coordless first stop still floors at the fixed day-open anchor (SHIFT.startMinutes), even with 0 drive', () => {
    const early = { id: 'early', startMin: 420, endMin: 460, windowMinutes: 40, expectedMinutes: 40, lat: null, lng: null }; // 07:00, before day-open
    // 420 (07:00) < 480 (day-open) + 0 (no coords) -> floors at 480.
    expect(annotateProjectedArrivals([early])[0].arrivalMin).toBe(480);
  });

  test('a first stop with real coords floors at day-open PLUS the real HQ drive (offer/commit parity with find-time\'s hqStartArrivalFloor)', () => {
    // Same coordinates the leading-gap parity suite (find-time-hq-leading-gap-grace.test.js)
    // uses, mocked to the identical 56-minute HQ->stop drive there — this is
    // the deliberately UNMOCKED version, using the real haversine/mileage
    // model, so the exact minute value below is re-derived independently
    // rather than assumed equal; it only needs to be the SAME formula
    // (SHIFT.startMinutes + driveMin(HQ, stop)), not a specific number.
    const { HQ, driveMin } = require('../services/auto-dispatch/geo');
    const stopCoords = { lat: 27.4, lng: -82.4 };
    const realDriveHome = driveMin(HQ, stopCoords);
    expect(realDriveHome).toBeGreaterThan(0); // sanity: these coords are genuinely apart from HQ
    const stop = {
      id: 'stop', startMin: 480, endMin: 540, windowMinutes: 60, expectedMinutes: 60, ...stopCoords,
    }; // offered at exactly 08:00 (day-open) — a graced leading-gap offer
    expect(annotateProjectedArrivals([stop])[0].arrivalMin).toBe(480 + realDriveHome);
  });

  test('offer/commit parity: the SAME 56-minute HQ->stop drive find-time-hq-leading-gap-grace.test.js mocks produces the SAME seed here', () => {
    // Mirrors that suite's own header comment: haversine mocked to a
    // constant 20 miles -> 56 minutes via the real (unmocked)
    // milesToDriveMinutes model, day-open 08:00 (480) -> hqStartArrivalFloor
    // there is 480 + 56 = 536. This test proves travel-gap.js's own
    // first-stop seed computes the IDENTICAL 536 from the SAME inputs
    // (SHIFT.startMinutes, the real milesToDriveMinutes calibration) — the
    // whole point of round 4's fix being "the SAME day-open source and HQ
    // coords find-time's HQ_START uses".
    jest.resetModules();
    jest.doMock('../services/route-optimizer', () => ({
      ...jest.requireActual('../services/route-optimizer'),
      haversine: () => 20,
    }));
    let isolatedTravelGap;
    jest.isolateModules(() => {
      isolatedTravelGap = require('../services/scheduling/travel-gap');
    });
    const stop = { id: 'stop', startMin: 480, endMin: 540, windowMinutes: 60, expectedMinutes: 60, lat: 27.4, lng: -82.4 };
    expect(isolatedTravelGap.annotateProjectedArrivals([stop])[0].arrivalMin).toBe(536);
    jest.dontMock('../services/route-optimizer');
  });
});

describe('arrival grace — travelGapViolation (A3/A6)', () => {
  // The plan's own G1 "live miss": Adam's real lawn stop (10:00-11:00, 50
  // expected minutes of a 60-min window) followed by a Canyon Creek estimate
  // candidate (11:00-11:30) — required 16 (11 modeled drive + 5 of buffer
  // left after lawn's own 10 minutes of padding), gap 10, so 6 minutes late.
  const lawnStop = { startMin: 600, endMin: 660, windowMinutes: 60, expectedMinutes: 50, ...LAWN };
  const ccCandidate = (graceMinutes) => ({
    startMin: 660, endMin: 690, windowMinutes: 30, expectedMinutes: 30, ...CANYON_CREEK, graceMinutes,
  });

  test('G1 — hidden at grace 0, offered (6 min late) at grace 90', () => {
    expect(requiredGapMinutes(lawnStop, ccCandidate(0))).toBe(16);
    const refused = travelGapViolation(ccCandidate(0), lawnStop);
    expect(refused).toEqual({ gapMin: 10, requiredMin: 16, lateMin: 6 });
    expect(travelGapViolation(ccCandidate(90), lawnStop)).toBeNull();
  });

  test('boundary inclusive: late == grace passes, late == grace + 1 refuses', () => {
    const prev = { startMin: 600, endMin: 660, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null };
    const cand = (grace) => ({ startMin: 660, endMin: 690, windowMinutes: 30, expectedMinutes: 30, lat: null, lng: null, graceMinutes: grace });
    // required = 0 drive + 15 buffer (no padding either side); candidate
    // starts exactly when prev ends -> lateMin === requiredMin === 15.
    expect(travelGapViolation(cand(15), prev)).toBeNull();
    expect(travelGapViolation(cand(14), prev)).toEqual({ gapMin: 0, requiredMin: 15, lateMin: 15 });
  });

  test('G3 — a real overlap is never graced, however large graceMinutes is', () => {
    const overlapping = { startMin: 630, endMin: 660, windowMinutes: 30, expectedMinutes: 30, ...LAWN, graceMinutes: 999 };
    const v = travelGapViolation(overlapping, lawnStop);
    expect(v).not.toBeNull();
    expect(v.gapMin).toBeLessThan(0);
    expect(v.lateMin).toBeUndefined();
  });

  test('decision 5 — the EARLIER side never reads grace: a candidate packed before a stop stays strict', () => {
    const stop = { startMin: 720, endMin: 780, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null };
    // Candidate ends exactly at requiredMin free time; graceMinutes on the
    // candidate must not rescue a candidate that is genuinely too close to
    // the stop AFTER it (the stop's own promise is not the candidate's to spend).
    const tooClose = { startMin: 600, endMin: 706, windowMinutes: 106, expectedMinutes: 106, lat: null, lng: null, graceMinutes: 999 };
    expect(travelGapViolation(tooClose, stop)).toEqual({ gapMin: 14, requiredMin: 15 });
  });

  test('A6 — a live hold gets no grace on its own next-side check', () => {
    const hold = { startMin: 600, endMin: 660, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null, hold: true };
    const late = { startMin: 660, endMin: 690, windowMinutes: 30, expectedMinutes: 30, lat: null, lng: null, graceMinutes: 90 };
    // Candidate starts exactly when the hold ends -> 15 min "late" against
    // the 15-min buffer-only required gap; grace 90 would normally clear it,
    // but a hold always demands the strict (0) allowance.
    expect(travelGapViolation(late, hold)).toEqual({ gapMin: 0, requiredMin: 15, lateMin: 15 });
    // The identical committed (non-hold) stop is graced normally.
    expect(travelGapViolation(late, { ...hold, hold: false })).toBeNull();
  });
});

describe('arrival grace — travelGapConflicts (A4 — projection through the day)', () => {
  const lawnStop = { id: 'lawn', startMin: 600, endMin: 660, windowMinutes: 60, expectedMinutes: 50, ...LAWN };
  const ccCandidate = (graceMinutes) => ({
    startMin: 660, endMin: 690, windowMinutes: 30, expectedMinutes: 30, ...CANYON_CREEK, graceMinutes,
  });

  beforeEach(() => { process.env.SLOT_TRAVEL_BUFFER_MINUTES = '25'; });

  test('G1 via travelGapConflicts: hidden at grace 0, offered at grace 90', () => {
    expect(travelGapConflicts(ccCandidate(0), [lawnStop]).map((c) => c.reason)).toEqual(['travel_gap']);
    expect(travelGapConflicts(ccCandidate(90), [lawnStop])).toEqual([]);
  });

  test('G4/G5 — the AFTER side is measured from the candidate\'s own PROJECTED arrival, not its nominal window', () => {
    // A naive (unprojected) check would measure the candidate's own window
    // end (11:30) against `next` and wrongly pass a gap the tech's real
    // (6-minutes-late) arrival cannot actually clear.
    const nextTooSoon = { id: 'next', startMin: 720, endMin: 780, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null }; // 12:00-13:00
    const conflicts = travelGapConflicts(ccCandidate(90), [lawnStop, nextTooSoon]);
    expect(conflicts.map((c) => [c.stop.id, c.reason])).toEqual([['next', 'travel_gap']]);
    // G5 — a next stop 30 minutes later clears even the projected arrival.
    const nextFine = { ...nextTooSoon, id: 'next-fine', startMin: 750, endMin: 810 }; // 12:30-13:30
    expect(travelGapConflicts(ccCandidate(90), [lawnStop, nextFine])).toEqual([]);
  });

  test('the before-neighbour selection itself is unchanged — only when it is done changes', () => {
    // A far-earlier stop and lawn (the true immediate neighbour) both
    // precede the candidate; only lawn is ever measured, exactly like the
    // pre-grace neighbours-only rule.
    const farEarlier = { id: 'far', startMin: 0, endMin: 60, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null };
    expect(travelGapConflicts(ccCandidate(90), [farEarlier, lawnStop]).map((c) => c.stop.id)).toEqual([]);
  });
});

describe('arrival grace — cascade / ordering (G9-G12 shapes)', () => {
  beforeEach(() => { process.env.SLOT_TRAVEL_BUFFER_MINUTES = '40'; });

  test('G9/G10 — a live hold ahead of a graced /book candidate is measured strictly; ordering alone decides who keeps the slot', () => {
    const holdX = { id: 'X', startMin: 660, endMin: 690, windowMinutes: 30, expectedMinutes: 30, lat: null, lng: null, hold: true }; // 11:00-11:30
    const candidateY = { startMin: 720, endMin: 780, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null, graceMinutes: 90 }; // 12:00-13:00
    // required(X,Y) = 40 (buffer-only); gap = 720-690 = 30 < 40 -> refused,
    // even though Y's own grace is 90 — a live hold gets none (A6).
    expect(travelGapConflicts(candidateY, [holdX]).map((c) => c.reason)).toEqual(['travel_gap']);

    // Reverse the order: Y is now the COMMITTED stop; X (a fresh candidate,
    // whatever its own grace) is measured on ITS next side, which is always
    // strict (decision 5) — it is refused for not fitting before Y, exactly
    // as before this lane existed.
    const committedY = { id: 'Y', startMin: 720, endMin: 780, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null };
    const freshX = { startMin: 660, endMin: 690, windowMinutes: 30, expectedMinutes: 30, lat: null, lng: null, graceMinutes: 90 };
    expect(travelGapConflicts(freshX, [committedY]).map((c) => c.reason)).toEqual(['travel_gap']);
  });

  test('G11/G12 shape — a chain of graced bookings is measured from where the tech will REALLY be, catching lateness a single-hop check would miss', () => {
    const A = { id: 'A', startMin: 600, endMin: 650, windowMinutes: 50, expectedMinutes: 50, lat: null, lng: null }; // 10:00
    const B = { id: 'B', startMin: 660, endMin: 710, windowMinutes: 50, expectedMinutes: 50, lat: null, lng: null }; // 11:00
    const C = { id: 'C', startMin: 720, endMin: 770, windowMinutes: 50, expectedMinutes: 50, lat: null, lng: null }; // 12:00
    // annotateProjectedArrivals: A on time; B's required gap from A is 40 ->
    // 650+40=690 > B's own 660 start -> B arrives 30 late; C's required gap
    // from (late) B is 40 -> (690+50)+40=780 > C's own 720 start -> C would
    // arrive 60 late — the compounded lateness, not the 30 a fresh
    // measurement against C's OWN stored (never-late) start would show.
    const D = (grace) => ({ startMin: 780, endMin: 810, windowMinutes: 30, expectedMinutes: 30, lat: null, lng: null, graceMinutes: grace }); // 13:00, after C
    // required(C,D) = 40; measured from C's real (projected, 60-late)
    // effective end (720+60+50=830) the free time is 780-830 = -50 (already
    // overlapping the promise), so D needs at least 50 + 40 = 90 minutes of
    // grace headroom just to clear the chain, not the naive 40 - (780-770)=30.
    expect(travelGapConflicts(D(89), [A, B, C]).map((c) => c.reason)).toEqual(['travel_gap']);
    expect(travelGapConflicts(D(90), [A, B, C])).toEqual([]);
  });
});

// Day-end bound (Codex round 3 P1 on #5310): find-time.js's own HQ_END
// sentinel already refuses to OFFER a graced candidate whose real arrival
// cannot finish its own work and (when the offer counts one) drive home
// before the customer day closes. travelGapConflicts had no equivalent —
// it only ever compares a candidate against OTHER real stops, so a
// candidate with no real stop after it (the day's last stop) never hit any
// check here at all. currentDayEndMinutes() falls back to its fixed
// 18:00 (1080) default in this file — nothing here ever populates
// customer-windows.js's cache.
describe('arrival grace — day-end bound at commit (Codex round 3 on #5310)', () => {
  beforeEach(() => { process.env.SLOT_TRAVEL_BUFFER_MINUTES = '30'; });

  // A real 16:00-17:00 stop (no padding), no coords. required(before, candidate)
  // = 0 drive + 30 buffer = 30, so the candidate's own real (projected)
  // arrival floors at max(candidate.startMin, 1020 + 30) = 1050 (17:30) —
  // a 30-minute-late arrival the ordinary pairwise check tolerates fine at
  // grace 90 (lateMin 30 <= 90), so nothing about the NEIGHBOUR check
  // objects; only the day itself might run out of room.
  const before = { id: 'before', startMin: 960, endMin: 1020, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null }; // 16:00-17:00
  const candidate = (durationMinutes, graceMinutes) => ({
    startMin: 1020, endMin: 1020 + durationMinutes, windowMinutes: durationMinutes, expectedMinutes: durationMinutes,
    lat: null, lng: null, graceMinutes,
  }); // 17:00 offered start

  test('17:00 slot, projected arrival 17:30, a 45-minute job would finish at 18:15 — refused at commit (day-end, no specific stop to blame)', () => {
    // arrivalFloor 1050 + ownDuration 45 + driveHome 0 = 1095 > 1080 (18:00).
    const conflicts = travelGapConflicts(candidate(45, 90), [before]);
    expect(conflicts.map((c) => ({ stop: c.stop, reason: c.reason }))).toEqual([{ stop: null, reason: 'day_end' }]);
  });

  test('the identical shape but a 25-minute job (finishes at 17:55) is within bound — no conflict', () => {
    // arrivalFloor 1050 + ownDuration 25 + driveHome 0 = 1075 <= 1080.
    expect(travelGapConflicts(candidate(25, 90), [before])).toEqual([]);
  });

  test('exactly at the boundary (finishes at 18:00) is fine; one minute over is refused', () => {
    // 1050 + 30 = 1080 (== dayEnd, not a violation); 1050 + 31 = 1081.
    expect(travelGapConflicts(candidate(30, 90), [before])).toEqual([]);
    expect(travelGapConflicts(candidate(31, 90), [before]).map((c) => c.reason)).toEqual(['day_end']);
  });

  // Codex round 4 pre-push audit (Claude fallback) P1: travelGapConflicts
  // used to bail to [] the instant `stops` was empty, BEFORE the day-end
  // check ever ran — a graced candidate on a day with NO other stops at
  // all (the ONLY stop that day) hit no check whatsoever at commit, while
  // find-time's own HQ_END sentinel already refuses this exact shape at
  // offer time (an empty day's one gap is HQ_START -> HQ_END directly).
  test('an empty day (no other stops at all) still gets the day-end check — a 90-minute job starting at 17:00 would finish at 18:30', () => {
    // arrivalFloor: no before/after neighbour at all, so it falls to the
    // HQ-seed floor max(1020, 480 + 0 drive) = 1020 (candidate's own start
    // already clears day-open here). 1020 + 90 + 0 = 1110 > 1080.
    const conflicts = travelGapConflicts(candidate(90, 90), []);
    expect(conflicts.map((c) => ({ stop: c.stop, reason: c.reason }))).toEqual([{ stop: null, reason: 'day_end' }]);
  });

  test('an empty day, within bound (a 60-minute job finishing at 18:00) — no conflict', () => {
    expect(travelGapConflicts(candidate(60, 90), [])).toEqual([]);
  });

  test('an empty day, grace 0 — byte-identical, still returns [] (this function never had a day-end check before this lane, and grace 0 still gates it off)', () => {
    expect(travelGapConflicts(candidate(90, 0), [])).toEqual([]);
  });

  test('grace 0 is byte-identical: the day-end check never even runs, whatever the duration', () => {
    // Same 45-minute job that was refused above at grace 90 — at grace 0,
    // candidateForAfterSide is `candidate` unchanged (no projected
    // lateness to check with), and this module has never had a day-end
    // check of its own before this lane, so it stays silent here; the
    // EXISTING stored-window day-end checks elsewhere (slot-reservation.js
    // et al.) are the only authority at grace 0, unchanged by this fix.
    // (The ordinary pairwise check against `before` still fires at grace 0
    // — unrelated to this fix, and unaffected by it — since a 0-minute
    // allowance can't absorb `before`'s own 30-minute required gap; only
    // the absence of a 'day_end' reason is this test's own claim.)
    expect(travelGapConflicts(candidate(45, 0), [before]).map((c) => c.reason)).not.toContain('day_end');
  });

  test('a real stop AFTER the candidate exempts it entirely — it is not the day\'s last stop', () => {
    const after = { id: 'after', startMin: 1200, endMin: 1260, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null }; // 20:00-21:00, well past "close" so it would never itself be offered, but its mere presence proves the day-end branch is skipped once there IS a later stop
    expect(travelGapConflicts(candidate(45, 90), [before, after]).map((c) => c.reason)).not.toContain('day_end');
  });
});

// Combined allocations (Codex round 4 P2 on #5310): a version-2 combined
// visit's members are each expanded (occupiedRows/stopCreditResolver, in
// buildDayStops/buildTravelGapStops) to the SAME allocation-summed
// {startMin, endMin, expectedMinutes} — duplicates of one physical stop,
// not consecutive ones. Chaining them as separate stops applied a full
// travel-gap buffer BETWEEN simultaneous co-located members, projecting a
// later candidate's required start well past what the tech's actual route
// needs and hiding genuinely open slots.
describe('annotateProjectedArrivals coalesces combined-allocation members into one logical stop (Codex round 4 P2 on #5310)', () => {
  // A 2-member 09:00-11:00 combined visit (540-660), no coords, no padding
  // (windowMinutes === expectedMinutes on each member) — exactly what
  // buildDayStops/buildTravelGapStops hand this function once
  // stopCreditResolver has summed the members' own credit onto each.
  const member1 = {
    id: 'm1', startMin: 540, endMin: 660, windowMinutes: 120, expectedMinutes: 120, lat: null, lng: null, allocationKey: 'alloc-1',
  };
  const member2 = {
    id: 'm2', startMin: 540, endMin: 660, windowMinutes: 120, expectedMinutes: 120, lat: null, lng: null, allocationKey: 'alloc-1',
  };

  test('both members of the group share ONE projected arrival — not a buffer chained between them', () => {
    const out = annotateProjectedArrivals([member1, member2]);
    // 540 clears the HQ-seed floor (480 + 0 drive) — on time, on both.
    expect(out.map((s) => s.arrivalMin)).toEqual([540, 540]);
  });

  test('a later candidate at 11:15 (675) — exactly 15 minutes (the plain buffer) after the group\'s REAL 11:00 end — is not hidden (grace 90)', () => {
    // Buggy math (member1 on time at 540/660; member2 chained AFTER member1
    // with a spurious 15-min buffer between "simultaneous" stops) would
    // project member2's own arrival at 660+15=675, effective end
    // 675+120=795, demanding the candidate clear 795+15=810 — 675 (135
    // minutes late) exceeds even a 90-minute grace, hiding a slot the real
    // route has no problem with. Fixed: both members share arrivalMin 540,
    // effective end 660, so the candidate only needs to clear 660+15=675 —
    // exactly on time (0 minutes late), well inside grace.
    const candidate = {
      startMin: 675, endMin: 735, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null, graceMinutes: 90,
    }; // 11:15-12:15
    expect(travelGapConflicts(candidate, [member1, member2])).toEqual([]);
  });

  test('grace 0 is byte-identical: allocationKey grouping never runs (annotateProjectedArrivals is never called)', () => {
    const candidate = {
      startMin: 675, endMin: 735, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null, graceMinutes: 0,
    };
    // Unaffected either way at grace 0 — travelGapConflicts falls back to
    // the plain (ungrouped) pairwise check, exactly as before this fix.
    expect(travelGapConflicts(candidate, [member1, member2])).toEqual([]);
  });

  test('an allocationKey that does not match anything else never groups (ordinary rows stay pairwise)', () => {
    const solo1 = { id: 's1', startMin: 540, endMin: 600, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null };
    const solo2 = { id: 's2', startMin: 600, endMin: 660, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null };
    const out = annotateProjectedArrivals([solo1, solo2]);
    // Ordinary consecutive stops: solo2 still chains normally off solo1
    // (540+60=600, +15 buffer = 615 > solo2's own 600 start -> 15 late).
    expect(out.map((s) => s.arrivalMin)).toEqual([540, 615]);
  });
});

// Grouped visits (visit_id, Codex round 4 P2 on #5310 proactive scan): a
// service-visit group's members are NOT pre-expanded to a shared span or
// summed credit the way a v2 allocation's are (occupiedRows only expands
// allocationKey rows) — the SAME "duplicate rows, one real stop" chaining
// bug, with a DIFFERENT (un-pre-summed, possibly staggered-window) input
// shape, so it needs its own combine step (combinedStopEntity's visit_id
// branch: MIN start to MAX end, SUM of each member's own expected minutes).
describe('annotateProjectedArrivals coalesces visit_id groups too, including staggered (overlapping, not identical) member windows', () => {
  // Two grouped members at the SAME property (no coords, kept simple), a
  // 9:00-10:00 first member and a 9:30-11:00 second member — a real
  // visit-group shape (visit-groups.js: "same customer, property, date,
  // OVERLAPPING window", never required to be identical the way a v2
  // allocation's shared window_start is).
  const m1 = { id: 'v1a', startMin: 540, endMin: 600, expectedMinutes: 60, lat: null, lng: null, visit_id: 'visit-1' }; // 09:00-10:00
  const m2 = { id: 'v1b', startMin: 570, endMin: 660, expectedMinutes: 90, lat: null, lng: null, visit_id: 'visit-1' }; // 09:30-11:00

  test('both members share ONE projected arrival, combined bounds MIN-start/MAX-end, expected minutes SUMMED (150, clamped to the 120-minute combined window)', () => {
    const out = annotateProjectedArrivals([m1, m2]);
    expect(out.map((s) => s.arrivalMin)).toEqual([540, 540]); // on time (540 clears the 480 HQ-seed floor)
  });

  test('a later candidate at 09:36 (676) — 1 minute past the group\'s REAL 15-min-buffered end (660+15=675) — is not hidden (grace 40)', () => {
    // Buggy (ungrouped) math: m2 chains off m1 as a separate stop (arrival
    // 615, effective end 615+90=705), demanding the candidate clear
    // 705+15=720 — 720-676=44 minutes late, over even a 40-minute grace.
    // Fixed: the group's own combined effective end is 540+min(150,120)=660,
    // so the candidate only needs to clear 660+15=675 — exactly on time.
    const candidate = { startMin: 676, endMin: 706, expectedMinutes: 30, lat: null, lng: null, graceMinutes: 40 };
    expect(travelGapConflicts(candidate, [m1, m2])).toEqual([]);
  });

  test('grace 0 is byte-identical: visit_id grouping never runs (annotateProjectedArrivals is never called)', () => {
    const candidate = { startMin: 676, endMin: 706, expectedMinutes: 30, lat: null, lng: null, graceMinutes: 0 };
    expect(travelGapConflicts(candidate, [m1, m2])).toEqual([]);
  });

  test('a solo visit_id (no other member sharing it) never groups with an unrelated stop', () => {
    const solo = { id: 'solo-visit', startMin: 540, endMin: 600, expectedMinutes: 60, lat: null, lng: null, visit_id: 'visit-2' };
    const unrelated = { id: 'other', startMin: 600, endMin: 650, expectedMinutes: 50, lat: null, lng: null };
    const out = annotateProjectedArrivals([solo, unrelated]);
    // Ordinary chain: unrelated still measured against solo normally
    // (600+60=660... wait solo's own window is 540-600 already, expected 60
    // = no padding, effective end 600; +15 buffer = 615 > unrelated's own
    // 600 start -> 15 late), proving no accidental grouping with a
    // DIFFERENT visit_id (or none at all).
    expect(out.map((s) => s.arrivalMin)).toEqual([540, 615]);
  });

  test('visit_id takes precedence over allocationKey when (implausibly) both are set on the same row — matches groupRouteStops\' own key precedence', () => {
    const a = {
      id: 'x1', startMin: 540, endMin: 600, expectedMinutes: 60, lat: null, lng: null, visit_id: 'v-both', allocationKey: 'alloc-should-be-ignored',
    };
    const b = {
      id: 'x2', startMin: 540, endMin: 600, expectedMinutes: 60, lat: null, lng: null, visit_id: 'v-both', allocationKey: 'a-different-alloc-key',
    };
    // Grouped by visit_id (both 'v-both') despite mismatched allocationKeys
    // — proves visit_id is checked first, not allocationKey.
    const out = annotateProjectedArrivals([a, b]);
    expect(out.map((s) => s.arrivalMin)).toEqual([540, 540]);
  });
});

// Codex round 6 P1s on #5310 — both projectGraceForCandidate consumers that
// had drifted from projectDayChain (the SAME timeline annotateProjectedArrivals
// walks), found by a structural review after rounds 4-5 kept surfacing one
// input path at a time.
describe('projectGraceForCandidate routes through projectDayChain, not a second parallel formula (Codex round 6 on #5310)', () => {
  beforeEach(() => { process.env.SLOT_TRAVEL_BUFFER_MINUTES = '15'; });

  // Finding #1 (travel-gap.js:518): a candidate with NO real stop before it
  // used to reach the after-side check completely unannotated (no
  // arrivalMin at all), so its effective end was measured from its bare,
  // possibly-graced-early advertised start rather than its own real HQ
  // arrival — silently accepting a later real stop its true (late) finish
  // would actually collide with.
  describe('a first-of-day candidate (no before-neighbour) is measured from its REAL HQ arrival against a later stop', () => {
    // Same mocked-haversine precedent as find-time-hq-leading-gap-grace.test.js
    // (20 miles -> 56 minutes via the real, unmocked milesToDriveMinutes
    // model): dayOpen 08:00 (480) + 56 = HQ arrival 536 (08:56). Candidate
    // offered 08:00-09:00 (480-540, no padding), grace 90 (offering 56
    // minutes before the real HQ arrival is comfortably inside a 90-minute
    // grace). Real finish (effective end) = 536 + 60 = 596 (09:56); +15
    // buffer = 611 (10:11) is the earliest a later stop can safely start.
    function loadIsolatedTravelGap() {
      let isolated;
      jest.isolateModules(() => {
        jest.doMock('../services/route-optimizer', () => ({
          ...jest.requireActual('../services/route-optimizer'),
          haversine: () => 20,
        }));
        isolated = require('../services/scheduling/travel-gap');
      });
      jest.dontMock('../services/route-optimizer');
      return isolated;
    }
    const candidate = { startMin: 480, endMin: 540, windowMinutes: 60, expectedMinutes: 60, lat: 27.4, lng: -82.4, graceMinutes: 90 };

    test('a new stop at 10:00 (600) — 11 minutes short of the real 10:11 clearance — is refused, not silently accepted', () => {
      const isolatedTravelGap = loadIsolatedTravelGap();
      const newStop = { id: 'new', startMin: 600, endMin: 660, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null };
      const conflicts = isolatedTravelGap.travelGapConflicts(candidate, [newStop]);
      expect(conflicts.map((c) => c.reason)).toEqual(['travel_gap']);
    });

    test('a new stop at 10:15 (615), past the real clearance, is fine', () => {
      const isolatedTravelGap = loadIsolatedTravelGap();
      const newStop = { id: 'new', startMin: 615, endMin: 675, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null };
      expect(isolatedTravelGap.travelGapConflicts(candidate, [newStop])).toEqual([]);
    });

    test('grace 0 is byte-identical: the SAME 10:00 stop is fine (no HQ-lateness concept at grace 0 — the un-graced code path never offered a start earlier than it could reach anyway)', () => {
      const isolatedTravelGap = loadIsolatedTravelGap();
      const newStop = { id: 'new', startMin: 600, endMin: 660, windowMinutes: 60, expectedMinutes: 60, lat: null, lng: null };
      expect(isolatedTravelGap.travelGapConflicts({ ...candidate, graceMinutes: 0 }, [newStop])).toEqual([]);
    });
  });

  // Finding #2 (travel-gap.js:438/518's `annotate`): a candidate placed
  // right after a visit_id group used to be measured against ONE member's
  // own individual (un-combined) credit, understating the group's real
  // combined occupancy.
  describe('a candidate after a visit_id group is measured against the GROUP\'S combined effective end, not one member\'s own', () => {
    // Same staggered-window group as the coalescing describe block above:
    // m1 09:00-10:00 (own credit 60), m2 09:30-11:00 (own credit 90) — group
    // arrives on time at 540 (09:00, clears the 480 HQ-seed floor). A
    // candidate can never start before m2's own RAW end (660, 11:00 — a
    // real overlap regardless of any credit, G3), so the observable
    // difference is what happens for a candidate starting JUST past that
    // raw floor: fixed combined credit SUMS to 150, clamped to the
    // 120-minute combined window (540-660) -> real combined effective end
    // 660, +15 buffer = 675 (11:15). The BUGGY per-member read instead
    // based effectiveEnd on m2's own 90-minute credit from the SHARED
    // (group) arrival 540 -> 630 — 30 minutes BELOW m2's own raw end (660),
    // so the buggy gap check was never even binding past the overlap floor:
    // it would have accepted ANY start at/after 660 with 0 minutes to
    // spare, when the route genuinely needs 675.
    const m1 = { id: 'v2a', startMin: 540, endMin: 600, expectedMinutes: 60, lat: null, lng: null, visit_id: 'visit-6' };
    const m2 = { id: 'v2b', startMin: 570, endMin: 660, expectedMinutes: 90, lat: null, lng: null, visit_id: 'visit-6' };
    const candidate = (graceMinutes) => ({
      startMin: 665, endMin: 685, windowMinutes: 20, expectedMinutes: 20, lat: null, lng: null, graceMinutes,
    }); // 11:05, just past m2's own raw end (660) — never an overlap either way

    test('grace 5 — the BUGGY threshold (645) says 0 minutes late and passes; the REAL 675 threshold says 10 minutes late, over a 5-minute grace — refused', () => {
      expect(travelGapConflicts(candidate(5), [m1, m2]).map((c) => c.reason)).toEqual(['travel_gap']);
    });

    test('grace 10 — exactly covers the real 10-minute lateness — fine; grace 9 does not', () => {
      expect(travelGapConflicts(candidate(10), [m1, m2])).toEqual([]);
      expect(travelGapConflicts(candidate(9), [m1, m2]).map((c) => c.reason)).toEqual(['travel_gap']);
    });

    test('grace 0 is byte-identical: the ordinary (non-grouped) pairwise check against m2 alone still applies, unrelated to this fix', () => {
      // m2's own raw end (660) + 15 buffer = 675 > 665 -> still a plain
      // travel_gap violation at grace 0, same as before this whole lane —
      // grace 0 never reads any credited/combined shape at all.
      expect(travelGapConflicts(candidate(0), [m1, m2]).map((c) => c.reason)).toEqual(['travel_gap']);
    });
  });
});
