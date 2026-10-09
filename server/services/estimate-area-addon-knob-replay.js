'use strict';

/**
 * Saved area add-on price knobs for estimate replay (pricing_config key `area_addon_pricing`).
 *
 * The add-on prices are DB-authoritative and an admin can edit them. Every replay path re-runs generateEstimate under
 * whatever the constants say NOW, so without an input-level override an edit between save and view/accept would
 * re-price an ALREADY-SENT quote and then lock and bill the new amount. Same contract as the Tree & Shrub knobs
 * (estimate-tree-shrub-knob-replay.js), and shared the same way by BOTH authoritative replay paths: the public one
 * (estimate-public#savedFloorReplayOverrides) and the server-authoritative recompute
 * (admin-estimate-persistence#serverRecomputeFromEstimateData).
 *
 *  - a priced add-on row carries `pricingKnobs` (stamped by the pricer): they replay verbatim;
 *  - a priced add-on row with NO stamp predates the stamp, so it was priced with the in-code defaults: they replay;
 *  - an estimate with no priced add-on row returns null (inject nothing), so fresh quotes resolve the live config.
 * Only the keys the estimate actually sold are in the signal: an add-on added later prices off the live row.
 */
const { AREA_ADDON_PRICING_DEFAULTS: DEFAULTS } = require('./pricing-engine/constants');
const { areaAddOnKnobsFor } = require('./pricing-engine/area-addon-config');

function parse(estData) {
  if (typeof estData === 'string') { try { return JSON.parse(estData); } catch { return null; } }
  return estData && typeof estData === 'object' ? estData : null;
}

// Every stored row of a priced area add-on, mapped or raw.
function pricedAddOnRows(estData) {
  const roots = [estData, estData && estData.result].filter((root) => root && typeof root === 'object');
  const lists = roots.flatMap((root) => [root.oneTime && root.oneTime.items, root.oneTime && root.oneTime.specItems, root.specItems, root.lineItems]);
  lists.push(estData && estData.engineResult && estData.engineResult.lineItems);
  return lists.filter(Array.isArray).flat()
    .filter((row) => row && row.service === 'area_addon' && typeof row.addOnKey === 'string'
      && Object.prototype.hasOwnProperty.call(DEFAULTS.items, row.addOnKey) && Number(row.price) > 0);
}

function areaAddOnKnobSignalForReplay(estDataRaw) {
  const rows = pricedAddOnRows(parse(estDataRaw));
  if (!rows.length) return null;
  const stampedRow = rows.find((row) => row.pricingKnobs && typeof row.pricingKnobs === 'object');
  const group = stampedRow ? stampedRow.pricingKnobs : DEFAULTS;
  const items = {};
  for (const row of rows) {
    const stamp = row.pricingKnobs && typeof row.pricingKnobs === 'object' ? row.pricingKnobs : null;
    if (items[row.addOnKey] && !stamp) continue;
    const knobs = stamp ? areaAddOnKnobsFor(row.addOnKey, { ...stamp, items: { [row.addOnKey]: stamp } }) : DEFAULTS.items[row.addOnKey];
    items[row.addOnKey] = { materialPer1000: knobs.materialPer1000, setupMin: knobs.setupMin, minPer1000: knobs.minPer1000, tiers: knobs.tiers ? [...knobs.tiers] : null };
  }
  return { targetMargin: group.targetMargin, adminPerJob: group.adminPerJob, items };
}

// The input fields a replay adds: { areaAddOnPricingKnobs } for a stored estimate that sold an add-on, else {}.
function areaAddOnReplayOverrides(estData) {
  const signal = areaAddOnKnobSignalForReplay(estData);
  return signal ? { areaAddOnPricingKnobs: signal } : {};
}

module.exports = { areaAddOnKnobSignalForReplay, areaAddOnReplayOverrides };
