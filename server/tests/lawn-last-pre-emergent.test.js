// The office's "last pre-emergent by Waves" block on the New sod form: turf visits only, pre-emergent products
// only (the sheet's own classifier), this home only (the sod holds' visit scope chain, units included), the newest
// application on or before the reference day with no row limit, and nothing at all when a read fails.
// Synthetic data; a table-keyed fake knex. The SQL itself (join, date bound) runs in CI-only suites.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { lastPreEmergentBlock } = require('../services/lawn-last-pre-emergent');

const P_DIM = 'aaaaaaaa-0000-4000-8000-000000000001';
const P_STONEWALL = 'aaaaaaaa-0000-4000-8000-000000000002';
const P_FERT = 'aaaaaaaa-0000-4000-8000-000000000003';
const P_CELSIUS = 'aaaaaaaa-0000-4000-8000-000000000004';

const CATALOG = [
  { id: P_DIM, name: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide', display_name: 'Dimension 2EW', category: 'herbicide', active_ingredient: 'Dithiopyr', formulation: 'liquid' },
  { id: P_STONEWALL, name: 'Stonewall 4FL Prodiamine', display_name: null, category: 'herbicide', active_ingredient: 'Prodiamine', formulation: 'liquid' },
  { id: P_FERT, name: 'Example 24-0-11 Turf Fertilizer', display_name: null, category: 'fertilizer', active_ingredient: 'Ammonium sulfate', formulation: 'granular', analysis_n: 24 },
  { id: P_CELSIUS, name: 'Celsius WG', display_name: null, category: 'herbicide', active_ingredient: 'Thiencarbazone', formulation: 'dry' },
];

const CUSTOMER = { id: 'cust-1', address_line1: '100 Example Court', address_line2: null, city: 'Bradenton', zip: '34201', has_multi_home: false };
const HOME_STAMP = { service_address_line1: '100 Example Court', service_address_line2: null, service_address_city: 'Bradenton', service_address_zip: '34201' };
const OTHER_STAMP = { service_address_line1: '9 Other Lane', service_address_line2: null, service_address_city: 'Sarasota', service_address_zip: '34236' };

const app = (extra) => ({
  product_id: P_DIM, service_date: '2026-08-01', service_line: 'lawn', service_type: 'Lawn Care',
  property_id: null, source_estimate_id: null, ...HOME_STAMP, ...extra,
});

// Records every where/whereIn so a test can see what the SQL was asked for.
function fakeKnex(tables) {
  const calls = [];
  const knex = jest.fn((table) => {
    const data = tables[table];
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNotNull', 'leftJoin', 'join', 'orderBy', 'select']) {
      chain[m] = (...args) => { calls.push([table, m, ...args]); return chain; };
    }
    const fail = () => { if (data instanceof Error) throw data; };
    chain.first = async () => { fail(); return Array.isArray(data) ? data[0] : data; };
    chain.columnInfo = async () => { fail(); return {}; };
    chain.distinct = () => chain;
    const settle = () => (data instanceof Error ? Promise.reject(data) : Promise.resolve(Array.isArray(data) ? data : []));
    chain.then = (resolve, reject) => settle().then(resolve, reject);
    chain.catch = (reject) => settle().catch(reject);
    return chain;
  });
  knex.calls = calls;
  return knex;
}

async function block({ rows, sodLaidOn = null, todayEt = '2026-10-09', customer = CUSTOMER, extra = {}, catalog = CATALOG }) {
  const knex = fakeKnex({
    customers: customer, products_catalog: catalog, 'service_products as sp': rows, customer_properties: [], scheduled_services: [], ...extra,
  });
  const result = await lastPreEmergentBlock({ knex, customerId: 'cust-1', sodLaidOn, todayEt });
  return { result, knex };
}

beforeEach(() => jest.clearAllMocks());

