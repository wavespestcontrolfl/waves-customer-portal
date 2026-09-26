// options.preSendCheck is the canonical messaging pipeline's send-window
// boundary re-check, and it must be awaited as the LAST step before
// c.messages.create() — sendSMS's own internal awaits (redirect check,
// template lookup, customer/location query) can carry a 19:59 ET send past
// the 20:00 cutoff, so any earlier placement re-opens the boundary race
// (codex r2). Fail closed: a throwing check blocks the send.

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
  isEnabled: jest.fn(gate => gate !== 'smsGratitudeReplies'),
  // Push channel routing reads this at send time; false keeps routing inert
  // so these tests keep asserting the legacy SMS path.
  gateEnvValue: jest.fn(() => false),
  gateEnvTimestamp: jest.fn(() => null),
}));
jest.mock('../models/db', () => jest.fn());
// Codex round 3 on #4608 (structural move, P1 PRRT_kwDOR3YQi86j8Ydm): the
// annual-offer guard's AUTHORITATIVE check now lives inside sendSMS's own
// dispatch(), the true provider boundary. Mocked transparently (always
// allowed) by default so every existing test in this file — none of whose
// bodies carry an estimate link — is unaffected; the tests below override it.
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  // Round 8 P1: default no-op (nothing rewritten) so every existing test
  // in this file is unaffected; the withheldLinkPolicy tests below override it.
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
}));
jest.mock('../services/sms-guard', () => ({
  validateOutbound: (...args) => mockValidateOutbound(...args),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => {}) }));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// callback_number_needed (PR #4807): every SMS is checked against
// disclaimed_number_holds (sendCustomerMessage + sendSMS's dispatch). Not
// under test here — stubbed to "never held" so no hold read reaches the db.
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));

const TwilioService = require('../services/twilio');
const { annualHandoffGuard, rewriteWithheldEstimateLinks } = require('../services/estimate-annual-guard');
const { isEnabled } = require('../config/feature-gates');

const TO = '+19415550123';
const FROM = '+19413180000';

