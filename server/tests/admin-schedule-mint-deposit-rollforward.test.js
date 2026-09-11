/**
 * mintScheduledServiceInvoiceWithDeposit — pre-completion mints roll the
 * estimate deposit forward.
 *
 * Charge-now and Mark-prepaid used to mint the visit invoice via
 * InvoiceService.create() with NO depositCredit; completion then reused the
 * pre-minted invoice, so createFromService's roll-forward never ran and the
 * customer's 'received' deposit stranded forever — deposit + full visit price
 * collected (money-path audit 2026-07-06). Contract (mirrors createFromService):
 *   - a fresh mint for a visit linked to an estimate requests the full
 *     unapplied deposit balance and CONSUMES exactly what create() applied,
 *     inside the same transaction
 *   - an allocation mismatch throws (the mint rolls back) and is retried
 *     against the fresh balance; a second failure raises the reconcile alert
 *     and falls back to an UNCREDITED mint — deposit machinery never blocks
 *     door collection
 *   - the in-lock replay check still short-circuits before any deposit work
 *   - a visit with no source estimate mints exactly as before
 *   - expectedDepositCredit (the credit a caller previewed to an operator):
 *     the applied credit must match it to the cent or the mint 409s inside
 *     the transaction (DEPOSIT_CREDIT_CHANGED) — nothing minted or consumed,
 *     no retry, and the uncredited fallback is refused too
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
const mockCreate = jest.fn();
jest.mock('../services/invoice', () => ({
  create: (...args) => mockCreate(...args),
  buildLineItemsForScheduledService: jest.fn(async () => ({ lineItems: [], discountIds: [] })),
}));
const mockPending = jest.fn();
const mockConsume = jest.fn();
// The deposit-ledger advisory lock (Codex round 14 P1 #4131): the mint
// acquires it before reading pendingDepositCredit — a no-op stub here,
// asserted against directly in the lock-ordering test below.
const mockAcquireDepositLock = jest.fn(async () => undefined);
jest.mock('../services/estimate-deposits', () => ({
  pendingDepositCredit: (...args) => mockPending(...args),
  consumeDepositCredit: (...args) => mockConsume(...args),
  acquireEstimateDepositLedgerLock: (...args) => mockAcquireDepositLock(...args),
}));
const mockPayer = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...args) => mockPayer(...args),
}));
const mockTrigger = jest.fn(async () => undefined);
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTrigger(...args),
}));

const db = require('../models/db');
const adminScheduleRouter = require('../routes/admin-schedule');

const {
  mintScheduledServiceInvoiceWithDeposit,
  mintOrReuseScheduledServiceInvoice,
} = adminScheduleRouter._test;

function makeTrx({ replayedInvoice = undefined, lockedSvcRow } = {}) {
  const trx = (table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNot = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.forUpdate = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table === 'invoices') return replayedInvoice;
      if (table === 'scheduled_services') {
        // The mint's row lock re-read; undefined estimated_price on the
        // caller's svc keeps the stale-price guard out of legacy tests.
        return lockedSvcRow !== undefined
          ? lockedSvcRow
          : { id: 'svc-1', estimated_price: null, primary_line_price: null };
      }
      return undefined;
    });
    return q;
  };
  trx.raw = jest.fn(async () => undefined);
  trx.fn = { now: () => 'NOW' };
  return trx;
}

function programTransactions(...trxs) {
  let i = 0;
  db.transaction.mockImplementation(async (fn) => {
    const trx = trxs[Math.min(i, trxs.length - 1)];
    i += 1;
    return fn(trx);
  });
}

const svc = { id: 'svc-1', customer_id: 'cust-1', source_estimate_id: 'est-1', service_type: 'Pest control' };
const buildCreateParams = () => ({ customerId: 'cust-1', scheduledServiceId: 'svc-1', lineItems: [] });

describe('mintScheduledServiceInvoiceWithDeposit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes the pending deposit into create() and consumes exactly the applied amount', async () => {
    const trx = makeTrx();
    programTransactions(trx);
    mockPending.mockResolvedValueOnce({ amount: 49 });
    mockCreate.mockResolvedValueOnce({ id: 'inv-1', applied_deposit_credit: 49 });
    mockConsume.mockResolvedValueOnce(49);

    const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams });

    expect(result).toEqual({ invoice: { id: 'inv-1', applied_deposit_credit: 49 }, reused: false });
    expect(mockPending).toHaveBeenCalledWith('est-1', trx);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).toMatchObject({
      database: trx,
      depositCredit: { amount: 49, estimateId: 'est-1' },
    });
    expect(mockConsume).toHaveBeenCalledWith({ estimateId: 'est-1', amount: 49, invoiceId: 'inv-1', trx });
  });

  it('consumes the CAPPED amount when create() applied less than requested', async () => {
    programTransactions(makeTrx());
    mockPending.mockResolvedValueOnce({ amount: 99 });
    mockCreate.mockResolvedValueOnce({ id: 'inv-1', applied_deposit_credit: 60 });
    mockConsume.mockResolvedValueOnce(60);

    await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams });

    expect(mockConsume).toHaveBeenCalledWith(expect.objectContaining({ amount: 60 }));
  });

  it('replay inside the lock short-circuits before any deposit work', async () => {
    const existing = { id: 'inv-existing' };
    programTransactions(makeTrx({ replayedInvoice: existing }));

    const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams });

    expect(result).toEqual({ invoice: existing, reused: true });
    expect(mockPending).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('mints without deposit machinery when the visit has no source estimate', async () => {
    programTransactions(makeTrx());
    mockCreate.mockResolvedValueOnce({ id: 'inv-1', applied_deposit_credit: 0 });

    await mintScheduledServiceInvoiceWithDeposit({ svc: { ...svc, source_estimate_id: null }, buildCreateParams });

    expect(mockPending).not.toHaveBeenCalled();
    expect(mockCreate.mock.calls[0][0].depositCredit).toBeUndefined();
    expect(mockConsume).not.toHaveBeenCalled();
    // No source estimate — nothing to serialize against, so no lock either.
    expect(mockAcquireDepositLock).not.toHaveBeenCalled();
  });

  // Codex round 14 P1 #4131: pendingDepositCredit is a plain SELECT and
  // markDepositReceived is an independent write, so without a shared lock
  // a deposit could settle between this read and the mint's own commit —
  // the zero-credit check would pass and a full-balance invoice would go
  // out beside the newly received deposit. The mint must take the SAME
  // advisory lock (keyed on the estimate) BEFORE reading, in the SAME
  // transaction that will go on to create() and consume.
  it('serializes against a concurrent deposit receipt: the estimate-keyed advisory lock is taken BEFORE pendingDepositCredit reads', async () => {
    const trx = makeTrx();
    programTransactions(trx);
    mockCreate.mockResolvedValueOnce({ id: 'inv-1', applied_deposit_credit: 49 });
    mockConsume.mockResolvedValueOnce(49);
    const callOrder = [];
    mockAcquireDepositLock.mockImplementationOnce(async () => { callOrder.push('lock'); });
    mockPending.mockImplementationOnce(async () => { callOrder.push('read'); return { amount: 49 }; });

    await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams });

    // Same transaction, same estimate id the read itself uses.
    expect(mockAcquireDepositLock).toHaveBeenCalledWith(trx, 'est-1');
    expect(callOrder).toEqual(['lock', 'read']);
  });

  it('retries once on allocation mismatch, then alerts and falls back to an uncredited mint', async () => {
    programTransactions(makeTrx(), makeTrx(), makeTrx());
    // Two credited attempts both mismatch (ledger raced), third mints uncredited.
    mockPending.mockResolvedValue({ amount: 49 });
    mockCreate
      .mockResolvedValueOnce({ id: 'inv-a', applied_deposit_credit: 49 })
      .mockResolvedValueOnce({ id: 'inv-b', applied_deposit_credit: 49 })
      .mockResolvedValueOnce({ id: 'inv-c', applied_deposit_credit: 0 });
    mockConsume.mockResolvedValue(20);

    const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams });

    expect(result.invoice.id).toBe('inv-c');
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[2][0].depositCredit).toBeUndefined();
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { estimateId: 'est-1' });
  });

  it('a mismatch on the first attempt succeeds on the retry against the fresh balance', async () => {
    programTransactions(makeTrx(), makeTrx());
    mockPending
      .mockResolvedValueOnce({ amount: 49 })
      .mockResolvedValueOnce({ amount: 29 });
    mockCreate
      .mockResolvedValueOnce({ id: 'inv-a', applied_deposit_credit: 49 })
      .mockResolvedValueOnce({ id: 'inv-b', applied_deposit_credit: 29 });
    mockConsume
      .mockResolvedValueOnce(29) // raced: only $29 still allocatable
      .mockResolvedValueOnce(29);

    const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams });

    expect(result.invoice.id).toBe('inv-b');
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  describe('expectedDepositCredit (the operator-previewed PENDING deposit)', () => {
    it('mints when the pending deposit still matches the preview even though the applied credit is capped at a smaller server total (tax-exempt customer)', async () => {
      programTransactions(makeTrx());
      mockPending.mockResolvedValueOnce({ amount: 150 });
      mockCreate.mockResolvedValueOnce({ id: 'inv-1', applied_deposit_credit: 100 });
      mockConsume.mockResolvedValueOnce(100);

      const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 150 });

      expect(result).toEqual({ invoice: { id: 'inv-1', applied_deposit_credit: 100 }, reused: false });
      expect(mockConsume).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }));
    });

    it('a payer-billed visit previews zero and mints: the homeowner deposit is not payer-eligible (create applies none)', async () => {
      programTransactions(makeTrx());
      mockPending.mockResolvedValueOnce({ amount: 50 });
      mockPayer.mockResolvedValueOnce({ payerId: 'payer-1' });
      mockCreate.mockResolvedValueOnce({ id: 'inv-1', applied_deposit_credit: 0 });

      const result = await mintScheduledServiceInvoiceWithDeposit({ svc: { ...svc, customer_id: 'cust-1' }, buildCreateParams, expectedDepositCredit: 0 });

      expect(result).toEqual({ invoice: { id: 'inv-1', applied_deposit_credit: 0 }, reused: false });
      expect(mockPayer).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', scheduledServiceId: 'svc-1' }));
      expect(mockConsume).not.toHaveBeenCalled();
    });

    it('a previewed create never takes the uncredited fallback: two failed ledger reads refuse (409 DEPOSIT_CREDIT_UNVERIFIABLE) after the reconcile alert — a deposit paid after a zero preview is never billed over', async () => {
      programTransactions(makeTrx(), makeTrx(), makeTrx());
      // The preview read zero; the customer then paid a deposit and BOTH
      // credited ledger reads fail — the uncredited third attempt would read
      // nothing, compare zero to the stale zero and mint the full balance.
      mockPending
        .mockRejectedValueOnce(new Error('ledger read failed'))
        .mockRejectedValueOnce(new Error('ledger read failed'));

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 0 }),
      ).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_CREDIT_UNVERIFIABLE' });
      expect(mockPending).toHaveBeenCalledTimes(2);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockTrigger).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { estimateId: 'est-1' });
    });

    it('a payer assigned after a non-zero preview is refused — create would apply no credit the operator saw', async () => {
      programTransactions(makeTrx());
      mockPending.mockResolvedValueOnce({ amount: 50 });
      mockPayer.mockResolvedValueOnce({ payerId: 'payer-1' });

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 50 }),
      ).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_CREDIT_CHANGED', expectedDepositCredit: 50, pendingDepositCredit: 0 });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('mints when the pending deposit matches the preview to the cent', async () => {
      programTransactions(makeTrx());
      mockPending.mockResolvedValueOnce({ amount: 49 });
      mockCreate.mockResolvedValueOnce({ id: 'inv-1', applied_deposit_credit: 49 });
      mockConsume.mockResolvedValueOnce(49);

      const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 49 });

      expect(result).toEqual({ invoice: { id: 'inv-1', applied_deposit_credit: 49 }, reused: false });
      expect(mockConsume).toHaveBeenCalledWith(expect.objectContaining({ amount: 49 }));
    });

    it('409s inside the transaction when the credit moved since the preview — nothing consumed, no retry, no fallback', async () => {
      programTransactions(makeTrx(), makeTrx(), makeTrx());
      mockPending.mockResolvedValue({ amount: 20 }); // another invoice consumed $29 of the $49 previewed
      mockCreate.mockResolvedValue({ id: 'inv-1', applied_deposit_credit: 20 });

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 49 }),
      ).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_CREDIT_CHANGED', expectedDepositCredit: 49, pendingDepositCredit: 20 });
      expect(mockCreate).not.toHaveBeenCalled(); // refused before anything is created
      expect(mockConsume).not.toHaveBeenCalled();
      expect(mockTrigger).not.toHaveBeenCalled();
    });

    it('a zero preview refuses a credit that appeared since — the customer would be sent less than the operator approved', async () => {
      programTransactions(makeTrx());
      mockPending.mockResolvedValueOnce({ amount: 49 });

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 0 }),
      ).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_CREDIT_CHANGED', pendingDepositCredit: 49 });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockConsume).not.toHaveBeenCalled();
    });

    it('the uncredited fallback after repeated allocation failures is never entered when a credit was previewed — the second failure refuses (DEPOSIT_CREDIT_UNVERIFIABLE) right after the reconcile alert', async () => {
      programTransactions(makeTrx(), makeTrx(), makeTrx());
      mockPending.mockResolvedValue({ amount: 49 });
      mockCreate
        .mockResolvedValueOnce({ id: 'inv-a', applied_deposit_credit: 49 })
        .mockResolvedValueOnce({ id: 'inv-b', applied_deposit_credit: 49 });
      mockConsume.mockResolvedValue(20);

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 49 }),
      ).rejects.toMatchObject({ status: 409, code: 'DEPOSIT_CREDIT_UNVERIFIABLE' });
      expect(mockCreate).toHaveBeenCalledTimes(2); // no third, uncredited transaction is opened
      expect(db.transaction).toHaveBeenCalledTimes(2);
      expect(mockTrigger).toHaveBeenCalledTimes(1); // the reconcile alert still goes out
    });
  });

  describe('expectedBalanceDue (the operator-previewed BALANCE — GitHub P1 #4131 r2)', () => {
    it('mints when the created row\'s authoritative total matches the previewed balance to the cent', async () => {
      programTransactions(makeTrx());
      mockPending.mockResolvedValueOnce({ amount: 49 });
      mockCreate.mockResolvedValueOnce({ id: 'inv-1', total: 76.19, applied_deposit_credit: 49 });
      mockConsume.mockResolvedValueOnce(49);

      const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 49, expectedBalanceDue: 76.19 });

      expect(result.reused).toBe(false);
      expect(mockConsume).toHaveBeenCalledWith(expect.objectContaining({ amount: 49 }));
    });

    it('409s BALANCE_CHANGED inside the transaction when the server total differs (tax exemption / county rate) — nothing consumed, no retry, the real figures ride on the error', async () => {
      programTransactions(makeTrx(), makeTrx(), makeTrx());
      mockPending.mockResolvedValue({ amount: 49 });
      // The form previewed 7% tax on $117 → $125.19 − $49 = $76.19; the
      // server bills the customer's exemption → $117 − $49 = $68.
      mockCreate.mockResolvedValue({ id: 'inv-1', total: 68, applied_deposit_credit: 49 });

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 49, expectedBalanceDue: 76.19 }),
      ).rejects.toMatchObject({
        status: 409, code: 'BALANCE_CHANGED', expectedBalanceDue: 76.19, balanceDue: 68, invoiceTotal: 117, appliedDepositCredit: 49,
      });
      expect(mockCreate).toHaveBeenCalledTimes(1); // terminal — the transaction rolled the create back
      expect(mockConsume).not.toHaveBeenCalled();
      expect(mockTrigger).not.toHaveBeenCalled();
    });

    it('a zero preview refuses a positive server balance — the deposit fell between the two totals', async () => {
      programTransactions(makeTrx());
      mockPending.mockResolvedValueOnce({ amount: 120 });
      // The form (7% tax: $125.19 total) capped the $120 credit at its total
      // and previewed a $5.19 balance; the server, tax-exempt ($117 total),
      // caps the credit at $117 and bills $0. Either direction is a mismatch.
      mockCreate.mockResolvedValueOnce({ id: 'inv-1', total: 0, applied_deposit_credit: 117 });

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 120, expectedBalanceDue: 5.19 }),
      ).rejects.toMatchObject({ status: 409, code: 'BALANCE_CHANGED', balanceDue: 0, appliedDepositCredit: 117 });
      expect(mockConsume).not.toHaveBeenCalled();
    });

    it('no balance expectation (every other caller) skips the check entirely', async () => {
      programTransactions(makeTrx());
      mockPending.mockResolvedValueOnce({ amount: 49 });
      mockCreate.mockResolvedValueOnce({ id: 'inv-1', total: 68, applied_deposit_credit: 49 });
      mockConsume.mockResolvedValueOnce(49);

      const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, expectedDepositCredit: 49 });
      expect(result.invoice.id).toBe('inv-1');
    });
  });

  it('bubbles an uncredited-mint failure instead of looping', async () => {
    programTransactions(makeTrx());
    mockCreate.mockRejectedValueOnce(new Error('create exploded'));

    await expect(
      mintScheduledServiceInvoiceWithDeposit({ svc: { ...svc, source_estimate_id: null }, buildCreateParams }),
    ).rejects.toThrow('create exploded');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  // Mint-path row lock + stale-price refusal (WaveGuard #3338 pre-enable
  // fast-follow): the mint re-reads the visit row FOR UPDATE inside the
  // lock transaction and refuses to CREATE from a price snapshot the row
  // no longer carries. 409s are terminal (no deposit retry, no fallback
  // mint) — retrying with the same stale params can't fix them.
  describe('stale-price guard', () => {
    const pricedSvc = { ...svc, estimated_price: 120, primary_line_price: null };

    it('409s when the locked estimated_price differs from the caller snapshot', async () => {
      programTransactions(makeTrx({
        lockedSvcRow: { id: 'svc-1', estimated_price: 100, primary_line_price: null },
      }));

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc: pricedSvc, buildCreateParams }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'SCHEDULED_PRICE_MOVED',
        // The locked current price rides the error (codex #3344 r5): the
        // dispatch REQUIRED-mint catch restamps its frozen mint cents from
        // it so the released resume bills the moved price.
        currentEstimatedPriceCents: 10000,
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockConsume).not.toHaveBeenCalled();
    });

    it('409s when primary_line_price moved even with estimated_price unchanged', async () => {
      programTransactions(makeTrx({
        lockedSvcRow: { id: 'svc-1', estimated_price: 120, primary_line_price: 95 },
      }));

      await expect(
        mintScheduledServiceInvoiceWithDeposit({
          svc: { ...pricedSvc, primary_line_price: 110 },
          buildCreateParams,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'SCHEDULED_PRICE_MOVED' });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('mints normally when the locked prices match to the cent', async () => {
      programTransactions(makeTrx({
        lockedSvcRow: { id: 'svc-1', estimated_price: 120, primary_line_price: null },
      }));
      mockPending.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({ id: 'inv-1' });

      const result = await mintScheduledServiceInvoiceWithDeposit({ svc: pricedSvc, buildCreateParams });
      expect(result.invoice).toEqual({ id: 'inv-1' });
    });

    it('allowPriceMovement (frozen-money resume lanes) bypasses the refusal', async () => {
      programTransactions(makeTrx({
        lockedSvcRow: { id: 'svc-1', estimated_price: 100, primary_line_price: null },
      }));
      mockPending.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({ id: 'inv-1' });

      const result = await mintScheduledServiceInvoiceWithDeposit({
        svc: pricedSvc, buildCreateParams, allowPriceMovement: true,
      });
      expect(result.invoice).toEqual({ id: 'inv-1' });
    });

    it('404s terminally when the visit row vanished before the lock', async () => {
      programTransactions(makeTrx({ lockedSvcRow: null }));

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc: pricedSvc, buildCreateParams }),
      ).rejects.toMatchObject({ status: 404 });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('a caller snapshot without price fields never trips the guard', async () => {
      programTransactions(makeTrx({
        lockedSvcRow: { id: 'svc-1', estimated_price: 77, primary_line_price: 12 },
      }));
      mockPending.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({ id: 'inv-1' });

      const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams });
      expect(result.invoice).toEqual({ id: 'inv-1' });
    });
  });

  describe('schedule mints leave tax to TaxCalculator (no hard-coded taxRate)', () => {
    it('mintOrReuseScheduledServiceInvoice builds create params WITHOUT a taxRate key', async () => {
      // Tax is the calculator's call (verified exemptions / service
      // taxability / county rates), not a flat per-property_type override:
      // the key must be ABSENT — an explicit value (even 0) pre-empts
      // TaxCalculator in InvoiceService.create, and the old
      // `cust_property_type === 'commercial' ? 0.07 : 0` billed `business`
      // customers at 0%. Same contract as billing recovery (#3448).
      db.mockImplementation(() => {
        const q = {};
        q.where = jest.fn(() => q);
        q.whereNot = jest.fn(() => q);
        q.orderBy = jest.fn(() => q);
        q.first = jest.fn(async () => undefined); // no existing invoice
        return q;
      });
      programTransactions(makeTrx({
        lockedSvcRow: { id: 'svc-1', estimated_price: 100, primary_line_price: null },
      }));
      mockPending.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({ id: 'inv-1' });

      const result = await mintOrReuseScheduledServiceInvoice({
        ...svc,
        estimated_price: 100,
        cust_property_type: 'business',
      });

      expect(result).toMatchObject({ invoice: { id: 'inv-1' }, reused: false });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const opts = mockCreate.mock.calls[0][0];
      expect(opts).toMatchObject({ customerId: 'cust-1', scheduledServiceId: 'svc-1' });
      expect(Object.prototype.hasOwnProperty.call(opts, 'taxRate')).toBe(false);
    });

    it('no schedule mint passes an explicit taxRate (source contract for the tech-checkout mint too)', () => {
      // The POST /:id/invoice tech-checkout mint shares the contract but is
      // impractical to drive here — pin the source: no `taxRate:` key
      // anywhere on the route.
      const fs = require('fs');
      const path = require('path');
      const routeSource = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
      expect(routeSource).not.toMatch(/taxRate:/);
    });
  });
});
