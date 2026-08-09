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

  test('allows nonFixedVoip (Google Voice-style) and tollFree through', async () => {
    wireDb(undefined);
    mockFetch.mockResolvedValue({ lineTypeIntelligence: { type: 'nonFixedVoip' } });
    const res = await checkLineType(SMS);
    expect(res).toEqual({ ok: true });
    expect(recordNonMobileSuppression).not.toHaveBeenCalled();
  });

  // 2026-08-06: an estimate link bounced off a Comcast fixedVoip (Twilio 30006)
  // — home-phone VoIP is not SMS-capable, so it is blocked proactively like a
  // landline instead of costing a bounced send to learn.
  test('fixedVoip (home-phone VoIP): caches and blocks WITHOUT persisting a suppression', async () => {
    const { q } = wireDb(undefined);
    mockFetch.mockResolvedValue({ lineTypeIntelligence: { type: 'fixedVoip' } });

    const res = await checkLineType(SMS);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(q.insert).toHaveBeenCalledWith(expect.objectContaining({ phone: '+18777175476', line_type: 'fixedVoip' }));
    // No suppression row on purpose: check_suppression runs BEFORE this
    // validator, so a persisted row would outlive LINETYPE_BLOCK_FIXED_VOIP=
    // false and keep already-seen numbers blocked after a rollback.
    expect(recordNonMobileSuppression).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NON_MOBILE_SMS_RECIPIENT');
    expect(res.reason).toContain('fixed-VoIP');
  });

  test('blocks a cached fixedVoip without calling Twilio', async () => {
    wireDb({ line_type: 'fixedVoip' });
    const res = await checkLineType(SMS);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NON_MOBILE_SMS_RECIPIENT');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('LINETYPE_BLOCK_FIXED_VOIP=false narrows the set back to landline-only (default keeps fixedVoip blocked)', () => {
    process.env.LINETYPE_BLOCK_FIXED_VOIP = 'false';
    let narrowed;
    jest.isolateModules(() => { narrowed = require('../services/messaging/validators/line-type'); });
    delete process.env.LINETYPE_BLOCK_FIXED_VOIP;
    expect(narrowed.NON_SMS_LINE_TYPES.has('fixedVoip')).toBe(false);
    expect(narrowed.NON_SMS_LINE_TYPES.has('landline')).toBe(true);

    let dflt;
    jest.isolateModules(() => { dflt = require('../services/messaging/validators/line-type'); });
    expect(dflt.NON_SMS_LINE_TYPES.has('fixedVoip')).toBe(true);
    expect(dflt.NON_SMS_LINE_TYPES.has('landline')).toBe(true);
  });

  test('rollback lifts the block for ALREADY-SEEN numbers: cached fixedVoip is allowed when the toggle is off', async () => {
    process.env.LINETYPE_BLOCK_FIXED_VOIP = 'false';
    let check;
    let dbIso;
    jest.isolateModules(() => {
      dbIso = require('../models/db');
      const fg = require('../config/feature-gates');
      fg.isEnabled.mockReturnValue(true);
      ({ checkLineType: check } = require('../services/messaging/validators/line-type'));
    });
    delete process.env.LINETYPE_BLOCK_FIXED_VOIP;
    const q = { where: jest.fn(() => q), first: jest.fn(async () => ({ line_type: 'fixedVoip' })) };
    dbIso.mockImplementation(() => q);
    // A pre-rollback fixedVoip leaves only a cache row (no suppression), so the
    // narrowed set is the ONLY thing standing between this number and delivery.
    await expect(check(SMS)).resolves.toEqual({ ok: true });
  });

  test('fails OPEN without a paid lookup when the cache READ errors (table missing/unreadable)', async () => {
    const { q } = wireDb(undefined, { readThrows: true });
    const res = await checkLineType(SMS);
    expect(res).toEqual({ ok: true });
    expect(mockFetch).not.toHaveBeenCalled(); // never pay for a lookup we can't cache
    expect(q.insert).not.toHaveBeenCalled();
  });
});