describe('TwilioService.sendSMS preSendCheck (provider-handoff gate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateOutbound.mockReturnValue({ ok: true });
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    delete process.env.OWNER_SMS_DISABLED;
  });

  test('a passing check sends normally', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      preSendCheck,
    });
    expect(preSendCheck).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.sid).toBe('SM_ok');
    expect(result.deliveryOutcome).toBe('accepted');
  });

  test('direct SMS callers strip external links without changing provider callback URLs', async () => {
    const body = 'Review: https://g.page/r/demo/review';
    const result = await TwilioService.sendSMS(TO, body, {
      messageType: 'manual', fromNumber: FROM,
    });
    expect(result.success).toBe(true);
    expect(mockTwilioCreate.mock.calls[0][0]).toMatchObject({
      body: 'Review: g.page/r/demo/review',
      statusCallback: expect.stringMatching(/^https:\/\//),
    });
  });

  test('MMS captions and media fetch URLs preserve their HTTPS schemes', async () => {
    const body = 'Photo: https://example.com/photo';
    await TwilioService.sendSMS(TO, body, {
      messageType: 'manual', fromNumber: FROM, mediaUrls: ['https://example.com/photo.jpg'],
    });
    expect(mockTwilioCreate.mock.calls[0][0]).toMatchObject({
      body, mediaUrl: ['https://example.com/photo.jpg'],
    });
  });

  test('a blocked check stops the send before messages.create and carries the deferral fields', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      preSendCheck: () => ({
        ok: false,
        code: 'QUIET_HOURS_HOLD',
        reason: 'Automated SMS is limited to 8:00 AM-8:00 PM ET',
        retryable: true,
        deferred: true,
        nextAllowedAt: '2026-08-07T12:00:00.000Z',
      }),
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      sid: null,
      preSendBlocked: true,
      code: 'QUIET_HOURS_HOLD',
      retryable: true,
      deferred: true,
      nextAllowedAt: '2026-08-07T12:00:00.000Z',
    });
  });

  test('a throwing check fails closed', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      preSendCheck: () => { throw new Error('window check exploded'); },
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      preSendBlocked: true,
      code: 'PRE_SEND_CHECK_FAILED',
    });
  });

  test('legacy callers without preSendCheck are unaffected', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  test('handoff locks enclose only the SDK call; log time follows lock acquisition', async () => {
    const events = [];
    const acquiredAt = new Date('2026-01-01T15:00:02Z');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T15:00:00Z'));
    require('../models/db').mockImplementation(table => ({ insert: async row => {
      events.push(table);
      expect(row.created_at).toEqual(acquiredAt);
      expect(JSON.parse(row.metadata).notificationEventKey).toBe('payment-expiry:pm-1:9:2026:expired');
    } }));
    mockTwilioCreate.mockImplementation(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });
    try {
      const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
        notificationEventKey: 'payment-expiry:pm-1:9:2026:expired',
        withSmsHandoff: async dispatch => {
          events.push('locked');
          jest.setSystemTime(acquiredAt);
          await dispatch();
          events.push('released');
          return { ok: true };
        },
      });
      expect(result.success).toBe(true);
      expect(events).toEqual(['locked', 'sdk', 'released', 'sms_log']);
    } finally { jest.useRealTimers(); require('../models/db').mockReset(); }
  });

  test.each([
    ['stamps human_authored on the sms_log row for a composer-typed body', { humanAuthored: true }, true],
    ['leaves human_authored off for an automated or unchanged-draft manual send', { humanAuthored: false }, false],
    ['leaves human_authored off when the option is absent', {}, false],
  ])('%s', async (_label, extra, expected) => {
    const rows = [];
    require('../models/db').mockImplementation(() => ({ insert: async row => { rows.push(row); } }));
    try {
      const result = await TwilioService.sendSMS(TO, 'Yes, the app is the easiest way to move it.', {
        messageType: 'manual', fromNumber: FROM, ...extra,
      });
      expect(result.success).toBe(true);
      expect(rows).toHaveLength(1);
      const metadata = JSON.parse(rows[0].metadata);
      expect(metadata.pre_handoff_stamp).toBe(true);
      expect(metadata.human_authored === true).toBe(expected);
      expect(Object.prototype.hasOwnProperty.call(metadata, 'human_authored')).toBe(expected);
    } finally { require('../models/db').mockReset(); }
  });

  test.each([
    ['stamps the visit an appointment send is about (Codex #4816 r41)', { appointmentId: 'visit-123' }, 'visit-123'],
    ['leaves scheduled_service_id off when the send names no visit', {}, undefined],
  ])('%s', async (_label, extra, expected) => {
    const rows = [];
    require('../models/db').mockImplementation(() => ({ insert: async row => { rows.push(row); } }));
    try {
      const result = await TwilioService.sendSMS(TO, 'Your appointment is confirmed.', {
        messageType: 'confirmation', fromNumber: FROM, ...extra,
      });
      expect(result.success).toBe(true);
      expect(JSON.parse(rows[0].metadata).scheduled_service_id).toBe(expected);
    } finally { require('../models/db').mockReset(); }
  });

  test.each([
    ['a typed send with no media option (scheduled dispatch) records zero media', { humanAuthored: true }, []],
    ['a typed send with media urls but no media option stays unknown', { humanAuthored: true, mediaUrls: ['https://example.invalid/a.jpg'] }, undefined],
    ['an automated send records no media evidence', { humanAuthored: false }, undefined],
    ['a caller-supplied media array is kept as is', { humanAuthored: true, media: [] }, []],
  ])('%s', async (_label, extra, expected) => {
    const rows = [];
    require('../models/db').mockImplementation(() => ({ insert: async row => { rows.push(row); } }));
    try {
      const result = await TwilioService.sendSMS(TO, 'Yes, the app is the easiest way to move it.', {
        messageType: 'manual', fromNumber: FROM, ...extra,
      });
      expect(result.success).toBe(true);
      expect(JSON.parse(rows[0].metadata).media).toEqual(expected);
    } finally { require('../models/db').mockReset(); }
  });

  test('a direct customer caller publishes before its handoff and settles the normalized accepted provider context afterward', async () => {
    const coordination = require('../services/messaging/provider-handoff-reservation');
    const handle = { direct: true };
    const events = [];
    const applies = jest.spyOn(coordination, 'directCoordinationApplies').mockReturnValue(true);
    const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation').mockImplementation(async (input) => {
      events.push(['reserve', input]);
      return { handle };
    });
    const capture = jest.spyOn(coordination, 'captureProviderContext').mockImplementation((_handle, context) => {
      events.push(['capture', context]);
    });
    const record = jest.spyOn(coordination, 'recordProviderOutcome').mockImplementation((_handle, outcome) => {
      events.push(['outcome', outcome]);
    });
    const settle = jest.spyOn(coordination, 'settleProviderHandoffReservation').mockImplementation(async () => {
      events.push(['settle']);
      return true;
    });
    mockTwilioCreate.mockImplementationOnce(async payload => {
      events.push(['sdk', payload]);
      return { sid: `SM${'2'.repeat(32)}` };
    });
    try {
      const result = await TwilioService.sendSMS('(941) 555-0123', 'Thanks — visit https://example.com', {
        messageType: 'estimate_service_details', fromNumber: FROM,
        notificationEventKey: 'payment-expiry:pm-1:9:2026:expired',
        withSmsHandoff: async dispatch => {
          events.push(['handoff']);
          await dispatch({ held: true });
          events.push(['handoff-done']);
          return { ok: true };
        },
      });
      expect(result).toMatchObject({ success: true, deliveryOutcome: 'accepted' });
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
        to: '+19415550123', fromNumber: FROM,
        body: 'Thanks - visit example.com', messageType: 'estimate_service_details',
      }));
      expect(events.map(([event]) => event)).toEqual(expect.arrayContaining([
        'reserve', 'capture', 'handoff', 'sdk', 'handoff-done', 'outcome', 'settle',
      ]));
      expect(events.find(([event, context]) => event === 'capture' && context.body)?.[1]).toMatchObject({
        to: '+19415550123', fromNumber: FROM, body: 'Thanks - visit example.com',
        messageType: 'estimate_service_details', channel: 'sms',
        metadata: expect.objectContaining({ notificationEventKey: 'payment-expiry:pm-1:9:2026:expired' }),
      });
      const eventNames = events.map(([event]) => event);
      expect(eventNames.indexOf('reserve')).toBeLessThan(eventNames.indexOf('handoff'));
      expect(eventNames.indexOf('sdk')).toBeGreaterThan(eventNames.indexOf('handoff'));
      expect(eventNames.indexOf('settle')).toBeGreaterThan(eventNames.indexOf('handoff-done'));
      expect(capture).toHaveBeenCalledWith(handle, expect.objectContaining({
        providerAcceptedAt: expect.any(Date),
        metadata: expect.objectContaining({ notificationEventKey: 'payment-expiry:pm-1:9:2026:expired' }),
      }));
      expect(settle).toHaveBeenCalledWith(handle);
    } finally {
      applies.mockRestore(); prepare.mockRestore(); capture.mockRestore();
      record.mockRestore(); settle.mockRestore();
    }
  });

  test('direct coordination covers customer-facing sends without a customer id and trusts only the canonical gratitude marker', () => {
    const coordination = require('../services/messaging/provider-handoff-reservation');
    isEnabled.mockReturnValue(true);
    try {
      expect(coordination.directCoordinationApplies({ messageType: 'estimate_service_details' })).toBe(true);
      expect(coordination.directCoordinationApplies({ messageType: 'ai_gratitude' })).toBe(true);
      const owner = coordination.gratitudeReservationOwner({
        audience: 'customer', purpose: 'conversational', entryPoint: 'sms_auto_send_executor',
        metadata: { original_message_type: 'ai_gratitude', agentDecisionId: 'decision-1' },
      }, { providerPreSendCheck: () => {}, withSmsHandoff: () => {} });
      expect(coordination.directCoordinationApplies({
        messageType: 'ai_gratitude', reservationOwner: owner,
      })).toBe(false);
    } finally {
      isEnabled.mockImplementation(gate => gate !== 'smsGratitudeReplies');
    }
  });

  test('a direct coordination database failure is retryable and never reaches the provider', async () => {
    const coordination = require('../services/messaging/provider-handoff-reservation');
    const applies = jest.spyOn(coordination, 'directCoordinationApplies').mockReturnValue(true);
    const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation')
      .mockRejectedValue(new Error('database unavailable'));
    try {
      await expect(TwilioService.sendSMS(TO, 'Reminder body', {
        messageType: 'estimate_service_details', fromNumber: FROM,
      })).resolves.toMatchObject({
        success: false, preSendBlocked: true, deliveryOutcome: 'not_sent', retryable: true,
        code: 'PROVIDER_HANDOFF_PREPARATION_FAILED',
      });
      expect(mockTwilioCreate).not.toHaveBeenCalled();
    } finally {
      applies.mockRestore(); prepare.mockRestore();
    }
  });

  test.each([
    ['guard refusal', async () => ({ ok: false, code: 'STALE', reason: 'stale' }), null, 'not_sent'],
    ['SDK uncertainty', async () => ({ ok: true }), Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), 'uncertain'],
  ])('a direct %s settles only after the final outcome is known', async (_label, preSendCheck, sdkError, expectedOutcome) => {
    const coordination = require('../services/messaging/provider-handoff-reservation');
    const handle = { direct: true };
    const applies = jest.spyOn(coordination, 'directCoordinationApplies').mockReturnValue(true);
    const prepare = jest.spyOn(coordination, 'prepareProviderHandoffReservation').mockResolvedValue({ handle });
    const capture = jest.spyOn(coordination, 'captureProviderContext').mockImplementation(() => {});
    const events = [];
    const record = jest.spyOn(coordination, 'recordProviderOutcome').mockImplementation((_handle, outcome) => {
      events.push(['outcome', outcome.deliveryOutcome]);
    });
    const settle = jest.spyOn(coordination, 'settleProviderHandoffReservation').mockImplementation(async () => {
      events.push(['settle']);
      return true;
    });
    if (sdkError) mockTwilioCreate.mockRejectedValueOnce(sdkError);
    try {
      const pending = TwilioService.sendSMS(TO, 'Reminder body', {
        customerId: 'cust-1', messageType: 'estimate_service_details', fromNumber: FROM, preSendCheck,
      });
      if (sdkError) await expect(pending).rejects.toMatchObject({ providerOutcome: { deliveryOutcome: 'uncertain' } });
      else await expect(pending).resolves.toMatchObject({ success: false, preSendBlocked: true });
      expect(settle).toHaveBeenCalledWith(handle);
      expect(events.slice(-2)).toEqual([['outcome', expectedOutcome], ['settle']]);
    } finally {
      applies.mockRestore(); prepare.mockRestore(); capture.mockRestore();
      record.mockRestore(); settle.mockRestore();
    }
  });


  test('a stale subject refuses the SDK handoff', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async () => ({ ok: false, code: 'LEAD_SUBJECT_CHANGED' }),
    });
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'LEAD_SUBJECT_CHANGED' });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('a guard failure after acceptance preserves the send result', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); throw new Error('commit connection lost'); },
    });
    expect(result).toMatchObject({ success: true, sid: 'SM_ok' });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
  });

  test('an authority lookup error blocks retryably without a provider failure alert', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async () => { throw Object.assign(new Error('connection unavailable'), { code: '08006' }); },
    });
    expect(result).toMatchObject({ success: false, preSendBlocked: true, code: 'SMS_HANDOFF_CHECK_FAILED', retryable: true });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test.each([
    ['timeout', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })],
    ['reset', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })],
    ['HTTP 408', Object.assign(new Error('request timeout'), { status: 408 })],
    ['timeout with an incidental 4xx status', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT', status: 400 })],
    ['HTTP 503', Object.assign(new Error('provider unavailable'), { status: 503 })],
    ['unknown handoff error', new Error('unexpected transport failure')],
  ])('an SDK %s stays uncertain and follows provider failure handling', async (_label, failure) => {
    mockTwilioCreate.mockRejectedValueOnce(failure);
    await expect(TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; },
    })).rejects.toMatchObject({
      providerOutcome: { sent: false, deliveryOutcome: 'uncertain' },
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('a missing SID remains uncertain (guarded: %s)', async guarded => {
    mockTwilioCreate.mockResolvedValueOnce({});
    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
      ...(guarded ? { withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; } } : {}),
    })).rejects.toMatchObject({ providerOutcome: { sent: false, deliveryOutcome: 'uncertain' } });
  });

  test('a provider 4xx is a definitive retryable/non-retryable rejection', async () => {
    mockTwilioCreate.mockRejectedValueOnce(Object.assign(new Error('too many requests'), { code: 20429, status: 429 }));

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
    })).rejects.toMatchObject({
      status: 429,
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
    });
  });

  test('a pre-provider 5xx-shaped exception is still definitive non-delivery', async () => {
    jest.spyOn(TwilioService, 'deriveOutboundNumber').mockRejectedValueOnce(
      Object.assign(new Error('location lookup unavailable'), { status: 503 }),
    );

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
    })).rejects.toMatchObject({
      status: 503,
      providerOutcome: { sent: false, deliveryOutcome: 'not_sent' },
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });

  test('an exception after an accepted SDK response preserves acceptance provenance', async () => {
    require('../services/conversations').recordTouchpoint.mockImplementationOnce(() => {
      throw Object.assign(new Error('touchpoint module failed'), { status: 503 });
    });

    await expect(TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
    })).rejects.toMatchObject({
      providerOutcome: {
        sent: true,
        deliveryOutcome: 'accepted',
        providerMessageId: 'SM_ok',
      },
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
  });

  test('a guarded send cannot escape through explicit push routing', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      explicitPushOnly: true, withSmsHandoff: jest.fn(),
    });
    expect(result).toMatchObject({ success: false, code: 'UNSUPPORTED_SMS_HANDOFF' });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });
});

