// Reclaimed water meters (GATE_LAWN_RECLAIMED_HALF_N): the county-layer download (paging, parser, user agent, 403), the local matcher (30 m),
// and the promise that no property data leaves the server. Fake fetch and fake knex; no network, no database.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const meters = require('../services/reclaimed-water-meters');

const feature = (objectid, x, y) => ({ attributes: { OBJECTID: objectid }, geometry: { x, y } });
const body = (features, exceededTransferLimit = false) => ({ ok: true, status: 200, json: async () => ({ features, ...(exceededTransferLimit ? { exceededTransferLimit: true } : {}) }) });
const refusal = (status) => ({ ok: false, status, json: async () => ({}) });

// A point `north` / `east` metres from a base point, at Parrish latitude (111,320 m per degree of latitude, 98,500 m of longitude).
const BASE = { lat: 27.5, lng: -82.4 };
const offset = (northM, eastM) => ({ lat: BASE.lat + northM / 111320, lng: BASE.lng + eastM / 98650 });

describe('the request', () => {
  test('is the constant layer query: where 1=1, OBJECTID plus the two in-service fields, geometry in 4326, json, ordered, 2000 a page', () => {
    const url = new URL(meters.pageUrl(4000));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.mymanatee.org/gisutil/rest/services/Reclaim_UN_Breakdown/MapServer/5/query');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      where: '1=1', outFields: 'OBJECTID,LIFECYCLESTATUS,RETIREDDATE', returnGeometry: 'true', outSR: '4326', f: 'json', orderByFields: 'OBJECTID', resultOffset: '4000', resultRecordCount: '2000',
    });
  });

  test('carries a normal browser-style user agent (the county answers 403 to some others), not the runtime default', async () => {
    const fetchImpl = jest.fn(async () => body([feature(1, -82.4, 27.5)]));
    await meters.fetchAllMeters({ fetchImpl });
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers['User-Agent']).toBe(meters.USER_AGENT);
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0 /);
    expect(headers['User-Agent']).not.toMatch(/node|undici/i);
  });

  test('a 403 (or any HTTP failure) is an error with its code, never a partial layer', async () => {
    await expect(meters.fetchAllMeters({ fetchImpl: async () => refusal(403) })).rejects.toMatchObject({ code: 'http_403' });
    let call = 0;
    const second = async () => { call += 1; return call === 1 ? body([feature(1, -82.4, 27.5)], true) : refusal(500); };
    await expect(meters.fetchAllMeters({ fetchImpl: second })).rejects.toMatchObject({ code: 'http_500' });
  });

  test('the county reports its own error inside a 200 answer', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: { code: 400, message: 'Invalid query' } }) });
    await expect(meters.fetchAllMeters({ fetchImpl })).rejects.toMatchObject({ code: 'layer_error' });
  });
});

