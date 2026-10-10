// The office's "last pre-emergent by Waves" block on the New sod form: turf visits only, pre-emergent products
// only (the sheet's own classifier, on the row's own snapshot), this home only (the sod holds' visit scope chain, units included), the newest
// application on or before the reference day with no row limit, and nothing at all when a read fails.
// Synthetic data; a table-keyed fake knex. The SQL itself (join, date bound) runs in CI-only suites.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { lastPreEmergentBlock } = require('../services/lawn-last-pre-emergent');

const CUSTOMER = { id: 'cust-1', address_line1: '100 Example Court', address_line2: null, city: 'Bradenton', zip: '34201', has_multi_home: false };
const HOME_STAMP = { service_address_line1: '100 Example Court', service_address_line2: null, service_address_city: 'Bradenton', service_address_zip: '34201' };
const OTHER_STAMP = { service_address_line1: '9 Other Lane', service_address_line2: null, service_address_city: 'Sarasota', service_address_zip: '34236' };

// One application row as the query returns it: the product snapshot frozen at completion, the visit, its scope.
const STONEWALL = { product_name: 'Stonewall 4FL Prodiamine', product_category: 'herbicide', active_ingredient: 'Prodiamine', epa_reg_number: '100-1139-10404' };
const BAG = { product_name: 'Example Dimension 0.21% 18-0-10', product_category: 'herbicide', active_ingredient: 'dithiopyr 0.21% + 18-0-10', epa_reg_number: '10404-87' };
const FERT = { product_name: 'Example 24-0-11 Turf Fertilizer', product_category: 'fertilizer', active_ingredient: 'Ammonium sulfate', epa_reg_number: null };
const app = (extra) => ({
  product_name: 'Dimension 2EW', product_category: 'herbicide', active_ingredient: 'Dithiopyr', epa_reg_number: '62719-542', service_date: '2026-08-01', service_line: 'lawn', service_type: 'Lawn Care',
  property_id: null, source_estimate_id: null, ...HOME_STAMP, ...extra,
});

