jest.mock('../services/email-template-library', () => ({ readStoredBillingReplayContext: jest.fn() }));
jest.mock('../services/billing-channel-email-authority', () => ({ dispatchUnderBillingEmailAuthority: jest.fn() }));
jest.mock('../services/messaging/billing-email-replay-eligibility', () => ({ billingEmailReplayEligible: jest.fn() }));

const EmailTemplateLibrary = require('../services/email-template-library');
const { dispatchUnderBillingEmailAuthority } = require('../services/billing-channel-email-authority');
const { billingEmailReplayEligible } = require('../services/messaging/billing-email-replay-eligibility');
const {
  isBillingEmailTemplateRetry,
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

// #4843 gate checklist: a billing row whose producer stored no replay
// contract (the monthly payment receipt, say) used to retry on the generic
// path with only a suppression check. It now re-authorizes the identity the
// billing Email adapter wrote on the row, through the same Email authority.
function unregistered(overrides = {}) {
  return message({
    template_key: 'billing.receipt_notice',
    trigger_event_id: 'billing:cust-1:monthly_billing_success:abc',
    idempotency_key: 'billing_channel_email:billing:cust-1:monthly_billing_success:abc:email',
    categories: JSON.stringify(['email_template', 'billing', 'payment_receipt']),
    payload_snapshot: JSON.stringify({ notification_body: 'Payment received' }),
    ...overrides,
  });
}

test('only the billing templates take the billing retry handoff', () => {
  expect(isBillingEmailTemplateRetry(unregistered())).toBe(true);
  expect(isBillingEmailTemplateRetry(message())).toBe(true);
  expect(isBillingEmailTemplateRetry(message({ template_key: 'invoice.sent' }))).toBe(false);
});

test('a row with no stored contract re-authorizes its own customer notice through the Email authority', async () => {
  // The receipt's own kill switch is read on the held transaction (left on).
  const heldDatabase = jest.fn(() => ({ where: () => ({ first: async () => ({ payment_receipt: true }) }) }));
  const dispatch = jest.fn(async () => {});
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    expect(options.input).toEqual({ customerId: 'cust-1', invoiceId: null, channel: 'email', metadata: {
      billingDeliveryCategory: 'payment_receipt', notificationEventKey: 'billing:cust-1:monthly_billing_success:abc' } });
    expect(options.recipientEmail).toBe('casey@example.com');
    expect(options.templateKey).toBe('billing.receipt_notice');
    expect(await options.preSendCheck({ database: heldDatabase, providerBoundary: false })).toEqual({ ok: true });
    await options.dispatch(heldDatabase, async () => ({ ok: true }));
    options.state.providerAccepted = true;
  });
  const row = unregistered();
  expect(isBillingEmailProviderReplay(row)).toBe(false);
  await expect(runBillingEmailProviderReplayHandoff(row, dispatch)).resolves.toEqual({ handled: true, allowed: true });
  expect(dispatch).toHaveBeenCalledWith(heldDatabase, expect.any(Function));
  // No stored contract: no producer eligibility to re-run.
  expect(billingEmailReplayEligible).not.toHaveBeenCalled();
  expect(EmailTemplateLibrary.readStoredBillingReplayContext).not.toHaveBeenCalled();
});

test('an authority refusal (the customer dropped Email since) stops the unregistered retry', async () => {
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    options.state.boundaryBlock = { code: 'BILLING_PREFERENCES_CHANGED', reason: 'Email is not selected for this billing category', retryable: false };
  });
  const dispatch = jest.fn();
  await expect(runBillingEmailProviderReplayHandoff(unregistered(), dispatch)).resolves.toMatchObject({
    handled: true, allowed: false, code: 'BILLING_PREFERENCES_CHANGED',
  });
  expect(dispatch).not.toHaveBeenCalled();
});