describe('the paging parser', () => {
  test('reads OBJECTID, x as longitude and y as latitude, and the more-pages flag', () => {
    expect(meters.parsePage({ features: [feature(7, -82.41, 27.61)], exceededTransferLimit: true })).toEqual({
      points: [{ objectid: 7, lat: 27.61, lng: -82.41 }], received: 1, more: true,
    });
    expect(meters.parsePage({ features: [] })).toEqual({ points: [], received: 0, more: false });
  });

  test('drops a feature with no usable geometry or id, and rejects a non-object answer', () => {
    const page = meters.parsePage({ features: [feature(1, -82.4, 27.5), { attributes: { OBJECTID: 2 } }, feature('x', -82.4, 27.5), feature(3, 'NaN', 27.5), feature(4, -82.4, 91), feature(5, 181, 27.5)] });
    expect(page.points.map((p) => p.objectid)).toEqual([1]);
    expect(page.received).toBe(6);
    expect(() => meters.parsePage(null)).toThrow();
  });

  test('pages by the offset of what it received until the county stops saying there is more; repeated ids count once', async () => {
    const pages = [
      body([feature(1, -82.4, 27.5), feature(2, -82.4001, 27.5)], true),
      body([feature(2, -82.4001, 27.5), feature(3, -82.4002, 27.5)], true),
      body([feature(4, -82.4003, 27.5)], false),
    ];
    const fetchImpl = jest.fn(async () => pages.shift());
    const all = await meters.fetchAllMeters({ fetchImpl });
    expect(all.map((p) => p.objectid).sort()).toEqual([1, 2, 3, 4]);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get('resultOffset'))).toEqual(['0', '2', '4']);
  });

  test('counts a meter only while it is in service: a retired date, or a lifecycle status other than the layer\'s in-service 8, drops it', () => {
    const withAttrs = (objectid, extra) => ({ attributes: { OBJECTID: objectid, ...extra }, geometry: { x: -82.4, y: 27.5 } });
    const page = meters.parsePage({ features: [
      withAttrs(1, { LIFECYCLESTATUS: 8, RETIREDDATE: null }),
      withAttrs(2, { LIFECYCLESTATUS: 8 }),
      withAttrs(3, {}),
      withAttrs(4, { LIFECYCLESTATUS: 8, RETIREDDATE: 1700000000000 }),
      withAttrs(5, { LIFECYCLESTATUS: 9, RETIREDDATE: null }),
      withAttrs(6, { LIFECYCLESTATUS: 0 }),
    ] });
    expect(page.points.map((p) => p.objectid)).toEqual([1, 2, 3]);
    expect(page.received).toBe(6);
    expect(meters.IN_SERVICE_LIFECYCLE).toBe(8);
  });

  test('a retired meter does not mark a property reclaimed', async () => {
    const retired = { attributes: { OBJECTID: 1, LIFECYCLESTATUS: 8, RETIREDDATE: 1700000000000 }, geometry: { x: -82.4, y: 27.5 } };
    const live = { attributes: { OBJECTID: 2, LIFECYCLESTATUS: 8, RETIREDDATE: null }, geometry: { x: -82.4 + 0.01, y: 27.5 } };
    const west = { attributes: { OBJECTID: 3, LIFECYCLESTATUS: 8 }, geometry: { x: -82.41, y: 27.5 } };
    const all = await meters.fetchAllMeters({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ features: [retired, live, west] }) }) });
    const index = meters.buildIndex(all);
    expect(meters.judgePoint(index, 27.5, -82.4)).toEqual({ reclaimed: false });
    expect(meters.judgePoint(index, 27.5, -82.39)).toEqual({ reclaimed: true });
  });

  test('an answer that never ends is an error, not a loop', async () => {
    const fetchImpl = async () => body([feature(1, -82.4, 27.5)], true);
    await expect(meters.fetchAllMeters({ fetchImpl })).rejects.toMatchObject({ code: 'too_many_pages' });
  });
});

describe('the matcher: a property is at a meter within 30 m', () => {
  const at = (n, e, id = 1) => ({ objectid: id, ...offset(n, e) });
  const judge = (list, point) => meters.judgePoint(meters.buildIndex(list), point.lat, point.lng);

  test('the radius is 30 m', () => { expect(meters.MATCH_RADIUS_M).toBe(30); });

  test.each([[0, 0, true], [12, 0, true], [0, 29, true], [20, 20, true], [0, 31, false], [31, 0, false], [25, 25, false]])('a meter %s m north and %s m east of the property: reclaimed %s', (n, e, expected) => {
    const property = { lat: BASE.lat, lng: BASE.lng };
    const index = meters.buildIndex([at(n, e), ...Array.from({ length: 3 }, (_, i) => at(5000 + i, 5000, i + 10))]);
    expect(meters.nearestMeter(index, property.lat, property.lng) !== null).toBe(expected);
  });

  test('a meter just across a grid cell edge is still found, and the closest of several is reported', () => {
    const edgeLng = (Math.floor(BASE.lng / 0.0005) + 1) * 0.0005; // a cell boundary
    const property = { lat: BASE.lat, lng: edgeLng - 0.00005 };
    const index = meters.buildIndex([{ objectid: 1, lat: BASE.lat, lng: edgeLng + 0.00005 }, { objectid: 2, lat: BASE.lat + 0.0002, lng: property.lng }]);
    expect(meters.nearestMeter(index, property.lat, property.lng).objectid).toBe(1);
    expect(meters.nearestMeter(index, property.lat, property.lng).distanceM).toBeCloseTo(9.9, 0);
  });

  test('reclaimed at a meter, not reclaimed inside the Manatee extent with no meter near, no opinion outside the extent', () => {
    const list = [at(0, 0, 1), at(2000, 2000, 2)];
    expect(judge(list, offset(0, 5))).toEqual({ reclaimed: true });
    expect(judge(list, offset(1000, 1000))).toEqual({ reclaimed: false });
    expect(judge(list, offset(-9000, 0))).toEqual({ reclaimed: null });
    expect(judge([], offset(0, 0))).toEqual({ reclaimed: null });
    expect(meters.judgePoint(meters.buildIndex(list), NaN, 1)).toEqual({ reclaimed: null });
  });

  test('distance is great-circle metres', () => {
    expect(meters.distanceM(27.5, -82.4, 27.5, -82.4)).toBe(0);
    expect(meters.distanceM(27.5, -82.4, 27.5 + 0.001, -82.4)).toBeCloseTo(111.2, 0);
  });
});

