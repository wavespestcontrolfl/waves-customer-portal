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

// Two-story roof-point rule (owner 2026-11-26, "fix this"). Every V2 exclusion row the pricer writes carries
// twoStoryRoofRule (the rule version) and twoStoryRoofFactor (the factor it priced with, 1 when none applied). A saved
// row WITHOUT the stamp was priced before the rule, so it replays with no factor, whatever its legacyPricingRules stamp
// says (quotes stamped false were already sent without it). Same trust contract as roofStyleReplaySignal.
function twoStoryRowFields(row) {
  const { isRodentExclusionRow } = require('../../shared/estimate-purchased-warranty.cjs');
  if (!isRodentExclusionRow(row) || !(Number(row.twoStoryRoofRule) >= 1)) return {};
  return {
    twoStoryRoofRule: Number(row.twoStoryRoofRule),
    ...(positive(row.twoStoryRoofFactor) ? { twoStoryRoofFactor: positive(row.twoStoryRoofFactor) } : {}),
  };
}

// { factor } from the first saved V2 exclusion row: its stamped factor, or 1 (no factor) when the row has no stamp.
// null when the estimate holds no exclusion row (nothing was quoted, so the current rule prices it).
function twoStoryRoofReplaySignal(estData) {
  const { isRodentExclusionRow } = require('../../shared/estimate-purchased-warranty.cjs');
  for (const row of require('./estimate-result-container').storedRodentExclusionRows(estData)) {
    if (!isRodentExclusionRow(row)) continue;
    return { factor: twoStoryRowFields(row).twoStoryRoofFactor || 1 };
  }
  return null;
}

// The measured eave feet of a Barrel tile pick, validated BEFORE any coercion: a finite number >= 0 or a numeric string;
// empty, null or undefined = 0. Anything else (boolean, object, 'abc', negative, Infinity) is null = invalid.
function parseBarrelEaveFt(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string') {
    // A long digit string converts to Infinity: check the result, not just the text.
    const parsed = /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// The fail-closed 400 for eave feet that are not a measurement (the route and the engine share it).
function invalidBarrelEaveFtError() {
  const err = new Error('The barrel eave feet must be a number of feet, 0 or more.');
  err.status = 400;
  err.statusCode = 400;
  err.code = 'EXCLUSION_ROOF_STYLE_INVALID';
  err.failClosed = true;
  err.isOperational = true;
  return err;
}

// Is this exclusion pick a barrel tile roof with no eave footage entered?
const unmeasuredBarrel = (roofStyle, eaveFt) => roofStyle === 'barrel_tile' && !(parseBarrelEaveFt(eaveFt) > 0);

// The exclusion pick of one stored input carrier ({ services: { exclusion | rodentExclusion } }), or null.
function exclusionPickIn(carrier) {
  const services = carrier && typeof carrier === 'object' ? carrier.services : null;
  const exclusion = services && typeof services === 'object' ? (services.exclusion || services.rodentExclusion) : null;
  return exclusion && typeof exclusion === 'object' ? exclusion : null;
}

// A priced barrel eave closure row, raw (component) or mapped (the mapper keeps the name, not the component).
const isClosureRow = (row) => row.component === 'barrel_eave_closure' || /eave closure/i.test(String(row.name || row.label || ''));

// Does this stored estimate pick a barrel tile roof for an exclusion with no eave footage entered? The send guard and the
// group scheduling preflight read it for a draft NEVER issued, so a draft saved before the barrel hold existed (no
// quote-required flag on its rows) is held like a new one until the footage is entered.
// The inputs that price the draft decide, in the order serverRecomputeFromEstimateData uses: the admin editor's saved
// request (engineRequest: EXCLUSION selected + options.exclRoofStyle / exclBarrelEaveFt), else engineInputs, else the
// older carriers. Rows are read only from the authoritative container (a revision can keep a stale engineResult): the
// engine's marker holds; with NO stored inputs at all, a barrel row with no priced closure row holds too.
function estimateHasUnmeasuredBarrelExclusion(estData) {
  const root = estData && typeof estData === 'object' ? estData : null;
  if (!root) return false;
  const Container = require('./estimate-result-container');
  const rows = Container.storedRodentExclusionRows(root);
  if (rows.some((row) => row.barrelClosureNeedsMeasurement === true)) return true;
  const request = root.engineRequest && typeof root.engineRequest === 'object' && root.engineRequest.profile ? root.engineRequest : null;
  if (request) {
    const options = request.options && typeof request.options === 'object' ? request.options : {};
    const selected = Array.isArray(request.selectedServices)
      && request.selectedServices.some((key) => String(key || '').toUpperCase() === 'EXCLUSION');
    return selected && unmeasuredBarrel(options.exclRoofStyle, options.exclBarrelEaveFt);
  }
  const container = Container.storedEstimateContainer(root);
  const carrier = [root.engineInputs, root.inputs, root.engineInput, container && container.inputs]
    .find((value) => value && typeof value === 'object');
  if (carrier) {
    const pick = exclusionPickIn(carrier);
    return !!pick && unmeasuredBarrel(pick.roofStyle, pick.barrelEaveFt);
  }
  return rows.some((row) => row.roofStyle === 'barrel_tile') && !rows.some(isClosureRow);
}

module.exports = {
  roofStyleReplaySignal, roofStyleRowFields, twoStoryRowFields, twoStoryRoofReplaySignal, parseBarrelEaveFt, invalidBarrelEaveFtError, estimateHasUnmeasuredBarrelExclusion,
};
