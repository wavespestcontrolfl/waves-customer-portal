// invoice-followups (the per-invoice sequence, the PRIMARY dunner): when an
// invoice is blocked on ACH micro-deposit verification, fireStep swaps the touch
// to the verification re-nudge (SMS-only) and still advances the cadence, instead
// of sending the generic "amount due" dunning + email.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({
  isInvoiceAwaitingMicrodepositVerification: jest.fn(async () => true),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (templateKey) => `sms body for ${templateKey}`),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/pay123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false })),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => ({ applied: 0 })),
  reverseAppliedCredit: jest.fn(async () => undefined),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'generic followup body'),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/customer-contact', () => ({ getInvoiceEmailRecipients: jest.fn(() => []) }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn(async () => false) }));
jest.mock('../services/email-template', () => ({ currency: jest.fn((v) => `$${v}`) }));

const db = require('../models/db');
const StripeService = require('../services/stripe');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const smsTemplatesRouter = require('../routes/admin-sms-templates');
const EmailTemplateLibrary = require('../services/email-template-library');
const InvoiceFollowUps = require('../services/invoice-followups');

function chain({ result = [], first, updateResult = 1 } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereRaw', 'andWhere', 'orWhere', 'join', 'limit', 'select', 'returning']
    .forEach((m) => { q[m] = jest.fn((arg) => { if (typeof arg === 'function') arg.call(q); return q; }); });
  q.first = jest.fn(async () => first);
  q.insert = jest.fn(async () => undefined);
  q.update = jest.fn(async () => updateResult);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

const row = {
  id: 'seq-1',
  invoice_id: 'inv-1',
  customer_id: 'cust-1',
  step_index: 0,
  touches_sent: 0,
  token: 'token-1',
  title: 'Quarterly Pest Control',
  total: '129.00',
  credit_applied: null,
  invoice_status: 'viewed',
  invoice_payer_id: null,
  invoice_stripe_pi: 'pi_microdeposit',
  service_date: '2026-05-01',
  due_date: '2026-05-10',
  invoice_number: 'WPC-2026-1042',
  invoice_sent_at: '2026-05-01T12:00:00.000Z',
  invoice_sms_sent_at: null,
  invoice_created_at: '2026-05-01T12:00:00.000Z',
};
const customer = { id: 'cust-1', first_name: 'Taylor', phone: '+19415550101' };

describe('invoice-followups micro-deposit diversion', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z')); // a Tuesday (in send window)
    jest.clearAllMocks();
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(true);
  });
  afterEach(() => jest.useRealTimers());

  test('swaps the touch to the verification re-nudge (SMS-only) and advances the sequence', async () => {
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [row] })],
      customers: [chain({ first: customer })],
      invoices: [chain({ first: { total: '129.00', credit_applied: null, status: 'viewed' } })],
      invoice_followup_sequences: [chain({ updateResult: 1 })], // the cadence advance
      customer_interactions: [chain()],
    });

    const result = await InvoiceFollowUps.runPending();

    // Verification copy was sent, NOT the generic step template (resolveBody).
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'bank_verification_incomplete',
      expect.objectContaining({ first_name: 'Taylor' }),
      expect.objectContaining({ workflow: 'microdeposit_verification_reminder' }),
    );
    expect(smsTemplatesRouter.getTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      body: 'sms body for bank_verification_incomplete',
    }));
    // SMS-only — the generic "amount due" follow-up email is skipped.
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    // The touch still counted (cadence advanced), so the re-nudge repeats on schedule.
    expect(result.sent).toBe(1);
  });

  test('non-micro-deposit invoice keeps the generic follow-up (no diversion)', async () => {
    StripeService.isInvoiceAwaitingMicrodepositVerification.mockResolvedValue(false);
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [row] })],
      customers: [chain({ first: customer })],
      invoices: [
        chain({ first: { total: '129.00', credit_applied: null, status: 'viewed' } }), // credit re-read
        chain({ first: { id: 'inv-1', status: 'viewed', title: 'Quarterly Pest Control', total: '129.00', credit_applied: null, due_date: '2026-05-10', service_date: '2026-05-01', invoice_number: 'WPC-2026-1042' } }), // sendFollowupEmail re-read
      ],
      notification_prefs: [chain({ first: {} })],
      invoice_followup_sequences: [chain({ updateResult: 1 })],
      customer_interactions: [chain()],
    });

    await InvoiceFollowUps.runPending();

    // Generic step template (resolveBody → getTemplate), not the verification copy.
    expect(smsTemplatesRouter.getTemplate).toHaveBeenCalledWith(
      'invoice_followup_3day',
      expect.anything(),
      expect.anything(),
    );
    expect(renderSmsTemplate).not.toHaveBeenCalledWith('bank_verification_incomplete', expect.anything(), expect.anything());
  });
});
