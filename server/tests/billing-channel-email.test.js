const rows = {
  customers: { id: 'cust-1', first_name: 'Casey', email: 'casey@example.com' },
  notification_prefs: { customer_id: 'cust-1', billing_channels: ['email'] },
  invoices: { id: 'inv-1', customer_id: 'cust-1', status: 'sent' },
};

const defaultDbImplementation = (table) => ({
  where: jest.fn().mockReturnThis(),
  first: jest.fn(async () => rows[table] || null),
});
const mockDb = jest.fn(defaultDbImplementation);
mockDb.transaction = jest.fn(async (callback) => callback(mockDb));

jest.mock('../models/db', () => mockDb);

const mockWithCustomerCommsLock = jest.fn(async (database, _customerId, callback) => (
  database.transaction(callback)
));
jest.mock('../utils/customer-comms-lock', () => ({
  withCustomerCommsLock: mockWithCustomerCommsLock,
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

const mockSendTemplate = jest.fn(async (input) => {
  let providerResult = null;
  const verdict = await input.withProviderHandoff(async () => {
    providerResult = { messageId: 'provider-1' };
  });
  if (verdict?.ok !== true || !providerResult) {
    return { sent: false, aborted: true, reason: 'aborted_before_dispatch' };
  }
  return { sent: true, message: { provider_message_id: providerResult.messageId } };
});

jest.mock('../services/email-template-library', () => ({
  sendTemplate: mockSendTemplate,
  redactEmailAddresses: (value) => value,
}));
jest.mock('../services/invoice-helpers', () => ({
  selfPayAtDispatch: jest.fn(() => async () => ({ ok: true })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'casey@example.com', name: 'Casey', role: 'primary' }]),
}));

const { sendBillingChannelEmail } = require('../services/billing-channel-email');
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

describe('billing channel email adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.mockImplementation(defaultDbImplementation);
    mockDb.transaction.mockImplementation(async (callback) => callback(mockDb));
    mockWithCustomerCommsLock.mockImplementation(async (database, _customerId, callback) => (
      database.transaction(callback)
    ));
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

  test('sends existing notification copy through billing.notice with a stable email key', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    await expect(sendBillingChannelEmail(input(), { preSendCheck })).resolves.toMatchObject({
      sent: true,
      provider: 'email',
      providerMessageId: 'provider-1',
      deliveryOutcome: 'accepted',
    });
    expect(preSendCheck).toHaveBeenCalledWith({ channel: 'email' });
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'billing.notice',
      to: 'casey@example.com',
      idempotencyKey: 'billing_channel_email:payment-expiry:pm-1:2026-10:email',
      payload: expect.objectContaining({
        category_label: 'Billing reminder',
        notification_body: input().body,
      }),
      suppressProviderErrorLog: true,
    }));
  });

  test('removes the SMS opt-out footer while preserving the billing copy', async () => {
    await sendBillingChannelEmail(input({
      body: 'Your invoice is ready: https://waves.example/pay/1 Reply STOP to opt out.',
    }));

    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        notification_body: 'Your invoice is ready: https://waves.example/pay/1',
      }),
    }));
  });

  test('does not send when Email is absent from the explicit category selection', async () => {
    rows.notification_prefs = { customer_id: 'cust-1', billing_channels: ['sms', 'push'] };
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false,
      blocked: true,
      code: 'BILLING_EMAIL_NOT_SELECTED',
      deliveryOutcome: 'not_sent',
    });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('does not send when the global email preference is disabled', async () => {
    rows.notification_prefs = { customer_id: 'cust-1', email_enabled: false, billing_channels: ['email'] };
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, blocked: true, code: 'BILLING_EMAIL_DISABLED', deliveryOutcome: 'not_sent',
    });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test.each([false, true])('reports uncertainty only after provider handoff started: %s', async (afterHandoff) => {
    mockSendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const fail = async () => { throw Object.assign(new Error('temporary provider failure'), { retryable: true }); };
      if (afterHandoff) return withProviderHandoff(fail);
      return fail();
    });
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, deliveryOutcome: afterHandoff ? 'uncertain' : 'not_sent', retryable: true,
    });
  });

  test('rechecks the selected channel at the provider boundary', async () => {
    let reads = 0;
    mockDb.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
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
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false,
      blocked: true,
      code: 'BILLING_EMAIL_NOT_SELECTED',
    });
  });

  test('rechecks the global email opt-out at the provider boundary', async () => {
    let reads = 0;
    mockDb.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        if (table === 'notification_prefs') {
          reads += 1;
          return { customer_id: 'cust-1', email_enabled: reads === 1, billing_channels: ['email'] };
        }
        return rows[table] || null;
      }),
    }));
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, blocked: true, code: 'BILLING_EMAIL_DISABLED',
    });
  });

  test('refuses an invoice that does not belong to the selected customer', async () => {
    rows.invoices = { id: 'inv-1', customer_id: 'cust-other', status: 'sent' };

    await expect(sendBillingChannelEmail(input({ invoiceId: 'inv-1' }))).resolves.toMatchObject({
      sent: false,
      blocked: true,
      code: 'INVOICE_CUSTOMER_MISMATCH',
    });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('refuses payer-owned invoice delivery before template dispatch', async () => {
    selfPayAtDispatch.mockImplementation(() => async () => ({
      ok: false,
      code: 'payer_billed',
      reason: 'Invoice is billed to a third-party payer',
    }));

    await expect(sendBillingChannelEmail(input({ invoiceId: 'inv-1' }))).resolves.toMatchObject({
      sent: false,
      blocked: true,
      code: 'payer_billed',
    });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('rechecks invoice ownership while both handoff locks cover provider dispatch', async () => {
    let commsLocked = false;
    let invoiceLocked = false;
    const lockedTrx = jest.fn(defaultDbImplementation);
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
    mockSendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const verdict = await withProviderHandoff(async () => {
        expect(commsLocked).toBe(true);
        expect(invoiceLocked).toBe(true);
      });
      return verdict.ok ? { sent: true, message: { provider_message_id: 'provider-locked' } } : { sent: false };
    });

    await expect(sendBillingChannelEmail(input({ invoiceId: 'inv-1' }))).resolves.toMatchObject({
      sent: true, providerMessageId: 'provider-locked', deliveryOutcome: 'accepted',
    });
    expect(selfPayAtDispatch).toHaveBeenNthCalledWith(2, 'inv-1', lockedTrx);
    expect(commsLocked).toBe(false);
    expect(invoiceLocked).toBe(false);
  });

  test('blocks when invoice ownership changes before provider dispatch', async () => {
    selfPayAtDispatch
      .mockImplementationOnce(() => async () => ({ ok: true }))
      .mockImplementationOnce(() => async () => ({
        ok: false, code: 'payer_billed', reason: 'Invoice moved to a third-party payer',
      }));

    await expect(sendBillingChannelEmail(input({ invoiceId: 'inv-1' }))).resolves.toMatchObject({
      sent: false, blocked: true, code: 'payer_billed', deliveryOutcome: 'not_sent',
    });
  });

  test('preserves provider acceptance when the surrounding transaction cannot commit', async () => {
    mockWithCustomerCommsLock.mockImplementationOnce(async (database, _customerId, callback) => {
      await callback(database);
      throw new Error('read-only handoff commit failed');
    });

    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: true, providerMessageId: 'provider-1', deliveryOutcome: 'accepted',
    });
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

    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false,
      blocked: true,
      code: 'EMAIL_RECIPIENT_CHANGED',
    });
  });
});
