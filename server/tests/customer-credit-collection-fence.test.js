// applyAccountCreditToInvoice's opt-in `dunningDraw` (customer
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

const mockResolvePayer = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolvePayer(...a) }));

const CustomerCredit = require('../services/customer-credit');

// Every table the apply reads before the fence, plus payment_plans (the first
// read AFTER it: an active plan makes the apply stop there with a distinct
// skip, which proves the fence did not stop it).
let rows; // per-test overrides for the rows the fake trx serves
function fakeTrx() {
  const calls = [];
  const trx = jest.fn((table) => {
    calls.push(table);
    const q = {};
    q.where = () => q;
    q.forUpdate = () => q;
    q.first = async () => {
      if (table === 'invoices') return { id: 'inv-1', customer_id: 'cust-1', status: 'overdue', total: '100.00', credit_applied: 0, payer_id: null, stripe_payment_intent_id: null, ...rows.invoice };
      if (table === 'invoice_followup_sequences') return rows.seq;
      if (table === 'scheduled_services') return rows.svc === undefined ? { id: 'svc-1', customer_id: 'cust-1' } : rows.svc;
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
  rows = {};
  mockResolvePayer.mockResolvedValue({ payerId: null });
  mockGates.autoApplyAccountCredit = true;
  mockDepositReady.mockResolvedValue(undefined);
  mockReconcile.mockResolvedValue(undefined);
});

describe('dunningDraw (opt-in, atomic with the apply)', () => {
  test.each([
    ['saved-card attempt in progress', () => mockReconcile.mockRejectedValue(pending('STRIPE_CHARGE_IN_PROGRESS'))],
    ['ambiguous Stripe outcome', () => mockReconcile.mockRejectedValue(pending('STRIPE_AMBIGUOUS_OUTCOME', { reconciliationRequired: true }))],
    ['orphan charge', () => mockReconcile.mockRejectedValue(pending('STRIPE_CHARGED_DB_FAILED', { reconciliationRequired: true }))],
    ['received deposit awaiting settlement', () => mockDepositReady.mockRejectedValue(pending('DEPOSIT_RECONCILIATION_REQUIRED'))],
  ])('%s: returns a skip sentinel (no throw) and touches nothing past the fence', async (_l, arm) => {
    arm();
    const trx = fakeTrx();
    const out = await CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', dunningDraw: true }, trx);
    expect(out).toMatchObject({ applied: 0, skipped: 'collection_pending' });
    expect(trx.calls).not.toContain('payment_plans');
  });

  test('the fence runs on the apply\'s OWN trx right after the invoice lock, with the deposit LEDGER LOCK enabled, and before the customer row lock (invoice -> ledger -> customer)', async () => {
    const trx = fakeTrx();
    await CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', dunningDraw: true }, trx);
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
    const out = await CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', dunningDraw: true }, trx);
    expect(out).toMatchObject({ applied: 0, skipped: 'active_payment_plan' });
    expect(trx.calls).toContain('payment_plans');
  });

  test('an UNEXPECTED fence error propagates (the trx rolls back; nothing is applied) rather than being read as "clear"', async () => {
    mockReconcile.mockRejectedValue(new Error('connection terminated'));
    await expect(CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', dunningDraw: true }, fakeTrx()))
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
    await CustomerCredit.autoApplyAccountCreditIfEnabled('inv-1', { trx, dunningDraw: true });
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    mockReconcile.mockClear();
    await CustomerCredit.autoApplyAccountCreditIfEnabled('inv-1', { trx: fakeTrx() });
    expect(mockReconcile).not.toHaveBeenCalled();
    mockReconcile.mockRejectedValue(new Error('connection terminated'));
    await expect(CustomerCredit.autoApplyAccountCreditIfEnabled('inv-1', { trx: fakeTrx(), dunningDraw: true })).resolves.toBeNull();
  });
});

describe('dunningDraw re-decides eligibility under the locks (the resolver\'s pre-read only chose the candidate)', () => {
  const draw = (trx = fakeTrx()) => CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1', dunningDraw: true }, trx);

  test.each([
    ['stopped', 'dunning_stopped'],
    ['paused', 'dunning_not_active'],
    ['autopay_hold', 'dunning_not_active'],
    ['completed', 'dunning_not_active'],
  ])('a sequence that is %s at lock time refuses (skip sentinel), whatever the earlier read said', async (status, skipped) => {
    rows.seq = { status };
    const trx = fakeTrx();
    expect(await draw(trx)).toMatchObject({ applied: 0, skipped });
    expect(trx.calls).not.toContain('payment_plans');
  });

  test.each([['active row', { status: 'active' }], ['no row (a quiet member)', undefined]])('%s may draw', async (_l, seq) => {
    rows.seq = seq;
    const trx = fakeTrx();
    expect(await draw(trx)).toMatchObject({ skipped: 'active_payment_plan' }); // got past every dunningDraw guard
    expect(trx.calls).toContain('payment_plans');
  });

  test('the sequence row is locked FOR UPDATE after the invoice lock and before the payer / plan checks', async () => {
    const trx = fakeTrx();
    await draw(trx);
    const i = (t) => trx.calls.indexOf(t);
    expect(i('invoices')).toBe(0);
    expect(i('invoice_followup_sequences')).toBeGreaterThan(i('customers'));
    expect(i('payment_plans')).toBeGreaterThan(i('invoice_followup_sequences'));
  });

  test('the payer is re-resolved LIVE on the apply\'s own trx, under the customer and visit locks', async () => {
    rows.invoice = { scheduled_service_id: 'svc-1' };
    const trx = fakeTrx();
    await draw(trx);
    expect(mockResolvePayer).toHaveBeenCalledWith({ database: trx, customerId: 'cust-1', scheduledServiceId: 'svc-1', throwOnError: true });
    expect(trx.calls.indexOf('scheduled_services')).toBeGreaterThan(trx.calls.indexOf('customers'));
  });

  test('an invoice with no visit is still re-resolved (by customer)', async () => {
    await draw();
    expect(mockResolvePayer.mock.calls[0][0]).toEqual(expect.not.objectContaining({ scheduledServiceId: expect.anything() }));
    expect(mockResolvePayer).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a payer assigned since the read', () => mockResolvePayer.mockResolvedValue({ payerId: 'payer-9' }), 'payer_billed'],
    ['a payer lookup failure', () => mockResolvePayer.mockRejectedValue(new Error('lookup down')), 'payer_check_failed'],
    ['a payer_id on the locked row', () => { rows.invoice = { payer_id: 'p1' }; }, 'payer_billed'],
    ['a payer statement on the locked row', () => { rows.invoice = { payer_statement_id: 's1' }; }, 'payer_billed'],
    ['a withdrawal stamp on the locked row', () => { rows.invoice = { scheduled_send_error: 'payer_billed:p1' }; }, 'payer_billed'],
    ['a visit that vanished', () => { rows.invoice = { scheduled_service_id: 'svc-1' }; rows.svc = null; }, 'service_missing'],
    ['a visit of another customer', () => { rows.invoice = { scheduled_service_id: 'svc-1' }; rows.svc = { id: 'svc-1', customer_id: 'other' }; }, 'customer_mismatch'],
  ])('%s consumes nothing', async (_l, arm, skipped) => {
    arm();
    const trx = fakeTrx();
    expect(await draw(trx)).toMatchObject({ applied: 0, skipped });
    expect(trx.calls).not.toContain('payment_plans');
  });

  test('an attached PaymentIntent on the LOCKED row refuses (the apply\'s own guard, so the resolver\'s microdeposit pre-read is only an early skip)', async () => {
    rows.invoice = { stripe_payment_intent_id: 'pi_live' };
    const trx = fakeTrx();
    expect(await draw(trx)).toMatchObject({ applied: 0, skipped: 'has_payment_intent' });
    expect(trx.calls).not.toContain('payment_plans');
  });

  test('WITHOUT dunningDraw none of this runs (sequence, visit, payer)', async () => {
    rows.seq = { status: 'paused' };
    mockResolvePayer.mockResolvedValue({ payerId: 'payer-9' });
    const trx = fakeTrx();
    expect(await CustomerCredit.applyAccountCreditToInvoice({ invoiceId: 'inv-1' }, trx)).toMatchObject({ skipped: 'active_payment_plan' });
    expect(mockResolvePayer).not.toHaveBeenCalled();
    expect(trx.calls).not.toContain('invoice_followup_sequences');
  });
});

