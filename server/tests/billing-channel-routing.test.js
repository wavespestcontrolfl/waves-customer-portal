/**
 * billing-channel-routing.js — selectedLegs / dispatchBillingChannels.
 *
 * Codex #4963 round 4 P2 (finding B/C groundwork): Text has no provider-side
 * event dedupe the way Email (billing-channel-email.js's idempotencyKey) and
 * App (push-channel-routing.js's notifyCustomer dedupeKey) do, so a replay
 * must be TOLD which legs already delivered via input.metadata.
 * replaySkipChannels — selectedLegs excludes them from the fan-out, and a
 * replay whose skip list alone accounts for every currently-selected channel
 * ends cleanly (BILLING_CHANNELS_ALREADY_DELIVERED) instead of falling into
 * the "nothing selected" / "caller owns email" branches.
 */

const {
  dispatchBillingChannels,
} = require('../services/messaging/billing-channel-routing');

const baseInput = (overrides = {}) => ({
  to: '+19415550100',
  body: 'Your invoice is ready',
  channel: 'sms',
  audience: 'customer',
  purpose: 'payment_link',
  customerId: 'cust-1',
  invoiceId: 'inv-1',
  metadata: { original_message_type: 'invoice', billingDeliveryCategory: 'invoice' },
  ...overrides,
});

const accepted = (channel) => ({ sent: true, blocked: false, channel, deliveryOutcome: 'accepted' });

describe('billing-channel-routing selectedLegs / replaySkipChannels (Codex #4963 round 4 P2)', () => {
  test('skips the Text leg when replaySkipChannels names it, still dispatching the other selected leg', async () => {
    const sendLeg = jest.fn(async ({ channel }) => accepted(channel));
    const input = baseInput({ metadata: { ...baseInput().metadata, replaySkipChannels: ['sms'] } });
    const result = await dispatchBillingChannels(input, { invoice_channels: ['email', 'sms'] }, sendLeg);
    expect(sendLeg).toHaveBeenCalledTimes(1);
    expect(sendLeg.mock.calls[0][0].channel).toBe('email');
    expect(result.channelResults).toHaveProperty('email');
    expect(result.channelResults).not.toHaveProperty('sms');
  });

  test('skips the Email leg when replaySkipChannels names it, still dispatching Text', async () => {
    const sendLeg = jest.fn(async ({ channel }) => accepted(channel));
    const input = baseInput({ metadata: { ...baseInput().metadata, replaySkipChannels: ['email'] } });
    const result = await dispatchBillingChannels(input, { invoice_channels: ['email', 'sms'] }, sendLeg);
    expect(sendLeg).toHaveBeenCalledTimes(1);
    expect(sendLeg.mock.calls[0][0].channel).toBe('sms');
    expect(result.channelResults).toHaveProperty('sms');
    expect(result.channelResults).not.toHaveProperty('email');
  });

  test('skips the App/push leg when replaySkipChannels names it', async () => {
    const sendLeg = jest.fn(async ({ channel }) => accepted(channel));
    const input = baseInput({ metadata: { ...baseInput().metadata, replaySkipChannels: ['push'] } });
    const result = await dispatchBillingChannels(input, { invoice_channels: ['push', 'sms'] }, sendLeg);
    expect(sendLeg).toHaveBeenCalledTimes(1);
    expect(sendLeg.mock.calls[0][0].channel).toBe('sms');
    expect(result.channelResults).not.toHaveProperty('push');
  });

  test('every currently-selected channel skipped -> BILLING_CHANNELS_ALREADY_DELIVERED, not NO_BILLING_CHANNEL_SELECTED', async () => {
    const sendLeg = jest.fn(async ({ channel }) => accepted(channel));
    const input = baseInput({ metadata: { ...baseInput().metadata, replaySkipChannels: ['sms'] } });
    const result = await dispatchBillingChannels(input, { invoice_channels: ['sms'] }, sendLeg);
    expect(sendLeg).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_CHANNELS_ALREADY_DELIVERED',
    });
    // Terminal, not retryable/deferred — the scheduler's replay treats this
    // as a clean end, never a hold or an alert.
    expect(result.retryable).not.toBe(true);
    expect(result.deferred).not.toBe(true);
  });

  test('Email absent only because hasEmailLeg owns it, Push already delivered -> CHANNEL_EMAIL_ONLY, never ALREADY_DELIVERED', async () => {
    // Codex round-4 P1 pre-push audit: selected ['email','push'], hasEmailLeg
    // excludes Email (the caller's OWN email sender is sending it, not a
    // dead leg), replaySkipChannels excludes Push (already delivered). The
    // resulting empty `channels` must not be misread as "everything already
    // delivered" — Email hasn't delivered here at all, it's just not this
    // call's job. CHANNEL_EMAIL_ONLY must still win.
    const sendLeg = jest.fn(async ({ channel }) => accepted(channel));
    const input = baseInput({ hasEmailLeg: true, metadata: { ...baseInput().metadata, replaySkipChannels: ['push'] } });
    const result = await dispatchBillingChannels(input, { invoice_channels: ['email', 'push'] }, sendLeg);
    expect(sendLeg).not.toHaveBeenCalled();
    expect(result.code).toBe('CHANNEL_EMAIL_ONLY');
    expect(result.code).not.toBe('BILLING_CHANNELS_ALREADY_DELIVERED');
  });

  test('an ordinary empty selection (no skip involved) still reports NO_BILLING_CHANNEL_SELECTED', async () => {
    const sendLeg = jest.fn(async ({ channel }) => accepted(channel));
    const result = await dispatchBillingChannels(baseInput(), { invoice_channels: [] }, sendLeg);
    expect(sendLeg).not.toHaveBeenCalled();
    expect(result.code).toBe('NO_BILLING_CHANNEL_SELECTED');
  });

  test('hasEmailLeg (unrelated marker) is untouched by replaySkipChannels — still just excludes Email', async () => {
    const sendLeg = jest.fn(async ({ channel }) => accepted(channel));
    const input = baseInput({ hasEmailLeg: true, metadata: { ...baseInput().metadata, replaySkipChannels: ['push'] } });
    const result = await dispatchBillingChannels(input, { invoice_channels: ['email', 'push', 'sms'] }, sendLeg);
    expect(sendLeg).toHaveBeenCalledTimes(1);
    expect(sendLeg.mock.calls[0][0].channel).toBe('sms');
    expect(result.channelResults).not.toHaveProperty('email');
    expect(result.channelResults).not.toHaveProperty('push');
  });

  test('an unrecognized replaySkipChannels shape (not an array) is ignored, not a crash', async () => {
    const sendLeg = jest.fn(async ({ channel }) => accepted(channel));
    const input = baseInput({ metadata: { ...baseInput().metadata, replaySkipChannels: 'sms' } });
    const result = await dispatchBillingChannels(input, { invoice_channels: ['sms'] }, sendLeg);
    expect(sendLeg).toHaveBeenCalledTimes(1);
    expect(result.channelResults).toHaveProperty('sms');
  });
});
