// Report Waves AI topics (owner ruling 2026-09-28: record the topic, never
// the question text). routeServiceReportQuestion returns the answer AND the
// answer family it came from; answerServiceReportQuestion stays the plain
// string API every other caller and test uses.
const {
  REPORT_QUESTION_TOPICS,
  routeServiceReportQuestion,
  answerServiceReportQuestion,
} = require('../services/service-report/report-assistant');

const pestData = { serviceLine: 'pest' };
const lawnWithPlan = {
  serviceLine: 'lawn',
  reportV2: { water: { weekPlan: { title: 'Water twice this week.', detail: 'About half an inch each time.' } } },
};
const withSummary = {
  serviceLine: 'pest',
  dynamicContext: { aiSummary: { headline: 'Your visit is complete.', body: 'Everything went as planned.' } },
};

describe('routeServiceReportQuestion topics', () => {
  test.each([
    ['Is it safe for my dog to go outside?', pestData, 'reentry'],
    ['How often should I water?', lawnWithPlan, 'watering'],
    ['When can I turn on my irrigation?', lawnWithPlan, 'watering'],
    // No plan to quote: the irrigation fallback answers with the re-entry
    // copy, so the recorded topic is reentry, never watering.
    ['When can I turn on my irrigation?', { serviceLine: 'lawn' }, 'reentry'],
    ['What did you find?', pestData, 'findings'],
    ['What should I do next?', pestData, 'next_steps'],
    ['When is my next appointment?', pestData, 'next_visit'],
    ['What was applied today?', pestData, 'applied'],
    ['Is the treatment working?', pestData, 'results'],
    ['zzz', withSummary, 'summary'],
    ['zzz', pestData, 'unrouted'],
  ])('%j routes to %s', (question, data, topic) => {
    const routed = routeServiceReportQuestion({ question, data });
    expect(routed.topic).toBe(topic);
    expect(REPORT_QUESTION_TOPICS).toContain(routed.topic);
    // The string API is exactly the routed answer.
    expect(answerServiceReportQuestion({ question, data })).toBe(routed.answer);
  });

  test('every rule-matched question gets a topic from the closed list', () => {
    const questions = [
      'what products did you use', 'where was the activity', 'should I schedule my next appointment',
      'how is my lawn score trending', 'what do you recommend after spraying', 'when will you be back',
      'what did you notice while treating', 'can the kids play in the yard',
    ];
    for (const question of questions) {
      expect(REPORT_QUESTION_TOPICS).toContain(routeServiceReportQuestion({ question, data: lawnWithPlan }).topic);
    }
  });
});
