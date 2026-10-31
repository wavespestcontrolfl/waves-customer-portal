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
// The v13 recipe as every reader sees it: a visit's optional conditional blocks are left out unless their gate is live, so with the gate
// off no reader, the programs route, the protocol reader or the estimate tools included, sees one.
//   addOns  GATE_LAWN_BERMUDA_REMOVAL  the bermuda removal step
//   swaps   GATE_LAWN_DEC_LARGE_PATCH_K  the December potassium bag for a mapped large patch (config/lawn-v13-trouble-product-swaps.js)
// A visit with none of the removed keys keeps its own object (identity), so a reader that holds one sees the recipe's. Built once per
// combination.
const views = new Map();
function v13View({ addOns, swaps }) {
  const key = `${addOns ? 'a' : '-'}${swaps ? 's' : '-'}`;
  if (key === 'as') return v13;
  if (!views.has(key)) {
    const drop = [...(addOns ? [] : ['addOns']), ...(swaps ? [] : ['swaps'])];
    const strip = (visit) => (drop.some((name) => visit[name]) ? Object.fromEntries(Object.entries(visit).filter(([name]) => !drop.includes(name))) : visit);
    views.set(key, Object.fromEntries(Object.entries(v13).map(([track, program]) => [track, { ...program, visits: program.visits.map(strip) }])));
  }
  return views.get(key);
}

// GATE_LAWN_RECLAIMED_HALF_N: the two reclaimed-water sentences of the recipe (one line in every track's notes and one in its safety_rules) say what the TECH does.
// The JSON holds the wording that is true with the gate off ("the app does not adjust it yet"); with the gate on, the reader gets the wording
// that is true when the app halves the N (and names the two bags that keep their full rate). Swapped by exact sentence, so a recipe edit that
// rewords one of them fails the test that pins the pair instead of silently serving the old text.
const RECLAIMED_WORDING = Object.freeze([
  [
    'Reclaimed-water lawns (purple pipes or caps): the tech logs half the N at every N visit; the app does not adjust it yet.',
    'Reclaimed-water lawns (purple pipes or caps) get half the N at every N visit, except bags that carry the pre-emergent or the winter potassium, which keep their full rate. A line that shows "Reclaimed water: half nitrogen today" is already halved by the app; otherwise the tech logs half.',
  ],
  [
    'the tech logs half the N on reclaimed-water lawns (the app does not adjust it yet).',
    'reclaimed-water lawns get half the N at every N visit, except bags that carry the pre-emergent or the winter potassium, which keep their full rate. A line that shows "Reclaimed water: half nitrogen today" is already halved by the app; otherwise the tech logs half.',
  ],
]);
const reword = (line) => RECLAIMED_WORDING.reduce((text, [from, to]) => text.replace(from, to), line);
const withReclaimedWording = (program) => Object.fromEntries(Object.entries(program).map(([track, recipe]) => [track, {
  ...recipe, notes: recipe.notes.map(reword), safety_rules: recipe.safety_rules.map(reword),
}]));
// The reclaimed wording over each recipe view, built once per view (memoized: the readers keep identity per gate combination).
const reclaimedViews = new Map();
const reclaimedView = (view) => {
  if (!reclaimedViews.has(view)) reclaimedViews.set(view, withReclaimedWording(view));
  return reclaimedViews.get(view);
};

function lawnProtocols() {
  if (!featureGates.lawnV13Live?.()) return protocols.lawn;
  const view = v13View({ addOns: featureGates.lawnBermudaRemovalLive?.() === true, swaps: featureGates.lawnDecLargePatchKLive?.() === true });
  return featureGates.lawnReclaimedHalfNLive?.() === true ? reclaimedView(view) : view;
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
  // A visit on a 9x rounds series reads its round's step window (an unpinned one; a pin names its window) and the real date's weed
  // rows (getProtocolWindowContext roundStep).
  const roundStep = roundStepForPlan(scheduledService);
  return {
    serviceDate,
    grassTrack,
    windowKey: scheduledService?.lawn_protocol_window_key || null,
    protocolKey: scheduledService?.lawn_protocol_key || null,
    protocolVersion: scheduledService?.lawn_protocol_version || null,
    planning: true,
    ...(roundStep ? { roundStep: { round: roundStep.round, month: roundStep.month } } : {}),
  };
}

