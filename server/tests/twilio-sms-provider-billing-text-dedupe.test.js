// providers/twilio-sms.js's sendViaTwilio wraps every send in
// billing-text-leg-dedupe.js's withBillingTextLegLock. This file covers
// the wiring itself: a deduped verdict short-circuits before
// TwilioService.sendSMS is ever called, and a legacy (non-billing) send is
// byte-identical to before — the guard's own scoping logic lives in
// billing-text-leg-dedupe.test.js and is not re-tested here.
const mockSendSMS = jest.fn();
jest.mock('../services/twilio', () => ({ sendSMS: (...args) => mockSendSMS(...args) }));

const mockWithBillingTextLegLock = jest.fn((input, send) => send());
jest.mock('../services/messaging/billing-text-leg-dedupe', () => ({
  withBillingTextLegLock: (...args) => mockWithBillingTextLegLock(...args),
}));

const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');

function billingTextInput(overrides = {}) {
  return {
    to: '+19415550100',
    body: 'Your balance is ready to view.',
    channel: 'sms',
    customerId: 'cust-1',
    purpose: 'billing',
    metadata: {
      billingDeliveryLeg: 'sms',
      billingDeliveryCategory: 'billing',
      notificationEventKey: 'billing:cust-1:billing_reminder:abc123',
    },
    ...overrides,
  };
}

describe('providers/twilio-sms sendViaTwilio — billing text leg dedupe wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWithBillingTextLegLock.mockImplementation((input, send) => send());
  });

  test('every send is routed through withBillingTextLegLock with the original input', async () => {
    mockSendSMS.mockResolvedValue({ success: true, sid: 'SM1', fromNumber: '+19415550199', deliveryOutcome: 'accepted' });
    const input = billingTextInput();
    await sendViaTwilio(input, {});
    expect(mockWithBillingTextLegLock).toHaveBeenCalledTimes(1);
    expect(mockWithBillingTextLegLock.mock.calls[0][0]).toBe(input);
    expect(typeof mockWithBillingTextLegLock.mock.calls[0][1]).toBe('function');
    expect(mockSendSMS).toHaveBeenCalledTimes(1);
  });

  test('a deduped verdict short-circuits before TwilioService.sendSMS is ever called', async () => {
    const dedupedResult = {
      sent: true, provider: 'twilio', deliveryOutcome: 'accepted', deduped: true,
      providerMessageId: 'SMprior00000000000000000000000000', sentAt: new Date('2026-09-01T00:00:00Z'),
    };
    mockWithBillingTextLegLock.mockResolvedValue(dedupedResult);

    const result = await sendViaTwilio(billingTextInput(), {});

    expect(mockSendSMS).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      sent: true, provider: 'twilio', deliveryOutcome: 'accepted', deduped: true,
      providerMessageId: dedupedResult.providerMessageId,
    }));
  });

  test('no dedupe verdict -> the thunk drives the real Twilio call and maps its accepted result normally', async () => {
    mockSendSMS.mockResolvedValue({ success: true, sid: 'SM2', fromNumber: '+19415550199', deliveryOutcome: 'accepted' });
    const result = await sendViaTwilio(billingTextInput(), {});
    expect(mockSendSMS).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ sent: true, provider: 'twilio', providerMessageId: 'SM2' }));
  });

  test('a legacy send with no billingDeliveryLeg still routes through the guard (which itself no-ops for it)', async () => {
    mockSendSMS.mockResolvedValue({ success: true, sid: 'SM3', fromNumber: '+19415550199', deliveryOutcome: 'accepted' });
    const input = billingTextInput({ metadata: { original_message_type: 'manual' } });
    await sendViaTwilio(input, {});
    expect(mockWithBillingTextLegLock).toHaveBeenCalledTimes(1);
    expect(mockSendSMS).toHaveBeenCalledTimes(1);
    // billingDeliveryLeg option must be absent/undefined for a legacy send —
    // twilio.js only stamps it on the accepted row when truthy.
    expect(mockSendSMS.mock.calls[0][2].billingDeliveryLeg).toBeUndefined();
  });

  test('an explicit billing sms leg passes billingDeliveryLeg through to TwilioService.sendSMS for persistence', async () => {
    mockSendSMS.mockResolvedValue({ success: true, sid: 'SM4', fromNumber: '+19415550199', deliveryOutcome: 'accepted' });
    await sendViaTwilio(billingTextInput(), {});
    expect(mockSendSMS.mock.calls[0][2]).toMatchObject({
      billingDeliveryLeg: 'sms',
      notificationEventKey: 'billing:cust-1:billing_reminder:abc123',
    });
  });
});
