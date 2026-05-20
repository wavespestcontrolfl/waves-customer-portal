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

const { _private, sendInvoiceEmail } = require('../services/invoice-email');
const db = require('../models/db');
const { buildInvoicePDFBuffer } = require('../services/pdf/invoice-pdf');

const customer = {
  id: 'cust-1',
  first_name: 'Lana',
  last_name: 'Owner',
  email: 'lana@example.com',
  phone: '+15551110000',
};

function query(result) {
  const chain = {
    where: jest.fn(() => chain),
    select: jest.fn(() => chain),
    first: jest.fn(() => Promise.resolve(result)),
    catch: jest.fn((handler) => Promise.resolve(result).catch(handler)),
  };
  return chain;
}

describe('invoice email recipient resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

  test('returns a controlled failure when invoice customer is missing with override', async () => {
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        return query({
          id: 'invoice-1',
          customer_id: 'missing-customer',
          invoice_number: 'INV-1',
          token: 'token-1',
        });
      }
      if (table === 'customers') {
        return query(null);
      }
      return query(null);
    });

    await expect(sendInvoiceEmail('invoice-1', {
      recipientOverride: { email: 'billing@example.com' },
    })).resolves.toEqual({
      ok: false,
      error: 'Customer not found',
    });
    expect(buildInvoicePDFBuffer).not.toHaveBeenCalled();
  });
});
