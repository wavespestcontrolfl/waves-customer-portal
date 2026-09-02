/**
 * Report identity snapshot — identity facts frozen at completion must win
 * over the live customer / schedule / technician / catalog joins at render,
 * and records without a snapshot must render exactly as before.
 */

const {
  buildReportIdentitySnapshot,
  applyReportIdentitySnapshot,
  applyReportIdentitySnapshotToLegacyPdf,
  resolveVisitAddress,
  resolveVisitCoordinates,
} = require('../services/service-report/report-identity-snapshot');
const {
  attachApprovedReportProductFacts,
  buildReportV1Data,
} = require('../services/service-report/report-data');

function stubKnex(fixtures = {}) {
  const calls = [];
  const knex = (table) => {
    calls.push(table);
    const rows = fixtures[table] || [];
    const query = {
      where: () => query,
      whereIn: () => query,
      whereNull: () => query,
      whereNotNull: () => query,
      orderBy: () => query,
      modify: () => query,
      limit: () => query,
      select: () => Promise.resolve(rows),
      first: () => Promise.resolve(rows[0] || null),
      catch: () => Promise.resolve(rows),
      then: (resolve) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };
  knex.calls = calls;
  return knex;
}

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

const FROZEN_FACTS = {
  productType: 'pesticide',
  name: 'Celsius WG',
  category: 'herbicide',
  activeIngredient: 'thiencarbazone-methyl',
  epaRegNumber: '432-1507',
  manufacturer: null,
  publicSummary: 'Frozen public summary.',
  serviceReportSummary: 'Frozen report summary.',
  precautionSummary: 'Frozen precaution.',
  reentrySummary: 'Frozen re-entry.',
  reentryHours: 4,
  irrigationNotes: null,
  irrigationRequired: null,
  labelVerifiedAt: '2026-05-30',
  labelVersion: '2026-label',
};

function snapshotFixture(overrides = {}) {
  return buildReportIdentitySnapshot({
    visit: {
      service_type: 'Original Lawn Service',
      service_address_line1: '200 Palm Ave',
      service_address_line2: null,
      service_address_city: 'Parrish',
      service_address_state: 'FL',
      service_address_zip: '34219',
    },
    customer: {
      first_name: 'Original',
      last_name: 'Customer',
      address_line1: '200 Palm Ave',
      address_line2: 'Unit 2',
      city: 'Parrish',
      state: 'FL',
      zip: '34219',
    },
    technicianName: 'Alex Benson',
    productFacts: { [PRODUCT_ID]: FROZEN_FACTS },
    frozenAt: new Date('2026-06-11T15:00:00Z'),
    ...overrides,
  });
}

function liveJoinedRow(serviceData) {
  // What the /:token routes hand buildReportV1Data AFTER the customer was
  // renamed, moved, the visit's service_type edited, and the tech renamed.
  return {
    id: 'record-1',
    customer_id: 'customer-1',
    scheduled_service_id: 'visit-1',
    service_line: 'lawn',
    service_type: 'Original Lawn Service',
    service_date: '2026-06-11',
    first_name: 'Renamed',
    last_name: 'Person',
    address_line1: '999 New Home Dr',
    address_line2: null,
    city: 'Bradenton',
    state: 'FL',
    zip: '34203',
    technician_name: 'Someone Else',
    areas_serviced: '[]',
    structured_notes: '{}',
    service_data: serviceData == null ? null : JSON.stringify(serviceData),
    pressure_index: null,
  };
}

describe('resolveVisitAddress (JS twin of the /:token address COALESCE)', () => {
  const customer = { address_line1: '100 Main St', address_line2: 'Apt 3', city: 'Parrish', state: 'FL', zip: '34219' };

  test('unstamped visit falls back to the primary address including its unit', () => {
    expect(resolveVisitAddress({ visit: {}, customer })).toEqual({
      line1: '100 Main St', line2: 'Apt 3', city: 'Parrish', state: 'FL', zip: '34219',
    });
  });

  test('non-divergent stamp inherits the primary unit', () => {
    expect(resolveVisitAddress({
      visit: { service_address_line1: '100 Main Street', service_address_city: 'Parrish', service_address_zip: '34219-1234' },
      customer,
    })).toMatchObject({ line1: '100 Main Street', line2: 'Apt 3' });
  });

  test('divergent stamp keeps only its own unit line', () => {
    expect(resolveVisitAddress({
      visit: { service_address_line1: '55 Rental Rd', service_address_city: 'Venice', service_address_zip: '34285', service_address_state: 'FL' },
      customer,
    })).toEqual({ line1: '55 Rental Rd', line2: null, city: 'Venice', state: 'FL', zip: '34285' });
  });

  test('stamp with an inline unit does not borrow the primary unit', () => {
    expect(resolveVisitAddress({
      visit: { service_address_line1: '100 Main St Apt 4', service_address_city: 'Parrish', service_address_zip: '34219' },
      customer,
    })).toMatchObject({ line1: '100 Main St Apt 4', line2: null });
  });
});

describe('resolveVisitCoordinates (JS twin of the /:token coordinate COALESCE)', () => {
  const customer = { address_line1: '100 Main St', city: 'Parrish', zip: '34219', latitude: '27.58', longitude: '-82.42' };

  test('stamped visit coords win', () => {
    expect(resolveVisitCoordinates({ visit: { lat: 27.1, lng: -82.1, service_address_line1: '55 Rental Rd' }, customer })).toEqual({ lat: 27.1, lng: -82.1 });
  });

  test('non-divergent stamp without coords falls back to the primary home', () => {
    expect(resolveVisitCoordinates({ visit: { service_address_line1: '100 Main Street' }, customer })).toEqual({ lat: 27.58, lng: -82.42 });
  });

  test('divergent stamp without coords freezes NO centre (no pin beats a wrong pin)', () => {
    expect(resolveVisitCoordinates({ visit: { service_address_line1: '55 Rental Rd', service_address_city: 'Venice', service_address_zip: '34285' }, customer })).toBeNull();
  });
});

describe('applyReportIdentitySnapshot', () => {
  test('returns the same row when no snapshot is present (legacy records unchanged)', () => {
    const row = liveJoinedRow({ protocol: {} });
    expect(applyReportIdentitySnapshot(row)).toBe(row);
    const noData = liveJoinedRow(null);
    expect(applyReportIdentitySnapshot(noData)).toBe(noData);
  });

  test('overlays frozen name, address, technician and exposes the snapshot', () => {
    const snapshot = snapshotFixture();
    const out = applyReportIdentitySnapshot({ ...liveJoinedRow({ reportIdentitySnapshot: snapshot }), technician_first_name: 'Some', technician_last_name: 'Else' });
    expect(out).toMatchObject({
      first_name: 'Original',
      last_name: 'Customer',
      address_line1: '200 Palm Ave',
      address_line2: 'Unit 2',
      city: 'Parrish',
      state: 'FL',
      zip: '34219',
      technician_name: 'Alex Benson',
      technician_first_name: null,
      technician_last_name: null,
    });
    expect(out.report_identity_snapshot).toEqual(snapshot);
  });

  test('freezes the map centre with the address, and nulls a live centre when none was resolved', () => {
    const withCoords = snapshotFixture({
      visit: { service_type: 'X', service_address_line1: '200 Palm Ave', lat: 27.5, lng: -82.5 },
    });
    expect(withCoords.mapCenter).toEqual({ lat: 27.5, lng: -82.5 });
    const live = { ...liveJoinedRow({ reportIdentitySnapshot: withCoords }), customer_latitude: '27.9', customer_longitude: '-82.9' };
    expect(applyReportIdentitySnapshot(live)).toMatchObject({ customer_latitude: 27.5, customer_longitude: -82.5 });

    const noCoords = snapshotFixture({
      visit: { service_type: 'X', service_address_line1: '55 Rental Rd', service_address_city: 'Venice', service_address_zip: '34285' },
    });
    expect(noCoords.mapCenter).toBeNull();
    const liveMoved = { ...liveJoinedRow({ reportIdentitySnapshot: noCoords }), customer_latitude: '27.9', customer_longitude: '-82.9' };
    expect(applyReportIdentitySnapshot(liveMoved)).toMatchObject({ customer_latitude: null, customer_longitude: null });
  });

  test('is idempotent', () => {
    const once = applyReportIdentitySnapshot(liveJoinedRow({ reportIdentitySnapshot: snapshotFixture() }));
    expect(applyReportIdentitySnapshot(once)).toEqual(once);
  });
});

describe('applyReportIdentitySnapshotToLegacyPdf (documents.js generator inputs)', () => {
  test('maps name, serviced address, technician, and product facts; passes through without a snapshot', () => {
    const service = liveJoinedRow({ reportIdentitySnapshot: snapshotFixture() });
    const out = applyReportIdentitySnapshotToLegacyPdf({
      customer: { id: 'c1', first_name: 'Renamed', last_name: 'Person', address_line1: '999 New Home Dr', city: 'Bradenton', zip: '34203' },
      service,
      products: [{ product_id: PRODUCT_ID.toUpperCase(), product_name: null, epa_reg_number: null }, { product_id: 'other', product_name: 'Bare' }],
    });
    expect(out.customer).toMatchObject({ id: 'c1', first_name: 'Original', last_name: 'Customer', address_line1: '200 Palm Ave', address_line2: 'Unit 2', city: 'Parrish', zip: '34219' });
    expect(out.service.technician_name).toBe('Alex Benson');
    expect(out.service.service_type).toBe('Original Lawn Service');
    expect(out.products[0]).toMatchObject({ product_name: 'Celsius WG', epa_reg_number: '432-1507' });
    expect(out.products[1]).toEqual({ product_id: 'other', product_name: 'Bare' });

    const legacy = { customer: { first_name: 'Live' }, service: liveJoinedRow(null), products: [] };
    expect(applyReportIdentitySnapshotToLegacyPdf(legacy)).toEqual(legacy);
  });
});

describe('buildReportIdentitySnapshot degrades per leg', () => {
  test('a missing customer row omits customer AND address; a missing tech omits technicianName', () => {
    const snapshot = buildReportIdentitySnapshot({
      visit: { service_type: 'Original Lawn Service', service_address_line1: '200 Palm Ave' },
      customer: null,
      technicianName: null,
      productFacts: undefined,
    });
    expect(snapshot).toEqual({
      version: 1,
      frozenAt: expect.any(String),
      serviceTitle: 'Original Lawn Service',
    });
    // The overlay then leaves every live identity value in place.
    const live = liveJoinedRow({ reportIdentitySnapshot: snapshot });
    const out = applyReportIdentitySnapshot(live);
    expect(out).toMatchObject({
      first_name: 'Renamed',
      address_line1: '999 New Home Dr',
      technician_name: 'Someone Else',
    });
    expect(out.report_identity_snapshot).toEqual(snapshot);
  });
});

describe('attachApprovedReportProductFacts with frozen facts', () => {
  test('frozen ids never hit the catalog; a null freeze stays bare', async () => {
    const knex = jest.fn(() => { throw new Error('catalog must not be queried'); });
    const products = await attachApprovedReportProductFacts(knex, [
      { product_id: PRODUCT_ID, product_name: null, epa_reg_number: null },
      { product_id: 'not-approved-at-completion', product_name: 'Bare' },
    ], { frozenFacts: { [PRODUCT_ID]: FROZEN_FACTS, 'not-approved-at-completion': null } });
    expect(knex).not.toHaveBeenCalled();
    expect(products[0]).toMatchObject({
      product_name: 'Celsius WG',
      epa_reg_number: '432-1507',
      approved_report_product_facts: FROZEN_FACTS,
    });
    expect(products[1].approved_report_product_facts).toBeUndefined();
  });

  test('frozen keys are canonical: an upper-case request id still resolves its frozen facts', async () => {
    const snapshot = buildReportIdentitySnapshot({ visit: {}, productFacts: { [PRODUCT_ID.toUpperCase()]: FROZEN_FACTS } });
    expect(Object.keys(snapshot.productFacts)).toEqual([PRODUCT_ID]);
    const knex = jest.fn(() => { throw new Error('catalog must not be queried'); });
    const [product] = await attachApprovedReportProductFacts(knex, [{ product_id: PRODUCT_ID.toUpperCase() }], { frozenFacts: snapshot.productFacts });
    expect(product.approved_report_product_facts).toEqual(FROZEN_FACTS);
  });

  test('a failed live enrichment keeps the frozen facts and still flags the failure', async () => {
    const chain = { whereIn: jest.fn(() => chain), select: jest.fn(() => Promise.reject(new Error('db down'))) };
    const knex = jest.fn(() => chain);
    const products = await attachApprovedReportProductFacts(knex, [
      { product_id: PRODUCT_ID },
      { product_id: 'live-id' },
    ], { frozenFacts: { [PRODUCT_ID]: FROZEN_FACTS } });
    expect(products.catalogEnrichmentFailed).toBe(true);
    expect(products[0].approved_report_product_facts).toEqual(FROZEN_FACTS);
    expect(products[1].approved_report_product_facts).toBeUndefined();
  });

  test('ids absent from the frozen map still resolve live', async () => {
    const chain = {
      whereIn: jest.fn(() => chain),
      select: jest.fn(() => Promise.resolve([{
        id: 'live-id', name: 'Live Product', category: 'insecticide', product_type: 'pesticide',
        epa_reg_number: '100-200', approved_for_service_report: true,
      }])),
    };
    const knex = jest.fn(() => chain);
    const products = await attachApprovedReportProductFacts(knex, [
      { product_id: PRODUCT_ID },
      { product_id: 'live-id' },
    ], { frozenFacts: { [PRODUCT_ID]: FROZEN_FACTS } });
    expect(chain.whereIn).toHaveBeenCalledWith('id', ['live-id']);
    expect(products[0].approved_report_product_facts).toEqual(FROZEN_FACTS);
    expect(products[1].approved_report_product_facts).toMatchObject({ epaRegNumber: '100-200' });
  });
});

describe('buildReportV1Data renders identity from the snapshot', () => {
  const liveFixtures = {
    scheduled_services: [{ id: 'visit-1', service_id: null, service_type: 'Renamed Lawn Service' }],
    service_products: [{
      id: 'sp-1', product_id: PRODUCT_ID, product_name: null, product_category: null,
      active_ingredient: null, epa_reg_number: null, application_method: 'broadcast_spray',
      application_rate: 1, rate_unit: 'oz', total_amount: 2, amount_unit: 'oz',
    }],
    products_catalog: [{
      id: PRODUCT_ID, name: 'Celsius WG (relabeled)', category: 'herbicide', product_type: 'pesticide',
      epa_reg_number: '999-9999', approved_for_service_report: true,
      customer_precaution_summary: 'LIVE precaution.',
    }],
  };

  test('snapshot wins over renamed customer, edited service_type, renamed tech, edited catalog', async () => {
    const data = await buildReportV1Data(
      liveJoinedRow({ reportIdentitySnapshot: snapshotFixture() }),
      'token-1',
      stubKnex(liveFixtures),
    );
    expect(data.customerName).toBe('Original Customer');
    expect(data.serviceDisplayName).toBe('Original Lawn Service');
    expect(data.technicianName).toBe('Alex B.');
    expect(data.serviceAddress).toContain('200 Palm Ave');
    expect(data.serviceAddress).not.toContain('999 New Home');
    // Map centre follows the frozen address, not the live customer row.
    expect(data.mapCenter).toBeNull();
    const application = (data.applications || []).find((a) => a.productId === PRODUCT_ID || a.product_id === PRODUCT_ID)
      || (data.applications || [])[0];
    expect(JSON.stringify(application)).toContain('432-1507');
    expect(JSON.stringify(application)).not.toContain('999-9999');
  });

  test('legacy record (no snapshot) keeps the live join behavior', async () => {
    const data = await buildReportV1Data(
      liveJoinedRow({ protocol: {} }),
      'token-2',
      stubKnex(liveFixtures),
    );
    expect(data.customerName).toBe('Renamed Person');
    expect(data.serviceDisplayName).toBe('Renamed Lawn Service');
    expect(data.technicianName).toBe('Someone E.');
    expect(data.serviceAddress).toContain('999 New Home');
  });
});
