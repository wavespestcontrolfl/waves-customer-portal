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

  // Codex round-3 P1: the misting branch above intercepted EVERY question on
  // a misting estimate with the design-visit/pricing copy — a weather or
  // safety question got that same copy instead of its own answer. Each
  // intent below is sourced from wiki/protocols/mosquito-misting-systems.md.
  describe('Codex round-4: no "-safe" claims, re-entry wording, mixed-estimate scoping', () => {
    test('safety answer never uses "*-safe" terminology', () => {
      const answer = answerEstimateQuestionFallback('Is it safe for my bees and koi?', mistingContext);
      expect(answer).not.toMatch(/\b\w+-safe\b/i);
      expect(answer.toLowerCase()).toContain('specific product label decides');
    });
    test.each(['Can we go outside after it sprays?', 'Is the spray bad to breathe on the lanai?'])('%s gets the safety answer', (question) => {
      const answer = answerEstimateQuestionFallback(question, mistingContext);
      expect(answer.toLowerCase()).toContain('nozzles are placed under 10 ft');
    });
    const mixedContext = {
      billing: { quoteRequired: true, amountText: null },
      services: [
        { service: 'mosquito_misting_system', label: 'Mosquito Misting System Service' },
        { service: 'pest_general_quarterly', label: 'Quarterly Pest Control Service' },
      ],
    };
    test('mixed estimate: a question about the other service is not answered with misting copy', () => {
      const answer = answerEstimateQuestionFallback('What does the pest control plan include?', mixedContext);
      expect(answer.toLowerCase()).not.toContain('design visit');
      expect(answer.toLowerCase()).not.toContain('nozzles');
    });
    test('mixed estimate: a misting question still gets misting copy', () => {
      const answer = answerEstimateQuestionFallback('How often do you clean the misting nozzles?', mixedContext);
      expect(answer.toLowerCase()).toContain('quarterly nozzle cleaning');
    });
  });

  describe('Codex round-5: re-entry, bare misting, visit weather', () => {
    test('re-entry question states the dry/label re-entry condition', () => {
      const answer = answerEstimateQuestionFallback('Can we go outside after it sprays?', mistingContext);
      expect(answer.toLowerCase()).toContain('until the mist has settled and treated surfaces are dry');
    });
    test('mixed misting + barrier estimate: bare "misting" question stays off the system copy', () => {
      const mixed = { billing: { quoteRequired: true, amountText: null }, services: [
        { service: 'mosquito_misting_system', label: 'Mosquito Misting System Service' },
        { service: 'mosquito_monthly', label: 'Monthly Mosquito Control Service' },
      ] };
      const answer = answerEstimateQuestionFallback('How does the 21-day misting cycle work?', mixed);
      expect(answer.toLowerCase()).not.toContain('design visit');
    });
    test('weather question about the design visit gets the reschedule answer, not cycle pausing', () => {
      const answer = answerEstimateQuestionFallback('Will you still come for the design visit if it rains?', mistingContext);
      expect(answer.toLowerCase()).toContain('reschedule');
      expect(answer.toLowerCase()).not.toContain('optional weather sensor');
    });
  });

  describe('Codex round-6: recurring-mode mixed quote keeps the misting row; "come on" is not a visit', () => {
    test('recurring serviceMode + priced recurring + quote-required misting one-time: misting question still gets misting copy, no amounts leak', () => {
      const context = buildEstimateAssistantContext({
        pricingBundle: {
          quoteRequired: true,
          oneTimeBreakdown: { items: [{ service: 'mosquito_misting_system', label: 'Mosquito Misting System Service', quoteRequired: true, amount: 4000 }] },
        },
        serviceMode: 'recurring',
      });
      expect(context.oneTime).toBeNull();
      expect(context.quoteOnlyItems).toEqual([{ service: 'mosquito_misting_system', label: 'Mosquito Misting System Service' }]);
      expect(JSON.stringify(context.quoteOnlyItems)).not.toMatch(/4000|\$/);
      const answer = answerEstimateQuestionFallback('How often do you clean the misting system nozzles?', context);
      expect(answer.toLowerCase()).toContain('quarterly nozzle cleaning');
    });
    test('"Will it come on if it rains?" is about the system, not the visit', () => {
      const answer = answerEstimateQuestionFallback('Will it come on if it rains?', mistingContext);
      expect(answer.toLowerCase()).toContain('should be paused for rain');
      expect(answer.toLowerCase()).not.toContain('reschedule');
    });
    test('"Will your tech still come if it rains?" is about the visit', () => {
      const answer = answerEstimateQuestionFallback('Will your tech still come if it rains?', mistingContext);
      expect(answer.toLowerCase()).toContain('reschedule');
    });
  });

  describe('intent order: price first, booking last (topic questions containing "when" stay on topic)', () => {
    test.each([
      ['When should I pause it before a storm?', 'should be paused for rain'],
      ['Is it safe to be outside when it sprays?', 'nozzles are placed under 10 ft'],
      ['When do you refill it?', 'monthly check and solution refill'],
      ['How much does a system cost?', 'designed and priced at a free on-site design visit'],
      ['Can I schedule the design visit?', 'designed and priced at a free on-site design visit'],
    ])('%s', (question, expected) => {
      const answer = answerEstimateQuestionFallback(question, mistingContext);
      expect(answer.toLowerCase()).toContain(expected);
      expect(answer).not.toContain('Pick one of the available times');
    });
  });

  describe('intent-routed answers (Codex round-3 P1)', () => {
    test('weather questions get the pause-conditions answer, not design-visit/pricing copy', () => {
      const answer = answerEstimateQuestionFallback('Do you pause it in high wind?', mistingContext);
      expect(answer.toLowerCase()).toContain('wind over 10 mph');
      expect(answer.toLowerCase()).toContain('50°f'.toLowerCase());
      expect(answer.toLowerCase()).not.toContain('design visit');
      expect(answer).not.toContain('Pick one of the available times');
    });

    test('a hurricane/storm question gets the storm-pause answer', () => {
      const answer = answerEstimateQuestionFallback('What happens to the system before a hurricane?', mistingContext);
      expect(answer.toLowerCase()).toContain('named storm');
      expect(answer.toLowerCase()).toContain('post-storm inspection');
    });

    test('a rain question gets the weather answer', () => {
      const answer = answerEstimateQuestionFallback('Will it still run if it rains?', mistingContext);
      expect(answer.toLowerCase()).toContain('should be paused for rain');
      expect(answer.toLowerCase()).toContain('optional weather sensor');
    });

    test('a pet-safety question ("what if my dog gets misted?") gets the placement/safety answer, not design-visit copy', () => {
      const answer = answerEstimateQuestionFallback('What if my dog gets misted?', mistingContext);
      expect(answer.toLowerCase()).toContain('pause the system and call the office');
      expect(answer.toLowerCase()).toContain('dawn and dusk');
      expect(answer.toLowerCase()).not.toContain('design visit');
    });

    test('a kids/pool/pollinator safety question gets the placement/safety answer', () => {
      const answer = answerEstimateQuestionFallback('Is this safe for my kids and the pool?', mistingContext);
      expect(answer.toLowerCase()).toContain('under 10 ft');
      expect(answer.toLowerCase()).toContain('pools');
    });

    test('the safety answer never claims disease prevention', () => {
      const answer = answerEstimateQuestionFallback('Are bees safe around this?', mistingContext);
      expect(answer.toLowerCase()).toContain('does not prevent disease');
    });

    test('a maintenance/refill question gets the service-plan answer', () => {
      const answer = answerEstimateQuestionFallback('How often do you refill the tank?', mistingContext);
      expect(answer.toLowerCase()).toContain('monthly check');
      expect(answer.toLowerCase()).toContain('quarterly nozzle cleaning');
      expect(answer.toLowerCase()).not.toContain('design visit');
    });

    test('a clogged-nozzle question gets the maintenance answer', () => {
      const answer = answerEstimateQuestionFallback('One of the nozzles seems clogged, what do I do?', mistingContext);
      expect(answer.toLowerCase()).toContain('licensed techs handle or refill');
    });

    test('an unrelated/generic question gets the short generic misting answer, never barrier or booking-window copy', () => {
      const answer = answerEstimateQuestionFallback('Does it come with a warranty?', mistingContext);
      expect(answer.toLowerCase()).toContain('free on-site design visit');
      expect(answer).not.toContain('Pick one of the available times');
      expect(answer).not.toMatch(/\$\d/);
    });
  });
});
