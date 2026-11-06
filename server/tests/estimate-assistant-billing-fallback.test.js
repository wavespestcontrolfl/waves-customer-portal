const { answerEstimateQuestionFallback } = require('../services/estimate-assistant');

// 2026-11-05 new-customer walk: with both AI models down, "When am I charged?"
// got the scheduling answer because the billing pattern matched "charge" but
// not "charged". Plain inflections of the billing words now reach the billing
// answer too.
describe('Ask Waves fallback — billing words and their plain forms', () => {
  const context = {
    serviceMode: 'recurring',
    tier: 'Silver',
    billing: { quoteRequired: true },
    services: [{ label: 'Pest Control', detail: 'quarterly', summary: 'Pest Control — quarterly' }],
  };
  const BILLING_ANSWER = /needs an inspection before final pricing/;

  test.each([
    'When am I charged?',
    'Will I be charged today?',
    'What are the charges?',
    'When do I get billed?',
    'How are bills sent?',
    'How do I pay?',
    'Have I paid anything yet?',
    'Is there a payment due?',
    'What are the prices?',
    'Are there any fees or discounts?',
    'What are the costs?',
  ])('"%s" gets the billing answer', (question) => {
    expect(answerEstimateQuestionFallback(question, context)).toMatch(BILLING_ANSWER);
  });

  test('the words that already matched still do', () => {
    for (const q of ['What does it cost?', 'Is there a setup fee?', 'How is billing handled?', 'Is there a charge?']) {
      expect(answerEstimateQuestionFallback(q, context)).toMatch(BILLING_ANSWER);
    }
  });

  test('a scheduling question that has no billing word still gets the scheduling answer', () => {
    const answer = answerEstimateQuestionFallback('What day will the technician come?', context);
    expect(answer).not.toMatch(BILLING_ANSWER);
  });
});
