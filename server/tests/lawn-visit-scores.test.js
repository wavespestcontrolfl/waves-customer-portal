const visit = require('../services/lawn-visit-scores');
const { NO_OBSERVATIONS } = require('../services/lawn-visit-customer-copy');
const { UNAVAILABLE_OBSERVATIONS } = require('../services/lawn-visit-result');
const { sig, sev, complete } = require('./helpers/lawn-visit-fixtures');

describe('legacy score derivation', () => {
  test('preserves the existing units and derives stress from the worst known signal', () => {
    const result = visit.deriveLegacyScores(complete(
      sev({ fungal_activity: 'minor', insect_damage: 'unknown', drought_stress: 'moderate', mechanical_damage: 'none', thatch_visibility: 'moderate', overwatering_signal: 'yes' }),
      { turf_density: 72, weed_coverage: 15, color_health: 8 },
    ));
    expect(result).toEqual({
      turf_density: 72, weed_suppression: 85, color_health: 80,
      fungus_control: 75, thatch_level: 60, stress_damage: 50,
      overwatering_signal: true, drought_stress: 'moderate', observations: NO_OBSERVATIONS,
    });
  });

  test('unknown signals and unavailable analysis never become healthy defaults', () => {
    const result = visit.deriveLegacyScores(complete(
      sev({ fungal_activity: 'unknown', insect_damage: 'unknown', drought_stress: 'unknown', mechanical_damage: 'unknown', thatch_visibility: 'unknown', overwatering_signal: 'unknown' }),
      { turf_density: null, weed_coverage: 20, color_health: null },
    ));
    expect(result).toMatchObject({ turf_density: null, weed_suppression: 80, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null, drought_stress: null, overwatering_signal: false });
    expect(visit.deriveLegacyScores({ status: 'unavailable' })).toBeNull();
    expect(visit.deriveLegacyScores(null)).toBeNull();
  });

  test('keeps raw model prose off the assessment fields before technician review', () => {
    const analysis = { ...complete(sev({}), {}), observations: 'Private field notes that must stay internal.' };
    const scores = visit.deriveLegacyScores(analysis);
    const fields = visit.assessmentScoreFields({ displayScores: scores, adjustedScores: scores, overallScore: null });
    expect(fields.observations).toBe(NO_OBSERVATIONS);
    expect(fields.composite_scores).not.toContain(analysis.observations);
    expect(fields.adjusted_scores).not.toContain(analysis.observations);
    expect(analysis.observations).toBe('Private field notes that must stay internal.');
    expect(visit.assessmentScoreFields({ displayScores: null, adjustedScores: null, overallScore: null })).toMatchObject({ observations: UNAVAILABLE_OBSERVATIONS, turf_density: null, stress_damage: null, overall_score: null });
  });

  test('seasonal adjustment sees only known numeric scores and cannot fill unknowns', () => {
    const adjust = jest.fn((scores) => ({ ...scores, turf_density: scores.turf_density + 7, color_health: 0, weed_suppression: NaN }));
    const adjusted = visit.adjustAvailableScores({ turf_density: 70, weed_suppression: 80, color_health: null, observations: NO_OBSERVATIONS, overwatering_signal: false }, adjust);
    expect(adjust).toHaveBeenCalledWith({ turf_density: 70, weed_suppression: 80 });
    expect(adjusted).toEqual({ turf_density: 77, weed_suppression: 80, color_health: null, observations: NO_OBSERVATIONS, overwatering_signal: false });
    expect(visit.adjustAvailableScores(null, adjust)).toBeNull();
  });

  test('overall scoring needs four known inputs while confirmation needs all six', () => {
    const four = { turf_density: 70, weed_suppression: 80, color_health: 75, stress_damage: 50 };
    expect(visit.overallInputsComplete(four)).toBe(true);
    expect(visit.scoresComplete(four)).toBe(false);
    expect(visit.missingScores(four)).toEqual(['fungus_control', 'thatch_level']);
    expect(visit.scoresComplete({ ...four, fungus_control: 75, thatch_level: 85 })).toBe(true);
    expect(visit.overallInputsComplete({ ...four, stress_damage: null })).toBe(false);
    expect(visit.missingScores(null)).toEqual(visit.SCORE_KEYS);
  });

  test('scoreVisit applies the seasonal adjustment once and skips incomplete overall scores', () => {
    const analysis = { ...complete(sev({ fungal_activity: 'minor', insect_damage: 'none', drought_stress: 'none', mechanical_damage: 'none', thatch_visibility: 'low' }), { turf_density: 70, weed_coverage: 20, color_health: 8 }), photoQuality: [{ photo: 1, quality: 'adequate' }] };
    const seasonAdjust = jest.fn((scores) => ({ ...scores, turf_density: scores.turf_density + 7 }));
    const calculateOverallScore = jest.fn(() => 88);
    const result = visit.scoreVisit(analysis, { seasonAdjust, calculateOverallScore });
    expect(result).toMatchObject({ adjustedScores: { turf_density: 77 }, overallScore: 88, analyzedCount: 1 });
    expect(seasonAdjust).toHaveBeenCalledTimes(1);
    expect(calculateOverallScore).toHaveBeenCalledWith(result.adjustedScores);
    calculateOverallScore.mockClear();
    expect(visit.scoreVisit({ ...analysis, scores: { ...analysis.scores, color_health: null } }, { seasonAdjust, calculateOverallScore }).overallScore).toBeNull();
    expect(visit.scoreVisit({ status: 'unavailable' }, { seasonAdjust, calculateOverallScore })).toMatchObject({ displayScores: null, adjustedScores: null, overallScore: null, analyzedCount: 0 });
    expect(calculateOverallScore).not.toHaveBeenCalled();
  });
});

