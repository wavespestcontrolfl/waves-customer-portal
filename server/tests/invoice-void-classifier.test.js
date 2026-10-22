/**
 * invoice-void-classifier.js: the ONE set of void refusals shared by the bar's void_invoice tool and the bar's cancel path.
 * This suite proves the shared module on a caller-supplied connection (a lock-holding transaction in the cancel path): it reads
 * through that connection, never the shared db; the deposit-credit rule can be skipped by the one caller that restores it;
 * and the charge markers, a paid date, a payment plan and an unresolved saved-card charge each refuse. void_invoice's own
 * behavior is covered by intelligence-bar-void-invoice.test.js. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('the shared db must not be read when a connection is given'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockFence = jest.fn(async () => {});
jest.mock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: (...a) => mockFence(...a) }));
jest.mock('../services/invoice-prepay', () => ({ resolveInvoiceTermId: jest.fn(async () => null) }));
jest.mock('../services/invoice', () => ({ queuedPayLinkText: jest.fn(async () => null) }));

const { moneyRefusal, pageOnlyRefusal, invoiceVoidRefusal } = require('../services/invoice-void-classifier');

// A fake knex-style connection: every table answers from `rows[table]` (first row or undefined) and every call is recorded.
function fakeConn(rows = {}) {
  const calls = [];
  const conn = (table) => {
    calls.push(table);
    const q = {
      where: () => q, whereNot: () => q, whereRaw: () => q, orWhereRaw: () => q,
      first: async () => (rows[table] || [])[0],
    };
    return q;
  };
  conn.calls = calls;
  return conn;
}
const INV = { id: 'inv-1', invoice_number: 'WPC-TEST-9', status: 'sent', line_items: '[]', total: '50.00' };

beforeEach(() => { mockFence.mockReset().mockResolvedValue(undefined); });

describe('moneyRefusal on a given connection', () => {
  test.each([
    ['a Stripe charge id', { stripe_charge_id: 'ch_test' }, 'charge_on_file'],
    ['a paid date', { paid_at: '2026-10-20T12:00:00Z' }, 'paid_date'],
    ['a recorded payment', { payment_recorded_at: '2026-10-20T12:00:00Z' }, 'payment_recorded'],
    ['a collected-money status', { status: 'paid' }, 'status_paid'],
  ])('%s refuses (by_owner_rule)', async (_label, patch, reason) => {
    const refused = await moneyRefusal({ ...INV, ...patch }, fakeConn());
    expect(refused).toMatchObject({ code: 'by_owner_rule', reason, invoice_id: 'inv-1' });
  });

  test('an active payment plan refuses, read through the given connection', async () => {
    const conn = fakeConn({ payment_plans: [{ id: 'plan-1', status: 'active' }] });
    expect(await moneyRefusal(INV, conn)).toMatchObject({ code: 'by_owner_rule', reason: 'payment_plan' });
    expect(conn.calls).toContain('payment_plans');
  });

  test('an unresolved saved-card charge refuses (the fence reads on the given connection, read-only)', async () => {
    mockFence.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'STRIPE_AMBIGUOUS_OUTCOME', reconciliationRequired: true }));
    const conn = fakeConn();
    expect(await moneyRefusal(INV, conn)).toMatchObject({ code: 'by_owner_rule', reason: 'charge_in_progress' });
    expect(mockFence).toHaveBeenCalledWith('inv-1', conn, { readOnly: true });
  });

  test('a fence read that fails for another reason is reported as unverified, never as clear', async () => {
    mockFence.mockRejectedValueOnce(new Error('connection terminated'));
    expect(await moneyRefusal(INV, fakeConn())).toMatchObject({ code: 'unverified' });
  });

  test('a deposit credit line refuses by default and is skipped only when the caller says so', async () => {
    const deposit = { ...INV, line_items: JSON.stringify([{ category: 'deposit_credit', amount: -75 }]) };
    expect(await moneyRefusal(deposit, fakeConn())).toMatchObject({ reason: 'deposit_collected' });
    expect(await moneyRefusal(deposit, fakeConn(), { skip: ['deposit_collected'] })).toBeNull();
  });

  test('a plain unpaid invoice is clear', async () => {
    expect(await moneyRefusal(INV, fakeConn())).toBeNull();
    expect(await invoiceVoidRefusal(INV, fakeConn())).toBeNull();
  });
});

describe('pageOnlyRefusal on a given connection', () => {
  test('a setup-fee claim is read through the given connection and refuses (needs_invoices_page)', async () => {
    const conn = fakeConn({ setup_fee_claims: [{ id: 'claim-1' }] });
    expect(await pageOnlyRefusal(INV, conn)).toMatchObject({ code: 'needs_invoices_page', reason: 'setup_fee' });
    expect(conn.calls).toContain('setup_fee_claims');
  });

  test('invoiceVoidRefusal returns the money verdict first, then the page-only one', async () => {
    const conn = fakeConn({ setup_fee_claims: [{ id: 'claim-1' }] });
    expect(await invoiceVoidRefusal({ ...INV, stripe_charge_id: 'ch_test' }, conn)).toMatchObject({ reason: 'charge_on_file' });
    expect(await invoiceVoidRefusal(INV, conn)).toMatchObject({ reason: 'setup_fee' });
  });
});
