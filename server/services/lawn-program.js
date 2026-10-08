/**
 * The lawn recipe every reader shares: one place that decides which lawn
 * program the portal runs.
 *
 * GATE_LAWN_V13 off (the default) returns protocols.json `lawn`, the object
 * every reader used before. On, it returns server/config/lawn-protocol-v13.json:
 * the track keys st_augustine, bermuda and zoysia in the same visit shape, each
 * holding the one universal v13 program (owner 2026-10-05, no per-grass tracks).
 * There is no bahia track: Celsius and Blindside are not labeled for bahiagrass
 * (owner 2026-10-06, the track is deleted and a bahia lawn plans nothing).
 *
 * Read at call time so unsetting the gate is the kill switch with no redeploy.
 * The structured (database) side of the same switch is
 * lawn-protocol-operating-layer.js getActiveLawnProtocol; both read
 * lawnV13Live().
 */
const protocols = require('../config/protocols.json');
const v13 = require('../config/lawn-protocol-v13.json');
const featureGates = require('../config/feature-gates');

// The lawn_protocols.version the v13 rows carry (migration
// 20261005120000_lawn_protocol_v13_staged). One constant for the reader and the
// migration's test.
const LAWN_V13_VERSION = '2026.10-v13';

// `?.()`: many suites mock feature-gates with a partial object. A reader the
// mock lacks reads as off, the fail-closed answer.
function lawnProtocols() {
  return featureGates.lawnV13Live?.() ? v13 : protocols.lawn;
}

// v13 is one program for every grass, still filed under the three track keys.
// A lawn whose recorded grass names none of them (mixed, unknown, free text)
// plans from this key while GATE_LAWN_V13 is live: the copies are the same
// steps and the same safety rules, so the key changes nothing but the lookup.
// Gate off: null, and such a lawn has no track, as before. Planning only (the
// plan engine): historical readers never synthesize a track for a past visit.
// Bahiagrass is the one grass that never takes this key: v13 weed spots use
// Celsius and Blindside, and both labels exclude bahiagrass, so a bahia lawn has
// no v13 track and no fallback (lawnV13NoProgramGrass).
const LAWN_V13_ANY_GRASS_TRACK = 'st_augustine';

// ── Bahia: the ONE alias table and the ONE gate-aware check ─────────────────
// Every bahia test in the portal asks these two, never a literal compare: a lawn recorded as `D`,
// `d_bahia`, Argentine or Pensacola is bahia everywhere or nowhere.
//   isBahiaGrass(value)        - does this grass / track / lawn-text value name bahia (gate-blind)?
//   lawnV13NoBahiaProgram()    - is the live program one that has no bahia track (GATE_LAWN_V13 on)?
//   bahiaHasNoProgram(value)   - both: bahia under a program that has none.
// The alias table is the pricing engine's own (GRASS_TYPE_ALIASES.bahia: D, BAHIA, bahia) plus the
// legacy protocol codes and the free-text names a lawn type is typed as.
const BAHIA_TRACK = 'bahia';
const BAHIA_LEGACY_CODES = Object.freeze(['d', 'd_bahia', 'd-bahia', 'dbahia', 'd bahia']);
const BAHIA_FREE_TEXT = /bahia|argentine|pensacola/;
const squash = (text) => String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
function isBahiaGrass(value) {
  if (value == null) return false;
  const text = String(value).trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (BAHIA_LEGACY_CODES.includes(lower) || BAHIA_FREE_TEXT.test(lower)) return true;
  const { GRASS_TYPE_ALIASES } = require('./pricing-engine/constants');
  return (GRASS_TYPE_ALIASES.bahia || []).some((alias) => squash(alias) === squash(text));
}
function lawnV13NoBahiaProgram() {
  return featureGates.lawnV13Live?.() === true && !lawnProtocols()?.[BAHIA_TRACK];
}
function bahiaHasNoProgram(value) {
  return lawnV13NoBahiaProgram() && isBahiaGrass(value);
}
// Kept as the plan engine's name for the same question.
const lawnV13NoProgramGrass = bahiaHasNoProgram;
function lawnV13AnyGrassTrack(grass = null) {
  if (featureGates.lawnV13Live?.() !== true || isBahiaGrass(grass)) return null;
  return LAWN_V13_ANY_GRASS_TRACK;
}

// The display names of the tracks the live program holds, for copy that lists them (the pricing
// knowledge entry, the customer guide): the old program's four, or v13's three (no bahia).
const LAWN_TRACK_NAMES = { st_augustine: 'St. Augustine', bermuda: 'Bermuda', zoysia: 'Zoysia', bahia: 'Bahia' };
function lawnTrackNames() {
  return Object.keys(lawnProtocols() || {}).map((key) => LAWN_TRACK_NAMES[key] || key);
}
// The "Tracks:" lines of the pricing knowledge entry. Gate off: the one old line, word for word.
function lawnTrackKnowledgeLines() {
  return [
    `Tracks: ${lawnTrackNames().join(' | ')}`,
    ...(lawnV13NoBahiaProgram() ? ['Bahiagrass lawns: no program (Celsius and Blindside are not labeled for bahiagrass); the office reviews each one before quoting'] : []),
  ];
}

