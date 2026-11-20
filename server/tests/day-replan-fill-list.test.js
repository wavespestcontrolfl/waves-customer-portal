/**
 * The 07:05 notice's fill list (services/day-replan/fill-list.js, owner 2026-11-20 *b*): the open estimates whose
 * first visit fits a listed block, by the schedule gap tool's own check (the real analyzeGapCandidate and arrival
 * search), least added drive first. The reads are faked; synthetic ids and names only.
 */
jest.mock('../models/db', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-slot-availability', () => {
  const actual = jest.requireActual('../services/estimate-slot-availability');
  return {
    resolveEstimateCoords: jest.fn(), resolveCatalogSlotProfile: jest.fn(), appointmentServicesFor: jest.fn((profile) => profile.services),
    estimateMoveInDate: jest.fn(async () => null),
    // The booking page's own season rule.
    seasonalSelectionProfile: actual.seasonalSelectionProfile, inMosquitoSeason: actual.inMosquitoSeason,
  };
});
jest.mock('../services/auto-dispatch/preferences', () => {
  const actual = jest.requireActual('../services/auto-dispatch/preferences');
  return { ...actual, getCustomerSchedulingPreferences: jest.fn(async (_id, type) => ({ ...actual.normalizePreferences(null, type), service_category: 'pest_control' })) };
});
jest.mock('../services/scheduling/day-stops', () => ({ ...jest.requireActual('../services/scheduling/day-stops'), dayStopsQuery: jest.fn() }));
jest.mock('../services/scheduling/day-quality', () => ({ QUALITY_EXCLUDED_STATUSES: ['cancelled', 'completed'], dayStopSelect: () => ['stop columns'] }));
jest.mock('../services/scheduling/tech-start-point', () => ({
  ...jest.requireActual('../services/scheduling/tech-start-point'), loadTechStartPoints: jest.fn(async () => new Map()),
}));
jest.mock('../services/scheduling/departure-time', () => ({ dayDepartureMinutes: jest.fn(async () => 480) }));
jest.mock('../services/day-replan/route-check', () => ({ DISPATCH_DAY_END: 18 * 60 }));
// The estimate page's own reads: a guarantee-only renewal, and an upcoming visit its page would adopt.
jest.mock('../routes/estimate-public', () => ({
  parseEstimateDataSafe: jest.fn((row) => (typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data || {})),
  isRodentGuaranteeOnlyEstimate: jest.fn(() => false),
  findLinkedUpcomingAppointment: jest.fn(async () => null),
  adoptionServiceModesForContract: jest.fn(() => ['recurring']),
}));
// The real check, watched: the list must yield to the event loop between checks.
jest.mock('../services/scheduling/gap-candidates', () => {
  const actual = jest.requireActual('../services/scheduling/gap-candidates');
  return { ...actual, analyzeGapCandidate: jest.fn(actual.analyzeGapCandidate) };
});

const logger = require('../services/logger');
const page = require('../routes/estimate-public');
const slots = require('../services/estimate-slot-availability');
const { getCustomerSchedulingPreferences, normalizePreferences } = require('../services/auto-dispatch/preferences');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const { loadTechStartPoints } = require('../services/scheduling/tech-start-point');
const { dayDepartureMinutes } = require('../services/scheduling/departure-time');
const { HQ } = require('../services/route-optimizer');
const { analyzeGapCandidate } = require('../services/scheduling/gap-candidates');
const { fillList, MAX_PER_BLOCK, _internals } = require('../services/day-replan/fill-list');

const NOW = new Date('2040-09-09T12:00:00Z');
const DAY = '2040-09-10';
const TECH = '00000000-0000-4000-8000-000000000001';
const PROFILE = { durationMinutes: 60, serviceLabel: 'Pest Control', services: [{ service: 'pest_control', label: 'Pest Control' }] };

const stop = (id, start, extra = {}) => ({ id, technician_id: TECH, status: 'confirmed', window_start: start,
  estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng, ...extra });
