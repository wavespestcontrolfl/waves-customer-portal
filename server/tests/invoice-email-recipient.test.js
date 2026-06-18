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

const { _private, sendInvoiceEmail, sendReceiptEmail } = require('../services/invoice-email');
const db = require('../models/db');
const { buildInvoicePDFBuffer, buildReceiptPDFBuffer } = require('../services/pdf/invoice-pdf');
const sendgrid = require('../services/sendgrid-mail');
const { shortenOrPassthrough } = require('../services/short-url');
const { sendTemplate } = require('../services/email-template-library');

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
    whereIn: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    select: jest.fn(() => chain),
    first: jest.fn(() => Promise.resolve(result)),
    update: jest.fn(() => Promise.resolve(1)),
    catch: jest.fn((handler) => Promise.resolve(result).catch(handler)),
  };
  return chain;
}

function countQuery(result) {
  const chain = {
    where: jest.fn(() => chain),
    count: jest.fn(() => chain),
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

  test('applies optional pay URL params before shortening invoice email links', async () => {
    buildInvoicePDFBuffer.mockResolvedValue(Buffer.from('pdf'));
    sendgrid.isConfigured.mockReturnValue(false);
    shortenOrPassthrough.mockResolvedValue('https://portal.wavespestcontrol.com/l/inv123');

    db.mockImplementation((table) => {
      if (table === 'invoices') {
        return query({
          id: 'invoice-1',
          customer_id: 'cust-1',
          invoice_number: 'INV-1',
          token: 'token-1',
          total: 249,
          line_items: [],
        });
      }
      if (table === 'customers') {
        return query({ ...customer, id: 'cust-1' });
      }
      if (table === 'notification_prefs') {
        return query({ billing_email: 'billing@example.com', billing_contact_name: 'Billing' });
      }
      if (table === 'invoice_attachments') {
        return countQuery({ count: 0 });
      }
      return query(null);
    });

    await sendInvoiceEmail('invoice-1', {
      payUrlParams: {
        source: 'estimate',
        saveCard: '1',
        billingTerm: 'prepay_annual',
      },
    });

    expect(shortenOrPassthrough).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: 'invoice',
        entityType: 'invoices',
        entityId: 'invoice-1',
        customerId: 'cust-1',
      }),
    );
    const [shortenTarget] = shortenOrPassthrough.mock.calls[0];
    const parsed = new URL(shortenTarget);
    expect(parsed.pathname).toBe('/pay/token-1');
    expect(parsed.searchParams.get('source')).toBe('estimate');
    expect(parsed.searchParams.get('saveCard')).toBe('1');
    expect(parsed.searchParams.get('billingTerm')).toBe('prepay_annual');
  });

  function dbWithPayer(payerRow, { invoiceExtra = {}, prefs = null } = {}) {
    return (table) => {
      if (table === 'invoices') {
        return query({
          id: 'invoice-1', customer_id: 'cust-1', invoice_number: 'INV-1',
          token: 'token-1', total: 300, line_items: [], payer_id: 7, ...invoiceExtra,
        });
      }
      if (table === 'customers') return query({ ...customer, id: 'cust-1' });
      if (table === 'notification_prefs') return query(prefs);
      if (table === 'payers') return query(payerRow);
      if (table === 'invoice_attachments') return countQuery({ count: 0 });
      return query(null);
    };
  }

  test('routes the invoice email to the payer AP inbox when the invoice carries a payer', async () => {
    buildInvoicePDFBuffer.mockResolvedValue(Buffer.from('pdf'));
    sendgrid.isConfigured.mockReturnValue(true);
    sendTemplate.mockResolvedValue({ message: { provider_message_id: 'm1' } });
    shortenOrPassthrough.mockResolvedValue('https://portal.wavespestcontrol.com/l/x');
    // A distinct customer billing email exists — the payer must still win.
    db.mockImplementation(dbWithPayer(
      { id: 7, ap_email: 'ap@westbay.com', company_name: 'Homes by West Bay', active: true },
      { prefs: { billing_email: 'lana-billing@example.com' } },
    ));

    const result = await sendInvoiceEmail('invoice-1');

    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'ap@westbay.com' }));
    expect(result.recipient).toEqual(expect.objectContaining({ email: 'ap@westbay.com', role: 'payer' }));
  });

  test('an explicit operator override still wins over the payer snapshot', async () => {
    buildInvoicePDFBuffer.mockResolvedValue(Buffer.from('pdf'));
    sendgrid.isConfigured.mockReturnValue(true);
    sendTemplate.mockResolvedValue({ message: { provider_message_id: 'm2' } });
    shortenOrPassthrough.mockResolvedValue('https://portal.wavespestcontrol.com/l/x');
    db.mockImplementation(dbWithPayer({ id: 7, ap_email: 'ap@westbay.com', active: true }));

    const result = await sendInvoiceEmail('invoice-1', {
      recipientOverride: { email: 'oneoff@example.com', name: 'One Off' },
    });

    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'oneoff@example.com' }));
    expect(result.recipient).toEqual(expect.objectContaining({ email: 'oneoff@example.com' }));
  });

  test('a payer with no usable AP email does NOT fall back to the homeowner — it fails for operator correction', async () => {
    buildInvoicePDFBuffer.mockResolvedValue(Buffer.from('pdf'));
    sendgrid.isConfigured.mockReturnValue(true);
    sendTemplate.mockResolvedValue({ message: { provider_message_id: 'm3' } });
    shortenOrPassthrough.mockResolvedValue('https://portal.wavespestcontrol.com/l/x');
    db.mockImplementation(dbWithPayer(
      { id: 7, ap_email: '', company_name: 'Homes by West Bay', active: true },
      { prefs: { billing_email: 'ap@example.com', billing_contact_name: 'Accounts Payable' } },
    ));

    const result = await sendInvoiceEmail('invoice-1');

    // Billing the homeowner for a third-party invoice (or exposing the bill)
    // is worse than not sending — the operator must add the payer AP email.
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/AP email/i);
  });

  test('an explicit operator override still sends even when the payer has no AP email', async () => {
    buildInvoicePDFBuffer.mockResolvedValue(Buffer.from('pdf'));
    sendgrid.isConfigured.mockReturnValue(true);
    sendTemplate.mockResolvedValue({ message: { provider_message_id: 'm4' } });
    shortenOrPassthrough.mockResolvedValue('https://portal.wavespestcontrol.com/l/x');
    db.mockImplementation(dbWithPayer(
      { id: 7, ap_email: '', company_name: 'Homes by West Bay', active: true },
    ));

    const result = await sendInvoiceEmail('invoice-1', {
      recipientOverride: { email: 'oneoff@example.com', name: 'One Off' },
    });

    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'oneoff@example.com' }));
    expect(result.recipient).toEqual(expect.objectContaining({ email: 'oneoff@example.com' }));
  });

  test('a blocked/suppressed SendGrid send returns ok:false (not delivered)', async () => {
    buildInvoicePDFBuffer.mockResolvedValue(Buffer.from('pdf'));
    sendgrid.isConfigured.mockReturnValue(true);
    // SendGrid suppression: the template result resolves with sent:false.
    sendTemplate.mockResolvedValue({ sent: false, blocked: true, reason: 'Email suppressed' });
    shortenOrPassthrough.mockResolvedValue('https://portal.wavespestcontrol.com/l/x');
    db.mockImplementation(dbWithPayer({ id: 7, ap_email: 'ap@westbay.com', active: true }));

    const result = await sendInvoiceEmail('invoice-1');

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
  });

  test('a one-off AP recipient is frozen onto the payer snapshot when the payer has no AP email', async () => {
    buildInvoicePDFBuffer.mockResolvedValue(Buffer.from('pdf'));
    sendgrid.isConfigured.mockReturnValue(true);
    sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'm5' } });
    shortenOrPassthrough.mockResolvedValue('https://portal.wavespestcontrol.com/l/x');

    const invoiceUpdate = jest.fn(() => Promise.resolve(1));
    db.mockImplementation((table) => {
      if (table === 'invoices') {
        const chain = {
          where: jest.fn(() => chain),
          first: jest.fn(() => Promise.resolve({
            id: 'invoice-1', customer_id: 'cust-1', invoice_number: 'INV-1',
            token: 'token-1', total: 300, line_items: [], payer_id: 7,
          })),
          update: invoiceUpdate,
          catch: jest.fn((h) => Promise.resolve(null).catch(h)),
        };
        return chain;
      }
      if (table === 'customers') return query({ ...customer, id: 'cust-1' });
      if (table === 'notification_prefs') return query(null);
      if (table === 'payers') return query({ id: 7, ap_email: '', company_name: 'Homes by West Bay', active: true });
      if (table === 'invoice_attachments') return countQuery({ count: 0 });
      return query(null);
    });

    const result = await sendInvoiceEmail('invoice-1', {
      recipientOverride: { email: 'ap-oneoff@westbay.com', name: 'AP' },
    });

    expect(result.ok).toBe(true);
    // The override AP email is persisted into the frozen snapshot for the
    // receipt + pay page to reuse.
    expect(invoiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      payer_snapshot: expect.stringContaining('ap-oneoff@westbay.com'),
    }));
  });

  test('a payer invoice whose payer cannot be attached (inactive live payer, no snapshot) fails closed — never the homeowner', async () => {
    buildInvoicePDFBuffer.mockResolvedValue(Buffer.from('pdf'));
    sendgrid.isConfigured.mockReturnValue(true);
    sendTemplate.mockResolvedValue({ sent: true, message: { provider_message_id: 'x' } });
    shortenOrPassthrough.mockResolvedValue('https://portal.wavespestcontrol.com/l/x');
    // payer_id is set on the invoice, but the live payer is deactivated and there
    // is no snapshot, so attachToInvoice leaves invoice.payer unset.
    db.mockImplementation(dbWithPayer(
      { id: 7, ap_email: 'ap@westbay.com', active: false },
      { prefs: { billing_email: 'homeowner-billing@example.com' } },
    ));

    const result = await sendInvoiceEmail('invoice-1');

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe('receipt email recipient resolution (third-party payer)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildReceiptPDFBuffer.mockResolvedValue(Buffer.from('pdf'));
    sendgrid.isConfigured.mockReturnValue(true);
    sendTemplate.mockResolvedValue({ message: { provider_message_id: 'r1' } });
    shortenOrPassthrough.mockResolvedValue('https://portal.wavespestcontrol.com/l/x');
  });

  function dbForReceipt(payerRow) {
    return (table) => {
      if (table === 'invoices') {
        return query({
          id: 'invoice-1', customer_id: 'cust-1', invoice_number: 'INV-1',
          token: 'token-1', total: 300, line_items: [], status: 'paid',
          paid_at: new Date('2026-06-17T12:00:00Z'),
          card_brand: 'visa', card_last_four: '4242', payer_id: 7,
        });
      }
      if (table === 'customers') return query({ ...customer, id: 'cust-1' });
      if (table === 'notification_prefs') return query(null);
      if (table === 'payers') return query(payerRow);
      if (table === 'payments') return query(null);
      return query(null);
    };
  }

  test('routes the receipt to the payer AP inbox (not the homeowner)', async () => {
    db.mockImplementation(dbForReceipt({ id: 7, ap_email: 'ap@westbay.com', company_name: 'Homes by West Bay', active: true }));

    const result = await sendReceiptEmail('invoice-1');

    expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: 'ap@westbay.com' }));
    expect(result.ok).toBe(true);
  });

  test('a payer with no usable AP email does NOT fall back to the homeowner — would leak the payer card last4', async () => {
    db.mockImplementation(dbForReceipt({ id: 7, ap_email: '', company_name: 'Homes by West Bay', active: true }));

    const result = await sendReceiptEmail('invoice-1');

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('No receipt recipient email');
  });

  test('a payer receipt whose payer cannot be attached (inactive, no snapshot) fails closed — never the homeowner', async () => {
    // payer_id is set, but the live payer is deactivated and there's no snapshot,
    // so attachToInvoice leaves invoice.payer unset — must NOT fall back to the
    // homeowner (would leak the payer's card last4).
    db.mockImplementation(dbForReceipt({ id: 7, ap_email: 'ap@westbay.com', active: false }));

    const result = await sendReceiptEmail('invoice-1');

    expect(sendTemplate).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('No receipt recipient email');
  });
});
