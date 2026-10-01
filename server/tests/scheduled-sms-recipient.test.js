/**
 * Scheduled-SMS recipient resolution.
 *
 * Rows queued with refresh_customer_phone (deposit-receipt quiet-hold
 * retries) must re-read the customer's CURRENT phone at send time — the cron
 * asserts phone_matches_customer for customer rows, and that trust can't ride
 * a number frozen hours earlier that the customer may have since changed.
 */

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  logGateStatus: jest.fn(),
}));

const db = require('../models/db');
const {
  resolveScheduledRecipient,
  canReplayBillingWithoutPhone,
  scheduledDepositReceiptAllowed,
  classifyDepositReplayFallback,
} = require('../services/scheduler');

// Every entry point except invoice_send_deferred registers no invoice handoff.
const noInvoiceHandoffs = { deferredProviderHandoff: () => undefined, deferredBillingEmailPreSendCheck: () => undefined };

test.each([false, true])('scheduled replay uses trusted row identities and registered dispatch: %s', async (registered) => {
  // Exercise the actual dispatch block without starting cron jobs or importing
  // live integrations. A forged descriptor must not override its claimed row.
  const source = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
  const start = source.indexOf('const sendReplay = () => {');
  const end = source.indexOf('if (smsResult.scheduledHold) continue;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const sendCustomerMessage = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
  const refusal = { sent: false, deliveryOutcome: 'not_sent', retryable: true };
  const dispatchDeferredReplay = jest.fn(async (_entry, _meta, fallback) => registered ? refusal : fallback());
  const dispatchScheduledSms = jest.fn(async (_msg, _meta, send) => send());
  const result = await require('vm').runInNewContext(`(async () => { ${source.slice(start, end)} return smsResult; })()`, {
    msg: { id: 'queue-row', customer_id: 'row-customer', message_body: 'Current queued copy' },
    claimMeta: { entry_point: 'fixture', scheduled_sms_log_id: 'forged-row', customer_id: 'forged-customer' },
    toPhone: 'fixture-phone', purpose: 'appointment', replayConsentBasis: undefined,
    sendCustomerMessage,
    dispatchScheduledSms,
    SCHEDULED_SMS_MAX_ATTEMPTS: 3,
    require: () => ({ ...noInvoiceHandoffs, deferredSmsHandoff: () => undefined, deferredProviderPreSendCheck: () => undefined, dispatchDeferredReplay }),
  });
  expect(dispatchScheduledSms).toHaveBeenCalledWith(expect.objectContaining({ id: 'queue-row' }),
    expect.objectContaining({ entry_point: 'fixture' }), expect.any(Function), 'appointment', 3);
  expect(dispatchDeferredReplay).toHaveBeenCalledWith('fixture', expect.objectContaining({
    scheduled_sms_log_id: 'queue-row', customer_id: 'row-customer',
  }), expect.any(Function));
  if (registered) {
    expect(result).toBe(refusal);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  } else {
    expect(result).toMatchObject({ sent: true });
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      body: 'Current queued copy', to: 'fixture-phone', customerId: 'row-customer', entryPoint: 'scheduled_sms_cron',
    }));
  }
});

test('a replay carries its entry\'s provider-boundary predicate into the send (the voicemail quote link\'s holds)', async () => {
  const source = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
  const start = source.indexOf('const sendReplay = () => {');
  const end = source.indexOf('if (smsResult.scheduledHold) continue;', start);
  const sendCustomerMessage = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
  const boundaryCheck = jest.fn();
  const deferredProviderPreSendCheck = jest.fn(() => boundaryCheck);
  await require('vm').runInNewContext(`(async () => { ${source.slice(start, end)} return smsResult; })()`, {
    msg: { id: 'queue-row', customer_id: null, to_phone: '+19415550101', message_body: 'Quote link', message_type: 'voicemail_quote_link' },
    claimMeta: { entry_point: 'voicemail_lead_sms_deferred', lead_id: 'lead-1', voicemail_phone: '+19415550101' },
    toPhone: '+19415550101', purpose: 'missed_call_followup', replayConsentBasis: undefined,
    sendCustomerMessage,
    dispatchScheduledSms: jest.fn(async (_msg, _meta, send) => send()),
    SCHEDULED_SMS_MAX_ATTEMPTS: 3,
    require: () => ({ ...noInvoiceHandoffs, deferredSmsHandoff: () => undefined, deferredProviderPreSendCheck, dispatchDeferredReplay: (_e, _m, fallback) => fallback() }),
  });
  expect(deferredProviderPreSendCheck).toHaveBeenCalledWith('voicemail_lead_sms_deferred', expect.objectContaining({
    lead_id: 'lead-1', voicemail_phone: '+19415550101', to_phone: '+19415550101',
  }));
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ providerPreSendCheck: boundaryCheck, entryPoint: 'scheduled_sms_cron' }));
  // Owner ruling 2026-09-28: an already-queued deferred voicemail text goes
  // out on the very next replay instead of waiting for the 8am-8pm window —
  // this entry point is used for nothing else, so the replay marks it
  // customer-initiated (checkSendWindow's CUSTOMER_ACTION_ENTRY_POINTS
  // escape hatch) unconditionally.
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ customerInitiated: true }));
});

