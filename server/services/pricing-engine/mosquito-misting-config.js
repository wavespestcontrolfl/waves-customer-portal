'use strict';

/**
 * The DB-editable prices of the mosquito misting system (pricing_config key `mosquito_misting_pricing`).
 *
 * Production pricing is DB-authoritative: the row seeds from the in-code table (constants.js MOSQUITO_MISTING) and an
 * admin edits it on the Pricing Logic panel (Mosquito tab). This file is the ONE validator of that row (the admin PUT
 * and the db-bridge sync both call it) and the one place that applies it.
 *
 *   tiers.<key>      price, hardwareCost, includedNozzles
 *   extraNozzlePrice, extraNozzleCost, includedRisers, extraRiserPrice, extraRiserCost
 *   install          techs, hours (install labor = techs x hours x the global labor rate)
 *   plan             monthly (the price of one monthly application), visitsPerYear, laborMinutesPerVisit, partsReservePerMonth
 *   refills.<key>    price (per refill application), productCost
 *   serviceCallNoPlan
 *
 * NOT editable, whatever the row says: labels, minNozzles, maxNozzles, maxRisers, maxRefillsPerYear, defaultTier,
 * defaultSolution, defaultRefillsPerYear. The admin PUT refuses a row that names one; the sync ignores it.
 *
 * Fail closed: any known field outside its bounds, or not a plain JSON number, makes the WHOLE row unusable and the
 * code defaults stand (never a half-applied row). Every sync rebases MOSQUITO_MISTING onto the defaults first, so a
 * deleted or invalid row restores them on the next sync, never the previous edit.
 */
const { MOSQUITO_MISTING, mosquitoMistingPricingDefaults } = require('./constants');

const DEFAULTS = mosquitoMistingPricingDefaults();

const PRICE = [0, 20000];
const COST = [0, 20000];
const BOUNDS = Object.freeze({
  price: PRICE,
  hardwareCost: COST,
  // Whole numbers inside the code-owned layout limits (minNozzles..maxNozzles), so an included count can never sit outside what the pricer sells.
  includedNozzles: [MOSQUITO_MISTING.minNozzles, MOSQUITO_MISTING.maxNozzles],
  extraNozzlePrice: PRICE,
  extraNozzleCost: COST,
  includedRisers: [0, MOSQUITO_MISTING.maxRisers],
  extraRiserPrice: PRICE,
  extraRiserCost: COST,
  techs: [1, 4],
  hours: [0, 80],
  // A $0 plan would drop the line (and its install) out of the engine's recurring totals: must be positive.
  monthly: [1, PRICE[1]],
  visitsPerYear: [1, 24],
  laborMinutesPerVisit: [0, 240],
  partsReservePerMonth: COST,
  productCost: COST,
  serviceCallNoPlan: PRICE,
});

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const WHOLE = new Set(['includedNozzles', 'includedRisers', 'visitsPerYear', 'techs']);
const inBounds = (field, value) => isNum(value) && (!WHOLE.has(field) || Number.isInteger(value)) && value >= BOUNDS[field][0] && value <= BOUNDS[field][1];
const range = (field) => `${BOUNDS[field][0]} to ${BOUNDS[field][1]}`;
const kind = (field) => (WHOLE.has(field) ? 'a whole number' : 'a number');

const TOP_NUMBERS = ['extraNozzlePrice', 'extraNozzleCost', 'includedRisers', 'extraRiserPrice', 'extraRiserCost', 'serviceCallNoPlan'];
// Group name -> its editable number fields (a group with keyed members is listed in KEYED).
const GROUPS = { install: ['techs', 'hours'], plan: ['monthly', 'visitsPerYear', 'laborMinutesPerVisit', 'partsReservePerMonth'] };
const KEYED = { tiers: ['price', 'hardwareCost', 'includedNozzles'], refills: ['price', 'productCost'] };
const TOP_KEYS = [...TOP_NUMBERS, ...Object.keys(GROUPS), ...Object.keys(KEYED)];

function checkFields(path, obj, fields, strict, errors) {
  if (!isPlain(obj)) { errors.push(`${path} must be an object`); return; }
  for (const field of Object.keys(obj)) {
    if (!fields.includes(field) && strict) errors.push(`${path}.${field} is set in code, not here`);
  }
  for (const field of fields) {
    if (obj[field] !== undefined && !inBounds(field, obj[field])) errors.push(`${path}.${field} must be ${kind(field)} from ${range(field)}`);
  }
}

/**
 * Validates a row's data. strict (the admin PUT) also refuses a key this table does not own; the sync passes strict
 * false and simply ignores them. { ok: true, value } with the known fields, or { ok: false, error }.
 */
