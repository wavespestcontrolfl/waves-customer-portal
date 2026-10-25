/**
 * GATE_LAWN_SPRAY_NO_TAX: Florida does not tax lawn spraying, residential or
 * nonresidential (Rule 12A-1.009(6)), and taxes pest control only for an
 * infestation of a nonresidential building, so tree and shrub and palm care is
 * not taxed either. TaxCalculator.calculateTax must not tax them for a
 * commercial account, while building pest work, mosquito work and a combined
 * visit that includes either keep their tax.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const TaxCalculator = require('../services/tax-calculator');

const MANATEE_ZIP = require('../config/county-zips').MANATEE_ZIPS[0];

const TAXABILITY = [
  { service_key: 'pest_recurring', service_label: 'Recurring Pest Control', is_taxable: true, residential_taxable: false, fl_statute_ref: 'FL §212.05(1)(i)1' },
  { service_key: 'tree_shrub', service_label: 'Tree & Shrub Care', is_taxable: true, residential_taxable: false, fl_statute_ref: 'FL §212.05(1)(i)1' },
  { service_key: 'palm_injection', service_label: 'Palm Injection', is_taxable: true, residential_taxable: false, fl_statute_ref: 'FL §212.05(1)(i)1' },
  { service_key: 'mosquito_misting_install', service_label: 'Mosquito Misting System Installation', is_taxable: true, residential_taxable: false, fl_statute_ref: 'FL §212.05(1)(i)1' },
];

// A knex stand-in: every builder method chains, a callback runs with the
// builder as `this` (knex's grouped-where shape), and first() answers by
// table. service_taxability matches the key or label the calculator searches for.
function fakeDb({ propertyType = 'commercial', exemption = null } = {}) {
  return (table) => {
    let key = null;
    let label = null;
    const builder = {
      where(arg, op, value) {
        if (typeof arg === 'function') arg.call(builder, builder);
        else if (arg === 'service_key' && op && value === undefined) key = op;
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
          return TAXABILITY.find((row) => row.service_key === key
            || row.service_label.toLowerCase() === String(label).toLowerCase()) || null;
        }
        if (table === 'tax_rates') return { county: 'Manatee', combined_rate: '0.07', state_rate: '0.06', county_surtax: '0.01' };
        return null;
      },
    };
    return builder;
  };
}

const tax = (serviceType, opts) => TaxCalculator.calculateTax('cust-1', serviceType, 100, { database: fakeDb(opts) });

// Live names from invoices and visits, plus the service_taxability labels for lawn add-ons.
const GROUNDS_NAMES = [
  'Every 6 Weeks Lawn Care Service',
  'Lawn Care Visit',
  'Bi-Monthly Tree & Shrub Care Service',
  'Palm Injection',
  'Fire Ant Yard Treatment',
  'Bed Pre-Emergent Weed Control',
  'Shell, Rock & Paver Weed Control',
  'Topdressing',
  'Lawn Pest Knockdown Service',
  'lawn_recurring',
];

afterEach(() => { delete process.env.GATE_LAWN_SPRAY_NO_TAX; });

describe('lawn and landscape tax (GATE_LAWN_SPRAY_NO_TAX)', () => {
  test('gate off: a commercial account pays county tax on lawn and tree and shrub work, as today', async () => {
    expect(await tax('Every 6 Weeks Lawn Care Service')).toMatchObject({ rate: 0.07, amount: 7, taxable: true, county: 'Manatee' });
    expect(await tax('Tree & Shrub Care')).toMatchObject({ rate: 0.07, amount: 7, taxable: true, county: 'Manatee' });
  });

  test.each(['1', 'true', 'on'])('gate %s: lawn, tree and shrub and palm work is not taxed for a commercial account', async (value) => {
    process.env.GATE_LAWN_SPRAY_NO_TAX = value;
    for (const name of GROUNDS_NAMES) {
      const result = await tax(name);
      expect(result).toMatchObject({ rate: 0, amount: 0, taxable: false });
      expect(result.reason).toContain('Rule 12A-1.009');
    }
  });

  test('gate on: building pest work, mosquito work and a combined visit keep the commercial tax', async () => {
    process.env.GATE_LAWN_SPRAY_NO_TAX = 'true';
    for (const name of ['Recurring Pest Control', 'Monthly Mosquito Control Service', 'Lawn & Mosquito Program', 'Lawn Care Visit #4 + Quarterly Pest Control', 'Lawn Care Visit #4 + Palmetto Bug Treatment', 'Mosquito Misting System Installation', 'Termite Trenching', 'Palmetto Bug Treatment']) {
      expect(await tax(name)).toMatchObject({ rate: 0.07, amount: 7, taxable: true });
    }
  });

  test('gate on: a residential lawn visit stays untaxed', async () => {
    process.env.GATE_LAWN_SPRAY_NO_TAX = 'true';
    expect(await tax('Monthly Lawn Care Service', { propertyType: 'residential' })).toMatchObject({ rate: 0, amount: 0, taxable: false });
  });

  test('gate on: a verified exemption still answers first', async () => {
    process.env.GATE_LAWN_SPRAY_NO_TAX = 'true';
    const result = await tax('Lawn Care Visit', { exemption: { exemption_type: 'resale', certificate_number: 'X-1' } });
    expect(result).toMatchObject({ rate: 0, taxable: false });
    expect(result.reason).toContain('Tax exempt');
  });
});

describe('isGroundsTreatment', () => {
  test.each([
    ['Every 6 Weeks Lawn Care Service', true],
    ['Quarterly Tree & Shrub Care Service', true],
    ['Palm Injection', true],
    ['Fire Ant Yard Treatment', true],
    ['Yearly Lawn Insect Preventive', true],
    ['Sod Webworm Treatment', true],
    ['Dethatching', true],
    ['Lawn Plugging', true],
    ['tree_shrub', true],
    ['area_addon_fire_ant_yard', true],
    ['Lawn Pest Knockdown Service', true],
    ['lawn_pest_knockdown', true],
    ['Lawn & Pest Control', false],
    ['Lawn Pest Knockdown + Quarterly Pest Control', false],
    ['Lawn Care Visit #4 + Palmetto Bug Treatment', false],
    ['Lawn Care Visit + Tree & Shrub Care', true],
    ['Lawn Care + Fire Ant Treatment', true],
    ['Lawn & Spider Control', false],
    ['Lawn Care and Ant Control', false],
    ['+', false],
    ['Lawn Care Visit #4 + Quarterly Pest Control', false],
    ['Seasonal Mosquito Control Service', false],
    ['Mosquito Barrier Treatment', false],
    ['Lawn & Mosquito Program', false],
    ['Mosquito Misting Service Plan', false],
    ['mosquito_misting_install', false],
    ['Quarterly Pest Control Service', false],
    ['Flea Control Service', false],
    ['Bee / Wasp Nest Removal Service', false],
    ['WDO Inspection Service', false],
    ['Palmetto Bug Treatment', false],
    ['Slab Pre-Treat Termite Service', false],
    ['Waves Assessment', false],
    ['', false],
    [null, false],
  ])('%s → %s', (name, expected) => {
    expect(TaxCalculator.isGroundsTreatment(name)).toBe(expected);
  });
});
