const { answerEstimateQuestionFallback } = require('../services/estimate-assistant');

// Safety questions are force-routed to the deterministic fallback whenever
// support rows exist (answerEstimateQuestion), so the label-verified safety
// facts estimate-ai-context attaches must surface HERE or they surface nowhere.
describe('Ask Waves fallback — label-verified safety facts', () => {
  const verifiedContext = {
    serviceMode: 'recurring',
    services: [{ label: 'Lawn Care', detail: 'Weed control applications', summary: 'Lawn Care — weed control' }],
    supportContext: {
      productCatalog: [
        {
          source: 'admin_product_catalog',
          activeIngredient: 'Carfentrazone + 2,4-D + MCPP + Dicamba',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Keep people and pets off treated areas until dry.',
          rainfastMinutes: 180,
        },
        {
          source: 'admin_product_catalog',
          activeIngredient: 'Quinclorac',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Keep people and pets off treated areas until dry.',
          rainfastMinutes: 60,
        },
      ],
    },
  };

  test('"is it safe for pets?" answers from the reviewed label: re-entry, signal word, most conservative rainfast', () => {
    const answer = answerEstimateQuestionFallback('Is it safe for pets?', verifiedContext);
    expect(answer).toContain('Label re-entry guidance: Keep people and pets off treated areas until dry.');
    expect(answer).toContain('Label signal word: Caution.');
    // Two rainfast windows (180 / 60) — quote the longest, never the shortest.
    expect(answer).toContain('rainfast in about 180 minutes');
    expect(answer).not.toContain('60 minutes');
    // Applicator PPE is technician-facing and must never read as customer instructions.
    expect(answer).not.toContain('PPE');
    // The existing guardrail copy stays.
    expect(answer).toContain('follow the product label directions');
  });

  test('distinct re-entry texts are listed per product, not merged', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    context.supportContext.productCatalog[1].reentry = 'Re-enter after about 4 hours.';
    const answer = answerEstimateQuestionFallback('Are the chemicals safe for kids?', context);
    expect(answer).toContain('Label re-entry guidance by product:');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).toContain('Re-enter after about 4 hours');
  });

  test('unverified rows contribute no safety claims even if stale fields are present', () => {
    const answer = answerEstimateQuestionFallback('Is it safe for kids?', {
      ...verifiedContext,
      supportContext: {
        productCatalog: [{
          source: 'admin_product_catalog',
          activeIngredient: 'Bifenthrin',
          labelVerified: false,
          // estimate-ai-context nulls these for unverified rows; even if a
          // stale/hand-built row carried them, the fallback must not read them.
          signalWord: 'Warning',
          reentry: 'Unverified re-entry claim.',
          rainfastMinutes: 30,
        }],
      },
    });
    expect(answer).toContain('Bifenthrin');
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('Warning');
    expect(answer).not.toContain('rainfast');
    expect(answer).toContain('follow the product label directions');
  });

  test('no catalog rows at all still gets the generic safety answer', () => {
    const answer = answerEstimateQuestionFallback('Is it pet safe?', {
      serviceMode: 'recurring',
      services: [{ label: 'Pest Control', detail: 'Quarterly', summary: 'Pest Control — quarterly' }],
    });
    expect(answer).toContain('follow the product label directions');
    expect(answer).not.toContain('Label re-entry guidance');
  });
});
