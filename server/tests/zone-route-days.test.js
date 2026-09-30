/**
 * Zone route days (GATE_ZONE_ROUTE_DAYS, owner ruling 2026-09-29): Friday is
 * the Venice / North Port route day. Pure policy + config + coordinate-zone
 * resolution; the find-time and estimate-picker paths have their own suites
 * (find-time-zone-route-days, estimate-slots-zone-route-days).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { customerMaxDetourMinutes } = require('../services/scheduling/policy');
const routeDays = require('../services/scheduling/zone-route-days');
const { nearestZoneByCoords, resolveZoneByCoords } = require('../services/slot-zone');
const { gates, zoneRouteDaysLive } = require('../config/feature-gates');

// 2027-05-21 is a Friday, 2027-05-20 a Thursday, 2027-05-22 a Saturday.
const FRI = '2027-05-21';
const THU = '2027-05-20';

// The seeded service_zones centers (migration 20260401000048).
const ZONES = [
  { id: 'z-brad', zone_name: 'Bradenton / Parrish', cities: ['Bradenton'], center_lat: 27.4989, center_lng: -82.5748 },
  { id: 'z-sar', zone_name: 'Sarasota / Lakewood Ranch', cities: ['Sarasota'], center_lat: 27.3364, center_lng: -82.5307 },
  { id: 'z-ven', zone_name: 'Venice / North Port', cities: ['Venice', 'North Port'], center_lat: 27.0998, center_lng: -82.4543 },
  { id: 'z-pc', zone_name: 'Port Charlotte', cities: [], center_lat: 26.9756, center_lng: -82.0912 },
];

beforeEach(() => {
  delete process.env.GATE_ZONE_ROUTE_DAYS;
  delete process.env.SCHEDULING_MAX_DETOUR_MINUTES;
  delete process.env.SOUTH_FUNNEL_ZONE_SLUGS;
  jest.clearAllMocks();
});
afterAll(() => { delete process.env.GATE_ZONE_ROUTE_DAYS; });

describe('gate', () => {
  test('ships dark and is read at call time', () => {
    expect(gates.zoneRouteDays).toBe(false);
    expect(zoneRouteDaysLive()).toBe(false);
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    expect(zoneRouteDaysLive()).toBe(true);
    process.env.GATE_ZONE_ROUTE_DAYS = '1';
    expect(zoneRouteDaysLive()).toBe(false); // strict 'true'
  });
});

describe('customerMaxDetourMinutes', () => {
  test('zero-arg call is unchanged (default 30, env override)', () => {
    expect(customerMaxDetourMinutes()).toBe(30);
    process.env.SCHEDULING_MAX_DETOUR_MINUTES = '45';
    expect(customerMaxDetourMinutes()).toBe(45);
  });

  test('gate off: a Venice Friday keeps the normal cap', () => {
    expect(customerMaxDetourMinutes({ date: FRI, zoneSlug: 'venice' })).toBe(30);
  });

  test('gate on: Venice on a Friday gets the lifted cap (code default 150)', () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    expect(customerMaxDetourMinutes({ date: FRI, zoneSlug: 'venice' })).toBe(150);
  });

  test('gate on: another weekday, another zone, or no zone keep the normal cap', () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    expect(customerMaxDetourMinutes({ date: THU, zoneSlug: 'venice' })).toBe(30);
    expect(customerMaxDetourMinutes({ date: FRI, zoneSlug: 'sarasota' })).toBe(30);
    expect(customerMaxDetourMinutes({ date: FRI })).toBe(30);
    expect(customerMaxDetourMinutes({ zoneSlug: 'venice' })).toBe(30);
  });

  test('the Port Charlotte slug shares the south pool with Venice', () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    expect(customerMaxDetourMinutes({ date: FRI, zoneSlug: 'port charlotte' })).toBe(150);
  });

  test('a lifted cap never LOWERS the normal cap', () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    process.env.SCHEDULING_MAX_DETOUR_MINUTES = '200';
    expect(customerMaxDetourMinutes({ date: FRI, zoneSlug: 'venice' })).toBe(200);
  });

  test('technician pin: only the pinned technician is lifted', () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    const zoneRouteDays = routeDays.parseZoneRouteDays(
      '{"venice":{"weekdays":[5],"max_detour_minutes":120,"technician_id":"tech-1"}}',
    );
    expect(customerMaxDetourMinutes({ date: FRI, zoneSlug: 'venice', technicianId: 'tech-1', zoneRouteDays })).toBe(120);
    expect(customerMaxDetourMinutes({ date: FRI, zoneSlug: 'venice', technicianId: 'tech-2', zoneRouteDays })).toBe(30);
  });

  test('a Date value (pg DATE column) resolves by its ET calendar day', () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    expect(customerMaxDetourMinutes({ date: new Date('2027-05-21T12:00:00-04:00'), zoneSlug: 'venice' })).toBe(150);
  });
});

describe('parseZoneRouteDays', () => {
  test('parses JSON text or an object; drops bad rules; malformed = no route days', () => {
    expect(routeDays.parseZoneRouteDays('{"Venice":{"weekdays":[5,9,"x"],"max_detour_minutes":90}}'))
      .toEqual({ venice: { weekdays: [5], max_detour_minutes: 90, technician_id: null } });
    expect(routeDays.parseZoneRouteDays({ venice: { weekdays: [5] } }))
      .toEqual({ venice: { weekdays: [5], max_detour_minutes: 150, technician_id: null } });
    expect(routeDays.parseZoneRouteDays('{"venice":{"weekdays":[]}}')).toEqual({});
    expect(routeDays.parseZoneRouteDays('not json')).toEqual({});
    expect(routeDays.parseZoneRouteDays('[5]')).toEqual({});
    expect(routeDays.parseZoneRouteDays('')).toEqual({});
    expect(routeDays.parseZoneRouteDays(null)).toEqual({});
  });
});

describe('readZoneRouteDays', () => {
  const settingsDb = (impl) => jest.fn(() => ({ where: () => ({ first: impl }) }));

  test('absent key -> the Friday/Venice code default', async () => {
    expect(await routeDays.readZoneRouteDays(settingsDb(async () => undefined))).toBe(routeDays.DEFAULT_ZONE_ROUTE_DAYS);
  });
  test('stored row overrides; {} switches the lift off', async () => {
    expect(await routeDays.readZoneRouteDays(settingsDb(async () => ({ value: '{"venice":{"weekdays":[4],"max_detour_minutes":100}}' }))))
      .toEqual({ venice: { weekdays: [4], max_detour_minutes: 100, technician_id: null } });
    expect(await routeDays.readZoneRouteDays(settingsDb(async () => ({ value: '{}' })))).toEqual({});
  });
  test('read failure fails closed (no lift), never throws', async () => {
    expect(await routeDays.readZoneRouteDays(settingsDb(async () => { throw new Error('boom'); }))).toEqual({});
  });
});

describe('preferRouteDayDates', () => {
  test('route-day dates move first, order otherwise stable', () => {
    const config = routeDays.DEFAULT_ZONE_ROUTE_DAYS;
    expect(routeDays.preferRouteDayDates(['2027-05-19', THU, FRI, '2027-05-28'], { zoneSlug: 'venice', config }))
      .toEqual([FRI, '2027-05-28', '2027-05-19', THU]);
    expect(routeDays.preferRouteDayDates(['2027-05-19', FRI], { zoneSlug: 'sarasota', config })).toEqual(['2027-05-19', FRI]);
  });
});

describe('coordinate zone resolution', () => {
  test('addresses missing from service_zones.cities still resolve to the south pool', () => {
    // North Venice, Northport (one word), North Port, Englewood, Nokomis, Osprey.
    const cases = [
      [27.1200, -82.4400, 'Venice / North Port'], // North Venice
      [27.0440, -82.2360, 'Port Charlotte'],      // Northport: nearest center is the retained PC row
      [26.9620, -82.3530, 'Venice / North Port'], // Englewood
      [27.1190, -82.4430, 'Venice / North Port'], // Nokomis
      [27.1960, -82.4870, 'Venice / North Port'], // Osprey
    ];
    for (const [lat, lng, name] of cases) {
      expect(nearestZoneByCoords(ZONES, lat, lng)?.zone_name).toBe(name);
    }
  });

  test('northern addresses resolve to their own zones; far-away and bad coords resolve to none', () => {
    expect(nearestZoneByCoords(ZONES, 27.3364, -82.5307).zone_name).toBe('Sarasota / Lakewood Ranch');
    expect(nearestZoneByCoords(ZONES, 27.4989, -82.5748).zone_name).toBe('Bradenton / Parrish');
    expect(nearestZoneByCoords(ZONES, 28.5, -81.4)).toBeNull(); // Orlando
    expect(nearestZoneByCoords(ZONES, null, null)).toBeNull();
    expect(nearestZoneByCoords(ZONES, 'x', -82)).toBeNull();
    expect(nearestZoneByCoords([{ zone_name: 'no center' }], 27.1, -82.4)).toBeNull();
  });

  test('resolveZoneByCoords reads service_zones once and skips the query for bad coords', async () => {
    const select = jest.fn().mockResolvedValue(ZONES);
    const dbc = jest.fn(() => ({ select }));
    expect((await resolveZoneByCoords(dbc, 27.12, -82.44)).zone_name).toBe('Venice / North Port');
    expect(dbc).toHaveBeenCalledWith('service_zones');
    dbc.mockClear();
    expect(await resolveZoneByCoords(dbc, undefined, undefined)).toBeNull();
    expect(dbc).not.toHaveBeenCalled();
  });
});

describe('resolveZoneRouteDaySlug', () => {
  const zoneDb = (settingsValue) => jest.fn((table) => {
    if (table === 'service_zones') return { select: async () => ZONES };
    if (table === 'system_settings') return { where: () => ({ first: async () => (settingsValue === undefined ? undefined : { value: settingsValue }) }) };
    throw new Error(`unexpected table ${table}`);
  });

  test('gate off: null with no database call at all', async () => {
    const conn = zoneDb();
    expect(await routeDays.resolveZoneRouteDaySlug({ lat: 27.12, lng: -82.44, conn })).toBeNull();
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on: a North Venice pin resolves to venice; Northport resolves inside the south pool', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    expect(await routeDays.resolveZoneRouteDaySlug({ lat: 27.12, lng: -82.44, conn: zoneDb() })).toBe('venice');
    const northport = await routeDays.resolveZoneRouteDaySlug({ lat: 27.044, lng: -82.236, conn: zoneDb() });
    expect(northport).toBe('port charlotte');
    expect(customerMaxDetourMinutes({ date: FRI, zoneSlug: northport })).toBe(150);
  });

  test('gate on: coordinates win over the estimate city zone; missing coords fall back to it', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    const veniceZone = { zone_name: 'Venice / North Port' };
    expect(await routeDays.resolveZoneRouteDaySlug({ lat: 27.3364, lng: -82.5307, estimateZone: veniceZone, conn: zoneDb() })).toBe('sarasota');
    expect(await routeDays.resolveZoneRouteDaySlug({ estimateZone: veniceZone, conn: zoneDb() })).toBe('venice');
  });

  test('gate on but config {} (lift switched off) returns null without a zone query', async () => {
    process.env.GATE_ZONE_ROUTE_DAYS = 'true';
    const conn = zoneDb('{}');
    expect(await routeDays.resolveZoneRouteDaySlug({ lat: 27.12, lng: -82.44, conn })).toBeNull();
    expect(conn).not.toHaveBeenCalledWith('service_zones');
  });
});
