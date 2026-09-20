/**
 * Applicant replies are matched narrowly (open application + recent
 * outbound job_* text to that phone), recorded on the application, typed
 * job_applicant_reply in sms_log, and raised only as the admin-only bell.
 */
const mockAppend = jest.fn(async () => {});
const mockTrigger = jest.fn(async () => ({}));
jest.mock('../services/recruiting-comms', () => ({
  appendCommsHistory: (...a) => mockAppend(...a),
  maskPhone: (p) => `masked(${String(p).slice(-4)})`,
  errorSummary: (e) => (e && e.name) || 'Error',
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: (...a) => mockTrigger(...a) }));
const mockBellRetire = jest.fn(async () => 1);
jest.mock('../services/notification-service', () => ({ markApplicantRepliesReadAdmin: (...a) => mockBellRetire(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const state = { apps: [], existingReply: null, newerCustomerText: null, inserts: [], insertFails: false, readState: null };
function builder(table) {
  const q = {};
  ['whereRaw', 'whereIn', 'where', 'whereNot', 'whereNotIn', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.modify = jest.fn((fn) => { fn(q); return q; });
  q.select = jest.fn(async () => (table === 'job_applications' ? state.apps : []));
  // sms_log: the "newer customer-facing text" probe carries the NOT LIKE
  // job_% type predicate; the idempotency probe does not.
  q.__isCustomerTextProbe = () => q.whereRaw.mock.calls.some((c) => /NOT LIKE 'job/.test(c[0]));
  q.first = jest.fn(async (...cols) => {
    if (table !== 'sms_log') return null;
    if (cols.includes('is_read')) return state.readState; // the post-write unread check
    return q.__isCustomerTextProbe() ? state.newerCustomerText : state.existingReply;
  });
  q.insert = jest.fn(async (row) => {
    if (state.insertFails) throw Object.assign(new Error('insert into sms_log ... values (+19415550142 ...)'), { name: 'error', code: '23505' });
    state.inserts.push({ table, row });
  });
  return q;
}
const mockDb = jest.fn((table) => builder(table));
mockDb.raw = jest.fn((sql) => ({ sql }));
mockDb.transaction = jest.fn(async (fn) => fn(mockDb));
jest.mock('../models/db', () => mockDb);

const { matchApplicantReply, recordApplicantReply, REPLY_MESSAGE_TYPE, _expireRecruitingPhoneCacheForTests } = require('../services/recruiting-inbound');

const NOW = Date.now();
const sentEntry = (daysAgo) => ({ at: new Date(NOW - daysAgo * 86400000).toISOString(), stage: 'interview_invite', channel: 'sms', outcome: 'sent', from_number: '+19415550199' });

beforeEach(() => {
  state.apps = [{ id: 'app-1', comms_history: [sentEntry(2)] }];
  state.newerCustomerText = null;
  state.inserts = [];
  state.insertFails = false;
  state.existingReply = null;
  state.readState = null;
  mockBellRetire.mockClear();
  mockDb.transaction.mockClear();
  mockAppend.mockClear();
  mockTrigger.mockClear();
  mockDb.mockClear();
});

const customerTextProbe = () => mockDb.mock.results.find((r) => r.value && r.value.__isCustomerTextProbe && r.value.__isCustomerTextProbe()).value;

describe('matchApplicantReply', () => {
  test('matches the open application that received a recruiting text', async () => {
    await expect(matchApplicantReply('+19415550142')).resolves.toEqual({ applicationId: 'app-1' });
  });
  test('no open application -> null', async () => {
    state.apps = [];
    await expect(matchApplicantReply('+19415550142')).resolves.toBeNull();
  });
  test('open application that was never texted (no sms sent entry) -> null (ordinary inbound path)', async () => {
    state.apps = [{ id: 'app-1', comms_history: [{ channel: 'email', outcome: 'sent', at: new Date(NOW).toISOString() }] }];
    await expect(matchApplicantReply('+19415550142')).resolves.toBeNull();
  });
  test('a text older than the window does not count', async () => {
    state.apps = [{ id: 'app-1', comms_history: [sentEntry(60)] }];
    await expect(matchApplicantReply('+19415550142')).resolves.toBeNull();
  });
  test('two open applications on one phone: the reply goes to the one that RECEIVED the text, not the newest', async () => {
    state.apps = [
      { id: 'app-A', comms_history: [sentEntry(3)] },
      { id: 'app-B', comms_history: [] }, // submitted later, never texted
    ];
    await expect(matchApplicantReply('+19415550142')).resolves.toEqual({ applicationId: 'app-A' });
  });
  test('an unreconciled handoff entry (crash mid-send) still classifies as a text', async () => {
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(1), outcome: 'handoff' }] }];
    await expect(matchApplicantReply('+19415550142')).resolves.toEqual({ applicationId: 'app-1' });
  });
  test('uncertain deliveries count as a text the applicant may be answering', async () => {
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(1), outcome: 'uncertain' }] }];
    await expect(matchApplicantReply('+19415550142')).resolves.toEqual({ applicationId: 'app-1' });
  });
  test('a NEWER DELIVERED customer-facing text after the handoff hands the reply back to the customer path', async () => {
    state.newerCustomerText = { id: 'sms-newer' };
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toBeNull();
    const q = customerTextProbe();
    // NULL-typed rows (legacy/direct-insert customer texts) ARE customer
    // context (Codex r14 P1): the predicate coalesces before excluding the
    // explicit internal types and job_* rows.
    const typePredicate = q.whereRaw.mock.calls.find((c) => /NOT LIKE 'job/.test(c[0]));
    expect(typePredicate[0]).toBe("COALESCE(message_type, '') NOT IN (?, ?, ?, ?) AND COALESCE(message_type, '') NOT LIKE 'job\\_%'");
    expect(typePredicate[1]).toEqual(['internal_alert', 'admin_alert', 'ai_assistant', 'ai_assistant_reply']);
    // scheduled / blocked / failed customer rows never count — delivery evidence only
    expect(q.whereIn).toHaveBeenCalledWith('status', ['sent', 'delivered']);
    // ... and only texts from the SAME Waves line the recruiting text used
    const fromPredicate = q.whereRaw.mock.calls.find((c) => /from_phone/.test(c[0]));
    expect(fromPredicate[1]).toEqual([['19415550199', '9415550199']]);
  });
  test('a replayed text uses its ACTUAL send time: a customer text sent between queue and replay does not override', async () => {
    // queued at day -1 (overnight), replayed by the cron at 08:00 (day 0);
    // the customer text at day -0.5 is OLDER than the real handoff. The
    // registry stamps replay_attempted_at right before Twilio; settlement
    // (finalized_at) is not a delivery-order stamp (Codex r16 P1).
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(1), outcome: 'sent', replay_attempted_at: new Date(NOW - 3600000).toISOString(), finalized_at: new Date(NOW - 3500000).toISOString() }] }];
    state.newerCustomerText = null; // the route's created_at > handoff predicate would not match the -0.5d text
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toEqual({ applicationId: 'app-1' });
    const q = customerTextProbe();
    const bound = q.where.mock.calls.find((c) => c[0] === 'created_at')[2];
    expect(Math.abs(bound.getTime() - (NOW - 3600000))).toBeLessThan(1000);
  });
  test('an in-flight replay (handoff with replay_attempted_at) uses the attempt time, so a customer text sent between enqueue and replay does not override', async () => {
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(1), outcome: 'handoff', replay_attempted_at: new Date(NOW - 1800000).toISOString() }] }];
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toEqual({ applicationId: 'app-1' });
    const q = customerTextProbe();
    const bound = q.where.mock.calls.find((c) => c[0] === 'created_at')[2];
    expect(Math.abs(bound.getTime() - (NOW - 1800000))).toBeLessThan(1000);
  });
  test('an immediate send ranks by handoff_at, not the earlier pending write: a customer text between the two does not override', async () => {
    // pending written at -2h, stamped handoff at -30m; a customer text at
    // -1h is OLDER than the real handoff (Codex r14 P1).
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(2 / 24), outcome: 'handoff', handoff_at: new Date(NOW - 1800000).toISOString() }] }];
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toEqual({ applicationId: 'app-1' });
    const q = customerTextProbe();
    const bound = q.where.mock.calls.find((c) => c[0] === 'created_at')[2];
    expect(Math.abs(bound.getTime() - (NOW - 1800000))).toBeLessThan(1000);
  });
  test('a LATE settlement never moves the text after a customer text that really followed it: the bound is handoff_at, not finalized_at', async () => {
    // handoff at -2h, Twilio response persisted at -10m; a customer text at
    // -1h must still override, so the probe bound is the handoff instant.
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(3), outcome: 'sent', handoff_at: new Date(NOW - 7200000).toISOString(), finalized_at: new Date(NOW - 600000).toISOString() }] }];
    state.newerCustomerText = { id: 'sms-newer' };
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toBeNull();
    const q = customerTextProbe();
    const bound = q.where.mock.calls.find((c) => c[0] === 'created_at')[2];
    expect(Math.abs(bound.getTime() - (NOW - 7200000))).toBeLessThan(1000);
  });
  test('a pending entry (before the provider boundary) is NOT delivery evidence', async () => {
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(0.1), outcome: 'pending' }] }];
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toBeNull();
  });
  test('a queued (deferred) recruiting text is NOT delivery evidence — a reply from that phone stays on the customer path', async () => {
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(0.1), outcome: 'deferred' }] }];
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toBeNull();
  });
  test('two recruiting lines: a reply to line A matches A\'s evidence even when a newer owner reply went out from line B', async () => {
    state.apps = [{ id: 'app-1', comms_history: [
      { ...sentEntry(2), from_number: '+19415550199' },                              // invite from A
      { ...sentEntry(1), stage: 'owner_reply', from_number: '+19415550777' },        // newer owner reply from B
    ] }];
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toEqual({ applicationId: 'app-1' });
    await expect(matchApplicantReply('+19415550142', '+19415550777')).resolves.toEqual({ applicationId: 'app-1' });
  });
  test('a reply sent to a DIFFERENT Waves number than the recruiting text went out from keeps the ordinary path', async () => {
    await expect(matchApplicantReply('+19415550142', '+19415550100')).resolves.toBeNull();
  });
  test('sms_log missing entirely (best-effort logging failed) -> the durable handoff evidence still wins', async () => {
    state.newerCustomerText = null;
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toEqual({ applicationId: 'app-1' });
  });
  test('a handoff entry without a stamped from_number still classifies (number check is skipped, not failed)', async () => {
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(1), from_number: undefined }] }];
    await expect(matchApplicantReply('+19415550142', '+19415550100')).resolves.toEqual({ applicationId: 'app-1' });
  });
  test('unparseable phone -> null without any query', async () => {
    await expect(matchApplicantReply('nope')).resolves.toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });
});

