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

const {
  DEFAULT_TRAVEL_BUFFER_MINUTES, travelBufferMinutes, requiredGapMinutes,
  travelGapViolation, travelGapConflicts, violatesTravelGap, resolveStopCoords,
} = travelGap;

// Rod (Palmetto) → Paul (Bradenton 34211): ~11.7 straight-line miles.
const PALMETTO = { lat: 27.545, lng: -82.545 };
const BRADENTON = { lat: 27.425, lng: -82.410 };

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
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
  test('the Rod case: 9–10 touching a 10–11 stop 33 minutes away is a violation', () => {
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

  test('every overlapping stop is a conflict regardless of position; malformed stops are skipped', () => {
    const overlapA = { startMin: 700, endMin: 720, id: 'a' };
    const overlapB = { startMin: 730, endMin: 800, id: 'b' };
    const out = travelGapConflicts(candidate, [overlapA, adjacent, { startMin: null, endMin: 5 }, overlapB]);
    expect(out.map((c) => [c.stop.id, c.reason])).toEqual([['a', 'overlap'], ['b', 'overlap']]);
    expect(travelGapConflicts(candidate, [])).toEqual([]);
    expect(travelGapConflicts({ startMin: NaN, endMin: 1 }, [adjacent])).toEqual([]);
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

  test('gate off → undefined with NO query (legacy statement set stays byte-identical)', async () => {
    expect(await resolveStopCoords(db, 'svc-1')).toBeUndefined();
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on → one guarded read (stamped pin, else non-divergent customer coords)', async () => {
    gateOn();
    const c = chain({ lat: '27.5', lng: '-82.5' });
    db.mockReturnValue(c);
    db.raw = jest.fn((sql) => sql);
    expect(await resolveStopCoords(db, 'svc-1')).toEqual({ lat: 27.5, lng: -82.5 });
    expect(c.leftJoin).toHaveBeenCalledWith('customers', 'scheduled_services.customer_id', 'customers.id');
    expect(db.raw.mock.calls.some(([sql]) => /COALESCE\(scheduled_services\.lat/.test(sql))).toBe(true);
  });

  test('gate on → unknown pin or a failing read degrades to nulls (fail-open)', async () => {
    gateOn();
    db.raw = jest.fn((sql) => sql);
    db.mockReturnValue(chain({ lat: null, lng: null }));
    expect(await resolveStopCoords(db, 'svc-1')).toEqual({ lat: null, lng: null });
    db.mockImplementation(() => { throw new Error('boom'); });
    expect(await resolveStopCoords(db, 'svc-1')).toEqual({ lat: null, lng: null });
    expect(await resolveStopCoords(db, null)).toEqual({ lat: null, lng: null });
  });
});
