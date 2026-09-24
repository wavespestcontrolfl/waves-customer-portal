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

test('independentStressFloor reads only insect/drought/mechanical severities, never fungus/thatch', () => {
  const quiet = { status: 'complete', severities: JSON.stringify({ fungal_activity: sig('severe'), insect_damage: sig('unknown', 'unknown', ''), drought_stress: sig('unknown', 'unknown', ''), mechanical_damage: sig('none') }) };
  expect(visit.independentStressFloor(quiet)).toBe(visit.independentStressFloor({ severities: JSON.stringify({ mechanical_damage: sig('none') }) }));
  const insects = { ...quiet, severities: JSON.stringify({ fungal_activity: sig('severe'), insect_damage: sig('moderate'), drought_stress: sig('unknown', 'unknown', '') }) };
  expect(visit.independentStressFloor(insects)).toBe(50);
  expect(visit.independentStressFloor({ status: 'complete', severities: JSON.stringify({ fungal_activity: sig('minor') }) })).toBeNull();
});

// Owner ruling 2026-09-24: lawn health scores are READ-ONLY from photos. A
// technician's adjustedScores override is honored ONLY for a key the AI left
// unknown (null) — a blank AI read is the one thing they may fill in. A key
// the AI DID determine is authoritative no matter what the client posts.
describe('confirm scores are read-only from the AI; a blank AI read is the one fillable exception', () => {
  const scoreValue = (value) => Math.max(0, Math.min(100, Math.round(Number(value))));

  describe('resolveConfirmScores — legacy / no-run path (the assessment row IS the AI read)', () => {
    test('an AI-known score ignores any override; a NULL column stays NULL unless the technician fills it', () => {
      const assessment = { turf_density: 72, weed_suppression: null, color_health: null, fungus_control: 75, thatch_level: null, stress_damage: null };
      expect(visit.resolveConfirmScores(assessment, undefined, scoreValue)).toEqual({
        turf_density: 72, weed_suppression: null, color_health: null, fungus_control: 75, thatch_level: null, stress_damage: 75,
      });
      // turf_density/fungus_control are AI-known (72/75) — the override is ignored.
      expect(visit.resolveConfirmScores(assessment, { turf_density: 10, fungus_control: 5, color_health: '81', stress_damage: 40 }, scoreValue))
        .toMatchObject({ turf_density: 72, fungus_control: 75, color_health: 81, stress_damage: 40, weed_suppression: null });
      // A blank or malformed override never becomes a 0 — it falls back to the stored value, as before this ruling.
      expect(visit.resolveConfirmScores(assessment, { turf_density: ' ', fungus_control: 'abc', stress_damage: 'x' }, scoreValue)).toMatchObject({ turf_density: 72, fungus_control: 75, stress_damage: 75 });
      const nothing = visit.resolveConfirmScores({ turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null }, {}, scoreValue);
      expect(nothing).toEqual({ turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null });
      expect(visit.scoresComplete(nothing)).toBe(false);
    });

    test('stress_damage can\'t be moved once the AI produced it, even via a fungus/thatch edit', () => {
      const assessment = { turf_density: 70, weed_suppression: 80, color_health: 70, fungus_control: 20, thatch_level: 85, stress_damage: 20 };
      expect(visit.resolveConfirmScores(assessment, {}, scoreValue).stress_damage).toBe(20);
      // fungus_control is AI-known (20) so its override is ignored too, giving
      // the tech no back door into re-deriving a fixed stress_damage.
      expect(visit.resolveConfirmScores(assessment, { fungus_control: 90, stress_damage: 5 }, scoreValue)).toMatchObject({ fungus_control: 20, stress_damage: 20 });
    });

    test('a genuinely AI-blank stress_damage derives from the picked (possibly tech-filled) components, and a direct fill sticks', () => {
      const assessment = { turf_density: 70, weed_suppression: 80, color_health: 70, fungus_control: null, thatch_level: null, stress_damage: null };
      expect(visit.resolveConfirmScores(assessment, {}, scoreValue).stress_damage).toBeNull();
      expect(visit.resolveConfirmScores(assessment, { fungus_control: 40, thatch_level: 90 }, scoreValue).stress_damage).toBe(40);
      expect(visit.resolveConfirmScores(assessment, { stress_damage: 65 }, scoreValue).stress_damage).toBe(65);
      // Once a fill is stored on the row, a later save that omits it keeps
      // it rather than re-deriving from a since-filled component.
      const afterFill = { ...assessment, stress_damage: 65 };
      expect(visit.resolveConfirmScores(afterFill, { fungus_control: 10 }, scoreValue)).toMatchObject({ fungus_control: 10, stress_damage: 65 });
    });
  });

  describe('confirmScores — run-backed path (the immutable scores_adjusted snapshot is the AI read)', () => {
    test('an override on an AI-known key is ignored; the one blank AI key accepts the fill', () => {
      const assessment = { turf_density: 72, weed_suppression: 80, color_health: null, fungus_control: 75, thatch_level: 60, stress_damage: 50 };
      const run = { status: 'complete', severities: { drought_stress: sig('moderate') }, scores_adjusted: { ...assessment } };
      const options = { scoreValue, calculateOverallScore: () => 77 };
      const filled = visit.confirmScores(assessment, run, { color_health: 70, turf_density: 999, fungus_control: 1 }, options);
      expect(filled).toMatchObject({
        confirmed: true, missing: [],
        finalScores: { turf_density: 72, weed_suppression: 80, color_health: 70, fungus_control: 75, thatch_level: 60, stress_damage: 50 },
      });
    });

    test('stress_damage can\'t be moved when the AI produced it, even via a fungus/thatch edit', () => {
      const assessment = { turf_density: 70, weed_suppression: 80, color_health: 70, fungus_control: 20, thatch_level: 85, stress_damage: 20 };
      const run = { status: 'complete', severities: JSON.stringify({ insect_damage: sig('moderate') }), scores_adjusted: { ...assessment } };
      const options = { scoreValue, calculateOverallScore: () => 77 };
      expect(visit.confirmScores(assessment, run, { fungus_control: 90, stress_damage: 5 }, options).finalScores)
        .toMatchObject({ fungus_control: 20, stress_damage: 20 });
    });

    test('a fully AI-blank run derives stress_damage from the technician-filled components and the run\'s independent stressors', () => {
      const assessment = { turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null };
      const insects = {
        status: 'complete',
        severities: JSON.stringify({ fungal_activity: sig('unknown', 'unknown', ''), insect_damage: sig('moderate'), drought_stress: sig('unknown', 'unknown', ''), mechanical_damage: sig('unknown', 'unknown', '') }),
        scores_adjusted: JSON.stringify({ ...assessment }),
      };
      const options = { scoreValue, calculateOverallScore: () => 77 };
      expect(visit.independentStressFloor(insects)).toBe(50);
      // The independent (insect) stressor floors Stress even though the
      // technician's own fungus/thatch fills were both higher.
      const filled = visit.confirmScores(assessment, insects, { turf_density: 70, weed_suppression: 80, color_health: 70, fungus_control: 90, thatch_level: 85 }, options);
      expect(filled.finalScores.stress_damage).toBe(50);
      expect(filled.confirmed).toBe(true);
    });

    test('an auto-derived (never explicit) stress_damage re-derives after a component correction, while an explicit fill sticks (Codex P1 2026-09-24)', () => {
      const options = { scoreValue, calculateOverallScore: () => 77 };
      const run = {
        status: 'complete',
        scores_adjusted: JSON.stringify({ turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null }),
      };
      let assessment = { turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null, adjusted_scores: null };
      const persist = (decision) => ({
        ...assessment, ...decision.finalScores,
        adjusted_scores: JSON.stringify({ ...decision.finalScores, stress_damage_explicit: decision.stressExplicit }),
      });

      // Save 1: fill fungus=80 only — Stress auto-derives to 80 (the only
      // known component), but this was never an explicit entry.
      const first = visit.confirmScores(assessment, run, { fungus_control: 80 }, options);
      expect(first.finalScores).toMatchObject({ fungus_control: 80, stress_damage: 80 });
      expect(first.stressExplicit).toBeNull();
      assessment = persist(first);

      // Save 2: correct fungus down to 40 and fill thatch=90 — Stress MUST
      // re-derive to 40, not stay frozen at the earlier auto-derived 80
      // (this was the reported bug: preserving any previously saved value,
      // including one automatically derived, prevented this correction).
      const second = visit.confirmScores(assessment, run, { fungus_control: 40, thatch_level: 90 }, options);
      expect(second.finalScores.stress_damage).toBe(40);
      expect(second.stressExplicit).toBeNull();
      assessment = persist(second);

      // Save 3: the technician now directly enters Stress=65 — an explicit
      // fill, recorded as such.
      const third = visit.confirmScores(assessment, run, { stress_damage: 65 }, options);
      expect(third.finalScores.stress_damage).toBe(65);
      expect(third.stressExplicit).toBe(65);
      assessment = persist(third);

      // Save 4: a further component edit without resending Stress — the
      // EXPLICIT 65 sticks, unlike the earlier auto-derived value.
      const fourth = visit.confirmScores(assessment, run, { color_health: 70 }, options);
      expect(fourth.finalScores.stress_damage).toBe(65);
    });

    test('posting a fill as null clears it; omitting it keeps it', () => {
      const options = { scoreValue, calculateOverallScore: () => 77 };
      const blank = { turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null };
      const run = { status: 'complete', scores_adjusted: JSON.stringify(blank) };
      const saved = { ...blank, fungus_control: 60, stress_damage: 40, adjusted_scores: JSON.stringify({ stress_damage_explicit: 40 }) };
      expect(visit.confirmScores(saved, run, {}, options).finalScores).toMatchObject({ fungus_control: 60, stress_damage: 40 });
      const clearedFill = visit.confirmScores(saved, run, { fungus_control: null, stress_damage: null }, options);
      expect(clearedFill.finalScores.fungus_control).toBeNull();
      expect(clearedFill.stressExplicit).toBeNull();
    });

    test('a Stress entry saved before this change (run.reconciliation.stress_damage_override) still sticks', () => {
      const options = { scoreValue, calculateOverallScore: () => 77 };
      const blank = { turf_density: null, weed_suppression: null, color_health: null, fungus_control: null, thatch_level: null, stress_damage: null };
      const run = { status: 'complete', scores_adjusted: JSON.stringify(blank), reconciliation: JSON.stringify({ stress_damage_override: 55 }) };
      const assessment = { ...blank, fungus_control: 90, thatch_level: 85, stress_damage: 55, adjusted_scores: null };
      const decision = visit.confirmScores(assessment, run, { turf_density: 70 }, options);
      expect(decision.finalScores.stress_damage).toBe(55);
      expect(decision.stressExplicit).toBe(55);
    });

    test('an incomplete/snapshot-less run has no immutable AI read to enforce, so its keys stay editable (unchanged legacy-style fallback)', () => {
      const assessment = { turf_density: 70, weed_suppression: 80, color_health: 70, fungus_control: 20, thatch_level: 85, stress_damage: 20 };
      const quiet = { status: 'complete', scores_raw: '{}', severities: JSON.stringify({ fungal_activity: sig('severe'), insect_damage: sig('unknown', 'unknown', ''), drought_stress: sig('unknown', 'unknown', ''), mechanical_damage: sig('none') }) };
      expect(visit.runAiScores(quiet)).toEqual({});
      const corrected = visit.confirmScores(assessment, quiet, { fungus_control: 90 }, { scoreValue, calculateOverallScore: () => 77 });
      expect(corrected.finalScores).toMatchObject({ fungus_control: 90, thatch_level: 85 });
      expect(corrected.calibrationEligible).toBe(false);
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
      // the overall inputs can all be known while a sub-score the AI also left unknown is not — still pending
      const thatchStillUnknown = { ...run, scores_adjusted: JSON.stringify({ turf_density: 70, weed_suppression: 80, color_health: 70, fungus_control: 75, thatch_level: null, stress_damage: 60 }) };
      const subScoreMissing = visit.confirmScores({ ...assessment, color_health: 70, thatch_level: null }, thatchStillUnknown, {}, { scoreValue, calculateOverallScore: () => 77 });
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
  });
});
