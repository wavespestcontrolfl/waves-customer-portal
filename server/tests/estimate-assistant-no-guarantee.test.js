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

  test('ordinary recurring estimates retain the existing guarantee context', () => {
    const context = buildEstimateAssistantContext({
      estimate: { waveguard_tier: 'Bronze', monthly_total: 55 },
      pricingBundle: {
        waveGuardTier: 'Bronze',
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 55, annual: 660 }],
      },
    });

    expect(context.guarantees.noGuaranteeClaims).toBe(false);
    expect(context.guarantees.recurring).toMatch(/Money-back guarantee/);
    expect(answerEstimateQuestionFallback('What is the guarantee?', context))
      .toMatch(/includes the money-back guarantee/i);
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
