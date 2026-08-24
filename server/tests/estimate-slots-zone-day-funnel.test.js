/**
 * South-zone day funnel (GATE_SOUTH_ZONE_DAY_FUNNEL): estimates resolving to
 * a funneled far-south zone only offer days the calendar already has a live
 * zone stop on ("clustered"); a window with no zone stop offers exactly ONE
 * day ("seeded" — cheapest-detour when route data exists, else soonest) so
 * the first booking creates the cluster. Gate off / other zones → untouched.
 */

// The gate resolves at feature-gates require time — set it before ANY require.
process.env.GATE_SOUTH_ZONE_DAY_FUNNEL = 'true';
// No live geocoding in tests: coords must come from the mocked customer row
// (or resolve to null and exercise the ASAP fallback path).
delete process.env.GOOGLE_MAPS_API_KEY;
delete process.env.GOOGLE_API_KEY;

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/scheduling/find-time', () => ({
  findAvailableSlots: jest.fn(async () => ({ slots: [], evaluated: 0, total_feasible: 0 })),
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { getAvailableSlots } = estimateSlotAvailability;
const {
  applyZoneDayFunnel,
  isFunnelZone,
  _internals: funnelInternals,
} = require('../services/scheduling/zone-day-funnel');

const VENICE_ZONE = { id: 'z-ven', zone_name: 'Venice / North Port', cities: ['Venice', 'Nokomis', 'North Port'] };
const SARASOTA_ZONE = { id: 'z-sar', zone_name: 'Sarasota', cities: ['Sarasota', 'Osprey'] };

const ESTIMATE_ROW = {
  id: 'est-funnel-1',
  status: 'sent',
  expires_at: null,
  customer_id: 'cust-1',
  address: '123 Shamrock Blvd, Venice, FL 34293',
  estimate_data: null,
  service_interest: 'Pest Control',
};

function zoneStopRow(overrides = {}) {
  return {
    technician_id: 'tech-1',
    scheduled_date: '2027-05-20',
    window_start: '08:00:00',
    window_end: '09:00:00',
    estimated_duration_minutes: 60,
    zone: 'venice',
    customer_city: null,
    ...overrides,
  };
}

function scheduledServicesChain(rows) {
  return {
    leftJoin: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(rows),
  };
}

