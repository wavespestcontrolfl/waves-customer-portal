// Tests services/ads/meta-data-manager.js — Meta Conversions API upload.

let sentRows = [];   // rows existingSent() should return
const insertCalls = [];

const mockDb = jest.fn(() => {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereIn = jest.fn(() => b);
  b.select = jest.fn(() => Promise.resolve(sentRows));
  b.insert = jest.fn((row) => {
    insertCalls.push(row);
    return { onConflict: jest.fn(() => ({ merge: jest.fn(() => Promise.resolve(1)) })) };
  });
  return b;
});
mockDb.fn = { now: () => 'NOW()' };

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: (_n, fn) => fn() }));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-06-26', addETDays: (d) => d }));

// Reuse-from-data-manager mock: provide collectCandidates + hashing helpers.
const mockCollect = jest.fn();
jest.mock('../services/ads/data-manager', () => ({
  _private: {
    collectCandidates: (...a) => mockCollect(...a),
    sha256Hex: (s) => `h:${s}`,
    normalizeEmail: (e) => (e && String(e).includes('@') ? String(e).trim().toLowerCase() : null),
    normalizePhone: (p) => {
      const d = String(p || '').replace(/\D/g, '');
      if (d.length === 10) return `+1${d}`;
      if (d.length === 11 && d[0] === '1') return `+${d}`;
      return null;
    },
  },
}));

const MetaCapi = require('../services/ads/meta-data-manager');
const { buildUserData, buildEvent, skipReason, resolveMode } = MetaCapi._private;

const env = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  sentRows = [];
  insertCalls.length = 0;
  process.env = { ...env, META_CAPI_PIXEL_ID: 'px1', META_CAPI_ACCESS_TOKEN: 'tok' };
  delete process.env.META_CAPI_ALLOW_UPLOADS;
  delete process.env.META_CAPI_TEST_EVENT_CODE;
  delete process.env.META_CAPI_VALIDATE_ONLY;
});
afterAll(() => { process.env = env; });

const lead = (over = {}) => ({
  conversionType: 'qualified_lead',
  transactionId: 'waves_qualified_lead:L1',
  eventTimestamp: '2026-06-20T12:00:00Z',
  email: 'a@b.com', phone: '(941) 318-7612', fbc: null, fbp: 'fb.1.1.99', fbclid: null,
  conversionValue: null, currency: 'USD', leadId: 'L1', ...over,
});

describe('buildUserData', () => {
  test('hashes email + phone (digits, no +) and passes fbc/fbp', () => {
    const ud = buildUserData(lead({ fbc: 'fb.1.1.abc' }), 1700000000);
    expect(ud.em).toEqual(['h:a@b.com']);
    expect(ud.ph).toEqual(['h:19413187612']);
    expect(ud.fbc).toBe('fb.1.1.abc');
    expect(ud.fbp).toBe('fb.1.1.99');
  });

  test('builds fbc from fbclid when fbc absent', () => {
    const ud = buildUserData(lead({ fbc: null, fbclid: 'CLK', email: null, phone: null, fbp: null }), 1700000000);
    expect(ud.fbc).toBe('fb.1.1700000000000.CLK');
  });
});

describe('buildEvent / skipReason', () => {
  test('builds a Lead event with dedup event_id', () => {
    const e = buildEvent(lead());
    expect(e).toMatchObject({ event_name: 'Lead', event_id: 'waves_qualified_lead:L1', action_source: 'system_generated' });
    expect(e.event_time).toBe(Math.floor(new Date('2026-06-20T12:00:00Z').getTime() / 1000));
    expect(e.custom_data).toBeUndefined(); // no value on a lead
  });

  test('Purchase event carries custom_data value/currency', () => {
    const e = buildEvent(lead({ conversionType: 'completed_job_revenue', transactionId: 'waves_completed_job:S1', conversionValue: 250 }));
    expect(e.event_name).toBe('Purchase');
    expect(e.custom_data).toEqual({ value: 250, currency: 'USD' });
  });

  test('skipReason flags no match keys + missing purchase value', () => {
    expect(skipReason(lead({ email: null, phone: null, fbp: null, fbc: null, fbclid: null }))).toBe('missing_match_keys');
    expect(skipReason(lead({ conversionType: 'completed_job_revenue', conversionValue: 0 }))).toBe('missing_conversion_value');
    expect(skipReason(lead())).toBeNull();
  });
});

describe('resolveMode', () => {
  test('not live + no test code -> cannot send', () => {
    expect(resolveMode(false)).toMatchObject({ live: false, testMode: true, canSend: false });
  });
  test('not live + test code -> dry run', () => {
    process.env.META_CAPI_TEST_EVENT_CODE = 'TEST1';
    expect(resolveMode(false)).toMatchObject({ testMode: true, canSend: true });
  });
  test('live -> real send', () => {
    process.env.META_CAPI_ALLOW_UPLOADS = 'true';
    expect(resolveMode(false)).toMatchObject({ live: true, testMode: false, canSend: true });
  });
});

describe('uploadConversions', () => {
  test('returns configured:false when creds missing', async () => {
    delete process.env.META_CAPI_PIXEL_ID;
    const r = await MetaCapi.uploadConversions({ conversionType: 'qualified_lead' });
    expect(r.configured).toBe(false);
  });

  test('refuses to send when not allowed and no test code', async () => {
    const r = await MetaCapi.uploadConversions({ conversionType: 'qualified_lead' });
    expect(r).toMatchObject({ skipped: true, reason: 'no_test_event_code' });
  });

  test('live: sends events and logs as sent', async () => {
    process.env.META_CAPI_ALLOW_UPLOADS = 'true';
    mockCollect.mockResolvedValue([lead()]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ events_received: 1, fbtrace_id: 'x' }) });

    const r = await MetaCapi.uploadConversions({ conversionType: 'qualified_lead', validateOnly: false });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.data[0].event_name).toBe('Lead');
    expect(body.test_event_code).toBeUndefined();
    expect(r).toMatchObject({ sent: 1, eventsReceived: 1, testMode: false });
    expect(insertCalls[0]).toMatchObject({ status: 'sent', event_id: 'waves_qualified_lead:L1' });
  });

  test('dry run: sends to Test Events and logs validated', async () => {
    process.env.META_CAPI_TEST_EVENT_CODE = 'TEST1'; // not live -> dry run
    mockCollect.mockResolvedValue([lead()]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ events_received: 1 }) });

    const r = await MetaCapi.uploadConversions({ conversionType: 'qualified_lead' });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.test_event_code).toBe('TEST1');
    expect(r).toMatchObject({ testMode: true, validated: 1, sent: 0 });
    expect(insertCalls[0]).toMatchObject({ status: 'validated', test_mode: true });
  });

  test('skips already-sent events (dedup by event_id)', async () => {
    process.env.META_CAPI_ALLOW_UPLOADS = 'true';
    mockCollect.mockResolvedValue([lead()]);
    sentRows = [{ event_id: 'waves_qualified_lead:L1' }];
    global.fetch = jest.fn();

    const r = await MetaCapi.uploadConversions({ conversionType: 'qualified_lead', validateOnly: false });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
    expect(r.skipped).toEqual([{ event_id: 'waves_qualified_lead:L1', reason: 'already_sent' }]);
  });
});