// Records every where/whereIn so a test can see what the SQL was asked for.
function fakeKnex(tables) {
  const calls = [];
  const knex = jest.fn((table) => {
    const data = tables[table];
    const chain = {};
    for (const m of ['where', 'whereIn', 'whereNotNull', 'leftJoin', 'join', 'orderBy', 'select']) {
      chain[m] = (...args) => {
        if (m === 'where' && typeof args[0] === 'function') { args[0].call({ whereIn: (...a) => { calls.push([table, 'whereIn', ...a]); return { orWhereNull: (...b) => { calls.push([table, 'orWhereNull', ...b]); } }; } }); return chain; }
        calls.push([table, m, ...args]);
        return chain;
      };
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

async function block({ rows, sodLaidOn = null, sodRootedOn = null, todayEt = '2026-10-09', customer = CUSTOMER, extra = {} }) {
  const knex = fakeKnex({
    customers: customer, 'service_products as sp': rows, customer_properties: [], scheduled_services: [], ...extra,
  });
  // `result` is the first entry (most tests have one product); `all` is the whole block.
  const all = await lastPreEmergentBlock({ knex, customerId: 'cust-1', sodLaidOn, sodRootedOn, todayEt });
  return { result: all ? all[0] : null, all, knex };
}

beforeEach(() => jest.clearAllMocks());

describe('the words', () => {
  it('no sod date: counts days from today, and warns with the matched product label wait (Dimension 2EW: 3 months)', async () => {
    const { result } = await block({ rows: [app({ service_date: '2026-08-01' })] });
    expect(result).toEqual({
      line: 'Last pre-emergent by Waves: Dimension 2EW, Aug 1, 2026 (69 days ago).',
      warning: 'Its label delays seeding or sprigging 3 months after treatment. Sod laid on treated soil may root slowly. Tell the customer in writing today.',
      note: null,
    });
  });

  it('a sod date: counts days before the sod date; Jul 2 is still inside 3 months on Oct 1; Jul 1 is over', async () => {
    const at91 = await block({ rows: [app({ service_date: '2026-07-02' })], sodLaidOn: '2026-10-01' });
    expect(at91.result.line).toBe('Last pre-emergent by Waves: Dimension 2EW, Jul 2, 2026 (91 days before the sod date).');
    expect(at91.result.warning).toMatch(/^Its label delays seeding or sprigging 3 months/);
    const at92 = await block({ rows: [app({ service_date: '2026-07-01' })], sodLaidOn: '2026-10-01' });
    expect(at92.result.line).toContain('(92 days before the sod date).');
    expect(at92.result.warning).toBeNull();
  });

  it('3 months is three calendar months, not a day count: Jan 1 is over on Apr 1 (90 days) and still inside on Mar 31', async () => {
    const over = await block({ rows: [app({ service_date: '2026-01-01' })], sodLaidOn: '2026-04-01' });
    expect(over.result.line).toContain('(90 days before the sod date).');
    expect(over.result.warning).toBeNull();
    const inside = await block({ rows: [app({ service_date: '2026-01-01' })], sodLaidOn: '2026-03-31' });
    expect(inside.result.warning).toMatch(/3 months/);
  });

  it('EPA 10404-87 (the Dimension bag) warns with its own 12 weeks: day 83 warns, day 84 does not', async () => {
    const at83 = await block({ rows: [app({ ...BAG, service_date: '2026-07-10' })], sodLaidOn: '2026-10-01' });
    expect(at83.result.warning).toBe('Its label delays seeding or sprigging 12 weeks after treatment. Sod laid on treated soil may root slowly. Tell the customer in writing today.');
    const at84 = await block({ rows: [app({ ...BAG, service_date: '2026-07-09' })], sodLaidOn: '2026-10-01' });
    expect(at84.result.warning).toBeNull();
  });

  it('a pre-emergent whose label wait the app does not hold (prodiamine): the line and a read-the-label note, never another product wait', async () => {
    const { result } = await block({ rows: [app({ ...STONEWALL, service_date: '2026-09-20' })] });
    expect(result.warning).toBeNull();
    expect(result.note).toBe('The app does not hold this product\'s label wait for seeding or sod. Read the label.');
  });

  it('an application is classified from the name and ingredient frozen on its own row (no catalog read)', async () => {
    const legacy = app({ product_name: 'Old Prodiamine 65 WDG', product_category: 'herbicide', active_ingredient: 'Prodiamine', epa_reg_number: null, service_date: '2026-09-01' });
    const notPre = app({ product_name: 'Old Iron', product_category: 'fertilizer', active_ingredient: 'Iron', epa_reg_number: null, service_date: '2026-09-20' });
    const { result, knex } = await block({ rows: [notPre, legacy] });
    expect(knex.calls.some(([table]) => table === 'products_catalog')).toBe(false);
    expect(result.line).toBe('Last pre-emergent by Waves: Old Prodiamine 65 WDG, Sep 1, 2026 (38 days ago).');
    expect(result.note).toMatch(/Read the label/);
  });

  it('the sod is confirmed rooted: the line stays, the warning and the note go', async () => {
    const { result } = await block({ rows: [app({ service_date: '2026-09-01' })], sodLaidOn: '2026-10-01', sodRootedOn: '2026-11-05' });
    expect(result).toEqual({ line: 'Last pre-emergent by Waves: Dimension 2EW, Sep 1, 2026 (30 days before the sod date).', warning: null, note: null });
  });

  it('says 1 day, not 1 days; never says the label forbids sod', async () => {
    const { result } = await block({ rows: [app({ service_date: '2026-10-08' })] });
    expect(result.line).toContain('(1 day ago).');
    expect(`${result.line} ${result.warning}`).not.toMatch(/forbid|prohibit|must not/i);
  });

  it('another dithiopyr product (a different EPA registration, or none) gets the note, never the Dimension wait', async () => {
    for (const epa_reg_number of ['62719-542-10404', '99999-1', null]) {
      const { result } = await block({ rows: [app({ product_name: 'Other Dithiopyr 2L', epa_reg_number, service_date: '2026-09-20' })] });
      expect(result.warning).toBeNull();
      expect(result.note).toMatch(/Read the label/);
    }
  });

  it('two pre-emergents on the newest day: both are listed, each with its own wait; older days are not', async () => {
    const { all } = await block({ rows: [app({ ...STONEWALL, service_date: '2026-09-20' }), app({ ...BAG, service_date: '2026-09-20' }), app({ service_date: '2026-09-01' })] });
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ line: 'Last pre-emergent by Waves: Stonewall 4FL Prodiamine, Sep 20, 2026 (19 days ago).', warning: null });
    expect(all[1].line).toContain('Example Dimension 0.21% 18-0-10, Sep 20, 2026');
    expect(all[1].warning).toMatch(/12 weeks/);
  });

  it('prints the name frozen on the application row', async () => {
    const { result } = await block({ rows: [app({ ...STONEWALL })] });
    expect(result.line).toContain('Stonewall 4FL Prodiamine');
  });

  it('days are ET calendar days: a date column read as UTC midnight keeps its day', async () => {
    const { result } = await block({ rows: [app({ service_date: new Date('2026-08-01T00:00:00.000Z') })] });
    expect(result.line).toContain('Aug 1, 2026 (69 days ago)');
  });
});

describe('what the query asks for', () => {
  it('a fertilizer and a post-emergent are not pre-emergents; the read is on or before the sod date with no row limit', async () => {
    const { result, knex } = await block({ rows: [app({ ...FERT, service_date: '2026-09-25' }), app({ product_name: 'Celsius WG', active_ingredient: 'Thiencarbazone', epa_reg_number: null, service_date: '2026-09-25' }), app()], sodLaidOn: '2026-10-01' });
    expect(result.line).toContain('Dimension 2EW, Aug 1, 2026');
    const read = knex.calls.filter(([table]) => table === 'service_products as sp');
    expect(read).toContainEqual(['service_products as sp', 'where', 'sr.service_date', '<=', '2026-10-01']);
    expect(read).toContainEqual(['service_products as sp', 'orderBy', 'sr.service_date', 'desc']);
    expect(read.some(([, method]) => method === 'limit')).toBe(false);
    expect(read).toContainEqual(['service_products as sp', 'where', 'sr.customer_id', 'cust-1']);
  });

  it('with no sod date the bound is today (ET)', async () => {
    const { knex } = await block({ rows: [app()], todayEt: '2026-10-09' });
    expect(knex.calls).toContainEqual(['service_products as sp', 'where', 'sr.service_date', '<=', '2026-10-09']);
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
