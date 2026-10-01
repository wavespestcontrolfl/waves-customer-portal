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
// The preference-enforced send rides the shared billing email authority
// (owner ruling 2026-09-27). Its own locks, rechecks and suppression reads are
// pinned in billing-channel-email-authority.test.js and the Postgres suite;
// here it authorizes the billing recipient, and a test overrides it to refuse
// at the first read or at the provider handoff.
jest.mock('../services/billing-channel-email-authority', () => ({
  loadBillingEmailContext: jest.fn(),
  dispatchUnderBillingEmailAuthority: jest.fn(),
}));

const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const BillingEmailAuthority = require('../services/billing-channel-email-authority');
const invoiceHelpers = require('../services/invoice-helpers');
const { getInvoiceEmailRecipients } = require('../services/customer-contact');
const { sendMicrodepositVerificationEmail } = require('../services/microdeposit-verification-email');

function prefsChain(value) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(() => Promise.resolve(value));
  return q;
}

const invoice = { id: 'inv-1', title: 'Quarterly Pest Control', total: '129.00', credit_applied: null };
const customer = { id: 'cust-1', first_name: 'Taylor' };
const authorityInput = {
  customerId: 'cust-1', invoiceId: 'inv-1', channel: 'email',
  metadata: { billingDeliveryCategory: 'payment_issue' },
};

function refuseAtHandoff(boundaryBlock) {
  BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
    state.boundaryBlock = boundaryBlock;
    return { ok: false };
  });
  EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
    await withProviderHandoff(jest.fn());
    return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
  });
}

describe('sendMicrodepositVerificationEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') return prefsChain({});
      throw new Error(`Unexpected db table ${table}`);
    });
    BillingEmailAuthority.loadBillingEmailContext.mockReset().mockResolvedValue({
      category: 'payment_issue',
      recipient: { email: 'billing@example.com', name: 'Taylor Smith' },
      recipientEmail: 'billing@example.com',
    });
    BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockReset()
      .mockImplementation(async ({ dispatch, state }) => {
        state.handoffStarted = true;
        await dispatch('authority-trx');
        state.providerAccepted = true;
        return { ok: true };
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
        billing_url: 'https://portal.wavespestcontrol.com/?tab=billing',
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

  test('an operator send skips the customer\'s choices and rechecks invoice ownership at the handoff', async () => {
    db.mockImplementation((table) => {
      if (table === 'notification_prefs') return prefsChain({ email_enabled: false });
      throw new Error(`Unexpected db table ${table}`);
    });
    const ownership = jest.fn(async () => ({ ok: true }));
    jest.spyOn(invoiceHelpers, 'selfPayAtDispatch').mockReturnValue(ownership);
    const dispatch = jest.fn();
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const handoff = await withProviderHandoff(dispatch);
      return { sent: handoff.ok };
    });

    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: false,
    });

    expect(result.ok).toBe(true);
    expect(invoiceHelpers.selfPayAtDispatch).toHaveBeenCalledWith('inv-1', db);
    expect(ownership).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(BillingEmailAuthority.loadBillingEmailContext).not.toHaveBeenCalled();
    expect(BillingEmailAuthority.dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
  });

  test('an operator send never dispatches once the invoice moved to a third-party payer', async () => {
    jest.spyOn(invoiceHelpers, 'selfPayAtDispatch')
      .mockReturnValue(async () => ({ ok: false, code: 'INVOICE_PAYER_BILLED' }));
    const dispatch = jest.fn();
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      await withProviderHandoff(dispatch);
      return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
    });

    const result = await sendMicrodepositVerificationEmail({ invoice, customer, touchKey: '14d' });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, blocked: false, reason: 'aborted_by_caller_before_dispatch' });
  });

  test('preference-enforced send goes through the shared billing email authority for payment_issue', async () => {
    const dispatch = jest.fn();
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) => {
      const handoff = await withProviderHandoff(dispatch);
      return { sent: handoff.ok };
    });

    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });

    expect(result).toEqual({ ok: true });
    expect(BillingEmailAuthority.loadBillingEmailContext).toHaveBeenCalledWith(authorityInput);
    expect(BillingEmailAuthority.dispatchUnderBillingEmailAuthority).toHaveBeenCalledWith(expect.objectContaining({
      input: authorityInput,
      recipientEmail: 'billing@example.com',
      templateKey: 'payment.microdeposit_verification',
    }));
    expect(dispatch).toHaveBeenCalledWith('authority-trx');
    expect(db).not.toHaveBeenCalled();
  });

  test.each([
    ['NO_EMAIL_RECIPIENT', { ok: false, skipped: true, reason: 'missing_email' }],
    ['INVOICE_PAYER_BILLED', { ok: false, skipped: true, reason: 'invoice_payer_billed' }],
    ['BILLING_PREFERENCES_CHANGED',
      { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'BILLING_PREFERENCES_CHANGED' }],
    ['INVOICE_CUSTOMER_MISMATCH',
      { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'INVOICE_CUSTOMER_MISMATCH' }],
  ])('a %s refusal at the first read sends nothing', async (code, expected) => {
    BillingEmailAuthority.loadBillingEmailContext.mockResolvedValueOnce({ error: { code, reason: code } });

    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });

    expect(result).toEqual(expected);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('an unreadable billing email context holds the send instead of sending blind', async () => {
    BillingEmailAuthority.loadBillingEmailContext.mockRejectedValueOnce(new Error('preferences unavailable'));

    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });

    expect(result).toEqual({
      ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'billing_email_context_unavailable',
    });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test.each([
    ['a staff do-not-contact', { code: 'SUPPRESSED_MANUAL_DNC', reason: 'manual_dnc' },
      { ok: false, blocked: true, reason: 'Suppressed: manual_dnc' }],
    ['a changed recipient', { code: 'EMAIL_RECIPIENT_CHANGED' },
      { ok: false, retryable: true, deliveryOutcome: 'not_sent', reason: 'EMAIL_RECIPIENT_CHANGED' }],
  ])('%s at the provider handoff refuses the dispatch', async (_label, boundaryBlock, expected) => {
    refuseAtHandoff(boundaryBlock);

    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });

    expect(result).toEqual(expected);
  });

  test.each([false, true])(
    'a failure before the provider handoff is definitely not sent (enforced: %s)',
    async (enforceBillingPreference) => {
      EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(new Error('template read unavailable'));
      const result = await sendMicrodepositVerificationEmail({
        invoice, customer, touchKey: '14d', enforceBillingPreference,
      });
      expect(result).toEqual({ ok: false, error: 'template read unavailable', deliveryOutcome: 'not_sent' });
    },
  );

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
      status: 429,
      providerOutcome: { deliveryOutcome: 'uncertain' },
    }));
    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });
    expect(result.deliveryOutcome).toBe('uncertain');
  });

  test.each([false, true])('unknown error after provider handoff remains uncertain (enforced: %s)', async (enforceBillingPreference) => {
    jest.spyOn(invoiceHelpers, 'selfPayAtDispatch').mockReturnValue(async () => ({ ok: true }));
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) =>
      withProviderHandoff(async () => { throw new Error('provider response lost'); }));
    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference,
    });
    expect(result.deliveryOutcome).toBe('uncertain');
  });

  test.each([
    ['rate limit', 429, 'not_sent'], ['timeout', 408, 'uncertain'],
    ['server error', 503, 'uncertain'], ['network error', null, 'uncertain'],
  ])('post-handoff %s has truthful Email delivery outcome', async (_label, status, expected) => {
    EmailTemplateLibrary.sendTemplate.mockImplementationOnce(async ({ withProviderHandoff }) =>
      withProviderHandoff(async () => { throw Object.assign(new Error('SendGrid error'), status ? { status } : {}); }));
    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });
    expect(result.deliveryOutcome).toBe(expected);
  });

  test('provider acceptance evidence survives a later thrown error', async () => {
    EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('audit failed'), {
      providerOutcome: { deliveryOutcome: 'accepted' },
    }));
    const result = await sendMicrodepositVerificationEmail({
      invoice, customer, touchKey: '14d', enforceBillingPreference: true,
    });
    expect(result).toEqual({ ok: true });
  });

  test.each(['EMAIL_TEMPLATE_DISABLED', 'EMAIL_TEMPLATE_UNAVAILABLE'])(
    'reports %s as a definite template refusal', async (code) => {
      EmailTemplateLibrary.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('template unavailable'), { code }));
      const result = await sendMicrodepositVerificationEmail({ invoice, customer, touchKey: '14d' });
      expect(result).toEqual({ ok: false, skipped: true, reason: 'template_unavailable' });
    },
  );
});
