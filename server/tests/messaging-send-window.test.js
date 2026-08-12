jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(async () => ({})),
  checkConsentForPurpose: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (_input, state) => state),
  checkSuppression: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  checkContactCompliance: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  checkLineType: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(async () => ({ id: 'audit-1' })),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(async () => ({ sent: true, providerMessageId: 'SM_test' })),
  mediaUrlsAllowed: jest.fn(() => false),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { isEnabled } = require('../config/feature-gates');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const {
  isWithinSendWindowET,
  nextSendWindowOpenET,
} = require('../services/messaging/send-window');
const { checkSendWindow } = require('../services/messaging/validators/send-window');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

// 2026-08-06 is EDT (UTC-4): 8:00 AM ET = 12:00Z, 8:00 PM ET = 00:00Z next day.
const EVENING_ET = new Date('2026-08-07T01:15:00Z'); // 9:15 PM ET Aug 6 — the late-reminder incident instant
const MORNING_OPEN = new Date('2026-08-06T12:00:00Z'); // 8:00 AM ET Aug 6
const MIDDAY_ET = new Date('2026-08-06T18:30:00Z'); // 2:30 PM ET
const PRE_DAWN_ET = new Date('2026-08-06T07:00:00Z'); // 3:00 AM ET
const LAST_MINUTE = new Date('2026-08-06T23:59:00Z'); // 7:59 PM ET
const WINDOW_CLOSE = new Date('2026-08-07T00:00:00Z'); // 8:00 PM ET Aug 6
// 2026-01-15 is EST (UTC-5): 8:00 AM ET = 13:00Z.
const WINTER_EARLY = new Date('2026-01-15T12:30:00Z'); // 7:30 AM ET
const WINTER_MID = new Date('2026-01-15T15:00:00Z'); // 10:00 AM ET

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((gate) => gate === 'smsSendWindow');
});

