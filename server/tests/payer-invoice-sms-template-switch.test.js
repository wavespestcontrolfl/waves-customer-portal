/**
 * The payer's pay-link text honors the EXISTING invoice SMS template kill switch (admin SMS Templates, row invoice_sent): message
 * type payer_invoice maps to it in MSG_TYPE_TO_TEMPLATE, so disabling the homeowner invoice text disables this one. A disabled
 * template reaches no provider send.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn(async () => true) };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'portal.wavespestcontrol.com/l/x'),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../services/billing-email-details', () => ({
  invoicePropertyAddress: jest.fn(async () => '123 Palm Ave, Bradenton, FL'),
  invoiceServiceDetails: jest.fn(async () => ({ label: '' })),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const db = require('../models/db');
const templates = require('../routes/admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { sendPayerInvoiceText } = require('../services/payer-invoice-sms');

let smsTemplates;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_PAYER_INVOICE_SMS = 'true';
  smsTemplates = {};
  const rows = {
    invoices: { id: 'inv-1', customer_id: 'cust-1', payer_id: 7, payer_statement_id: null, status: 'sending', total: '150.00', credit_applied: 0, amount_paid: 0, token: 'tok', service_type: 'Lawn Care', scheduled_send_error: null },
    payers: { id: 7, display_name: 'Pat Rowe', ap_phone: '(941) 555-0123', active: true },
    customers: { id: 'cust-1', first_name: 'Sam', phone: '+19415550111' },
  };
  db.mockImplementation((table) => {
    const q = {};
    let key;
    q.where = (arg) => { key = arg && arg.template_key; return q; };
    q.first = async () => (table === 'sms_templates' ? smsTemplates[key] : rows[table]);
    q.whereRaw = () => q;
    q.update = async () => 1;
    return q;
  });
});
afterAll(() => { delete process.env.GATE_PAYER_INVOICE_SMS; });

describe('isTemplateActive for the payer text\'s message type', () => {
  test('is the invoice_sent row: active with no row, active when enabled, off when the invoice text is disabled', async () => {
    await expect(templates.isTemplateActive('payer_invoice')).resolves.toBe(true);
    smsTemplates.invoice_sent = { template_key: 'invoice_sent', is_active: true };
    await expect(templates.isTemplateActive('payer_invoice')).resolves.toBe(true);
    smsTemplates.invoice_sent = { template_key: 'invoice_sent', is_active: false };
    await expect(templates.isTemplateActive('payer_invoice')).resolves.toBe(false);
    // Same switch the homeowner invoice text reads.
    await expect(templates.isTemplateActive('invoice')).resolves.toBe(false);
  });

  test('a row named payer_invoice is not what decides it', async () => {
    smsTemplates.payer_invoice = { template_key: 'payer_invoice', is_active: false };
    await expect(templates.isTemplateActive('payer_invoice')).resolves.toBe(true);
  });
});

describe('sendPayerInvoiceText when the invoice template is disabled', () => {
  test('a switched-off template is reported as not sent, never as a sent text', async () => {
    // What twilio.js returns for a disabled template, as the provider adapter maps it: sent:true, deliveryOutcome 'not_sent'.
    sendCustomerMessage.mockResolvedValue({ sent: true, provider: 'twilio', deliveryOutcome: 'not_sent', providerMessageId: 'template-disabled', raw: { templateDisabled: true } });
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' }))
      .resolves.toMatchObject({ sent: false, code: 'template_disabled' });
  });

  test('twilio.js\'s gate (modeled on the real isTemplateActive): a disabled template makes no Twilio request', async () => {
    smsTemplates.invoice_sent = { template_key: 'invoice_sent', is_active: false };
    const create = jest.fn();
    // twilio.js sendSMS asks isTemplateActive(options.messageType) before any Twilio request; model that gate with the real function.
    sendCustomerMessage.mockImplementation(async (input) => {
      const messageType = input.metadata.original_message_type;
      if (!(await templates.isTemplateActive(messageType))) {
        return { sent: true, provider: 'twilio', deliveryOutcome: 'not_sent', providerMessageId: 'template-disabled', raw: { templateDisabled: true } };
      }
      create();
      return { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}` };
    });
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-1' })).resolves.toMatchObject({ sent: false, code: 'template_disabled' });
    expect(create).not.toHaveBeenCalled();
    smsTemplates.invoice_sent.is_active = true;
    await expect(sendPayerInvoiceText({ invoiceId: 'inv-1', emailMessageId: 'em-2' })).resolves.toMatchObject({ sent: true });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
