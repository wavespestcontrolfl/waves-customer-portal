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
  getZoneFunnelDays,
  onZoneDay,
  dropOtherTruckDays,
  perTruckLive,
  offerFunnelView,
  funnelOfferPool,
  truckMayTakeDate,
  funnelZoneRows,
  rowInFunnelZones,
  isFunnelZone,
  fallbackCenterZoneName,
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

// `realStopDates`: the chain also answers estimate-slot-availability's stopDatesInRange read (the packing rule: a stop
// day keeps only route openings, no synthetic hours) from `rows`, as Postgres would: per truck one
// {scheduled_date, technician_id} row per timed stop, else the distinct dates. Without it that read throws here and
// fails open (no day packed).
function scheduledServicesChain(rows, { realStopDates = false } = {}) {
  const chain = {
    leftJoin: jest.fn().mockReturnThis(),
    whereBetween: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(rows),
  };
  if (realStopDates) {
    const timed = rows.filter((r) => r.window_start != null);
    Object.assign(chain, {
      whereNotNull: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      distinct: jest.fn(() => {
        const perTruck = timed.map((r) => ({ scheduled_date: r.scheduled_date, technician_id: r.technician_id ?? null }));
        return {
          then: (ok, err) => Promise.resolve(perTruck).then(ok, err),
          pluck: jest.fn().mockResolvedValue([...new Set(timed.map((r) => r.scheduled_date))]),
        };
      }),
    });
  }
  return chain;
}