test('a deferred billing notice replays with its delivery category and Email-sidecar marker', async () => {
  const source = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
  const start = source.indexOf('const sendReplay = () => {');
  const end = source.indexOf('if (smsResult.scheduledHold) continue;', start);
  const sendCustomerMessage = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
  await require('vm').runInNewContext(`(async () => { ${source.slice(start, end)} return smsResult; })()`, {
    msg: { id: 'queue-row', customer_id: 'cust-1', message_body: 'Payment problem', message_type: 'payment_failed' },
    claimMeta: { entry_point: 'stripe_webhook_billing_deferred', billingDeliveryCategory: 'payment_issue',
      hasEmailLeg: true, notificationEventKey: 'payment-problem:attempt:pay-2:payment_failed', invoice_id: 'inv-1' },
    toPhone: '+19415550101', purpose: 'payment_failure', replayConsentBasis: undefined,
    sendCustomerMessage,
    dispatchScheduledSms: jest.fn(async (_msg, _meta, send) => send()),
    SCHEDULED_SMS_MAX_ATTEMPTS: 3,
    Array,
    require: () => ({ ...noInvoiceHandoffs, deferredSmsHandoff: () => undefined, deferredProviderPreSendCheck: () => undefined, dispatchDeferredReplay: (_e, _m, fallback) => fallback() }),
  });
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
    hasEmailLeg: true, invoiceId: 'inv-1',
    metadata: expect.objectContaining({
      billingDeliveryCategory: 'payment_issue', notificationEventKey: 'payment-problem:attempt:pay-2:payment_failed',
    }),
  }));
});

test('a composer-queued text replays with its linked visits so the street-level hold is re-checked at DELIVERY (a clear visit that became a hold after the enqueue)', async () => {
  const source = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
  const start = source.indexOf('const sendReplay = () => {');
  const end = source.indexOf('if (smsResult.scheduledHold) continue;', start);
  const run = async (claimMeta) => {
    const sendCustomerMessage = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
    await require('vm').runInNewContext(`(async () => { ${source.slice(start, end)} return smsResult; })()`, {
      msg: { id: 'queue-row', customer_id: 'cust-1', message_body: 'Your reschedule link', message_type: 'manual', admin_user_id: 'admin-1' },
      claimMeta,
      toPhone: '+19415550101', purpose: 'conversational', replayConsentBasis: undefined,
      sendCustomerMessage,
      dispatchScheduledSms: jest.fn(async (_msg, _meta, send) => send()),
      SCHEDULED_SMS_MAX_ATTEMPTS: 3,
      Array,
      require: () => ({ ...noInvoiceHandoffs, deferredSmsHandoff: () => undefined, deferredProviderPreSendCheck: () => undefined, dispatchDeferredReplay: (_e, _m, fallback) => fallback() }),
    });
    return sendCustomerMessage.mock.calls[0][0];
  };
  const withLinks = await run({ human_authored: true, linked_scheduled_service_ids: ['3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c'] });
  expect(withLinks.metadata.linked_scheduled_service_ids).toEqual(['3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c']);
  // Every other queued row replays exactly as before: no key at all.
  expect((await run({ human_authored: true })).metadata).not.toHaveProperty('linked_scheduled_service_ids');
});

