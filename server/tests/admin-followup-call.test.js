jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({
  twilio: {
    accountSid: 'AC_test',
    authToken: 'auth_test',
  },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(),
}));
jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
}));

const { isEnabled } = require('../config/feature-gates');
const TwilioService = require('../services/twilio');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
const {
  triggerAdminFollowupCall,
  _internals,
} = require('../services/admin-followup-call');

function daytime() {
  return new Date('2026-05-20T14:00:00-04:00');
}

function afterHours() {
  return new Date('2026-05-20T22:00:00-04:00');
}

function makeDatabase() {
  const inserts = [];
  const updates = [];
  const database = jest.fn((table) => {
    const builder = {
      clause: null,
      insert(row) {
        inserts.push({ table, row });
        return {
          returning: async () => [{ id: 'call-log-1' }],
        };
      },
      where(clause) {
        this.clause = clause;
        return this;
      },
      update(patch) {
        updates.push({ table, clause: this.clause, patch });
        return Promise.resolve(1);
      },
    };
    return builder;
  });
  return { database, inserts, updates };
}

describe('admin follow-up call workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADAM_PHONE;
    delete process.env.WAVES_LEAD_ALERT_FROM_NUMBER;
    delete process.env.SERVER_DOMAIN;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    isEnabled.mockImplementation((gate) => gate === 'twilioVoice' || gate === 'leadAutoBridge');
    TwilioService.sendSMS.mockResolvedValue({ success: true, sid: 'SM_test' });
    alertTwilioFailure.mockResolvedValue({ ok: true });
  });

  test('auto-bridges through the same admin prompt used by quote requests', async () => {
    const { database, inserts, updates } = makeDatabase();
    const create = jest.fn(async () => ({ sid: 'CA_test' }));
    const twilioFactory = jest.fn(() => ({ calls: { create } }));

    const result = await triggerAdminFollowupCall({
      customerId: 'customer-1',
      customerName: 'Ada Lovelace',
      customerPhone: '(941) 555-0199',
      address: '123 Main St',
      source: 'estimate-accept',
      eventLabel: 'Estimate accepted',
      sourceLabel: 'Estimate accepted by Ada',
      now: daytime(),
      database,
      twilioFactory,
    });

    expect(result).toEqual({
      called: true,
      mode: 'auto_bridge',
      callSid: 'CA_test',
      callLogId: 'call-log-1',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415993489',
      from: '+19412975749', // all outbound calls originate from the main Waves line
      url: expect.stringContaining('/api/webhooks/twilio/outbound-admin-prompt?'),
      statusCallback: 'https://portal.wavespestcontrol.com/api/webhooks/twilio/call-status',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: false,
    }));
    const url = new URL(create.mock.calls[0][0].url);
    expect(url.searchParams.get('customerNumber')).toBe('+19415550199');
    expect(url.searchParams.get('callerIdNumber')).toBe('+19412975749'); // main Waves line (default)
    expect(url.searchParams.get('leadName')).toBe('Ada');
    expect(url.searchParams.get('eventLabel')).toBe('Estimate accepted');
    expect(url.searchParams.get('callLogId')).toBe('call-log-1');
    expect(inserts[0]).toMatchObject({
      table: 'call_log',
      row: expect.objectContaining({
        customer_id: 'customer-1',
        direction: 'outbound',
        from_phone: '+19412975749',
        to_phone: '+19415993489',
        status: 'initiated',
        source: 'estimate-accept-auto-bridge',
      }),
    });
    expect(JSON.parse(inserts[0].row.metadata)).toMatchObject({
      type: 'admin_auto_bridge',
      eventLabel: 'Estimate accepted',
      customerPhone: '+19415550199',
    });
    expect(updates).toEqual([
      {
        table: 'call_log',
        clause: { id: 'call-log-1' },
        patch: expect.objectContaining({ twilio_call_sid: 'CA_test' }),
      },
    ]);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('falls back to internal SMS after hours', async () => {
    const { database } = makeDatabase();
    const create = jest.fn(async () => ({ sid: 'CA_test' }));
    const twilioFactory = jest.fn(() => ({ calls: { create } }));

    const result = await triggerAdminFollowupCall({
      customerName: 'Grace Hopper',
      customerPhone: '9415550101',
      address: '456 Bay Dr',
      source: 'estimate-accept',
      eventLabel: 'Estimate accepted',
      now: afterHours(),
      database,
      twilioFactory,
    });

    expect(result).toEqual({ called: false, sms: true, reason: 'after_hours' });
    expect(create).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).toHaveBeenCalledWith(
      '+19415993489',
      expect.stringContaining('Estimate accepted'),
      { messageType: 'internal_alert' },
    );
  });

  test('falls back to internal SMS when voice is disabled', async () => {
    isEnabled.mockImplementation((gate) => gate === 'leadAutoBridge');
    const { database } = makeDatabase();
    const create = jest.fn(async () => ({ sid: 'CA_test' }));
    const twilioFactory = jest.fn(() => ({ calls: { create } }));

    const result = await triggerAdminFollowupCall({
      customerName: 'Katherine Johnson',
      customerPhone: '+1 (941) 555-0102',
      source: 'estimate-accept',
      now: daytime(),
      database,
      twilioFactory,
    });

    expect(result).toEqual({ called: false, sms: true, reason: 'twilio_voice_disabled' });
    expect(create).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).toHaveBeenCalled();
  });

  test('marks a precreated auto-bridge call log failed when Twilio rejects the call', async () => {
    const { database, updates } = makeDatabase();
    const create = jest.fn(async () => {
      throw new Error('bad request for +19415550199');
    });
    const twilioFactory = jest.fn(() => ({ calls: { create } }));

    const result = await triggerAdminFollowupCall({
      customerId: 'customer-1',
      customerName: 'Ada Lovelace',
      customerPhone: '(941) 555-0199',
      source: 'estimate-accept',
      eventLabel: 'Estimate accepted',
      now: daytime(),
      database,
      twilioFactory,
    });

    expect(result).toEqual({
      called: false,
      sms: true,
      reason: 'call_failed',
      error: 'bad request for [phone]',
    });
    expect(updates).toEqual([
      {
        table: 'call_log',
        clause: { id: 'call-log-1' },
        patch: expect.objectContaining({
          status: 'failed',
          notes: 'Twilio create failed: bad request for [phone]',
          updated_at: expect.any(Date),
        }),
      },
    ]);
    expect(TwilioService.sendSMS).toHaveBeenCalled();
    expect(alertTwilioFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorMessage: 'bad request for [phone]',
    }));
  });

  test('normalizes US phone inputs', () => {
    expect(_internals.normalizeUsPhone('9415993489')).toBe('+19415993489');
    expect(_internals.normalizeUsPhone('+1 (941) 599-3489')).toBe('+19415993489');
    expect(_internals.normalizeUsPhone('')).toBe('');
  });

  test('scrubs phone numbers from provider errors before logging', () => {
    expect(_internals.scrubProviderError('bad url customerNumber=%2B19415550199')).toBe('bad url customerNumber=[phone]');
    expect(_internals.scrubProviderError('failed for +19415550199 and 19415550199')).toBe('failed for [phone] and [phone]');
  });
});