function mockDb({ scheduledRows = [], estimateRow = ESTIMATE_ROW } = {}) {
  db.mockImplementation((table) => {
    if (table === 'estimates') {
      return {
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(estimateRow),
      };
    }
    if (table === 'customers') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          latitude: 27.0998,
          longitude: -82.4543,
          address_line1: '123 Shamrock Blvd',
          city: 'Venice',
          state: 'FL',
          zip: '34293',
        }),
      };
    }
    if (table === 'technicians') {
      return {
        where: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{ id: 'tech-1', name: 'Adam Benetti' }]),
      };
    }
    if (table === 'service_zones') {
      return { select: jest.fn().mockResolvedValue([VENICE_ZONE, SARASOTA_ZONE]) };
    }
    if (table === 'scheduled_services') {
      return scheduledServicesChain(scheduledRows);
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const slot = (date, windowStart = '10:00', techId = 'tech-1') => ({
  slotId: `${date}_${windowStart.replace(':', '-')}_${techId}`,
  date,
  windowStart,
  windowEnd: '11:00',
  durationMinutes: 60,
  techId,
});

describe('applyZoneDayFunnel (pure)', () => {
  const pool = [slot('2027-05-19'), slot('2027-05-20'), slot('2027-05-21'), slot('2027-05-21', '13:00')];

  test('null funnelDays leaves the pool untouched with no funnel metadata', () => {
    const out = applyZoneDayFunnel(pool, null);
    expect(out.slots).toBe(pool);
    expect(out.funnel).toBeNull();
  });

  test('clustered: only zone-stop days survive', () => {
    const out = applyZoneDayFunnel(pool, new Set(['2027-05-21']));
    expect(out.slots.map((s) => s.date)).toEqual(['2027-05-21', '2027-05-21']);
    expect(out.funnel).toEqual({ mode: 'clustered' });
  });

  test('seeded: no zone day in the pool → one preferred (cheapest-detour) day only', () => {
    const out = applyZoneDayFunnel(pool, new Set(), { preferredSeedDates: ['2027-05-21', '2027-05-19'] });
    expect(out.slots.map((s) => s.date)).toEqual(['2027-05-21', '2027-05-21']);
    expect(out.funnel).toEqual({ mode: 'seeded', seedDate: '2027-05-21' });
  });

  test('seeded: preferred date absent from the pool falls back to the soonest day', () => {
    const out = applyZoneDayFunnel(pool, new Set(['2027-06-01']), { preferredSeedDates: ['2027-07-04'] });
    expect(out.slots.map((s) => s.date)).toEqual(['2027-05-19']);
    expect(out.funnel).toEqual({ mode: 'seeded', seedDate: '2027-05-19' });
  });

  test('empty pool passes through untouched', () => {
    const out = applyZoneDayFunnel([], new Set(['2027-05-20']));
    expect(out.slots).toEqual([]);
    expect(out.funnel).toBeNull();
  });
});

describe('isFunnelZone / zone matching', () => {
  test('gate on: the Venice zone funnels, other zones do not', () => {
    expect(isFunnelZone(VENICE_ZONE)).toBe(true);
    expect(isFunnelZone(SARASOTA_ZONE)).toBe(false);
    expect(isFunnelZone(null)).toBe(false);
  });

  test('SOUTH_FUNNEL_ZONE_SLUGS overrides the funneled slug list', () => {
    process.env.SOUTH_FUNNEL_ZONE_SLUGS = 'sarasota';
    try {
      expect(isFunnelZone(SARASOTA_ZONE)).toBe(true);
      expect(isFunnelZone(VENICE_ZONE)).toBe(false);
    } finally {
      delete process.env.SOUTH_FUNNEL_ZONE_SLUGS;
    }
  });

  test('gate off: isFunnelZone is false even for the Venice zone', () => {
    const prev = process.env.GATE_SOUTH_ZONE_DAY_FUNNEL;
    delete process.env.GATE_SOUTH_ZONE_DAY_FUNNEL;
    try {
      let fresh;
      jest.isolateModules(() => {
        fresh = require('../services/scheduling/zone-day-funnel');
      });
      expect(fresh.isFunnelZone(VENICE_ZONE)).toBe(false);
    } finally {
      process.env.GATE_SOUTH_ZONE_DAY_FUNNEL = prev;
    }
  });

  test('zoneStopDates excludes phantom statuses — rescheduled/skipped rows must not mint cluster days', async () => {
    const chain = scheduledServicesChain([zoneStopRow()]);
    const dbc = jest.fn(() => chain);
    const dates = await funnelInternals.zoneStopDates(dbc, VENICE_ZONE, '2027-05-18', '2027-05-22');
    expect(dates).toEqual(new Set(['2027-05-20']));
    // The mock chain can't apply the filter, so pin the query arguments: a
    // 'rescheduled' phantom or 'skipped' visit is not a truck in the zone.
    expect(chain.whereNotIn).toHaveBeenCalledWith(
      'scheduled_services.status',
      ['cancelled', 'rescheduled', 'skipped'],
    );
  });

  test('rowMatchesZone mirrors filterCollidingSlots: slug OR customer city, legacy slugs via city', () => {
    const cities = new Set(['venice', 'nokomis', 'north port']);
    const { rowMatchesZone } = funnelInternals;
    expect(rowMatchesZone({ zone: 'venice', customer_city: null }, VENICE_ZONE, 'venice', cities)).toBe(true);
    // Legacy backfill slug doesn't equal zoneSlugOf output — the city leg catches it.
    expect(rowMatchesZone({ zone: 'venice_north_port', customer_city: 'Nokomis' }, VENICE_ZONE, 'venice', cities)).toBe(true);
    expect(rowMatchesZone({ zone: 'venice_north_port', customer_city: null }, VENICE_ZONE, 'venice', cities)).toBe(false);
    expect(rowMatchesZone({ zone: 'sarasota', customer_city: 'Sarasota' }, VENICE_ZONE, 'venice', cities)).toBe(false);
  });
});

describe('getAvailableSlots — funnel end to end', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findAvailableSlots.mockResolvedValue({ slots: [], evaluated: 0, total_feasible: 0 });
    estimateSlotAvailability._internals.clearCaches();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-14T15:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const WINDOW = { dateFrom: '2027-05-18', dateTo: '2027-05-22' };

  test('clustered: a live Venice stop restricts every offer to that day', async () => {
    mockDb({ scheduledRows: [zoneStopRow()] });
    const result = await getAvailableSlots('est-funnel-1', WINDOW);
    const slots = [...(result.primary || []), ...(result.expander || [])];
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((s) => s.date))).toEqual(new Set(['2027-05-20']));
    expect(result.metadata.zoneDayFunnel).toEqual({ mode: 'clustered' });
    expect(result.metadata.firstDayAvailability?.date).toBe('2027-05-20');
  });

  test('clustered via legacy slug + customer city (no modern zone stamp)', async () => {
    mockDb({ scheduledRows: [zoneStopRow({ zone: 'venice_north_port', customer_city: 'North Port' })] });
    const result = await getAvailableSlots('est-funnel-1', WINDOW);
    const slots = [...(result.primary || []), ...(result.expander || [])];
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((s) => s.date))).toEqual(new Set(['2027-05-20']));
  });

  test('seeded: no Venice stop in the window offers exactly one day, preferring the route-scored day', async () => {
    mockDb({ scheduledRows: [] });
    // find-time's best-scored candidate (cheapest detour) is on 05-21.
    findAvailableSlots.mockResolvedValue({
      slots: [{
        date: '2027-05-21',
        start_time: '09:00',
        technician: { id: 'tech-1', name: 'Adam Benetti' },
        detour_minutes: 4,
        stops_that_day: 2,
      }],
      evaluated: 1,
      total_feasible: 1,
    });
    const result = await getAvailableSlots('est-funnel-1', WINDOW);
    const slots = [...(result.primary || []), ...(result.expander || [])];
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((s) => s.date))).toEqual(new Set(['2027-05-21']));
    expect(result.metadata.zoneDayFunnel).toEqual({ mode: 'seeded', seedDate: '2027-05-21' });
  });

  test('funneled results are never cached: a new zone stop reshapes the very next request', async () => {
    mockDb({ scheduledRows: [] });
    const first = await getAvailableSlots('est-funnel-1', WINDOW);
    expect(first.metadata.zoneDayFunnel?.mode).toBe('seeded');
    // A zone stop lands (any estimate in the zone) — no invalidation hook
    // fires for THIS estimate, so a cached seed would now be wrong.
    mockDb({ scheduledRows: [zoneStopRow()] });
    const second = await getAvailableSlots('est-funnel-1', WINDOW);
    expect(second.metadata.cacheHit).toBe(false);
    expect(second.metadata.zoneDayFunnel).toEqual({ mode: 'clustered' });
    const slots = [...(second.primary || []), ...(second.expander || [])];
    expect(new Set(slots.map((s) => s.date))).toEqual(new Set(['2027-05-20']));
  });

  test('non-funneled zone: a Sarasota estimate keeps its multi-day pool', async () => {
    mockDb({
      scheduledRows: [],
      estimateRow: { ...ESTIMATE_ROW, id: 'est-sar-1', address: '55 Main St, Sarasota, FL 34231' },
    });
    const result = await getAvailableSlots('est-sar-1', WINDOW);
    const slots = [...(result.primary || []), ...(result.expander || [])];
    expect(new Set(slots.map((s) => s.date)).size).toBeGreaterThan(1);
    expect(result.metadata.zoneDayFunnel).toBeUndefined();
  });
});
