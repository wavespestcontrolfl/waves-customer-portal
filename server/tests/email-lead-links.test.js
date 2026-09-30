jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { resolveEmailLinks, uuidOrNull } = require('../services/email-lead-links');

const EST = '11111111-1111-4111-8111-111111111111';
const EST2 = '44444444-4444-4444-8444-444444444444';
const LEAD = '22222222-2222-4222-8222-222222222222';
const CUST = '33333333-3333-4333-8333-333333333333';

// A leads table whose lookups are answered from two maps, recording each query.
function fakeDb({ byId = {}, byEstimate = {}, fail = false } = {}) {
  const calls = [];
  const dbh = (table) => {
    if (table !== 'leads') throw new Error(`unexpected table ${table}`);
    const q = { filters: {}, nullCols: [] };
    q.where = (f) => { Object.assign(q.filters, f); return q; };
    q.whereNull = (c) => { q.nullCols.push(c); return q; };
    q.orderBy = () => q;
    q.first = async () => {
      calls.push({ ...q.filters, nullCols: q.nullCols });
      if (fail) throw Object.assign(new Error('boom with a@b.example'), { code: 'XX000' });
      if (q.filters.id) return byId[q.filters.id] ? { id: q.filters.id } : undefined;
      if (q.filters.estimate_id) return byEstimate[q.filters.estimate_id] ? { id: byEstimate[q.filters.estimate_id] } : undefined;
      return undefined;
    };
    return q;
  };
  dbh.calls = calls;
  return dbh;
}

describe('resolveEmailLinks', () => {
  test('uuidOrNull accepts only real uuids, lower-cased', () => {
    expect(uuidOrNull(EST.toUpperCase())).toBe(EST);
    expect(uuidOrNull('est-1')).toBeNull();
    expect(uuidOrNull(null)).toBeNull();
    expect(uuidOrNull('123')).toBeNull();
  });

  test('test sends are never linked', async () => {
    const dbh = fakeDb({ byId: { [LEAD]: true } });
    await expect(resolveEmailLinks({ recipientType: 'lead', recipientId: LEAD, estimateId: EST, test: true }, dbh))
      .resolves.toEqual({ lead_id: null, estimate_id: null });
    expect(dbh.calls).toHaveLength(0);
  });

  test('lead-typed with a real lead id: records the lead, no estimate query needed', async () => {
    const dbh = fakeDb({ byId: { [LEAD]: true } });
    await expect(resolveEmailLinks({ recipientType: 'lead', recipientId: LEAD }, dbh))
      .resolves.toEqual({ lead_id: LEAD, estimate_id: null });
    expect(dbh.calls).toHaveLength(1);
  });

  test('lead-typed naming a customer id: not a lead; uses the estimate owner', async () => {
    const dbh = fakeDb({ byEstimate: { [EST]: LEAD } });
    await expect(resolveEmailLinks({ recipientType: 'lead', recipientId: CUST, estimateId: EST }, dbh))
      .resolves.toEqual({ lead_id: LEAD, estimate_id: EST });
    expect(dbh.calls[1].nullCols).toEqual(['deleted_at']);
  });

  test('no recipient id: estimate from estimateIds[0], then linkEstimateId, then payload.estimate_id', async () => {
    const dbh = fakeDb({ byEstimate: { [EST]: LEAD } });
    expect((await resolveEmailLinks({ recipientType: 'lead', estimateIds: [EST, EST2] }, dbh)).estimate_id).toBe(EST);
    expect((await resolveEmailLinks({ recipientType: 'lead', linkEstimateId: EST }, dbh)).estimate_id).toBe(EST);
    expect((await resolveEmailLinks({ recipientType: 'lead', payload: { estimate_id: EST } }, dbh)).lead_id).toBe(LEAD);
    expect((await resolveEmailLinks({ recipientType: 'lead', estimateId: 'not-a-uuid' }, dbh)))
      .toEqual({ lead_id: null, estimate_id: null });
  });

  test('untyped sends (assessment override) still resolve through an explicit estimate', async () => {
    const dbh = fakeDb({ byEstimate: { [EST]: LEAD } });
    await expect(resolveEmailLinks({ recipientType: null, estimateId: EST }, dbh))
      .resolves.toEqual({ lead_id: LEAD, estimate_id: EST });
  });

  test('customer-typed: estimate recorded, zero lead queries', async () => {
    const dbh = fakeDb();
    await expect(resolveEmailLinks({ recipientType: 'customer', recipientId: CUST, estimateId: EST }, dbh))
      .resolves.toEqual({ lead_id: null, estimate_id: EST });
    expect(dbh.calls).toHaveLength(0);
  });

  test('a lookup error is swallowed and logged without SQL or address; the estimate link survives', async () => {
    const logger = require('../services/logger');
    const dbh = fakeDb({ fail: true });
    await expect(resolveEmailLinks({ recipientType: 'lead', estimateId: EST }, dbh))
      .resolves.toEqual({ lead_id: null, estimate_id: EST });
    const msg = logger.warn.mock.calls.map((c) => c[0]).join(' ');
    expect(msg).toMatch(/XX000/);
    expect(msg).not.toMatch(/a@b\.example/);
  });
});
