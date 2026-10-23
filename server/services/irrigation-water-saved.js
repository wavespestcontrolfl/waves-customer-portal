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

// GATE_IRRIGATION_WATER_DOLLARS (phase 2, owner 2026-10-23 "ok go"): the dollar range beside the gallons, printed only
// when the customer answered "county water" in the portal (a well lawn saves pump electricity, a reclaimed lawn a
// dollar or two: a dollar figure there would be wrong by 10x to 100x). Strict `=== 'true'`, read at call time.
function irrigationWaterDollarsLive() {
  return process.env.GATE_IRRIGATION_WATER_DOLLARS === 'true';
}

// Marginal $ per 1,000 gallons by county, from the utilities' published schedules (2026). `low` = a dedicated
// irrigation meter (water only, lowest tier); `high` = irrigation on the house meter (an upper water tier plus
// sewer). Which meter a customer has is not on file, so the sentence prints the range.
//   Manatee: irrigation meter $3.11 (tier 1) … house meter $3.89 tier + $6.89 sewer (rates effective 2026-06-01).
//   Sarasota: potable tiers $3.70–6.42 (FY2024) + wastewater, raised 6.4% + index for FY2026: about $4 to $13.
//   Charlotte: water $6.84 (0–5,999 gal) … $9.91 (11,000–15,999) + sewer $6.58 (rates effective 2026-04-01).
const WATER_RATES_PER_1000_GAL = Object.freeze({
  Manatee: Object.freeze({ low: 3.11, high: 10.78 }),
  Sarasota: Object.freeze({ low: 4.0, high: 13.0 }),
  Charlotte: Object.freeze({ low: 6.84, high: 16.49 }),
});
const WATER_SOURCE_COUNTY = 'county';

function dollars(gallons, perThousand) {
  return Math.round((gallons / 1000) * perThousand);
}

/**
 * The dollar block for a county-water customer, or null: not asked / not county water, no county rate on file,
 * or the gate is off. Figures are whole dollars for the displayed gallons.
 */
