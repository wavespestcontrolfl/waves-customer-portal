/**
 * Relevance follow-up pass (owner 2026-08-04):
 *  - the AI summary's weekly rain figure must agree with the Water This Week
 *    widget (the same report was quoting 2.72" and 2.96" at once);
 *  - a drought / dry-pocket stress hypothesis must not survive on a report
 *    whose own water data shows rain well above target;
 *  - the follow-up card's reason ends on a complete clause, never "…";
 *  - the applied-today sentence collapses a shared method and keeps element
 *    symbol casing ("Iron + N", never "iron + n").
 */

const {
  reconcileLawnReport,
  firstSentence,
  reconcileRainFigure,
  replaceDroughtHypothesis,
} = require('../services/service-report/report-consistency');
const { buildTreatmentSummary } = require('../services/service-report/treatment-summary');

describe('reconcileRainFigure', () => {
  test('rewrites a stale weekly total to the widget figure', () => {
    const out = reconcileRainFigure(
      'Recent rainfall totaling 2.72 inches, combined with August heat and humidity, can favor turf disease.',
      2.96,
    );
    expect(out).toBe(
      'Recent rainfall totaling 2.96 inches, combined with August heat and humidity, can favor turf disease.',
    );
  });

  test('matching figures are untouched (null = no change)', () => {
    expect(reconcileRainFigure('With 2.96 inches of rain over the past week, moisture stays high.', 2.96)).toBeNull();
  });

  test('a target mention is never rewritten', () => {
    // Below half the canonical AND in a target sentence — both guards hold.
    expect(reconcileRainFigure(
      'Rain this week ran well past the 0.75 inch target total.',
      2.96,
    )).toBeNull();
  });

  test('a rain sentence without a weekly-total cue is left alone', () => {
    expect(reconcileRainFigure('About 1.36 inches of rain fell Wednesday.', 2.96)).toBeNull();
  });

  test('no canonical figure → no-op', () => {
    expect(reconcileRainFigure('Rain totaled 2.72 inches this week.', null)).toBeNull();
  });
});

describe('replaceDroughtHypothesis', () => {
  test('rewords a dry-pocket differential in a stress sentence', () => {
    expect(replaceDroughtHypothesis(
      'Thinning tan patches near the sidewalk could line up with chinch bug activity or a dry pocket.',
    )).toBe(
      'Thinning tan patches near the sidewalk could line up with chinch bug activity or uneven sprinkler coverage.',
    );
  });

  test('rewords "localized drought" in the photo narrative', () => {
    expect(replaceDroughtHypothesis(
      'Scattered dry blades suggest early minor stress that could be consistent with chinch bug activity or localized drought.',
    )).toMatch(/chinch bug activity or uneven sprinkler coverage\.$/);
  });

  test('never touches drought-tolerance praise or negated mentions', () => {
    expect(replaceDroughtHypothesis('This stress-resistant cultivar has strong drought tolerance.')).toBeNull();
    expect(replaceDroughtHypothesis('No drought stress is visible in the stressed areas.')).toBeNull();
  });

  test('a sentence not about the stress signals is left alone', () => {
    expect(replaceDroughtHypothesis('A drought was declared in the county.')).toBeNull();
  });
});

describe('reconcileLawnReport — relevance pass integration', () => {
  const base = () => ({
    data: {
      summary: 'Recent rainfall totaling 2.72 inches raised disease pressure this week. We will re-check the flagged areas.',
      lawnAssessment: {
        recommendations: {
          nextVisitFocus: 'Evaluate response to today’s iron, potassium, fungicide, and insect treatment; confirm whether color is improving, inspect thinning edge areas for chinch bug or drought stress.',
        },
      },
    },
    reportV2: {
      water: { rainInches: 2.96, targetInches: 0.75 },
      insights: [{
        status: 'watch',
        headline: 'Early stress showing near the sidewalk',
        whatWeSaw: 'Thinning tan patches hint at early minor stress, which could line up with chinch bug activity or a dry pocket.',
      }],
      photoSummary: 'A few thinning tan patches suggest stress that could be consistent with chinch bug activity or localized drought.',
    },
    serviceLine: 'lawn',
  });

  test('summary rain figure is reconciled and returned', () => {
    const fix = reconcileLawnReport(base());
    expect(fix.summary).toMatch(/totaling 2\.96 inches/);
    expect(fix.warnings.some((w) => w.code === 'summary_rain_figure_stale')).toBe(true);
  });

  test('drought hypotheses are reworded across insights, photo narrative, and follow-up reason', () => {
    const fix = reconcileLawnReport(base());
    expect(fix.insights[0].whatWeSaw).toMatch(/uneven sprinkler coverage/);
    expect(fix.insights[0].whatWeSaw).not.toMatch(/dry pocket/);
    expect(fix.photoSummary).toMatch(/uneven sprinkler coverage/);
    expect(fix.followUp.reason).not.toMatch(/drought/i);
    expect(fix.warnings.filter((w) => w.code === 'drought_hypothesis_contradicts_rainfall').length).toBeGreaterThan(0);
  });

  test('rain near target keeps the drought differential (no rewrite)', () => {
    const input = base();
    input.reportV2.water = { rainInches: 0.9, targetInches: 0.75 };
    input.data.summary = 'Rain this week was light.';
    const fix = reconcileLawnReport(input);
    expect(fix.insights).toBeNull();
    expect(fix.photoSummary).toBeNull();
  });

  test('todaysResult carries no fixed "No urgent homeowner action" clause', () => {
    const fix = reconcileLawnReport(base());
    expect(fix.todaysResult).toBe('Recent rainfall totaling 2.96 inches raised disease pressure this week.');
  });
});

