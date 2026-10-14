// The estimate is the source of the customer's treatable lawn size (owner
// ruling 2026-10-04). Pure rules: which estimate figure counts as CONFIRMED,
// which property it applies to, the bounds, and the shared writer's three
// places + audit row, against an in-memory fake knex.
const mockAudit = jest.fn(async () => 'audit-1');
let mockColumn = true;
jest.mock('../services/audit-log', () => ({ auditLawnSqftFromEstimate: (...a) => mockAudit(...a) }));
jest.mock('../services/property-service-areas', () => ({ hasAreaMeasurementsColumn: async () => mockColumn }));
jest.mock('../services/customer-pricing-ai', () => ({ withTurfProfileFence: async (db, _id, work) => work(db.__trx) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const sync = require('../services/lawn-size-sync');

const ADDR = { address_line1: '100 Main St', address_line2: null, city: 'Bradenton', zip: '34205' };

function fakeDb({ customer = {}, turf, primary = {}, properties = [] } = {}) {
  const state = {
    customers: { id: 'c1', ...ADDR, property_sqft: null, ...customer },
    turf: turf === undefined ? null : { customer_id: 'c1', ...turf },
    primary: primary === null ? null : { id: 'p1', customer_id: 'c1', is_primary: true, active: true, ...ADDR, property_sqft: null, service_area_measurements: { areas: { lawn: { sqft: 1 } } }, ...primary },
    properties,
    writes: [],
  };
  const trx = (table) => {
    const q = {
      where: () => q,
      first: async () => {
        if (table === 'customers') return state.customers;
        if (table === 'customer_turf_profiles') return state.turf;
        if (table === 'customer_properties') return state.primary || properties[0] || null;
        return null;
      },
      insert: (row) => { q.row = row; return q; },
      onConflict: () => q,
      merge: async (patch) => { state.writes.push({ table, op: 'upsert', row: q.row, patch }); state.turf = { ...(state.turf || {}), ...q.row, ...patch }; },
      update: async (patch) => {
        state.writes.push({ table, op: 'update', patch });
        if (table === 'customers') state.customers = { ...state.customers, ...patch };
        if (table === 'customer_properties' && state.primary) state.primary = { ...state.primary, ...patch };
      },
    };
    return q;
  };
  trx.raw = (sql) => ({ raw: sql });
  trx.fn = { now: () => 'NOW' };
  const db = { __trx: trx, state };
  return db;
}

const pricedLine = (over = {}) => ({ service: 'lawn_care', lawnSqFt: 5200, turfBasis: 'measuredTurfSf', turfEstimated: false, ...over });
const adminEstimate = (over = {}) => ({ engineResult: { lineItems: [pricedLine(over)] }, engineRequest: { profile: { measuredTurfSf: 5200 } } });

describe('saneLawnSqft bounds', () => {
  test('accepts whole numbers 1..1,000,000 (numbers and digit strings)', () => {
    expect(sync.saneLawnSqft(1)).toBe(1);
    expect(sync.saneLawnSqft(5200)).toBe(5200);
    expect(sync.saneLawnSqft('5200')).toBe(5200);
    expect(sync.saneLawnSqft(1000000)).toBe(1000000);
  });
  test('rejects zero, negatives, fractions, blanks, text and over the ceiling', () => {
    for (const bad of [0, -5, 5200.5, '', null, undefined, 'abc', '12abc', 1000001, NaN, Infinity, true, {}]) {
      expect(sync.saneLawnSqft(bad)).toBeNull();
    }
  });
});

describe('confirmedLawnSqftFromEstimate', () => {
  test('admin tool: the priced line on a measuredTurfSf basis is the confirmed size', () => {
    expect(sync.confirmedLawnSqftFromEstimate(adminEstimate())).toEqual({
      sqft: 5200, field: 'lineItems[lawn_care].lawnSqFt', basis: 'measuredTurfSf', source: 'priced_line',
    });
  });
  test('an explicit lawnSqFt basis counts as confirmed too', () => {
    expect(sync.confirmedLawnSqftFromEstimate(adminEstimate({ turfBasis: 'lawnSqFt' })).sqft).toBe(5200);
  });
  test('v1-mapped lawnMeta (lsf) is read when no engine line carries the basis', () => {
    const data = { result: { results: { lawnMeta: { lsf: 6100, turfBasis: 'measuredTurfSf', turfEstimated: false } } } };
    expect(sync.confirmedLawnSqftFromEstimate(data)).toMatchObject({ sqft: 6100, field: 'results.lawnMeta.lsf' });
  });
  test('a JSON string estimate_data parses', () => {
    expect(sync.confirmedLawnSqftFromEstimate(JSON.stringify(adminEstimate())).sqft).toBe(5200);
  });
  test.each(['estimatedTurfSf', 'countyPrior', 'plausibleMaxTurfCap', 'legacyHardscapeEstimate', 'lotFallback'])(
    'AI / lot basis %s is never written',
    (basis) => {
      expect(sync.confirmedLawnSqftFromEstimate(adminEstimate({ turfBasis: basis, turfEstimated: true })))
        .toEqual({ sqft: null, reason: 'unconfirmed_estimate', basis });
    },
  );
  test('an AI figure sitting next to a typed request figure is still unconfirmed (the priced line decides)', () => {
    const data = { engineResult: { lineItems: [pricedLine({ turfBasis: 'estimatedTurfSf', turfEstimated: true })] }, engineRequest: { profile: { measuredTurfSf: 9999 } } };
    expect(sync.confirmedLawnSqftFromEstimate(data).reason).toBe('unconfirmed_estimate');
  });
  test('a confirmed zero is not a lawn size', () => {
    expect(sync.confirmedLawnSqftFromEstimate(adminEstimate({ lawnSqFt: 0 }))).toMatchObject({ sqft: null, reason: 'no_positive_size' });
  });
  test('out-of-range and fractional figures are implausible', () => {
    expect(sync.confirmedLawnSqftFromEstimate(adminEstimate({ lawnSqFt: 2000000 })).reason).toBe('implausible_size');
    expect(sync.confirmedLawnSqftFromEstimate(adminEstimate({ lawnSqFt: 5200.5 })).reason).toBe('implausible_size');
  });
  test('two lawn lines that disagree are conflicting', () => {
    const data = { engineResult: { lineItems: [pricedLine({ lawnSqFt: 5000 }), pricedLine({ lawnSqFt: 7000 })] } };
    expect(sync.confirmedLawnSqftFromEstimate(data).reason).toBe('conflicting_sizes');
  });
  test('agent estimate that echoes the customer saved size (propertyFacts) is not a confirmation', () => {
    const data = { ...adminEstimate(), propertyFacts: { treatable_lawn_sqft: { value: 5200, source: 'recorded' } } };
    expect(sync.confirmedLawnSqftFromEstimate(data).reason).toBe('saved_size_echo');
  });
  test('automated lead draft that bound the profile size (measuredTurfUnitVerified) is an echo', () => {
    const data = { engineInput: { measuredTurfSf: 5200, measuredTurfUnitVerified: true }, engineResult: { lineItems: [pricedLine()] } };
    expect(sync.confirmedLawnSqftFromEstimate(data).reason).toBe('saved_size_echo');
  });
  test('legacy save with no priced basis falls back to the typed request figure', () => {
    const data = { engineRequest: { profile: { measuredTurfSf: '4800' } }, result: { lineItems: [{ service: 'lawn_care', perApp: 60 }] } };
    expect(sync.confirmedLawnSqftFromEstimate(data)).toEqual({ sqft: 4800, field: 'engineRequest.profile.measuredTurfSf', basis: null, source: 'request_input' });
  });
  test('no lawn figure at all', () => {
    expect(sync.confirmedLawnSqftFromEstimate({})).toEqual({ sqft: null, reason: 'no_lawn_size' });
    expect(sync.confirmedLawnSqftFromEstimate(null)).toEqual({ sqft: null, reason: 'no_lawn_size' });
  });
});

describe('unconfirmedLawnGuessFromEstimate', () => {
  const ai = (over = {}) => adminEstimate({ turfBasis: 'estimatedTurfSf', turfEstimated: true, lawnSqFt: 4793, ...over });
  test('returns the priced AI figure with its basis', () => {
    expect(sync.unconfirmedLawnGuessFromEstimate(ai())).toEqual({ sqft: 4793, basis: 'estimatedTurfSf', field: 'lineItems[lawn_care].lawnSqFt', flag: null });
  });
  test('rounds a fractional AI figure; flags under 500 and over 20,000', () => {
    expect(sync.unconfirmedLawnGuessFromEstimate(ai({ lawnSqFt: 4793.4 })).sqft).toBe(4793);
    expect(sync.unconfirmedLawnGuessFromEstimate(ai({ lawnSqFt: 499 })).flag).toBe('under_500');
    expect(sync.unconfirmedLawnGuessFromEstimate(ai({ lawnSqFt: 500 })).flag).toBeNull();
    expect(sync.unconfirmedLawnGuessFromEstimate(ai({ lawnSqFt: 20000 })).flag).toBeNull();
    expect(sync.unconfirmedLawnGuessFromEstimate(ai({ lawnSqFt: 20001 })).flag).toBe('over_20000');
  });
  test('no guess from a confirmed estimate, a zero, or a saved-size echo', () => {
    expect(sync.unconfirmedLawnGuessFromEstimate(adminEstimate()).reason).toBe('has_confirmed_size');
    expect(sync.unconfirmedLawnGuessFromEstimate(ai({ lawnSqFt: 0 })).reason).toBe('no_positive_size');
    expect(sync.unconfirmedLawnGuessFromEstimate({ ...ai(), propertyFacts: { treatable_lawn_sqft: {} } }).reason).toBe('saved_size_echo');
    expect(sync.unconfirmedLawnGuessFromEstimate({}).reason).toBe('no_priced_basis');
  });
});

describe('applyEstimateLawnSqft with allowUnconfirmedWhenEmpty (backfill opt-in)', () => {
  const estimate = { id: 'e1', property_id: null, address: '100 Main St, Bradenton, FL 34205' };
  const aiData = (over = {}) => adminEstimate({ turfBasis: 'estimatedTurfSf', turfEstimated: true, lawnSqFt: 4793, ...over });
  beforeEach(() => { mockAudit.mockClear(); mockColumn = true; });

  test('empty customer: the guess is written and the audit row records the basis and source', async () => {
    const db = fakeDb({ turf: undefined });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: aiData(), trigger: 'backfill_unconfirmed', allowUnconfirmedWhenEmpty: true });
    expect(out).toMatchObject({ status: 'written', sqft: 4793 });
    expect(db.state.turf.lawn_sqft).toBe(4793);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ trigger: 'backfill_unconfirmed', basis: 'estimatedTurfSf', source: 'unconfirmed_estimate', sqft: 4793 });
  });
  test('without the option the same AI estimate is skipped', async () => {
    const db = fakeDb({ turf: undefined });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: aiData() });
    expect(out).toMatchObject({ status: 'skipped', reason: 'unconfirmed_estimate' });
    expect(db.state.writes).toEqual([]);
  });
  test.each([
    ['turf', { turf: { lawn_sqft: 4000 } }],
    ['customer mirror', { turf: undefined, customer: { property_sqft: 3000 } }],
    ['primary mirror', { turf: undefined, primary: { property_sqft: 3000 } }],
  ])('existing size in the %s is never overwritten by a guess (checked under the lock)', async (_n, setup) => {
    const db = fakeDb(setup);
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: aiData(), trigger: 'backfill_unconfirmed', allowUnconfirmedWhenEmpty: true });
    expect(out).toMatchObject({ status: 'skipped', reason: 'has_size' });
    expect(db.state.writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });
  test('a guess under 500 or over 20,000 is not written', async () => {
    for (const [sqft, reason] of [[300, 'guess_under_500'], [25000, 'guess_over_20000']]) {
      const db = fakeDb({ turf: undefined });
      const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: aiData({ lawnSqFt: sqft }), allowUnconfirmedWhenEmpty: true });
      expect(out).toMatchObject({ status: 'skipped', reason });
      expect(db.state.writes).toEqual([]);
    }
  });
  test('a confirmed estimate still takes the confirmed path (and overwrites) even with the option on', async () => {
    const db = fakeDb({ turf: { lawn_sqft: 4000 } });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate(), allowUnconfirmedWhenEmpty: true });
    expect(out).toMatchObject({ status: 'written', sqft: 5200 });
  });
});

