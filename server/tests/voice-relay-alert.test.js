/**
 * Voice-relay Phase E item 2 — URGENT/HOT-LEAD INTERNAL OWNER ALERT.
 *
 * Matrix:
 *   - gate off → no alert, no sender loaded
 *   - lead_quality 'hot' → ONE internal alert, through the SAME sender the
 *     self-booking confirm path uses (TwilioService.sendSMS to ADAM_PHONE with
 *     messageType 'internal_alert')
 *   - cold / warm / spam / no quality → no alert
 *   - idempotent: one per CALL, never per turn (two capture_lead calls, one alert)
 *   - fail-open: an alert failure never breaks the call OR the lead write
 *   - NEVER customer-facing: the customer-send spies must be un-called on
 *     every path (sendCustomerMessage, appointment reminders, email)
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
// The internal-alert sender (services/twilio.js redirects owner-phone
// internal_alert sends to the admin bell/push before Twilio is ever touched).
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({ success: true, sid: 'internal-admin-notification' })) }));
// CUSTOMER-FACING spies — none of these may EVER fire from the voice agent.
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email', () => ({ send: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ registerAppointment: jest.fn(), sendConfirmation: jest.fn() }));

const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailService = require('../services/email');
const AppointmentReminders = require('../services/appointment-reminders');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');
const logger = require('../services/logger');

const relayAlert = require('../services/voice-agent/relay-alert');
const { executeTool } = require('../services/voice-agent/relay-tools');

// Synthetic fixtures only — 555 numbers, example.com.
const OWNER = '+19415550199';
const CALLER = '+19415550142';
const HOT_LEAD = {
  first_name: 'Pat', last_name: 'Rivera', phone: CALLER, city: 'Bradenton',
  requested_service: 'termites swarming in the living room',
  urgency_reason: 'swarming termites right now',
  call_summary: 'Swarming termites in the living room, wants someone today.',
  lead_quality: 'hot',
};

function assertNeverCustomerFacing() {
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(EmailService.send).not.toHaveBeenCalled();
  expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  expect(AppointmentReminders.sendConfirmation).not.toHaveBeenCalled();
  // Every sendSMS the agent can make is an internal_alert to the owner phone.
  for (const call of TwilioService.sendSMS.mock.calls) {
    expect(call[0]).toBe(OWNER);
    expect(call[2]).toMatchObject({ messageType: 'internal_alert' });
  }
}

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
const savedPhone = process.env.ADAM_PHONE;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
  if (savedPhone === undefined) delete process.env.ADAM_PHONE;
  else process.env.ADAM_PHONE = savedPhone;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  process.env.ADAM_PHONE = OWNER;
  createLeadFromExtraction.mockResolvedValue({ leadId: 'l-1', customerId: null, created: true });
  TwilioService.sendSMS.mockResolvedValue({ success: true, sid: 'internal-admin-notification' });
});

describe('GATE OFF — dark', () => {
  test('a hot lead fires NOTHING while the context gate is off', async () => {
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, { callSid: 'CA1' })).toBe(false);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    assertNeverCustomerFacing();
  });

  test('gate values other than the literal "true" stay dark', async () => {
    for (const v of ['1', 'on', 'TRUE ', 'yes']) {
      process.env.VOICE_RELAY_CONTEXT_ENABLED = v;
      expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, {})).toBe(false);
    }
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});

describe('GATE ON — the alert', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('hot lead → ONE internal alert via the self-booking confirm path\'s exact sender', async () => {
    const ctx = { callSid: 'CA-hot', markOwnerAlerted: jest.fn() };
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, ctx)).toBe(true);

    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [to, body, opts] = TwilioService.sendSMS.mock.calls[0];
    expect(to).toBe(OWNER);
    expect(opts).toEqual({ messageType: 'internal_alert' });
    expect(body).toMatch(/URGENT lead/i);
    expect(body).toContain('Pat Rivera');
    expect(body).toContain(CALLER); // the owner needs a number to call back
    expect(body).toContain('swarming termites right now');
    expect(ctx.markOwnerAlerted).toHaveBeenCalledTimes(1);
    assertNeverCustomerFacing();
  });

  test('a matched existing customer is flagged as such in the alert', async () => {
    await relayAlert.alertOwnerHotLead(HOT_LEAD, { customerId: 'c-1', callSid: 'CA-x' });
    expect(TwilioService.sendSMS.mock.calls[0][1]).toMatch(/EXISTING CUSTOMER/);
  });

  test('cold / warm / spam / missing quality → NO alert', async () => {
    for (const quality of ['cold', 'warm', 'spam', null, undefined, 'HOT ']) {
      expect(await relayAlert.alertOwnerHotLead({ ...HOT_LEAD, lead_quality: quality }, {})).toBe(false);
    }
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    assertNeverCustomerFacing();
  });

  test('IDEMPOTENT — one alert per CALL even when capture_lead runs twice', async () => {
    let alerted = false;
    const ctx = { callSid: 'CA-twice', isOwnerAlerted: () => alerted, markOwnerAlerted: () => { alerted = true; } };
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, ctx)).toBe(true);
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, ctx)).toBe(false);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  });

  test('a plain ownerAlerted boolean is honoured too (simple ctx)', async () => {
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, { ownerAlerted: true })).toBe(false);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('FAIL-OPEN — a send failure is logged loudly and never thrown', async () => {
    TwilioService.sendSMS.mockRejectedValue(new Error('notification trigger down'));
    await expect(relayAlert.alertOwnerHotLead(HOT_LEAD, { callSid: 'CA-fail' })).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/hot-lead owner alert FAILED/i));
  });

  test('no ADAM_PHONE configured → no alert, warned, nothing thrown', async () => {
    delete process.env.ADAM_PHONE;
    await expect(relayAlert.alertOwnerHotLead(HOT_LEAD, {})).resolves.toBe(false);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/ADAM_PHONE is unset/i));
  });

  test('the alert body never leaks the caller phone into LOGS (masked there only)', async () => {
    await relayAlert.alertOwnerHotLead(HOT_LEAD, { callSid: 'CA-mask' });
    const logged = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].flat().join(' ');
    expect(logged).not.toContain(CALLER);
    expect(logged).toMatch(/hot-lead owner alert sent/);
  });
});

describe('capture_lead → alert wiring (the live path)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('hot capture_lead writes the lead FIRST, then alerts — never customer-facing', async () => {
    const out = await executeTool('capture_lead', {
      first_name: 'Pat', last_name: 'Rivera', call_summary: 'Swarming termites, urgent.',
      requested_service: 'termites', lead_quality: 'hot', urgency_reason: 'swarming right now',
    }, { from: CALLER, callSid: 'CA-live', markCaptured: jest.fn(), markOwnerAlerted: jest.fn() });

    expect(out).toMatch(/Lead saved successfully/);
    expect(createLeadFromExtraction).toHaveBeenCalledTimes(1);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    assertNeverCustomerFacing();
  });

  test('an alert failure NEVER loses the lead or fails the tool', async () => {
    TwilioService.sendSMS.mockRejectedValue(new Error('bell down'));
    const out = await executeTool('capture_lead', {
      call_summary: 'Angry about a missed visit.', lead_quality: 'hot',
    }, { from: CALLER, callSid: 'CA-live-2', markCaptured: jest.fn() });
    expect(out).toMatch(/Lead saved successfully/);
    expect(createLeadFromExtraction).toHaveBeenCalledTimes(1);
  });

  test('a COLD capture_lead alerts nobody', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Just price shopping.', lead_quality: 'cold',
    }, { from: CALLER, callSid: 'CA-cold', markCaptured: jest.fn() });
    expect(createLeadFromExtraction).toHaveBeenCalledTimes(1);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    assertNeverCustomerFacing();
  });

  test('a SPAM capture_lead writes nothing and alerts nobody', async () => {
    const out = await executeTool('capture_lead', {
      call_summary: 'Robocall.', lead_quality: 'spam',
    }, { from: CALLER, callSid: 'CA-spam', markCaptured: jest.fn() });
    expect(out).toMatch(/Marked as spam/i);
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});
