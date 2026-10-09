'use strict';

/**
 * The DB-editable knobs of the area add-on prices (pricing_config key `area_addon_pricing`).
 *
 * Production pricing is DB-authoritative: the row seeds from the in-code table (constants.js AREA_ADDONS) and an
 * admin edits it on the existing Pricing Logic panel (One-time tab). This file is the ONE validator of that row
 * (the admin PUT and the db-bridge sync both call it) and the one place that applies it.
 *
 *   targetMargin    group      price = cost / (1 - targetMargin)
 *   adminPerJob     group      the booking-and-invoicing charge of one job, in dollars
 *   items.<key>     per add-on materialPer1000 ($ per 1,000 sq ft), setupMin, minPer1000 (minutes per 1,000 sq ft),
 *                              tiers (the sq ft bands, ascending; the web sweep has none)
 *
 * NOT editable, whatever the row says: maxPerYear, minDaysApart, requiresGrassTrack, limitProduct (label and owner
 * rulings), serviceKey, name, category, areaLabel (identity). The admin PUT refuses a row that names one; the sync
 * ignores it.
 *
 * Fail closed: any known field outside its bounds, or not a plain JSON number, makes the WHOLE row unusable and the
 * code defaults stand (never a half-applied row). Every sync rebases AREA_ADDONS onto the defaults first, so a deleted
 * or invalid row restores them on the next sync, never the previous edit.
 */
const { AREA_ADDONS, areaAddOnPricingDefaults } = require('./constants');

const DEFAULTS = areaAddOnPricingDefaults();

const BOUNDS = Object.freeze({
  targetMargin: [0.25, 0.85],
  adminPerJob: [0, 100],
  materialPer1000: [0, 200],
  setupMin: [0, 240],
  minPer1000: [0, 120],
});
const TIER_BOUNDS = Object.freeze({ min: 100, max: 100000, count: 6 });
const ITEM_FIELDS = ['materialPer1000', 'setupMin', 'minPer1000', 'tiers'];

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
const inBounds = (field, value) => isNum(value) && value >= BOUNDS[field][0] && value <= BOUNDS[field][1];

function checkTiers(key, tiers, errors) {
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > TIER_BOUNDS.count
    || !tiers.every((t) => isNum(t) && Number.isInteger(t) && t >= TIER_BOUNDS.min && t <= TIER_BOUNDS.max)
    || !tiers.every((t, i) => i === 0 || t > tiers[i - 1])) {
    errors.push(`items.${key}.tiers must be 1 to ${TIER_BOUNDS.count} whole sq ft numbers from ${TIER_BOUNDS.min} to ${TIER_BOUNDS.max}, each larger than the one before`);
  }
}

function checkItem(key, item, strict, errors) {
  if (!isPlain(item)) { errors.push(`items.${key} must be an object`); return; }
  for (const field of Object.keys(item)) {
    if (!ITEM_FIELDS.includes(field) && strict) errors.push(`items.${key}.${field} is set in code, not here`);
  }
  for (const field of ['materialPer1000', 'setupMin', 'minPer1000']) {
    if (item[field] !== undefined && !inBounds(field, item[field])) {
      errors.push(`items.${key}.${field} must be a number from ${BOUNDS[field][0]} to ${BOUNDS[field][1]}`);
    }
  }
  if (item.tiers === undefined) return;
  if (DEFAULTS.items[key].tiers !== null) checkTiers(key, item.tiers, errors);
  else if (strict) errors.push(`items.${key} has no area tiers`);
}

/**
 * Validates a row's data. strict (the admin PUT) also refuses a key this table does not own; the sync passes strict
 * false and simply ignores them. { ok: true, value } with the known fields, or { ok: false, error }.
 */
function normalizeAreaAddOnPricingConfig(data, { strict = true } = {}) {
  const errors = [];
  if (!isPlain(data)) return { ok: false, error: 'area_addon_pricing must be an object' };
  for (const field of Object.keys(data)) {
    if (!['targetMargin', 'adminPerJob', 'items'].includes(field) && strict) errors.push(`${field} is not a setting of this row`);
  }
  for (const field of ['targetMargin', 'adminPerJob']) {
    if (data[field] !== undefined && !inBounds(field, data[field])) errors.push(`${field} must be a number from ${BOUNDS[field][0]} to ${BOUNDS[field][1]}`);
  }
  const items = {};
  if (data.items !== undefined && !isPlain(data.items)) errors.push('items must be an object');
  for (const [key, item] of Object.entries(isPlain(data.items) ? data.items : {})) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS.items, key)) {
      checkItem(key, item, strict, errors);
      items[key] = item;
    } else if (strict) errors.push(`items.${key} is not an add-on`);
  }
  if (errors.length) return { ok: false, error: errors[0] };
  return { ok: true, value: { targetMargin: data.targetMargin, adminPerJob: data.adminPerJob, items } };
}

