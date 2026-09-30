const areas = require('../services/property-service-areas');
const { addressKey } = require('../services/customer-properties');

test('lookup estimates round fractional square feet for review without relaxing saved input validation', () => {
  expect(areas.lookupSuggestions({ estimatedBedAreaSf: 1200.5, estimatedTurfSf: 4999.4, turfSource: 'vision' })).toMatchObject({
    beds: { sqft: 1201, source: 'imagery', reviewedAt: null }, lawn: { sqft: 4999, source: 'imagery', reviewedAt: null },
  });
  expect(areas.lookupSuggestions({ estimatedBedAreaSf: -0.1 })).toEqual({});
  expect(() => areas.validateAreaChanges({ beds: { sqft: 1200.5, source: 'field' } })).toThrow();
});

test.each([null, [], {}, { other: { sqft: 100, source: 'field' } },
  { beds: { sqft: '100', source: 'field' } }, { beds: { sqft: -1, source: 'field' } },
  { beds: { sqft: 0.5, source: 'field' } }, { beds: { sqft: 1000001, source: 'field' } },
  { beds: { sqft: 100, source: 'unknown' } }])('rejects invalid review payload %j', input => {
  expect(() => areas.validateAreaChanges(input)).toThrow();
});
test('the review writer accepts zero and rejects client review stamps', () => {
  expect(areas.validateAreaChanges({ beds: { sqft: 0, source: 'imagery', reviewedAt: 'fake', reviewedBy: 'fake' } }))
    .toEqual({ beds: { sqft: 0, source: 'imagery' } });
});
test('missing/unknown or unobservable turf is not an observed zero', () => {
  expect(areas.lookupSuggestions({ estimatedTurfSf: 0, turfSource: 'none' })).toEqual({});
  expect(areas.lookupSuggestions({ estimatedTurfSf: 1000, turfSource: 'vision', turfObservation: 'unobservable' })).toEqual({});
  expect(areas.lookupSuggestions({ estimatedTurfSf: 0, turfSource: 'vision' }).lawn.sqft).toBe(0);
});
test('a changed legacy bed measurement withdraws the review instead of attaching it to the new value', () => {
  const property = { id: 'property', address_line1: '100 Fixture St', city: 'Fixture', zip: '34201', bed_sqft: 600 };
  property.service_area_measurements = { addressKey: addressKey(property), areas: { beds: { sqft: 500, source: 'field', reviewedBy: 'staff', reviewedAt: '2026-09-27' } } };
  expect(areas.reviewedAreas(property)).toEqual({});
});
test('the gate is opt-in, including tests and development', async () => {
  delete process.env.GATE_PROPERTY_SERVICE_AREAS;
  expect(areas.propertyServiceAreasEnabled()).toBe(false);
  await expect(areas.snapshotVisitArea({ malformed: true })).resolves.toBeNull();
});

// ---- Mock-knex coverage (no Postgres) --------------------------------------
function makeKnex(tables) {
  const knex = table => {
    let preds = {};
    const q = {
      where(p) { preds = { ...preds, ...p }; return q; },
      forUpdate() { return q; },
      async first() { return (tables[table] || []).find(r => Object.entries(preds).every(([k, v]) => r[k] === v)); },
    };
    return q;
  };
  knex.schema = { hasColumn: jest.fn(async () => true) };
  return knex;
}
const admin = { techRole: 'admin', technicianId: 'admin-1' };
const fixtureProperty = (extra = {}) => ({
  id: 'prop-1', customer_id: 'cust-1', active: true, is_primary: false, address_line1: '100 Fixture St',
  city: 'Fixture', state: 'FL', zip: '34201', bed_sqft: null, property_sqft: null, ...extra,
});
const scope = { customerId: 'cust-1', propertyId: 'prop-1' };