describe('firstSentence clause-boundary truncation', () => {
  test('an over-cap single sentence ends on the last complete clause, not "…"', () => {
    const focus = 'Evaluate response to today’s iron, potassium, fungicide, and insect treatment; confirm whether color is improving, inspect thinning edge areas for chinch bug activity or new stress.';
    const out = firstSentence(focus);
    expect(out.length).toBeLessThanOrEqual(171);
    expect(out).not.toContain('…');
    expect(out).toMatch(/\.$/);
  });

  test('short sentences are unchanged', () => {
    expect(firstSentence('Recheck the mid-lawn zone.')).toBe('Recheck the mid-lawn zone.');
  });

  test('no clause boundary falls back to the word-boundary ellipsis', () => {
    const out = firstSentence(`Recheck ${'the very long unbroken run of words '.repeat(8)}at the end`);
    expect(out).toMatch(/…$/);
  });
});

describe('buildTreatmentSummary — shared method + symbol casing (owner 2026-08-04)', () => {
  const lawnProducts = [
    { name: 'LESCO K-Flow 0-0-25', kind: 'fertilizer', activeIngredient: 'Potassium 0-0-25 + sulfur', targets: [], method: 'broadcast_spray' },
    { name: 'Artavia 2 SC', kind: 'fungicide', activeIngredient: 'Azoxystrobin', targets: ['Large patch'], method: 'broadcast_spray' },
    { name: 'LESCO Chelated Iron Plus', kind: 'fertilizer', activeIngredient: 'Iron + N (foliar)', targets: [], method: 'broadcast_spray' },
    { name: 'Talstar P', kind: 'insecticide', activeIngredient: 'Bifenthrin', targets: ['Fire ants'], method: 'broadcast_spray' },
  ];

  test('one shared method is said once, not four times', () => {
    const out = buildTreatmentSummary({ products: lawnProducts });
    expect(out).toContain('(all applied as a broadcast application)');
    expect(out.match(/broadcast application/g)).toHaveLength(1);
  });

  test('element symbols keep their case; digit runs are untouched', () => {
    const out = buildTreatmentSummary({ products: lawnProducts });
    expect(out).toContain('iron + N (foliar)');
    expect(out).toContain('potassium 0-0-25 + sulfur');
    expect(out).not.toContain('iron + n');
  });

  test('mixed methods keep the per-item tag', () => {
    const out = buildTreatmentSummary({ products: [
      { name: 'Safari 20 SG', kind: 'systemic', activeIngredient: 'Dinotefuran 20%', targets: [], method: 'soil_drench' },
      { name: 'Kontos', kind: 'insecticide', activeIngredient: 'Spirotetramat', targets: [], method: 'foliar_spray' },
    ] });
    expect(out).toContain('dinotefuran (soil drench)');
    expect(out).toContain('spirotetramat (foliar spray)');
    expect(out).not.toContain('all applied as');
  });

  test('a single product keeps its inline method tag', () => {
    const out = buildTreatmentSummary({ products: [
      { name: 'Talstar P', kind: 'insecticide', activeIngredient: 'Bifenthrin', targets: [], method: 'broadcast_spray' },
    ] });
    expect(out).toContain('bifenthrin (broadcast application)');
  });
});