// A protocol version that can serve a visit: the published one, or the staged
// v13 version (loaded by the migration, never active until the follow-up PR
// retires the old program) ONLY while GATE_LAWN_V13 is live. Unsetting the gate
// fails closed for a visit pinned to v13: its recipe would be the old program
// against v13 windows. Every reader that asked "status === 'active'" asks this.
// It lives here, not in the operating layer, because suites mock that module
// with partial objects.
function isServingProtocol(protocol) {
  if (protocol?.status === 'active') return true;
  return protocol?.status === 'staged' && protocol.version === LAWN_V13_VERSION && featureGates.lawnV13Live?.() === true;
}

// getProtocolWindowContext options for a live visit's own assignment: its window
// key AND its protocol key and version, so a visit pinned to an older version gets
// that version's context and never a newer version's window by key collision.
// Unpinned, those fields are null and the planning lookup picks the protocol.
function visitProtocolQuery({ serviceDate, grassTrack, scheduledService }) {
  return {
    serviceDate,
    grassTrack,
    windowKey: scheduledService?.lawn_protocol_window_key || null,
    protocolKey: scheduledService?.lawn_protocol_key || null,
    protocolVersion: scheduledService?.lawn_protocol_version || null,
    planning: true,
  };
}

// A recipe visit can carry `cadenceVariants`: { "<applications a year>": { primary } },
// the whole-lawn step a plan of that many applications runs INSTEAD of the visit's
// own step (the 12x one, also the default). v13 has one: April on the 9x plan
// (LESCO Dimension 0.21% 18-0-10 in place of the 24-0-11). This is the one
// decision of which step a visit runs; the plan, the tank sheet and the
// completion defaults all read it. `visitsPerYear` is the plan's count, or null
// when unknown: the visit keeps its own step and `unknownCadence` names the
// variant products a known plan would have used (the caller warns).
function visitForCadence(visit, visitsPerYear) {
  const variants = visit?.cadenceVariants;
  if (!variants || typeof variants !== 'object') return { visit, branch: null, unknownCadence: null };
  const variant = variants[String(Number(visitsPerYear))];
  if (visitsPerYear != null && variant) {
    // The variant replaces the whole step: its lines, and (when it states them) the notes and the visit goal the
    // job card shows, so a step with no whole-lawn tool does not keep the 12x step's rates or tool wording.
    return { visit: { ...visit, primary: variant.primary, ...(variant.secondary ? { secondary: variant.secondary } : {}), ...(variant.notes ? { notes: variant.notes } : {}), ...(variant.goal ? { goal: variant.goal } : {}) }, branch: String(Number(visitsPerYear)), unknownCadence: null };
  }
  if (visitsPerYear != null) return { visit, branch: null, unknownCadence: null };
  // Only a line that names a product ("Name \u2014 rate"): a scout-only step has none.
  const names = Object.values(variants).flatMap((entry) => String(entry.primary || '').split('\n').filter((line) => line.includes(' \u2014 ')).map((line) => line.split(' \u2014 ')[0].trim()).filter(Boolean));
  return { visit, branch: null, unknownCadence: { variantProducts: [...new Set(names)], cadences: Object.keys(variants) } };
}

// The warning for a visit whose plan cadence is unknown (visitForCadence's
// unknownCadence): it kept the 12x step and says what a known plan would have used.
function unknownCadenceWarning(unknownCadence) {
  const cadences = unknownCadence.cadences.join('x or ');
  const instead = unknownCadence.variantProducts.length ? `use ${unknownCadence.variantProducts.join(' or ')} instead` : 'this visit has no whole-lawn product';
  return {
    code: 'lawn_v13_plan_cadence_unknown', severity: 'warning',
    message: `This visit's lawn plan (applications a year) is not on file, so the plan keeps the 12x step. On a ${cadences}x plan, ${instead}.`,
  };
}

module.exports = { BAHIA_TRACK, isBahiaGrass, lawnV13NoBahiaProgram, bahiaHasNoProgram, lawnTrackKnowledgeLines, lawnTrackNames, lawnProtocols, LAWN_V13_VERSION, LAWN_V13_ANY_GRASS_TRACK, lawnV13AnyGrassTrack, lawnV13NoProgramGrass, isServingProtocol, visitProtocolQuery, visitForCadence, unknownCadenceWarning };
