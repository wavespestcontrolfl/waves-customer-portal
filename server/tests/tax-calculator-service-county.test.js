/**
 * GATE_TAX_SERVICE_COUNTY: Florida's surtax is due in the county where the
 * service is delivered (s. 212.054(3)(a); Rule 12A-15.003(5)(a)). With the gate
 * on, the serviced property's ZIP names the county (a saved property of the
 * customer, or the saved property of one of its visits), DeSoto ZIPs map, and
 * Lee, Collier and DeSoto use their 2026 rates when no tax_rates row covers
 * them. Gate off keeps the customer's ZIP and the 7% fallback exactly as before.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const TaxCalculator = require('../services/tax-calculator');
const { MANATEE_ZIPS, CHARLOTTE_ZIPS, LEE_ZIPS, COLLIER_ZIPS, DESOTO_ZIPS } = require('../config/county-zips');

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';
const PROPERTY_ID = '22222222-2222-4222-8222-222222222222';
const VISIT_ID = '33333333-3333-4333-8333-333333333333';

const row = (county, combined, surtax) => ({ county, combined_rate: combined, state_rate: '0.0600', county_surtax: surtax });
const SEEDED = {
  Manatee: row('Manatee', '0.0700', '0.0100'),
  Sarasota: row('Sarasota', '0.0700', '0.0100'),
  Charlotte: row('Charlotte', '0.0700', '0.0100'),
};
// Charlotte after its 1% surtax ends (the Nov 3 2026 vote decides it).
const CHARLOTTE_AT_SIX = { ...SEEDED, Charlotte: row('Charlotte', '0.0600', '0.0000') };

// A knex stand-in: builder methods chain, where() objects are kept, and
// first() answers by table, so the test sees which rows the calculator read.
function fakeDb({ customerZip = MANATEE_ZIPS[0], properties = {}, visits = {}, rates = SEEDED } = {}) {
  const calls = [];
  const conn = (table) => {
    const where = {};
    const builder = {
      where(arg, value) {
        if (typeof arg === 'function') arg.call(builder, builder);
        else if (arg && typeof arg === 'object') Object.assign(where, arg);
        else if (value !== undefined) where[arg] = value;
        return builder;
      },
      orWhere() { return builder; },
      andWhere(arg) { if (typeof arg === 'function') arg.call(builder, builder); return builder; },
      whereNull() { return builder; },
      orWhereNotNull() { return builder; },
      orderBy() { return builder; },
      join() { return builder; },
      async first() {
        calls.push({ table, where: { ...where } });
        if (table === 'customers') return { id: CUSTOMER_ID, property_type: 'commercial', zip: customerZip, building_use: null };
        if (table === 'customer_properties') {
          const property = properties[where.id];
          return property && property.customer_id === where.customer_id ? { zip: property.zip } : null;
        }
        if (table === 'scheduled_services as s') {
          const visit = visits[where['s.id']];
          if (!visit || visit.customer_id !== where['s.customer_id']) return null;
          const property = properties[visit.property_id];
          return property && property.customer_id === where['p.customer_id'] ? { zip: property.zip } : null;
        }
        if (table === 'tax_rates') return rates[where.county] || null;
        return null;
      },
    };
    return builder;
  };
  conn.calls = calls;
  return conn;
}

const tax = (db, opts = {}) => TaxCalculator.calculateTax(CUSTOMER_ID, 'nonresidential_pest_control', 200, { database: db, ...opts });
const readProperty = (db) => db.calls.some((call) => call.table === 'customer_properties' || call.table === 'scheduled_services as s');
const charlotteProperty = { [PROPERTY_ID]: { customer_id: CUSTOMER_ID, zip: CHARLOTTE_ZIPS[0] } };

afterEach(() => { delete process.env.GATE_TAX_SERVICE_COUNTY; });
const gateOn = () => { process.env.GATE_TAX_SERVICE_COUNTY = 'true'; };

describe('tax county from the serviced property (GATE_TAX_SERVICE_COUNTY)', () => {
  test('gate off: the customer ZIP names the county and no property is read, as before', async () => {
    const db = fakeDb({ rates: CHARLOTTE_AT_SIX, properties: charlotteProperty });
    expect(await tax(db, { propertyId: PROPERTY_ID })).toEqual({
      rate: 0.07, amount: 14, taxable: true, county: 'Manatee', reason: 'Manatee County — 7.0% (state 6% + county 1% surtax)',
    });
    expect(readProperty(db)).toBe(false);
  });

  test("gate on: the estimate's saved property in another county names it", async () => {
    gateOn();
    const db = fakeDb({ rates: CHARLOTTE_AT_SIX, properties: charlotteProperty });
    expect(await tax(db, { propertyId: PROPERTY_ID })).toEqual({
      rate: 0.06, amount: 12, taxable: true, county: 'Charlotte', countySource: 'property',
      reason: 'Charlotte County (property ZIP) — 6.0% (state 6% + county 0% surtax)',
    });
  });

  test("gate on: a visit names the county through its saved property", async () => {
    gateOn();
    const db = fakeDb({
      rates: CHARLOTTE_AT_SIX,
      properties: charlotteProperty,
      visits: { [VISIT_ID]: { customer_id: CUSTOMER_ID, property_id: PROPERTY_ID } },
    });
    expect(await tax(db, { scheduledServiceId: VISIT_ID })).toMatchObject({ rate: 0.06, county: 'Charlotte', countySource: 'property' });
  });

  test("gate on: another customer's property or visit is ignored", async () => {
    gateOn();
    const properties = { [PROPERTY_ID]: { customer_id: OTHER_CUSTOMER_ID, zip: CHARLOTTE_ZIPS[0] } };
    const visits = { [VISIT_ID]: { customer_id: OTHER_CUSTOMER_ID, property_id: PROPERTY_ID } };
    const result = await tax(fakeDb({ rates: CHARLOTTE_AT_SIX, properties, visits }), { propertyId: PROPERTY_ID, scheduledServiceId: VISIT_ID });
    expect(result).toEqual({ rate: 0.07, amount: 14, taxable: true, county: 'Manatee', reason: 'Manatee County — 7.0% (state 6% + county 1% surtax)' });
  });

  test("gate on: a property without a ZIP leaves the customer's ZIP", async () => {
    gateOn();
    const properties = { [PROPERTY_ID]: { customer_id: CUSTOMER_ID, zip: '  ' } };
    expect(await tax(fakeDb({ rates: CHARLOTTE_AT_SIX, properties }), { propertyId: PROPERTY_ID }))
      .toEqual(expect.not.objectContaining({ countySource: expect.anything() }));
  });

  test('gate on: an id that is not a UUID reads nothing', async () => {
    gateOn();
    const db = fakeDb({ properties: charlotteProperty });
    expect(await tax(db, { propertyId: 'not-a-uuid', scheduledServiceId: 42 })).toMatchObject({ county: 'Manatee' });
    expect(readProperty(db)).toBe(false);
  });

  test("gate on: an unmapped property ZIP is reported as the property's", async () => {
    gateOn();
    const properties = { [PROPERTY_ID]: { customer_id: CUSTOMER_ID, zip: '33601' } };
    expect(await tax(fakeDb({ properties }), { propertyId: PROPERTY_ID })).toEqual({
      rate: 0.07, amount: 14, taxable: true, county: 'unknown', countySource: 'property',
      reason: "Default FL rate (county could not be inferred from the property's ZIP)",
    });
  });
});

describe('neighbor county rates (GATE_TAX_SERVICE_COUNTY)', () => {
  test.each([
    ['Lee', LEE_ZIPS[0], 0.065, 13, 'Lee County — 6.5% (state 6% + county 0.5% surtax)'],
    ['Collier', COLLIER_ZIPS[0], 0.06, 12, 'Collier County — 6.0% (state 6% + county 0% surtax)'],
    ['DeSoto', DESOTO_ZIPS[0], 0.075, 15, 'DeSoto County — 7.5% (state 6% + county 1.5% surtax)'],
  ])('gate on: %s without a rate row uses its 2026 rate', async (county, zip, rate, amount, reason) => {
    gateOn();
    expect(await tax(fakeDb({ customerZip: zip }))).toEqual({ rate, amount, taxable: true, county, reason });
  });

  test('gate off: Lee without a rate row and a DeSoto ZIP keep the 7% fallback, as before', async () => {
    expect(await tax(fakeDb({ customerZip: LEE_ZIPS[0] }))).toEqual({
      rate: 0.07, amount: 14, taxable: true, county: 'Lee', reason: 'Lee County — 7.0% (state 6% + county 1% surtax)',
    });
    expect(await tax(fakeDb({ customerZip: DESOTO_ZIPS[0] }))).toEqual({
      rate: 0.07, amount: 14, taxable: true, county: 'unknown', reason: 'Default FL rate (county could not be inferred from ZIP)',
    });
  });

  test('gate on: a tax_rates row for the county wins over the 2026 rate', async () => {
    gateOn();
    const rates = { ...SEEDED, Lee: row('Lee', '0.0700', '0.0100') };
    expect(await tax(fakeDb({ customerZip: LEE_ZIPS[0], rates }))).toMatchObject({ rate: 0.07, county: 'Lee' });
  });
});
