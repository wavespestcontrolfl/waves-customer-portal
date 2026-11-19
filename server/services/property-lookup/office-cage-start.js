/**
 * Office starting size for a county-measured pool cage
 * (GATE_CAGE_START_MEDIUM, owner 2026-11-17 "both", draft price study).
 *
 * The lookup sizes a cage from the county's assessed area: over 600 sq ft is
 * Large, over 900 sq ft is Oversized (classifyPoolCageSize). In 90 days of
 * sent estimates every priced cage over 600 sq ft measured 2,000 sq ft or
 * less, and the office moved nearly all of them to Medium by hand. With the
 * gate on, the two office tools start such a cage at Medium:
 *   - the call-agent draft (estimator-engine pipeline), and
 *   - the estimate tool's first fill (POST /property-lookup answers
 *     meta.poolCageStartSize, stampEstimateToolCageStart).
 * The call-agent draft also follows the estimate tool on a cage with no
 * decided pool: the tool drops it, so the draft does too.
 *
 * NOT changed, on purpose: the lookup's own enriched.poolCageSize. The
 * website quote holds a Large or Oversized cage for a manual quote off that
 * field, and the website-lead draft, the customer price assistant, the tech
 * estimate tool and the moving re-price read it too. Small, Large and
 * Oversized stay selectable by hand in the estimate tool.
 *
 * GATE_CAGE_TWO_SIZES (owner 2026-11-19, "cage 1000") supersedes the Medium
 * start: with it on the lookup's own answer is two sizes (Medium up to 1,000
 * sq ft, Large above), so officeCageStartSize returns null and no
 * meta.poolCageStartSize is stamped. The call-agent draft still drops a cage
 * on a home with no decided pool (GATE_CAGE_START_MEDIUM). The estimate tool is
 * told to offer two sizes by meta.poolCageTwoSizes (stampEstimateToolCageStart).
 */

// A cage over this area is no longer the lookup's Medium (classifyPoolCageSize).
const CAGE_START_ABOVE_SQFT = 600;
// Owner limit: a cage over 2,000 sq ft stays Oversized.
const CAGE_START_MAX_SQFT = 2000;

// `?.()`: a whole-module feature-gates mock without the reader reads as off.
const gateLive = () => require('../../config/feature-gates').cageStartMediumLive?.() === true;

const twoSizesLive = () => require('../../config/feature-gates').cageTwoSizesLive?.() === true;

const up = (value) => String(value || '').toUpperCase();

// 'MEDIUM' when the office tools start this cage at Medium, else null (the
// lookup's own size stands). Keyed on the county's assessed area only: a
// cage sized from the satellite image has no area and keeps its size.
function officeCageStartSize(enriched) {
  if (!gateLive() || twoSizesLive()) return null;
  const sqft = Number(enriched?.poolCageSqft);
  return sqft > CAGE_START_ABOVE_SQFT && sqft <= CAGE_START_MAX_SQFT ? 'MEDIUM' : null;
}

// The lookup profile as the call-agent draft prices it. Gate off, or nothing
// to change: the SAME object, so the engine input is byte-identical. The
// lookup's profile is never mutated.
function agentDraftCageProfile(enriched) {
  if (!enriched || !gateLive() || up(enriched.poolCage) !== 'YES') return enriched;
  // The estimate tool counts a cage only with a decided pool (a 'POSSIBLE'
  // pool is satellite-only and may be the neighbor's).
  if (up(enriched.pool) !== 'YES') return { ...enriched, poolCage: 'NO', poolCageSize: 'NONE' };
  const startSize = officeCageStartSize(enriched);
  return startSize ? { ...enriched, poolCageSize: startSize } : enriched;
}

// The estimate tool's half: names the starting size BESIDE the profile, never
// in it (enriched.poolCageSize stays the lookup's own size, and the profile is
// what the estimate saves). The tool's first fill reads meta.poolCageStartSize.
// Absent while the gate is off. GATE_CAGE_TWO_SIZES: also names meta.poolCageTwoSizes
// (the tool then offers Medium and Large only), absent while that gate is off.
function stampEstimateToolCageStart(result) {
  if (twoSizesLive() && result?.meta) result.meta.poolCageTwoSizes = true;
  const startSize = officeCageStartSize(result?.enriched);
  if (startSize && result.meta) result.meta.poolCageStartSize = startSize;
  return result;
}

module.exports = { officeCageStartSize, agentDraftCageProfile, stampEstimateToolCageStart };
