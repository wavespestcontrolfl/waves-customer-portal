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

// `stressFloor`: the floor the derivation uses when the technician sent no
// explicit stress correction — the run's INDEPENDENT stressors (above), so a
// corrected fungus or thatch score re-derives stress from the corrected
// components instead of keeping the stored AI stress as a permanent floor
// (Codex #4150 r13: the standalone panel deletes stress_damage before posting
// a fungus edit). `undefined` (no run) keeps the stored value as the floor.
function resolveConfirmScores(assessment, adjustedScores, scoreValue, { stressFloor, stressOverride } = {}) {
  const adjusted = adjustedScores && typeof adjustedScores === 'object' ? adjustedScores : {};
  const present = (value) => value != null && value !== '';
  // An override counts only when it is a finite number (or a non-blank string
  // that parses to one) — a blank, whitespace or malformed value falls back to
  // the stored score exactly as the legacy path does, never to 0.
  const pick = (key) => {
    if (numericOverride(adjusted[key])) return scoreValue(adjusted[key]);
    return present(assessment[key]) ? scoreValue(assessment[key]) : null;
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
  } else if (known(stressOverride)) {
    final.stress_damage = scoreValue(stressOverride);
  } else {
    const floor = stressFloor === undefined ? (present(assessment.stress_damage) ? Number(assessment.stress_damage) : null) : stressFloor;
    const parts = [final.fungus_control, final.thatch_level, floor]
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    final.stress_damage = parts.length ? Math.min(...parts) : null;
  }
  return final;
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
  const previousOverride = parseJsonObject(run?.reconciliation)?.stress_damage_override;
  const componentChanged = ['fungus_control', 'thatch_level'].some((key) => numericOverride(adjusted[key]) && scoreValue(adjusted[key]) !== (numericOverride(assessment[key]) ? scoreValue(assessment[key]) : null));
  // Preserve an explicit correction across partial confirmations. A later
  // change to a component without an explicit stress edit requests a fresh
  // derivation. The caller persists this marker on the run in the SAME
  // transaction as the assessment, including null when ownership is cleared.
  const stressOverride = numericOverride(adjusted.stress_damage)
    ? scoreValue(adjusted.stress_damage)
    : (componentChanged || !known(previousOverride) ? null : previousOverride);
  const finalScores = resolveConfirmScores(assessment, adjusted, scoreValue, {
    ...(run?.status === 'complete' ? { stressFloor: independentStressFloor(run) } : {}),
    stressOverride,
  });
  const confirmed = scoresComplete(finalScores);
  const aiScores = runAiScores(run);
  return {
    finalScores,
    overallScore: overallScoreFor(finalScores, calculateOverallScore),
    confirmed,
    missing: missingScores(finalScores),
    aiScores,
    stressOverride,
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
  scoreVisit,
  overallScoreFor,
  confirmScores,
  runAiScores,
};
