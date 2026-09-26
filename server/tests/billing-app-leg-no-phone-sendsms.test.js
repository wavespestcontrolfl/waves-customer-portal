/**
 * Pre-push audit P1: the explicit billing App-only leg
 * (server/services/messaging/send-customer-message.js — the App-only
 * billing leg for a customer with no phone on file) calls the REAL
 * TwilioService.sendSMS(null, body, { explicitPushOnly: true,
 * billingDeliveryCategory, ... }) — see server/services/messaging/
 * providers/twilio-sms.js and push-channel-routing.js. Every existing
 * sendSMS test mocks '../services/twilio' wholesale, so nothing exercised
 * the REAL sendSMS (server/services/twilio.js, sendSMS ~line 607) with a
 * null recipient. This file runs the real function — only the Twilio SDK
 * client, the DB, and PushRouting.attemptPushFirst are mocked — and
 * proves:
 *
 *   1. explicitPushOnly + a null recipient reaches attemptPushFirst with
 *      `to: null` and the billing category, and never touches the Twilio
 *      client (messages.create) when the push leg delivers.
 *   2. WITHOUT explicitPushOnly, a null recipient is refused before ever
 *      reaching the Twilio client — sendSMS has no other guard that
 *      would otherwise catch a missing `to` (see the production fix
 *      alongside this test, twilio.js's new MISSING_RECIPIENT guard).
 */
const mockTwilioCreate = jest.fn();
const mockAttemptPushFirst = jest.fn();

jest.mock('twilio', () => jest.fn(() => ({ messages: { create: mockTwilioCreate } })));
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test', verifyServiceSid: 'VA_test' } }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => gate !== 'smsGratitudeReplies'),
  gateEnvValue: jest.fn(() => false),
  gateEnvTimestamp: jest.fn(() => null),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../routes/admin-sms-templates', () => ({ isTemplateActive: jest.fn(async () => true) }));
jest.mock('../services/sms-guard', () => ({ validateOutbound: jest.fn(() => ({ ok: true })) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true, push: null })) }));
jest.mock('../services/audit-log', () => ({ auditInternalAdminAlertDeliveryIssue: jest.fn(() => Promise.resolve()) }));
// callback_number_needed hold (PR #4807): not under test here, matches the
// existing owned-number-guard test's stub.
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));
// The only external edge for the App-only leg: attemptPushFirst is the
// real production boundary between sendSMS and the notification service /
// sms_log write, and it is exercised on its own in
// push-channel-routing.test.js. Stubbed here so this file tests sendSMS's
// OWN null-tolerance, not attemptPushFirst's internals.
jest.mock('../services/messaging/push-channel-routing', () => ({
  decidePushRoute: jest.fn(() => 'sms_only'),
  attemptPushFirst: mockAttemptPushFirst,
  gatePushRoutingOn: jest.fn(() => false),
}));

const TwilioService = require('../services/twilio');
const logger = require('../services/logger');

describe('billing App-only leg: real sendSMS with no phone (to === null)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OWNER_SMS_DISABLED;
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_should_not_happen' });
  });

  test('explicitPushOnly + null recipient reaches attemptPushFirst with to:null and the billing category, and never calls the Twilio client', async () => {
    mockAttemptPushFirst.mockResolvedValue({
      delivered: true,
      deliveryOutcome: 'accepted',
      sid: 'push:notif-1',
      notificationId: 'notif-1',
      acceptedAt: new Date('2026-09-25T12:00:00Z'),
    });

    const result = await TwilioService.sendSMS(null, 'Your invoice is ready — view it in the Waves app.', {
      explicitPushOnly: true,
      billingDeliveryCategory: 'invoice',
      customerId: 'cust-1',
      invoiceId: 'inv-1',
      messageType: 'invoice',
    });

    expect(mockAttemptPushFirst).toHaveBeenCalledTimes(1);
    const pushCallArgs = mockAttemptPushFirst.mock.calls[0][0];
    expect(pushCallArgs.to).toBeNull();
    expect(pushCallArgs.billingDeliveryCategory).toBe('invoice');
    expect(pushCallArgs.customerId).toBe('cust-1');
    expect(pushCallArgs.invoiceId).toBe('inv-1');
    expect(pushCallArgs.explicitPushOnly).toBe(true);

    expect(result).toMatchObject({ success: true, sid: 'push:notif-1', pushRouted: true });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('explicitPushOnly + null recipient: a push failure is reported as an app-side outcome, never a Twilio send', async () => {
    mockAttemptPushFirst.mockResolvedValue({ delivered: false, deliveryOutcome: 'not_sent', reason: 'no_fresh_device' });

    const result = await TwilioService.sendSMS(null, 'Your invoice is ready.', {
      explicitPushOnly: true,
      billingDeliveryCategory: 'invoice',
      customerId: 'cust-1',
      invoiceId: 'inv-1',
      messageType: 'invoice',
    });

    expect(mockAttemptPushFirst).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: false, appUnavailable: true });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('without explicitPushOnly, a null recipient is refused before the Twilio client — never sends a text', async () => {
    const result = await TwilioService.sendSMS(null, 'Your invoice is ready.', {
      billingDeliveryCategory: 'invoice',
      customerId: 'cust-1',
      invoiceId: 'inv-1',
      messageType: 'invoice',
    });

    expect(result).toMatchObject({ success: false, sid: null, blocked: true, guardBlocked: true, code: 'MISSING_RECIPIENT' });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(mockAttemptPushFirst).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no recipient'));
  });
});
