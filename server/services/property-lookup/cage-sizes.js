/**
 * Pool cage size policy: the ONE place that turns a cage area or a size word
 * into the four-size answer (SMALL/MEDIUM/LARGE/OVERSIZED) or the two-size
 * answer (MEDIUM/LARGE) of GATE_CAGE_TWO_SIZES (owner 2026-11-19, "cage 1000":
 * Medium up to 1,000 sq ft, Large above).
 *
 * Pure functions, no gate reads: callers decide which answer applies under
 * this request's gate state. The invariant every caller keeps: the cage size
 * and the manual-quote hold come from the best evidence, in this order:
 * the county's assessed area, then the profile's four-size answer
 * (poolCageLegacySize), then its own size word.
 *
 * Consumers: the property lookup (server/routes/property-lookup-v2.js), the
 * customer hold rule (office-cage-start.js customerCageHold) and the website
 * quote (server/routes/public-quote.js websiteCageFeatures).
 */

const FOUR_SIZES = ['SMALL', 'MEDIUM', 'LARGE', 'OVERSIZED'];
const TWO_SIZES = ['MEDIUM', 'LARGE'];
const TWO_SIZES_MEDIUM_MAX_SQFT = 1000;

// A positive finite area from a number or a numeric string (a public caller's
// profile can carry either); anything else is not an area.
function areaOf(sqft) {
  const n = typeof sqft === 'string' && sqft.trim() !== '' ? Number(sqft) : sqft;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

const upper = (value) => String(value == null ? '' : value).trim().toUpperCase();
const validFour = (value) => (FOUR_SIZES.includes(upper(value)) ? upper(value) : null);
const hasLegacyKey = (profile) => !!profile && Object.prototype.hasOwnProperty.call(profile, 'poolCageLegacySize');

// Today's bands: under 300 Small, 300 to 600 Medium, 601 to 900 Large, above Oversized.
function fourBandCageSize(sqft) {
  const area = areaOf(sqft);
  if (area === null) return null;
  if (area < 300) return 'SMALL';
  if (area <= 600) return 'MEDIUM';
  if (area <= 900) return 'LARGE';
  return 'OVERSIZED';
}

// Two sizes: Medium up to 1,000 sq ft, Large above.
function twoSizeFromArea(sqft) {
  const area = areaOf(sqft);
  if (area === null) return null;
  return area <= TWO_SIZES_MEDIUM_MAX_SQFT ? 'MEDIUM' : 'LARGE';
}

// An old four-size word read as two sizes: Small, Medium and Large read
// Medium, only Oversized reads Large.
function fourToTwo(size) {
  const word = validFour(size);
  if (!word) return null;
  return word === 'OVERSIZED' ? 'LARGE' : 'MEDIUM';
}

// The profile's four-size answer. A profile with its own poolCageLegacySize key
// is a two-size profile: its poolCageSize is NOT a four-size word then.
function fourSizeOf(profile) {
  if (!profile) return null;
  const fromArea = fourBandCageSize(profile.poolCageSqft);
  if (fromArea) return fromArea;
  const legacy = validFour(profile.poolCageLegacySize);
  if (legacy) return legacy;
  return hasLegacyKey(profile) ? null : validFour(profile.poolCageSize);
}

// The profile's two-size answer.
function twoSizeOf(profile) {
  if (!profile) return null;
  const fromArea = twoSizeFromArea(profile.poolCageSqft);
  if (fromArea) return fromArea;
  const fromFour = fourToTwo(fourSizeOf(profile));
  if (fromFour) return fromFour;
  const own = upper(profile.poolCageSize);
  return hasLegacyKey(profile) && TWO_SIZES.includes(own) ? own : null;
}

// True for the sizes today's four-size rule holds for a person to quote.
const isHeldFourSize = (size) => size === 'LARGE' || size === 'OVERSIZED';

module.exports = {
  fourBandCageSize, twoSizeFromArea, fourToTwo, fourSizeOf, twoSizeOf, isHeldFourSize, validFour,
};
