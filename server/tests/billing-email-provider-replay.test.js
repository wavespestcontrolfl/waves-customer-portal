jest.mock('../services/email-template-library', () => ({ readStoredBillingReplayContext: jest.fn() }));
jest.mock('../services/billing-channel-email-authority', () => ({ dispatchUnderBillingEmailAuthority: jest.fn() }));
jest.mock('../services/messaging/billing-email-replay-eligibility', () => ({ billingEmailReplayEligible: jest.fn() }));

const EmailTemplateLibrary = require('../services/email-template-library');
const { dispatchUnderBillingEmailAuthority } = require('../services/billing-channel-email-authority');
const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');
const {
  isBillingEmailProviderReplay,
  runBillingEmailProviderReplayHandoff,
} = require('../services/billing-email-provider-replay');

const context = {
  schema_version: 1,
  customer_id: 'cust-1',
  invoice_id: 'inv-1',
  category: 'invoice',
  source_entry_point: 'invoice_followup_sequence',
  notificationEventKey: 'invoice-followup:seq-1:day-3',
  followup_sequence_id: 'seq-1',
  rendered_amount: '128.00',
  collections_ledger_id: 'ledger-1',
};

function message(overrides = {}) {
  return {
    template_key: 'billing.notice',
    recipient_type: 'customer',
    recipient_id: 'cust-1',
    recipient_email_snapshot: 'casey@example.com',
    trigger_event_id: context.notificationEventKey,
    idempotency_key: `billing_channel_email:${context.notificationEventKey}:email`,
    categories: JSON.stringify(['email_template', 'billing', 'invoice']),
    payload_snapshot: JSON.stringify({ first_name: 'Casey', __billing_replay_context: context }),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  EmailTemplateLibrary.readStoredBillingReplayContext.mockReturnValue(context);
  billingEmailReplayEligible.mockResolvedValue({ eligible: true });
});

test('recognizes a stored replay contract only on the canonical billing templates', () => {
  expect(isBillingEmailProviderReplay(message())).toBe(true);
  expect(isBillingEmailProviderReplay(message({ template_key: 'billing.receipt_notice' }))).toBe(true);
  expect(isBillingEmailProviderReplay(message({ template_key: 'invoice.sent' }))).toBe(false);
});

test.each(['billing.notice', 'billing.receipt_notice'])('contextless %s retains the existing provider retry path', async (templateKey) => {
  const legacy = message({ template_key: templateKey, payload_snapshot: JSON.stringify({ notification_body: 'Payment received' }) });
  expect(isBillingEmailProviderReplay(legacy)).toBe(false);
  await expect(runBillingEmailProviderReplayHandoff(legacy, jest.fn())).resolves.toEqual({ handled: false });
  expect(dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
  expect(EmailTemplateLibrary.readStoredBillingReplayContext).not.toHaveBeenCalled();
});

test.each([null, {}, 'bad-context'])('a present invalid contract %j cannot fall back to an unguarded replay', async (stored) => {
  const invalid = message({ payload_snapshot: { __billing_replay_context: stored } });
  EmailTemplateLibrary.readStoredBillingReplayContext.mockReturnValueOnce(null);
  expect(isBillingEmailProviderReplay(invalid)).toBe(true);
  await expect(runBillingEmailProviderReplayHandoff(invalid, jest.fn())).resolves.toMatchObject({
    handled: true, terminal: true, code: 'BILLING_REPLAY_CONTEXT_INVALID',
  });
});

test('runs eligibility and provider dispatch on the held authority database', async () => {
  const heldDatabase = jest.fn();
  const order = [];
  billingEmailReplayEligible.mockImplementationOnce(async () => { order.push('eligibility'); return { eligible: true }; });
  const dispatch = jest.fn(async () => { order.push('dispatch'); });
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    expect(options.input).toMatchObject({ customerId: 'cust-1', invoiceId: 'inv-1',
      metadata: { billingDeliveryCategory: 'invoice', notificationEventKey: context.notificationEventKey } });
    expect(options.recipientEmail).toBe('casey@example.com');
    expect(await options.preSendCheck({ database: heldDatabase })).toEqual({ ok: true });
    options.state.handoffStarted = true;
    await options.dispatch(heldDatabase);
    options.state.providerAccepted = true;
  });

  const stored = message();
  await expect(runBillingEmailProviderReplayHandoff(stored, dispatch))
    .resolves.toEqual({ handled: true, allowed: true });
  expect(EmailTemplateLibrary.readStoredBillingReplayContext).toHaveBeenCalledWith(stored);
  expect(billingEmailReplayEligible).toHaveBeenCalledWith(context, heldDatabase);
  expect(dispatch).toHaveBeenCalledWith(heldDatabase);
  expect(order).toEqual(['eligibility', 'dispatch']);
});

test('propagates a provider error for the retry owner to classify', async () => {
  const providerError = new Error('provider outcome unknown');
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    expect(await options.preSendCheck({ database: jest.fn() })).toEqual({ ok: true });
    options.state.handoffStarted = true;
    await options.dispatch(jest.fn());
  });
  await expect(runBillingEmailProviderReplayHandoff(
    message(), async () => { throw providerError; },
  )).rejects.toBe(providerError);
});

test('treats an authority return without refusal or acceptance as temporary', async () => {
  dispatchUnderBillingEmailAuthority.mockResolvedValueOnce(undefined);
  await expect(runBillingEmailProviderReplayHandoff(message(), jest.fn())).resolves.toMatchObject({
    handled: true, allowed: false, retryable: true, terminal: false,
    code: 'BILLING_REPLAY_RECHECK_FAILED',
  });
});

test.each([
  [{ eligible: false, reason: 'sequence-stopped', retryable: false }, false],
  [{ eligible: false, reason: 'billing-email-eligibility-unavailable', retryable: true }, true],
])('classifies locked boundary refusals without dispatching', async (verdict, retryable) => {
  const dispatch = jest.fn();
  billingEmailReplayEligible.mockResolvedValueOnce(verdict);
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    const checked = await options.preSendCheck({ database: jest.fn() });
    options.state.boundaryBlock = checked;
    return { ok: false };
  });

  await expect(runBillingEmailProviderReplayHandoff(message(), dispatch)).resolves.toMatchObject({
    handled: true, allowed: false, retryable, terminal: !retryable,
    code: 'BILLING_REPLAY_INELIGIBLE', reason: verdict.reason,
  });
  expect(dispatch).not.toHaveBeenCalled();
});

test('rejects a missing or mismatched stored context terminally before authority', async () => {
  EmailTemplateLibrary.readStoredBillingReplayContext.mockReturnValueOnce(null);
  await expect(runBillingEmailProviderReplayHandoff(message(), jest.fn())).resolves.toMatchObject({
    handled: true, allowed: false, retryable: false, terminal: true,
    code: 'BILLING_REPLAY_CONTEXT_INVALID',
  });
  expect(dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
});
