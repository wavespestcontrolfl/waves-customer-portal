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
    // Below half the canonical — the per-number guard holds.
    expect(reconcileRainFigure(
      'Rain this week ran well past the 0.75 inch target total.',
      2.96,
    )).toBeNull();
  });

  test('stale total is rewritten even when the target shares the sentence (codex P2 r1)', () => {
    expect(reconcileRainFigure(
      'Rainfall totaling 2.72 inches was above the 0.75 inch target.',
      2.96,
    )).toBe('Rainfall totaling 2.96 inches was above the 0.75 inch target.');
  });

  test('a leading target figure does not consume the rewrite attempt', () => {
    expect(reconcileRainFigure(
      'Against the 0.75 inch target, rain totaled 2.72 inches this week.',
      2.96,
    )).toBe('Against the 0.75 inch target, rain totaled 2.96 inches this week.');
  });

  test('a singular "inch" total is rewritten too (codex P2 r2)', () => {
    expect(reconcileRainFigure('Rain totaled about 1 inch this week.', 1.52))
      .toBe('Rain totaled about 1.52 inch this week.');
  });

  test('low-rain week: the target is never rewritten to the rain total (codex P2 r2)', () => {
    // First figure already canonical → scan stops; target phrase also guarded.
    expect(reconcileRainFigure(
      'Rainfall totaled 0.2 inches this week, below the 0.75 inches target.',
      0.2,
    )).toBeNull();
  });

  test('"target of N" phrasing is skipped without consuming the attempt', () => {
    expect(reconcileRainFigure(
      'Rain this week fell short of the target of 0.75 inches, totaling 0.2 inches.',
      0.35,
    )).toBe('Rain this week fell short of the target of 0.75 inches, totaling 0.35 inches.');
  });

  test('a rain sentence without a weekly-total cue is left alone', () => {
    expect(reconcileRainFigure('About 1.36 inches of rain fell Wednesday.', 2.96)).toBeNull();
  });

  test('no canonical figure → no-op', () => {
    expect(reconcileRainFigure('Rain totaled 2.72 inches this week.', null)).toBeNull();
  });

  test('precipitation / last-seven-days phrasing qualifies (codex P2 r6)', () => {
    expect(reconcileRainFigure('Precipitation over the last seven days was 2.72 inches.', 2.96))
      .toBe('Precipitation over the last seven days was 2.96 inches.');
    expect(reconcileRainFigure('Precipitation totaled 2.72 inches this week.', 2.96))
      .toBe('Precipitation totaled 2.96 inches this week.');
  });

  test('a genuinely stale LOW total is rewritten (codex P2 r3)', () => {
    // Open same-day window: 0.2" at completion, 0.8" by view time — the old
    // below-half-canonical guard wrongly skipped this exact drift.
    expect(reconcileRainFigure('Rainfall totaled 0.2 inches this week.', 0.8))
      .toBe('Rainfall totaled 0.8 inches this week.');
  });

  test('a per-week target qualifier still guards, and the stale total still rewrites (codex P2 r4)', () => {
    expect(reconcileRainFigure(
      'Against the 0.75 inches per week target, rain totaled 2.72 inches this week.',
      2.96,
    )).toBe('Against the 0.75 inches per week target, rain totaled 2.96 inches this week.');
  });

  test('a bare "in" unit is recognized (codex P2 r4)', () => {
    expect(reconcileRainFigure('Rain totaled 2.72 in this week.', 2.96))
      .toBe('Rain totaled 2.96 in this week.');
    // …but "in" as a preposition never reads as a unit.
    expect(reconcileRainFigure('Rain arrived at 2 in the morning and totaled little this week.', 2.96))
      .toBeNull();
  });

  test('a combined rain+irrigation total is never rewritten to rain-only (codex P2 r5)', () => {
    expect(reconcileRainFigure('Rain and irrigation totaled 1.95 inches this week.', 1.2)).toBeNull();
    expect(reconcileRainFigure('Total water including rain came to 1.95 inches this week.', 1.2)).toBeNull();
    // The precipitation synonym rides the same combined-water guard (r8).
    expect(reconcileRainFigure('Precipitation and irrigation totaled 1.95 inches this week.', 1.2)).toBeNull();
  });

  test('a delta-from-target figure is never rewritten to the total (codex P2 r5)', () => {
    expect(reconcileRainFigure(
      'Rain ran heavy this week, at 2.2 inches above the weekly target.',
      2.96,
    )).toBeNull();
  });

  test('goal/recommended phrasing guards like target does', () => {
    expect(reconcileRainFigure(
      'Rain this week totaled 0.2 inches against the recommended 0.75 inches.',
      0.8,
    )).toBe('Rain this week totaled 0.8 inches against the recommended 0.75 inches.');
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

  test('"drought stress tolerance" never partially rewrites (codex P2 r2)', () => {
    expect(replaceDroughtHypothesis('Potassium supports drought stress tolerance in stressed turf.')).toBeNull();
  });

  test('an unrelated negation does not shield the drought phrase (codex P2 r3)', () => {
    expect(replaceDroughtHypothesis('No pests were seen; drought stress remains possible in the thin areas.'))
      .toBe('No pests were seen; uneven sprinkler coverage remains possible in the thin areas.');
  });

  test('terse dry-pocket headlines qualify and keep their capitalization (codex P2 r4)', () => {
    expect(replaceDroughtHypothesis('Dry pocket near the sidewalk'))
      .toBe('Uneven sprinkler coverage near the sidewalk');
    expect(replaceDroughtHypothesis('Localized drought near the edge'))
      .toBe('Uneven sprinkler coverage near the edge');
  });

  test('negations with plain qualifiers are preserved (codex P2 r4)', () => {
    expect(replaceDroughtHypothesis('No current signs of dry pockets in the stressed areas.')).toBeNull();
    expect(replaceDroughtHypothesis('No recent dry spells are visible across the tan patches.')).toBeNull();
  });

  test('"dry patch" rewrites as a hypothesis but survives as an observation (codex P2 r5)', () => {
    expect(replaceDroughtHypothesis('Thinning tan patches could be chinch bug activity or a dry patch.'))
      .toBe('Thinning tan patches could be chinch bug activity or uneven sprinkler coverage.');
    expect(replaceDroughtHypothesis('A few dry patches near the sidewalk were noted.')).toBeNull();
  });

  test('dry spot/area and drought-related forms are covered (codex P2 r7)', () => {
    expect(replaceDroughtHypothesis('Thin patches could be chinch bugs or dry spots.'))
      .toBe('Thin patches could be chinch bugs or uneven sprinkler coverage.');
    expect(replaceDroughtHypothesis('The stress there is possibly drought-related.'))
      .toBe('The stress there is possibly sprinkler-coverage-related.');
    // Observation forms without a hypothesis cue survive.
    expect(replaceDroughtHypothesis('Some dry areas near the stressed strip were noted.')).toBeNull();
  });

  test('a cue AFTER an observed dry area never converts it to a hypothesis (codex P2 r8)', () => {
    expect(replaceDroughtHypothesis('Dry spots were noted in thin turf, and color is improving or stable.')).toBeNull();
  });

  test('a negated dry phrase does not shield a later hypothesis in the same sentence (codex P2 r7)', () => {
    expect(replaceDroughtHypothesis('No current signs of dry pockets, but drought stress remains possible in the thin areas.'))
      .toBe('No current signs of dry pockets, but uneven sprinkler coverage remains possible in the thin areas.');
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

  test('rain-unknown report: null figures never coerce to 0 (codex P1 r1)', () => {
    // Number(null) === 0 — a rain-unknown report must not rewrite the summary
    // to "0 inches" or judge rain against a phantom 0" target.
    const input = base();
    input.reportV2.water = { rainInches: null, targetInches: null };
    const fix = reconcileLawnReport(input);
    expect(fix.summary).toBeNull();
    expect(fix.insights).toBeNull();
    expect(fix.photoSummary).toBeNull();
    expect(fix.warnings.some((w) => /rain/.test(w.code))).toBe(false);
  });

  test('the rendered nextVisitPlan row is reconciled too (codex P2 r1)', () => {
    const input = base();
    input.reportV2.insights[0].nextVisitPlan = 'Recheck the sidewalk edge for chinch bug or drought stress.';
    const fix = reconcileLawnReport(input);
    expect(fix.insights[0].nextVisitPlan).toBe('Recheck the sidewalk edge for chinch bug or uneven sprinkler coverage.');
  });

  test('hero snapshot copies of insight text are patched too (codex P2 r3)', () => {
    const input = base();
    input.reportV2.snapshot = {
      overallScore: 74,
      mainWatch: 'Thin patches that could line up with chinch bug activity or a dry pocket.',
      wavesNext: 'Recheck the flagged edge for drought stress next visit.',
      watching: ['Stress patches from chinch bugs or a dry pocket', 'Mowing height'],
      customerAction: 'Watch the thin patches for spread.',
    };
    const fix = reconcileLawnReport(input);
    expect(fix.snapshot.mainWatch).toMatch(/uneven sprinkler coverage/);
    expect(fix.snapshot.wavesNext).toMatch(/uneven sprinkler coverage/);
    expect(fix.snapshot.watching[0]).toMatch(/uneven sprinkler coverage/);
    expect(fix.snapshot.watching[1]).toBe('Mowing height');
    expect(fix.snapshot.customerAction).toBe('Watch the thin patches for spread.');
  });

  test('untouched snapshot returns null (payload keeps its own)', () => {
    const input = base();
    input.reportV2.snapshot = { overallScore: 74, mainWatch: 'Mowing a bit tall.' };
    expect(reconcileLawnReport(input).snapshot).toBeNull();
  });

  test('applyLawnReportReconciliation patches a payload in place (shared with pdf-queue — codex P2 r6)', () => {
    const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
    const input = base();
    const data = { ...input.data, serviceLine: 'lawn', reportV2: input.reportV2 };
    const out = applyLawnReportReconciliation(data, null);
    expect(out).toBe(data);
    expect(data.summary).toMatch(/totaling 2\.96 inches/);
    expect(data.reportV2.insights[0].whatWeSaw).toMatch(/uneven sprinkler coverage/);
    expect(data.reportV2.photoSummary).toMatch(/uneven sprinkler coverage/);
    expect(Array.isArray(data.reportV2.consistencyWarnings)).toBe(true);
  });

  test('applyLawnReportReconciliation is a no-op without reportV2', () => {
    const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
    const data = { summary: 'Rain totaled 2.72 inches this week.' };
    applyLawnReportReconciliation(data, null);
    expect(data.summary).toBe('Rain totaled 2.72 inches this week.');
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

  test('a comma-only list keeps the honest ellipsis instead of fabricating a complete sentence (codex P2 r8)', () => {
    const listy = 'Recheck the front yard, side yard, back yard, driveway edge, mailbox strip, pool cage strip, fence line, and shade corner for lingering stress signals and anything new that appears.';
    const out = firstSentence(listy);
    expect(out).toMatch(/…$/);
    expect(out).not.toMatch(/\.$/);
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

  test('proper-case element notation survives ("Mn + Fe", "Fe/Mg/Mn/S" — codex P3 r1)', () => {
    const out = buildTreatmentSummary({ products: [
      { name: 'LESCO Micro Blend', kind: 'fertilizer', activeIngredient: 'Mn + Fe + Mg + S', targets: [], method: 'broadcast_spray' },
      { name: 'SiteOne Chelated Mix', kind: 'fertilizer', activeIngredient: 'Chelated Fe/Mg/Mn/S blend', targets: [], method: 'broadcast_spray' },
    ] });
    expect(out).toContain('Mn + Fe + Mg + S');
    expect(out).toContain('chelated Fe/Mg/Mn/S blend');
    expect(out).not.toMatch(/\bmn\b|\bfe\/mg/);
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
