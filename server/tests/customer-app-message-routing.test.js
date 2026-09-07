jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/messaging/audit', () => ({ persistAudit: jest.fn(async () => ({ id: 'audit-test' })) }));
jest.mock('../services/messaging/validators/line-type', () => ({ checkLineType: jest.fn(async () => ({ ok: true })) }));

const db = require('../models/db');
const Twilio = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const customerId = '11111111-1111-4111-8111-111111111111';
let prefs;
let suppression;
let suppressionError;
const input = {
  to: '+19415550142', body: 'Your payment receipt is ready in the portal.',
  channel: 'sms', audience: 'customer', purpose: 'payment_receipt', customerId,
  invoiceId: 'test-invoice', customerInitiated: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
  require('../config/feature-gates').gates.smsSendWindow = true;
  prefs = { payment_receipt_channel: 'push', payment_receipt: true, sms_enabled: true, payment_confirmation_sms: true };
  suppression = null;
  suppressionError = false;
  db.mockImplementation((table) => {
    const q = {
      where: jest.fn(() => q), whereIn: jest.fn(() => q),
      first: jest.fn(async () => {
        if (table === 'customers') return { id: customerId, account_id: customerId, phone: input.to, is_primary_profile: true };
        if (table === 'notification_prefs') return { ...prefs };
        if (table === 'messaging_suppression') {
          if (suppressionError) throw new Error('read unavailable');
          return suppression;
        }
        return null;
      }),
    };
    return q;
  });
  Twilio.sendSMS.mockResolvedValue({ success: true, pushRouted: true, sid: 'push:test-event' });
});
afterEach(() => { delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS; delete process.env.GATE_SMS_SEND_WINDOW; });

test('App first reaches the app with text settings off, without changing them', async () => {
  prefs.sms_enabled = false;
  prefs.payment_confirmation_sms = false;
  const result = await sendCustomerMessage(input);
  expect(result).toMatchObject({ sent: true, channel: 'push' });
  expect(Twilio.sendSMS).toHaveBeenCalledWith(input.to, input.body, expect.objectContaining({ explicitPushOnly: true }));
  expect(prefs.sms_enabled).toBe(false);
  expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ channel: 'push' }), providerOutcome: expect.objectContaining({ provider: 'push' }) }));
});

test.each(['opt_out_keyword', 'wrong_number', 'manual_dnc', 'non_mobile'])('hard suppression %s still blocks app delivery', async (reason) => {
  suppression = { reason, active: true };
  const result = await sendCustomerMessage(input);
  expect(result.sent).toBe(false);
  expect(result.blocked).toBe(true);
  expect(Twilio.sendSMS).not.toHaveBeenCalled();
});

test('unknown suppression and category off both fail closed', async () => {
  suppressionError = true;
  expect((await sendCustomerMessage(input)).code).toBe('SUPPRESSION_LOOKUP_FAILED');
  suppressionError = false;
  prefs.payment_receipt = false;
  expect((await sendCustomerMessage(input)).code).toBe('PURPOSE_OPTED_OUT');
  expect(Twilio.sendSMS).not.toHaveBeenCalled();
});

test('an unavailable app retries one allowed text, with a separate audited reason', async () => {
  Twilio.sendSMS.mockResolvedValueOnce({ success: false, appUnavailable: true, error: 'no_fresh_device' })
    .mockResolvedValueOnce({ success: true, sid: 'SMtest' });
  const result = await sendCustomerMessage(input);
  expect(result).toMatchObject({ sent: true, channel: 'sms', requestedChannel: 'push', fallbackReason: 'no_fresh_device' });
  expect(Twilio.sendSMS).toHaveBeenCalledTimes(2);
  expect(Twilio.sendSMS.mock.calls[1][2]).toMatchObject({ explicitPushOnly: false, skipPushRouting: true });
  expect(persistAudit.mock.calls.map(([attempt]) => attempt.input.channel)).toEqual(['push', 'sms']);
});

test('a fallback rechecks a new opt-out rather than bypassing it', async () => {
  Twilio.sendSMS.mockImplementationOnce(async () => {
    prefs.sms_enabled = false;
    return { success: false, appUnavailable: true, error: 'provider_failure' };
  });
  const result = await sendCustomerMessage(input);
  expect(result).toMatchObject({ sent: false, code: 'SMS_OPTED_OUT', requestedChannel: 'push' });
  expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
});

test('an event already being pushed defers without racing a backup text', async () => {
  Twilio.sendSMS.mockResolvedValue({ success: false, appPending: true });
  expect(await sendCustomerMessage(input)).toMatchObject({ sent: false, deferred: true, reason: 'push_in_flight' });
  expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
});

test.each([{ bundled_review_request_id: 'qa-review' }, { mms_fallback_reason: 'fixture-failure' }])('excluded review and media fallback keep their text delivery: %j', async (metadata) => {
  await sendCustomerMessage({ ...input, metadata });
  expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(false);
});

test.each(['appointment_rescheduled', 'reschedule_series_confirmation', 'appointment_series_cancelled', 'appointment_no_show'])('appointment update %s honors the primary channel', async (type) => {
  prefs.appointment_confirmation_channel = 'push';
  await sendCustomerMessage({ ...input, purpose: 'appointment_confirmation', operatorInitiated: true,
    metadata: { original_message_type: type, useCustomerChannel: true } });
  expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(true);
});

test('lifecycle bells retain legacy behavior while App first uses the guarded sender', async () => {
  const { bellPushAllowed } = require('../services/messaging/push-channel-routing');
  prefs.en_route_channel = 'sms';
  expect(await bellPushAllowed(customerId, 'tech_en_route')).toBe(true);
  prefs.en_route_channel = 'push';
  expect(await bellPushAllowed(customerId, 'tech_en_route')).toBe(false);
  process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'false';
  expect(await bellPushAllowed(customerId, 'tech_en_route')).toBe(true);
});

test.each([{ gateBlocked: true }, { templateDisabled: true }, { suppressed: true }])('a transport guard is an honest block with no backup: %j', async (block) => {
  Twilio.sendSMS.mockResolvedValue({ success: true, sid: 'guard-blocked', ...block });
  expect(await sendCustomerMessage(input)).toMatchObject({ sent: false, blocked: true, code: 'DELIVERY_SUPPRESSED' });
  expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
});

test('staff Text, secondary contacts and a dark gate stay on their text path', async () => {
  await sendCustomerMessage({ ...input, operatorInitiated: true });
  await sendCustomerMessage({ ...input, to: '+19415550143' });
  process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'false';
  await sendCustomerMessage(input);
  expect(Twilio.sendSMS.mock.calls.every(([, , options]) => options.explicitPushOnly === false)).toBe(true);
});

test('automated app delivery observes the existing ET send window', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2035-01-10T02:00:00Z'));
  try {
    expect(await sendCustomerMessage({ ...input, customerInitiated: false })).toMatchObject({ sent: false, code: 'QUIET_HOURS_HOLD', deferred: true });
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
