/**
 * Both whole-route finders report WHY they refused hours, per date
 * (`rejections_by_date`), so the availability strip can tell a day whose
 * route could not be verified from a day that is full (Codex r1/r2 on
 * #5592). The route-evaluation internals are mocked: this is about the
 * finders' own bookkeeping, not route feasibility.
 */
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
  // The context carries its date so the evaluators below can answer per day.
  loadArrivalRouteContext: jest.fn(async ({ date }) => ({
    date, target: { id: 'candidate', service_type: 'pest_control' }, rows: [],
  })),
  enumerateArrivalPlacements: jest.fn(),
  evaluateArrivalPlacement: jest.fn(),
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { enumerateArrivalPlacements, evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');

function chain(result) {
  const c = {};
  ['where', 'whereBetween', 'whereNull', 'whereIn'].forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  return c;
}

const ymd = (daysAhead) => new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const [OPEN_DAY, UNVERIFIED_DAY, FULL_DAY] = [ymd(30), ymd(31), ymd(32)];
const BASE = {
  lat: 27.4, lng: -82.5, durationMinutes: 60, technicianId: 'tech-1', includeWeekends: true, includeBlackoutDates: true,
  dateFrom: OPEN_DAY, dateTo: FULL_DAY, topN: 50, arrivalWindow: { serviceId: 'svc-1' },
};
const fit = {
  feasible: true, routeOrder: ['candidate'], detourMinutes: 4, driveMinutes: 10, occupiedMinutes: 60, waitingMinutes: 0,
  arrivalDelayMinutes: 0, estimatedArrival: '09:00', arrivals: [{ id: 'candidate' }], finishMinute: 700,
  travelSource: 'none', travelReasons: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_SCHEDULING_CAPACITY;
  db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 'tech-1', name: 'A' }]) : chain([])));
});
afterAll(() => { delete process.env.GATE_SCHEDULING_CAPACITY; });

test('the pre-capacity arrival finder keeps its enumerator\'s refusal counts, per date', async () => {
  enumerateArrivalPlacements.mockImplementation((context) => {
    if (context.date === OPEN_DAY) {
      return { placements: [{ windowStart: '09:00', windowEnd: '10:00', fit }], evaluated: 10, rejections: { arrival_window: 9 } };
    }
    if (context.date === UNVERIFIED_DAY) return { placements: [], evaluated: 10, rejections: { route_unverified: 10 } };
    return { placements: [], evaluated: 10, rejections: { arrival_window: 7, return_time: 3 } };
  });
  const result = await findAvailableSlots(BASE);
  expect(result.slots.map((slot) => [slot.date, slot.start_time])).toEqual([[OPEN_DAY, '09:00']]);
  expect(result.rejections_by_date).toEqual({
    [OPEN_DAY]: { arrival_window: 9 },
    [UNVERIFIED_DAY]: { route_unverified: 10 },
    [FULL_DAY]: { arrival_window: 7, return_time: 3 },
  });
});

test('the capacity finder splits its refusal counts by date', async () => {
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  evaluateArrivalPlacement.mockImplementation((context, options) => {
    if (context.date === UNVERIFIED_DAY) return { feasible: false, reason: 'route_unverified' };
    if (context.date === FULL_DAY) return { feasible: false, reason: 'day_overcommitted' };
    return options.windowStart === '09:00' ? fit : { feasible: false, reason: 'arrival_window' };
  });
  const result = await findAvailableSlots(BASE);
  expect(result.slots.map((slot) => [slot.date, slot.start_time])).toEqual([[OPEN_DAY, '09:00']]);
  const byDate = result.rejections_by_date;
  expect(Object.keys(byDate[UNVERIFIED_DAY])).toEqual(['route_unverified']);
  expect(Object.keys(byDate[FULL_DAY])).toEqual(['day_overcommitted']);
  expect(Object.keys(byDate[OPEN_DAY])).toEqual(['arrival_window']);
  // The flat counts are the per-date counts summed.
  const summed = {};
  for (const reasons of Object.values(byDate)) {
    for (const [reason, count] of Object.entries(reasons)) summed[reason] = (summed[reason] || 0) + count;
  }
  expect(summed).toEqual(result.rejections);
});

test('an advisory caller spends none of the shared Google drive-time allowance', async () => {
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  const { createSchedulingTravel } = require('../services/route-optimizer');
  evaluateArrivalPlacement.mockImplementation(() => fit);
  createSchedulingTravel.mockClear();
  await findAvailableSlots({ ...BASE, providerTravel: false });
  expect(createSchedulingTravel).toHaveBeenCalledWith({ maxRequests: 0 });
  // Every other caller (customer booking, the ranged button) keeps the allowance.
  createSchedulingTravel.mockClear();
  await findAvailableSlots(BASE);
  expect(createSchedulingTravel).toHaveBeenCalledWith(undefined);
});