describe('applyOwnerSetLawnSqft', () => {
  beforeEach(() => { mockAudit.mockClear(); mockColumn = true; });
  test('fills an empty size; audit row has trigger owner_set, the reason and no estimate id', async () => {
    const db = fakeDb({ turf: undefined });
    const out = await sync.applyOwnerSetLawnSqft(db, { customerId: 'c1', sqft: 1300, reason: 'owner ruling: newest unaccepted estimate' });
    expect(out).toMatchObject({ status: 'written', sqft: 1300 });
    expect(db.state.turf.lawn_sqft).toBe(1300);
    expect(db.state.customers.property_sqft).toBe(1300);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ customer_id: 'c1', estimate_id: null, sqft: 1300, trigger: 'owner_set', source: 'owner_set', reason: 'owner ruling: newest unaccepted estimate', trx: db.__trx });
  });
  test.each([['turf', { turf: { lawn_sqft: 4000 } }], ['customer', { turf: undefined, customer: { property_sqft: 3000 } }], ['primary', { turf: undefined, primary: { property_sqft: 3000 } }]])('refuses to overwrite a size in the %s', async (_n, setup) => {
    const db = fakeDb(setup);
    const out = await sync.applyOwnerSetLawnSqft(db, { customerId: 'c1', sqft: 1300, reason: 'r' });
    expect(out).toMatchObject({ status: 'skipped', reason: 'has_size' });
    expect(db.state.writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });
  test('out of bounds or no reason: nothing happens, not even the fence', async () => {
    const db = fakeDb({ turf: undefined });
    expect((await sync.applyOwnerSetLawnSqft(db, { customerId: 'c1', sqft: 499, reason: 'r' })).reason).toBe('out_of_bounds');
    expect((await sync.applyOwnerSetLawnSqft(db, { customerId: 'c1', sqft: 20001, reason: 'r' })).reason).toBe('out_of_bounds');
    expect((await sync.applyOwnerSetLawnSqft(db, { customerId: 'c1', sqft: 1300, reason: '  ' })).reason).toBe('reason_required');
    expect(db.state.writes).toEqual([]);
  });
  test('revalidate aborts the write', async () => {
    const db = fakeDb({ turf: undefined });
    const out = await sync.applyOwnerSetLawnSqft(db, { customerId: 'c1', sqft: 1300, reason: 'r', revalidate: async () => 'turf none -> 3300' });
    expect(out).toMatchObject({ status: 'skipped', reason: 'changed_since_read' });
    expect(db.state.writes).toEqual([]);
  });
});

