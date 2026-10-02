/**
 * Lawn progress engine (lawn report rebuild P13). Pure: no I/O, no clock, no
 * gate, no model. Ships DARK and data only: P14 writes the customer copy from
 * what this returns; nothing here is a sentence.
 *
 * "Since last visit", decided by the server. Inputs are what the prior visit
 * froze (P12 `sinceLast`: the products it applied and the topics it said it
 * would keep watching), both visits' scores, the two dates and the
 * assessment's own confidence. For every prior applied row (per metric the row
 * can be judged on) and every prior check it returns ONE state from a closed
 * set, plus an overall direction.
 *
 * Verdicts are NOT decided here. Applied rows are judged by P10's
 * judgeProgress against each metric's own window (server/config/
 * lawn-expectations.js metricWindows); this module only gates that verdict and
 * names it. A second verdict system would drift from the owner-approved windows.
 *
 * States (closed set, STATES):
 *   improving       the score gained a full band before the row's full window opened
 *                   (judgeProgress 'ahead'), or the same-spot recheck said better
 *   on_track        gained a band once the full window opened, or a hold-mode metric stopped falling
 *   holding_steady  nothing to judge against (no window for the metric, a short-lived
 *                   product, a prevention row), or the same-spot recheck said same
 *   too_early       the metric's window has not opened, or is open with no clear gain yet
 *   behind          the metric's window has CLOSED with no gain (or still falling in
 *                   hold mode), or the same-spot recheck said worse
 *   unclear         this visit's photos cannot support a comparison (low confidence,
 *                   or a score the two models disagreed on), a score is missing, or a
 *                   prior check has no recorded same-spot recheck
 *   seasonal        color compared across a season change that includes a cool season
 *
 * Gate order (first that applies wins):
 *   1. a needed score is missing                     -> unclear (missing_scores)
 *   2. confidence below moderate, or the metric is one the two models disagreed on
 *                                                    -> unclear (low_confidence)
 *   3. color_health across a cool-season change      -> seasonal
 *   4. judgeProgress's verdict, renamed
 *
 * Rules the tests pin:
 *   - too_early is never behind: judgeProgress cannot say behind before the
 *     metric window closes, and a short-lived, absence or site-limit row can
 *     never be behind at all (belt and braces below).
 *   - Low or insufficient (or unknown) confidence is always unclear, never a
 *     verdict word and never a direction.
 *   - Color across a season change is seasonal, never behind.
 *   - A recheck verdict comes ONLY from a structured recheck record on the
 *     check (check.recheck = { verdict, source }), never from score deltas.
 *     Owner ruling 09-29 (SCOPE round 3b): the recheck is an IMAGE ANALYSIS
 *     job, not the technician's: last visit's and today's same-spot photos
 *     are read as a pair (source 'photo_pair', P19), and the office can
 *     override it from the lawn review queue (source 'office_review').
 *     A photo_pair recheck is a photo read, so low confidence makes it
 *     unclear like any other photo verdict; an office_review is a person's
 *     decision and stands.
 *
 * Thresholds: the band (8 points per category, 4 for the overall) is W5's
 * proposal; tune it with the calibration replay (server/scripts/
 * replay-lawn-progress.js). The confidence levels and the photo-quality cut
 * points below are PROPOSED here (the assessment has no stored score
 * confidence yet; a stored `scoreConfidence` overrides the derived level the
 * day one exists).
 */
const { judgeProgress, buildLawnExpectations } = require('./lawn-expectations');
const { getSeason, crossSeasonNoteFromSeasons } = require('./lawn-seasonality');
const { etCalendarDayOf } = require('../../utils/datetime-et');

const ENGINE_VERSION = 'lawn_progress_v1';
const PROGRESS_VERSION = 1;

const STATES = ['improving', 'on_track', 'holding_steady', 'too_early', 'behind', 'unclear', 'seasonal'];
const DIRECTIONS = ['up', 'down', 'flat', 'unknown'];

// The four consolidated categories (and the overall) a visit scores.
const METRICS = ['weed_suppression', 'color_health', 'stress_damage', 'turf_density'];

// W5: 8 points for a category (single-category photo scores swing more with
// 1-3 photos), 4 for the overall (lawn-report-narrative.js trendDirection).
const CATEGORY_BAND = 8;
const OVERALL_BAND = 4;

