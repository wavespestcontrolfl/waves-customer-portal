jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({ stopSequence: jest.fn(async () => undefined) }));
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(async () => undefined) }));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { _invoiceHasNonBaseCharges, _invoiceHasDepositCreditLine } = InvoiceService;

function chain({ first, returning, rows } = {}) {
  const q = { _update: null };
  q.where = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.whereNotIn = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.forUpdate = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.update = jest.fn((u) => { q._update = u; return { returning: async () => (returning === undefined ? [] : returning) }; });
  q.insert = jest.fn(async () => [1]);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve) => Promise.resolve(rows || []).then(resolve);
  return q;
}
const invoice = (o = {}) => ({ id: 'inv-1', status: 'sent', invoice_number: 'WPC-1', total: '55.00', tax_rate: 0, line_items: '[]', ...o });
const addonLi = JSON.stringify([
  { client_id: 'scheduled_x_primary', amount: 55 },
  { client_id: 'scheduled_x_addon_9', amount: 25 },
]);

describe('invoiceHasNonBaseCharges (fail-closed)', () => {
  test('no line_items → false', () => expect(_invoiceHasNonBaseCharges({ line_items: '[]' })).toBe(false));
  test('primary only → false', () => expect(_invoiceHasNonBaseCharges({ line_items: JSON.stringify([{ client_id: 'scheduled_x_primary', amount: 55 }]) })).toBe(false));
  test('tagged add-on line → true', () => expect(_invoiceHasNonBaseCharges({ line_items: addonLi })).toBe(true));
  test('positive checkout extra with NO _addon_/_primary id → true (fail-closed)', () => {
    const li = JSON.stringify([{ client_id: 'scheduled_x_primary', amount: 55 }, { description: 'Extra', amount: 30 }]);
    expect(_invoiceHasNonBaseCharges({ line_items: li })).toBe(true);
  });
  test('negative discount/credit line is not a charge → false', () => {
    const li = JSON.stringify([{ client_id: 'scheduled_x_primary', amount: 55 }, { category: 'deposit_credit', amount: -20 }]);
    expect(_invoiceHasNonBaseCharges({ line_items: li })).toBe(false);
  });
  test('malformed line_items → false', () => expect(_invoiceHasNonBaseCharges({ line_items: 'nope' })).toBe(false));
});

describe('invoiceHasDepositCreditLine', () => {
  test('deposit_credit line → true', () => expect(_invoiceHasDepositCreditLine({ line_items: JSON.stringify([{ category: 'deposit_credit', amount: -20 }]) })).toBe(true));
  test('none → false', () => expect(_invoiceHasDepositCreditLine({ line_items: '[]' })).toBe(false));
});