test.each([
  ['a non-customer recipient', { recipient_type: 'lead' }],
  ['a notice key that differs from the idempotency key', { idempotency_key: 'billing_channel_email:other-key:email' }],
  ['no notice key', { trigger_event_id: null }],
  ['two notice categories', { categories: JSON.stringify(['billing', 'invoice', 'payment_receipt']) }],
  ['no billing category', { categories: JSON.stringify(['email_template']) }],
  ['a receipt template on a non-receipt category', { categories: JSON.stringify(['email_template', 'billing', 'invoice']) }],
])('an unregistered row with %s is refused before the authority', async (_label, overrides) => {
  const dispatch = jest.fn();
  await expect(runBillingEmailProviderReplayHandoff(unregistered(overrides), dispatch)).resolves.toMatchObject({
    handled: true, allowed: false, terminal: true, code: 'BILLING_RETRY_IDENTITY_INVALID',
  });
  expect(dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});

// Payment receipts sent before billing.receipt_notice existed (migration
// 20260926000100) used billing.notice. Their retries keep working.
test('a pre-migration receipt on billing.notice keeps its retry', async () => {
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    expect(options.input.metadata.billingDeliveryCategory).toBe('payment_receipt');
    expect(options.templateKey).toBe('billing.notice');
    options.state.providerAccepted = true;
  });
  await expect(runBillingEmailProviderReplayHandoff(unregistered({ template_key: 'billing.notice' }), jest.fn()))
    .resolves.toEqual({ handled: true, allowed: true });
});

// A receipt still honors notification_prefs.payment_receipt, read on the
// authority's held transaction, like the first send.
describe('payment receipt kill switch on a retry', () => {
  function prefsDatabase(row, { fails = false } = {}) {
    const first = jest.fn(async () => { if (fails) throw new Error('prefs read failed'); return row; });
    const where = jest.fn(() => ({ first }));
    return Object.assign(jest.fn(() => ({ where })), { where, first });
  }
  async function preSendVerdict(database) {
    let verdict;
    dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
      verdict = await options.preSendCheck({ database, providerBoundary: false });
      if (verdict.ok !== true) options.state.boundaryBlock = verdict;
      else options.state.providerAccepted = true;
    });
    const outcome = await runBillingEmailProviderReplayHandoff(unregistered(), jest.fn());
    return { verdict, outcome };
  }

  test('a customer who turned receipts off gets no retried receipt', async () => {
    const database = prefsDatabase({ payment_receipt: false });
    const { verdict, outcome } = await preSendVerdict(database);
    expect(database).toHaveBeenCalledWith('notification_prefs');
    expect(database.where).toHaveBeenCalledWith({ customer_id: 'cust-1' });
    expect(verdict).toEqual({ ok: false, code: 'BILLING_REPLAY_INELIGIBLE', reason: 'receipt_opted_out', retryable: false });
    expect(outcome).toMatchObject({ handled: true, allowed: false, terminal: true, reason: 'receipt_opted_out' });
  });

  test.each([[{ payment_receipt: true }], [{ payment_receipt: null }], [undefined]])('receipts left on (%j) still retry', async (row) => {
    const { verdict, outcome } = await preSendVerdict(prefsDatabase(row));
    expect(verdict).toEqual({ ok: true });
    expect(outcome).toEqual({ handled: true, allowed: true });
  });

  test('an unreadable receipt setting holds the retry', async () => {
    const { verdict } = await preSendVerdict(prefsDatabase(null, { fails: true }));
    expect(verdict).toEqual({ ok: false, code: 'BILLING_REPLAY_INELIGIBLE', reason: 'receipt-prefs-unavailable', retryable: true });
  });

  test('an autopay notice honors the same switch, like its first send', async () => {
    EmailTemplateLibrary.readStoredBillingReplayContext.mockReturnValue({
      schema_version: 1, customer_id: 'cust-1', category: 'billing', source_entry_point: 'autopay_pre_charge_reminder',
      notificationEventKey: 'precharge:cust-1:2030-06-10', charge_date: '2030-06-10',
    });
    const database = prefsDatabase({ payment_receipt: false });
    let verdict;
    dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
      verdict = await options.preSendCheck({ database, providerBoundary: false });
      options.state.boundaryBlock = verdict;
    });
    await runBillingEmailProviderReplayHandoff(message(), jest.fn());
    expect(verdict).toEqual({ ok: false, code: 'BILLING_REPLAY_INELIGIBLE', reason: 'receipt_opted_out', retryable: false });
    // Refused before the producer's own eligibility runs.
    expect(billingEmailReplayEligible).not.toHaveBeenCalled();
  });

  test('other categories never read the receipt setting', async () => {
    const database = prefsDatabase({ payment_receipt: false });
    dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
      expect(await options.preSendCheck({ database, providerBoundary: false })).toEqual({ ok: true });
      options.state.providerAccepted = true;
    });
    await runBillingEmailProviderReplayHandoff(unregistered({
      template_key: 'billing.notice', categories: JSON.stringify(['email_template', 'billing']),
    }), jest.fn());
    expect(database).not.toHaveBeenCalled();
  });
});

