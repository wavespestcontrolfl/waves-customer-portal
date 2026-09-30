// applyAccountCreditToInvoice's opt-in `requireNoCollectionPending` (customer
// dunning's credit draw): the collection fence runs INSIDE the apply's own
// transaction, under the invoice row lock, and a recognised pending state
// returns a skip SENTINEL (never a throw, so the fence's stale-claim promotion
// commits — apply-credit-claim-fence-promotion-postgres.test.js). Without the
// option nothing about the apply changes. Unit level: a fake trx.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockGates = { autoApplyAccountCredit: true };
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false, gates: mockGates }));
const mockDepositReady = jest.fn();
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: (...a) => mockDepositReady(...a) }));
const mockReconcile = jest.fn();
jest.mock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: (...a) => mockReconcile(...a) }));

const CustomerCredit = require('../services/customer-credit');

// Every table the apply reads before the fence, plus payment_plans (the first
// read AFTER it: an active plan makes the apply stop there with a distinct
// skip, which proves the fence did not stop it).
function fakeTrx() {
  const calls = [];
  const trx = jest.fn((table) => {
    calls.push(table);
    const q = {};
    q.where = () => q;
    q.forUpdate = () => q;
    q.first = async () => {
      if (table === 'invoices') return { id: 'inv-1', customer_id: 'cust-1', status: 'overdue', total: '100.00', credit_applied: 0, payer_id: null, stripe_payment_intent_id: null };
      if (table === 'customers') return { id: 'cust-1', account_credits: 40, auto_apply_account_credit: true };
      if (table === 'payment_plans') return { id: 'plan-1' };
      return undefined;
    };
    return q;
  });
  trx.fn = { now: () => 'now' };
  trx.calls = calls;
  return trx;
}

// invocationCallOrder of the first read of the customers table on the fake trx
const customerReadOrder = (trx) => {
  const idx = trx.calls.indexOf('customers');
  return idx === -1 ? Infinity : trx.mock.invocationCallOrder[idx];
};

const pending = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  mockGates.autoApplyAccountCredit = true;
  mockDepositReady.mockResolvedValue(undefined);
  mockReconcile.mockResolvedValue(undefined);
});

describe('requireNoCollectionPending (opt-in, atomic with the apply)', () => {
  test.each([
    ['saved-card attempt in progress', () => mockReconcile.mockRejectedValue(pending('STRIPE_CHARGE_IN_PROGRESS'))],
    ['ambiguous Stripe outcome', () => mockReconcile.mockRejectedValue(pending('STRIPE_AMBIGUOUS_OUTCOME', { reconciliationRequired: true }))],
    ['orphan charge', () => mockReconcile.mockRejectedValue(pending('STRIPE_CHARGED_DB_FAILED', { reconciliationRequired: true }))],
    ['received deposit awaiting settlement', () => mockDepositReady.mockRejectedValue(pending('DEPOSIT_RECONCILIATION_REQUIRED'))],
  ])('%s: returns a skip sentinel (no throw) and touches nothing past the fence', async (_l, arm) => {
    arm();
    const trx = fakeTrx();
    const out = await CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', requireNoCollectionPending: true }, trx);
    expect(out).toMatchObject({ applied: 0, skipped: 'collection_pending' });
    expect(trx.calls).not.toContain('payment_plans');
  });

  test('the fence runs on the apply\'s OWN trx right after the invoice lock, with the deposit LEDGER LOCK enabled, and before the customer row lock (invoice -> ledger -> customer)', async () => {
    const trx = fakeTrx();
    await CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', requireNoCollectionPending: true }, trx);
    // exactly (trx, invoice): no { lock: false } — the default takes the estimate-deposit advisory lock
    expect(mockDepositReady).toHaveBeenCalledTimes(1);
    expect(mockDepositReady.mock.calls[0]).toHaveLength(2);
    expect(mockDepositReady.mock.calls[0][0]).toBe(trx);
    expect(mockDepositReady.mock.calls[0][1]).toMatchObject({ id: 'inv-1' });
    expect(mockReconcile).toHaveBeenCalledWith('inv-1', trx);
    // the fence is settled before the customer row is locked
    const fenceOrder = Math.min(mockDepositReady.mock.invocationCallOrder[0], mockReconcile.mock.invocationCallOrder[0]);
    const customerLockAt = customerReadOrder(trx);
    expect(customerLockAt).toBeGreaterThan(fenceOrder);
    expect(trx.calls[0]).toBe('invoices'); // locked read first
  });

  test('a clear fence lets the apply proceed', async () => {
    const trx = fakeTrx();
    const out = await CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', requireNoCollectionPending: true }, trx);
    expect(out).toMatchObject({ applied: 0, skipped: 'active_payment_plan' });
    expect(trx.calls).toContain('payment_plans');
  });

  test('an UNEXPECTED fence error propagates (the trx rolls back; nothing is applied) rather than being read as "clear"', async () => {
    mockReconcile.mockRejectedValue(new Error('connection terminated'));
    await expect(CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', requireNoCollectionPending: true }, fakeTrx()))
      .rejects.toThrow('connection terminated');
  });

  test('WITHOUT the option the fence is never consulted (every existing caller unchanged)', async () => {
    mockReconcile.mockRejectedValue(pending('STRIPE_CHARGE_IN_PROGRESS'));
    const trx = fakeTrx();
    const out = await CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1' }, trx);
    expect(out).toMatchObject({ skipped: 'active_payment_plan' });
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockDepositReady).not.toHaveBeenCalled();
  });

  test('autoApplyAccountCreditIfEnabled forwards the option only when set, and swallows an unexpected fence error as null', async () => {
    const trx = fakeTrx();
    await CustomerCredit.autoApplyAccountCreditIfEnabled('inv-1', { trx, requireNoCollectionPending: true });
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    mockReconcile.mockClear();
    await CustomerCredit.autoApplyAccountCreditIfEnabled('inv-1', { trx: fakeTrx() });
    expect(mockReconcile).not.toHaveBeenCalled();
    mockReconcile.mockRejectedValue(new Error('connection terminated'));
    await expect(CustomerCredit.autoApplyAccountCreditIfEnabled('inv-1', { trx: fakeTrx(), requireNoCollectionPending: true })).resolves.toBeNull();
  });
});
