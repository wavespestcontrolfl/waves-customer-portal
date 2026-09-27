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
    expect(context.guarantees.guidance).toMatch(/Do not describe the estimate as including/i);

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

  test.each([
    { warrantyTier: 'none', warrantyAdder: 0 },
    { warrantyTier: 'one_year_retreat' },
    { warrantyTier: 'one_year_retreat', warrantyAdder: -1 },
  ])('current unproven warranty metadata clears a saved purchased benefit: %j', (liveWarranty) => {
    const row = { service: 'trenching', label: 'Termite Trenching', amount: 1200, price: 1200 };
    const context = buildEstimateAssistantContext({
      estimate: { onetime_total: 1200 },
      estData: { result: { oneTime: { items: [{ ...row, warrantyTier: 'one_year_retreat', warrantyAdder: 0 }] } } },
      pricingBundle: { anchorOneTimePrice: 1200, oneTimeBreakdown: { items: [{ ...row, ...liveWarranty }] } },
      noGuaranteeClaims: true,
    });
    expect(context.oneTime.items[0].purchasedTerms).toEqual([]);
    expect(answerEstimateQuestionFallback('What is included?', context)).not.toContain('Annual inspection during the warranty period');
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
