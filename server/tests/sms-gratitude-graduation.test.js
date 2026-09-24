jest.mock('../models/db', () => jest.fn(() => { throw new Error('generic signals unavailable'); }));
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/sms-suggest-mode', () => ({ isEscalationIntent: () => false }));
jest.mock('../services/sms-shadow-drafter', () => ({
  PROMPT_VERSION: 'test-version', resolveEffectiveVoiceProfile: async () => null,
}));
jest.mock('../services/sms-gratitude-qualification', () => ({ evaluateGratitudeQualification: jest.fn() }));

const graduation = require('../services/sms-graduation');
const { evaluateGratitudeQualification } = require('../services/sms-gratitude-qualification');

beforeEach(() => jest.clearAllMocks());

test('only the fixed gratitude intent can use the non-delivery exam', async () => {
  const exam = { eligible: true, blockers: [], basis: 'fixed_copy_exam' };
  evaluateGratitudeQualification.mockResolvedValue(exam);
  await expect(graduation.evaluateAutoSendEligibility({ intent: 'gratitude_reply', voiceProfileVersion: 9 })).resolves.toBe(exam);
  expect(evaluateGratitudeQualification).toHaveBeenCalledWith(expect.objectContaining({ voiceProfileVersion: 9 }));
  evaluateGratitudeQualification.mockClear();
  await expect(graduation.evaluateAutoSendEligibility({ intent: 'general_customer_sms_needs_review' })).resolves.toMatchObject({ eligible: false });
  expect(evaluateGratitudeQualification).not.toHaveBeenCalled();
});

test.each(['shadow', 'auto_send'])('readiness for %s reports exam evidence without inventing live acceptance', async mode => {
  evaluateGratitudeQualification.mockResolvedValue({ eligible: true, blockers: [], basis: 'fixed_copy_exam' });
  const readiness = (await graduation.computeReadiness({ intents: [{ intent: 'gratitude_reply', mode }] })).get('gratitude_reply');
  expect(readiness.eligible).toBe(true);
  expect(readiness.eligibleFor).toBe(mode === 'shadow' ? 'auto_send' : null);
  expect(readiness.judge.judged).toBe(0);
  if (mode === 'auto_send') expect(readiness.autoSendHealth.sendReady).toBe(true);
});

test('a missing or failed gratitude exam blocks promotion and existing auto-send health', async () => {
  evaluateGratitudeQualification.mockResolvedValue({ eligible: false, blockers: ['Qualification missing'] });
  const readiness = (await graduation.computeReadiness({ intents: [{ intent: 'gratitude_reply', mode: 'auto_send' }] })).get('gratitude_reply');
  expect(readiness.eligible).toBe(false);
  expect(readiness.autoSendHealth).toEqual({ sendReady: false, blockers: ['Qualification missing'] });
});
