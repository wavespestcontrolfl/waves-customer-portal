/** Hourly county pass: property pins and the needs_pin retry (GATE_GEOCODE_COUNTY_FALLBACK). */
let mockRecorded;
let mockConfig;
jest.mock('../models/db', () => {
  const conn = jest.fn((table) => {
    const rec = { table, ops: [] };
    mockRecorded.push(rec);
    const chain = new Proxy({}, { get: (_t, op) => {
      if (op === 'then') return (resolve, reject) => Promise.resolve(mockConfig.rows(rec)).then(resolve, reject);
      return (...args) => {
        rec.ops.push([op, ...args]);
        return op === 'update' ? Promise.resolve(mockConfig.update(rec)) : chain;
      };
    } });
    return chain;
  });
  conn.transaction = async fn => fn(conn);
  return conn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/property-lookup/county-lot-pin', () => ({ countyLotPinForAddress: jest.fn() }));
jest.mock('../services/scheduling/quality-after-change', () => ({ refreshScheduleQualityAfterChange: jest.fn(async () => {}) }));

const { countyLotPinForAddress } = require('../services/property-lookup/county-lot-pin');
const { refreshScheduleQualityAfterChange } = require('../services/scheduling/quality-after-change');
const review = require('../services/customer-geocode-review');
const { sweepCountyFallback, sweepUnpinnedProperties, _unresolvedProperties } = require('../services/geocoder-county-fallback');
const db = require('../models/db');

const LOT = { lat: 27.58, lng: -82.42, parcelId: '1000', county: 'Manatee' };
const property = (overrides = {}) => ({
  id: 'p1', customer_id: 'c1', latitude: null, longitude: null,
  address_line1: '104 Sample Way', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219',
  c_address_line1: '100 Main St', c_city: 'Bradenton', c_zip: '34205', c_latitude: '27.49', c_longitude: '-82.57',
  ...overrides,
});
const opsOf = (table) => mockRecorded.filter(rec => rec.table === table);
const hasOp = (rec, name, ...args) => rec.ops.some(op => op[0] === name && args.every((arg, i) => JSON.stringify(op[i + 1]) === JSON.stringify(arg)));

beforeEach(() => {
  process.env.GATE_GEOCODE_REVIEW = 'true';
  process.env.GATE_GEOCODE_COUNTY_FALLBACK = 'true';
  db.mockClear();
  mockRecorded = [];
  mockConfig = { rows: jest.fn(() => []), update: jest.fn(() => 1) };
  countyLotPinForAddress.mockReset().mockResolvedValue(LOT);
  refreshScheduleQualityAfterChange.mockClear();
  _unresolvedProperties.clear();
});
afterAll(() => { delete process.env.GATE_GEOCODE_REVIEW; delete process.env.GATE_GEOCODE_COUNTY_FALLBACK; });

describe('sweepUnpinnedProperties', () => {
  const candidates = (rows) => { mockConfig.rows.mockImplementation(rec => rec.table === 'customer_properties as p' ? rows : []); };

  test('only active unpinned properties of live customers are asked for, at most 25, behind the review fences', async () => {
    candidates([]);
    await sweepUnpinnedProperties();
    const query = opsOf('customer_properties as p')[0];
    expect(hasOp(query, 'where', 'p.active', true)).toBe(true);
    expect(hasOp(query, 'whereNull', 'c.deleted_at')).toBe(true);
    expect(hasOp(query, 'limit', 25)).toBe(true);
    const raw = query.ops.filter(op => op[0] === 'whereRaw').map(op => op[1]).join('\n');
    expect(raw).toContain(review.PRIMARY_ADDRESS_MATCH_SQL); // the customer path owns a primary at the customer's address
    expect(query.ops.some(op => op[0] === 'whereNotExists')).toBe(true); // excludePrimaryPropertyReviewBlocks
  });

  test('a property at the customer\'s own address copies the customer pin without a county call', async () => {
    candidates([property({ address_line1: ' 100 main st ', city: 'BRADENTON', zip: '34205' })]);
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 1, unresolved: 0 });
    expect(countyLotPinForAddress).not.toHaveBeenCalled();
    const write = opsOf('customer_properties')[0];
    expect(write.ops.find(op => op[0] === 'update')[1]).toMatchObject({ latitude: 27.49, longitude: -82.57 });
  });

  test('another address takes the county lot; the write only lands on the row as read', async () => {
    candidates([property()]);
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 1, unresolved: 0 });
    expect(countyLotPinForAddress).toHaveBeenCalledWith(expect.objectContaining({ address_line1: '104 Sample Way', zip: '34219' }));
    const write = opsOf('customer_properties')[0];
    expect(write.ops.find(op => op[0] === 'update')[1]).toMatchObject({ latitude: 27.58, longitude: -82.42 });
    for (const column of ['address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude']) {
      expect(write.ops.some(op => ['where', 'whereNull'].includes(op[0]) && op[1] === column)).toBe(true);
    }
  });

  test('a raced write (row changed since read) lands nothing and fills no visits', async () => {
    candidates([property()]);
    mockConfig.update.mockImplementation(rec => rec.table === 'customer_properties' ? 0 : 1);
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 0, unresolved: 1 });
    expect(opsOf('scheduled_services')).toHaveLength(0);
    expect(refreshScheduleQualityAfterChange).not.toHaveBeenCalled();
  });

  test('upcoming visits of the property with no pin get it, then quality refreshes once per batch', async () => {
    candidates([property({ id: 'p1', customer_id: 'c1' }), property({ id: 'p2', customer_id: 'c1' }), property({ id: 'p3', customer_id: 'c2' })]);
    await sweepUnpinnedProperties();
    const visits = opsOf('scheduled_services');
    expect(visits).toHaveLength(3);
    const first = visits[0];
    expect(hasOp(first, 'where', { property_id: 'p1' })).toBe(true);
    expect(first.ops.some(op => op[0] === 'where' && op[1] === 'scheduled_date' && op[2] === '>=')).toBe(true);
    // Live = a legacy NULL status or anything but cancelled/completed: run the where-callback on a recorder.
    const statusGroup = first.ops.find(op => op[0] === 'where' && typeof op[1] === 'function');
    const inner = [];
    const recorder = { whereNull: (...a) => { inner.push(['whereNull', ...a]); return recorder; },
      orWhereNotIn: (...a) => { inner.push(['orWhereNotIn', ...a]); return recorder; } };
    statusGroup[1].call(recorder);
    expect(inner).toEqual([['whereNull', 'status'], ['orWhereNotIn', 'status', ['cancelled', 'completed']]]);
    expect(first.ops.find(op => op[0] === 'update')[1]).toMatchObject({ lat: 27.58, lng: -82.42 });
    expect(refreshScheduleQualityAfterChange).toHaveBeenCalledTimes(1);
    expect(refreshScheduleQualityAfterChange).toHaveBeenCalledWith({ customerIds: ['c1', 'c2'] });
  });

  test('a miss is remembered by address: skipped next run, readmitted after an address edit', async () => {
    candidates([property()]);
    countyLotPinForAddress.mockResolvedValue(null);
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 0, unresolved: 1 });
    expect(_unresolvedProperties.get('p1')).toBe('104 sample way|parrish|34219');

    mockRecorded = [];
    mockConfig.rows.mockImplementation(rec => {
      if (rec.table === 'customer_properties') return [{ id: 'p1', address_line1: '104 Sample Way', city: 'Parrish', zip: '34219' }];
      return [];
    });
    await sweepUnpinnedProperties();
    const query = opsOf('customer_properties as p')[0];
    expect(hasOp(query, 'whereNotIn', 'p.id', ['p1'])).toBe(true);

    mockRecorded = [];
    mockConfig.rows.mockImplementation(rec => rec.table === 'customer_properties'
      ? [{ id: 'p1', address_line1: '106 Sample Way', city: 'Parrish', zip: '34219' }] : []);
    await sweepUnpinnedProperties();
    expect(_unresolvedProperties.has('p1')).toBe(false);
    expect(hasOp(opsOf('customer_properties as p')[0], 'whereNotIn', 'p.id', ['p1'])).toBe(false);
  });

  test('the exclusion map is capped by dropping the oldest entries', async () => {
    for (let i = 0; i < 2005; i += 1) _unresolvedProperties.set(`x${i}`, 'a|b|c');
    mockConfig.rows.mockImplementation(rec => rec.table === 'customer_properties'
      ? [...new Array(2000)].map((_, i) => ({ id: `x${i + 5}`, address_line1: 'a', city: 'b', zip: 'c' })) : []);
    await sweepUnpinnedProperties();
    expect(_unresolvedProperties.size).toBe(2000);
    expect(_unresolvedProperties.has('x0')).toBe(false);
  });

  test('a county outage stops the run: nothing written, nothing remembered', async () => {
    candidates([property({ id: 'p1' }), property({ id: 'p2' })]);
    countyLotPinForAddress.mockRejectedValue(new Error('county down'));
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 0, unresolved: 0 });
    expect(countyLotPinForAddress).toHaveBeenCalledTimes(1);
    expect(_unresolvedProperties.size).toBe(0);
    expect(opsOf('scheduled_services')).toHaveLength(0);
  });

  test('gate off: no query, no county call', async () => {
    delete process.env.GATE_GEOCODE_COUNTY_FALLBACK;
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 0, pinned: 0, unresolved: 0 });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('sweepCountyFallback', () => {
  test('gate off: does nothing at all', async () => {
    delete process.env.GATE_GEOCODE_COUNTY_FALLBACK;
    expect(await sweepCountyFallback()).toBeNull();
    expect(db).not.toHaveBeenCalled();
    expect(countyLotPinForAddress).not.toHaveBeenCalled();
  });

  test('a failing needs_pin retry never blocks the property sweep', async () => {
    const spy = jest.spyOn(review, 'retryCountyNeedsPin').mockRejectedValue(new Error('boom'));
    mockConfig.rows.mockImplementation(rec => rec.table === 'customer_properties as p' ? [property()] : []);
    const results = await sweepCountyFallback();
    spy.mockRestore();
    expect(results.needsPin).toBeUndefined();
    expect(results.properties).toEqual({ checked: 1, pinned: 1, unresolved: 0 });
  });

  test('a failing property sweep still reports the needs_pin retry', async () => {
    const spy = jest.spyOn(review, 'retryCountyNeedsPin').mockResolvedValue({ checked: 2, pinned: 1, customerIds: ['c9'] });
    mockConfig.rows.mockImplementation(() => { throw new Error('db down'); });
    const results = await sweepCountyFallback();
    spy.mockRestore();
    expect(results.needsPin.pinned).toBe(1);
    expect(refreshScheduleQualityAfterChange).toHaveBeenCalledWith({ customerIds: ['c9'] });
  });
});
