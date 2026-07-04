const {
  answerEstimateQuestionFallback,
  FORCE_FALLBACK_QUESTION_PATTERN,
} = require('../services/estimate-assistant');

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
          title: 'herbicide active ingredient',
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
          title: 'adulticide active ingredient',
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
    // The active-ingredient sentence is scoped the same way — the lawn
    // herbicide must not be named in a mosquito answer either.
    expect(answer).not.toContain('Quinclorac');
    expect(answer).toContain('follow the product label directions');
  });

  test('a question naming BOTH bundle families gets both products\' label facts', () => {
    const answer = answerEstimateQuestionFallback('Are the lawn and mosquito treatments safe for pets?', bundleContext);
    expect(answer).toContain('Label re-entry guidance by product:');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).toContain('Stay out of the treated area until sprays have dried');
    // Most conservative rainfast across every named family.
    expect(answer).toContain('rainfast in about 180 minutes');
    expect(answer).toContain('Label watering/irrigation guidance: Avoid irrigation for 24 hours after application.');
  });

  test('a question naming a specific ingredient narrows to that product even with no family word', () => {
    const answer = answerEstimateQuestionFallback('Is bifenthrin safe for pets?', {
      serviceMode: 'recurring',
      services: [
        { label: 'Lawn Care', detail: 'Weed control applications', summary: 'Lawn Care — weed control' },
        { label: 'Pest Control', detail: 'Exterior perimeter plan', summary: 'Pest Control — perimeter' },
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
            irrigationNotes: null,
            serviceKeys: ['lawn_care'],
          },
          {
            source: 'admin_product_catalog',
            category: 'insecticide',
            activeIngredient: 'Bifenthrin',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'Re-enter once sprays have dried.',
            rainfastMinutes: 45,
            irrigationNotes: null,
            serviceKeys: ['pest_control'],
          },
        ],
      },
    });
    expect(answer).toContain('Re-enter once sprays have dried');
    expect(answer).toContain('rainfast in about 45 minutes');
    // The lawn herbicide the customer did NOT ask about stays out — of the
    // label facts AND the active-ingredient sentence.
    expect(answer).not.toContain('rainfast in about 180 minutes');
    expect(answer).not.toContain('until dry.');
    expect(answer).not.toContain('Quinclorac');
    expect(answer).toContain('Bifenthrin');
  });

  test('short punctuated ingredient names like 2,4-D still narrow to their product', () => {
    const answer = answerEstimateQuestionFallback('Is 2,4-D safe for pets?', {
      serviceMode: 'recurring',
      services: [
        { label: 'Lawn Care', detail: 'Weed control applications', summary: 'Lawn Care — weed control' },
        { label: 'Pest Control', detail: 'Exterior perimeter plan', summary: 'Pest Control — perimeter' },
      ],
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
            category: 'insecticide',
            activeIngredient: 'Bifenthrin',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'Re-enter once sprays have dried.',
            rainfastMinutes: 45,
            irrigationNotes: null,
            serviceKeys: ['pest_control'],
          },
        ],
      },
    });
    expect(answer).toContain('2,4-D');
    expect(answer).toContain('rainfast in about 180 minutes');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).not.toContain('rainfast in about 45 minutes');
    expect(answer).not.toContain('Bifenthrin');
  });

  test('the force-fallback gate routes watering questions away from the live models', () => {
    // These must hit the deterministic fallback (where label facts live), not
    // an LLM that could miss or hallucinate the irrigation guidance.
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('Can I water after treatment?')).toBe(true);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('When can I run the sprinklers again?')).toBe(true);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('How soon can I irrigate?')).toBe(true);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('Is it safe for my dog?')).toBe(true);
    // Rainfast timing comes from reviewed rainfastMinutes — deterministic only.
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('How soon is it rainfast?')).toBe(true);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('What if it rains after treatment?')).toBe(true);
    // Rain-after phrasing counts only when tied to the treatment.
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('What if it rains right after you treat?')).toBe(true);
    // Bare "when can I water?" is irrigation intent even without context.
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('When can I water?')).toBe(true);
    // Non-safety questions still reach the live models — bare "rain" and
    // "treatment" are scheduling/duration vocabulary, not safety intent.
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('What time will the technician arrive?')).toBe(false);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('Will you still come if it rains?')).toBe(false);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('Will you still come if it rains after 2pm?')).toBe(false);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('How long does the mosquito treatment last?')).toBe(false);
    // "standing water" and "keep <pest> off" are service/efficacy wording.
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('Do you treat standing water?')).toBe(false);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('Will the treatment keep mosquitoes off my patio?')).toBe(false);
  });

  test('rain-timing scheduling questions never get label copy from the fallback', () => {
    const answer = answerEstimateQuestionFallback('Will you still come if it rains after 2pm?', verifiedContext);
    expect(answer).not.toContain('follow the product label directions');
    expect(answer).not.toContain('Label re-entry guidance');
  });

  test('"outside plants" watering questions keep the lawn label facts', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    context.supportContext.productCatalog[0].irrigationNotes = 'Avoid irrigation for 24 hours after application.';
    // "outside" is a location here, not a pest-treatment scope — the lawn
    // rows carrying the irrigation guidance must survive scoping.
    const answer = answerEstimateQuestionFallback('Can I water my outside plants after treatment?', context);
    expect(answer).toContain('Label watering/irrigation guidance: Avoid irrigation for 24 hours after application.');
  });

  test('"safe for the lawn" scopes to the asked-about spray, not the lawn family', () => {
    const answer = answerEstimateQuestionFallback('Is the mosquito spray safe for the lawn?', bundleContext);
    expect(answer).toContain('Stay out of the treated area until sprays have dried');
    expect(answer).not.toContain('Quinclorac');
    expect(answer).not.toContain('until dry.');
    expect(answer).not.toContain('rainfast in about 180 minutes');
  });

  test('rainfast questions land in the safety branch and quote the label window', () => {
    const answer = answerEstimateQuestionFallback('What if it rains after the treatment?', verifiedContext);
    expect(answer).toContain('rainfast in about 180 minutes');
  });

  test('generic "active ingredient" wording does not bypass family scoping', () => {
    // Every catalog row's title is "<category> active ingredient", so these
    // words must not count as naming a specific product.
    const answer = answerEstimateQuestionFallback('Is the active ingredient in the mosquito spray safe for pets?', bundleContext);
    expect(answer).toContain('Deltamethrin');
    expect(answer).toContain('Stay out of the treated area until sprays have dried');
    expect(answer).not.toContain('Quinclorac');
    expect(answer).not.toContain('rainfast in about 180 minutes');
    expect(answer).not.toContain('until dry.');
  });

  test('"bug spray" scopes to pest-control products on a mixed estimate', () => {
    const context = JSON.parse(JSON.stringify(bundleContext));
    context.services.push({ label: 'Pest Control', detail: 'Exterior perimeter plan', summary: 'Pest Control — perimeter' });
    context.supportContext.productCatalog.push({
      source: 'admin_product_catalog',
      title: 'insecticide active ingredient',
      category: 'insecticide',
      activeIngredient: 'Bifenthrin',
      labelVerified: true,
      signalWord: 'Caution',
      reentry: 'Re-enter once sprays have dried.',
      rainfastMinutes: 45,
      irrigationNotes: null,
      serviceKeys: ['pest_control'],
    });
    const answer = answerEstimateQuestionFallback('Is the bug spray safe for pets?', context);
    expect(answer).toContain('Bifenthrin');
    expect(answer).toContain('Re-enter once sprays have dried');
    expect(answer).toContain('rainfast in about 45 minutes');
    expect(answer).not.toContain('Quinclorac');
    expect(answer).not.toContain('Deltamethrin');
    expect(answer).not.toContain('rainfast in about 180 minutes');
  });

  test('plant-watering questions do not get ant-control copy', () => {
    const answer = answerEstimateQuestionFallback('Can I water my plants after treatment?', verifiedContext);
    // "plants" must not trip the ant approach ("ants" suffix match).
    expect(answer).not.toContain('For ants,');
    expect(answer).toContain('follow the product label directions');
  });

  test('one product\'s rainfast window is not claimed for products without one', () => {
    const context = JSON.parse(JSON.stringify(bundleContext));
    // The mosquito label states no rainfast window (seed leaves it blank).
    context.supportContext.productCatalog[1].rainfastMinutes = null;
    const answer = answerEstimateQuestionFallback('Are the lawn and mosquito treatments safe for pets?', context);
    expect(answer).not.toContain('Treated areas are rainfast');
    expect(answer).toContain('Where a product label states a rainfast window, treated areas are rainfast in about 180 minutes');
    expect(answer).toContain('not every product on this estimate has a stated window on file');
  });

  test('a scoped unverified product blocks the blanket rainfast claim too', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    // Unverified rows carry no safety fields at all — their rainfast is
    // unknown, so the verified products' window must not read as blanket.
    context.supportContext.productCatalog.push({
      source: 'admin_product_catalog',
      category: 'adjuvant',
      activeIngredient: 'Surfactant blend',
      labelVerified: false,
      signalWord: null,
      reentry: null,
      rainfastMinutes: null,
      irrigationNotes: null,
      serviceKeys: ['lawn_care'],
    });
    const answer = answerEstimateQuestionFallback('Is it safe for pets?', context);
    expect(answer).not.toContain('Treated areas are rainfast');
    expect(answer).toContain('Where a product label states a rainfast window, treated areas are rainfast in about 180 minutes');
  });

  test('family questions fail closed on unattributed rows, even on a single-family estimate', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    context.supportContext.productCatalog.forEach((row) => { row.serviceKeys = []; });
    const answer = answerEstimateQuestionFallback('Is the lawn spray safe for pets?', context);
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('rainfast');
    expect(answer).toContain('follow the product label directions');
  });

  test('a mentioned product not attributed to this estimate is never quoted', () => {
    // The catalog search can pull EVERY herbicide when the question says
    // "herbicide" — a row not linked to this estimate's services must not
    // answer as if it were the customer's product.
    const context = JSON.parse(JSON.stringify(verifiedContext));
    context.supportContext.productCatalog.push({
      source: 'admin_product_catalog',
      category: 'herbicide',
      activeIngredient: 'Glyphosate',
      labelVerified: true,
      signalWord: 'Warning',
      reentry: 'Foreign product re-entry claim.',
      rainfastMinutes: 240,
      irrigationNotes: null,
      serviceKeys: [],
    });
    const answer = answerEstimateQuestionFallback('Is the herbicide safe for pets?', context);
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).not.toContain('Glyphosate');
    expect(answer).not.toContain('Foreign product re-entry claim');
    expect(answer).not.toContain('240');
  });

  // Lawn + pest bundle with one attributed product per family.
  const lawnPestContext = {
    serviceMode: 'recurring',
    services: [
      { label: 'Lawn Care', detail: 'Weed control applications', summary: 'Lawn Care — weed control' },
      { label: 'Pest Control', detail: 'Exterior perimeter plan', summary: 'Pest Control — perimeter' },
    ],
    supportContext: {
      productCatalog: [
        {
          source: 'admin_product_catalog',
          title: 'herbicide active ingredient',
          category: 'herbicide',
          activeIngredient: 'Quinclorac',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Keep people and pets off treated areas until dry.',
          rainfastMinutes: 180,
          irrigationNotes: null,
          serviceKeys: ['lawn_care'],
        },
        {
          source: 'admin_product_catalog',
          title: 'insecticide active ingredient',
          category: 'insecticide',
          activeIngredient: 'Bifenthrin',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Re-enter once sprays have dried.',
          rainfastMinutes: 45,
          irrigationNotes: null,
          serviceKeys: ['pest_control'],
        },
      ],
    },
  };

  test('a family question about a service NOT on this estimate quotes nothing', () => {
    // Question terms can pull mosquito products into the support context
    // even on a lawn-only estimate — the customer didn't buy them.
    const answer = answerEstimateQuestionFallback('Is the mosquito spray safe for pets?', {
      serviceMode: 'recurring',
      services: [{ label: 'Lawn Care', detail: 'Weed control applications', summary: 'Lawn Care — weed control' }],
      supportContext: {
        productCatalog: [
          JSON.parse(JSON.stringify(bundleContext.supportContext.productCatalog[0])),
          JSON.parse(JSON.stringify(bundleContext.supportContext.productCatalog[1])),
        ],
      },
    });
    expect(answer).not.toContain('Deltamethrin');
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('rainfast');
    expect(answer).toContain('follow the product label directions');
  });

  test('"exterior spray" questions scope to pest control on a mixed estimate', () => {
    const answer = answerEstimateQuestionFallback('Is the exterior spray safe for pets?', lawnPestContext);
    expect(answer).toContain('Bifenthrin');
    expect(answer).toContain('Re-enter once sprays have dried');
    expect(answer).toContain('rainfast in about 45 minutes');
    expect(answer).not.toContain('Quinclorac');
    expect(answer).not.toContain('rainfast in about 180 minutes');
  });

  test('"lawn insect" questions stay lawn-scoped despite the insecticide category', () => {
    const answer = answerEstimateQuestionFallback('Is the lawn insect treatment safe for pets?', lawnPestContext);
    expect(answer).toContain('Quinclorac');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).toContain('rainfast in about 180 minutes');
    // "insect" must not mention-match the insecticide CATEGORY.
    expect(answer).not.toContain('Bifenthrin');
    expect(answer).not.toContain('sprays have dried');
    expect(answer).not.toContain('rainfast in about 45 minutes');
  });

  test('a truncated catalog slice forces the qualified rainfast copy', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    // The catalog query caps its slice; a full slice can't prove every
    // scoped product has a stated window.
    context.supportContext.productCatalogTruncated = true;
    const answer = answerEstimateQuestionFallback('Is it safe for pets?', context);
    expect(answer).not.toContain('Treated areas are rainfast');
    expect(answer).toContain('Where a product label states a rainfast window, treated areas are rainfast in about 180 minutes');
  });

  test('one-time mode does not answer from the recurring alternative\'s products', () => {
    // The recurring alternative still rides along in recurringServices, but
    // the customer is looking at the selected one-time service.
    const answer = answerEstimateQuestionFallback('Is it safe for pets?', {
      serviceMode: 'one_time',
      services: [{ label: 'Pest Control', detail: 'One-time treatment', summary: 'Pest Control — one-time' }],
      recurringServices: [{ label: 'Lawn Care', detail: 'Weed control applications', summary: 'Lawn Care — weed control' }],
      supportContext: {
        productCatalog: JSON.parse(JSON.stringify(lawnPestContext.supportContext.productCatalog)),
      },
    });
    expect(answer).toContain('Bifenthrin');
    expect(answer).toContain('rainfast in about 45 minutes');
    expect(answer).not.toContain('Quinclorac');
    expect(answer).not.toContain('until dry.');
    expect(answer).not.toContain('rainfast in about 180 minutes');
  });

  test('a broad category mention stays inside the named family', () => {
    // "insecticide" matches the pest product, but the customer asked about a
    // LAWN insecticide — there is none, so say nothing product-specific
    // rather than quote the perimeter-pest label.
    const answer = answerEstimateQuestionFallback('Is the lawn insecticide safe for pets?', lawnPestContext);
    expect(answer).not.toContain('Bifenthrin');
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('rainfast');
    expect(answer).toContain('follow the product label directions');
  });

  test('naming a product narrows to it via the builder\'s questionNameMatch flag', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    // The builder stamps the flag when the question names the product —
    // the name itself never enters the support context.
    context.supportContext.productCatalog[0].questionNameMatch = true;
    const answer = answerEstimateQuestionFallback('Is SpeedZone safe for pets?', context);
    expect(answer).toContain('Carfentrazone');
    expect(answer).toContain('rainfast in about 180 minutes');
    expect(answer).not.toContain('Quinclorac');
    expect(answer).not.toContain('rainfast in about 60 minutes');
  });

  test('naming a family alongside "bug spray" keeps both families\' facts', () => {
    const answer = answerEstimateQuestionFallback('Are the lawn and bug spray safe for pets?', lawnPestContext);
    expect(answer).toContain('Label re-entry guidance by product:');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).toContain('Re-enter once sprays have dried');
  });

  test('naming an off-estimate product fails closed, not through to the estimate\'s facts', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    // Loaded from the question term, but not a product on this estimate.
    context.supportContext.productCatalog.push({
      source: 'admin_product_catalog',
      category: 'herbicide',
      activeIngredient: 'Glyphosate',
      labelVerified: true,
      signalWord: 'Warning',
      reentry: 'Foreign product re-entry claim.',
      rainfastMinutes: 240,
      irrigationNotes: null,
      serviceKeys: [],
    });
    const answer = answerEstimateQuestionFallback('Is glyphosate safe for pets?', context);
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('Foreign product re-entry claim');
    expect(answer).not.toContain('Carfentrazone');
    expect(answer).toContain('follow the product label directions');
  });

  test('unrelated "and" does not widen a product question to the whole family', () => {
    const context = JSON.parse(JSON.stringify(lawnPestContext));
    context.supportContext.productCatalog.push({
      source: 'admin_product_catalog',
      title: 'insect growth regulator active ingredient',
      category: 'insect growth regulator',
      activeIngredient: 'Hydroprene',
      labelVerified: true,
      signalWord: 'Caution',
      reentry: 'Ventilate treated rooms briefly.',
      rainfastMinutes: null,
      irrigationNotes: null,
      serviceKeys: ['pest_control'],
    });
    // "kids and pets" is not a product+family coordination.
    const answer = answerEstimateQuestionFallback('Is the Bifenthrin pest spray safe for kids and pets?', context);
    expect(answer).toContain('Re-enter once sprays have dried');
    expect(answer).not.toContain('Hydroprene');
    expect(answer).not.toContain('Ventilate treated rooms');
  });

  test('a coordinated product + family question unions both scopes', () => {
    const answer = answerEstimateQuestionFallback('Is Bifenthrin and the lawn treatment safe for pets?', lawnPestContext);
    expect(answer).toContain('Label re-entry guidance by product:');
    expect(answer).toContain('Re-enter once sprays have dried');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
  });

  test('coordination works in the reverse order too', () => {
    const answer = answerEstimateQuestionFallback('Is the lawn treatment plus Bifenthrin safe for pets?', lawnPestContext);
    expect(answer).toContain('Re-enter once sprays have dried');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
  });

  test('naming an off-estimate product with a category word still fails closed', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    context.supportContext.productCatalog.push({
      source: 'admin_product_catalog',
      category: 'herbicide',
      activeIngredient: 'Glyphosate',
      labelVerified: true,
      signalWord: 'Warning',
      reentry: 'Foreign product re-entry claim.',
      rainfastMinutes: 240,
      irrigationNotes: null,
      serviceKeys: [],
    });
    // "herbicide" describes the named off-estimate product — it must not
    // fall through to the estimate's own herbicides' facts.
    const answer = answerEstimateQuestionFallback('Is glyphosate herbicide safe for pets?', context);
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('Carfentrazone');
    expect(answer).not.toContain('Glyphosate');
    expect(answer).toContain('follow the product label directions');
  });

  test('"spray on the lawn" questions scope to the lawn family', () => {
    const answer = answerEstimateQuestionFallback('What product do you spray on the lawn?', lawnPestContext);
    expect(answer).toContain('Quinclorac');
    expect(answer).not.toContain('Bifenthrin');
  });

  test('watering questions on a pest-only estimate keep the pest label facts', () => {
    // "the lawn" is where the customer waters, not the service they bought —
    // scoping to lawn_care here would starve the pest product's guidance.
    const answer = answerEstimateQuestionFallback('Can I water the lawn after the treatment?', {
      serviceMode: 'recurring',
      services: [{ label: 'Pest Control', detail: 'Exterior perimeter plan', summary: 'Pest Control — perimeter' }],
      supportContext: {
        productCatalog: [{
          source: 'admin_product_catalog',
          title: 'insecticide active ingredient',
          category: 'insecticide',
          activeIngredient: 'Bifenthrin',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Re-enter once sprays have dried.',
          rainfastMinutes: 45,
          irrigationNotes: null,
          serviceKeys: ['pest_control'],
        }],
      },
    });
    expect(answer).toContain('Re-enter once sprays have dried');
  });

  test('rodent-bait estimates keep their rodent label facts', () => {
    const answer = answerEstimateQuestionFallback('Is the rodent bait safe for pets?', {
      serviceMode: 'recurring',
      services: [{ service: 'rodent_bait_quarterly', label: 'Rodent Bait Stations', detail: 'Quarterly exterior program', summary: 'Rodent Bait Stations — quarterly' }],
      supportContext: {
        productCatalog: [{
          source: 'admin_product_catalog',
          title: 'rodenticide active ingredient',
          category: 'rodenticide',
          activeIngredient: 'Bromadiolone',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Bait is secured in tamper-resistant stations.',
          rainfastMinutes: null,
          irrigationNotes: null,
          serviceKeys: ['rodent_bait'],
        }],
      },
    });
    expect(answer).toContain('Bait is secured in tamper-resistant stations');
  });

  test('"used for the lawn treatment" targets the lawn family, not everything', () => {
    const answer = answerEstimateQuestionFallback('What product is used for the lawn treatment?', lawnPestContext);
    expect(answer).toContain('Quinclorac');
    expect(answer).not.toContain('Bifenthrin');
  });

  test('re-entry questions get the reviewed re-entry guidance', () => {
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('When can we re-enter after service?')).toBe(true);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('How long until the yard is dry?')).toBe(true);
    const answer = answerEstimateQuestionFallback('How long before we can re-enter the lawn?', verifiedContext);
    expect(answer).toContain('Label re-entry guidance: Keep people and pets off treated areas until dry');
  });

  test('"water bugs" is a pest question, not a watering question', () => {
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('Do you treat water bugs?')).toBe(false);
    const answer = answerEstimateQuestionFallback('Do you treat water bugs?', {
      serviceMode: 'recurring',
      services: [{ label: 'Pest Control', detail: 'Exterior perimeter plan', summary: 'Pest Control — quarterly' }],
    });
    expect(answer).toContain('For pest control');
    expect(answer).not.toContain('follow the product label directions');
  });

  test('naming an ingredient narrows even on a single-family estimate with several products', () => {
    const answer = answerEstimateQuestionFallback('Is the 2,4-D lawn spray safe for pets?', {
      serviceMode: 'recurring',
      services: [{ label: 'Lawn Care', detail: 'Weed control applications', summary: 'Lawn Care — weed control' }],
      supportContext: {
        productCatalog: [
          {
            source: 'admin_product_catalog',
            title: 'herbicide active ingredient',
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
            title: 'pre-emergent active ingredient',
            category: 'pre-emergent',
            activeIngredient: 'Prodiamine',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'Re-enter after watering-in is complete.',
            rainfastMinutes: 60,
            irrigationNotes: null,
            serviceKeys: ['lawn_care'],
          },
        ],
      },
    });
    expect(answer).toContain('2,4-D');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).toContain('rainfast in about 180 minutes');
    // The sibling lawn product the customer did not name stays out.
    expect(answer).not.toContain('Prodiamine');
    expect(answer).not.toContain('watering-in');
    expect(answer).not.toContain('rainfast in about 60 minutes');
  });
});
