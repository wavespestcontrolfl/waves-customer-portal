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

  test('exemptions: non-sms channel, internal audience, conversational purpose, admin operator', () => {
    expect(checkSendWindow({ ...SMS, channel: 'email' }, null, null, EVENING_ET)).toEqual({ ok: true });
    expect(checkSendWindow({ ...SMS, audience: 'internal' }, null, null, EVENING_ET)).toEqual({ ok: true });
    expect(checkSendWindow({ ...SMS, purpose: 'conversational' }, null, null, EVENING_ET)).toEqual({ ok: true });
    expect(checkSendWindow({ ...SMS, identityTrustLevel: 'admin_operator' }, null, null, EVENING_ET)).toEqual({ ok: true });
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
});