// A recheck verdict is a structured better/same/worse read of the SAME spot.
// Owner 09-29: the paired-photo read (P19) or an office override from the
// lawn review queue. Never the tech, never a score delta.
const RECHECK_SOURCES = ['photo_pair', 'office_review'];
const RECHECK_STATE = { better: 'improving', same: 'holding_steady', worse: 'behind' };
const RECHECK_STATUS = { better: 'checked_better', same: 'checked_same', worse: 'checked_worse' };

// ── Confidence ────────────────────────────────────────────────────────────
// Levels, lowest first. Below 'moderate' nothing is compared.
const CONFIDENCE_LEVELS = ['insufficient', 'low', 'moderate', 'high'];
const COMPARABLE_LEVELS = new Set(['moderate', 'high']);

// lawn_assessment_photos.quality_score (0-100; the visit runs write 80 / 55 /
// 20 / 0 for adequate / limited / poor / unrated, and legacy rows default to
// 50). PROPOSED cut points.
const ADEQUATE_QUALITY = 75;
const USABLE_QUALITY = 40;

// A divergence flag's metric -> the category it makes unreliable.
const DIVERGENCE_METRIC = {
  turf_density: 'turf_density',
  weed_suppression: 'weed_suppression',
  color_health: 'color_health',
  stress_damage: 'stress_damage',
  fungus_control: 'stress_damage',
  thatch_level: 'stress_damage',
};

function qualityBucket(value) {
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (['adequate', 'limited', 'poor'].includes(key)) return key;
    // quality_score is a Postgres decimal: pg returns it as a string ('80.00').
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(key)) return 'unrated';
  }
  const n = value == null || value === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 'unrated';
  if (n >= ADEQUATE_QUALITY) return 'adequate';
  if (n >= USABLE_QUALITY) return 'limited';
  return 'poor';
}

/**
 * How far the assessment's scores can be trusted for a comparison, from the
 * fields the assessment has today.
 *   insufficient  no usable photo
 *   low           one usable photo, or no photo better than "limited"
 *   moderate      two usable photos, at least one adequate (the typical visit)
 *   high          three or more usable photos, at least two adequate
 * `divergenceFlags` (the two vision models disagreeing by more than 20 points)
 * do not move the level; they make THAT category unclear (`divergentMetrics`).
 * A stored `scoreConfidence` ('high'|'moderate'|'low'|'insufficient') wins.
 * With neither photo evidence nor a stored level the answer is 'unknown',
 * which compares nothing.
 *
 * @param {object} [input]
 * @param {Array<string|number|{quality?:string|number, quality_score?:number, qualityScore?:number}>} [input.photos] quality per photo
 * @param {Array<{metric:string}>} [input.divergenceFlags]
 * @param {string} [input.scoreConfidence]
 * @returns {{level:string, usablePhotos:number|null, adequatePhotos:number|null, divergentMetrics:string[], source:string}}
 */
/** The categories an assessment's divergence flags make unreliable. */
function divergentMetricsFrom(divergenceFlags) {
  return [...new Set((Array.isArray(divergenceFlags) ? divergenceFlags : [])
    .map((flag) => DIVERGENCE_METRIC[String(flag?.metric || '').toLowerCase()])
    .filter(Boolean))].sort();
}

/**
 * What one lawn_assessment_photos row says about READABILITY, for
 * deriveAssessmentConfidence. quality_score has two meanings in the table:
 * the legacy multi-call path stores a lawn-HEALTH blend (turf density, weed
 * cover, color) and fills the row's per-photo turf_density / weed_coverage /
 * color_health, while the one-call path stores the model's photo-quality
 * read and leaves those null. A health blend must never read as photo
 * quality (a clear photo of a sick lawn would look unusable), so a legacy
 * row is judged by its quality gate alone: passed = adequate, failed = poor.
 */
function photoQualityForConfidence(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.quality_gate_passed === false) return 'poor';
  const legacyHealthBlend = row.turf_density != null || row.weed_coverage != null || row.color_health != null;
  if (legacyHealthBlend) return 'adequate';
  return row.quality_score ?? null;
}