const estimate = (id, extra = {}) => ({ id, customer_id: `c-${id}`, customer_name: `Pat ${id}`, status: 'sent', ...extra });

// A fake knex: each table's chain records its calls; a where(fn) runs fn on a recorder of its own. `inactive` maps a
// capability category to the technicians set to off for it; `scheduleBlocks` are the tech_schedule_blocks rows.
function fakeConn({ estimates = [], taken = [], inactive = {}, scheduleBlocks = [] } = {}) {
  const calls = [];
  const conn = (table) => {
    const q = { categories: [] };
    for (const m of ['whereIn', 'whereNull', 'whereNotNull', 'whereNot', 'orWhere', 'orderBy', 'limit']) {
      q[m] = (...args) => {
        calls.push([table, m, args]);
        if (m === 'whereIn' && args[0] === 'service_category') q.categories = args[1];
        return q;
      };
    }
    q.where = (...args) => {
      if (typeof args[0] === 'function') args[0](q);
      else calls.push([table, 'where', args]);
      return q;
    };
    q.select = async () => ({ estimates, tech_schedule_blocks: scheduleBlocks }[table] || []);
    q.pluck = async () => (table === 'scheduled_services' ? taken : q.categories.flatMap((category) => inactive[category] || []));
    return q;
  };
  return { conn, calls };
}

// Every listed day's stops (the gap tool's read): by date, numbered in route order as dispatch saves them.
function dayStops(byDay) {
  dayStopsQuery.mockImplementation((_conn, { dateStr }) => ({
    whereRaw: async () => (byDay[dateStr] || []).map((row, i) => ({ route_order: i + 1, ...row })),
  }));
}

