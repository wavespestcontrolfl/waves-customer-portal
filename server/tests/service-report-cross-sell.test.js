const { buildReportCrossSell, _private } = require('../services/service-report/cross-sell');

// Recurring rows must be UPCOMING to count as live obligations (the ownership
// loader applies the lifecycle evidence unconditionally) — compute the date so
// the suite never ages out.
const FUTURE_SCHEDULED_DATE = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

function dbForTables(tables = {}, { failCatalogJoin = false } = {}) {
  return (table) => {
    if (failCatalogJoin && table === 'scheduled_services as s') {
      const boom = () => { throw new Error('join failed'); };
      return { leftJoin: boom, where: boom, select: boom };
    }
    const rows = tables[table] || [];
    const q = {
      where() { return q; },
      whereNotIn() { return q; },
      orWhereNull() { return q; },
      leftJoin() { return q; },
      orderBy() { return q; },
      select() { return rows; },
      limit() { return q; },
      first(col) {
        void col;
        return rows[0] || null;
      },
      columnInfo() {
        return table === 'scheduled_services' ? { is_recurring: {} } : {};
      },
    };
    return q;
  };
}

const CUSTOMER = (overrides = {}) => ({
  id: 'cust-1',
  active: true,
  waveguard_tier: 'Bronze',
  monthly_rate: 55,
  property_sqft: 4500,
  lot_sqft: 7000,
  lawn_type: 'St. Augustine',
  address_line1: '123 Gulf Dr',
  city: 'Sarasota',
  state: 'FL',
  zip: '34236',
  ...overrides,
});

const SERVICE = (overrides = {}) => ({
  id: 'sr-1',
  customer_id: 'cust-1',
  address_line1: '123 Gulf Dr',
  city: 'Sarasota',
  zip: '34236',
  ...overrides,
});

function recurringRows(serviceTypes) {
  return serviceTypes.map((service_type, index) => ({
    id: `svc-${index + 1}`,
    service_type,
    scheduled_date: FUTURE_SCHEDULED_DATE,
    status: 'scheduled',
    is_recurring: true,
  }));
}

function dbFor({ customer = CUSTOMER(), serviceTypes = [], turfProfile = null, estimates = [], failCatalogJoin = false } = {}) {
  const scheduled = recurringRows(serviceTypes);
  return dbForTables({
    customers: [customer],
    scheduled_services: scheduled,
    // Catalog join returns the same rows: service_key/service_name stay
    // undefined, so classification falls to service_type text — the plain-row
    // legacy path the classifier documents.
    'scheduled_services as s': scheduled,
    customer_turf_profiles: turfProfile ? [turfProfile] : [],
    estimates,
  }, { failCatalogJoin });
}

// Cache-only lookup default: a miss (null) prices from the profile alone.
const missLookup = async () => null;

describe('offer ladder', () => {
  const { pickOfferTarget, OFFER_LADDER } = _private;

  test('one offer per report, first missing family wins, mosquito never offered', () => {
    expect(OFFER_LADDER).toEqual(['pest_control', 'lawn_care', 'tree_shrub', 'termite']);
    expect(pickOfferTarget([])).toBe('pest_control');
    expect(pickOfferTarget(['pest_control'])).toBe('lawn_care');
    expect(pickOfferTarget(['lawn_care'])).toBe('pest_control');
    expect(pickOfferTarget(['pest_control', 'lawn_care'])).toBe('tree_shrub');
    expect(pickOfferTarget(['pest_control', 'lawn_care', 'tree_shrub'])).toBe('termite');
    // Ownership vocabulary termite_bait maps onto the ladder's termite rung.
    expect(pickOfferTarget(['pest_control', 'lawn_care', 'tree_shrub', 'termite_bait'])).toBe(null);
    // Mosquito ownership occupies no rung — the ladder position is unchanged.
    expect(pickOfferTarget(['mosquito'])).toBe('pest_control');
  });
});

