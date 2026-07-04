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
          category: 'herbicide',
          activeIngredient: 'Carfentrazone + 2,4-D + MCPP + Dicamba',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Keep people and pets off treated areas until dry.',
          rainfastMinutes: 180,
          irrigationNotes: null,
          serviceKeys: ['lawn_care'],
        },
        {
          source: 'admin_product_catalog',
          category: 'herbicide',
          activeIngredient: 'Quinclorac',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Keep people and pets off treated areas until dry.',
          rainfastMinutes: 60,
          irrigationNotes: null,
          serviceKeys: ['lawn_care'],
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

  test('watering questions surface the label irrigation guidance', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    context.supportContext.productCatalog[0].irrigationNotes = 'Avoid irrigation for 24 hours after application.';
    const answer = answerEstimateQuestionFallback('Can I water the lawn after the application?', context);
    expect(answer).toContain('Label watering/irrigation guidance: Avoid irrigation for 24 hours after application.');
  });

  // The support context is built from ALL estimate services, so a bundle must
  // not answer a mosquito question with the lawn herbicide's label facts.
  const bundleContext = {
    serviceMode: 'recurring',
    services: [
      { label: 'Lawn Care', detail: 'Weed control applications', summary: 'Lawn Care — weed control' },
      { label: 'Mosquito Control', detail: 'Barrier treatment', summary: 'Mosquito Control — barrier' },
    ],
    supportContext: {
      productCatalog: [
        {
          source: 'admin_product_catalog',
          category: 'herbicide',
          activeIngredient: 'Quinclorac',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Keep people and pets off treated areas until dry.',
          rainfastMinutes: 180,
          irrigationNotes: 'Avoid irrigation for 24 hours after application.',
          serviceKeys: ['lawn_care'],
        },
        {
          source: 'admin_product_catalog',
          category: 'adulticide',
          activeIngredient: 'Deltamethrin',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Stay out of the treated area until sprays have dried.',
          rainfastMinutes: 30,
          irrigationNotes: null,
          serviceKeys: ['mosquito'],
        },
      ],
    },
  };

  test('family-specific question on a bundle only quotes that family\'s label facts', () => {
    const answer = answerEstimateQuestionFallback('Is the mosquito spray safe for pets?', bundleContext);
    expect(answer).toContain('Stay out of the treated area until sprays have dried');
    expect(answer).toContain('rainfast in about 30 minutes');
    // The lawn herbicide's facts must not leak into a mosquito answer.
    expect(answer).not.toContain('rainfast in about 180 minutes');
    expect(answer).not.toContain('until dry.');
    expect(answer).not.toContain('irrigation');
  });

  test('family question with no attributable product says nothing rather than quoting the wrong label', () => {
    const context = JSON.parse(JSON.stringify(bundleContext));
    // Only the lawn product remains verified/attributed; the mosquito question
    // must fail closed to generic copy instead of borrowing lawn facts.
    context.supportContext.productCatalog = context.supportContext.productCatalog
      .filter((row) => row.serviceKeys.includes('lawn_care'));
    const answer = answerEstimateQuestionFallback('Is the mosquito spray safe for pets?', context);
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('rainfast');
    expect(answer).toContain('follow the product label directions');
  });
});
