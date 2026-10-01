// Findings card diet, server side (lawn report rebuild P8, GATE_LAWN_REPORT_LEAD).
// The stock insight sentences that claim an unverified past action or only
// paraphrase the cause, and the out-of-band mowing recommendation the mowing
// finding card already says, are null in lead mode. The legacy card and the PDF
// still print them, so with the gate off every string is unchanged.
// Synthetic payloads only.

const { buildLawnInsightCards } = require('../services/service-report/lawn-report-insights');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { _test: { mergeNarrative } } = require('../services/service-report/lawn-report-narrative');

const CATS = (status) => [
  { key: 'weed_pressure', status },
  { key: 'damage_disease_signals', status },
  { key: 'coverage', status: 'needs_attention' },
  { key: 'water_moisture_stress', status },
];

function withGate(value, fn) {
  const previous = process.env.GATE_LAWN_REPORT_LEAD;
  if (value === undefined) delete process.env.GATE_LAWN_REPORT_LEAD; else process.env.GATE_LAWN_REPORT_LEAD = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.GATE_LAWN_REPORT_LEAD; else process.env.GATE_LAWN_REPORT_LEAD = previous;
  }
}

const cardOf = (cards, category) => cards.find((c) => c.category === category);

const STOCK_WAVES_ACTIONS = [
  'Documented the moisture and adjusted today’s plan toward drying things out.',
  'Noted the shortfall and set this week’s watering plan on the report.',
  'Noted the shortfall and set the watering target on the report.',
  'Flagged the area and will recheck it next visit.',
  'Flagged it for a recheck at the next visit.',
  'Spot-treated where appropriate and built it into the plan.',
  'Documented the areas for comparison next visit.',
  'Shifted the program toward density and color recovery.',
  'Logged the height for your file — we don’t mow, so this is a heads-up.',
  'Noted it on this visit and built any follow-up into the plan.',
  'Completed today’s scheduled treatment and documented the visit.',
];
const STOCK_WHY = [
  'That pattern usually points to uneven sprinkler coverage, not the whole lawn needing more water.',
  'Catching patterns early lets us confirm the cause before it spreads.',
  'We want what you noticed tracked on the report, not lost.',
  'Your lawn is responding well to the program.',
];

// Every card variant the stock lines live on.
const BUILDS = [
  { water: { status: 'surplus' } },
  { water: { status: 'deficit' } },
  { water: { status: 'deficit', weekPlan: { title: 'This week: 25 minutes per turf zone', action: 'run' } } },
  { water: { status: 'balanced', localizedDry: true, localizedDryConfidence: 'area_estimated' } },
  { categories: CATS('watch'), water: { status: 'balanced' } },
  { categories: CATS('needs_attention'), water: { status: 'balanced' }, mowing: { status: 'too_short' }, customerConcern: 'Brown spot by the mailbox' },
  { mowing: { status: 'too_tall' } },
  {},
];

function allCards() {
  return BUILDS.flatMap((input) => buildLawnInsightCards({ grassLabel: 'St. Augustine', ...input }));
}

describe('insight stock sentences in lead mode', () => {
  test('every unverifiable wavesAction and listed whyItMatters is null (key kept, never missing)', () => {
    const cards = withGate('true', allCards);
    for (const card of cards) {
      expect(card).toHaveProperty('wavesAction');
      expect(STOCK_WAVES_ACTIONS).not.toContain(card.wavesAction);
      expect(STOCK_WHY).not.toContain(card.whyItMatters);
    }
    expect(cardOf(withGate('true', () => buildLawnInsightCards({ water: { status: 'deficit' } })), 'water').wavesAction).toBeNull();
    expect(cardOf(withGate('true', () => buildLawnInsightCards({})), 'overall')).toMatchObject({ wavesAction: null, whyItMatters: null });
    expect(cardOf(withGate('true', () => buildLawnInsightCards({ mowing: { status: 'too_short' } })), 'mowing').wavesAction).toBeNull();
  });

  test('the product-grounded wavesAction lines and the other whyItMatters lines stay', () => {
    withGate('true', () => {
      const fung = cardOf(buildLawnInsightCards({ water: { status: 'surplus' }, treatmentKinds: ['fungicide'] }), 'water');
      expect(fung.wavesAction).toBe('Applied a fungicide and adjusted today’s plan toward drying things out.');
      expect(fung.whyItMatters).toMatch(/Staying too wet drives fungus/);
      expect(cardOf(buildLawnInsightCards({ categories: CATS('watch'), treatmentKinds: ['pre_emergent'] }), 'weeds').wavesAction).toMatch(/pre-emergent/);
      expect(cardOf(buildLawnInsightCards({ categories: CATS('watch'), treatmentKinds: ['herbicide'] }), 'weeds').wavesAction).toMatch(/herbicide/);
      expect(cardOf(buildLawnInsightCards({ categories: CATS('needs_attention'), treatmentKinds: ['fertilizer'] }), 'coverage').wavesAction).toMatch(/Fed the lawn/);
      expect(cardOf(buildLawnInsightCards({ mowing: { status: 'too_tall' } }), 'mowing').whyItMatters).toMatch(/Tall mowing/);
    });
  });

  test('every watering variant of customerAction and nextVisitPlan is identical with the gate on and off', () => {
    const pick = (cards) => cards.map((c) => [c.category, c.customerAction, c.nextVisitPlan, c.whatWeSaw, c.headline]);
    for (const input of BUILDS) {
      const off = withGate(undefined, () => pick(buildLawnInsightCards({ grassLabel: 'St. Augustine', ...input })));
      const on = withGate('true', () => pick(buildLawnInsightCards({ grassLabel: 'St. Augustine', ...input })));
      expect(on).toEqual(off);
    }
  });

  test('gate off keeps every stock sentence (the legacy card and the PDF still print them)', () => {
    const cards = withGate(undefined, allCards);
    const waves = cards.map((c) => c.wavesAction);
    for (const line of ['Documented the moisture and adjusted today’s plan toward drying things out.', 'Flagged the area and will recheck it next visit.', 'Documented the areas for comparison next visit.', 'Completed today’s scheduled treatment and documented the visit.']) {
      expect(waves).toContain(line);
    }
    const why = cards.map((c) => c.whyItMatters);
    for (const line of STOCK_WHY) expect(why).toContain(line);
    for (const card of cards) {
      expect(typeof card.wavesAction).toBe('string');
      expect(typeof card.whyItMatters).toBe('string');
    }
  });
});

