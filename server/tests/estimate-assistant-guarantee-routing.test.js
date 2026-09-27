// Owner ruling 2026-09-27: on an estimate without estimate-wide terms, every
// guarantee question gets the deterministic per-service answer. A live model
// must never decide which service a question means (Codex #4982: "What
// warranty did I buy?" reached the models, whose answers were not checked
// against guarantees.serviceTerms).
jest.mock('../services/llm/call', () => ({ dispatch: jest.fn() }));

const { dispatch } = require('../services/llm/call');
const { answerEstimateQuestion } = require('../services/estimate-assistant');

const BOND = 'Purchased termite bond: 5-year term with re-treatment coverage.';

describe('Ask Waves routes guarantee questions before the live models', () => {
  beforeEach(() => {
    dispatch.mockReset();
    dispatch.mockResolvedValue({ ok: true, text: 'model answer' });
  });

  test('a termite estimate answers deterministically, with each service under its own name', async () => {
    const result = await answerEstimateQuestion({
      database: null,
      question: 'What warranty did I buy?',
      estimate: { id: 'synthetic-estimate', status: 'sent', monthly_total: 38 },
      estData: { result: { recurring: { services: [
        { service: 'termite_bond', name: 'Termite Bond (5-Year Term)', annual: 216 },
        { service: 'rodent_bait', name: 'Rodent Bait Stations', monthly: 20 },
      ] } } },
      noGuaranteeClaims: true,
    });
    expect(result.source).toBe('fallback');
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.answer).toContain(`Termite Bond: ${BOND}`);
  });

  test.each([
    'What happens if the termites come back?',
    'Will you treat them again if they return?',
    'What coverage comes with this?',
  ])('recurrence wording is routed too: %s', async (question) => {
    const result = await answerEstimateQuestion({
      database: null,
      question,
      estimate: { id: 'synthetic-estimate', status: 'sent', monthly_total: 38 },
      estData: { result: { recurring: { services: [
        { service: 'termite_bond', name: 'Termite Bond (5-Year Term)', annual: 216 },
      ] } } },
      noGuaranteeClaims: true,
    });
    expect(result.source).toBe('fallback');
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.answer).toContain(`Termite Bond: ${BOND}`);
  });

  test('a model answer that makes a plan-terms claim is never served on a termite estimate', async () => {
    dispatch.mockResolvedValue({ ok: true, text: 'Absolutely, our money-back guarantee covers the whole plan.' });
    const args = {
      database: null,
      question: 'Tell me about this plan',
      estimate: { id: 'synthetic-estimate', status: 'sent', monthly_total: 38 },
      estData: { result: { recurring: { services: [
        { service: 'termite_bait', name: 'Termite Bait Monitoring', mo: 38 },
      ] } } },
      noGuaranteeClaims: true,
    };
    const guarded = await answerEstimateQuestion(args);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(guarded.source).toBe('fallback');
    expect(guarded.answer).not.toMatch(/money-back/i);
    // A model answer without such a claim is served as usual.
    dispatch.mockResolvedValue({ ok: true, text: 'The plan monitors bait stations around your home.' });
    const served = await answerEstimateQuestion(args);
    expect(served).toEqual({ answer: 'The plan monitors bait stations around your home.', source: 'openai' });
  });

  test('an ordinary pest plan still reaches the live model', async () => {
    const result = await answerEstimateQuestion({
      database: null,
      question: 'What warranty did I buy?',
      estimate: { id: 'synthetic-estimate', status: 'sent', monthly_total: 55 },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 55,
        included: [{ service: 'pest_control', label: 'Pest Control' }] }] },
    });
    expect(result.source).toBe('openai');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
