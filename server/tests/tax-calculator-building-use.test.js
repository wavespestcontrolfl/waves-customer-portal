/**
 * GATE_BUILDING_USE_TAX: Florida taxes pest control only at a nonresidential
 * building (Rule 12A-1.009), whoever pays. An account whose won proposal says
 * its site is residential (customers.building_use = 'residential': homes,
 * apartments, condos and their common areas) is taxed like any residential
 * customer, not at all. Gate off, or any other building use, keeps the
 * commercial tax exactly as before.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const TaxCalculator = require('../services/tax-calculator');

const MANATEE_ZIP = require('../config/county-zips').MANATEE_ZIPS[0];

const TAXABILITY = [
  { service_key: 'pest_recurring', service_label: 'Recurring Pest Control', is_taxable: true, residential_taxable: false, fl_statute_ref: 'FL §212.05(1)(i)1' },
];

// A knex stand-in (same shape as tax-calculator-slab-home.test.js): every
// builder method chains and first() answers by table.
function fakeDb({ buildingUse = null, exemption = null } = {}) {
  return (table) => {
    let label = null;
    const builder = {
      where(arg, op, value) {
        if (typeof arg === 'function') arg.call(builder, builder);
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
      async first() {
        if (table === 'customers') return { id: 'cust-1', property_type: 'commercial', zip: MANATEE_ZIP, building_use: buildingUse };
        if (table === 'tax_exemptions') return exemption;
        if (table === 'service_taxability') {
          return TAXABILITY.find((row) => row.service_label.toLowerCase() === String(label).toLowerCase()) || null;
        }
        if (table === 'tax_rates') return { county: 'Manatee', combined_rate: '0.07', state_rate: '0.06', county_surtax: '0.01' };
        return null;
      },
    };
    return builder;
  };
}

const tax = (dbOpts, calcOpts = {}) => TaxCalculator.calculateTax('cust-1', 'Recurring Pest Control', 191, { database: fakeDb(dbOpts), ...calcOpts });
const RESIDENTIAL = { rate: 0, amount: 0, taxable: false, county: null, reason: 'Residential building use — pest control at homes and their common areas is not taxable (FL Rule 12A-1.009)' };

afterEach(() => { delete process.env.GATE_BUILDING_USE_TAX; });

describe('building use tax (GATE_BUILDING_USE_TAX)', () => {
  test('gate off: a residential-use commercial account pays county tax, as today', async () => {
    expect(await tax({ buildingUse: 'residential' })).toMatchObject({ rate: 0.07, amount: 13.37, taxable: true, county: 'Manatee' });
  });

  test('gate on: a residential-use account owes no tax on its pest work', async () => {
    process.env.GATE_BUILDING_USE_TAX = 'true';
    expect(await tax({ buildingUse: 'residential' })).toEqual(RESIDENTIAL);
  });

  test('gate on: the use belongs to the site, so a payer-billed invoice follows it too', async () => {
    process.env.GATE_BUILDING_USE_TAX = 'true';
    expect(await tax({ buildingUse: 'residential' }, { skipCustomerExemption: true })).toEqual(RESIDENTIAL);
  });

  test('gate on: a business building, or no recorded use, keeps the county tax', async () => {
    process.env.GATE_BUILDING_USE_TAX = 'true';
    expect(await tax({ buildingUse: 'nonresidential' })).toMatchObject({ rate: 0.07, amount: 13.37, taxable: true });
    expect(await tax({ buildingUse: null })).toMatchObject({ rate: 0.07, amount: 13.37, taxable: true });
  });

  test('gate on: a verified exemption still answers first', async () => {
    process.env.GATE_BUILDING_USE_TAX = 'true';
    const exemption = { exemption_type: 'nonprofit', certificate_number: 'SYN-1' };
    expect(await tax({ buildingUse: 'residential', exemption })).toMatchObject({ taxable: false, reason: 'Tax exempt — nonprofit (SYN-1)' });
  });
});
