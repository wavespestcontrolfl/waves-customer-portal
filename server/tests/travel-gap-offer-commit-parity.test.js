/**
 * Offer/commit parity for the expected-minutes travel-gap formula (owner
 * ruling 2026-09-23): a slot filterCollidingSlots/find-time offers must be
 * one occupancy.js's findConflictingVisits (the commit gate reserveSlot /
 * commitReservation / extendReservation all call) also accepts, and vice
 * versa — both read the SAME scheduling/travel-gap.js functions with the
 * SAME expected-minutes inputs, so this is a direct exercise of the one
 * shared rule rather than a re-implementation of either side.
 */
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { violatesTravelGap } = require('../services/scheduling/travel-gap');

function makeQuery(rows = []) {
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg) { if (typeof arg === 'function') arg.call(builder, builder); return builder; }),
    whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    orWhereNull: jest.fn().mockReturnThis(),
    orWhereNot: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  });
  return builder;
}

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  db.raw = jest.fn((sql) => sql);
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const SAME_POINT = { lat: 27.4, lng: -82.4 };
const PALMETTO = { lat: 27.545, lng: -82.545 };
const BRADENTON = { lat: 27.425, lng: -82.41 };

describe('the 11:00 packed-before-noon case', () => {
  const stop = {
    id: 'noon-stop', window_start: '12:00:00', window_end: '13:00:00',
    estimated_duration_minutes: 60, service_type: null, service_key_snapshot: null, ...SAME_POINT,
  };

  test('offer side (travelGapViolation): 11:00-12:00 with 45 expected minutes clears a co-located 12:00 stop', () => {
    const candidate = { startMin: 660, endMin: 720, windowMinutes: 60, expectedMinutes: 45, ...SAME_POINT };
    expect(violatesTravelGap(candidate, [{ startMin: 720, endMin: 780, ...SAME_POINT }])).toBe(false);
  });

  test('commit side (findConflictingVisits): the SAME window/expectedMinutes is accepted — no clash', async () => {
    db.mockReturnValue(makeQuery([stop]));
    const clash = await findConflictingVisits({
      db, date: '2099-01-05', windowStart: '11:00', windowEnd: '12:00',
      travel: { ...SAME_POINT, expectedMinutes: 45 },
    });
    expect(clash).toEqual([]);
  });

  test('without the expected-minutes credit (a bare hold with no catalog signal), the SAME window is a clash — offer and commit still agree with each other, just on the legacy (unreduced) rule', async () => {
    db.mockReturnValue(makeQuery([stop]));
    const clash = await findConflictingVisits({
      db, date: '2099-01-05', windowStart: '11:00', windowEnd: '12:00', travel: SAME_POINT,
    });
    expect(clash.map((c) => c.id)).toEqual(['noon-stop']);
    expect(violatesTravelGap(
      { startMin: 660, endMin: 720, ...SAME_POINT },
      [{ startMin: 720, endMin: 780, ...SAME_POINT }],
    )).toBe(true);
  });
});

describe('the 2026-09-03 Palmetto/Bradenton 33-minute case stays blocked on both sides', () => {
  const stop = {
    id: 'bradenton-stop', window_start: '10:00:00', window_end: '11:00:00',
    estimated_duration_minutes: 60, service_type: null, service_key_snapshot: null, ...BRADENTON,
  };

  test('offer side: touching 9-10 in Palmetto against a 10-11 Bradenton stop violates', () => {
    expect(violatesTravelGap(
      { startMin: 540, endMin: 600, ...PALMETTO },
      [{ startMin: 600, endMin: 660, ...BRADENTON }],
    )).toBe(true);
  });

  test('commit side: the same window is refused, even with an (irrelevant, too-small-to-help) expected-minutes credit', async () => {
    db.mockReturnValue(makeQuery([stop]));
    const clash = await findConflictingVisits({
      db, date: '2099-01-05', windowStart: '09:00', windowEnd: '10:00',
      // A 15-minute credit does not come close to covering a ~33-minute drive.
      travel: { ...PALMETTO, expectedMinutes: 45 },
    });
    expect(clash.map((c) => c.id)).toEqual(['bradenton-stop']);
  });
});

describe('version-2 combined allocation: expected minutes are summed across the members (Codex #4664 r1 P1)', () => {
  const { ensureCatalogLoaded, clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');
  const catalog = (table) => ({
    select: async () => (table === 'services'
      ? [{ service_key: 'quarterly_pest', name: 'Pest', min_duration_minutes: 30, max_duration_minutes: 60 }]
      : []),
  });
  const mix = { version: 2, allocatedServiceIds: ['m1', 'm2'] };
  const member = (id, windowStart, windowEnd) => ({
    id, customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: '2026-09-03',
    window_start: windowStart, window_end: windowEnd, status: 'scheduled',
    service_type: 'Pest', service_key_snapshot: 'quarterly_pest', estimated_duration_minutes: 60,
    reservation_expires_at: null, reservation_service_mix: mix, lat: PALMETTO.lat, lng: PALMETTO.lng,
  });

  beforeEach(async () => { clearExpectedServiceMinutesCache(); await ensureCatalogLoaded(catalog); });
  afterEach(() => clearExpectedServiceMinutesCache());

  // Both members carry the allocation's shared 09:00 arrival anchor (that
  // anchor is part of allocationKey); occupiedRows expands each to the
  // summed 09:00-11:00 work span.
  test('two 60-minute members occupying 09:00-11:00 are expected done at 10:30 (45+45), not 09:45 — the 33-minute Bradenton 11:00 candidate is refused', async () => {
    db.mockImplementation(() => makeQuery([member('m1', '09:00:00', '10:00:00'), member('m2', '09:00:00', '10:00:00')]));
    const clash = await findConflictingVisits({
      date: '2026-09-03', windowStart: '11:00', windowEnd: '12:00',
      travel: { ...BRADENTON, expectedMinutes: 45 },
    });
    // Per-member credit would put the expected end at 09:45 -> a 75-minute
    // gap that clears the 33-minute drive; the summed credit ends at 10:30
    // -> 30 minutes, short of the drive.
    expect(clash.map((r) => r.id).sort()).toEqual(['m1', 'm2']);
  });

  test('the same allocation with a co-located 11:00 candidate is still fine (summed credit, zero drive)', async () => {
    db.mockImplementation(() => makeQuery([member('m1', '09:00:00', '10:00:00'), member('m2', '09:00:00', '10:00:00')]));
    const clash = await findConflictingVisits({
      date: '2026-09-03', windowStart: '11:00', windowEnd: '12:00',
      travel: { ...PALMETTO, expectedMinutes: 45 },
    });
    expect(clash).toEqual([]);
  });
});