// A recipe visit can carry `cadenceVariants`: { "<applications a year>": { primary, secondary?, notes? } },
// the whole-lawn step a plan of that many applications runs INSTEAD of the visit's
// own step (the 12x one, also the default). v13 has one: April on the 9x plan
// (LESCO Dimension 0.21% 18-0-10, 0.5 lb N, in place of the 12x plan's LESCO 44-0-0
// polymer bag, 1.0 lb N; the variant's own notes carry its N rate). This is the one
// decision of which step a visit runs; the plan, the tank sheet and the
// completion defaults all read it. `visitsPerYear` is the plan's count, or null
// when unknown: the visit keeps its own step and `unknownCadence` names the
// variant products a known plan would have used (the caller warns).
function visitForCadence(visit, visitsPerYear) {
  const variants = visit?.cadenceVariants;
  if (!variants || typeof variants !== 'object') return { visit, branch: null, unknownCadence: null };
  const variant = variants[String(Number(visitsPerYear))];
  if (visitsPerYear != null && variant) {
    // A variant may state its own notes: the visit's N rate is read from the notes, so a variant whose
    // bag has another nitrogen target (v13 April: 12x 1.0 lb N, 9x 0.5 lb N) carries its own.
    return { visit: { ...visit, primary: variant.primary, ...(variant.secondary ? { secondary: variant.secondary } : {}), ...(variant.notes ? { notes: variant.notes } : {}) }, branch: String(Number(visitsPerYear)), unknownCadence: null };
  }
  if (visitsPerYear != null) return { visit, branch: null, unknownCadence: null };
  const names = Object.values(variants).flatMap((entry) => String(entry.primary || '').split('\n').map((line) => line.split(' \u2014 ')[0].trim()).filter(Boolean));
  return { visit, branch: null, unknownCadence: { variantProducts: [...new Set(names)], cadences: Object.keys(variants) } };
}

// ── 9x rounds visits (owner 2026-10-29) ─────────────────────────────────────────────────────────────────────────────────────────
// A visit on a lawn_rounds_9 series takes the program step of its ROUND (lawn-rounds.js ROUND_STEPS), not the step of its calendar
// month. Program products, nutrient targets and the program rules keyed by month follow the round's step; the weed and spot rows
// and lines, and every real-date rule (ordinance blackout, heat, chinch season), follow the date the visit is actually on.
const lawnRounds = require('./lawn-rounds');

// The step a booked visit takes, or null (a 12x, legacy 9x, one-time or non-lawn visit, or v13 off: the round map names v13 steps, so
// the old program keeps the calendar month). `row` needs recurring_pattern and scheduled_date.
function roundStepForPlan(row) {
  if (featureGates.lawnV13Live?.() !== true) return null;
  return lawnRounds.roundStepForVisit(row);
}

// The weed and spot products of the v13 recipe: the Celsius weed mix (Celsius, Certainty, the nonionic surfactant), Blindside in its
// place and Dismiss for sedge. Matched by name because the rows carry no weed flag; a bermuda removal row (gates.bermudaRemoval) is not one.
const WEED_SPOT_NAME = /^(celsius|certainty|blindside|dismiss)\b|nonionic surfactant/i;
const isWeedSpotName = (name) => WEED_SPOT_NAME.test(String(name || '').replace(/[^A-Za-z0-9/.]+/g, ' ').trim());
function isWeedSpotRow(row) {
  if (!row || row.gates?.bermudaRemoval) return false;
  return isWeedSpotName(row.product_name) || isWeedSpotName(row.catalog_product_name);
}

