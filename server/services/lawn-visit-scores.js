/** Legacy-unit lawn scores, explicit unknowns, and confirmation/calibration rules. */
const { FUNGUS_DISPLAY, THATCH_DISPLAY } = require('./lawn-assessment');
const { UNAVAILABLE_OBSERVATIONS, compositeFor } = require('./lawn-visit-result');
const { NO_OBSERVATIONS } = require('./lawn-visit-customer-copy');

const OVERALL_INPUTS = ['turf_density', 'weed_suppression', 'color_health', 'stress_damage'];
const SCORE_KEYS = [...OVERALL_INPUTS, 'fungus_control', 'thatch_level'];

const knownLevel = (level, map) => (level && level !== 'unknown' && map[level] != null ? map[level] : null);

/**
 * The six legacy columns in their existing units, derived from the run's
 * scores and severities — NULL where the model could not determine a value.
 * stress_damage is the worst KNOWN stressor; an unknown signal never counts as
 * the healthy 95 default computeStressDamageDisplay gives a missing one.
 */
function deriveLegacyScores(analysis) {
  if (!analysis || analysis.status !== 'complete') return null;
  const { scores, severities } = analysis;
  const level = (key) => severities?.[key]?.level;
  const fungus = knownLevel(level('fungal_activity'), FUNGUS_DISPLAY);
  const thatch = knownLevel(level('thatch_visibility'), THATCH_DISPLAY);
  const stressParts = [fungus, thatch, ...['insect_damage', 'drought_stress', 'mechanical_damage'].map((key) => knownLevel(level(key), FUNGUS_DISPLAY))]
    .filter((value) => value != null);
  const drought = level('drought_stress');
  return {
    turf_density: scores.turf_density ?? null,
    weed_suppression: scores.weed_coverage == null ? null : 100 - scores.weed_coverage,
    color_health: scores.color_health == null ? null : Math.round(scores.color_health * 10),
    fungus_control: fungus,
    thatch_level: thatch,
    stress_damage: stressParts.length ? Math.min(...stressParts) : null,
    overwatering_signal: level('overwatering_signal') === 'yes',
    drought_stress: drought && drought !== 'unknown' ? drought : null,
    // Model prose stays on the internal run until technician review.
    observations: NO_OBSERVATIONS,
  };
}

function adjustAvailableScores(scores, adjust) {
  if (!scores) return null;
  const numeric = {};
  for (const [key, value] of Object.entries(scores)) {
    if (typeof value === 'number' && Number.isFinite(value)) numeric[key] = value;
  }
  const adjusted = adjust(numeric) || {};
  const out = { ...scores };
  for (const key of Object.keys(numeric)) out[key] = Number.isFinite(adjusted[key]) ? adjusted[key] : numeric[key];
  return out;
}

const known = (value) => typeof value === 'number' && Number.isFinite(value);
const numericOverride = (value) => known(value) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
// The overall score needs its four inputs.
function overallInputsComplete(scores) {
  return !!scores && OVERALL_INPUTS.every((key) => known(scores[key]));
}
// A confirmed, customer-facing row needs all six.
function scoresComplete(scores) {
  return !!scores && SCORE_KEYS.every((key) => known(scores[key]));
}
function missingScores(scores) {
  return SCORE_KEYS.filter((key) => !known(scores?.[key]));
}

// The lawn_assessments insert fields the gate-on path writes in place of the
// legacy raw/composite/score block. The raw output lives on the run row.
function assessmentScoreFields({ displayScores, adjustedScores, overallScore }) {
  const scores = adjustedScores || {};
  return {
    claude_raw: null,
    gemini_raw: null,
    composite_scores: displayScores ? JSON.stringify(displayScores) : null,
    adjusted_scores: adjustedScores ? JSON.stringify(adjustedScores) : null,
    divergence_flags: JSON.stringify([]),
    turf_density: scores.turf_density ?? null,
    weed_suppression: scores.weed_suppression ?? null,
    color_health: scores.color_health ?? null,
    fungus_control: scores.fungus_control ?? null,
    thatch_level: scores.thatch_level ?? null,
    stress_damage: scores.stress_damage ?? null,
    observations: scores.observations || UNAVAILABLE_OBSERVATIONS,
    overall_score: overallScore ?? null,
  };
}

const parseJsonObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
};

function independentStressFloor(run) {
  const severities = parseJsonObject(run?.severities);
  if (!severities) return null;
  const parts = ['insect_damage', 'drought_stress', 'mechanical_damage']
    .map((key) => knownLevel(severities[key]?.level, FUNGUS_DISPLAY))
    .filter((value) => value != null);
  return parts.length ? Math.min(...parts) : null;
}

// Owner ruling 2026-10-04 (replaces the 2026-09-24 read-only ruling): the
// technician may change any score after the AI read renders, until the
// assessment is confirmed. A score resolves in this order:
//   1. a number posted in this request (`adjustedScores`);
//   2. the value already saved on the assessment row — the AI read /assess
//      wrote, or the technician's entry from an earlier partial save (the
//      client posts only the keys typed in this session, so an omitted key
//      must keep an earlier entry);
//   3. the AI's own read.
// A key posted as null/blank is an explicit clear: it goes back to the AI's
// read (unknown when the AI had none). "The AI's read" is the run's immutable
// `scores_adjusted` snapshot (`aiScores`, from `runAiScores`) when a run
// exists; without one (`aiScores` omitted) the assessment row's stored value
// stands in for it. The snapshot is never rewritten, so calibration always
// compares the technician's final scores against what the AI actually read.
//
// stress_damage (Condition) follows the same order, except that its "saved
// entry" is `stressExplicit`, never the row column: while the AI left it
// blank the column may only hold a PREVIOUS auto-derivation from then-current
// components, and treating that as an entry would freeze a stale answer
// (Codex P1 2026-09-24). `stressExplicit` is this request's own entry or the
// persisted marker of an earlier one (see confirmScores). With no entry and
// no AI read, Condition is re-derived fresh from the known components plus
// `stressFloor`, the run's INDEPENDENT stressors (insect/drought/mechanical);
// `undefined` (no run) leaves the floor out.
function resolveConfirmScores(assessment, adjustedScores, scoreValue, { stressFloor, aiScores, stressExplicit } = {}) {
  const adjusted = adjustedScores && typeof adjustedScores === 'object' ? adjustedScores : {};
  const ai = aiScores && typeof aiScores === 'object' ? aiScores : null;
  const present = (value) => value != null && value !== '';
  // An override counts only when it is a finite number (or a non-blank string
  // that parses to one) — a blank, whitespace or malformed value is a clear,
  // never a 0.
  const cleared = (key) => Object.prototype.hasOwnProperty.call(adjusted, key) && !numericOverride(adjusted[key]);
  const stored = (key) => (present(assessment[key]) ? scoreValue(assessment[key]) : null);
  const aiRead = (key) => {
    if (!ai) return stored(key);
    return known(ai[key]) ? scoreValue(ai[key]) : null;
  };
  const pick = (key) => {
    if (numericOverride(adjusted[key])) return scoreValue(adjusted[key]);
    if (cleared(key)) return aiRead(key);
    return stored(key) ?? aiRead(key);
  };
  const final = {
    turf_density: pick('turf_density'),
    weed_suppression: pick('weed_suppression'),
    color_health: pick('color_health'),
    fungus_control: pick('fungus_control'),
    thatch_level: pick('thatch_level'),
  };
  if (numericOverride(adjusted.stress_damage)) {
    final.stress_damage = scoreValue(adjusted.stress_damage);
  } else if (known(stressExplicit)) {
    // An earlier EXPLICIT entry sticks across a later partial save that
    // doesn't repeat it.
    final.stress_damage = scoreValue(stressExplicit);
  } else if (aiRead('stress_damage') != null) {
    final.stress_damage = aiRead('stress_damage');
  } else {
    const floor = stressFloor === undefined ? null : stressFloor;
    const parts = [final.fungus_control, final.thatch_level, floor]
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    final.stress_damage = parts.length ? Math.min(...parts) : null;
  }
  return final;
}

