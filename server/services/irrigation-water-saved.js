'use strict';

/**
 * "Water you saved" for the Monday irrigation plan (owner 2026-10-22, phase 1: gallons only).
 *
 * One sentence on a skip, conditional or run plan saying what one sprinkler run puts on the lawn, so the
 * instruction to skip has a number behind it. Gallons = depth per run × lawn area × 623 gal per inch per
 * 1,000 sq ft (UF/IFAS AE220). Depth per run is the customer's own schedule when one is on file (typed weekly
 * inches over their watering days, else zone minutes on the plan's head rate table), otherwise the OWNER
 * DEFAULT: a typical 20-minute run, twice a week, putting down half an inch. The lawn area is never defaulted:
 * no lawn_sqft on file, no sentence (owner call still open on a default area).
 *
 * FREEZE RULE (same shape as the head rate table, irrigation-rates.js): the gate is read only when a NEW
 * week-plan decision is made, and the block is written into the snapshot's decisionInputs.waterSaved (the key
 * is absent when the gate is off or nothing could be computed, so a gate-off snapshot is byte-identical to
 * before). Replay and every renderer of a STORED plan take the block from the snapshot and never recompute it:
 * a lawn-size edit or a gate flip after publication cannot change, or withhold, an instruction already sent.
 *
 * Dollars are deliberately NOT here: the water source (county, reclaimed, well) is not on file, and a dollar
 * figure printed to a well or reclaimed customer would be wrong by an order of magnitude (phase 2).
 */

const { deriveIrrigationInchesPerWeek, normalizeRuntimeInputs } = require('@waves/irrigation-runtime');

// Gallons one inch of water is over 1,000 sq ft (UF/IFAS AE220).
const GALLONS_PER_INCH_PER_1000_SQFT = 623;
// Owner default (2026-10-22): a typical run is 20 minutes, twice a week, and puts down half an inch.
const DEFAULT_RUN_MINUTES = 20;
const DEFAULT_RUNS_PER_WEEK = 2;
const DEFAULT_DEPTH_PER_RUN_INCHES = 0.5;
// A residential lawn above this is a data-entry artifact, not a lawn.
const MAX_LAWN_SQFT = 200000;
// Printed figures are rounded to the nearest 50 gallons: an estimate must not read like a meter.
const ROUND_GALLONS_TO = 50;

// GATE_IRRIGATION_WATER_SAVINGS read at CALL time, strict `=== 'true'` (customer copy), so an unset variable is
// the kill switch. Read here, not in config/feature-gates.js, so the pure renderers pull in no heavy module.
function irrigationWaterSavedLive() {
  return process.env.GATE_IRRIGATION_WATER_SAVINGS === 'true';
}

function positiveLawnSqft(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_LAWN_SQFT) return null;
  return Math.round(n);
}

function roundGallons(gallons) {
  return Math.round(gallons / ROUND_GALLONS_TO) * ROUND_GALLONS_TO;
}

/**
 * The frozen block for a NEW decision, or null when nothing honest can be printed (no lawn area on file).
 *
 * @param {object} input
 * @param {number|string|null} input.lawnSqft            customer_turf_profiles.lawn_sqft (withheld after a move until re-established)
 * @param {number|string|null} input.runMinutes          the customer's minutes per zone, or null
 * @param {Array|string|null}  input.wateringDays        the customer's watering days, or null
 * @param {Array|string|null}  input.systemType          the customer's head types, or null
 * @param {number|null}        input.explicitInchesPerWeek  a POSITIVE typed weekly figure, or null
 * @param {object}             input.rates               the head rate table the decision is built on (ratesForTable)
 * @returns {{ v: 1, basis: 'schedule'|'default', lawnSqft: number, depthInches: number, runsPerWeek: number,
 *             gallonsPerRun: number, gallonsPerWeek: number } | null}
 */
function waterSavedForDecision({ lawnSqft, runMinutes = null, wateringDays = null, systemType = null, explicitInchesPerWeek = null, rates } = {}) {
  const sqft = positiveLawnSqft(lawnSqft);
  if (!sqft) return null;

  let depth = DEFAULT_DEPTH_PER_RUN_INCHES;
  let runs = DEFAULT_RUNS_PER_WEEK;
  let basis = 'default';
  const explicit = Number(explicitInchesPerWeek);
  const days = normalizeRuntimeInputs({ runMinutes, wateringDays, systemType }).wateringDays;
  const derived = deriveIrrigationInchesPerWeek({ runMinutes, wateringDays, systemType }, { rates });
  if (Number.isFinite(explicit) && explicit > 0 && days.length > 0) {
    // A typed weekly figure outranks any table (the engine's own precedence), spread over the customer's days.
    depth = explicit / days.length;
    runs = days.length;
    basis = 'schedule';
  } else if (derived.inchesPerWeek != null && derived.runsPerWeek > 0) {
    // Per run from the minutes and rate themselves (the weekly figure is already rounded to hundredths).
    depth = (derived.runMinutes / 60) * derived.rateInPerHr;
    runs = derived.runsPerWeek;
    basis = 'schedule';
  }

  const perRun = roundGallons((depth * sqft / 1000) * GALLONS_PER_INCH_PER_1000_SQFT);
  if (perRun < ROUND_GALLONS_TO) return null;
  return {
    v: 1,
    basis,
    lawnSqft: sqft,
    depthInches: Math.round(depth * 100) / 100,
    runsPerWeek: runs,
    gallonsPerRun: perRun,
    gallonsPerWeek: roundGallons((depth * runs * sqft / 1000) * GALLONS_PER_INCH_PER_1000_SQFT),
  };
}

function fmtGallons(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * The customer sentence for a plan, or null when the plan has nothing to skip (no block, an unavailable plan,
 * or a hold because irrigation is not permitted at all).
 */
function waterSavedSentence(block, plan) {
  if (!block || !plan || plan.action === 'unavailable') return null;
  if (plan.action === 'hold' && Array.isArray(plan.reasons) && plan.reasons.includes('restriction_prohibits')) return null;
  const perRun = fmtGallons(block.gallonsPerRun);
  // Only a hold skips the whole week; a run or conditional plan may still run, so it gets the per-run figure alone.
  const weekClause = plan.action === 'hold' && block.runsPerWeek >= 2
    ? `, so skipping ${block.runsPerWeek === 2 ? 'both' : `all ${block.runsPerWeek}`} of this week's runs saves about ${fmtGallons(block.gallonsPerWeek)} gallons`
    : '';
  if (block.basis === 'schedule') {
    return `Each run you skip is about ${perRun} gallons on your lawn, from the sprinkler schedule in your portal and your lawn's size on file${weekClause}.`;
  }
  return `Each ${DEFAULT_RUN_MINUTES}-minute run you skip is about ${perRun} gallons on your lawn${weekClause}. That assumes a typical half-inch run over your lawn's size on file; enter your zone minutes and watering days under Irrigation in your portal and we'll use those instead.`;
}

module.exports = {
  irrigationWaterSavedLive,
  waterSavedForDecision,
  waterSavedSentence,
  WATER_SAVED_CONSTANTS: Object.freeze({ GALLONS_PER_INCH_PER_1000_SQFT, DEFAULT_RUN_MINUTES, DEFAULT_RUNS_PER_WEEK, DEFAULT_DEPTH_PER_RUN_INCHES, MAX_LAWN_SQFT, ROUND_GALLONS_TO }),
};
