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
