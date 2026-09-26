const rows = {
  customers: { id: 'cust-1', first_name: 'Casey', email: 'casey@example.com' },
  notification_prefs: { customer_id: 'cust-1', billing_channels: ['email'] },
  invoices: { id: 'inv-1', customer_id: 'cust-1', status: 'sent' },
};

const defaultDbImplementation = (table) => ({
  where: jest.fn().mockReturnThis(),
  forUpdate: jest.fn().mockReturnThis(),
  first: jest.fn(async () => rows[table] || null),
});
const mockDb = jest.fn(defaultDbImplementation);
mockDb.transaction = jest.fn(async (callback) => callback(mockDb));

jest.mock('../models/db', () => mockDb);

const mockWithCustomerCommsLock = jest.fn(async (database, _customerId, callback) => (
  database.transaction(callback)
));
const mockLockCustomerEmail = jest.fn(async () => {});
jest.mock('../utils/customer-comms-lock', () => ({
  withCustomerCommsLock: mockWithCustomerCommsLock,
  lockCustomerEmail: mockLockCustomerEmail,
}));

const mockWithInvoiceDepositSettlement = jest.fn(async (invoiceId, callback, database) => (
  database.transaction((trx) => {
    const invoice = rows.invoices?.id === invoiceId ? rows.invoices : null;
    return invoice ? callback(trx, invoice) : null;
  })
));
jest.mock('../services/estimate-deposits', () => ({
  withInvoiceDepositSettlement: mockWithInvoiceDepositSettlement,
}));

const mockLoadTemplateByKey = jest.fn(async () => ({
  template: { template_key: 'billing.notice', send_stream: 'transactional_required' },
}));
const mockActiveSuppressionFor = jest.fn(async () => null);

jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: mockLoadTemplateByKey,
  activeSuppressionFor: mockActiveSuppressionFor,
}));
jest.mock('../services/invoice-helpers', () => ({
  selfPayAtDispatch: jest.fn(() => async () => ({ ok: true })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'casey@example.com', name: 'Casey', role: 'primary' }]),
}));

const {
  loadBillingEmailContext,
  dispatchUnderBillingEmailAuthority,
} = require('../services/billing-channel-email-authority');
const { selfPayAtDispatch } = require('../services/invoice-helpers');
const { getInvoiceEmailRecipients } = require('../services/customer-contact');

function input(overrides = {}) {
  return {
    body: 'Your saved card needs attention. No invented outcome text.',
    customerId: 'cust-1',
    channel: 'email',
    metadata: {
      billingDeliveryCategory: 'billing',
      notificationEventKey: 'payment-expiry:pm-1:2026-10',
    },
    ...overrides,
  };
}

// Drives the same two-step flow the adapter runs: prepare context, then hand
// dispatch off to the authority under its locks. Tests assert on the
// resulting `state` (boundary block / handoff semantics) and `outcome`
// rather than a template-send result, since sending is the adapter's job.
async function runAuthority(overrides = {}, { preSendCheck, dispatch = jest.fn(async () => {}) } = {}) {
  const requestInput = input(overrides);
  const context = await loadBillingEmailContext(requestInput);
  if (context.error) return { context, outcome: { ok: false }, state: null, dispatch };
  const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
  const outcome = await dispatchUnderBillingEmailAuthority({
    input: requestInput, recipientEmail: context.recipientEmail, preSendCheck, dispatch, state,
  });
  return { context, outcome, state, dispatch };
}

