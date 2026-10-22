/**
 * GATE_TECH_START_POINTS part 2 (owner 2026-10-22): auto-dispatch's route math
 * starts and ends each technician's day at that technician's start point.
 *
 * What this locks down (synthetic coordinates only):
 *  1. route-model.js: chainDriveMinutes / routeCost / neighbours take an
 *     optional `home`; no home (or HQ) is exactly today's numbers.
 *  2. Gate on, a start point far from the office: the same chain is priced
 *     from that point at BOTH ends, and a stop near home gets cheaper.
 *  3. candidate-slots.js computeCurrentPlacement anchors the day at the tech's
 *     start point; a tech with no point keeps the office; gate off reads
 *     nothing new and answers today's numbers.
 *  4. The start points load once per technician per run (one batched query).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/rebooker', () => ({
  probeMoveConflicts: jest.fn().mockResolvedValue({ rows: [], snapshot: [] }),
  occupancyProbeEnd: jest.requireActual('../services/rebooker').occupancyProbeEnd,
}));

const RouteOptimizer = require('../services/route-optimizer');
const { chainDriveMinutes, routeCost } = require('../services/auto-dispatch/route-model');
const { ROAD_LEGS } = require('../services/auto-dispatch/road-check');
const { driveMin, HQ } = require('../services/auto-dispatch/geo');
const {
  computeCurrentPlacement, _internals: {
    loadStartPoints, loadAllStartPoints, scoredStartPoint, homeFor, filterAndScoreSharedModelCandidates,
  },
} = require('../services/auto-dispatch/candidate-slots');

const ENV_GATE = process.env.GATE_TECH_START_POINTS;
const ENV_SHARED = process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
const ENV_DRIVE = process.env.GATE_DRIVE_TIME_CALIBRATION;
beforeEach(() => { delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL; });
afterEach(() => {
  for (const [k, v] of [['GATE_TECH_START_POINTS', ENV_GATE], ['GATE_AUTO_DISPATCH_SHARED_MODEL', ENV_SHARED], ['GATE_DRIVE_TIME_CALIBRATION', ENV_DRIVE]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// A "home" ~25 miles south of the office; two stops near it.
const HOME = { lat: 27.0998, lng: -82.4543 };
const NEAR_HOME_A = { lat: 27.11, lng: -82.45 };
const NEAR_HOME_B = { lat: 27.12, lng: -82.46 };

const stop = (id, geo, startMin) => ({
  id, geo, startMin, window_start: `${String(Math.floor(startMin / 60)).padStart(2, '0')}:00`, estimated_duration_minutes: 60,
});

describe('route-model: home at both ends', () => {
  test('no home / HQ: exactly the office-anchored numbers', () => {
    const geos = [NEAR_HOME_A, NEAR_HOME_B];
    const old = driveMin(HQ, NEAR_HOME_A) + driveMin(NEAR_HOME_A, NEAR_HOME_B) + driveMin(NEAR_HOME_B, HQ);
    expect(chainDriveMinutes(geos)).toBe(old);
    expect(chainDriveMinutes(geos, HQ)).toBe(old);
    expect(chainDriveMinutes(geos, undefined)).toBe(old);
    expect(chainDriveMinutes([])).toBe(0);
    const others = [stop('a', NEAR_HOME_A, 540)];
    const visit = stop('v', NEAR_HOME_B, 660);
    expect(routeCost(others, visit, HQ)).toEqual(routeCost(others, visit));
  });

  test('a start point is used at both ends of the chain', () => {
    const geos = [NEAR_HOME_A, NEAR_HOME_B];
    const fromHome = driveMin(HOME, NEAR_HOME_A) + driveMin(NEAR_HOME_A, NEAR_HOME_B) + driveMin(NEAR_HOME_B, HOME);
    expect(chainDriveMinutes(geos, HOME)).toBe(fromHome);
    expect(fromHome).toBeLessThan(chainDriveMinutes(geos));
  });

  test('routeCost: stops near home cost less drive from home; neighbours name home at the ends', () => {
    const others = [stop('a', NEAR_HOME_A, 540)];
    const visit = stop('v', NEAR_HOME_B, 600);
    const office = routeCost(others, visit);
    const home = routeCost(others, visit, HOME);
    expect(home.driveWithoutMinutes).toBeLessThan(office.driveWithoutMinutes);
    expect(home.driveWithMinutes).toBeLessThan(office.driveWithMinutes);
    expect(home.driveWithoutMinutes).toBe(chainDriveMinutes([NEAR_HOME_A], HOME));
    // The visit is the last stop: its next leg returns to the day's home.
    expect(home.neighbours.next).toBe(HOME);
    expect(office.neighbours.next).toBe(HQ);
    // A visit that is the first stop starts from home.
    const first = routeCost([stop('b', NEAR_HOME_A, 720)], stop('v2', NEAR_HOME_B, 540), HOME);
    expect(first.neighbours.prev).toBe(HOME);
  });

  test('a day with no stops: the visit alone is a round trip from home', () => {
    const visit = stop('v', NEAR_HOME_B, 600);
    const home = routeCost([], visit, HOME);
    expect(home.driveWithMinutes).toBe(2 * driveMin(HOME, NEAR_HOME_B));
    expect(routeCost([], visit).driveWithMinutes).toBe(2 * driveMin(HQ, NEAR_HOME_B));
    expect(home.driveWithMinutes).toBeLessThan(routeCost([], visit).driveWithMinutes);
  });
});

// A db stub: the technicians query answers `techRows` (counting calls); every
// scheduled_services query answers no other stops.
function dbStub(techRows = []) {
  const calls = [];
  const db = (table) => {
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'orWhere', 'leftJoin', 'orderBy', 'first', 'whereBetween', 'whereNotNull'].forEach((m) => { c[m] = () => c; });
    c.whereIn = (col, ids) => { if (table === 'technicians') calls.push([...ids]); return c; };
    c.select = async () => (table === 'technicians' ? techRows : []);
    return c;
  };
  db.techCalls = calls;
  return db;
}

const SERVICE = {
  id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04', technician_id: 't1', window_start: '09:00',
  estimated_duration_minutes: 60, lat: NEAR_HOME_B.lat, lng: NEAR_HOME_B.lng,
};
const baseCtx = (db, extra = {}) => ({
  db, nowDate: new Date('2026-06-19T16:00:00Z'), lockWindowDays: 14, lookaheadDays: 90, topN: 60,
  capabilityFor: () => 'qualified', ...extra,
});
const PREFS = { service_category: 'general' };

describe('computeCurrentPlacement: the day is anchored at the start point', () => {
  const officeNumbers = (async () => {
    delete process.env.GATE_TECH_START_POINTS;
    return computeCurrentPlacement(SERVICE, PREFS, baseCtx(dbStub()));
  });

  test('gate off: office anchors, no technician read, numbers are today\'s', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    const db = dbStub([{ id: 't1', start_lat: HOME.lat, start_lng: HOME.lng }]);
    const res = await computeCurrentPlacement(SERVICE, PREFS, baseCtx(db));
    expect(db.techCalls).toEqual([]);
    expect(res.total_drive_minutes).toBe(2 * driveMin(HQ, NEAR_HOME_B));
    expect(res.detour_minutes).toBe(Math.max(0, 2 * driveMin(HQ, NEAR_HOME_B) - driveMin(HQ, HQ)));
    expect(homeFor({ startPoints: new Map([['t1', HOME]]) }, 't1')).toBe(HQ);
  });

  test('gate on, tech with a far start point: both anchors are that point', async () => {
    const off = await officeNumbers();
    process.env.GATE_TECH_START_POINTS = 'true';
    const db = dbStub([{ id: 't1', start_lat: String(HOME.lat), start_lng: String(HOME.lng) }]);
    const res = await computeCurrentPlacement(SERVICE, PREFS, baseCtx(db));
    expect(res.total_drive_minutes).toBe(2 * driveMin(HOME, NEAR_HOME_B));
    expect(res.total_drive_minutes).toBeLessThan(off.total_drive_minutes);
    expect(res.detour_minutes).toBeLessThan(off.detour_minutes);
  });

  test('gate on, tech with no start point keeps the office', async () => {
    const off = await officeNumbers();
    process.env.GATE_TECH_START_POINTS = 'true';
    const db = dbStub([{ id: 't1', start_lat: null, start_lng: null }]);
    const res = await computeCurrentPlacement(SERVICE, PREFS, baseCtx(db));
    expect(res.total_drive_minutes).toBe(off.total_drive_minutes);
    expect(res.detour_minutes).toBe(off.detour_minutes);
  });

  test('gate on, shared model: the current placement is priced from the start point', async () => {
    process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
    delete process.env.GATE_TECH_START_POINTS;
    const groupContext = { excludeIds: new Set(), siblings: [], visitWindowStart: '09:00' };
    const off = await computeCurrentPlacement(SERVICE, PREFS, baseCtx(dbStub(), { groupContext }));
    process.env.GATE_TECH_START_POINTS = 'true';
    const db = dbStub([{ id: 't1', start_lat: HOME.lat, start_lng: HOME.lng }]);
    const res = await computeCurrentPlacement(SERVICE, PREFS, baseCtx(db, { groupContext }));
    expect(res.model).toBe('shared_v1');
    expect(res.total_drive_minutes).toBe(2 * driveMin(HOME, NEAR_HOME_B));
    expect(res.total_drive_minutes).toBeLessThan(off.total_drive_minutes);
    // The road check reads the same legs: the visit is the day's only stop, so both ends are home.
    expect(res[ROAD_LEGS].prev).toEqual(HOME);
    expect(res[ROAD_LEGS].next).toEqual(HOME);
  });
});

describe('loadStartPoints: one batched read per technician per run', () => {
  test('reads each technician once across calls and shares the run cache', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    const db = dbStub([{ id: 't1', start_lat: HOME.lat, start_lng: HOME.lng }]);
    const run = new Map();
    const ctx = { db, startPoints: run };
    await loadStartPoints(ctx, ['t1', 't2', 't1', null]);
    await loadStartPoints({ db, startPoints: run }, ['t1', 't2']);
    expect(db.techCalls).toEqual([['t1', 't2']]);
    expect(homeFor(ctx, 't1')).toEqual(HOME);
    expect(homeFor(ctx, 't2')).toBe(RouteOptimizer.HQ); // unknown tech: office
    expect(homeFor(ctx, null)).toBe(RouteOptimizer.HQ);
  });

  test('gate off: no read, no cache entry', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    const db = dbStub([{ id: 't1', start_lat: HOME.lat, start_lng: HOME.lng }]);
    const ctx = { db };
    await loadStartPoints(ctx, ['t1']);
    expect(db.techCalls).toEqual([]);
    expect(ctx.startPoints).toBeUndefined();
  });
});

describe('loadAllStartPoints: the cache holds every technician before the slot search reads them', () => {
  const rowsOf = (...rows) => {
    const db = jest.fn(() => ({ select: async () => rows }));
    return db;
  };
  test('one read for the run; a technician already cached keeps the older snapshot; others (no address too) are cached', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    const db = rowsOf({ id: 't1', start_lat: 1, start_lng: 1 }, { id: 't2', start_lat: HOME.lat, start_lng: HOME.lng }, { id: 't3', start_lat: null, start_lng: null });
    const run = new Map([['t1', HOME]]);
    await loadAllStartPoints({ db, startPoints: run });
    await loadAllStartPoints({ db, startPoints: run });
    expect(db).toHaveBeenCalledTimes(1);
    expect(run.get('t1')).toBe(HOME); // older snapshot kept
    expect(run.get('t2')).toEqual(HOME);
    expect(run.get('t3')).toBe(HQ);
  });

  test('gate off: no read, no cache', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    const db = rowsOf({ id: 't1', start_lat: HOME.lat, start_lng: HOME.lng });
    const ctx = { db };
    await loadAllStartPoints(ctx);
    expect(db).not.toHaveBeenCalled();
    expect(ctx.startPoints).toBeUndefined();
  });

  test('scoredStartPoint answers the cached point even when the gate is now off; homeFor answers the office', () => {
    delete process.env.GATE_TECH_START_POINTS;
    const ctx = { startPoints: new Map([['t1', HOME]]) };
    expect(scoredStartPoint(ctx, 't1')).toEqual(HOME);
    expect(scoredStartPoint(ctx, 't9')).toBe(HQ);
    expect(scoredStartPoint({}, 't1')).toBe(HQ);
    expect(homeFor(ctx, 't1')).toBe(HQ);
    process.env.GATE_TECH_START_POINTS = 'true';
    expect(homeFor(ctx, 't1')).toEqual(HOME);
  });
});

describe('candidates are scored from their own technician\'s start point', () => {
  const cand = (tech) => ({ date: '2026-08-05', technician_id: tech, start_time: '09:00', end_time: '10:00' });
  const groupContext = { excludeIds: new Set(), siblings: [], visitWindowStart: '09:00' };

  test('gate on: t1 (far start point) and t2 (none) price the same slot differently; one technician read', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    const db = dbStub([{ id: 't1', start_lat: HOME.lat, start_lng: HOME.lng }, { id: 't2', start_lat: null, start_lng: null }]);
    const ctx = baseCtx(db, { groupContext });
    const out = await filterAndScoreSharedModelCandidates(SERVICE, { lat: NEAR_HOME_B.lat, lng: NEAR_HOME_B.lng }, [cand('t1'), cand('t2')], ctx, {});
    const [a, b] = out;
    expect(a.total_drive_minutes).toBe(2 * driveMin(HOME, NEAR_HOME_B));
    expect(b.total_drive_minutes).toBe(2 * driveMin(HQ, NEAR_HOME_B));
    expect(a.total_drive_minutes).toBeLessThan(b.total_drive_minutes);
    expect(db.techCalls).toEqual([['t1', 't2']]);
  });

  test('gate off: every candidate is priced from the office, no technician read', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    const db = dbStub([{ id: 't1', start_lat: HOME.lat, start_lng: HOME.lng }]);
    const out = await filterAndScoreSharedModelCandidates(SERVICE, { lat: NEAR_HOME_B.lat, lng: NEAR_HOME_B.lng }, [cand('t1')], baseCtx(db, { groupContext }), {});
    expect(out[0].total_drive_minutes).toBe(2 * driveMin(HQ, NEAR_HOME_B));
    expect(db.techCalls).toEqual([]);
  });
});
