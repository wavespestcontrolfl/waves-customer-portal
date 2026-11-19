/**
 * taurus-yearly-count: the label-scenario rule, the concentration of a ledger row, the one query's
 * arguments, the ET year, and the fail-soft answers. The SQL itself runs on a real PostgreSQL in
 * taurus-yearly-count-postgres.test.js.
 */
jest.mock('../models/db', () => ({ raw: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  taurusYearlyCount, taurusEligible, applicationConcentration, etYearBounds,
  TAURUS_LOW_RATE_SINCE, TAURUS_NAME_PATTERN,
} = require('../services/taurus-yearly-count');

const VISIT = { id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1' };
const ledger = (rows) => ({ raw: jest.fn().mockResolvedValue({ rows }) });
const OLD = '2026-05-01';
const NEW = '2026-12-01';
let n = 0;
const row = (over = {}) => {
  n += 1;
  return { id: `row-${n}`, service_record_id: `rec-${n}`, application_date: NEW, application_rate: null, rate_unit: null, dilution_rate: null, ...over };
};

describe('taurusEligible (label scenarios for another 0.03% application)', () => {
  it.each([
    [{ high: 0, low: 0 }, true],
    [{ high: 0, low: 3 }, true],
    [{ high: 0, low: 4 }, false],
    [{ high: 0, low: 7 }, false],
    [{ high: 1, low: 0 }, true],
    [{ high: 1, low: 1 }, true],
    [{ high: 1, low: 2 }, false],
    [{ high: 2, low: 0 }, false],
    [{ high: 3, low: 0 }, false],
  ])('%j -> %s', (counts, expected) => {
    expect(taurusEligible(counts)).toBe(expected);
  });
});

describe("taurusEligible for another 0.06% application ({ rate: 'high' })", () => {
  it.each([
    [{ high: 0, low: 0 }, true],
    [{ high: 0, low: 2 }, true],
    [{ high: 0, low: 3 }, false],
    [{ high: 1, low: 0 }, true],
    [{ high: 1, low: 1 }, false],
    [{ high: 2, low: 0 }, false],
    [{ high: 0, low: 4 }, false],
  ])('%j -> %s', (counts, expected) => {
    expect(taurusEligible(counts, { rate: 'high' })).toBe(expected);
  });
});

describe('applicationConcentration', () => {
  it('counts a row before the 0.03% ruling as 0.06% when it records no concentration', () => {
    expect(TAURUS_LOW_RATE_SINCE).toBe('2026-11-20');
    expect(applicationConcentration(row({ application_date: '2026-11-19', rate_unit: 'oz', application_rate: '4' }))).toBe('high');
    expect(applicationConcentration(row({ application_date: '2026-11-19', rate_unit: 'oz', application_rate: '1.6' }))).toBe('high');
    expect(applicationConcentration(row({ application_date: '2026-04-08' }))).toBe('high');
  });

  it('lets a recorded concentration decide before the ruling date too (the rollout day)', () => {
    expect(applicationConcentration(row({ application_date: '2026-11-19', application_rate: '0.4', rate_unit: 'fl_oz/gal' }))).toBe('low');
    expect(applicationConcentration(row({ application_date: '2026-11-19', dilution_rate: '0.03%' }))).toBe('low');
    expect(applicationConcentration(row({ application_date: '2026-06-01', application_rate: '0.8', rate_unit: 'fl_oz/gal' }))).toBe('high');
  });

  it('counts a row from the ruling date on as 0.03% unless it says otherwise', () => {
    expect(applicationConcentration(row({ application_date: '2026-11-20' }))).toBe('low');
    expect(applicationConcentration(row({ application_rate: '1.6', rate_unit: 'oz' }))).toBe('low');
    expect(applicationConcentration(row({ application_rate: '0.4', rate_unit: 'fl_oz/gal' }))).toBe('low');
  });

  it('reads a later 0.06% row from its fl oz per gallon rate or its dilution', () => {
    expect(applicationConcentration(row({ application_rate: '0.8', rate_unit: 'fl_oz/gal' }))).toBe('high');
    expect(applicationConcentration(row({ application_rate: 0.8, rate_unit: 'FL OZ/GAL' }))).toBe('high');
    expect(applicationConcentration(row({ dilution_rate: '0.06%' }))).toBe('high');
    expect(applicationConcentration(row({ dilution_rate: '0.1' }))).toBe('high');
    expect(applicationConcentration(row({ dilution_rate: '0.03%' }))).toBe('low');
    expect(applicationConcentration(row({ dilution_rate: 'unknown' }))).toBe('low');
  });

  it('reads a later amount above the house mix (1.6 fl oz, one 4-gal tank) as the old 0.06% tank', () => {
    expect(applicationConcentration(row({ quantity_applied: '3.2', quantity_unit: 'fl_oz' }))).toBe('high');
    expect(applicationConcentration(row({ quantity_applied: 4, quantity_unit: 'oz' }))).toBe('high');
    expect(applicationConcentration(row({ application_rate: '3.2', rate_unit: 'oz' }))).toBe('high');
    expect(applicationConcentration(row({ application_rate: 4, rate_unit: 'fl oz' }))).toBe('high');
    // The house amount itself, a smaller one, or an amount in another unit stays 0.03%.
    expect(applicationConcentration(row({ quantity_applied: '1.600', quantity_unit: 'fl_oz' }))).toBe('low');
    expect(applicationConcentration(row({ application_rate: 1.6, rate_unit: 'oz' }))).toBe('low');
    expect(applicationConcentration(row({ quantity_applied: 2, quantity_unit: 'gal' }))).toBe('low');
    expect(applicationConcentration(row({ quantity_applied: 3.2 }))).toBe('low');
  });

  it('lets a recorded concentration decide over the amount (two house-strength tanks stay 0.03%)', () => {
    expect(applicationConcentration(row({ application_rate: '0.4', rate_unit: 'fl_oz/gal', quantity_applied: '3.2', quantity_unit: 'fl_oz' }))).toBe('low');
    expect(applicationConcentration(row({ dilution_rate: '0.03%', quantity_applied: 3.2, quantity_unit: 'fl_oz' }))).toBe('low');
    expect(applicationConcentration(row({ dilution_rate: '0.06%', application_rate: '0.4', rate_unit: 'fl_oz/gal' }))).toBe('high');
    expect(applicationConcentration(row({ application_rate: '0.8', rate_unit: 'fl_oz/gal', quantity_applied: '1.6', quantity_unit: 'fl_oz' }))).toBe('high');
  });

  it('reads an oz/gal rate like fl_oz/gal, and a teaspoon amount in fl oz', () => {
    expect(applicationConcentration(row({ application_rate: '0.8', rate_unit: 'oz/gal' }))).toBe('high');
    expect(applicationConcentration(row({ application_rate: '0.4', rate_unit: 'oz/gal', quantity_applied: 3.2, quantity_unit: 'fl_oz' }))).toBe('low');
    expect(applicationConcentration(row({ quantity_applied: 19.2, quantity_unit: 'tsp' }))).toBe('high'); // 3.2 fl oz
    expect(applicationConcentration(row({ quantity_applied: 9.6, quantity_unit: 'tsp' }))).toBe('low'); // 1.6 fl oz
  });
});

describe('etYearBounds', () => {
  it('uses the ET calendar year, not the UTC one, at the year boundary', () => {
    // 11 PM ET Dec 31 2026 is already Jan 1 2027 in UTC.
    expect(etYearBounds(new Date('2027-01-01T04:00:00Z'))).toEqual({ year: 2026, yearStart: '2026-01-01', nextYearStart: '2027-01-01' });
    // 12:30 AM ET Jan 1 2027 (05:30Z) is the new year.
    expect(etYearBounds(new Date('2027-01-01T05:30:00Z'))).toEqual({ year: 2027, yearStart: '2027-01-01', nextYearStart: '2028-01-01' });
    // 7 PM ET Dec 31 2026 (00:00Z Jan 1) is still 2026.
    expect(etYearBounds(new Date('2027-01-01T00:00:00Z')).year).toBe(2026);
  });
});

describe('taurusYearlyCount', () => {
  it('passes the home, the visit to leave out, the ET year window and the name rule; one read-only query', async () => {
    const knex = ledger([]);
    const out = await taurusYearlyCount(VISIT, { knex, now: new Date('2027-01-01T04:00:00Z') });
    expect(out).toEqual({ high: 0, low: 0, count: 0, eligible: true, eligibleHigh: true, year: 2026 });
    expect(knex.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = knex.raw.mock.calls[0];
    expect(bindings).toEqual({
      customerId: 'cust-1', propertyId: 'prop-1', visitId: 'visit-1',
      yearStart: '2026-01-01', nextYearStart: '2027-01-01', namePattern: TAURUS_NAME_PATTERN,
    });
    // The ledger, not retracted rows, no row lock, no write.
    expect(sql).toMatch(/FROM property_application_history/);
    expect(sql).toMatch(/retracted_at IS NULL/);
    expect(sql).not.toMatch(/FOR\s+(UPDATE|SHARE)|INSERT|UPDATE\s|DELETE/i);
  });

  it('falls back to the customer when the visit has no property, and leaves out no visit without an id', async () => {
    const knex = ledger([]);
    await taurusYearlyCount({ customer_id: 'cust-1' }, { knex });
    expect(knex.raw.mock.calls[0][1]).toMatchObject({ customerId: 'cust-1', propertyId: null, visitId: null });
  });

  it('counts one application per service record, at its highest concentration', async () => {
    const knex = ledger([
      row({ service_record_id: 'rec-a', application_date: OLD }),
      row({ service_record_id: 'rec-a', application_date: OLD }),
      row({ service_record_id: 'rec-b', application_date: NEW }),
      row({ service_record_id: 'rec-b', application_date: NEW, application_rate: '0.8', rate_unit: 'fl_oz/gal' }),
      row({ service_record_id: null, application_date: NEW }),
    ]);
    // rec-a: one 0.06%; rec-b: two rows, one 0.06% -> one 0.06%; the record-less row is its own 0.03% application.
    expect(await taurusYearlyCount(VISIT, { knex, now: new Date('2026-12-10T15:00:00Z') })).toEqual({ high: 2, low: 1, count: 3, eligible: false, eligibleHigh: false, year: 2026 });
  });

  it.each([
    ['four at 0.03% use the year up', [NEW, NEW, NEW, NEW].map((d) => row({ application_date: d })), { high: 0, low: 4, eligible: false }],
    ['three at 0.03% leave one', [NEW, NEW, NEW].map((d) => row({ application_date: d })), { high: 0, low: 3, eligible: true }],
    ['one 0.06% and one 0.03% leave room', [row({ application_date: OLD }), row()], { high: 1, low: 1, eligible: true }],
    ['one 0.06% and two 0.03% use the year up', [row({ application_date: OLD }), row(), row()], { high: 1, low: 2, eligible: false }],
    ['two 0.06% use the year up', [row({ application_date: OLD }), row({ application_date: OLD })], { high: 2, low: 0, eligible: false }],
  ])('%s', async (_name, rows, expected) => {
    expect(await taurusYearlyCount(VISIT, { knex: ledger(rows) })).toMatchObject(expected);
  });

  it('checks both years for a visit scheduled in another year than today, and is eligible only when both are', async () => {
    const answers = { '2026-01-01': [row({ application_date: OLD }), row({ application_date: OLD })], '2027-01-01': [] };
    const knex = { raw: jest.fn(async (sql, b) => ({ rows: answers[b.yearStart] })) };
    // A December 2026 visit recapped on 2027-01-04: December's year is used up (two 0.06%), January's is empty.
    const out = await taurusYearlyCount({ ...VISIT, scheduled_date: '2026-12-30' }, { knex, now: new Date('2027-01-04T15:00:00Z') });
    expect(knex.raw).toHaveBeenCalledTimes(2);
    expect(knex.raw.mock.calls.map(([, b]) => b.yearStart).sort()).toEqual(['2026-01-01', '2027-01-01']);
    expect(out).toMatchObject({ eligible: false, eligibleHigh: false, high: 2, year: 2026 });
    // Both years with room: eligible.
    const roomy = { raw: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await taurusYearlyCount({ ...VISIT, scheduled_date: new Date('2026-12-30T05:00:00Z') }, { knex: roomy, now: new Date('2027-01-04T15:00:00Z') }))
      .toMatchObject({ eligible: true, eligibleHigh: true });
    expect(roomy.raw).toHaveBeenCalledTimes(2);
  });

  it('runs one query when the scheduled date is in the same year as today, or missing', async () => {
    for (const scheduled_date of ['2026-12-10', null, undefined, 'not a date']) {
      const knex = ledger([]);
      await taurusYearlyCount({ ...VISIT, scheduled_date }, { knex, now: new Date('2026-12-10T15:00:00Z') });
      expect(knex.raw).toHaveBeenCalledTimes(1);
    }
  });

  it('answers unknown (null) with no customer, without a query', async () => {
    const knex = ledger([]);
    expect(await taurusYearlyCount({ id: 'visit-1' }, { knex })).toBeNull();
    expect(await taurusYearlyCount(null, { knex })).toBeNull();
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it('answers unknown (null) when the read fails or returns no rows array', async () => {
    const failing = { raw: jest.fn().mockRejectedValue(Object.assign(new Error('boom: SELECT ...'), { code: '57014' })) };
    expect(await taurusYearlyCount(VISIT, { knex: failing })).toBeNull();
    expect(await taurusYearlyCount(VISIT, { knex: { raw: jest.fn().mockResolvedValue({}) } })).toBeNull();
    // One of two years failing leaves the whole answer unknown.
    const half = { raw: jest.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('x')) };
    expect(await taurusYearlyCount({ ...VISIT, scheduled_date: '2025-12-30' }, { knex: half, now: new Date('2026-12-10T15:00:00Z') })).toBeNull();
  });
});
