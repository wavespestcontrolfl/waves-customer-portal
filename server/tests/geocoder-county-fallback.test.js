/** Hourly county pass: property pins, the visit pins they feed, and the needs_pin retry (GATE_GEOCODE_COUNTY_FALLBACK). */
let mockRecorded;
let mockConfig;
jest.mock('../models/db', () => {
  const conn = jest.fn((table) => {
    const rec = { table, ops: [] };
    mockRecorded.push(rec);
    const chain = new Proxy({}, { get: (_t, op) => {
      if (op === 'then') return (resolve, reject) => Promise.resolve().then(() => mockConfig.rows(rec)).then(resolve, reject);
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
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn(async () => {}) }));
jest.mock('../services/geocoder-service-locations', () => ({
  SNAPSHOT_COLUMNS: jest.requireActual('../services/geocoder-service-locations').SNAPSHOT_COLUMNS,
  persistServicePin: jest.fn(),
}));

const { countyLotPinForAddress } = require('../services/property-lookup/county-lot-pin');
const { refreshScheduleQualityAfterChange } = require('../services/scheduling/quality-after-change');
const { emitDispatchJobUpdate } = require('../services/dispatch-assignment');
const { SNAPSHOT_COLUMNS, persistServicePin } = require('../services/geocoder-service-locations');
const review = require('../services/customer-geocode-review');
const { sweepCountyFallback, sweepUnpinnedProperties, sweepPropertyVisitPins, _unresolvedProperties } = require('../services/geocoder-county-fallback');
const { etDateString, addETDays } = require('../utils/datetime-et');
const db = require('../models/db');

const NOW = new Date('2026-11-02T15:00:00Z');
const LOT = { lat: 27.58, lng: -82.42, parcelId: '1000', county: 'Manatee' };
const property = (overrides = {}) => ({
  id: 'p1', customer_id: 'c1', is_primary: false, latitude: null, longitude: null,
  address_line1: '104 Sample Way', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219',
  c_address_line1: '100 Main St', c_address_line2: null, c_city: 'Bradenton', c_state: 'FL', c_zip: '34205',
  c_latitude: '27.49', c_longitude: '-82.57',
  ...overrides,
});
// The customers row as stored, matching property()'s c_ columns.
const customerRow = (overrides = {}) => ({ id: 'c1', address_line1: '100 Main St', address_line2: null, city: 'Bradenton', state: 'FL',
  zip: '34205', latitude: '27.49', longitude: '-82.57', deleted_at: null, ...overrides });
const visit = (overrides = {}) => ({
  id: 'v1', customer_id: 'c1', property_id: 'p1', technician_id: 't1', scheduled_date: '2026-11-05', status: 'pending',
  visit_id: null, lat: null, lng: null, auto_dispatch_locked: false, auto_dispatch_excluded: false, reservation_expires_at: null,
  service_address_line1: '104 Sample Way', service_address_line2: null, service_address_city: 'Parrish',
  service_address_state: 'FL', service_address_zip: '34219',
  p_address_line1: '104 Sample Way', p_address_line2: null, p_city: 'Parrish', p_state: 'FL', p_zip: '34219',
  p_latitude: '27.58', p_longitude: '-82.42',
  ...overrides,
});
const opsOf = (table) => mockRecorded.filter(rec => rec.table === table);
const hasOp = (rec, name, ...args) => rec.ops.some(op => op[0] === name && args.every((arg, i) => JSON.stringify(op[i + 1]) === JSON.stringify(arg)));
const propertyWrites = () => opsOf('customer_properties').filter(rec => rec.ops.some(op => op[0] === 'update'));
// Runs a knex where/join callback against a recorder and returns the calls it made.
function callbackCalls(fn) {
  const calls = [];
  const recorder = new Proxy({}, { get: (_t, op) => (...args) => { calls.push([op, ...args]); return recorder; } });
  fn.call(recorder);
  return calls;
}

let state;
beforeEach(() => {
  process.env.GATE_GEOCODE_REVIEW = 'true';
  process.env.GATE_GEOCODE_COUNTY_FALLBACK = 'true';
  db.mockClear();
  mockRecorded = [];
  state = { candidates: [], customer: customerRow(), review: undefined, prune: [], visitPages: [[]] };
  mockConfig = {
    rows: jest.fn((rec) => {
      if (rec.table === 'customer_properties as p') return state.candidates;
      if (rec.table === 'scheduled_services as s') {
        const offset = [...rec.ops].reverse().find(op => op[0] === 'offset')?.[1] ?? 0;
        return state.visitPages[offset / 25] || [];
      }
      if (rec.table === 'customers') return state.customer;
      if (rec.table === 'customer_geocode_reviews') return state.review;
      if (rec.table === 'customer_properties' && rec.ops.some(op => op[0] === 'whereIn')) return state.prune;
      return undefined;
    }),
    update: jest.fn(() => 1),
  };
  countyLotPinForAddress.mockReset().mockResolvedValue(LOT);
  persistServicePin.mockReset().mockResolvedValue(true);
  emitDispatchJobUpdate.mockClear();
  refreshScheduleQualityAfterChange.mockClear();
  _unresolvedProperties.clear();
});
afterAll(() => { delete process.env.GATE_GEOCODE_REVIEW; delete process.env.GATE_GEOCODE_COUNTY_FALLBACK; });

describe('sweepUnpinnedProperties', () => {
  test('only active unpinned properties of live customers are asked for, at most 25, behind the review fences', async () => {
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
    state.candidates = [property({ address_line1: ' 100 main st ', city: 'BRADENTON', zip: '34205' })];
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 1, unresolved: 0 });
    expect(countyLotPinForAddress).not.toHaveBeenCalled();
    expect(propertyWrites()[0].ops.find(op => op[0] === 'update')[1]).toMatchObject({ latitude: 27.49, longitude: -82.57 });
  });

  test('a customer pin the review withholds is never copied, and the row waits until its address changes', async () => {
    state.candidates = [property({ address_line1: '100 Main St', city: 'Bradenton', zip: '34205' })];
    state.review = { customer_id: 'c1', status: 'needs_pin', reason: 'partial_match',
      address_snapshot: ['100 Main St', null, 'Bradenton', 'FL', '34205'], updated_at: '2026-11-01T00:00:00Z' };
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 0, unresolved: 1 });
    expect(propertyWrites()).toHaveLength(0);
    expect(_unresolvedProperties.get('p1')).toBe('100 main st|bradenton|34205');
  });

  test('another address takes the county lot; the write only lands on the row and primary flag as read', async () => {
    state.candidates = [property()];
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 1, unresolved: 0 });
    expect(countyLotPinForAddress).toHaveBeenCalledWith(expect.objectContaining({ address_line1: '104 Sample Way', zip: '34219' }));
    const write = propertyWrites()[0];
    expect(write.ops.find(op => op[0] === 'update')[1]).toMatchObject({ latitude: 27.58, longitude: -82.42 });
    for (const column of ['address_line1', 'address_line2', 'city', 'state', 'zip', 'latitude', 'longitude', 'is_primary']) {
      expect(write.ops.some(op => ['where', 'whereNull'].includes(op[0]) && op[1] === column)).toBe(true);
    }
  });

  test('the write runs under the customer review fence, even with the review gate off', async () => {
    const fence = jest.spyOn(review, 'withCustomerReviewWriteFence');
    state.candidates = [property()];
    delete process.env.GATE_GEOCODE_REVIEW;
    await sweepUnpinnedProperties();
    expect(fence).toHaveBeenCalledWith('c1', db, expect.any(Function), { lockWhenDisabled: true });
    fence.mockRestore();
    expect(opsOf('customers').some(rec => rec.ops.some(op => op[0] === 'forUpdate'))).toBe(true);
    expect(propertyWrites()).toHaveLength(1);
  });

  test('a review that holds a primary row\'s address blocks the write inside the fence', async () => {
    state.candidates = [property({ is_primary: true })];
    await sweepUnpinnedProperties();
    const write = propertyWrites()[0];
    expect(hasOp(write, 'where', 'is_primary', true)).toBe(true);
    // excludePrimaryPropertyReviewForId: a verified review, or a needs_* review at this row's address, blocks it.
    const blocked = write.ops.find(op => op[0] === 'whereNotExists');
    expect(callbackCalls(blocked[1])).toEqual(expect.arrayContaining([
      ['from', 'customer_geocode_reviews as r'],
      ['where', { 'blocked_primary.id': 'p1', 'blocked_primary.active': true, 'blocked_primary.is_primary': true }],
    ]));
  });

  test.each([
    ['the customer\'s pin', { latitude: '27.50' }],
    ['the customer\'s address', { address_line2: 'Apt 2' }],
  ])('%s changed during the county call: nothing is written, and the next run reads the row again', async (_name, change) => {
    state.candidates = [property()];
    state.customer = customerRow(change);
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 0, unresolved: 1 });
    expect(propertyWrites()).toHaveLength(0);
    expect(_unresolvedProperties.size).toBe(0);
  });

  test('a raced write (row changed since read) lands nothing and is retried next run', async () => {
    state.candidates = [property()];
    mockConfig.update.mockReturnValue(0);
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 0, unresolved: 1 });
    expect(_unresolvedProperties.size).toBe(0);
  });

  test('a property sweep never writes visits', async () => {
    state.candidates = [property({ id: 'p1' }), property({ id: 'p2' })];
    await sweepUnpinnedProperties();
    expect(opsOf('scheduled_services')).toHaveLength(0);
    expect(persistServicePin).not.toHaveBeenCalled();
    expect(refreshScheduleQualityAfterChange).not.toHaveBeenCalled();
  });

  test('a miss is remembered by address: skipped next run, readmitted after an address edit', async () => {
    state.candidates = [property()];
    countyLotPinForAddress.mockResolvedValue(null);
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 0, unresolved: 1 });
    expect(_unresolvedProperties.get('p1')).toBe('104 sample way|parrish|34219');

    mockRecorded = [];
    state.candidates = [];
    state.prune = [{ id: 'p1', address_line1: '104 Sample Way', city: 'Parrish', zip: '34219' }];
    await sweepUnpinnedProperties();
    expect(hasOp(opsOf('customer_properties as p')[0], 'whereNotIn', 'p.id', ['p1'])).toBe(true);

    mockRecorded = [];
    state.prune = [{ id: 'p1', address_line1: '106 Sample Way', city: 'Parrish', zip: '34219' }];
    await sweepUnpinnedProperties();
    expect(_unresolvedProperties.has('p1')).toBe(false);
    expect(hasOp(opsOf('customer_properties as p')[0], 'whereNotIn', 'p.id', ['p1'])).toBe(false);
  });

  test('the exclusion map is capped by dropping the oldest entries', async () => {
    for (let i = 0; i < 2005; i += 1) _unresolvedProperties.set(`x${i}`, 'a|b|c');
    state.prune = [...new Array(2000)].map((_, i) => ({ id: `x${i + 5}`, address_line1: 'a', city: 'b', zip: 'c' }));
    await sweepUnpinnedProperties();
    expect(_unresolvedProperties.size).toBe(2000);
    expect(_unresolvedProperties.has('x0')).toBe(false);
  });

  test('a county outage stops the run: nothing written, nothing remembered', async () => {
    state.candidates = [property({ id: 'p1' }), property({ id: 'p2' })];
    countyLotPinForAddress.mockRejectedValue(new Error('county down'));
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 1, pinned: 0, unresolved: 0 });
    expect(countyLotPinForAddress).toHaveBeenCalledTimes(1);
    expect(_unresolvedProperties.size).toBe(0);
    expect(propertyWrites()).toHaveLength(0);
  });

  test('gate off: no query, no county call', async () => {
    delete process.env.GATE_GEOCODE_COUNTY_FALLBACK;
    expect(await sweepUnpinnedProperties()).toEqual({ checked: 0, pinned: 0, unresolved: 0 });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('sweepPropertyVisitPins', () => {
  test('asks only for the service backstop\'s visits, on an active pinned property of the same customer', async () => {
    await sweepPropertyVisitPins({ now: NOW });
    const query = opsOf('scheduled_services as s')[0];
    const propertyJoin = query.ops.find(op => op[0] === 'join' && op[1] === 'customer_properties as p');
    expect(callbackCalls(propertyJoin[2])).toEqual([['on', 'p.id', '=', 's.property_id'], ['andOn', 'p.customer_id', '=', 's.customer_id']]);
    expect(hasOp(query, 'whereNull', 'c.deleted_at')).toBe(true);
    expect(hasOp(query, 'where', 'p.active', true)).toBe(true);
    expect(hasOp(query, 'whereBetween', 's.scheduled_date', [etDateString(NOW), etDateString(addETDays(NOW, 30))])).toBe(true);
    const status = query.ops.find(op => op[0] === 'where' && typeof op[1] === 'function');
    expect(callbackCalls(status[1])).toEqual([['whereNull', 's.status'], ['orWhereIn', 's.status', ['pending', 'confirmed']]]);
    const raw = query.ops.filter(op => op[0] === 'whereRaw').map(op => op[1]).join('\n');
    expect(raw).toContain('p.latitude IS NOT NULL AND p.longitude IS NOT NULL');
    expect(raw).toContain('NOT COALESCE(s.auto_dispatch_locked, false) AND NOT COALESCE(s.auto_dispatch_excluded, false)');
    expect(raw).toContain('(s.lat IS NULL OR s.lng IS NULL OR s.lat = 0 OR s.lng = 0)');
    expect(raw).toContain("NULLIF(btrim(s.service_address_line1), '') IS NOT NULL");
    expect(hasOp(query, 'limit', 25)).toBe(true);
  });

  test('a visit stamped with its property\'s address takes the pin through the service-location write', async () => {
    state.visitPages = [[visit()]];
    expect(await sweepPropertyVisitPins({ now: NOW })).toEqual({ checked: 1, pinned: 1, stale: 0, failed: 0 });
    expect(persistServicePin).toHaveBeenCalledTimes(1);
    const [conn, snapshot, pin, options] = persistServicePin.mock.calls[0];
    expect(conn).toBe(db);
    expect(Object.keys(snapshot)).toEqual(SNAPSHOT_COLUMNS);
    expect(snapshot).toMatchObject({ id: 'v1', technician_id: 't1', status: 'pending', lat: null, lng: null });
    expect(pin).toEqual({ lat: 27.58, lng: -82.42 });
    expect(options).toEqual({ source: 'property_pin' });
    expect(emitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: 'v1', qualityDates: expect.any(Set) });
    expect(refreshScheduleQualityAfterChange).toHaveBeenCalledTimes(1);
    expect(refreshScheduleQualityAfterChange).toHaveBeenCalledWith({ dates: ['2026-11-05'], now: NOW }, db);
  });

  test('only a stamp that names the property counts; a missing city or ZIP never borrows the property\'s', async () => {
    state.visitPages = [[
      visit({ id: 'exact' }),
      visit({ id: 'spelling', service_address_line1: '104 SAMPLE WAY', service_address_zip: '34219-1234' }),
      visit({ id: 'other-house', service_address_line1: '106 Sample Way' }),
      visit({ id: 'other-unit', service_address_line2: 'Apt 4' }),
      visit({ id: 'other-city', service_address_city: 'Bradenton' }),
      visit({ id: 'no-city', service_address_city: null }),
      visit({ id: 'no-zip', service_address_zip: '' }),
    ]];
    await sweepPropertyVisitPins({ now: NOW });
    expect(persistServicePin.mock.calls.map(call => call[1].id)).toEqual(['exact', 'spelling']);
  });

  test('a full page stamped for other addresses does not starve a later visit', async () => {
    state.visitPages = [[...new Array(25)].map((_, i) => visit({ id: `elsewhere-${i}`, service_address_line1: '106 Sample Way' })), [visit({ id: 'later' })]];
    await sweepPropertyVisitPins({ now: NOW });
    expect(persistServicePin.mock.calls.map(call => call[1].id)).toEqual(['later']);
    expect(hasOp(opsOf('scheduled_services as s')[0], 'offset', 25)).toBe(true);
  });

  test('a refused write counts as stale, a thrown one as failed, and the pass goes on', async () => {
    state.visitPages = [[visit({ id: 'v1', scheduled_date: '2026-11-04' }), visit({ id: 'v2', scheduled_date: '2026-11-05' }),
      visit({ id: 'v3', scheduled_date: '2026-11-06' })]];
    persistServicePin.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('deadlock')).mockResolvedValueOnce(true);
    expect(await sweepPropertyVisitPins({ now: NOW })).toEqual({ checked: 3, pinned: 1, stale: 1, failed: 1 });
    expect(emitDispatchJobUpdate).toHaveBeenCalledTimes(1);
    expect(refreshScheduleQualityAfterChange).toHaveBeenCalledWith({ dates: ['2026-11-06'], now: NOW }, db);
  });

  test('gate off: no query, no write', async () => {
    delete process.env.GATE_GEOCODE_COUNTY_FALLBACK;
    expect(await sweepPropertyVisitPins({ now: NOW })).toEqual({ checked: 0, pinned: 0, stale: 0, failed: 0 });
    expect(db).not.toHaveBeenCalled();
    expect(persistServicePin).not.toHaveBeenCalled();
  });
});

