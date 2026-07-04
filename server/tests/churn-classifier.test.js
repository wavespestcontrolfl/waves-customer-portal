// Fail-closed contract: every miss — blank text, live-provider failure, junk
// output, unknown code, thrown error — must land on 'unclassified'. The
// cancellation processor runs this last and unguarded results would leave a
// churned row violating the CHECK constraint.
jest.mock('../services/llm/call', () => ({
  dispatch: jest.fn(),
  callAnthropic: jest.fn(),
}));

const { dispatch, callAnthropic } = require('../services/llm/call');
const { classifyChurnReason, CHURN_REASON_CODES } = require('../services/churn-classifier');

describe('classifyChurnReason', () => {
  beforeEach(() => {
    dispatch.mockReset();
    callAnthropic.mockReset();
  });

  test('taxonomy stays in lockstep with the migration CHECK list', () => {
    expect(CHURN_REASON_CODES).toEqual([
      'price', 'moving', 'service_quality', 'results', 'competitor',
      'seasonal_pause', 'financial', 'no_longer_needed', 'other', 'unclassified',
    ]);
  });

  test('live model classifies; code is normalized', async () => {
    dispatch.mockResolvedValue({ ok: true, json: { code: ' Price ' } });
    const out = await classifyChurnReason('Way too expensive, found someone for half');
    expect(out).toEqual({ code: 'price', source: 'live' });
    expect(callAnthropic).not.toHaveBeenCalled();
  });

  test('live miss falls back to Claude; fallback code used', async () => {
    dispatch.mockResolvedValue({ ok: false, reason: 'error' });
    callAnthropic.mockResolvedValue({ ok: true, json: { code: 'moving' } });
    const out = await classifyChurnReason('We sold the house and are relocating to Georgia');
    expect(out).toEqual({ code: 'moving', source: 'fallback' });
  });

  test('unknown code from the model fails closed, not through', async () => {
    dispatch.mockResolvedValue({ ok: true, json: { code: 'vibes' } });
    callAnthropic.mockResolvedValue({ ok: true, json: { code: 'also_not_a_code' } });
    const out = await classifyChurnReason('some text');
    expect(out.code).toBe('unclassified');
  });

  test('blank/boilerplate text skips the model entirely', async () => {
    expect((await classifyChurnReason('')).code).toBe('unclassified');
    expect((await classifyChurnReason('  ')).code).toBe('unclassified');
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a thrown provider error never escapes', async () => {
    dispatch.mockRejectedValue(new Error('network down'));
    const out = await classifyChurnReason('cancel my service');
    expect(out.code).toBe('unclassified');
  });
});
