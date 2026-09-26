// Provider-boundary behavior (opt-out, ownership, recipient locking,
// suppression, pre-send checks) lives in billing-channel-email-authority.js
// and is covered by its own test file. This file covers what the adapter
// itself owns: event-key/body validation, SMS-footer stripping, the
// template/idempotency wiring, passing the authority's boundary block or
// context error straight through, and classifying a provider failure by
// deliveryOutcome (using the real sendgrid-mail classifier).
const mockLoadBillingEmailContext = jest.fn();
const mockDispatchUnderBillingEmailAuthority = jest.fn();
jest.mock('../services/billing-channel-email-authority', () => {
  const actual = jest.requireActual('../services/billing-channel-email-authority');
  return {
    ...actual,
    loadBillingEmailContext: (...args) => mockLoadBillingEmailContext(...args),
    dispatchUnderBillingEmailAuthority: (...args) => mockDispatchUnderBillingEmailAuthority(...args),
  };
});

const mockSendTemplate = jest.fn();
const mockRedactEmailAddresses = jest.fn((value) => value);
jest.mock('../services/email-template-library', () => ({
  sendTemplate: (...args) => mockSendTemplate(...args),
  redactEmailAddresses: (...args) => mockRedactEmailAddresses(...args),
}));

const { sendBillingChannelEmail } = require('../services/billing-channel-email');