// Each estimate's stored location (absent: none can stand in; an Error: the read failed).
function locations(byId) {
  slots.resolveEstimateCoords.mockImplementation(async (row) => {
    if (byId[row.id] instanceof Error) throw byId[row.id];
    if (!byId[row.id]) throw Object.assign(new Error('estimate coordinates need a geocode'), { code: 'COORDS_NEED_GEOCODE' });
    return byId[row.id];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  slots.resolveCatalogSlotProfile.mockResolvedValue(PROFILE);
});

describe('open estimates', () => {
  test('sent or viewed, live and with a customer; internal test contacts and estimates a visit or live hold came from are left out', async () => {
    const { conn, calls } = fakeConn({
      estimates: [estimate('e1'), estimate('e2', { customer_name: 'Shakedown Test' }), estimate('e3'),
        estimate('e4', { customer_id: '3274944a-f509-413c-9dee-a8b0cdb16493' })],
      taken: ['e3'],
    });
    expect((await _internals.openEstimates(conn, NOW)).estimates.map((e) => e.id)).toEqual(['e1']);
    expect(calls).toEqual(expect.arrayContaining([
      ['estimates', 'whereIn', ['status', ['sent', 'viewed']]], ['estimates', 'whereNull', ['archived_at']],
      ['estimates', 'whereNotNull', ['customer_id']], ['estimates', 'whereNull', ['expires_at']], ['estimates', 'orWhere', ['expires_at', '>', NOW]],
      ['estimates', 'orderBy', ['created_at', 'desc']],
      ['scheduled_services', 'whereIn', ['source_estimate_id', ['e1', 'e3']]], ['scheduled_services', 'whereNot', ['status', 'cancelled']],
      ['scheduled_services', 'whereNull', ['reservation_expires_at']], ['scheduled_services', 'orWhere', ['reservation_expires_at', '>', NOW]],
    ]));
  });

  test('the cap counts open estimates only: newer test contacts and taken estimates never take a place', async () => {
    const tests = Array.from({ length: 45 }, (_, i) => estimate(`t${i}`, { customer_name: 'Shakedown Test' }));
    const older = Array.from({ length: 45 }, (_, i) => estimate(`o${i}`));
    const { conn, calls } = fakeConn({ estimates: [...tests, ...older], taken: ['o0'] });
    const { estimates: open } = await _internals.openEstimates(conn, NOW);
    expect(open).toHaveLength(_internals.MAX_ESTIMATES);
    expect(open[0].id).toBe('o1');
    expect(calls.some(([table, m]) => table === 'estimates' && m === 'limit')).toBe(false);
    // The page's lookup runs for the estimates it keeps, and stops at the cap.
    expect(page.findLinkedUpcomingAppointment).toHaveBeenCalledTimes(_internals.MAX_ESTIMATES);
  });

  test('an estimate with no visit to book, or whose page already shows an appointment, is left out', async () => {
    page.isRodentGuaranteeOnlyEstimate.mockImplementation((row) => row.id === 'renewal');
    page.findLinkedUpcomingAppointment.mockImplementation(async (row) => (row.id === 'booked' ? { id: 'visit-1' } : null));
    try {
      // estimate_data as a JSON string: the page's helpers get it parsed, as the page's view passes it.
      const stored = { estimate_data: JSON.stringify({ result: { recurring: { services: [{ service: 'pest_control' }] } } }) };
      const parsed = JSON.parse(stored.estimate_data);
      const { conn } = fakeConn({ estimates: [estimate('renewal', stored), estimate('booked', stored), estimate('open', stored)] });
      expect(await _internals.openEstimates(conn, NOW)).toEqual({ estimates: [expect.objectContaining({ id: 'open' })], unread: 0 });
      expect(page.isRodentGuaranteeOnlyEstimate).toHaveBeenCalledWith(expect.objectContaining({ id: 'open' }), parsed);
      // As the page's view asks it: the estimate's own service modes, on this connection.
      expect(page.adoptionServiceModesForContract).toHaveBeenCalledWith(expect.objectContaining({ id: 'open' }), parsed);
      expect(page.findLinkedUpcomingAppointment).toHaveBeenCalledWith(expect.objectContaining({ id: 'open' }), parsed,
        { database: conn, serviceModes: ['recurring'] });
      expect(page.findLinkedUpcomingAppointment).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'renewal' }), expect.anything(), expect.anything());
    } finally {
      page.isRodentGuaranteeOnlyEstimate.mockImplementation(() => false);
      page.findLinkedUpcomingAppointment.mockImplementation(async () => null);
    }
  });

  test('an estimate whose page lookup fails is left off, counted as unread and logged; the rest are still checked', async () => {
    page.findLinkedUpcomingAppointment.mockImplementation(async (row) => {
      if (row.id === 'down') throw new Error('lookup timeout');
      return null;
    });
    try {
      const { conn } = fakeConn({ estimates: [estimate('down'), estimate('ok')] });
      expect(await _internals.openEstimates(conn, NOW)).toEqual({ estimates: [expect.objectContaining({ id: 'ok' })], unread: 1 });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('estimate down unread (lookup timeout)'));
      // The notice's count: the estimate was checked, and could not be read.
      expect(await fillList(conn, [], NOW)).toEqual({ checked: 2, fitted: 0, noLocation: 0, unread: 1, byBlock: [] });
    } finally {
      page.findLinkedUpcomingAppointment.mockImplementation(async () => null);
    }
  });

  test('none open: the visits are not read, and with no block nothing else is read', async () => {
    const { conn, calls } = fakeConn();
    expect(await _internals.openEstimates(conn, NOW)).toEqual({ estimates: [], unread: 0 });
    expect(calls.some(([table]) => table === 'scheduled_services')).toBe(false);
    const open = fakeConn({ estimates: [estimate('e1')] });
    expect(await fillList(open.conn, [], NOW)).toEqual({ checked: 1, fitted: 0, noLocation: 0, unread: 0, byBlock: [] });
    expect(slots.resolveEstimateCoords).not.toHaveBeenCalled();
    expect(dayStopsQuery).not.toHaveBeenCalled();
  });
});