describe('sweepCountyFallback', () => {
  test('gate off: does nothing at all', async () => {
    delete process.env.GATE_GEOCODE_COUNTY_FALLBACK;
    expect(await sweepCountyFallback()).toBeNull();
    expect(db).not.toHaveBeenCalled();
    expect(countyLotPinForAddress).not.toHaveBeenCalled();
  });

  test('a failing needs_pin retry never blocks the property sweep or the visit pass', async () => {
    const spy = jest.spyOn(review, 'retryCountyNeedsPin').mockRejectedValue(new Error('boom'));
    state.candidates = [property()];
    state.visitPages = [[visit()]];
    const results = await sweepCountyFallback();
    spy.mockRestore();
    expect(results.needsPin).toBeUndefined();
    expect(results.properties).toEqual({ checked: 1, pinned: 1, unresolved: 0 });
    expect(results.visits).toEqual({ checked: 1, pinned: 1, stale: 0, failed: 0 });
  });

  test('a failing property sweep still runs the visit pass and reports the needs_pin retry', async () => {
    const spy = jest.spyOn(review, 'retryCountyNeedsPin').mockResolvedValue({ checked: 2, pinned: 1, customerIds: ['c9'] });
    const rows = mockConfig.rows.getMockImplementation();
    mockConfig.rows.mockImplementation((rec) => {
      if (rec.table === 'customer_properties as p') throw new Error('db down');
      return rows(rec);
    });
    state.visitPages = [[visit()]];
    const results = await sweepCountyFallback();
    spy.mockRestore();
    expect(results.needsPin.pinned).toBe(1);
    expect(results.properties).toBeUndefined();
    expect(results.visits.pinned).toBe(1);
    expect(refreshScheduleQualityAfterChange).toHaveBeenCalledWith({ customerIds: ['c9'] });
  });
});
