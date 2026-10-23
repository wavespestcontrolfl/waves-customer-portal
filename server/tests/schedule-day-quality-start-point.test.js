/**
 * GATE_TECH_START_POINTS (owner 2026-10-22): the planned-day measurement
 * (day quality) starts and ends each tech's day at that tech's start point.
 *
 *  1. measureDayQuality: a `home` drives the first and last leg; none = the office.
 *  2. getScheduleQualityMeasurements: gate off = byte-identical and NO start-point
 *     query; gate on = ONE start-point query for every tech, the tech with a point
 *     is measured from it, the tech without one from the office.
 *  3. The same function runs inside quality-after-change's snapshot and
 *     quality-alerts' transaction (a callable like any knex connection), so a
 *     before/after pair of calls uses the same point.
 *  4. The gap candidate finder models the same day from the same point.
 *  5. No coordinates in any returned measurement (it is written to the ledger).
 */
jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/day-stops', () => ({ dayStopsQuery: jest.fn(), guardedCoordSelects: () => [] }));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })) }));

const RouteOptimizer = require('../services/route-optimizer');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const { measureDayQuality, getScheduleQualityMeasurements } = require('../services/scheduling/day-quality');
const { analyzeGapCandidate } = require('../services/scheduling/gap-candidates');
const { normalizePreferences } = require('../services/auto-dispatch/preferences');

const ENV = process.env.GATE_TECH_START_POINTS;
afterEach(() => {
  if (ENV === undefined) delete process.env.GATE_TECH_START_POINTS;
  else process.env.GATE_TECH_START_POINTS = ENV;
  dayStopsQuery.mockReset();
});

// Synthetic: a start point ~25 miles from the office with the stop next to it.
const HOME_ROW = { id: 'tech-home', start_lat: '27.0998000', start_lng: '-82.4543000' };
const HOME = { lat: 27.0998, lng: -82.4543 };
const DATE = '2027-05-10';
const NOW = new Date(`${DATE}T12:00:00Z`);
const stopFor = (tech, id = `${tech}-v1`) => ({
  id, technician_id: tech, route_order: 1, customer_id: `cust-${id}`, scheduled_date: DATE,
  window_start: '09:00', window_end: '10:00', time_window: null, status: 'confirmed',
  reservation_expires_at: null, created_at: '2020-01-01T00:00:00Z', visit_id: null,
  estimated_duration_minutes: 60, service_type: null, is_recurring: false, is_callback: false,
  lat: 27.11, lng: -82.45,
});

// A knex-shaped connection: the assignable-tech list and the start-point read.
function connWith(startRows) {
  const calls = { techList: 0, startPoints: 0, startPointIds: null };
  const conn = jest.fn((table) => {
    if (table !== 'technicians') throw new Error(`unexpected table ${table}`);
    const q = {};
    q.where = () => q;
    q.whereNotNull = () => q;
    q.whereIn = (_col, ids) => { calls.startPointIds = ids; return q; };
    q.select = async (...cols) => {
      if (Array.isArray(cols[0])) { calls.startPoints += 1; return startRows; }
      calls.techList += 1;
      return [{ id: 'tech-home', name: 'Tech Home' }, { id: 'tech-office', name: 'Tech Office' }];
    };
    return q;
  });
  return { conn, calls };
}
const useStops = () => dayStopsQuery.mockImplementation(() => ({
  whereRaw: () => Promise.resolve([stopFor('tech-home'), stopFor('tech-office')]),
}));
const drive = (result, tech) => result.days[0].byTech.find(row => row.technicianId === tech).modeledDriveMinutes;

describe('measureDayQuality home option', () => {
  const stops = [stopFor('t')];
  test('no home = the office, identical to passing the office', () => {
    expect(measureDayQuality(RouteOptimizer, stops)).toEqual(measureDayQuality(RouteOptimizer, stops, { home: RouteOptimizer.HQ }));
  });
  test('a home next to the stop makes the first and last legs short', () => {
    const office = measureDayQuality(RouteOptimizer, stops).modeledDriveMinutes;
    const home = measureDayQuality(RouteOptimizer, stops, { home: HOME }).modeledDriveMinutes;
    expect(home).toBeLessThan(office);
    expect(home).toBeGreaterThan(0);
  });
});