describe('recordApplicantReply', () => {
  const args = { applicationId: 'app-1', from: '+19415550142', to: '+19415550199', body: 'Yes, Tuesday works', messageSid: 'SM1', mediaCount: 0 };

  test('a reply the owner read in the gap between commit and bell creation retires that one bell (Codex r23 P2)', async () => {
    state.readState = { is_read: true };
    await recordApplicantReply({ applicationId: 'app-1', from: '+19415550142', to: '+19415550199', body: 'Yes', messageSid: 'SM-read' });
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockBellRetire).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'app-1', replyId: 'SM-read' }));
    state.readState = { is_read: false };
    mockBellRetire.mockClear();
    await recordApplicantReply({ applicationId: 'app-1', from: '+19415550142', to: '+19415550199', body: 'Yes', messageSid: 'SM-unread' });
    expect(mockBellRetire).not.toHaveBeenCalled();
  });

  test('writes the sms_log row + history in one transaction, then rings the admin-only bell (no PII)', async () => {
    await expect(recordApplicantReply(args)).resolves.toEqual({ persisted: true, duplicate: false });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].row).toMatchObject({ customer_id: null, direction: 'inbound', message_type: REPLY_MESSAGE_TYPE, twilio_sid: 'SM1' });
    // history append rides the SAME transaction handle
    expect(mockAppend).toHaveBeenCalledWith('app-1', [expect.objectContaining({ stage: 'applicant_reply', channel: 'sms', outcome: 'received', to: 'masked(0142)', body: 'Yes, Tuesday works', by: 'applicant' })], mockDb);
    expect(mockTrigger).toHaveBeenCalledWith('job_applicant_reply', { applicationId: 'app-1', replyId: 'SM1' });
    expect(JSON.stringify(mockTrigger.mock.calls[0][1])).not.toMatch(/0142|Tuesday/);
  });

  test('attachments ride the ledger as stored references (key, never a public URL) with the unified message id', async () => {
    await recordApplicantReply({ ...args, body: '', mediaCount: 1, media: [{ key: 'sms/in/abc.jpg', url: 'https://twilio.example/x', contentType: 'image/jpeg' }], unifiedMessageId: 'msg-9' });
    const entry = mockAppend.mock.calls[0][1][0];
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.media).toEqual([{ key: 'sms/in/abc.jpg', url: null, contentType: 'image/jpeg' }]);
    expect(entry.unified_message_id).toBe('msg-9');
    expect(entry.body).toBe('1 photo');
  });

  test('a redelivered SID is a no-op: nothing inserted, no second bell', async () => {
    state.existingReply = { id: 'sms-existing' };
    await expect(recordApplicantReply(args)).resolves.toEqual({ persisted: true, duplicate: true });
    expect(state.inserts).toHaveLength(0);
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  test('persistence failure THROWS (caller fails closed), rings nothing, and never logs the phone', async () => {
    state.insertFails = true;
    await expect(recordApplicantReply(args)).rejects.toBeTruthy();
    expect(mockTrigger).not.toHaveBeenCalled();
    const logger = require('../services/logger');
    expect(logger.error.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/0142/);
  });
});

