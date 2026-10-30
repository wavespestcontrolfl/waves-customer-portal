/**
 * GATE_SAVE_ROAD_BUY (owner 2026-10-28 design, "ok go" 2026-10-29): before an
 * ADMIN staff save opens its transaction, buy the Google road times its own
 * check and route number will read, so the save agrees with the Edit dialog's
 * slot check. Locked down here:
 *  - gate off (unset): nothing runs, no Google call, no spend;
 *  - gate on, admin, road day: only the missing legs are bought (counted with
 *    a fake provider), at most 15 lookups; the save's cache-only read then
 *    finds them, and a second purchase buys 0;
 *  - a technician (no spender), a non-road day, a transaction handle: 0;
 *  - a refused purchase, an error or a slow Google falls back to today's
 *    behavior and never throws.
 * Synthetic stops, no customer records, no network.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/picker-road-spend', () => ({
  reserveRoadSpend: jest.fn(async () => ({ allowed: true, day: '2027-03-01' })),
  releaseRoadSpend: jest.fn(async () => {}),
}));
let mockDayRows = [];
jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: () => {
    const q = { where: () => q, then: (resolve, reject) => Promise.resolve(mockDayRows).then(resolve, reject) };
    return q;
  },
  guardedCoordSelects: () => [],
  serviceLocationSelects: () => [],
  resolveServiceLocation: async (row) => ({ lat: row.lat, lng: row.lng }),
}));

const RouteOptimizer = require('../services/route-optimizer');
const arrivalRoute = require('../services/scheduling/arrival-route');
const { buyRoadsBeforeSave, buyRoadsForVisitSave } = require('../services/scheduling/save-road-buy');
const { _test: roadTest } = require('../services/scheduling/hint-road-times');
const { reserveRoadSpend } = require('../services/scheduling/picker-road-spend');
const { etDateString, addETDays } = require('../utils/datetime-et');

const TODAY = etDateString(new Date());
const dayAhead = (n) => etDateString(addETDays(new Date(), n));
const ROAD_DAY = dayAhead(1);
const PLAIN_DAY = dayAhead(4);
const NON_ROAD_DAY = dayAhead(12);
const GATES = ['GATE_PICKER_ROAD_CHECK', 'GATE_SAVE_ROAD_TIMES', 'GATE_SAVE_ROAD_BUY', 'GATE_ADMIN_ARRIVAL_WINDOWS',
  'GATE_STAFF_ROUTE_INSERTION', 'GATE_SCHEDULING_CAPACITY', 'GATE_DRIVE_TIME_CALIBRATION'];
const savedEnv = Object.fromEntries(GATES.map((key) => [key, process.env[key]]));
afterAll(() => {
  GATES.forEach((key) => { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; });
});

const stop = (id, windowStart, lat, date, overrides = {}) => ({
  id, technician_id: 'tech', scheduled_date: date, status: 'confirmed',
  window_start: windowStart, window_end: `${String(Number(windowStart.slice(0, 2)) + 1).padStart(2, '0')}:00`,
  estimated_duration_minutes: 60, lat, lng: -82.4, route_order: null, created_at: '2020-01-01T12:00:00Z', ...overrides,
});
const dayOf = (date) => [stop('north', '08:00', 27.55, date, { route_order: 1 }), stop('south', '13:00', 27.45, date, { route_order: 2 })];

// A fake Google. Like createSchedulingTravel: only a leg it sent has Google's
// answer, and diagnostics() counts what it sent. `hang` = a Google that never
// answers (the 2-second limit).
let asked;
let hang = false;
function fakeSource(mode) {
  const got = new Set();
  let sent = 0;
  const keyOf = (leg) => `${leg.date}@${leg.departureMin}|${leg.from.lat}>${leg.to.lat}`;
  return {
    preload: async (legs) => {
      if (hang) await new Promise(() => {});
      asked[mode].push(...legs);
      legs.forEach((leg) => got.add(keyOf(leg)));
      sent += legs.length;
    },
    lookup: (leg) => (got.has(keyOf(leg))
      ? { minutes: 17, source: mode === 'traffic' ? 'google_traffic' : 'google_road', reason: null }
      : { minutes: 99, source: 'conservative_model', reason: 'request_budget' }),
    diagnostics: () => ({ requests: sent, elements: sent }),
  };
}

const prospective = { lat: 27.5, lng: -82.4, estimated_duration_minutes: 60, service_type: 'Pest Control' };
const placement = (date, over = {}) => ({
  spender: 'staff-1', date, technicianId: 'tech', windowStart: '10:00', windowEnd: '11:00', prospective, ...over,
});
const lookupsAsked = () => asked.traffic.length + asked.plain.length;

beforeEach(() => {
  asked = { traffic: [], plain: [] };
  hang = false;
  mockDayRows = dayOf(ROAD_DAY);
  roadTest.roadCache.clear();
  roadTest.plainCache.clear();
  reserveRoadSpend.mockClear();
  reserveRoadSpend.mockImplementation(async () => ({ allowed: true, day: '2027-03-01' }));
  jest.spyOn(RouteOptimizer, 'createSchedulingTravel').mockImplementation((opts = {}) => fakeSource(opts.traffic === false ? 'plain' : 'traffic'));
  process.env.GATE_PICKER_ROAD_CHECK = 'true';
  process.env.GATE_SAVE_ROAD_TIMES = 'true';
  process.env.GATE_SAVE_ROAD_BUY = 'true';
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
  process.env.GATE_STAFF_ROUTE_INSERTION = 'true';
  delete process.env.GATE_SCHEDULING_CAPACITY;
});
afterEach(() => { jest.restoreAllMocks(); });

describe('gate off', () => {
  test.each([
    ['GATE_SAVE_ROAD_BUY unset', () => delete process.env.GATE_SAVE_ROAD_BUY],
    ['GATE_SAVE_ROAD_TIMES unset', () => delete process.env.GATE_SAVE_ROAD_TIMES],
    ['the pickers\' road check unset', () => delete process.env.GATE_PICKER_ROAD_CHECK],
    ['the arrival-window check unset', () => delete process.env.GATE_ADMIN_ARRIVAL_WINDOWS],
    ['capacity mode on', () => { process.env.GATE_SCHEDULING_CAPACITY = 'true'; }],
  ])('%s: no read, no Google call, no spend', async (_name, turnOff) => {
    turnOff();
    expect(arrivalRoute.saveRoadBuyLive()).toBeFalsy();
    expect(await buyRoadsBeforeSave(placement(ROAD_DAY))).toBeNull();
    expect(await buyRoadsForVisitSave({ spender: 'staff-1', serviceId: 'svc-1' })).toBeNull();
    expect(RouteOptimizer.createSchedulingTravel).not.toHaveBeenCalled();
    expect(reserveRoadSpend).not.toHaveBeenCalled();
    expect(lookupsAsked()).toBe(0);
  });
});

describe('an admin save on a road day', () => {
  test('buys only the missing legs, then the save\'s cache-only read finds every one of them', async () => {
    const result = await buyRoadsBeforeSave(placement(ROAD_DAY));
    expect(result.lookups).toBeGreaterThan(0);
    expect(result.lookups).toBeLessThanOrEqual(15);
    expect(lookupsAsked()).toBe(result.lookups);
    expect(reserveRoadSpend).toHaveBeenCalledWith(expect.objectContaining({ spender: 'staff-1' }));
    // The save's own reads: its advisory check (the saved visit is a row now)
    // and its route number (place: true), both on the cache-only travel.
    const saveRows = [...dayOf(ROAD_DAY)];
    const saved = stop('__candidate__', '10:00', 27.5, ROAD_DAY, { estimated_duration_minutes: 60 });
    const context = {
      date: ROAD_DAY, now: new Date(), target: saved, rows: saveRows, grouped: false, prospective: true,
      travel: arrivalRoute._internals.staffSaveTravel(ROAD_DAY),
    };
    const legs = [];
    arrivalRoute.evaluateArrivalPlacement(context, { windowStart: '10:00', windowEnd: '11:00', allowInsertion: false, collectLegs: legs });
    arrivalRoute.evaluateArrivalPlacement(context, { windowStart: '10:00', windowEnd: '11:00', place: true, collectLegs: legs });
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((leg) => /^google/.test(leg.source))).toBe(true);
    // And the cache-only read bought nothing.
    expect(lookupsAsked()).toBe(result.lookups);
  });

  test('a fully cached placement buys 0 lookups and costs nothing', async () => {
    const first = await buyRoadsBeforeSave(placement(ROAD_DAY));
    expect(first.lookups).toBeGreaterThan(0);
    reserveRoadSpend.mockClear();
    const before = lookupsAsked();
    const second = await buyRoadsBeforeSave(placement(ROAD_DAY));
    expect(second.lookups).toBe(0);
    expect(lookupsAsked()).toBe(before);
    expect(reserveRoadSpend).not.toHaveBeenCalled();
  });

  test('a plain-road day (after the traffic days) buys plain lookups', async () => {
    mockDayRows = dayOf(PLAIN_DAY);
    const result = await buyRoadsBeforeSave(placement(PLAIN_DAY));
    expect(result.lookups).toBeGreaterThan(0);
    expect(asked.plain.length).toBe(result.lookups);
    expect(asked.traffic).toHaveLength(0);
  });

  test('one save buys at most 15 lookups, or the cap it is given', async () => {
    mockDayRows = Array.from({ length: 12 }, (_, i) => stop(`s${i}`, `${String(8 + (i % 8)).padStart(2, '0')}:00`, 27.4 + i / 50, ROAD_DAY, { route_order: i + 1, technician_id: 'tech' }));
    const result = await buyRoadsBeforeSave(placement(ROAD_DAY));
    expect(result.lookups).toBeLessThanOrEqual(15);
    reserveRoadSpend.mockClear();
    roadTest.roadCache.clear();
    asked = { traffic: [], plain: [] };
    const small = await buyRoadsBeforeSave(placement(ROAD_DAY, { maxLookups: 2 }));
    expect(small.lookups).toBeLessThanOrEqual(2);
    expect(lookupsAsked()).toBeLessThanOrEqual(2);
  });

  test('check: false leaves the advisory check\'s legs out (a move that runs none)', async () => {
    const both = await buyRoadsBeforeSave(placement(ROAD_DAY));
    roadTest.roadCache.clear();
    asked = { traffic: [], plain: [] };
    const placeOnly = await buyRoadsBeforeSave(placement(ROAD_DAY, { check: false }));
    expect(placeOnly.lookups).toBeGreaterThan(0);
    expect(placeOnly.lookups).toBeLessThanOrEqual(both.lookups);
  });
});

describe('nothing is bought for', () => {
  test('a technician (no spender)', async () => {
    const result = await buyRoadsBeforeSave(placement(ROAD_DAY, { spender: null }));
    expect(result).toMatchObject({ lookups: 0, skipped: 'no_spender' });
    expect(RouteOptimizer.createSchedulingTravel).not.toHaveBeenCalled();
    expect(reserveRoadSpend).not.toHaveBeenCalled();
  });

  test('a day beyond the road days', async () => {
    mockDayRows = dayOf(NON_ROAD_DAY);
    const result = await buyRoadsBeforeSave(placement(NON_ROAD_DAY));
    expect(result).toMatchObject({ lookups: 0, skipped: 'not_road_day' });
    expect(reserveRoadSpend).not.toHaveBeenCalled();
  });

  test('a past day', async () => {
    const result = await buyRoadsBeforeSave(placement(etDateString(addETDays(new Date(), -2))));
    expect(result).toMatchObject({ lookups: 0, skipped: 'not_road_day' });
  });

  test('an unassigned or untimed visit', async () => {
    expect(await buyRoadsBeforeSave(placement(ROAD_DAY, { technicianId: null }))).toMatchObject({ lookups: 0, skipped: 'no_placement' });
    expect(await buyRoadsBeforeSave(placement(ROAD_DAY, { windowStart: null }))).toMatchObject({ lookups: 0, skipped: 'no_placement' });
    expect(lookupsAsked()).toBe(0);
  });

  test('a transaction handle: never a Google call inside a transaction', async () => {
    const trx = Object.assign(jest.fn(), { isTransaction: true });
    const result = await buyRoadsBeforeSave(placement(ROAD_DAY, { conn: trx }));
    expect(result).toMatchObject({ lookups: 0, skipped: 'in_transaction' });
    expect(RouteOptimizer.createSchedulingTravel).not.toHaveBeenCalled();
    expect(trx).not.toHaveBeenCalled();
  });
});

describe('a purchase that goes wrong leaves the save as it was', () => {
  test('a refused purchase (a spend ceiling) asks Google nothing and does not throw', async () => {
    reserveRoadSpend.mockImplementation(async () => ({ allowed: false, reason: 'daily_cap' }));
    const result = await buyRoadsBeforeSave(placement(ROAD_DAY));
    expect(result.lookups).toBe(0);
    expect(result.refused).toBe('daily_cap');
    expect(lookupsAsked()).toBe(0);
  });

  test('a spend counter that throws fails closed: no Google, no throw', async () => {
    reserveRoadSpend.mockImplementation(async () => { throw new Error('db down'); });
    await expect(buyRoadsBeforeSave(placement(ROAD_DAY))).resolves.toBeDefined();
    expect(lookupsAsked()).toBe(0);
  });

  test('a Google that never answers: the save waits only the time limit and goes on', async () => {
    hang = true;
    const started = Date.now();
    const result = await buyRoadsBeforeSave(placement(ROAD_DAY, { timeoutMs: 60 }));
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('an unreadable day (the read throws) is logged and the save goes on', async () => {
    mockDayRows = null;
    await expect(buyRoadsBeforeSave(placement(ROAD_DAY))).resolves.toBeDefined();
    expect(lookupsAsked()).toBe(0);
  });
});

describe('buyRoadsForVisitSave reads the pending edit from the stored row', () => {
  const stored = { scheduled_date: new Date(`${ROAD_DAY}T12:00:00Z`), technician_id: 'tech', window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60 };
  const conn = () => {
    const chain = { where: () => chain, first: async () => stored };
    return jest.fn(() => chain);
  };

  test('a start-only edit derives its end from the duration and buys for the new day, technician and start', async () => {
    const spy = jest.spyOn(arrivalRoute, 'buySaveRoads').mockResolvedValue({ lookups: 3 });
    const result = await buyRoadsForVisitSave({
      spender: 'staff-1', serviceId: 'svc-1', conn: conn(),
      changes: { scheduled_date: PLAIN_DAY, window_start: '14:00', technician_id: 'tech-2', estimated_duration_minutes: 90 },
    });
    expect(result).toEqual({ lookups: 3 });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      spender: 'staff-1', serviceId: 'svc-1', date: PLAIN_DAY, technicianId: 'tech-2', windowStart: '14:00', windowEnd: '15:30',
    }));
  });

  test('no spender (a technician) reads nothing and buys nothing', async () => {
    const c = conn();
    expect(await buyRoadsForVisitSave({ spender: null, serviceId: 'svc-1', conn: c })).toBeNull();
    expect(c).not.toHaveBeenCalled();
  });

  test('a transaction handle reads nothing and buys nothing', async () => {
    const c = Object.assign(conn(), { isTransaction: true });
    expect(await buyRoadsForVisitSave({ spender: 'staff-1', serviceId: 'svc-1', conn: c })).toBeNull();
    expect(c).not.toHaveBeenCalled();
  });
});

test('TODAY is a road day too (the picker windows start at 0)', () => {
  expect(require('../services/scheduling/hint-road-times').onRoads(TODAY, TODAY)).toBe(true);
});
