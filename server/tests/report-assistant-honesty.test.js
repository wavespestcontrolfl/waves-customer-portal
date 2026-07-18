// Honesty guards for the deterministic report assistant + consistency layer
// (2026-07-16 audit): the assistant must never invent a pressure reading,
// never phrase re-entry as a minute count (owner site-compliance rule), and
// the consistency layer must never fabricate a "Follow-up already planned"
// card from routine sign-off prose.

const { answerServiceReportQuestion } = require('../services/service-report/report-assistant');
const { reconcileLawnReport } = require('../services/service-report/report-consistency');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');

describe('assistant never invents a pressure reading', () => {
  test('trend question on a report with no pressure data says so instead of "0.3"', () => {
    const answer = answerServiceReportQuestion({
      question: 'How is my pest trend?',
      data: { pressureIndex: null, dynamicContext: {} },
    });
    expect(answer).toContain('was not recorded');
    expect(answer).not.toContain('0.3');
  });

  test('a real reading still answers with the visible index', () => {
    const answer = answerServiceReportQuestion({
      question: 'How is my pest trend?',
      data: { pressureIndex: 1.8, dynamicContext: {} },
    });
    expect(answer).toContain('1.8 on a 0-5 scale');
  });
});

describe('assistant re-entry fallback never states minutes', () => {
  test('advisory minutes phrase as "fully dry", not a minute count', () => {
    const answer = answerServiceReportQuestion({
      question: 'When can I re-enter treated areas?',
      data: {
        dynamicContext: {},
        advisory: { exterior_reentry_min: 240, interior_reentry_min: 30, pet_advisory: 'Keep pets off treated areas until dry.' },
      },
    });
    expect(answer).not.toMatch(/\d+\s*min/i);
    expect(answer).toContain('fully dry');
    expect(answer).toContain('Keep pets off treated areas until dry.');
  });

  test('the reworded suggested question still routes to the re-entry answer', () => {
    const answer = answerServiceReportQuestion({
      question: 'When can I re-enter treated areas?',
      data: { dynamicContext: { reentry: { customerSummary: 'Treated areas are ready for normal use.' } } },
    });
    expect(answer).toBe('Treated areas are ready for normal use.');
  });
});

describe('consistency layer never fabricates a planned follow-up from sign-off prose', () => {
  function reconcile(summaryText, { nextVisitFocus = null } = {}) {
    const lawnAssessment = {
      scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, overallScore: 68 },
      aiSummary: summaryText,
      recommendations: nextVisitFocus ? { nextVisitFocus } : {},
    };
    const reportV2 = buildLawnReportV2({ lawnAssessment });
    return reconcileLawnReport({ data: { lawnAssessment, summary: '' }, reportV2 });
  }

  test('routine sign-off "see you at your next visit" fabricates nothing', () => {
    const result = reconcile('Great visit today. We will see you at your next visit.');
    expect(result?.followUp || null).toBeNull();
  });

  test('watering advice "return to normal watering" fabricates nothing', () => {
    const result = reconcile('You can return to normal watering tomorrow.');
    expect(result?.followUp || null).toBeNull();
  });

  test('an explicit commitment still surfaces the follow-up card', () => {
    const result = reconcile('We flagged the mid-lawn zone and a follow-up is planned to recheck it.');
    expect(result?.followUp).toMatchObject({ scheduled: true, headline: 'Follow-up already planned' });
  });

  test('a real nextVisitFocus still counts regardless of prose', () => {
    const result = reconcile('Routine service completed.', { nextVisitFocus: 'Recheck the mid-lawn irrigation coverage.' });
    expect(result?.followUp).toMatchObject({ scheduled: true });
    expect(result.followUp.reason).toContain('Recheck the mid-lawn');
  });
});