describe('the narrative overlay never refills a nulled line', () => {
  test('a model-written wavesAction / whyItMatters / mowing sentence does not land on a null field', () => {
    const base = {
      insights: [{ headline: 'H', whatWeSaw: 'S', whyItMatters: null, wavesAction: null, customerAction: null, nextVisitPlan: null }],
      mowing: { measuredHeightInches: 1.5, status: 'too_short', recommendation: null },
    };
    const model = {
      insights: [{ headline: 'H2', whatWeSaw: 'S2', whyItMatters: 'Model why.', wavesAction: 'Model did.', customerAction: '', nextVisitPlan: '' }],
      mowing: 'Mow higher, we will handle it.',
    };
    const out = mergeNarrative(base, model);
    expect(out.insights[0].whyItMatters).toBeNull();
    expect(out.insights[0].wavesAction).toBeNull();
    expect(out.mowing.recommendation).toBeNull();
    // Written copy still lands where the builder left a sentence (gate-off behavior).
    const kept = mergeNarrative({
      insights: [{ headline: 'H', whatWeSaw: 'S', whyItMatters: 'Builder why.', wavesAction: 'Builder did.' }],
      mowing: { measuredHeightInches: 3, status: 'ideal', recommendation: 'Looks good.' },
    }, { insights: [{ whyItMatters: 'Model why.', wavesAction: 'Model did.' }], mowing: 'Model mowing line.' });
    expect(kept.insights[0].whyItMatters).toBe('Model why.');
    expect(kept.insights[0].wavesAction).toBe('Model did.');
    expect(kept.mowing.recommendation).toBe('Model mowing line.');
  });
});

describe('mowing recommendation in lead mode', () => {
  const build = (heightIn, status) => buildLawnReportV2({
    lawnAssessment: { scores: { turfDensity: 80, weedSuppression: 80, colorHealth: 80, stressDamage: 80, fungusControl: 80, overallScore: 80, season: 'peak' }, photos: [] },
    mowingHeight: { heightIn, status, band: { min: 3.5, max: 4.0 } },
  });

  test('too_short and too_tall leave the recommendation null; the mowing finding card still says what to do', () => {
    for (const [height, status, step] of [[2, 'below', 'Raise the mower one setting.'], [5.5, 'above', 'Lower the mower one setting.']]) {
      const report = withGate('true', () => build(height, status));
      expect(report.mowing.status).toBe(status === 'below' ? 'too_short' : 'too_tall');
      expect(report.mowing.recommendation).toBeNull();
      expect(report.mowing.measuredHeightInches).toBe(height);
      expect(cardOf(report.insights, 'mowing').customerAction).toBe(step);
    }
  });

  test('the in-range line stays', () => {
    const report = withGate('true', () => build(3.75, 'in_range'));
    expect(report.mowing.recommendation).toMatch(/Mowing height looks good/);
  });

  test('gate off keeps the out-of-band recommendation text', () => {
    expect(withGate(undefined, () => build(2, 'below')).mowing.recommendation).toMatch(/kept a bit short/);
    expect(withGate(undefined, () => build(5.5, 'above')).mowing.recommendation).toMatch(/kept a bit tall/);
  });
});