describe('readAreaMeasurements without a database', () => {
  test('falls back to the property recorded lawn area when no turf profile exists', async () => {
    const knex = makeKnex({ customer_properties: [fixtureProperty({ property_sqft: 3100 })] });
    const lookup = jest.fn().mockResolvedValue(null);
    const read = await areas.readAreaMeasurements(scope, admin, { knex, lookup });
    expect(read.areas.lawn).toEqual({ sqft: 3100, source: 'recorded', reviewedAt: null });
    // The editor compares this to tell an address change from a measurement edit.
    expect(read.addressKey).toBe(require('../services/customer-properties').addressKey(fixtureProperty({ property_sqft: 3100 })));
  });

  test('the primary turf profile overrides the property recorded lawn area', async () => {
    const property = fixtureProperty({ is_primary: true, property_sqft: 3100 });
    const customer = { id: 'cust-1', address_line1: property.address_line1, address_line2: null, city: property.city, state: 'FL', zip: property.zip };
    const knex = makeKnex({ customer_properties: [property], customers: [customer], customer_turf_profiles: [{ customer_id: 'cust-1', lawn_sqft: 2800 }] });
    const read = await areas.readAreaMeasurements(scope, admin, { knex, lookup: jest.fn().mockResolvedValue(null) });
    expect(read.areas.lawn.sqft).toBe(2800);
  });

  test('a repeat refresh inside the cooldown reuses the cache instead of going upstream', async () => {
    const knex = makeKnex({ customer_properties: [fixtureProperty()] });
    const lookup = jest.fn().mockResolvedValue({ enriched: { estimatedBedAreaSf: 800.5 } });
    // The shared claim grants the first refresh and refuses the repeat.
    const claimRefresh = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const first = await areas.readAreaMeasurements(scope, admin, { knex, refresh: true, lookup, claimRefresh });
    expect(lookup).toHaveBeenLastCalledWith(expect.any(String), { refresh: true });
    expect(first.areas.beds.sqft).toBe(801);
    await areas.readAreaMeasurements(scope, admin, { knex, refresh: true, lookup, claimRefresh });
    expect(claimRefresh).toHaveBeenCalledWith(lookup.mock.calls[0][0]);
    expect(lookup).toHaveBeenLastCalledWith(expect.any(String), { cacheOnly: true, persist: false });
    expect(lookup.mock.calls.filter(([, options]) => options.refresh)).toHaveLength(1);
  });

  test('a failed live refresh returns a fixed message, not the upstream error text', async () => {
    const knex = makeKnex({ customer_properties: [fixtureProperty()] });
    const lookup = jest.fn().mockRejectedValue(new Error('provider https://upstream.example/?key=SECRET timed out'));
    const warn = jest.spyOn(require('../services/logger'), 'warn').mockImplementation(() => {});
    const failure = await areas.readAreaMeasurements(scope, admin, { knex, refresh: true, lookup, claimRefresh: async () => true }).catch(error => error);
    expect(failure).toMatchObject({ status: 502, isOperational: true });
    expect(failure.message).not.toMatch(/SECRET|upstream/);
    // The server log gets a stable code only, never the upstream message.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=Error'));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRET|upstream|Fixture/);
    warn.mockRestore();
  });

  test('an ordinary read never claims a live refresh', async () => {
    const knex = makeKnex({ customer_properties: [fixtureProperty()] });
    const claimRefresh = jest.fn();
    await areas.readAreaMeasurements(scope, admin, { knex, lookup: jest.fn().mockResolvedValue(null), claimRefresh });
    expect(claimRefresh).not.toHaveBeenCalled();
  });
});

describe('snapshotVisitArea for untreated incomplete visits', () => {
  let isolated;
  beforeEach(() => {
    process.env.GATE_PROPERTY_SERVICE_AREAS = 'true';
    jest.isolateModules(() => {
      jest.doMock('../services/technician-visit-scope', () => ({
        technicianCurrentVisitFilter: (req, query) => query,
        lockOwnedLiveVisit: jest.fn(),
      }));
      jest.doMock('../services/lawn-assessment-history', () => ({
        visitEvidence: () => ({}), scopeForAssessment: async () => ({ propertyId: 'prop-1' }),
      }));
      isolated = require('../services/property-service-areas');
    });
  });
  afterEach(() => {
    delete process.env.GATE_PROPERTY_SERVICE_AREAS;
    jest.dontMock('../services/technician-visit-scope');
    jest.dontMock('../services/lawn-assessment-history');
  });
  const setup = () => {
    const property = fixtureProperty({ property_sqft: 4000 });
    property.service_area_measurements = { addressKey: addressKey(property), areas: { lawn: { sqft: 4000, source: 'field', reviewedAt: 'r', reviewedBy: 't' } } };
    const knex = makeKnex({ customer_properties: [property], scheduled_services: [{ id: 'svc-1', customer_id: 'cust-1' }] });
    const service = { id: 'svc-1', service_type: 'Lawn Care' };
    const input = treatedSqft => ({ propertyId: 'prop-1', version: isolated.areaVersion(property, null), kind: 'lawn', treatedSqft });
    return { knex, service, input };
  };

  test('the reviewed default is not frozen for an incomplete visit with no treatment evidence', async () => {
    const { knex, service, input } = setup();
    expect(await isolated.snapshotVisitArea(input(4000), service, admin, knex, { treatmentEvidence: false })).toBeNull();
  });
  test('an explicit override is still recorded on an untreated incomplete visit', async () => {
    const { knex, service, input } = setup();
    expect(await isolated.snapshotVisitArea(input(2500), service, admin, knex, { treatmentEvidence: false }))
      .toMatchObject({ treatedSqft: 2500, propertyAreaSqft: 4000, kind: 'lawn' });
  });
  test('an override the tech set equal to the reviewed area is recorded on an untreated incomplete visit', async () => {
    const { knex, service, input } = setup();
    expect(await isolated.snapshotVisitArea({ ...input(4000), explicitVisitArea: true }, service, admin, knex, { treatmentEvidence: false }))
      .toMatchObject({ treatedSqft: 4000 });
  });
  test('the default is recorded when products were applied (or the visit completed)', async () => {
    const { knex, service, input } = setup();
    expect(await isolated.snapshotVisitArea(input(4000), service, admin, knex)).toMatchObject({ treatedSqft: 4000 });
    expect(await isolated.snapshotVisitArea(input(4000), service, admin, knex, { treatmentEvidence: true })).toMatchObject({ treatedSqft: 4000 });
  });
});

test('the area-column probe caches only a positive answer', async () => {
  const knex = makeKnex({});
  knex.schema.hasColumn.mockResolvedValueOnce(false);
  const fresh = require('../services/property-service-areas');
  expect(await fresh.hasAreaMeasurementsColumn(knex)).toBe(false);
  expect(await fresh.hasAreaMeasurementsColumn(knex)).toBe(true);
  knex.schema.hasColumn.mockResolvedValue(false);
  expect(await fresh.hasAreaMeasurementsColumn(knex)).toBe(true);
  expect(knex.schema.hasColumn).toHaveBeenCalledTimes(2);
});
