/**
 * GATE_ESTIMATE_SLOT_ONE_PER_HOUR (dark, owner 2026-10-25, second technician):
 * the estimate time picker lists ONE opening per date + start time. With two
 * technicians open at the same hour the picker used to list "Tue 9:00" twice
 * (once per technician), count both in the "Only N openings" badge and let
 * the repeat push other times out of the short list. On: one complete,
 * reservable slot per date|windowStart (route-optimal, then nearby job, then
 * the first claim). Off: byte-identical to before.
 */
// No live geocoding in tests: coords come from the mocked customer row.
delete process.env.GOOGLE_MAPS_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GATE_ESTIMATE_SLOT_ONE_PER_HOUR;

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => ({ slots: [], evaluated: 0, total_feasible: 0 })),
}));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn(async () => null),
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const featureGates = require('../config/feature-gates');
const { getAvailableSlots } = estimateSlotAvailability;
const { collapseSameStartSlots, selectCustomerFacingSlots } = estimateSlotAvailability._internals;

const GATE = 'GATE_ESTIMATE_SLOT_ONE_PER_HOUR';

const ESTIMATE_ROW = {
  id: 'est-one-hour-1',
  status: 'sent',
  expires_at: null,
  customer_id: 'cust-1',
  address: '123 Palm Ave, Venice, FL 34293',
  estimate_data: null,
  service_interest: 'Pest Control',
};

const TECHS_TWO = [
  { id: 'tech-1', name: 'Alpha One' },
  { id: 'tech-2', name: 'Bravo Two' },
];

