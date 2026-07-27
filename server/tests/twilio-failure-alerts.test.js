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

// One fresh chain object per db('twilio_alert_dedupe') invocation so the
// release (where({dedupe_key}) → del), confirm (where({dedupe_key}) →
// update), and prune (where('last_alerted_at', ...) → del) paths can be told
// apart after the fact.
let queries;

function newQuery() {
  const q = {
    where: jest.fn().mockReturnThis(),
    del: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue(1),
  };
  queries.push(q);
  return q;
}

function byKeyCalls(method) {
  return queries.filter((q) =>
    q.where.mock.calls.some(([arg]) => arg && typeof arg === 'object' && 'dedupe_key' in arg) &&
    q[method].mock.calls.length > 0
  );
}
const releaseCalls = () => byKeyCalls('del');
const confirmCalls = () => byKeyCalls('update');

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
    queries = [];
    db.mockImplementation(() => newQuery());
    db.fn = { now: jest.fn(() => 'NOW()') };
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

  test('formatted, bare, and E.164 forms of one number share a key', async () => {
    const shared = { channel: 'sms', direction: 'outbound', phase: 'delivery', status: 'failed' };
    await alertTwilioFailure({ ...shared, sid: 'SM1', to: '(941) 555-0009' });
    await alertTwilioFailure({ ...shared, sid: 'SM2', to: '+19415550009' });
    await alertTwilioFailure({ ...shared, sid: 'SM3', to: '9415550009' });

    const keys = claimedKeys();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
  });

  test('non-phone remote values take the per-event fallback', async () => {
    const shared = { channel: 'voice', direction: 'inbound', phase: 'webhook', status: 'failed', to: '+19413187612' };
    await alertTwilioFailure({ ...shared, sid: 'CA1', from: 'client:anonymous' });
    await alertTwilioFailure({ ...shared, sid: 'CA2', from: 'client:anonymous' });

    const keys = claimedKeys();
    expect(keys[0]).not.toBe(keys[1]);
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

  test('events with no phone and no SID never share a key', async () => {
    // Malformed webhooks can arrive with an empty body — a constant fallback
    // key would suppress every later such failure for the whole window.
    const shared = { channel: 'sms', direction: 'inbound', phase: 'webhook', status: 'failed' };
    await alertTwilioFailure({ ...shared });
    await alertTwilioFailure({ ...shared });

    const keys = claimedKeys();
    expect(keys[0]).not.toBe(keys[1]);
    expect(triggerNotification).toHaveBeenCalledTimes(2);
  });

  test('fails open when the dedupe table is unavailable, and never releases what it does not own', async () => {
    db.raw = jest.fn((sql) => {
      if (CLAIM_SQL_RE.test(String(sql))) return Promise.reject(new Error('claim down'));
      return { __rawFragment: sql };
    });
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: null, error: 'still down' });

    const result = await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      status: 'failed',
      to: '+19415550009',
    });

    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ bellWritten: false, push: null, error: 'still down' });
    // Unowned claim: no release, no confirm — releasing could delete a valid
    // in-window row established by an earlier delivered alert.
    expect(releaseCalls()).toHaveLength(0);
    expect(confirmCalls()).toHaveLength(0);
  });

  test('confirms the lease to the full window after successful delivery', async () => {
    await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      status: 'failed',
      to: '+19415550009',
    });

    expect(confirmCalls()).toHaveLength(1);
    expect(confirmCalls()[0].update).toHaveBeenCalledWith({ delivered_at: 'NOW()' });
    expect(releaseCalls()).toHaveLength(0);
  });

  test('push-only delivery confirms the claimed window', async () => {
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: { sent: 2, failed: 0 } });

    await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      status: 'failed',
      to: '+19415550009',
    });

    expect(confirmCalls()).toHaveLength(1);
    expect(releaseCalls()).toHaveLength(0);
  });

  test('releases the claimed window when notification dispatch throws', async () => {
    triggerNotification.mockRejectedValueOnce(new Error('bell down'));

    await expect(alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      status: 'failed',
      to: '+19415550009',
    })).rejects.toThrow('bell down');

    expect(releaseCalls()).toHaveLength(1);
    expect(confirmCalls()).toHaveLength(0);
  });

  test('releases the window when dispatch reports no channel succeeded', async () => {
    // triggerNotification never throws in practice — bell/push failures come
    // back as a result object. That result must still give the window back.
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: null, error: 'db down' });

    const result = await alertTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      status: 'failed',
      to: '+19415550009',
    });

    expect(result).toEqual({ bellWritten: false, push: null, error: 'db down' });
    expect(releaseCalls()).toHaveLength(1);
    expect(confirmCalls()).toHaveLength(0);
  });

  test('an overlapping same-key caller takes over after a failed dispatch', async () => {
    // The losing claimant must not be skipped while the winner's delivery is
    // still unknown: it waits, and if the winner fails and releases the
    // window, it claims and dispatches itself.
    let resolveFirst;
    triggerNotification
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => ({ bellWritten: true, push: null }));

    const shared = { channel: 'sms', direction: 'outbound', status: 'failed', to: '+19415550009' };
    // Same tick, no await between them — the exact race where an
    // asynchronously-checked map would let both proceed independently.
    const first = alertTwilioFailure({ ...shared, sid: 'SM1' });
    const second = alertTwilioFailure({ ...shared, sid: 'SM2' });
    await new Promise((r) => setImmediate(r));

    expect(triggerNotification).toHaveBeenCalledTimes(1);
    resolveFirst({ bellWritten: false, push: null, error: 'db down' });

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ bellWritten: false, push: null, error: 'db down' });
    expect(r2).toEqual({ bellWritten: true, push: null });
    expect(triggerNotification).toHaveBeenCalledTimes(2);
    // The failed winner released; the taker confirmed its own claim.
    expect(releaseCalls()).toHaveLength(1);
    expect(confirmCalls()).toHaveLength(1);
  });
});