describe('no property data leaves the server', () => {
  // A fake knex that serves a stored layer and properties whose coordinates are easy to look for in an outbound request.
  const PROPERTY = { id: 'p1', latitude: '27.123456', longitude: '-82.654321' };
  function fakeKnex({ stored = 0 } = {}) {
    const rows = { reclaimed_water_meters: stored, customer_properties: [PROPERTY] };
    const chain = (table) => {
      const q = {
        count: () => q, max: () => q, select: () => q, where: () => q, whereNot: () => q, whereNull: () => q, whereNotNull: () => q, whereIn: () => q, orWhere: () => q, modify: () => q, insert: () => q, onConflict: () => q, merge: async () => 0, del: async () => 0, update: async () => 0,
        first: async () => (table === 'reclaimed_water_meters' ? { n: rows.reclaimed_water_meters, latest: null } : null),
        then: (resolve) => resolve(table === 'customer_properties' ? [PROPERTY] : []),
      };
      return q;
    };
    const knex = (table) => chain(table);
    knex.transaction = async (fn) => fn(knex);
    return knex;
  }

  test('the daily tick sends only the constant layer query: no property id, coordinate or address in any URL, header or body', async () => {
    const big = Array.from({ length: 5100 }, (_, i) => feature(i + 1, -82.4 - i * 0.00001, 27.5));
    const fetchImpl = jest.fn(async () => body(big, false));
    await meters.runDailyTick({ knex: fakeKnex(), fetchImpl, now: new Date('2026-10-23T08:00:00Z') }).catch(() => {});
    expect(fetchImpl).toHaveBeenCalled();
    for (const [url, init] of fetchImpl.mock.calls) {
      const sent = JSON.stringify({ url: String(url), init: { ...init, signal: undefined } });
      expect(String(url).startsWith(meters.LAYER_QUERY_URL)).toBe(true);
      expect(init.method).toBeUndefined(); // a plain GET
      expect(init.body).toBeUndefined();
      for (const secret of ['27.123456', '-82.654321', '27.1234', '82.6543', 'p1']) expect(sent).not.toContain(secret);
    }
  });

  test('the module has no way to put a property in a request: fetchAllMeters and pageUrl take no property argument', () => {
    expect(meters.fetchAllMeters.length).toBeLessThanOrEqual(1);
    expect(meters.pageUrl.length).toBe(1);
    expect(typeof meters.pageUrl(0)).toBe('string');
  });
});

describe('a short or failed pull never replaces the stored layer', () => {
  test('storeMeters refuses fewer than the plausible minimum, and fewer than half of what is stored', async () => {
    const countOf = (n) => () => ({ count: () => ({ first: async () => ({ n }) }) });
    const small = Array.from({ length: 100 }, (_, i) => ({ objectid: i, lat: 27.5, lng: -82.4 }));
    await expect(meters.storeMeters(small, { knex: countOf(0) })).rejects.toMatchObject({ code: 'implausible_pull' });
    const some = Array.from({ length: meters.MIN_PLAUSIBLE_METERS }, (_, i) => ({ objectid: i, lat: 27.5, lng: -82.4 }));
    await expect(meters.storeMeters(some, { knex: countOf(40000) })).rejects.toMatchObject({ code: 'implausible_pull' });
  });
});
