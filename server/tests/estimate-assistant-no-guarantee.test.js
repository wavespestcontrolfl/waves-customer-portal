jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  answerEstimateQuestionFallback,
  buildEstimateAssistantContext,
} = require('../services/estimate-assistant');

describe('estimate assistant no-guarantee context', () => {
  test('removes guarantee claims from model context and the deterministic guarantee answer', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Fixture Customer',
        waveguard_tier: 'Bronze',
        monthly_total: 55,
      },
      estData: {
        result: {
          recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 55 }] },
        },
        engineResult: {
          lineItems: [{ service: 'termite_bait', name: 'Termite Bait Monitoring', recurring: true, monthly: 45 }],
        },
      },
      pricingBundle: {
        waveGuardTier: 'Bronze',
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 55, annual: 660 }],
      },
      noGuaranteeClaims: true,
    });

    expect(context.guarantees).toMatchObject({
      noGuaranteeClaims: true,
      recurring: null,
      oneTime: null,
    });
    expect(context.guarantees.guidance).toMatch(/Do not infer an estimate-wide/i);

    const answer = answerEstimateQuestionFallback('Does this include a money-back guarantee?', context);
    expect(answer).toMatch(/written service scope and terms/i);
    expect(answer).toMatch(/do not see an estimate-wide callback or money-back guarantee/i);
    expect(answer).not.toMatch(/includes the money-back guarantee|30-day callback/i);
  });

  test.each(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'palm_injection'])('ordinary recurring %s estimates retain their guarantee context', (service) => {
    const context = buildEstimateAssistantContext({
      estimate: { waveguard_tier: 'Bronze', monthly_total: 55 },
      pricingBundle: {
        waveGuardTier: 'Bronze',
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 55, annual: 660,
          included: [{ service, label: service }],
        }],
      },
    });

    expect(context.guarantees.noGuaranteeClaims).toBe(false);
    expect(context.guarantees.recurringTermsEligible).toBe(true);
    expect(context.guarantees.recurring).toMatch(/Money-back guarantee/);
    expect(answerEstimateQuestionFallback('What is the guarantee?', context))
      .toMatch(/includes the money-back guarantee/i);
  });

  test.each([
    ['rodent', ['rodent_bait']],
    ['commercial', ['commercial_pest']],
    ['mixed rodent', ['pest_control', 'rodent_bait']],
    ['unknown', ['unclassified_service']],
  ])('%s retains neutral service context without inheriting recurring terms', (_lane, services) => {
    const context = buildEstimateAssistantContext({
      estimate: { waveguard_tier: 'Bronze', monthly_total: 55 },
      pricingBundle: { frequencies: [{ key: 'monthly', monthly: 55,
        included: services.map((service) => ({ service, label: service, detail: 'Licensed and insured; satisfaction guaranteed' })),
      }] },
      noGuaranteeClaims: false,
    });
    expect(context.guarantees).toMatchObject({ noGuaranteeClaims: false, recurringTermsEligible: false, recurring: null, oneTime: null });
    expect(context.services[0].detail).toContain('satisfaction guaranteed');
    for (const question of ['Does this include a money-back guarantee?', 'What are my WaveGuard membership benefits?']) {
      const answer = answerEstimateQuestionFallback(question, context);
      expect(answer).toMatch(/written service scope and terms/i);
      expect(answer).not.toMatch(/includes the money-back guarantee|30-day callback/i);
    }
  });

  test('the page decision narrows eligibility: pest-only rows on an authored (commercial) proposal get no plan terms', () => {
    // An authored proposal is commercial work (estimateCarriesPlanTerms), a
    // mark its pest-only engine rows do not carry. The route passes the
    // page's own decision, and Ask Waves never states estimate-wide terms
    // the page withholds.
    const build = (noEstimateWideGuarantee) => buildEstimateAssistantContext({
      estimate: { waveguard_tier: 'Bronze', monthly_total: 55 },
      pricingBundle: { waveGuardTier: 'Bronze', frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 55, annual: 660,
        included: [{ service: 'pest_control', label: 'Pest Control' }],
      }] },
      noEstimateWideGuarantee,
    });
    expect(build(false).guarantees.recurringTermsEligible).toBe(true);
    const context = build(true);
    expect(context.guarantees).toMatchObject({ noGuaranteeClaims: false, recurringTermsEligible: false, recurring: null, oneTime: null });
    const answer = answerEstimateQuestionFallback('Does this include a money-back guarantee?', context);
    expect(answer).not.toMatch(/includes the money-back guarantee|30-day callback/i);
  });

  test('each service states its own terms: pest keeps its plan terms beside rodent, under its own name only', () => {
    const build = (commercialScope) => buildEstimateAssistantContext({
      estimate: { waveguard_tier: 'Bronze', monthly_total: 75 },
      pricingBundle: { waveGuardTier: 'Bronze', frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 75, annual: 900,
        included: [
          { service: 'pest_control', label: 'Pest Control' },
          { service: 'rodent_bait', label: 'Rodent Bait Stations', detail: 'Station monitoring and service.' },
        ],
      }] },
      noEstimateWideGuarantee: true,
      commercialScope,
    });
    const context = build(false);
    expect(context.guarantees).toMatchObject({ recurringTermsEligible: false, recurring: null });
    const pestEntry = context.guarantees.serviceTerms.find((entry) => entry.service === 'Pest Control');
    expect(pestEntry.terms.join(' ')).toMatch(/^Money-back guarantee on recurring WaveGuard service/);
    expect(context.guarantees.serviceTerms.find((entry) => /Rodent/.test(entry.service))).toBeUndefined();
    const answer = answerEstimateQuestionFallback('What is the guarantee?', context);
    expect(answer).toContain('Pest Control: Money-back guarantee on recurring WaveGuard service');
    expect(answer).toMatch(/applies to that service only/);
    expect(answer).not.toMatch(/Rodent Bait Stations:/);

    // An authored proposal or commercial row anywhere: no service carries them.
    const commercial = build(true);
    expect(commercial.guarantees.serviceTerms.some((entry) => /Money-back/.test(entry.terms.join(' ')))).toBe(false);
  });

  test('a pest + lawn bundle carries the plan terms, as the page states them (every service carries them)', () => {
    const context = buildEstimateAssistantContext({
      estimate: { waveguard_tier: 'Silver', monthly_total: 110 },
      pricingBundle: { waveGuardTier: 'Silver', frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 110, annual: 1320,
        included: [{ service: 'pest_control', label: 'Pest Control' }, { service: 'lawn_care', label: 'Lawn Care' }],
      }] },
    });
    expect(context.guarantees.recurringTermsEligible).toBe(true);
    expect(answerEstimateQuestionFallback('What is the guarantee?', context))
      .toMatch(/includes the money-back guarantee/i);
  });

  test.each([
    ['mosquito', { service: 'mosquito', label: 'One-Time Mosquito Treatment', amount: 125 }, true],
    ['tree & shrub', { service: 'tree_shrub', label: 'One-Time Tree & Shrub Treatment', amount: 140 }, true],
    ['lawn', { service: 'one_time_lawn', label: 'One-Time Lawn Treatment', amount: 120 }, false],
    ['rodent', { service: 'rodent_trapping', label: 'Rodent Trapping', amount: 200 }, false],
    ['commercial bed bug', { service: 'bed_bug', label: 'Bed Bug Treatment', amount: 650, isCommercial: true }, false],
  ])('a one-time %s job carries the page\'s 30-day callback only where the page states it', (_name, item, callback) => {
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: item.amount }, serviceMode: 'one_time', estData: {},
      pricingBundle: { anchorOneTimePrice: item.amount, oneTimeBreakdown: { total: item.amount, items: [item] } },
    });
    const answer = answerEstimateQuestionFallback('Is there a callback if the problem comes back?', context);
    if (callback) {
      expect(context.guarantees.oneTime).toMatch(/30-day callback/);
      expect(answer).toMatch(/30-day callback/);
    } else {
      expect(context.guarantees.oneTime).toBeNull();
      expect(answer).not.toMatch(/30-day callback/);
    }
  });

  test.each([
    'When will you treat the lawn again?',
    'How often do you retreat the lawn?',
  ])('a scheduling question is not a guarantee question: %s', (question) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 45 },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 45, included: [
        { service: 'termite_bait', label: 'Termite Bait Monitoring' },
      ] }] },
      noGuaranteeClaims: true,
    });
    expect(answerEstimateQuestionFallback(question, context)).not.toMatch(/No guarantee\./);
  });

  test.each([true, false])('neutral policy %s governs no-contract prose in the actual assistant context', (noGuaranteeClaims) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55 },
      pricingBundle: { frequencies: [{ key: 'monthly', monthly: 55, included: [{
        service: 'pest_control', label: 'Pest Control',
        detail: 'Exterior perimeter service. No long-term contract. Cancel any time. No lock-in. Licensed and insured.',
      }] }] },
      noGuaranteeClaims,
    });
    expect(context.services[0].detail).toContain('Exterior perimeter service.');
    expect(context.services[0].detail).toContain('Licensed and insured.');
    if (noGuaranteeClaims) {
      expect(context.services[0].detail).not.toMatch(/no long.term contract|cancel any time|no lock-in/i);
    } else {
      expect(context.services[0].detail).toContain('No long-term contract.');
      expect(context.services[0].detail).toContain('Cancel any time.');
    }
  });

  test('one-time rodent work cannot inherit pest callback terms', () => {
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 200 },
      pricingBundle: { anchorOneTimePrice: 200, oneTimeBreakdown: { items: [{ service: 'rodent_trapping', label: 'Rodent Trapping', amount: 200 }] } },
      serviceMode: 'one_time',
    });
    expect(context.guarantees).toMatchObject({ recurringTermsEligible: false, recurring: null, oneTime: null });
    expect(answerEstimateQuestionFallback('What is the guarantee?', context)).not.toMatch(/30-day callback|includes the money-back guarantee/i);
  });

  test.each(['rodent_bait', 'commercial_pest'])(
    '%s raw detail drops a generic written guarantee as the page does (pre-push P1 on d1da03b391)', (service) => {
      const context = buildEstimateAssistantContext({
        estimate: { monthly_total: 55 },
        pricingBundle: { frequencies: [{ key: 'monthly', monthly: 55, included: [{ service, label: service,
          detail: 'Satisfaction guaranteed. Written 30-day guarantee on the treated areas. Warranty included with every visit. Licensed and insured.',
        }] }] },
        noGuaranteeClaims: false,
      });
      expect(context.services[0].detail).toBe('Satisfaction guaranteed. Licensed and insured.');
      const answer = answerEstimateQuestionFallback('What is included?', context);
      expect(answer).toContain('Satisfaction guaranteed.');
      expect(answer).not.toMatch(/30-day guarantee|warranty included/i);
    },
  );

  test.each([
    ['the engine flag says removed', { warrantyExtendedSelected: false }],
    ['a legacy status says removed', { warrantyStatus: 'No extended warranty' }],
  ])('a pre-slab job whose extended warranty was removed drops the stale detail part: %s', (_name, selection) => {
    for (const source of ['pricing', 'estimate_data']) {
      const item = {
        service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', price: 1400, amount: 1400, ...selection,
        detail: 'Termite soil treatment before the slab pour | Extended 5-yr warranty',
      };
      const context = buildEstimateAssistantContext({
        estimate: { onetime_total: 1400 },
        ...(source === 'pricing'
          ? { pricingBundle: { anchorOneTimePrice: 1400, oneTimeBreakdown: { items: [item] } } }
          : { estData: { result: { oneTime: { items: [item] } } } }),
        serviceMode: 'one_time',
        noGuaranteeClaims: true,
      });
      expect(context.oneTime.items[0].detail).toBe('Termite soil treatment before the slab pour');
      expect(context.oneTime.items[0].warrantyTerms.join(' ')).toContain('No extended warranty selected.');
      const answer = answerEstimateQuestionFallback('What is included?', context);
      expect(answer).not.toMatch(/extended 5-yr warranty/i);
    }
  });

  test('a pre-slab job keeps its selected extended warranty part on a no-guarantee estimate, as the page does', () => {
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1400 },
      pricingBundle: { anchorOneTimePrice: 1400, oneTimeBreakdown: { items: [{
        service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 1400, warrantyExtendedSelected: true,
        detail: 'Termite soil treatment before the slab pour | Extended 5-yr warranty | Money-back guarantee on every visit',
      }] } },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items[0].detail).toBe('Termite soil treatment before the slab pour | Extended 5-yr warranty');
  });

  test.each(['rodent_bait', 'commercial_pest', 'unclassified_service'])(
    '%s raw detail cannot reintroduce residential recurring promises', (service) => {
      const context = buildEstimateAssistantContext({
        estimate: { monthly_total: 55 },
        pricingBundle: { frequencies: [{ key: 'monthly', monthly: 55, included: [{ service, label: service,
          detail: 'Satisfaction guaranteed. Unlimited free callbacks and a money-back guarantee; No long-term contract; Free re-service between visits.',
        }] }] },
        noGuaranteeClaims: false,
      });
      expect(context.guarantees.recurringTermsEligible).toBe(false);
      expect(context.services[0].detail).toBe('Satisfaction guaranteed.');
      const answer = answerEstimateQuestionFallback('What is included?', context);
      expect(answer).toContain('Satisfaction guaranteed.');
      expect(answer).not.toMatch(/callbacks?|money-back|no long-term contract|free re-service/i);
    },
  );

  test.each(['rodent_bait', 'commercial_pest'])('%s answers its retained satisfaction term without inventing recurring benefits', (service) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55 },
      pricingBundle: { frequencies: [{ key: 'monthly', monthly: 55,
        included: [{ service, label: service, detail: 'Licensed and insured. Satisfaction guaranteed.' }],
      }] },
    });

    const answer = answerEstimateQuestionFallback('Is satisfaction guaranteed?', context);
    expect(answer).toContain('says “Satisfaction guaranteed.”');
    expect(answer).toContain('applies to that service only');
    expect(answer).not.toMatch(/includes the money-back guarantee|free re-treat|callbacks are free/i);
    expect(answerEstimateQuestionFallback('Are callbacks free?', context)).toMatch(/do not see an estimate-wide callback/i);
  });

  test('satisfaction answers preserve written limits and reject negated wording', () => {
    const build = (detail) => buildEstimateAssistantContext({
      estimate: { monthly_total: 55 },
      pricingBundle: { frequencies: [{ key: 'monthly', monthly: 55,
        included: [{ service: 'rodent_bait', label: 'Rodent Bait Stations', detail }],
      }] },
    });

    const qualified = answerEstimateQuestionFallback('Is satisfaction guaranteed?',
      build('Satisfaction guaranteed for the initial treatment only.'));
    expect(qualified).toContain('“Satisfaction guaranteed for the initial treatment only.”');

    const negated = answerEstimateQuestionFallback('Is satisfaction guaranteed?',
      build('Satisfaction guaranteed is not included in this service.'));
    expect(negated).toMatch(/written service scope and terms/i);
    expect(negated).not.toContain('detail on this estimate says');
  });

  test.each([false, true])('satisfaction answers stay within the named service scope (reversed: %s)', (reverse) => {
    const rows = [
      { service: 'commercial_pest', label: 'Commercial Pest Control',
        detail: 'Satisfaction guaranteed for the initial treatment only.' },
      { service: 'rodent_bait', label: 'Rodent Bait Stations', detail: 'Station monitoring and service.' },
    ];
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55 },
      pricingBundle: { frequencies: [{ key: 'monthly', monthly: 55,
        included: reverse ? [...rows].reverse() : rows,
      }] },
    });

    // Owner ruling 2026-09-27: each service carries its own terms and the
    // assistant never guesses which service a question means. Both questions
    // get the same answer, with the clause listed under its own service only.
    expect(context.guarantees.serviceTerms).toEqual([
      { service: 'Pest Control', terms: ['The written detail says “Satisfaction guaranteed for the initial treatment only.”'] },
    ]);
    const rodent = answerEstimateQuestionFallback('Is satisfaction guaranteed for the rodent service?', context);
    expect(rodent).toContain('Pest Control: The written detail says “Satisfaction guaranteed for the initial treatment only.”');
    expect(rodent).not.toMatch(/Rodent Bait Stations:/);
    expect(answerEstimateQuestionFallback('Is satisfaction guaranteed for commercial pest?', context)).toBe(rodent);
  });

  test.each(['pricing', 'saved'])('commercial %s scope remains neutral after normalizing its display name', (source) => {
    const rows = [{ service: 'pest_control', name: 'Commercial Pest Control', label: 'Commercial Pest Control', mo: 55 }];
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55 },
      estData: { result: { recurring: { services: source === 'saved' ? rows : [] } } },
      pricingBundle: { frequencies: [{ key: 'monthly', monthly: 55, included: source === 'pricing' ? rows : [] }] },
    });
    expect(context.services[0].label).toBe('Pest Control');
    expect(context.guarantees.recurringTermsEligible).toBe(false);
    expect(context.guarantees.recurring).toBeNull();
  });

  test('recurring eligibility unions result and engineResult identities behind a frozen pricing projection', () => {
    const context = buildEstimateAssistantContext({
      estimate: { waveguard_tier: 'Bronze', monthly_total: 55 },
      estData: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 55 }] } },
        engineResult: { recurring: { services: [{ service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 24 }] } },
      },
      pricingBundle: { waveGuardTier: 'Bronze', frequencies: [{ key: 'quarterly', monthly: 55, annual: 660,
        included: [{ service: 'pest_control', label: 'Pest Control' }],
      }] },
    });

    expect(context.guarantees).toMatchObject({ recurringTermsEligible: false, recurring: null });
    expect(answerEstimateQuestionFallback('Are callbacks free?', context))
      .toMatch(/do not see an estimate-wide callback/i);
  });

  test.each([
    ['serviceKey identity', { result: { recurring: { services: [
      { serviceKey: 'commercial_pest', name: 'Pest Control', mo: 55 },
    ] } } }],
    ['top-level legacy recurring root', { result: {}, recurring: { services: [
      { service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 24 },
    ] } }],
    ['commercial engine line item', { result: {}, engineResult: { lineItems: [
      { service: 'commercial_pest', name: 'Commercial Pest Control', monthly: 55 },
    ] } }],
    ['commercial manual engine line item', { result: {}, engineResult: { lineItems: [
      { service_key: 'commercial_pest', name: 'Commercial Pest Control', quoteRequired: true },
    ] } }],
    ['rodent engine line item', { result: {}, engineResult: { lineItems: [
      { service: 'rodent_bait', name: 'Rodent Bait Stations', monthly: 24 },
    ] } }],
  ])('%s remains terms-neutral behind a frozen residential pest projection', (_label, estData) => {
    const context = buildEstimateAssistantContext({
      estimate: { waveguard_tier: 'Bronze', monthly_total: 55 },
      estData,
      pricingBundle: { waveGuardTier: 'Bronze', frequencies: [{ key: 'quarterly', monthly: 55, annual: 660,
        included: [{ service: 'pest_control', label: 'Pest Control' }],
      }] },
    });

    expect(context.services.map((row) => row.label)).toEqual(['Pest Control']);
    expect(context.guarantees).toMatchObject({ recurringTermsEligible: false, recurring: null });
  });

  test.each(['pricing', 'saved'])('%s purchased warranty scope survives without allowing arbitrary warranty prose', (source) => {
    const row = { service: 'termite_trenching', label: 'Front foundation', amount: 1200, price: 1200,
      warrantyTier: 'one_year_retreat', warrantyAdder: 100, detail: 'Guaranteed termite-free forever' };
    const input = (item) => ({
      estimate: { onetime_total: 1200 },
      estData: { result: { oneTime: { items: source === 'saved' ? [item] : [] } } },
      pricingBundle: { anchorOneTimePrice: 1200, oneTimeBreakdown: { items: source === 'pricing' ? [item] : [] } },
      noGuaranteeClaims: true,
    });
    const context = buildEstimateAssistantContext(input(row));
    expect(context.oneTime.items[0].purchasedTerms).toEqual(['Annual inspection during the warranty period']);
    const answer = answerEstimateQuestionFallback('What is included?', context);
    expect(answer).toContain('Annual inspection during the warranty period');
    expect(answer).not.toMatch(/termite-free forever|money-back guarantee|unlimited.*callback/i);
    const guaranteeAnswer = answerEstimateQuestionFallback('What guarantee does the trenching include?', context);
    expect(guaranteeAnswer).toContain('Front foundation: Annual inspection during the warranty period.');
    expect(guaranteeAnswer).toMatch(/do not see an estimate-wide callback or money-back guarantee/i);
    expect(guaranteeAnswer).not.toMatch(/termite-free forever/i);
    for (const question of [
      'Does the trenching include a money-back guarantee?',
      'Does its guarantee include callbacks?',
      'Does the trenching include a satisfaction guarantee?',
    ]) {
      expect(answerEstimateQuestionFallback(question, context)).toBe(guaranteeAnswer);
    }
    const unproven = buildEstimateAssistantContext(input({ ...row, warrantyAdder: undefined }));
    expect(unproven.oneTime.items[0].purchasedTerms || []).toEqual([]);
    expect(answerEstimateQuestionFallback('What is included?', unproven)).not.toContain('Annual inspection during the warranty period');
  });

  test('a legacy frozen row inherits a purchased trenching warranty only from its matching authoritative raw row', () => {
    const saved = { service: 'trenching', label: 'Termite Trenching', amount: 1200,
      warrantyTier: 'one_year_retreat', warrantyAdder: 0 };
    const build = (pricingRow) => buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: { result: { oneTime: { items: [saved] } } },
      pricingBundle: { anchorOneTimePrice: 1200, oneTimeBreakdown: { items: [pricingRow] } },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });

    const legacy = build({ service: 'trenching', label: 'Termite Trenching', amount: 1200,
      warrantyTier: 'one_year_retreat' });
    expect(legacy.oneTime.items[0].purchasedTerms).toEqual(['Annual inspection during the warranty period']);
    expect(answerEstimateQuestionFallback('Is there an annual inspection?', legacy))
      .toContain('Annual inspection during the warranty period');

    const explicitRemoval = build({ service: 'trenching', label: 'Termite Trenching', amount: 1200,
      warrantyTier: 'one_year_retreat', warrantyAdder: null });
    expect(explicitRemoval.oneTime.items[0].purchasedTerms).toEqual([]);

    const wrongService = build({ service: 'one_time_pest', label: 'Termite Trenching', amount: 1200,
      warrantyTier: 'one_year_retreat' });
    expect(wrongService.oneTime.items[0].purchasedTerms || []).toEqual([]);
  });

  test('dual saved containers retain raw trenching purchase evidence omitted by the mapped row', () => {
    const mapped = { service: 'trenching', label: 'Termite Trenching', amount: 1200, price: 1200,
      warrantyTier: 'one_year_retreat' };
    const raw = { ...mapped, warrantyAdder: 0 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: {
        result: { oneTime: { items: [mapped] } },
        engineResult: { oneTime: { items: [raw] } },
      },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items[0].purchasedTerms)
      .toEqual(['Annual inspection during the warranty period']);
  });

  test.each([false, true])('renamed current trenching rows do not duplicate fallback services (pricing: %s)', (withPricing) => {
    const mapped = { service: 'termite_trenching', label: 'Updated Trenching Scope', amount: 1200,
      warrantyTier: 'one_year_retreat' };
    const raw = { ...mapped, service: 'trenching', label: 'Termite Trenching', warrantyAdder: 0 };
    const priced = { service: 'trenching', label: 'Current Quoted Scope', amount: 1200 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: { result: { oneTime: { items: [mapped] } }, engineResult: { oneTime: { items: [raw] } } },
      pricingBundle: withPricing ? { anchorOneTimePrice: 1200, oneTimeBreakdown: { items: [priced] } } : {},
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items).toHaveLength(1);
    expect(context.oneTime.items[0]).toMatchObject({
      label: withPricing ? priced.label : mapped.label,
      purchasedTerms: ['Annual inspection during the warranty period'],
    });
    for (const question of ['What warranty does this estimate include?', 'What is included?']) {
      const answer = answerEstimateQuestionFallback(question, context);
      expect(answer.match(/Annual inspection during the warranty period/g)).toHaveLength(1);
      expect(answer).not.toContain(raw.label);
    }
  });

  test('coalescing fallback identities retains distinct current jobs and unrelated raw services', () => {
    const current = [
      { service: 'trenching', label: 'Front foundation', amount: 900, warrantyTier: 'one_year_retreat', warrantyAdder: 0 },
      { service: 'trenching', label: 'Rear foundation', amount: 700, warrantyTier: 'none', warrantyAdder: 0 },
    ];
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1850 },
      estData: {
        result: { oneTime: { items: current } },
        engineResult: { oneTime: { items: [
          { service: 'termite_trenching', label: 'Older foundation label', amount: 900 },
          { service: 'one_time_pest', label: 'General Pest Treatment', amount: 250 },
        ] } },
      },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items.map((row) => row.label).sort())
      .toEqual(['Front foundation', 'General Pest Treatment', 'Rear foundation']);
    expect(context.oneTime.items.find((row) => row.label === 'Front foundation').purchasedTerms)
      .toEqual(['Annual inspection during the warranty period']);
    expect(context.oneTime.items.find((row) => row.label === 'Rear foundation').purchasedTerms).toEqual([]);
  });

  test.each([
    ['same-price named jobs',
      [
        { service: 'trenching', label: 'Front foundation', amount: 900 },
        { service: 'trenching', label: 'Rear foundation', amount: 900 },
      ],
      [{ service: 'trenching', label: 'Front foundation', amount: 900,
        warrantyTier: 'three_year_repair_retreat', warrantyAdder: 117 }],
      ['Front foundation']],
    ['renamed jobs with distinct prices',
      [
        { service: 'trenching', label: 'Current north scope', amount: 900 },
        { service: 'trenching', label: 'Current south scope', amount: 700 },
      ],
      [
        { service: 'trenching', label: 'Legacy front scope', amount: 900,
          warrantyTier: 'three_year_repair_retreat', warrantyAdder: 117 },
        { service: 'trenching', label: 'Legacy rear scope', amount: 700,
          warrantyTier: 'none', warrantyAdder: 0 },
      ],
      ['Current north scope']],
    ['same-price paid and unpaid jobs',
      [
        { service: 'trenching', label: 'Front foundation', amount: 900 },
        { service: 'trenching', label: 'Rear foundation', amount: 900 },
      ],
      [
        { service: 'trenching', label: 'Front foundation', amount: 900,
          warrantyTier: 'one_year_retreat', warrantyAdder: 0 },
        { service: 'trenching', label: 'Rear foundation', amount: 900,
          warrantyTier: 'none', warrantyAdder: 0 },
      ],
      ['Front foundation']],
    ['changed-price label reservation',
      [
        { service: 'trenching', label: 'Front foundation', amount: 700 },
        { service: 'trenching', label: 'Rear foundation', amount: 900 },
      ],
      [{ service: 'trenching', label: 'Front foundation', amount: 900,
        warrantyTier: 'three_year_repair_retreat', warrantyAdder: 117 }],
      ['Front foundation']],
    ['equal-price exact-label reservation before renamed fallback',
      [
        { service: 'trenching', label: 'Front foundation', amount: 900 },
        { service: 'trenching', label: 'Current rear scope', amount: 900 },
      ],
      [
        { service: 'trenching', label: 'Front foundation', amount: 900,
          warrantyTier: 'none', warrantyAdder: 0 },
        { service: 'trenching', label: 'Legacy rear scope', amount: 900,
          warrantyTier: 'one_year_retreat', warrantyAdder: 0 },
      ],
      ['Current rear scope']],
    ['reversed equal-price exact-label reservation before renamed fallback',
      [
        { service: 'trenching', label: 'Current rear scope', amount: 900 },
        { service: 'trenching', label: 'Front foundation', amount: 900 },
      ],
      [
        { service: 'trenching', label: 'Legacy rear scope', amount: 900,
          warrantyTier: 'one_year_retreat', warrantyAdder: 0 },
        { service: 'trenching', label: 'Front foundation', amount: 900,
          warrantyTier: 'none', warrantyAdder: 0 },
      ],
      ['Current rear scope']],
  ])('pricing reconciliation assigns warranty evidence to one distinct trenching job: %s', (
    _name, pricedRows, savedRows, purchasedLabels,
  ) => {
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: pricedRows.reduce((sum, row) => sum + row.amount, 0) },
      estData: { result: { oneTime: { items: savedRows } } },
      pricingBundle: { anchorOneTimePrice: 1800, oneTimeBreakdown: { items: pricedRows } },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items.filter((row) => row.purchasedTerms.length).map((row) => row.label))
      .toEqual(purchasedLabels);
    const terms = context.guarantees.serviceTerms;
    expect(terms.filter((entry) => entry.terms.includes('Annual inspection during the warranty period')))
      .toHaveLength(1);
    expect(terms.filter((entry) => entry.terms.includes('No guarantee.'))).toHaveLength(pricedRows.length - 1);
    const answer = answerEstimateQuestionFallback('What guarantee does the trenching include?', context);
    for (const entry of terms) expect(answer).toContain(`${entry.service}: ${entry.terms.join(' ')}`);
  });

  test('identical direct engine jobs keep their own decisions in context and scoped answers', () => {
    const rows = [
      { service: 'trenching', label: 'Termite Trenching', amount: 900,
        warrantyTier: 'one_year_retreat', warrantyAdder: 0 },
      { service: 'trenching', label: 'Termite Trenching', amount: 900,
        warrantyTier: 'none', warrantyAdder: 0 },
    ];
    for (const directRows of [rows, [...rows].reverse()]) {
      const context = buildEstimateAssistantContext({
        estimate: { onetime_total: 1800 }, serviceMode: 'one_time', noGuaranteeClaims: true,
        estData: {},
        pricingBundle: { source: 'engine_invocation', snapshotHit: false,
          anchorOneTimePrice: 1800, oneTimeBreakdown: { total: 1800, items: directRows } },
      });
      expect(context.oneTime.items).toHaveLength(2);
      expect(context.oneTime.items.filter((row) => row.purchasedTerms
        .includes('Annual inspection during the warranty period'))).toHaveLength(1);
      const paidFirst = directRows[0].warrantyTier === 'one_year_retreat';
      expect(context.guarantees.serviceTerms).toEqual([
        { service: 'Termite Trenching job 1 of 2 at $900',
          terms: [paidFirst ? 'Annual inspection during the warranty period' : 'No guarantee.'] },
        { service: 'Termite Trenching job 2 of 2 at $900',
          terms: [paidFirst ? 'No guarantee.' : 'Annual inspection during the warranty period'] },
      ]);
    }
  });

  test('identical current jobs with the same decision are both listed (Codex #4982)', () => {
    const rows = [
      { service: 'trenching', label: 'Termite Trenching', amount: 900, warrantyTier: 'one_year_retreat', warrantyAdder: 0 },
      { service: 'trenching', label: 'Termite Trenching', amount: 900, warrantyTier: 'one_year_retreat', warrantyAdder: 0 },
    ];
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1800 }, serviceMode: 'one_time', noGuaranteeClaims: true,
      estData: {},
      pricingBundle: { source: 'engine_invocation', snapshotHit: false,
        anchorOneTimePrice: 1800, oneTimeBreakdown: { total: 1800, items: rows } },
    });
    expect(context.oneTime.items).toHaveLength(2);
    expect(context.guarantees.serviceTerms).toEqual([
      { service: 'Termite Trenching job 1 of 2 at $900', terms: ['Annual inspection during the warranty period'] },
      { service: 'Termite Trenching job 2 of 2 at $900', terms: ['Annual inspection during the warranty period'] },
    ]);
    const answer = answerEstimateQuestionFallback('Is the trenching guaranteed?', context);
    expect(answer).toContain('Termite Trenching job 1 of 2 at $900: Annual inspection');
    expect(answer).toContain('Termite Trenching job 2 of 2 at $900: Annual inspection');
  });

  test.each([
    ['unpaid-unpaid-paid', ['none', 'none', 'one_year_retreat']],
    ['paid-paid-unpaid', ['one_year_retreat', 'one_year_retreat', 'none']],
  ])('identical current jobs retain their source multiplicity: %s', (_name, tiers) => {
    const rows = tiers.map((warrantyTier) => ({
      service: 'trenching', label: 'Termite Trenching', amount: 900,
      warrantyTier, warrantyAdder: 0,
    }));
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 2700 }, serviceMode: 'one_time', noGuaranteeClaims: true,
      estData: {},
      pricingBundle: { source: 'engine_invocation', snapshotHit: false,
        anchorOneTimePrice: 2700, oneTimeBreakdown: { total: 2700, items: rows } },
    });
    expect(context.oneTime.items).toHaveLength(3);
    expect(context.guarantees.serviceTerms).toEqual(tiers.map((tier, index) => ({
      service: `Termite Trenching job ${index + 1} of 3 at $900`,
      terms: [tier === 'none' ? 'No guarantee.' : 'Annual inspection during the warranty period'],
    })));
  });

  test.each([
    ['paid-first', false],
    ['removed-first', true],
  ])('every wording of a guarantee question gets the same per-service answer: %s', (_name, reverse) => {
    // Owner ruling 2026-09-27: the assistant never guesses from a question's
    // prices, labels or service words which job is meant. It lists each job
    // with its own terms, so a sibling's purchase can't be borrowed either way.
    const paid = { service: 'trenching', label: 'Rear Trenching', amount: 900,
      warrantyTier: 'one_year_retreat', warrantyAdder: 0 };
    const removed = { service: 'trenching', label: 'Front Trenching', amount: 700,
      warrantyTier: 'none', warrantyAdder: 0 };
    const rows = reverse ? [removed, paid] : [paid, removed];
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1600 }, serviceMode: 'one_time', noGuaranteeClaims: true,
      estData: {},
      pricingBundle: { source: 'engine_invocation', snapshotHit: false,
        anchorOneTimePrice: 1600, oneTimeBreakdown: { total: 1600, items: rows } },
    });
    const answers = [
      'Does the $700 trenching include a guarantee?',
      'Does the 900 dollars trenching include a guarantee?',
      'Does the trenching priced at seven hundred include a guarantee?',
      'Does the Front Trenching include a guarantee?',
      'Does the Rear Trenching include a guarantee?',
      'What guarantees do Trenching and Rear Trenching include?',
      'Does the cost of trenching include a warranty?',
      'Does the trenching cost include an annual inspection?',
    ].map((question) => answerEstimateQuestionFallback(question, context));
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain('Rear Trenching: Annual inspection during the warranty period.');
    expect(answers[0]).toContain('Front Trenching: No guarantee.');
    expect(answers[0]).toMatch(/do not see an estimate-wide callback or money-back guarantee/i);
  });

  test.each([
    ['ascending', [700, 900]],
    ['descending', [900, 700]],
  ])('same-label paid jobs are each listed by price: %s', (_name, amounts) => {
    const rows = amounts.map((amount) => ({
      service: 'trenching', label: 'Termite Trenching', amount,
      warrantyTier: 'one_year_retreat', warrantyAdder: 0,
    }));
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1600 }, serviceMode: 'one_time', noGuaranteeClaims: true,
      estData: {},
      pricingBundle: { source: 'engine_invocation', snapshotHit: false,
        anchorOneTimePrice: 1600, oneTimeBreakdown: { total: 1600, items: rows } },
    });
    expect(context.oneTime.items).toHaveLength(2);
    expect(context.guarantees.serviceTerms).toEqual(amounts.map((amount) => ({
      service: `Termite Trenching at $${amount}`, terms: ['Annual inspection during the warranty period'],
    })));
  });

  test.each([
    ['extended', true, 'Extended 5-year warranty', 'Extended 5-year warranty selected. Warranty terms depend on the selected warranty option.'],
    ['basic', false, 'No extended warranty selected', 'Warranty terms depend on the selected warranty option. No extended warranty selected.'],
  ])('a pre-slab job states its %s warranty option, never "No guarantee"', (_tier, extended, status, statement) => {
    // Owner ruling 2026-09-27: a selected pre-slab warranty is stated. The
    // wording is the page's own (preSlabCustomerCopy), read from the same row.
    const item = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950,
      warrantyExtendedSelected: extended, warrantyStatus: status };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 950 }, serviceMode: 'one_time', noGuaranteeClaims: true, estData: {},
      pricingBundle: { anchorOneTimePrice: 950, oneTimeBreakdown: { total: 950, items: [item] } },
    });
    expect(context.guarantees.serviceTerms).toEqual([
      { service: 'Pre-Slab Termiticide Treatment', terms: [statement] },
    ]);
    const answer = answerEstimateQuestionFallback('What warranty comes with the pre-slab treatment?', context);
    expect(answer).toContain(`Pre-Slab Termiticide Treatment: ${statement}`);
    expect(answer).not.toContain('Pre-Slab Termiticide Treatment: No guarantee.');
  });

  test('a Bora-Care warranty question gets the per-service answer, not the product shortcut', () => {
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 2250 }, serviceMode: 'one_time', noGuaranteeClaims: true, estData: {},
      pricingBundle: { source: 'engine_invocation', snapshotHit: false, anchorOneTimePrice: 2250,
        oneTimeBreakdown: { total: 2250, items: [
          { service: 'bora_care', label: 'Bora-Care Wood Treatment', amount: 1050 },
          { service: 'trenching', label: 'Termite Trenching', amount: 1200,
            warrantyTier: 'one_year_retreat', warrantyAdder: 0 },
        ] } },
    });
    const answer = answerEstimateQuestionFallback('Does Bora-Care include a warranty?', context);
    expect(answer).toContain('Bora-Care Wood Treatment: No guarantee.');
    expect(answer).toContain('Termite Trenching: Annual inspection during the warranty period.');
    expect(answer).not.toMatch(/borate treatment applied to bare wood/i);
    // A product question without guarantee wording keeps the Bora-Care answer.
    expect(answerEstimateQuestionFallback('Does Bora-Care cover beetles?', context))
      .toMatch(/borate treatment applied to bare wood/i);
  });

  test('an estimate with termite work states no other service\'s plan terms, as the page does', () => {
    // AGENTS.md estimate truth scope: with termite work on the estimate, no
    // service states callback, money-back, satisfaction or no-contract terms;
    // the page strips the same clauses from row details.
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55 },
      pricingBundle: { frequencies: [{ key: 'monthly', monthly: 55, included: [
        { service: 'rodent_bait', label: 'Rodent Bait Stations',
          detail: 'Station service. Satisfaction guaranteed for the initial treatment only.' },
        { service: 'termite_bait', label: 'Termite Bait Monitoring' },
      ] }] },
      noGuaranteeClaims: true,
    });
    const answer = answerEstimateQuestionFallback('Is satisfaction guaranteed on the rodent stations?', context);
    expect(answer).not.toMatch(/satisfaction guaranteed/i);
    expect(answer).toContain('Termite Service: No guarantee.');
    expect(answer).toMatch(/do not see an estimate-wide callback or money-back guarantee/i);
  });

  test('a hidden priced pre-slab add-on still exposes its selected warranty terms', () => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55, visitsPerYear: 4 };
    const extended = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950,
      warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty selected' };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 950, show_one_time_option: false },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: { result: { recurring: { services: [recurring] }, oneTime: { items: [extended] } } },
      pricingBundle: { source: 'engine_invocation', snapshotHit: false, anchorOneTimePrice: 950,
        oneTimeBreakdown: { total: 950, items: [extended] } },
    });
    expect(context.serviceMode).toBe('recurring');
    expect(context.oneTime.items).toHaveLength(1);
    expect(context.guarantees.serviceTerms).toEqual([{
      service: 'Pre-Slab Termiticide Treatment',
      terms: ['Extended 5-year warranty selected. Warranty terms depend on the selected warranty option.'],
    }]);
  });

  test.each([
    ['snapshot current basic beats stale extended',
      { warrantyExtendedSelected: false, warrantyStatus: 'No extended warranty selected' },
      { warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty selected' }, true],
    ['explicit false beats stale positive status',
      null,
      { warrantyExtendedSelected: false, warrantyStatus: 'Extended 5-year warranty selected' }, false],
  ])('%s', (_name, currentWarranty, pricedWarranty, snapshotHit) => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55 };
    const base = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950 };
    const priced = { ...base, ...pricedWarranty };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 950, show_one_time_option: true },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: currentWarranty ? { result: { recurring: { services: [recurring] },
        oneTime: { items: [{ ...base, ...currentWarranty }] } } } : {},
      pricingBundle: { source: 'engine_invocation', snapshotHit, anchorOneTimePrice: 950,
        oneTimeBreakdown: { total: 950, items: [priced] } },
    });
    expect(context.guarantees.serviceTerms).toEqual([{
      service: 'Pre-Slab Termiticide Treatment',
      terms: ['Warranty terms depend on the selected warranty option. No extended warranty selected.'],
    }]);
  });

  test('a saved row whose removal lives only in its detail text governs a stale snapshot detail (pre-push P1)', () => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55 };
    const base = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950 };
    const saved = { ...base, detail: 'Termite soil treatment before the slab pour | No extended warranty selected' };
    const snapshot = { ...base, detail: 'Termite soil treatment before the slab pour | Extended 5-year warranty' };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 950, show_one_time_option: true },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: { result: { recurring: { services: [recurring] }, oneTime: { items: [saved] } } },
      pricingBundle: { source: 'engine_invocation', snapshotHit: true, anchorOneTimePrice: 950,
        oneTimeBreakdown: { total: 950, items: [snapshot] } },
    });
    const row = context.oneTime.items[0];
    expect(row.warrantyExtendedSelected).toBe(false);
    expect(row.warrantyTerms.join(' ')).toContain('No extended warranty selected.');
    expect(row.detail).not.toMatch(/extended 5-year warranty/i);
    expect(context.guarantees.serviceTerms).toEqual([{
      service: 'Pre-Slab Termiticide Treatment',
      terms: ['Warranty terms depend on the selected warranty option. No extended warranty selected.'],
    }]);
    expect(answerEstimateQuestionFallback('What is included?', context)).not.toMatch(/extended 5-year warranty/i);
  });

  test('historical engine evidence never revives a warranty the priced snapshot removed (pre-push P1)', () => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55 };
    const base = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950 };
    const currentUndecided = { ...base };
    const historicalExtended = { ...base, warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty selected' };
    const snapshotRemoved = { ...base, warrantyExtendedSelected: false, detail: 'Termite soil treatment | Extended 5-year warranty' };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 950, show_one_time_option: true },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: {
        result: { recurring: { services: [recurring] }, oneTime: { items: [currentUndecided] } },
        engineResult: { recurring: { services: [recurring] }, oneTime: { items: [historicalExtended] } },
      },
      pricingBundle: { source: 'engine_invocation', snapshotHit: true, anchorOneTimePrice: 950,
        oneTimeBreakdown: { total: 950, items: [snapshotRemoved] } },
    });
    const row = context.oneTime.items[0];
    expect(row.warrantyExtendedSelected).toBe(false);
    expect(row.detail).not.toMatch(/extended 5-year warranty/i);
    expect(context.guarantees.serviceTerms).toEqual([{
      service: 'Pre-Slab Termiticide Treatment',
      terms: ['Warranty terms depend on the selected warranty option. No extended warranty selected.'],
    }]);
  });

  test('an exact-label saved row is reserved for its job before amount fallback (pre-push P1)', () => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55 };
    const house = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment – House', amount: 1000 };
    const annex = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment – Annex', amount: 1200 };
    const savedHouse = { ...house, amount: 1200, warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty selected' };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 2200, show_one_time_option: true },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: { result: { recurring: { services: [recurring] }, oneTime: { items: [savedHouse] } } },
      pricingBundle: { source: 'engine_invocation', snapshotHit: true, anchorOneTimePrice: 2200,
        oneTimeBreakdown: { total: 2200, items: [house, annex] } },
    });
    expect(context.guarantees.serviceTerms).toEqual([
      { service: 'Pre-Slab Termiticide Treatment – House',
        terms: ['Extended 5-year warranty selected. Warranty terms depend on the selected warranty option.'] },
      { service: 'Pre-Slab Termiticide Treatment – Annex',
        terms: ['Warranty terms depend on the selected warranty option. No extended warranty selected.'] },
    ]);
  });

  test('a legacy-mapped undefined flag is no decision: the saved selection still governs (Codex #5195 r1)', () => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55 };
    const base = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950 };
    const priced = { ...base, warrantyExtendedSelected: undefined };
    expect(Object.prototype.hasOwnProperty.call(priced, 'warrantyExtendedSelected')).toBe(true);
    const saved = { ...base, warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty selected' };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 950, show_one_time_option: true },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: { result: { recurring: { services: [recurring] }, oneTime: { items: [saved] } } },
      pricingBundle: { source: 'engine_invocation', snapshotHit: false, anchorOneTimePrice: 950,
        oneTimeBreakdown: { total: 950, items: [priced] } },
    });
    expect(context.guarantees.serviceTerms).toEqual([{
      service: 'Pre-Slab Termiticide Treatment',
      terms: ['Extended 5-year warranty selected. Warranty terms depend on the selected warranty option.'],
    }]);
  });

  test('a pre-slab row only an older engineResult retains is not exposed for its warranty terms (Codex #5195 r1)', () => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55, visitsPerYear: 4 };
    const removed = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950,
      warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty selected' };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, show_one_time_option: false },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: {
        result: { recurring: { services: [recurring] }, oneTime: { items: [] } },
        engineResult: { recurring: { services: [recurring] }, oneTime: { items: [removed] } },
      },
      pricingBundle: { source: 'engine_invocation', snapshotHit: false,
        frequencies: [{ key: 'quarterly', monthly: 55, included: [{ service: 'pest_control', label: 'Pest Control' }] }] },
    });
    expect(context.serviceMode).toBe('recurring');
    expect(context.oneTime?.items ?? null).toBeNull();
    expect(JSON.stringify(context.guarantees.serviceTerms)).not.toMatch(/Pre-Slab/);
    expect(answerEstimateQuestionFallback('What is included?', context)).not.toMatch(/pre-slab|extended 5-year/i);
  });

  test('an undecided priced pre-slab row never inherits a saved sibling\'s selection through the merge (tree-reviewer)', () => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55 };
    const base = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment' };
    const priced = { ...base, amount: 2200, detail: 'Termite soil treatment before the slab pour' };
    const savedBasic = { ...base, amount: 1000, warrantyExtendedSelected: false, warrantyStatus: 'No extended warranty selected' };
    const savedExtended = { ...base, amount: 1200, warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty' };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 2200, show_one_time_option: true },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: { result: { recurring: { services: [recurring] }, oneTime: { items: [savedBasic, savedExtended] } } },
      pricingBundle: { source: 'engine_invocation', snapshotHit: true, anchorOneTimePrice: 2200,
        oneTimeBreakdown: { total: 2200, items: [priced] } },
    });
    const row = context.oneTime.items.find((item) => item.amount === 2200);
    expect(row.warrantyExtendedSelected).not.toBe(true);
    expect(row.warrantyStatus ?? '').not.toMatch(/extended/i);
    expect(row.warrantyTerms.join(' ')).toContain('No extended warranty selected.');
    expect(JSON.stringify(context)).not.toMatch(/Extended 5-year warranty selected/);
  });

  test('an ambiguous current group stops the search: no historical row is borrowed (tree-reviewer)', () => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55 };
    const priced = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950, detail: 'Termite soil treatment' };
    const house = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide – House', amount: 950, warrantyExtendedSelected: false };
    const annex = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide – Annex', amount: 950, warrantyExtendedSelected: false };
    const historical = { ...priced, warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty' };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 950, show_one_time_option: true },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: {
        result: { recurring: { services: [recurring] }, oneTime: { items: [house, annex] } },
        engineResult: { recurring: { services: [recurring] }, oneTime: { items: [historical] } },
      },
      pricingBundle: { source: 'engine_invocation', snapshotHit: true, anchorOneTimePrice: 950,
        oneTimeBreakdown: { total: 950, items: [priced] } },
    });
    expect(JSON.stringify(context)).not.toMatch(/Extended 5-year warranty selected/);
  });

  test('terms, flag and status all follow one decision (tree-reviewer)', () => {
    const base = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950 };
    for (const [row, extended] of [
      [{ ...base, warrantyExtendedSelected: null, warrantyStatus: 'Extended 5-year warranty' }, true],
      [{ ...base, warrantyStatus: 'Basic warranty; 5-year option declined' }, false],
      [{ ...base, warrantyExtendedSelected: false, warrantyStatus: 'Extended 5-year warranty' }, false],
    ]) {
      const context = buildEstimateAssistantContext({
        estimate: { onetime_total: 950 }, serviceMode: 'one_time', noGuaranteeClaims: true,
        pricingBundle: { source: 'engine_invocation', snapshotHit: false, anchorOneTimePrice: 950,
          oneTimeBreakdown: { total: 950, items: [row] } },
      });
      const item = context.oneTime.items[0];
      expect(item.warrantyExtendedSelected).toBe(extended);
      expect(item.warrantyTerms[0].startsWith('Extended 5-year warranty selected')).toBe(extended);
    }
  });

  test('without pricing, an undecided current row borrows one matching older decision, consistently (tree-reviewer)', () => {
    const base = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950 };
    const current = { ...base, detail: 'Termite soil treatment' };
    const historical = { ...base, warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty' };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 950 }, serviceMode: 'one_time', noGuaranteeClaims: true,
      estData: { result: { oneTime: { items: [current] } }, engineResult: { oneTime: { items: [historical] } } },
    });
    const item = context.oneTime.items[0];
    expect(item.warrantyExtendedSelected).toBe(true);
    expect(item.warrantyTerms[0]).toMatch(/^Extended 5-year warranty selected/);
  });

  test('a current pre-slab add-on does not drag a removed historical service into the context (pre-push P1)', () => {
    const recurring = { service: 'pest_control', name: 'Pest Control', mo: 55, visitsPerYear: 4 };
    const preSlab = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950,
      warrantyExtendedSelected: true, warrantyStatus: 'Extended 5-year warranty selected' };
    const removedFoam = { service: 'termite_foam', label: 'Termite Foam Treatment', amount: 400 };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 950, show_one_time_option: false },
      serviceMode: 'recurring', noGuaranteeClaims: true,
      estData: {
        result: { recurring: { services: [recurring] }, oneTime: { items: [preSlab] } },
        engineResult: { recurring: { services: [recurring] }, oneTime: { items: [preSlab, removedFoam] } },
      },
      pricingBundle: { source: 'engine_invocation', snapshotHit: false, anchorOneTimePrice: 950,
        oneTimeBreakdown: { total: 950, items: [preSlab] } },
    });
    expect(context.oneTime.items.map((row) => row.label)).toEqual(['Pre-Slab Termiticide Treatment']);
    expect(JSON.stringify(context)).not.toMatch(/Termite Foam Treatment/);
    expect(answerEstimateQuestionFallback('What is included?', context)).not.toMatch(/foam/i);
  });

  test('a hand-built context lists each row under its own name', () => {
    const bond = 'Purchased termite bond: 5-year term with re-treatment coverage.';
    const rows = [
      { service: 'termite_bond_5yr', label: 'Termite Bond', amount: 700, purchasedTerms: [bond] },
      { service: 'trenching', label: 'Trenching', amount: 900, purchasedTerms: [] },
    ];
    const context = {
      serviceMode: 'one_time', services: rows,
      oneTime: { amount: 1600, amountText: '$1,600', items: rows },
      guarantees: { noGuaranteeClaims: true },
    };
    const answer = answerEstimateQuestionFallback('Does the $700 trenching include a guarantee?', context);
    expect(answer).toContain(`Termite Bond: ${bond}`);
    expect(answer).toContain('Trenching: No guarantee.');
    expect(answer).not.toContain('Annual inspection during the warranty period');
  });

  test.each([
    ['none', { warrantyTier: 'none', warrantyAdder: 0 }],
    ['null', { warrantyTier: null, warrantyAdder: null }],
  ])('an explicit live %s decision suppresses older raw trenching warranty evidence', (_name, liveDecision) => {
    const row = { service: 'trenching', label: 'Termite Trenching', amount: 1200, price: 1200 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: {
        result: { oneTime: { items: [{ ...row, ...liveDecision }] } },
        engineResult: { oneTime: { items: [{ ...row, warrantyTier: 'one_year_retreat', warrantyAdder: 0 }] } },
      },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items[0].purchasedTerms).toEqual([]);
  });

  test.each([
    ['key alias removal', { key: 'trenching', label: 'Termite Trenching', price: 1200,
      warrantyTier: 'none', warrantyAdder: 0 }],
    ['tier conflict', { service: 'trenching', label: 'Termite Trenching', price: 1200,
      warrantyTier: 'three_year_repair_retreat' }],
    ['renamed removal', { service: 'trenching', label: 'Updated Trenching Scope', price: 1200,
      warrantyTier: 'none', warrantyAdder: 0 }],
    ['zero-price removal', { service: 'trenching', label: 'Updated Trenching Scope', price: 0,
      warrantyTier: 'none', warrantyAdder: 0 }],
  ])('current %s cannot resurrect older raw warranty proof', (_name, current) => {
    const raw = { service: 'trenching', label: 'Termite Trenching', price: 1200,
      warrantyTier: 'one_year_retreat', warrantyAdder: 0 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: {
        result: { oneTime: { items: [current] } },
        engineResult: { oneTime: { items: [raw] } },
      },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items.flatMap((row) => row.purchasedTerms || [])).toEqual([]);
  });

  test.each([
    ['oneTime with empty root', (row) => ({ specItems: [], oneTime: { specItems: [row] } })],
    ['oneTime with unrelated root', (row) => ({ specItems: [{ service: 'one_time_pest', price: 250 }], oneTime: { specItems: [row] } })],
    ['nested oneTime with empty root', (row) => ({ specItems: [], results: { oneTime: { specItems: [row] } } })],
  ])('current nested warranty removal survives %s specItems', (_name, currentShape) => {
    const row = { service: 'trenching', label: 'Termite Trenching', price: 1200 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: {
        result: currentShape({ ...row, warrantyTier: 'none', warrantyAdder: 0 }),
        engineResult: { oneTime: { items: [{ ...row, warrantyTier: 'one_year_retreat', warrantyAdder: 0 }] } },
      },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items.flatMap((item) => item.purchasedTerms || [])).toEqual([]);
    expect(answerEstimateQuestionFallback('Does the trenching warranty include an annual inspection?', context))
      .not.toContain('Annual inspection during the warranty period');
  });

  test('ambiguous duplicate raw trenching rows cannot prove purchased terms', () => {
    const mapped = { service: 'trenching', label: 'Termite Trenching', amount: 1200, price: 1200,
      warrantyTier: 'one_year_retreat' };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: {
        result: { oneTime: { items: [mapped] } },
        engineResult: { oneTime: { items: [
          { ...mapped, warrantyAdder: 0 },
          { ...mapped, warrantyTier: 'three_year_repair_retreat', warrantyAdder: 117 },
        ] } },
      },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items[0].purchasedTerms || []).toEqual([]);
  });

  test('a canonically priced termite bond exposes only its selected purchased term under no-guarantee policy', () => {
    const context = buildEstimateAssistantContext({
      estimate: { waveguard_tier: 'Bronze', monthly_total: 49 },
      estData: {
        result: { recurring: { services: [
          { service: 'termite_bait', name: 'Termite Bait Monitoring', mo: 34, perTreatment: 102, visitsPerYear: 4 },
        ] } },
        engineResult: { lineItems: [
          { service: 'termite_bond', name: 'Termite Bond (10-Year Term)', bondTerm: '10yr', bondYears: 10,
            monthly: 15, perApp: 45, visitsPerYear: 4, detail: 'Lifetime repair guarantee' },
        ] },
      },
      pricingBundle: { waveGuardTier: 'Bronze', frequencies: [{ key: 'quarterly', monthly: 49, annual: 588,
        included: [{ service: 'termite_bait', label: 'Termite Bait Monitoring' }],
        perServiceTreatments: [{ service: 'termite_bait', label: 'Termite Bait Monitoring', perTreatment: 147, visitsPerYear: 4 }],
      }] },
      noGuaranteeClaims: true,
    });

    const bondTerm = context.recurringServices.flatMap((row) => row.purchasedTerms || []);
    expect(bondTerm).toEqual(['Purchased termite bond: 10-year term with re-treatment coverage.']);
    expect(JSON.stringify(context)).not.toMatch(/Lifetime repair guarantee/i);
    const answer = answerEstimateQuestionFallback('What re-treatment does my termite bond include?', context);
    expect(answer).toContain('Termite Bond: Purchased termite bond: 10-year term with re-treatment coverage.');
    expect(answer).toContain('Termite Service: No guarantee.');
    expect(answer).toContain('applies to that service only');
    expect(answer).toMatch(/do not see an estimate-wide callback/i);
    for (const question of [
      'Does my termite bond include free callbacks?',
      'What bond did I buy?', 'What warranty did I buy?', 'What guarantee does my termite bond include?',
    ]) {
      expect(answerEstimateQuestionFallback(question, context)).toBe(answer);
    }

    const unproven = buildEstimateAssistantContext({
      estimate: { monthly_total: 15 },
      estData: { result: { recurring: { services: [{ service: 'termite_bait', name: 'Termite Bond (10-Year Term)',
        bondTerm: '10yr', bondYears: 10, mo: 15, detail: 'Re-treatment coverage' }] } } },
      noGuaranteeClaims: true,
    });
    expect(unproven.recurringServices.flatMap((row) => row.purchasedTerms || [])).toEqual([]);
    expect(answerEstimateQuestionFallback('What re-treatment does my termite bond include?', unproven))
      .toMatch(/written service scope and terms/i);
  });

  test.each([
    ['name-derived', { service: 'termite_bond', name: 'Termite Bond (5-Year Term)', annual: 216 }, true],
    ['bondYears-derived', { service: 'termite_bond', name: 'Termite Bond', bondYears: 10, annual: 180 }, true],
    ['serviceKey alias', { serviceKey: 'termite_bond', name: 'Termite Bond (1-Year Term)', annual: 240 }, true],
    ['name-only', { name: 'Termite Bond (5-Year Term)', annual: 216 }, true],
    ['wrong service', { service: 'termite_bait', name: 'Termite Bond (5-Year Term)', annual: 216 }, false],
    ['unsupported name', { service: 'termite_bond', name: 'Termite Bond (7-Year Term)', annual: 216 }, false],
    ['unpaid', { service: 'termite_bond', name: 'Termite Bond (5-Year Term)', annual: 0 }, false],
  ])('legacy bond normalization proves only supported purchased identities: %s', (_name, row, purchased) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 18 },
      estData: { result: { recurring: { services: [row] } } },
      noGuaranteeClaims: true,
    });
    const terms = context.recurringServices.flatMap((item) => item.purchasedTerms || []);
    expect(terms.length > 0).toBe(purchased);
    if (purchased) expect(terms[0]).toMatch(/Purchased termite bond: (1|5|10)-year term/);
  });

  test('a name-only legacy bond in raw lineItems clears every identity gate', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 18 },
      estData: { engineResult: { lineItems: [
        { name: 'Termite Bond (5-Year Term)', annual: 216 },
      ] } },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices.flatMap((row) => row.purchasedTerms || []))
      .toEqual(['Purchased termite bond: 5-year term with re-treatment coverage.']);
  });

  test.each([
    ['disabled snake-case option, paid warranty', { show_one_time_option: false }, 117],
    ['disabled snake-case option, included warranty', { show_one_time_option: false }, 0],
    ['disabled camel-case option', { showOneTimeOption: false }, 117],
    ['absent one-time option', {}, 117],
  ])('recurring estimates retain purchased add-on terms: %s', (_name, option, warrantyAdder) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 900, ...option },
      estData: { result: {
        recurring: { services: [{ service: 'pest', name: 'Pest Control', monthly: 55 }] },
        oneTime: { items: [{ service: 'trenching', label: 'Termite Trenching', amount: 900,
          warrantyTier: 'one_year_retreat', warrantyAdder }] },
      } },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.serviceMode).toBe('recurring');
    expect(context.services.map((row) => row.service)).toEqual(['pest']);
    expect(context.oneTime.items[0].purchasedTerms)
      .toContain('Annual inspection during the warranty period');
    expect(answerEstimateQuestionFallback('What warranty does the trenching include?', context))
      .toContain('Annual inspection during the warranty period');
  });

  test.each([
    ['unselected warranty', { warrantyTier: 'none', warrantyAdder: 0 }],
    ['missing purchase evidence', { warrantyTier: 'one_year_retreat' }],
  ])('a hidden one-time option does not invent add-on coverage: %s', (_name, warranty) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 55, onetime_total: 900, show_one_time_option: false },
      estData: { result: {
        recurring: { services: [{ service: 'pest', name: 'Pest Control', monthly: 55 }] },
        oneTime: { items: [{ service: 'trenching', label: 'Termite Trenching', amount: 900,
          ...warranty }] },
      } },
      noGuaranteeClaims: true,
    });
    expect(context.serviceMode).toBe('recurring');
    expect(context.oneTime).toBeNull();
    expect(answerEstimateQuestionFallback('What warranty does the trenching include?', context))
      .not.toMatch(/annual inspection|purchased.*warranty/i);
  });

  test('mixed purchased warranties are each listed under their own service', () => {
    const trenching = { service: 'trenching', label: 'Termite Trenching', amount: 1200, price: 1200,
      warrantyTier: 'one_year_retreat', warrantyAdder: 0 };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 18, onetime_total: 1200, show_one_time_option: true },
      estData: { result: {
        recurring: { services: [
          { service: 'termite_bond', name: 'Termite Bond (5-Year Term)', annual: 216 },
        ] },
        oneTime: { items: [trenching] },
      } },
      noGuaranteeClaims: true,
    });

    expect(context.guarantees.serviceTerms).toEqual([
      { service: 'Termite Bond', terms: ['Purchased termite bond: 5-year term with re-treatment coverage.'] },
      { service: 'Termite Trenching', terms: ['Annual inspection during the warranty period'] },
    ]);
    const answers = [
      'What warranty does the trenching include?',
      'What warranty does the bond include?',
      'Is annual inspection included with my termite bond?',
      'What warranty did I buy?',
    ].map((question) => answerEstimateQuestionFallback(question, context));
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toMatch(/Termite Bond: Purchased termite bond: 5-year term[^.]*\. Termite Trenching: Annual inspection/);
    expect(answers[0]).toContain('Each of those terms applies to that service only');
  });

  test('a named service without purchased terms cannot inherit another service warranty', () => {
    const bond = { service: 'termite_bond', name: 'Termite Bond (5-Year Term)', annual: 216 };
    const bondOnly = buildEstimateAssistantContext({
      estimate: { monthly_total: 18 },
      estData: { result: { recurring: { services: [bond] } } },
      noGuaranteeClaims: true,
    });
    const missingTrenching = answerEstimateQuestionFallback('What warranty does the trenching include?', bondOnly);
    expect(missingTrenching).toContain('Termite Bond: Purchased termite bond: 5-year term with re-treatment coverage.');
    expect(missingTrenching).not.toMatch(/trenching/i);

    const mixed = buildEstimateAssistantContext({
      estimate: { monthly_total: 38 },
      estData: { result: { recurring: { services: [
        bond,
        { service: 'rodent_bait', name: 'Rodent Bait Stations', monthly: 20 },
      ] } } },
      noGuaranteeClaims: true,
    });
    expect(mixed.guarantees.serviceTerms).toEqual([
      { service: 'Termite Bond', terms: ['Purchased termite bond: 5-year term with re-treatment coverage.'] },
    ]);
    const rodent = answerEstimateQuestionFallback('What warranty does the rodent service include?', mixed);
    expect(rodent).not.toMatch(/Rodent Bait Stations:/);
    expect(answerEstimateQuestionFallback('What warranty did I buy?', mixed)).toBe(rodent);
  });

  test.each([
    ['1yr', 1, 60],
    ['5yr', 5, 54],
    ['10yr', 10, 45],
  ])('pricing-only canonical %s bond retains its purchased term', (term, years, perTreatment) => {
    const bond = { service: `termite_bond_${term}`, label: `Termite Bond (${years}-Year Term)`,
      bondTerm: term, bondYears: years, perTreatment, visitsPerYear: 4 };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: perTreatment / 3 },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: perTreatment / 3,
        included: [{ service: bond.service, label: bond.label, bondTerm: term, bondYears: years }],
        perServiceTreatments: [bond],
      }] },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices.flatMap((row) => row.purchasedTerms || []))
      .toEqual([`Purchased termite bond: ${years}-year term with re-treatment coverage.`]);
  });

  test('pricing keeps termite bait and its purchased bond as separate service identities', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 49 },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 49,
        included: [
          { service: 'termite_bait', label: 'Termite Bait Monitoring' },
          { serviceKey: 'termite_bond_10yr', label: 'Termite Bond (10-Year Term)', selectedBondTerm: '10yr', years: 10 },
        ],
        perServiceTreatments: [
          { service: 'termite_bait', label: 'Termite Bait Monitoring', perTreatment: 102, visitsPerYear: 4 },
          { serviceKey: 'termite_bond_10yr', label: 'Termite Bond (10-Year Term)', selectedBondTerm: '10yr', years: 10,
            perTreatment: 45, visitsPerYear: 4 },
        ],
      }] },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices.map((row) => row.label)).toEqual(['Termite Service', 'Termite Bond']);
    expect(context.recurringServices.find((row) => row.label === 'Termite Bond').purchasedTerms)
      .toEqual(['Purchased termite bond: 10-year term with re-treatment coverage.']);
  });

  test.each([
    ['unpaid', { service: 'termite_bond_5yr', bondTerm: '5yr', bondYears: 5, perTreatment: 0 }],
    ['inconsistent term', { service: 'termite_bond_5yr', bondTerm: '10yr', bondYears: 10, perTreatment: 54 }],
    ['unsupported term', { service: 'termite_bond_7yr', bondTerm: '7yr', bondYears: 7, perTreatment: 54 }],
    ['label-only', { service: 'termite_bait', bondTerm: '10yr', bondYears: 10, perTreatment: 45 }],
    ['selected none', { service: 'termite_bond_10yr', bondTerm: '10yr', selectedBondTerm: 'none', bondYears: 10, perTreatment: 45 }],
    ['selected null', { service: 'termite_bond_10yr', bondTerm: '10yr', selectedBondTerm: null, bondYears: 10, perTreatment: 45 }],
    ['conflicting selected term', { service: 'termite_bond_10yr', bondTerm: '10yr', selectedBondTerm: '5yr', bondYears: 10, perTreatment: 45 }],
  ])('pricing-only %s bond metadata cannot create purchased terms', (_label, row) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 18 },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 18,
        perServiceTreatments: [{ ...row, label: 'Termite Bond (10-Year Term)', visitsPerYear: 4 }],
      }] },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices.flatMap((item) => item.purchasedTerms || [])).toEqual([]);
  });

  test('current result display fields outrank a contradictory historical engine bond row', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 18 },
      estData: {
        result: { recurring: { services: [{ service: 'termite_bond_10yr', name: 'Termite Bond (10-Year Term)',
          bondTerm: '10yr', bondYears: 10, mo: 15 }] } },
        engineResult: { recurring: { services: [{ service: 'termite_bond_5yr', name: 'Termite Bond (5-Year Term)',
          bondTerm: '10yr', bondYears: 10, mo: 18 }] } },
      },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices).toHaveLength(1);
    expect(context.recurringServices[0].service).toBe('termite_bond_10yr');
    expect(context.recurringServices[0].purchasedTerms).toEqual([]);
    expect(answerEstimateQuestionFallback('What warranty did I buy?', context))
      .toMatch(/written service scope and terms/i);
  });

  test('an unversioned historical bond removal keeps purchased terms conservative', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 15 },
      estData: {
        result: { recurring: { services: [{ service: 'termite_bond_10yr', name: 'Termite Bond (10-Year Term)',
          bondTerm: '10yr', bondYears: 10, mo: 15 }] } },
        engineResult: { recurring: { services: [{ service: 'termite_bond_10yr', name: 'Termite Bond',
          selectedBondTerm: 'none', bondYears: null, mo: 15 }] } },
      },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices).toHaveLength(1);
    expect(context.recurringServices[0].purchasedTerms).toEqual([]);
  });

  test.each([
    ['recurring removal', { recurring: { services: [{ service: 'termite_bond_10yr', selectedBondTerm: 'none', mo: 15 }] } }],
    ['contradictory replacement', { recurring: { services: [{ service: 'termite_bond_5yr', bondTerm: '10yr', bondYears: 10, mo: 18 }] } }],
    ['zero-price raw removal', { lineItems: [{ service: 'termite_bond', bondTerm: 'none', monthly: 0, perApp: 0 }] }],
  ])('%s clears a saved bond before frozen pricing filters fallback rows', (_name, engineResult) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 34 },
      estData: {
        result: { recurring: { services: [{ service: 'termite_bond_10yr', name: 'Termite Bond (10-Year Term)',
          bondTerm: '10yr', bondYears: 10, mo: 15 }] } },
        engineResult,
      },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 34, annual: 408,
        included: [{ service: 'termite_bait', label: 'Termite Bait Monitoring' }],
        perServiceTreatments: [{ service: 'termite_bait', label: 'Termite Bait Monitoring', perTreatment: 102, visitsPerYear: 4 }],
      }] },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices.map((row) => row.label)).toEqual(['Termite Service']);
    expect(context.recurringServices.flatMap((row) => row.purchasedTerms || [])).toEqual([]);
    expect(answerEstimateQuestionFallback('What warranty did I buy?', context))
      .toMatch(/written service scope and terms/i);
  });

  test.each([
    ['recurring removal', { recurring: { services: [{ service: 'termite_bond_10yr', selectedBondTerm: 'none', mo: 15 }] } }],
    ['nested removal', { results: { recurring: { services: [{ serviceKey: 'termite_bond_10yr', selectedBondTerm: null, mo: 15 }] } } }],
    ['raw removal', { lineItems: [{ service: 'termite_bond', bondTerm: 'none', monthly: 0 }] }],
    ['raw bait selector removal', { lineItems: [{ service: 'termite_bait', selectedBondTerm: 'none', monthly: 34 }] }],
    ['contradictory current term', { recurring: { services: [{ service: 'termite_bond_5yr', bondTerm: '10yr', mo: 18 }] } }],
    ['conflicting unversioned terms', { recurring: { services: [{ service: 'termite_bond_5yr', bondTerm: '5yr', mo: 18 }] } }],
    ['zero-price current term', { recurring: { services: [{ service: 'termite_bond_10yr', bondTerm: '10yr', mo: 0, annual: 0 }] } }],
  ])('%s cannot be overwritten by an older engine bond or frozen pricing', (_name, current) => {
    const savedBond = { service: 'termite_bond_10yr', label: 'Termite Bond (10-Year Term)',
      bondTerm: '10yr', bondYears: 10, perTreatment: 45, visitsPerYear: 4 };
    for (const frozenPricing of [false, true]) {
      const context = buildEstimateAssistantContext({
        estimate: { monthly_total: 49 },
        estData: { result: current, engineResult: { recurring: { services: [{ ...savedBond, mo: 15 }] } } },
        pricingBundle: frozenPricing ? { frequencies: [{ key: 'quarterly', monthly: 49,
          included: [savedBond], perServiceTreatments: [savedBond] }] } : {},
        noGuaranteeClaims: true,
      });
      expect({ frozenPricing, terms: context.recurringServices.flatMap((row) => row.purchasedTerms || []) })
        .toEqual({ frozenPricing, terms: [] });
      expect(answerEstimateQuestionFallback('What warranty did I buy?', context))
        .not.toMatch(/Purchased termite bond|\d+-year term with re-treatment coverage/i);
    }
  });

  test('a current top-level bond selector resolves historical term disagreement', () => {
    const bond = { service: 'termite_bond_5yr', label: 'Termite Bond (5-Year Term)',
      bondTerm: '5yr', bondYears: 5, perTreatment: 54, visitsPerYear: 4 };
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 18 },
      estData: { inputs: { termiteBondTerm: '5yr' },
        result: { recurring: { services: [{ ...bond, mo: 18 }] } },
        engineResult: { lineItems: [{ service: 'termite_bond', bondTerm: '10yr', bondYears: 10, monthly: 15 }] } },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 18, included: [bond], perServiceTreatments: [bond] }] },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices.flatMap((row) => row.purchasedTerms || []))
      .toEqual(['Purchased termite bond: 5-year term with re-treatment coverage.']);
  });

  test.each(['none', '10yr'])('the top-level legacy result.tmBait selector (%s) governs an older paid engine bond', (selected) => {
    // readV1Shape reads result.tmBait as well as result.results.tmBait; the
    // current decision there outranks a historical engine row (Codex #4982).
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 45 },
      estData: {
        result: { tmBait: { selectedBondTerm: selected },
          recurring: { services: [{ service: 'termite_bait', name: 'Termite Bait Monitoring', mo: 30 }] } },
        engineResult: { lineItems: [{ service: 'termite_bond', name: 'Termite Bond (5-Year Term)', bondTerm: '5yr', bondYears: 5, monthly: 15 }] },
      },
      noGuaranteeClaims: true,
    });
    const terms = context.recurringServices.flatMap((row) => row.purchasedTerms || []);
    expect(terms).not.toContain('Purchased termite bond: 5-year term with re-treatment coverage.');
    if (selected === 'none') expect(terms).toEqual([]);
  });

  test('a scheduling question that says "return" is not a guarantee question', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 45 },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 45, included: [
        { service: 'termite_bait', label: 'Termite Bait Monitoring' },
      ] }] },
      noGuaranteeClaims: true,
    });
    expect(answerEstimateQuestionFallback('When will you return for the next scheduled treatment?', context))
      .toMatch(/Pick one of the available times/);
    expect(answerEstimateQuestionFallback('What happens if the termites come back?', context))
      .toContain('Termite Service: No guarantee.');
  });

  // Two tiers (Codex #4982): a question that names a guarantee term gets each
  // service's terms whatever else it mentions; only a genuine price question
  // leaves it. Softer re-treatment wording still yields to scheduling.
  test.each([
    ['Is my next visit covered by the warranty?', true],
    ['How much warranty coverage do I get?', true],
    ['How much is covered?', true],
    ['How much does the warranty cover?', true],
    ['Does the cost of trenching include a warranty?', true],
    ['How much does the 5-year termite bond cost?', false],
    ['How much is the bond?', false],
    ['How much for the 5-year bond?', false],
    ['How much for coverage?', true],
    ['What’s the price of the warranty?', false],
    ['How often do you retreat the lawn?', false],
    ['Are you licensed and bonded?', false],
  ])('"%s" gets each service\'s terms: %s', (question, termsAnswer) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 45 },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 45, included: [
        { service: 'termite_bait', label: 'Termite Bait Monitoring' },
      ] }] },
      noGuaranteeClaims: true,
    });
    expect(/No guarantee\./.test(answerEstimateQuestionFallback(question, context))).toBe(termsAnswer);
  });

  test('a bond price question keeps its pricing answer (Codex #4982)', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 45 },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 45, included: [
        { service: 'termite_bait', label: 'Termite Bait Monitoring' },
      ] }] },
      noGuaranteeClaims: true,
    });
    const termsAnswer = answerEstimateQuestionFallback('What guarantee comes with the bond?', context);
    expect(termsAnswer).toContain('No guarantee.');
    expect(answerEstimateQuestionFallback('How much does the 5-year termite bond cost?', context)).not.toBe(termsAnswer);
  });

  test('a raw termite row behind a pest projection still states its own terms (Codex #4982)', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 85 },
      estData: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 55 }] } },
        engineResult: { lineItems: [{ service: 'termite_bait', name: 'Termite Bait Monitoring', monthly: 30 }] },
      },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 85, included: [
        { service: 'pest_control', label: 'Pest Control' },
      ] }] },
      noGuaranteeClaims: true,
    });
    expect(context.guarantees.serviceTerms.map((entry) => entry.terms[0])).toContain('No guarantee.');
    expect(answerEstimateQuestionFallback('Is there a guarantee?', context)).toMatch(/Termite[^:]*: No guarantee\./);
  });

  test('a trenching purchase mirrored into two saved containers is still proven (Codex #4982)', () => {
    const row = { service: 'trenching', label: 'Termite Trenching', amount: 1200, price: 1200,
      warrantyTier: 'one_year_retreat', warrantyAdder: 0 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: { result: {
        oneTime: { specItems: [JSON.parse(JSON.stringify(row))] },
        specItems: [JSON.parse(JSON.stringify(row))],
      } },
      serviceMode: 'one_time',
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items.flatMap((item) => item.purchasedTerms || []))
      .toContain('Annual inspection during the warranty period');
  });

  test('an explicit "no extended warranty" beats stale pre-slab prose (Codex #4982)', () => {
    const item = { service: 'pre_slab_termiticide', label: 'Pre-Slab Termiticide Treatment', amount: 950,
      warrantyExtendedSelected: false, detail: '1,850 sf | Termidor SC | Extended 5-yr warranty' };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 950 }, serviceMode: 'one_time', noGuaranteeClaims: true, estData: {},
      pricingBundle: { anchorOneTimePrice: 950, oneTimeBreakdown: { total: 950, items: [item] } },
    });
    expect(context.guarantees.serviceTerms[0].terms[0]).toMatch(/No extended warranty selected/);
  });

  test('matching legacy bond snapshots retain purchased coverage without a selector', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 18 },
      estData: { result: { recurring: { services: [{ name: 'Termite Bond (5-Year Term)', annual: 216, years: null }] } },
        engineResult: { lineItems: [{ service: 'termite_bond', bondTerm: '5yr', bondYears: 5, monthly: 18 }] } },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices.flatMap((row) => row.purchasedTerms || []))
      .toEqual(['Purchased termite bond: 5-year term with re-treatment coverage.']);
  });

  test('a frozen treatment price cannot override its explicit included-row removal', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 15 },
      pricingBundle: { frequencies: [{ key: 'quarterly', monthly: 15,
        included: [{ service: 'termite_bond_10yr', selectedBondTerm: 'none' }],
        perServiceTreatments: [{ service: 'termite_bond_10yr', bondTerm: '10yr', perTreatment: 45 }],
      }] },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices.flatMap((row) => row.purchasedTerms || [])).toEqual([]);
  });

  test.each(['none', null, '10yr'])('an engine-only mapped selector %j constrains its saved bond proof', (selectedBondTerm) => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 18 },
      estData: { engineResult: { results: { tmBait: { selectedBondTerm } },
        lineItems: [{ service: 'termite_bond', bondTerm: '5yr', bondYears: 5, monthly: 18 }] } },
      noGuaranteeClaims: true,
    });
    expect(context.recurringServices.flatMap((row) => row.purchasedTerms || [])).toEqual([]);
    expect(answerEstimateQuestionFallback('What warranty did I buy?', context))
      .not.toMatch(/Purchased termite bond|\d+-year term with re-treatment coverage/i);
  });

  test.each([null, '', '  '])('incomplete price %j may retain matching paid raw bond evidence', (monthly) => {
    const incomplete = { service: 'termite_bond_5yr', label: 'Termite Bond (5-Year Term)', bondTerm: '5yr', monthly };
    for (const frozenPricing of [false, true]) {
      const context = buildEstimateAssistantContext({
        estimate: { monthly_total: 18 },
        estData: { result: { recurring: { services: [incomplete] } },
          engineResult: { lineItems: [{ service: 'termite_bond', bondTerm: '5yr', bondYears: 5, monthly: 18 }] } },
        pricingBundle: frozenPricing ? { frequencies: [{ key: 'quarterly', monthly: 18,
          included: [incomplete], perServiceTreatments: [{ ...incomplete, perTreatment: 54 }] }] } : {},
        noGuaranteeClaims: true,
      });
      expect({ frozenPricing, terms: context.recurringServices.flatMap((row) => row.purchasedTerms || []) })
        .toEqual({ frozenPricing, terms: ['Purchased termite bond: 5-year term with re-treatment coverage.'] });
    }
  });

  test.each([
    { service: 'trenching', warrantyTier: 'none', warrantyAdder: 0 },
    { serviceKey: 'termite_trenching', warrantyTier: null, warrantyAdder: null },
    { key: 'trenching', warrantyTier: 'one_year_retreat', warrantyAdder: -1 },
  ])('current unproven warranty metadata clears a fully populated frozen purchase: %j', (liveWarranty) => {
    const row = { label: 'Termite Trenching', amount: 1200, price: 1200 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: { result: { oneTime: { items: [{ ...row, ...liveWarranty }] } } },
      pricingBundle: { anchorOneTimePrice: 1200, oneTimeBreakdown: { items: [{
        ...row, service: 'trenching', warrantyTier: 'three_year_repair_retreat', warrantyAdder: 117,
      }] } },
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items[0].purchasedTerms).toEqual([]);
    expect(answerEstimateQuestionFallback('What is included?', context)).not.toContain('Annual inspection during the warranty period');
  });

  test('current recurring fields fill omissions in a frozen projection while raw identities stay unioned', () => {
    const context = buildEstimateAssistantContext({
      estimate: { monthly_total: 61 },
      estData: {
        result: { recurring: { services: [{
          service: 'pest_control', name: 'Pest Control', mo: 61, frequencyLabel: 'Monthly visits',
          detail: 'Current measured scope', visitsPerYear: 12, perTreatment: 61,
        }] } },
        engineResult: { recurring: { services: [
          { service: 'pest_control', name: 'Pest Control', mo: 44, cadence: 'Historical quarterly',
            detail: 'Historical scope', visitsPerYear: 4, perApp: 132 },
          { service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 24 },
        ] } },
      },
      pricingBundle: { frequencies: [{ key: 'monthly', monthly: 61, annual: 732,
        included: [{ service: 'pest_control', label: 'Pest Control' }],
      }] },
    });

    expect(context.recurringServices).toHaveLength(1);
    expect(context.recurringServices[0]).toMatchObject({
      service: 'pest_control', monthly: 61, cadence: 'Monthly visits',
      detail: 'Current measured scope', visitsPerYear: 12, perApplication: 61,
    });
    expect(context.guarantees).toMatchObject({ recurringTermsEligible: false, recurring: null });
  });

  test.each([
    { warrantyTier: 'none', warrantyAdder: 0 },
    { warrantyTier: null, warrantyAdder: null },
    { warrantyTier: 'one_year_retreat', warrantyAdder: -1 },
  ])('current pricing removal still clears a saved purchase: %j', (decision) => {
    const row = { service: 'trenching', label: 'Termite Trenching', amount: 1200, price: 1200 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: { result: { oneTime: { items: [{ ...row, warrantyTier: 'three_year_repair_retreat', warrantyAdder: 117 }] } } },
      pricingBundle: { anchorOneTimePrice: 1200, oneTimeBreakdown: { items: [{ ...row, ...decision }] } },
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items[0].purchasedTerms).toEqual([]);
    expect(answerEstimateQuestionFallback('What warranty did I buy?', context))
      .not.toContain('Annual inspection during the warranty period');
  });

  test.each([false, true])('engine pricing honors actual replay versus sent snapshot provenance: snapshot=%s', (snapshotHit) => {
    const row = { service: 'trenching', label: 'Termite Trenching', amount: 1200, price: 1200 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: { result: { oneTime: { items: [{ ...row, warrantyTier: 'none', warrantyAdder: 0 }] } } },
      pricingBundle: { source: 'engine_invocation', snapshotHit, anchorOneTimePrice: 1200,
        oneTimeBreakdown: { items: [{ ...row, warrantyTier: 'three_year_repair_retreat', warrantyAdder: 117 }] } },
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items[0].purchasedTerms)
      .toEqual(snapshotHit ? [] : ['Annual inspection during the warranty period']);
  });

  test.each(['pricing', 'saved'])('%s raw details cannot leak guarantee claims into summaries or inclusion answers', (source) => {
    const items = [
      { service: 'one_time_mosquito', label: 'Mosquito Treatment', name: 'Mosquito Treatment', amount: 150, price: 150, detail: 'Rain re-spray guarantee' },
      { service: 'one_time_pest', label: 'One-Time Pest Control', name: 'One-Time Pest Control', amount: 90, price: 90, detail: 'Targeted treatment around entry points' },
    ];
    const input = {
      estimate: { monthly_total: 55, onetime_total: 240, show_one_time_option: true },
      estData: { result: {
        recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 55, detail: 'Unlimited free callbacks' }] },
        oneTime: { items: source === 'saved' ? items : [] },
      } },
      pricingBundle: {
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 55, annual: 660 }],
        oneTimeBreakdown: { items: source === 'pricing' ? items : [] },
        anchorOneTimePrice: 240,
      },
    };
    const context = buildEstimateAssistantContext({ ...input, noGuaranteeClaims: true });
    const rows = [...context.services, ...context.recurringServices, ...context.oneTime.items];
    expect(rows.map((row) => `${row.detail || ''} ${row.summary}`).join(' '))
      .not.toMatch(/Rain re-spray guarantee|Unlimited free callbacks/i);
    expect(context.oneTime.items.find((row) => row.service === 'one_time_pest').detail)
      .toContain('Targeted treatment around entry points');
    expect(context.oneTime.items.find((row) => row.service === 'one_time_mosquito').amount).toBe(150);
    const answer = answerEstimateQuestionFallback('What is included?', context);
    expect(answer).toContain('Mosquito Treatment');
    expect(answer).not.toMatch(/Rain re-spray guarantee|Unlimited free callbacks/i);

    const normalContext = buildEstimateAssistantContext(input);
    expect(normalContext.oneTime.items.find((row) => row.service === 'one_time_mosquito').detail)
      .toContain('Rain re-spray guarantee');
  });
});
