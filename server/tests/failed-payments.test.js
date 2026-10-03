/**
 * services/failed-payments.js — the one failed-payment ledger the /balance route and the SMS grounding balance share.
 * Codex round-36: the strict (SMS) read is payer-aware and fail-closed; the route read is unchanged.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { loadFailedPaymentFacts, standaloneFailedTotal } = require('../services/failed-payments');

// A recording query builder: every chained call is captured; awaiting resolves with `result` (or rejects if it is an Error).
function fakeDb({ payments = [], invoices = [], invoiceError = null } = {}) {
  const calls = { payments: [], invoices: [] };
  const mk = (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'select']) { q[m] = jest.fn((...a) => { calls[table].push([m, a]); return q; }); }
    const settle = () => (table === 'invoices' && invoiceError ? Promise.reject(invoiceError) : Promise.resolve(table === 'payments' ? payments : invoices));
    q.then = (ok, bad) => settle().then(ok, bad);
    q.catch = (bad) => settle().catch(bad);
    return q;
  };
  const dbh = jest.fn((table) => mk(table));
  dbh.calls = calls;
  return dbh;
}
const row = (over = {}) => ({ id: 'p1', amount: 50, metadata: null, stripe_payment_intent_id: 'pi_1', retry_count: 1, next_retry_at: null, ...over });
const names = (dbh, table, method) => dbh.calls[table].filter(([m]) => m === method).map(([, a]) => a);

describe('loadFailedPaymentFacts — default (the /balance route): query shape unchanged', () => {
  test('failed only, no payer_id filter, original columns (+ id)', async () => {
    const dbh = fakeDb({ payments: [row()] });
    await loadFailedPaymentFacts('c1', dbh);
    expect(names(dbh, 'payments', 'where')).toEqual([[{ customer_id: 'c1', status: 'failed' }]]);
    expect(names(dbh, 'payments', 'whereNull')).toEqual([['superseded_by_payment_id']]);
    expect(names(dbh, 'payments', 'select')[0]).toEqual(['id', 'amount', 'metadata', 'stripe_payment_intent_id', 'retry_count', 'next_retry_at']);
  });
  test('a failing non-draft-invoice lookup still reads as "no carrying invoices" (the route swallowed it before)', async () => {
    const dbh = fakeDb({ payments: [row({ metadata: { invoice_id: 'inv-1' } })], invoiceError: new Error('boom') });
    const facts = await loadFailedPaymentFacts('c1', dbh);
    expect([...facts.balanceCarryingInvoiceIds]).toEqual([]);
  });
});

describe('loadFailedPaymentFacts — strict (SMS grounding)', () => {
  test('payer-owned rows are filtered in SQL and every column the payer-linkage predicate reads is selected', async () => {
    const dbh = fakeDb({ payments: [row()] });
    await loadFailedPaymentFacts('c1', dbh, { statuses: ['failed', 'pending', 'overdue'], strict: true });
    expect(names(dbh, 'payments', 'whereIn')).toEqual([['status', ['failed', 'pending', 'overdue']]]);
    expect(names(dbh, 'payments', 'whereNull')).toEqual([['superseded_by_payment_id'], ['payer_id']]);
    const cols = names(dbh, 'payments', 'select')[0];
    for (const c of ['metadata', 'stripe_payment_intent_id', 'stripe_charge_id', 'description', 'payer_id']) expect(cols).toContain(c);
  });
  test('an AP row only the predicate can see (charge id / description linkage) is excluded from the total', async () => {
    const { buildPayerLinkage } = require('../services/payer-linkage');
    const linkage = buildPayerLinkage([{ id: 'payer-inv', stripe_payment_intent_id: null, stripe_charge_id: 'ch_payer', invoice_number: 'WPC-2026-0900' }]);
    const viaCharge = row({ id: 'a', amount: 70, stripe_charge_id: 'ch_payer' });
    const viaDescription = row({ id: 'b', amount: 80, description: 'Invoice WPC-2026-0900 — pest control' });
    const own = row({ id: 'c', amount: 25 });
    const facts = { rows: [viaCharge, viaDescription, own], balanceCarryingInvoiceIds: new Set() };
    expect(standaloneFailedTotal(facts, (p) => linkage.isPayerLinked(p))).toBe(25);
  });
  test('a failing invoice lookup THROWS (the aggregator marks billing unavailable) instead of becoming an empty set', async () => {
    const dbh = fakeDb({ payments: [row({ metadata: { invoice_id: 'inv-1' } })], invoiceError: new Error('boom') });
    await expect(loadFailedPaymentFacts('c1', dbh, { strict: true })).rejects.toThrow('boom');
  });
  test('a non-draft invoice that carries the debt keeps its failed row out of the total', async () => {
    const dbh = fakeDb({ payments: [row({ metadata: { invoice_id: 'inv-1' }, amount: 40 }), row({ id: 'q', amount: 15 })], invoices: [{ id: 'inv-1' }] });
    const facts = await loadFailedPaymentFacts('c1', dbh, { strict: true });
    expect(standaloneFailedTotal(facts)).toBe(15);
  });
});
