// P4 payer AR / aging. The bucketing + summary math is pure (no DB); the two
// read helpers use a thenable db-builder mock that resolves preset rows.

let mockRows = [];
jest.mock('../models/db', () => {
  const builder = {
    where() { return this; },
    whereIn() { return this; },
    whereNotNull() { return this; },
    leftJoin() { return this; },
    orderBy() { return this; },
    select() { return this; },
    then(resolve, reject) { return Promise.resolve(mockRows).then(resolve, reject); },
  };
  return jest.fn(() => builder);
});
// Fix "today" so aging is deterministic.
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-06-21' }));

const ar = require('../services/payer-ar');

beforeEach(() => { mockRows = []; });

describe('bucketForDaysPastDue', () => {
  test('maps day-counts to buckets', () => {
    expect(ar.bucketForDaysPastDue(-5)).toBe('current');
    expect(ar.bucketForDaysPastDue(0)).toBe('current');
    expect(ar.bucketForDaysPastDue(1)).toBe('b1_15');
    expect(ar.bucketForDaysPastDue(15)).toBe('b1_15');
    expect(ar.bucketForDaysPastDue(16)).toBe('b16_30');
    expect(ar.bucketForDaysPastDue(30)).toBe('b16_30');
    expect(ar.bucketForDaysPastDue(31)).toBe('b31_45');
    expect(ar.bucketForDaysPastDue(45)).toBe('b31_45');
    expect(ar.bucketForDaysPastDue(46)).toBe('b45_plus');
  });
});

describe('ageStatement', () => {
  test('keys days-past-due on the statement due_date (ET)', () => {
    expect(ar.ageStatement({ due_date: '2026-06-01' })).toMatchObject({ days_past_due: 20, overdue: true, aging_bucket: 'b16_30' });
    expect(ar.ageStatement({ due_date: '2026-07-01' })).toMatchObject({ days_past_due: -10, overdue: false, aging_bucket: 'current' });
    expect(ar.ageStatement({ due_date: '2026-06-21' })).toMatchObject({ days_past_due: 0, overdue: false, aging_bucket: 'current' });
  });

  test('no due_date → not overdue', () => {
    expect(ar.ageStatement({})).toMatchObject({ days_past_due: null, overdue: false });
  });
});

describe('summarize', () => {
  test('rolls totals into buckets + by-terms, tracks oldest past-due', () => {
    const s = ar.summarize([
      { total: 100, terms_snapshot: 'net30', due_date: '2026-06-01' }, // 20d past due
      { total: 50, terms_snapshot: 'net15', due_date: '2026-07-01' },  // not due
      { total: 200, terms_snapshot: 'net30', due_date: '2026-04-01' }, // 81d past due
    ]);
    expect(s.outstanding_total).toBe(350);
    expect(s.past_due_total).toBe(300);   // only the two overdue
    expect(s.statement_count).toBe(3);
    expect(s.oldest_days_past_due).toBe(81);
    expect(s.buckets.b16_30).toMatchObject({ count: 1, total: 100 });
    expect(s.buckets.b45_plus).toMatchObject({ count: 1, total: 200 });
    expect(s.buckets.current).toMatchObject({ count: 1, total: 50 });
    expect(s.by_terms.net30).toMatchObject({ count: 2, total: 300 });
    expect(s.by_terms.net15).toMatchObject({ count: 1, total: 50 });
  });

  test('empty → zeros (gate-dark safe)', () => {
    const s = ar.summarize([]);
    expect(s.outstanding_total).toBe(0);
    expect(s.past_due_total).toBe(0);
    expect(s.oldest_days_past_due).toBeNull();
  });
});

describe('payerArForPayer', () => {
  test('returns outstanding statements with derived aging + summary', async () => {
    mockRows = [
      { id: 1, payer_id: 9, status: 'sent', total: 100, terms_snapshot: 'net30', due_date: '2026-06-01' },
      { id: 2, payer_id: 9, status: 'finalized', total: 40, terms_snapshot: 'net15', due_date: '2026-07-10' },
    ];
    const res = await ar.payerArForPayer(9);
    expect(res.summary.outstanding_total).toBe(140);
    expect(res.statements).toHaveLength(2);
    expect(res.statements[0]).toMatchObject({ id: 1, overdue: true, aging_bucket: 'b16_30' });
    expect(res.statements[1]).toMatchObject({ id: 2, overdue: false });
  });

  test('invalid payer id → empty', async () => {
    const res = await ar.payerArForPayer('nope');
    expect(res.summary.outstanding_total).toBe(0);
    expect(res.statements).toHaveLength(0);
  });
});

describe('computePayerArAging', () => {
  test('aggregates org-wide + per-payer worklist sorted by oldest past-due', async () => {
    mockRows = [
      { id: 1, payer_id: 9, status: 'sent', terms_snapshot: 'net30', total: 100, due_date: '2026-06-01', payer_name: 'Acme', payer_company: 'Acme Builders' },
      { id: 2, payer_id: 7, status: 'viewed', terms_snapshot: 'net15', total: 500, due_date: '2026-04-01', payer_name: 'West Bay', payer_company: null },
      { id: 3, payer_id: 9, status: 'processing', terms_snapshot: 'net30', total: 60, due_date: '2026-07-01', payer_name: 'Acme', payer_company: 'Acme Builders' },
    ];
    const res = await ar.computePayerArAging();
    expect(res.outstanding_total).toBe(660);
    expect(res.by_terms.net30).toMatchObject({ count: 2, total: 160 });
    expect(res.by_terms.net15).toMatchObject({ count: 1, total: 500 });
    // Worklist sorted by oldest past-due first → payer 7 (81d) ahead of payer 9 (20d).
    expect(res.payers[0]).toMatchObject({ payer_id: 7, payer_name: 'West Bay', oldest_days_past_due: 81 });
    expect(res.payers[1]).toMatchObject({ payer_id: 9, payer_name: 'Acme Builders' });
    expect(res.payers[1].outstanding_total).toBe(160);
  });
});