describe('send-window helpers', () => {
  test('isWithinSendWindowET boundaries (EDT)', () => {
    expect(isWithinSendWindowET(EVENING_ET)).toBe(false);
    expect(isWithinSendWindowET(MORNING_OPEN)).toBe(true);
    expect(isWithinSendWindowET(MIDDAY_ET)).toBe(true);
    expect(isWithinSendWindowET(PRE_DAWN_ET)).toBe(false);
    expect(isWithinSendWindowET(LAST_MINUTE)).toBe(true);
    expect(isWithinSendWindowET(WINDOW_CLOSE)).toBe(false); // 8 PM exact = closed
  });

  test('isWithinSendWindowET boundaries (EST)', () => {
    expect(isWithinSendWindowET(WINTER_EARLY)).toBe(false);
    expect(isWithinSendWindowET(WINTER_MID)).toBe(true);
  });

  test('nextSendWindowOpenET from an evening block → next morning 8:00 ET', () => {
    expect(nextSendWindowOpenET(EVENING_ET).toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  test('nextSendWindowOpenET pre-dawn → same day 8:00 ET', () => {
    expect(nextSendWindowOpenET(PRE_DAWN_ET).toISOString()).toBe('2026-08-06T12:00:00.000Z');
  });

  test('nextSendWindowOpenET during the window → tomorrow 8:00 ET', () => {
    expect(nextSendWindowOpenET(MIDDAY_ET).toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  test('nextSendWindowOpenET across the November fall-back keeps 8:00 ET wall-clock', () => {
    // 2026-10-31 9:00 PM EDT (01:00Z Nov 1); DST ends Nov 1 → next open must
    // read 8:00 AM EST = 13:00Z, not a UTC-arithmetic 12:00Z.
    const beforeFallBack = new Date('2026-11-01T01:00:00Z');
    const open = nextSendWindowOpenET(beforeFallBack);
    expect(open.toISOString()).toBe('2026-11-01T13:00:00.000Z');
    expect(isWithinSendWindowET(open)).toBe(true);
  });

  test('nextSendWindowOpenET late on the spring-forward eve advances ONE ET date (codex r26 P1)', () => {
    // 2026-03-07 11:30 PM EST (04:30Z Mar 8); DST starts Mar 8 2:00 AM ET.
    // "+24 absolute hours" lands at 00:30 EDT on Mar 9 — TWO ET dates later
    // — and would delay every held SMS a full extra day. The next open is
    // Mar 8 8:00 AM EDT = 12:00Z.
    const springForwardEve = new Date('2026-03-08T04:30:00Z');
    const open = nextSendWindowOpenET(springForwardEve);
    expect(open.toISOString()).toBe('2026-03-08T12:00:00.000Z');
    expect(isWithinSendWindowET(open)).toBe(true);
  });

  test('nextSendWindowOpenET pre-dawn on the spring-forward day itself → same day 8:00 EDT', () => {
    // 2026-03-08 1:30 AM EST (06:30Z) — before the jump; same-day open is
    // 8:00 AM EDT = 12:00Z.
    const preJump = new Date('2026-03-08T06:30:00Z');
    expect(nextSendWindowOpenET(preJump).toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });
});

describe('checkSendWindow validator', () => {
  const SMS = {
    to: '+19415550123',
    body: 'hi',
    channel: 'sms',
    audience: 'customer',
    purpose: 'appointment_reminder_24h',
    customerId: 'c1',
    identityTrustLevel: 'phone_matches_customer',
  };

  test('gate off → ok even outside the window', () => {
    isEnabled.mockReturnValue(false);
    expect(checkSendWindow(SMS, null, null, EVENING_ET)).toEqual({ ok: true });
  });

  test('outside window → blocked with deferral contract', () => {
    const res = checkSendWindow(SMS, null, null, EVENING_ET);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('QUIET_HOURS_HOLD');
    expect(res.retryable).toBe(true);
    expect(res.deferred).toBe(true);
    expect(res.nextAllowedAt).toBe('2026-08-07T12:00:00.000Z');
  });

  test('inside window → ok', () => {
    expect(checkSendWindow(SMS, null, null, MIDDAY_ET)).toEqual({ ok: true });
  });

  test('exemptions: non-sms channel, internal audience, admin operator', () => {
    expect(checkSendWindow({ ...SMS, channel: 'email' }, null, null, EVENING_ET)).toEqual({ ok: true });
    expect(checkSendWindow({ ...SMS, audience: 'internal' }, null, null, EVENING_ET)).toEqual({ ok: true });
    expect(checkSendWindow({ ...SMS, identityTrustLevel: 'admin_operator' }, null, null, EVENING_ET)).toEqual({ ok: true });
  });

  test('purpose conversational alone is NOT exempt — explicit inbound-reply provenance is', () => {
    // Cold automated sends (lead-webhook form auto-reply, lead-response
    // agent) reuse the conversational policy for its consent/trust shape;
    // only a send marked as an actual inbound reply passes at night.
    const cold = checkSendWindow({ ...SMS, purpose: 'conversational', entryPoint: 'lead_webhook_auto_reply' }, null, null, EVENING_ET);
    expect(cold.ok).toBe(false);
    expect(cold.code).toBe('QUIET_HOURS_HOLD');
    expect(checkSendWindow({ ...SMS, purpose: 'conversational', conversationalContext: true }, null, null, EVENING_ET)).toEqual({ ok: true });
  });

  test('conversationalContext marker exempts an inbound-reply send that keeps a stricter purpose', () => {
    // The reschedule-reply confirmation: purpose stays 'appointment' (its
    // trust floor is stricter than the conversational policy) but the send
    // answers a customer's own "1"/"2" reply.
    expect(checkSendWindow({ ...SMS, purpose: 'appointment', conversationalContext: true }, null, null, EVENING_ET)).toEqual({ ok: true });
    const res = checkSendWindow({ ...SMS, purpose: 'appointment' }, null, null, EVENING_ET);
    expect(res.ok).toBe(false);
  });

  test('operator-clicked entry points pass at night even with customer-level trust', () => {
    expect(checkSendWindow({ ...SMS, entryPoint: 'admin_estimate_send' }, null, null, EVENING_ET)).toEqual({ ok: true });
  });

  test('scheduled_sms_cron is NOT blanket-exempt — only rows with operator provenance pass', () => {
    // The queue carries automated requeues (deferred voicemail text-backs,
    // held prep texts) alongside operator-composed rows; a late-recovering
    // queue must not text automated rows at night. The executor passes
    // operatorInitiated only for persisted operator provenance.
    const res = checkSendWindow({ ...SMS, entryPoint: 'scheduled_sms_cron' }, null, null, EVENING_ET);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('QUIET_HOURS_HOLD');
    expect(checkSendWindow({ ...SMS, entryPoint: 'scheduled_sms_cron', operatorInitiated: true }, null, null, EVENING_ET)).toEqual({ ok: true });
  });

  test('explicit operatorInitiated marker passes shared entry points at night', () => {
    expect(checkSendWindow({ ...SMS, entryPoint: 'invoice_send_via_sms', operatorInitiated: true }, null, null, EVENING_ET)).toEqual({ ok: true });
    const res = checkSendWindow({ ...SMS, entryPoint: 'invoice_send_via_sms' }, null, null, EVENING_ET);
    expect(res.ok).toBe(false);
  });

  test('booking side-effect and automation entry points stay fenced', () => {
    for (const entryPoint of ['admin_recurring_appointment_created', 'appointment_reminder_cron', 'invoice_followup_sequence']) {
      const res = checkSendWindow({ ...SMS, entryPoint }, null, null, EVENING_ET);
      expect(res.ok).toBe(false);
      expect(res.code).toBe('QUIET_HOURS_HOLD');
    }
    // Cold conversational-policy automations stay fenced too (no
    // inbound-reply provenance): form auto-replies, the lead-response
    // agent, the quote-wizard booking text.
    for (const entryPoint of ['lead_webhook_auto_reply', 'lead_response_auto_reply', 'public_quote_booking_sms']) {
      const res = checkSendWindow({ ...SMS, purpose: 'conversational', entryPoint }, null, null, EVENING_ET);
      expect(res.ok).toBe(false);
      expect(res.code).toBe('QUIET_HOURS_HOLD');
    }
  });
});

describe('sendCustomerMessage send-window integration', () => {
  const INPUT = {
    to: '+19415550123',
    body: 'Your appointment is tomorrow.',
    channel: 'sms',
    audience: 'customer',
    purpose: 'appointment_reminder_24h',
    customerId: 'c1',
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'appointment_reminder_cron',
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  test('evening automated send is blocked and carries the deferral fields', async () => {
    jest.useFakeTimers({ now: EVENING_ET, doNotFake: ['nextTick', 'setImmediate'] });
    const res = await sendCustomerMessage(INPUT);
    expect(res.sent).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.code).toBe('QUIET_HOURS_HOLD');
    expect(res.retryable).toBe(true);
    expect(res.deferred).toBe(true);
    expect(res.nextAllowedAt).toBe('2026-08-07T12:00:00.000Z');
    expect(sendViaTwilio).not.toHaveBeenCalled();
  });

  test('same evening instant, admin operator send goes through', async () => {
    jest.useFakeTimers({ now: EVENING_ET, doNotFake: ['nextTick', 'setImmediate'] });
    const res = await sendCustomerMessage({ ...INPUT, identityTrustLevel: 'admin_operator' });
    expect(res.sent).toBe(true);
    expect(sendViaTwilio).toHaveBeenCalledTimes(1);
  });

  test('midday automated send goes through', async () => {
    jest.useFakeTimers({ now: MIDDAY_ET, doNotFake: ['nextTick', 'setImmediate'] });
    const res = await sendCustomerMessage(INPUT);
    expect(res.sent).toBe(true);
    expect(sendViaTwilio).toHaveBeenCalledTimes(1);
  });

  test('provider receives a preSendCheck hook that flips when the clock crosses the 20:00 cutoff', async () => {
    // The 19:59→20:01 boundary race: validators pass at 19:59, but the
    // provider's internal awaits (template lookup, customer query) can carry
    // the send past 20:00. The hook re-runs the window check at the actual
    // Twilio handoff.
    jest.useFakeTimers({ now: LAST_MINUTE, doNotFake: ['nextTick', 'setImmediate'] });
    const res = await sendCustomerMessage(INPUT);
    expect(res.sent).toBe(true);
    const hooks = sendViaTwilio.mock.calls[0][1];
    expect(typeof hooks.preSendCheck).toBe('function');
    expect(hooks.preSendCheck()).toEqual({ ok: true });
    jest.setSystemTime(WINDOW_CLOSE);
    const lateVerdict = hooks.preSendCheck();
    expect(lateVerdict.ok).toBe(false);
    expect(lateVerdict.code).toBe('QUIET_HOURS_HOLD');
    expect(lateVerdict.nextAllowedAt).toBe('2026-08-07T12:00:00.000Z');
  });

  test('a provider-handoff block maps back onto the QUIET_HOURS_HOLD deferral contract', async () => {
    jest.useFakeTimers({ now: LAST_MINUTE, doNotFake: ['nextTick', 'setImmediate'] });
    sendViaTwilio.mockResolvedValueOnce({
      sent: false,
      provider: 'twilio',
      blocked: true,
      code: 'QUIET_HOURS_HOLD',
      error: 'Automated SMS is limited to 8:00 AM-8:00 PM ET',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-08-07T12:00:00.000Z',
    });
    const res = await sendCustomerMessage(INPUT);
    expect(res.sent).toBe(false);
    expect(res.blocked).toBe(true);
    expect(res.code).toBe('QUIET_HOURS_HOLD');
    expect(res.retryable).toBe(true);
    expect(res.deferred).toBe(true);
    expect(res.nextAllowedAt).toBe('2026-08-07T12:00:00.000Z');
    const { persistAudit } = require('../services/messaging/audit');
    const auditArgs = persistAudit.mock.calls.at(-1)[0];
    expect(auditArgs.validatorsFailed).toEqual(['check_send_window_boundary']);
    expect(auditArgs.providerOutcome).toBeNull();
  });
});
