jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => ({ bellWritten: true, push: null })),
}));

const db = require('../models/db');
const { triggerNotification } = require('../services/notification-triggers');
const {
  alertTwilioFailure,
  publicDedupeKey,
  sanitizeFailureText,
} = require('../services/twilio-failure-alerts');

const CLAIM_SQL_RE = /INSERT INTO twilio_alert_dedupe/i;

function dedupeTableQuery() {
  return {
    where: jest.fn().mockReturnThis(),
    del: jest.fn().mockResolvedValue(1),
  };
}

// db.raw serves two roles: the awaited atomic claim (returns pg-shaped
// { rows }) and inert SQL fragments used as query-builder values (prune's
// interval). Route on the SQL text; `claims` yields one result per claim
// call, defaulting to "window claimed".
function mockDbRaw(claims = []) {
  const queue = [...claims];
  db.raw = jest.fn((sql) => {
    if (CLAIM_SQL_RE.test(String(sql))) {
      const claimed = queue.length ? queue.shift() : true;
      return Promise.resolve({ rows: claimed ? [{ dedupe_key: 'claimed' }] : [] });
    }
    return { __rawFragment: sql };
  });
}

function claimedKeys() {
  return db.raw.mock.calls
    .filter(([sql]) => CLAIM_SQL_RE.test(String(sql)))
    .map(([, params]) => params[0]);
}

