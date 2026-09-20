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

const state = { app: null, texted: null, inserts: [], insertFails: false };
function builder(table) {
  const q = {};
  ['whereRaw', 'whereIn', 'where', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => (table === 'job_applications' ? state.app : state.texted));
  q.insert = jest.fn(async (row) => {
    if (state.insertFails) throw Object.assign(new Error('insert into sms_log ... values (+19415550142 ...)'), { name: 'error', code: '23505' });
    state.inserts.push({ table, row });
  });
  return q;
}
const mockDb = jest.fn((table) => builder(table));
mockDb.raw = jest.fn((sql) => ({ sql }));
jest.mock('../models/db', () => mockDb);

const { matchApplicantReply, recordApplicantReply, REPLY_MESSAGE_TYPE } = require('../services/recruiting-inbound');

beforeEach(() => {
  state.app = { id: 'app-1' };
  state.texted = { id: 'sms-1' };
  state.inserts = [];
  state.insertFails = false;
  mockAppend.mockClear();
  mockTrigger.mockClear();
  mockDb.mockClear();
});

describe('matchApplicantReply', () => {
  test('matches an open application that we recently texted', async () => {
    await expect(matchApplicantReply('+19415550142')).resolves.toEqual({ applicationId: 'app-1' });
  });
  test('no open application -> null (no sms_log lookup)', async () => {
    state.app = null;
    await expect(matchApplicantReply('+19415550142')).resolves.toBeNull();
    expect(mockDb).toHaveBeenCalledTimes(1);
  });
  test('application exists but we never texted it a job_* message -> null (ordinary inbound path)', async () => {
    state.texted = null;
    await expect(matchApplicantReply('+19415550142')).resolves.toBeNull();
  });
  test('unparseable phone -> null without any query', async () => {
    await expect(matchApplicantReply('nope')).resolves.toBeNull();
    expect(mockDb).not.toHaveBeenCalled();
  });
});

describe('recordApplicantReply', () => {
  const args = { applicationId: 'app-1', from: '+19415550142', to: '+19415550199', body: 'Yes, Tuesday works', messageSid: 'SM1', mediaCount: 0 };

  test('writes a job_applicant_reply sms_log row with no customer, appends history, rings the admin-only bell', async () => {
    await expect(recordApplicantReply(args)).resolves.toBe(true);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].row).toMatchObject({ customer_id: null, direction: 'inbound', message_type: REPLY_MESSAGE_TYPE, twilio_sid: 'SM1' });
    expect(mockAppend).toHaveBeenCalledWith('app-1', [expect.objectContaining({ stage: 'applicant_reply', channel: 'sms', outcome: 'received', to: 'masked(0142)', body: 'Yes, Tuesday works', by: 'applicant' })]);
    expect(mockTrigger).toHaveBeenCalledWith('job_applicant_reply', { applicationId: 'app-1' });
    // No PII in the bell payload.
    expect(JSON.stringify(mockTrigger.mock.calls[0][1])).not.toMatch(/0142|Tuesday/);
  });

  test('sms_log failure -> still appends + rings, reports not persisted, logs no PII', async () => {
    state.insertFails = true;
    const logger = require('../services/logger');
    await expect(recordApplicantReply(args)).resolves.toBe(false);
    expect(mockAppend).toHaveBeenCalled();
    expect(mockTrigger).toHaveBeenCalled();
    expect(logger.error.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/0142/);
  });
});