describe('settleInvoiceAsAnnualPrepayCovered (full coverage only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.transaction = jest.fn(async (fn) => fn(db));
    db.fn = { now: () => 'NOW' };
  });

  test('no add-ons → prepaid, dedicated marker set, paid_at stamped, NO payments row', async () => {
    const inv = invoice();
    const updateChain = chain({ first: inv, returning: [{ ...inv, status: 'prepaid' }] });
    db.mockReturnValueOnce(chain({ first: inv }))      // initial fetch
      .mockReturnValueOnce(chain({ first: undefined })) // pre-txn payments check
      .mockReturnValueOnce(chain({ first: inv }))       // locked fetch
      .mockReturnValueOnce(chain({ first: undefined })) // in-txn payments check
      .mockReturnValueOnce(updateChain);                // update
    const res = await InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1');
    expect(res).toMatchObject({ settled: true });
    expect(res.invoice.status).toBe('prepaid');
    expect(updateChain._update).toMatchObject({
      status: 'prepaid', annual_prepay_covered_term_id: 'term-1', prepaid_at: 'NOW', paid_at: 'NOW',
    });
    expect(updateChain._update.annual_prepay_term_id).toBeUndefined(); // never the term-anchor column
    expect(updateChain.insert).not.toHaveBeenCalled();
    // Terminally closes any dunning sequence (parity with voidInvoice / credit close-out).
    expect(require('../services/invoice-followups').stopSequence)
      .toHaveBeenCalledWith('inv-1', { reason: 'annual_prepay_covered' });
  });

  test('invoice with add-ons → NOT settled here (reason has_add_ons), no txn', async () => {
    db.mockReturnValueOnce(chain({ first: invoice({ line_items: addonLi }) }));
    const res = await InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1');
    expect(res).toMatchObject({ settled: false, reason: 'has_add_ons' });
    expect(db.transaction).not.toHaveBeenCalled();
    // A refused settle must not touch the dunning sequence — the invoice stays collectible.
    expect(require('../services/invoice-followups').stopSequence).not.toHaveBeenCalled();
  });

  test('already settled by this term (marker set) → no-op already_covered', async () => {
    db.mockReturnValueOnce(chain({ first: invoice({ annual_prepay_covered_term_id: 'term-1' }) }));
    const res = await InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1');
    expect(res).toMatchObject({ settled: false, reason: 'already_covered' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('terminal (paid) → no-op already_settled', async () => {
    db.mockReturnValueOnce(chain({ first: invoice({ status: 'paid' }) }));
    const res = await InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1');
    expect(res).toMatchObject({ settled: false, reason: 'already_settled' });
  });

  test('processing (ACH in flight) → refused, never flipped to prepaid', async () => {
    db.mockReturnValueOnce(chain({ first: invoice({ status: 'processing' }) }));
    const res = await InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1');
    expect(res).toMatchObject({ settled: false, reason: 'already_settled' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('applied account credit → not settled here (caller voids to restore credit)', async () => {
    db.mockReturnValueOnce(chain({ first: invoice({ credit_applied: '20.00' }) }));
    const res = await InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1');
    expect(res).toMatchObject({ settled: false, reason: 'has_applied_credit' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('ledger-backed deposit credit → not settled here (caller voids to restore deposit)', async () => {
    const li = JSON.stringify([{ client_id: 'scheduled_x_primary', amount: 55 }, { category: 'deposit_credit', amount: -20 }]);
    db.mockReturnValueOnce(chain({ first: invoice({ line_items: li }) }));
    const res = await InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1');
    expect(res).toMatchObject({ settled: false, reason: 'has_deposit_credit' });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('payer-billed → no-op payer_billed', async () => {
    db.mockReturnValueOnce(chain({ first: invoice({ payer_id: 7 }) }));
    const res = await InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1');
    expect(res).toMatchObject({ settled: false, reason: 'payer_billed' });
  });

  test('credit applied between pre-check and lock → aborts under the row lock', async () => {
    const clean = invoice();                       // passes pre-lock guards
    const lockedWithCredit = invoice({ credit_applied: '20.00' }); // changed under lock
    db.mockReturnValueOnce(chain({ first: clean }))       // initial fetch
      .mockReturnValueOnce(chain({ first: undefined }))   // pre-txn payments check
      .mockReturnValueOnce(chain({ first: lockedWithCredit })); // locked fetch → recheck fails
    await expect(InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1'))
      .rejects.toThrow(/Account credit was applied while settling/i);
  });

  test('payment already applied → throws (refund instead)', async () => {
    db.mockReturnValueOnce(chain({ first: invoice() }))
      .mockReturnValueOnce(chain({ first: { id: 'pay-1' } }));
    await expect(InvoiceService.settleInvoiceAsAnnualPrepayCovered('inv-1', 'term-1'))
      .rejects.toThrow(/refund instead/i);
  });
});

describe('reopenAnnualPrepayCoveredInvoicesForTerm', () => {
  beforeEach(() => { jest.clearAllMocks(); db.fn = { now: () => 'NOW' }; });

  test('prepaid-by-covered-term reopens to prev status; cash-paid one is skipped', async () => {
    const prepaidInv = { id: 'i1', status: 'prepaid', prepaid_prev_status: 'sent', payment_recorded_at: null, invoice_number: 'A' };
    const cashInv = { id: 'i2', status: 'prepaid', payment_recorded_at: 'NOW', invoice_number: 'B' };
    const reopenChain = chain({ returning: [1] });
    reopenChain.update = jest.fn((u) => { reopenChain._update = u; return Promise.resolve(1); });
    db.mockReturnValueOnce(chain({ rows: [prepaidInv, cashInv] })) // select by covered-term + prepaid
      .mockReturnValueOnce(chain({ first: undefined }))            // i1: no paid payment
      .mockReturnValueOnce(reopenChain);                          // i1: reopen update
    const n = await InvoiceService.reopenAnnualPrepayCoveredInvoicesForTerm('term-1');
    expect(n).toBe(1);
    expect(reopenChain._update).toMatchObject({
      status: 'sent', paid_at: null, prepaid_at: null,
      // The undone settlement must not leave a stale "settled by term X" claim —
      // it would no-op a legitimate future re-settlement as `already_covered`.
      annual_prepay_covered_term_id: null, prepaid_by: null,
    });
  });
});
