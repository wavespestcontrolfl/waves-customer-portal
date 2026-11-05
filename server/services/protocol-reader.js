/**
 * Shared protocol reader.
 *
 * Protocols describe scope, cadence, products, preparation, and safety. They
 * never contribute dollars to an estimate; the pricing engine remains the
 * only pricing authority.
 */

const protocols = require('../config/protocols.json');
const { lawnProtocols, isBahiaGrass, bahiaHasNoProgram, lawnV13NoBahiaProgram } = require('./lawn-program');

const LAWN_TRACK_ALIASES = Object.freeze({
  a: 'st_augustine',
  a_st_aug_sun: 'st_augustine',
  b: 'st_augustine',
  b_st_aug_shade: 'st_augustine',
  c1: 'bermuda',
  c1_bermuda: 'bermuda',
  c2: 'zoysia',
  c2_zoysia: 'zoysia',
  d: 'bahia',
  d_bahia: 'bahia',
  'st augustine': 'st_augustine',
});

const PROTOCOL_KEY_ALIASES = Object.freeze({
  pest: 'pest',
  pest_control: 'pest',
  one_time_pest: 'pest',
  flea: 'pest',
  flea_control: 'pest',
  stinging: 'pest',
  stinging_v2: 'pest',
  stinging_insect: 'pest',
  one_time_lawn: 'lawn',
  tree: 'tree_shrub',
  tree_shrub: 'tree_shrub',
  mosquito: 'mosquito',
  one_time_mosquito: 'mosquito',
  termite: 'termite',
  termite_bait: 'termite',
  trenching: 'termite',
  termite_trenching: 'termite',
  bora_care: 'termite',
  pre_slab_termiticide: 'termite',
  pre_slab_termidor: 'termite',
  rodent: 'rodent',
  rodent_bait: 'rodent',
  palm: 'palm_injection',
  palm_injection: 'palm_injection',
  cockroach: 'cockroach',
  german_roach: 'cockroach',
  german_roach_initial: 'cockroach',
  german_roach_cleanout: 'cockroach',
  pest_initial_roach: 'cockroach',
  cockroach_control: 'cockroach',
  vehicle_german_roach: 'cockroach',
  roach: 'cockroach',
  rodent_trapping: 'rodent',
  bed_bug: 'bed_bug',
  bedbug: 'bed_bug',
});

function availablePrograms() {
  return Object.keys(protocols);
}

function availableLawnTracks() {
  return Object.keys(lawnProtocols() || {});
}

// GATE_LAWN_V13: the v13 program has no bahia track (the Celsius label says do not use it on
// bahiagrass, and Blindside is not labeled for bahia). The bahia aliases (bahia, d, d_bahia)
// stay for the old program, so callers are never told to ask for a track that is not there.
const V13_NO_PROGRAM_NOTE = 'Bahiagrass has no lawn program under v13: the Celsius label says do not use it on bahiagrass and Blindside is not labeled for bahia. Plan no lawn products for it; the visit work is entered by hand.';
// The note that names the lawn tracks a caller may ask for. Gate off it is the old text, word for word.
function lawnTrackAdvice() {
  if (lawnV13NoBahiaProgram()) {
    return `Specify ${availableLawnTracks().join(', ')} (legacy A/B = St. Augustine, C1 = Bermuda, C2 = Zoysia). Bahiagrass has no v13 program.`;
  }
  return 'Specify st_augustine, bermuda, zoysia, or bahia (legacy A/B = St. Augustine, C1 = Bermuda, C2 = Zoysia, D = Bahia).';
}

function normalizeLawnTrack(value) {
  const requested = String(value || '').trim().toLowerCase();
  if (!requested) return 'st_augustine';
  if (lawnProtocols()?.[requested]) return requested;
  // Bahia is a real track only while the old program is live; the name still resolves to itself so
  // getProtocol can say it has no v13 program instead of calling it an unknown track.
  return LAWN_TRACK_ALIASES[requested] || (isBahiaGrass(requested) ? 'bahia' : null);
}

function normalizeProtocolKey(value) {
  const requested = String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  // one_time_lawn / lawn_pest_knockdown are Agent Estimate service keys that
  // still follow the lawn protocol family — without the alias, get_protocol
  // reports "no program exists" and the required protocol review is skipped.
  if (['lawn', 'lawn_care', 'one_time_lawn', 'lawn_pest_control', 'lawn_pest_knockdown'].includes(requested)) return 'lawn';
  return PROTOCOL_KEY_ALIASES[requested] || requested || null;
}