test('a generic billing notice keeps its category', async () => {
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    expect(options.input.metadata.billingDeliveryCategory).toBe('billing');
    options.state.providerAccepted = true;
  });
  await expect(runBillingEmailProviderReplayHandoff(unregistered({
    template_key: 'billing.notice', categories: JSON.stringify(['email_template', 'billing', 'billing']),
  }), jest.fn())).resolves.toEqual({ handled: true, allowed: true });
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
  billingEmailReplayEligible.mockImplementation(async () => { order.push('eligibility'); return { eligible: true }; });
  const dispatch = jest.fn(async (database, providerBoundaryCheck) => {
    expect(database).toBe(heldDatabase);
    order.push('provider-preparation');
    expect(await providerBoundaryCheck({ database })).toEqual({ ok: true });
    order.push('provider-request');
  });
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    expect(options.input).toMatchObject({ customerId: 'cust-1', invoiceId: 'inv-1',
      metadata: { billingDeliveryCategory: 'invoice', notificationEventKey: context.notificationEventKey } });
    expect(options.recipientEmail).toBe('casey@example.com');
    // The retried row's own template decides the suppression recheck.
    expect(options.templateKey).toBe('billing.notice');
    expect(await options.preSendCheck({ database: heldDatabase, providerBoundary: false })).toEqual({ ok: true });
    const providerBoundaryCheck = async ({ database }) => {
      const verdict = await options.preSendCheck({ database, providerBoundary: true });
      if (verdict.ok === true) options.state.handoffStarted = true;
      else options.state.boundaryBlock = verdict;
      return verdict;
    };
    await options.dispatch(heldDatabase, providerBoundaryCheck);
    options.state.providerAccepted = true;
  });

  const stored = message();
  await expect(runBillingEmailProviderReplayHandoff(stored, dispatch))
    .resolves.toEqual({ handled: true, allowed: true });
  expect(EmailTemplateLibrary.readStoredBillingReplayContext).toHaveBeenCalledWith(stored);
  expect(billingEmailReplayEligible).toHaveBeenCalledTimes(2);
  expect(billingEmailReplayEligible).toHaveBeenCalledWith(context, heldDatabase);
  expect(dispatch).toHaveBeenCalledWith(heldDatabase, expect.any(Function));
  expect(order).toEqual(['eligibility', 'provider-preparation', 'eligibility', 'provider-request']);
});

test('keeps original recipient authority while sending a corrected bounce destination at the final boundary', async () => {
  const heldDatabase = jest.fn();
  const correctedCheck = jest.fn(async () => ({ ok: true }));
  const dispatch = jest.fn(async (database, providerBoundaryCheck) => {
    expect(database).toBe(heldDatabase);
    expect(await providerBoundaryCheck({ database })).toEqual({ ok: true });
  });
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    expect(options.recipientEmail).toBe('casey@example.net');
    expect(options.authorityRecipientEmail).toBe('casey@example.com');
    expect(await options.preSendCheck({ database: heldDatabase, providerBoundary: false })).toEqual({ ok: true });
    const providerBoundaryCheck = async ({ database }) => {
      const verdict = await options.preSendCheck({ database, providerBoundary: true });
      options.state.handoffStarted = verdict.ok === true;
      return verdict;
    };
    await options.dispatch(heldDatabase, providerBoundaryCheck);
    options.state.providerAccepted = true;
  });

  await expect(runBillingEmailProviderReplayHandoff(message(), dispatch, {
    recipientEmail: ' Casey@Example.Net ',
    authorityRecipientEmail: ' Casey@Example.Com ',
    providerBoundaryCheck: correctedCheck,
  })).resolves.toEqual({ handled: true, allowed: true });
  expect(billingEmailReplayEligible).toHaveBeenCalledTimes(2);
  expect(correctedCheck).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith(heldDatabase, expect.any(Function));
});