describe('getScheduleQualityMeasurements', () => {
  test('gate off: no start-point query, every tech measured from the office, byte-identical to the office measurement', async () => {
    delete process.env.GATE_TECH_START_POINTS;
    useStops();
    const { conn, calls } = connWith([HOME_ROW]);
    const result = await getScheduleQualityMeasurements({ date: DATE }, conn, NOW);
    expect(calls).toMatchObject({ techList: 1, startPoints: 0 });
    const expected = measureDayQuality(RouteOptimizer, [stopFor('tech-home')], { future: true }).modeledDriveMinutes;
    expect(drive(result, 'tech-home')).toBe(expected);
    expect(drive(result, 'tech-office')).toBe(expected);
    expect(result.days[0].byTech[0].assumptions).not.toHaveProperty('startPoint');
  });

  test('gate on: ONE start-point query for all techs; the tech with a point is measured from it, the other from the office', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    useStops();
    const { conn, calls } = connWith([HOME_ROW]);
    const result = await getScheduleQualityMeasurements({ date: DATE }, conn, NOW);
    expect(calls).toMatchObject({ techList: 1, startPoints: 1, startPointIds: ['tech-home', 'tech-office'] });
    const fromHome = measureDayQuality(RouteOptimizer, [stopFor('tech-home')], { future: true, home: HOME }).modeledDriveMinutes;
    const fromOffice = measureDayQuality(RouteOptimizer, [stopFor('tech-office')], { future: true }).modeledDriveMinutes;
    expect(fromHome).toBeLessThan(fromOffice);
    expect(drive(result, 'tech-home')).toBe(fromHome);
    expect(drive(result, 'tech-office')).toBe(fromOffice);
  });

  test('gate on, no tech has a point: identical to gate off', async () => {
    useStops();
    delete process.env.GATE_TECH_START_POINTS;
    const off = await getScheduleQualityMeasurements({ date: DATE }, connWith([]).conn, NOW);
    process.env.GATE_TECH_START_POINTS = 'true';
    const on = await getScheduleQualityMeasurements({ date: DATE }, connWith([]).conn, NOW);
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });

  test('no coordinates, gate on: the result (which reaches the planner ledger and alerts) holds no start point', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    useStops();
    const result = await getScheduleQualityMeasurements({ date: DATE }, connWith([HOME_ROW]).conn, NOW);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/27\.0998|82\.4543|start_lat|start_lng|"lat"|"lng"/);
  });

  test('two calls on the same connection (a before/after pair) measure from the same point', async () => {
    process.env.GATE_TECH_START_POINTS = 'true';
    useStops();
    const { conn } = connWith([HOME_ROW]);
    const before = await getScheduleQualityMeasurements({ date: DATE }, conn, NOW);
    const after = await getScheduleQualityMeasurements({ date: DATE }, conn, NOW);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

describe('analyzeGapCandidate models the same day from the tech start point', () => {
  const service = { id: 'candidate', technician_id: null, scheduled_date: '2040-09-11', status: 'pending',
    service_type: 'Pest Control', estimated_duration_minutes: 60, lat: 27.11, lng: -82.45 };
  const candidate = { service, preferences: normalizePreferences(null, service.service_type), holds: [], siblingDates: [], deactivated: [] };
  const options = { date: '2040-09-10', today: '2040-09-09', now: new Date('2040-09-09T12:00:00Z'), technicianId: 'tech',
    departureMinutes: 480, targetReturnMinutes: 1020, breakMinutes: 30, closed: false };
  const firstFit = (extra) => analyzeGapCandidate(candidate, [], { ...options, ...extra }).routeFits[0];

  test('an empty day: the candidate near home costs far less drive from home than from the office; no home = the office', () => {
    const office = firstFit({});
    const home = firstFit({ home: HOME });
    expect(home.modeledDriveMinutes).toBeLessThan(office.modeledDriveMinutes);
    expect(firstFit({ home: RouteOptimizer.HQ })).toEqual(office);
    expect(JSON.stringify(home)).not.toMatch(/27\.0998|82\.4543/);
  });
});
