jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(),
}));

const { _internals } = require('../services/messaging/send-customer-message');

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
});