test('a queued invoice notice replays with the registry\'s invoice handoffs, bound to its own row', async () => {
  const source = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
  const start = source.indexOf('const sendReplay = () => {');
  const end = source.indexOf('if (smsResult.scheduledHold) continue;', start);
  const sendCustomerMessage = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
  const providerHandoff = jest.fn();
  const emailCheck = jest.fn();
  const deferredProviderHandoff = jest.fn(() => providerHandoff);
  const deferredBillingEmailPreSendCheck = jest.fn(() => emailCheck);
  await require('vm').runInNewContext(`(async () => { ${source.slice(start, end)} return smsResult; })()`, {
    msg: { id: 'queue-row', customer_id: 'cust-1', to_phone: '+19415550101', message_body: 'Your invoice', message_type: 'invoice' },
    claimMeta: { entry_point: 'invoice_send_deferred', invoice_id: 'inv-1', customer_id: 'forged-customer',
      billingDeliveryCategory: 'invoice', notificationEventKey: 'invoice:inv-1:sent' },
    toPhone: '+19415550101', purpose: 'payment_link', replayConsentBasis: undefined,
    sendCustomerMessage,
    dispatchScheduledSms: jest.fn(async (_msg, _meta, send) => send()),
    SCHEDULED_SMS_MAX_ATTEMPTS: 3,
    require: () => ({ deferredSmsHandoff: () => undefined, deferredProviderHandoff, deferredBillingEmailPreSendCheck,
      deferredProviderPreSendCheck: () => undefined, dispatchDeferredReplay: (_e, _m, fallback) => fallback() }),
  });
  const rowMeta = expect.objectContaining({ invoice_id: 'inv-1', customer_id: 'cust-1', to_phone: '+19415550101' });
  expect(deferredProviderHandoff).toHaveBeenCalledWith('invoice_send_deferred', rowMeta);
  expect(deferredBillingEmailPreSendCheck).toHaveBeenCalledWith('invoice_send_deferred', rowMeta);
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
    entryPoint: 'scheduled_sms_cron', purpose: 'payment_link', invoiceId: 'inv-1',
    withProviderHandoff: providerHandoff, billingEmailPreSendCheck: emailCheck,
    metadata: expect.objectContaining({ original_entry_point: 'invoice_send_deferred' }),
  }));
});

test('scheduled completion sends the body after the review guard strips its bundled ask', async () => {
  const source = require('fs').readFileSync(require.resolve('../services/scheduler'), 'utf8');
  const start = source.indexOf('const sendReplay = () => {');
  const end = source.indexOf('if (smsResult.scheduledHold) continue;', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const completion = 'Receipt: https://portal.test/receipt/xyz';
  const sendCustomerMessage = jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted' }));
  const dispatchDeferredReplay = jest.fn(async (_entry, _meta, fallback) => fallback());
  const dispatchScheduledSms = jest.fn(async (msg, meta, send) => {
    // dispatchScheduledSms persists this rewrite before invoking send.
    msg.message_body = completion;
    delete meta.bundled_review_request_id;
    return send();
  });
  await require('vm').runInNewContext(`(async () => { ${source.slice(start, end)} return smsResult; })()`, {
    msg: { id: 'queue-row', customer_id: 'customer-1', message_body: completion
      + '\n\nEnjoyed the service? A quick review means the world: https://portal.test/rate/ask' },
    claimMeta: { entry_point: 'dispatch_completion_deferred', bundled_review_request_id: 'review-1' },
    toPhone: 'fixture-phone', purpose: 'service_complete', replayConsentBasis: undefined,
    sendCustomerMessage, dispatchScheduledSms, SCHEDULED_SMS_MAX_ATTEMPTS: 3,
    require: () => ({ ...noInvoiceHandoffs, deferredSmsHandoff: () => undefined, deferredProviderPreSendCheck: () => undefined, dispatchDeferredReplay }),
  });
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
    body: completion,
    metadata: expect.objectContaining({ bundled_review_request_id: undefined }),
  }));
  expect(dispatchDeferredReplay).toHaveBeenCalledWith('dispatch_completion_deferred',
    expect.objectContaining({ scheduled_sms_log_id: 'queue-row' }), expect.any(Function));
  expect(dispatchDeferredReplay.mock.calls[0][1]).not.toHaveProperty('bundled_review_request_id');
});

