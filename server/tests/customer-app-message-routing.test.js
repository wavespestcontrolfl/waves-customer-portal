jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/billing-channel-email', () => ({ sendBillingChannelEmail: jest.fn() }));
jest.mock('../services/messaging/audit', () => ({ persistAudit: jest.fn(async () => ({ id: 'audit-test' })) }));
jest.mock('../services/messaging/validators/line-type', () => ({
  ...jest.requireActual('../services/messaging/validators/line-type'),
  readCachedLineType: jest.fn(async () => ({ state: 'hit', lineType: 'mobile' })),
}));
jest.mock('../services/appointment-email', () => ({ sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/reschedule-link', () => ({ buildRescheduleLink: jest.fn(async () => ({ url: null })) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
// callback_number_needed hold (PR #4807, round 6 — number-keyed): the
// canonical chokepoint checks every SMS `to` against
// disclaimed_number_holds, and safeSendAppointment's visit pre-check asks
// the same module whether the customer's phone is held. Stubbed (never
// held) so this file's bespoke customers/notification_prefs/
// messaging_suppression `db` double is never also asked to answer the
// hold reads; the hold itself is covered by
// send-customer-message-callback-number-hold.test.js and
// callback-number-hold-boundary.test.js.
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
  disclaimedNumberHeldForVisit: jest.fn(async () => false),
}));

