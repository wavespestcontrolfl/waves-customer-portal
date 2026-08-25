jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
const mockReconcile = jest.fn(async () => undefined);
jest.mock('../services/setup-fee-alert-reconcile', () => ({
  reconcileSetupFeeAlertForInvoice: (...args) => mockReconcile(...args),
}));
const mockRetrievePI = jest.fn();
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...args) => mockRetrievePI(...args),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');

function chain({ first, returning } = {}) {
  const q = {};
  q.where = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.whereRaw = jest.fn(() => q);
  q.forUpdate = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  return q;
}

const noPayment = () => chain({ first: undefined });

function voidInvoice(overrides = {}) {
  return {
    id: 'inv-1',
    status: 'void',
    invoice_number: 'WPC-2026-1042',
    ...overrides,
  };
}

describe('InvoiceService.unvoidInvoice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.transaction = jest.fn(async (fn) => fn(db));
  });

  test('restores a voided invoice to draft and clears the archive/session/schedule stamps', async () => {
    const restored = voidInvoice({ status: 'draft' });
    const updateChain = chain({ returning: [restored] });
    db
      .mockReturnValueOnce(chain({ first: voidInvoice() })) // load
      .mockReturnValueOnce(updateChain) // conditional restore
      .mockReturnValueOnce(noPayment()); // fresh-row money guard

    const result = await InvoiceService.unvoidInvoice('inv-1');

    expect(result).toBe(restored);
    expect(updateChain.where).toHaveBeenCalledWith({ id: 'inv-1', status: 'void' });
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'draft',
        archived_at: null,
        stripe_payment_intent_id: null,
        scheduled_send_at: null,
        scheduled_send_attempts: 0,
        scheduled_send_error: null,
        scheduled_request_review: false,
        scheduled_review_delay_minutes: null,
      }),
    );
    expect(mockReconcile).toHaveBeenCalledWith(restored);
  });

  test('refuses an invoice that is not void', async () => {
    db.mockReturnValueOnce(chain({ first: voidInvoice({ status: 'sent' }) }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Only a voided invoice can be unvoided (current status: sent)',
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses when the void returned a deposit credit — the line stays on the invoice but the ledger rows reopened', async () => {
    db.mockReturnValueOnce(
      chain({
        first: voidInvoice({
          line_items: JSON.stringify([
            { description: 'Service', quantity: 1, unit_price: 100, amount: 100 },
            { description: 'Deposit credit', quantity: 1, unit_price: -49, amount: -49, category: 'deposit_credit', estimate_id: 'est-1' },
          ]),
        }),
      }),
    );
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/Cannot unvoid — the deposit credit/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses an annual-prepay-term invoice', async () => {
    db.mockReturnValueOnce(chain({ first: voidInvoice({ annual_prepay_term_id: 'term-1' }) }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/annual prepay term/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('refuses when a payment landed on the voided row (late webhook) — restoring beside collected money double-collects', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice() }))
      .mockReturnValueOnce(chain({ returning: [voidInvoice({ status: 'draft' })] }))
      .mockReturnValueOnce(chain({ first: { id: 'pay-9' } })); // fresh-row money guard hit → rollback
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Cannot unvoid an invoice with payment already applied (payment pay-9)',
    );
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('a lost conditional restore (status changed mid-flight) throws instead of committing side effects', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice() }))
      .mockReturnValueOnce(chain({ returning: [] }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Invoice status changed while unvoiding — re-check and retry',
    );
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  test('a kept PaymentIntent stamp must verify as canceled before it is cleared; anything live refuses', async () => {
    db.mockReturnValueOnce(chain({ first: voidInvoice({ stripe_payment_intent_id: 'pi_1' }) }));
    mockRetrievePI.mockResolvedValueOnce({ status: 'requires_payment_method' });
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'This invoice still has a live payment session (requires_payment_method); resolve it before unvoiding',
    );

    db.mockReturnValueOnce(chain({ first: voidInvoice({ stripe_payment_intent_id: 'pi_1' }) }));
    mockRetrievePI.mockRejectedValueOnce(new Error('boom'));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(
      'Open payment session pi_1 could not be verified (boom); resolve it before unvoiding',
    );

    // Verified-canceled proceeds and clears the stamp.
    const restored = voidInvoice({ status: 'draft' });
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ stripe_payment_intent_id: 'pi_1' }) }))
      .mockReturnValueOnce(chain({ returning: [restored] }))
      .mockReturnValueOnce(noPayment());
    mockRetrievePI.mockResolvedValueOnce({ status: 'canceled' });
    await expect(InvoiceService.unvoidInvoice('inv-1')).resolves.toBe(restored);
  });

  test('refuses a voided line on a finalized payer statement (frozen total)', async () => {
    db
      .mockReturnValueOnce(chain({ first: voidInvoice({ payer_statement_id: 'stmt-1' }) }))
      .mockReturnValueOnce(chain({ first: { status: 'finalized' } }));
    await expect(InvoiceService.unvoidInvoice('inv-1')).rejects.toThrow(/finalized payer statement/);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