describe('the words', () => {
  it('no sod date: counts days from today, and warns under 91 days', async () => {
    const { result } = await block({ rows: [app({ service_date: '2026-08-01' })] });
    expect(result).toEqual({
      line: 'Last pre-emergent by Waves: Dimension 2EW, Aug 1, 2026 (69 days ago).',
      warning: 'Its label delays seeding or sprigging 12 weeks (Dimension 2EW: 3 months) after treatment. Sod laid on treated soil may root slowly. Tell the customer in writing today.',
    });
  });

  it('a sod date: counts days before the sod date; 90 days warns, 91 days does not', async () => {
    const at90 = await block({ rows: [app({ service_date: '2026-07-03' })], sodLaidOn: '2026-10-01' });
    expect(at90.result.line).toBe('Last pre-emergent by Waves: Dimension 2EW, Jul 3, 2026 (90 days before the sod date).');
    expect(at90.result.warning).toMatch(/^Its label delays seeding or sprigging 12 weeks/);
    const at91 = await block({ rows: [app({ service_date: '2026-07-02' })], sodLaidOn: '2026-10-01' });
    expect(at91.result.line).toContain('(91 days before the sod date).');
    expect(at91.result.warning).toBeNull();
  });

  it('says 1 day, not 1 days; never says the label forbids sod', async () => {
    const { result } = await block({ rows: [app({ service_date: '2026-10-08' })] });
    expect(result.line).toContain('(1 day ago).');
    expect(`${result.line} ${result.warning}`).not.toMatch(/forbid|prohibit|must not/i);
  });

  it('uses the catalog name when there is no short display name', async () => {
    const { result } = await block({ rows: [app({ product_id: P_STONEWALL })] });
    expect(result.line).toContain('Stonewall 4FL Prodiamine');
  });

  it('days are ET calendar days: a date column read as UTC midnight keeps its day', async () => {
    const { result } = await block({ rows: [app({ service_date: new Date('2026-08-01T00:00:00.000Z') })] });
    expect(result.line).toContain('Aug 1, 2026 (69 days ago)');
  });
});

describe('what the query asks for', () => {
  it('reads only pre-emergent products by id (fertilizer and a post-emergent are not), on or before the sod date, no row limit', async () => {
    const { knex } = await block({ rows: [app()], sodLaidOn: '2026-10-01' });
    const read = knex.calls.filter(([table]) => table === 'service_products as sp');
    expect(read).toContainEqual(['service_products as sp', 'whereIn', 'sp.product_id', [P_DIM, P_STONEWALL]]);
    expect(read).toContainEqual(['service_products as sp', 'where', 'sr.service_date', '<=', '2026-10-01']);
    expect(read).toContainEqual(['service_products as sp', 'orderBy', 'sr.service_date', 'desc']);
    expect(read.some(([, method]) => method === 'limit')).toBe(false);
    expect(read).toContainEqual(['service_products as sp', 'where', 'sr.customer_id', 'cust-1']);
  });

  it('with no sod date the bound is today (ET)', async () => {
    const { knex } = await block({ rows: [app()], todayEt: '2026-10-09' });
    expect(knex.calls).toContainEqual(['service_products as sp', 'where', 'sr.service_date', '<=', '2026-10-09']);
  });

  it('no pre-emergent in the catalog: nothing, and the applications are not read', async () => {
    const { result, knex } = await block({ rows: [app()], catalog: [CATALOG[2], CATALOG[3]] });
    expect(result).toBeNull();
    expect(knex.calls.some(([table]) => table === 'service_products as sp')).toBe(false);
  });

  it('nothing applied: no block', async () => {
    expect((await block({ rows: [] })).result).toBeNull();
  });
});