const db = require('../models/db');
const Twilio = require('../services/twilio');
const { sendBillingChannelEmail } = require('../services/billing-channel-email');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const AppointmentReminders = require('../services/appointment-reminders');
const { sendAppointmentReminderEmail } = require('../services/appointment-email');
const { readCachedLineType } = require('../services/messaging/validators/line-type');
const { notifyAdmin } = require('../services/notification-service');
const customerId = '11111111-1111-4111-8111-111111111111';
let prefs;
let prefsError;
let suppression;
let suppressionError;
let customerPhone;
const input = {
  to: '+19415550142', body: 'Your payment receipt is ready in the portal.',
  channel: 'sms', audience: 'customer', purpose: 'payment_receipt', customerId,
  invoiceId: 'test-invoice', customerInitiated: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
  require('../config/feature-gates').gates.smsSendWindow = true;
  require('../config/feature-gates').gates.proactiveLineTypeLookup = false;
  readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'mobile' });
  prefs = { payment_receipt_channel: 'push', payment_receipt: true, sms_enabled: true, payment_confirmation_sms: true };
  prefsError = false;
  suppression = null;
  suppressionError = false;
  customerPhone = input.to;
  db.mockImplementation((table) => {
    const q = {
      where: jest.fn(() => q), whereIn: jest.fn(() => q),
      first: jest.fn(async () => {
        if (table === 'customers') return { id: customerId, account_id: customerId, phone: customerPhone, is_primary_profile: true };
        if (table === 'notification_prefs') {
          if (prefsError) throw new Error('preferences unavailable');
          return { ...prefs };
        }
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
  sendBillingChannelEmail.mockResolvedValue({ sent: true, provider: 'email', providerMessageId: 'email:qa', deliveryOutcome: 'accepted' });
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

test.each(['invoice', 'payment_link', 'invoice_followup'])('explicit invoice choice routes %s and retains invoice identity', async (type) => {
  prefs.invoice_channel = 'push';
  prefs.sms_enabled = false;
  const notice = { ...input, purpose: 'payment_link', metadata: { original_message_type: type,
    notificationEventKey: 'invoice-followup:qa-sequence:day3' } };
  expect(await sendCustomerMessage(notice)).toMatchObject({ sent: true, channel: 'push' });
  expect(Twilio.sendSMS).toHaveBeenCalledWith(input.to, input.body, expect.objectContaining({
    explicitPushOnly: true, invoiceId: input.invoiceId, notificationEventKey: notice.metadata.notificationEventKey,
  }));
});

test.each(['payment_failed', 'autopay_charge_failed', 'autopay_retry_failed', 'autopay_retry_final_failed',
  'ach_retry_notice', 'ach_card_fallback', 'ach_suspended', 'bank_verification_incomplete', 'bank_verification_failed'])('Payment problems App choice routes %s with text disabled', async (type) => {
  prefs.payment_issue_channel = 'push';
  prefs.sms_enabled = false;
  expect(await sendCustomerMessage({ ...input, purpose: 'payment_failure',
    metadata: { original_message_type: type, notificationEventKey: 'payment-problem:attempt:qa' },
  })).toMatchObject({ sent: true, channel: 'push' });
  expect(Twilio.sendSMS).toHaveBeenCalledWith(input.to, input.body, expect.objectContaining({
    explicitPushOnly: true, notificationEventKey: 'payment-problem:attempt:qa',
  }));
});

test('invoice App choice retains operator Text and consent-checked fallback', async () => {
  prefs.invoice_channel = 'push';
  const notice = { ...input, purpose: 'payment_link', metadata: { original_message_type: 'invoice' } };
  await sendCustomerMessage({ ...notice, operatorInitiated: true });
  expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(false);
  prefs.sms_enabled = false;
  Twilio.sendSMS.mockResolvedValue({ success: false, appUnavailable: true, error: 'no_fresh_device' });
  expect(await sendCustomerMessage(notice)).toMatchObject({ sent: false, code: 'SMS_OPTED_OUT', requestedChannel: 'push' });
  expect(Twilio.sendSMS).toHaveBeenCalledTimes(2);
});

test('an unavailable invoice guard keeps a retry without falling back around the payer check', async () => {
  prefs.invoice_channel = 'push';
  Twilio.sendSMS.mockResolvedValue({ success: false, appRetryable: true, deliveryOutcome: 'not_sent', error: 'invoice_lookup_failed' });
  expect(await sendCustomerMessage({ ...input, purpose: 'payment_link', metadata: { original_message_type: 'invoice' } }))
    .toMatchObject({ sent: false, deliveryOutcome: 'not_sent', code: 'APP_DELIVERY_HOLD', retryable: true, deferred: true, nextAllowedAt: expect.any(String) });
  expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
});

test('temporary native failures retain their delay and never invoke a Text fallback', async () => {
  prefs.invoice_channel = 'push';
  Twilio.sendSMS.mockResolvedValue({ success: false, appRetryable: true, deliveryOutcome: 'uncertain', error: 'native_provider_retryable', retryAfterMs: 900000 });
  const startedAt = Date.now();
  const result = await sendCustomerMessage({ ...input, purpose: 'payment_link', metadata: { original_message_type: 'invoice' } });
  expect(result).toMatchObject({ sent: false, blocked: false, code: 'APP_PROVIDER_RETRY',
    deliveryOutcome: 'uncertain', retryable: true, deferred: true, retryAfterMs: 900000 });
  expect(new Date(result.nextAllowedAt).getTime()).toBeGreaterThanOrEqual(startedAt + 900000);
  expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
  expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(true);
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
  const unknown = await sendCustomerMessage(input);
  expect(unknown.code).toBe('SUPPRESSION_LOOKUP_FAILED');
  // Outside an explicit billing leg the App-first block stays terminal, as on main.
  expect(unknown.deferred).toBeUndefined();
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

describe.each([
  ['72h', 'service_reminder_72h_channel', 'service_reminder_72h', 'reminder_72h'],
  ['24h', 'service_reminder_24h_channel', 'service_reminder_24h', 'appointment_reminder'],
])('%s reminder App choice', (tier, channelColumn, enabledColumn, messageType) => {
  const reminder = { ...input, invoiceId: undefined, customerInitiated: false,
    appointmentId: '22222222-2222-4222-8222-222222222222',
    purpose: `appointment_reminder_${tier}`, body: 'Your appointment reminder is ready.',
    metadata: { original_message_type: messageType, useCustomerChannel: true },
  };
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2035-01-10T15:00:00Z'));
    prefs[channelColumn] = 'push';
    prefs[enabledColumn] = true;
  });
  afterEach(() => jest.useRealTimers());

  test('uses the app when texts are off and keeps a stable event key on retry', async () => {
    prefs.sms_enabled = false;
    expect(await sendCustomerMessage(reminder)).toMatchObject({ sent: true, channel: 'push' });
    expect(await sendCustomerMessage(reminder)).toMatchObject({ sent: true, channel: 'push' });
    const options = Twilio.sendSMS.mock.calls.map(([, , value]) => value);
    expect(options[0]).toMatchObject({ explicitPushOnly: true, notificationEventKey: expect.any(String) });
    expect(options[1].notificationEventKey).toBe(options[0].notificationEventKey);
    expect(prefs.sms_enabled).toBe(false);
  });

  test('keeps category opt-outs and quiet hours authoritative', async () => {
    prefs[enabledColumn] = false;
    expect(await sendCustomerMessage(reminder)).toMatchObject({ sent: false, code: 'PURPOSE_OPTED_OUT' });
    prefs[enabledColumn] = true;
    jest.setSystemTime(new Date('2035-01-10T02:00:00Z'));
    expect(await sendCustomerMessage(reminder)).toMatchObject({ sent: false, code: 'QUIET_HOURS_HOLD' });
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
  });

  test('falls back once when unavailable and does not replace a property contact text', async () => {
    Twilio.sendSMS.mockResolvedValueOnce({ success: false, appUnavailable: true, error: 'no_fresh_device' })
      .mockResolvedValue({ success: true, sid: 'SMreminder' });
    expect(await sendCustomerMessage(reminder)).toMatchObject({ sent: true, channel: 'sms', requestedChannel: 'push' });
    expect(Twilio.sendSMS.mock.calls[1][2]).toMatchObject({ explicitPushOnly: false, skipPushRouting: true });
    await sendCustomerMessage({ ...reminder, to: '+19415550143', identityTrustLevel: 'service_contact_authorized' });
    expect(Twilio.sendSMS.mock.calls[2][2].explicitPushOnly).toBe(false);
  });

  async function deliverReminder(sendOptions = {}, customerExtra = {}, channel = 'push') {
    const outcome = {};
    await AppointmentReminders._test.deliverAppointmentNotice({
      channel, kind: tier, customerId, scheduledServiceId: reminder.appointmentId,
      smsOutcome: outcome,
      smsAttempt: () => AppointmentReminders.safeSendAppointment(
        { id: customerId, phone: input.to, ...customerExtra }, prefs, () => reminder.body,
        messageType, reminder.purpose, { scheduled_service_id: reminder.appointmentId }, { ...sendOptions, expectedChannel: channel, sendOutcome: outcome },
      ),
    });
    return outcome;
  }

  test('a pending holder push defers contact texts until the reminder retry', async () => {
    const extra = { service_contact_phone: '+19415550143', service_contacts_consent_at: new Date() };
    Twilio.sendSMS.mockImplementation(async (to) => to === input.to
      ? { success: false, appPending: true } : { success: true, sid: 'SMcontact' });
    expect(await deliverReminder({}, extra)).toMatchObject({ blockedCode: 'PUSH_IN_FLIGHT' });
    expect(Twilio.sendSMS.mock.calls.map(([to]) => to)).toEqual([input.to]);
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
    Twilio.sendSMS.mockImplementation(async (to) => to === input.to
      ? { success: true, pushRouted: true, sid: 'push:reminder' } : { success: true, sid: 'SMcontact' });
    expect(await deliverReminder({}, extra)).toMatchObject({ providerAccepted: true });
    expect(Twilio.sendSMS.mock.calls.map(([to]) => to)).toEqual([input.to, input.to, extra.service_contact_phone]);
    expect(Twilio.sendSMS.mock.calls[0][2].notificationEventKey).toBe(Twilio.sendSMS.mock.calls[1][2].notificationEventKey);
  });

  test.each(['email', 'both'])('a switch to %s during push retries using the current channel', async (channel) => {
    Twilio.sendSMS.mockImplementationOnce(async () => {
      prefs[channelColumn] = channel;
      return { success: false, appUnavailable: true, error: 'preference_changed' };
    }).mockResolvedValue({ success: true, sid: 'SMreminder' });
    expect(await deliverReminder()).toMatchObject({ blockedCode: 'REMINDER_PREFERENCES_HOLD' });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
    await deliverReminder({}, {}, (await AppointmentReminders._test.getReminderPrefs(customerId))[`reminder${tier}Channel`]);
    expect(sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(channel === 'both' ? 2 : 1);
  });

  test('a stale App scan cannot text after the channel already changed to Both', async () => {
    prefs[channelColumn] = 'both';
    expect(await deliverReminder()).toMatchObject({ blockedCode: 'REMINDER_PREFERENCES_HOLD' });
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
  });

  test.each(['email_enabled', enabledColumn])('failed App delivery honors a %s opt-out made during the push', async (preference) => {
    prefs.sms_enabled = false;
    prefs.email_enabled = true;
    Twilio.sendSMS.mockImplementationOnce(async () => {
      prefs[preference] = false;
      return { success: false, appUnavailable: true, error: 'no_fresh_device' };
    });
    expect(await deliverReminder()).toMatchObject({ blockedCode: 'SMS_OPTED_OUT' });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
  });

  test('an unreadable preference during App failure cannot enable an email backup', async () => {
    Twilio.sendSMS.mockImplementationOnce(async () => {
      prefsError = true;
      return { success: false, appUnavailable: true, error: 'no_fresh_device' };
    });
    expect(await deliverReminder()).toMatchObject({ retryable: true });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
  });

  test('failed App delivery skips a landline text and uses an allowed email', async () => {
    readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'landline' });
    prefs.email_enabled = true;
    Twilio.sendSMS.mockResolvedValueOnce({ success: false, appUnavailable: true, error: 'no_fresh_device' })
      .mockResolvedValue({ success: true, sid: 'SMshould-not-send' });
    expect(await deliverReminder()).toMatchObject({ blockedCode: 'NON_MOBILE_SMS_RECIPIENT', fallbackEmailOk: true });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  });

  test('accepted App delivery reaches a landline owner without a text or email', async () => {
    readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'landline' });
    expect(await deliverReminder()).toMatchObject({ providerAccepted: true });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(true);
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
  });

  test('App delivery preserves the caller visit fence before any provider handoff', async () => {
    const preDispatchCheck = jest.fn(async () => ({ ok: false, code: 'MOVE_HOLD' }));
    expect(await deliverReminder({ preDispatchCheck })).toMatchObject({ blockedCode: 'MOVE_HOLD' });
    expect(preDispatchCheck).toHaveBeenCalledTimes(1);
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
  });

  test('a channel change before inner routing cannot text a landline', async () => {
    readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'landline' });
    const query = db.getMockImplementation();
    let reads = 0;
    db.mockImplementation((table) => {
      const q = query(table);
      if (table === 'notification_prefs') {
        const read = q.first;
        q.first = jest.fn(async () => {
          const row = await read();
          if (++reads === 1) prefs[channelColumn] = 'sms';
          return row;
        });
      }
      return q;
    });
    expect(await deliverReminder()).toMatchObject({ blockedCode: 'NON_MOBILE_SMS_RECIPIENT', fallbackEmailOk: true });
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
    expect(sendAppointmentReminderEmail).toHaveBeenCalledTimes(1);
  });

  test.each([...([false, true].flatMap(email => [false, true].map(gate => [email, gate, false]))), [false, false, true]])('a delayed App backup failure honors email_enabled=%s with App gate=%s and contact=%s', async (emailEnabled, appGateEnabled, serviceContact) => {
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = String(appGateEnabled);
    if (appGateEnabled) Twilio.sendSMS.mockResolvedValueOnce({ success: false, appUnavailable: true, error: 'no_fresh_device' });
    Twilio.sendSMS.mockResolvedValue({ success: true, sid: 'SMbackup' });
    const extra = serviceContact ? { service_contact_phone: '+19415550143', service_contacts_consent_at: new Date() } : {};
    if (serviceContact) Twilio.sendSMS.mockImplementation(async (to) => ({ success: true, sid: to === input.to ? 'SMprimary' : 'SMbackup' }));
    await deliverReminder({}, extra);
    const sentInput = persistAudit.mock.calls.at(-1)[0].input;
    expect(sentInput.metadata.requestedChannel).toBe('push');
    prefs.email_enabled = emailEnabled;
    const query = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = query(table);
      q.orderBy = jest.fn(() => q);
      if (table === 'messaging_audit_log') q.first = jest.fn(async () => ({
        channel: 'sms', purpose: sentInput.purpose, customer_id: customerId, metadata: sentInput.metadata,
      }));
      return q;
    });
    await AppointmentReminders.handleUndeliveredSms({ sid: 'SMbackup', status: 'undelivered', errorCode: '30003', to: extra.service_contact_phone || input.to });
    expect(sendAppointmentReminderEmail).toHaveBeenCalledTimes(emailEnabled ? 1 : 0);
  });

  test('an unreadable callback preference persists an office follow-up without emailing', async () => {
    Twilio.sendSMS.mockResolvedValueOnce({ success: false, appUnavailable: true, error: 'no_fresh_device' })
      .mockResolvedValue({ success: true, sid: 'SMbackup' });
    await deliverReminder();
    const sentInput = persistAudit.mock.calls.at(-1)[0].input;
    const query = db.getMockImplementation();
    prefsError = true;
    db.mockImplementation((table) => {
      const q = query(table);
      q.orderBy = jest.fn(() => q);
      if (table === 'messaging_audit_log') q.first = jest.fn(async () => ({
        channel: 'sms', purpose: sentInput.purpose, customer_id: customerId, metadata: sentInput.metadata,
      }));
      return q;
    });
    notifyAdmin.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'persisted-follow-up' });
    await AppointmentReminders.handleUndeliveredSms({ sid: 'SMbackup', status: 'undelivered', errorCode: '30003', to: input.to });
    expect(sendAppointmentReminderEmail).not.toHaveBeenCalled();
    expect(notifyAdmin).toHaveBeenCalledTimes(2);
    expect(notifyAdmin).toHaveBeenLastCalledWith('comms', expect.any(String), expect.stringContaining('email consent'), expect.objectContaining({
      bell: true, link: `/admin/customers/${customerId}`,
      metadata: { customerId, scheduledServiceId: reminder.appointmentId, kind: tier, reason: 'reminder_preferences_unavailable' },
    }));
  });
});

