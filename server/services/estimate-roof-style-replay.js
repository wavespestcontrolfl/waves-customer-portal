'use strict';

/**
 * Quote-time roof style terms for estimate replay (GATE_EXCLUSION_ROOF_STYLE_PRICING).
 *
 * The tile multiplier and the barrel eave closure rate and minimum live in code (RODENT.exclusionV2), so a later change to
 * them would re-price an ALREADY-SENT quote on every replay. Same contract as estimate-whole-home-replay.js: shared by BOTH
 * authoritative replay paths (estimate-public#savedFloorReplayOverrides and
 * admin-estimate-persistence#serverRecomputeFromEstimateData).
 *
 * Trusted source: the SAVED priced rodent exclusion rows (estimate-result-container storedRodentExclusionRows), which the
 * pricer stamped with roofStyle, tileRoofMultiplier, barrelEavePerFt and barrelEaveMinimum. Never client-posted input: the
 * engine honors the signal only on a savedEstimateReplay, and the key is stripped from posted bodies
 * (estimate-client-identity-fields). A saved row without a stamp replays the live constant (per field).
 */
const ROOF_STYLES = ['shingle', 'flat_tile', 'barrel_tile', 'metal', 'other'];
const positive = (value) => (Number(value) > 0 ? Number(value) : null);

// The saved row's stamps, or {} when the row is not a rodent exclusion row with a recognized roof style (fail closed).
function roofStyleRowFields(row) {
  const { isRodentExclusionRow } = require('../../shared/estimate-purchased-warranty.cjs');
  if (!isRodentExclusionRow(row) || !ROOF_STYLES.includes(row.roofStyle)) return {};
  return {
    roofStyle: row.roofStyle,
    ...(positive(row.tileRoofMultiplier) ? { tileRoofMultiplier: positive(row.tileRoofMultiplier) } : {}),
    ...(positive(row.barrelEavePerFt) ? { barrelEavePerFt: positive(row.barrelEavePerFt) } : {}),
    ...(positive(row.barrelEaveMinimum) ? { barrelEaveMinimum: positive(row.barrelEaveMinimum) } : {}),
  };
}

// { multiplier, perFt, minimum } from the first saved exclusion row that carries a roof style, else null (replay live).
function roofStyleReplaySignal(estData) {
  for (const row of require('./estimate-result-container').storedRodentExclusionRows(estData)) {
    const fields = roofStyleRowFields(row);
    if (!fields.roofStyle) continue;
    return {
      multiplier: fields.tileRoofMultiplier || null,
      perFt: fields.barrelEavePerFt || null,
      minimum: fields.barrelEaveMinimum || null,
    };
  }
  return null;
}

module.exports = { roofStyleReplaySignal, roofStyleRowFields };
