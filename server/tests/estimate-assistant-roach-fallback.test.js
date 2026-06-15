const { answerEstimateQuestionFallback } = require('../services/estimate-assistant');

describe('Ask Waves fallback — German roach questions', () => {
  const context = {
    serviceMode: 'one_time',
    services: [
      { label: 'German Roach Cleanout', detail: '3 visit program', summary: 'German Roach Cleanout — 3 visit program' },
    ],
  };

  test('"How long until the roaches are gone?" gets the multi-visit roach answer, not a scheduling reply', () => {
    const answer = answerEstimateQuestionFallback('How long until the roaches are gone?', context);
    expect(answer.toLowerCase()).toContain('roach');
    expect(answer.toLowerCase()).toContain('multi-visit');
    expect(answer.toLowerCase()).toContain('breeding cycle');
    // Must not fall through to the generic scheduling answer.
    expect(answer).not.toContain('Pick one of the available times');
    // Nor the catch-all.
    expect(answer).not.toContain('I can answer questions about this estimate');
  });

  test('"How do you get rid of German roaches?" gets the roach treatment answer', () => {
    const answer = answerEstimateQuestionFallback('How do you get rid of German roaches?', context);
    expect(answer.toLowerCase()).toContain('roach');
    expect(answer.toLowerCase()).toContain('breeding cycle');
  });

  test('a non-German cockroach estimate does NOT get German-roach multi-visit copy', () => {
    const nativeRoachContext = {
      serviceMode: 'one_time',
      services: [
        { label: 'Native Cockroach Treatment', detail: 'one-time', summary: 'Native Cockroach Treatment — one-time' },
      ],
    };
    const answer = answerEstimateQuestionFallback('How do you treat cockroaches?', nativeRoachContext);
    expect(answer.toLowerCase()).toContain('cockroach');
    // The German-roach-specific multi-visit / breeding-cycle copy must not leak
    // onto a native cockroach or general pest estimate.
    expect(answer.toLowerCase()).not.toContain('german roach');
    expect(answer.toLowerCase()).not.toContain('breeding cycle');
    expect(answer.toLowerCase()).not.toContain('number of visits');
  });
});
