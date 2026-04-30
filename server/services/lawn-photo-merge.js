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

module.exports = { withConcurrency, majorityVote };
