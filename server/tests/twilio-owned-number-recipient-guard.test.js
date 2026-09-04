/**
 * sendSMS refuses a recipient that is one of Waves' own Twilio numbers.
 * 2026-08-29: a public quote-form lead carried our main line as its phone;
 * the booking-invite text went out with To == From, Twilio failed it with
 * 21266, and the queue row settled blocked with no SID. Every SMS reaches
 * Twilio through sendSMS, so the guard lives there — before the Twilio
 * client is touched, after internal alerts have been redirected to a bell.
 */
const mockTwilioCreate = jest.fn();

jest.mock('twilio', () => jest.fn(() => ({ messages: { create: mockTwilioCreate } })));
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test', verifyServiceSid: 'VA_test' } }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true), gateEnvValue: jest.fn(() => false) }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../routes/admin-sms-templates', () => ({ isTemplateActive: jest.fn(async () => true) }));
jest.mock('../services/sms-guard', () => ({ validateOutbound: jest.fn(() => ({ ok: true })) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ bellWritten: true, push: null })) }));
jest.mock('../services/audit-log', () => ({ auditInternalAdminAlertDeliveryIssue: jest.fn(() => Promise.resolve()) }));

const TwilioService = require('../services/twilio');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const logger = require('../services/logger');

describe('sendSMS owned-number recipient guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_should_not_happen' });
    delete process.env.OWNER_SMS_DISABLED;
  });

  test('a customer-facing text addressed to the main line is blocked before Twilio', async () => {
    const result = await TwilioService.sendSMS(TWILIO_NUMBERS.mainLine.number, 'Your Waves quote is ready', {
      messageType: 'quote_booking_invite',
    });
    expect(result).toMatchObject({ success: false, sid: null, blocked: true, guardBlocked: true, code: 'OWNED_NUMBER_RECIPIENT' });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Waves-owned number'));
  });

  test('a formatted variant of a tracking number is blocked too', async () => {
    const tracking = TWILIO_NUMBERS.allNumbers.find((n) => n.number && n.number !== TWILIO_NUMBERS.mainLine.number);
    const digits = String(tracking.number).replace(/\D/g, '').slice(-10);
    const formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    const result = await TwilioService.sendSMS(formatted, 'Hello', { messageType: 'appointment' });
    expect(result.code).toBe('OWNED_NUMBER_RECIPIENT');
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('a real customer number still reaches Twilio', async () => {
    const result = await TwilioService.sendSMS('+19415550123', 'Hello', { messageType: 'appointment' });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
