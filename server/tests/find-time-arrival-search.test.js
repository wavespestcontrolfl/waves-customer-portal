/**
 * The nightly auto-dispatch arrival search (GATE_AUTO_DISPATCH_ARRIVAL_SEARCH,
 * owner 2026-10-24): find-time's arrival-window engine (findCapacitySlots) for
 * the ONE call that passes `arrivalSearch: true` (auto-dispatch/
 * candidate-slots.js), while GATE_SCHEDULING_CAPACITY — which the owner turned
 * off on 2026-10-05 for every booking surface — stays off. Pins find-time.js's
 * own wiring with a mocked arrival-route (like find-time-insertion.test.js):
 * which engine runs, what the route context is asked for, and the Google
 * allowance. A source guard keeps every other caller off the option.
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
  arrivalWindowRoutingEnabled: () => false,
  loadArrivalRouteContext: jest.fn(async () => ({
    target: { id: 'candidate', service_type: 'pest_control' },
    rows: [{ id: 's09', route_order: 1, window_start: '09:00' }],
  })),
  enumerateArrivalPlacements: jest.fn(),
  evaluateArrivalPlacement: jest.fn(() => ({
    feasible: true, routeOrder: ['s09', 'candidate'],
    detourMinutes: 5, driveMinutes: 0, occupiedMinutes: 0, waitingMinutes: 0,
    estimatedArrival: null, arrivals: [{}], finishMinute: 1080,
    travelSource: 'none', travelReasons: [],
  })),
}));

const db = require('../models/db');
const { createSchedulingTravel } = require('../services/route-optimizer');
const { loadArrivalRouteContext } = require('../services/scheduling/arrival-route');
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
const FUTURE_DATE = nextBookableDate(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const BASE = {
  lat: 27.4, lng: -82.5, durationMinutes: 60, technicianId: 'tech-1',
  dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 50, serviceType: 'pest_control', slotStepMinutes: 60,
};
// The night tool's own request (candidate-slots.js findTimeArgs with the gate on).
const NIGHT = { ...BASE, arrivalSearch: true, providerTravel: false, techStartPoints: true };

const routeAsks = () => loadArrivalRouteContext.mock.calls.map(([args]) => args);

describe('findAvailableSlots — the night arrival search', () => {
  const saved = process.env.GATE_SCHEDULING_CAPACITY;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_SCHEDULING_CAPACITY;
    db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 'tech-1', name: 'A' }]) : chain([])));
  });
  afterAll(() => { if (saved === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = saved; });

  test('with the old gate off, the night request runs the arrival engine with today\'s job lengths, the tech start point and no Google', async () => {
    const { slots } = await findAvailableSlots(NIGHT);
    expect(slots.length).toBeGreaterThan(0);
    expect(routeAsks().length).toBeGreaterThan(0);
    for (const ask of routeAsks()) {
      expect(ask).toMatchObject({ technicianId: 'tech-1', preserveCapacity: true, planningMinutes: false, startPoints: true });
    }
    // providerTravel false: none of the paid road allowance customer booking shares.
    expect(createSchedulingTravel).toHaveBeenCalledWith({ maxRequests: 0 });
  });

  test('the night request hands the route the van departure it was given', async () => {
    await findAvailableSlots({ ...NIGHT, departureMinutes: 450 });
    expect(routeAsks().length).toBeGreaterThan(0);
    for (const ask of routeAsks()) expect(ask.vanDepartureMin).toBe(450);
  });

  test('the night request with no departure leaves vanDepartureMin off the route ask', async () => {
    await findAvailableSlots(NIGHT);
    for (const ask of routeAsks()) expect(ask.vanDepartureMin).toBeUndefined();
  });

  test('a booking caller never gets vanDepartureMin, even when it passes departureMinutes', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    await findAvailableSlots({ ...BASE, departureMinutes: 450 });
    expect(routeAsks().length).toBeGreaterThan(0);
    for (const ask of routeAsks()) expect(ask.vanDepartureMin).toBeUndefined();
  });

  test('a booking request with the old gate off keeps today\'s search: the arrival engine is never asked', async () => {
    // lat/lng is checked by today's search only; its answer proves that path ran.
    expect(await findAvailableSlots({ ...BASE, lat: null })).toEqual({ error: 'lat/lng required', slots: [] });
    expect(loadArrivalRouteContext).not.toHaveBeenCalled();
    expect(createSchedulingTravel).not.toHaveBeenCalled();
  });

  test('a booking request under the old gate asks the route exactly as before: no per-call switch, planning minutes, the office', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    await findAvailableSlots(BASE);
    expect(routeAsks().length).toBeGreaterThan(0);
    for (const ask of routeAsks()) {
      expect(ask).toMatchObject({ preserveCapacity: false, planningMinutes: true, startPoints: false });
    }
    expect(createSchedulingTravel).toHaveBeenCalledWith(undefined);
  });
});

// The owner's condition for the build (scope page 58XT2mGs, "a test fails if
// any booking caller asks for the arrival search"): the option is named in
// the night tool's files and find-time alone. Comments do not count.
test('only the nightly auto-dispatch search passes arrivalSearch to find-time', () => {
  const root = path.join(__dirname, '..');
  const named = [];
  const code = (file) => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'tests', '__tests__'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /\barrivalSearch\b/.test(code(full))) {
        named.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  expect(named.sort()).toEqual([
    'services/auto-dispatch/candidate-slots.js',
    'services/auto-dispatch/config.js',
    'services/auto-dispatch/index.js',
    'services/scheduling/find-time.js',
  ]);
});
