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
 *  - a priced add-on row with NO stamp predates the stamp, so it was priced with the in-code defaults: they replay
 *    (the labor rate and the drive minutes were never in the defaults: they replay as current at replay);
 *  - an estimate with no priced add-on row returns null (inject nothing), so fresh quotes resolve the live config.
 * Only the keys the estimate actually sold are in the signal: an add-on added later prices off the live row.
 */
const DEFAULTS = require('./pricing-engine/constants').areaAddOnPricingDefaults();
const { areaAddOnKnobsFor } = require('./pricing-engine/area-addon-config');
const { storedAreaAddOnRows } = require('./estimate-result-container');

// Every stored row of a priced area add-on, from the authoritative container (a revision's stale
// `engineResult` never supplies a knob stamp for an add-on the revision removed).
function pricedAddOnRows(estData) {
  // Priced by ANY amount field the booking reads (area-addon-limits isSoldAddOnRow): a row sold through `amount`, `total` or a
  // discounted field freezes its knobs too.
  const { isSoldAddOnRow } = require('./area-addon-limits');
  return storedAreaAddOnRows(estData).filter((row) => isSoldAddOnRow(row) && Object.prototype.hasOwnProperty.call(DEFAULTS.items, row.addOnKey));
}

function areaAddOnKnobSignalForReplay(estDataRaw) {
  const rows = pricedAddOnRows(estDataRaw);
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
  // laborRate and driveMinutes are the labor cost's two global inputs. A stamped row freezes them; a row with no stamp
  // (priced before the stamp) leaves them out, so it replays the values current at replay (its other knobs replay the in-code defaults).
  return { targetMargin: group.targetMargin, adminPerJob: group.adminPerJob, laborRate: group.laborRate, driveMinutes: group.driveMinutes, items };
}

// The input fields a replay adds: { areaAddOnPricingKnobs } for a stored estimate that sold an add-on, else {}.
function areaAddOnReplayOverrides(estData) {
  const signal = areaAddOnKnobSignalForReplay(estData);
  return signal ? { areaAddOnPricingKnobs: signal } : {};
}

module.exports = { areaAddOnKnobSignalForReplay, areaAddOnReplayOverrides };