// Owner ruling 2026-10-04: the completion screen shows four scores and no
// longer asks for Fungus or Thatch, so Condition speaks for both:
//   - a Fungus/Thatch the AI left blank and nobody entered takes the
//     Condition score (Condition is the worst of the stressors, so the copy
//     never contradicts it). A key in `posted` was sent by the client, blank
//     or not: that client shows the field (the standalone Lawn assessment
//     page), so its blank stays a blank the technician must fill;
//   - when Condition is the technician's own entry (`conditionEntered`), a
//     Fungus/Thatch read BELOW it is raised to it. Report and tip readers
//     treat a low sub-score as confirmed evidence of disease or thatch, and
//     would otherwise contradict the technician's correction. A sub-score
//     posted as a number in this request is the technician's too and stays.
// Both apply only on the save that completes the row. A row that stays
// pending keeps its own values, so a later Condition change is not left
// beside a stale copy. `copied` names the keys that hold the Condition score
// rather than a reading.
function alignWithCondition(scores, { posted = {}, conditionEntered = false } = {}) {
  const sent = posted && typeof posted === 'object' ? posted : {};
  const condition = scores?.stress_damage;
  if (!known(condition)) return { scores, copied: [] };
  const copied = ['fungus_control', 'thatch_level'].filter((key) => {
    if (Object.prototype.hasOwnProperty.call(sent, key)) return false;
    return !known(scores[key]) || (conditionEntered && scores[key] < condition);
  });
  if (!copied.length) return { scores, copied };
  const aligned = { ...scores, ...Object.fromEntries(copied.map((key) => [key, condition])) };
  return scoresComplete(aligned) ? { scores: aligned, copied } : { scores, copied: [] };
}

// What calibration compares against the AI read: the technician's scores,
// without the Fungus/Thatch keys that only hold the Condition score. Those
// are one Condition entry, already counted under stress_damage — counted
// again they would triple its weight in avg_delta and bias_direction.
function calibrationScores(finalScores, copied) {
  const skip = Array.isArray(copied) ? copied : [];
  return { ...finalScores, ...Object.fromEntries(skip.map((key) => [key, null])) };
}

function scoreVisit(analysis, { seasonAdjust, calculateOverallScore }) {
  const mergedComposite = compositeFor(analysis);
  const displayScores = deriveLegacyScores(analysis);
  const adjustedScores = adjustAvailableScores(displayScores, seasonAdjust);
  return {
    mergedComposite,
    displayScores,
    adjustedScores,
    overallScore: overallInputsComplete(adjustedScores) ? calculateOverallScore(adjustedScores) : null,
    analyzedCount: analysis.status === 'complete' ? (analysis.photoQuality || []).length : 0,
  };
}

// /confirm's overall score for a run-backed row: nothing until every input exists.
function overallScoreFor(finalScores, calculateOverallScore) {
  return overallInputsComplete(finalScores) ? calculateOverallScore(finalScores) : null;
}

