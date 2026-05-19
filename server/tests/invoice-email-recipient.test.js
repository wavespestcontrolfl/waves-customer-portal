jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/pdf/invoice-pdf', () => ({
  buildInvoicePDFBuffer: jest.fn(),
  buildReceiptPDFBuffer: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(),
  invoiceShortCodePrefix: jest.fn(),
}));

const { _private } = require('../services/invoice-email');

const customer = {
  id: 'cust-1',
  first_name: 'Lana',
  last_name: 'Owner',
  email: 'lana@example.com',
  phone: '+15551110000',
};

describe('invoice email recipient resolution', () => {
  test('uses a valid one-time recipient override ahead of customer billing prefs', () => {
    const result = _private.invoiceRecipientFor(
      customer,
      { billing_email: 'ap@example.com', billing_contact_name: 'Accounts Payable' },
      { email: ' Tenant@Example.com ', name: ' Terry Tenant ' },
    );

    expect(result).toEqual({
      recipient: {
        email: 'tenant@example.com',
        name: 'Terry Tenant',
        role: 'invoice_override',
      },
    });
  });

  test('rejects malformed one-time recipient email', () => {
    expect(_private.invoiceRecipientFor(customer, {}, { email: 'not-an-email' }))
      .toEqual({ error: 'Invalid invoice recipient email' });
  });

  test('falls back to the configured billing recipient without override', () => {
    const result = _private.invoiceRecipientFor(
      customer,
      { billing_email: 'ap@example.com', billing_contact_name: 'Accounts Payable' },
      null,
    );

    expect(result.recipient).toEqual(expect.objectContaining({
      email: 'ap@example.com',
      name: 'Accounts Payable',
      role: 'billing_contact',
    }));
  });
});
