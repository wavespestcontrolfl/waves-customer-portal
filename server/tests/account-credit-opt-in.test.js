// Owner ruling 2026-08-28: automatic account-credit application is the
// CUSTOMER's choice (customers.auto_apply_account_credit, portal slider,
// default OFF). Every automatic seam funnels through
// applyAccountCreditToInvoice, so the gate lives there; estimate acceptance
// passes customerRequested (the customer accepted a price shown net of
// credit) and the admin apply-credit route posts its movement directly.
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.transaction = jest.fn(async (run) => run(db));
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.raw = jest.fn((x) => x);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { applyAccountCreditToInvoice, customerAutoApplyEnabled } = require('../services/customer-credit');

function chain(rowsFor, calls) {
  const q = {};
  ['where', 'whereIn', 'forUpdate', 'orderBy'].forEach((m) => { q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; }); });
  q.first = jest.fn(async (...a) => { calls.push(['first', ...a]); const rows = typeof rowsFor === 'function' ? rowsFor() : rowsFor; return rows[0] || null; });
  q.update = jest.fn(async (patch) => { calls.push(['update', patch]); return 1; });
  q.insert = jest.fn((row) => { calls.push(['insert', row]); return { returning: jest.fn(async () => [{ id: 'ledger-1', ...row }]) }; });
  q.select = jest.fn(async () => (typeof rowsFor === 'function' ? rowsFor() : rowsFor));
  return q;
}
const INVOICE = { id: 'inv-1', customer_id: 'c1', status: 'sent', total: '120.00', credit_applied: 0, payer_id: null, stripe_payment_intent_id: null };
function world({ optIn, balance = '500.00' }) {
  const calls = { invoices: [], customers: [], plans: [], ledger: [] };
  db.mockImplementation((table) => {
    if (table === 'invoices') return chain([INVOICE], calls.invoices);
    if (table === 'customers') return chain([{ id: 'c1', account_credits: balance, auto_apply_account_credit: optIn }], calls.customers);
    if (table === 'payment_plans') return chain([], calls.plans);
    if (table === 'customer_credit_ledger') return chain([], calls.ledger);
    throw new Error(`unexpected table ${table}`);
  });
  return calls;
}
beforeEach(() => jest.clearAllMocks());

describe('applyAccountCreditToInvoice — customer opt-in gate', () => {
  test('opted OUT (default) → skipped customer_opt_out, no credit movement, invoice untouched', async () => {
    const calls = world({ optIn: false });
    const result = await applyAccountCreditToInvoice({ invoiceId: 'inv-1' });
    expect(result).toEqual({ applied: 0, skipped: 'customer_opt_out' });
    expect(calls.customers).toEqual(expect.arrayContaining([['forUpdate'], ['first', 'auto_apply_account_credit']]));
    expect(calls.invoices.find((c) => c[0] === 'update')).toBeUndefined();
    expect(calls.ledger).toEqual([]);
  });

  test('a missing / NULL flag reads as OUT (fail toward leaving the balance alone)', async () => {
    world({ optIn: null });
    expect((await applyAccountCreditToInvoice({ invoiceId: 'inv-1' })).skipped).toBe('customer_opt_out');
    world({ optIn: undefined });
    expect((await applyAccountCreditToInvoice({ invoiceId: 'inv-1' })).skipped).toBe('customer_opt_out');
  });

  test('opted IN → the apply proceeds past the gate (reaches the balance read)', async () => {
    const calls = world({ optIn: true });
    const result = await applyAccountCreditToInvoice({ invoiceId: 'inv-1' });
    expect(result.skipped).not.toBe('customer_opt_out');
    expect(calls.customers.some((c) => c[0] === 'first' && c.includes('account_credits'))).toBe(true);
  });

  test('customerRequested (estimate acceptance) bypasses the slider — the customer accepted a price shown net of credit', async () => {
    const calls = world({ optIn: false });
    const result = await applyAccountCreditToInvoice({ invoiceId: 'inv-1', customerRequested: true });
    expect(result.skipped).not.toBe('customer_opt_out');
    expect(calls.customers.find((c) => c[0] === 'first' && c[1] === 'auto_apply_account_credit')).toBeUndefined();
  });

  test('the opt-in is re-asserted on the LOCKED balance row — a flip that lands between the gate and the movement consumes nothing', async () => {
    let reads = 0;
    const calls = { invoices: [], customers: [], plans: [], ledger: [] };
    db.mockImplementation((table) => {
      if (table === 'invoices') return chain([INVOICE], calls.invoices);
      // first read (gate) says ON, the locked balance read says OFF
      if (table === 'customers') return chain(() => [{ id: 'c1', account_credits: '500.00', auto_apply_account_credit: (reads++ === 0) }], calls.customers);
      if (table === 'payment_plans') return chain([], calls.plans);
      if (table === 'customer_credit_ledger') return chain([], calls.ledger);
      throw new Error(`unexpected table ${table}`);
    });
    expect(await applyAccountCreditToInvoice({ invoiceId: 'inv-1' })).toEqual({ applied: 0, skipped: 'customer_opt_out' });
    expect(calls.ledger).toEqual([]);
    expect(calls.customers.filter((c) => c[0] === 'first').map((c) => c.slice(1))).toEqual([
      ['auto_apply_account_credit'], ['id', 'account_credits', 'auto_apply_account_credit'],
    ]);
  });

  test('customerAutoApplyEnabled: true only for an explicit true; missing customer → false', async () => {
    world({ optIn: true });
    expect(await customerAutoApplyEnabled('c1')).toBe(true);
    world({ optIn: 'true' });
    expect(await customerAutoApplyEnabled('c1')).toBe(false);
    expect(await customerAutoApplyEnabled(null)).toBe(false);
  });
});
