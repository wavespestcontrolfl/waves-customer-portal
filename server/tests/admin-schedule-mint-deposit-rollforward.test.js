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
 *     and holds the invoice mint until the ledger is reconciled
 *   - the in-lock replay check still short-circuits before any deposit work
 *   - a visit with no source estimate mints exactly as before
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
const mockLedgerLock = jest.fn(async () => undefined);
jest.mock('../services/estimate-deposits', () => ({
  acquireEstimateDepositLedgerLock: (...args) => mockLedgerLock(...args),
  pendingDepositCredit: (...args) => mockPending(...args),
  consumeDepositCredit: (...args) => mockConsume(...args),
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

function makeTrx({ replayedInvoice = undefined, lockedSvcRow, sourceEstimateId = 'est-1' } = {}) {
  const trx = (table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNot = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.whereNull = jest.fn(() => q);
    q.join = jest.fn(() => q);
    q.noWait = jest.fn(() => q);
    q.select = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.forUpdate = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table === 'invoices') return replayedInvoice;
      if (table === 'scheduled_services') {
        // The mint's row lock re-read; undefined estimated_price on the
        // caller's svc keeps the stale-price guard out of legacy tests.
        return lockedSvcRow === null ? null : {
          id: 'svc-1', customer_id: 'cust-1', source_estimate_id: sourceEstimateId,
          estimated_price: null, primary_line_price: null,
          ...(lockedSvcRow || {}),
        };
      }
      return undefined;
    });
    // Owner ruling — REFUSE AFTER A VOID: an UNPRICED svc linked to an
    // estimate runs siblingInvoiceCoverageVerdict's combinedInvoiceVoidedWithoutLiveReplacement
    // guard under this same transaction — its 'invoices as i' query is
    // AWAITED DIRECTLY (thenable — mirrors knex's `.select()`), never
    // through `.first()`. Every existing test in this file wants "nothing
    // on the estimate" (the ordinary case), so this resolves to `[]`.
    if (table === 'invoices as i') {
      q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
      q.catch = (reject) => Promise.resolve([]).catch(reject);
    }
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
    programTransactions(makeTrx({ sourceEstimateId: null }));
    mockCreate.mockResolvedValueOnce({ id: 'inv-1', applied_deposit_credit: 0 });

    await mintScheduledServiceInvoiceWithDeposit({ svc: { ...svc, source_estimate_id: null }, buildCreateParams });

    expect(mockPending).not.toHaveBeenCalled();
    expect(mockCreate.mock.calls[0][0].depositCredit).toBeUndefined();
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('refuses a stale estimate source before reading or applying deposit credit', async () => {
    programTransactions(makeTrx({ sourceEstimateId: 'est-other' }));
    await expect(mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams }))
      .rejects.toMatchObject({ code: 'SCHEDULED_BILLING_SOURCE_MOVED', status: 409 });
    expect(mockPending).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('retries once on allocation mismatch, then alerts and holds the invoice mint', async () => {
    programTransactions(makeTrx(), makeTrx());
    // Both credited attempts mismatch; neither can publish an uncredited bill.
    mockPending.mockResolvedValue({ amount: 49 });
    mockCreate
      .mockResolvedValueOnce({ id: 'inv-a', applied_deposit_credit: 49 })
      .mockResolvedValueOnce({ id: 'inv-b', applied_deposit_credit: 49 });
    mockConsume.mockResolvedValue(20);

    await expect(mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams }))
      .rejects.toMatchObject({ code: 'DEPOSIT_RECONCILIATION_REQUIRED', status: 409 });

    expect(mockCreate).toHaveBeenCalledTimes(2);
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

  it('bubbles an uncredited-mint failure instead of looping', async () => {
    programTransactions(makeTrx({ sourceEstimateId: null }));
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
        q.whereNotIn = jest.fn(() => q);
        q.whereNull = jest.fn(() => q);
        // Owner ruling — REFUSE AFTER A VOID: this priced svc's own mint
        // never asks the sibling-coverage question at all
        // (isSiblingCoverageEligibleVisit requires !hasOwnPrice), so no
        // extra query shape is needed here — these chain methods are kept
        // only for parity with the other stubs in this file.
        q.whereIn = jest.fn(() => q);
        q.join = jest.fn(() => q);
        q.forUpdate = jest.fn(() => q);
        q.noWait = jest.fn(() => q);
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

  // Codex round-6 P1: two sibling visits under the SAME estimate, charged
  // at the same moment while neither has an invoice, could both run
  // recheckInTrx's sibling lookup (lockRows: true — FOR UPDATE OF i locks
  // nothing when no row matches), both see 'none', and both mint a
  // collectible base invoice for the same trip. The estimate-scoped ledger
  // lock (the ONE key every estimate-scoped writer already shares) must be
  // taken BEFORE recheckInTrx so only one mint per estimate can even reach
  // the recheck at a time — the loser's recheck (or resolver snapshot) then
  // sees the winner's freshly committed invoice and refuses instead of
  // minting beside it.
  // Codex round-6 P1 (pre-push): a sibling-coverage verdict — both the
  // resolver's pre-lock read and this transaction's own recheckInTrx —
  // classifies coverage against `svc.scheduled_date`. A reschedule between
  // that read and this lock invalidates it exactly like a moved customer or
  // estimate: both lookups would classify the OLD day's siblings, letting
  // an extras-only invoice mint on a now-uncovered visit. The locked
  // svc row now carries scheduled_date and is compared the same
  // unconditional way as customer_id/source_estimate_id.
  describe('reschedule guard (scheduled_date moved under the lock)', () => {
    const datedSvc = { ...svc, scheduled_date: '2026-09-27' };

    it('409s SCHEDULED_BILLING_SOURCE_MOVED when the locked scheduled_date differs from the caller snapshot', async () => {
      programTransactions(makeTrx({ lockedSvcRow: { scheduled_date: '2026-10-04' } }));

      await expect(
        mintScheduledServiceInvoiceWithDeposit({ svc: datedSvc, buildCreateParams }),
      ).rejects.toMatchObject({ status: 409, code: 'SCHEDULED_BILLING_SOURCE_MOVED' });
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('mints normally when the locked scheduled_date matches', async () => {
      programTransactions(makeTrx({ lockedSvcRow: { scheduled_date: '2026-09-27' } }));
      mockPending.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({ id: 'inv-1' });

      const result = await mintScheduledServiceInvoiceWithDeposit({ svc: datedSvc, buildCreateParams });
      expect(result.invoice).toEqual({ id: 'inv-1' });
    });

    it('a caller snapshot with no scheduled_date field never trips the guard (legacy/pure callers)', async () => {
      programTransactions(makeTrx({ lockedSvcRow: { scheduled_date: '2026-10-04' } }));
      mockPending.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({ id: 'inv-1' });

      // `svc` (module-level fixture) carries no scheduled_date at all.
      const result = await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams });
      expect(result.invoice).toEqual({ id: 'inv-1' });
    });
  });

  describe('estimate ledger lock precedes the caller recheck', () => {
    it('acquires the estimate-scoped ledger lock BEFORE calling recheckInTrx', async () => {
      programTransactions(makeTrx());
      mockPending.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({ id: 'inv-1' });
      const order = [];
      mockLedgerLock.mockImplementationOnce(async () => { order.push('ledger_lock'); });
      const recheckInTrx = jest.fn(async () => { order.push('recheck'); });

      await mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, recheckInTrx });

      expect(order).toEqual(['ledger_lock', 'recheck']);
    });

    it('still runs recheckInTrx when the visit has no source estimate (no ledger lock to take)', async () => {
      programTransactions(makeTrx({ sourceEstimateId: null }));
      mockCreate.mockResolvedValueOnce({ id: 'inv-1' });
      const recheckInTrx = jest.fn(async () => {});

      await mintScheduledServiceInvoiceWithDeposit({
        svc: { ...svc, source_estimate_id: null }, buildCreateParams, recheckInTrx,
      });

      expect(mockLedgerLock).not.toHaveBeenCalled();
      expect(recheckInTrx).toHaveBeenCalledTimes(1);
    });

    it('a recheckInTrx refusal still throws AFTER the ledger lock was taken, never before — proves the order under a failure too', async () => {
      programTransactions(makeTrx());
      const order = [];
      mockLedgerLock.mockImplementationOnce(async () => { order.push('ledger_lock'); });
      const recheckInTrx = jest.fn(async () => {
        order.push('recheck');
        const e = new Error('sibling coverage changed while charging');
        e.status = 409;
        e.code = 'SIBLING_COVERAGE_CHANGED';
        throw e;
      });

      await expect(mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, recheckInTrx }))
        .rejects.toMatchObject({ code: 'SIBLING_COVERAGE_CHANGED' });
      expect(order).toEqual(['ledger_lock', 'recheck']);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });
});
