/**
 * taurus-yearly-count: the argument contract of the one read-only query, the
 * ET year window, and the fail-soft answers. The SQL itself is exercised on a
 * real PostgreSQL in taurus-yearly-count-postgres.test.js.
 */
jest.mock('../models/db', () => ({ raw: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { taurusYearlyCount, etYearBounds, TAURUS_YEARLY_LIMIT } = require('../services/taurus-yearly-count');

const fakeKnex = (rows) => ({ raw: jest.fn().mockResolvedValue({ rows }) });
const VISIT = { id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1' };

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
  it('passes the home, the visit to leave out, the ET year window and the product name; one query', async () => {
    const knex = fakeKnex([{ count: 3 }]);
    const out = await taurusYearlyCount(VISIT, { knex, now: new Date('2027-01-01T04:00:00Z') });
    expect(out).toEqual({ count: 3, limit: TAURUS_YEARLY_LIMIT, year: 2026 });
    expect(knex.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = knex.raw.mock.calls[0];
    expect(bindings).toEqual({
      customerId: 'cust-1', propertyId: 'prop-1', visitId: 'visit-1',
      yearStart: '2026-01-01', nextYearStart: '2027-01-01', productName: 'Taurus SC',
    });
    // Read only: no row lock, no write.
    expect(sql).not.toMatch(/FOR\s+(UPDATE|SHARE)|INSERT|UPDATE\s|DELETE/i);
  });

  it('falls back to the customer when the visit has no property_id', async () => {
    const knex = fakeKnex([{ count: 2 }]);
    await taurusYearlyCount({ id: 'visit-1', customer_id: 'cust-1', property_id: null }, { knex });
    expect(knex.raw.mock.calls[0][1]).toMatchObject({ customerId: 'cust-1', propertyId: null });
  });

  it('leaves no visit out when the call has no visit id', async () => {
    const knex = fakeKnex([{ count: 1 }]);
    await taurusYearlyCount({ customer_id: 'cust-1' }, { knex });
    expect(knex.raw.mock.calls[0][1].visitId).toBeNull();
  });

  it('answers unknown (null) with no customer, without a query', async () => {
    const knex = fakeKnex([{ count: 1 }]);
    expect(await taurusYearlyCount({ id: 'visit-1' }, { knex })).toBeNull();
    expect(await taurusYearlyCount(null, { knex })).toBeNull();
    expect(knex.raw).not.toHaveBeenCalled();
  });

  it('answers unknown (null) when the read fails or returns nothing usable', async () => {
    const failing = { raw: jest.fn().mockRejectedValue(Object.assign(new Error('boom: SELECT ...'), { code: '57014' })) };
    expect(await taurusYearlyCount(VISIT, { knex: failing })).toBeNull();
    expect(await taurusYearlyCount(VISIT, { knex: fakeKnex([]) })).toBeNull();
  });
});
