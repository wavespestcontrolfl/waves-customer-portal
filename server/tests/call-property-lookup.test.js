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
      address_line1: '123 Main St', city: 'Bradenton', state: 'FL', zip: '34205',
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

  test('patterns are BOUND (knex.raw eats bare ?); sink is attempt-based and ranks first', async () => {
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
    // recently_touched means MODIFIED AFTER INSERTION — insertion itself
    // stamps updated_at, and a bare-timestamp definition sank every newly
    // created property behind the legacy backlog.
    const touchedSelect = db.raw.mock.calls.find((c) => String(c[0]).includes('recently_touched'));
    expect(String(touchedSelect[0])).toContain('cp.updated_at > cp.created_at');
    // The sink ranks FIRST, across visit classes — upcoming-first ordering
    // let a batch-sized head of partial upcoming rows starve everything.
    expect(cpBuilder.orderBy).toHaveBeenCalledWith([
      { column: 'recently_touched', order: 'asc' },
      { column: 'has_upcoming_visit', order: 'desc' },
      { column: 'has_estimate', order: 'desc' },
      { column: 'cp.created_at', order: 'desc' },
    ]);
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