test('an emoji-bearing supported notice keeps its allowed SMS fallback and records why', async () => {
  Twilio.sendSMS.mockResolvedValue({ success: true, sid: 'SMemoji' });
  expect(await sendCustomerMessage({ ...input, body: 'Your receipt is ready ✅' })).toMatchObject({
    sent: true, channel: 'sms', requestedChannel: 'push', fallbackReason: 'push_body_unsupported',
  });
  expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
  expect(Twilio.sendSMS.mock.calls[0][2]).toMatchObject({ explicitPushOnly: false, skipPushRouting: true });
  prefs.sms_enabled = false;
  expect(await sendCustomerMessage({ ...input, body: 'Your receipt is ready ✅' })).toMatchObject({ sent: false, code: 'SMS_OPTED_OUT' });
});


test.each(['no_fresh_device', 'preference_changed', 'app_gate_off'])('App-only request updates never become a text on %s', async (reason) => {
  prefs.sms_enabled = false;
  Twilio.sendSMS.mockResolvedValueOnce({ success: false, appUnavailable: true, error: reason });
  const result = await sendCustomerMessage({ ...input, purpose: 'support_resolution',
    metadata: { appOnly: true, original_message_type: 'service_request_updated' } });
  expect(result).toMatchObject({ sent: false, blocked: true, code: 'APP_UNAVAILABLE' });
  expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
  expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(true);
});

test('request delivery forwards the queued status and transition identity to the final App guard', async () => {
  const notificationEventKey = 'request:request-1:updated:transition-1';
  expect(await sendCustomerMessage({ ...input, purpose: 'support_resolution', metadata: {
    appOnly: true, original_message_type: 'service_request_updated',
    service_request_id: 'request-1', request_status: 'acknowledged', request_status_version: 1, notificationEventKey,
  } })).toMatchObject({ sent: true, channel: 'push' });
  expect(Twilio.sendSMS.mock.calls[0][2]).toMatchObject({ explicitPushOnly: true,
    requestNotification: { id: 'request-1', status: 'acknowledged', version: 1 }, notificationEventKey });
});

