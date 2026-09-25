// Unit test for sendMicrodepositVerificationEmail — the branded email arm of the
// micro-deposit dunning diversion.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', status: 'sent' } })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'billing@example.com', name: 'Taylor Smith' }]),
}));
jest.mock('../services/email-template', () => ({ currency: (v) => `$${Number(v).toFixed(2)}` }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.wavespestcontrol.com' }));

const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const invoiceHelpers = require('../services/invoice-helpers');
const { getInvoiceEmailRecipients } = require('../services/customer-contact');
const { sendMicrodepositVerificationEmail } = require('../services/microdeposit-verification-email');

function prefsChain() {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => ({}));
  q.catch = (cb) => Promise.resolve({}).catch(cb);
  return q;
}

const invoice = { id: 'inv-1', title: 'Quarterly Pest Control', total: '129.00', credit_applied: null };
const customer = { id: 'cust-1', first_name: 'Taylor' };

describe('sendMicrodepositVerificationEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') return prefsChain();
      throw new Error(`Unexpected db table ${table}`);
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test('sends the branded payment.microdeposit_verification template, keyed to the touch', async () => {
    const result = await sendMicrodepositVerificationEmail({ invoice, customer, touchKey: 'd7_reminder' });

    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'payment.microdeposit_verification',
      to: 'billing@example.com',
      suppressionGroupKey: 'transactional_required',
      idempotencyKey: 'microdeposit_verification_email:inv-1:d7_reminder',
      payload: expect.objectContaining({
        first_name: 'Taylor',
        invoice_title: 'Quarterly Pest Control',
        amount_due: '$129.00',
        billing_url: 'https://portal.wavespestcontrol.com/billing',
      }),
    }));
    expect(result.ok).toBe(true);
  });

  test('skips (no send) when there is no deliverable email address', async () => {
    getInvoiceEmailRecipients.mockReturnValueOnce([]);
    const result = await sendMicrodepositVerificationEmail({ invoice, customer, touchKey: '14d' });

    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'missing_email' });
  });

  test('returns ok:false (never throws) when the email send errors', async () => {
    EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(new Error('sendgrid down'));
    const result = await sendMicrodepositVerificationEmail({ invoice, customer, touchKey: '7d' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sendgrid down/);
    expect(result.deliveryOutcome).toBe('uncertain');
  });

  test('early template read failure is definitely not sent when preference-enforced handoff has not begun', async () => {
    EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(new Error('template read unavailable'));
    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });
    expect(result).toEqual({ ok: false, error: 'template read unavailable', deliveryOutcome: 'not_sent' });
  });

  test('in-progress collision stays uncertain even before this caller starts a handoff', async () => {
    EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('in progress'), {
      code: 'EMAIL_SEND_IN_PROGRESS', retryable: true,
    }));
    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });
    expect(result.deliveryOutcome).toBe('uncertain');
  });

  test('structured uncertain outcome wins over an unstarted local handoff', async () => {
    EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('handoff state unknown'), {
      providerOutcome: { deliveryOutcome: 'uncertain' },
    }));
    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });
    expect(result.deliveryOutcome).toBe('uncertain');
  });

  test('unknown error after provider handoff remains uncertain', async () => {
    jest.spyOn(invoiceHelpers, 'selfPayAtDispatch').mockReturnValue(async () => ({ ok: true }));
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) =>
      withProviderHandoff(async () => { throw new Error('provider response lost'); }));
    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });
    expect(result.deliveryOutcome).toBe('uncertain');
  });

  test('provider acceptance evidence survives a later thrown error', async () => {
    EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('audit failed'), {
      providerOutcome: { deliveryOutcome: 'accepted' },
    }));
    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });
    expect(result).toEqual({ ok: true, providerAccepted: true });
  });

  test.each(['EMAIL_TEMPLATE_DISABLED', 'EMAIL_TEMPLATE_UNAVAILABLE'])(
    'reports %s as a definite template refusal', async (code) => {
      EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('template unavailable'), { code }));
      const result = await sendMicrodepositVerificationEmail({ invoice, customer, touchKey: '14d' });
      expect(result).toEqual({ ok: false, skipped: true, reason: 'template_unavailable' });
    },
  );
});