function normalizeMosquitoMistingPricingConfig(data, { strict = true } = {}) {
  const errors = [];
  if (!isPlain(data)) return { ok: false, error: 'mosquito_misting_pricing must be an object' };
  for (const field of Object.keys(data)) {
    if (!TOP_KEYS.includes(field) && strict) errors.push(`${field} is not a setting of this row`);
  }
  const value = {};
  for (const field of TOP_NUMBERS) {
    if (data[field] === undefined) continue;
    if (!inBounds(field, data[field])) errors.push(`${field} must be ${kind(field)} from ${range(field)}`);
    value[field] = data[field];
  }
  for (const [group, fields] of Object.entries(GROUPS)) {
    if (data[group] === undefined) continue;
    checkFields(group, data[group], fields, strict, errors);
    value[group] = data[group];
  }
  for (const [group, fields] of Object.entries(KEYED)) {
    if (data[group] === undefined) continue;
    if (!isPlain(data[group])) { errors.push(`${group} must be an object`); continue; }
    value[group] = {};
    for (const [key, member] of Object.entries(data[group])) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS[group], key)) {
        checkFields(`${group}.${key}`, member, fields, strict, errors);
        value[group][key] = member;
      } else if (strict) errors.push(`${group}.${key} is not one of ours`);
    }
  }
  if (errors.length) return { ok: false, error: errors[0] };
  return { ok: true, value };
}

// MOSQUITO_MISTING back onto the in-code defaults (in place: every module holds this object).
function rebaseMosquitoMisting(target = MOSQUITO_MISTING) {
  for (const field of TOP_NUMBERS) target[field] = DEFAULTS[field];
  for (const [group, fields] of Object.entries(GROUPS)) {
    for (const field of fields) target[group][field] = DEFAULTS[group][field];
  }
  for (const [group, fields] of Object.entries(KEYED)) {
    for (const key of Object.keys(DEFAULTS[group])) {
      for (const field of fields) target[group][key][field] = DEFAULTS[group][key][field];
    }
  }
}

/**
 * The sync's one call: rebase onto the defaults, then apply the row when it is valid. Returns { applied, error? }.
 * `row` undefined (no row) applies nothing and is not an error.
 */
// Which refill solutions the LAST apply took a price for from the row. The sync keeps the in-code defaults for anything the row did not
// supply (no row, a refused row, or a partial one that leaves a solution out), which is right for a quote on a fresh environment; a billed
// refill price must be the row's own, so the resolver asks about the one solution it prices.
let appliedRefillPrices = new Set();
function mistingRefillPriceIsFromRow(solution) {
  return appliedRefillPrices.has(String(solution == null ? '' : solution).trim().toLowerCase());
}

function applyMosquitoMistingPricingConfig(row, target = MOSQUITO_MISTING) {
  appliedRefillPrices = new Set();
  rebaseMosquitoMisting(target);
  if (row === undefined || row === null) return { applied: false };
  const verdict = normalizeMosquitoMistingPricingConfig(row, { strict: false });
  if (!verdict.ok) return { applied: false, error: verdict.error };
  const value = verdict.value;
  for (const field of TOP_NUMBERS) if (value[field] !== undefined) target[field] = value[field];
  for (const [group, fields] of Object.entries(GROUPS)) {
    for (const field of fields) if (value[group] && value[group][field] !== undefined) target[group][field] = value[group][field];
  }
  for (const [group, fields] of Object.entries(KEYED)) {
    for (const [key, member] of Object.entries(value[group] || {})) {
      for (const field of fields) if (member[field] !== undefined) target[group][key][field] = member[field];
    }
  }
  for (const [key, member] of Object.entries(value.refills || {})) if (member && member.price !== undefined) appliedRefillPrices.add(key);
  return { applied: true };
}

// What db-bridge calls on every sync: apply, and say so when the row was refused (the code defaults stand).
function syncMosquitoMistingPricingConfig(row, target = MOSQUITO_MISTING) {
  const applied = applyMosquitoMistingPricingConfig(row, target);
  if (applied.error) console.warn(`[db-bridge] mosquito_misting_pricing rejected (${applied.error}); the in-code misting prices stand`);
  return applied;
}

// The per-refill-application price of ONE named solution (misting PR 2c). Reads the LIVE table, so it is DB-authoritative through the
// pricing_config sync exactly like a quote. An unknown, missing or non-positive solution price is null: the refill is then UNPRICED
// and refused, never read as the Standard price (the catalog row's base_price is only the Standard placeholder).
function mistingRefillPriceFor(solution, target = MOSQUITO_MISTING) {
  const key = String(solution == null ? '' : solution).trim().toLowerCase();
  const refills = target.refills || {};
  if (!Object.prototype.hasOwnProperty.call(refills, key)) return null;
  const price = Number(refills[key].price);
  return Number.isFinite(price) && price > 0 ? price : null;
}

// The row's data at the in-code defaults: what the migration seeds and the route's table-creating fallback inserts.
function defaultMosquitoMistingPricingData() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

module.exports = {
  BOUNDS,
  defaultMosquitoMistingPricingData,
  normalizeMosquitoMistingPricingConfig,
  applyMosquitoMistingPricingConfig,
  syncMosquitoMistingPricingConfig,
  rebaseMosquitoMisting,
  mistingRefillPriceFor,
  mistingRefillPriceIsFromRow,
};
