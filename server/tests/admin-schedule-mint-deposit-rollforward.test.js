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
jest.mock('../services/estimate-deposits', () => ({
  pendingDepositCredit: (...args) => mockPending(...args),
  consumeDepositCredit: (...args) => mockConsume(...args),
}));
const mockTrigger = jest.fn(async () => undefined);
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTrigger(...args),
}));

const db = require('../models/db');
const adminScheduleRouter = require('../routes/admin-schedule');

const { mintScheduledServiceInvoiceWithDeposit } = adminScheduleRouter._test;

function makeTrx({ replayedInvoice = undefined } = {}) {
  const trx = (table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereNot = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'invoices' ? replayedInvoice : undefined));
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

  it('bubbles an uncredited-mint failure instead of looping', async () => {
    programTransactions(makeTrx());
    mockCreate.mockRejectedValueOnce(new Error('create exploded'));

    await expect(
      mintScheduledServiceInvoiceWithDeposit({ svc: { ...svc, source_estimate_id: null }, buildCreateParams }),
    ).rejects.toThrow('create exploded');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
