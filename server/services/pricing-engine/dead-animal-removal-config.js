'use strict';

/**
 * The DB-editable knobs of Dead Rodent Removal & Odor Treatment (pricing_config key `rodent_dead_animal_removal`).
 *
 * Production pricing is DB-authoritative: the row seeds from the in-code table (constants.js RODENT.deadAnimalRemoval,
 * migration 20261029130100) and an admin may edit it. This file is the ONE validator of that row (the admin PUT and the
 * db-bridge sync both call it) and the one place that turns it into constants.
 *
 *   {
 *     "reachable": { "alone": 199, "on_site_min": 45 },
 *     "attic":     { "alone": 299, "on_site_min": 90 }
 *   }
 *
 *   alone         the tier's ONE price in dollars, a plain JSON number from 1 to 2000 (owner 2026-10-29: one price per
 *                 tier; other rodent work on the estimate does not lower it, staff discount on the estimate)
 *   on_site_min   whole minutes from 1 to 480: the tech's time on site; it also sizes the booked slot
 *   riding        RETIRED 2026-10-29 (it was the lower price when the estimate had other rodent work). A stored row
 *                 may still carry it, but only equal to `alone`, so it can never price anything lower; it is ignored.
 *
 * The in_wall tier has no price (a custom quote) and no knob. Fail closed: any known field outside its bounds, or not a
 * plain JSON number, or any unknown key, makes the WHOLE row unusable and the code defaults stand (never a half-applied
 * row). Every db-bridge sync restores the code defaults first, so a deleted or malformed row also leaves them.
 */

const TIERS = ['reachable', 'attic'];
const PRICE_BOUNDS = Object.freeze([1, 2000]);
const MINUTE_BOUNDS = Object.freeze([1, 480]);

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

// The row's data for a given constants block (used to seed a fresh install).
function defaultDeadAnimalRemovalData(block) {
  const source = block || require('./constants').RODENT.deadAnimalRemoval;
  return Object.fromEntries(TIERS.map((tier) => [tier, {
    alone: source[tier].alone,
    on_site_min: source[tier].durationMin,
  }]));
}

// { ok: true, value: { reachable: { alone, durationMin }, attic: {...} } } or { ok: false, error }.
function normalizeDeadAnimalRemovalConfig(data) {
  if (!isPlain(data)) return { ok: false, error: 'must be an object with reachable and attic' };
  const unknown = Object.keys(data).filter((key) => !TIERS.includes(key));
  if (unknown.length) return { ok: false, error: `${unknown[0]} is not a knob (only ${TIERS.join(' and ')})` };
  const value = {};
  for (const tier of TIERS) {
    const row = data[tier];
    if (!isPlain(row)) return { ok: false, error: `${tier} must be an object with alone and on_site_min` };
    const extra = Object.keys(row).filter((key) => !['alone', 'riding', 'on_site_min'].includes(key));
    if (extra.length) return { ok: false, error: `${tier}.${extra[0]} is not a knob` };
    if (!isNum(row.alone) || row.alone < PRICE_BOUNDS[0] || row.alone > PRICE_BOUNDS[1]) {
      return { ok: false, error: `${tier}.alone must be a number from ${PRICE_BOUNDS[0]} to ${PRICE_BOUNDS[1]}` };
    }
    if ('riding' in row && row.riding !== row.alone) {
      return { ok: false, error: `${tier}.riding is retired (one price per tier since 2026-10-29): remove it or set it equal to ${tier}.alone` };
    }
    if (!isNum(row.on_site_min) || !Number.isInteger(row.on_site_min)
      || row.on_site_min < MINUTE_BOUNDS[0] || row.on_site_min > MINUTE_BOUNDS[1]) {
      return { ok: false, error: `${tier}.on_site_min must be a whole number of minutes from ${MINUTE_BOUNDS[0]} to ${MINUTE_BOUNDS[1]}` };
    }
    value[tier] = { alone: row.alone, durationMin: row.on_site_min };
  }
  return { ok: true, value };
}

// Applies a valid row onto the live constants block; returns true when it was applied.
function applyDeadAnimalRemovalConfig(data, block) {
  const verdict = normalizeDeadAnimalRemovalConfig(data);
  if (!verdict.ok) return false;
  for (const tier of TIERS) Object.assign(block[tier], verdict.value[tier]);
  return true;
}

module.exports = {
  TIERS,
  PRICE_BOUNDS,
  MINUTE_BOUNDS,
  defaultDeadAnimalRemovalData,
  normalizeDeadAnimalRemovalConfig,
  applyDeadAnimalRemovalConfig,
};