describe('matchApplicantReply — unprovisioned recruiting schema', () => {
  test('42P01 (no job_applications table) is a definite "not recruiting", other errors propagate', async () => {
    mockDb.mockImplementationOnce(() => { throw Object.assign(new Error('relation "job_applications" does not exist'), { code: '42P01' }); });
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toBeNull();
    mockDb.mockImplementationOnce(() => { throw Object.assign(new Error('timeout'), { code: '57014' }); });
    await expect(matchApplicantReply('+19415550142', '+19415550199')).rejects.toBeTruthy();
  });
});

describe('isPlausibleRecruitingPhone — blast-radius bound for the fail-closed path', () => {
  const { isPlausibleRecruitingPhone, _resetRecruitingPhoneCacheForTests } = require('../services/recruiting-inbound');
  beforeEach(() => { _resetRecruitingPhoneCacheForTests(); mockDb.mockClear(); });

  function snapshot(rows) {
    mockDb.mockImplementation(() => {
      const q = { whereIn: jest.fn(() => q), select: jest.fn(async () => rows) };
      return q;
    });
  }

  test('true for a phone with an open application, false otherwise, and the snapshot is reused within the TTL', async () => {
    snapshot([{ digits: '19415550142' }]);
    await expect(isPlausibleRecruitingPhone('+19415550142')).resolves.toBe(true);
    await expect(isPlausibleRecruitingPhone('+19415550999')).resolves.toBe(false);
    expect(mockDb).toHaveBeenCalledTimes(1);
  });

  test('a refresh failure keeps the last snapshot; with no snapshot ever loaded the answer is unknown (null → fail closed)', async () => {
    mockDb.mockImplementation(() => { throw Object.assign(new Error('down'), { code: '57014' }); });
    await expect(isPlausibleRecruitingPhone('+19415550142')).resolves.toBeNull();
    snapshot([{ digits: '9415550142' }]);
    await expect(isPlausibleRecruitingPhone('+19415550142')).resolves.toBe(true);
    _resetRecruitingPhoneCacheForTests();
  });

  test('after a FAILED refresh only a positive from the stale snapshot is trusted — a negative is unknown (null), never false (Codex r17 P1)', async () => {
    snapshot([{ digits: '9415550142' }]);
    await expect(isPlausibleRecruitingPhone('+19415550142')).resolves.toBe(true);
    _expireRecruitingPhoneCacheForTests();
    mockDb.mockImplementation(() => { throw Object.assign(new Error('down'), { code: '57014' }); });
    await expect(isPlausibleRecruitingPhone('+19415550142')).resolves.toBe(true);   // stale positive still stands
    await expect(isPlausibleRecruitingPhone('+19415550999')).resolves.toBeNull();   // an applicant created since the snapshot would be absent
    _resetRecruitingPhoneCacheForTests();
  });
});
