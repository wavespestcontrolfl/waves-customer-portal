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
function mockRowDb(row, updateBuilder, extra = {}) {
  let cpCalls = 0;
  let ssCalls = 0;
  db.mockImplementation((table) => {
    if (table === 'property_lookups') return builder(undefined);
    if (table === 'customer_properties') {
      cpCalls += 1;
      // 1st customer_properties call = the row fetch; the 2nd is the
      // fill-only UPDATE.
      return cpCalls === 1 ? builder(row) : (updateBuilder || builder(1));
    }
    if (table === 'scheduled_services') {
      // The visit mirror now SELECTS candidates (canonical-key fence in
      // JS) then UPDATEs by id — visitsSeq supplies one builder per call.
      if (extra.visitsSeq) return extra.visitsSeq[Math.min(ssCalls++, extra.visitsSeq.length - 1)];
      return builder([]);
    }
    if (table === 'customers') return extra.customers || builder(undefined);
    return builder(1);
  });
}

function builder(result) {
  const b = {};
  for (const m of ['where', 'first', 'update', 'join', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'orWhereNull', 'select', 'orderBy', 'limit', 'offset', 'insert', 'onConflict', 'merge']) b[m] = jest.fn(() => b);
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
    // update(...) uses RETURNING — resolves to the post-update rows.
    const updateBuilder = builder([{ latitude: 27.4995, longitude: -82.4108, property_type: 'single_family' }]);
    const visitSelect = builder([{
      id: 'v1',
      service_address_line1: '123 Sample Cove', service_address_line2: null,
      service_address_city: 'Bradenton', service_address_zip: '34212',
    }]);
    const visitsBuilder = builder(1);
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34212',
    }, updateBuilder, { visitsSeq: [visitSelect, visitsBuilder] });
    performPropertyLookup.mockResolvedValueOnce({
      satellite: { inServiceArea: true },
      enriched: {
        lat: 27.4995, lng: -82.4108, propertyType: 'Single Family', homeSqFt: 3200,
        _observed: { propertyType: true }, fieldVerifyFlags: [],
      },
    });

    const res = await runCallPropertyLookup({ propertyId: 'p1' });
    expect(res).toEqual({ enriched: true, filled: ['latitude', 'longitude', 'property_type'], complete: true });
    expect(performPropertyLookup).toHaveBeenCalledWith('123 Sample Cove, Bradenton, FL 34212');
    // Linked visits missing their coordinate pair get the same fill.
    expect(visitsBuilder.update).toHaveBeenCalledWith({ lat: 27.4995, lng: -82.4108 });

    const patch = updateBuilder.update.mock.calls[0][0];
    // Atomic coordinate pair: each component writes only when BOTH are null.
    expect(patch.latitude).toMatchObject({ __raw: 'CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE latitude END', bindings: [27.4995] });
    expect(patch.longitude).toMatchObject({ __raw: 'CASE WHEN latitude IS NULL AND longitude IS NULL THEN ? ELSE longitude END', bindings: [-82.4108] });
    expect(patch.property_type).toMatchObject({ __raw: "COALESCE(NULLIF(TRIM(property_type), ''), ?)", bindings: ['single_family'] });
    // sqft semantics belong to the lawn lane — never written here.
    expect(Object.keys(patch)).toEqual(['latitude', 'longitude', 'property_type', 'updated_at']);
  });

  test('visit fill fences by CANONICAL addressKey: designator variants match, other addresses do not', async () => {
    const updateBuilder = builder([{ latitude: 27.4995, longitude: -82.4108, property_type: 'single_family' }]);
    const visitSelect = builder([
      {
        // Linked via the canonical key ("Apt 4" vs the property's "Unit 4",
        // case differs) — a raw string compare orphaned exactly this visit.
        id: 'v-linked',
        service_address_line1: '123 SAMPLE COVE', service_address_line2: 'Apt 4',
        service_address_city: 'Bradenton', service_address_zip: '34212',
      },
      {
        // Stamped with a DIFFERENT address (the pre-edit booking) — the
        // post-edit backfill must never attach coordinates here.
        id: 'v-old-address',
        service_address_line1: '9 Elsewhere Rd', service_address_line2: null,
        service_address_city: 'Bradenton', service_address_zip: '34212',
      },
      {
        // Unstamped legacy row — keys to '' and never matches.
        id: 'v-unstamped',
        service_address_line1: null, service_address_line2: null,
        service_address_city: null, service_address_zip: null,
      },
    ]);
    const visitUpdate = builder(1);
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', address_line2: 'Unit 4', city: 'Bradenton', state: 'FL', zip: '34212',
    }, updateBuilder, { visitsSeq: [visitSelect, visitUpdate] });
    performPropertyLookup.mockResolvedValueOnce({
      satellite: { inServiceArea: true },
      enriched: {
        lat: 27.4995, lng: -82.4108, propertyType: 'Single Family',
        _observed: { propertyType: true }, fieldVerifyFlags: [],
      },
    });
    await runCallPropertyLookup({ propertyId: 'p1' });
    expect(visitUpdate.whereIn).toHaveBeenCalledWith('id', ['v-linked']);
    expect(visitUpdate.update).toHaveBeenCalledWith({ lat: 27.4995, lng: -82.4108 });
  });

  test('null coordinates are never persisted as 0,0; synthesized type never persists', async () => {
    const updateBuilder = builder(1);
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
      address_key: 'key-nofill',
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
    // No durable FACT is written — but the row IS touched (updated_at
    // only), or a completed no-fill lookup (resolved/cache_hit is outside
    // the attempt cooldown) would head the nightly order and consume a
    // batch slot every night (hook P1).
    expect(updateBuilder.update).toHaveBeenCalledTimes(1);
    expect(updateBuilder.update.mock.calls[0][0]).toEqual({ updated_at: 'NOW()' });
    // The touch is fenced to the looked-up address: an address edited or
    // deactivated mid-lookup is a FRESH candidate, not one to park a week.
    expect(updateBuilder.where).toHaveBeenCalledWith({ id: 'p1', address_key: 'key-nofill', active: true });
  });

  test('address edited during the lookup → update matches nothing, result discarded', async () => {
    const updateBuilder = builder([]); // fenced UPDATE matched no rows (RETURNING empty)
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
    const touchBuilder = builder(1);
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
      address_key: 'key-flagged',
    }, touchBuilder);
    performPropertyLookup.mockResolvedValueOnce({
      enriched: {
        lat: 27.5, lng: -82.4, propertyType: 'Single Family',
        _observed: { propertyType: true },
        fieldVerifyFlags: [{ field: 'address', reason: 'number_snapped' }],
      },
    });
    const res = await runCallPropertyLookup({ propertyId: 'p1' });
    expect(res).toEqual({ enriched: true, filled: [], complete: false });
    // The flag-touch carries the same address fence as the no-fill touch.
    expect(touchBuilder.update).toHaveBeenCalledWith({ updated_at: 'NOW()' });
    expect(touchBuilder.where).toHaveBeenCalledWith({ id: 'p1', address_key: 'key-flagged', active: true });
  });

  test('numberless street → skipped before any lookup spend', async () => {
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: 'Main St', city: 'Bradenton', state: 'FL', zip: '34205',
    });
    expect(await runCallPropertyLookup({ propertyId: 'p1' })).toEqual({ skipped: 'incomplete_address' });
    expect(performPropertyLookup).not.toHaveBeenCalled();
  });

  test('primary row mirrors coords to customers but NEVER a commercial type', async () => {
    const customersBuilder = builder({
      id: 'c1', address_line1: '123 Sample Cove', address_line2: null, city: 'Bradenton', zip: '34212',
      latitude: null, longitude: null, property_type: null,
    });
    mockRowDb({
      id: 'p1', customer_id: 'c1', active: true, is_primary: true,
      latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34212',
      address_key: require('../services/customer-properties').addressKey({
        address_line1: '123 Sample Cove', city: 'Bradenton', zip: '34212',
      }),
    }, builder([{ latitude: 27.5, longitude: -82.4, property_type: 'commercial' }]), { customers: customersBuilder });
    performPropertyLookup.mockResolvedValueOnce({
      satellite: { inServiceArea: true },
      enriched: {
        lat: 27.5, lng: -82.4, propertyType: 'Commercial',
        _observed: { propertyType: true }, fieldVerifyFlags: [],
      },
    });
    const res = await runCallPropertyLookup({ propertyId: 'p1' });
    expect(res.filled).toEqual(['latitude', 'longitude', 'property_type']);
    // customers mirror got the coordinate pair…
    const mirror = customersBuilder.update.mock.calls[0][0];
    expect(mirror.latitude).toBeDefined();
    // …but the commercial classification NEVER lands on customers
    // (customers.property_type feeds service_taxability — owner ruling).
    expect(mirror.property_type).toBeUndefined();
  });

  test("commercial SUBTYPES ('Office') store as the literal 'commercial' and never mirror", async () => {
    // Tax, triage, and the mirror guards all test the exact 'commercial'
    // value — a preserved subtype ('office', 'warehouse') would read as
    // residential downstream and slip past the never-mirror fence.
    const customersBuilder = builder({
      id: 'c1', address_line1: '400 Business Blvd', address_line2: null, city: 'Bradenton', zip: '34212',
      latitude: null, longitude: null, property_type: null,
    });
    const updateBuilder = builder([{ latitude: 27.5, longitude: -82.4, property_type: 'commercial' }]);
    mockRowDb({
      id: 'p1', customer_id: 'c1', active: true, is_primary: true,
      latitude: null, longitude: null, property_type: null,
      address_line1: '400 Business Blvd', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34212',
      address_key: require('../services/customer-properties').addressKey({
        address_line1: '400 Business Blvd', city: 'Bradenton', zip: '34212',
      }),
    }, updateBuilder, { customers: customersBuilder });
    performPropertyLookup.mockResolvedValueOnce({
      satellite: { inServiceArea: true },
      enriched: {
        lat: 27.5, lng: -82.4, propertyType: 'Office',
        _observed: { propertyType: true }, fieldVerifyFlags: [],
      },
    });
    await runCallPropertyLookup({ propertyId: 'p1' });
    // The stored value is the canonical literal, not the subtype.
    expect(updateBuilder.update.mock.calls[0][0].property_type.bindings).toEqual(['commercial']);
    const mirror = customersBuilder.update.mock.calls[0]?.[0] || {};
    expect(mirror.property_type).toBeUndefined();
  });

  test("a stored commercial subtype ('office', e.g. admin-typed) never mirrors either", async () => {
    // The guard normalizes rather than string-comparing the literal: a
    // subtype already ON the row (concurrent/admin writer preserved by
    // COALESCE) is still a commercial classification.
    const customersBuilder = builder({
      id: 'c1', address_line1: '400 Business Blvd', address_line2: null, city: 'Bradenton', zip: '34212',
      latitude: null, longitude: null, property_type: null,
    });
    const updateBuilder = builder([{ latitude: 27.5, longitude: -82.4, property_type: 'office' }]);
    mockRowDb({
      id: 'p1', customer_id: 'c1', active: true, is_primary: true,
      latitude: null, longitude: null, property_type: null,
      address_line1: '400 Business Blvd', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34212',
      address_key: require('../services/customer-properties').addressKey({
        address_line1: '400 Business Blvd', city: 'Bradenton', zip: '34212',
      }),
    }, updateBuilder, { customers: customersBuilder });
    performPropertyLookup.mockResolvedValueOnce({
      satellite: { inServiceArea: true },
      enriched: {
        lat: 27.5, lng: -82.4, propertyType: 'Single Family',
        _observed: { propertyType: true }, fieldVerifyFlags: [],
      },
    });
    await runCallPropertyLookup({ propertyId: 'p1' });
    const mirror = customersBuilder.update.mock.calls[0]?.[0] || {};
    expect(mirror.latitude).toBeDefined();
    expect(mirror.property_type).toBeUndefined();
  });

  test("blank property_type is MISSING: the row enriches and the fill won't preserve ''", async () => {
    // Admin edits store '' verbatim; a truthy/IS NULL reading of that blank
    // made such rows permanently unenrichable (skipped as complete once
    // coordinates existed, and COALESCE preserved the '').
    const updateBuilder = builder([{ latitude: 27.4, longitude: -82.5, property_type: 'single_family' }]);
    mockRowDb({
      id: 'p1', active: true, latitude: 27.4, longitude: -82.5, property_type: '',
      address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
    }, updateBuilder);
    performPropertyLookup.mockResolvedValueOnce({
      satellite: { inServiceArea: true },
      enriched: {
        lat: 27.4, lng: -82.5, propertyType: 'Single Family',
        _observed: { propertyType: true }, fieldVerifyFlags: [],
      },
    });
    const res = await runCallPropertyLookup({ propertyId: 'p1' });
    expect(res).toEqual({ enriched: true, filled: ['property_type'], complete: true });
    const patch = updateBuilder.update.mock.calls[0][0];
    expect(patch.property_type).toMatchObject({
      __raw: "COALESCE(NULLIF(TRIM(property_type), ''), ?)", bindings: ['single_family'],
    });
  });

  test('lone-coordinate row with a type is unrepairable → skipped, no spend', async () => {
    mockRowDb({
      id: 'p1', active: true, latitude: 27.4, longitude: null, property_type: 'single_family',
      address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
    });
    expect(await runCallPropertyLookup({ propertyId: 'p1' })).toEqual({ skipped: 'unrepairable_partial' });
    expect(performPropertyLookup).not.toHaveBeenCalled();
  });

  test("whole-profile 'all' verify flag vetoes persistence like an address flag", async () => {
    mockRowDb({
      id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
    });
    performPropertyLookup.mockResolvedValueOnce({
      satellite: { inServiceArea: true },
      enriched: {
        lat: 27.5, lng: -82.4, propertyType: 'Single Family',
        _observed: { propertyType: true },
        fieldVerifyFlags: [{ field: 'all', reason: 'ai_only_record' }],
      },
    });
    expect(await runCallPropertyLookup({ propertyId: 'p1' })).toEqual({ enriched: true, filled: [], complete: false });
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

  test('transient failure retries ONCE at 10m, then leaves the row to the nightly sweep', async () => {
    // A brief provider/DB blip at call time must not strand the row
    // unenriched when the separately gated backfill is off — but each
    // attempt is paid spend and a no-profile result can be deterministic,
    // so exactly one re-buy.
    process.env.GATE_CALL_PROPERTY_LOOKUP = 'true';
    const timeouts = [];
    const spy = jest.spyOn(global, 'setTimeout')
      .mockImplementation((cb, ms) => { timeouts.push({ cb, ms }); return { unref: () => {} }; });
    db.mockImplementation((table) => {
      if (table === 'property_lookups') return builder(undefined);
      if (table === 'customer_properties') {
        return builder({
          id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
          address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
        });
      }
      return builder(1);
    });
    performPropertyLookup.mockRejectedValue(new Error('provider blip'));
    enqueueCallPropertyLookup({ propertyId: 'p1' });
    await flushImmediates();
    await flushImmediates();
    await flushImmediates();
    expect(timeouts.map((t) => t.ms)).toEqual([10 * 60 * 1000]);
    timeouts[0].cb();
    await flushImmediates();
    await flushImmediates();
    await flushImmediates();
    expect(timeouts).toHaveLength(1);
    performPropertyLookup.mockReset();
    spy.mockRestore();
  });

  test('in-flight retry ladder: 3m then 8m (outlasting the 10m pending window), then stops', async () => {
    // A killed process leaves a stale 'pending' ledger stamp; a single
    // 3-minute retry landed inside the 10-minute pending window and skipped
    // again — the row stayed unenriched until the (separately gated)
    // backfill. The second rung (3m+8m=11m) guarantees one attempt after
    // any stamp seen at the first run has aged out of the window.
    process.env.GATE_CALL_PROPERTY_LOOKUP = 'true';
    const timeouts = [];
    const spy = jest.spyOn(global, 'setTimeout')
      .mockImplementation((cb, ms) => { timeouts.push({ cb, ms }); return { unref: () => {} }; });
    db.mockImplementation((table) => {
      if (table === 'property_lookups') return builder({ id: 'stale-pending' });
      if (table === 'customer_properties') {
        return builder({
          id: 'p1', active: true, latitude: null, longitude: null, property_type: null,
          address_line1: '123 Sample Cove', city: 'Bradenton', state: 'FL', zip: '34212',
        });
      }
      return builder(1);
    });
    enqueueCallPropertyLookup({ propertyId: 'p1' });
    await flushImmediates();
    await flushImmediates();
    expect(timeouts.map((t) => t.ms)).toEqual([3 * 60 * 1000]);
    timeouts[0].cb();
    await flushImmediates();
    await flushImmediates();
    expect(timeouts.map((t) => t.ms)).toEqual([3 * 60 * 1000, 8 * 60 * 1000]);
    timeouts[1].cb();
    await flushImmediates();
    await flushImmediates();
    // Still pending past the window = an ACTIVE re-stamped lookup — stop;
    // its result warms the same cache and the nightly sweep catches the row.
    expect(timeouts).toHaveLength(2);
    expect(performPropertyLookup).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('sweepUnenrichedProperties', () => {
  const { sweepUnenrichedProperties } = require('../services/call-property-lookup');

  afterEach(() => {
    delete process.env.GATE_PROPERTY_ENRICH_BACKFILL;
    delete process.env.PROPERTY_BACKFILL_BATCH;
  });

  test('both gates off → skipped before any DB read', async () => {
    expect(await sweepUnenrichedProperties()).toEqual({ skipped: 'gated', visitCoordsReconciled: 0, customerMirrorsReconciled: 0 });
    expect(db).not.toHaveBeenCalled();
  });

  test('backfill off + call gate on → sweep still gated (no paid spend) but reconciliation runs', async () => {
    process.env.GATE_CALL_PROPERTY_LOOKUP = 'true';
    const joined = builder([]);
    db.mockImplementation((table) => {
      if (String(table).startsWith('scheduled_services as ss')) return joined;
      return builder([]);
    });
    const res = await sweepUnenrichedProperties();
    expect(res).toEqual({ skipped: 'gated', visitCoordsReconciled: 0, customerMirrorsReconciled: 0 });
    // The race the reconciliation heals is created by the CALL-TIME lane,
    // so the free scan must not hide behind the paid sweep's budget gate.
    expect(joined.join).toHaveBeenCalled();
    expect(performPropertyLookup).not.toHaveBeenCalled();
  });

  test('enriches candidates up to the batch cap; cooldown rows are skipped without spending', async () => {
    process.env.GATE_PROPERTY_ENRICH_BACKFILL = 'true';
    process.env.PROPERTY_BACKFILL_BATCH = '2';
    const mkRow = (id) => ({
      id, active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Main St', city: 'Bradenton', state: 'FL', zip: '34205',
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
      if (String(table).startsWith('scheduled_services as ss')) return builder([]);
      if (String(table).startsWith('customer_properties as cp')) return builder(candidates);
      if (table === 'property_lookups') {
        ledgerCalls += 1;
        return builder(ledgerCalls === 3 ? { last_attempt_status: 'no_record' } : undefined);
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

  test('park is ledger-based: worked rows skip free, admin edits and cache catch-ups still enrich', async () => {
    process.env.GATE_PROPERTY_ENRICH_BACKFILL = 'true';
    process.env.PROPERTY_BACKFILL_BATCH = '2';
    const mkRow = (id, createdAt, updatedAt) => ({
      id, active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Main St', city: 'Bradenton', state: 'FL', zip: '34205',
      created_at: createdAt, updated_at: updatedAt,
    });
    const candidates = [
      // Productive attempt + the enrich lane's touch (updated_at moved
      // past created_at) → PARKED: no lookup, no batch spend.
      mkRow('p-parked', '2026-08-01T00:00:00Z', '2026-08-13T00:00:00Z'),
      // updated_at recent but NO ledger attempt — an ordinary admin edit
      // (say a ZIP fill that first made the row geocodable) must NEVER
      // park a candidate; property updated_at alone is not attempt
      // evidence.
      mkRow('p-admin-edit', '2026-08-01T00:00:00Z', '2026-08-13T00:00:00Z'),
      // Productive attempt but the row was never worked (in-flight-skip
      // catch-up) → enriched as a near-free cache hit.
      mkRow('p-catchup', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
    ];
    // property_lookups call order: p-parked verdict(1) → p-admin-edit
    // verdict(2) + in-flight(3) → p-catchup verdict(4) + in-flight(5).
    let ledgerCalls = 0;
    let rowFetches = 0;
    db.mockImplementation((table) => {
      if (String(table).startsWith('scheduled_services as ss')) return builder([]);
      if (String(table).startsWith('customer_properties as cp')) return builder(candidates);
      if (table === 'property_lookups') {
        ledgerCalls += 1;
        return builder([1, 4].includes(ledgerCalls) ? { last_attempt_status: 'resolved' } : undefined);
      }
      if (table === 'customer_properties') {
        rowFetches += 1;
        return builder(candidates[rowFetches === 1 ? 1 : 2]);
      }
      return builder(1);
    });
    performPropertyLookup.mockResolvedValue({
      satellite: { inServiceArea: true },
      enriched: { lat: 27.5, lng: -82.5, propertyType: 'Single Family', _observed: { propertyType: true } },
    });

    const res = await sweepUnenrichedProperties();
    expect(res.parked).toBe(1);
    expect(res.cooledDown).toBe(0);
    expect(res.processed).toBe(2);
    expect(res.enriched).toBe(2);
    expect(performPropertyLookup).toHaveBeenCalledTimes(2);
  });

  test('a throwing row is counted failed and never aborts the batch', async () => {
    process.env.GATE_PROPERTY_ENRICH_BACKFILL = 'true';
    process.env.PROPERTY_BACKFILL_BATCH = '2';
    const mkRow = (id) => ({
      id, active: true, latitude: null, longitude: null, property_type: null,
      address_line1: '123 Main St', city: 'Bradenton', state: 'FL', zip: '34205',
    });
    const candidates = [mkRow('p1'), mkRow('p2')];
    let rowFetch = 0;
    db.mockImplementation((table) => {
      if (String(table).startsWith('scheduled_services as ss')) return builder([]);
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

describe('fetchBackfillCandidates', () => {
  const { _private } = require('../services/call-property-lookup');

  test('SQL house-number gate is behavior-parity with hasPrimaryStreetNumber (incl. unit-first forms)', () => {
    // The SQL patterns use only constructs whose semantics coincide in
    // Postgres ARE and JS RegExp ([0-9]/[a-z] classes, \s/\S, ?, *,
    // alternation), so evaluating them in JS pins parity with the
    // authoritative predicate: a form SQL rejects but the enrich guard
    // accepts would be permanently invisible to the sweep.
    const { hasPrimaryStreetNumber } = jest.requireActual('../services/estimator-engine/unit-scope-model');
    const primary = new RegExp(_private.SQL_PRIMARY_NUMBER_RE, 'i');
    const leadingUnit = new RegExp(_private.SQL_LEADING_UNIT_RE, 'i');
    const sqlAccepts = (a) => primary.test(a) || primary.test(a.replace(leadingUnit, ''));
    const corpus = [
      '123 Main St', '123A Main St', '123-125 Main St', '123/2 Main St',
      'Unit 7, 123 Main St', '#12 900 Bayview Ter', 'Apt B 55 Palm Ave',
      'Suite 4 at 200 Cortez Rd', 'Ste 9 77 Beach Dr', 'apartment 2, 8 Oak Ln',
      'Main St', '62nd Avenue East', 'Unit 7', 'Unit 7, Main St',
      'PO Box 123', '', '   ', '# 3, 41 Gulf Dr',
    ];
    for (const a of corpus) {
      expect({ address: a, accepted: sqlAccepts(a) })
        .toEqual({ address: a, accepted: hasPrimaryStreetNumber(a) });
    }
  });

  test('patterns are BOUND (knex.raw eats bare ?); ordering is stable with no updated_at sort key', async () => {
    const cpBuilder = builder([]);
    db.mockImplementation(() => cpBuilder);
    await _private.fetchBackfillCandidates(5, 0);
    const rawCall = cpBuilder.whereRaw.mock.calls.find((c) => String(c[0]).includes('regexp_replace'));
    expect(rawCall).toBeDefined();
    expect(rawCall[1]).toEqual([
      _private.SQL_PRIMARY_NUMBER_RE, _private.SQL_LEADING_UNIT_RE, _private.SQL_PRIMARY_NUMBER_RE,
    ]);
    // Blank types count as missing in the candidate predicate.
    const nullSetCall = cpBuilder.whereRaw.mock.calls.find((c) => String(c[0]).includes('cp.latitude IS NULL'));
    expect(String(nullSetCall[0])).toContain("NULLIF(TRIM(cp.property_type), '') IS NULL");
    // Upcoming priority counts ACTIONABLE visits only — a batch of future
    // cancelled/skipped rows must not outrank real dispatches for the
    // bounded nightly budget.
    const upcomingSelect = db.raw.mock.calls.find((c) => String(c[0]).includes('has_upcoming_visit'));
    expect(String(upcomingSelect[0])).toContain("ss.status NOT IN ('completed', 'cancelled', 'skipped')");
    // The ordering must be STABLE while the sweep runs (the offset
    // accounting depends on it) and must NOT contain an updated_at-derived
    // sort key — that sink parked rows on the wrong evidence (an ordinary
    // admin edit sank a geocodable row with an imminent visit for a week)
    // and moved each looked-up row to the tail mid-sweep, so the advancing
    // offset jumped over unseen candidates. Already-worked rows are parked
    // in the sweep loop off the ATTEMPT LEDGER instead.
    expect(db.raw.mock.calls.some((c) => String(c[0]).includes('recently_touched'))).toBe(false);
    expect(cpBuilder.orderBy).toHaveBeenCalledWith([
      { column: 'has_upcoming_visit', order: 'desc' },
      { column: 'has_estimate', order: 'desc' },
      { column: 'cp.created_at', order: 'desc' },
    ]);
  });
});

describe('reconcileVisitCoordinates', () => {
  const { _private } = require('../services/call-property-lookup');

  test('fills race-inserted null-coordinate visits from the visit side, canonical fence held', async () => {
    // v1: linked stamp is a designator variant of the enriched property
    // ("Apt 4" vs "Unit 4") → reconciled. v2: stamped with a different
    // (pre-edit) address → never touched.
    const prop = {
      latitude: '27.5', longitude: '-82.4',
      address_line1: '123 SAMPLE COVE', address_line2: 'Unit 4', city: 'Bradenton', zip: '34212',
    };
    const joined = builder([
      {
        visit_id: 'v1',
        service_address_line1: '123 Sample Cove', service_address_line2: 'Apt 4',
        service_address_city: 'Bradenton', service_address_zip: '34212',
        ...prop,
      },
      {
        visit_id: 'v2',
        service_address_line1: '9 Elsewhere Rd', service_address_line2: null,
        service_address_city: 'Bradenton', service_address_zip: '34212',
        ...prop,
      },
    ]);
    const upd = builder(1);
    db.mockImplementation((table) => {
      if (String(table).startsWith('scheduled_services as ss')) return joined;
      if (table === 'scheduled_services') return upd;
      return builder(1);
    });
    const filled = await _private.reconcileVisitCoordinates();
    expect(filled).toBe(1);
    expect(upd.where).toHaveBeenCalledTimes(1);
    expect(upd.where).toHaveBeenCalledWith({ id: 'v1' });
    expect(upd.update).toHaveBeenCalledWith({ lat: 27.5, lng: -82.4 });
  });

  test('durable cursor: resumes past the scanned prefix, wraps once, clears on a completed scan', async () => {
    // A permanent residue of unreconcilable rows bigger than one night's
    // page budget must not pin every scan to the same head — the cursor
    // stored in system_settings makes successive nights cover the tail.
    // CHRONOLOGICAL (created_at, id), not id alone: ids are random UUIDs,
    // so an id keyset would exclude rows created after the cursor was
    // persisted whenever the new UUID sorts below it.
    const settingsRead = builder({ value: '2026-08-14T00:00:00.000Z|v-500' });
    const settingsWrite = builder(1);
    let settingsCalls = 0;
    const joinedResumed = builder([]);
    const joinedFromTop = builder([]);
    let joinCalls = 0;
    db.mockImplementation((table) => {
      if (String(table).startsWith('scheduled_services as ss')) {
        return [joinedResumed, joinedFromTop][Math.min(joinCalls++, 1)];
      }
      if (table === 'system_settings') return settingsCalls++ === 0 ? settingsRead : settingsWrite;
      return builder(1);
    });
    await _private.reconcileVisitCoordinates();
    // Resumed from the stored chronological cursor — the timestamp is
    // bound as the STORED TEXT with an explicit ::timestamptz cast, never
    // routed through a JS Date (which truncates PG's microsecond
    // precision; a truncated cursor sorted before a whole same-timestamp
    // page and the scan re-selected that head forever).
    expect(joinedResumed.whereRaw).toHaveBeenCalledWith(
      '(ss.created_at, ss.id) > (?::timestamptz, ?)',
      ['2026-08-14T00:00:00.000Z', 'v-500'],
    );
    // …an empty page past the cursor wraps to the top ONCE (no keyset)…
    const fromTopKeyset = joinedFromTop.whereRaw.mock.calls
      .some((c) => String(c[0]).includes('(ss.created_at, ss.id)'));
    expect(fromTopKeyset).toBe(false);
    // …and the completed scan clears the cursor for the next night.
    expect(settingsWrite.insert).toHaveBeenCalledWith(expect.objectContaining({
      key: 'call_property_lookup.reconcile_visit_cursor', value: null,
    }));
    expect(settingsWrite.merge).toHaveBeenCalledWith(expect.objectContaining({ value: null }));
  });

  test('page-capped scan persists the tail cursor at full database precision', async () => {
    // 20 full pages (the nightly cap) → the run is page-capped, so the
    // NEXT night must resume from tonight's tail, serialized ts|id. The
    // timestamp is PG's ::text rendering, persisted VERBATIM — microseconds
    // included — so a bulk-imported page sharing one sub-millisecond
    // created_at can never pin the cursor before its own rows.
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      visit_id: `v-${i}`,
      visit_created_key: '2026-08-10 12:00:00.123456+00',
      service_address_line1: '9 Elsewhere Rd',
      service_address_city: 'Bradenton',
      service_address_zip: '34212',
      latitude: '27.5',
      longitude: '-82.4',
      address_line1: '123 Sample Cove',
      city: 'Bradenton',
      zip: '34212',
    }));
    const settingsWrite = builder(1);
    let settingsCalls = 0;
    db.mockImplementation((table) => {
      if (String(table).startsWith('scheduled_services as ss')) return builder(fullPage);
      if (table === 'system_settings') return settingsCalls++ === 0 ? builder(undefined) : settingsWrite;
      return builder(1);
    });
    await _private.reconcileVisitCoordinates();
    expect(settingsWrite.insert).toHaveBeenCalledWith(expect.objectContaining({
      key: 'call_property_lookup.reconcile_visit_cursor',
      value: '2026-08-10 12:00:00.123456+00|v-199',
    }));
  });
});

describe('reconcileCustomerMirrors', () => {
  const { _private } = require('../services/call-property-lookup');

  test('fills a stale primary mirror (canonical fence, fill-only, commercial never mirrored)', async () => {
    const base = {
      c_line1: '123 Sample Cove', c_line2: null, c_city: 'Bradenton', c_zip: '34212',
      address_line1: '123 SAMPLE COVE', address_line2: null, city: 'Bradenton', zip: '34212',
    };
    const joined = builder([
      // Coords missing on the customer, present on the primary property.
      { customer_id: 'c1', latitude: '27.5', longitude: '-82.4', cp_type: 'single_family', ...base },
      // Commercial type must never reach customers (taxability ruling) and
      // this row has no coordinate gap → nothing to write, skipped.
      {
        customer_id: 'c2', latitude: null, longitude: null, cp_type: 'commercial', ...base,
      },
      // A commercial SUBTYPE (e.g. admin-typed 'office') is still a
      // commercial classification — the guard normalizes, not string-equals.
      {
        customer_id: 'c4', latitude: null, longitude: null, cp_type: 'office', ...base,
      },
      // Customer address no longer matches the primary property → fenced out.
      {
        customer_id: 'c3', latitude: '27.5', longitude: '-82.4', cp_type: 'single_family',
        ...base, c_line1: '9 Elsewhere Rd',
      },
    ]);
    const upd = builder(1);
    db.mockImplementation((table) => {
      if (String(table).startsWith('customers as c')) return joined;
      if (table === 'customers') return upd;
      return builder(1);
    });
    const filled = await _private.reconcileCustomerMirrors();
    expect(filled).toBe(1);
    expect(upd.where).toHaveBeenCalledTimes(1);
    expect(upd.where).toHaveBeenCalledWith({ id: 'c1' });
    const mirror = upd.update.mock.calls[0][0];
    expect(mirror.latitude).toMatchObject({ bindings: [27.5] });
    expect(mirror.property_type).toMatchObject({ bindings: ['single_family'] });
    // The captured address columns are re-asserted in the UPDATE predicate.
    const reassert = upd.whereRaw.mock.calls[0];
    expect(reassert[1]).toEqual(['123 Sample Cove', '', 'Bradenton', '34212']);
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
