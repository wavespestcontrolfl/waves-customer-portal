/**
 * Mileage dashboard: GATE_TRUCK_VIEWS_PER_VEHICLE (tech roadmap build 6).
 * Off = the response is byte for byte today's. On = a per-vehicle list built
 * from the SAME two mileage_log reads, plus every live Bouncie vehicle.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockState = { todayRows: [], mtdRows: [], techRows: [], calls: [] };
jest.mock('../models/db', () => {
  const mockDb = jest.fn((table) => {
    let rows = [];
    const call = { table, wheres: [] };
    mockState.calls.push(call);
    const chain = {
      where(...args) {
        call.wheres.push(args);
        if (table === 'mileage_log') rows = args.length === 2 ? mockState.todayRows : mockState.mtdRows;
        return chain;
      },
      whereNotNull() { rows = mockState.techRows; return chain; },
      select() { return chain; },
      then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
    };
    return chain;
  });
  return mockDb;
});

const mockBouncie = { getVehicles: jest.fn() };
jest.mock('../services/bouncie', () => mockBouncie);

const { getDashboard } = require('../services/bouncie-mileage');

const GATE = 'GATE_TRUCK_VIEWS_PER_VEHICLE';
const saved = process.env[GATE];
const today = '2026-10-29';
const monthStart = '2026-10-01';

const row = (patch) => ({
  vehicle_id: 'imei-1', vehicle_name: 'Truck One', trip_date: today, distance_miles: '10.00', is_business: true,
  duration_minutes: 20, idle_minutes: 5, customer_id: 'c1', deduction_amount: '7.25', fuel_consumed_gal: '1.000', ...patch,
});

beforeEach(() => {
  // Pin only the clock, so "today" (ET) is a fixed day inside a month with an earlier drive day.
  jest.useFakeTimers({
    now: new Date('2026-10-29T16:00:00Z'),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
  });
  jest.clearAllMocks();
  mockState.calls = [];
  mockState.todayRows = [
    row({}),
    row({ distance_miles: '4.00', is_business: false, customer_id: null, deduction_amount: '0', duration_minutes: 10, idle_minutes: 0 }),
    row({ vehicle_id: 'imei-2', vehicle_name: 'Truck Two', distance_miles: '30.50', duration_minutes: 50, idle_minutes: 2, deduction_amount: '22.11', fuel_consumed_gal: '2.5' }),
  ];
  mockState.mtdRows = [
    ...mockState.todayRows,
    row({ trip_date: monthStart, distance_miles: '6.00', deduction_amount: '4.35' }),
    row({ vehicle_id: 'imei-2', vehicle_name: 'Truck Two', trip_date: monthStart, distance_miles: '100.00', deduction_amount: '72.50' }),
  ];
  mockState.techRows = [{ name: 'Sample Alpha', bouncie_imei: 'imei-2' }];
  mockBouncie.getVehicles.mockResolvedValue([
    { id: 'imei-1', imei: 'imei-1', nickname: 'Truck One', isRunning: false },
    { id: 'imei-2', imei: 'imei-2', nickname: 'Truck Two', isRunning: true },
  ]);
});

afterEach(() => jest.useRealTimers());

afterAll(() => {
  if (saved === undefined) delete process.env[GATE];
  else process.env[GATE] = saved;
});

describe('getDashboard with GATE_TRUCK_VIEWS_PER_VEHICLE', () => {
  test('off: today, mtd and live_vehicle are today\'s, no new keys, no technician read', async () => {
    delete process.env[GATE];
    const dash = await getDashboard();
    expect(Object.keys(dash)).toEqual(['today', 'mtd', 'live_vehicle']);
    expect(JSON.stringify(dash)).toBe(JSON.stringify({
      today: {
        date: today, total_miles: 44.5, business_miles: 40.5, trip_count: 3, drive_minutes: 80,
        idle_minutes: 7, customer_stops: 2, irs_deduction: 29.36,
      },
      mtd: {
        month: monthStart, total_miles: 150.5, business_miles: 146.5, trip_count: 5,
        irs_deduction: 106.21, fuel_consumed_gal: 6.5, drive_days: 2, avg_daily_miles: 75.3,
      },
      live_vehicle: { id: 'imei-1', imei: 'imei-1', nickname: 'Truck One', isRunning: false },
    }));
    expect(mockState.calls.map(c => c.table)).toEqual(['mileage_log', 'mileage_log']);
  });

  test('on: vehicles are grouped from the same two reads, MTD miles first, with the technician', async () => {
    process.env[GATE] = 'true';
    const dash = await getDashboard();
    expect(Object.keys(dash)).toEqual(['today', 'mtd', 'live_vehicle', 'vehicles', 'live_vehicles']);
    expect(dash.today.total_miles).toBe(44.5);
    expect(dash.live_vehicle.nickname).toBe('Truck One');
    expect(dash.vehicles.map(v => v.vehicle_id)).toEqual(['imei-2', 'imei-1']);
    const [two, one] = dash.vehicles;
    expect(two).toMatchObject({ vehicle_name: 'Truck Two', technician: 'Sample Alpha' });
    expect(two.today).toMatchObject({ date: today, total_miles: 30.5, business_miles: 30.5, trip_count: 1, drive_minutes: 50, idle_minutes: 2, customer_stops: 1, irs_deduction: 22.11 });
    expect(two.mtd).toMatchObject({ month: monthStart, total_miles: 130.5, business_miles: 130.5, trip_count: 2, irs_deduction: 94.61, fuel_consumed_gal: 3.5 });
    expect(one).toMatchObject({ vehicle_name: 'Truck One', technician: null });
    expect(one.today).toMatchObject({ total_miles: 14, business_miles: 10, trip_count: 2, customer_stops: 1 });
    expect(one.mtd).toMatchObject({ total_miles: 20, business_miles: 16, trip_count: 3 });
    // the vehicle rows add up to the all-vehicles totals
    expect(one.mtd.total_miles + two.mtd.total_miles).toBe(dash.mtd.total_miles);
    // a vehicle with no mileage row yet still shows, from the live list
    expect(dash.live_vehicles.map(v => [v.nickname, v.technician])).toEqual([['Truck One', null], ['Truck Two', 'Sample Alpha']]);
    // two mileage_log reads and one technician read, never a loop per vehicle
    expect(mockState.calls.map(c => c.table)).toEqual(['mileage_log', 'mileage_log', 'technicians']);
  });

  test('on: a vehicle id that is not a Bouncie vehicle still gets a row; a missing name falls back to the id', async () => {
    process.env[GATE] = 'true';
    mockState.todayRows = [];
    mockState.mtdRows = [row({ vehicle_id: 'imei-9', vehicle_name: null, trip_date: monthStart })];
    mockBouncie.getVehicles.mockResolvedValue([]);
    const dash = await getDashboard();
    expect(dash.vehicles).toHaveLength(1);
    expect(dash.vehicles[0]).toMatchObject({ vehicle_id: 'imei-9', vehicle_name: 'imei-9', technician: null });
    expect(dash.vehicles[0].today.trip_count).toBe(0);
    expect(dash.live_vehicles).toEqual([]);
    expect(dash.live_vehicle).toBeNull();
  });

  test('any value but the exact string true keeps the gate off', async () => {
    process.env[GATE] = 'TRUE';
    const dash = await getDashboard();
    expect(Object.keys(dash)).toEqual(['today', 'mtd', 'live_vehicle']);
  });
});