// Everything /confirm decides for a run-backed row, in one place: the final
// scores with NULLs preserved, the overall score once its inputs exist, and
// whether the row CONFIRMS. A row confirms only when every score column is
// known — every customer reader (lawn-health, Lawn Report, Knowledge Bridge,
// property score, the history baseline) selects on confirmed_by_tech and
// coerces a NULL score to 0 or 100 — so an unavailable run or a partial
// answer saves the technician's scores and review but stays pending, with
// no customer output, no calibration and no baseline, until the technician
// fills the gaps and confirms again. `missing` names the gaps for the client;
// calibration needs a confirmed row with AI scores to compare against.
function confirmScores(assessment, run, adjustedScores, { scoreValue, calculateOverallScore }) {
  const adjusted = adjustedScores || {};
  const aiScores = runAiScores(run);
  // What makes a technician's Condition entry stick across a later partial
  // save that doesn't repeat it: this request's own entry, or the marker of
  // an earlier one persisted on the assessment row's adjusted_scores snapshot
  // (written back by the caller alongside decision.stressExplicit — see
  // confirmLockedRun). Never assessment.stress_damage itself, which may only
  // be a PREVIOUS auto-derivation (Codex P1 2026-09-24).
  // Rows saved partway before the marker existed carry the entry as the run's
  // reconciliation.stress_damage_override instead; read it as a fallback.
  // Only an ABSENT marker falls back to the old field; a marker written as
  // null is an explicit clear and must not resurrect the old entry.
  const snapshot = parseJsonObject(assessment?.adjusted_scores) || {};
  const previousExplicit = Object.prototype.hasOwnProperty.call(snapshot, 'stress_damage_explicit')
    ? snapshot.stress_damage_explicit
    : parseJsonObject(run?.reconciliation)?.stress_damage_override;
  // Posting stress_damage as null/blank clears an earlier explicit entry.
  const stressCleared = Object.prototype.hasOwnProperty.call(adjusted, 'stress_damage') && !numericOverride(adjusted.stress_damage);
  const stressExplicit = numericOverride(adjusted.stress_damage)
    ? scoreValue(adjusted.stress_damage)
    : (!stressCleared && known(previousExplicit) ? previousExplicit : null);
  const { scores: finalScores, copied: copiedFromCondition } = alignWithCondition(resolveConfirmScores(assessment, adjusted, scoreValue, {
    ...(run?.status === 'complete' ? { stressFloor: independentStressFloor(run) } : {}),
    aiScores,
    stressExplicit,
  }), { posted: adjusted, conditionEntered: known(stressExplicit) });
  const confirmed = scoresComplete(finalScores);
  return {
    finalScores,
    copiedFromCondition,
    overallScore: overallScoreFor(finalScores, calculateOverallScore),
    confirmed,
    missing: missingScores(finalScores),
    aiScores,
    stressExplicit,
    calibrationEligible: confirmed && SCORE_KEYS.some((key) => known(aiScores[key])),
  };
}

// The AI scores a technician's confirm is calibrated against: the run's
// scores_adjusted snapshot — the seasonally adjusted legacy-unit values the
// technician was actually shown, so an unchanged confirm records no delta —
// never the assessment row, which a pending confirm may already have
// overwritten with the technician's entries. An unavailable run, or an answer that could determine nothing, has no score
// to compare — calibration then records nothing, rather than a row of NULL
// AI values whose avg_delta of 0 would read as perfect agreement.
// The immutable snapshot is REQUIRED: a complete run without scores_adjusted
// is a writer bug, not a comparable baseline — deriving from scores_raw
// would calibrate against unadjusted values and mislead the technician deltas
// (Codex #4149 r13). Such a run is not comparable (empty → calibration off).
function runAiScores(run) {
  if (run?.status !== 'complete') return {};
  const presented = parseJsonObject(run.scores_adjusted);
  if (!presented) return {};
  return Object.fromEntries(SCORE_KEYS.map((key) => [key, known(presented[key]) ? presented[key] : null]));
}

module.exports = {
  SCORE_KEYS,
  deriveLegacyScores,
  adjustAvailableScores,
  overallInputsComplete,
  scoresComplete,
  missingScores,
  assessmentScoreFields,
  independentStressFloor,
  resolveConfirmScores,
  alignWithCondition,
  calibrationScores,
  scoreVisit,
  overallScoreFor,
  confirmScores,
  runAiScores,
};