describe('estimateTargetsPrimary', () => {
  const customer = { id: 'c1', ...ADDR };
  const primary = { id: 'p1', ...ADDR };
  test('a linked property_id must be the primary', () => {
    expect(sync.estimateTargetsPrimary({ property_id: 'p1' }, customer, primary)).toEqual({ match: true });
    expect(sync.estimateTargetsPrimary({ property_id: 'p2' }, customer, primary)).toMatchObject({ match: false, reason: 'other_property', targetPropertyId: 'p2' });
  });
  test('an unlinked estimate must quote the customer own address', () => {
    expect(sync.estimateTargetsPrimary({ address: '100 Main St, Bradenton, FL 34205' }, customer, primary)).toEqual({ match: true });
    expect(sync.estimateTargetsPrimary({ address: '9 Other Rd, Bradenton, FL 34205' }, customer, primary)).toMatchObject({ match: false, reason: 'other_property' });
  });
  test('no property link and no address is unmatched (no evidence)', () => {
    expect(sync.estimateTargetsPrimary({ address: '' }, customer, primary)).toMatchObject({ match: false, reason: 'unmatched' });
    expect(sync.estimateTargetsPrimary({}, customer, primary)).toMatchObject({ match: false, reason: 'unmatched' });
  });
  test('a new customer with no primary property row yet still matches on the quoted address', () => {
    expect(sync.estimateTargetsPrimary({ address: '100 Main St, Bradenton, FL 34205' }, customer, null)).toEqual({ match: true });
    expect(sync.estimateTargetsPrimary({ address: '9 Other Rd, Bradenton, FL 34205' }, customer, null).reason).toBe('other_property');
  });
  test('a linked property_id cannot be checked without a primary row: unmatched', () => {
    expect(sync.estimateTargetsPrimary({ property_id: 'p1' }, customer, null)).toMatchObject({ match: false, reason: 'unmatched' });
  });
});