function deriveAssessmentConfidence({ photos, divergenceFlags, scoreConfidence } = {}) {
  const divergentMetrics = divergentMetricsFrom(divergenceFlags);

  if (CONFIDENCE_LEVELS.includes(scoreConfidence)) {
    return { level: scoreConfidence, usablePhotos: null, adequatePhotos: null, divergentMetrics, source: 'stored' };
  }
  if (!Array.isArray(photos)) {
    return { level: 'unknown', usablePhotos: null, adequatePhotos: null, divergentMetrics, source: 'none' };
  }
  const buckets = photos.map((photo) => qualityBucket(
    photo && typeof photo === 'object' ? (photo.quality ?? photo.quality_score ?? photo.qualityScore) : photo,
  ));
  const adequate = buckets.filter((b) => b === 'adequate').length;
  const usable = adequate + buckets.filter((b) => b === 'limited').length;
  let level;
  if (usable === 0) level = 'insufficient';
  else if (usable === 1 || adequate === 0) level = 'low';
  else if (usable >= 3 && adequate >= 2) level = 'high';
  else level = 'moderate';
  return { level, usablePhotos: usable, adequatePhotos: adequate, divergentMetrics, source: 'photos' };
}

function normalizeConfidence(value) {
  if (typeof value === 'string') {
    return { level: CONFIDENCE_LEVELS.includes(value) ? value : 'unknown', divergentMetrics: [] };
  }
  if (value && typeof value === 'object') {
    return {
      level: CONFIDENCE_LEVELS.includes(value.level) ? value.level : 'unknown',
      divergentMetrics: Array.isArray(value.divergentMetrics) ? value.divergentMetrics : [],
    };
  }
  return { level: 'unknown', divergentMetrics: [] };
}

// ── Dates and scores ──────────────────────────────────────────────────────
function dayString(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return m ? m[1] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return etCalendarDayOf(value);
  return null;
}