// AREA_ADDONS back onto the in-code defaults (in place: every module holds this object).
function rebaseAreaAddOns(target = AREA_ADDONS) {
  target.targetMargin = DEFAULTS.targetMargin;
  target.adminPerJob = DEFAULTS.adminPerJob;
  for (const [key, defaults] of Object.entries(DEFAULTS.items)) {
    Object.assign(target.items[key], { materialPer1000: defaults.materialPer1000, setupMin: defaults.setupMin, minPer1000: defaults.minPer1000, tiers: defaults.tiers ? [...defaults.tiers] : null });
  }
}

/**
 * The sync's one call: rebase onto the defaults, then apply the row when it is valid. Returns { applied, error? }.
 * `row` undefined (no row) applies nothing and is not an error.
 */
function applyAreaAddOnPricingConfig(row, target = AREA_ADDONS) {
  rebaseAreaAddOns(target);
  if (row === undefined || row === null) return { applied: false };
  const verdict = normalizeAreaAddOnPricingConfig(row, { strict: false });
  if (!verdict.ok) return { applied: false, error: verdict.error };
  const { targetMargin, adminPerJob, items } = verdict.value;
  if (targetMargin !== undefined) target.targetMargin = targetMargin;
  if (adminPerJob !== undefined) target.adminPerJob = adminPerJob;
  for (const [key, item] of Object.entries(items)) {
    for (const field of ITEM_FIELDS) {
      if (item[field] === undefined) continue;
      if (field === 'tiers' && DEFAULTS.items[key].tiers === null) continue;
      target.items[key][field] = field === 'tiers' ? [...item[field]] : item[field];
    }
  }
  return { applied: true };
}

// What db-bridge calls on every sync: apply, and say so when the row was refused (the code defaults stand).
function syncAreaAddOnPricingConfig(row, target = AREA_ADDONS) {
  const applied = applyAreaAddOnPricingConfig(row, target);
  if (applied.error) console.warn(`[db-bridge] area_addon_pricing rejected (${applied.error}); the in-code add-on prices stand`);
  return applied;
}

// The knobs one add-on line was priced with, as stamped on the line (pricingKnobs) and replayed from the stored
// estimate: the group's margin and admin charge, and this add-on's own cost knobs and tiers. `replay` is the stored
// signal (areaAddOnPricingKnobs: { targetMargin, adminPerJob, items: { <key>: {...} } }); a field it lacks is the live value.
function areaAddOnKnobsFor(addOnKey, replay = null) {
  const cfg = AREA_ADDONS.items[addOnKey];
  const stored = replay && isPlain(replay.items) && isPlain(replay.items[addOnKey]) ? replay.items[addOnKey] : {};
  const num = (field, value, live) => (inBounds(field, value) ? value : live);
  const tiers = cfg.tiers && Array.isArray(stored.tiers) && stored.tiers.length && stored.tiers.every((t) => isNum(t) && t > 0) ? [...stored.tiers] : (cfg.tiers ? [...cfg.tiers] : null);
  return {
    targetMargin: num('targetMargin', replay && replay.targetMargin, AREA_ADDONS.targetMargin),
    adminPerJob: num('adminPerJob', replay && replay.adminPerJob, AREA_ADDONS.adminPerJob),
    materialPer1000: num('materialPer1000', stored.materialPer1000, cfg.materialPer1000),
    setupMin: num('setupMin', stored.setupMin, cfg.setupMin),
    minPer1000: num('minPer1000', stored.minPer1000, cfg.minPer1000),
    tiers,
  };
}

// The row's data at the in-code defaults: what the migration seeds and the route's table-creating fallback inserts.
function defaultAreaAddOnPricingData() {
  return {
    targetMargin: DEFAULTS.targetMargin,
    adminPerJob: DEFAULTS.adminPerJob,
    items: Object.fromEntries(Object.entries(DEFAULTS.items).map(([key, item]) => [key, {
      materialPer1000: item.materialPer1000, setupMin: item.setupMin, minPer1000: item.minPer1000, ...(item.tiers ? { tiers: [...item.tiers] } : {}),
    }])),
  };
}

module.exports = { defaultAreaAddOnPricingData, BOUNDS, TIER_BOUNDS, normalizeAreaAddOnPricingConfig, applyAreaAddOnPricingConfig, syncAreaAddOnPricingConfig, rebaseAreaAddOns, areaAddOnKnobsFor };
