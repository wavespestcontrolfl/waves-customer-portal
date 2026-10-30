/**
 * GATE_ROUTE_CHECK_LATE_DAYS wiring in find-time.js (mocked arrival-route, like
 * find-time-rejections-by-date.test.js): the staff arrival-window finder reads the gate at CALL time and
 * only then asks the enumerator for late days; a flagged fit becomes a `day_already_late` slot. The night
 * auto-dispatch search (findCapacitySlots, opts.arrivalSearch) and booking never pass the option.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })),
}));
jest.mock('../services/technician-capabilities', () => ({
  inactiveCapabilitiesForServices: jest.fn(async () => []),
}));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  createSchedulingTravel: jest.fn(() => ({ preload: async () => {}, diagnostics: () => ({}) })),
}));
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: () => true,
  loadArrivalRouteContext: jest.fn(async ({ date }) => ({
    date, target: { id: 'candidate', service_type: 'pest_control' }, rows: [{ id: 's09', route_order: 1, window_start: '09:00' }],
  })),
  enumerateArrivalPlacements: jest.fn(),
  evaluateArrivalPlacement: jest.fn(() => ({
    feasible: true, routeOrder: ['s09', 'candidate'], detourMinutes: 5, driveMinutes: 0, occupiedMinutes: 0, waitingMinutes: 0,
    estimatedArrival: null, arrivals: [{}], finishMinute: 1080, travelSource: 'none', travelReasons: [],
  })),
}));

const db = require('../models/db');
const { enumerateArrivalPlacements, evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');
const { findAvailableSlots } = require('../services/scheduling/find-time');

function chain(result) {
  const c = {};
  ['where', 'whereBetween', 'whereNull', 'whereIn'].forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  return c;
}
function nextBookableDate(from) {
  const date = new Date(from);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0);
  return date;
}
const DAY = nextBookableDate(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const BASE = {
  lat: 27.4, lng: -82.5, durationMinutes: 60, technicianId: 'tech-1', includeWeekends: true, includeBlackoutDates: true,
  dateFrom: DAY, dateTo: DAY, topN: 50, arrivalWindow: { serviceId: 'svc-1' },
};
const fit = (over = {}) => ({
  feasible: true, routeOrder: ['candidate'], detourMinutes: 4, driveMinutes: 10, occupiedMinutes: 60, waitingMinutes: 0,
  arrivalDelayMinutes: 0, estimatedArrival: '15:00', arrivals: [{ id: 'candidate' }], finishMinute: 700, ...over,
});

const saved = process.env.GATE_ROUTE_CHECK_LATE_DAYS;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_ROUTE_CHECK_LATE_DAYS;
  delete process.env.GATE_SCHEDULING_CAPACITY;
  db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 'tech-1', name: 'A' }]) : chain([])));
  enumerateArrivalPlacements.mockReturnValue({
    placements: [{ windowStart: '15:00', windowEnd: '16:00', fit: fit() }], evaluated: 11, rejections: { arrival_window: 10 },
  });
});
afterAll(() => {
  if (saved === undefined) delete process.env.GATE_ROUTE_CHECK_LATE_DAYS; else process.env.GATE_ROUTE_CHECK_LATE_DAYS = saved;
  delete process.env.GATE_SCHEDULING_CAPACITY;
});

describe('the staff arrival-window finder', () => {
  test('gate unset: the enumerator gets exactly the old limits and the slot has no flag', async () => {
    const result = await findAvailableSlots(BASE);
    for (const [, limits] of enumerateArrivalPlacements.mock.calls) {
      expect(Object.keys(limits).sort()).toEqual(['durationMinutes', 'earliestStartMin', 'latestServiceEndMin']);
    }
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).not.toHaveProperty('day_already_late');
  });

  test('gate on: the enumerator is asked for late days, and a flagged fit becomes a flagged slot', async () => {
    process.env.GATE_ROUTE_CHECK_LATE_DAYS = 'true';
    enumerateArrivalPlacements.mockReturnValue({
      placements: [
        { windowStart: '15:00', windowEnd: '16:00', fit: fit({ dayAlreadyLate: true }) },
        { windowStart: '16:00', windowEnd: '17:00', fit: fit({ dayAlreadyLate: true, estimatedArrival: '16:00' }) },
      ], evaluated: 11, rejections: { arrival_window: 9 },
    });
    const result = await findAvailableSlots(BASE);
    for (const [, limits] of enumerateArrivalPlacements.mock.calls) expect(limits.lateDays).toBe(true);
    expect(result.slots.map((s) => [s.start_time, s.day_already_late])).toEqual([['15:00', true], ['16:00', true]]);
    // The usual slot fields are untouched.
    expect(result.slots[0]).toMatchObject({ route_mode: 'arrival_windows', technician: { id: 'tech-1' }, estimated_arrival: '15:00' });
  });

  test('gate on: a clean day\'s slot carries no flag and the limits are otherwise the old ones', async () => {
    process.env.GATE_ROUTE_CHECK_LATE_DAYS = 'true';
    const result = await findAvailableSlots(BASE);
    expect(result.slots[0]).not.toHaveProperty('day_already_late');
    const limits = enumerateArrivalPlacements.mock.calls[0][1];
    expect(Object.keys(limits).sort()).toEqual(['durationMinutes', 'earliestStartMin', 'lateDays', 'latestServiceEndMin']);
  });

  test('the gate is read at call time: flipping it between requests changes the next request', async () => {
    await findAvailableSlots(BASE);
    process.env.GATE_ROUTE_CHECK_LATE_DAYS = 'true';
    await findAvailableSlots(BASE);
    delete process.env.GATE_ROUTE_CHECK_LATE_DAYS;
    await findAvailableSlots(BASE);
    expect(enumerateArrivalPlacements.mock.calls.map(([, limits]) => limits.lateDays === true)).toEqual([false, true, false]);
  });
});

describe('the night auto-dispatch search and booking never ask for late days', () => {
  const NIGHT = { ...BASE, arrivalWindow: undefined, serviceType: 'pest_control', slotStepMinutes: 60, arrivalSearch: true, providerTravel: false, techStartPoints: true };

  test('with the gate on, findCapacitySlots (arrivalSearch) evaluates every hour with the old options and never enumerates late days', async () => {
    process.env.GATE_ROUTE_CHECK_LATE_DAYS = 'true';
    const { slots } = await findAvailableSlots(NIGHT);
    expect(slots.length).toBeGreaterThan(0);
    expect(evaluateArrivalPlacement).toHaveBeenCalled();
    for (const [, options] of evaluateArrivalPlacement.mock.calls) expect(options).not.toHaveProperty('lateDays');
    expect(enumerateArrivalPlacements).not.toHaveBeenCalled();
    for (const slot of slots) expect(slot).not.toHaveProperty('day_already_late');
  });

  test('the night result is the same with the gate on and off', async () => {
    const off = await findAvailableSlots(NIGHT);
    process.env.GATE_ROUTE_CHECK_LATE_DAYS = 'true';
    const on = await findAvailableSlots(NIGHT);
    expect(on).toEqual(off);
  });

  test('a booking request under the capacity gate never gets the option either', async () => {
    process.env.GATE_ROUTE_CHECK_LATE_DAYS = 'true';
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    await findAvailableSlots({ ...NIGHT, arrivalSearch: undefined, customerFacing: true });
    for (const [, options] of evaluateArrivalPlacement.mock.calls) expect(options).not.toHaveProperty('lateDays');
  });
});

// The option is named only by the staff finder (find-time.js) and the evaluator that honors it. Comments do not count.
test('lateDays is named only by the staff finder, its picked-hour verdict, the evaluator and the staff save writers; the customer route check and the automatic writers never name it', () => {
  const root = path.join(__dirname, '..');
  const named = [];
  const code = (file) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', '__tests__'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /\blateDays\b/.test(code(full))) named.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  expect(named.sort()).toEqual([
    'routes/admin-schedule.js', 'services/rebooker.js', 'services/scheduling/arrival-route.js',
    'services/scheduling/find-time-hints.js', 'services/scheduling/find-time.js', 'services/scheduling/staff-save-route-check.js',
  ]);
});
