// Pure helpers for the /assess multi-photo path.
//
// Two functions, no DB, no side effects, fully testable:
//
//   - withConcurrency: bounded parallel mapper. Default cap = 3 because
//     the panel limits photo capture to 3, and even when that grows
//     we want a hard ceiling so a tech who somehow uploaded 10 photos
//     doesn't fan out 20 vision-API calls (Claude + Gemini per photo)
//     in parallel and trip a rate limit.
//
//   - majorityVote: tally-based selection across categorical photo
//     attributes (fungal_activity, thatch_visibility). Replaces the
//     prior "first valid result wins" behavior — that meant a noisy
//     photo 0 could unlock fungicide protocol decisions even when
//     photos 1 and 2 disagreed. Ties resolve to the value that
//     appeared FIRST in the input order (Map insertion order); this
//     matches the prior implicit behavior so a 1-photo assessment
//     produces an identical result.

const { areaWeight } = require('./lawn-photo-shots');

/**
 * Bounded-concurrency map. Runs `fn(item)` over `items` in batches
 * of size `limit`. Preserves input order in the returned array.
 *
 * Why batched-Promise.all instead of a worker-pool: only used for
 * ≤3 items today; the simpler shape is plenty fast and lets the
 * caller reason about ordering trivially.
 */
async function withConcurrency(items, limit, fn) {
  if (!Array.isArray(items)) throw new TypeError('withConcurrency: items must be an array');
  if (typeof fn !== 'function') throw new TypeError('withConcurrency: fn must be a function');
  const cap = Math.max(1, Math.floor(limit) || 1);
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += cap) {
    const batch = items.slice(i, i + cap);
    const results = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    for (let j = 0; j < results.length; j++) out[i + j] = results[j];
  }
  return out;
}

/**
 * Majority vote over a list of categorical values. Skips null/undefined.
 * Tie-break: first-seen wins (insertion-order Map). For an empty input
 * (or all-nullish), returns `fallback`.
 */
function majorityVote(values, fallback = null) {
  if (!Array.isArray(values)) return fallback;
  const counts = new Map();
  for (const v of values) {
    if (v == null) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (counts.size === 0) return fallback;
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

// Worst-severity selection across photos for the stress signals. Unlike the
// majority vote, a single trouble-spot photo with severe damage must win —
// Stress/Damage is defined as the worst signal, so a localized severe insect/
// drought/mechanical reading can't be averaged away by two healthy overviews.
const SEVERITY_RANK = { none: 0, minor: 1, moderate: 2, severe: 3 };
const THATCH_RANK = { low: 0, moderate: 1, high: 2 };

// Pick the worst (highest-ranked) value across photos, using the supplied rank
// map. Skips unknown/nullish values; returns fallback when none are usable.
function worstByRank(values, rank, fallback = null) {
  let worst = fallback;
  let worstRank = -1;
  for (const v of (Array.isArray(values) ? values : [])) {
    if (typeof v !== 'string' || !Object.hasOwn(rank, v)) continue;
    const r = rank[v];
    if (r > worstRank) { worstRank = r; worst = v; }
  }
  return worst;
}

function worstSeverity(values, fallback = null) {
  return worstByRank(values, SEVERITY_RANK, fallback);
}

// Merge per-photo composite results into one assessment composite. A single
// photo is returned as-is (it already carries the Claude/Gemini overwatering_signal
// + single-voice observations from averageScores). For 2+ photos: average the
// numeric fields, majority-vote the categoricals, take the PRIMARY photo's
// observation as a single voice (not a contradictory ' | ' join across photos),
// and OR overwatering_signal so one photo seeing mushrooms/standing water/algae
// still flags the whole assessment.
//
// Shot-list weighting (GATE_LAWN_SHOT_LIST, lawn report rebuild P18): when the
// caller passes `zones` (parallel to validResults, the recorded shot key or
// null per result), density, weeds and color become weighted means: front,
// back, side and unlabeled photos count in full, shade and hot_edge count
// half, and close_up, blade_crown and trouble count for nothing, so a trouble
// spot no longer drags the whole-lawn score. If every photo is a detail shot
// the plain mean is used (a score is better than none). Severities, the
// overwatering OR and the votes below are unchanged. No `zones` = the plain
// mean, byte-identical to before.
function mergePhotoComposites(validResults = [], { zones } = {}) {
  const raw = Array.isArray(validResults) ? validResults : [];
  const kept = [];
  const keptWeights = [];
  raw.forEach((result, index) => {
    if (!result) return;
    kept.push(result);
    keptWeights.push(Array.isArray(zones) ? areaWeight(zones[index]) : 1);
  });
  const results = kept;
  if (!results.length) return null;
  if (results.length === 1) return results[0].composite;

  // Weights apply only when the caller recorded zones and at least one photo
  // can speak for the area; otherwise every photo counts the same.
  const weighted = Array.isArray(zones) && keptWeights.some((w) => w > 0);
  const mean = (field, digits) => {
    const pairs = results
      .map((r, i) => [r.composite[field], weighted ? keptWeights[i] : 1])
      .filter(([v, w]) => v != null && w > 0);
    if (!pairs.length) return null;
    if (!weighted) return pairs.reduce((a, [v]) => a + v, 0) / pairs.length;
    const total = pairs.reduce((a, [, w]) => a + w, 0);
    return pairs.reduce((a, [v, w]) => a + v * w, 0) / total;
  };

  const merged = {};
  for (const field of ['turf_density', 'weed_coverage']) {
    const value = mean(field);
    merged[field] = value != null ? Math.round(value) : 0;
  }
  const colorValue = mean('color_health');
  merged.color_health = colorValue != null ? Math.round(colorValue * 10) / 10 : 5;
  merged.fungal_activity = majorityVote(
    results.map(r => r.composite.fungal_activity),
    results[0].composite.fungal_activity,
  );
  merged.thatch_visibility = majorityVote(
    results.map(r => r.composite.thatch_visibility),
    results[0].composite.thatch_visibility,
  );
  // Worst-stressor (not majority) for the signals that feed Stress/Damage, so a
  // localized severe spot in one photo survives the merge.
  for (const field of ['insect_damage', 'drought_stress', 'mechanical_damage']) {
    merged[field] = worstSeverity(
      results.map(r => r.composite[field]),
      results[0].composite[field],
    );
  }
  // Carry the WORST disease/thatch across photos for Stress/Damage only. The
  // majority fungal_activity/thatch_visibility above stay intact for the Lawn
  // Diagnostic protocol + snapshot findings; these worst_* values let
  // computeStressDamageDisplay keep a trouble-spot photo from being averaged
  // away on the customer-facing consolidated score.
  merged.worst_fungal_activity = worstSeverity(
    results.map(r => r.composite.fungal_activity),
    merged.fungal_activity,
  );
  merged.worst_thatch_visibility = worstByRank(
    results.map(r => r.composite.thatch_visibility),
    THATCH_RANK,
    merged.thatch_visibility,
  );
  merged.observations = results.map(r => r.composite.observations).filter(Boolean)[0] || '';
  merged.overwatering_signal = results.some(r => r.composite?.overwatering_signal === true);
  // Grass type: majority vote across photos, falling back to the first detected.
  const grasses = results.map(r => r.composite?.grass_type).filter(Boolean);
  merged.grass_type = grasses.length ? (majorityVote(grasses) || grasses[0]) : null;
  return merged;
}

module.exports = { withConcurrency, majorityVote, worstSeverity, mergePhotoComposites };