function getProtocol({ service_type: serviceType, lawn_track: lawnTrack } = {}) {
  const key = normalizeProtocolKey(serviceType);

  if (key === 'lawn') {
    const track = normalizeLawnTrack(lawnTrack);
    if (track && lawnProtocols()?.[track]) {
      return { protocol: lawnProtocols()[track], track, type: 'lawn_care' };
    }
    if (bahiaHasNoProgram(track)) {
      return { available_tracks: availableLawnTracks(), no_program: true, note: V13_NO_PROGRAM_NOTE };
    }
    return {
      available_tracks: availableLawnTracks(),
      note: lawnTrackAdvice(),
    };
  }

  if (key && protocols[key] && key !== 'lawn') {
    return { protocol: protocols[key], type: key };
  }

  return {
    type: serviceType || null,
    available_programs: availablePrograms(),
    note: `No "${serviceType || ''}" program in protocols.json — choose an available program.`,
  };
}

// Owner-only cost keys and priced-line text, stripped for a technician viewer
// (moved here from routes/admin-protocols.js so the REST routes and the
// Intelligence Bar get_protocol tool share one copy).
// codex round 1 P1: the structured cost fields were stripped, but item.raw
// (and visit.primary/secondary, which item.raw lines are parsed FROM) still
// carry the protocol's own priced-line convention verbatim — e.g. "K-Flow
// 0-0-25 ($2.18)" — which ProtocolReferenceTabV2.jsx renders unconditionally.
// Strip every dollar-figure token: the parenthesized "($x.xx)" / "($x+$y)" /
// "($x est)" cost-tag convention (isPricedProtocolLine's own pattern), and
// any bare "$N" left over (e.g. "OPTIONAL if requested — $15",
// ">$60 YTD = reprice flag").
function stripPriceTokensFromText(text) {
  if (!text) return text;
  return String(text)
    .replace(/\s*\([^)]*\$[^)]*\)/g, '')
    .replace(/[<>]?\$\s?\d[\d,.]*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+(\n|$)/g, '$1')
    .trim();
}

// Deep, whole-payload backstop for the same rule: any string anywhere in
// the lawn-mix response (visit.primary/secondary, an unmatched-line
// warning message, a mixingOrder instruction that falls back to item.raw
// when the catalog product has no mixing_instructions, …) gets every
// dollar-figure token stripped for a non-admin viewer. Field-level
// stripping above (stripLawnMixItemPricing, materialCostSummary: null)
// stays the primary mechanism; this closes every path that copies raw
// protocol-line text into the response instead of a structured field.
function deepStripPriceTokens(value) {
  if (typeof value === 'string') return stripPriceTokensFromText(value);
  if (Array.isArray(value)) return value.map(deepStripPriceTokens);
  // codex-review P1: a Date (equipment.expiresAt, product.labelVerifiedAt)
  // has no OWN enumerable properties, so recursing into it like a plain
  // object produced {} — ProtocolTankSheet then rendered a quantity/expiry
  // as missing. Only recurse into an actual plain object; every other
  // object type (Date, RegExp, Buffer, …) passes through untouched.
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = deepStripPriceTokens(val);
    return out;
  }
  return value;
}

// codex round 4 P1 (PR #4673): the raw protocols.json catalog routes below
// (/programs, /programs/:track/visit/:num, /match, /completion-actions) are
// technician-reachable (router-level requireTechOrAdmin) and hand back the
// track/program/visit objects verbatim — each visit carries the owner-only
// per-visit cost figures (material_cost / conditional_cost / labor_cost, a
// program's costing_assumptions and minimum_price_per_palm) AND the same
// "($2.18)" priced-line convention in primary/secondary that lawn-mix
// already strips. ProtocolReferenceTabV2's "View full calendar" table and
// SchedulePage's protocol panels render them straight from these payloads.
// Same rule as lawn-mix: the recipe stays, every cost figure goes, and the
// response is tagged viewerRole so the client hides the cost columns
// instead of rendering "—" placeholders. Only plain objects are recursed
// (the Date-passthrough rule deepStripPriceTokens documents above).
const OWNER_ONLY_PROTOCOL_COST_KEYS = new Set([
  'material_cost', 'conditional_cost', 'labor_cost', 'costing_assumptions', 'minimum_price_per_palm',
]);
function stripKeysDeep(value, keys) {
  if (Array.isArray(value)) return value.map((item) => stripKeysDeep(item, keys));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (keys.has(key)) continue;
      out[key] = stripKeysDeep(val, keys);
    }
    return out;
  }
  return value;
}
const stripOwnerOnlyProtocolCostFields = (value) => stripKeysDeep(value, OWNER_ONLY_PROTOCOL_COST_KEYS);

module.exports = {
  LAWN_TRACK_ALIASES,
  PROTOCOL_KEY_ALIASES,
  availableLawnTracks,
  availablePrograms,
  getProtocol,
  stripPriceTokensFromText,
  deepStripPriceTokens,
  stripOwnerOnlyProtocolCostFields,
  stripKeysDeep,
  normalizeLawnTrack,
  normalizeProtocolKey,
};
