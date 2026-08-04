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

// Today's-result reconciliation leads with THIS visit's story (owner
// feedback 2026-08-03): the summary's first sentence is already vetted
// customer copy rendered verbatim in Visit Summary, so it can't introduce a
// new claim. Anything unusable keeps the neutral lead — never a truncated
// or thank-you-first hero line.
describe('reconciled todaysResult leads with the visit summary', () => {
  function reconcile(dataSummary) {
    const lawnAssessment = {
      scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, overallScore: 68 },
      aiSummary: 'We flagged the mid-lawn zone and a follow-up is planned to recheck it.',
      recommendations: { nextVisitFocus: 'Recheck the mid-lawn zone.' },
    };
    const reportV2 = buildLawnReportV2({ lawnAssessment });
    return reconcileLawnReport({ data: { lawnAssessment, summary: dataSummary }, reportV2 });
  }

  test('uses the summary first sentence as the lead', () => {
    const result = reconcile(
      'The front and back yards received a lawn application addressing large patch and fire ants. More prose follows.',
    );
    expect(result.todaysResult).toBe(
      'The front and back yards received a lawn application addressing large patch and fire ants. '
      + 'No urgent homeowner action is needed today.',
    );
  });

  test('empty summary keeps the neutral lead', () => {
    expect(reconcile('').todaysResult).toMatch(/^Routine service completed\./);
  });

  test('a thank-you greeting never opens the hero line', () => {
    const result = reconcile('Thanks for having us out today. We treated the full lawn for chinch bugs.');
    expect(result.todaysResult).toMatch(/^We treated the full lawn for chinch bugs\./);
  });

  test('abbreviation periods are not sentence boundaries ("The St." must never ship)', () => {
    const result = reconcile('The St. Augustine lawn received a preventive fungicide application. More prose follows.');
    expect(result.todaysResult).toMatch(
      /^The St\. Augustine lawn received a preventive fungicide application\. No urgent/,
    );
  });

  test('initialism periods are not sentence boundaries ("The U.S." must never ship)', () => {
    const result = reconcile('The U.S. EPA-registered product was applied to the full lawn. More prose follows.');
    expect(result.todaysResult).toMatch(
      /^The U\.S\. EPA-registered product was applied to the full lawn\. No urgent/,
    );
  });

  test('an over-long first sentence falls back instead of truncating with an ellipsis', () => {
    const longSentence = `The lawn received ${'a very detailed set of applications, '.repeat(8)}covering every zone.`;
    expect(reconcile(longSentence).todaysResult).toMatch(/^Routine service completed\./);
    expect(reconcile(longSentence).todaysResult).not.toContain('…');
  });
});
