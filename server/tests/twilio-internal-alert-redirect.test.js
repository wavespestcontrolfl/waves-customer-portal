const mockTwilioCreate = jest.fn();
const mockValidateOutbound = jest.fn(() => ({ ok: true }));

jest.mock('twilio', () => jest.fn(() => ({
  messages: { create: mockTwilioCreate },
})));
jest.mock('../config', () => ({
  twilio: {
    accountSid: 'AC_test',
    authToken: 'auth_test',
    verifyServiceSid: 'VA_test',
  },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
}));
jest.mock('../services/sms-guard', () => ({
  validateOutbound: (...args) => mockValidateOutbound(...args),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => ({ bellWritten: true, push: null })),
}));

const TwilioService = require('../services/twilio');
const { triggerNotification } = require('../services/notification-triggers');

describe('Twilio internal admin alert redirect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateOutbound.mockReturnValue({ ok: true });
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_fallback' });
    process.env.ADAM_PHONE = '+19415993489';
    process.env.WAVES_OFFICE_PHONE = '+19413187612';
    delete process.env.OWNER_SMS_DISABLED;
  });

  test('redirects owner internal_alert SMS into a Waves admin notification', async () => {
    const result = await TwilioService.sendSMS(
      '+19415993489',
      'New lead from palmettoexterminator.com\n+18182079399\nCynthia Sparagna',
      { messageType: 'internal_alert', link: '/admin/leads' },
    );

    expect(result).toMatchObject({
      success: true,
      suppressed: true,
      notificationRedirected: true,
    });
    expect(triggerNotification).toHaveBeenCalledWith('internal_admin_alert', expect.objectContaining({
      title: 'New lead from palmettoexterminator.com',
      body: '+18182079399\nCynthia Sparagna',
      link: '/admin/leads',
      originalMessageType: 'internal_alert',
      originalToMasked: '***3489',
    }));
  });

  test('redirects legacy admin_alert messages sent to hardcoded office fallback', async () => {
    const result = await TwilioService.sendSMS(
      '+19413187612',
      'CANCELLATION ALERT: customer wants to cancel',
      { messageType: 'admin_alert' },
    );

    expect(result.notificationRedirected).toBe(true);
    expect(triggerNotification).toHaveBeenCalledWith('internal_admin_alert', expect.objectContaining({
      title: 'CANCELLATION ALERT: customer wants to cancel',
      originalMessageType: 'admin_alert',
      originalToMasked: '***7612',
    }));
  });

  test('suppresses owner SMS fallback when notification redirect does not deliver', async () => {
    triggerNotification.mockResolvedValueOnce({
      bellWritten: false,
      push: { subscriptions: 0, sent: 0, failed: 0, skipped: 0 },
    });

    const result = await TwilioService.sendSMS(
      '+19415993489',
      'New lead fallback path',
      { messageType: 'internal_alert', link: '/admin/leads' },
    );

    expect(result).toMatchObject({
      success: true,
      sid: 'internal-admin-notification-undelivered',
      suppressed: true,
      notificationRedirected: false,
      notificationUndelivered: true,
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('suppresses owner SMS fallback when notification redirect throws', async () => {
    triggerNotification.mockRejectedValueOnce(new Error('notification table unavailable'));

    const result = await TwilioService.sendSMS(
      '+19415993489',
      'New lead exception path',
      { messageType: 'internal_alert', link: '/admin/leads' },
    );

    expect(result).toMatchObject({
      success: true,
      sid: 'internal-admin-notification-error',
      suppressed: true,
      notificationRedirected: false,
      notificationError: true,
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('blocks internal_alert SMS to unknown recipients by default', async () => {
    const result = await TwilioService.sendSMS(
      '+19415550123',
      'Internal billing alert',
      { messageType: 'internal_alert', link: '/admin/revenue' },
    );

    expect(result).toMatchObject({
      success: false,
      blocked: true,
      guardBlocked: true,
      error: 'Internal/admin alert recipient is not a known owner/admin phone',
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('reports SMS guard blocks through admin notifications without direct owner SMS', async () => {
    mockValidateOutbound.mockReturnValueOnce({ ok: false, reason: 'unsubstituted_variable' });

    const result = await TwilioService.sendSMS(
      '+19415550123',
      'Hi {{first_name}}',
      { messageType: 'appointment_reminder' },
    );

    expect(result).toMatchObject({
      success: false,
      guardBlocked: true,
      error: 'unsubstituted_variable',
    });
    expect(triggerNotification).toHaveBeenCalledWith('internal_admin_alert', expect.objectContaining({
      title: 'SMS guard blocked outbound message',
      body: expect.stringContaining('Reason: unsubstituted_variable'),
      link: '/admin/sms-templates',
      originalMessageType: 'sms_guard_blocked',
      originalToMasked: '***0123',
    }));
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });
});
