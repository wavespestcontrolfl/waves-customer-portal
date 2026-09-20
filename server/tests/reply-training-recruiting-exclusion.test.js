jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { _internals: { shouldCaptureReply } } = require('../services/reply-training-capture');
test('recruiting texts (job_*) are never captured as customer-response training examples', () => {
  const base = { channel: 'sms', direction: 'outbound', authorType: 'admin', adminUserId: 'admin-1', body: 'See you Tuesday' };
  expect(shouldCaptureReply({ ...base, messageType: 'manual' })).toBe(true);
  for (const t of ['job_owner_reply', 'job_interview_invite', 'JOB_APPLICANT_REPLY']) {
    expect(shouldCaptureReply({ ...base, messageType: t })).toBe(false);
  }
});