// The as-needed rows of a v13 window: every spot product (weed, fungicide, insecticide, wetting agent: role `*_spot`), the curative grub
// and mole cricket granule (`insect_curative`) and the optional fire ant add-on (`insecticide_optional_addon`). Each is applied only where
// its trigger is found, and its window holds the seasonal rules (February Celsius alone, Blindside and Dismiss November to March, the
// take-all, large patch, chinch bug and caterpillar months), so on a rounds visit they come from the spot month's window (the REAL date's,
// with the St. Augustine green-up exception: lawn-rounds.js roundSpotMonth) while every other row comes from the round's step window: the
// whole-lawn products, a trouble swap's replacement bag (the December 0-0-24), a sold area add-on. A bermuda removal row is not one.
const AS_NEEDED_ROLES = new Set(['insect_curative', 'insecticide_optional_addon']);
function isAsNeededRow(row) {
  if (!row || row.gates?.bermudaRemoval) return false;
  const role = String(row.role || '');
  return role.endsWith('_spot') || AS_NEEDED_ROLES.has(role) || isWeedSpotRow(row);
}

const recipeLines = (text) => String(text || '').split('\n').filter((line) => line.trim());

// The step visit a rounds visit reads: the round's step with its rounds-only variant applied (round 2: April's cadenceVariants["9"];
// round 3: February's roundVariants.lawn_rounds_9), so the plan, the tank sheet, the brief and the completion actions state the same
// bag and nitrogen target. `roundStep` is lawn-rounds.js roundStepForVisit's answer; null returns the visit untouched. A variant the
// recipe does not carry leaves the step as written (`branch` null).
function visitForRound(visit, roundStep) {
  if (!visit || !roundStep) return { visit, branch: null };
  if (roundStep.variant === 'cadence9') return visitForCadence(visit, 9);
  if (roundStep.variant !== 'rounds') return { visit, branch: null };
  const variant = visit.roundVariants?.[lawnRounds.LAWN_ROUNDS_9];
  if (!variant) return { visit, branch: null };
  return {
    visit: { ...visit, primary: variant.primary, ...(variant.secondary ? { secondary: variant.secondary } : {}), ...(variant.notes ? { notes: variant.notes } : {}) },
    branch: lawnRounds.LAWN_ROUNDS_9,
  };
}

// The round's step with the as-needed LINES of the spot month's step: every `secondary` line (the weed, disease and insect spots, the
// wetting agent, the curative granule, the fire ant add-on) is the spot month's, so the season decides them as it does for a 12x visit.
// The planned treatment (`primary`, the notes, the round's variant) stays the round step's. The same visit back when the two steps are
// the same month or the lines already agree.
function visitWithSpotLines(stepVisit, spotVisit) {
  if (!stepVisit || !spotVisit || stepVisit === spotVisit) return stepVisit;
  const secondary = recipeLines(spotVisit.secondary).join('\n');
  return secondary === String(stepVisit.secondary || '') ? stepVisit : { ...stepVisit, secondary };
}

// The warning for a visit whose plan cadence is unknown (visitForCadence's
// unknownCadence): it kept the 12x step and says what a known plan would have used.
function unknownCadenceWarning(unknownCadence) {
  return {
    code: 'lawn_v13_plan_cadence_unknown', severity: 'warning',
    message: `This visit's lawn plan (applications a year) is not on file, so the plan keeps the 12x step. On a ${unknownCadence.cadences.join('x or ')}x plan, use ${unknownCadence.variantProducts.join(' or ')} instead.`,
  };
}

module.exports = { BAHIA_TRACK, isBahiaGrass, lawnV13NoBahiaProgram, bahiaHasNoProgram, lawnTrackKnowledgeLines, lawnTrackNames, lawnProtocols, LAWN_V13_VERSION, LAWN_V13_ANY_GRASS_TRACK, lawnV13AnyGrassTrack, lawnV13NoProgramGrass, isServingProtocol, visitProtocolQuery, visitForCadence, unknownCadenceWarning, roundStepForPlan, isWeedSpotName, isWeedSpotRow, isAsNeededRow, visitForRound, visitWithSpotLines };
