jest.mock('../services/ops-digest', () => ({ deliverOpsDigest: jest.fn(async ({ sendEmail }) => sendEmail()) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('db called'); });
  fn.raw = jest.fn(() => { throw new Error('db.raw called'); });
  fn.transaction = jest.fn(() => { throw new Error('db.transaction called'); });
  fn.destroy = jest.fn();
  fn.fn = { now: () => 'now()' };
  return fn;
});
jest.mock('../services/lead-from-extraction', () => ({
  createLeadFromExtraction: jest.fn(async () => { throw new Error('capture floor called'); }),
  stampCustomerPreferredLanguage: jest.fn(async () => false),
}));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../services/voice-profile-distiller', () => ({ MAX_PROFILE_CHARS: 4000, getApprovedVoiceProfile: jest.fn(async () => null) }));
jest.mock('../services/twilio-failure-alerts', () => ({ maskSid: (s) => String(s || 'none') }));

// Every grading assertion from the original 271-test safety suite, plus the
// final recognition regressions, is an explicit offline corpus case. Keep
// status and failure-detail expectations independent of parser internals.
const corpus = require('./fixtures/voice-relay-safety-corpus.json');
const { runCheck } = require('../services/eval/voice-relay-replay')._internals;

test.each(corpus)('$name', ({ expectation, record, expected, detailPattern, detailFlags }) => {
  const result = runCheck(expectation, record);
  expect(result.status).toBe(expected);
  if (detailPattern) expect(result.detail).toMatch(new RegExp(detailPattern, detailFlags));
});