describe('Twilio failure alerts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation(() => dedupeTableQuery());
    mockDbRaw();
  });

  test('sanitizes provider text before admin notification dispatch', async () => {
    await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      phase: 'send_api',
      status: 'failed',
      sid: 'SM1234567890abcdef1234567890abcdef',
      errorCode: '30007',
      errorMessage: 'Twilio failed for +19415551212 and SM1234567890abcdef1234567890abcdef sent to owner@example.com',
      from: '+19413187612',
      to: '+19415551212',
      dedupeKey: 'twilio:sms:outbound:+19415551212:SM1234567890abcdef1234567890abcdef',
    });

    expect(triggerNotification).toHaveBeenCalledWith('twilio_failure', expect.objectContaining({
      errorMessage: 'Twilio failed for [phone] and SM...abcdef sent to [email]',
      fromMasked: '***7612',
      toMasked: '***1212',
      sidMasked: 'SM...abcdef',
      dedupeKey: expect.stringMatching(/^twilio:[a-f0-9]{16}$/),
    }));

    const payload = triggerNotification.mock.calls[0][1];
    expect(payload).not.toHaveProperty('sid');
    expect(payload.dedupeKey).not.toContain('+19415551212');
    expect(payload.dedupeKey).not.toContain('SM1234567890abcdef1234567890abcdef');
  });

  test('sanitizes lookup urls, phone numbers, emails, and Twilio SIDs', () => {
    expect(sanitizeFailureText(
      'GET https://lookups.twilio.com/v2/PhoneNumbers/%2B19415551212?Fields=caller_name failed for +19415551212 ZZ1234567890abcdef1234567890abcdef test@example.com'
    )).toBe(
      'GET https://lookups.twilio.com/v2/PhoneNumbers/[phone]?Fields=caller_name failed for [phone] ZZ...abcdef [email]'
    );
  });

  test('hashes caller-provided dedupe keys before persistence', () => {
    expect(publicDedupeKey('raw:+19415551212:SM1234567890abcdef1234567890abcdef'))
      .toMatch(/^twilio:[a-f0-9]{16}$/);
  });

  test('keys inbound failures by the caller, not the shared business line', async () => {
    const shared = {
      channel: 'voice',
      direction: 'inbound',
      phase: 'webhook',
      status: 'failed',
      to: '+19413187612', // Waves business line — identical on every inbound failure
    };
    await alertTwilioFailure({ ...shared, sid: 'CA1', from: '+19415550001' });
    await alertTwilioFailure({ ...shared, sid: 'CA2', from: '+19415550002' });
    await alertTwilioFailure({ ...shared, sid: 'CA3', from: '+19415550001' });

    const keys = claimedKeys();
    expect(keys).toHaveLength(3);
    // Different callers must never share a key (one caller's failure would
    // suppress the others' alerts for the whole window).
    expect(keys[0]).not.toBe(keys[1]);
    // Same caller dedupes together even though every event has a fresh SID.
    expect(keys[2]).toBe(keys[0]);
  });

  test('outbound repeat failures to one number share a key across SIDs and statuses', async () => {
    mockDbRaw([true, false]);
    const shared = {
      channel: 'sms',
      direction: 'outbound',
      phase: 'delivery',
      from: '+19413187612',
      to: '+19415550009',
      errorCode: '30003',
    };
    const first = await alertTwilioFailure({ ...shared, sid: 'SM1', status: 'failed' });
    const second = await alertTwilioFailure({ ...shared, sid: 'SM2', status: 'undelivered' });

    const keys = claimedKeys();
    expect(keys[1]).toBe(keys[0]);
    expect(first).toEqual({ bellWritten: true, push: null });
    expect(second).toEqual({ skipped: true, reason: 'duplicate' });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('falls back to a per-event key when no remote number is available', async () => {
    const shared = { channel: 'voice', direction: 'inbound', phase: 'webhook', status: 'failed' };
    await alertTwilioFailure({ ...shared, sid: 'CA1' });
    await alertTwilioFailure({ ...shared, sid: 'CA2' });

    const keys = claimedKeys();
    // No phone to key on → per-SID keys, which fail toward alerting.
    expect(keys[0]).not.toBe(keys[1]);
    expect(triggerNotification).toHaveBeenCalledTimes(2);
  });

  test('unknown direction takes the per-event fallback, never a shared-line key', async () => {
    // The voice /call-status catch path passes direction 'unknown'. Guessing
    // outbound there would key on `to` — a Waves business line — and one
    // error would suppress every other caller to that line for the window.
    const shared = {
      channel: 'voice',
      direction: 'unknown',
      phase: 'status',
      status: 'failed',
      from: '+19415550001',
      to: '+19413187612',
    };
    await alertTwilioFailure({ ...shared, sid: 'CA1' });
    await alertTwilioFailure({ ...shared, sid: 'CA2' });

    const keys = claimedKeys();
    expect(keys[0]).not.toBe(keys[1]);
    expect(triggerNotification).toHaveBeenCalledTimes(2);
  });

  test('fails open when the dedupe table is unavailable', async () => {
    db.raw = jest.fn((sql) => {
      if (CLAIM_SQL_RE.test(String(sql))) return Promise.reject(new Error('relation missing'));
      return { __rawFragment: sql };
    });

    const result = await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      status: 'failed',
      to: '+19415550009',
    });

    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ bellWritten: true, push: null });
  });

  test('releases the claimed window when notification dispatch throws', async () => {
    const query = dedupeTableQuery();
    db.mockImplementation(() => query);
    triggerNotification.mockRejectedValueOnce(new Error('bell down'));

    await expect(alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      status: 'failed',
      to: '+19415550009',
    })).rejects.toThrow('bell down');

    const [claimKey] = claimedKeys();
    expect(query.where).toHaveBeenCalledWith({ dedupe_key: claimKey });
    expect(query.del).toHaveBeenCalled();
  });

  test('releases the window when dispatch reports no channel succeeded', async () => {
    // triggerNotification never throws in practice — bell/push failures come
    // back as a result object. That result must still give the window back.
    const query = dedupeTableQuery();
    db.mockImplementation(() => query);
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: null, error: 'db down' });

    const result = await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      status: 'failed',
      to: '+19415550009',
    });

    expect(result).toEqual({ bellWritten: false, push: null, error: 'db down' });
    const [claimKey] = claimedKeys();
    expect(query.where).toHaveBeenCalledWith({ dedupe_key: claimKey });
    expect(query.del).toHaveBeenCalled();
  });

  test('push-only delivery keeps the claimed window', async () => {
    const query = dedupeTableQuery();
    db.mockImplementation(() => query);
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: { sent: 2, failed: 0 } });

    await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      status: 'failed',
      to: '+19415550009',
    });

    // The release path is the only `where({ dedupe_key })` caller.
    expect(query.where).not.toHaveBeenCalledWith(
      expect.objectContaining({ dedupe_key: expect.anything() })
    );
  });
});
