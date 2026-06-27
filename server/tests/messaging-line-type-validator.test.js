jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: () => 'NOW()' };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({
  recordNonMobileSuppression: jest.fn(async () => ({ ok: true, recorded: true })),
}));
jest.mock('../config', () => ({ twilio: { accountSid: 'AC', authToken: 'tok' } }));

const mockFetch = jest.fn();
jest.mock('twilio', () => jest.fn(() => ({
  lookups: { v2: { phoneNumbers: jest.fn(() => ({ fetch: mockFetch })) } },
})));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { recordNonMobileSuppression } = require('../services/messaging/validators/suppression');
const { checkLineType } = require('../services/messaging/validators/line-type');

function wireDb(cacheRow, { readThrows = false } = {}) {
  const insertChain = {};
  insertChain.onConflict = jest.fn(() => insertChain);
  insertChain.merge = jest.fn(async () => [1]);
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => {
    if (readThrows) throw new Error('phone_line_types read failed');
    return cacheRow;
  });
  q.insert = jest.fn(() => insertChain);
  db.mockImplementation(() => q);
  return { q, insertChain };
}

const SMS = { to: '+18777175476', channel: 'sms', audience: 'customer' };

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockReturnValue(true);
  mockFetch.mockReset();
});

describe('checkLineType — gating / scope', () => {
  test('no-ops (ok) when the gate is off — no db, no lookup', async () => {
    isEnabled.mockReturnValue(false);
    wireDb(undefined);
    const res = await checkLineType(SMS);
    expect(res).toEqual({ ok: true });
    expect(db).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('no-ops for non-sms channels', async () => {
    wireDb(undefined);
    const res = await checkLineType({ ...SMS, channel: 'email' });
    expect(res).toEqual({ ok: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('no-ops for non customer/lead audiences', async () => {
    wireDb(undefined);
    const res = await checkLineType({ ...SMS, audience: 'internal' });
    expect(res).toEqual({ ok: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('checkLineType — cache hits (no lookup cost)', () => {
  test('blocks a cached landline without calling Twilio', async () => {
    wireDb({ line_type: 'landline' });
    const res = await checkLineType(SMS);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NON_MOBILE_SMS_RECIPIENT');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(recordNonMobileSuppression).not.toHaveBeenCalled(); // already known/suppressed
  });

  test('allows a cached mobile without calling Twilio', async () => {
    wireDb({ line_type: 'mobile' });
    const res = await checkLineType(SMS);
    expect(res).toEqual({ ok: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('checkLineType — cache miss → one-time lookup', () => {
  test('landline: caches, records suppression, and blocks', async () => {
    const { q, insertChain } = wireDb(undefined);
    mockFetch.mockResolvedValue({ lineTypeIntelligence: { type: 'landline' } });

    const res = await checkLineType(SMS);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(q.insert).toHaveBeenCalledWith(expect.objectContaining({ phone: '+18777175476', line_type: 'landline' }));
    expect(insertChain.onConflict).toHaveBeenCalledWith('phone');
    expect(recordNonMobileSuppression).toHaveBeenCalledWith({ phone: '+18777175476', source: 'proactive_lookup_landline' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NON_MOBILE_SMS_RECIPIENT');
  });

  test('mobile: caches and allows, no suppression', async () => {
    const { q } = wireDb(undefined);
    mockFetch.mockResolvedValue({ lineTypeIntelligence: { type: 'mobile' } });

    const res = await checkLineType(SMS);

    expect(res).toEqual({ ok: true });
    expect(q.insert).toHaveBeenCalledWith(expect.objectContaining({ line_type: 'mobile' }));
    expect(recordNonMobileSuppression).not.toHaveBeenCalled();
  });

  test('fails OPEN (allows) when the Twilio lookup errors', async () => {
    const { q } = wireDb(undefined);
    mockFetch.mockRejectedValue(new Error('twilio 503'));

    const res = await checkLineType(SMS);

    expect(res).toEqual({ ok: true });
    expect(q.insert).not.toHaveBeenCalled(); // nothing to cache
    expect(recordNonMobileSuppression).not.toHaveBeenCalled();
  });

  test('allows voip/tollFree through (only landline is treated as non-SMS-capable)', async () => {
    wireDb(undefined);
    mockFetch.mockResolvedValue({ lineTypeIntelligence: { type: 'nonFixedVoip' } });
    const res = await checkLineType(SMS);
    expect(res).toEqual({ ok: true });
    expect(recordNonMobileSuppression).not.toHaveBeenCalled();
  });

  test('fails OPEN without a paid lookup when the cache READ errors (table missing/unreadable)', async () => {
    const { q } = wireDb(undefined, { readThrows: true });
    const res = await checkLineType(SMS);
    expect(res).toEqual({ ok: true });
    expect(mockFetch).not.toHaveBeenCalled(); // never pay for a lookup we can't cache
    expect(q.insert).not.toHaveBeenCalled();
  });
});
