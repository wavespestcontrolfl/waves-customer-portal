// buildPortalOffer — the portal-home variant of the report cross-sell card
// (portal roadmap bet 2, owner rulings 2026-08-13). The offer matrix itself
// is pinned cell-by-cell in service-report-cross-sell.test.js; this suite
// pins the PORTAL-SPECIFIC deltas: no identity-start (owns-nothing → no
// offer), the always-required single-premises proof, and that the shared
// demotion rules still hold on this entry point.

jest.mock('../services/property-lookup/lookup-cache', () => ({
  hasVerifiedOverrides: jest.fn(async () => false),
}));

const { buildPortalOffer } = require('../services/service-report/cross-sell');
const { hasVerifiedOverrides } = require('../services/property-lookup/lookup-cache');

const FUTURE_SCHEDULED_DATE = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

// Same minimal knex fake as the report suite (kept in sync by hand — the
// fixture builder is test scaffolding, not a production surface).
function dbForTables(tables = {}) {
  const dbFn = (table) => {
    const rows = tables[table] || [];
    const q = {
      where() { return q; },
      whereNotIn() { return q; },
      orWhereNull() { return q; },
      leftJoin() { return q; },
      orderBy() { return q; },
      select() { return rows; },
      limit() { return q; },
      first() { return rows[0] || null; },
      whereNotNull() { return q; },
      distinct() { return rows; },
      columnInfo() {
        return table === 'scheduled_services'
          ? {
            is_recurring: {},
            service_address_line1: {},
            service_address_line2: {},
            service_address_city: {},
            service_address_zip: {},
          }
          : {};
      },
    };
    return q;
  };
  dbFn.schema = { hasTable: async (name) => Object.prototype.hasOwnProperty.call(tables, name) };
  return dbFn;
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

function recurringRows(serviceTypes) {
  return serviceTypes.map((service_type, index) => ({
    id: `svc-${index + 1}`,
    service_type,
    scheduled_date: FUTURE_SCHEDULED_DATE,
    status: 'scheduled',
    is_recurring: true,
  }));
}

function dbFor({ customer = CUSTOMER(), serviceTypes = [], planRates = [] } = {}) {
  const scheduled = recurringRows(serviceTypes);
  return dbForTables({
    customers: [customer],
    customer_properties: [],
    scheduled_services: scheduled,
    'scheduled_services as s': scheduled,
    customer_turf_profiles: [],
    estimates: [],
    customer_plan_rates: planRates,
  });
}

const missLookup = async () => null;

beforeEach(() => {
  hasVerifiedOverrides.mockClear();
  hasVerifiedOverrides.mockImplementation(async () => false);
});

describe('buildPortalOffer', () => {
  test('pest+lawn recurring → the matrix target (tree & shrub) with a fingerprint', async () => {
    const db = dbFor({ serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'] });
    const offer = await buildPortalOffer('cust-1', db, { propertyLookup: missLookup });
    expect(offer).not.toBeNull();
    expect(offer.serviceKey).toBe('tree_shrub');
    expect(offer.relationship).toBe('add');
    expect(['priced', 'quote_cta']).toContain(offer.mode);
    expect(typeof offer.fingerprint).toBe('string');
    expect(offer.fingerprint.length).toBeGreaterThan(0);
    // Per-application is the only price field the payload may carry.
    if (offer.mode === 'priced') {
      expect(offer.option.perVisit).toBeGreaterThan(0);
      expect(offer.option.monthly).toBeUndefined();
      expect(offer.option.annual).toBeUndefined();
    }
  });

  test('owns NOTHING recurring → no offer (portal has no identity-start branch; one-time services are never pushed)', async () => {
    const db = dbFor({ serviceTypes: [] });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('owns everything → no offer (owner matrix: the referral card fills the slot)', async () => {
    const db = dbFor({
      serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program', 'Tree & Shrub Care', 'Termite Bait Program'],
    });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('inactive customer → no offer', async () => {
    const db = dbFor({ customer: CUSTOMER({ active: false }), serviceTypes: ['Quarterly Pest Control'] });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('no provable primary premises (blank address) → no offer', async () => {
    const db = dbFor({
      customer: CUSTOMER({ address_line1: null, city: null, zip: null }),
      serviceTypes: ['Quarterly Pest Control'],
    });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('multi-home account (has_multi_home) → no offer (single-premises proof is always required)', async () => {
    const db = dbFor({
      customer: CUSTOMER({ has_multi_home: true }),
      serviceTypes: ['Quarterly Pest Control'],
    });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });

  test('a verified correction on file demotes to the quote CTA (no price on stale facts)', async () => {
    hasVerifiedOverrides.mockImplementation(async () => true);
    const db = dbFor({ serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'] });
    const offer = await buildPortalOffer('cust-1', db, { propertyLookup: missLookup });
    if (offer) {
      expect(offer.mode).toBe('quote_cta');
      expect(offer.option).toBeNull();
    }
  });

  test('a live plan-rate on the target family suppresses the offer entirely', async () => {
    const db = dbFor({
      serviceTypes: ['Quarterly Pest Control', 'Lawn Care Program'],
      planRates: [{ family_key: 'tree_shrub', monthly_rate: 40 }],
    });
    expect(await buildPortalOffer('cust-1', db, { propertyLookup: missLookup })).toBeNull();
  });
});
