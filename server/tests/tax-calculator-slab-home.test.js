/**
 * GATE_SLAB_HOME_NO_TAX: a pre-construction termite treatment (slab
 * pre-treat) is taxable in Florida only for a nonresidential building
 * (Rule 12A-1.009), so TaxCalculator.calculateTax must not tax a home slab
 * just because the customer is a builder whose account is commercial. A
 * service name that says Commercial keeps the normal commercial tax.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const TaxCalculator = require('../services/tax-calculator');

const MANATEE_ZIP = require('../config/county-zips').MANATEE_ZIPS[0];

const TAXABILITY = [
  { service_key: 'pest_recurring', service_label: 'Recurring Pest Control', is_taxable: true, residential_taxable: false, fl_statute_ref: 'FL §212.05(1)(i)1' },
  { service_key: 'area_addon_bed_pre_emergent', service_label: 'Bed Pre-Emergent Weed Control', is_taxable: true, residential_taxable: false, fl_statute_ref: 'FL §212.05(1)(i)1' },
];

// A knex stand-in: every builder method chains, a callback runs with the
// builder as `this` (knex's grouped-where shape), and first() answers by
// table. service_taxability matches the label the calculator searches for.
function fakeDb({ propertyType = 'commercial', exemption = null } = {}) {
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
        if (table === 'customers') return { id: 'cust-1', property_type: propertyType, zip: MANATEE_ZIP };
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

const tax = (serviceType, opts) => TaxCalculator.calculateTax('cust-1', serviceType, 191, { database: fakeDb(opts) });

afterEach(() => { delete process.env.GATE_SLAB_HOME_NO_TAX; });

describe('slab pre-treat tax (GATE_SLAB_HOME_NO_TAX)', () => {
  test('gate off: a commercial account pays county tax on a slab pre-treat, as today', async () => {
    const result = await tax('Slab Pre-Treat Termite Service');
    expect(result).toMatchObject({ rate: 0.07, amount: 13.37, taxable: true, county: 'Manatee' });
  });

  test.each(['1', 'true', 'on'])('gate %s: every live slab service name is not taxed for a commercial account', async (value) => {
    process.env.GATE_SLAB_HOME_NO_TAX = value;
    for (const name of ['Slab Pre-Treat Termite Service', 'Pre-Slab Termidor', 'Termite Pretreatment Service']) {
      const result = await tax(name);
      expect(result).toMatchObject({ rate: 0, amount: 0, taxable: false });
      expect(result.reason).toContain('Rule 12A-1.009');
    }
  });

  test('gate on: a name that says Commercial or nonresidential keeps the commercial tax', async () => {
    process.env.GATE_SLAB_HOME_NO_TAX = 'true';
    for (const name of ['Commercial Slab Pre-Treat Termite Service', 'Non-Residential Pre-Construction Termite Treatment']) {
      expect(await tax(name)).toMatchObject({ rate: 0.07, amount: 13.37, taxable: true });
    }
  });

  test('gate on: other commercial services keep their tax', async () => {
    process.env.GATE_SLAB_HOME_NO_TAX = 'true';
    expect(await tax('Recurring Pest Control')).toMatchObject({ rate: 0.07, taxable: true });
    expect(await tax('Bed Pre-Emergent Weed Control')).toMatchObject({ rate: 0.07, taxable: true });
    expect(await tax('Termite Trenching')).toMatchObject({ rate: 0.07, taxable: true });
  });

  test('gate on: a verified exemption still answers first', async () => {
    process.env.GATE_SLAB_HOME_NO_TAX = 'true';
    const result = await tax('Slab Pre-Treat Termite Service', { exemption: { exemption_type: 'resale', certificate_number: 'X-1' } });
    expect(result).toMatchObject({ rate: 0, taxable: false });
    expect(result.reason).toContain('Tax exempt');
  });
});

describe('isHomeSlabPretreat', () => {
  test.each([
    ['Slab Pre-Treat Termite Service', true],
    ['Pre-Slab Termidor', true],
    ['Termite Pretreatment Service', true],
    ['Pre-Construction Termite Treatment', true],
    ['Bora-Care Pre-Treat', true],
    ['pre treat slab', true],
    ['Commercial Slab Pre-Treat Termite Service', false],
    ['Nonresidential Pre-Slab Termidor', false],
    ['Bed Pre-Emergent Weed Control', false],
    ['Termite Trenching', false],
    ['Pretreat', false],
    ['nonresidential_pest_control', false],
    ['', false],
    [null, false],
  ])('%s → %s', (name, expected) => {
    expect(TaxCalculator.isHomeSlabPretreat(name)).toBe(expected);
  });
});