function mockCustomerLookup(row) {
  db.mockImplementation((table) => {
    if (table !== 'customers') throw new Error(`unexpected table: ${table}`);
    return { where: () => ({ first: async () => row }) };
  });
}

function mockPrefsLookup(row) {
  db.mockImplementation((table) => {
    if (table !== 'notification_prefs') throw new Error(`unexpected table: ${table}`);
    return { where: () => ({ first: async () => row }) };
  });
}

describe('resolveScheduledRecipient', () => {
  afterEach(() => db.mockReset());

  test('refreshes to the customer\'s current phone when flagged', async () => {
    mockCustomerLookup({ phone: '(941) 555-0222' });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      { refresh_customer_phone: true },
    )).resolves.toBe('(941) 555-0222');
  });

  test('keeps the queued number without the flag — ordinary scheduled sends are untouched', async () => {
    db.mockImplementation(() => { throw new Error('must not query'); });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      {},
    )).resolves.toBe('(941) 555-0100');
  });

  test('unverified rows (r24): send only when the LIVE account phone still matches the snapshot', async () => {
    // Enqueue-time identity lookup failed, so the refresh-vs-freeze
    // decision was deferred here. Live match → refresh semantics.
    mockCustomerLookup({ phone: '+1 (941) 555-0100' });
    await expect(resolveScheduledRecipient(
      { to_phone: '9415550100', customer_id: 'cust-1' },
      { recipient_identity_unverified: true },
    )).resolves.toBe('+1 (941) 555-0100');

    // Live mismatch is ambiguous (changed phone vs intentional alternate)
    // — null puts the row on the bounded-retry-then-terminal rail instead
    // of guessing where a bearer link should go.
    mockCustomerLookup({ phone: '(941) 555-0999' });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      { recipient_identity_unverified: true },
    )).resolves.toBeNull();

    // Lookup failing again holds the row too.
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      { recipient_identity_unverified: true },
    )).resolves.toBeNull();
  });

  test('keeps the queued number for lead rows even if flagged', async () => {
    db.mockImplementation(() => { throw new Error('must not query'); });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: null },
      { refresh_customer_phone: true },
    )).resolves.toBe('(941) 555-0100');
  });

  test('returns null when the current phone cannot be verified — never the frozen snapshot', async () => {
    // The snapshot is exactly the staleness the flag exists to prevent —
    // sending to it under phone_matches_customer trust would be wrong, so
    // the cron retries the row instead.
    mockCustomerLookup({ phone: '   ' });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      { refresh_customer_phone: true },
    )).resolves.toBeNull();

    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(resolveScheduledRecipient(
      { to_phone: '(941) 555-0100', customer_id: 'cust-1' },
      { refresh_customer_phone: true },
    )).resolves.toBeNull();
  });
});

