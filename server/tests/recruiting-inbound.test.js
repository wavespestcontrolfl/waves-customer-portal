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

const state = { apps: [], existingReply: null, inserts: [], insertFails: false };
function builder(table) {
  const q = {};
  ['whereRaw', 'whereIn', 'where', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(async () => (table === 'job_applications' ? state.apps : []));
  q.first = jest.fn(async () => (table === 'sms_log' ? state.existingReply : null));
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
const sentEntry = (daysAgo) => ({ at: new Date(NOW - daysAgo * 86400000).toISOString(), stage: 'interview_invite', channel: 'sms', outcome: 'sent' });

beforeEach(() => {
  state.apps = [{ id: 'app-1', comms_history: [sentEntry(2)] }];
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
