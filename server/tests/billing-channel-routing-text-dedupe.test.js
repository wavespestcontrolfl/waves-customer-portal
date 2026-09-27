// Full router fan-out replay: a billing notice whose Email leg already
// deduped on its own idempotencyKey (billing-channel-email.js) and whose
// Text leg now also dedupes on its own notificationEventKey
// (messaging/billing-text-leg-dedupe.js, wired into
// providers/twilio-sms.js's sendViaTwilio) must still report as ONE
// accepted notice at the dispatchBillingChannels/billingDispatchOutcome
// level — the shape every producer checks (`.sent`) to treat the notice as
// delivered. `sendLeg` here stands in for the recursive
// sendCustomerMessageCore call; each leg's own adapter (billing-channel-
// email.js / providers/twilio-sms.js) is what actually performs the
// per-channel dedupe check this test simulates the RESULT of — those
// adapters have their own coverage (billing-channel-email.test.js,
// twilio-sms-provider-billing-text-dedupe.test.js, billing-text-leg-
// dedupe.test.js).
const { dispatchBillingChannels } = require('../services/messaging/billing-channel-routing');

function billingInput(overrides = {}) {
  return {
    to: '+19415550100',
    body: 'Your balance is ready to view.',
    channel: 'sms',
    audience: 'customer',
    purpose: 'billing',
    customerId: 'cust-1',
    metadata: { original_message_type: 'billing_reminder' },
    ...overrides,
  };
}

const prefs = { billing_channels: ['email', 'sms'] };

describe('dispatchBillingChannels — Email + Text replay, both already accepted', () => {
  test('both legs dedupe on their own mechanism; the router reports one accepted, deduped notice', async () => {
    const sendLeg = jest.fn(async (legInput) => {
      if (legInput.channel === 'email') {
        return {
          sent: true, blocked: false, deliveryOutcome: 'accepted', deduped: true,
          providerMessageId: 'email-prior-1',
        };
      }
      if (legInput.channel === 'sms') {
        return {
          sent: true, blocked: false, deliveryOutcome: 'accepted', deduped: true,
          provider: 'twilio', providerMessageId: 'SMprior00000000000000000000000000',
        };
      }
      throw new Error(`unexpected channel ${legInput.channel}`);
    });

    const outcome = await dispatchBillingChannels(billingInput(), prefs, sendLeg);

    expect(sendLeg).toHaveBeenCalledTimes(2);
    // Both legs individually report accepted+deduped.
    expect(outcome.channelResults.email).toMatchObject({ sent: true, deliveryOutcome: 'accepted', deduped: true });
    expect(outcome.channelResults.sms).toMatchObject({ sent: true, deliveryOutcome: 'accepted', deduped: true });
    // The router's own aggregation (billingDispatchOutcome) treats the
    // fan-out as ONE accepted, deduped notice — the shape a producer
    // checks (.sent) to mark the notice delivered, never re-queuing it.
    expect(outcome).toMatchObject({ sent: true, deliveryOutcome: 'accepted', deduped: true });
    expect(outcome.notificationEventKey).toBeTruthy();
  });

  test('a real prior send (Text accepted, Email still needing to go) does not fully dedupe — Email still sends', async () => {
    const sendLeg = jest.fn(async (legInput) => {
      if (legInput.channel === 'email') {
        return { sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'email-fresh-1' };
      }
      return {
        sent: true, blocked: false, deliveryOutcome: 'accepted', deduped: true,
        provider: 'twilio', providerMessageId: 'SMprior00000000000000000000000000',
      };
    });

    const outcome = await dispatchBillingChannels(billingInput(), prefs, sendLeg);

    expect(sendLeg).toHaveBeenCalledTimes(2);
    expect(outcome.channelResults.email.deduped).toBeUndefined();
    expect(outcome.channelResults.sms.deduped).toBe(true);
    expect(outcome.sent).toBe(true);
  });
});

// A guarded current bell is accepted while native delivery stays uncertain.
test.each([false, true])('settles the current App bell and preserves unfinished siblings: %s', async (siblings) => {
  const app = { sent: false, bellPersisted: true, deliveryOutcome: 'uncertain', deferred: true, retryable: true, code: 'APP_DELIVERY_HOLD' };
  const send = jest.fn(async input => input.metadata.billingDeliveryLeg === 'push' ? app
    : { sent: false, retryable: true, deliveryOutcome: 'not_sent', code: 'SIBLING_RETRY' });
  const result = await dispatchBillingChannels(billingInput(), { billing_channels: siblings ? ['email', 'push', 'sms'] : ['push'] }, send);
  expect(send).toHaveBeenCalledTimes(siblings ? 3 : 1);
  expect(result).toMatchObject(siblings ? { sent: false, code: 'SIBLING_RETRY' } : { sent: true, deliveryOutcome: 'accepted' });
  expect(result.channelResults.push).toEqual(app);
  expect(result.providerMessageId).toBeUndefined();
});
