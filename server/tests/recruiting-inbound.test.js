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
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const state = { apps: [], existingReply: null, newerCustomerText: null, inserts: [], insertFails: false };
function builder(table) {
  const q = {};
  ['whereRaw', 'whereIn', 'where', 'whereNot', 'whereNotIn', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.modify = jest.fn((fn) => { fn(q); return q; });
  q.select = jest.fn(async () => (table === 'job_applications' ? state.apps : []));
  // sms_log: the "newer customer-facing text" probe uses whereNot(job_%); the
  // idempotency probe does not.
  q.first = jest.fn(async () => (table === 'sms_log' ? (q.whereNot.mock.calls.length ? state.newerCustomerText : state.existingReply) : null));
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

const { matchApplicantReply, recordApplicantReply, REPLY_MESSAGE_TYPE } = require('../services/recruiting-inbound');

const NOW = Date.now();
const sentEntry = (daysAgo) => ({ at: new Date(NOW - daysAgo * 86400000).toISOString(), stage: 'interview_invite', channel: 'sms', outcome: 'sent', from_number: '+19415550199' });

beforeEach(() => {
  state.apps = [{ id: 'app-1', comms_history: [sentEntry(2)] }];
  state.newerCustomerText = null;
  state.inserts = [];
  state.insertFails = false;
  state.existingReply = null;
  mockAppend.mockClear();
  mockTrigger.mockClear();
  mockDb.mockClear();
});

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
    const q = mockDb.mock.results.find((r) => r.value && r.value.whereNot.mock.calls.length).value;
    expect(q.whereNotIn).toHaveBeenCalledWith('message_type', ['internal_alert', 'admin_alert', 'ai_assistant', 'ai_assistant_reply']);
    expect(q.whereNot).toHaveBeenCalledWith('message_type', 'like', 'job_%');
    // scheduled / blocked / failed customer rows never count — delivery evidence only
    expect(q.whereIn).toHaveBeenCalledWith('status', ['sent', 'delivered']);
    // ... and only texts from the SAME Waves line the recruiting text used
    const fromPredicate = q.whereRaw.mock.calls.find((c) => /from_phone/.test(c[0]));
    expect(fromPredicate[1]).toEqual([['19415550199', '9415550199']]);
  });
  test('a replayed text uses its ACTUAL send time: a customer text sent between queue and replay does not override', async () => {
    // queued at day -1 (overnight), replayed by the cron at 08:00 (day 0);
    // the customer text at day -0.5 is OLDER than the real handoff.
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(1), outcome: 'sent', finalized_at: new Date(NOW - 3600000).toISOString() }] }];
    state.newerCustomerText = null; // the route's created_at > handoff predicate would not match the -0.5d text
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toEqual({ applicationId: 'app-1' });
    const q = mockDb.mock.results.find((r) => r.value && r.value.whereNot.mock.calls.length).value;
    const bound = q.where.mock.calls.find((c) => c[0] === 'created_at')[2];
    expect(Math.abs(bound.getTime() - (NOW - 3600000))).toBeLessThan(1000);
  });
  test('an in-flight replay (handoff with replay_attempted_at) uses the attempt time, so a customer text sent between enqueue and replay does not override', async () => {
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(1), outcome: 'handoff', replay_attempted_at: new Date(NOW - 1800000).toISOString() }] }];
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toEqual({ applicationId: 'app-1' });
    const q = mockDb.mock.results.find((r) => r.value && r.value.whereNot.mock.calls.length).value;
    const bound = q.where.mock.calls.find((c) => c[0] === 'created_at')[2];
    expect(Math.abs(bound.getTime() - (NOW - 1800000))).toBeLessThan(1000);
  });
  test('a queued (deferred) recruiting text is owner-only context for a reply too', async () => {
    state.apps = [{ id: 'app-1', comms_history: [{ ...sentEntry(0.1), outcome: 'deferred' }] }];
    await expect(matchApplicantReply('+19415550142', '+19415550199')).resolves.toEqual({ applicationId: 'app-1' });
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

  test('writes the sms_log row + history in one transaction, then rings the admin-only bell (no PII)', async () => {
    await expect(recordApplicantReply(args)).resolves.toEqual({ persisted: true, duplicate: false });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].row).toMatchObject({ customer_id: null, direction: 'inbound', message_type: REPLY_MESSAGE_TYPE, twilio_sid: 'SM1' });
    // history append rides the SAME transaction handle
    expect(mockAppend).toHaveBeenCalledWith('app-1', [expect.objectContaining({ stage: 'applicant_reply', channel: 'sms', outcome: 'received', to: 'masked(0142)', body: 'Yes, Tuesday works', by: 'applicant' })], mockDb);
    expect(mockTrigger).toHaveBeenCalledWith('job_applicant_reply', { applicationId: 'app-1' });
    expect(JSON.stringify(mockTrigger.mock.calls[0][1])).not.toMatch(/0142|Tuesday/);
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