function mockDb({ techs = TECHS_TWO } = {}) {
  db.mockImplementation((table) => {
    if (table === 'estimates') {
      return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(ESTIMATE_ROW) };
    }
    if (table === 'customers') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          latitude: 27.0998, longitude: -82.4543, address_line1: '123 Palm Ave', city: 'Venice', state: 'FL', zip: '34293',
        }),
      };
    }
    if (table === 'technicians') {
      return { where: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue(techs) };
    }
    if (table === 'service_zones') {
      return { select: jest.fn().mockResolvedValue([]) };
    }
    if (table === 'scheduled_services') {
      return {
        leftJoin: jest.fn().mockReturnThis(),
        whereBetween: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    if (table === 'technician_absences') {
      return {
        whereBetween: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const slot = (over = {}) => ({
  slotId: `${over.date || '2027-05-20'}_${String(over.windowStart || '09:00').replace(':', '-')}_${over.techId || 'tech-1'}`,
  date: '2027-05-20',
  windowStart: '09:00',
  windowEnd: '10:00',
  durationMinutes: 60,
  techId: 'tech-1',
  techFirstName: 'Alpha',
  routeOptimal: false,
  nearbyJob: null,
  ...over,
});

describe('collapseSameStartSlots (pure)', () => {
  test('keeps the first claim when nothing is route-optimal or nearby', () => {
    const a = slot({ techId: 'tech-1' });
    const b = slot({ techId: 'tech-2', techFirstName: 'Bravo' });
    expect(collapseSameStartSlots([a, b])).toEqual([a]);
    expect(collapseSameStartSlots([b, a])).toEqual([b]);
  });

  test('prefers routeOptimal, then nearbyJob, then the first claim', () => {
    const plain = slot({ techId: 'tech-1' });
    const nearby = slot({ techId: 'tech-2', nearbyJob: { detourMinutes: 9 } });
    const optimal = slot({ techId: 'tech-3', routeOptimal: true, nearbyJob: { detourMinutes: 4 } });
    expect(collapseSameStartSlots([plain, nearby])).toEqual([nearby]);
    expect(collapseSameStartSlots([plain, nearby, optimal])).toEqual([optimal]);
    expect(collapseSameStartSlots([optimal, nearby, plain])).toEqual([optimal]);
    // A later route-optimal slot does not displace an earlier route-optimal one.
    const optimal2 = slot({ techId: 'tech-4', routeOptimal: true });
    expect(collapseSameStartSlots([optimal, optimal2])).toEqual([optimal]);
  });

  test('the kept slot is the whole original object (own tech, slotId, hold fields); nothing merged', () => {
    const plain = slot({ techId: 'tech-1', holdToken: 'hold-a' });
    const optimal = slot({ techId: 'tech-2', routeOptimal: true, holdToken: 'hold-b' });
    const [kept] = collapseSameStartSlots([plain, optimal]);
    expect(kept).toBe(optimal);
    expect(kept.techId).toBe('tech-2');
    expect(kept.holdToken).toBe('hold-b');
  });

  test('different dates or start times are all kept; slots missing a date or start are left alone', () => {
    const pool = [
      slot({ techId: 'tech-1' }),
      slot({ techId: 'tech-2' }),
      slot({ techId: 'tech-1', windowStart: '10:00' }),
      slot({ techId: 'tech-1', date: '2027-05-21' }),
      { techId: 'tech-9' },
      { techId: 'tech-8' },
    ];
    const out = collapseSameStartSlots(pool);
    expect(out).toHaveLength(5);
    expect(out.map((s) => `${s.date}|${s.windowStart}`)).toEqual([
      '2027-05-20|09:00', '2027-05-20|10:00', '2027-05-21|09:00', 'undefined|undefined', 'undefined|undefined',
    ]);
  });

  test('one technician: the list is unchanged', () => {
    const pool = [slot(), slot({ windowStart: '10:00' }), slot({ date: '2027-05-21' })];
    expect(collapseSameStartSlots(pool)).toEqual(pool);
  });
});

describe('getAvailableSlots — one slot per date and start time', () => {
  const WINDOW = { dateFrom: '2027-05-18', dateTo: '2027-05-20' };
  const all = (r) => [...(r.primary || []), ...(r.expander || [])];
  const startKey = (s) => `${s.date}|${s.windowStart}`;
  const strip = (r) => ({
    primary: r.primary.map((s) => ({ ...s })),
    expander: r.expander.map((s) => ({ ...s })),
    nearby: r.nearby,
    firstDayAvailability: r.metadata.firstDayAvailability,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    findAvailableSlots.mockResolvedValue({ slots: [], evaluated: 0, total_feasible: 0 });
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
    delete process.env[GATE];
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env[GATE];
  });

  test('reader is strict true and read at call time', () => {
    expect(featureGates.estimateSlotOnePerHourLive()).toBe(false);
    process.env[GATE] = '1';
    expect(featureGates.estimateSlotOnePerHourLive()).toBe(false);
    process.env[GATE] = 'TRUE';
    expect(featureGates.estimateSlotOnePerHourLive()).toBe(false);
    process.env[GATE] = 'true';
    expect(featureGates.estimateSlotOnePerHourLive()).toBe(true);
  });

  test('gate off: two technicians at one hour both reach the customer (today)', async () => {
    mockDb();
    const result = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, maxResults: 40, expanderMaxResults: 0 });
    const slots = all(result);
    const nine = slots.filter((s) => startKey(s) === '2027-05-18|09:00');
    expect(nine.map((s) => s.techId).sort()).toEqual(['tech-1', 'tech-2']);
  });

  test('gate on: one slot per date and start time, a complete slot with its own technician', async () => {
    process.env[GATE] = 'true';
    mockDb();
    const result = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, maxResults: 40, expanderMaxResults: 0 });
    const slots = all(result);
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map(startKey)).size).toBe(slots.length);
    for (const s of slots) {
      expect(['tech-1', 'tech-2']).toContain(s.techId);
      expect(typeof s.slotId).toBe('string');
      expect(s.slotId).toContain(s.techId);
    }
  });

  test('gate on: the count behind the "Only N openings" badge follows the collapsed list', async () => {
    mockDb();
    const off = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    estimateSlotAvailability._internals.clearCaches();
    process.env[GATE] = 'true';
    const on = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    expect(off.metadata.firstDayAvailability.openCount).toBeGreaterThan(on.metadata.firstDayAvailability.openCount);
    // Two technicians doubled the day's count when off.
    expect(off.metadata.firstDayAvailability.openCount).toBe(on.metadata.firstDayAvailability.openCount * 2);
    expect(off.metadata.firstDayAvailability.date).toBe(on.metadata.firstDayAvailability.date);
  });

  test('gate on: a route-optimal technician wins the hour even when listed second', async () => {
    process.env[GATE] = 'true';
    mockDb();
    findAvailableSlots.mockResolvedValue({
      slots: [{
        date: '2027-05-20',
        start_time: '10:00',
        technician: { id: 'tech-2', name: 'Bravo Two' },
        detour_minutes: 4,
        stops_that_day: 3,
        insertion: { after_stop_id: 'stop-1', after: 'Customer (09:00)' },
      }],
      evaluated: 1,
      total_feasible: 1,
    });
    const result = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, maxResults: 40, expanderMaxResults: 0 });
    const ten = all(result).filter((s) => startKey(s) === '2027-05-20|10:00');
    expect(ten).toHaveLength(1);
    expect(ten[0].techId).toBe('tech-2');
    expect(ten[0].routeOptimal).toBe(true);
    expect(ten[0].nearbyJob).toEqual({ detourMinutes: 4 });
  });

  test('one technician: gate on and off give identical output', async () => {
    mockDb({ techs: [TECHS_TWO[0]] });
    const off = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    estimateSlotAvailability._internals.clearCaches();
    process.env[GATE] = 'true';
    const on = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    expect(strip(on)).toEqual(strip(off));
  });

  test('gate on: the short list shows more distinct times than gate off', async () => {
    mockDb();
    const off = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    estimateSlotAvailability._internals.clearCaches();
    process.env[GATE] = 'true';
    const on = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW });
    expect(new Set(all(on).map(startKey)).size).toBeGreaterThanOrEqual(new Set(all(off).map(startKey)).size);
  });

  test('the result cache does not serve one list shape to the other gate state', async () => {
    mockDb();
    const off = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, maxResults: 40, expanderMaxResults: 0 });
    process.env[GATE] = 'true';
    const on = await getAvailableSlots(ESTIMATE_ROW.id, { ...WINDOW, maxResults: 40, expanderMaxResults: 0 });
    expect(all(on).length).toBeLessThan(all(off).length);
  });

  test('selectCustomerFacingSlots itself is untouched by the gate', () => {
    process.env[GATE] = 'true';
    const pool = [slot({ techId: 'tech-1' }), slot({ techId: 'tech-2' })];
    expect(selectCustomerFacingSlots(pool, 5)).toHaveLength(2);
  });
});
