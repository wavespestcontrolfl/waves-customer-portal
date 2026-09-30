// Dunning consolidation PR 1: combinedEligibleSiblings gains an OBSERVER,
// onDegrade(reason), so the customer-level dunning set can tell "genuinely a
// single invoice" ('none') from "the combined flow could not engage"
// (gate_off | payer_anchor | payer_unresolved | incomplete | over_cap). The
// return values are unchanged (null or the sibling rows), the setup-seam
// throws are unchanged, and the caller's `database` now reaches the payer
// resolve too (a boundary check inside a held transaction must not need a
// second pool connection). invoiceCreditWouldFullyCover moved here with a
// `database` param; pay-v2 re-exports the same function.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockGates = { autoApplyAccountCredit: true };
const mockEnabled = { payIncludeBalance: true };
jest.mock('../config/feature-gates', () => ({
  isEnabled: (g) => mockEnabled[g] === true,
  gates: mockGates,
}));
const mockResolveForInvoice = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolveForInvoice(...a) }));
const mockStopped = jest.fn();
jest.mock('../services/completion-balance-sweep', () => ({ dunningStoppedInvoiceIds: (...a) => mockStopped(...a) }));
const mockOpenBalance = jest.fn();
jest.mock('../services/open-balance', () => ({ openBalanceInvoices: (...a) => mockOpenBalance(...a) }));
const mockReconcile = jest.fn();
const mockRetrieve = jest.fn();
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...a) => mockRetrieve(...a),
  cancelPaymentIntent: jest.fn(),
  assertNoInvoiceChargeReconciliationPending: (...a) => mockReconcile(...a),
}));

const db = require('../models/db');
const PayCombined = require('../services/pay-combined');

const anchor = (over = {}) => ({
  id: 'inv-anchor', invoice_number: 'INV-A', customer_id: 'cust-1', payer_id: null, payer_statement_id: null,
  status: 'sent', total: '100.00', credit_applied: 0, stripe_payment_intent_id: null, ...over,
});
const sib = (id, over = {}) => ({
  id, invoice_number: `INV-${id}`, status: 'overdue', total: '50.00', credit_applied: 0, stripe_payment_intent_id: null, ...over,
});

let reasons;
const opts = (extra = {}) => ({ onDegrade: (r) => reasons.push(r), ...extra });

beforeEach(() => {
  jest.resetAllMocks();
  reasons = [];
  mockEnabled.payIncludeBalance = true;
  mockGates.autoApplyAccountCredit = true;
  mockResolveForInvoice.mockResolvedValue({ payerId: null });
  mockStopped.mockResolvedValue(new Set());
  mockOpenBalance.mockResolvedValue([sib('s1')]);
  mockReconcile.mockResolvedValue(undefined);
});

describe('onDegrade reasons — each null return names why, and the return value is unchanged', () => {
  test('a combined selection engaged: the siblings come back and nothing is reported', async () => {
    const out = await PayCombined.combinedEligibleSiblings(anchor(), opts());
    expect(out.map((i) => i.id)).toEqual(['s1']);
    expect(reasons).toEqual([]);
  });

  test('gate off', async () => {
    mockEnabled.payIncludeBalance = false;
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['gate_off']);
    expect(mockOpenBalance).not.toHaveBeenCalled();
  });

  test.each([
    ['payer_id set', { payer_id: 'payer-1' }],
    ['payer_statement_id set', { payer_statement_id: 'stmt-1' }],
  ])('payer-billed anchor (%s)', async (_label, over) => {
    await expect(PayCombined.combinedEligibleSiblings(anchor(over), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['payer_anchor']);
    expect(mockResolveForInvoice).not.toHaveBeenCalled();
  });

  test('the live payer resolve finds a payer the raw column does not show', async () => {
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-9' });
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['payer_anchor']);
  });

  test('the payer resolve fails: payer_unresolved (fail closed, not "single")', async () => {
    mockResolveForInvoice.mockRejectedValue(new Error('lookup down'));
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['payer_unresolved']);
  });

  test.each([
    ['a sibling payer resolve failed', (args) => args.onResolveFailure()],
    ['the candidate bound was hit', (args) => args.onTruncation(200)],
  ])('incomplete open read: %s', async (_label, signal) => {
    mockOpenBalance.mockImplementation(async (_customer, args) => { signal(args); return [sib('s1')]; });
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['incomplete']);
  });

  test('a missing customer id and an unexpected failure both read as incomplete', async () => {
    await expect(PayCombined.combinedEligibleSiblings(anchor({ customer_id: null }), opts())).resolves.toBeNull();
    mockOpenBalance.mockRejectedValue(new Error('boom'));
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['incomplete', 'incomplete']);
  });

  test('over the sibling cap', async () => {
    mockOpenBalance.mockResolvedValue(
      Array.from({ length: PayCombined.MAX_COMBINED_SIBLINGS + 1 }, (_v, i) => sib(`s${i}`)),
    );
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
    expect(reasons).toEqual(['over_cap']);
  });

  describe('none: the combined flow engaged and simply no sibling rides it', () => {
    test('no other open invoice', async () => {
      mockOpenBalance.mockResolvedValue([]);
      await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
      expect(reasons).toEqual(['none']);
    });

    test('every other invoice is stopped', async () => {
      mockStopped.mockResolvedValue(new Set(['s1']));
      await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
      expect(reasons).toEqual(['none']);
    });

    test('every other invoice carries a live PaymentIntent', async () => {
      mockOpenBalance.mockResolvedValue([sib('s1', { stripe_payment_intent_id: 'pi_live' })]);
      mockRetrieve.mockResolvedValue({ id: 'pi_live', status: 'processing', created: Math.floor(Date.now() / 1000), metadata: {} });
      await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
      expect(reasons).toEqual(['none']);
    });

    test('every other invoice has a charge reconciliation pending', async () => {
      mockReconcile.mockRejectedValue(new Error('reconciliation pending'));
      await expect(PayCombined.combinedEligibleSiblings(anchor(), opts())).resolves.toBeNull();
      expect(reasons).toEqual(['none']);
    });
  });
});

