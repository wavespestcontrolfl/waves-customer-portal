/**
 * Auto property-lookup for call-pipeline property rows.
 *
 * Pins: the gate contract (off → enqueue is a no-op and run skips before
 * any DB read), the pay-only-when-missing guard, the COALESCE fill-only
 * patch (never overwrites, sqft never written), the property_type
 * vocabulary normalization, and enqueue's never-throws-into-the-pipeline
 * contract.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  fn.fn = { now: () => 'NOW()' };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/property-lookup-v2', () => ({ performPropertyLookup: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { performPropertyLookup } = require('../routes/property-lookup-v2');
const {
  runCallPropertyLookup,
  enqueueCallPropertyLookup,
  _private: { snakePropertyType },
} = require('../services/call-property-lookup');

const flushImmediates = () => new Promise((resolve) => setImmediate(resolve));

// Table-aware single-row mock: customer_properties → the row; the
// property_lookups ledger (in-flight dedupe) → empty; updates → 1 row.
function mockRowDb(row, updateBuilder) {
  let cpCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'property_lookups') return builder(undefined);
    if (table === 'customer_properties') {
      cpCalls += 1;
      // 1st customer_properties call = the row fetch; the 2nd is the
      // fill-only UPDATE.
      return cpCalls === 1 ? builder(row) : (updateBuilder || builder(1));
    }
    return builder(1);
  });
}

function builder(result) {
  const b = {};
  for (const m of ['where', 'first', 'update', 'join', 'whereIn', 'whereRaw', 'whereNull', 'orWhereNull', 'select', 'orderBy', 'limit', 'offset']) b[m] = jest.fn(() => b);
  b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return b;
}

afterEach(() => {
  delete process.env.GATE_CALL_PROPERTY_LOOKUP;
  jest.clearAllMocks();
});

describe('gate contract', () => {
  test('run: gate off → skipped before any DB read', async () => {
    expect(await runCallPropertyLookup({ propertyId: 'p1' })).toEqual({ skipped: 'gated' });
    expect(db).not.toHaveBeenCalled();
  });

  test('enqueue: gate off → no-op (nothing scheduled)', async () => {
    enqueueCallPropertyLookup({ propertyId: 'p1' });
    await flushImmediates();
    expect(db).not.toHaveBeenCalled();
    expect(performPropertyLookup).not.toHaveBeenCalled();
  });
});

describe('runCallPropertyLookup', () => {
  beforeEach(() => { process.env.GATE_CALL_PROPERTY_LOOKUP = 'true'; });

  test('missing/inactive row → skipped, no lookup spend', async () => {
    db.mockImplementation(() => builder(undefined));
    expect(await runCallPropertyLookup({ propertyId: 'p1' })).toEqual({ skipped: 'missing' });
    expect(performPropertyLookup).not.toHaveBeenCalled();
  });

  test('already-enriched row → skipped, no lookup spend', async () => {
    mockRowDb({
      id: 'p1', active: true, latitude: 27.4, longitude: -82.5, property_type: 'single_family',
    });
    expect(await runCallPropertyLookup({ propertyId: 'p1' })).toEqual({ skipped: 'complete' });
    expect(performPropertyLookup).not.toHaveBeenCalled();
  });

  test('fill-only patch: COALESCE lat/lng/type, snake_case vocabulary, no sqft ever', async () => {
    const updateBuilder = builder(1);
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34212',
    }, updateBuilder);
    performPropertyLookup.mockResolvedValueOnce({
      satellite: { inServiceArea: true },
      enriched: {
        lat: 27.4995, lng: -82.4108, propertyType: 'Single Family', homeSqFt: 3200,
        _observed: { propertyType: true }, fieldVerifyFlags: [],
      },
    });

    const res = await runCallPropertyLookup({ propertyId: 'p1' });
    expect(res).toEqual({ enriched: true, filled: ['latitude', 'longitude', 'property_type'], complete: true });
    expect(performPropertyLookup).toHaveBeenCalledWith('123 Sample Cove, Bradenton, FL, 34212');

    const patch = updateBuilder.update.mock.calls[0][0];
    // Atomic coordinate pair: each component writes only when BOTH are null.
    expect(patch.latitude).toMatchObject({ __raw: 'CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE latitude END', bindings: [27.4995] });
    expect(patch.longitude).toMatchObject({ __raw: 'CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE longitude END', bindings: [-82.4108] });
    expect(patch.property_type).toMatchObject({ __raw: 'COALESCE(property_type, ?)', bindings: ['single_family'] });
    // sqft semantics belong to the lawn lane — never written here.
    expect(Object.keys(patch)).toEqual(['latitude', 'longitude', 'property_type', 'updated_at']);
  });

  test('null coordinates are never persisted as 0,0; synthesized type never persists', async () => {
    const updateBuilder = builder(1);
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
    }, updateBuilder);
    // Geocode failed (null coords) and the type is the synthesized display
    // default (_observed.propertyType false) → nothing durable is written.
    performPropertyLookup.mockResolvedValueOnce({
      enriched: {
        lat: null, lng: null, propertyType: 'Single Family',
        _observed: { propertyType: false }, fieldVerifyFlags: [],
      },
    });
    const res = await runCallPropertyLookup({ propertyId: 'p1' });
    expect(res).toEqual({ enriched: true, filled: [], complete: false });
    expect(updateBuilder.update).not.toHaveBeenCalled();
  });

  test('address edited during the lookup → update matches nothing, result discarded', async () => {
    const updateBuilder = builder(0); // fenced UPDATE matched no rows
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
      address_key: 'oldkey',
    }, updateBuilder);
    performPropertyLookup.mockResolvedValueOnce({
      satellite: { inServiceArea: true },
      enriched: {
        lat: 27.5, lng: -82.4, propertyType: 'Single Family',
        _observed: { propertyType: true }, fieldVerifyFlags: [],
      },
    });
    const res = await runCallPropertyLookup({ propertyId: 'p1' });
    expect(res).toEqual({ enriched: true, filled: [], complete: false });
    // The fence includes the address key captured at read time.
    expect(updateBuilder.where).toHaveBeenCalledWith({ id: 'p1', address_key: 'oldkey', active: true });
  });

  test('address field-verify flag → cache warmed but nothing persisted', async () => {
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
    });
    performPropertyLookup.mockResolvedValueOnce({
      enriched: {
        lat: 27.5, lng: -82.4, propertyType: 'Single Family',
        _observed: { propertyType: true },
        fieldVerifyFlags: [{ field: 'address', reason: 'number_snapped' }],
      },
    });
    const res = await runCallPropertyLookup({ propertyId: 'p1' });
    expect(res).toEqual({ enriched: true, filled: [], complete: false });
  });

  test('street without ZIP → skipped before any lookup spend', async () => {
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', city: null, state: 'FL', zip: null,
    });
    expect(await runCallPropertyLookup({ propertyId: 'p1' })).toEqual({ skipped: 'incomplete_address' });
    expect(performPropertyLookup).not.toHaveBeenCalled();
  });

  test('no enriched profile → reports enriched:false, writes nothing', async () => {
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '1 Nowhere Rd', city: 'Bradenton', state: 'FL', zip: '34205',
    });
    performPropertyLookup.mockResolvedValueOnce({ enriched: null });
    expect(await runCallPropertyLookup({ propertyId: 'p1' })).toEqual({ enriched: false });
  });
});

describe('enqueueCallPropertyLookup', () => {
  test('a lookup failure is swallowed and logged — never thrown into the pipeline', async () => {
    process.env.GATE_CALL_PROPERTY_LOOKUP = 'true';
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
    });
    performPropertyLookup.mockRejectedValueOnce(new Error('trio timeout'));
    enqueueCallPropertyLookup({ propertyId: 'p1' });
    await flushImmediates();
    await flushImmediates();
    expect(logger.warn).toHaveBeenCalledWith('[call-property-lookup] failed', expect.objectContaining({ propertyId: 'p1' }));
  });
});

describe('sweepUnenrichedProperties', () => {
  const { sweepUnenrichedProperties } = require('../services/call-property-lookup');

  afterEach(() => {
    delete process.env.GATE_PROPERTY_ENRICH_BACKFILL;
    delete process.env.PROPERTY_BACKFILL_BATCH;
  });

  test('gate off → skipped before any DB read (independent of the per-call gate)', async () => {
    process.env.GATE_CALL_PROPERTY_LOOKUP = 'true'; // other lane's gate must not leak in
    expect(await sweepUnenrichedProperties()).toEqual({ skipped: 'gated' });
    expect(db).not.toHaveBeenCalled();
  });

  test('enriches candidates up to the batch cap; cooldown rows are skipped without spending', async () => {
    process.env.GATE_PROPERTY_ENRICH_BACKFILL = 'true';
    process.env.PROPERTY_BACKFILL_BATCH = '2';
    const mkRow = (id) => ({
      id, active: true, latitude: null, longitude: null, property_type: null,
      address_line1: `${id} Main St`, city: 'Bradenton', state: 'FL', zip: '34205',
    });
    const candidates = [mkRow('p1'), mkRow('p2'), mkRow('p3')];
    // property_lookups sees the cooldown check per candidate AND the
    // in-flight check inside each processed row. Per-row order: cooldown →
    // row fetch → in-flight → update. Sequence: p1 cooldown(1), p1
    // in-flight(2), p2 cooldown(3, "recent" → cooled), p3 cooldown(4), p3
    // in-flight(5). Row fetches: p1 then p3.
    let ledgerCalls = 0;
    let rowFetches = 0;
    db.mockImplementation((table) => {
      if (String(table).startsWith('customer_properties as cp')) return builder(candidates);
      if (table === 'property_lookups') {
        ledgerCalls += 1;
        return builder(ledgerCalls === 3 ? { last_attempt_at: 'recent' } : undefined);
      }
      if (table === 'customer_properties') {
        rowFetches += 1;
        return builder(candidates[rowFetches === 1 ? 0 : 2]);
      }
      return builder(1);
    });
    performPropertyLookup.mockResolvedValue({
      satellite: { inServiceArea: true },
      enriched: { lat: 27.5, lng: -82.5, propertyType: 'Single Family', _observed: { propertyType: true } },
    });

    const res = await sweepUnenrichedProperties();
    // p1 enriched, p2 cooled down (no lookup), p3 enriched — cap honored.
    expect(res.processed).toBe(2);
    expect(res.enriched).toBe(2);
    expect(res.cooledDown).toBe(1);
    expect(performPropertyLookup).toHaveBeenCalledTimes(2);
  });

  test('a throwing row is counted failed and never aborts the batch', async () => {
    process.env.GATE_PROPERTY_ENRICH_BACKFILL = 'true';
    process.env.PROPERTY_BACKFILL_BATCH = '2';
    const mkRow = (id) => ({
      id, active: true, latitude: null, longitude: null, property_type: null,
      address_line1: `${id} Main St`, city: 'Bradenton', state: 'FL', zip: '34205',
    });
    const candidates = [mkRow('p1'), mkRow('p2')];
    let rowFetch = 0;
    db.mockImplementation((table) => {
      if (String(table).startsWith('customer_properties as cp')) return builder(candidates);
      if (table === 'property_lookups') return builder(undefined);
      if (table === 'customer_properties') { rowFetch += 1; return builder(candidates[rowFetch <= 1 ? 0 : 1]); }
      return builder(1);
    });
    performPropertyLookup
      .mockRejectedValueOnce(new Error('trio timeout'))
      .mockResolvedValueOnce({ satellite: { inServiceArea: true }, enriched: { lat: 27.5, lng: -82.5, propertyType: 'Townhome', _observed: { propertyType: true } } });

    const res = await sweepUnenrichedProperties();
    expect(res.processed).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.enriched).toBe(1);
  });
});

describe('snakePropertyType', () => {
  test.each([
    ['Single Family', 'single_family'],
    ['Townhome', 'townhome'],
    ['Multi-Family', 'multi_family'],
    ['Commercial', 'commercial'],
    ['', null],
    [null, null],
  ])('%s → %s', (input, expected) => {
    expect(snakePropertyType(input)).toBe(expected);
  });
});
