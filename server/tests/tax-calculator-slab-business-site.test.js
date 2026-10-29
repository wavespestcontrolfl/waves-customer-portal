/**
 * GATE_SLAB_BUSINESS_SITE_TAX: with GATE_SLAB_HOME_NO_TAX on, every slab name
 * that does not say Commercial is billed as a home job, and the catalog has no
 * Commercial slab service. Florida taxes a slab pre-treat at a nonresidential
 * building (Rule 12A-1.009), so with this gate on a commercial account's slab
 * job keeps the county tax when its serviced property has Occupancy
 * "Commercial". Builders' home sites and every non-commercial account keep the
 * home-slab answer; gate off changes nothing.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const TaxCalculator = require('../services/tax-calculator');

const MANATEE_ZIP = require('../config/county-zips').MANATEE_ZIPS[0];

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const HOME_ID = '44444444-4444-4444-8444-444444444444';
const VISIT_ID = '33333333-3333-4333-8333-333333333333';

const SLAB = 'Slab Pre-Treat Termite Service';
const TAXABILITY = [
  { service_key: 'pest_recurring', service_label: 'Recurring Pest Control', is_taxable: true, residential_taxable: false, fl_statute_ref: 'FL §212.05(1)(i)1' },
];

// A knex stand-in: builder methods chain, where() objects are kept, a callback
// runs with the builder as `this`, and first() answers by table, so the test
// sees which rows the calculator read.
function fakeDb({ propertyType = 'commercial', buildingUse = null, properties = {}, visits = {} } = {}) {
  const calls = [];
  const conn = (table) => {
    const where = {};
    let label = null;
    const builder = {
      where(arg, op, value) {
        if (typeof arg === 'function') arg.call(builder, builder);
        else if (arg && typeof arg === 'object') Object.assign(where, arg);
        else if (arg === 'service_key' && op && value === undefined) label = label || op;
        return builder;
      },
      orWhere(col, op, value) {
        if (col === 'service_label' && op === 'ilike') label = String(value).replace(/%/g, '');
        return builder;
      },
      andWhere(arg) { if (typeof arg === 'function') arg.call(builder, builder); return builder; },
      whereNull() { return builder; },
      orWhereNotNull() { return builder; },
      orderBy() { return builder; },
      join() { return builder; },
      async first() {
        calls.push({ table, where: { ...where } });
        if (table === 'customers') return { id: CUSTOMER_ID, property_type: propertyType, zip: MANATEE_ZIP, building_use: buildingUse };
        if (table === 'tax_exemptions') return null;
        if (table === 'service_taxability') {
          return TAXABILITY.find((row) => row.service_label.toLowerCase() === String(label).toLowerCase()) || null;
        }
        if (table === 'customer_properties') {
          const property = properties[where.id];
          return property && property.customer_id === where.customer_id ? { occupancy_type: property.occupancy_type } : null;
        }
        if (table === 'scheduled_services as s') {
          const visit = visits[where['s.id']];
          if (!visit || visit.customer_id !== where['s.customer_id']) return null;
          const property = properties[visit.property_id];
          return property && property.customer_id === where['p.customer_id'] ? { occupancy_type: property.occupancy_type } : null;
        }
        if (table === 'tax_rates') return { county: 'Manatee', combined_rate: '0.07', state_rate: '0.06', county_surtax: '0.01' };
        return null;
      },
    };
    return builder;
  };
  conn.calls = calls;
  return conn;
}

const PROPERTIES = {
  [SITE_ID]: { customer_id: CUSTOMER_ID, occupancy_type: 'commercial' },
  [HOME_ID]: { customer_id: CUSTOMER_ID, occupancy_type: 'owner_occupied' },
};
const tax = (db, opts = {}, serviceType = SLAB) => TaxCalculator.calculateTax(CUSTOMER_ID, serviceType, 191, { database: db, ...opts });
const readProperty = (db) => db.calls.some((call) => call.table === 'customer_properties' || call.table === 'scheduled_services as s');
const TAXED = { rate: 0.07, amount: 13.37, taxable: true, county: 'Manatee' };
const HOME = { rate: 0, amount: 0, taxable: false };

beforeEach(() => { process.env.GATE_SLAB_HOME_NO_TAX = 'true'; });
afterEach(() => {
  delete process.env.GATE_SLAB_HOME_NO_TAX;
  delete process.env.GATE_SLAB_BUSINESS_SITE_TAX;
  delete process.env.GATE_BUILDING_USE_TAX;
});
const gateOn = () => { process.env.GATE_SLAB_BUSINESS_SITE_TAX = 'true'; };

describe('slab pre-treat at a business site (GATE_SLAB_BUSINESS_SITE_TAX)', () => {
  test('gate off: a slab at a property marked Commercial is billed as a home job and no property is read, as before', async () => {
    const db = fakeDb({ properties: PROPERTIES });
    expect(await tax(db, { propertyId: SITE_ID })).toMatchObject(HOME);
    expect(readProperty(db)).toBe(false);
  });

  test.each(['1', 'true', 'on'])('gate %s: the saved property marked Commercial keeps the county tax', async (value) => {
    process.env.GATE_SLAB_BUSINESS_SITE_TAX = value;
    expect(await tax(fakeDb({ properties: PROPERTIES }), { propertyId: SITE_ID })).toMatchObject(TAXED);
  });

  test("gate on: a visit's property marked Commercial keeps the county tax", async () => {
    gateOn();
    const visits = { [VISIT_ID]: { customer_id: CUSTOMER_ID, property_id: SITE_ID } };
    expect(await tax(fakeDb({ properties: PROPERTIES, visits }), { scheduledServiceId: VISIT_ID })).toMatchObject(TAXED);
  });

  test("gate on: a builder's home site, an unknown site or no site id keeps the home-slab answer", async () => {
    gateOn();
    expect(await tax(fakeDb({ properties: PROPERTIES }), { propertyId: HOME_ID })).toMatchObject(HOME);
    expect(await tax(fakeDb({ properties: { [SITE_ID]: { customer_id: CUSTOMER_ID, occupancy_type: null } } }), { propertyId: SITE_ID })).toMatchObject(HOME);
    expect(await tax(fakeDb({ properties: PROPERTIES }))).toMatchObject(HOME);
  });

  test("gate on: another customer's property or visit never counts", async () => {
    gateOn();
    const properties = { [SITE_ID]: { customer_id: OTHER_CUSTOMER_ID, occupancy_type: 'commercial' } };
    const visits = { [VISIT_ID]: { customer_id: OTHER_CUSTOMER_ID, property_id: SITE_ID } };
    expect(await tax(fakeDb({ properties, visits }), { propertyId: SITE_ID, scheduledServiceId: VISIT_ID })).toMatchObject(HOME);
  });

  test('gate on: a non-commercial account reads no property and keeps the home-slab answer', async () => {
    gateOn();
    const db = fakeDb({ propertyType: 'single_family', properties: PROPERTIES });
    expect(await tax(db, { propertyId: SITE_ID })).toMatchObject(HOME);
    expect(readProperty(db)).toBe(false);
  });

  test("gate on: an account whose recorded building use is residential keeps the home-slab answer", async () => {
    gateOn();
    const db = fakeDb({ buildingUse: 'residential', properties: PROPERTIES });
    expect(await tax(db, { propertyId: SITE_ID })).toMatchObject(HOME);
    expect(readProperty(db)).toBe(false);
  });

  test('gate on with GATE_SLAB_HOME_NO_TAX off: the slab is taxed as before and no property is read', async () => {
    gateOn();
    delete process.env.GATE_SLAB_HOME_NO_TAX;
    const db = fakeDb({ properties: PROPERTIES });
    expect(await tax(db, { propertyId: HOME_ID })).toMatchObject(TAXED);
    expect(readProperty(db)).toBe(false);
  });

  test('gate on: other commercial services keep their tax and read no property', async () => {
    gateOn();
    const db = fakeDb({ properties: PROPERTIES });
    expect(await tax(db, { propertyId: SITE_ID }, 'Recurring Pest Control')).toMatchObject(TAXED);
    expect(readProperty(db)).toBe(false);
  });
});
