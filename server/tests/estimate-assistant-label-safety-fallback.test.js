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

  test('naming a product keeps sibling category rows out of the answer', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    context.supportContext.productCatalog[1].reentry = 'Re-enter after about 4 hours.';
    // "herbicide" here is adjectival — it describes 2,4-D, not the estimate's
    // other herbicides, so Quinclorac's label facts stay out.
    const answer = answerEstimateQuestionFallback('Is the 2,4-D herbicide safe for pets?', context);
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).not.toContain('Re-enter after about 4 hours');
    expect(answer).not.toContain('Quinclorac');
  });

  test('a salt/ester active form still counts as naming the short active', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    // The catalog stores the salt form; the customer says "2,4-D". The
    // normalized whole-segment alias ("24ddimethylaminesalt") never equals
    // "24d" — the segment's distinctive words must count as aliases, or the
    // question scopes to every attributed lawn product instead.
    context.supportContext.productCatalog[0].activeIngredient = '2,4-D dimethylamine salt';
    context.supportContext.productCatalog[1].reentry = 'Re-enter after about 4 hours.';
    const answer = answerEstimateQuestionFallback('Is the 2,4-D herbicide safe for pets?', context);
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).not.toContain('Re-enter after about 4 hours');
    expect(answer).not.toContain('Quinclorac');
  });

  test('a conjunction making the category its own subject unions the category rows', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    context.supportContext.productCatalog[1].reentry = 'Re-enter after about 4 hours.';
    const answer = answerEstimateQuestionFallback('Are 2,4-D and the herbicide products safe for pets?', context);
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
    // Only one of the two scoped products states watering guidance — the
    // line must not read as covering both.
    const answer = answerEstimateQuestionFallback('Can I water the lawn after the application?', context);
    expect(answer).toContain('Where a product label provides watering/irrigation guidance: Avoid irrigation for 24 hours after application; not every product on this estimate has watering guidance on file.');
    // With every scoped product stating guidance, the blanket form returns.
    context.supportContext.productCatalog[1].irrigationNotes = 'Avoid irrigation for 24 hours after application.';
    const covered = answerEstimateQuestionFallback('Can I water the lawn after the application?', context);
    expect(covered).toContain('Label watering/irrigation guidance: Avoid irrigation for 24 hours after application.');
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

  test('a pet + area recipient list stays scoped to the asked family', () => {
    // "for my dog and lawn" is recipients all the way through — the trailing
    // lawn noun must not pull the herbicide's facts into a mosquito answer.
    const answer = answerEstimateQuestionFallback('Is the mosquito spray safe for my dog and lawn?', bundleContext);
    expect(answer).toContain('Stay out of the treated area until sprays have dried');
    expect(answer).not.toContain('Keep people and pets off treated areas until dry');
    expect(answer).not.toContain('rainfast in about 180 minutes');
    expect(answer).not.toContain('Quinclorac');
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

  test('a coordinated category + family question gets both products\' label facts', () => {
    // "the herbicide and mosquito treatment" makes the category and the
    // family separate subjects — intersecting herbicides with the mosquito
    // family would empty the set and answer with no facts at all.
    const answer = answerEstimateQuestionFallback('Are the herbicide and mosquito treatment safe for pets?', bundleContext);
    expect(answer).toContain('Label re-entry guidance by product:');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).toContain('Stay out of the treated area until sprays have dried');
  });

  test('combo service keys keep every embedded family for scoping', () => {
    const answer = answerEstimateQuestionFallback('Is the tree and shrub treatment safe for pets?', {
      serviceMode: 'recurring',
      services: [{ service: 'lawn_tree_shrub_combo', label: 'Lawn + Tree & Shrub Combo', detail: 'Combined program', summary: 'Lawn + Tree & Shrub' }],
      supportContext: {
        productCatalog: [{
          source: 'admin_product_catalog',
          title: 'fungicide active ingredient',
          category: 'fungicide',
          activeIngredient: 'Azoxystrobin',
          labelVerified: true,
          signalWord: 'Caution',
          reentry: 'Ornamental re-entry line.',
          rainfastMinutes: 60,
          irrigationNotes: null,
          serviceKeys: ['tree_shrub'],
        }],
      },
    });
    // A combo estimate collapsed to lawn_care alone would treat this
    // tree/shrub row as off-estimate and answer with no facts.
    expect(answer).toContain('Ornamental re-entry line.');
  });

  test('an acronym names the expanded biological active', () => {
    const answer = answerEstimateQuestionFallback('Is the Bti treatment safe for pets?', {
      serviceMode: 'recurring',
      services: [{ label: 'Mosquito Control', detail: 'Barrier treatment', summary: 'Mosquito Control — barrier' }],
      supportContext: {
        productCatalog: [
          {
            source: 'admin_product_catalog',
            title: 'larvicide active ingredient',
            category: 'larvicide',
            // Stored expanded, with the taxonomy rank marker and a trailing
            // formulation word — the customer still says "Bti".
            activeIngredient: 'Bacillus thuringiensis subsp. israelensis solids',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'Larvicide dunk re-entry line.',
            rainfastMinutes: null,
            irrigationNotes: null,
            serviceKeys: ['mosquito'],
          },
          {
            source: 'admin_product_catalog',
            title: 'adulticide active ingredient',
            category: 'adulticide',
            activeIngredient: 'Deltamethrin',
            labelVerified: true,
            signalWord: 'Warning',
            reentry: 'Adulticide re-entry line.',
            rainfastMinutes: 30,
            irrigationNotes: null,
            serviceKeys: ['mosquito'],
          },
        ],
      },
    });
    expect(answer).toContain('Larvicide dunk re-entry line.');
    expect(answer).not.toContain('Adulticide re-entry line.');
    expect(answer).not.toContain('Deltamethrin');
  });

  test('a short category acronym scopes to that category', () => {
    const answer = answerEstimateQuestionFallback('Is the IGR safe for pets?', {
      serviceMode: 'recurring',
      services: [{ label: 'Pest Control', detail: 'Quarterly perimeter plan', summary: 'Pest Control — quarterly' }],
      supportContext: {
        productCatalog: [
          {
            source: 'admin_product_catalog',
            title: 'IGR active ingredient',
            category: 'IGR',
            activeIngredient: 'Pyriproxyfen',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'IGR re-entry line.',
            rainfastMinutes: null,
            irrigationNotes: null,
            serviceKeys: ['pest_control'],
          },
          {
            source: 'admin_product_catalog',
            title: 'insecticide active ingredient',
            category: 'insecticide',
            activeIngredient: 'Bifenthrin',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'Insecticide re-entry line.',
            rainfastMinutes: 45,
            irrigationNotes: null,
            serviceKeys: ['pest_control'],
          },
        ],
      },
    });
    expect(answer).toContain('IGR re-entry line.');
    expect(answer).not.toContain('Insecticide re-entry line.');
    expect(answer).not.toContain('Bifenthrin');
  });

  test('"service dog" is a recipient, not coordination onto the service', () => {
    const answer = answerEstimateQuestionFallback('Is the Bifenthrin pest spray safe for kids and service dog?', {
      serviceMode: 'recurring',
      services: [{ label: 'Pest Control', detail: 'Quarterly perimeter plan', summary: 'Pest Control — quarterly' }],
      supportContext: {
        productCatalog: [
          {
            source: 'admin_product_catalog',
            title: 'insecticide active ingredient',
            category: 'insecticide',
            activeIngredient: 'Bifenthrin',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'Bifenthrin re-entry line.',
            rainfastMinutes: 45,
            irrigationNotes: null,
            serviceKeys: ['pest_control'],
          },
          {
            source: 'admin_product_catalog',
            title: 'insecticide active ingredient',
            category: 'insecticide',
            activeIngredient: 'Fipronil',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'Sibling product re-entry line.',
            rainfastMinutes: 120,
            irrigationNotes: null,
            serviceKeys: ['pest_control'],
          },
        ],
      },
    });
    // "kids and service dog" is a recipient list — it must not union every
    // pest row into a Bifenthrin-specific answer.
    expect(answer).toContain('Bifenthrin re-entry line.');
    expect(answer).not.toContain('Sibling product re-entry line.');
    expect(answer).not.toContain('Fipronil');
  });

  test('a coordinated product name with no catalog match fails the answer closed', () => {
    // Roundup is not in the catalog at all — the dedicated named-product
    // fetch would have loaded any match. Answering with the 2,4-D facts
    // alone would read as though the safety answer covered both.
    const answer = answerEstimateQuestionFallback('Are 2,4-D and Roundup safe for pets?', verifiedContext);
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('Keep people and pets off treated areas until dry');
    expect(answer).toContain('follow the product label directions');
  });

  test('a LONE product name with no catalog match fails the answer closed too', () => {
    // No coordination anchor here — the product-ask position ("Is X safe")
    // is the signal that Roundup is a product, not an ordinary noun.
    const answer = answerEstimateQuestionFallback('Is Roundup safe for pets?', verifiedContext);
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('Keep people and pets off treated areas until dry');
    expect(answer).not.toContain('Carfentrazone');
    expect(answer).toContain('follow the product label directions');
  });

  test('ordinary nouns outside product-ask position keep the label facts', () => {
    // "golden retriever" is a recipient, not a product mention — the
    // unresolved-name guard must not starve the answer.
    const answer = answerEstimateQuestionFallback('Is it safe for my golden retriever?', verifiedContext);
    expect(answer).toContain('Keep people and pets off treated areas until dry');
  });

  test('a passive/product-subject unresolved name fails the answer closed too', () => {
    // The product sits BEFORE the usage verb — no "is X safe" or
    // verb-then-product anchor fires, but the question still names an
    // off-catalog product and the lawn facts must not read as covering it.
    const answer = answerEstimateQuestionFallback('Will Roundup be used on my lawn, and is it safe for dogs?', verifiedContext);
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('Keep people and pets off treated areas until dry');
    expect(answer).not.toContain('Carfentrazone');
    expect(answer).toContain('follow the product label directions');
    // A RESOLVED on-estimate product in the same passive position keeps its
    // facts flowing.
    const resolved = answerEstimateQuestionFallback('Will 2,4-D be sprayed on my lawn, and is it safe for dogs?', verifiedContext);
    expect(resolved).toContain('Keep people and pets off treated areas until dry');
  });

  test('an unqualified category on a plant area scopes to that area\'s family', () => {
    const answer = answerEstimateQuestionFallback('Is the insecticide on landscape plants safe?', {
      serviceMode: 'recurring',
      services: [
        { label: 'Tree & Shrub Care', detail: 'Ornamental program', summary: 'Tree & Shrub — ornamental' },
        { label: 'Pest Control', detail: 'Quarterly perimeter plan', summary: 'Pest Control — quarterly' },
      ],
      supportContext: {
        productCatalog: [
          {
            source: 'admin_product_catalog',
            title: 'insecticide active ingredient',
            category: 'insecticide',
            activeIngredient: 'Acephate',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'Ornamental insecticide re-entry line.',
            rainfastMinutes: null,
            irrigationNotes: null,
            serviceKeys: ['tree_shrub'],
          },
          {
            source: 'admin_product_catalog',
            title: 'insecticide active ingredient',
            category: 'insecticide',
            activeIngredient: 'Bifenthrin',
            labelVerified: true,
            signalWord: 'Caution',
            reentry: 'Perimeter insecticide re-entry line.',
            rainfastMinutes: 45,
            irrigationNotes: null,
            serviceKeys: ['pest_control'],
          },
        ],
      },
    });
    expect(answer).toContain('Ornamental insecticide re-entry line.');
    expect(answer).not.toContain('Perimeter insecticide re-entry line.');
    expect(answer).not.toContain('Bifenthrin');
  });

  test('a question naming BOTH bundle families gets both products\' label facts', () => {
    const answer = answerEstimateQuestionFallback('Are the lawn and mosquito treatments safe for pets?', bundleContext);
    expect(answer).toContain('Label re-entry guidance by product:');
    expect(answer).toContain('Keep people and pets off treated areas until dry');
    expect(answer).toContain('Stay out of the treated area until sprays have dried');
    // Most conservative rainfast across every named family.
    expect(answer).toContain('rainfast in about 180 minutes');
    // Only the lawn product states watering guidance — the line stays
    // qualified rather than reading as covering the mosquito product too.
    expect(answer).toContain('Where a product label provides watering/irrigation guidance: Avoid irrigation for 24 hours after application; not every product on this estimate has watering guidance on file.');
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
    // Service-family qualifiers between the article and the service noun
    // are still treatment-tied rain wording.
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('What if it rains after my lawn service?')).toBe(true);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('What if it rains after the pest control treatment?')).toBe(true);
    // The reversed word order is the same label question — and without the
    // reversed alternate, family words the gate does not list bare
    // ("mosquito") would reach the live models entirely.
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('How soon after my lawn service can it rain?')).toBe(true);
    expect(FORCE_FALLBACK_QUESTION_PATTERN.test('How soon after the mosquito treatment can it rain?')).toBe(true);
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
    // rows carrying the irrigation guidance must survive scoping. Only one
    // of the two scoped products states guidance, so the line is qualified.
    const answer = answerEstimateQuestionFallback('Can I water my outside plants after treatment?', context);
    expect(answer).toContain('Where a product label provides watering/irrigation guidance: Avoid irrigation for 24 hours after application; not every product on this estimate has watering guidance on file.');
  });

  test('"safe for the lawn" scopes to the asked-about spray, not the lawn family', () => {
    const answer = answerEstimateQuestionFallback('Is the mosquito spray safe for the lawn?', bundleContext);
    expect(answer).toContain('Stay out of the treated area until sprays have dried');
    expect(answer).not.toContain('Quinclorac');
    expect(answer).not.toContain('until dry.');
    expect(answer).not.toContain('rainfast in about 180 minutes');
    // The lead approach sentence must match the scoped family too — lawn
    // copy above mosquito label facts reads as a contradiction.
    expect(answer).toContain('For mosquitoes');
    expect(answer).not.toContain('For lawns');
  });

  test('rainfast questions land in the safety branch and quote the label window', () => {
    const answer = answerEstimateQuestionFallback('What if it rains after the treatment?', verifiedContext);
    expect(answer).toContain('rainfast in about 180 minutes');
  });

  test('service-qualified rain questions land in the safety branch too', () => {
    const answer = answerEstimateQuestionFallback('What if it rains after my lawn service?', verifiedContext);
    expect(answer).toContain('rainfast in about 180 minutes');
  });

  test('reversed rain-after wording gets the same rainfast answer', () => {
    // "How soon after my lawn service can it rain?" is the rain-after label
    // question with the order flipped — it must not fall through to the
    // generic lawn copy without the reviewed rainfast window.
    const answer = answerEstimateQuestionFallback('How soon after my lawn service can it rain?', verifiedContext);
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
    // The unverified product's re-entry guidance is just as unknown — the
    // verified products' instruction must not read as blanket either.
    expect(answer).not.toContain('Label re-entry guidance:');
    expect(answer).toContain('Where a product label provides re-entry guidance: Keep people and pets off treated areas until dry; not every product on this estimate has re-entry guidance on file.');
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

  test('a truncated catalog slice qualifies the re-entry and signal-word copy too', () => {
    const context = JSON.parse(JSON.stringify(verifiedContext));
    // An omitted product can carry a longer or different re-entry interval —
    // the blanket instruction must not read as covering it.
    context.supportContext.productCatalogTruncated = true;
    const answer = answerEstimateQuestionFallback('Is it safe for pets?', context);
    expect(answer).not.toContain('Label re-entry guidance:');
    expect(answer).toContain('Where a product label provides re-entry guidance: Keep people and pets off treated areas until dry; not every product on this estimate has re-entry guidance on file.');
    expect(answer).not.toContain('Label signal word: Caution.');
    expect(answer).toContain('Label signal word for the products on file: Caution.');
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

  test('naming an on-estimate AND an off-estimate product fails closed for both', () => {
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
    // 2,4-D is on the plan, glyphosate is not — answering with the 2,4-D
    // facts alone would read as though the safety answer covered both.
    const answer = answerEstimateQuestionFallback('Are 2,4-D and glyphosate safe for pets?', context);
    expect(answer).not.toContain('Label re-entry guidance');
    expect(answer).not.toContain('Keep people and pets off treated areas until dry');
    expect(answer).not.toContain('Foreign product re-entry claim');
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
