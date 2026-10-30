/**
 * GATE_ROUTE_CHECK_STAFF_LISTS (owner 2026-10-29, "Route Check Everywhere"
 * build 1): the staff day lists (SmartRebooker.findRescheduleOptions behind the
 * Reschedule window and the Quick Move day buttons) rank days by the
 * dispatcher's arrival-window route check. Off = today's list.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({ clearTechCurrentJob: jest.fn().mockResolvedValue(null) }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })) }));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/scheduling/blackout-dates', () => ({
  ...jest.requireActual('../services/scheduling/blackout-dates'),
  getBlackoutDates: jest.fn().mockResolvedValue(new Set()),
}));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(),
  _internals: {},
}));

const db = require('../models/db');
const SmartRebooker = require('../services/rebooker');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${etDateString()}T12:00`), n));

const SERVICE = {
  id: 'svc-1', technician_id: 'tech-1', lat: 27.3, lng: -82.5, zip: '34202', city: 'Bradenton',
  scheduled_date: dayOffset(0), service_type: 'Pest Control', window_start: '09:00', window_end: '11:00',
  estimated_duration_minutes: 60, recurring_pattern: null,
};

function qb(table, service) {
  const b = {};
  let counting = false;
  ['where', 'whereIn', 'whereNotIn', 'whereNull', 'leftJoin', 'select', 'orderBy'].forEach((m) => { b[m] = jest.fn(() => b); });
  b.count = jest.fn(() => { counting = true; return b; });
  b.first = jest.fn(async () => (counting ? { count: '2' } : (table === 'scheduled_services' ? service : undefined)));
  b.then = (res, rej) => Promise.resolve([]).then(res, rej);
  return b;
}

function wireDb(service = SERVICE) {
  db.mockImplementation((table) => qb(table, service));
  db.raw = jest.fn(() => 'raw');
}

const slot = (date, start, score, detour = score) => ({
  date, start_time: start, end_time: `${String(Number(start.slice(0, 2)) + 2).padStart(2, '0')}:00`,
  score, detour_minutes: detour, technician: { id: 'tech-1' },
});
const datesOf = (call) => {
  const out = [];
  for (let d = call.dateFrom; d <= call.dateTo; d = etDateString(addETDays(parseETDateTime(`${d}T12:00`), 1))) out.push(d);
  return out;
};

const ENV_KEYS = ['GATE_ROUTE_CHECK_STAFF_LISTS', 'GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_PICKER_ROAD_CHECK', 'GATE_SCHEDULING_CAPACITY'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => { delete process.env[k]; });
  jest.clearAllMocks();
  findConflictingVisits.mockResolvedValue([]);
  getBlackoutDates.mockResolvedValue(new Set());
  wireDb();
});
afterEach(() => {
  ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
});

const gateOn = () => { process.env.GATE_ROUTE_CHECK_STAFF_LISTS = 'true'; process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true'; };
const ADMIN = { isAdmin: true, technicianId: 'staff-9' };

describe('gate off', () => {
  test('the route check is never asked, even with an admin caller', async () => {
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(findAvailableSlots).not.toHaveBeenCalled();
    expect(options).toHaveLength(3);
    expect(Object.keys(options[0]).sort()).toEqual(['currentLoad', 'date', 'dayOfWeek', 'displayDate', 'sameAreaServices', 'score', 'suggestedWindow']);
    expect(options.map((o) => o.score)).toEqual([...options.map((o) => o.score)].sort((a, b) => b - a));
  });

  test('gate on without arrival-window routing is also today\'s list', async () => {
    process.env.GATE_ROUTE_CHECK_STAFF_LISTS = 'true';
    await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(findAvailableSlots).not.toHaveBeenCalled();
  });
});

describe('gate on', () => {
  beforeEach(gateOn);

  test('admin caller: one search, Google through the staff spender and a request budget', async () => {
    process.env.GATE_PICKER_ROAD_CHECK = 'true';
    findAvailableSlots.mockImplementation(async (call) => ({ slots: [slot(datesOf(call)[2], '10:00', 5)], rejections_by_date: {} }));
    await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);
    const call = findAvailableSlots.mock.calls[0][0];
    expect(call).toMatchObject({
      arrivalWindow: { serviceId: 'svc-1', unit: true },
      technicianId: 'tech-1',
      durationMinutes: 120,
      excludeServiceIds: ['svc-1'],
      includeWeekends: true,
      includeBlackoutDates: true,
      pickerRoadCheck: true,
      roadSpender: 'staff-9',
      providerTravel: false,
      lat: 27.3, lng: -82.5,
    });
    expect(call.pickerBudget).toEqual(expect.objectContaining({ traffic: 0, plain: 0 }));
    expect(call.dateFrom).toBe(dayOffset(1));
    expect(call.dateTo).toBe(dayOffset(10));
  });

  test.each([
    ['a technician caller', { isAdmin: false, technicianId: 'tech-1' }],
    ['no caller', undefined],
  ])('%s: estimate only (no pickerRoadCheck, no spender, no budget)', async (_name, caller) => {
    process.env.GATE_PICKER_ROAD_CHECK = 'true';
    findAvailableSlots.mockImplementation(async (call) => ({ slots: [slot(datesOf(call)[0], '10:00', 5)], rejections_by_date: {} }));
    await SmartRebooker.findRescheduleOptions('svc-1', undefined, caller ? { caller } : {});
    const call = findAvailableSlots.mock.calls[0][0];
    expect(call.providerTravel).toBe(false);
    expect(call).not.toHaveProperty('pickerRoadCheck');
    expect(call).not.toHaveProperty('roadSpender');
    expect(call).not.toHaveProperty('pickerBudget');
  });

  test('admin caller with the picker road check off, or no technician id, buys nothing', async () => {
    findAvailableSlots.mockImplementation(async (call) => ({ slots: [slot(datesOf(call)[0], '10:00', 5)], rejections_by_date: {} }));
    await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    process.env.GATE_PICKER_ROAD_CHECK = 'true';
    await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: { isAdmin: true } });
    for (const [call] of findAvailableSlots.mock.calls) {
      expect(call.providerTravel).toBe(false);
      expect(call).not.toHaveProperty('roadSpender');
      expect(call).not.toHaveProperty('pickerBudget');
    }
  });

  test('ranks days by the engine\'s order and offers each at the route-checked start', async () => {
    findAvailableSlots.mockImplementation(async (call) => {
      const d = datesOf(call);
      return {
        slots: [slot(d[5], '13:00', 2, 1.2), slot(d[5], '09:00', 3), slot(d[1], '10:00', 4, 7.6), slot(d[8], '08:00', 9, 20)],
        rejections_by_date: {},
      };
    });
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(options.map((o) => o.date)).toEqual([dayOffset(6), dayOffset(2), dayOffset(9)]);
    expect(options[0].suggestedWindow).toEqual({ start: '13:00', end: '15:00', display: '1:00 PM-3:00 PM' });
    expect(options[0]).toMatchObject({ routeChecked: true, driveMinutes: 1 });
    expect(options[1]).toMatchObject({ routeChecked: true, driveMinutes: 8 });
    // The old fields stay.
    for (const key of ['date', 'dayOfWeek', 'displayDate', 'currentLoad', 'sameAreaServices', 'suggestedWindow', 'score']) {
      expect(options[0]).toHaveProperty(key);
    }
  });

  test('ties on the engine\'s score fall back to the old score (sooner day first)', async () => {
    findAvailableSlots.mockImplementation(async (call) => {
      const d = datesOf(call);
      return { slots: [slot(d[6], '10:00', 5), slot(d[0], '10:00', 5), slot(d[3], '10:00', 5)], rejections_by_date: {} };
    });
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(options).toHaveLength(3);
    expect(options[0].date).toBe(dayOffset(1));
  });

  test('a day with no feasible start is dropped; an unverified day follows the checked days', async () => {
    findAvailableSlots.mockImplementation(async (call) => {
      const d = datesOf(call);
      return {
        slots: [slot(d[4], '10:00', 5)],
        rejections_by_date: { [d[0]]: { route_unverified: 4 }, [d[1]]: { day_overcommitted: 4 }, [d[2]]: { route_unverified: 2, arrival_too_late: 1 } },
      };
    });
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    const dates = options.map((o) => o.date);
    expect(dates[0]).toBe(dayOffset(5));
    expect(options[0].routeChecked).toBe(true);
    expect(dates).not.toContain(dayOffset(2)); // full
    expect(dates).not.toContain(dayOffset(3)); // mixed reasons = certified no
    expect(options.slice(1).every((o) => o.routeChecked === false)).toBe(true);
    expect(options[1].suggestedWindow).toEqual({ start: '09:00', end: '12:00', display: '9:00 AM-12:00 PM' });
    expect(options.length).toBeLessThanOrEqual(3);
  });

  test('keeps every eligibility filter: a blackout day is neither searched nor offered', async () => {
    getBlackoutDates.mockResolvedValue(new Set([dayOffset(1), dayOffset(10)]));
    findAvailableSlots.mockImplementation(async (call) => ({
      slots: [slot(dayOffset(1), '10:00', 1), slot(dayOffset(4), '10:00', 6)], rejections_by_date: {},
    }));
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    const call = findAvailableSlots.mock.calls[0][0];
    expect(call.dateFrom).toBe(dayOffset(2));
    expect(call.dateTo).toBe(dayOffset(9));
    expect(options.map((o) => o.date)).not.toContain(dayOffset(1));
    expect(options[0].date).toBe(dayOffset(4));
  });

  test('keeps the season filter for reason flows (Feb-Oct visit never offered Nov-Jan)', async () => {
    wireDb({ ...SERVICE, recurring_pattern: 'seasonal_feb_oct' });
    const month = (n) => Number(dayOffset(n).slice(5, 7));
    findAvailableSlots.mockImplementation(async (call) => ({ slots: datesOf(call).map((d, i) => slot(d, '10:00', i + 1)), rejections_by_date: {} }));
    const options = await SmartRebooker.findRescheduleOptions('svc-1', 'weather_rain', { caller: ADMIN });
    for (const o of options) {
      const m = Number(o.date.slice(5, 7));
      expect(m >= 2 && m <= 10).toBe(true);
    }
    expect(month(1)).toBeGreaterThan(0);
  });

  test('the overlap probe still vetoes the chosen start; the next start on that day is tried', async () => {
    findAvailableSlots.mockImplementation(async (call) => {
      const d = datesOf(call);
      return { slots: [slot(d[1], '09:00', 1), slot(d[1], '11:00', 2), slot(d[2], '10:00', 3)], rejections_by_date: {} };
    });
    findConflictingVisits.mockImplementation(async ({ date, windowStart }) => (date === dayOffset(2) && windowStart === '09:00' ? [{ id: 'x' }] : []));
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(options[0]).toMatchObject({ date: dayOffset(2) });
    expect(options[0].suggestedWindow.start).toBe('11:00');
  });

  test('rain-out span: the probe and the search use probeSpanMinutes and the windows are that long', async () => {
    findAvailableSlots.mockImplementation(async (call) => ({ slots: [{ ...slot(datesOf(call)[0], '10:00', 1), end_time: '11:00' }], rejections_by_date: {} }));
    const options = await SmartRebooker.findRescheduleOptions('svc-1', 'weather_rain', { probeSpanMinutes: 60, travelGap: true, caller: undefined });
    expect(findAvailableSlots.mock.calls[0][0].durationMinutes).toBe(60);
    expect(options[0].suggestedWindow).toEqual({ start: '10:00', end: '11:00', display: '10:00 AM-11:00 AM' });
    expect(findConflictingVisits.mock.calls[0][0]).toMatchObject({ travel: { lat: 27.3, lng: -82.5 } });
  });

  test('every day unverified: today\'s list, unchanged', async () => {
    const legacy = await (async () => {
      delete process.env.GATE_ROUTE_CHECK_STAFF_LISTS;
      const list = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
      gateOn();
      return list;
    })();
    findAvailableSlots.mockImplementation(async (call) => ({
      slots: [], rejections_by_date: Object.fromEntries(datesOf(call).map((d) => [d, { route_unverified: 5 }])),
    }));
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);
    expect(options).toEqual(legacy);
  });

  test.each([
    ['throws', () => { throw new Error('boom'); }],
    ['returns an error', async () => ({ error: 'lat/lng required', slots: [] })],
  ])('a search that %s: today\'s list, unchanged', async (_name, impl) => {
    delete process.env.GATE_ROUTE_CHECK_STAFF_LISTS;
    const legacy = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    gateOn();
    findAvailableSlots.mockImplementation(impl);
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);
    expect(options).toEqual(legacy);
  });

  test('a visit with no technician or no coordinates keeps today\'s list without a search', async () => {
    wireDb({ ...SERVICE, technician_id: null });
    await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    wireDb({ ...SERVICE, lat: null, lng: null });
    await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(findAvailableSlots).not.toHaveBeenCalled();
  });

  test('count and shape: at most three options, each with the old fields', async () => {
    findAvailableSlots.mockImplementation(async (call) => ({ slots: datesOf(call).map((d, i) => slot(d, '10:00', i + 1)), rejections_by_date: {} }));
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.date)).toEqual([dayOffset(1), dayOffset(2), dayOffset(3)]);
    for (const o of options) {
      expect(Object.keys(o).sort()).toEqual(['currentLoad', 'date', 'dayOfWeek', 'displayDate', 'driveMinutes', 'routeChecked', 'sameAreaServices', 'score', 'suggestedWindow']);
    }
  });

  // GATE_ROUTE_CHECK_LATE_DAYS (fix A): a day whose existing stops already arrive late is listed, flagged.
  test('an already-late day is a checked day: kept, flagged dayAlreadyLate, and ranked after every day that is not', async () => {
    findAvailableSlots.mockImplementation(async (call) => {
      const d = datesOf(call);
      return {
        // The late day has the engine's best score; the three clean days follow.
        slots: [{ ...slot(d[0], '15:00', 1), day_already_late: true }, slot(d[1], '10:00', 5), slot(d[2], '10:00', 6), slot(d[3], '10:00', 7)],
        rejections_by_date: {},
      };
    });
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(options.map((o) => o.date)).toEqual([dayOffset(2), dayOffset(3), dayOffset(4)]);
    expect(options.some((o) => 'dayAlreadyLate' in o)).toBe(false);
  });

  test('with fewer than three clean days the already-late day still appears, flagged, at its checked start', async () => {
    findAvailableSlots.mockImplementation(async (call) => {
      const d = datesOf(call);
      return { slots: [{ ...slot(d[0], '15:00', 1), day_already_late: true }, slot(d[1], '10:00', 5)], rejections_by_date: {} };
    });
    const options = await SmartRebooker.findRescheduleOptions('svc-1', undefined, { caller: ADMIN });
    expect(options.slice(0, 2).map((o) => o.date)).toEqual([dayOffset(2), dayOffset(1)]);
    expect(options[1]).toMatchObject({ routeChecked: true, dayAlreadyLate: true });
    expect(options[1].suggestedWindow.start).toBe('15:00');
  });
});
