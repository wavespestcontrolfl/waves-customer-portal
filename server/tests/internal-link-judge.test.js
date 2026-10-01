jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { dispatchWithFallback } = require('../services/llm/call');
const { judgeLink } = require('../services/content/internal-link-judge');

const link = {
  anchor: 'neem oil',
  paragraph: 'Is neem oil safe around pets?',
  sourceTitle: 'Do Pest Sprays Harm Pets',
  sourceUrl: '/pets/',
  targetTitle: 'Neem Oil for Whiteflies',
  targetUrl: '/pest-control/neem-oil-for-whiteflies/',
  targetSummary: 'Whiteflies on hibiscus…',
};

afterEach(() => { delete process.env.AUTONOMOUS_INTERNAL_LINK_LLM_JUDGE; });

test('passes the model verdict through', async () => {
  dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { approve: false, reason: 'Pet-safety reader expects a pet page.' } });
  expect(await judgeLink(link)).toEqual({ ok: true, approve: false, reason: 'Pet-safety reader expects a pet page.' });
  const [, payload] = dispatchWithFallback.mock.calls[0];
  expect(payload.text).toContain('Anchor words to be linked: "neem oil"');
  expect(payload.jsonMode).toBe(true);
});

test('fails closed on no answer, a malformed answer, or a throw', async () => {
  dispatchWithFallback.mockResolvedValueOnce({ ok: false, reason: 'no_key' });
  expect(await judgeLink(link)).toEqual({ ok: false, reason: 'judge_unavailable:no_key' });
  dispatchWithFallback.mockResolvedValueOnce({ ok: true, json: { approve: 'yes' } });
  expect((await judgeLink(link)).ok).toBe(false);
  dispatchWithFallback.mockRejectedValueOnce(new Error('boom'));
  expect(await judgeLink(link)).toEqual({ ok: false, reason: 'judge_error' });
});

test('kill switch approves without a model call', async () => {
  process.env.AUTONOMOUS_INTERNAL_LINK_LLM_JUDGE = 'false';
  dispatchWithFallback.mockClear();
  expect(await judgeLink(link)).toMatchObject({ ok: true, approve: true });
  expect(dispatchWithFallback).not.toHaveBeenCalled();
});