describe('buildReportCrossSell', () => {
  test('pest-only customer is offered lawn care, priced from the turf profile', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
    expect(result.mode).toBe('priced');
    expect(result.option.monthly).toBeGreaterThan(0);
    expect(result.option.cadence).toMatch(/applications/);
  });

  test('lawn-only customer is offered pest control; no cached footprint demotes to quote CTA', async () => {
    const db = dbFor({ serviceTypes: ['Lawn Care'] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    // Home square footage only comes from the lookup; a cache miss must ask,
    // never guess — the card degrades to the unpriced CTA.
    expect(result.mode).toBe('quote_cta');
    expect(result.option).toBeNull();
  });

  test('lawn-only customer with a cached lookup gets a priced pest offer', async () => {
    // A lawn customer carries a measured turf profile; without one the
    // modeled current-lawn baseline raises an estimate-level turf verify
    // flag, and any estimate-level flag demotes the offer to the CTA (the
    // card never shows a price the portal pricing panel would flag).
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    // Stories ride along like a real cached county/vision read would — a
    // DEFAULTED story count is itself a manual-review reason
    // (stories_estimated) and correctly demotes the offer to the CTA.
    const lookup = async () => ({ enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: lookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('priced');
    expect(result.option.monthly).toBeGreaterThan(0);
  });

  test('pest + lawn customer is offered tree & shrub', async () => {
    const db = dbFor({
      customer: CUSTOMER({ bed_sqft: 1200 }),
      serviceTypes: ['Pest Control', 'Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500 },
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('tree_shrub');
  });

  test('pest + lawn + tree & shrub customer is offered termite (owner ruling: not mosquito)', async () => {
    const db = dbFor({ serviceTypes: ['Pest Control', 'Lawn Care', 'Tree & Shrub Care'] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('termite');
  });

  test('customer owning the whole ladder gets no card (referral only)', async () => {
    const db = dbFor({ serviceTypes: ['Pest Control', 'Lawn Care', 'Tree & Shrub Care', 'Termite Bait Monitoring'] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('one-time-only customer (no recurring rows) is offered a pest plan', async () => {
    const db = dbFor({ serviceTypes: [] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('FAIL CLOSED: a broken ownership catalog join suppresses the card entirely', async () => {
    const db = dbFor({ serviceTypes: ['Pest Control'], failCatalogJoin: true });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('commercial property gets no card', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: 'Commercial' }),
      serviceTypes: ['Pest Control'],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('commercial classification from a trusted cached lookup suppresses the card even with a blank stored type', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: null }),
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const lookup = async () => ({ enriched: { propertyType: 'Commercial', homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: lookup });
    expect(result).toBeNull();
  });

  test('multifamily property gets no card (≥5-unit ruling rides normalizePropertyType)', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: 'multifamily' }),
      serviceTypes: ['Pest Control'],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('a report stamped at a different property than the primary is suppressed', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500 },
    });
    const service = SERVICE({ address_line1: '9 Rental Way', city: 'Venice', zip: '34285' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('report-family guard: a pest report with zero upcoming rows never offers pest', async () => {
    // Recurring customer whose next visit isn't seeded yet — ownership sees
    // nothing upcoming, but the report itself proves they buy pest.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control Service' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
  });

  test('one-time report identities (cockroach cleanout) do NOT count as owned pest', async () => {
    const db = dbFor({ serviceTypes: [] });
    const service = SERVICE({ service_type: 'Cockroach Treatment' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('estimate seed prices a pest offer when profile and lookup carry nothing', async () => {
    // The dimensions that priced the customer's live plan fill the gaps —
    // prod audit 2026-08-11: without this, real reports never priced.
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('priced');
    expect(result.option.monthly).toBeGreaterThan(0);
  });

  test('a seed with guessed stories keeps the manual-review demotion (CTA, no price)', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        // No storiesSource on the old estimate → seed replays 'estimated' →
        // stories_estimated manual review → the card refuses the price.
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('quote_cta');
  });

  test('non-accepted estimates never seed a price (drafts/sent/expired refused)', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'sent',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('quote_cta');
  });

  test('an addressless estimate never seeds a customer with a primary street', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('quote_cta');
  });

  test('an estimate stamped at a different street never seeds this property', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '9 Rental Way, Venice, FL 34285',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('quote_cta');
  });

  test('inactive customer gets no card', async () => {
    const db = dbFor({ customer: CUSTOMER({ active: false }), serviceTypes: [] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('missing customer_id or database returns null, never throws', async () => {
    expect(await buildReportCrossSell({}, dbFor({}))).toBeNull();
    expect(await buildReportCrossSell(SERVICE(), null)).toBeNull();
  });
});
