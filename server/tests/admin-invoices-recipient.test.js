const adminInvoicesRoute = require('../routes/admin-invoices');

const {
  invoiceRecipientOverrideError,
  paymentPlanFollowupStopReason,
  stopInvoiceFollowupsForPaymentPlan,
} = adminInvoicesRoute._private;

describe('admin invoice recipient override validation', () => {
  test('rejects invalid invoice recipient email format', () => {
    expect(invoiceRecipientOverrideError('not-an-email', false))
      .toBe('Enter a valid invoice recipient email.');
  });

  test('rejects non-boolean save-as-default flags', () => {
    expect(invoiceRecipientOverrideError('billing@example.com', 'false'))
      .toBe('saveBillingRecipient must be true or false.');
  });

  test('rejects over-length billing recipient email when saving as default', () => {
    const localPart = 'a'.repeat(190);

    expect(invoiceRecipientOverrideError(`${localPart}@example.com`, true))
      .toBe('Billing recipient email must be 200 characters or fewer.');
  });

  test('rejects over-length one-time invoice recipient email', () => {
    const localPart = 'a'.repeat(190);

    expect(invoiceRecipientOverrideError(`${localPart}@example.com`, false))
      .toBe('Invoice recipient email must be 200 characters or fewer.');
  });
});

describe('admin invoice payment plan follow-up handling', () => {
  test('stops active invoice follow-up sequences when a payment plan is created', async () => {
    const query = {
      where: jest.fn(() => null),
      whereIn: jest.fn(() => null),
      update: jest.fn(async () => 1),
    };
    query.where.mockReturnValue(query);
    query.whereIn.mockReturnValue(query);
    const database = jest.fn(() => query);

    const result = await stopInvoiceFollowupsForPaymentPlan('inv-1', {
      paymentPlanId: 'plan-1',
      adminId: 'admin-1',
      database,
    });

    expect(result).toBe(1);
    expect(database).toHaveBeenCalledWith('invoice_followup_sequences');
    expect(query.where).toHaveBeenCalledWith({ invoice_id: 'inv-1' });
    expect(query.whereIn).toHaveBeenCalledWith('status', ['active', 'paused', 'autopay_hold']);
    expect(query.update).toHaveBeenCalledWith({
      status: 'stopped',
      stopped_reason: 'payment_plan_created:plan-1',
      stopped_by_admin_id: 'admin-1',
      next_touch_at: null,
    });
  });

  test('uses a stable reason when the payment plan id is missing', () => {
    expect(paymentPlanFollowupStopReason(null)).toBe('payment_plan_created:unknown');
  });
});