describe('turf only', () => {
  it('skips a pre-emergent on a tree-and-shrub or pest visit and names the older lawn one', async () => {
    const { result } = await block({
      rows: [
        app({ service_date: '2026-09-20', service_line: 'tree_shrub', service_type: 'Tree & Shrub Care' }),
        app({ service_date: '2026-09-10', service_line: null, service_type: 'Quarterly Pest Control' }),
        app({ service_date: '2026-06-01' }),
      ],
    });
    expect(result.line).toContain('Jun 1, 2026');
  });

  it('a visit with no stored line is read from its service type', async () => {
    const { result } = await block({ rows: [app({ service_line: null, service_type: 'Lawn Care Visit #3' })] });
    expect(result.line).toContain('Aug 1, 2026');
  });

  it('only non-lawn applications: nothing', async () => {
    expect((await block({ rows: [app({ service_line: 'tree_shrub' })] })).result).toBeNull();
  });
});

describe('this home only', () => {
  it('skips an application at another property of the same customer, newest first', async () => {
    const { result } = await block({ rows: [app({ service_date: '2026-09-20', ...OTHER_STAMP }), app({ service_date: '2026-07-01' })] });
    expect(result.line).toContain('Jul 1, 2026');
  });

  it('another unit on the same street is another premises', async () => {
    const home = { ...CUSTOMER, address_line2: 'Unit 4' };
    const { result } = await block({
      customer: home,
      rows: [
        app({ service_date: '2026-09-20', service_address_line2: 'Unit 5' }),
        app({ service_date: '2026-07-01', service_address_line2: 'Unit 4' }),
      ],
    });
    expect(result.line).toContain('Jul 1, 2026');
  });

  it('a stamp on the home street that omits the unit takes the home unit', async () => {
    const home = { ...CUSTOMER, address_line2: 'Unit 4' };
    const { result } = await block({ customer: home, rows: [app({ service_date: '2026-09-20', service_address_line2: null })] });
    expect(result.line).toContain('Sep 20, 2026');
  });

  it('a visit linked to a property at another address is left out; one at this address counts', async () => {
    const link = { service_address_line1: null, service_address_line2: null, service_address_city: null, service_address_zip: null };
    const other = await block({
      rows: [app({ ...link, property_id: 'prop-2' })],
      extra: { customer_properties: { address_line1: '9 Other Lane', address_line2: null, city: 'Sarasota', zip: '34236' } },
    });
    expect(other.result).toBeNull();
    const mine = await block({
      rows: [app({ ...link, property_id: 'prop-1' })],
      extra: { customer_properties: { address_line1: '100 Example Court', address_line2: null, city: 'Bradenton', zip: '34201' } },
    });
    expect(mine.result.line).toContain('Aug 1, 2026');
  });

  it('a visit with no address evidence counts only on a single-premises account', async () => {
    const bare = { ...app(), service_address_line1: null, service_address_line2: null, service_address_city: null, service_address_zip: null };
    expect((await block({ rows: [bare] })).result.line).toContain('Aug 1, 2026');
    expect((await block({ rows: [bare], customer: { ...CUSTOMER, has_multi_home: true } })).result).toBeNull();
  });

  it('a visit whose property link cannot be resolved is left out', async () => {
    const link = { service_address_line1: null, service_address_line2: null, service_address_city: null, service_address_zip: null };
    const { result } = await block({ rows: [app({ ...link, property_id: 'prop-gone' })], extra: { customer_properties: undefined } });
    expect(result).toBeNull();
  });
});

describe('a failed read shows nothing', () => {
  it('returns null and logs the error code only, never the driver message', async () => {
    const err = Object.assign(new Error('select * from service_products where customer_id = secret-value'), { code: '42P01' });
    const { result } = await block({ rows: err });
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = logger.warn.mock.calls[0][0];
    expect(message).toContain('42P01');
    expect(message).not.toContain('secret-value');
  });

  it('a failed property lookup is no block, not a guess', async () => {
    const link = { service_address_line1: null, service_address_line2: null, service_address_city: null, service_address_zip: null };
    const { result } = await block({ rows: [app({ ...link, property_id: 'prop-1' })], extra: { customer_properties: new Error('boom') } });
    expect(result).toBeNull();
  });

  it('a missing customer is no block', async () => {
    expect((await block({ rows: [app()], customer: null })).result).toBeNull();
  });
});
