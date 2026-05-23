jest.mock('../models/db', () => jest.fn());
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
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
});