describe('annual-offer guard at the TRUE provider boundary (Codex round 3 on #4608, P1 PRRT_kwDOR3YQi86j8Ydm — structural move)', () => {
  // This is a SIBLING describe, not nested under the first one — its
  // beforeEach (jest.clearAllMocks + mockTwilioCreate's default resolve)
  // never runs for tests here, so a queued once-value left over from the
  // FIRST describe's last test (several of which chain
  // mockRejectedValueOnce/mockImplementationOnce on the SAME shared
  // mockTwilioCreate) can otherwise leak in. Reset fully, independently.
  beforeEach(() => {
    jest.clearAllMocks();
    mockTwilioCreate.mockResolvedValue({ sid: 'SM_ok' });
    annualHandoffGuard.mockReturnValue(async () => ({ blocked: false, reason: null, estimateId: null }));
  });

  test('runs INSIDE a caller withSmsHandoff lock — AFTER it acquires, not before (closes the preSendCheck-before-the-lock gap)', async () => {
    const events = [];
    annualHandoffGuard.mockReturnValueOnce(async () => { events.push('guard'); return { blocked: false, reason: null, estimateId: null }; });
    mockTwilioCreate.mockImplementation(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => {
        events.push('locked');
        await dispatch();
        events.push('released');
        return { ok: true };
      },
    });

    expect(result.success).toBe(true);
    expect(events).toEqual(['locked', 'guard', 'sdk', 'released']);
  });

  // Pre-push audit P2 (twilio.js:953, round 12): dispatch() must reuse the
  // handoff's OWN transaction for the guard read, not open a second
  // root-pool connection while the first is still held.
  test('with a caller withSmsHandoff, the guard\'s loader is called with the HELD trx, not the module db', async () => {
    const db = require('../models/db');
    const trxSentinel = { __isTrx: true };
    let capturedDb;
    annualHandoffGuard.mockImplementationOnce((args) => { capturedDb = args.db; return async () => ({ blocked: false, reason: null, estimateId: null }); });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(trxSentinel); return { ok: true }; },
    });

    expect(result.success).toBe(true);
    expect(capturedDb).toBe(trxSentinel);
    expect(capturedDb).not.toBe(db);
  });

  test('with NO caller withSmsHandoff (plain dispatch), the guard\'s loader falls back to the module db', async () => {
    const db = require('../models/db');
    let capturedDb;
    annualHandoffGuard.mockImplementationOnce((args) => { capturedDb = args.db; return async () => ({ blocked: false, reason: null, estimateId: null }); });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM });

    expect(result.success).toBe(true);
    expect(capturedDb).toBe(db);
  });

  test('a blocked verdict inside the lock never reaches the SDK — a permanent, non-retryable refusal, not the generic handoff-check-failed shape', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));

    const result = await TwilioService.sendSMS(TO, 'Your estimate is expiring: https://portal.wavespestcontrol.com/estimate/withheld-token-abc', {
      messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; },
    });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, preSendBlocked: true, code: 'ANNUAL_OFFER_WITHHELD', error: 'annual_offer_withheld',
    });
    // Never the generic "handoff check failed, retryable" shape — this is a
    // definite, permanent refusal.
    expect(result.retryable).not.toBe(true);
  });

  test('a blocked verdict with NO caller handoff (plain dispatch) is a clean guardBlocked refusal — never a Twilio-failure alert or a thrown/wrapped error', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));

    const result = await TwilioService.sendSMS(TO, 'https://portal.wavespestcontrol.com/estimate/withheld-token-xyz', {
      messageType: 'manual', fromNumber: FROM,
    });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, guardBlocked: true, code: 'ANNUAL_OFFER_WITHHELD', error: 'annual_offer_withheld', deliveryOutcome: 'not_sent',
    });
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('estimateId / estimateIds options are threaded through as the guard\'s explicit addition, alongside the final normalized body as content', async () => {
    await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, estimateId: 'est-solo',
    });
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({
      estimateIds: ['est-solo'], texts: ['Reminder body'],
    }));

    annualHandoffGuard.mockClear();
    await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, estimateIds: ['est-a', 'est-b'],
    });
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({
      estimateIds: ['est-a', 'est-b'], texts: ['Reminder body'],
    }));

    annualHandoffGuard.mockClear();
    await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM });
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({ estimateIds: [] }));
  });

  test('a guard infrastructure error (the lookup itself throws), with NO withSmsHandoff, resolves to a retryable, provider-never-attempted result — not a withheld/blocked refusal, and never a generic provider-failure throw (round 13 P1)', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => { throw new Error('estimates lookup unavailable'); });

    // Pre-push audit P1 (twilio.js:964, round 13): a lookup failure here
    // used to propagate as a bare throw, landing in the generic Twilio-
    // error classification below — which treats an unrecognized error code
    // as a definite, non-retryable provider failure. It must instead
    // resolve to the SAME retryable/not-attempted shape sendWindowClosed
    // gets, so a scheduled retry sweep tries again instead of marking an
    // unsent message permanently failed.
    const result = await TwilioService.sendSMS(TO, 'Reminder body', { messageType: 'manual', fromNumber: FROM });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, sid: null, preSendBlocked: true,
      code: 'ANNUAL_OFFER_GUARD_FAILED', retryable: true, deliveryOutcome: 'not_sent',
    });
    expect(result.error).toMatch(/estimates lookup unavailable/);
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('a guard infrastructure error (the lookup itself throws) INSIDE a caller withSmsHandoff also resolves retryable, provider-never-attempted — never the generic handoff-check-failed shape or a Twilio SDK call (round 13 P1)', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => { throw new Error('estimates lookup unavailable'); });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM,
      withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; },
    });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, preSendBlocked: true,
      code: 'ANNUAL_OFFER_GUARD_FAILED', retryable: true,
      validator: 'check_sms_handoff_authority',
    });
    expect(result.error).toMatch(/estimates lookup unavailable/);
  });

  test('round 5 P1: a guard that resolves after the window closes gets ONE more sync recheck immediately before the SDK call — no provider call, window refusal', async () => {
    // The early preSendCheck() passes (window was fine THEN); by the time
    // the guard's own DB reads resolve inside dispatch(), the window has
    // closed — isStillValid() is the ONLY thing that can see that, since
    // it is pure/synchronous and reruns at the true last moment.
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => false);

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck,
    });

    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(preSendCheck.isStillValid).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false, preSendBlocked: true, code: 'QUIET_HOURS_HOLD', retryable: true,
    });
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('round 5 P1: the same final recheck applies INSIDE a caller withSmsHandoff lock, after the guard, before the SDK call', async () => {
    const events = [];
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => { events.push('isStillValid'); return false; });
    annualHandoffGuard.mockReturnValueOnce(async () => { events.push('guard'); return { blocked: false, reason: null, estimateId: null }; });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck,
      withSmsHandoff: async dispatch => {
        events.push('locked');
        await dispatch();
        // dispatch() throws for this refusal — a real caller's own lock
        // release happens around this callback (a try/finally the caller
        // owns), not inside it, so nothing past the throw runs here.
        events.push('released');
        return { ok: true };
      },
    });

    expect(events).toEqual(['locked', 'guard', 'isStillValid']);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false, preSendBlocked: true, code: 'QUIET_HOURS_HOLD', retryable: true,
    });
  });

  test('round 5 P1: isStillValid() returning true lets the send proceed normally', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => true);

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck,
    });

    expect(preSendCheck.isStillValid).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  test('round 5 P1: a preSendCheck with no isStillValid is unaffected (legacy/direct callers)', async () => {
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck,
    });
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  test.each([
    ['bare', false],
    ['locked handoff', true],
  ])('a late final predicate blocks the %s path after the suspended annual guard, before the SDK', async (_label, locked) => {
    const events = [];
    let finishGuard;
    let announceGuard;
    let lateCondition = false;
    const guardStarted = new Promise(resolve => { announceGuard = resolve; });
    const guardSuspended = new Promise(resolve => { finishGuard = resolve; });
    annualHandoffGuard.mockReturnValueOnce(async () => {
      events.push('guard:start');
      announceGuard();
      await guardSuspended;
      events.push('guard:end');
      return { blocked: false, reason: null, estimateId: null };
    });
    const providerPreSendCheck = jest.fn(async () => {
      events.push('final');
      return lateCondition
        ? { ok: false, code: 'GRATITUDE_THREAD_CHANGED', reason: 'thread changed', retryable: false }
        : { ok: true };
    });
    const trx = { __isTrx: true };

    const resultPromise = TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      providerPreSendCheck,
      ...(locked ? {
        withSmsHandoff: async dispatch => {
          events.push('locked');
          await dispatch(trx);
          return { ok: true };
        },
      } : {}),
    });
    await guardStarted;
    expect(providerPreSendCheck).not.toHaveBeenCalled();
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    lateCondition = true;
    finishGuard();

    const result = await resultPromise;
    expect(events).toEqual(locked
      ? ['locked', 'guard:start', 'guard:end', 'final']
      : ['guard:start', 'guard:end', 'final']);
    expect(providerPreSendCheck).toHaveBeenCalledTimes(1);
    expect(providerPreSendCheck).toHaveBeenCalledWith({
      channel: 'sms',
      dbi: locked ? trx : require('../models/db'),
    });
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      preSendBlocked: true,
      code: 'GRATITUDE_THREAD_CHANGED',
      error: 'thread changed',
      retryable: false,
      validator: 'provider_pre_send_check_boundary',
      deliveryOutcome: 'not_sent',
    });
  });

  test.each([
    ['bare', false],
    ['locked handoff', true],
  ])('a throwing final predicate fails the %s path closed as a definite retryable non-send', async (_label, locked) => {
    const providerPreSendCheck = jest.fn(async () => {
      throw Object.assign(new Error('fresh thread unavailable'), {
        code: 'GRATITUDE_CONTEXT_UNAVAILABLE',
        retryable: true,
      });
    });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual',
      fromNumber: FROM,
      providerPreSendCheck,
      ...(locked ? {
        withSmsHandoff: async dispatch => { await dispatch(); return { ok: true }; },
      } : {}),
    });

    expect(providerPreSendCheck).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      preSendBlocked: true,
      code: 'GRATITUDE_CONTEXT_UNAVAILABLE',
      error: 'fresh thread unavailable',
      retryable: true,
      validator: 'provider_pre_send_check_boundary',
      deliveryOutcome: 'not_sent',
    });
    expect(require('../services/twilio-failure-alerts').alertTwilioFailure).not.toHaveBeenCalled();
  });

  test('a passing final predicate runs once after the annual guard and before the sync check and SDK', async () => {
    const events = [];
    annualHandoffGuard.mockReturnValueOnce(async () => {
      events.push('annual');
      return { blocked: false, reason: null, estimateId: null };
    });
    const preSendCheck = jest.fn(async () => ({ ok: true }));
    preSendCheck.isStillValid = jest.fn(() => { events.push('sync'); return true; });
    const providerPreSendCheck = jest.fn(async () => { events.push('final'); return { ok: true }; });
    mockTwilioCreate.mockImplementationOnce(async () => { events.push('sdk'); return { sid: 'SM_ok' }; });

    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, preSendCheck, providerPreSendCheck,
    });

    expect(result).toMatchObject({ success: true, deliveryOutcome: 'accepted' });
    expect(preSendCheck).toHaveBeenCalledTimes(1);
    expect(providerPreSendCheck).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['annual', 'final', 'sync', 'sdk']);
  });

  test('round 8 P1: withheldLinkPolicy "rewrite" strips a withheld estimate link from the body BEFORE the guard check and the SDK call, and the provider is called with the rewritten text', async () => {
    const originalBody = 'Hello! We received your deposit. https://portal.wavespestcontrol.com/estimate/withheld-token-abc';
    const rewrittenBody = 'Hello! We received your deposit. https://portal.wavespestcontrol.com';
    rewriteWithheldEstimateLinks.mockResolvedValueOnce({ html: undefined, text: rewrittenBody, rewrittenIds: ['est-1'] });

    const result = await TwilioService.sendSMS(TO, originalBody, {
      messageType: 'deposit_receipt', fromNumber: FROM, withheldLinkPolicy: 'rewrite', estimateId: 'est-1',
    });

    // Runs AFTER stripSmsUrlScheme/normalizeGsmPunctuation (this file's own
    // "direct SMS callers strip external links" test pins that behavior),
    // so the scheme is already gone by the time the rewrite sees it — the
    // estimate path/token survives either way.
    expect(rewriteWithheldEstimateLinks).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('/estimate/withheld-token-abc'),
    }));
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    const sentBody = mockTwilioCreate.mock.calls[0][0].body;
    expect(sentBody).toBe(rewrittenBody);
    expect(sentBody).not.toMatch(/\/estimate\//);
    expect(sentBody).toContain('https://portal.wavespestcontrol.com');
    // The guard's own re-derivation runs on the REWRITTEN body, and the
    // explicit estimateId that survived the rewrite must NOT be forced
    // through — it would refuse a body that no longer carries the link.
    expect(annualHandoffGuard).toHaveBeenCalledWith(expect.objectContaining({
      estimateIds: [], texts: [rewrittenBody],
    }));
    expect(result).toMatchObject({ success: true, withheldLinksRewritten: ['est-1'] });
  });

  test('round 8 P1: without withheldLinkPolicy (default refuse), a withheld estimate link still refuses — never silently rewritten', async () => {
    annualHandoffGuard.mockReturnValueOnce(async () => ({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' }));

    const result = await TwilioService.sendSMS(TO, 'https://portal.wavespestcontrol.com/estimate/withheld-token-xyz', {
      messageType: 'manual', fromNumber: FROM,
    });

    expect(rewriteWithheldEstimateLinks).not.toHaveBeenCalled();
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, guardBlocked: true, code: 'ANNUAL_OFFER_WITHHELD' });
  });

  test('round 8 P1: withheldLinkPolicy "rewrite" with nothing to rewrite sends the original body unchanged, no marker', async () => {
    const result = await TwilioService.sendSMS(TO, 'Reminder body', {
      messageType: 'manual', fromNumber: FROM, withheldLinkPolicy: 'rewrite',
    });

    expect(rewriteWithheldEstimateLinks).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    expect(mockTwilioCreate.mock.calls[0][0].body).toBe('Reminder body');
    expect(result.withheldLinksRewritten).toBeUndefined();
  });
});
