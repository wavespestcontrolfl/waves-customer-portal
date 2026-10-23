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

  test('the sheet\'s weight units (oz, g, lb) are all judged in pounds', () => {
    const area = { area_value: 1200, area_unit: 'sqft' };
    expect(limits.ratePer1000(row({ total_amount: 144, amount_unit: 'oz', ...area }))).toBe(7.5);
    expect(limits.ratePer1000(row({ total_amount: 4082.328, amount_unit: 'g', ...area }))).toBeCloseTo(7.5, 3);
    expect(limits.rateFindings([row({ total_amount: 192, amount_unit: 'oz', ...area })])).toEqual([expect.objectContaining({ current: 10 })]);
    expect(limits.ratePer1000(row({ total_amount: 9, amount_unit: 'fl_oz', ...area }))).toBeNull();
  });

  test('an entered oz or g rate is converted to pounds before the cap, and an overridden total still wins when higher', async () => {
    expect(limits.ratePer1000(row({ application_rate: 120, rate_unit: 'oz' }))).toBe(7.5);
    expect(limits.ratePer1000(row({ application_rate: 120, rate_unit: 'oz/1000sf' }))).toBe(7.5);
    expect(limits.ratePer1000(row({ application_rate: 3401.94, rate_unit: 'g' }))).toBeCloseTo(7.5, 3);
    expect(limits.ratePer1000(row({ application_rate: 5, rate_unit: 'fl_oz' }))).toBeNull();
    expect(limits.ratePer1000(row({ application_rate: 5, rate_unit: 'lb/palm' }))).toBeNull();
    // 160 oz/1k is 10 lb/1k; a total of 6 lb over 1,000 sq ft reads 6; the higher reading (10) is judged and sent to the office.
    const conflicting = row({ application_rate: 160, rate_unit: 'oz', total_amount: 6, amount_unit: 'lb', area_value: 1000, area_unit: 'sqft' });
    expect(limits.ratePer1000(conflicting)).toBe(10);
    const { out, notify } = await flag({ rows: [conflicting] });
    expect(out.blocks[0].message).toMatch(/applied at 10 lb per 1,000 sq ft/);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('the bag label rate of 1 lb per 100 sq ft (10 per 1,000, 1.3 lb N) is over the cap', () => {
    expect(limits.rateFindings([row({ application_rate: 10, rate_unit: 'lb' })])).toEqual([expect.objectContaining({ limitType: 'ornamental_fertilizer_rate', current: 10 })]);
    expect(limits.rateFindings([row({ application_rate: 7.5, rate_unit: 'lb' })])).toEqual([]);
  });

  test('a total with no treated area cannot be checked: flagged to the tech AND sent to the office', async () => {
    const { out, notify } = await flag({ rows: [row({ total_amount: 9, amount_unit: 'lb' })] });
    expect(out.blocks).toEqual([expect.objectContaining({ code: 'application_limit_exceeded', productId: 'orn', message: expect.stringMatching(/13-0-13 .*recorded with no treated sq ft; county cap not checked/) })]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ findings: [expect.objectContaining({ code: 'application_limit_exceeded', limitType: 'ornamental_fertilizer_rate_unchecked', reason: 'area_missing', max: 7.5 })] }));
    expect(notify.mock.calls[0][0].findings[0].advisoryOnly).toBeUndefined();
  });

  test('a row with no amount and no rate at all is sent to the office too, with its own reason', async () => {
    const { out, notify } = await flag({ rows: [row()] });
    expect(out.blocks[0].message).toMatch(/recorded with no usable amount or rate; county cap not checked/);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ findings: [expect.objectContaining({ limitType: 'ornamental_fertilizer_rate_unchecked', reason: 'rate_missing' })] }));
  });

  test('a row whose cap can be read (rate, or total over area) never rings the unchecked finding', async () => {
    for (const ok of [row({ application_rate: 7.5, rate_unit: 'lb' }), row({ total_amount: 9, amount_unit: 'lb', area_value: 1200, area_unit: 'sqft' })]) {
      const { notify } = await flag({ rows: [ok] });
      expect(notify).not.toHaveBeenCalled();
    }
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

  test('the zone comes from the visit\'s city as the closeout reads it: North Port is not flagged in July, Sarasota is', async () => {
    const run = (city) => limits.flagOrnamentalFertilizer({ svc: { ...svc, city, scheduled_date: '2028-07-10' }, record: { id: 'rec-1', service_date: '2028-07-10' }, database: fakeDb({ rows: [row({ application_rate: 7.5, rate_unit: 'lb' })] }), advisory: null, notify: jest.fn() });
    expect(await run('North Port')).toBeNull();
    expect((await run('Sarasota')).blocks[0].message).toMatch(/not allowed June 1 to September 30/);
    expect((await run(undefined)).blocks[0].message).toMatch(/not allowed June 1 to September 30/);
  });

  test('an unidentified history row older than 12 months does not flag a new feeding; a recent or undated one does', async () => {
    const unidentified = (date) => ({ product_name: null, catalog_name: null, application_date: date, property_id: 'prop-1', ledger_property_id: 'prop-1' });
    const run = (history) => limits.flagOrnamentalFertilizer({ svc, record, database: fakeDb({ rows: [row({ application_rate: 7.5, rate_unit: 'lb' })], history }), advisory: null, notify: jest.fn() });
    // Visit 2028-10-10: 2027-10-10 is exactly 12 months back, so it is out of the window.
    expect(await run([unidentified('2026-03-01'), unidentified('2027-10-10')])).toBeNull();
    for (const date of ['2027-10-11', '2028-06-01', null]) {
      expect((await run([unidentified(date)])).blocks[0].message).toMatch(/unidentified product/);
    }
  });

  test('an unreadable history is flagged as unchecked, rings the office (Codex #6516 r2) and never throws', async () => {
    const { out, notify } = await flag({ rows: [row({ application_rate: 7.5, rate_unit: 'lb' })], failHistory: true });
    expect(out.blocks).toEqual([expect.objectContaining({ code: 'application_limit_exceeded',
      message: expect.stringContaining('history could not be read; 2-a-year and 5-month rules not checked') })]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].findings).toEqual([expect.objectContaining({ limitType: limits.HISTORY_UNCHECKED_LIMIT_TYPE, reason: 'history_unavailable' })]);
  });

  test('the history-unchecked and rate-unchecked findings of one record are different findings (own limit type)', async () => {
    const { notify } = await flag({ rows: [row({ total_amount: 9, amount_unit: 'lb' })], failHistory: true });
    const types = notify.mock.calls[0][0].findings.map((f) => f.limitType);
    expect(types.sort()).toEqual([limits.HISTORY_UNCHECKED_LIMIT_TYPE, limits.UNCHECKED_LIMIT_TYPE].sort());
    expect(limits.HISTORY_UNCHECKED_LIMIT_TYPE).not.toBe(limits.UNCHECKED_LIMIT_TYPE);
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

describe('the post-save read of the record\'s rows fails (Codex #6516 r7)', () => {
  const failing = () => { const db = fakeDb({ rows: [] }); const broken = () => { throw new Error('rows down'); }; broken.raw = db.raw; return broken; };
  const run = (names) => {
    const notify = jest.fn(async () => {});
    return limits.flagOrnamentalFertilizer({ svc, record, database: failing(), advisory: null, notify, submittedProductNames: names }).then((out) => ({ out, notify }));
  };
  test('a 13-0-13 among the submitted products rings the office and tells the tech', async () => {
    const { out, notify } = await run(['Celsius WG', ORN]);
    expect(out.blocks).toEqual([expect.objectContaining({ code: 'application_limit_exceeded', message: '13-0-13 limits could not be checked for this visit; the office will review.' })]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].findings).toEqual([expect.objectContaining({ limitType: limits.AUDIT_UNAVAILABLE_LIMIT_TYPE, reason: 'audit_unavailable', productName: ORN })]);
    expect(notify.mock.calls[0][0].findings[0].advisoryOnly).toBeUndefined();
  });
  test('a visit that submitted no 13-0-13 (or no products at all) rings nothing', async () => {
    for (const names of [['Celsius WG', 'Snapshot 2.5TG'], [], undefined]) {
      const { out, notify } = await run(names);
      expect(out).toBeNull();
      expect(notify).not.toHaveBeenCalled();
    }
  });
  test('it has its own limit type, apart from the rate-unchecked and history-unchecked findings', () => {
    expect(new Set(limits.UNCHECKED_LIMIT_TYPES).size).toBe(3);
    expect(limits.UNCHECKED_LIMIT_TYPES).toContain(limits.AUDIT_UNAVAILABLE_LIMIT_TYPE);
  });
});

describe('a 13-0-13 on a lawn-primary visit with a Tree & Shrub companion is judged the same (the row is the trigger)', () => {
  const lawnSvc = { ...svc, service_type: 'Lawn Care', city: 'Sarasota' };
  const run = (opts, extra = {}) => {
    const notify = jest.fn(async () => {});
    return limits.flagOrnamentalFertilizer({ svc: lawnSvc, record, database: fakeDb(opts), advisory: null, notify, ...extra }).then((out) => ({ out, notify }));
  };
  test('an over-cap 13-0-13 rings the office', async () => {
    const { out, notify } = await run({ rows: [row({ total_amount: 12, amount_unit: 'lb', area_value: 1200, area_unit: 'sqft' })] });
    expect(out.blocks[0]).toMatchObject({ code: 'application_limit_exceeded' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].svc).toBe(lawnSvc);
    expect(notify.mock.calls[0][0].findings[0]).toMatchObject({ limitType: 'ornamental_fertilizer_rate', current: 10 });
  });
  test('the history and zone rules read the lawn visit\'s customer, property and city (a July visit in Sarasota is held)', async () => {
    const july = { ...lawnSvc, scheduled_date: '2028-07-10' };
    const notify = jest.fn(async () => {});
    const db = fakeDb({ rows: [row({ application_rate: 7.5, rate_unit: 'lb' })], history: [past('2028-02-10')] });
    const out = await limits.flagOrnamentalFertilizer({ svc: july, record: { id: 'rec-1', service_date: '2028-07-10' }, database: db, advisory: null, notify });
    expect(out.blocks.map((b) => b.message).join(' ')).toMatch(/not allowed June 1 to September 30/);
    expect(db.seen.excluded).toBe('rec-1');
  });
  test('a lawn visit with no 13-0-13 row does nothing and reads no history', async () => {
    const db = fakeDb({ rows: [row({ product_name: 'Celsius WG', application_rate: 99, rate_unit: 'oz' })], failHistory: true });
    const notify = jest.fn();
    expect(await limits.flagOrnamentalFertilizer({ svc: lawnSvc, record, database: db, advisory: null, notify })).toBeNull();
    expect(notify).not.toHaveBeenCalled();
    const none = await run({ rows: [] });
    expect(none.out).toBeNull();
    expect(none.notify).not.toHaveBeenCalled();
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