describe('confirm scores preserve NULLs', () => {
  const scoreValue = (value) => Math.max(0, Math.min(100, Math.round(Number(value))));

  test('a saved manual stress correction survives filling another missing score', () => {
    const assessment = { turf_density: 72, weed_suppression: 80, color_health: null, fungus_control: 75, thatch_level: 60, stress_damage: 50 };
    const run = { status: 'complete', severities: { drought_stress: sig('moderate') }, scores_adjusted: { ...assessment } };
    const options = { scoreValue, calculateOverallScore: () => 77 };
    const partial = visit.confirmScores(assessment, run, { stress_damage: 90 }, options);
    expect(partial).toMatchObject({ confirmed: false, stressOverride: 90, finalScores: { stress_damage: 90 } });
    const saved = { ...assessment, ...partial.finalScores };
    const savedRun = { ...run, reconciliation: JSON.stringify({ stress_damage_override: partial.stressOverride }) };
    const later = visit.confirmScores(saved, savedRun, { color_health: 70 }, options);
    expect(later).toMatchObject({ confirmed: true, stressOverride: 90, finalScores: { stress_damage: 90 } });
    expect(later.aiScores.stress_damage).toBe(50);
    // A full form can repeat unchanged component scores without clearing the correction.
    expect(visit.confirmScores(saved, savedRun, { color_health: 70, fungus_control: 75, thatch_level: 60 }, options).stressOverride).toBe(90);
    expect(visit.confirmScores({ ...saved, fungus_control: '75', thatch_level: '60' }, savedRun, { color_health: 70, fungus_control: 75, thatch_level: 60 }, options).stressOverride).toBe(90);
    // A changed component intentionally requests a new derivation when stress is omitted.
    const revised = visit.confirmScores(saved, savedRun, { color_health: 70, fungus_control: 40 }, options);
    expect(revised).toMatchObject({ stressOverride: null, finalScores: { stress_damage: 40 } });
    // Explicit zero is a saved correction too.
    const zero = visit.confirmScores(saved, savedRun, { stress_damage: 0 }, options);
    expect(zero).toMatchObject({ stressOverride: 0, finalScores: { stress_damage: 0 } });
    expect(visit.confirmScores({ ...saved, ...zero.finalScores }, { ...savedRun, reconciliation: { stress_damage_override: 0 } }, { color_health: 70 }, options).finalScores.stress_damage).toBe(0);
  });

  test('a NULL column stays NULL unless the technician entered a value; stress derives from the known values only', () => {
    const assessment = { turf_density: 72, weed_suppression: null, color_health: null, fungus_control: 75, thatch_level: null, stress_damage: null };
    expect(visit.resolveConfirmScores(assessment, undefined, scoreValue)).toEqual({
      turf_density: 72, weed_suppression: null, color_health: null, fungus_control: 75, thatch_level: null, stress_damage: 75,
    });
    expect(visit.resolveConfirmScores(assessment, { color_health: '81', stress_damage: 40 }, scoreValue)).toMatchObject({ color_health: 81, stress_damage: 40, weed_suppression: null });
    // A blank or malformed override never becomes a 0 — it falls back to the stored value, as the legacy path does.
    expect(visit.resolveConfirmScores(assessment, { turf_density: ' ', fungus_control: 'abc', stress_damage: 'x' }, scoreValue)).toMatchObject({ turf_density: 72, fungus_control: 75, stress_damage: 75 });
    const nothing = visit.resolveConfirmScores({ turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null }, {}, scoreValue);
    expect(nothing).toEqual({ turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null });
    expect(visit.scoresComplete(nothing)).toBe(false);
  });

  test('confirmScores decides scores, overall, whether the row confirms and what calibration compares against, in one call', () => {
    const assessment = { turf_density: 72, weed_suppression: 80, color_health: null, fungus_control: 75, thatch_level: 60, stress_damage: 50 };
    const scoresRaw = JSON.stringify({ turf_density: 70, weed_coverage: 20, color_health: null });
    const severities = JSON.stringify({ fungal_activity: sig('minor'), thatch_visibility: sig('moderate'), drought_stress: sig('unknown', 'unknown', '') });
    const run = { status: 'complete', scores_raw: scoresRaw, severities, scores_adjusted: JSON.stringify({ turf_density: 70, weed_suppression: 80, color_health: null, fungus_control: 75, thatch_level: 60, stress_damage: 60 }) };
    const partial = visit.confirmScores(assessment, run, {}, { scoreValue, calculateOverallScore: () => 77 });
    expect(partial.finalScores.color_health).toBeNull();
    expect(partial.overallScore).toBeNull();
    // one score missing → the row stays pending: nothing customer-facing, no calibration
    expect(partial).toMatchObject({ confirmed: false, missing: ['color_health'], calibrationEligible: false });
    const filled = visit.confirmScores(assessment, run, { color_health: 70 }, { scoreValue, calculateOverallScore: () => 77 });
    expect(filled).toMatchObject({ overallScore: 77, confirmed: true, missing: [], calibrationEligible: true });
    // the AI baseline is the run's own snapshot in legacy units — not the assessment row
    expect(filled.aiScores).toEqual({ turf_density: 70, weed_suppression: 80, color_health: null, fungus_control: 75, thatch_level: 60, stress_damage: 60 });
    // …the snapshot is REQUIRED: a complete run without scores_adjusted is not comparable (never derived from the raw answer)
    const snapshot = { ...run, scores_adjusted: JSON.stringify({ turf_density: 77, weed_suppression: 80, color_health: null, fungus_control: 75, thatch_level: 60, stress_damage: 60 }) };
    expect(visit.confirmScores(assessment, snapshot, { color_health: 70 }, { scoreValue, calculateOverallScore: () => 77 }).aiScores).toEqual({ turf_density: 77, weed_suppression: 80, color_health: null, fungus_control: 75, thatch_level: 60, stress_damage: 60 });
    expect(visit.runAiScores({ ...run, scores_adjusted: null })).toEqual({});
    expect(visit.confirmScores(assessment, { ...run, scores_adjusted: null }, { color_health: 70 }, { scoreValue, calculateOverallScore: () => 77 })).toMatchObject({ confirmed: true, calibrationEligible: false });
    // the overall inputs can all be known while a sub-score is not — still pending
    const subScoreMissing = visit.confirmScores({ ...assessment, color_health: 70, thatch_level: null }, run, {}, { scoreValue, calculateOverallScore: () => 77 });
    expect(subScoreMissing).toMatchObject({ overallScore: 77, confirmed: false, missing: ['thatch_level'], calibrationEligible: false });
    const unavailable = visit.confirmScores({ turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null }, { status: 'unavailable', scores_raw: null, severities: null }, {}, { scoreValue, calculateOverallScore: () => 77 });
    expect(unavailable).toMatchObject({ overallScore: null, confirmed: false, calibrationEligible: false, aiScores: {} });
    expect(unavailable.missing).toEqual(visit.SCORE_KEYS);
    // an unavailable run the technician scored by hand confirms, but has no AI scores to calibrate against
    const handScored = visit.confirmScores(assessment, { status: 'unavailable', scores_raw: null, severities: null }, { color_health: 70 }, { scoreValue, calculateOverallScore: () => 77 });
    expect(handScored).toMatchObject({ confirmed: true, calibrationEligible: false });
    // a complete run that could determine nothing (every score undeterminable, every severity unknown) is not comparable either
    const blank = { status: 'complete', scores_raw: JSON.stringify({ turf_density: null, weed_coverage: null, color_health: null }), severities: JSON.stringify({ fungal_activity: sig('unknown', 'unknown', ''), thatch_visibility: sig('unknown', 'unknown', '') }), scores_adjusted: JSON.stringify({ turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null }) };
    const noBaseline = visit.confirmScores(assessment, blank, { color_health: 70 }, { scoreValue, calculateOverallScore: () => 77 });
    expect(noBaseline).toMatchObject({ confirmed: true, calibrationEligible: false });
    expect(Object.values(noBaseline.aiScores).every((value) => value == null)).toBe(true);
  });

  test('the stress floor is the run\'s independent stressors: a corrected fungus or thatch re-derives stress, the stored AI stress is not a permanent floor', () => {
    const assessment = { turf_density: 70, weed_suppression: 80, color_health: 70, fungus_control: 20, thatch_level: 85, stress_damage: 20 };
    // No run (legacy fallback): the stored value still bounds the derivation.
    expect(visit.resolveConfirmScores(assessment, {}, scoreValue).stress_damage).toBe(20);
    expect(visit.resolveConfirmScores(assessment, { fungus_control: 90 }, scoreValue).stress_damage).toBe(20);
    // A run whose independent stressors are unknown: fungus was the sole source of the AI stress, so raising it raises stress.
    const quiet = { status: 'complete', scores_raw: '{}', severities: JSON.stringify({ fungal_activity: sig('severe'), insect_damage: sig('unknown', 'unknown', ''), drought_stress: sig('unknown', 'unknown', ''), mechanical_damage: sig('none') }) };
    expect(visit.independentStressFloor(quiet)).toBe(visit.independentStressFloor({ severities: JSON.stringify({ mechanical_damage: sig('none') }) }));
    const corrected = visit.confirmScores(assessment, quiet, { fungus_control: 90 }, { scoreValue, calculateOverallScore: () => 77 });
    expect(corrected.finalScores).toMatchObject({ fungus_control: 90, thatch_level: 85 });
    expect(corrected.finalScores.stress_damage).toBe(Math.min(85, visit.independentStressFloor(quiet)));
    // An independent stressor the technician cannot correct through fungus / thatch still floors it.
    const insects = { ...quiet, severities: JSON.stringify({ fungal_activity: sig('severe'), insect_damage: sig('moderate'), drought_stress: sig('unknown', 'unknown', '') }) };
    expect(visit.independentStressFloor(insects)).toBe(50);
    expect(visit.confirmScores(assessment, insects, { fungus_control: 90 }, { scoreValue, calculateOverallScore: () => 77 }).finalScores.stress_damage).toBe(50);
    // An explicit correction always wins.
    expect(visit.confirmScores(assessment, insects, { stress_damage: 95 }, { scoreValue, calculateOverallScore: () => 77 }).finalScores.stress_damage).toBe(95);
    // A run that rated no independent stressor: stress is the worst of the corrected components alone.
    expect(visit.independentStressFloor({ status: 'complete', severities: JSON.stringify({ fungal_activity: sig('minor') }) })).toBeNull();
    expect(visit.confirmScores(assessment, { status: 'complete', scores_raw: '{}', severities: JSON.stringify({ fungal_activity: sig('minor') }) }, { fungus_control: 90 }, { scoreValue, calculateOverallScore: () => 77 }).finalScores.stress_damage).toBe(85);
    expect(visit.scoresComplete(visit.resolveConfirmScores(assessment, {}, scoreValue))).toBe(true);
  });
});
