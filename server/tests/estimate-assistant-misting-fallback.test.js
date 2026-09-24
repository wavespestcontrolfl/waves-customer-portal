const {
  answerEstimateQuestionFallback,
  buildEstimateAssistantContext,
} = require('../services/estimate-assistant');

// Codex round-2 P1: mosquito_misting_system is lead-only and quote-required
// by design (no engine pricer) — the deterministic quote-required fallback
// (answerEstimateQuestion returns it before any model call) must never send
// the misting-system customer to "pick a time to book online" (it is NOT
// self-bookable — wiki/services/service-dispatch-rules.md) or state a price
// (pricing is owner-pending).
describe('Ask Waves fallback — mosquito misting SYSTEM quote-required questions', () => {
  const mistingContext = {
    billing: { quoteRequired: true, amountText: null },
    services: [{
      service: 'mosquito_misting_system',
      label: 'Mosquito Misting System Service',
      detail: 'Automatic mosquito misting system — install and monthly service plan.',
    }],
  };

  test('"What happens at the design visit?" gets the design-visit answer, never the booking-window reply', () => {
    const answer = answerEstimateQuestionFallback('What happens at the design visit?', mistingContext);
    expect(answer.toLowerCase()).toContain('design visit');
    expect(answer).not.toContain('Pick one of the available times');
    expect(answer).not.toMatch(/\$\d/);
  });

  test('a scheduling-phrased question ("when can someone come out?") also gets the design-visit answer, not online booking', () => {
    const answer = answerEstimateQuestionFallback('When can someone come out to look at my yard?', mistingContext);
    expect(answer.toLowerCase()).toContain('design visit');
    expect(answer).not.toContain('Pick one of the available times');
    expect(answer).not.toContain('book online');
  });

  test('a price question on the misting estimate states no price', () => {
    const answer = answerEstimateQuestionFallback('How much does this cost?', mistingContext);
    expect(answer).not.toMatch(/\$\d/);
  });

  test('the misting-system identity is recognized by catalog key alone, even with a generic label', () => {
    const context = {
      billing: { quoteRequired: true },
      services: [{ service: 'mosquito_misting_system', label: 'Mosquito Control' }],
    };
    const answer = answerEstimateQuestionFallback('What happens at the design visit?', context);
    expect(answer.toLowerCase()).toContain('design visit');
  });

  test('end to end through buildEstimateAssistantContext: a real one-time quote-required misting item reaches the design-visit answer', () => {
    const context = buildEstimateAssistantContext({
      pricingBundle: {
        oneTimeBreakdown: {
          items: [{
            service: 'mosquito_misting_system',
            label: 'Mosquito Misting System Service',
            quoteRequired: true,
            detail: 'Automatic mosquito misting system.',
          }],
        },
      },
      serviceMode: 'one_time',
    });
    expect(context.billing.quoteRequired).toBe(true);
    const answer = answerEstimateQuestionFallback('What happens at the design visit?', context);
    expect(answer.toLowerCase()).toContain('design visit');
    expect(answer).not.toContain('Pick one of the available times');
    expect(answer).not.toMatch(/\$\d/);
  });

  test('a non-misting quote-required estimate is unchanged: still gets the booking-window reply for a scheduling question', () => {
    const wdoContext = {
      billing: { quoteRequired: true, amountText: null },
      services: [{ service: 'wdo_inspection', label: 'WDO Inspection (Real Estate)', detail: 'Standalone inspection' }],
    };
    const answer = answerEstimateQuestionFallback('When can you come out?', wdoContext);
    expect(answer).toContain('Pick one of the available times');
  });

  test('a non-misting quote-required estimate keeps its existing price-question copy', () => {
    const wdoContext = {
      billing: { quoteRequired: true, amountText: null },
      services: [{ service: 'wdo_inspection', label: 'WDO Inspection (Real Estate)', detail: 'Standalone inspection' }],
    };
    const answer = answerEstimateQuestionFallback('How much does this cost?', wdoContext);
    expect(answer).toContain('needs an inspection before final pricing');
  });

  test('bare "mosquito" on a barrier (non-misting) quote-required estimate is unchanged', () => {
    const barrierContext = {
      billing: { quoteRequired: true, amountText: null },
      services: [{ service: 'mosquito_one_time', label: 'Mosquito Control', detail: 'One-time barrier spray' }],
    };
    const answer = answerEstimateQuestionFallback('When will the technician be out?', barrierContext);
    expect(answer).toContain('Pick one of the available times');
  });
});
