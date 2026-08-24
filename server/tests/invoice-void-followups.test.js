jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/invoice-followups', () => ({
  stopSequence: jest.fn(async () => undefined),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  syncTermForInvoicePayment: jest.fn(async () => undefined),
}));
const mockRestoreDepositCredit = jest.fn(async () => 0);
jest.mock('../services/estimate-deposits', () => ({
  restoreDepositCreditForVoidedInvoice: (...args) => mockRestoreDepositCredit(...args),
}));

const db = require('../models/db');
const FollowUps = require('../services/invoice-followups');
const InvoiceService = require('../services/invoice');

function chain({ first, returning } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  return q;
}

// voidInvoice runs a money guard (db('payments')…first('id')) before AND inside
// the void transaction — a credit-only invoice has no such row, so both resolve
// to undefined and the void proceeds. Each call consumes one db() mock slot.
const noPayment = () => chain({ first: undefined });

function invoice(overrides = {}) {
  return {
    id: 'inv-1',
    status: 'sent',
    invoice_number: 'WPC-2026-1042',
    ...overrides,
  };
}

describe('InvoiceService.voidInvoice follow-up cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Pass-through transaction — the void + ledger restore share it.
    db.transaction = jest.fn(async (fn) => fn(db));
  });

  test('stops the invoice follow-up sequence after voiding an invoice', async () => {
    db
      .mockReturnValueOnce(chain({ first: invoice() }))
      .mockReturnValueOnce(noPayment())
      .mockReturnValueOnce(chain({ returning: [invoice({ status: 'void' })] }))
      .mockReturnValueOnce(noPayment());

    await InvoiceService.voidInvoice('inv-1');

    expect(FollowUps.stopSequence).toHaveBeenCalledWith('inv-1', {
      reason: 'invoice_voided',
    });
  });

  test('also stops a stale sequence when the invoice is already void', async () => {
    db.mockReturnValueOnce(chain({ first: invoice({ status: 'void' }) }));

    await InvoiceService.voidInvoice('inv-1');

    expect(FollowUps.stopSequence).toHaveBeenCalledWith('inv-1', {
      reason: 'invoice_voided',
    });
  });

  test('restores deposit credits inside the void transaction (P1)', async () => {
    const voided = invoice({
      status: 'void',
      line_items: JSON.stringify([
        { description: 'Service', quantity: 1, unit_price: 100 },
        { description: 'Deposit credit (paid at acceptance)', quantity: 1, unit_price: -49, amount: -49, category: 'deposit_credit', estimate_id: 'est-1' },
      ]),
    });
    db
      .mockReturnValueOnce(chain({ first: invoice() }))
      .mockReturnValueOnce(noPayment())
      .mockReturnValueOnce(chain({ returning: [voided] }))
      .mockReturnValueOnce(noPayment());

    await InvoiceService.voidInvoice('inv-1');

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mockRestoreDepositCredit).toHaveBeenCalledWith({ invoice: voided, trx: db });
  });

  test('a restore failure rolls the void back — blocked void beats stranded deposit money (P1)', async () => {
    db
      .mockReturnValueOnce(chain({ first: invoice() }))
      .mockReturnValueOnce(noPayment())
      .mockReturnValueOnce(chain({ returning: [invoice({ status: 'void' })] }))
      .mockReturnValueOnce(noPayment());
    mockRestoreDepositCredit.mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(InvoiceService.voidInvoice('inv-1')).rejects.toThrow('ledger unavailable');
    // The throw propagates out of db.transaction, so the void never commits;
    // no post-void side effects run either.
    expect(FollowUps.stopSequence).not.toHaveBeenCalled();
  });

  test('a lost conditional void (status changed mid-flight) throws instead of restoring twice', async () => {
    db
      .mockReturnValueOnce(chain({ first: invoice() }))
      .mockReturnValueOnce(noPayment())
      .mockReturnValueOnce(chain({ returning: [] }));

    await expect(InvoiceService.voidInvoice('inv-1')).rejects.toThrow(/changed while voiding/);
    expect(mockRestoreDepositCredit).not.toHaveBeenCalled();
  });

  test('refuses to void a CASH-backed prepaid invoice (payment_recorded_at) — refund, not void', async () => {
    // 'prepaid' passes assertInvoiceVoidable, but a cash-backed prepayment records
    // money; voiding it would hide collected revenue. Must refund instead.
    db
      .mockReturnValueOnce(chain({ first: invoice({ status: 'prepaid', payment_recorded_at: '2026-06-21T12:00:00Z' }) }))
      .mockReturnValueOnce(noPayment());

    await expect(InvoiceService.voidInvoice('inv-1')).rejects.toThrow(/payment already applied[\s\S]*refund instead/);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockRestoreDepositCredit).not.toHaveBeenCalled();
  });

  test('refuses to void a prepaid invoice with a paid payments row — refund, not void', async () => {
    db
      .mockReturnValueOnce(chain({ first: invoice({ status: 'prepaid' }) }))
      .mockReturnValueOnce(chain({ first: { id: 'pay-9' } }));

    await expect(InvoiceService.voidInvoice('inv-1')).rejects.toThrow(/payment already applied \(payment pay-9\)/);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
