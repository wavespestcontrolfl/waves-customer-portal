/**
 * Persist-time treatment-contradiction guard (codex P1 #3093 r5): model
 * recommendations that advise against/defer a product class applied on the
 * visit are stripped before they reach lawn_assessments.
 */

const { _test } = require('../services/knowledge-bridge');

const APPLIED = [
  { product_name: 'Artavia 2 SC (Azoxy)', product_category: 'Fungicide' },
  { product_name: 'Celsius WG', product_category: 'herbicide' },
  { product_name: 'LESCO K-Flow', product_category: 'Fertilizer' },
];

describe('sanitizeRecommendationsAgainstTreatment', () => {
  test('drops a recommendation deferring a fungicide applied today', () => {
    const { parsed, dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      summary: 'Lawn is healthy overall.',
      recommendations: [
        { priority: 1, action: 'Monitor the blotchy areas before making a fungicide application.', reason: 'Scores do not support disease treatment.', timeframe: 'Next visit' },
        { priority: 2, action: 'Keep mowing at 4 inches.', reason: 'Supports density.', timeframe: 'Weekly' },
      ],
      nextVisitFocus: 'Confirm no fungicide is needed.',
      customerTip: 'Water in the morning.',
    }, APPLIED);
    expect(dropped).toBeGreaterThanOrEqual(1);
    expect(parsed.recommendations).toHaveLength(1);
    expect(parsed.recommendations[0].action).toContain('mowing');
  });

  test('replaces a contradicting nextVisitFocus with neutral monitoring copy', () => {
    const { parsed } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [],
      nextVisitFocus: 'Hold off on any herbicide until weeds are verified.',
    }, APPLIED);
    expect(parsed.nextVisitFocus).toMatch(/Recheck the areas treated today/);
  });

  test('strips a contradicting summary so the stored ai_summary stands', () => {
    const { parsed } = _test.sanitizeRecommendationsAgainstTreatment({
      summary: 'Do not apply fungicide at this time.',
      recommendations: [],
    }, APPLIED);
    expect(parsed.summary).toBeUndefined();
  });

  test('leaves everything untouched when no corrective class was applied', () => {
    const input = {
      summary: 'Consider a fungicide application before disease spreads.',
      recommendations: [{ priority: 1, action: 'Hold off on fungicide until confirmed.', reason: 'x', timeframe: 'y' }],
    };
    const { parsed, dropped } = _test.sanitizeRecommendationsAgainstTreatment(
      JSON.parse(JSON.stringify(input)),
      [{ product_name: 'LESCO K-Flow', product_category: 'Fertilizer' }],
    );
    expect(dropped).toBe(0);
    expect(parsed.recommendations).toHaveLength(1);
  });

  test('supportive mentions of the applied class pass through', () => {
    const { parsed, dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [
        { priority: 1, action: 'Watch how the lawn responds to today’s fungicide over the next two weeks.', reason: 'Azoxystrobin needs time to work.', timeframe: '2 weeks' },
      ],
    }, APPLIED);
    expect(dropped).toBe(0);
    expect(parsed.recommendations).toHaveLength(1);
  });
});