function waterDollarsForBlock({ gallonsPerRun, gallonsPerWeek }, { waterSource, county } = {}) {
  if (!irrigationWaterDollarsLive()) return null;
  if (String(waterSource || '').trim().toLowerCase() !== WATER_SOURCE_COUNTY) return null;
  const key = String(county || '').trim().replace(/\s+county$/i, '');
  const rate = WATER_RATES_PER_1000_GAL[key.charAt(0).toUpperCase() + key.slice(1).toLowerCase()];
  if (!rate) return null;
  return {
    county: key.charAt(0).toUpperCase() + key.slice(1).toLowerCase(),
    perThousandLow: rate.low,
    perThousandHigh: rate.high,
    runLow: dollars(gallonsPerRun, rate.low),
    runHigh: dollars(gallonsPerRun, rate.high),
    weekLow: dollars(gallonsPerWeek, rate.low),
    weekHigh: dollars(gallonsPerWeek, rate.high),
  };
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
 * @param {number|null}        input.planDepthInches     a RUN / conditional plan's prescribed depth per event: the run
 *                                                        the email tells them to skip, which may differ from their normal
 *                                                        schedule (a restriction-limited plan prescribes fewer, longer runs)
 * @param {number|null}        input.planEvents          that plan's event count
 * @param {string|null}        input.waterSource         the portal answer: 'county' | 'reclaimed' | 'well' | null (withheld
 *                                                        after a move until re-saved); dollars print for 'county' only
 * @param {string|null}        input.county              the decision's jurisdiction (resolveRestrictionCounty), the rate key
 * @param {boolean}            input.ignoreDrip          how the caller's own derivation reads drip zones: the plan engine
 *                                                        leaves drip out (one turf head + drip is one head), the email's
 *                                                        ask paths count it (mixed heads → the setup ask), so each caller
 *                                                        passes its own reading and the sentence never contradicts the
 *                                                        template beside it (codex #6498 r7, r8)
 * @returns {{ v: 1, basis: 'plan'|'schedule'|'default', lawnSqft: number, depthInches: number, runsPerWeek: number,
 *             gallonsPerRun: number, gallonsPerWeek: number } | null}
 */
function waterSavedForDecision({ lawnSqft, runMinutes = null, wateringDays = null, systemType = null, explicitInchesPerWeek = null, rates, planDepthInches = null, planEvents = null, ignoreDrip = true, waterSource = null, county = null } = {}) {
  const sqft = positiveLawnSqft(lawnSqft);
  if (!sqft) return null;

  let depth = DEFAULT_DEPTH_PER_RUN_INCHES;
  let runs = DEFAULT_RUNS_PER_WEEK;
  let basis = 'default';
  const explicit = Number(explicitInchesPerWeek);
  const days = normalizeRuntimeInputs({ runMinutes, wateringDays, systemType }).wateringDays;
  const derived = deriveIrrigationInchesPerWeek({ runMinutes, wateringDays, systemType }, { rates, ignoreDrip });
  const planDepth = Number(planDepthInches);
  if (Number.isFinite(planDepth) && planDepth > 0) {
    // The run the plan prescribes IS the run the sentence sits beside (codex #6498 r7).
    depth = planDepth;
    runs = Number.isFinite(Number(planEvents)) && Number(planEvents) > 0 ? Number(planEvents) : 1;
    basis = 'plan';
  } else if (Number.isFinite(explicit) && explicit > 0 && days.length > 0) {
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
  const block = {
    v: 1,
    basis,
    lawnSqft: sqft,
    depthInches: Math.round(depth * 100) / 100,
    runsPerWeek: runs,
    gallonsPerRun: perRun,
    // From the DISPLAYED per-run figure, so the two printed numbers always add up (codex #6498 r1 P2).
    gallonsPerWeek: perRun * runs,
  };
  // Phase 2: the dollar range, frozen with the block (key absent unless county water + a county rate + the gate).
  const money = waterDollarsForBlock(block, { waterSource, county });
  return money ? { ...block, dollars: money } : block;
}

function fmtGallons(n) {
  return Number(n).toLocaleString('en-US');
}

function fmtDollars(n) {
  return `$${Number(n).toLocaleString('en-US')}`;
}

/** " On Manatee County water that is roughly $7 to $23 for the week." / "… a run." — or '' without a dollar block. */
function dollarClause(block, { whole } = {}) {
  const d = block && block.dollars;
  if (!d) return '';
  const [lo, hi] = whole ? [d.weekLow, d.weekHigh] : [d.runLow, d.runHigh];
  if (!(hi > 0)) return '';
  const range = lo === hi ? `about ${fmtDollars(hi)}` : `roughly ${fmtDollars(lo)} to ${fmtDollars(hi)}`;
  return ` On ${d.county} County water that is ${range} ${whole ? 'for the week' : 'a run'}.`;
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
  // The dollar clause (phase 2) follows the same split: the week's money on a whole-week hold, a run's money otherwise.
  // A cool-season cadence hold is itself conditional (a customer who did not run last week runs one cycle this week),
  // so it gets the per-run figure alone too (codex #6498 r5 P2).
  const cadenceHold = Array.isArray(plan.reasons) && plan.reasons.includes('cool_season_cadence');
  const wholeWeek = plan.action === 'hold' && !cadenceHold && block.runsPerWeek >= 2;
  const weekClause = wholeWeek
    ? `, so skipping ${block.runsPerWeek === 2 ? 'both' : `all ${block.runsPerWeek}`} of this week's runs saves about ${fmtGallons(block.gallonsPerWeek)} gallons`
    : '';
  const money = dollarClause(block, { whole: wholeWeek });
  if (block.basis === 'plan') {
    return `Each run you skip is about ${perRun} gallons on your lawn, from this week's plan and your lawn's size on file${weekClause}.${money}`;
  }
  if (block.basis === 'schedule') {
    return `Each run you skip is about ${perRun} gallons on your lawn, from the sprinkler schedule in your portal and your lawn's size on file${weekClause}.${money}`;
  }
  return `Each ${DEFAULT_RUN_MINUTES}-minute run you skip is about ${perRun} gallons on your lawn${weekClause}.${money} That assumes a typical half-inch run over your lawn's size on file; enter your zone minutes and watering days under Irrigation in your portal and we'll use those instead.`;
}

/**
 * The sentence for the ASK emails (setup: a sprinkler system on file but no usable schedule; confirm: a tech-recorded
 * weekly total): there is no plan to skip yet, so it gives the per-run figure as the reason to enter or confirm the
 * schedule. Default basis in practice (a weekly total gives no per-run depth); a portal schedule on file is named.
 * Appended to the ask; null when there is no block.
 */
function waterSavedSetupSentence(block) {
  if (!block) return null;
  const perRun = fmtGallons(block.gallonsPerRun);
  const money = dollarClause(block, { whole: false });
  if (block.basis === 'schedule') {
    return `From the sprinkler schedule in your portal and your lawn's size on file, each run is about ${perRun} gallons, so every run you skip after a good rain is real water saved.${money}`;
  }
  return `For a lawn your size, a typical ${DEFAULT_RUN_MINUTES}-minute run is about ${perRun} gallons, so every run you skip after a good rain is real water saved.${money} Once your schedule is on file we'll use your own minutes and days for that figure.`;
}

module.exports = {
  irrigationWaterSavedLive,
  irrigationWaterDollarsLive,
  waterDollarsForBlock,
  WATER_RATES_PER_1000_GAL,
  waterSavedForDecision,
  waterSavedSentence,
  waterSavedSetupSentence,
  WATER_SAVED_CONSTANTS: Object.freeze({ GALLONS_PER_INCH_PER_1000_SQFT, DEFAULT_RUN_MINUTES, DEFAULT_RUNS_PER_WEEK, DEFAULT_DEPTH_PER_RUN_INCHES, MAX_LAWN_SQFT, ROUND_GALLONS_TO }),
};