describe('unchanged behavior', () => {
  test('without a callback the same inputs return the same values', async () => {
    await expect(PayCombined.combinedEligibleSiblings(anchor())).resolves.toHaveLength(1);
    mockEnabled.payIncludeBalance = false;
    await expect(PayCombined.combinedEligibleSiblings(anchor())).resolves.toBeNull();
  });

  test('a throwing observer never changes the result', async () => {
    const out = await PayCombined.combinedEligibleSiblings(anchor(), { onDegrade: () => { throw new Error('observer bug'); } });
    expect(out).toHaveLength(1);
    mockOpenBalance.mockResolvedValue([]);
    await expect(PayCombined.combinedEligibleSiblings(anchor(), { onDegrade: () => { throw new Error('observer bug'); } })).resolves.toBeNull();
  });

  test('the setup-seam abort verdicts still throw, and report nothing', async () => {
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts({ throwOnPayerAnchor: true })))
      .rejects.toMatchObject({ payerBilledAnchor: true, combinedSetupAbort: true });
    mockResolveForInvoice.mockRejectedValue(new Error('lookup down'));
    await expect(PayCombined.combinedEligibleSiblings(anchor(), opts({ throwOnPayerAnchor: true })))
      .rejects.toMatchObject({ combinedSetupAbort: true, statusCode: 409 });
    expect(reasons).toEqual([]);
  });

  test('the closed reason list is exported', () => {
    expect(PayCombined.DEGRADE_REASONS).toEqual(['gate_off', 'payer_anchor', 'payer_unresolved', 'incomplete', 'over_cap', 'none']);
  });
});

describe('the caller\'s database handle reaches the payer resolve', () => {
  test('resolveForInvoice and the open read receive the SAME handle', async () => {
    const handle = jest.fn();
    await PayCombined.combinedEligibleSiblings(anchor({ scheduled_service_id: 'visit-1' }), { database: handle });
    expect(mockResolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({
      database: handle, customerId: 'cust-1', scheduledServiceId: 'visit-1', throwOnError: true,
    }));
    expect(mockOpenBalance).toHaveBeenCalledWith('cust-1', expect.objectContaining({ database: handle }));
    expect(mockStopped).toHaveBeenCalledWith(['s1'], { database: handle });
    expect(mockReconcile).toHaveBeenCalledWith('s1', handle);
  });

  test('with no handle the default pool handle is passed explicitly', async () => {
    await PayCombined.combinedEligibleSiblings(anchor());
    expect(mockResolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ database: db }));
  });
});

describe('invoiceCreditWouldFullyCover (hoisted from pay-v2)', () => {
  const invoice = { customer_id: 'cust-1', total: 100, credit_applied: 0 };
  const dbReturning = (row) => {
    const handle = jest.fn(() => ({ where: () => ({ first: jest.fn(async () => row) }) }));
    return handle;
  };

  test('reads through the handle it is given, never the pool', async () => {
    const handle = dbReturning({ account_credits: 150, auto_apply_account_credit: true });
    await expect(PayCombined.invoiceCreditWouldFullyCover(invoice, { database: handle })).resolves.toBe(true);
    expect(handle).toHaveBeenCalledWith('customers');
    expect(db).not.toHaveBeenCalled();
  });

  test('the same verdicts as before: partial, opted out, payer-billed, gate off', async () => {
    await expect(PayCombined.invoiceCreditWouldFullyCover(invoice, { database: dbReturning({ account_credits: 40, auto_apply_account_credit: true }) })).resolves.toBe(false);
    await expect(PayCombined.invoiceCreditWouldFullyCover(invoice, { database: dbReturning({ account_credits: 150, auto_apply_account_credit: false }) })).resolves.toBe(false);
    const untouched = dbReturning({ account_credits: 150, auto_apply_account_credit: true });
    await expect(PayCombined.invoiceCreditWouldFullyCover({ ...invoice, payer_id: 'payer-1' }, { database: untouched })).resolves.toBe(false);
    expect(untouched).not.toHaveBeenCalled();
    mockGates.autoApplyAccountCredit = false;
    await expect(PayCombined.invoiceCreditWouldFullyCover(invoice, { database: untouched })).resolves.toBe(false);
    expect(untouched).not.toHaveBeenCalled();
  });
});
