/**
 * payment-history — authoritative history for absence claims (Codex round-10/11
 * P1, PR #5331): payer exclusion in SQL BEFORE the limit, exact `complete`,
 * lazy loading, fail closed.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const { loadPaymentHistory, ensureAbsenceHistory, PAYMENT_HISTORY_CAP } = require('../services/payment-history');

function fakeDb(rows, { fail = false } = {}) {
  const calls = [];
  const q = {};
  ['where', 'whereNot', 'whereNull', 'whereRaw', 'orderBy', 'limit'].forEach((m) => {
    q[m] = jest.fn((...args) => { calls.push([m, args]); return q; });
  });
  q.then = (res, rej) => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(rows)).then(res, rej);
  const dbh = jest.fn(() => q);
  dbh.calls = calls;
  return dbh;
}

describe('loadPaymentHistory', () => {
  test('excludes payer-billed invoices IN SQL, before the limit; reads cap+1', async () => {
    const dbh = fakeDb([{ id: 1 }]);
    await loadPaymentHistory('c1', dbh);
    const names = dbh.calls.map(([m]) => m);
    expect(names.indexOf('whereRaw')).toBeGreaterThan(-1);
    expect(names.indexOf('whereRaw')).toBeLessThan(names.indexOf('limit'));
    const raw = dbh.calls.find(([m]) => m === 'whereRaw')[1];
    expect(raw[0]).toMatch(/NOT IN \(SELECT id::text FROM invoices WHERE customer_id = \? AND payer_id IS NOT NULL\)/);
    expect(raw[1]).toEqual(['c1']);
    expect(dbh.calls.find(([m]) => m === 'limit')[1]).toEqual([PAYMENT_HISTORY_CAP + 1]);
    expect(dbh.calls.some(([m, a]) => m === 'whereNot' && a[1] === 'upcoming')).toBe(true);
  });

  test('complete is exact: <= cap rows complete; cap+1 rows is truncated to cap and incomplete', async () => {
    const few = await loadPaymentHistory('c1', fakeDb(Array.from({ length: 4 }, (_, i) => ({ id: i }))));
    expect(few).toEqual({ rows: expect.any(Array), complete: true });
    expect(few.rows).toHaveLength(4);
    const exactlyCap = await loadPaymentHistory('c1', fakeDb(Array.from({ length: PAYMENT_HISTORY_CAP }, (_, i) => ({ id: i }))));
    expect(exactlyCap.complete).toBe(true);
    const over = await loadPaymentHistory('c1', fakeDb(Array.from({ length: PAYMENT_HISTORY_CAP + 1 }, (_, i) => ({ id: i }))));
    expect(over.complete).toBe(false);
    expect(over.rows).toHaveLength(PAYMENT_HISTORY_CAP);
  });

  test('a failed read returns null (unknown => fail closed); no customer returns null', async () => {
    expect(await loadPaymentHistory('c1', fakeDb([], { fail: true }))).toBeNull();
    expect(await loadPaymentHistory(null, fakeDb([]))).toBeNull();
  });
});

describe('ensureAbsenceHistory (lazy)', () => {
  const ctx = (billing) => ({ customer: { id: 'c1' }, billing });

  test('no read unless the reply makes an ABSENCE claim AND the display window may be truncated', async () => {
    const dbh = fakeDb([{ id: 1 }]);
    const notAbsence = ctx({ recentPayments: [], recentPaymentsTruncated: true });
    await ensureAbsenceHistory(notAbsence, 'We received your $120 payment from Sep 12.', dbh);
    expect(dbh).not.toHaveBeenCalled();
    expect(notAbsence.billing.paymentHistory).toBeUndefined();
    const notTruncated = ctx({ recentPayments: [], recentPaymentsTruncated: false });
    await ensureAbsenceHistory(notTruncated, "Your payment isn't showing yet.", dbh);
    expect(dbh).not.toHaveBeenCalled();
  });

  test('absence claim + truncated window: loads once, attaches, idempotent', async () => {
    const dbh = fakeDb([{ id: 1, amount: 120 }]);
    const c = ctx({ recentPayments: [], recentPaymentsTruncated: true });
    await ensureAbsenceHistory(c, "Your payment isn't showing on our end yet.", dbh);
    expect(c.billing.paymentHistory).toEqual({ rows: [{ id: 1, amount: 120 }], complete: true });
    await ensureAbsenceHistory(c, "We haven't received it.", dbh);
    expect(dbh).toHaveBeenCalledTimes(1);
  });

  test('a failed load attaches null (validator then rejects)', async () => {
    const c = ctx({ recentPayments: [], recentPaymentsTruncated: true });
    await ensureAbsenceHistory(c, "Your payment isn't showing.", fakeDb([], { fail: true }));
    expect(c.billing.paymentHistory).toBeNull();
  });
});

describe('Codex round-12 P0: payer-owned rows with no invoice_id', () => {
  test('payments.payer_id IS NULL is applied in SQL before the limit', async () => {
    const dbh = fakeDb([{ id: 1 }]);
    await loadPaymentHistory('c1', dbh);
    const names = dbh.calls.map(([m]) => m);
    expect(dbh.calls.some(([m, a]) => m === 'whereNull' && a[0] === 'payments.payer_id')).toBe(true);
    expect(names.indexOf('whereNull')).toBeLessThan(names.indexOf('limit'));
  });
});

describe('Codex round-12 P0: the aggregator\'s Recent payments read excludes payer-owned rows in SQL too', () => {
  test('getContextForCustomer\'s db(\'payments\') display read carries whereNull(\'payments.payer_id\') before its limit', () => {
    const src = require('fs').readFileSync(require.resolve('../services/context-aggregator'), 'utf8');
    const line = src.split('\n').find((l) => /db\('payments'\)\.where\(\{ 'payments\.customer_id': customer\.id \}\)/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/whereNull\('payments\.payer_id'\)/);
    expect(line.indexOf("whereNull('payments.payer_id')")).toBeLessThan(line.indexOf('.limit('));
  });
});