describe('applyEstimateLawnSqft', () => {
  const estimate = { id: 'e1', property_id: null, address: '100 Main St, Bradenton, FL 34205' };
  beforeEach(() => { mockAudit.mockClear(); mockColumn = true; });

  test('estimate wins over an existing turf size: three places move, review withdrawn, one audit row', async () => {
    const db = fakeDb({ turf: { lawn_sqft: 4000 }, customer: { property_sqft: 3000 }, primary: { property_sqft: 3500 } });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate() });
    expect(out).toMatchObject({ status: 'written', sqft: 5200 });
    expect(out.before).toEqual({ turf_lawn_sqft: 4000, primary_property_id: 'p1', primary_property_sqft: 3500, customer_property_sqft: 3000 });
    expect(out.after).toMatchObject({ turf_lawn_sqft: 5200, primary_property_sqft: 5200, customer_property_sqft: 5200 });
    expect(db.state.turf.lawn_sqft).toBe(5200);
    expect(db.state.customers.property_sqft).toBe(5200);
    expect(db.state.primary.property_sqft).toBe(5200);
    expect(db.state.primary.service_area_measurements).toEqual({ raw: "service_area_measurements #- '{areas,lawn}'" });
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({ customer_id: 'c1', estimate_id: 'e1', sqft: 5200, trigger: 'acceptance', basis: 'measuredTurfSf', trx: db.__trx });
  });

  test('first profile: inserts the turf row', async () => {
    const db = fakeDb({ turf: undefined });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate() });
    expect(out.status).toBe('written');
    expect(out.before.turf_lawn_sqft).toBeNull();
    expect(db.state.writes.find((w) => w.table === 'customer_turf_profiles').row).toEqual({ customer_id: 'c1', lawn_sqft: 5200 });
  });

  test('already equal everywhere: nothing written, no audit row', async () => {
    const db = fakeDb({ turf: { lawn_sqft: 5200 }, customer: { property_sqft: 5200 }, primary: { property_sqft: 5200 } });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate() });
    expect(out.status).toBe('unchanged');
    expect(db.state.writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('turf already right but a mirror is stale: mirrors move, turf row untouched', async () => {
    const db = fakeDb({ turf: { lawn_sqft: 5200 }, customer: { property_sqft: 1800 }, primary: { property_sqft: 1800 } });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate() });
    expect(out.status).toBe('written');
    expect(db.state.writes.some((w) => w.table === 'customer_turf_profiles')).toBe(false);
    expect(db.state.customers.property_sqft).toBe(5200);
  });

  test('AI/lot estimate: nothing is touched', async () => {
    const db = fakeDb({ turf: { lawn_sqft: 4000 } });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate({ turfBasis: 'estimatedTurfSf', turfEstimated: true }) });
    expect(out).toMatchObject({ status: 'skipped', reason: 'unconfirmed_estimate' });
    expect(db.state.writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('estimate for another property: nothing written; the target property is reported', async () => {
    const db = fakeDb({ turf: { lawn_sqft: 4000 }, properties: [{ id: 'p2', customer_id: 'c1', property_sqft: 2500 }] });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate: { id: 'e2', property_id: 'p2' }, estimateData: adminEstimate() });
    expect(out).toMatchObject({ status: 'skipped', reason: 'other_property', sqft: 5200, targetPropertyId: 'p2' });
    expect(db.state.writes).toEqual([]);
  });

  test('no primary property row yet: turf size and customers.property_sqft move (the lazily created primary will not inherit a stale size)', async () => {
    const db = fakeDb({ turf: { lawn_sqft: 4000 }, customer: { property_sqft: 3000 }, primary: null });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate() });
    expect(out).toMatchObject({ status: 'written', before: { primary_property_id: null, customer_property_sqft: 3000 } });
    expect(db.state.customers.property_sqft).toBe(5200);
    expect(db.state.turf.lawn_sqft).toBe(5200);
    expect(db.state.writes.some((w) => w.table === 'customer_properties')).toBe(false);
  });

  test('before the service-areas migration the mirrors stay put, the turf size still moves', async () => {
    mockColumn = false;
    const db = fakeDb({ turf: { lawn_sqft: 4000 }, customer: { property_sqft: 3000 } });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate() });
    expect(out.status).toBe('written');
    expect(out.mirrorsSynced).toBe(false);
    expect(db.state.customers.property_sqft).toBe(3000);
    expect(db.state.turf.lawn_sqft).toBe(5200);
  });

  test('revalidate runs inside the fence before any read or write; a reason aborts the write', async () => {
    const db = fakeDb({ turf: { lawn_sqft: 4000 } });
    const revalidate = jest.fn(async (trx) => { expect(trx).toBe(db.__trx); return 'estimate e1 -> e2'; });
    const out = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate(), revalidate });
    expect(out).toMatchObject({ status: 'skipped', reason: 'changed_since_read', detail: 'estimate e1 -> e2' });
    expect(db.state.writes).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
    const ok = await sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate(), revalidate: async () => null });
    expect(ok.status).toBe('written');
  });

  test('a database error propagates so the acceptance caller can fail soft', async () => {
    const db = fakeDb({ turf: { lawn_sqft: 4000 } });
    mockAudit.mockRejectedValueOnce(new Error('audit insert failed'));
    await expect(sync.applyEstimateLawnSqft(db, { customerId: 'c1', estimate, estimateData: adminEstimate() })).rejects.toThrow('audit insert failed');
  });
});