test('a resendable eligibility refusal carries BILLING_REPLAY_RESENDABLE as its code', async () => {
  const { BILLING_REPLAY_RESENDABLE } = require('../services/billing-email-provider-replay');
  billingEmailReplayEligible.mockResolvedValueOnce({
    eligible: false, reason: 'invoice-send-not-finalized', retryable: false, resendable: true,
  });
  let verdict;
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    verdict = await options.preSendCheck({ database: jest.fn() });
  });
  await runBillingEmailProviderReplayHandoff(message(), jest.fn());
  expect(verdict).toEqual({ ok: false, code: BILLING_REPLAY_RESENDABLE, reason: 'invoice-send-not-finalized', retryable: false });
});

test('propagates a provider error for the retry owner to classify', async () => {
  const providerError = new Error('provider outcome unknown');
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    const database = jest.fn();
    await options.dispatch(database, async () => {
      expect(await options.preSendCheck({ database, providerBoundary: true })).toEqual({ ok: true });
      options.state.handoffStarted = true;
      return { ok: true };
    });
  });
  await expect(runBillingEmailProviderReplayHandoff(
    message(), async (database, providerBoundaryCheck) => {
      await providerBoundaryCheck({ database });
      throw providerError;
    },
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

test('fresh rendering is restricted to the previsit producer', async () => {
  billingEmailReplayEligible.mockResolvedValueOnce({ eligible: false, reason: 'balance-reminder-copy-stale' });
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async (options) => {
    options.state.boundaryBlock = await options.preSendCheck({ database: jest.fn() });
  });
  await expect(runBillingEmailProviderReplayHandoff(message(), jest.fn()))
    .resolves.toMatchObject({ code: 'BILLING_REPLAY_INELIGIBLE', terminal: true });
});

function previsitMessage() {
  const stored = { ...context, category: 'billing', source_entry_point: 'previsit_balance_reminder',
    notificationEventKey: 'previsit-balance:visit-1', appointment_id: 'visit-1' };
  EmailTemplateLibrary.readStoredBillingReplayContext.mockReturnValueOnce(stored);
  return message({ trigger_event_id: stored.notificationEventKey,
    idempotency_key: `billing_channel_email:${stored.notificationEventKey}:email`,
    payload_snapshot: { __billing_replay_context: stored } });
}

test.each(['BILLING_PREFERENCES_CHANGED', 'EMAIL_RECIPIENT_CHANGED'])(
  'an unsent previsit authority refusal %s reopens source delivery', async (code) => {
    dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
      state.boundaryBlock = { code, reason: 'Stored authority changed', retryable: true };
    });
    const dispatch = jest.fn();
    await expect(runBillingEmailProviderReplayHandoff(previsitMessage(), dispatch)).resolves.toMatchObject({
      allowed: false, terminal: true, retryable: false, code: 'BILLING_REPLAY_REQUOTE_REQUIRED',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(billingEmailReplayEligible).not.toHaveBeenCalled();
  },
);

test.each(['providerPreparationStarted', 'handoffStarted'])(
  'previsit authority supersession after %s cannot release an uncertain attempt', async (phase) => {
    dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
      state[phase] = true;
      state.boundaryBlock = { code: 'EMAIL_RECIPIENT_CHANGED', retryable: true };
    });
    await expect(runBillingEmailProviderReplayHandoff(previsitMessage(), jest.fn()))
      .resolves.toMatchObject({ allowed: false, code: 'EMAIL_RECIPIENT_CHANGED', retryable: true });
  },
);

test('accepted previsit provider evidence wins over later authority supersession', async () => {
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
    state.providerAccepted = true;
    state.boundaryBlock = { code: 'BILLING_PREFERENCES_CHANGED', retryable: true };
  });
  await expect(runBillingEmailProviderReplayHandoff(previsitMessage(), jest.fn()))
    .resolves.toEqual({ handled: true, allowed: true });
});

test('a transient previsit authority read failure retains its retry', async () => {
  dispatchUnderBillingEmailAuthority.mockImplementationOnce(async ({ state }) => {
    state.boundaryBlock = { code: 'BILLING_EMAIL_RECHECK_FAILED', retryable: true };
  });
  await expect(runBillingEmailProviderReplayHandoff(previsitMessage(), jest.fn()))
    .resolves.toMatchObject({ allowed: false, code: 'BILLING_EMAIL_RECHECK_FAILED', retryable: true });
});
