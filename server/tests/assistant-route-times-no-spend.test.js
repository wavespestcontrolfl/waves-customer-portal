/**
 * GATE_ASSISTANT_ROUTE_TIMES spends nothing (owner 2026-10-29, "drive clock"): the
 * assistant's model-only path passes providerTravel:false from availabilityForPin
 * through buildBookingAvailability to find-time, where capacity mode builds its
 * scheduling travel source with a zero request allowance. Every other caller
 * keeps today's allowance.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => {
  const actual = jest.requireActual('../services/scheduling/find-time');
  return { ...actual, findAvailableSlots: jest.fn() };
});

const db = require('../models/db');
const findTime = require('../services/scheduling/find-time');

describe('availabilityForPin -> buildBookingAvailability -> findAvailableSlots', () => {
  const saved = { cap: process.env.GATE_SCHEDULING_CAPACITY, self: process.env.GATE_SELF_BOOKING };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_SCHEDULING_CAPACITY = 'true'; // capacity mode forced on: the mode that buys road times
    process.env.GATE_SELF_BOOKING = 'true';
    const builder = {
      first: jest.fn().mockResolvedValue({ advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60, day_start: '08:00', day_end: '17:00' }),
      whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
      whereBetween: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), count: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    db.mockReturnValue(builder);
    db.raw = jest.fn((sql) => sql);
    findTime.findAvailableSlots.mockResolvedValue({ slots: [], total_feasible: 0 });
  });
  afterAll(() => {
    if (saved.cap === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = saved.cap;
    if (saved.self === undefined) delete process.env.GATE_SELF_BOOKING; else process.env.GATE_SELF_BOOKING = saved.self;
  });

  test('the assistant\'s call asks find-time for the model-only clock; /book\'s own call does not', async () => {
    const { availabilityForPin } = require('../routes/booking')._internals;
    await availabilityForPin({ lat: 27.4, lng: -82.4, serviceKey: 'pest_control', providerTravel: false });
    expect(findTime.findAvailableSlots).toHaveBeenCalledTimes(1);
    expect(findTime.findAvailableSlots.mock.calls[0][0].providerTravel).toBe(false);

    findTime.findAvailableSlots.mockClear();
    await availabilityForPin({ lat: 27.4, lng: -82.4, serviceKey: 'pest_control' });
    expect(findTime.findAvailableSlots.mock.calls[0][0].providerTravel).toBeUndefined();
  });

  test('the assistant adapter is the only caller that passes it', () => {
    const fs = require('fs');
    const path = require('path');
    const hits = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!['node_modules', 'tests'].includes(entry.name)) walk(full); return; }
      if (entry.name.endsWith('.js') && /availabilityForPin\(\{[^}]*providerTravel:\s*false/.test(fs.readFileSync(full, 'utf8'))) hits.push(entry.name);
    });
    walk(path.join(__dirname, '..'));
    expect(hits).toEqual(['assistant-route-times.js']);
  });
});

describe('find-time capacity mode: the travel source behind providerTravel', () => {
  test('false builds the scheduling travel with a zero request allowance; the default keeps today\'s', async () => {
    jest.resetModules();
    jest.doMock('../models/db', () => jest.fn());
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('../services/scheduling/blackout-dates', () => ({ getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })) }));
    jest.doMock('../services/technician-capabilities', () => ({ inactiveCapabilitiesForServices: jest.fn(async () => []) }));
    const createSchedulingTravel = jest.fn(() => ({ preload: async () => {}, diagnostics: () => ({}) }));
    jest.doMock('../services/route-optimizer', () => ({ HQ: { lat: 27.39, lng: -82.39 }, createSchedulingTravel }));
    jest.doMock('../services/scheduling/arrival-route', () => ({
      arrivalWindowRoutingEnabled: () => false,
      loadArrivalRouteContext: jest.fn(async () => ({ target: { id: 'candidate' }, rows: [] })),
      enumerateArrivalPlacements: jest.fn(),
      evaluateArrivalPlacement: jest.fn(() => ({ feasible: false })),
    }));
    const freshDb = require('../models/db');
    const chain = (result) => {
      const c = {};
      ['where', 'whereBetween', 'whereNull', 'whereIn'].forEach((m) => { c[m] = () => c; });
      c.select = async () => result;
      return c;
    };
    freshDb.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 'tech-1', name: 'A' }]) : chain([])));
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const { findAvailableSlots } = jest.requireActual('../services/scheduling/find-time');
    const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const base = { lat: 27.4, lng: -82.5, durationMinutes: 60, technicianId: 'tech-1', dateFrom: date, dateTo: date, topN: 5, serviceType: 'pest_control' };
    await findAvailableSlots({ ...base, providerTravel: false });
    expect(createSchedulingTravel).toHaveBeenLastCalledWith({ maxRequests: 0 });
    await findAvailableSlots(base);
    expect(createSchedulingTravel).toHaveBeenLastCalledWith(undefined);
    delete process.env.GATE_SCHEDULING_CAPACITY;
    ['../models/db', '../services/logger', '../services/scheduling/blackout-dates', '../services/technician-capabilities', '../services/route-optimizer', '../services/scheduling/arrival-route'].forEach((m) => jest.dontMock(m));
  });
});
