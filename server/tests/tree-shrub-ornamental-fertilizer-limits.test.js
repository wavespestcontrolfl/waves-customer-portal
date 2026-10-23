/**
 * LESCO 13-0-13 at Tree & Shrub closeout: the 7.5 lb per 1,000 sq ft county cap and the history rules (2 in 12 months,
 * 5 calendar months apart, none June 1 to Sept. 30) are flagged on the completion and sent to the office; the closeout never
 * refuses for them. The June to September blackout stays a hard block in validateTreeShrubTypedCompliance.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const limits = require('../services/tree-shrub-ornamental-fertilizer-limits');
const { validateTreeShrubTypedCompliance } = require('../services/tree-shrub-closeout');

const ORN = 'LESCO 13-0-13 60% PolyPlus Landscape';
const record = { id: 'rec-1', service_date: '2028-10-10' };
const svc = { id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1', scheduled_date: '2028-10-10', service_type: 'Tree & Shrub Care' };

// Fake knex for the two reads the check makes: the record's service_products rows and the ledger history. Synthetic rows only.
function fakeDb({ rows = [], history = [], failHistory = false } = {}) {
  const seen = { excluded: null };
  const db = (table) => {
    const q = {
      leftJoin() { return q; },
      where(a, b) { if (a === 'sp.service_record_id') seen.recordId = b; if (typeof a === 'function') { a({ whereNull: () => ({ orWhereNot: (col, id) => { seen.excluded = id; } }) }); } return q; },
      whereNull() { return q; },
      select() {
        if (table === 'service_products as sp') return Promise.resolve(rows);
        return failHistory ? Promise.reject(new Error('down')) : Promise.resolve(history);
      },
    };
    return q;
  };
  db.raw = (sql) => sql;
  db.seen = seen;
  return db;
}
const row = (extra = {}) => ({ product_id: 'orn', product_name: ORN, application_rate: null, rate_unit: null, total_amount: null, amount_unit: null, area_value: null, area_unit: null, ...extra });
const past = (date, extra = {}) => ({ product_name: ORN, application_date: date, property_id: 'prop-1', ledger_property_id: 'prop-1', application_rate: 7.5, rate_unit: 'lb', ...extra });
const flag = (opts, advisory = null) => {
  const notify = jest.fn(async () => {});
  return limits.flagOrnamentalFertilizer({ svc, record, database: fakeDb(opts), advisory, notify }).then((out) => ({ out, notify }));
};

describe('the rate cap (7.5 lb per 1,000 sq ft = 0.75 lb per 100 sq ft = 0.98 lb N)', () => {
  test('a rate or a total over the treated area at or under the cap is not flagged; over it is', async () => {
    for (const ok of [row({ application_rate: 7.5, rate_unit: 'lb' }), row({ total_amount: 9, amount_unit: 'lb', area_value: 1200, area_unit: 'sqft' }), row({ application_rate: 3, rate_unit: 'lb/1000sf' })]) {
      const { out, notify } = await flag({ rows: [ok] });
      expect(out).toBeNull();
      expect(notify).not.toHaveBeenCalled();
    }
    const { out, notify } = await flag({ rows: [row({ total_amount: 12, amount_unit: 'lb', area_value: 1200, area_unit: 'sqft' })] });
    expect(out).toMatchObject({ advisory: true, blocks: [{ code: 'application_limit_exceeded', productId: 'orn', message: expect.stringMatching(/applied at 10 lb per 1,000 sq ft, over the 7\.5 lb per 1,000 sq ft \(0\.75 lb per 100 sq ft\) county limit/) }] });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ findings: [expect.objectContaining({ limitType: 'ornamental_fertilizer_rate', current: 10, max: 7.5 })] }));
  });

  test('a total overridden above the entered rate is judged by what was spread (rate 7.5, total 12 lb over 1,200 sq ft = 10)', async () => {
    const conflicting = row({ application_rate: 7.5, rate_unit: 'lb', total_amount: 12, amount_unit: 'lb', area_value: 1200, area_unit: 'sqft' });
    expect(limits.ratePer1000(conflicting)).toBe(10);
    const { out, notify } = await flag({ rows: [conflicting] });
    expect(out.blocks[0].message).toMatch(/applied at 10 lb per 1,000 sq ft/);
    expect(notify).toHaveBeenCalledTimes(1);
    // The reverse: a low total with a high entered rate is still judged by the higher figure.
    expect(limits.ratePer1000(row({ application_rate: 9, rate_unit: 'lb', total_amount: 6, amount_unit: 'lb', area_value: 1200, area_unit: 'sqft' }))).toBe(9);
  });

  test('the bag label rate of 1 lb per 100 sq ft (10 per 1,000, 1.3 lb N) is over the cap', () => {
    expect(limits.rateFindings([row({ application_rate: 10, rate_unit: 'lb' })])).toEqual([expect.objectContaining({ limitType: 'ornamental_fertilizer_rate', current: 10 })]);
    expect(limits.rateFindings([row({ application_rate: 7.5, rate_unit: 'lb' })])).toEqual([]);
  });

  test('a total with no treated area cannot be checked: the tech is told, the office is not rung', async () => {
    const { out, notify } = await flag({ rows: [row({ total_amount: 9, amount_unit: 'lb' })] });
    expect(out.blocks).toEqual([expect.objectContaining({ code: 'ornamental_fertilizer_rate_unchecked', message: expect.stringMatching(/enter the amount in lb and the treated square feet/) })]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('the history rules judge the hand-added row as the suggestion is judged', () => {
  const histRows = (history) => flag({ rows: [row({ application_rate: 7.5, rate_unit: 'lb' })], history });

  test('under five months after the last 13-0-13: flagged and sent to the office', async () => {
    const { out, notify } = await histRows([past('2028-07-20')]);
    expect(out.blocks).toEqual([expect.objectContaining({ code: 'application_limit_exceeded', message: expect.stringMatching(/less than five months ago/) })]);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ findings: [expect.objectContaining({ limitType: 'ornamental_fertilizer_history', reason: 'The last 13-0-13 application was less than five months ago.' })] }));
  });

  test('two already recorded in 12 months: flagged', async () => {
    const { out } = await flag({ rows: [row({ application_rate: 7.5, rate_unit: 'lb' })], history: [past('2028-02-10'), past('2027-12-01')] });
    expect(out.blocks[0].message).toMatch(/Two 13-0-13 applications are already recorded in the past year/);
  });

  test('a June to September date is flagged here too (the zone-based hard block is upstream)', async () => {
    const out = await limits.flagOrnamentalFertilizer({ svc: { ...svc, scheduled_date: '2028-07-10' }, record: { id: 'rec-1', service_date: '2028-07-10' }, database: fakeDb({ rows: [row({ application_rate: 7.5, rate_unit: 'lb' })] }), advisory: null, notify: jest.fn() });
    expect(out.blocks[0].message).toMatch(/not allowed June 1 to September 30/);
  });

  test('five months apart and a recent palm feed: nothing flagged; the record being judged is left out of its own history', async () => {
    const db = fakeDb({ rows: [row({ application_rate: 7.5, rate_unit: 'lb' })], history: [past('2028-04-12'), past('2028-09-20', { product_name: 'LESCO 0-0-16 #510513' })] });
    const notify = jest.fn();
    expect(await limits.flagOrnamentalFertilizer({ svc, record, database: db, advisory: null, notify })).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(db.seen.excluded).toBe('rec-1');
  });

  test('an unreadable history is flagged to the tech as unchecked and never throws', async () => {
    const { out, notify } = await flag({ rows: [row({ application_rate: 7.5, rate_unit: 'lb' })], failHistory: true });
    expect(out.blocks).toEqual([expect.objectContaining({ code: 'application_limit_check_unavailable' })]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('scope and merging', () => {
  test('a record with no 13-0-13 row reads no history and flags nothing; other products are ignored', async () => {
    const { out } = await flag({ rows: [row({ product_name: 'Snapshot 2.5TG', application_rate: 99, rate_unit: 'lb' })] });
    expect(out).toBeNull();
  });
  test('findings merge into an existing advisory and a failed read returns it unchanged', async () => {
    const prior = { advisory: true, blocks: [{ code: 'x', message: 'earlier' }] };
    const { out } = await flag({ rows: [row({ application_rate: 12, rate_unit: 'lb' })] }, prior);
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[0]).toEqual(prior.blocks[0]);
    const same = await limits.flagOrnamentalFertilizer({ svc, record, database: () => { throw new Error('boom'); }, advisory: prior, notify: jest.fn() });
    expect(same).toBe(prior);
  });
});

describe('the June to September blackout is still a hard block on a hand-added 13-0-13', () => {
  const typed = (date, zoneCity = 'Parrish') => validateTreeShrubTypedCompliance({
    service: { city: zoneCity, scheduled_date: date, service_type: 'Tree & Shrub Care' }, serviceDate: date, values: {},
    products: [{ productId: 'orn', name: ORN, totalAmount: 9, amountUnit: 'lb' }], productRows: [{ id: 'orn', name: ORN, category: 'fertilizer' }],
    completionPhotos: ['a', 'b'],
  });
  test('July blocks with tree_shrub_np_blackout; October does not', () => {
    expect(typed('2028-07-10').blocks.map((b) => b.code)).toContain('tree_shrub_np_blackout');
    expect(typed('2028-10-10').blocks.map((b) => b.code)).not.toContain('tree_shrub_np_blackout');
  });
});
