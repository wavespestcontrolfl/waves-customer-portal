/**
 * Codex round-13 P1 (PR #5331): billing.hasProcessingPayment is an authoritative
 * EXISTENCE answer (payment-history.hasInFlightMoney), NOT derived from the
 * 5-row Recent payments display window. Five newer paid rows push an older
 * processing row out of the window; the flag must still be true.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/payment-history', () => ({
  ...jest.requireActual('../services/payment-history'),
  hasInFlightMoney: jest.fn(),
}));
jest.mock('../models/db', () => {
  const windowRows = [1, 2, 3, 4, 5].map((n) => ({
    id: `p${n}`, amount: 40 + n, status: 'paid', payment_date: `2026-09-2${n}`, payer_id: null, metadata: null,
  }));
  const rowsFor = (table) => (table === 'payments' ? windowRows : []);
  const mk = (table) => {
    const q = {};
    for (const m of ['where', 'whereNull', 'whereNot', 'whereNotNull', 'whereIn', 'whereRaw', 'orWhere', 'orderBy', 'limit', 'select', 'leftJoin', 'join', 'count', 'andWhere', 'whereNotIn', 'modify', 'groupBy', 'distinct']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'customers' ? { id: 'c1' } : undefined));
    q.catch = jest.fn(() => Promise.resolve(rowsFor(table)));
    q.then = (res, rej) => Promise.resolve(rowsFor(table)).then(res, rej);
    return q;
  };
  const db = jest.fn((table) => mk(String(table).split(' ')[0]));
  db.raw = jest.fn(async () => ({ rows: [] }));
  db.fn = { now: jest.fn() };
  return db;
});

const aggregator = require('../services/context-aggregator');
const { hasInFlightMoney } = require('../services/payment-history');

const build = async () => {
  const ctx = await aggregator.getContextForCustomer({ id: 'c1', first_name: 'Test', last_name: 'Customer', phone: '+15555550100' });
  return ctx.billing;
};

describe('hasProcessingPayment comes from the existence query, not the display window', () => {
  test('5 newer PAID rows in the window + an older processing row elsewhere => true', async () => {
    hasInFlightMoney.mockResolvedValue(true);
    const billing = await build();
    expect(hasInFlightMoney).toHaveBeenCalledWith('c1');
    expect(billing.recentPayments.every((p) => p.status === 'paid')).toBe(true); // the processing row is NOT in the window
    expect(billing.hasProcessingPayment).toBe(true);
  });

  test('nothing in flight => false', async () => {
    hasInFlightMoney.mockResolvedValue(false);
    expect((await build()).hasProcessingPayment).toBe(false);
  });

  test('an unreadable existence query (null) fails closed as in flight', async () => {
    hasInFlightMoney.mockResolvedValue(null);
    expect((await build()).hasProcessingPayment).toBe(true);
  });
});