describe('a fit inside the block', () => {
  test('the visit runs from the van\'s arrival, or the window\'s start when the van is early, to its end', () => {
    const block = { start: 9 * 60, min: 90 };
    const late = { windowStart: '09:00', windowEnd: '10:00', estimatedArrival: '09:40', addedDriveMinutes: 3 };
    const early = { windowStart: '09:00', windowEnd: '10:00', estimatedArrival: '08:50', addedDriveMinutes: 5.5 };
    // Arriving at 9:40, the visit ends at 10:40, past the block: the next fit is taken.
    expect(_internals.fitInside(block, [late, early])).toEqual({ windowStart: '09:00', startMin: 540, endMin: 600, length: 60, addedDriveMin: 6 });
    // The offered window stays 9:00 when the van comes at 9:40.
    expect(_internals.fitInside({ start: 9 * 60, min: 100 }, [late])).toEqual({ windowStart: '09:00', startMin: 580, endMin: 640, length: 60, addedDriveMin: 3 });
    expect(_internals.fitInside({ start: 9 * 60 + 1, min: 120 }, [early])).toBeNull();
    expect(_internals.fitInside(block, [{ ...early, addedDriveMinutes: -0.4 }]).addedDriveMin).toBe(0);
  });
});

describe('fillList', () => {
  const morning = { day: DAY, techId: TECH, start: 9 * 60, min: 4 * 60 };

  test('each block lists its best three, least added drive first: the length, the drive it adds and the finish', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('later', '13:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng }, mid: { lat: HQ.lat + 0.04, lng: HQ.lng },
      far: { lat: HQ.lat + 0.08, lng: HQ.lng }, farthest: { lat: HQ.lat + 0.15, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: ['mid', 'farthest', 'near', 'far'].map((id) => estimate(id)) });
    const out = await fillList(conn, [morning], NOW);
    expect(out).toMatchObject({ checked: 4, fitted: 4, noLocation: 0, unread: 0 });
    const [lines] = out.byBlock;
    expect(lines.map((l) => l.estimateId)).toEqual(['near', 'mid', 'far']);
    expect(lines).toHaveLength(MAX_PER_BLOCK);
    expect(lines[0].addedDriveMin).toBeLessThan(lines[1].addedDriveMin);
    expect(lines[1].addedDriveMin).toBeLessThan(lines[2].addedDriveMin);
    for (const line of lines) {
      expect(line).toMatchObject({ name: `Pat ${line.estimateId}`, label: 'Pest Control', length: 60, endMin: line.startMin + 60 });
      expect(line.startMin).toBeGreaterThanOrEqual(9 * 60);
      expect(line.endMin).toBeLessThanOrEqual(13 * 60);
    }
    // Never geocoded: each location is the stored one or none.
    expect(slots.resolveEstimateCoords).toHaveBeenCalledTimes(4);
    for (const [, opts] of slots.resolveEstimateCoords.mock.calls) expect(opts).toEqual({ paidCalls: false, strictReads: true });
    expect(slots.resolveCatalogSlotProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'near' }), {}, conn);
    expect(getCustomerSchedulingPreferences).toHaveBeenCalledWith('c-near', 'Pest Control', conn, { serviceKey: 'pest_control' });
    // The gap tool's read of the day, with its statuses and columns.
    expect(dayStopsQuery).toHaveBeenCalledWith(conn, { dateStr: DAY, excludeStatuses: ['cancelled', 'completed'], select: ['stop columns'] });
    expect(loadTechStartPoints).toHaveBeenCalledWith(conn, [TECH]);
  });

  test('least added drive comes first, even when it starts later (a customer who asked for late morning)', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('later', '13:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng }, mid: { lat: HQ.lat + 0.05, lng: HQ.lng } });
    getCustomerSchedulingPreferences.mockImplementationOnce(async (_id, type) => ({ ...normalizePreferences(null, type),
      service_category: 'pest_control', preferred_time_window: { startMin: 11 * 60, endMin: 13 * 60 } }));
    const { conn } = fakeConn({ estimates: [estimate('near'), estimate('mid')] });
    const [lines] = (await fillList(conn, [morning], NOW)).byBlock;
    expect(lines.map((l) => l.estimateId)).toEqual(['near', 'mid']);
    expect(lines[0].startMin).toBe(11 * 60);
    expect(lines[1].startMin).toBeLessThan(11 * 60);
    expect(lines[0].addedDriveMin).toBeLessThan(lines[1].addedDriveMin);
  });

  test('a new visit goes where the staff finder puts it: before the first stop, between stops and after the last', async () => {
    dayStops({ [DAY]: [stop('midday', '11:00', { window_end: '12:00' }), stop('afternoon', '14:00', { window_end: '15:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near')] });
    const blocks = [{ day: DAY, techId: TECH, start: 8 * 60, min: 3 * 60 }, { day: DAY, techId: TECH, start: 12 * 60 + 30, min: 90 },
      { day: DAY, techId: TECH, start: 15 * 60 + 30, min: 90 }];
    const out = await fillList(conn, blocks, NOW);
    for (const [i, lines] of out.byBlock.entries()) {
      expect(lines).toEqual([expect.objectContaining({ estimateId: 'near' })]);
      expect(lines[0].startMin).toBeGreaterThanOrEqual(blocks[i].start);
      expect(lines[0].endMin).toBeLessThanOrEqual(blocks[i].start + blocks[i].min);
    }
  });

  test('a visit that cannot run inside a block is not listed there; each block takes its own best fit', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('midday', '10:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near', { customer_name: '' })] });
    const blocks = [{ day: DAY, techId: TECH, start: 9 * 60, min: 60 }, { day: DAY, techId: TECH, start: 14 * 60, min: 120 },
      { day: DAY, techId: TECH, start: 11 * 60, min: 60 }];
    slots.resolveCatalogSlotProfile.mockResolvedValue({ ...PROFILE, durationMinutes: 90 });
    const long = await fillList(conn, blocks, NOW);
    // 90 minutes do not fit an hour's block; the afternoon block holds it.
    expect(long.byBlock[0]).toEqual([]);
    expect(long.byBlock[1]).toEqual([expect.objectContaining({ estimateId: 'near', name: null, length: 90 })]);
    expect(long.byBlock[1][0].startMin).toBeGreaterThanOrEqual(14 * 60);
    expect(long.fitted).toBe(1);
    // The midday stop holds 10:00 to 2:00: nothing runs inside the 11:00 block.
    expect(long.byBlock[2]).toEqual([]);
    // One read of the day for its three blocks.
    expect(dayStopsQuery).toHaveBeenCalledTimes(1);
  });

  test('the van is home by the route check\'s day end: a far visit fits an early block, not the last hour', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ far: { lat: HQ.lat + 0.6, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('far')] });
    const out = await fillList(conn, [{ day: DAY, techId: TECH, start: 16 * 60, min: 60 }, { day: DAY, techId: TECH, start: 13 * 60, min: 60 }], NOW);
    expect(out.byBlock[0]).toEqual([]);
    expect(out.byBlock[1]).toEqual([expect.objectContaining({ estimateId: 'far', startMin: 13 * 60 })]);
  });

  test('the van starts and ends at the technician\'s start point, and leaves at the departure time', async () => {
    dayStops({ [DAY]: [] });
    const farAway = { lat: HQ.lat + 0.6, lng: HQ.lng };
    locations({ far: farAway });
    const { conn } = fakeConn({ estimates: [estimate('far')] });
    const late = [{ day: DAY, techId: TECH, start: 16 * 60, min: 60 }];
    // From the office the van is not home by 6 PM; from a start point next door it is.
    expect((await fillList(conn, late, NOW)).byBlock[0]).toEqual([]);
    loadTechStartPoints.mockResolvedValueOnce(new Map([[TECH.toLowerCase(), { lat: farAway.lat + 0.005, lng: farAway.lng }]]));
    expect((await fillList(conn, late, NOW)).byBlock[0]).toEqual([expect.objectContaining({ estimateId: 'far', startMin: 16 * 60 })]);
    // A 10:00 AM departure: no visit runs in the 9:00 block.
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const near = fakeConn({ estimates: [estimate('near')] });
    const nine = [{ day: DAY, techId: TECH, start: 9 * 60, min: 60 }];
    expect((await fillList(near.conn, nine, NOW)).byBlock[0]).toHaveLength(1);
    dayDepartureMinutes.mockResolvedValueOnce(10 * 60);
    expect((await fillList(near.conn, nine, NOW)).byBlock[0]).toEqual([]);
  });

  test('no stored location is counted, a failed read is counted and logged (never as no location), and the rest still fit', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('later', '13:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng }, broken: { lat: HQ.lat, lng: HQ.lng }, dbdown: new Error('connection reset') });
    slots.resolveCatalogSlotProfile.mockImplementation(async (row) => {
      if (row.id === 'broken') throw new Error('catalog down');
      return PROFILE;
    });
    const { conn } = fakeConn({ estimates: [estimate('near'), estimate('nowhere'), estimate('broken'), estimate('dbdown')] });
    const out = await fillList(conn, [morning], NOW);
    expect(out).toMatchObject({ checked: 4, fitted: 1, noLocation: 1, unread: 2 });
    expect(out.byBlock[0].map((l) => l.estimateId)).toEqual(['near']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('estimate broken unread (catalog down)'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('estimate dbdown unread (connection reset)'));
  });

  test('a technician without the service\'s capability gets no line', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn, calls } = fakeConn({ estimates: [estimate('near')], inactive: { general: [TECH] } });
    const out = await fillList(conn, [morning], NOW);
    expect(out).toMatchObject({ checked: 1, fitted: 0, byBlock: [[]] });
    expect(calls).toContainEqual(['technician_capabilities', 'whereIn', ['service_category', ['general']]]);
  });

  test('a combined visit needs the capability for each service it performs', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    slots.resolveCatalogSlotProfile.mockResolvedValue({ ...PROFILE, reservationServiceMix: true, serviceLabel: 'Pest Control + Lawn Care',
      services: [{ service: 'pest_control', label: 'Pest Control' }, { service: 'lawn_care', label: 'Lawn Care' }] });
    const offForLawn = fakeConn({ estimates: [estimate('near')], inactive: { lawn: [TECH] } });
    expect((await fillList(offForLawn.conn, [morning], NOW)).byBlock[0]).toEqual([]);
    expect(offForLawn.calls).toContainEqual(['technician_capabilities', 'whereIn', ['service_category', ['general', 'lawn']]]);
    const offForMosquito = fakeConn({ estimates: [estimate('near')], inactive: { mosquito: [TECH] } });
    expect((await fillList(offForMosquito.conn, [morning], NOW)).byBlock[0]).toEqual([expect.objectContaining({ label: 'Pest Control + Lawn Care' })]);
  });

  test('the mowing-day rule covers every service the visit performs: a pest-first visit with lawn care', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    // DAY is a Monday (weekday 1): the customer's mowing rule blocks it.
    const mowingPrefs = async (_id, type) => ({ ...normalizePreferences(null, type), service_category: 'pest_control',
      mowing: { mode: 'true', blocked_weekdays: [1], days: [] } });
    const combined = { ...PROFILE, reservationServiceMix: true, serviceLabel: 'Pest Control + Lawn Care',
      services: [{ service: 'pest_control', label: 'Pest Control' }, { service: 'lawn_care', label: 'Lawn Care' }] };
    const { conn } = fakeConn({ estimates: [estimate('near')] });
    slots.resolveCatalogSlotProfile.mockResolvedValue(combined);
    getCustomerSchedulingPreferences.mockImplementationOnce(mowingPrefs);
    expect((await fillList(conn, [morning], NOW)).byBlock[0]).toEqual([]);
    // Pest alone: the mowing day does not hold it.
    slots.resolveCatalogSlotProfile.mockResolvedValue(PROFILE);
    getCustomerSchedulingPreferences.mockImplementationOnce(mowingPrefs);
    expect((await fillList(conn, [morning], NOW)).byBlock[0]).toHaveLength(1);
  });

  test('the day\'s schedule blocks hold the technician: the technician\'s own and everyone\'s, not another technician\'s', async () => {
    dayStops({ [DAY]: [stop('first', '08:00'), stop('later', '13:00', { window_end: '14:00' })] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const block = (technicianId) => ({ id: 'b1', technician_id: technicianId, start_time: '09:00:00', end_time: '12:00:00' });
    const linesWith = async (scheduleBlocks) => {
      const { conn, calls } = fakeConn({ estimates: [estimate('near')], scheduleBlocks });
      const [lines] = (await fillList(conn, [morning], NOW)).byBlock;
      expect(calls).toEqual(expect.arrayContaining([['tech_schedule_blocks', 'where', [{ date: DAY }]],
        ['tech_schedule_blocks', 'whereNot', ['block_type', 'available']]]));
      return lines;
    };
    expect(await linesWith([])).toEqual([expect.objectContaining({ estimateId: 'near', startMin: expect.any(Number) })]);
    expect((await linesWith([]))[0].startMin).toBeLessThan(10 * 60);
    // A 9:00 to noon block holds the van too: it reaches the customer after noon, and the visit runs past the 1:00 PM
    // end of the opening.
    expect(await linesWith([block(TECH)])).toEqual([]);
    expect(await linesWith([block(null)])).toEqual([]);
    expect((await linesWith([block('00000000-0000-4000-8000-000000000002')]))[0].startMin).toBeLessThan(10 * 60);
  });

  test('only on a day the booking page allows a first visit: a seasonal mosquito program in season, a new home from its move-in date', async () => {
    const NOV = '2040-11-13';
    dayStops({ [DAY]: [stop('first', '08:00')], [NOV]: [stop('first-nov', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near')] });
    const blocks = [morning, { ...morning, day: NOV }];
    slots.resolveCatalogSlotProfile.mockResolvedValue({ ...PROFILE, serviceLabel: 'Seasonal Mosquito Control',
      services: [{ service: 'mosquito', label: 'Mosquito', visitsPerYear: 9 }] });
    expect((await fillList(conn, blocks, NOW)).byBlock.map((lines) => lines.length)).toEqual([1, 0]);
    slots.resolveCatalogSlotProfile.mockResolvedValue(PROFILE);
    slots.estimateMoveInDate.mockResolvedValueOnce('2040-09-11');
    expect((await fillList(conn, blocks, NOW)).byBlock.map((lines) => lines.length)).toEqual([0, 1]);
    expect(slots.estimateMoveInDate).toHaveBeenCalledWith(expect.objectContaining({ id: 'near' }));
  });

  test('the server keeps answering while the list is built: the checks yield to the event loop between them', async () => {
    dayStops({ [DAY]: [stop('first', '08:00')] });
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng }, mid: { lat: HQ.lat + 0.05, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near'), estimate('mid')] });
    const events = [];
    analyzeGapCandidate.mockImplementation((...args) => {
      events.push('check');
      return jest.requireActual('../services/scheduling/gap-candidates').analyzeGapCandidate(...args);
    });
    setImmediate(() => events.push('other work'));
    try {
      await fillList(conn, [morning], NOW);
    } finally {
      analyzeGapCandidate.mockImplementation(jest.requireActual('../services/scheduling/gap-candidates').analyzeGapCandidate);
    }
    expect(events).toEqual(['check', 'other work', 'check']);
  });

  test('a failed read of the day throws: the notice says the fill list was not built', async () => {
    dayStopsQuery.mockImplementation(() => ({ whereRaw: async () => { throw new Error('db down'); } }));
    locations({ near: { lat: HQ.lat + 0.01, lng: HQ.lng } });
    const { conn } = fakeConn({ estimates: [estimate('near')] });
    await expect(fillList(conn, [morning], NOW)).rejects.toThrow('db down');
  });
});