describe('explicit billing channel combinations', () => {
  const combinations = [
    ['email'], ['sms'], ['push'], ['email', 'sms'],
    ['email', 'push'], ['sms', 'push'], ['email', 'sms', 'push'],
  ];
  beforeEach(() => {
    Twilio.sendSMS.mockImplementation(async (_to, _body, options) => ({
      success: true, deliveryOutcome: 'accepted', sid: options.explicitPushOnly ? 'push:billing-qa' : `SM${'1'.repeat(32)}`,
      pushRouted: options.explicitPushOnly,
    }));
  });

  describe.each([
    ['invoice', 'payment_link', 'invoice_channels'],
    ['payment_failed', 'payment_failure', 'payment_issue_channels'],
    ['billing_reminder', 'billing', 'billing_channels'],
    ['receipt', 'payment_receipt', 'payment_receipt_channels'],
  ])('%s', (type, purpose, column) => {
    test.each(combinations.map((channels) => [channels.join('+'), channels]))('%s sends precisely those channels', async (_name, channels) => {
      prefs[column] = channels;
      const result = await sendCustomerMessage({ ...input, purpose,
        metadata: { original_message_type: type, notificationEventKey: 'qa:billing:combination' } });
      expect(result).toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
      // sendCustomerMessage returns dispatchBillingChannels's outcome
      // directly (pre-push audit P1 on #4843) — the persisted key survives
      // the whole fan-out unchanged, ready for a producer to re-persist.
      expect(result.notificationEventKey).toBe('qa:billing:combination');
      expect(Object.keys(result.channelResults).sort()).toEqual([...channels].sort());
      expect(sendBillingChannelEmail).toHaveBeenCalledTimes(channels.includes('email') ? 1 : 0);
      const calls = Twilio.sendSMS.mock.calls;
      expect(calls.filter(([, , options]) => options.explicitPushOnly)).toHaveLength(channels.includes('push') ? 1 : 0);
      expect(calls.filter(([, , options]) => !options.explicitPushOnly)).toHaveLength(channels.includes('sms') ? 1 : 0);
      expect(calls.every(([, , options]) => options.skipPushRouting === true)).toBe(true);
    });
  });

  test('Email and App still work when Text is opted out, without resetting consent', async () => {
    prefs.payment_receipt_channels = ['email', 'sms', 'push'];
    prefs.sms_enabled = false;
    prefs.payment_confirmation_sms = false;
    const result = await sendCustomerMessage(input);
    expect(result.channelResults).toMatchObject({ email: { sent: true }, push: { sent: true }, sms: { sent: false, code: 'SMS_OPTED_OUT' } });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(prefs.sms_enabled).toBe(false);
  });

  test('a disabled email leg does not prevent the selected text', async () => {
    prefs.payment_receipt_channels = ['email', 'sms'];
    prefs.email_enabled = false;
    const result = await sendCustomerMessage(input);
    expect(result.channelResults).toMatchObject({ email: { sent: false, code: 'EMAIL_OPTED_OUT' }, sms: { sent: true } });
    expect(sendBillingChannelEmail).not.toHaveBeenCalled();
  });

  test('an unresolved phone-keyed suppression read fails CLOSED for Email, same as App (finding A)', async () => {
    // checkSuppression only consults the phone-keyed messaging_suppression
    // table — the ONLY place manual_dnc / opt_out live. The billing email
    // authority's own suppression recheck only ever consults the
    // email-template suppression store, never this one, so a transient read
    // failure here must fail closed for Email exactly like it already does
    // for App, or a DB blip lets a manual_dnc / opt-out recipient through on
    // the Email leg.
    prefs.payment_receipt_channels = ['email'];
    suppressionError = true;
    const result = await sendCustomerMessage(input);
    expect(result.channelResults.email).toMatchObject({ sent: false, code: 'SUPPRESSION_LOOKUP_FAILED' });
    expect(sendBillingChannelEmail).not.toHaveBeenCalled();
    // A one-shot producer must be able to queue it: a schedulable hold, not a drop.
    expect(result).toMatchObject({ sent: false, code: 'SUPPRESSION_LOOKUP_FAILED', deferred: true, retryable: true,
      deliveryOutcome: 'not_sent', nextAllowedAt: expect.any(String) });
    expect(require('../services/messaging/billing-channel-routing').isReplayHold(result)).toBe(true);
  });

  test('a suppression lookup failure holds the selected App leg and defers the Text leg with the notice instead of sending it alone', async () => {
    // App fails closed on unknown suppression (requiresVerifiedSuppression);
    // the hold stops later legs so the replay cannot duplicate a Text sent now.
    prefs.payment_receipt_channels = ['push', 'sms'];
    suppressionError = true;
    const result = await sendCustomerMessage(input);
    expect(result.channelResults.push).toMatchObject({ sent: false, code: 'SUPPRESSION_LOOKUP_FAILED', deferred: true });
    expect(result.channelResults.sms).toBeUndefined();
    expect(result).toMatchObject({ code: 'SUPPRESSION_LOOKUP_FAILED', deferred: true, retryable: true });
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
  });


  test('an operator-initiated send stays on the plain Text path even when the customer has an explicit multi-channel billing selection on file', async () => {
    // isBillingDeliveryCandidate excludes operatorInitiated sends (unless
    // useCustomerChannel is set) — a staff-composed billing text must never
    // silently expand into an Email+App+Text fan-out just because the
    // customer separately picked several delivery channels for automated
    // billing notices.
    prefs.payment_receipt_channels = ['email', 'push', 'sms'];
    const result = await sendCustomerMessage({ ...input, operatorInitiated: true });
    expect(result.channelResults).toBeUndefined();
    expect(sendBillingChannelEmail).not.toHaveBeenCalled();
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(false);
  });

  test('with no explicit billing channel arrays on the preferences row, the fan-out is never invoked (gate-off / legacy shape, byte-identical to origin/main)', async () => {
    // Prod carries zero non-null billing channel arrays while
    // GATE_BILLING_NOTIFICATION_CHANNELS is off — this is that exact shape.
    // Assert it directly against the router entry point rather than only
    // inferring it from the outcome, so a future change that starts calling
    // dispatchBillingChannels on a legacy row (even if it happens to still
    // return the same single-channel outcome) is caught.
    const BillingRouting = require('../services/messaging/billing-channel-routing');
    const dispatchSpy = jest.spyOn(BillingRouting, 'dispatchBillingChannels');
    try {
      prefs = { payment_receipt_channel: 'push', payment_receipt: true, sms_enabled: true, payment_confirmation_sms: true };
      const result = await sendCustomerMessage(input);
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(result.channelResults).toBeUndefined();
      expect(result).toMatchObject({ sent: true, channel: 'push' });
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  test('the app gate being off makes an explicit App-only billing leg a terminal APP_UNAVAILABLE, not the schedulable preference-change hold', async () => {
    // attemptPushFirst returns reason:'app_gate_off' distinctly from
    // reason:'preference_changed' — only the latter is remapped to the
    // schedulable BILLING_PREFERENCES_CHANGED hold. A dark app gate must
    // stay a plain terminal refusal (a producer should not keep retrying a
    // notice against a gate that is simply off).
    prefs.payment_receipt_channels = ['push'];
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'false';
    Twilio.sendSMS.mockResolvedValue({ success: false, appUnavailable: true, error: 'app_gate_off' });
    const result = await sendCustomerMessage(input);
    expect(result.channelResults.push).toMatchObject({ sent: false, blocked: true, code: 'APP_UNAVAILABLE' });
    expect(result.channelResults.push.deferred).not.toBe(true);
    expect(result.channelResults.push.code).not.toBe('BILLING_PREFERENCES_CHANGED');
  });

  test('the ACH processing acknowledgment stays on its legacy path even with explicit choices on file', async () => {
    const { billingDeliveryCategory } = require('../services/messaging/billing-channel-routing');
    expect(billingDeliveryCategory({ purpose: 'payment_failure', metadata: { original_message_type: 'ach_payment_processing' } }))
      .toBeNull();
    prefs.payment_issue_channels = ['email', 'sms'];
    prefs.payment_receipt_channels = ['email', 'sms'];
    const result = await sendCustomerMessage({ ...input, purpose: 'payment_failure',
      metadata: { original_message_type: 'ach_payment_processing' } });
    expect(result.channelResults).toBeUndefined();
    expect(sendBillingChannelEmail).not.toHaveBeenCalled();
  });

  test('an explicit channel selection with no recognized channel (empty array, or only unrecognized values) selects nothing and never calls a provider', async () => {
    // Defense in depth: the preferences API's Joi schema enforces
    // .min(1) on every billing channel array, so this should be
    // unreachable through the normal write path — but the router itself
    // must still fail safely (blocked, no provider call) rather than
    // silently falling back to some default channel if a row is ever
    // written some other way (backfill, direct DB edit, a future writer).
    const { dispatchBillingChannels } = require('../services/messaging/billing-channel-routing');
    const sendLeg = jest.fn();
    for (const channels of [[], ['carrier_pigeon']]) {
      const result = await dispatchBillingChannels(input, { payment_receipt_channels: channels }, sendLeg);
      expect(sendLeg).not.toHaveBeenCalled();
      expect(result).toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', channelResults: {},
        code: 'NO_BILLING_CHANNEL_SELECTED' });
    }
    // Email selected but owned by the caller's own sender stays CHANNEL_EMAIL_ONLY,
    // which invoice.js relies on to send that email itself.
    await expect(dispatchBillingChannels({ ...input, hasEmailLeg: true }, { payment_receipt_channels: ['email'] }, sendLeg))
      .resolves.toMatchObject({ code: 'CHANNEL_EMAIL_ONLY' });
    expect(sendLeg).not.toHaveBeenCalled();
  });

  test.each([['push'], ['email', 'push']])('unavailable App never creates an unselected text: %j', async (...channels) => {
    prefs.payment_receipt_channels = channels;
    Twilio.sendSMS.mockResolvedValue({ success: false, appUnavailable: true, error: 'no_fresh_device' });
    const result = await sendCustomerMessage(input);
    expect(result.channelResults.push).toMatchObject({ sent: false, code: 'APP_UNAVAILABLE' });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(true);
  });

  test('a mid-dispatch App preference change is a schedulable hold, not a terminal APP_UNAVAILABLE (finding D; Codex r3 P1 on #4843)', async () => {
    // pushEligibleRuntime's late re-read (push-channel-routing.js) can catch
    // a switch away from App that landed after this leg was selected — the
    // SAME race the consent layer's BILLING_PREFERENCES_CHANGED/
    // CHANNEL_NOT_SELECTED refusals cover for Email/Text. It must get the
    // identical SCHEDULABLE hold (ONE code, deferred + nextAllowedAt, via the
    // shared preferenceChangeHold() helper) so the caller's retry re-fans-out
    // under the same notificationEventKey, instead of a dead-end terminal
    // APP_UNAVAILABLE that drops the event.
    prefs.payment_receipt_channels = ['push'];
    Twilio.sendSMS.mockResolvedValue({ success: false, appUnavailable: true, error: 'preference_changed' });
    const result = await sendCustomerMessage(input);
    expect(result.channelResults.push).toMatchObject({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'BILLING_PREFERENCES_CHANGED',
      deferred: true, retryable: true, nextAllowedAt: expect.any(String),
    });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
  });

  test('a provider failure does not prevent the other selected channels', async () => {
    prefs.payment_receipt_channels = ['email', 'sms', 'push'];
    sendBillingChannelEmail.mockRejectedValue(new Error('email unavailable'));
    const result = await sendCustomerMessage(input);
    expect(result).toMatchObject({ sent: true, deliveryOutcome: 'accepted', channel: 'sms' });
    expect(result.channelResults.email).toMatchObject({ sent: false, retryable: true });
    expect(result.channelResults.push.sent).toBe(true);
  });

  test('an accepted email preserves the selected overnight text deferral', async () => {
    prefs.payment_receipt_channels = ['email', 'sms'];
    jest.useFakeTimers().setSystemTime(new Date('2035-01-10T02:00:00Z'));
    try {
      const result = await sendCustomerMessage({ ...input, customerInitiated: false });
      expect(result).toMatchObject({ sent: false, deferred: true, code: 'QUIET_HOURS_HOLD', nextAllowedAt: expect.any(String) });
      expect(result.channelResults.email).toMatchObject({ sent: true, deliveryOutcome: 'accepted' });
      expect(Twilio.sendSMS).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  test('a failing email provider does not hold back an available selected text', async () => {
    prefs.payment_receipt_channels = ['email', 'sms'];
    sendBillingChannelEmail.mockResolvedValue({ sent: false, provider: 'email',
      deliveryOutcome: 'not_sent', retryable: true, error: 'provider unavailable' });
    const result = await sendCustomerMessage(input);
    expect(result).toMatchObject({ sent: true, channel: 'sms', deliveryOutcome: 'accepted' });
    expect(result.channelResults.email).toMatchObject({ sent: false, retryable: true });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
  });

  test('an email-only selection whose provider returns a retryable failure surfaces the raw retryable leg outcome', async () => {
    // With no other selected leg to mask it, a retryable provider failure on
    // the only channel is returned as-is: sent:false, retryable:true, the
    // leg's own not_sent/code.
    prefs.payment_receipt_channels = ['email'];
    sendBillingChannelEmail.mockResolvedValue({ sent: false, provider: 'email',
      deliveryOutcome: 'not_sent', retryable: true, code: 'PROVIDER_FAILURE', error: 'provider unavailable' });
    const result = await sendCustomerMessage(input);
    expect(result).toMatchObject({
      sent: false, retryable: true, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE',
      channelResults: { email: { sent: false, code: 'PROVIDER_FAILURE' } },
    });
  });

  test('a deferred App leg holds Text until replay, so an accepted text cannot be duplicated', async () => {
    prefs.payment_receipt_channels = ['sms', 'push'];
    Twilio.sendSMS.mockResolvedValue({ success: false, appPending: true });
    const result = await sendCustomerMessage(input);
    expect(result).toMatchObject({ sent: false, deferred: true, code: 'PUSH_IN_FLIGHT' });
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(true);
  });

  test('only the final selected Text carries proof that the whole scheduled row was delivered', async () => {
    prefs.payment_receipt_channels = ['sms', 'push'];
    await sendCustomerMessage({ ...input, metadata: { ...input.metadata,
      scheduled_sms_log_id: 'queue-1', notificationEventKey: 'receipt:queue-1' } });
    const appOptions = Twilio.sendSMS.mock.calls.find(([, , options]) => options.explicitPushOnly)[2];
    const textOptions = Twilio.sendSMS.mock.calls.find(([, , options]) => !options.explicitPushOnly)[2];
    expect(appOptions.scheduledSmsLogId).toBeUndefined();
    expect(appOptions.notificationEventKey).toBe('receipt:queue-1');
    expect(textOptions.scheduledSmsLogId).toBe('queue-1');
  });

  test('App acceptance cannot settle a selected Text that still needs retry', async () => {
    // An unfinished/retryable Text leg outranks App's own acceptance — the
    // top-level outcome carries the Text leg's own raw code, and each leg's
    // own channelResults entry is untouched.
    const { dispatchBillingChannels } = require('../services/messaging/billing-channel-routing');
    const result = await dispatchBillingChannels(input, { payment_receipt_channels: ['sms', 'push'] }, async (leg) =>
      leg.metadata.billingDeliveryLeg === 'push'
        ? { sent: true, deliveryOutcome: 'accepted', channel: 'push' }
        : { sent: false, deliveryOutcome: 'not_sent', retryable: true, code: 'TEXT_PROVIDER_RETRY' });
    expect(result).toMatchObject({
      sent: false, retryable: true, deliveryOutcome: 'not_sent', code: 'TEXT_PROVIDER_RETRY',
      channelResults: { push: { sent: true }, sms: { sent: false, code: 'TEXT_PROVIDER_RETRY' } },
    });
  });

  test('an earlier Email failure cannot hide uncertain Text delivery', async () => {
    // An `uncertain` outcome (delivery unproven) is never auto-converted
    // into a replay — the code stays exactly what the leg returned.
    const { dispatchBillingChannels } = require('../services/messaging/billing-channel-routing');
    const result = await dispatchBillingChannels(input, { payment_receipt_channels: ['email', 'sms'] }, async (leg) =>
      leg.metadata.billingDeliveryLeg === 'email'
        ? { sent: false, deliveryOutcome: 'not_sent', retryable: true, code: 'BILLING_EMAIL_PREPARATION_FAILED' }
        : { sent: false, deliveryOutcome: 'uncertain', retryable: true, code: 'TEXT_OUTCOME_UNCERTAIN' });
    expect(result).toMatchObject({ sent: false, retryable: true, deliveryOutcome: 'uncertain', code: 'TEXT_OUTCOME_UNCERTAIN' });
    expect(result.originalCode).toBeUndefined();
  });

  test('App proof cannot settle an Email leg that still needs retry', async () => {
    prefs.payment_receipt_channels = ['email', 'push'];
    sendBillingChannelEmail.mockResolvedValue({ sent: false, provider: 'email',
      deliveryOutcome: 'not_sent', retryable: true, error: 'provider unavailable' });
    const result = await sendCustomerMessage({ ...input, metadata: { ...input.metadata,
      scheduled_sms_log_id: 'queue-1', notificationEventKey: 'receipt:queue-1' } });
    expect(result).toMatchObject({ sent: false, retryable: true,
      channelResults: { email: { sent: false }, push: { sent: true } } });
    const appOptions = Twilio.sendSMS.mock.calls[0][2];
    expect(appOptions.scheduledSmsLogId).toBeUndefined();
    expect(appOptions.notificationEventKey).toBe('receipt:queue-1');
  });

  test.each(['balance_reminder', 'annual_prepay_payment_reminder'])(
    "%s is classified as 'billing' so it honors the Billing Reminder Delivery channel (Codex r1 P1 on #4843)",
    (originalMessageType) => {
      const { billingDeliveryCategory, BILLING_MESSAGE_CATEGORIES } = require('../services/messaging/billing-channel-routing');
      expect(BILLING_MESSAGE_CATEGORIES[originalMessageType]).toBe('billing');
      expect(billingDeliveryCategory({
        purpose: 'payment_link',
        metadata: { original_message_type: originalMessageType },
      })).toBe('billing');
    },
  );

  test('separate payments with identical receipt copy have separate event identities', () => {
    const { billingNotificationEventKey } = require('../services/messaging/billing-channel-routing');
    expect(billingNotificationEventKey({ ...input, paymentId: 'payment-one' }))
      .not.toBe(billingNotificationEventKey({ ...input, paymentId: 'payment-two' }));
  });

  test('numeric event ids hash like their string form', () => {
    const { billingNotificationEventKey } = require('../services/messaging/billing-channel-routing');
    const numeric = { ...input, metadata: { ...input.metadata, scheduled_sms_log_id: 4242 } };
    expect(billingNotificationEventKey(numeric)).toBe(billingNotificationEventKey({
      ...input, metadata: { ...input.metadata, scheduled_sms_log_id: '4242' },
    }));
  });

  test('with no event or entity id, an identical body on two different ET days gets different keys (Codex r1 P1 on #4843)', () => {
    // Without an eventId, a recurring identical reminder (e.g. payment_expiry
    // repeated 30 days later) used to hash on body alone and dedupe forever.
    const { billingNotificationEventKey } = require('../services/messaging/billing-channel-routing');
    const noEventId = { customerId: 'cust-1', body: 'Your card on file could not be charged.',
      purpose: 'payment_failure', metadata: { original_message_type: 'payment_expiry' } };
    jest.useFakeTimers().setSystemTime(new Date('2026-01-05T12:00:00-05:00'));
    const day1 = billingNotificationEventKey(noEventId);
    jest.setSystemTime(new Date('2026-01-05T23:59:00-05:00'));
    const day1Again = billingNotificationEventKey(noEventId);
    jest.setSystemTime(new Date('2026-02-04T12:00:00-05:00'));
    const day2 = billingNotificationEventKey(noEventId);
    jest.useRealTimers();
    expect(day1).toBe(day1Again);
    expect(day1).not.toBe(day2);
  });

  test('an explicit eventId or notificationEventKey is unaffected by the ET day (no drift for real events)', () => {
    const { billingNotificationEventKey } = require('../services/messaging/billing-channel-routing');
    const withEventId = { customerId: 'cust-1', body: 'x', purpose: 'payment_failure',
      metadata: { original_message_type: 'payment_expiry', stripe_event_id: 'evt_1' } };
    jest.useFakeTimers().setSystemTime(new Date('2026-01-05T12:00:00-05:00'));
    const day1 = billingNotificationEventKey(withEventId);
    jest.setSystemTime(new Date('2026-02-04T12:00:00-05:00'));
    const day2 = billingNotificationEventKey(withEventId);
    jest.useRealTimers();
    expect(day1).toBe(day2);
    const explicitKey = { ...withEventId, metadata: { ...withEventId.metadata, notificationEventKey: 'stable-key' } };
    expect(billingNotificationEventKey(explicitKey)).toBe('stable-key');
  });

  test('a producer that persists the fan-out key on its queued replay row dedupes against the SAME identity on replay; one that does not gets a DIFFERENT (resend-causing) key (pre-push audit P1 on #4843)', () => {
    const { dispatchBillingChannels, billingNotificationEventKey } = require('../services/messaging/billing-channel-routing');
    // No eventId (stripe_event_id / attempt_payment_id / payment_id) on the
    // original attempt — the identity falls back to invoiceId + ET day +
    // body, matching a producer send with no upfront notificationEventKey.
    const originalInput = { ...input, purpose: 'payment_failure',
      metadata: { original_message_type: 'receipt' } };

    // 1. The immediate attempt's own fan-out generates and returns a key —
    //    this is what a producer (stripe-webhook.js et al.) must persist in
    //    its queued sms_log row's metadata when the fan-out defers.
    const originalKey = billingNotificationEventKey(originalInput);
    expect(originalKey).toEqual(expect.any(String));

    // 2. FIXED producer: persists notificationEventKey in the queued row.
    //    scheduler.js's replay carries it forward as
    //    metadata.notificationEventKey alongside the row's own
    //    scheduled_sms_log_id (server/services/scheduler.js ~4077) — the
    //    persisted key wins (checked first), so the replay's identity is
    //    UNCHANGED from the original attempt: an already-accepted Email leg
    //    is recognized as already-sent, not resent.
    const replayWithPersistedKey = { ...originalInput, metadata: { ...originalInput.metadata,
      scheduled_sms_log_id: 'sms-log-row-99', notificationEventKey: originalKey } };
    expect(billingNotificationEventKey(replayWithPersistedKey)).toBe(originalKey);

    // 3. BUGGY producer (pre-fix): never persisted the key. The replay's
    //    metadata carries scheduled_sms_log_id but no notificationEventKey,
    //    so billingNotificationEventKey hashes the row id instead — a
    //    DIFFERENT key from the original attempt, which would read an
    //    already-accepted leg as a brand-new, unsent notification.
    const replayWithoutPersistedKey = { ...originalInput, metadata: { ...originalInput.metadata,
      scheduled_sms_log_id: 'sms-log-row-99' } };
    expect(billingNotificationEventKey(replayWithoutPersistedKey)).not.toBe(originalKey);

    // 4. dispatchBillingChannels itself stamps this exact key on its
    //    outcome for every leg configuration, so a producer never has to
    //    re-derive it by hand.
    return dispatchBillingChannels(originalInput, { payment_receipt_channels: ['sms', 'email'] },
      async () => ({ sent: true, deliveryOutcome: 'accepted' })).then((result) => {
      expect(result.notificationEventKey).toBe(originalKey);
    });
  });

  test('unlisted receipt types forward their saved billing category to the App provider', async () => {
    prefs.payment_receipt_channels = ['push'];
    expect(await sendCustomerMessage({ ...input, metadata: { original_message_type: 'autopay_charge_success' } }))
      .toMatchObject({ sent: true, channel: 'push' });
    expect(Twilio.sendSMS.mock.calls[0][2].billingDeliveryCategory).toBe('payment_receipt');
    const { pushEligibleRuntime } = require('../services/messaging/push-channel-routing')._test;
    expect(await pushEligibleRuntime(customerId, input.to, 'autopay_charge_success', db, {
      requireExplicit: true, billingDeliveryCategory: 'payment_receipt',
    })).toBe(true);
  });

  test('a real email sidecar owns Email and does not get a generic duplicate', async () => {
    prefs.payment_receipt_channels = ['email'];
    const withHasEmailLeg = { ...input, hasEmailLeg: true };
    const result = await sendCustomerMessage(withHasEmailLeg);
    expect(result).toMatchObject({ sent: false, code: 'CHANNEL_EMAIL_ONLY' });
    expect(sendBillingChannelEmail).not.toHaveBeenCalled();
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
    // Structural fix (pre-push audit P1 on #4843): notificationEventKey
    // rides along on EVERY outcome dispatchBillingChannels returns,
    // including this zero-selected-legs refusal — a producer that enqueues
    // its own replay row off this outcome must be able to read the key
    // even when no leg actually ran.
    const { billingNotificationEventKey } = require('../services/messaging/billing-channel-routing');
    expect(result.notificationEventKey).toBe(billingNotificationEventKey(withHasEmailLeg));
    expect(result.notificationEventKey).toEqual(expect.any(String));
  });

  test('an invoice App leg retains the invoice lock around its provider handoff', async () => {
    prefs.invoice_channels = ['push'];
    const withProviderHandoff = jest.fn(async dispatch => dispatch());
    const result = await sendCustomerMessage({ ...input, purpose: 'payment_link',
      entryPoint: 'invoice_send_via_sms', hasEmailLeg: true, withProviderHandoff,
      metadata: { original_message_type: 'invoice' } });
    expect(result).toMatchObject({ sent: true, channel: 'push' });
    expect(withProviderHandoff).toHaveBeenCalledTimes(1);
    expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(true);
  });

  test('fresh channel changes are enforced at the provider boundary (Codex r3 P1 on #4843: schedulable hold)', async () => {
    prefs.payment_receipt_channels = ['sms'];
    Twilio.sendSMS.mockImplementation(async (_to, _body, options) => {
      prefs.payment_receipt_channels = ['email'];
      const verdict = await options.preSendCheck();
      expect(verdict).toMatchObject({ ok: false, code: 'BILLING_PREFERENCES_CHANGED', deferred: true, nextAllowedAt: expect.any(String) });
      return { success: false, preSendBlocked: true, code: verdict.code, error: verdict.reason };
    });
    const result = await sendCustomerMessage(input);
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'BILLING_PREFERENCES_CHANGED' });
    // The boundary block carries the real consent verdict's deferred/nextAllowedAt
    // through, independent of what the Twilio adapter mock itself forwards.
    expect(result.deferred).toBe(true);
    expect(result.nextAllowedAt).toEqual(expect.any(String));
  });

  test('a mid-dispatch preference change makes the Text leg a schedulable hold, not terminal (Codex r1 P1, updated r3 P1, on #4843)', async () => {
    // Same race as above, but forwarding the boundary verdict's `retryable`
    // flag the way the real Twilio adapter does — the caller's retry must
    // re-run the fan-out under the same notificationEventKey rather than
    // treating the customer's mid-dispatch channel change as a dead end.
    prefs.payment_receipt_channels = ['sms'];
    Twilio.sendSMS.mockImplementation(async (_to, _body, options) => {
      prefs.payment_receipt_channels = ['email'];
      const verdict = await options.preSendCheck();
      expect(verdict).toMatchObject({ ok: false, code: 'BILLING_PREFERENCES_CHANGED', retryable: true, deferred: true });
      return { success: false, preSendBlocked: true, code: verdict.code, error: verdict.reason, retryable: verdict.retryable };
    });
    expect(await sendCustomerMessage(input)).toMatchObject({
      sent: false, blocked: true, code: 'BILLING_PREFERENCES_CHANGED', retryable: true, deferred: true, nextAllowedAt: expect.any(String),
    });
  });

  test('an accepted Email cannot hide a Text leg refused by a mid-dispatch preference change', async () => {
    // billingDispatchOutcome precedence: an unfinished/refused Text
    // outranks an earlier acceptance so the caller retries it — the
    // retryable CHANNEL_NOT_SELECTED refusal must not be masked by Email
    // already having gone out. The top-level outcome carries the Text leg's
    // own raw code; the per-leg channelResults entry is untouched.
    const { dispatchBillingChannels } = require('../services/messaging/billing-channel-routing');
    const result = await dispatchBillingChannels(input, { payment_receipt_channels: ['email', 'sms'] }, async (leg) =>
      leg.metadata.billingDeliveryLeg === 'sms'
        ? { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CHANNEL_NOT_SELECTED',
          reason: 'Recipient has not selected this billing delivery channel', retryable: true }
        : { sent: true, deliveryOutcome: 'accepted', channel: 'email' });
    expect(result).toMatchObject({
      sent: false, retryable: true, deliveryOutcome: 'not_sent', code: 'CHANNEL_NOT_SELECTED',
      channelResults: { email: { sent: true }, sms: { sent: false, code: 'CHANNEL_NOT_SELECTED' } },
    });
  });

  test('billing choices cannot copy a secondary contact’s text to the account holder', async () => {
    prefs.payment_receipt_channels = ['email', 'sms', 'push'];
    await sendCustomerMessage({ ...input, to: '+19415550143' });
    expect(sendBillingChannelEmail).not.toHaveBeenCalled();
    expect(Twilio.sendSMS).toHaveBeenCalledTimes(1);
    expect(Twilio.sendSMS.mock.calls[0][2].explicitPushOnly).toBe(false);
  });

  test('Email works from the verified customer id when no phone recipient exists', async () => {
    prefs.payment_receipt_channels = ['email'];
    customerPhone = null;
    const result = await sendCustomerMessage({ ...input, to: null });
    expect(result.channelResults).toMatchObject({ email: { sent: true, deliveryOutcome: 'accepted' } });
    expect(sendBillingChannelEmail).toHaveBeenCalledTimes(1);
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
  });

  test('App works from the verified customer id when no phone recipient exists', async () => {
    prefs.payment_receipt_channels = ['push'];
    customerPhone = null;
    const result = await sendCustomerMessage({ ...input, to: null });
    expect(result.channelResults).toMatchObject({ push: { sent: true, deliveryOutcome: 'accepted' } });
    expect(Twilio.sendSMS).toHaveBeenCalledWith(null, input.body, expect.objectContaining({ explicitPushOnly: true }));
    expect(sendBillingChannelEmail).not.toHaveBeenCalled();
  });

  test('the withheld-link rewrite reaches the recursive App leg, not just the SMS-shaped pass (finding C)', async () => {
    // Only the top-level call still has channel:'sms' when the withheld-link
    // rewrite block runs — the recursive App leg's OWN sendCustomerMessageCore
    // call has already flipped sendInput.channel to 'push' by then, so it
    // never re-runs the rewrite itself. Without carrying the rewritten
    // body/cleared estimateId into the fan-out, the App leg would still
    // carry the original estimateId into annualOfferGuardVerdict and refuse
    // an owed receipt whose offer is withheld.
    prefs.payment_receipt_channels = ['push'];
    const AnnualGuard = require('../services/estimate-annual-guard');
    const rewrittenBody = 'Your deposit was received — view your receipt in the Waves app.';
    const rewriteSpy = jest.spyOn(AnnualGuard, 'rewriteWithheldEstimateLinks')
      .mockResolvedValue({ text: rewrittenBody, rewrittenIds: ['est-1'] });
    try {
      const result = await sendCustomerMessage({
        ...input,
        estimateId: 'est-1',
        body: 'Your deposit was received. https://portal.wavespestcontrol.com/estimate/abcdefghijklmnop',
      });
      expect(result.channelResults.push).toMatchObject({ sent: true });
      // Codex r3 P1 on #4843: the App leg no longer carries the SMS phone
      // snapshot — it identifies its recipient by the verified customerId,
      // so a mid-dispatch phone change on Email/App legs can't misfire
      // BILLING_RECIPIENT_CHANGED.
      expect(Twilio.sendSMS).toHaveBeenCalledWith(
        null,
        rewrittenBody,
        expect.objectContaining({ explicitPushOnly: true, estimateId: null, estimateIds: [] }),
      );
    } finally {
      rewriteSpy.mockRestore();
    }
  });

  test('a phone change mid-dispatch never blocks Email/App; the Text leg still refuses/rechecks per existing rules (Codex r3 P1 on #4843)', async () => {
    // The top-level fan-out decision already verified input.to belongs to
    // the account holder before dispatchBillingChannels ever ran. Email and
    // App no longer carry that phone snapshot into their own legs (P1 B), so
    // a phone change landing mid-dispatch can't misfire their fresh
    // usesBillingDeliveryPreferences recheck — only Text, which still needs
    // a real phone, is exposed to the race, and it keeps its existing
    // terminal BILLING_RECIPIENT_CHANGED refusal (unaffected by this fix).
    prefs.payment_receipt_channels = ['email', 'push', 'sms'];
    Twilio.sendSMS.mockImplementation(async (_to, _body, options) => {
      if (options.explicitPushOnly) {
        // Mutate AFTER the App leg's own dispatch reached the provider —
        // by the time the Text leg (dispatched last) reloads contact state,
        // it sees a different customer phone than the one it still carries.
        customerPhone = '+19415559999';
        return { success: true, deliveryOutcome: 'accepted', sid: 'push:billing-qa', pushRouted: true };
      }
      return { success: true, deliveryOutcome: 'accepted', sid: `SM${'1'.repeat(32)}` };
    });
    const result = await sendCustomerMessage(input);
    expect(result.channelResults.email).toMatchObject({ sent: true });
    expect(result.channelResults.push).toMatchObject({ sent: true });
    expect(result.channelResults.sms).toMatchObject({ sent: false, code: 'BILLING_RECIPIENT_CHANGED' });
  });

  test('a missing phone suppresses only the selected Text leg', async () => {
    prefs.payment_receipt_channels = ['email', 'sms'];
    customerPhone = null;
    const result = await sendCustomerMessage({ ...input, to: '' });
    expect(result.channelResults).toMatchObject({
      email: { sent: true },
      sms: { sent: false, blocked: true, code: 'MISSING_SMS_RECIPIENT' },
    });
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
  });

  test('a no-phone Text-only choice is suppressed without fabricating a destination', async () => {
    prefs.payment_receipt_channels = ['sms'];
    customerPhone = null;
    const result = await sendCustomerMessage({ ...input, to: null });
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'MISSING_SMS_RECIPIENT' });
    expect(sendBillingChannelEmail).not.toHaveBeenCalled();
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
  });

  test('a no-phone legacy billing row fails safely before any provider call', async () => {
    customerPhone = null;
    const result = await sendCustomerMessage({ ...input, to: null });
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'MISSING_BILLING_RECIPIENT' });
    expect(sendBillingChannelEmail).not.toHaveBeenCalled();
    expect(Twilio.sendSMS).not.toHaveBeenCalled();
  });

  test('App runtime eligibility accepts no phone only for an explicit billing category', async () => {
    prefs.payment_receipt_channels = ['push'];
    customerPhone = null;
    const { pushEligibleRuntime } = require('../services/messaging/push-channel-routing')._test;
    await expect(pushEligibleRuntime(customerId, null, 'receipt', db, {
      requireExplicit: true, billingDeliveryCategory: 'payment_receipt',
    })).resolves.toBe(true);
    await expect(pushEligibleRuntime(customerId, null, 'receipt', db, { requireExplicit: true }))
      .resolves.toBe(false);
  });

  test('explicit billing selections suppress the independent lifecycle push', async () => {
    const { bellPushAllowed } = require('../services/messaging/push-channel-routing');
    prefs.invoice_channels = ['sms'];
    expect(await bellPushAllowed(customerId, 'invoice')).toBe(false);
    prefs.invoice_channels = ['push'];
    expect(await bellPushAllowed(customerId, 'invoice')).toBe(false);
  });
});
