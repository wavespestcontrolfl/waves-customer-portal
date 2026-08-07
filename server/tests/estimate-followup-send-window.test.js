// sendDualChannel vs the 8AM-8PM ET send window: a QUIET_HOURS_HOLD on the
// SMS leg must defer the WHOLE touch (skip the email leg, return false so
// the caller releases its stage claim and the next cron tick re-fires inside
// the window). Letting the email leg run would return attempted=true, the
// stage claim would finalize, and the SMS leg would never send. Any other
// SMS block (consent, suppression) keeps the old behavior: the email leg
// still carries the touch.

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  redactEmailAddresses: jest.fn((s) => s),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendDualChannel } = require('../services/estimate-follow-up')._private;

const EST = {
  id: 'est-1',
  customer_id: 'cust-1',
  customer_phone: '+19415550123',
  customer_email: 'c@example.com',
  created_at: '2026-08-01T00:00:00Z',
};

const EMAIL = { templateKey: 'estimate.followup_unviewed', stage: 'unviewed', payload: {} };

describe('estimate follow-up sendDualChannel send-window hold', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a held SMS leg defers the whole touch: email skipped, claim released', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'QUIET_HOURS_HOLD',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-08-07T12:00:00.000Z',
    });
    const attempted = await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    expect(attempted).toBe(false);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('a terminal SMS block still lets the email leg carry the touch', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: true,
      code: 'SUPPRESSED',
    });
    const attempted = await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    expect(attempted).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('inside the window both legs run', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: true });
    const attempted = await sendDualChannel(EST, { sms: 'Follow-up body', email: EMAIL });
    expect(attempted).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
