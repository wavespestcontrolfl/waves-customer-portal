jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(),
}));

const { _internals } = require('../services/messaging/send-customer-message');
const { resolvePolicy } = require('../services/messaging/policy');

describe('sendCustomerMessage contract guardrails', () => {
  test('blocks internal briefing purpose for customer audiences', () => {
    expect(_internals.validateContract({
      to: '+19415550123',
      body: 'Internal note',
      channel: 'sms',
      audience: 'customer',
      purpose: 'internal_briefing',
    })).toEqual({
      ok: false,
      reason: 'internal_briefing purpose requires internal or admin audience',
    });
  });

  test('blocks internal audiences on customer-facing purposes', () => {
    expect(_internals.validateContract({
      to: '+19415550123',
      body: 'Appointment reminder',
      channel: 'sms',
      audience: 'internal',
      purpose: 'appointment',
    })).toEqual({
      ok: false,
      reason: 'internal/admin audience requires internal_briefing purpose',
    });
  });

  test('detects autopay customer SMS across purpose and message type', () => {
    expect(_internals.isAutopayCustomerSms({
      to: '+19415550123',
      body: 'Payment failed',
      channel: 'sms',
      audience: 'customer',
      purpose: 'payment_failure',
      metadata: { original_message_type: 'autopay_charge_failed' },
    })).toBe(true);

    expect(_internals.isAutopayCustomerSms({
      to: '+19415550123',
      body: 'Card expiring',
      channel: 'sms',
      audience: 'customer',
      purpose: 'autopay',
      metadata: { original_message_type: 'payment_expiry' },
    })).toBe(true);

    expect(_internals.isAutopayCustomerSms({
      to: '+19415550123',
      body: 'Internal alert',
      channel: 'sms',
      audience: 'internal',
      purpose: 'internal_briefing',
      metadata: { original_message_type: 'autopay_charge_failed' },
    })).toBe(false);
  });

  test('blocks autopay customer SMS while the rollout gate is off', () => {
    expect(_internals.checkAutopayCustomerSmsGate({
      to: '+19415550123',
      body: 'Payment failed',
      channel: 'sms',
      audience: 'customer',
      purpose: 'payment_failure',
      metadata: { original_message_type: 'autopay_charge_failed' },
    })).toEqual({
      ok: false,
      code: 'AUTOPAY_CUSTOMER_SMS_DISABLED',
      reason: 'AutoPay customer SMS is disabled',
    });

    expect(_internals.checkAutopayCustomerSmsGate({
      to: '+19415550123',
      body: 'Appointment reminder',
      channel: 'sms',
      audience: 'customer',
      purpose: 'appointment',
    })).toEqual({ ok: true });
  });

  test('review requests honor the review_request notification preference', () => {
    expect(resolvePolicy('customer', 'review_request')).toEqual(expect.objectContaining({
      prefsColumn: 'review_request',
    }));
  });

  test('arrival texts gate on the independent tech_arrived preference, not tech_en_route', () => {
    expect(resolvePolicy('customer', 'tech_arrived')).toEqual(expect.objectContaining({
      prefsColumn: 'tech_arrived',
      requireConsent: 'transactional',
    }));
  });
});
