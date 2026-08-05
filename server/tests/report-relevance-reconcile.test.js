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

  test('an irrigation amount is never rewritten to the rain total (codex P2 r19)', () => {
    expect(reconcileRainFigure(
      'Irrigation added 0.75 inches while rain totaled 2.72 inches this week.',
      2.96,
    )).toBe('Irrigation added 0.75 inches while rain totaled 2.96 inches this week.');
  });

  test('a unit-bearing rain range is never corrupted (codex P2 r20)', () => {
    expect(reconcileRainFigure('Rainfall was between 1 inch and 2 inches this week.', 2.96)).toBeNull();
  });

  test('a daily-window total is never rewritten to the weekly figure (codex P2 r20)', () => {
    expect(reconcileRainFigure('Rainfall totaled 0.4 inches in the last 24 hours.', 2.96)).toBeNull();
    expect(reconcileRainFigure('Rainfall totaled 0.4 inches today.', 2.96)).toBeNull();
  });

  test('sub-week rain windows are never rewritten (codex P2 r21)', () => {
    expect(reconcileRainFigure('Rainfall totaled 0.4 inches over the last 48 hours.', 2.96)).toBeNull();
    expect(reconcileRainFigure('Rainfall totaled 0.4 inches in the past two days.', 2.96)).toBeNull();
  });

  test('aftercare/irrigation instruction amounts are never rewritten (codex P2 r21)', () => {
    expect(reconcileRainFigure('With rain this week, water in today’s application with 0.25 inches within 24 hours.', 2.96)).toBeNull();
    expect(reconcileRainFigure('Rain this week means you can skip adding 0.25 inches of irrigation.', 2.96)).toBeNull();
  });

  test('a prior-week rain amount is never rewritten (codex P2 r22)', () => {
    expect(reconcileRainFigure(
      'Last week rainfall totaled 1.2 inches, while this week rainfall totaled 2.72 inches.',
      2.96,
    )).toBe('Last week rainfall totaled 1.2 inches, while this week rainfall totaled 2.96 inches.');
  });

  test('a prior "in." measurement sentence never absorbs the rain rewrite (codex P2 r23)', () => {
    expect(reconcileRainFigure('Mowing height was 3.5 in. Rainfall totaled 2.72 inches this week.', 2.96))
      .toBe('Mowing height was 3.5 in. Rainfall totaled 2.96 inches this week.');
  });

  test('a daily-average rain figure is never rewritten (codex P2 r24)', () => {
    expect(reconcileRainFigure('Average daily rainfall this week was 0.4 inches.', 2.96)).toBeNull();
    expect(reconcileRainFigure(
      'Rainfall averaged 0.4 inches per day this week, with the weekly total at 2.72 inches.',
      2.96,
    )).toBe('Rainfall averaged 0.4 inches per day this week, with the weekly total at 2.96 inches.');
  });

  test('a non-rain inch measurement is never rewritten (codex P2 r25)', () => {
    expect(reconcileRainFigure(
      'With rain this week, mowing height was 3.5 inches, and rain totaled 2.72 inches.',
      2.96,
    )).toBe('With rain this week, mowing height was 3.5 inches, and rain totaled 2.96 inches.');
  });

  test('benchmark rain deltas are preserved (codex P2 r25)', () => {
    expect(reconcileRainFigure('Rainfall was 1.97 inches above normal this week.', 2.96)).toBeNull();
    expect(reconcileRainFigure('Rain ran below normal by 0.4 inches this week.', 2.96)).toBeNull();
  });

  test('"weekly rainfall" qualifies as a week cue (codex P2 r25)', () => {
    expect(reconcileRainFigure('Weekly rainfall was 2.72 inches.', 2.96))
      .toBe('Weekly rainfall was 2.96 inches.');
  });

  test('hyphenated rain ranges are never corrupted (codex P2 r26)', () => {
    expect(reconcileRainFigure('Rainfall this week was 1-2 inches.', 2.96)).toBeNull();
  });

  test('a day/storm amount AFTER the figure is skipped (codex P2 r26)', () => {
    expect(reconcileRainFigure(
      'Rainfall this week included 1.36 inches from Wednesday’s storm, totaling 2.72 inches for the week.',
      2.96,
    )).toBe('Rainfall this week included 1.36 inches from Wednesday’s storm, totaling 2.96 inches for the week.');
  });

  test('a prior-week amount AFTER the figure is skipped (codex P2 r26)', () => {
    expect(reconcileRainFigure(
      'Rainfall totaled 1.2 inches last week, while this week rainfall totaled 2.72 inches.',
      2.96,
    )).toBe('Rainfall totaled 1.2 inches last week, while this week rainfall totaled 2.96 inches.');
  });

  test('a weekend rain window is never rewritten (codex P2 r27)', () => {
    expect(reconcileRainFigure('Rainfall totaled 0.4 inches over the weekend.', 2.96)).toBeNull();
  });

  test('comparative rain bounds are preserved (codex P2 r27)', () => {
    expect(reconcileRainFigure('Rainfall this week stayed under 1 inch.', 2.96)).toBeNull();
  });

  test('a contrast word bounds the prior-week guard (codex P2 r27)', () => {
    expect(reconcileRainFigure(
      'Last week rainfall totaled 1.2 inches while this week rainfall totaled 2.72 inches.',
      2.96,
    )).toBe('Last week rainfall totaled 1.2 inches while this week rainfall totaled 2.96 inches.');
  });

  test('a weekend amount inside a weekly comparison is skipped (codex P2 r28)', () => {
    expect(reconcileRainFigure(
      'Rainfall totaled 1.2 inches last weekend, while rain totaled 2.72 inches this week.',
      2.96,
    )).toBe('Rainfall totaled 1.2 inches last weekend, while rain totaled 2.96 inches this week.');
  });

  test('explicit non-week windows are never rewritten (codex P2 r28)', () => {
    expect(reconcileRainFigure('Rainfall totaled 4.2 inches over the past 14 days.', 2.96)).toBeNull();
    expect(reconcileRainFigure('Rainfall totaled 6.1 inches this month.', 2.96)).toBeNull();
    expect(reconcileRainFigure('Rainfall totaled 9.4 inches since July 1.', 2.96)).toBeNull();
  });

  test('a leading-dot rain amount rewrites as one value (codex P2 r28)', () => {
    expect(reconcileRainFigure('Rain totaled .72 inches this week.', 2.96))
      .toBe('Rain totaled 2.96 inches this week.');
  });

  test('a stale total after a target-and list still reconciles (codex P2 r28)', () => {
    expect(reconcileRainFigure(
      'Rain this week brought the 0.75 inches target and 2.72 inches total.',
      2.96,
    )).toBe('Rain this week brought the 0.75 inches target and 2.96 inches total.');
  });

  test('curly inch marks reconcile like ASCII units (codex P2 r29)', () => {
    expect(reconcileRainFigure('Rainfall totaled 2.72″ this week.', 2.96))
      .toBe('Rainfall totaled 2.96″ this week.');
    expect(reconcileRainFigure('Rainfall totaled 2.72” this week.', 2.96))
      .toBe('Rainfall totaled 2.96” this week.');
  });

  test('a long target qualifier still guards the target figure (codex P2 r29)', () => {
    expect(reconcileRainFigure(
      'The rain target for this week was 0.75 inches, but rain totaled 2.72 inches.',
      2.96,
    )).toBe('The rain target for this week was 0.75 inches, but rain totaled 2.96 inches.');
    expect(reconcileRainFigure(
      'The weekly target for your lawn was 0.75 inches, and rainfall reached 2.72 inches.',
      2.96,
    )).toBe('The weekly target for your lawn was 0.75 inches, and rainfall reached 2.96 inches.');
  });

  test('a non-week window amount is skipped even beside a weekly figure (codex P2 r29)', () => {
    expect(reconcileRainFigure(
      'Rainfall totaled 4.2 inches this month, while rain totaled 2.72 inches this week.',
      2.96,
    )).toBe('Rainfall totaled 4.2 inches this month, while rain totaled 2.96 inches this week.');
    expect(reconcileRainFigure(
      'Over the past 14 days rainfall totaled 4.2 inches, but this week rain totaled 2.72 inches.',
      2.96,
    )).toBe('Over the past 14 days rainfall totaled 4.2 inches, but this week rain totaled 2.96 inches.');
  });

  test('a week-over-week rain delta is preserved (codex P2 r30)', () => {
    expect(reconcileRainFigure(
      'Rainfall increased by 1 inch this week to a total of 2.72 inches.',
      2.96,
    )).toBe('Rainfall increased by 1 inch this week to a total of 2.96 inches.');
    expect(reconcileRainFigure('Rainfall was up by 0.4 inches this week.', 2.96)).toBeNull();
  });

  test('spelled-out weekly totals reconcile (codex P2 r30)', () => {
    expect(reconcileRainFigure('Rainfall totaled one inch this week.', 2.96))
      .toBe('Rainfall totaled 2.96 inches this week.');
    expect(reconcileRainFigure('Rainfall totaled one and a half inches this week.', 2.96))
      .toBe('Rainfall totaled 2.96 inches this week.');
    expect(reconcileRainFigure('Rainfall totaled half an inch this week.', 2.96))
      .toBe('Rainfall totaled 2.96 inches this week.');
    // Spelled range endpoints stay a range, exactly like digit endpoints.
    expect(reconcileRainFigure('Rainfall was between one and two inches this week.', 2.96)).toBeNull();
  });

  test('temporal deltas without "by" are preserved (codex P2 r31)', () => {
    expect(reconcileRainFigure(
      'Rainfall rose 1 inch this week to a total of 2.72 inches.',
      2.96,
    )).toBe('Rainfall rose 1 inch this week to a total of 2.96 inches.');
    expect(reconcileRainFigure(
      'Rainfall was 1 inch higher this week, totaling 2.72 inches.',
      2.96,
    )).toBe('Rainfall was 1 inch higher this week, totaling 2.96 inches.');
    // "rose to <total>" is the total itself, not a delta.
    expect(reconcileRainFigure('Rainfall rose to 2.72 inches this week.', 2.96))
      .toBe('Rainfall rose to 2.96 inches this week.');
    // "N inches of rain fell" states the total that fell, not a decrease.
    expect(reconcileRainFigure('This week 2.72 inches of rain fell across the area.', 2.96))
      .toBe('This week 2.96 inches of rain fell across the area.');
  });

  test('mixed-fraction rain amounts rewrite as a whole (codex P2 r32)', () => {
    expect(reconcileRainFigure('Rainfall totaled 2 1/2 inches this week.', 2.96))
      .toBe('Rainfall totaled 2.96 inches this week.');
    expect(reconcileRainFigure('Rainfall totaled 1/2 inch this week.', 2.96))
      .toBe('Rainfall totaled 2.96 inches this week.');
    // A fraction equal to the canonical figure is already in agreement.
    expect(reconcileRainFigure('Rainfall totaled 2 1/2 inches this week.', 2.5)).toBeNull();
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

  test('a singular "inch" total is rewritten too, pluralizing the unit (codex P2 r2 + P3 r12)', () => {
    expect(reconcileRainFigure('Rain totaled about 1 inch this week.', 1.52))
      .toBe('Rain totaled about 1.52 inches this week.');
    expect(reconcileRainFigure('Rain totaled 1.4 inches this week.', 1))
      .toBe('Rain totaled 1 inch this week.');
  });

  test('low-rain week: the target is never rewritten to the rain total (codex P2 r2)', () => {
    // First figure already canonical → scan stops; target phrase also guarded.
    expect(reconcileRainFigure(
      'Rainfall totaled 0.2 inches this week, below the 0.75 inches target.',
      0.2,
    )).toBeNull();
  });

  test('a stale total AFTER a target clause still rewrites (codex P2 r9)', () => {
    expect(reconcileRainFigure(
      'Rain this week was above the target, totaling 2.72 inches.',
      2.96,
    )).toBe('Rain this week was above the target, totaling 2.96 inches.');
  });

  test('"target of N" phrasing is skipped without consuming the attempt', () => {
    expect(reconcileRainFigure(
      'Rain this week fell short of the target of 0.75 inches, totaling 0.2 inches.',
      0.35,
    )).toBe('Rain this week fell short of the target of 0.75 inches, totaling 0.35 inches.');
  });

  test('an "in." abbreviation does not split the sentence away from its cue (codex P2 r17)', () => {
    expect(reconcileRainFigure('Rainfall was 2.72 in. this week.', 2.96))
      .toBe('Rainfall was 2.96 in. this week.');
  });

  test('a daily/storm amount is never rewritten to the weekly total (codex P2 r17)', () => {
    expect(reconcileRainFigure(
      'Wednesday brought 1.36 inches of rain, contributing to this week’s wet turf.',
      2.96,
    )).toBeNull();
  });

  test('a target range endpoint is never rewritten (codex P2 r17)', () => {
    expect(reconcileRainFigure(
      'Rain this week was below the recommended range of 0.75 to 1 inch.',
      2.96,
    )).toBeNull();
  });

  test('a rain sentence without a weekly-total cue is left alone', () => {
    expect(reconcileRainFigure('About 1.36 inches of rain fell Wednesday.', 2.96)).toBeNull();
  });

  test('no canonical figure → no-op', () => {
    expect(reconcileRainFigure('Rain totaled 2.72 inches this week.', null)).toBeNull();
  });

  test('hyphenated adjectival totals reconcile and stay singular (codex P2 r14)', () => {
    expect(reconcileRainFigure('The 2.72-inch rainfall total this week raised disease pressure.', 2.96))
      .toBe('The 2.96-inch rainfall total this week raised disease pressure.');
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
    // Qualifiers between connector and irrigation (r13).
    expect(reconcileRainFigure('Rainfall plus your irrigation totaled 1.95 inches this week.', 1.2)).toBeNull();
  });

  test('a delta-from-target figure is never rewritten to the total (codex P2 r5)', () => {
    expect(reconcileRainFigure(
      'Rain ran heavy this week, at 2.2 inches above the weekly target.',
      2.96,
    )).toBeNull();
  });

  test('a delta against an explicit target figure is preserved too (codex P2 r16)', () => {
    expect(reconcileRainFigure(
      'Rain this week was 1.97 inches above the 0.75-inch target.',
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

  test('a cue in an EARLIER clause never leaks across the boundary (codex P2 r9)', () => {
    expect(replaceDroughtHypothesis('Color is improving or stable; dry spots were noted in thin turf.')).toBeNull();
  });

  test('dry pocket/spell observations are preserved; terse headlines still rewrite (codex P2 r10)', () => {
    expect(replaceDroughtHypothesis('Dry pockets were noted in thin turf.')).toBeNull();
    expect(replaceDroughtHypothesis('Dry spells were observed across the stressed strip.')).toBeNull();
    // The terse headline form (no observation verb) still qualifies.
    expect(replaceDroughtHypothesis('Dry pocket near the sidewalk'))
      .toBe('Uneven sprinkler coverage near the sidewalk');
  });

  test('unhyphenated "drought stressed" reads adjectivally (codex P2 r12)', () => {
    expect(replaceDroughtHypothesis('The thin strip is possibly drought stressed.'))
      .toBe('The thin strip is possibly sprinkler-coverage-related.');
  });

  test('a negation AFTER the drought phrase preserves the observation (codex P2 r12)', () => {
    expect(replaceDroughtHypothesis('Drought stress was not observed in the thin patches.')).toBeNull();
    expect(replaceDroughtHypothesis('Drought stress isn’t visible across the stressed areas.')).toBeNull();
  });

  test('damage wording qualifies as a stress cue (codex P2 r15)', () => {
    expect(replaceDroughtHypothesis('Damage could be drought-related.'))
      .toBe('Damage could be sprinkler-coverage-related.');
    expect(replaceDroughtHypothesis('Drought-related damage is possible near the edge.'))
      .toBe('Sprinkler-coverage-related damage is possible near the edge.');
  });

  test('drought dismissals stay verbatim (codex P2 r14)', () => {
    expect(replaceDroughtHypothesis('Drought stress is unlikely given the thin-patch pattern.')).toBeNull();
    expect(replaceDroughtHypothesis('Drought stress was ruled out for the stressed strip.')).toBeNull();
  });

  test('a negated dismissal is an unresolved hypothesis and still reconciles (codex P2 r16)', () => {
    expect(replaceDroughtHypothesis('Drought stress cannot be ruled out in the thin patches.'))
      .toBe('Uneven sprinkler coverage cannot be ruled out in the thin patches.');
  });

  test('pre-phrase dismissals are preserved (codex P2 r17)', () => {
    expect(replaceDroughtHypothesis('The thinning is unlikely to be drought stress.')).toBeNull();
    expect(replaceDroughtHypothesis('We ruled out drought stress for the thin patches.')).toBeNull();
  });

  test('"drought stress-related" rewrites as one adjectival phrase (codex P2 r18)', () => {
    expect(replaceDroughtHypothesis('The thinning could be drought stress-related damage.'))
      .toBe('The thinning could be sprinkler-coverage-related damage.');
    expect(replaceDroughtHypothesis('Drought-stress-related thinning is possible near the edge.'))
      .toBe('Sprinkler-coverage-related thinning is possible near the edge.');
  });

  test('a pre-phrase "less likely to be" dismissal is preserved (codex P2 r19)', () => {
    expect(replaceDroughtHypothesis('The thinning is less likely to be drought stress.')).toBeNull();
  });

  test('pre-phrase "due to"/"from" dismissals are preserved (codex P2 r20)', () => {
    expect(replaceDroughtHypothesis('The thinning is less likely due to drought stress.')).toBeNull();
    expect(replaceDroughtHypothesis('The damage is unlikely from drought stress.')).toBeNull();
  });

  test('bare copular pre-phrase dismissals are preserved (codex P2 r21)', () => {
    expect(replaceDroughtHypothesis('The stress was unlikely drought stress.')).toBeNull();
    expect(replaceDroughtHypothesis('The thinning was less likely drought stress.')).toBeNull();
  });

  test('a descriptive "or" before an observed dry area never converts it (codex P2 r21)', () => {
    expect(replaceDroughtHypothesis('Brown or tan patches and dry spots were noted near the sidewalk.')).toBeNull();
  });

  test('coordinated dry-area dismissals stay preserved (codex P2 r23)', () => {
    expect(replaceDroughtHypothesis('The thinning was not due to drought stress or dry spots.')).toBeNull();
  });

  test('comma-delimited dismissal lists stay preserved (codex P2 r27)', () => {
    expect(replaceDroughtHypothesis('The thinning was not due to dry spots, drought stress, or chinch bugs.')).toBeNull();
  });

  test('have-not-been-ruled-out dry areas reconcile with plural grammar (codex P2 r27)', () => {
    expect(replaceDroughtHypothesis('Dry pockets have not been ruled out in the thin turf.'))
      .toBe('Patches of uneven sprinkler coverage have not been ruled out in the thin turf.');
  });

  test('dry-condition hypotheses reconcile (codex P2 r27)', () => {
    expect(replaceDroughtHypothesis('Dry conditions may be contributing to the thinning.'))
      .toBe('Uneven sprinkler coverage may be contributing to the thinning.');
    expect(replaceDroughtHypothesis('The stress may be due to dry conditions near the sidewalk.'))
      .toBe('The stress may be due to uneven sprinkler coverage near the sidewalk.');
  });

  test('unresolved sentence-initial dry areas still reconcile (codex P2 r23)', () => {
    expect(replaceDroughtHypothesis('Dry spots cannot be ruled out near the sidewalk.'))
      .toBe('Uneven sprinkler coverage cannot be ruled out near the sidewalk.');
    expect(replaceDroughtHypothesis('Dry areas remain possible.'))
      .toBe('Patches of uneven sprinkler coverage remain possible.');
  });

  test('negated-belief dismissals are preserved (codex P2 r23)', () => {
    expect(replaceDroughtHypothesis('The thinning is not currently believed to be drought stress.')).toBeNull();
  });

  test('observed drought-stress descriptions are preserved (codex P2 r26)', () => {
    expect(replaceDroughtHypothesis('Drought stress symptoms were noted along the edge.')).toBeNull();
    expect(replaceDroughtHypothesis('Some drought stress damage was observed near the walkway.')).toBeNull();
  });

  test('improving dry pockets are historical, not hypotheses (codex P2 r25)', () => {
    expect(replaceDroughtHypothesis('Dry pockets have improved after this week’s rain.')).toBeNull();
  });

  test('expanded "could not be ruled out" is unresolved and reconciles (codex P2 r28)', () => {
    expect(replaceDroughtHypothesis('Drought stress could not be ruled out in the thin patches.'))
      .toBe('Uneven sprinkler coverage could not be ruled out in the thin patches.');
  });

  test('bare "drought" before a stress noun reads adjectivally (codex P2 r28)', () => {
    expect(replaceDroughtHypothesis('Drought pressure may be contributing to thinning.'))
      .toBe('Sprinkler-coverage-related pressure may be contributing to thinning.');
  });

  test('visible/showing drought stress is an observation and is preserved (codex P2 r29)', () => {
    expect(replaceDroughtHypothesis('Drought stress symptoms are visible along the driveway edge.')).toBeNull();
    expect(replaceDroughtHypothesis('Drought stress was showing in the thin backyard strip.')).toBeNull();
  });

  test('"drought conditions" rewrites as a full phrase (codex P2 r29)', () => {
    expect(replaceDroughtHypothesis('Drought conditions may be contributing to the thinning along the fence.'))
      .toBe('Uneven sprinkler coverage may be contributing to the thinning along the fence.');
    expect(replaceDroughtHypothesis('Thinning along the edge could reflect drought conditions.'))
      .toBe('Thinning along the edge could reflect uneven sprinkler coverage.');
  });

  test('cue-less or observed drought conditions stay preserved (codex P2 r29)', () => {
    expect(replaceDroughtHypothesis('Drought conditions were noted in the thin strip.')).toBeNull();
    expect(replaceDroughtHypothesis('Drought conditions have eased after this week’s rain on the stressed strip.')).toBeNull();
  });

  test('confirmed/present drought stress is preserved (codex P1 r30)', () => {
    expect(replaceDroughtHypothesis('Drought stress was confirmed along the stressed edge.')).toBeNull();
    expect(replaceDroughtHypothesis('Drought stress is present in the thin strip.')).toBeNull();
    expect(replaceDroughtHypothesis('Drought stress is still evident near the walkway patches.')).toBeNull();
    // Pre-phrase observation verbs make the same confirmed-evidence claim.
    expect(replaceDroughtHypothesis('We confirmed drought stress along the thin edge.')).toBeNull();
    // A modal keeps the hypothesis reading — "may be present" still reconciles.
    expect(replaceDroughtHypothesis('Drought stress may be present in the thin areas.'))
      .toBe('Uneven sprinkler coverage may be present in the thin areas.');
  });

  test('an observed clause does not shield a later hypothesis clause (codex P2 r31)', () => {
    expect(replaceDroughtHypothesis(
      'Dry spots were observed near the curb, but dry conditions may be contributing to thinning elsewhere.',
    )).toBe('Dry spots were observed near the curb, but uneven sprinkler coverage may be contributing to thinning elsewhere.');
  });

  test('"not ruled out" is unresolved and still reconciles (codex P2 r25)', () => {
    expect(replaceDroughtHypothesis('Drought stress is not ruled out in the thin patches.'))
      .toBe('Uneven sprinkler coverage is not ruled out in the thin patches.');
    expect(replaceDroughtHypothesis('Drought stress has not been ruled out for the stressed strip.'))
      .toBe('Uneven sprinkler coverage has not been ruled out for the stressed strip.');
  });

  test('possible/potential dry spots are hypotheses (codex P2 r25)', () => {
    expect(replaceDroughtHypothesis('Possible dry spots near the stressed strip.'))
      .toBe('Possible uneven sprinkler coverage near the stressed strip.');
    expect(replaceDroughtHypothesis('Potential dry spots near the sidewalk.'))
      .toBe('Potential uneven sprinkler coverage near the sidewalk.');
  });

  test('"inconsistent with" drought dismissals stay verbatim (codex P2 r24)', () => {
    expect(replaceDroughtHypothesis('The pattern is inconsistent with drought stress.')).toBeNull();
    // The positive hypothesis form still reconciles.
    expect(replaceDroughtHypothesis('Stress that could be consistent with localized drought.'))
      .toMatch(/uneven sprinkler coverage/);
  });

  test('a dry-pocket hypothesis after a negated clause still reconciles (codex P2 r23)', () => {
    expect(replaceDroughtHypothesis('No drought stress, but dry pockets may contribute.'))
      .toBe('No drought stress, but uneven sprinkler coverage may contribute.');
  });

  test('a resolved dry spell is historical, not a hypothesis (codex P2 r20)', () => {
    expect(replaceDroughtHypothesis('Dry spell ended after this week’s heavy rain.')).toBeNull();
  });

  test('sentence-initial dry-spot hypotheses still reconcile (codex P2 r20)', () => {
    expect(replaceDroughtHypothesis('Dry spots could be contributing to the thinning.'))
      .toBe('Uneven sprinkler coverage could be contributing to the thinning.');
    expect(replaceDroughtHypothesis('Dry areas may be stressing the strip.'))
      .toBe('Uneven sprinkler coverage may be stressing the strip.');
  });

  test('a negated dismissal with modifiers still reconciles (codex P2 r18)', () => {
    expect(replaceDroughtHypothesis('Drought stress cannot be completely ruled out in the thin patches.'))
      .toBe('Uneven sprinkler coverage cannot be completely ruled out in the thin patches.');
    expect(replaceDroughtHypothesis('We cannot fully rule out drought stress for the thin patches.'))
      .toBe('We cannot fully rule out uneven sprinkler coverage for the thin patches.');
    // A true dismissal with a modifier still survives verbatim.
    expect(replaceDroughtHypothesis('Drought stress was effectively ruled out for the stressed strip.')).toBeNull();
  });

  test('a direct dry-spot hypothesis passes the prefilter (codex P2 r17)', () => {
    expect(replaceDroughtHypothesis('Could be dry spots near the sidewalk.'))
      .toBe('Could be uneven sprinkler coverage near the sidewalk.');
  });

  test('drought-resistance praise stays verbatim (codex P2 r14)', () => {
    expect(replaceDroughtHypothesis('This stressed cultivar has strong drought resistance.')).toBeNull();
    expect(replaceDroughtHypothesis('The stressed sod is drought resistant.')).toBeNull();
  });

  test('non-hyphenated "drought stress symptoms/signs" reads adjectivally (codex P2 r10)', () => {
    // "may be developing", not "are showing": visible/showing continuations
    // are technician observations and are preserved outright (codex P2 r29).
    expect(replaceDroughtHypothesis('Drought stress symptoms may be developing in the thin areas.'))
      .toBe('Sprinkler-coverage-related symptoms may be developing in the thin areas.');
    // The plain noun form keeps the noun replacement.
    expect(replaceDroughtHypothesis('No pests were seen; drought stress remains possible in the thin areas.'))
      .toMatch(/uneven sprinkler coverage remains possible/);
  });

  test('hyphenated drought-stress forms are covered (codex P2 r9)', () => {
    expect(replaceDroughtHypothesis('The thin strip is possibly drought-stressed.'))
      .toBe('The thin strip is possibly sprinkler-coverage-related.');
    // Non-observation continuation — see the r29 note in the test above.
    expect(replaceDroughtHypothesis('Drought-stress symptoms may be developing in the thin areas.'))
      .toBe('Sprinkler-coverage-related symptoms may be developing in the thin areas.');
    // Tolerance praise still survives in hyphenated proximity.
    expect(replaceDroughtHypothesis('This stressed cultivar shows drought-stress tolerance.')).toBeNull();
    expect(replaceDroughtHypothesis('This stressed cultivar is drought stress-tolerant.')).toBeNull();
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

  test('the lawn assessment the assistant answers from is reconciled too (codex P2 r22)', () => {
    const input = base();
    input.data.lawnAssessment.customerSummary = 'Thinning tan patches could be chinch bug activity or a dry pocket.';
    input.data.lawnAssessment.snapshot = {
      summary: 'Recent rainfall totaling 2.72 inches raised pressure, and thin areas could be drought stress.',
      nextWatchItems: ['Recheck the thin strip for chinch bug or drought stress.'],
      findings: [{ customerCopy: 'Stress that could be consistent with localized drought.' }],
    };
    const fix = reconcileLawnReport(input);
    expect(fix.lawnAssessment.customerSummary).toMatch(/uneven sprinkler coverage/);
    expect(fix.lawnAssessment.snapshot.summary).toMatch(/totaling 2\.96 inches/);
    expect(fix.lawnAssessment.snapshot.summary).toMatch(/uneven sprinkler coverage/);
    expect(fix.lawnAssessment.snapshot.nextWatchItems[0]).toMatch(/uneven sprinkler coverage/);
    expect(fix.lawnAssessment.snapshot.findings[0].customerCopy).toMatch(/uneven sprinkler coverage/);
    // An untouched assessment returns null (keep what the payload has).
    const clean = base();
    clean.data.lawnAssessment = { customerSummary: 'The lawn is thickening nicely.' };
    expect(reconcileLawnReport(clean).lawnAssessment).toBeNull();
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