function mockDb({ scheduledRows = [], estimateRow = ESTIMATE_ROW, failFirstScheduledCall = false, techs = [{ id: 'tech-1', name: 'Adam Benetti' }], coords = true, realStopDates = false, zones = [VENICE_ZONE, SARASOTA_ZONE] } = {}) {
  let scheduledCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'scheduled_services' && failFirstScheduledCall && scheduledCalls++ === 0) {
      // First scheduled_services query per request is the funnel's zone-stop
      // lookup — simulate a transient failure there only, so the later
      // collision queries still succeed and the request completes.
      const failing = scheduledServicesChain([]);
      failing.select.mockRejectedValue(new Error('transient outage'));
      return failing;
    }
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
          latitude: coords ? 27.0998 : null,
          longitude: coords ? -82.4543 : null,
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
        select: jest.fn().mockResolvedValue(techs),
      };
    }
    if (table === 'service_zones') {
      return { select: jest.fn().mockResolvedValue(zones) };
    }
    if (table === 'scheduled_services') {
      return scheduledServicesChain(scheduledRows, { realStopDates });
    }
    if (table === 'technician_absences') {
      // buildAsapCapacitySlots' absentTechDays read (technician-eligibility.js)
      // — no tech is marked out in this suite.
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

// Per truck (GATE_MULTI_TECH_CONFIRM, owner 2026-11-19 "build south"; the night run reads it): a zone day belongs to
// the technician whose stop it is. An unassigned zone stop counts for every technician; no technician counts any stop.
describe('per truck: onZoneDay', () => {
  const DAYS = new Set(['2027-05-20', '2027-05-21']);
  const TECH_DAYS = new Map([['2027-05-20', new Set(['tech-2'])], ['2027-05-21', new Set([null])]]);

  test('a zone day is its stop technician\'s; an unassigned stop or a slot with no technician counts any truck', () => {
    expect(onZoneDay('2027-05-20', 'tech-2', DAYS, TECH_DAYS)).toBe(true);
    expect(onZoneDay('2027-05-20', 'tech-1', DAYS, TECH_DAYS)).toBe(false);
    expect(onZoneDay('2027-05-21', 'tech-1', DAYS, TECH_DAYS)).toBe(true);
    expect(onZoneDay('2027-05-20', null, DAYS, TECH_DAYS)).toBe(true);
    expect(onZoneDay('2027-05-19', 'tech-2', DAYS, TECH_DAYS)).toBe(false);
    // Fleet-wide (techDays null, the gate off): any zone stop that day, whoever drives it.
    expect(onZoneDay('2027-05-20', 'tech-1', DAYS, null)).toBe(true);
  });
});

// Owner rule B (2026-11-19, "Only the truck that is already going south that day"): the booking pages drop each
// opening of a truck on another truck's zone day before they choose among trucks.
describe('per truck: dropOtherTruckDays', () => {
  const DAYS = new Set(['2027-05-20', '2027-05-21']);
  const TECH_DAYS = new Map([['2027-05-20', new Set(['tech-2'])], ['2027-05-21', new Set([null])]]);
  const techOf = (s) => s.techId;
  const pool = [
    slot('2027-05-19', '10:00', 'tech-1'), slot('2027-05-19', '10:00', 'tech-2'),
    slot('2027-05-20', '10:00', 'tech-1'), slot('2027-05-20', '10:00', 'tech-2'), slot('2027-05-20', '11:00', null),
    slot('2027-05-21', '10:00', 'tech-1'), slot('2027-05-21', '10:00', 'tech-2'),
  ];

  test('a zone day keeps its own truck only; a day with no zone stop, an unassigned stop\'s day and a slot with no technician keep every truck', () => {
    const kept = dropOtherTruckDays(pool, { days: DAYS, techDays: TECH_DAYS }, techOf);
    expect(kept.map((s) => s.slotId)).toEqual(pool.filter((s) => s !== pool[2]).map((s) => s.slotId));
  });

  test('fleet-wide (techDays null), no funnel (days null) or no view: the very same array', () => {
    expect(dropOtherTruckDays(pool, { days: DAYS, techDays: null }, techOf)).toBe(pool);
    expect(dropOtherTruckDays(pool, { days: null, techDays: TECH_DAYS }, techOf)).toBe(pool);
    expect(dropOtherTruckDays(pool, {}, techOf)).toBe(pool);
  });
});

describe('fallbackCenterZoneName (deep-south coordinate-fallback alias)', () => {
  test('deep-south cities alias to the retained Port Charlotte row, case/whitespace-insensitive', () => {
    for (const city of ['Port Charlotte', 'punta gorda', '  MURDOCK ', 'Rotonda West', 'Placida', 'Boca Grande']) {
      expect(fallbackCenterZoneName(city)).toBe('port charlotte');
    }
  });

  test('Venice-proper and mid-corridor cities stay on the normal cities scan', () => {
    for (const city of ['Venice', 'North Port', 'Nokomis', 'Osprey', 'Englewood', 'Sarasota', 'nowhere', '', null, undefined]) {
      expect(fallbackCenterZoneName(city)).toBeNull();
    }
  });
});

describe('isFunnelZone / zone matching', () => {
  test('gate on: the Venice zone funnels, other zones do not', () => {
    expect(isFunnelZone(VENICE_ZONE)).toBe(true);
    expect(isFunnelZone(SARASOTA_ZONE)).toBe(false);
    expect(isFunnelZone(null)).toBe(false);
    // The seeded Port Charlotte zone row funnels by default too — an
    // estimate resolving to it must not fall outside the south rollout.
    expect(isFunnelZone({ id: 'z-pc', zone_name: 'Port Charlotte', cities: ['Port Charlotte'] })).toBe(true);
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

  test('zoneStopDays excludes phantom statuses — the shared route-stop classifier, incl. no_show', async () => {
    const chain = scheduledServicesChain([zoneStopRow()]);
    const dbc = jest.fn(() => chain);
    const { dates } = await funnelInternals.zoneStopDays(dbc, VENICE_ZONE, '2027-05-18', '2027-05-22');
    expect(dates).toEqual(new Set(['2027-05-20']));
    // The mock chain can't apply the filter, so pin the query arguments to
    // stops-ahead's NOT_A_ROUTE_STOP_STATUSES: a cancelled/rescheduled/
    // skipped phantom or a no_show is not a truck in the zone, so a
    // no-show-only day must not become a cluster day.
    const { NOT_A_ROUTE_STOP_STATUSES } = require('../services/stops-ahead');
    expect(NOT_A_ROUTE_STOP_STATUSES).toEqual(expect.arrayContaining(['cancelled', 'rescheduled', 'skipped', 'no_show']));
    expect(chain.whereNotIn).toHaveBeenCalledWith(
      'scheduled_services.status',
      NOT_A_ROUTE_STOP_STATUSES,
    );
  });

  test('zoneStopDays: each zone day names the technicians of its stops, null for an unassigned stop', async () => {
    const rows = [
      zoneStopRow(),
      zoneStopRow({ technician_id: null }),
      zoneStopRow({ scheduled_date: '2027-05-21', technician_id: 'tech-2' }),
      zoneStopRow({ zone: 'parrish', technician_id: 'tech-3' }),
    ];
    const dbc = jest.fn(() => scheduledServicesChain(rows));
    const { dates, techs } = await funnelInternals.zoneStopDays(dbc, VENICE_ZONE, '2027-05-18', '2027-05-22');
    expect(dates).toEqual(new Set(['2027-05-20', '2027-05-21']));
    expect(techs).toEqual(new Map([['2027-05-20', new Set(['tech-1', null])], ['2027-05-21', new Set(['tech-2'])]]));
  });

  test('getZoneFunnelDays: the per-truck view only with GATE_MULTI_TECH_CONFIRM on, read at call time', async () => {
    const prev = process.env.GATE_MULTI_TECH_CONFIRM;
    const dbc = jest.fn(() => scheduledServicesChain([zoneStopRow()]));
    const read = () => getZoneFunnelDays(dbc, { estimateZone: VENICE_ZONE, dateFrom: '2027-05-18', dateTo: '2027-05-22' });
    try {
      delete process.env.GATE_MULTI_TECH_CONFIRM;
      expect(await read()).toEqual({ days: new Set(['2027-05-20']), techDays: null, failed: false });
      process.env.GATE_MULTI_TECH_CONFIRM = 'true';
      expect(await read()).toEqual({
        days: new Set(['2027-05-20']), techDays: new Map([['2027-05-20', new Set(['tech-1'])]]), failed: false,
      });
    } finally {
      if (prev === undefined) delete process.env.GATE_MULTI_TECH_CONFIRM; else process.env.GATE_MULTI_TECH_CONFIRM = prev;
    }
  });

  test('a tech-scope read that throws (a partial occupancy or feature-gates mock) reads as off: never a failed lookup', async () => {
    const occupancy = require('../services/scheduling/occupancy');
    const spy = jest.spyOn(occupancy, 'techScopedConfirmActive').mockImplementation(() => {
      throw new TypeError('multiTechConfirmLive is not a function');
    });
    try {
      const dbc = jest.fn(() => scheduledServicesChain([zoneStopRow()]));
      expect(perTruckLive()).toBe(false);
      expect(await getZoneFunnelDays(dbc, { estimateZone: VENICE_ZONE, dateFrom: '2027-05-18', dateTo: '2027-05-22' }))
        .toEqual({ days: new Set(['2027-05-20']), techDays: null, failed: false });
    } finally {
      spy.mockRestore();
    }
  });

  test('rowMatchesZone: zone stamp authoritative (legacy slugs by prefix), city decides unstamped rows only', () => {
    const cities = new Set(['venice', 'nokomis', 'north port']);
    const { rowMatchesZone } = funnelInternals;
    expect(rowMatchesZone({ zone: 'venice', customer_city: null }, VENICE_ZONE, 'venice', cities)).toBe(true);
    // Legacy backfill slug is an underscore compound of the modern slug.
    expect(rowMatchesZone({ zone: 'venice_north_port', customer_city: null }, VENICE_ZONE, 'venice', cities)).toBe(true);
    // Unstamped row: linked-customer city decides.
    expect(rowMatchesZone({ zone: null, customer_city: 'Nokomis' }, VENICE_ZONE, 'venice', cities)).toBe(true);
    expect(rowMatchesZone({ zone: '', customer_city: 'Bradenton' }, VENICE_ZONE, 'venice', cities)).toBe(false);
    // A stop stamped for ANOTHER zone must not become a Venice stop just
    // because the multi-property customer's primary city is Venice.
    expect(rowMatchesZone({ zone: 'sarasota', customer_city: 'Venice' }, VENICE_ZONE, 'venice', cities)).toBe(false);
    // 'lakewood_ranch' is admin-schedule getZone()'s fallthrough default —
    // NOT authoritative against a city match: a historical Port Charlotte
    // appointment mis-stamped with it must still count via its city, while
    // a genuine Lakewood Ranch row stays excluded through the city leg.
    const southCities = new Set([...cities, 'port charlotte', 'punta gorda', 'englewood']);
    expect(rowMatchesZone({ zone: 'lakewood_ranch', customer_city: 'Port Charlotte' }, VENICE_ZONE, 'venice', southCities)).toBe(true);
    expect(rowMatchesZone({ zone: 'lakewood_ranch', service_city: 'Punta Gorda', customer_city: 'Lakewood Ranch' }, VENICE_ZONE, 'venice', southCities)).toBe(true);
    expect(rowMatchesZone({ zone: 'lakewood_ranch', customer_city: 'Lakewood Ranch' }, VENICE_ZONE, 'venice', southCities)).toBe(false);
    // Merged-zone alias: rows stamped 'port charlotte' while that zone was
    // live are cluster evidence for the consolidated south pool — both
    // slugs are in the funnel list, so they name the same pool, both ways.
    expect(rowMatchesZone({ zone: 'port charlotte', customer_city: null }, VENICE_ZONE, 'venice', southCities)).toBe(true);
    expect(rowMatchesZone({ zone: 'venice_north_port', customer_city: null }, VENICE_ZONE, 'port charlotte', southCities)).toBe(true);
    // A non-funneled stamp never rides the alias.
    expect(rowMatchesZone({ zone: 'sarasota', customer_city: null }, VENICE_ZONE, 'port charlotte', southCities)).toBe(false);
    // Unstamped multi-property call booking: the visit's service city
    // outranks the customer's primary city, both ways.
    expect(rowMatchesZone({ zone: null, service_city: 'Venice', customer_city: 'Sarasota' }, VENICE_ZONE, 'venice', cities)).toBe(true);
    expect(rowMatchesZone({ zone: null, service_city: 'Sarasota', customer_city: 'Venice' }, VENICE_ZONE, 'venice', cities)).toBe(false);
    expect(rowMatchesZone({ zone: null, service_city: null, customer_city: 'Venice' }, VENICE_ZONE, 'venice', cities)).toBe(true);
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

  const withGates = async (gates, fn) => {
    const prev = Object.fromEntries(Object.keys(gates).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(gates)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
  const offered = (result) => [...(result.primary || []), ...(result.expander || [])];

  const TWO_TRUCKS = [{ id: 'tech-1', name: 'Adam Benetti' }, { id: 'tech-2', name: 'Second Tech' }];
  // find-time route openings at 10:00: [date, technician, detour minutes].
  const routeOpenings = (list) => ({
    slots: list.map(([date, techId, detour]) => ({
      date, start_time: '10:00', end_time: '11:00', technician: { id: techId, name: techId === 'tech-1' ? 'Adam Benetti' : 'Second Tech' },
      detour_minutes: detour, stops_that_day: 1,
    })),
    evaluated: list.length,
    total_feasible: list.length,
  });

  // Owner rule B (GATE_MULTI_TECH_CONFIRM on): tech-2 drives south on 05-20 with no open time there (the packing rule
  // keeps a stop day's route openings only, and find-time found none for tech-2), so tech-1's route opening on 05-20
  // is not offered: the page opens one new day instead. Off: the fleet's zone day, as before.
  test.each([[undefined, 'clustered'], ['true', 'seeded']])('another technician\'s Venice stop, GATE_MULTI_TECH_CONFIRM=%s: %s', async (gate, mode) => {
    await withGates({ GATE_MULTI_TECH_CONFIRM: gate }, async () => {
      mockDb({ realStopDates: true, scheduledRows: [zoneStopRow({ technician_id: 'tech-2' })], techs: TWO_TRUCKS });
      findAvailableSlots.mockResolvedValue(routeOpenings([['2027-05-20', 'tech-1', 3], ['2027-05-21', 'tech-1', 3]]));
      const result = await getAvailableSlots('est-funnel-1', WINDOW);
      const dates = new Set(offered(result).map((s) => s.date));
      expect(dates.size).toBe(1);
      expect(result.metadata.zoneDayFunnel.mode).toBe(mode);
      expect(dates.has('2027-05-20')).toBe(mode === 'clustered');
    });
  });

  // Both trucks open at 10:00 on the zone day; the one-per-hour collapse keeps one slot per start (the closer route
  // first: tech-1's). Per truck the filter runs before the collapse, so the zone day's 10:00 is tech-2's, never lost
  // to tech-1's slot.
  test.each([[undefined, 'tech-1'], ['true', 'tech-2']])('two trucks with GATE_ESTIMATE_SLOT_ONE_PER_HOUR on, GATE_MULTI_TECH_CONFIRM=%s: the zone day\'s 10:00 is %s\'s', async (gate, techId) => {
    await withGates({ GATE_MULTI_TECH_CONFIRM: gate, GATE_ESTIMATE_SLOT_ONE_PER_HOUR: 'true' }, async () => {
      mockDb({ realStopDates: true, scheduledRows: [zoneStopRow({ technician_id: 'tech-2' })], techs: TWO_TRUCKS });
      findAvailableSlots.mockResolvedValue(routeOpenings([['2027-05-20', 'tech-1', 3], ['2027-05-20', 'tech-2', 40]]));
      const result = await getAvailableSlots('est-funnel-1', WINDOW);
      expect(result.metadata.zoneDayFunnel).toEqual({ mode: 'clustered' });
      expect(offered(result).map((s) => [s.date, s.windowStart, s.techId])).toEqual([['2027-05-20', '10:00', techId]]);
    });
  });

  // GATE_BOOKING_MAKE_ROOM: the make-room check gets the same rule (makeRoomAdmit with the per-truck days).
  test('per truck, the make-room check admits the zone day for its own truck only', async () => {
    const makeRoom = require('../services/scheduling/booking-make-room');
    const mode = jest.spyOn(makeRoom, 'bookingMakeRoomMode').mockReturnValue('shadow');
    const check = jest.spyOn(makeRoom, 'startBackgroundCheck').mockResolvedValue({});
    try {
      await withGates({ GATE_MULTI_TECH_CONFIRM: 'true' }, async () => {
        mockDb({
          scheduledRows: [zoneStopRow({ technician_id: 'tech-2' })],
          techs: [{ id: 'tech-1', name: 'Adam Benetti' }, { id: 'tech-2', name: 'Second Tech' }],
        });
        await getAvailableSlots('est-funnel-1', { ...WINDOW, offer: true });
      });
      expect(check).toHaveBeenCalledTimes(1);
      const [{ admit }] = check.mock.calls[0];
      const hour = (techId) => ({ date: '2027-05-20', windowStart: '10:00', windowEnd: '11:00', durationMinutes: 60, techId });
      expect(admit(hour('tech-2'))).toBe(true);
      expect(admit(hour('tech-1'))).toBe(false);
    } finally {
      mode.mockRestore();
      check.mockRestore();
    }
  });

  // No coordinates (the ASAP-only path, synthetic hours only): the packing rule drops a stop day's hours for the stop's
  // truck (per truck) or the fleet (off), and per truck the filter drops the other truck's hours on the zone day
  // before the funnel. Either way the zone day is not offered and one new day opens.
  test.each([undefined, 'true'])('no coordinates, two trucks, GATE_MULTI_TECH_CONFIRM=%s: one new day, never the zone day', async (gate) => {
    await withGates({ GATE_MULTI_TECH_CONFIRM: gate }, async () => {
      mockDb({ realStopDates: true, scheduledRows: [zoneStopRow({ technician_id: 'tech-2' })], techs: TWO_TRUCKS, coords: false });
      const result = await getAvailableSlots('est-funnel-1', WINDOW);
      const slots = offered(result);
      expect(findAvailableSlots).not.toHaveBeenCalled();
      expect(slots.length).toBeGreaterThan(0);
      expect(result.metadata.zoneDayFunnel.mode).toBe('seeded');
      expect(new Set(slots.map((s) => s.date)).size).toBe(1);
      expect(slots.some((s) => s.date === '2027-05-20')).toBe(false);
    });
  });

  test.each([false, true])('capacity preserves south-zone day filtering (clustered=%s)', async clustered => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      mockDb({ scheduledRows: clustered ? [zoneStopRow()] : [] });
      findAvailableSlots.mockResolvedValue({ slots: ['2027-05-21', '2027-05-20'].map(date => ({
        date, start_time: '10:00', end_time: '11:00', route_mode: 'arrival_windows',
        technician: { id: 'tech-1', name: 'Fixture' }, detour_minutes: 4, stops_that_day: 2,
      })) });
      const result = await getAvailableSlots('est-funnel-1', WINDOW);
      const slots = [...result.primary, ...result.expander];
      expect(slots.length).toBeGreaterThan(0);
      expect(new Set(slots.map(s => s.date))).toEqual(new Set([clustered ? '2027-05-20' : '2027-05-21']));
      expect(result.metadata.zoneDayFunnel.mode).toBe(clustered ? 'clustered' : 'seeded');
    } finally { delete process.env.GATE_SCHEDULING_CAPACITY; }
  });

  test('clustered via legacy zone slug (underscore compound of the modern slug)', async () => {
    mockDb({ scheduledRows: [zoneStopRow({ zone: 'venice_north_port', customer_city: null })] });
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

  test('seeded + timeOfDay: the seed day is chosen from days that satisfy the time preference', async () => {
    // No Venice stops anywhere; the route-preferred day (05-19) has its
    // whole afternoon blocked by an out-of-zone visit, so an afternoon
    // search must seed a different day — not seed 05-19 and return nothing.
    mockDb({
      scheduledRows: [zoneStopRow({
        zone: 'sarasota',
        customer_city: null,
        scheduled_date: '2027-05-19',
        window_start: '12:00:00',
        window_end: '17:00:00',
      })],
    });
    findAvailableSlots.mockResolvedValue({
      slots: [{
        date: '2027-05-19',
        start_time: '09:00',
        technician: { id: 'tech-1', name: 'Adam Benetti' },
        detour_minutes: 4,
        stops_that_day: 2,
      }],
      evaluated: 1,
      total_feasible: 1,
    });
    const result = await getAvailableSlots('est-funnel-1', { ...WINDOW, timeOfDay: 'afternoon' });
    const slots = [...(result.primary || []), ...(result.expander || [])];
    expect(slots.length).toBeGreaterThan(0);
    const dates = new Set(slots.map((s) => s.date));
    expect(dates.size).toBe(1);
    expect(dates.has('2027-05-19')).toBe(false);
    expect(slots.every((s) => Number(s.windowStart.split(':')[0]) >= 12)).toBe(true);
    expect(result.metadata.zoneDayFunnel?.mode).toBe('seeded');
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

  test('fail-open is request-scoped: a transient lookup failure is not cached as non-funneled', async () => {
    mockDb({ scheduledRows: [zoneStopRow()], failFirstScheduledCall: true });
    const first = await getAvailableSlots('est-funnel-1', WINDOW);
    // This request fails open — full multi-day pool, no funnel metadata.
    expect(first.metadata.zoneDayFunnel).toBeUndefined();
    const firstDates = new Set([...(first.primary || []), ...(first.expander || [])].map((s) => s.date));
    expect(firstDates.size).toBeGreaterThan(1);
    // The very next request (lookup healthy again) must recompute and
    // funnel — a cached fail-open result would serve unfunneled slots for
    // the whole TTL.
    mockDb({ scheduledRows: [zoneStopRow()] });
    const second = await getAvailableSlots('est-funnel-1', WINDOW);
    expect(second.metadata.cacheHit).toBe(false);
    expect(second.metadata.zoneDayFunnel).toEqual({ mode: 'clustered' });
  });

  test('an address rewrite busts the cache: the next request funnels for the new zone', async () => {
    // First request: Sarasota address, non-funneled — this one IS cached.
    mockDb({
      scheduledRows: [],
      estimateRow: { ...ESTIMATE_ROW, address: '55 Main St, Sarasota, FL 34231' },
    });
    const first = await getAvailableSlots('est-funnel-1', WINDOW);
    expect(first.metadata.zoneDayFunnel).toBeUndefined();
    // Any writer (admin revise, customer-address fan-out — possibly in a
    // DIFFERENT process) rewrites the address to Venice. The address-keyed
    // cache must miss and the request must funnel immediately.
    mockDb({ scheduledRows: [zoneStopRow()] });
    const second = await getAvailableSlots('est-funnel-1', WINDOW);
    expect(second.metadata.cacheHit).toBe(false);
    expect(second.metadata.zoneDayFunnel).toEqual({ mode: 'clustered' });
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

// The same funnel for another offer pool (the lead assessment link, booking.js buildBookingAvailability): same
// helpers, only the address text and the pool come from the caller.
describe('offerFunnelView + funnelOfferPool (assessment link pool, same helpers as the estimate page)', () => {
  const pool = [slot('2027-05-19'), slot('2027-05-20'), slot('2027-05-21'), slot('2027-05-21', '13:00')];
  const WINDOW_ARGS = { dateFrom: '2027-05-18', dateTo: '2027-05-24' };
  const VENICE_ADDRESS = '9 Test Palm Way, Venice, FL, 34285';
  const funnelFor = async (p, address, args = WINDOW_ARGS) => funnelOfferPool(p, await offerFunnelView({ address, ...args, conn: db }), { conn: db });
  const VENICE_VIEW = { days: new Set(['2027-05-20']), techDays: null };
  const scheduledReads = () => db.mock.calls.filter((c) => c[0] === 'scheduled_services').length;
  const withTruckGate = async (value, fn) => {
    const prev = process.env.GATE_MULTI_TECH_CONFIRM;
    if (value == null) delete process.env.GATE_MULTI_TECH_CONFIRM; else process.env.GATE_MULTI_TECH_CONFIRM = value;
    try { return await fn(); } finally {
      if (prev === undefined) delete process.env.GATE_MULTI_TECH_CONFIRM; else process.env.GATE_MULTI_TECH_CONFIRM = prev;
    }
  };

  beforeEach(() => { jest.clearAllMocks(); });

  test('a far-south address with a live zone stop keeps that day only, as applyZoneDayFunnel does', async () => {
    mockDb({ scheduledRows: [zoneStopRow()] });
    const out = await funnelFor(pool, VENICE_ADDRESS);
    expect(out).toEqual(applyZoneDayFunnel(pool, new Set(['2027-05-20'])).slots);
    expect(out.map((s) => s.date)).toEqual(['2027-05-20']);
  });

  test('no zone stop in the window seeds one day: the first date of the pool (its score order)', async () => {
    mockDb({ scheduledRows: [] });
    const out = await funnelFor([slot('2027-05-21'), slot('2027-05-19')], VENICE_ADDRESS);
    expect(out.map((s) => s.date)).toEqual(['2027-05-21']);
  });

  // The builder (routes/booking.js) drops the other trucks' slots with this view before its start claims.
  test('the view carries the per-truck days only with GATE_MULTI_TECH_CONFIRM on', async () => {
    mockDb({ scheduledRows: [zoneStopRow({ technician_id: 'tech-2' })] });
    expect(await withTruckGate(null, () => offerFunnelView({ address: VENICE_ADDRESS, ...WINDOW_ARGS, conn: db })))
      .toEqual({ days: new Set(['2027-05-20']), techDays: null });
    expect(await withTruckGate('true', () => offerFunnelView({ address: VENICE_ADDRESS, ...WINDOW_ARGS, conn: db })))
      .toEqual({ days: new Set(['2027-05-20']), techDays: new Map([['2027-05-20', new Set(['tech-2'])]]) });
  });

  // A one-day window funnels to itself in the fleet view (the commit's rebuild): no read. Per truck it reads, so the
  // commit drops the same openings as the list.
  test('a one-day window: no view and no read in the fleet view; per truck the day\'s view', async () => {
    mockDb({ scheduledRows: [zoneStopRow({ technician_id: 'tech-2' })] });
    const oneDay = { dateFrom: '2027-05-20', dateTo: '2027-05-20' };
    expect(await withTruckGate(null, () => offerFunnelView({ address: VENICE_ADDRESS, ...oneDay, conn: db }))).toBeNull();
    expect(scheduledReads()).toBe(0);
    expect(await withTruckGate('true', () => offerFunnelView({ address: VENICE_ADDRESS, ...oneDay, conn: db })))
      .toEqual({ days: new Set(['2027-05-20']), techDays: new Map([['2027-05-20', new Set(['tech-2'])]]) });
    expect(scheduledReads()).toBe(1);
  });

  test('a lead outside the funneled zones gets the very same pool, and no zone-stop query runs', async () => {
    mockDb({ scheduledRows: [zoneStopRow()] });
    const out = await funnelFor(pool, '55 Main St, Sarasota, FL, 34231');
    expect(out).toBe(pool);
    expect(scheduledReads()).toBe(0);
  });

  test('no address: no view and no query; no view or an empty pool: untouched', async () => {
    mockDb({ scheduledRows: [zoneStopRow()] });
    expect(await offerFunnelView({ address: null, ...WINDOW_ARGS, conn: db })).toBeNull();
    expect(db).not.toHaveBeenCalled();
    expect(await funnelOfferPool(pool, null, { conn: db })).toBe(pool);
    const empty = [];
    expect(await funnelOfferPool(empty, { days: new Set(['2027-05-20']), techDays: null }, { conn: db })).toBe(empty);
  });

  test('a zone or zone-stop lookup failure fails open: no view, the full pool', async () => {
    mockDb({ failFirstScheduledCall: true });
    expect(await funnelFor(pool, VENICE_ADDRESS)).toBe(pool);
    db.mockImplementation(() => ({ select: jest.fn().mockRejectedValue(new Error('zones down')) }));
    expect(await offerFunnelView({ address: VENICE_ADDRESS, ...WINDOW_ARGS, conn: db })).toBeNull();
  });

  // The writers' re-check under their date lock (createSelfBooking callbackVisit.slotGuard, slot-reservation.js holds),
  // with the zone the writer stamps: the first of two racing bookings' stop decides the second.
  describe('truckMayTakeDate (rule B when a booking is written)', () => {
    const take = (technicianId, estimateZone = VENICE_ZONE) => truckMayTakeDate(db, { estimateZone, date: '2027-05-20', technicianId });

    test('per truck: a day another truck drives south refuses; its own truck, an unassigned stop or no stop takes it', async () => {
      await withTruckGate('true', async () => {
        mockDb({ scheduledRows: [zoneStopRow({ technician_id: 'tech-2' })] });
        expect(await take('tech-1')).toBe(false);
        expect(await take('tech-2')).toBe(true);
        mockDb({ scheduledRows: [zoneStopRow({ technician_id: null })] });
        expect(await take('tech-1')).toBe(true);
        mockDb({ scheduledRows: [] });
        expect(await take('tech-1')).toBe(true);
      });
    });

    test('the fleet view, no technician, no zone or another zone: true with no read', async () => {
      mockDb({ scheduledRows: [zoneStopRow({ technician_id: 'tech-2' })] });
      expect(await withTruckGate(null, () => take('tech-1'))).toBe(true);
      await withTruckGate('true', async () => {
        expect(await take(null)).toBe(true);
        expect(await take('tech-1', null)).toBe(true);
        expect(await take('tech-1', SARASOTA_ZONE)).toBe(true);
      });
      expect(db).not.toHaveBeenCalled();
    });

    // Not fail-open like the offer: the booking transaction refuses rather than books past a read it could not do.
    test('a stop-read failure throws, so the booking transaction fails closed', async () => {
      await withTruckGate('true', async () => {
        mockDb({ failFirstScheduledCall: true });
        await expect(take('tech-1')).rejects.toThrow('transient outage');
      });
    });
  });

  // The offer reads the zone as the booking will stamp it (createSelfBooking resolves callbackVisit.zoneAddress the
  // same way), so the commit check never refuses a time the list showed. With a city, the city alone decides.
  test.each([
    ['a Venice address on Sarasota Street, Sarasota listed first', [SARASOTA_ZONE, VENICE_ZONE], '100 Sarasota St, Venice, FL, 34285', 'Venice', null, VENICE_VIEW],
    ['a Sarasota address on Venice Avenue, Venice listed first', [VENICE_ZONE, SARASOTA_ZONE], '100 Venice Ave, Sarasota, FL, 34231', 'Sarasota', VENICE_VIEW, null],
    ['a city no zone lists (North Venice): the zone city its name contains', [SARASOTA_ZONE, VENICE_ZONE], '9 Sarasota Way, North Venice, FL, 34275', 'North Venice', null, VENICE_VIEW],
    ['a city no zone lists on a street named for one (Wimauma, Venice Ave): no zone', [VENICE_ZONE, SARASOTA_ZONE], '100 Venice Ave, Wimauma, FL, 33598', 'Wimauma', VENICE_VIEW, null],
  ])('%s: the city decides the zone, as the booking stamps it', async (_label, zones, address, city, textOnly, withCity) => {
    mockDb({ scheduledRows: [zoneStopRow({ technician_id: 'tech-2' })], zones });
    const view = (c) => offerFunnelView({ address, city: c, ...WINDOW_ARGS, conn: db });
    expect(await view(null)).toEqual(textOnly);
    expect(await view(city)).toEqual(withCity);
    expect(await view(`  ${city.toUpperCase()} `)).toEqual(withCity);
  });

  test('gate off: no view and no query at all, also for funnelZoneRows', async () => {
    const prev = process.env.GATE_SOUTH_ZONE_DAY_FUNNEL;
    delete process.env.GATE_SOUTH_ZONE_DAY_FUNNEL;
    try {
      let fresh;
      jest.isolateModules(() => { fresh = require('../services/scheduling/zone-day-funnel'); });
      const dbc = jest.fn();
      expect(await fresh.offerFunnelView({ address: VENICE_ADDRESS, ...WINDOW_ARGS, conn: dbc })).toBeNull();
      expect(await fresh.funnelZoneRows(dbc)).toEqual([]);
      expect(dbc).not.toHaveBeenCalled();
    } finally {
      process.env.GATE_SOUTH_ZONE_DAY_FUNNEL = prev;
    }
  });
});

describe('funnelZoneRows / rowInFunnelZones (the funneled zones and who is in them)', () => {
  test('gate on: only the funneled zone rows; a visit row is in, out, or unresolved (null)', async () => {
    mockDb();
    const zones = await funnelZoneRows(db);
    expect(zones).toEqual([VENICE_ZONE]);
    expect(rowInFunnelZones({ zone: 'venice' }, zones)).toBe(true);
    expect(rowInFunnelZones({ zone: 'venice_north_port' }, zones)).toBe(true);
    expect(rowInFunnelZones({ zone: 'parrish', customer_city: 'Venice' }, zones)).toBe(false);
    expect(rowInFunnelZones({ zone: null, service_city: 'Nokomis' }, zones)).toBe(true);
    expect(rowInFunnelZones({ zone: 'lakewood_ranch', customer_city: 'Parrish' }, zones)).toBe(false);
    expect(rowInFunnelZones({ zone: 'lakewood_ranch' }, zones)).toBeNull();
    expect(rowInFunnelZones({}, zones)).toBeNull();
  });
});
