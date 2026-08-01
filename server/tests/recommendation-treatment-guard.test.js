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

  test('PGR deferrals are caught (r23)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Hold off on the plant growth regulator until growth slows.', reason: 'x', timeframe: 'y' }],
    }, [{ product_name: 'Primo Maxx', product_category: 'pgr' }]);
    expect(dropped).toBe(1);
  });

  test('name-phrased deferrals are caught (r26)', () => {
    const cases = [
      'Hold off on Celsius WG until temperatures drop.',
      'Do not apply more Artavia this month.',
      'Skip the Azoxy next visit.',
    ];
    for (const badText of cases) {
      const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
        recommendations: [{ priority: 1, action: badText, reason: 'x', timeframe: 'y' }],
      }, APPLIED.concat([{ product_name: 'Artavia 2 SC (Azoxy)', product_category: 'Fungicide' }]));
      expect(dropped).toBe(1);
    }
  });

  test('unresolved-category rows are guarded via generic treatment terms (r26)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Hold off on today’s treatment until the lawn recovers.', reason: 'x', timeframe: 'y' }],
    }, [{ product_name: 'Mystery Blend', product_category: null }]);
    expect(dropped).toBe(1);
  });

  test('generic deferrals are caught for any applied product (r27)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'No additional treatment is warranted at this time.', reason: 'x', timeframe: 'y' }],
    }, APPLIED);
    expect(dropped).toBe(1);
  });

  test('unrecognized category strings use the all-classes fallback (r31)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Hold off on fungicide until spring.', reason: 'x', timeframe: 'y' }],
    }, [{ product_name: 'Generic Blend 5', product_category: 'Uncategorized' }]);
    expect(dropped).toBe(1);
  });

  test('unrelated negations after a class mention survive (r31)', () => {
    const { dropped, parsed } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [
        { priority: 1, action: 'Fungicide was applied today, so extra irrigation is not needed.', reason: 'Label guidance.', timeframe: 'Today' },
      ],
    }, APPLIED);
    expect(dropped).toBe(0);
    expect(parsed.recommendations).toHaveLength(1);
  });

  test('catalog acronyms are guarded (r32)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Hold off on MSM until the turf recovers.', reason: 'x', timeframe: 'y' }],
    }, [{ product_name: 'QP MSM 60DF Turf Herbicide', product_category: 'herbicide' }]);
    expect(dropped).toBe(1);
  });

  test('non-object JSON payloads never count as grounded (r32)', () => {
    for (const bad of ['just a string', [1, 2, 3], 42]) {
      const { parsed, dropped } = _test.sanitizeRecommendationsAgainstTreatment(bad, APPLIED);
      expect(dropped).toBe(0);
      expect(parsed).toBe(bad);
    }
  });

  test('marketed tokens in manufacturer-prefixed names are guarded (r35)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Hold off on Stonewall until fall.', reason: 'x', timeframe: 'y' }],
    }, [{ product_name: 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', product_category: 'herbicide' }]);
    expect(dropped).toBe(1);
  });

  test('generic catalog words do not become product identities (r35)', () => {
    const { dropped } = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Hold off on liquid feeding until the lawn greens up.', reason: 'x', timeframe: 'y' }],
    }, [{ product_name: 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide', product_category: 'herbicide' }]);
    expect(dropped).toBe(0);
  });

  test('malformed nested payload shapes never count as grounded (r37)', () => {
    const v = _test.recommendationPayloadShapeValid;
    expect(v({ summary: 'ok', recommendations: [{ action: 'a', reason: 'b', timeframe: 'c', priority: 1 }], customerTip: 't' })).toBe(true);
    expect(v({})).toBe(true);
    expect(v({ summary: { nested: true } })).toBe(false);
    expect(v({ customerTip: ['arr'] })).toBe(false);
    expect(v({ recommendations: ['just a string'] })).toBe(false);
    expect(v({ recommendations: [{ action: { deep: 1 } }] })).toBe(false);
    expect(v({ recommendations: 'not-an-array' })).toBe(false);
  });

  test('aliases are word-bounded — "Avoid driveway runoff" survives Drive XLR8 (r41)', () => {
    const applied = [{ product_name: 'Drive XLR8 Post Emergent Liquid Herbicide', product_category: 'herbicide' }];
    const ok = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Avoid driveway runoff when watering in.', reason: 'x', timeframe: 'y' }],
    }, applied);
    expect(ok.dropped).toBe(0);
    const bad = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Avoid Drive until the turf recovers.', reason: 'x', timeframe: 'y' }],
    }, applied);
    expect(bad.dropped).toBe(1);
  });

  test('generic modifiers never become aliases — "Avoid high-nitrogen fertilizer" survives (r42)', () => {
    const applied = [{ product_name: 'LESCO High Manganese Combo Micronutrient', product_category: 'micronutrient' }];
    const ok = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Avoid high-nitrogen fertilizer until the next visit.', reason: 'x', timeframe: 'y' }],
    }, applied);
    expect(ok.dropped).toBe(0);
    const bad = _test.sanitizeRecommendationsAgainstTreatment({
      recommendations: [{ priority: 1, action: 'Avoid Manganese until the next visit.', reason: 'x', timeframe: 'y' }],
    }, applied);
    expect(bad.dropped).toBe(1);
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

describe('generation fence registry (r28/r29)', () => {
  const { _test } = require('../services/knowledge-bridge');
  const future = () => new Date(Date.now() + 60000).toISOString();
  const past = () => new Date(Date.now() - 60000).toISOString();

  test('any live run keeps the fence up; expired entries are ignored', () => {
    expect(_test.generationInFlight({ _generationRuns: { a: future() } })).toBe(true);
    expect(_test.generationInFlight({ _generationRuns: { a: past() } })).toBe(false);
    expect(_test.generationInFlight({})).toBe(false);
    expect(_test.generationInFlight(null)).toBe(false);
  });

  test('a second concurrent run keeps the fence up after the first finishes', () => {
    const stored = { _generationRuns: { runA: future(), runB: future() } };
    const remaining = _test.activeGenerationRuns(stored);
    delete remaining.runA; // runA's Phase B write
    expect(_test.generationInFlight({ _generationRuns: remaining })).toBe(true);
    delete remaining.runB;
    expect(_test.generationInFlight({ _generationRuns: remaining })).toBe(false);
  });

  // Issue #3135: the Phase B write now consults the seal too, so this
  // predicate gates the final write and not just new-run registration.
  test('sendSealActive is true only for an unexpired seal', () => {
    expect(_test.sendSealActive({ _sendSealUntil: future() })).toBe(true);
    expect(_test.sendSealActive({ _sendSealUntil: past() })).toBe(false);
    expect(_test.sendSealActive({ _sendSealUntil: 'not-a-date' })).toBe(false);
    expect(_test.sendSealActive({})).toBe(false);
    expect(_test.sendSealActive(null)).toBe(false);
  });

  // A seal and a live run are independent gates: a seal with no run active
  // must still block the write, which is exactly the interleaving #3135
  // describes (lease expired, seal taken, provider returns late).
  test('an active seal is independent of the generation fence', () => {
    const sealedNoRuns = { _sendSealUntil: future() };
    expect(_test.generationInFlight(sealedNoRuns)).toBe(false);
    expect(_test.sendSealActive(sealedNoRuns)).toBe(true);
  });
});
