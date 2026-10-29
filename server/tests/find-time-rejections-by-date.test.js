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

test('a new stop (New Appointment, GATE_NEW_APPT_ROUTE_TIMES) runs the same finder on a prospective context', async () => {
  const { loadArrivalRouteContext } = require('../services/scheduling/arrival-route');
  enumerateArrivalPlacements.mockReturnValue({ placements: [{ windowStart: '17:00', windowEnd: '18:00', fit }], evaluated: 12, rejections: {} });
  const prospective = { lat: 27.4, lng: -82.5, estimated_duration_minutes: 60 };
  const result = await findAvailableSlots({ ...BASE, dateTo: OPEN_DAY, arrivalWindow: { prospective } });
  expect(loadArrivalRouteContext).toHaveBeenCalledWith(expect.objectContaining({ prospective, date: OPEN_DAY, technicianId: 'tech-1' }));
  expect(loadArrivalRouteContext.mock.calls[0][0]).not.toHaveProperty('serviceId');
  expect(result.slots.map((slot) => [slot.date, slot.start_time, slot.route_mode])).toEqual([[OPEN_DAY, '17:00', 'arrival_windows']]);
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

// GATE_PICKER_ROAD_CHECK (owner 2026-10-26, "Next 7 days"; 2026-10-27, "make
// sure costs are appropriate"): the staff picker's route check drives the
// road days on Google (hint-road-times.js roadWindows: today + 6 by default)
// and checks later days on the model, with no Google re-check.
test('the picker road check: Google on the road days, later days the model', async () => {
  const { loadArrivalRouteContext } = require('../services/scheduling/arrival-route');
  const roads = require('../services/scheduling/hint-road-times');
  const roadTravel = { preload: jest.fn(async () => {}), lookup: jest.fn() };
  const spy = jest.spyOn(roads, 'createPickerTravel').mockReturnValue(roadTravel);
  loadArrivalRouteContext.mockImplementation(async ({ date, travel }) => ({
    date, travel, target: { id: 'candidate', service_type: 'pest_control' }, rows: [],
  }));
  const source = (context) => (context.travel ? 'google_traffic' : undefined);
  enumerateArrivalPlacements.mockImplementation((context, opts) => {
    if (opts.collectLegs) { opts.collectLegs.push({ date: context.date }); return { placements: [], evaluated: 0, rejections: {} }; }
    return { placements: [
      { windowStart: '09:00', windowEnd: '10:00', fit: { ...fit, detourMinutes: 9, travelSource: source(context) } },
      { windowStart: '14:00', windowEnd: '15:00', fit: { ...fit, detourMinutes: 4, travelSource: source(context) } },
    ], evaluated: 2, rejections: {} };
  });
  const [near, far] = [ymd(1), ymd(10)];
  const pickerBudget = roads.createPickerBudget();
  try {
    const result = await findAvailableSlots({ ...BASE, dateFrom: near, dateTo: far, pickerRoadCheck: true, roadSpender: 'staff-1', pickerBudget });
    expect(loadArrivalRouteContext.mock.calls.every(([opts]) => opts.fromActiveStop === true)).toBe(true);
    // One travel source, counted against the staff user, on the request's budget.
    expect(spy).toHaveBeenCalledWith({ spender: 'staff-1', budget: pickerBudget });
    const enumerated = enumerateArrivalPlacements.mock.calls.filter(([, opts]) => !opts.collectLegs).map(([context]) => context);
    expect(enumerated.find((context) => context.date === near).travel).toBe(roadTravel);
    expect(enumerated.find((context) => context.date === far).travel).toBeUndefined();
    const at = (date) => result.slots.filter((slot) => slot.date === date)
      .map((slot) => [slot.start_time, slot.detour_minutes, slot.drive_source]).sort();
    expect(at(near)).toEqual([['09:00', 9, 'google'], ['14:00', 4, 'google']]);
    // A later day keeps the model's numbers: no Google re-check of its best hour.
    expect(at(far)).toEqual([['09:00', 9, undefined], ['14:00', 4, undefined]]);
    expect(evaluateArrivalPlacement).not.toHaveBeenCalled();
    // Three passes over the road days' routes, nothing more.
    expect(roadTravel.preload).toHaveBeenCalledTimes(3);
  } finally {
    spy.mockRestore();
  }
});

test('the road days follow PICKER_ROAD_TRAFFIC_DAYS + PICKER_ROAD_PLAIN_DAYS', async () => {
  const { loadArrivalRouteContext } = require('../services/scheduling/arrival-route');
  const roads = require('../services/scheduling/hint-road-times');
  const roadTravel = { preload: jest.fn(async () => {}), lookup: jest.fn() };
  const spy = jest.spyOn(roads, 'createPickerTravel').mockReturnValue(roadTravel);
  loadArrivalRouteContext.mockImplementation(async ({ date, travel }) => ({
    date, travel, target: { id: 'candidate', service_type: 'pest_control' }, rows: [],
  }));
  enumerateArrivalPlacements.mockReturnValue({ placements: [], evaluated: 0, rejections: {} });
  process.env.PICKER_ROAD_TRAFFIC_DAYS = '2';
  process.env.PICKER_ROAD_PLAIN_DAYS = '0';
  // Eastern dates, as the finder counts days (the UTC `ymd` can run a day ahead).
  const { etDateString } = require('../utils/datetime-et');
  const etYmd = (n) => {
    const d = new Date(`${etDateString(new Date())}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  try {
    await findAvailableSlots({ ...BASE, dateFrom: etYmd(1), dateTo: etYmd(3), pickerRoadCheck: true, roadSpender: 'staff-1' });
    const enumerated = enumerateArrivalPlacements.mock.calls.filter(([, opts]) => !opts.collectLegs).map(([context]) => context);
    expect(enumerated.filter((context) => context.travel === roadTravel).map((context) => context.date)).toEqual([etYmd(1)]);
  } finally {
    delete process.env.PICKER_ROAD_TRAFFIC_DAYS;
    delete process.env.PICKER_ROAD_PLAIN_DAYS;
    spy.mockRestore();
  }
});

// The tech Quick Move (GATE_TECH_MOVE_ROUTE_TIMES) continues today's route
// from the current stop on the model: no Google travel source, no re-check.
test('fromActiveStop without the picker road check: the current stop, no Google', async () => {
  const { loadArrivalRouteContext } = require('../services/scheduling/arrival-route');
  const roads = require('../services/scheduling/hint-road-times');
  const roadTravel = { preload: jest.fn(async () => {}), lookup: jest.fn() };
  const spy = jest.spyOn(roads, 'createPickerTravel').mockReturnValue(roadTravel);
  loadArrivalRouteContext.mockImplementation(async ({ date, travel }) => ({
    date, travel, target: { id: 'candidate', service_type: 'pest_control' }, rows: [],
  }));
  enumerateArrivalPlacements.mockReturnValue({ placements: [{ windowStart: '09:00', windowEnd: '10:00', fit: { ...fit, travelSource: undefined } }], evaluated: 1, rejections: {} });
  try {
    await findAvailableSlots({ ...BASE, dateFrom: ymd(1), dateTo: ymd(3), fromActiveStop: true });
    expect(loadArrivalRouteContext.mock.calls.every(([opts]) => opts.fromActiveStop === true)).toBe(true);
    expect(roadTravel.preload).not.toHaveBeenCalled();
    expect(enumerateArrivalPlacements.mock.calls.every(([context]) => context.travel === undefined)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

// Codex #6881 r2 (P1): with the road check off, no route gets the travel
// source and nothing is preloaded or re-checked — the gate-off search is the
// model, exactly as before, for staff and technicians alike.
test('the picker road check off: no Google, no re-check', async () => {
  const { loadArrivalRouteContext } = require('../services/scheduling/arrival-route');
  const roads = require('../services/scheduling/hint-road-times');
  const roadTravel = { preload: jest.fn(async () => {}), lookup: jest.fn() };
  const spy = jest.spyOn(roads, 'createPickerTravel').mockReturnValue(roadTravel);
  loadArrivalRouteContext.mockImplementation(async ({ date, travel }) => ({
    date, travel, target: { id: 'candidate', service_type: 'pest_control' }, rows: [],
  }));
  // A model-only fit carries no travelSource (only a road-checked one does).
  const modelFit = { ...fit, travelSource: undefined };
  enumerateArrivalPlacements.mockReturnValue({ placements: [{ windowStart: '09:00', windowEnd: '10:00', fit: modelFit }], evaluated: 1, rejections: {} });
  try {
    const result = await findAvailableSlots({ ...BASE, dateFrom: ymd(1), dateTo: ymd(10) });
    expect(roadTravel.preload).not.toHaveBeenCalled();
    expect(evaluateArrivalPlacement).not.toHaveBeenCalled();
    expect(enumerateArrivalPlacements.mock.calls.every(([context]) => context.travel === undefined)).toBe(true);
    expect(loadArrivalRouteContext.mock.calls.every(([opts]) => opts.fromActiveStop === false)).toBe(true);
    expect(result.slots.every((slot) => slot.drive_source === undefined)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
