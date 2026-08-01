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

  test('catches the shipped audit phrase via the disease-treatment synonym', () => {
    const { parsed, dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [
        { priority: 1, action: 'Inspect the blotchy areas at the next service.', reason: 'Field observations do not currently support active disease treatment; no drought or insect decline was observed.', timeframe: 'Next visit' },
      ],
    }, APPLIED);
    expect(dropped).toBe(1);
    expect(parsed.recommendations).toHaveLength(0);
  });

  test('catches "confirm no fungicide is needed" phrasings (r7)', () => {
    const { parsed } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [],
      nextVisitFocus: 'Confirm no fungicide is needed.',
    }, APPLIED);
    expect(parsed.nextVisitFocus).toMatch(/Recheck the areas treated today/);
  });

  test('catches "no herbicide required" phrasings (r7)', () => {
    const { parsed, dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [
        { priority: 1, action: 'Note that no weed treatment is required at this time.', reason: 'Weed suppression is strong.', timeframe: 'n/a' },
      ],
    }, APPLIED);
    expect(dropped).toBe(1);
    expect(parsed.recommendations).toHaveLength(0);
  });

  test('passive deferrals are caught (r10)', () => {
    const { parsed, dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [
        { priority: 1, action: 'A fungicide application should be deferred until disease is confirmed.', reason: 'Scores are healthy.', timeframe: 'Next visit' },
      ],
    }, APPLIED);
    expect(dropped).toBe(1);
    expect(parsed.recommendations).toHaveLength(0);
  });

  test('past-tense and contracted negations are caught (r11)', () => {
    const cases = [
      'A fungicide application was deferred until disease is confirmed.',
      'A fungicide isn’t necessary at this time.',
    ];
    for (const bad of cases) {
      const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
        recommendations: [{ priority: 1, action: bad, reason: 'x', timeframe: 'y' }],
      }, APPLIED);
      expect(dropped).toBe(1);
    }
  });

  test('active wait-to-apply deferrals are caught (r13)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Wait to apply fungicide until disease is confirmed.', reason: 'x', timeframe: 'y' }],
    }, APPLIED);
    expect(dropped).toBe(1);
  });

  test('fertilizer deferrals are caught (r19)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Hold off on fertilizer until the lawn recovers.', reason: 'x', timeframe: 'y' }],
    }, APPLIED);
    expect(dropped).toBe(1);
  });

  test('modal negations are caught (r19)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Fungicide should not be applied until disease is confirmed.', reason: 'x', timeframe: 'y' }],
    }, APPLIED);
    expect(dropped).toBe(1);
  });

  test('biostimulant and wetting-agent deferrals are caught (r20)', () => {
    const soilProducts = [
      { product_name: 'CarbonPro-L', product_category: 'biostimulant' },
      { product_name: 'Hydretain', product_category: 'wetting agent' },
    ];
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [
        { priority: 1, action: 'Hold off on biostimulants until soil temps drop.', reason: 'x', timeframe: 'y' },
        { priority: 2, action: 'A wetting agent is not needed at this time.', reason: 'x', timeframe: 'y' },
      ],
    }, soilProducts);
    expect(dropped).toBe(2);
  });

  test('pre-emergent wording matches the herbicide class (r22 — Prodiamine rows persist herbicide)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Hold off on pre-emergent until fall.', reason: 'x', timeframe: 'y' }],
    }, [{ product_name: 'Prodiamine 65 WDG', product_category: 'herbicide' }]);
    expect(dropped).toBe(1);
  });

  test('compact aftercare forms pass (r22 — avoid/no must bind to the treatment)', () => {
    const { dropped, parsed } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [
        { priority: 1, action: 'Avoid watering after herbicide application.', reason: 'Foliar uptake.', timeframe: 'Today' },
        { priority: 2, action: 'Do not water after the herbicide application for one hour.', reason: 'Foliar uptake.', timeframe: 'Today' },
      ],
    }, APPLIED);
    expect(dropped).toBe(0);
    expect(parsed.recommendations).toHaveLength(2);
  });

  test('legitimate aftercare mentioning the class passes (defer must govern the treatment)', () => {
    const { parsed, dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [
        { priority: 1, action: 'Wait until today’s fungicide application has dried before mowing.', reason: 'Label re-entry guidance.', timeframe: 'Today' },
        { priority: 2, action: 'Avoid watering for a few hours after the herbicide application.', reason: 'Foliar products need dry leaves to absorb.', timeframe: 'Today' },
      ],
    }, APPLIED);
    expect(dropped).toBe(0);
    expect(parsed.recommendations).toHaveLength(2);
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
