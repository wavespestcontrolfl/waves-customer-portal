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
    ['bundle', ['pest_control', 'lawn_care']],
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

  test('one-time rodent work cannot inherit pest callback terms', () => {
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 200 },
      pricingBundle: { anchorOneTimePrice: 200, oneTimeBreakdown: { items: [{ service: 'rodent_trapping', label: 'Rodent Trapping', amount: 200 }] } },
      serviceMode: 'one_time',
    });
    expect(context.guarantees).toMatchObject({ recurringTermsEligible: false, recurring: null, oneTime: null });
    expect(answerEstimateQuestionFallback('What is the guarantee?', context)).not.toMatch(/30-day callback|includes the money-back guarantee/i);
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
    const row = { service: 'trenching', label: 'Termite Trenching', amount: 1200, price: 1200,
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
    expect(answer).toContain('Purchased termite bond: 10-year term with re-treatment coverage.');
    expect(answer).toContain('applies only to that service');
    expect(answerEstimateQuestionFallback('Does my termite bond include free callbacks?', context))
      .toMatch(/do not see an estimate-wide callback/i);
    for (const question of ['What bond did I buy?', 'What warranty did I buy?']) {
      expect(answerEstimateQuestionFallback(question, context))
        .toContain('Purchased termite bond: 10-year term with re-treatment coverage.');
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

  test('mixed purchased warranty answers stay scoped to the named service', () => {
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

    const trenchingAnswer = answerEstimateQuestionFallback('What warranty does the trenching include?', context);
    expect(trenchingAnswer).toContain('For Termite Trenching');
    expect(trenchingAnswer).toContain('Annual inspection during the warranty period');
    expect(trenchingAnswer).not.toMatch(/5-year|re-treatment/i);

    const bondAnswer = answerEstimateQuestionFallback('What warranty does the bond include?', context);
    expect(bondAnswer).toContain('For Termite Bond');
    expect(bondAnswer).toContain('5-year term with re-treatment coverage');
    expect(bondAnswer).not.toContain('Annual inspection during the warranty period');

    const bondInspectionAnswer = answerEstimateQuestionFallback(
      'Is annual inspection included with my termite bond?', context,
    );
    expect(bondInspectionAnswer).toContain('For Termite Bond');
    expect(bondInspectionAnswer).toContain('5-year term with re-treatment coverage');
    expect(bondInspectionAnswer).not.toContain('Annual inspection during the warranty period');

    const genericAnswer = answerEstimateQuestionFallback('What warranty did I buy?', context);
    expect(genericAnswer).toMatch(/Termite Bond:.*5-year term/s);
    expect(genericAnswer).toMatch(/Termite Trenching:.*Annual inspection/s);
    expect(genericAnswer).toContain('Each term applies only to the named service');
  });

  test('a named service without purchased terms cannot inherit another service warranty', () => {
    const bond = { service: 'termite_bond', name: 'Termite Bond (5-Year Term)', annual: 216 };
    const bondOnly = buildEstimateAssistantContext({
      estimate: { monthly_total: 18 },
      estData: { result: { recurring: { services: [bond] } } },
      noGuaranteeClaims: true,
    });
    const missingTrenching = answerEstimateQuestionFallback('What warranty does the trenching include?', bondOnly);
    expect(missingTrenching).not.toMatch(/5-year|re-treatment coverage/i);

    const mixed = buildEstimateAssistantContext({
      estimate: { monthly_total: 38 },
      estData: { result: { recurring: { services: [
        bond,
        { service: 'rodent_bait', name: 'Rodent Bait Stations', monthly: 20 },
      ] } } },
      noGuaranteeClaims: true,
    });
    const rodent = answerEstimateQuestionFallback('What warranty does the rodent service include?', mixed);
    expect(rodent).not.toMatch(/5-year|re-treatment coverage/i);
    expect(answerEstimateQuestionFallback('What warranty did I buy?', mixed))
      .toContain('5-year term with re-treatment coverage');
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