describe('canReplayBillingWithoutPhone', () => {
  const registered = { entry_point: 'billing_retry_email_deferred', requires_registered_dispatch: true,
    refresh_customer_phone: true, billingDeliveryCategory: 'payment_issue' };

  test('a registered Email-only replay proceeds without a phone', () => {
    expect(canReplayBillingWithoutPhone({ customer_id: 'cust-1', to_phone: '' }, registered)).toBe(true);
    expect(canReplayBillingWithoutPhone({ customer_id: 'cust-1', to_phone: '+19415550101' }, registered)).toBe(true);
  });

  test.each([
    ['an ordinary billing SMS row whose phone refresh failed', { refresh_customer_phone: true, billingDeliveryCategory: 'invoice' }],
    ['a registered entry that still sends Text', { ...registered, entry_point: 'invoice_followup_deferred' }],
    ['an unregistered row naming the Email entry point', { ...registered, requires_registered_dispatch: false }],
    ['an unverified recipient identity', { ...registered, recipient_identity_unverified: true }],
    ['an explicit foreign destination', { ...registered, explicit_recipient: true }],
    ['an unrecognized billing category', { ...registered, billingDeliveryCategory: 'appointment' }],
  ])('%s stays on the recipient-refresh rail', (_label, provenance) => {
    expect(canReplayBillingWithoutPhone({ customer_id: 'cust-1', to_phone: '' }, provenance)).toBe(false);
  });

  test('requires a customer row', () => {
    expect(canReplayBillingWithoutPhone({ customer_id: null, to_phone: '' }, registered)).toBe(false);
  });

  // PR #4843 Codex r6 activation-checklist: a phone-less Stripe billing hold
  // (ACH failure / bank verification) stamps requires_registered_dispatch so
  // it replays through the registered dispatch hook instead of retrying
  // toward a phone that will never resolve; a phone-bearing hold never
  // carries that stamp and stays on the ordinary refresh rail.
  test('a phone-less Stripe billing hold (stripe_webhook_billing_deferred) is accepted', () => {
    const stripeHold = { entry_point: 'stripe_webhook_billing_deferred', requires_registered_dispatch: true,
      refresh_customer_phone: true, billingDeliveryCategory: 'payment_issue' };
    expect(canReplayBillingWithoutPhone({ customer_id: 'cust-1', to_phone: '' }, stripeHold)).toBe(true);
  });

  test('a phone-bearing Stripe billing hold never gets the stamp — stays on the refresh rail', () => {
    const phoneBearingHold = { entry_point: 'stripe_webhook_billing_deferred',
      refresh_customer_phone: true, billingDeliveryCategory: 'payment_issue' };
    expect(canReplayBillingWithoutPhone({ customer_id: 'cust-1', to_phone: '' }, phoneBearingHold)).toBe(false);
  });
});

describe('scheduledDepositReceiptAllowed', () => {
  afterEach(() => db.mockReset());

  const receiptRow = { customer_id: 'cust-1', message_type: 'deposit_receipt' };

  test('blocks the replay when the customer switched to email-only receipts', async () => {
    mockPrefsLookup({ payment_receipt_channel: 'email' });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(false);
  });

  test('allows sms and both channels, and defaults to sms when prefs are missing', async () => {
    mockPrefsLookup({ payment_receipt_channel: 'sms' });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
    mockPrefsLookup({ payment_receipt_channel: 'both' });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
    mockPrefsLookup({ payment_receipt_channel: 'push' });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
    mockPrefsLookup(null);
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
  });

  test('leaves explicit receipt combinations to the central billing router', async () => {
    mockPrefsLookup({ payment_receipt_channel: 'email', payment_receipt_channels: ['push'] });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
  });

  test('ignores lead rows and non-receipt message types — no prefs query', async () => {
    db.mockImplementation(() => { throw new Error('must not query'); });
    await expect(scheduledDepositReceiptAllowed({ customer_id: null, message_type: 'deposit_receipt' })).resolves.toBe(true);
    await expect(scheduledDepositReceiptAllowed({ customer_id: 'cust-1', message_type: 'review_request' })).resolves.toBe(true);
  });

  test('fails open on a lookup error — matches the immediate path default', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(scheduledDepositReceiptAllowed(receiptRow)).resolves.toBe(true);
  });
});

describe('classifyDepositReplayFallback — channel-flip email handoff outcomes', () => {
  test('delivered email or a full receipt opt-out blocks the queued text', () => {
    expect(classifyDepositReplayFallback({ sent: true })).toBe('handled');
    expect(classifyDepositReplayFallback({ sent: false, reason: 'receipt_opted_out' })).toBe('handled');
  });

  test('a deterministically undeliverable email lets the queued TEXT proceed — it is the only receipt left', () => {
    // Mirrors the immediate path\'s undeliverable-email SMS fallback
    // (codex P2 on 6b73a479).
    for (const reason of ['no_recipient_email', 'sendgrid_not_configured', 'no_received_deposit', 'estimate_not_found', 'no_estimate_ref']) {
      expect(classifyDepositReplayFallback({ sent: false, reason })).toBe('sms_fallback');
    }
  });

  test('transient failures ride the bounded retry rail', () => {
    expect(classifyDepositReplayFallback({ sent: false, reason: 'prefs_lookup_failed' })).toBe('retry');
    expect(classifyDepositReplayFallback({ sent: false, reason: 'connect ETIMEDOUT' })).toBe('retry');
    expect(classifyDepositReplayFallback({})).toBe('retry');
  });
});