function dayNumber(value) {
  const day = dayString(value);
  if (!day) return null;
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function scoreOf(scores, metric) {
  const raw = scores?.[metric];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const delta = (cur, prior) => (cur == null || prior == null ? null : cur - prior);

/** The scores object this engine reads, out of an assessment row (DB column names). */
function scoresFromAssessmentRow(row) {
  if (!row) return null;
  // shared/lawn-scores.cjs is the report's own score math (null-aware overall,
  // stress_damage derived from fungus/thatch on older rows).
  const { lawnScoreValue, resolveStressDamage, calculateLawnOverallScore } = require('../../../shared/lawn-scores.cjs');
  return {
    turf_density: lawnScoreValue(row.turf_density),
    weed_suppression: lawnScoreValue(row.weed_suppression),
    color_health: lawnScoreValue(row.color_health),
    stress_damage: resolveStressDamage(row),
    overall: calculateLawnOverallScore(row),
  };
}

// ── Items ─────────────────────────────────────────────────────────────────
// judgeProgress's vocabulary -> this module's closed set.
const VERDICT_STATE = {
  too_early: 'too_early',
  in_window: 'too_early',
  ahead: 'improving',
  on_track: 'on_track',
  behind: 'behind',
  holding_steady: 'holding_steady',
  unclear: 'unclear',
};

function appliedRows(applied, priorDate) {
  const applications = (Array.isArray(applied) ? applied : [])
    .filter((app) => app && typeof app.name === 'string' && app.name.trim())
    .map((app) => ({ name: app.name, targets: Array.isArray(app.targets) ? app.targets : [] }));
  if (!applications.length) return { rows: [], unmapped: [] };
  // includeUnapproved: the progress is DATA; each item carries `approved` so
  // the writer (P14) can still withhold what the owner has not signed.
  const built = buildLawnExpectations({ applications, visitDate: priorDate }, { includeUnapproved: true });
  return { rows: built.rows, unmapped: built.unmapped };
}

function itemForMetric({ row, metric, days, cur, prior, gates, band }) {
  const scoreDelta = delta(scoreOf(cur, metric), scoreOf(prior, metric));
  const rawVerdict = judgeProgress(row, { metric, daysSinceApplication: days, scoreDelta, band });
  let state = VERDICT_STATE[rawVerdict] || 'unclear';
  let gate = null;

  if (scoreDelta == null || !Number.isFinite(days)) {
    state = 'unclear';
    gate = 'missing_scores';
  } else if (!gates.comparable || gates.divergent.has(metric)) {
    state = 'unclear';
    gate = 'low_confidence';
  } else if (metric === 'color_health' && gates.seasonChange) {
    state = 'seasonal';
    gate = 'seasonal';
  } else if (state === 'behind' && (row.transient || row.judgedByAbsence || row.behindEligible === false)) {
    // judgeProgress already withholds behind from rows with no window; this is
    // the invariant stated where a regression would be seen.
    state = 'holding_steady';
  }

  return {
    kind: 'applied',
    rowId: row.id,
    family: row.family || null,
    appliesTo: row.appliesTo,
    approved: Boolean(row.approved),
    metric,
    state,
    gate,
    rawVerdict,
    basis: { daysSinceApplication: Number.isFinite(days) ? days : null, scoreDelta, band },
  };
}

function itemForCheck(check, comparable) {
  const recheck = check?.recheck;
  const verdict = recheck && typeof recheck === 'object' ? recheck.verdict : null;
  const valid = Boolean(recheck) && RECHECK_SOURCES.includes(recheck.source) && Object.prototype.hasOwnProperty.call(RECHECK_STATE, verdict);
  // A paired-photo read is still a photo read: low confidence = unclear.
  const lowConfidence = valid && recheck.source === 'photo_pair' && !comparable;
  return {
    kind: 'check',
    key: String(check?.key || ''),
    priorStatus: check?.status || null,
    state: valid && !lowConfidence ? RECHECK_STATE[verdict] : 'unclear',
    gate: lowConfidence ? 'low_confidence' : (valid ? null : 'not_rechecked'),
    source: valid ? recheck.source : null,
    // Say a recheck happened only when this is not 'not_recorded'.
    recheck: valid ? RECHECK_STATUS[verdict] : 'not_recorded',
  };
}

// ── Overall ───────────────────────────────────────────────────────────────
function overallDirection({ curOverall, priorOverall, comparable, seasonChange, band }) {
  const d = delta(curOverall, priorOverall);
  if (d == null) return { direction: 'unknown', delta: null, band, reason: 'missing_scores' };
  if (!comparable) return { direction: 'unknown', delta: d, band, reason: 'low_confidence' };
  if (d >= band) return { direction: 'up', delta: d, band, reason: null };
  if (d <= -band) {
    // A drop across a cool-season change is largely seasonal (lawn-seasonality
    // never lets a winter-vs-summer diff read as decline): no direction.
    return seasonChange
      ? { direction: 'unknown', delta: d, band, reason: 'seasonal' }
      : { direction: 'down', delta: d, band, reason: null };
  }
  return { direction: 'flat', delta: d, band, reason: null };
}

function seasonOf(side) {
  if (side?.season) return String(side.season);
  const day = dayString(side?.date);
  return day ? getSeason(Number(day.slice(5, 7))) : null;
}

// Why a visit cannot be compared, first that applies (null = comparable).
// The frozen sinceLast pins the visit its treatments came from: scores from
// any other visit would judge those treatments against the wrong dates.
const INELIGIBLE = [
  ['baseline', ({ current }) => Boolean(current?.isBaseline)],
  ['prior_mismatch', ({ prior, sinceLast }) => sinceLast?.priorAssessmentId != null && prior?.assessmentId != null
    && String(sinceLast.priorAssessmentId) !== String(prior.assessmentId)],
  ['no_prior', ({ prior, current, priorDay, curDay }) => !prior?.scores || !current?.scores
    || priorDay == null || curDay == null || curDay <= priorDay],
];

/**
 * How far the two visits' scores can be compared. A noisy PRIOR read makes a
 * delta as unreliable as a noisy current one, so the prior's photo confidence
 * (when the caller has it) and its divergence flags count too.
 */
function comparisonGates(current, prior) {
  const confidence = normalizeConfidence(current.confidence);
  const priorConfidence = prior.confidence == null ? null : normalizeConfidence(prior.confidence);
  const comparable = [confidence, priorConfidence].every((c) => c == null || COMPARABLE_LEVELS.has(c.level));
  const divergent = new Set([
    ...confidence.divergentMetrics,
    ...(priorConfidence?.divergentMetrics || []),
    ...(Array.isArray(prior.divergentMetrics) ? prior.divergentMetrics : []),
  ]);
  const priorSeason = seasonOf(prior);
  const curSeason = seasonOf(current);
  const seasonalLine = crossSeasonNoteFromSeasons(priorSeason, curSeason);
  return {
    level: confidence.level,
    comparable,
    divergent,
    seasonChange: seasonalLine != null,
    season: { prior: priorSeason, current: curSeason, seasonChange: seasonalLine != null, seasonalLine },
  };
}

/** One item per judged metric of each prior applied row, then one per prior check. */
function progressItems({ sinceLast, priorDate, days, current, prior, gates, band }) {
  const { rows, unmapped } = appliedRows(sinceLast?.applied, priorDate);
  const items = rows.flatMap((row) => {
    // Judged metrics when the row has windows; otherwise its one metric, which
    // judgeProgress answers 'holding_steady'.
    const metrics = Object.keys(row.metricWindows || {});
    return (metrics.length ? metrics : [row.metric])
      .filter((metric) => METRICS.includes(metric))
      .map((metric) => itemForMetric({ row, metric, days, cur: current.scores, prior: prior.scores, gates, band }));
  });
  const checks = Array.isArray(sinceLast?.checks) ? sinceLast.checks : [];
  return { items: [...items, ...checks.map((check) => itemForCheck(check, gates.comparable))], unmapped };
}

/**
 * The overall score is a null-aware weighted blend (shared/lawn-scores.cjs):
 * an assessment missing a category renormalizes over the rest, which is a
 * different statistic. A direction needs all four categories on BOTH visits.
 */
function sameOverallBasis(current, prior) {
  return METRICS.every((m) => scoreOf(current.scores, m) != null && scoreOf(prior.scores, m) != null);
}

/**
 * @param {object} input
 * @param {{date, season?, isBaseline?, scores, confidence}} input.current this visit's assessment
 * @param {{assessmentId?, date, season?, scores, confidence?, divergentMetrics?}} input.prior the prior visit's assessment
 * @param {object|null} [input.sinceLast] reportV2.sinceLast (P12): { priorAssessmentId, priorDate, applied[], checks[] }
 *   Its FROZEN priorDate wins over the prior row's live date (a corrected
 *   schedule date must not move a permanent report across a window). When
 *   sinceLast and prior name different assessments nothing is judged
 *   (reason 'prior_mismatch').
 * @param {number} [input.band] category dead-band (default 8)
 * @param {number} [input.overallBand] overall dead-band (default 4)
 * @returns {object} { v, engineVersion, eligible, reason, daysSincePrior, confidence, season, overall, deltas, items, unmapped }
 */
function buildLawnProgress({
  current, prior, sinceLast = null, band = CATEGORY_BAND, overallBand = OVERALL_BAND,
} = {}) {
  const base = {
    v: PROGRESS_VERSION,
    engineVersion: ENGINE_VERSION,
    eligible: false,
    reason: null,
    daysSincePrior: null,
    confidence: null,
    season: null,
    overall: { direction: 'unknown', delta: null, band: overallBand, reason: null },
    deltas: null,
    items: [],
    unmapped: [],
  };

  const priorDate = dayString(sinceLast?.priorDate || prior?.date);
  const priorDay = dayNumber(priorDate);
  const curDay = dayNumber(current?.date);
  const ineligible = INELIGIBLE.find(([, test]) => test({ current, prior, sinceLast, priorDay, curDay }));
  if (ineligible) return { ...base, reason: ineligible[0] };

  const days = curDay - priorDay;
  const gates = comparisonGates(current, prior);
  const { items, unmapped } = progressItems({ sinceLast, priorDate, days, current, prior, gates, band });
  const overall = sameOverallBasis(current, prior)
    ? overallDirection({
      curOverall: scoreOf(current.scores, 'overall'),
      priorOverall: scoreOf(prior.scores, 'overall'),
      comparable: gates.comparable,
      seasonChange: gates.seasonChange,
      band: overallBand,
    })
    : { direction: 'unknown', delta: null, band: overallBand, reason: 'incomplete_scores' };

  return {
    ...base,
    eligible: true,
    daysSincePrior: days,
    confidence: { level: gates.level, comparable: gates.comparable, divergentMetrics: [...gates.divergent].sort() },
    season: gates.season,
    overall,
    deltas: Object.fromEntries([...METRICS, 'overall'].map((m) => [m, delta(scoreOf(current.scores, m), scoreOf(prior.scores, m))])),
    items,
    unmapped,
  };
}

module.exports = {
  divergentMetricsFrom,
  photoQualityForConfidence,
  ENGINE_VERSION,
  PROGRESS_VERSION,
  STATES,
  DIRECTIONS,
  METRICS,
  CATEGORY_BAND,
  OVERALL_BAND,
  RECHECK_SOURCES,
  CONFIDENCE_LEVELS,
  deriveAssessmentConfidence,
  scoresFromAssessmentRow,
  buildLawnProgress,
};