describe('billing channel email authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockImplementation(defaultDbImplementation);
    mockDb.transaction.mockImplementation(async (callback) => callback(mockDb));
    mockWithCustomerCommsLock.mockImplementation(async (database, _customerId, callback) => (
      database.transaction(callback)
    ));
    mockLockCustomerEmail.mockResolvedValue();
    mockLoadTemplateByKey.mockResolvedValue({
      template: { template_key: 'billing.notice', send_stream: 'transactional_required' },
    });
    mockActiveSuppressionFor.mockResolvedValue(null);
    mockWithInvoiceDepositSettlement.mockImplementation(async (invoiceId, callback, database) => (
      database.transaction((trx) => {
        const invoice = rows.invoices?.id === invoiceId ? rows.invoices : null;
        return invoice ? callback(trx, invoice) : null;
      })
    ));
    selfPayAtDispatch.mockImplementation(() => async () => ({ ok: true }));
    getInvoiceEmailRecipients.mockImplementation(() => [{ email: 'casey@example.com', name: 'Casey', role: 'primary' }]);
    rows.customers = { id: 'cust-1', first_name: 'Casey', email: 'casey@example.com' };
    rows.notification_prefs = { customer_id: 'cust-1', billing_channels: ['email'] };
    rows.invoices = { id: 'inv-1', customer_id: 'cust-1', status: 'sent' };
  });

  test('does not allow dispatch when Email is absent from the explicit category selection', async () => {
    rows.notification_prefs = { customer_id: 'cust-1', billing_channels: ['sms', 'push'] };
    const { context } = await runAuthority();
    expect(context.error).toMatchObject({
      blocked: true, code: 'BILLING_EMAIL_NOT_SELECTED', deliveryOutcome: 'not_sent',
    });
  });

  test('does not allow dispatch when the global email preference is disabled', async () => {
    rows.notification_prefs = { customer_id: 'cust-1', email_enabled: false, billing_channels: ['email'] };
    const { context } = await runAuthority();
    expect(context.error).toMatchObject({ blocked: true, code: 'BILLING_EMAIL_DISABLED' });
  });

  test('rechecks the selected channel at the provider boundary', async () => {
    let reads = 0;
    mockDb.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        if (table === 'notification_prefs') {
          reads += 1;
          return reads === 1
            ? { customer_id: 'cust-1', billing_channels: ['email'] }
            : { customer_id: 'cust-1', billing_channels: ['sms'] };
        }
        return rows[table] || null;
      }),
    }));
    const { outcome, state } = await runAuthority();
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({ blocked: true, code: 'BILLING_EMAIL_NOT_SELECTED' });
  });

  test('rechecks the global email opt-out at the provider boundary', async () => {
    let reads = 0;
    mockDb.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        if (table === 'notification_prefs') {
          reads += 1;
          return { customer_id: 'cust-1', email_enabled: reads === 1, billing_channels: ['email'] };
        }
        return rows[table] || null;
      }),
    }));
    const { outcome, state } = await runAuthority();
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({ blocked: true, code: 'BILLING_EMAIL_DISABLED' });
  });

  test('locks the address and rechecks canonical suppression before provider dispatch', async () => {
    const handoffOrder = [];
    mockLockCustomerEmail.mockImplementationOnce(async (trx, email) => {
      expect(trx).toBe(mockDb);
      expect(email).toBe('casey@example.com');
      handoffOrder.push('address-lock');
    });
    mockActiveSuppressionFor.mockImplementationOnce(async (template, email, group, trx) => {
      expect(template).toMatchObject({ template_key: 'billing.notice' });
      expect(email).toBe('casey@example.com');
      expect(group).toBe('transactional_required');
      expect(trx).toBe(mockDb);
      handoffOrder.push('suppression-read');
      return { suppression_type: 'bounce', group_key: null };
    });

    const dispatch = jest.fn(async () => {});
    const { outcome, state } = await runAuthority({}, { dispatch });
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({ blocked: true, code: 'EMAIL_SUPPRESSED', deliveryOutcome: 'not_sent' });
    expect(handoffOrder).toEqual(['address-lock', 'suppression-read']);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('the locked suppression recheck loads billing.notice for a non-receipt category', async () => {
    const { outcome } = await runAuthority();
    expect(outcome.ok).toBe(true);
    expect(mockLoadTemplateByKey).toHaveBeenCalledWith('billing.notice', mockDb);
  });

  test('the locked suppression recheck loads billing.receipt_notice for the payment_receipt category', async () => {
    rows.notification_prefs = { customer_id: 'cust-1', payment_receipt_channels: ['email'] };
    const { outcome } = await runAuthority({
      metadata: { billingDeliveryCategory: 'payment_receipt', notificationEventKey: 'deposit-receipt:inv-1' },
    });
    expect(outcome.ok).toBe(true);
    expect(mockLoadTemplateByKey).toHaveBeenCalledWith('billing.receipt_notice', mockDb);
  });

  test('refuses an invoice that does not belong to the selected customer', async () => {
    rows.invoices = { id: 'inv-1', customer_id: 'cust-other', status: 'sent' };
    const { context } = await runAuthority({ invoiceId: 'inv-1' });
    expect(context.error).toMatchObject({ blocked: true, code: 'INVOICE_CUSTOMER_MISMATCH' });
  });

  test('refuses payer-owned invoice delivery before template dispatch', async () => {
    selfPayAtDispatch.mockImplementation(() => async () => ({
      ok: false,
      code: 'payer_billed',
      reason: 'Invoice is billed to a third-party payer',
    }));
    const { context } = await runAuthority({ invoiceId: 'inv-1' });
    expect(context.error).toMatchObject({ blocked: true, code: 'payer_billed' });
  });

  test('rechecks invoice ownership while both handoff locks cover provider dispatch', async () => {
    let commsLocked = false;
    let invoiceLocked = false;
    const recipientLocks = [];
    const lockedTrx = jest.fn((table) => {
      const query = defaultDbImplementation(table);
      query.forUpdate.mockImplementation(() => {
        expect(commsLocked).toBe(true);
        expect(invoiceLocked).toBe(true);
        recipientLocks.push(table);
        return query;
      });
      return query;
    });
    mockWithCustomerCommsLock.mockImplementationOnce(async (database, customerId, callback) => {
      expect(database).toBe(mockDb);
      expect(customerId).toBe('cust-1');
      commsLocked = true;
      try { return await callback(lockedTrx); } finally { commsLocked = false; }
    });
    mockWithInvoiceDepositSettlement.mockImplementationOnce(async (invoiceId, callback, database) => {
      expect(invoiceId).toBe('inv-1');
      expect(database).toBe(lockedTrx);
      expect(commsLocked).toBe(true);
      invoiceLocked = true;
      try { return await callback(lockedTrx, rows.invoices); } finally { invoiceLocked = false; }
    });
    const dispatch = jest.fn(async () => {
      expect(commsLocked).toBe(true);
      expect(invoiceLocked).toBe(true);
    });

    const { outcome, state } = await runAuthority({ invoiceId: 'inv-1' }, { dispatch });
    expect(outcome.ok).toBe(true);
    expect(state.providerAccepted).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(selfPayAtDispatch).toHaveBeenNthCalledWith(2, 'inv-1', lockedTrx);
    expect(recipientLocks).toEqual(['customers', 'notification_prefs']);
    expect(mockLockCustomerEmail).toHaveBeenCalledWith(lockedTrx, 'casey@example.com');
    expect(commsLocked).toBe(false);
    expect(invoiceLocked).toBe(false);
  });

  test('blocks when invoice ownership changes before provider dispatch', async () => {
    selfPayAtDispatch
      .mockImplementationOnce(() => async () => ({ ok: true }))
      .mockImplementationOnce(() => async () => ({
        ok: false, code: 'payer_billed', reason: 'Invoice moved to a third-party payer',
      }));
    const { outcome, state } = await runAuthority({ invoiceId: 'inv-1' });
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({ blocked: true, code: 'payer_billed', deliveryOutcome: 'not_sent' });
  });

  test('preserves provider acceptance when the surrounding transaction cannot commit', async () => {
    mockWithCustomerCommsLock.mockImplementationOnce(async (database, _customerId, callback) => {
      await callback(database);
      throw new Error('read-only handoff commit failed');
    });
    const { outcome, state } = await runAuthority();
    expect(outcome.ok).toBe(true);
    expect(state.providerAccepted).toBe(true);
  });

  test('aborts when the billing recipient changes before provider handoff', async () => {
    getInvoiceEmailRecipients.mockImplementation((customer) => [{
      email: customer.email,
      name: customer.first_name,
      role: 'primary',
    }]);
    let customerReads = 0;
    mockDb.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        if (table === 'customers') {
          customerReads += 1;
          return customerReads === 1
            ? rows.customers
            : { ...rows.customers, email: 'new-billing@example.com' };
        }
        return rows[table] || null;
      }),
    }));
    const { outcome, state } = await runAuthority();
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({ blocked: true, code: 'EMAIL_RECIPIENT_CHANGED' });
  });

  test('invokes the pre-send check for the email channel before dispatch', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    const { outcome } = await runAuthority({}, { preSendCheck });
    expect(outcome.ok).toBe(true);
    expect(preSendCheck).toHaveBeenCalledWith({ channel: 'email', database: mockDb });
  });

  test('blocks dispatch when the pre-send check fails', async () => {
    const preSendCheck = jest.fn(async () => ({
      ok: false, code: 'PORTAL_HOLD', reason: 'Portal hold active', retryable: true,
    }));
    const dispatch = jest.fn(async () => {});
    const { outcome, state } = await runAuthority({}, { preSendCheck, dispatch });
    expect(outcome.ok).toBe(false);
    expect(state.boundaryBlock).toMatchObject({
      blocked: true, code: 'PORTAL_HOLD', reason: 'Portal hold active', retryable: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
