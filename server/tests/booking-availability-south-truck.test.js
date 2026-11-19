/**
 * Far-south days per truck on /book's offer builder (GATE_MULTI_TECH_CONFIRM, owner 2026-11-19 "build south"):
 * buildBookingAvailability keeps one technician per date+start. With the per-truck view on, the truck whose
 * far-south zone day it is claims a start both trucks have, before the funnel runs (an offered list,
 * `zoneFunnelAddress`) and on the confirmation rebuild that books it (`zoneTruckAddress`, no funnel), so the
 * commit books the truck the list offered. Gate off: no zone read before the claims, first claim by score.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/packing-geometry', () => ({ loadPackingAnchors: jest.fn() }));
jest.mock('../services/scheduling/line-technician', () => ({
  lineMapLive: jest.fn(),
  lineOfferRanking: jest.fn(),
  serviceLineFor: jest.fn(),
  recordLinePickShadow: jest.fn(),
}));
// The real funnel (onZoneDay, funnelOfferPool with a view); only the address's zone-day read is a fixture.
jest.mock('../services/scheduling/zone-day-funnel', () => ({
  ...jest.requireActual('../services/scheduling/zone-day-funnel'),
  offerFunnelDays: jest.fn(),
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { loadPackingAnchors } = require('../services/scheduling/packing-geometry');
const lineTech = require('../services/scheduling/line-technician');
const { offerFunnelDays } = require('../services/scheduling/zone-day-funnel');
const { buildBookingAvailability } = require('../routes/booking')._internals;
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const NOW = parseETDateTime(`${etDateString()}T12:00`);
const D = etDateString(addETDays(NOW, 10));
const CONFIG = {
  advance_days_min: 1, advance_days_max: 14, slot_duration_minutes: 60,
  day_start: '08:00', day_end: '18:00', max_self_books_per_day: 3,
};
const ADDRESS = '1 Test Way, Venice, FL, 34285';

const slotOf = (techId, startTime, extra = {}) => ({
  date: D, start_time: startTime, end_time: null, technician: { id: techId },
  detour_minutes: 3, stops_that_day: 0, rank: 1, score: 10, insertion: {}, ...extra,
});
// find-time scores the north truck first at 09:00; only the north truck has 11:00.
const SLOTS = () => [
  slotOf('tech-north', '09:00', { score: 5 }),
  slotOf('tech-south', '09:00', { score: 9 }),
  slotOf('tech-north', '11:00', { score: 6 }),
];
const zoneDay = (...techIds) => ({ days: new Set([D]), techDays: new Map([[D, new Set(techIds)]]) });

function wireDb() {
  const builder = {
    whereNot: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), whereNotIn: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(),
    count: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(), groupByRaw: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  db.mockReturnValue(builder);
  db.raw = jest.fn((sql) => sql);
}

async function build(extra = {}, slots = SLOTS()) {
  const gate = process.env.GATE_SCHEDULING_CAPACITY;
  process.env.GATE_SCHEDULING_CAPACITY = 'true';
  findAvailableSlots.mockResolvedValue({ slots, total_feasible: slots.length });
  try {
    return await buildBookingAvailability({
      lat: 27.1, lng: -82.4, duration: 60, rangeFrom: D, rangeTo: D, config: CONFIG, today: NOW, ...extra,
    });
  } finally {
    if (gate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = gate;
  }
}

const offers = (availability) => (availability.days[0]?.slots || []).map((s) => `${s.start_time}:${s.technician_id}`);

const SAVED_MULTI = process.env.GATE_MULTI_TECH_CONFIRM;
beforeEach(() => {
  jest.clearAllMocks();
  wireDb();
  loadPackingAnchors.mockResolvedValue([]);
  lineTech.lineMapLive.mockReturnValue(true);
  lineTech.lineOfferRanking.mockResolvedValue(null);
  offerFunnelDays.mockResolvedValue(zoneDay('tech-south'));
  process.env.GATE_MULTI_TECH_CONFIRM = 'true';
});
afterAll(() => {
  if (SAVED_MULTI === undefined) delete process.env.GATE_MULTI_TECH_CONFIRM; else process.env.GATE_MULTI_TECH_CONFIRM = SAVED_MULTI;
});

describe('buildBookingAvailability — far-south days per truck (GATE_MULTI_TECH_CONFIRM)', () => {
  test('an offered list: the zone-day truck claims 09:00, and the funnel keeps only its own zone-day starts', async () => {
    const result = await build({ zoneFunnelAddress: ADDRESS });
    expect(offerFunnelDays).toHaveBeenCalledTimes(1);
    expect(offerFunnelDays).toHaveBeenCalledWith({ address: ADDRESS, dateFrom: D, dateTo: D, conn: db });
    expect(offers(result)).toEqual(['09:00:tech-south']);
  });

  test('the confirmation rebuild (no funnel) books the same truck at 09:00 and keeps every other start', async () => {
    const result = await build({ zoneTruckAddress: ADDRESS });
    expect(offerFunnelDays).toHaveBeenCalledWith({ address: ADDRESS, dateFrom: D, dateTo: D, conn: db });
    expect(offers(result)).toEqual(['09:00:tech-south', '11:00:tech-north']);
  });

  test('the zone-day truck outranks the line map\'s home technician at a start both have', async () => {
    lineTech.lineOfferRanking.mockResolvedValue({ lines: ['general'], rankOf: (id) => ({ 'tech-north': 0, 'tech-south': 1 }[id] ?? null) });
    const result = await build({ zoneTruckAddress: ADDRESS, serviceLines: ['general'] });
    expect(offers(result)).toEqual(['09:00:tech-south', '11:00:tech-north']);
  });

  test('an unassigned zone stop, a date with no zone stop, or no zone for the address: first claim by score', async () => {
    for (const view of [zoneDay(null), { days: new Set(), techDays: new Map() }, null]) {
      offerFunnelDays.mockResolvedValue(view);
      expect(offers(await build({ zoneTruckAddress: ADDRESS }))).toEqual(['09:00:tech-north', '11:00:tech-north']);
    }
  });

  test('no address: nothing is read and the claims are today\'s', async () => {
    offerFunnelDays.mockResolvedValue(null);
    expect(offers(await build())).toEqual(['09:00:tech-north', '11:00:tech-north']);
    expect(offerFunnelDays).toHaveBeenCalledWith(expect.objectContaining({ address: undefined }));
  });

  // The route check drops the zone-day truck's only opening (another customer would be late). The funnel runs again over
  // the route-checked rest, so the other truck's opening seeds the day instead of an empty list (Codex pre-push P1
  // on 068130b3fc).
  test('the route check drops every zone-day opening: the other truck\'s opening seeds the day', async () => {
    const routeCheck = require('../services/scheduling/customer-route-check');
    const mode = jest.spyOn(routeCheck, 'customerRouteCheckMode').mockReturnValue('on');
    const check = jest.spyOn(routeCheck, 'filterOfferedSlots')
      .mockImplementation(async ({ slots }) => ({ slots: slots.filter((s) => s.technician_id !== 'tech-south') }));
    try {
      expect(offers(await build({ zoneFunnelAddress: ADDRESS, surface: 'inspection' }))).toEqual(['11:00:tech-north']);
      expect(check).toHaveBeenCalledTimes(2);
      // A route check that keeps the zone-day opening runs once and changes nothing.
      check.mockClear();
      check.mockImplementation(async ({ slots }) => ({ slots }));
      expect(offers(await build({ zoneFunnelAddress: ADDRESS, surface: 'inspection' }))).toEqual(['09:00:tech-south']);
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      mode.mockRestore();
      check.mockRestore();
    }
  });

  test('gate off: no zone read before the claims, first claim by score, as with one truck', async () => {
    delete process.env.GATE_MULTI_TECH_CONFIRM;
    expect(offers(await build({ zoneTruckAddress: ADDRESS }))).toEqual(['09:00:tech-north', '11:00:tech-north']);
    expect(offerFunnelDays).not.toHaveBeenCalled();
  });
});