function baseContext(overrides = {}) {
  return {
    category: 'billing',
    categoryLabel: 'Billing reminder',
    customer: { id: 'cust-1', first_name: 'Casey' },
    prefs: { customer_id: 'cust-1', billing_channels: ['email'] },
    invoice: null,
    recipient: { email: 'casey@example.com', name: 'Casey', role: 'primary' },
    recipientEmail: 'casey@example.com',
    ...overrides,
  };
}

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
    mockLoadBillingEmailContext.mockResolvedValue(baseContext());
    mockDispatchUnderBillingEmailAuthority.mockImplementation(async ({ dispatch, state }) => {
      state.handoffStarted = true;
      await dispatch();
      state.providerAccepted = true;
      return { ok: true };
    });
    mockSendTemplate.mockImplementation(async (opts) => {
      let providerResult = null;
      const verdict = await opts.withProviderHandoff(async () => { providerResult = { messageId: 'provider-1' }; });
      if (verdict?.ok !== true || !providerResult) {
        return { sent: false, aborted: true, reason: 'aborted_before_dispatch' };
      }
      return { sent: true, message: { provider_message_id: providerResult.messageId } };
    });
    mockRedactEmailAddresses.mockImplementation((value) => value);
  });

  test('sends existing notification copy through billing.notice with a stable email key', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    await expect(sendBillingChannelEmail(input(), { preSendCheck })).resolves.toMatchObject({
      sent: true,
      provider: 'email',
      providerMessageId: 'provider-1',
      deliveryOutcome: 'accepted',
    });
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'billing.notice',
      to: 'casey@example.com',
      idempotencyKey: 'billing_channel_email:payment-expiry:pm-1:2026-10:email',
      categories: ['billing', 'billing'],
      suppressionGroupKey: 'transactional_required',
      payload: expect.objectContaining({
        category_label: 'Billing reminder',
        notification_body: input().body,
        first_name: 'Casey',
      }),
      suppressProviderErrorLog: true,
    }));
    expect(mockDispatchUnderBillingEmailAuthority).toHaveBeenCalledWith(expect.objectContaining({
      recipientEmail: 'casey@example.com',
      preSendCheck,
    }));
  });

  test('routes a payment_receipt-category send through billing.receipt_notice', async () => {
    mockLoadBillingEmailContext.mockResolvedValue(baseContext({
      category: 'payment_receipt', categoryLabel: 'Payment receipt',
    }));
    await sendBillingChannelEmail(input({
      metadata: { billingDeliveryCategory: 'payment_receipt', notificationEventKey: 'deposit-receipt:inv-1' },
    }));
    expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'billing.receipt_notice',
    }));
  });

  test.each(['invoice', 'payment_issue', 'billing'])(
    'keeps the %s category on billing.notice',
    async (category) => {
      mockLoadBillingEmailContext.mockResolvedValue(baseContext({ category }));
      await sendBillingChannelEmail(input());
      expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
        templateKey: 'billing.notice',
      }));
    },
  );

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

  test('requires a stable notification event key', async () => {
    await expect(sendBillingChannelEmail(input({ metadata: { billingDeliveryCategory: 'billing' } })))
      .resolves.toMatchObject({ sent: false, blocked: true, code: 'NOTIFICATION_EVENT_KEY_REQUIRED' });
    expect(mockLoadBillingEmailContext).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('requires message content once the SMS opt-out footer is stripped', async () => {
    await expect(sendBillingChannelEmail(input({ body: '  Reply STOP to opt out.  ' })))
      .resolves.toMatchObject({ sent: false, blocked: true, code: 'EMAIL_BODY_REQUIRED' });
    expect(mockLoadBillingEmailContext).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('returns the authority context error without dispatching', async () => {
    // Codex r4 P1 on #4843: the authority now marks this specific code
    // retryable (a channel-selection mismatch can be the mid-dispatch
    // preference-change race) — the adapter forwards it unchanged.
    mockLoadBillingEmailContext.mockResolvedValue({
      error: {
        sent: false, provider: 'email', providerMessageId: null, deliveryOutcome: 'not_sent',
        blocked: true, code: 'BILLING_EMAIL_NOT_SELECTED', reason: 'Email is not selected for this billing category',
        retryable: true,
      },
    });
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, blocked: true, code: 'BILLING_EMAIL_NOT_SELECTED', retryable: true,
    });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('reports a context preparation failure as retryable', async () => {
    mockLoadBillingEmailContext.mockRejectedValue(new Error('connection reset'));
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, blocked: true, code: 'BILLING_EMAIL_PREPARATION_FAILED', retryable: true,
    });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('returns the authority boundary block set during the provider handoff', async () => {
    mockDispatchUnderBillingEmailAuthority.mockImplementation(async ({ state }) => {
      state.boundaryBlock = {
        sent: false, provider: 'email', providerMessageId: null, deliveryOutcome: 'not_sent',
        blocked: true, code: 'EMAIL_SUPPRESSED', reason: 'Suppressed: bounce',
      };
      return { ok: false };
    });
    mockSendTemplate.mockImplementation(async (opts) => {
      const verdict = await opts.withProviderHandoff(async () => {});
      return verdict.ok ? { sent: true, message: {} } : { sent: false, aborted: true };
    });

    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, blocked: true, code: 'EMAIL_SUPPRESSED',
    });
  });

  test('reports an unsuppressed non-send from the template library as EMAIL_NOT_SENT', async () => {
    mockSendTemplate.mockResolvedValue({ sent: false, reason: 'provider rejected the template payload' });
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, blocked: true, code: 'EMAIL_NOT_SENT', reason: 'provider rejected the template payload',
    });
  });

  test.each([
    ['a broken annual-offer guard lookup', { sent: false, aborted: true, guardError: true, reason: 'annual_offer_guard_failed', providerAttempted: false },
      'ANNUAL_OFFER_GUARD_FAILED', true],
    ['a lost lease / refused handoff', { sent: false, aborted: true, reason: 'aborted_before_dispatch' },
      'EMAIL_ABORTED_BEFORE_DISPATCH', true],
    ['a withheld annual offer', { sent: false, blocked: true, reason: 'annual_offer_withheld', providerAttempted: false },
      'ANNUAL_OFFER_WITHHELD', false],
    ['an active suppression', { sent: false, blocked: true, reason: 'Suppressed: bounce' },
      'EMAIL_SUPPRESSED', false],
  ])('classifies %s from the template library as not sent', async (_label, result, code, retryable) => {
    mockSendTemplate.mockResolvedValue(result);
    const outcome = await sendBillingChannelEmail(input());
    expect(outcome).toMatchObject({ sent: false, deliveryOutcome: 'not_sent', code, reason: result.reason });
    expect(outcome.retryable === true).toBe(retryable);
  });

  test('redacts email addresses out of a provider failure reason', async () => {
    mockRedactEmailAddresses.mockImplementation(() => 'contact [redacted] failed');
    mockSendTemplate.mockImplementation(async (opts) => opts.withProviderHandoff(async () => {
      throw Object.assign(new Error('delivery to casey@example.com failed'), { status: 503 });
    }));
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, deliveryOutcome: 'uncertain', reason: 'contact [redacted] failed',
    });
    expect(mockRedactEmailAddresses).toHaveBeenCalledWith('delivery to casey@example.com failed');
  });

  test.each([false, true])('reports uncertainty only after provider handoff started: %s', async (afterHandoff) => {
    mockDispatchUnderBillingEmailAuthority.mockImplementation(async ({ dispatch, state }) => {
      if (!afterHandoff) throw Object.assign(new Error('temporary provider failure'), { retryable: true });
      state.handoffStarted = true;
      await dispatch();
      state.providerAccepted = true;
      return { ok: true };
    });
    mockSendTemplate.mockImplementation(async (opts) => opts.withProviderHandoff(async () => {
      if (afterHandoff) throw Object.assign(new Error('temporary provider failure'), { retryable: true });
    }));
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, deliveryOutcome: afterHandoff ? 'uncertain' : 'not_sent', retryable: true,
    });
  });

  test('classifies a pre-handoff provider failure as not sent', async () => {
    mockDispatchUnderBillingEmailAuthority.mockRejectedValue(new Error('pre-handoff failure'));
    mockSendTemplate.mockImplementation(async (opts) => opts.withProviderHandoff(async () => {}));
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, deliveryOutcome: 'not_sent', retryable: true,
    });
  });

  test('classifies EMAIL_SEND_IN_PROGRESS as not sent even after handoff started', async () => {
    mockSendTemplate.mockImplementation(async (opts) => opts.withProviderHandoff(async () => {
      throw Object.assign(new Error('a send is already in progress for this key'), { code: 'EMAIL_SEND_IN_PROGRESS' });
    }));
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, deliveryOutcome: 'not_sent', retryable: true, code: 'EMAIL_SEND_IN_PROGRESS',
    });
  });

  test('classifies SENDGRID_NOT_CONFIGURED as not sent even after handoff started (no provider request was ever made)', async () => {
    mockSendTemplate.mockImplementation(async (opts) => opts.withProviderHandoff(async () => {
      throw Object.assign(new Error('SENDGRID_API_KEY not configured'), { code: 'SENDGRID_NOT_CONFIGURED' });
    }));
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, deliveryOutcome: 'not_sent', retryable: true, code: 'SENDGRID_NOT_CONFIGURED',
    });
  });

  test.each([400, 401, 403, 404, 405, 413, 415, 422, 429])(
    'classifies a definite SendGrid %s rejection after handoff as not sent',
    async (status) => {
      mockSendTemplate.mockImplementation(async (opts) => opts.withProviderHandoff(async () => {
        throw Object.assign(new Error(`SendGrid ${status}: rejected`), { status });
      }));
      await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
        sent: false, deliveryOutcome: 'not_sent', retryable: true, code: 'EMAIL_PROVIDER_ERROR',
      });
    },
  );

  test.each([
    ['408', { status: 408 }],
    ['other 4xx', { status: 418 }],
    ['5xx', { status: 503 }],
    ['network error', { code: 'ECONNRESET' }],
  ])('keeps a %s failure after handoff uncertain', async (_label, shape) => {
    mockSendTemplate.mockImplementation(async (opts) => opts.withProviderHandoff(async () => {
      throw Object.assign(new Error('provider failure after handoff'), shape);
    }));
    await expect(sendBillingChannelEmail(input())).resolves.toMatchObject({
      sent: false, deliveryOutcome: 'uncertain', retryable: false,
    });
  });
});
