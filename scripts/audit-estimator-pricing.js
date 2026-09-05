#!/usr/bin/env node
/**
 * audit-estimator-pricing.js — READ-ONLY independent unit-economics audit of
 * the Waves estimator engine.
 *
 * What it does
 *   1. Reconstructs the expected customer price for every core service from the
 *      pricing constants + the documented formulas WITHOUT calling the engine's
 *      pricer functions, then calls `generateEstimate()` and diffs the two.
 *   2. Builds an independent cost stack (labor, materials, drive, admin,
 *      callback reserve, card processing) under (a) the engine's own labor
 *      assumptions and (b) production RECORDED visit spans (check-in →
 *      check-out, which often includes driving to the next stop — NOT on-site
 *      time; owner 2026-09-02, MON-004), and reports gross margin, markup and
 *      contribution margin at every WaveGuard tier. The recorded-span columns
 *      are context only: no target price is derived from them.
 *   3. Runs a scenario matrix: smallest / typical / large / maximum scope,
 *      every bracket boundary (-1 / exact / +1), blank / zero / negative /
 *      decimal / huge inputs, residential vs commercial, stand-alone vs bundled,
 *      no discount vs deepest discount, annual prepay and manual override.
 *
 * What it never does
 *   - It never writes to any database and never mutates pricing_config.
 *   - It only reads `AUDIT_DB_URL` (never DATABASE_URL) and opens the session
 *     READ ONLY when `--db` is passed, to overlay the live pricing_config the way
 *     db-bridge does at runtime. Without `--db` it prices on constants.js.
 *
 * Usage (from the repo root):
 *   node scripts/audit-estimator-pricing.js                # markdown summary to stdout
 *   node scripts/audit-estimator-pricing.js --json out.json --md out.md
 *   AUDIT_DB_URL=postgres://... node scripts/audit-estimator-pricing.js --db
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'server', 'services', 'pricing-engine');
const constants = require(path.join(ENGINE_DIR, 'constants'));
const { generateEstimate } = require(path.join(ENGINE_DIR, 'estimate-engine'));
const converter = require(path.join(ROOT, 'server', 'services', 'estimate-converter'));
const { etParts } = require(path.join(ROOT, 'server', 'utils', 'datetime-et'));
const { computeChargeAmount } = require(path.join(ROOT, 'server', 'services', 'stripe-pricing'));
const PREPAY_PCT = Number(converter.ANNUAL_PREPAY_DISCOUNT_PCT ?? constants.ANNUAL_PREPAY_DISCOUNT_PCT ?? 0.05);
// Stripe's fixed per-transaction component; not surchargeable (stripe-pricing.js header).
const CARD_FIXED_FEE = 0.30;

const args = process.argv.slice(2);
// A value-taking flag with no following non-flag value is an invocation error,
// never a silently skipped artifact (codex r6 P2).
const argValue = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const v = args[i + 1];
  return v != null && !v.startsWith('--') ? v : null;
};
const WANT_DB = args.includes('--db');
const JSON_OUT = argValue('--json');
const MD_OUT = argValue('--md');
// Reject unknown flags: a not-yet-built mode (the plan names --termite-plan
// for PR A1) must never silently run the default matrix (codex P1 on PR #3792).
// Only when run as the CLI: the golden test requires this file as a library
// under jest's own argv.
const KNOWN_FLAGS = new Map([['--db', 0], ['--json', 1], ['--md', 1]]);
if (require.main === module) {
  for (let i = 0; i < args.length; i += 1) {
    if (!KNOWN_FLAGS.has(args[i])) {
      console.error(`Unknown argument ${JSON.stringify(args[i])}. Known flags: ${[...KNOWN_FLAGS.keys()].join(' ')}`);
      process.exit(2);
    }
    const arity = KNOWN_FLAGS.get(args[i]);
    if (arity && (args[i + 1] == null || args[i + 1].startsWith('--'))) {
      console.error(`${args[i]} needs a value (got ${JSON.stringify(args[i + 1] ?? null)})`);
      process.exit(2);
    }
    i += arity;
  }
}
// Shared prepay cadence vocabulary — the independent expectation for the
// converter resolver below (codex r6 P1). visitsPerYearForCadence is the
// coverage count a stored cadence pays for; prepayCoverageCadenceForPattern
// is null for every cadence the term-creation path fails closed on.
const { visitsPerYearForCadence, prepayCoverageCadenceForPattern } = require(path.join(ROOT, 'server', 'services', 'prepay-cadence'));
// Termite station economics are the owner-reviewed cartridge model in
// docs/estimator-pricing-plan-2026-09-03.md §A1 (BASF Trelona ATBS: two
// cartridges per station, label-driven replacement, 25-pack cartridge rate,
// an ASSUMED activity follow-up reserve). The termite pricer defines no
// per-station monitoring cost of its own; the rodent bait / amortization
// rates are rodent inputs and must never stand in for it (codex r6 P1).
const TERMITE_CARTRIDGE_MODEL = Object.freeze({ cartridgesPerStation: 2, replacementRate: 0.33, cartridgeCost: 6.83, followUpVisitsPerYear: 0.25, followUpVisitCost: 55 });
const termiteAnnualCost = (stations) => round2(stations * TERMITE_CARTRIDGE_MODEL.cartridgesPerStation * TERMITE_CARTRIDGE_MODEL.replacementRate * TERMITE_CARTRIDGE_MODEL.cartridgeCost + TERMITE_CARTRIDGE_MODEL.followUpVisitsPerYear * TERMITE_CARTRIDGE_MODEL.followUpVisitCost);

// ── Money helpers (kept local on purpose — this file must not import engine helpers) ──
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct =(n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : 'n/a');
const money = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : 'n/a');

// ── Production RECORDED visit spans (aggregate, read-only, 2026-06-01..2026-09-02) ──
// Source: scheduled_services.status='completed', span = time_on_site_adjusted_minutes
// ?? actual_duration_minutes ?? (check_out - check_in). Medians; n = sample size.
// NOT on-site time: check-out is often stamped while driving to the next stop
// (owner 2026-09-02, MON-004), so a span already contains drive. They are fed to
// unitEconomics with driveMinutes 0 (never re-added) and reported for context —
// no target price or repricing recommendation is derived from them.
const RECORDED_VISIT_SPAN_MINUTES = {
  pest_control_quarterly: { median: 44, p75: 63, p90: 79, n: 98 },
  pest_control_monthly: { median: 36, p75: 51, p90: 61, n: 6 },
  one_time_pest: { median: 36, p75: 38, p90: 40, n: 3 },
  cockroach_treatment: { median: 36, p75: 40, p90: 42, n: 3 },
  lawn_care_9x: { median: 44, p75: 50, p90: 56, n: 17 },
  lawn_care_12x: { median: 37, p75: 46, p90: 54, n: 7 },
  wdo_inspection: { median: 60, p75: 60, p90: 60, n: 9 },
  rodent_trapping: { median: 92, p75: 92, p90: 92, n: 7 },
  pest_re_service: { median: 28, p75: 38, p90: 44, n: 4 },
};
// Callback rate observed 2026-06-01..2026-09-02: 8 callbacks / 307 completed visits (all pest).
const OBSERVED_PEST_CALLBACK_RATE = 8 / 307;

// ── Independent formula library (constants in, dollars out; no engine calls) ──
function interp(value, points) {
  // points: [[x, y], ...] ascending. Linear interpolation, clamped at the ends.
  if (!points.length) return 0;
  if (value <= points[0][0]) return points[0][1];
  if (value >= points[points.length - 1][0]) return points[points.length - 1][1];
  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (value >= x0 && value <= x1) {
      return x1 === x0 ? y0 : y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return points[points.length - 1][1];
}

function footprintOf(homeSqFt, stories = 1) {
  return Math.round((Number(homeSqFt) || 0) / Math.max(1, Number(stories) || 1));
}

// Hardscape estimate — FROZEN literal mirror of constants.HARDSCAPE and
// HARDSCAPE_ADDITIONS (property-calculator.js estimateHardscape), deliberately
// NOT the production functions: a breakpoint, slope, clamp or pool-addition
// change in constants.js must move the engine away from this expectation and
// surface as a mosquito mismatch instead of moving both sides together
// (codex r21 P2). A deliberate curve change updates these literals in the same
// PR (the plan's per-PR verification rule). The property-type dispatch mirrors
// estimateHardscape's string tests: commercial / townhome-or-duplex / condo /
// everything else single-family.
const HARDSCAPE_CURVES = Object.freeze({
  commercial: { perLotSqFt: 0.15 },
  single_family: { base: 800, tier1: { from: 7500, to: 15000, perSqFt: 0.03 }, tier2: { from: 15000, perSqFt: 0.05 } },
  townhome: { base: 400, from: 7500, perSqFt: 0.02 },
  condo: { base: 200, from: 7500, perSqFt: 0.05 },
  additions: { poolCage: 600, poolNoCage: 450 },
});
function hardscapeOf(lotSqFt, propertyType = 'single_family', features = {}) {
  const C = HARDSCAPE_CURVES;
  const type = String(propertyType || 'single_family');
  let hs;
  if (type === 'commercial') hs = lotSqFt * C.commercial.perLotSqFt;
  else if (type.includes('townhome') || type === 'duplex') hs = C.townhome.base + Math.max(0, lotSqFt - C.townhome.from) * C.townhome.perSqFt;
  else if (type.includes('condo')) hs = C.condo.base + Math.max(0, lotSqFt - C.condo.from) * C.condo.perSqFt;
  else {
    const sf = C.single_family;
    hs = sf.base;
    if (lotSqFt > sf.tier1.from) hs += (Math.min(lotSqFt, sf.tier1.to) - sf.tier1.from) * sf.tier1.perSqFt;
    if (lotSqFt > sf.tier2.from) hs += (lotSqFt - sf.tier2.from) * sf.tier2.perSqFt;
  }
  if (features.poolCage) hs += C.additions.poolCage;
  else if (features.pool) hs += C.additions.poolNoCage;
  return Math.round(hs);
}

// PEST — documented formula: max(floor, base + round(footprintAdj) + featureAdj + propAdj) × freqMult
// Year-built pressure bump — frozen mirror of modifiers.js pestAgeAdj (no constant
// exists for it): age ≥ 60 → $8, ≥ 40 → $5, ≥ 20 → $2, else $0 (codex r14 P2).
// Age is taken from the EASTERN calendar year (server/utils/datetime-et.js
// etParts — AGENTS.md America/New_York discipline). Production's pestAgeAdj
// uses the UTC year on a TZ=UTC Railway box, so for the five hours after
// 00:00 UTC on 1 January — still 31 December in Eastern time — this
// expectation legitimately DISAGREES with the engine at an age threshold
// (report finding AGE-001) instead of mirroring the drift (codex r18 P1).
const currentETYear = () => etParts(new Date()).year;
function pestAgeAdjOf(yearBuilt) {
  if (!yearBuilt) return 0;
  const age = currentETYear() - Number(yearBuilt);
  return age >= 60 ? 8 : age >= 40 ? 5 : age >= 20 ? 2 : 0;
}
function expectPest({ homeSqFt, stories = 1, features = {}, propertyType = 'single_family', frequency = 'quarterly', yearBuilt = null }) {
  const { PEST, PROPERTY_TYPE_ADJ } = constants;
  const footprint = footprintOf(homeSqFt, stories);
  const footprintAdj = Math.round(interp(footprint, PEST.footprintBrackets.map((b) => [b.sqft, b.adj])));
  const a = PEST.additionalAdjustments;
  let featureAdj = 0;
  if (features.indoor) featureAdj += a.indoor;
  if (features.shrubs === 'heavy') featureAdj += a.shrubs_heavy;
  else if (features.shrubs === 'light') featureAdj += a.shrubs_light || 0;
  if (features.poolCage) {
    const size = String(features.poolCageSize || 'medium').toLowerCase();
    featureAdj += size === 'small' ? a.poolCageSmall : size === 'large' ? a.poolCageLarge : size === 'oversized' ? a.poolCageOversized : a.poolCageMedium;
  } else if (features.pool) featureAdj += a.poolNoCage;
  if (features.complexity === 'complex') featureAdj += a.complexity_complex;
  else if (features.complexity === 'simple') featureAdj += a.complexity_simple || 0;
  if (features.nearWater) featureAdj += a.nearWater;
  if (features.attachedGarage) featureAdj += a.attachedGarage;
  const propAdj = PROPERTY_TYPE_ADJ[propertyType] || 0;
  const ageAdj = pestAgeAdjOf(yearBuilt);
  const basePrice = Math.max(PEST.floor, PEST.base + footprintAdj + featureAdj + propAdj + ageAdj);
  const freqMult = PEST.frequencyDiscounts.v2[frequency] || 1;
  const visits = PEST.frequencies[frequency] || 4;
  const perApp = round2(basePrice * freqMult);
  const annual = round2(perApp * visits);
  const monthly = round2(annual / 12);
  return { footprint, footprintAdj, featureAdj, propAdj, basePrice, freqMult, visits, perApp, annual, monthly };
}

// LAWN — bracket interpolation on the monthly cell, cadence caps, annual = round(monthly×12)
function lawnMonthlyUncapped(track, sqft, tierIndex) {
  const rows = constants.LAWN_BRACKETS[track];
  if (sqft <= rows[0][0]) return rows[0][tierIndex + 1];
  if (sqft > constants.LAWN_TABLE_MAX_SQFT) {
    const lo = rows[rows.length - 2];
    const hi = rows[rows.length - 1];
    const slope = (hi[tierIndex + 1] - lo[tierIndex + 1]) / (hi[0] - lo[0]);
    return Math.round(hi[tierIndex + 1] + (sqft - hi[0]) * slope);
  }
  if (sqft >= rows[rows.length - 1][0]) return rows[rows.length - 1][tierIndex + 1];
  return Math.round(interp(sqft, rows.map((r) => [r[0], r[tierIndex + 1]])));
}
// Market monthly for one tier: bracket cell + cadence caps / edge-parity floors.
function lawnMarketMonthly({ track, lawnSqFt, tier }) {
  const { LAWN_TIERS, LAWN_ENHANCED_MONTHLY_CAP_RATIO, LAWN_PREMIUM_MONTHLY_CAP_RATIO, LAWN_TABLE_MAX_SQFT, LAWN_PRICING_V2 } = constants;
  const tc = LAWN_TIERS[tier];
  const std = lawnMonthlyUncapped(track, lawnSqFt, LAWN_TIERS.standard.index);
  let monthly = lawnMonthlyUncapped(track, lawnSqFt, tc.index);
  const inTable = lawnSqFt <= LAWN_TABLE_MAX_SQFT || LAWN_PRICING_V2.edgeParityFloorArmed === false;
  const discountLive = LAWN_PRICING_V2.cadenceFreqDiscountArmed !== false;
  if (tier === 'enhanced' && discountLive) {
    monthly = inTable
      ? Math.min(monthly, Math.floor(std * LAWN_ENHANCED_MONTHLY_CAP_RATIO))
      : Math.max(monthly, Math.ceil(std * (9 / 6)));
  } else if (tier === 'premium' && discountLive) {
    const enhUncapped = lawnMonthlyUncapped(track, lawnSqFt, LAWN_TIERS.enhanced.index);
    if (inTable) {
      const enhCapped = Math.min(enhUncapped, Math.floor(std * LAWN_ENHANCED_MONTHLY_CAP_RATIO));
      monthly = Math.min(monthly, Math.floor(std * LAWN_PREMIUM_MONTHLY_CAP_RATIO), Math.floor(enhCapped * (12 / 9)));
    } else {
      const enhFloored = Math.max(enhUncapped, Math.ceil(std * (9 / 6)));
      monthly = Math.max(monthly, Math.ceil(std * (12 / 6)));
      monthly = Math.min(monthly, Math.floor(enhFloored * (12 / 9)));
    }
  }
  return monthly;
}
// Sold price = market, lifted by the ARMED cost floor (annualCost ÷ (1 − target
// margin), ceiled to a whole-dollar per-app), then the program minimum, then —
// under armed floors inside the table — the cadence-ladder lift that keeps
// pa12 ≤ pa9 ≤ 0.96·pa6 / pa12 ≤ 0.92·pa6 on floored legs (service-pricing.js
// priceLawnCare). In-code defaults disarm both; the parity run simulates an
// overlay to exercise them (codex r14 P2).
function expectLawn({ track = 'st_augustine', lawnSqFt, tier = 'enhanced', bermudaSuppression = false, property = {}, routeDriveMinutes = null }) {
  const { LAWN_TIERS, LAWN_ENHANCED_MONTHLY_CAP_RATIO, LAWN_PREMIUM_MONTHLY_CAP_RATIO, LAWN_TABLE_MAX_SQFT, LAWN_PRICING_V2 } = constants;
  const useFloor = LAWN_PRICING_V2.useLawnCostFloor === true;
  const pmm = Number(LAWN_PRICING_V2.programMinimumMonthly);
  const programMinimumAnnual = Number.isFinite(pmm) && pmm > 0 ? round2(pmm * 12) : 0;
  const ladderArmed = LAWN_PRICING_V2.cadenceFreqDiscountArmed !== false && (lawnSqFt <= LAWN_TABLE_MAX_SQFT || LAWN_PRICING_V2.edgeParityFloorArmed === false);
  const legs = {};
  for (const t of ['standard', 'enhanced', 'premium']) {
    const freq = LAWN_TIERS[t].freq;
    const marketMonthly = lawnMarketMonthly({ track, lawnSqFt, tier: t });
    const marketAnnual = Math.round(marketMonthly * 12);
    const floorAnnual = round2(lawnCostStack({ track, lawnSqFt, visits: freq, routeDensity: LAWN_PRICING_V2.defaultRouteDensity, property, routeDriveMinutes }).annualCost / (1 - LAWN_PRICING_V2.targetCollectedMarginFloor));
    const floored = useFloor && floorAnnual > marketAnnual;
    let ann = floored ? Math.ceil(floorAnnual / freq) * freq : marketAnnual;
    if (programMinimumAnnual > 0 && ann < programMinimumAnnual) ann = Math.ceil(programMinimumAnnual / freq) * freq;
    legs[t] = { freq, marketMonthly, marketAnnual, floorAnnual, floored, ann, lifted: false };
  }
  if (useFloor && ladderArmed && Object.values(legs).some((l) => l.floored)) {
    const lift = (leg, needed) => { if (needed > leg.ann) { leg.ann = Math.ceil(needed / leg.freq) * leg.freq; leg.lifted = true; } };
    lift(legs.enhanced, legs.premium.ann * (legs.enhanced.freq / legs.premium.freq));
    lift(legs.standard, legs.enhanced.ann / LAWN_ENHANCED_MONTHLY_CAP_RATIO);
    lift(legs.standard, legs.premium.ann / LAWN_PREMIUM_MONTHLY_CAP_RATIO);
  }
  const leg = legs[tier];
  // Bermuda suppression add-on (St. Augustine only; codex r17 P2): perAppBase +
  // perAppPer1000Sqft × (lawnSqFt / 1,000), rounded to cents, baked into EVERY
  // application AFTER floor / minimum / ladder resolution (plan-spread pricing,
  // owner ruling 2026-08-07) — annual = round2(ann + adder × visits). A request on
  // any other track is ineligible and prices unchanged (service-pricing.js
  // priceLawnCare). The gate itself is enforced by the engine, not reproduced here.
  const bs = LAWN_PRICING_V2.bermudaSuppression || {};
  const suppressionPerApp = bermudaSuppression && track === 'st_augustine' ? round2(Number(bs.perAppBase) + Number(bs.perAppPer1000Sqft) * (lawnSqFt / 1000)) : 0;
  const annual = suppressionPerApp > 0 ? round2(leg.ann + suppressionPerApp * leg.freq) : leg.ann;
  const perApp = round2(annual / leg.freq);
  return { monthly: round2(annual / 12), annual, perApp, visits: leg.freq, marketMonthly: leg.marketMonthly, floorAnnual: leg.floorAnnual, floored: leg.floored, lifted: leg.lifted, suppressionPerApp };
}
// Lawn cost stack (shared package arithmetic, re-implemented here).
// Property-driven floor inputs (codex r20 P2), mirrored from
// calcLawnAnnualCostFloorDetails / lawnComplexityMinutes as literals: landscape
// complexity (features.complexity or landscapeComplexity: moderate +5 min,
// complex +10), heavy shrubs (features.shrubs or shrubDensity: +5), a privacy
// fence (fenceType / features.gate / features.accessDifficulty containing
// "privacy": +5) add labor minutes per visit; poor or deferred maintenance and
// high / severe / very-high pest pressure each add $5 to the per-visit callback
// reserve; an explicit routeDriveMinutes (services.lawn or the input) replaces
// the route-density drive minutes. Everything else is neutral.
const lawnComplexityMinutesOf = (property = {}) => {
  const f = property.features || {};
  const complexity = String(f.complexity || property.landscapeComplexity || '').toLowerCase();
  const shrubs = String(f.shrubs || property.shrubDensity || '').toLowerCase();
  const privacy = String(property.fenceType || f.gate || f.accessDifficulty || '').toLowerCase().includes('privacy');
  return (complexity === 'moderate' ? 5 : 0) + (complexity === 'complex' ? 10 : 0) + (shrubs === 'heavy' ? 5 : 0) + (privacy ? 5 : 0);
};
const lawnCallbackReserveOf = (property = {}) => {
  const V = constants.LAWN_PRICING_V2;
  const norm = (v) => String(v || '').toUpperCase().replace(/[\s-]+/g, '_');
  const maintenance = norm(property.maintenanceCondition);
  const pressure = norm(property.overallPestPressure);
  return V.callbackReservePerVisitDefault + (['POOR', 'DEFERRED'].includes(maintenance) ? 5 : 0) + (['HIGH', 'SEVERE', 'VERY_HIGH'].includes(pressure) ? 5 : 0);
};
function lawnCostStack({ track, lawnSqFt, visits, onSiteMinutesOverride = null, routeDensity = 'DENSE', property = {}, routeDriveMinutes = null }) {
  const V = constants.LAWN_PRICING_V2;
  const budgets = { st_augustine: { 4: 75, 6: 103, 9: 182, 12: 225 }, bermuda: { 4: 61, 6: 93, 9: 172, 12: 226 }, zoysia: { 4: 83, 6: 124, 9: 205, 12: 219 }, bahia: { 4: 52, 6: 78, 9: 107, 12: 131 } };
  const annualBudget = (budgets[track] || budgets.st_augustine)[visits] || 100;
  const materialPerVisit = (annualBudget * (lawnSqFt / 4500)) / visits;
  const complexityMinutes = lawnComplexityMinutesOf(property);
  const modeledMinutes = V.laborMinutesBase + (lawnSqFt / 1000) * V.laborMinutesPer1000Sqft + complexityMinutes;
  const onSite = onSiteMinutesOverride ?? modeledMinutes;
  const explicitDrive = Number(routeDriveMinutes ?? property.routeDriveMinutes);
  const drive = Number.isFinite(explicitDrive) && routeDriveMinutes !== null ? Math.max(0, explicitDrive) : (V.routeDensityMinutes[routeDensity] ?? 5);
  const laborPerVisit = (V.laborRateLoaded * (onSite + drive)) / 60;
  const callback = lawnCallbackReserveOf(property);
  const annualCost = (materialPerVisit + laborPerVisit + callback + V.equipmentReservePerVisit) * visits + V.adminAnnualDefault;
  return { annualBudget, materialPerVisit: round2(materialPerVisit), modeledMinutes, complexityMinutes, onSiteMinutes: onSite, driveMinutes: drive, laborPerVisit: round2(laborPerVisit), callbackReservePerVisit: callback, annualCost: round2(annualCost) };
}

// MOSQUITO — treatable = lot − footprint − hardscape; anchors at category top edges; 500-sf steps
function expectMosquito({ homeSqFt, stories = 1, lotSqFt, propertyType = 'single_family', features = {}, program = 'seasonal9', stationCount = 0, dunkCount = 0 }) {
  const M = constants.MOSQUITO;
  const footprint = footprintOf(homeSqFt, stories);
  const hardscape = hardscapeOf(lotSqFt, propertyType, features);
  const treatable = Math.max(0, lotSqFt - footprint - hardscape);
  const cats = M.lotCategories;
  const cat = cats.find((c) => treatable <= c.maxSqFt) || cats[cats.length - 1];
  const catIndex = cats.indexOf(cat);
  const floorSqFt = catIndex > 0 ? cats[catIndex - 1].maxSqFt + 1 : 0;
  const pricingSqFt = Math.max(treatable, floorSqFt);
  const programIndex = M.programs.indexOf(program);
  const anchorsFor = (idx) => {
    const a = cats.filter((c) => Number.isFinite(c.maxSqFt)).map((c) => ({ sqft: c.maxSqFt + 1, price: M.basePrices[c.key][idx] }));
    const terminal = cats[cats.length - 1];
    const tp = M.basePrices[terminal.key][idx];
    const last = a[a.length - 1];
    const prev = a[a.length - 2];
    const slope = (last.price - prev.price) / (last.sqft - prev.sqft);
    let terminalSqFt = 43560;
    if (tp > last.price && slope > 0) {
      const span = Math.ceil((tp - last.price) / slope / M.priceStepSqFt) * M.priceStepSqFt;
      terminalSqFt = Math.max(43560, last.sqft + span);
    }
    a.push({ sqft: terminalSqFt, price: tp });
    return a;
  };
  const interpAnchors = (anchors, sqft) => {
    const stepped = Math.ceil(Math.max(0, sqft) / M.priceStepSqFt) * M.priceStepSqFt;
    if (stepped <= anchors[0].sqft) return anchors[0].price;
    for (let i = 1; i < anchors.length; i += 1) {
      if (stepped <= anchors[i].sqft) {
        const a = anchors[i - 1];
        const b = anchors[i];
        return Math.round(a.price + ((stepped - a.sqft) / (b.sqft - a.sqft)) * (b.price - a.price));
      }
    }
    return anchors[anchors.length - 1].price;
  };
  let base = interpAnchors(anchorsFor(programIndex), pricingSqFt);
  if (program === 'monthly12') base = Math.min(base, interpAnchors(anchorsFor(M.programs.indexOf('seasonal9')), pricingSqFt));
  let pressure = 1;
  const f = M.pressureFactors;
  if (features.trees === 'heavy') pressure += f.trees_heavy; else if (features.trees === 'moderate') pressure += f.trees_moderate;
  if (features.complexity === 'complex') pressure += f.complexity_complex; else if (features.complexity === 'moderate') pressure += f.complexity_moderate;
  if (features.pool || features.poolCage) pressure += f.pool;
  // Water proximity: the engine's modifiers.js applies a graduated MULTIPLIER
  // (ADJACENT 1.35 / CLOSE 1.20 / NEAR 1.10 / MODERATE 1.05 / DISTANT 1.02) and
  // skips the +10% additive factor whenever the multiplier > 1. A bare boolean
  // nearWater normalises to CLOSE (property-calculator.js:678). The README /
  // POLICY docs still describe the retired additive +10% — see the audit report.
  const WATER_MULT = { ADJACENT: 1.35, CLOSE: 1.2, NEAR: 1.1, MODERATE: 1.05, DISTANT: 1.02, NONE: 1 };
  const waterLevel = features.nearWater === true ? 'CLOSE' : String(features.nearWater || 'NONE').toUpperCase();
  const waterMult = WATER_MULT[waterLevel] ?? (features.nearWater ? 1.2 : 1);
  // An explicit 'NONE' level is no water at all — neither the multiplier nor
  // the additive factor applies (property-calculator.js:678 defaults to it).
  if (features.nearWater && waterLevel !== 'NONE' && waterMult <= 1) pressure += f.nearWater;
  if (features.irrigation) pressure += f.irrigation;
  // Ramp boundaries come from the (possibly DB-overlaid) lot categories exactly as
  // service-pricing.js mosquitoLotSizePressure derives them: each band starts one
  // square foot past the previous band's maxSqFt (codex r13 P2).
  const bound = (key) => { const c = M.lotCategories.find((x) => x.key === key); return c && Number.isFinite(c.maxSqFt) ? c.maxSqFt + 1 : null; };
  const rampStart = bound('QUARTER') || 12000; const halfStart = bound('THIRD') || 18000; const acreStart = bound('HALF') || 35000;
  if (pricingSqFt >= acreStart) pressure += f.lot_acre;
  else if (pricingSqFt >= halfStart) pressure += f.lot_half + ((pricingSqFt - halfStart) / (acreStart - halfStart)) * (f.lot_acre - f.lot_half);
  else if (pricingSqFt >= rampStart) pressure += ((pricingSqFt - rampStart) / (halfStart - rampStart)) * f.lot_half;
  if (waterMult > 1) pressure *= waterMult;
  pressure = Math.min(pressure, M.pressureCap);
  const perVisit = Math.round(base * pressure);
  const visits = M.tierVisits[program];
  // Recurring add-ons are ANNUAL charges (station $39/yr, dunk $4/yr), never
  // per visit; counts round to integers and clamp at 0 (codex r10 P2).
  const addOnQty = (n) => Math.max(0, Math.round(Number(n) || 0));
  const annualAddOns = addOnQty(stationCount) * M.addOns.in2CareStation.price + addOnQty(dunkCount) * M.addOns.dunkTablet.price;
  const annual = perVisit * visits + annualAddOns;
  const monthly = round2(annual / 12);
  // material per visit from the engine's own product assumptions
  const k = Math.max(1, treatable / 1000);
  const materialPerVisit = round2(Math.max(M.productUsage.bifenthrinBaseOz, M.productUsage.bifenthrinOzPer1000 * k) * M.productCosts.bifenthrinOz + M.productUsage.tekkoProOz * M.productCosts.tekkoProOz);
  return { footprint, hardscape, treatable, category: cat.key, pricingSqFt, base, pressure: round2(pressure), perVisit, visits, annualAddOns, annual, monthly, materialPerVisit };
}

// RODENT BAIT — footprint bracket, per quarterly visit, ladder extension
function expectRodentBait({ homeSqFt, stories = 1 }) {
  const R = constants.RODENT;
  const fp = footprintOf(homeSqFt, stories) || 2500;
  let stations; let perVisit; let extended = false;
  const b = R.baitBrackets.find((x) => fp <= x.maxSqFt);
  if (b) { stations = b.stations; perVisit = b.perVisit; } else {
    const top = R.baitBrackets[R.baitBrackets.length - 1];
    const steps = Math.ceil((fp - top.maxSqFt) / R.baitBracketExtension.perSqFt);
    stations = top.stations + steps * R.baitBracketExtension.stationsPerStep;
    perVisit = round2(top.perVisit + steps * R.baitBracketExtension.perVisitPerStep);
    extended = true;
  }
  const visits = R.baitVisitsPerYear;
  const annual = round2(perVisit * visits);
  return { footprint: fp, stations, perVisit, visits, annual, monthly: round2(annual / 12), extended, setupFee: R.baitSetupFee };
}

// TERMITE BAIT — perimeter from footprint, the REQUESTED system's label spacing and
// station cost (Trelona 15 ft is the menu default; Advance 10 ft stays priceable so
// an existing estimate replays at its own system — codex r16 P2), 1.45× material
// markup, station-bracket monitoring.
// Property-driven modifiers (codex r19 P2) mirrored as literals from
// modifiers.js so an edit moves only one side: the construction material scales
// the marked-up install material (wood frame 1.15, steel frame 0.95, ICF 0.9,
// block / CMU / concrete / unknown 1.0 — case-insensitive) and the foundation
// adds a flat trenching adjustment after it (crawlspace $150, pier-and-beam
// $125, raised $100, slab / unknown $0). Monitoring is untouched by either.
const TERMITE_CONSTRUCTION_MULT = { WOOD_FRAME: 1.15, STEEL_FRAME: 0.95, BLOCK: 1, CMU: 1, CONCRETE: 1, ICF: 0.9 };
const TERMITE_FOUNDATION_ADJ = { CRAWLSPACE: 150, RAISED: 100, PIER_AND_BEAM: 125, SLAB: 0 };
const termiteConstructionMultOf = (material) => TERMITE_CONSTRUCTION_MULT[String(material || '').toUpperCase()] ?? 1;
const termiteFoundationAdjOf = (foundation) => TERMITE_FOUNDATION_ADJ[String(foundation || '').toUpperCase()] ?? 0;
function expectTermiteBait({ homeSqFt, stories = 1, complexity = 'standard', system = constants.TERMITE.defaultSystem, constructionMaterial = null, foundationType = null }) {
  const T = constants.TERMITE;
  const fp = footprintOf(homeSqFt, stories);
  const constructionMult = termiteConstructionMultOf(constructionMaterial);
  const foundationAdj = termiteFoundationAdjOf(foundationType);
  // moderate and complex both take the complex multiplier; anything else is
  // standard (service-pricing.js normalizeTermiteComplexity).
  const perimMult = complexity === 'complex' || complexity === 'moderate' ? T.perimeterMultiplier.complex : T.perimeterMultiplier.standard;
  const perimeter = Math.round(4 * Math.sqrt(fp) * perimMult);
  const sys = T.systems[system] || T.systems[T.defaultSystem];
  const spacingFt = Number(sys.spacingFt) > 0 ? Number(sys.spacingFt) : T.stationSpacing;
  const stations = Math.max(T.minStations, Math.ceil(perimeter / spacingFt));
  const installMaterial = stations * (sys.stationCost + sys.laborMaterial + sys.misc);
  const installLabor = stations * 0.083 * constants.GLOBAL.LABOR_RATE;
  const installPrice = Math.round(installMaterial * T.installMultiplier * constructionMult + foundationAdj);
  const steps = Math.max(0, Math.ceil(stations / T.monitoring.bracketStations) - 2);
  const monitoringMonthly = round2(T.monitoring.baseMonthly + steps * T.monitoring.stepMonthly);
  const monitoringAnnual = round2(monitoringMonthly * 12);
  const perApp = round2(monitoringAnnual / T.monitoringVisitsPerYear);
  return { system, spacingFt, complexity, perimMult, footprint: fp, perimeter, stations, installMaterial: round2(installMaterial), installLabor: round2(installLabor), installPrice, installMarkupOnMaterial: T.installMultiplier - 1, constructionMult, foundationAdj, monitoringMonthly, monitoringAnnual, perApp, visits: T.monitoringVisitsPerYear };
}

// ONE-TIME PEST — max(floor, round(quarterlyBase × 2.2)) × urgency; 15% perk; strict > visit-1 clamp
function expectOneTimePest({ homeSqFt, stories = 1, features = {}, propertyType = 'single_family', urgency = 'NONE', afterHours = false, isRecurringCustomer = false }) {
  const q = expectPest({ homeSqFt, stories, features, propertyType, frequency: 'quarterly' });
  const O = constants.ONE_TIME.pest;
  const multiplied = Math.round(q.basePrice * O.multiplier);
  const preUrgency = Math.max(O.floor, multiplied);
  const u = constants.URGENCY[String(urgency).toUpperCase()] || constants.URGENCY.NONE;
  const mult = afterHours ? (u.afterHours || u.standard || 1) : (u.standard || 1);
  const perkRate = isRecurringCustomer ? constants.WAVEGUARD.recurringCustomerOneTimePerk : 0;
  const discounted = Math.round(preUrgency * mult * (1 - perkRate));
  let price = Math.max(O.floor, discounted);
  const visitOne = round2(q.basePrice + constants.PEST.initialFee);
  const clamped = price <= visitOne;
  if (clamped) price = visitOne + 1;
  return { quarterlyBase: q.basePrice, multiplied, preUrgency, urgencyMult: mult, perkRate, price, visitOne, clamped };
}

// TREE & SHRUB — cost buildup ÷ (1 − 0.45), monthly floor, annual = round2(monthly×12)
function expectTreeShrub({ bedArea, treeCount = 0, palmCount = 0, access = 'easy', tier = 'standard', shrubDensity = 'moderate' }) {
  const TS = constants.TREE_SHRUB;
  const G = constants.GLOBAL;
  const tc = TS.tiers[tier];
  const density = TS.densityFactors[shrubDensity] ?? 1;
  const palmMaterialArmed = (TS.routinePalmCareReserve.perPalmAnnual || 0) > 0;
  const palmLaborArmed = (TS.routinePalmCareReserve.minutesPerPalmVisit || 0) > 0;
  // Service-line palms: each leg either rides the legacy per-tree term (unarmed)
  // or its reserve replacement (armed) — labor minutes per visit inside on-site
  // time, annual material OUTSIDE the tier factor (service-pricing.js
  // priceTreeShrub; codex r8 P2). A --db overlay that arms a knob flows here
  // through the same live constants object.
  const materialTreeCount = treeCount + (palmMaterialArmed ? 0 : palmCount);
  const laborTreeCount = treeCount + (palmLaborArmed ? 0 : palmCount);
  const palmMinutesPerVisit = Math.round((palmLaborArmed ? palmCount : 0) * (TS.routinePalmCareReserve.minutesPerPalmVisit || 0));
  const palmReserveAnnual = (TS.routinePalmCareReserve.perPalmAnnual || 0) * (palmMaterialArmed ? palmCount : 0);
  const onSiteMin = Math.max(25, 20 + Math.round((bedArea / 500) * density) + Math.round(laborTreeCount * 1.5) + palmMinutesPerVisit + (TS.accessMinutes[access] || 0));
  const factor = tier === 'light' ? TS.materialModel.lightFactor : tier === 'enhanced' ? TS.materialModel.enhancedFactor : 1;
  const modeledMaterial = (TS.materialModel.fixedAnnual + TS.materialModel.perTreeAnnual * materialTreeCount + TS.materialModel.perSqFtAnnual * bedArea * density) * factor + palmReserveAnnual;
  const materialCost = Math.max(tc.frequency * 10, modeledMaterial);
  // Same operation order as priceTreeShrub (service-pricing.js:2800): rate ×
  // (minutes / 60), not (rate × minutes) / 60 — the two float orders differ by
  // an ulp that the whole-dollar pass can turn into a $1 false mismatch near a
  // half-dollar boundary (codex r29 P2).
  const laborPerVisit = G.LABOR_RATE * ((onSiteMin + 10) / 60);
  const laborAnnual = laborPerVisit * tc.frequency;
  const directCost = materialCost + laborAnnual + (TS.callbackReservePerVisit || 0) * tc.frequency;
  const baseAnnual = (directCost + G.ADMIN_ANNUAL) / (1 - TS.marginTarget);
  const monthlyFloored = Math.max(tc.monthlyFloor, round2(baseAnnual / 12));
  // Rounding order (three passes): pricer rounds monthly to cents and annual to
  // cents, then estimate-engine.js re-rounds annual to WHOLE DOLLARS and
  // re-derives monthly = annual/12 (estimate-engine.js ~:943-946). The whole-
  // dollar pass moves the customer monthly by up to ±$0.04.
  const annual = Math.round(round2(monthlyFloored * 12));
  const monthly = round2(annual / 12);
  const perApp = round2(annual / tc.frequency);
  return { onSiteMin, materialCost: round2(materialCost), laborPerVisit: round2(laborPerVisit), laborAnnual: round2(laborAnnual), directCost: round2(directCost), baseAnnual: round2(baseAnnual), monthlyBeforeWholeDollarPass: monthlyFloored, monthly, annual, perApp, visits: tc.frequency, floorApplied: monthlyFloored > round2(baseAnnual / 12) };
}

// WDO / German roach / foam drill / top dressing / plugging / palm — flat & cost-plus formulas
// WDO is one terminal bracket in code ($250 flat), but the --db overlay can
// install tiered onetime_wdo brackets (db-bridge); the expected price is the
// first bracket whose maxSqFt covers the footprint (living area / stories, 2,000
// when absent — resolvePestFootprint), else the last one (codex r19 P2).
function expectWdo(homeSqFt = 2000, stories = 1) {
  const fp = footprintOf(homeSqFt, stories) || 2000;
  const brackets = constants.SPECIALTY.wdo.brackets;
  const b = brackets.find((x) => fp <= x.maxSqFt) || brackets[brackets.length - 1];
  return { footprint: fp, price: b.price, bracketMaxSqFt: b.maxSqFt, bracketsLive: brackets.length };
}
function expectGermanRoach(severity = 'light') {
  const cfg = constants.SPECIALTY.germanRoach;
  const key = severity === 'severe' ? 'heavy' : (cfg.tiers[severity] ? severity : cfg.defaultSeverity);
  return { price: cfg.tiers[key].price, visits: cfg.tiers[key].visits, severity: key };
}
function expectFoamDrill(points = 5, urgency = 'ROUTINE', afterHours = false) {
  const cfg = constants.SPECIALTY.foamDrill;
  const tier = cfg.tiers.find((t) => points <= t.maxPoints);
  // Above the top tier the engine fails closed (quote required, >20 points):
  // the independent formula must expect NO price there, not the top tier's.
  if (!tier) return { price: null, refusedOverMaxPoints: true, maxPoints: cfg.tiers[cfg.tiers.length - 1].maxPoints };
  const cost = tier.cans * cfg.canCost + tier.laborHrs * constants.GLOBAL.LABOR_RATE + cfg.bitsCost;
  let price = Math.max(cfg.floor, Math.round(cost / cfg.marginDivisor));
  const mult = urgency === 'SOON' ? (afterHours ? 1.5 : 1.25) : urgency === 'URGENT' ? (afterHours ? 2 : 1.5) : 1;
  price = Math.round(price * mult);
  return { cost: round2(cost), price, tier: tier.label, cans: tier.cans, laborHrs: tier.laborHrs, targetMargin: 1 - cfg.marginDivisor, realizedMargin: round2((price - cost) / price) };
}
function expectTopDressing(lawnSqFt, depth = 'eighth', hasRecurringLawn = false) {
  const cfg = constants.SPECIALTY.topDressing[depth];
  const lawnEst = hasRecurringLawn ? lawnSqFt : lawnSqFt * 0.65;
  const k = lawnEst / 1000;
  const material = depth === 'eighth' ? k * 1.04 * cfg.sandRate + k * cfg.deliveryRate : k * 2.08 * cfg.sandRate + k * cfg.deliveryRate;
  const laborMin = depth === 'eighth' ? lawnEst / 130 + 30 : (lawnEst / 130) * 1.5 + 45;
  const labor = (constants.GLOBAL.LABOR_RATE * laborMin) / 60;
  const price = Math.max(cfg.floor, Math.round((material + labor) / cfg.marginDivisor));
  return { lawnEst: Math.round(lawnEst), material: round2(material), laborMin: round2(laborMin), labor: round2(labor), price, targetMargin: 1 - cfg.marginDivisor };
}
function expectPlugging(lawnSqFt, spacing = 12, urgency = 'ROUTINE', afterHours = false) {
  const cfg = constants.SPECIALTY.plugging;
  const ppsf = cfg.spacingRates[`${spacing}inch`] || cfg.spacingRates['12inch'];
  const plugs = Math.ceil(lawnSqFt * ppsf);
  const cost = plugs * cfg.costPerPlug + (plugs / cfg.laborPerPlugs) * constants.GLOBAL.LABOR_RATE;
  // Urgency applies AFTER the floor, then re-rounds (pricePlugging →
  // applyUrgency) — the same ladder foam drill uses (codex r30 P2).
  const mult = urgency === 'SOON' ? (afterHours ? 1.5 : 1.25) : urgency === 'URGENT' ? (afterHours ? 2 : 1.5) : 1;
  const price = Math.round(Math.max(250, Math.round(cost / 0.55)) * mult);
  return { plugs, cost: round2(cost), price, urgencyMult: mult, targetMargin: 0.45 };
}
// Every supported treatment family (codex r14 P2): fixed, tiered, fungal (quote:
// floor / custom, apps from appsPerYear or 12/intervalMonths), lethal bronzing
// (quote: floor / custom, fixed 4 apps, eligible statuses only) and Tree-Age
// (DBH tier floor / custom, quote-only above the last priced tier, 0.5 apps/yr).
// A branch the engine must refuse returns null; pricing it is a P1 below.
function expectPalm({ treatmentType = 'nutrition', palmCount = 1, palmSize, appsPerYear = null, intervalMonths = null, customPricePerPalm = null, diagnosisConfirmed = false, selectedProduct = null, palmStatus = null, dbhInches = null, highDose = false, largeDiameter = false, nonstandardProduct = false, product = null, restrictedUseProduct = false, licensedApplicator = false }) {
  const P = constants.PALM;
  const t = P.treatments[treatmentType];
  if (!t) return null;
  const quote = (floor) => (customPricePerPalm == null ? floor : Math.max(Number(customPricePerPalm), floor));
  let perPalm; let apps;
  if (t.pricingType === 'fixed') {
    perPalm = t.pricePerPalm;
    // Mirror of pricePalmInjection's cadence validation (service-pricing.js:4159-4168):
    // an omitted cadence takes the default; a supplied one must be a finite
    // positive number AND one of the configured allowedAppsPerYear values,
    // otherwise the engine throws — so the expectation is NO price (codex r25 P2).
    if (appsPerYear === null || appsPerYear === undefined || appsPerYear === '') apps = t.defaultAppsPerYear;
    else if (typeof appsPerYear !== 'number' || !Number.isFinite(appsPerYear) || appsPerYear <= 0) return null;
    else if (!Array.isArray(t.allowedAppsPerYear) || !t.allowedAppsPerYear.includes(appsPerYear)) return null;
    else apps = appsPerYear;
  }
  else if (t.pricingType === 'tiered') {
    // The engine fails closed on a tiered treatment without a palm size
    // (getTierByPalmSize) — expect NO price, never a defaulted medium tier.
    if (!palmSize) return null;
    const tier = t.tiers.find((x) => x.size === palmSize);
    if (!tier) return null;
    // quoteBasedWhen flags switch a tiered treatment to quote pricing: a custom
    // price is REQUIRED and floors at the selected size tier (codex r15 P2).
    const flags = { highDose, largeDiameter, nonstandardProduct };
    const quoteRequired = (t.quoteBasedWhen || []).some((f) => flags[f] === true);
    if (quoteRequired && customPricePerPalm == null) return null;
    perPalm = quoteRequired ? quote(tier.pricePerPalm) : tier.pricePerPalm; apps = t.defaultAppsPerYear;
  } else if (treatmentType === 'fungal') {
    if (diagnosisConfirmed !== true || !t.products.includes(selectedProduct)) return null;
    if (appsPerYear == null && intervalMonths == null) return null;
    // Mirror resolveAppsPerYear → assertPositiveNumber: the cadence must be a
    // finite positive NUMBER (a numeric string, zero, negative, NaN or Infinity
    // is refused) — never Number()-coerced into a zero / negative / infinite
    // annual price (codex r29 P2).
    const cadence = appsPerYear != null ? appsPerYear : intervalMonths;
    if (typeof cadence !== 'number' || !Number.isFinite(cadence) || cadence <= 0) return null;
    apps = appsPerYear != null ? appsPerYear : round2(12 / intervalMonths);
    perPalm = quote(t.floorPerPalm);
  } else if (treatmentType === 'lethalBronzing') {
    if (!t.eligibleStatuses.includes(palmStatus)) return null;
    apps = t.appsPerYear; perPalm = quote(t.floorPerPalm);
  } else if (treatmentType === 'treeAge') {
    if (!(Number(dbhInches) > 0)) return null;
    const tier = t.tiers.find((x) => x.dbhMax === null || Number(dbhInches) <= x.dbhMax);
    if (tier.quoteBased && customPricePerPalm == null) return null;
    // A restricted-use product — Tree-Age R10 by name or the restrictedUseProduct
    // flag — prices only for a licensed applicator, and the licence is strictly
    // `true` (a truthy string is not a licence) — codex r19 P2.
    if ((product === 'Tree-Age R10' || restrictedUseProduct === true) && licensedApplicator !== true) return null;
    apps = t.appsPerYear; perPalm = quote(tier.pricePerPalm || 110);
  } else return null;
  const rawPerVisit = round2(perPalm * palmCount);
  const perVisit = Math.max(rawPerVisit, P.minPerVisit);
  // the engine rounds the palm line's annual to whole dollars (estimate-engine.js)
  const annual = round2(perVisit * apps);
  return { perPalm, apps, rawPerVisit, perVisit, annual, minimumApplied: perVisit > rawPerVisit };
}

// WAVEGUARD — tier from count of qualifying services; % on eligible recurring lines
function expectTier(serviceKeys) {
  const q = serviceKeys.filter((k) => constants.WAVEGUARD.qualifyingServices.includes(k)).length;
  const T = constants.WAVEGUARD.tiers;
  if (q >= T.platinum.minServices) return { tier: 'platinum', discount: T.platinum.discount, count: q };
  if (q >= T.gold.minServices) return { tier: 'gold', discount: T.gold.discount, count: q };
  if (q >= T.silver.minServices) return { tier: 'silver', discount: T.silver.discount, count: q };
  return { tier: 'bronze', discount: 0, count: q };
}

// ── Unit-economics calculator (the audit's own definitions) ──
// gross margin = (rev − direct) / rev ; markup = (rev − direct) / direct
// contribution = (rev − cardFee − direct) / rev, card fee = 2.9% on credit-card payers
function unitEconomics({ revenuePerVisit, visits, onSiteMinutes, driveMinutes = constants.GLOBAL.DRIVE_TIME, technicians = 1, materialPerVisit = 0, consumablesPerVisit = 0, adminAnnual = constants.GLOBAL.ADMIN_ANNUAL, callbackRate = 0, callbackMinutes = 0, callbackDriveMinutes = driveMinutes, callbackMaterial = 0, discountPct = 0, cardFeeRate = 0.029, laborRate = constants.GLOBAL.LABOR_RATE }) {
  const labor = ((onSiteMinutes + driveMinutes) / 60) * laborRate * technicians;
  // callbackMinutes is a RECORDED span (check-in → check-out, drive included) —
  // callers pass callbackDriveMinutes: 0 so drive is never re-added (codex r14 P2).
  const expectedCallback = callbackRate * (((callbackMinutes + callbackDriveMinutes) / 60) * laborRate + callbackMaterial);
  const directPerVisit = labor + materialPerVisit + consumablesPerVisit + expectedCallback;
  const directAnnual = directPerVisit * visits + adminAnnual;
  const revenueAnnual = revenuePerVisit * visits * (1 - discountPct);
  const grossProfit = revenueAnnual - directAnnual;
  const grossMargin = revenueAnnual > 0 ? grossProfit / revenueAnnual : null;
  const markup = directAnnual > 0 ? grossProfit / directAnnual : null;
  // Card proceeds per funding path (codex r5 P2): confirmed credit collects a
  // separately rounded surcharge (computeChargeAmount) that offsets the %
  // cost; debit / prepaid / unknown collect none. Stripe's fixed $0.30 per
  // transaction applies to both. contributionMargin reports the debit path
  // (the worse of the two); contributionMarginCredit is beside it.
  const perVisitNet = revenuePerVisit * (1 - discountPct);
  const credit = computeChargeAmount(perVisitNet, 'card', { funding: 'credit' });
  const creditCostPerVisit = credit.total * cardFeeRate + CARD_FIXED_FEE;
  const creditProceedsAnnual = (credit.total - creditCostPerVisit) * visits;
  const debitCostPerVisit = perVisitNet * cardFeeRate + CARD_FIXED_FEE;
  const debitProceedsAnnual = (perVisitNet - debitCostPerVisit) * visits;
  const cardFee = debitCostPerVisit * visits;
  const contributionMargin = revenueAnnual > 0 ? (debitProceedsAnnual - directAnnual) / revenueAnnual : null;
  const contributionMarginCredit = revenueAnnual > 0 ? (creditProceedsAnnual - directAnnual) / revenueAnnual : null;
  const targetPriceAnnual35 = directAnnual / (1 - 0.35);
  return {
    laborPerVisit: round2(labor), materialPerVisit: round2(materialPerVisit), expectedCallbackPerVisit: round2(expectedCallback),
    directPerVisit: round2(directPerVisit), directAnnual: round2(directAnnual), revenueAnnual: round2(revenueAnnual),
    grossProfit: round2(grossProfit), grossMargin: grossMargin === null ? null : Math.round(grossMargin * 1000) / 1000,
    markup: markup === null ? null : Math.round(markup * 1000) / 1000, contributionMargin: contributionMargin === null ? null : Math.round(contributionMargin * 1000) / 1000, contributionMarginCredit: contributionMarginCredit === null ? null : Math.round(contributionMarginCredit * 1000) / 1000, surchargePerVisit: credit.surcharge,
    targetPriceAnnualAt35: round2(targetPriceAnnual35), targetPerVisitAt35: round2(targetPriceAnnual35 / visits),
  };
}

// ── Engine driver (the only place the engine is called) ──
function runEngine(input) {
  try {
    const r = generateEstimate(input);
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const line = (r, service) => (r && r.lineItems ? r.lineItems.find((l) => l.service === service) : null);

// ── Scenario matrix ──
const BASE = { homeSqFt: 2000, stories: 1, lotSqFt: 8000, lawnSqFt: 4500, propertyType: 'single_family' };
const findings = [];
const scenarios = [];
// A price that is NaN / ±Infinity / not a number on EITHER side is a discrepancy,
// never a match: diff used to become null and Math.abs(null) === 0 passed the
// tolerance, so a non-finite engine result recorded as 'match' and the audit
// could exit 0 on an invalid price (codex r16 P1). Every tolerance comparison in
// this file goes through this predicate.
const offBy = (expected, actual, tol) => !(Number.isFinite(expected) && Number.isFinite(actual)) || Math.abs(actual - expected) > tol;
function record(section, name, input, expected, actual, opts = {}) {
  const tol = opts.tolerance ?? 0.005;
  const diff = Number.isFinite(expected) && Number.isFinite(actual) ? round2(actual - expected) : null;
  // NO_PRICE = the independent formula expected a price and the engine
  // returned none. It is a discrepancy like any other (a refused or errored
  // line where a price was expected) and is counted, listed and raised as a
  // finding — never silently dropped from the totals (codex P1 on PR #3792).
  const status = expected === null || expected === undefined ? 'engine_only' : (actual === null || actual === undefined ? 'NO_PRICE' : (offBy(expected, actual, tol) ? 'MISMATCH' : 'match'));
  // Scenario metadata stays under row.extra — the Markdown renderer prints
  // s.extra, so spreading it onto the row hid every observation (codex r2 P2).
  const row = { section, name, input, expected, actual, diff, status, extra: opts.extra || null };
  scenarios.push(row);
  if (status === 'MISMATCH') findings.push({ severity: 'P1', section, name, detail: diff === null ? `non-finite price: independent ${expected} vs engine ${actual}` : `independent ${expected} vs engine ${actual} (diff ${diff})` });
  if (status === 'NO_PRICE') findings.push({ severity: 'P1', section, name, detail: `independent ${expected} but the engine returned no price for this line` });
  return row;
}
// A failed P0/P1 invariant is a COUNTED discrepancy, not a note (codex r18 P1):
// flagIf records a MISMATCH scenario row — so it lands in the mismatch count,
// the discrepancy list and the exit code — as well as the finding. Passing
// invariants are not enumerated separately; they ride the record they
// accompany. P2 flags stay advisory (finding only).
function flagIf(cond, severity, section, name, detail) {
  if (!cond) return;
  findings.push({ severity, section, name, detail });
  // A flag that accompanies a row of the same name (e.g. the prepay-cadence
  // check pushes its own MISMATCH row first) is already counted through it.
  const rowed = scenarios.some((s) => s.section === section && s.name === name);
  if (!rowed && (severity === 'P0' || severity === 'P1')) scenarios.push({ section, name, input: null, expected: 'invariant holds', actual: detail, diff: null, status: 'MISMATCH', extra: { invariant: true } });
}

function runPestMatrix() {
  const section = 'pest_control';
  // Boundaries come from the LIVE bracket array (DB overlay included), never a
  // hardcoded list, so an off-by-one at a new breakpoint is tested (codex r14 P2).
  const boundaries = constants.PEST.footprintBrackets.map((b) => Number(b.sqft)).filter((n) => Number.isFinite(n) && n > 0);
  const sizes = new Set([500, 799, ...boundaries, ...boundaries.map((b) => b - 1), ...boundaries.map((b) => b + 1), 6500, 10000, 20000]);
  for (const sqft of [...sizes].sort((a, b) => a - b)) {
    for (const frequency of ['quarterly', 'bimonthly', 'monthly']) {
      const exp = expectPest({ homeSqFt: sqft, frequency });
      const r = runEngine({ ...BASE, homeSqFt: sqft, services: { pest: { frequency } } });
      const li = line(r.result, 'pest_control');
      record(section, `footprint ${sqft} ${frequency}`, { homeSqFt: sqft, frequency }, exp.perApp, li ? li.perApp : null, { extra: { annualExpected: exp.annual, annualActual: li ? li.annual : null, review: li ? li.requiresManualReview : null } });
      if (li) flagIf(offBy(exp.annual, li.annual, 0.005), 'P1', section, `annual ${sqft} ${frequency}`, `annual ${li.annual} vs ${exp.annual}`);
    }
  }
  // feature modifiers
  const featureCases = [
    { features: { poolCage: true, poolCageSize: 'small' } }, { features: { poolCage: true, poolCageSize: 'large' } }, { features: { poolCage: true, poolCageSize: 'oversized' } },
    { features: { pool: true } }, { features: { shrubs: 'heavy' } }, { features: { shrubs: 'light' } }, { features: { complexity: 'complex' } }, { features: { complexity: 'simple' } },
    { features: { nearWater: 'YES' } }, { features: { indoor: true } },
    // attachedGarage (codex r26 P2): PEST.additionalAdjustments.attachedGarage via
    // hasAttachedGarageForPest (service-pricing.js:1478-1508) on the normalised feature.
    { features: { attachedGarage: true } }, { features: { attachedGarage: true, pool: true } },
  ];
  for (const fc of featureCases) {
    const norm = { ...fc.features, nearWater: fc.features.nearWater === 'YES' };
    const exp = expectPest({ homeSqFt: 2000, features: norm });
    const r = runEngine({ ...BASE, features: fc.features, services: { pest: { frequency: 'quarterly' } } });
    const li = line(r.result, 'pest_control');
    record(section, `features ${JSON.stringify(fc.features)}`, fc.features, exp.perApp, li ? li.perApp : null);
  }
  for (const propertyType of Object.keys(constants.PROPERTY_TYPE_ADJ)) {
    const exp = expectPest({ homeSqFt: 2000, propertyType });
    const r = runEngine({ ...BASE, propertyType, services: { pest: { frequency: 'quarterly' } } });
    const li = line(r.result, 'pest_control');
    record(section, `propertyType ${propertyType}`, { propertyType }, exp.perApp, li ? li.perApp : null);
  }
  // year built → age adjustment at every boundary ±1 (codex r14 P2); 3,000 sf so the
  // floor cannot mask the adder
  const thisYear = currentETYear();
  for (const age of [0, 19, 20, 21, 39, 40, 41, 59, 60, 61, 120]) {
    const yearBuilt = thisYear - age;
    const exp = expectPest({ homeSqFt: 3000, yearBuilt });
    const r = runEngine({ ...BASE, homeSqFt: 3000, yearBuilt, services: { pest: { frequency: 'quarterly' } } });
    const li = line(r.result, 'pest_control');
    record(section, `yearBuilt ${yearBuilt} (age ${age}) quarterly (3000 sf)`, { homeSqFt: 3000, yearBuilt }, exp.perApp, li ? li.perApp : null, { extra: { ageAdjExpected: pestAgeAdjOf(yearBuilt) } });
  }
  // stories
  for (const stories of [1, 2, 3]) {
    const exp = expectPest({ homeSqFt: 3000, stories });
    const r = runEngine({ ...BASE, homeSqFt: 3000, stories, services: { pest: { frequency: 'quarterly' } } });
    const li = line(r.result, 'pest_control');
    record(section, `stories ${stories} (3000 sf)`, { homeSqFt: 3000, stories }, exp.perApp, li ? li.perApp : null, { extra: { footprintUsed: li ? li.footprintUsed : null } });
  }
  // invalid / degenerate inputs
  const bad = [
    { name: 'blank homeSqFt', input: { ...BASE, homeSqFt: '' } },
    { name: 'zero homeSqFt', input: { ...BASE, homeSqFt: 0 } },
    { name: 'negative homeSqFt', input: { ...BASE, homeSqFt: -1500 } },
    { name: 'decimal homeSqFt', input: { ...BASE, homeSqFt: 2000.7 } },
    { name: 'huge homeSqFt 1e9', input: { ...BASE, homeSqFt: 1e9 } },
    { name: 'negative stories', input: { ...BASE, stories: -3 } },
    { name: 'decimal stories', input: { ...BASE, stories: 2.7 } },
    { name: 'unknown frequency semiannual', input: { ...BASE }, freq: 'semiannual' },
    { name: 'unknown propertyType Condo', input: { ...BASE, propertyType: 'Condo' } },
  ];
  for (const b of bad) {
    const r = runEngine({ ...b.input, services: { pest: { frequency: b.freq || 'quarterly' } } });
    const li = line(r.result, 'pest_control');
    const row = record(section, `invalid: ${b.name}`, b.input, null, li ? li.perApp : null, { extra: { engineError: r.ok ? null : r.error, review: li ? li.requiresManualReview : null, warnings: li ? (li.warnings || []).slice(0, 4) : null, footprintUsed: li ? li.footprintUsed : null, footprintSource: li ? li.footprintSource : null, frequency: li ? li.frequency : null } });
    if (li && li.perApp > 0 && !li.requiresManualReview && !(li.warnings || []).length) {
      findings.push({ severity: 'P2', section, name: `invalid input priced silently: ${b.name}`, detail: `perApp ${li.perApp}, footprint ${li.footprintUsed} (${li.footprintSource}), no review flag / warning` });
    }
    void row;
  }
}

function runLawnMatrix() {
  const section = 'lawn_care';
  // Simulated overlay (codex r14 P2): arm the cost floor and a program minimum the
  // way a pricing_config row would, price the same sizes, restore. The engine reads
  // LAWN_PRICING_V2 at call time, so this is exactly what --db exercises.
  const V = constants.LAWN_PRICING_V2;
  const saved = { useLawnCostFloor: V.useLawnCostFloor, programMinimumMonthly: V.programMinimumMonthly };
  for (const overlay of [{ useLawnCostFloor: true, programMinimumMonthly: 0 }, { useLawnCostFloor: false, programMinimumMonthly: 150 }, { useLawnCostFloor: true, programMinimumMonthly: 150 }]) {
    Object.assign(V, overlay);
    try {
      for (const track of ['st_augustine', 'bahia']) for (const sqft of [1000, 2500, 4500, 8000, 20000, 25000]) for (const tier of ['standard', 'enhanced', 'premium']) {
        const exp = expectLawn({ track, lawnSqFt: sqft, tier });
        const r = runEngine({ ...BASE, lawnSqFt: sqft, services: { lawn: { track, tier } } });
        const li = line(r.result, 'lawn_care');
        record(section, `[overlay floor=${overlay.useLawnCostFloor} min=${overlay.programMinimumMonthly}/mo] ${track} ${sqft}sf ${tier}`, { track, lawnSqFt: sqft, tier, overlay }, exp.perApp, li ? li.perApp : null, { extra: { annualExpected: exp.annual, annualActual: li ? li.annual : null, floorAnnual: exp.floorAnnual, floored: exp.floored, lifted: exp.lifted, engineBasis: li ? li.pricingBasis ?? null : null, engineLift: li ? li.cadenceLadderLiftApplied ?? null : null } });
        if (li) flagIf(offBy(exp.annual, li.annual, 0.005), 'P1', section, `[overlay] annual ${track} ${sqft} ${tier}`, `annual ${li.annual} vs ${exp.annual}`);
      }
    } finally { Object.assign(V, saved); }
  }
  // Armed floor with the property cost inputs (codex r20 P2): complexity /
  // heavy shrubs / privacy fence minutes, poor-maintenance and high-pressure
  // callback reserve, and an explicit route drive time — each on the field the
  // engine actually reads (top-level profile fields, the features object, or
  // services.lawn.routeDriveMinutes), plus unrecognised values proven neutral.
  // The floor must bind on at least one case or the block proves nothing.
  const propertyCases = [
    { name: 'complex + heavy shrubs + poor maintenance + high pressure + privacy fence', property: { landscapeComplexity: 'complex', shrubDensity: 'heavy', maintenanceCondition: 'poor', overallPestPressure: 'high', fenceType: 'privacy' } },
    { name: 'features.complexity=moderate + features.shrubs=heavy', property: { features: { complexity: 'moderate', shrubs: 'heavy' } } },
    { name: 'maintenance "Deferred" + pressure "very-high" (normalised)', property: { maintenanceCondition: 'Deferred', overallPestPressure: 'very-high' } },
    { name: 'features.accessDifficulty mentions a privacy fence', property: { features: { accessDifficulty: 'privacy fence, locked gate' } } },
    { name: 'input.routeDriveMinutes=20 (explicit drive replaces route density)', property: { routeDriveMinutes: 20 }, routeDriveMinutes: 20 },
    { name: 'services.lawn.routeDriveMinutes=15 (service line wins)', property: {}, routeDriveMinutes: 15, lawnLine: { routeDriveMinutes: 15 } },
    { name: 'unrecognised values are neutral', property: { landscapeComplexity: 'wild', shrubDensity: 'sparse', maintenanceCondition: 'GOOD', overallPestPressure: 'LOW', fenceType: 'chain link' } },
    // Route density is NOT an estimate input (codex r26 P2, re-verified): the
    // floor reads options.routeDensity || property.routeDensity (service-pricing.js:1983)
    // but neither is populated from the profile, the features object or the lawn
    // line, so SPARSE at every placement must price exactly like the neutral case
    // (the expectation carries no density) — the explicit routeDriveMinutes input
    // above is the only reachable drive-time lever. A future wiring of the input
    // shows here as a mismatch and must add the density to the expectation.
    { name: 'routeDensity=SPARSE at input / features / services.lawn is unreachable (neutral)', property: { routeDensity: 'SPARSE', features: { routeDensity: 'SPARSE' } }, lawnLine: { routeDensity: 'SPARSE' } },
  ];
  Object.assign(V, { useLawnCostFloor: true, programMinimumMonthly: 0 });
  let anyPropertyFloored = false;
  try {
    for (const pc of propertyCases) for (const sqft of [2500, 4500, 8000]) for (const tier of ['standard', 'enhanced', 'premium']) {
      const neutral = expectLawn({ track: 'st_augustine', lawnSqFt: sqft, tier });
      const exp = expectLawn({ track: 'st_augustine', lawnSqFt: sqft, tier, property: pc.property, routeDriveMinutes: pc.routeDriveMinutes ?? null });
      const r = runEngine({ ...BASE, lawnSqFt: sqft, ...pc.property, services: { lawn: { track: 'st_augustine', tier, ...(pc.lawnLine || {}) } } });
      const li = line(r.result, 'lawn_care');
      anyPropertyFloored = anyPropertyFloored || exp.floored;
      record(section, `[overlay floor=true min=0/mo] st_augustine ${sqft}sf ${tier} [property: ${pc.name}]`, { lawnSqFt: sqft, tier, property: pc.property, routeDriveMinutes: pc.routeDriveMinutes ?? null }, exp.perApp, li ? li.perApp : null, { extra: { annualExpected: exp.annual, annualActual: li ? li.annual : null, floorAnnual: exp.floorAnnual, neutralFloorAnnual: neutral.floorAnnual, floored: exp.floored, lifted: exp.lifted, engineBasis: li ? li.pricingBasis ?? null : null, engineError: r.ok ? null : r.error } });
      if (li) flagIf(offBy(exp.annual, li.annual, 0.005), 'P1', section, `[overlay property] annual st_augustine ${sqft} ${tier} [${pc.name}]`, `annual ${li.annual} vs ${exp.annual}`);
    }
  } finally { Object.assign(V, saved); }
  flagIf(!anyPropertyFloored, 'P1', section, '[overlay property] armed floor binds on at least one property-input case', 'no property-input case was floored — the block proves nothing');
  // Bermuda suppression add-on (codex r17 P2): gate-enabled in-process (the engine
  // reads GATE_BERMUDA_SUPPRESSION at call time through gateEnvValue), priced on
  // the St. Augustine track at every cadence, ineligible on bahia, and asserted to
  // FAIL CLOSED when the gate is off — a checked add-on must never price silently
  // without it. The env value is restored after.
  const savedGate = process.env.GATE_BERMUDA_SUPPRESSION;
  process.env.GATE_BERMUDA_SUPPRESSION = 'true';
  try {
    for (const track of ['st_augustine', 'bahia']) for (const sqft of [2500, 4500, 8000, 20000]) for (const tier of ['standard', 'enhanced', 'premium']) {
      const exp = expectLawn({ track, lawnSqFt: sqft, tier, bermudaSuppression: true });
      const r = runEngine({ ...BASE, lawnSqFt: sqft, services: { lawn: { track, tier, bermudaSuppression: true } } });
      const li = line(r.result, 'lawn_care');
      record(section, `[gate on] bermuda suppression ${track} ${sqft}sf ${tier}${track === 'st_augustine' ? '' : ' (ineligible track: no adder)'}`, { track, lawnSqFt: sqft, tier, bermudaSuppression: true }, exp.perApp, li ? li.perApp : null, { extra: { annualExpected: exp.annual, annualActual: li ? li.annual : null, suppressionPerAppExpected: exp.suppressionPerApp, suppressionPerAppActual: li ? ((li.tiers || []).find((t) => t.tier === tier)?.bermudaSuppressionPerApp ?? li.bermudaSuppressionPerApp ?? null) : null, engineError: r.ok ? null : r.error } });
      if (li) flagIf(offBy(exp.annual, li.annual, 0.005), 'P1', section, `[gate on] bermuda suppression annual ${track} ${sqft} ${tier}`, `annual ${li.annual} vs ${exp.annual}`);
    }
  } finally { if (savedGate === undefined) delete process.env.GATE_BERMUDA_SUPPRESSION; else process.env.GATE_BERMUDA_SUPPRESSION = savedGate; }
  {
    const savedOff = process.env.GATE_BERMUDA_SUPPRESSION;
    delete process.env.GATE_BERMUDA_SUPPRESSION;
    try {
      const r = runEngine({ ...BASE, lawnSqFt: 4500, services: { lawn: { track: 'st_augustine', tier: 'enhanced', bermudaSuppression: true } } });
      const failedClosed = !r.ok && /GATE_BERMUDA_SUPPRESSION/.test(r.error || '');
      const row = { section, name: '[gate off] bermuda suppression requested ⇒ engine fails closed (BERMUDA_SUPPRESSION_GATED), never a silent unchanged price', expected: 'throws BERMUDA_SUPPRESSION_GATED', actual: r.ok ? `priced ${line(r.result, 'lawn_care')?.perApp ?? null}/app without the gate` : r.error, status: failedClosed ? 'match' : 'MISMATCH', extra: null };
      scenarios.push(row);
      if (row.status === 'MISMATCH') findings.push({ severity: 'P1', section, name: row.name, detail: String(row.actual) });
    } finally { if (savedOff !== undefined) process.env.GATE_BERMUDA_SUPPRESSION = savedOff; }
  }
  for (const track of Object.keys(constants.LAWN_BRACKETS)) {
    // Row edges from EACH track's live bracket rows (codex r15 P2), plus the table cutoff ±1.
    const rowEdges = constants.LAWN_BRACKETS[track].map((r) => r[0]);
    const sizes = new Set([500, 1499, ...rowEdges, ...rowEdges.map((x) => x - 1), ...rowEdges.map((x) => x + 1), 4250, 12500, constants.LAWN_TABLE_MAX_SQFT, constants.LAWN_TABLE_MAX_SQFT + 1, 25000, 30000]);
    for (const sqft of [...sizes].sort((a, b) => a - b)) {
      for (const tier of ['standard', 'enhanced', 'premium']) {
        const exp = expectLawn({ track, lawnSqFt: sqft, tier });
        const r = runEngine({ ...BASE, lawnSqFt: sqft, services: { lawn: { track, tier } } });
        const li = line(r.result, 'lawn_care');
        record(section, `${track} ${sqft}sf ${tier}`, { track, lawnSqFt: sqft, tier }, exp.perApp, li ? li.perApp : null, { extra: { annualExpected: exp.annual, annualActual: li ? li.annual : null, customQuote: li ? li.customQuoteFlag : null, basis: li ? li.pricingBasis : null } });
        if (li) flagIf(offBy(exp.annual, li.annual, 0.005), 'P1', section, `annual ${track} ${sqft} ${tier}`, `annual ${li.annual} vs ${exp.annual}`);
      }
    }
  }
  // cadence ladder invariant (per-app should fall or hold with more visits inside the table)
  for (const track of Object.keys(constants.LAWN_BRACKETS)) {
    for (const sqft of [2000, 4500, 8000, 12000, 20000]) {
      const pa = ['standard', 'enhanced', 'premium'].map((tier) => line(runEngine({ ...BASE, lawnSqFt: sqft, services: { lawn: { track, tier } } }).result, 'lawn_care').perApp);
      flagIf(!(pa[1] <= pa[0] + 0.005 && pa[2] <= pa[1] + 0.005), 'P2', section, `cadence ladder ${track} ${sqft}`, `perApp 6x/9x/12x = ${pa.join('/')} (higher cadence should not cost more per application)`);
    }
  }
  const bad = [
    { name: 'blank lawnSqFt (falls to lot-derived turf)', input: { ...BASE, lawnSqFt: undefined } },
    { name: 'zero lawnSqFt', input: { ...BASE, lawnSqFt: 0 } },
    { name: 'negative lawnSqFt', input: { ...BASE, lawnSqFt: -4500 } },
    { name: 'decimal lawnSqFt', input: { ...BASE, lawnSqFt: 4500.5 } },
    { name: 'huge lawnSqFt 1e7', input: { ...BASE, lawnSqFt: 1e7 } },
    { name: 'legacy lawnFreq 4 (retired basic)', input: { ...BASE }, lawnFreq: 4 },
    { name: 'unknown grass paspalum', input: { ...BASE }, track: 'paspalum' },
  ];
  for (const b of bad) {
    const r = runEngine({ ...b.input, services: { lawn: { track: b.track || 'st_augustine', tier: 'enhanced', ...(b.lawnFreq ? { lawnFreq: b.lawnFreq } : {}) } } });
    const li = line(r.result, 'lawn_care');
    record(section, `invalid: ${b.name}`, b.input, null, li ? li.perApp : null, { extra: { engineError: r.ok ? null : r.error, lawnSqFtUsed: li ? li.lawnSqFt : null, tier: li ? li.tier : null, review: li ? li.requiresManualReview : null, reasons: li ? li.manualReviewReasons : null, customQuote: li ? li.customQuoteFlag : null, basis: li ? li.pricingBasis : null } });
    if (li && li.perApp > 0 && !li.requiresManualReview && !li.customQuoteFlag && /zero|negative|huge|legacy/.test(b.name)) {
      findings.push({ severity: 'P2', section, name: `invalid input priced silently: ${b.name}`, detail: `perApp ${li.perApp} on lawnSqFt=${li.lawnSqFt}, tier ${li.tier}, no review flag` });
    }
  }
}

function runMosquitoMatrix() {
  const section = 'mosquito';
  // Category edges from the LIVE lot categories (DB overlay included): each band's
  // maxSqFt and the next band's first foot; 43,560 / 60,000 are extra samples (codex r15 P2).
  const edges = [...new Set(constants.MOSQUITO.lotCategories.filter((c) => Number.isFinite(c.maxSqFt)).flatMap((c) => [c.maxSqFt, c.maxSqFt + 1])), 43560, 60000].sort((a, b) => a - b);
  // choose lots so treatable lands near edges: treatable = lot - 2000 - hardscape(lot)
  const lots = new Set([3000, 5000, 8000, 10500, 12000, 15000, 20000, 25000, 35000, 40000, 45000, 60000, 90000]);
  for (const lot of [...lots].sort((a, b) => a - b)) {
    for (const program of ['seasonal9', 'monthly12']) {
      const exp = expectMosquito({ homeSqFt: 2000, lotSqFt: lot, program });
      const r = runEngine({ ...BASE, lotSqFt: lot, lawnSqFt: undefined, services: { mosquito: { tier: program } } });
      const li = line(r.result, 'mosquito');
      record(section, `lot ${lot} ${program}`, { lotSqFt: lot, program }, exp.perVisit, li ? li.perVisit : null, { extra: { treatableExpected: exp.treatable, treatableActual: li ? (li.mosquitoTreatableSqFt ?? li.treatableSqFt) : null, category: li ? li.lotCategory : null, annualExpected: exp.annual, annualActual: li ? li.annual : null } });
    }
  }
  // Add-ons: stations and dunks are annual charges folded into `annual` (and
  // therefore `monthly`), not `perVisit` — so these cases compare the totals
  // the customer pays, which the perVisit matrix above cannot see (codex r10 P2).
  for (const c of [{ stationCount: 2 }, { dunkCount: 5 }, { stationCount: 3, dunkCount: 10 }, { stationCount: 1.6 }, { stationCount: -2, dunkCount: 'x' }]) {
    for (const program of ['seasonal9', 'monthly12']) {
      const exp = expectMosquito({ homeSqFt: 2000, lotSqFt: 8000, program, ...c });
      const r = runEngine({ ...BASE, lotSqFt: 8000, lawnSqFt: undefined, services: { mosquito: { tier: program, ...c } } });
      const li = line(r.result, 'mosquito');
      const extra = { annualAddOnsExpected: exp.annualAddOns, annualAddOnsActual: li ? li.annualAddOns ?? li.addOns?.annualAddOns ?? null : null, perVisitExpected: exp.perVisit, perVisitActual: li ? li.perVisit : null, stationCountUsed: li ? li.stationCount ?? li.addOns?.stationCount ?? null : null, dunkCountUsed: li ? li.dunkCount ?? li.addOns?.dunkCount ?? null : null, warnings: li ? (li.warnings || []).slice(0, 3) : null, engineError: r.ok ? null : r.error };
      record(section, `add-ons ${JSON.stringify(c)} ${program} annual`, { lotSqFt: 8000, program, ...c }, exp.annual, li ? li.annual : null, { extra });
      record(section, `add-ons ${JSON.stringify(c)} ${program} monthly`, { lotSqFt: 8000, program, ...c }, exp.monthly, li ? li.monthly : null, { extra });
    }
  }
  // Category boundaries are defined on TREATABLE area (lot − footprint −
  // hardscape), so construct the lot that lands treatable at edge−1 / edge /
  // edge+1 instead of sampling lot sizes (codex r2 P2). Hardscape is a
  // rounded function of the lot, so a target can be unreachable by ±1 sf; that
  // is recorded as an engine-only observation rather than skipped.
  const lotForTreatable = (target) => {
    const fp = footprintOf(2000, 1);
    for (let lot = target + fp; lot <= target + fp + 20000; lot += 1) {
      const t = Math.max(0, lot - fp - hardscapeOf(lot, 'single_family', {}));
      if (t === target) return lot;
      if (t > target) return null;
    }
    return null;
  };
  for (const edge of edges.filter((e) => e < 43560)) {
    for (const delta of [-1, 0, 1]) {
      const target = edge + delta;
      const lot = lotForTreatable(target);
      if (lot === null) { record(section, `treatable ${target} unreachable by any integer lot (hardscape rounding)`, { treatableTarget: target }, null, null, { extra: { note: 'boundary cannot be hit exactly; neighbours cover it' } }); continue; }
      for (const program of ['seasonal9', 'monthly12']) {
        const exp = expectMosquito({ homeSqFt: 2000, lotSqFt: lot, program });
        const r = runEngine({ ...BASE, lotSqFt: lot, lawnSqFt: undefined, services: { mosquito: { tier: program } } });
        const li = line(r.result, 'mosquito');
        record(section, `treatable ${target} (lot ${lot}) ${program}`, { lotSqFt: lot, treatableTarget: target, program }, exp.perVisit, li ? li.perVisit : null, { extra: { treatableExpected: exp.treatable, treatableActual: li ? (li.mosquitoTreatableSqFt ?? li.treatableSqFt) : null, categoryExpected: exp.category, categoryActual: li ? li.lotCategory : null } });
        flagIf(exp.treatable !== target, 'P2', section, `treatable ${target} (lot ${lot})`, `independent treatable ${exp.treatable} missed the target`);
      }
    }
  }
  for (const features of [{ trees: 'heavy' }, { nearWater: true }, { pool: true }, { irrigation: true }, { trees: 'heavy', complexity: 'complex', nearWater: true, pool: true, irrigation: true }]) {
    const exp = expectMosquito({ homeSqFt: 2000, lotSqFt: 8000, features, program: 'seasonal9' });
    const r = runEngine({ ...BASE, lawnSqFt: undefined, features, services: { mosquito: { tier: 'seasonal9' } } });
    const li = line(r.result, 'mosquito');
    record(section, `features ${JSON.stringify(features)}`, features, exp.perVisit, li ? li.perVisit : null, { extra: { pressureExpected: exp.pressure, pressureActual: li ? li.pressureMultiplier ?? li.pressure : null } });
  }
  // Property-level water proximity (codex r25 P2): modifiers.js derives a
  // distinct multiplier per level (ADJACENT 1.35 / CLOSE 1.20 / NEAR 1.10 /
  // MODERATE 1.05 / DISTANT 1.02 / NONE 1); the level string travels on the
  // INPUT (`nearWater`, property-calculator.js:678), not in `features`. Both
  // the multiplier and the price are compared for every level.
  for (const level of ['ADJACENT', 'CLOSE', 'NEAR', 'MODERATE', 'DISTANT', 'NONE']) {
    const exp = expectMosquito({ homeSqFt: 2000, lotSqFt: 8000, features: { nearWater: level }, program: 'seasonal9' });
    const r = runEngine({ ...BASE, lawnSqFt: undefined, nearWater: level, services: { mosquito: { tier: 'seasonal9' } } });
    const li = line(r.result, 'mosquito');
    const pressureActual = li ? (li.pressureMultiplier ?? li.pressure ?? null) : null;
    record(section, `water proximity ${level} perVisit`, { nearWater: level }, exp.perVisit, li ? li.perVisit : null, { extra: { pressureExpected: exp.pressure, pressureActual, engineError: r.ok ? null : r.error } });
    record(section, `water proximity ${level} pressure multiplier`, { nearWater: level }, exp.pressure, pressureActual === null ? null : round2(pressureActual), { tolerance: 0.005 });
  }
  // Every hardscape curve and pool addition (codex r21 P2): the residential
  // curves price through expectMosquito against the engine's perVisit; a
  // commercial property routes to the commercial mosquito pricer (its own
  // section), so only its treatable area — the part the hardscape curve
  // decides — is asserted for it. Lots 6,000 / 8,000 / 20,000 sit below, inside
  // and beyond the 7,500 / 15,000 breakpoints.
  for (const propertyType of ['single_family', 'townhome', 'duplex', 'condo', 'condo_ground', 'commercial']) {
    for (const features of [{}, { pool: true }, { poolCage: true }]) {
      for (const lot of [6000, 8000, 20000]) {
        const exp = expectMosquito({ homeSqFt: 2000, lotSqFt: lot, propertyType, features, program: 'seasonal9' });
        const r = runEngine({ ...BASE, propertyType, lotSqFt: lot, lawnSqFt: undefined, features, services: { mosquito: { tier: 'seasonal9' } } });
        const li = line(r.result, 'mosquito') || line(r.result, 'commercial_mosquito');
        const treatableActual = li ? (li.mosquitoTreatableSqFt ?? li.treatableSqFt ?? null) : null;
        const name = `hardscape curve ${propertyType} ${JSON.stringify(features)} lot ${lot}`;
        const input = { propertyType, lotSqFt: lot, features };
        // The treatable area is compared DIRECTLY for every property type: a
        // one-square-foot curve regression rarely moves the rounded price, so
        // the perVisit row alone would stay green through it (codex r22 P2).
        record(section, `${name} treatable`, input, exp.treatable, treatableActual, { extra: { hardscapeExpected: exp.hardscape, service: li ? li.service : null, engineError: r.ok ? null : r.error } });
        if (propertyType !== 'commercial') record(section, name, input, exp.perVisit, li ? li.perVisit : null, { extra: { hardscapeExpected: exp.hardscape, treatableExpected: exp.treatable, treatableActual, engineError: r.ok ? null : r.error } });
      }
    }
  }
  const bad = [
    { name: 'zero lot', input: { ...BASE, lotSqFt: 0, lawnSqFt: undefined } },
    { name: 'negative lot', input: { ...BASE, lotSqFt: -8000, lawnSqFt: undefined } },
    { name: 'missing lot', input: { ...BASE, lotSqFt: undefined, lawnSqFt: undefined } },
    { name: 'lot smaller than footprint', input: { ...BASE, lotSqFt: 1500, lawnSqFt: undefined } },
  ];
  for (const b of bad) {
    const r = runEngine({ ...b.input, services: { mosquito: { tier: 'seasonal9' } } });
    const li = line(r.result, 'mosquito');
    record(section, `invalid: ${b.name}`, b.input, null, li ? li.perVisit : null, { extra: { engineError: r.ok ? null : r.error, category: li ? li.lotCategory : null, review: li ? li.requiresManualReview : null, reasons: li ? li.manualReviewReasons : null } });
  }
}

function runRodentMatrix() {
  const section = 'rodent_bait';
  // Bracket edges from the LIVE baitBrackets array plus the first two extension
  // steps above the top bracket (codex r15 P2).
  const R = constants.RODENT;
  const edges = R.baitBrackets.map((b) => b.maxSqFt);
  const top = edges[edges.length - 1];
  const sizes = new Set([600, ...edges, ...edges.map((e) => e - 1), ...edges.map((e) => e + 1), top + R.baitBracketExtension.perSqFt, top + 2 * R.baitBracketExtension.perSqFt, 12000]);
  for (const sqft of [...sizes].sort((a, b) => a - b)) {
    const exp = expectRodentBait({ homeSqFt: sqft });
    const r = runEngine({ ...BASE, homeSqFt: sqft, services: { rodentBait: {} } });
    const li = line(r.result, 'rodent_bait');
    record(section, `footprint ${sqft}`, { homeSqFt: sqft }, exp.perVisit, li ? li.perVisit : null, { extra: { stationsExpected: exp.stations, stationsActual: li ? li.stations : null, annualExpected: exp.annual, annualActual: li ? li.annual : null } });
  }
  // setup fee: standalone vs bundled with a qualifying service
  const solo = runEngine({ ...BASE, services: { rodentBait: {} } }).result;
  const bundled = runEngine({ ...BASE, services: { rodentBait: {}, pest: { frequency: 'quarterly' } } }).result;
  record(section, 'setup fee standalone', {}, constants.RODENT.baitSetupFee, solo.summary.rodentBaitSetupTotal);
  // FROZEN literal (codex r26 P2): the line above moves with RODENT.baitSetupFee;
  // this one pins the $99 standalone charge independently of the constant.
  record(section, 'setup fee standalone (frozen $99)', {}, 99, solo.summary.rodentBaitSetupTotal);
  record(section, 'setup fee bundled with pest (waived)', {}, 0, bundled.summary.rodentBaitSetupTotal);
  for (const b of [{ name: 'zero homeSqFt', homeSqFt: 0 }, { name: 'negative homeSqFt', homeSqFt: -2000 }, { name: 'missing homeSqFt', homeSqFt: undefined }]) {
    const r = runEngine({ ...BASE, homeSqFt: b.homeSqFt, services: { rodentBait: {} } });
    const li = line(r.result, 'rodent_bait');
    record(section, `invalid: ${b.name}`, { homeSqFt: b.homeSqFt }, null, li ? li.perVisit : null, { extra: { footprintUsed: li ? li.footprintUsed : null, stations: li ? li.stations : null, review: li ? li.requiresManualReview : null } });
    if (li && li.perVisit > 0 && !li.requiresManualReview) findings.push({ severity: 'P2', section, name: `invalid input priced silently: ${b.name}`, detail: `rodent bait priced ${li.perVisit}/visit on footprint ${li.footprintUsed} with no review flag` });
  }
}

function runTermiteMatrix() {
  const section = 'termite_bait';
  // Every system the live constants can price (codex r16 P2): the menu default
  // (Trelona, 15 ft) AND the legacy Advance system (10 ft, its own station cost),
  // which an existing estimate's replayable input still requests — the engine must
  // honour the requested system, never silently reprice it at the default.
  const systems = Object.keys(constants.TERMITE.systems);
  for (const system of systems) {
    const tag = system === constants.TERMITE.defaultSystem ? '' : ` [${system} replay]`;
    for (const sqft of [800, 1200, 1600, 2000, 2500, 3200, 4000, 6000]) {
      const exp = expectTermiteBait({ homeSqFt: sqft, system });
      const r = runEngine({ ...BASE, homeSqFt: sqft, services: { termite: { system } } });
      const li = line(r.result, 'termite_bait');
      const install = li ? (li.installation?.price ?? li.installPrice ?? null) : null;
      const monthly = li ? (li.monitoring?.monthly ?? li.monthly ?? null) : null;
      record(section, `install footprint ${sqft}${tag}`, { homeSqFt: sqft, system }, exp.installPrice, install, { extra: { system: li ? li.selectedSystem ?? li.system ?? null : null, requestedSystem: li ? li.requestedSystem ?? null : null, spacingFt: exp.spacingFt, stationsExpected: exp.stations, stationsActual: li ? (li.stations ?? li.stationCount) : null, perimeterExpected: exp.perimeter, installMarkupOnMaterialOnly: exp.installMarkupOnMaterial, installLaborNotBilled: exp.installLabor } });
      record(section, `monitoring monthly footprint ${sqft}${tag}`, { homeSqFt: sqft, system }, exp.monitoringMonthly, monthly);
      flagIf(!!li && (li.selectedSystem ?? li.system) !== system, 'P1', section, `requested system honoured ${sqft}${tag}`, `requested ${system}, engine priced ${li ? (li.selectedSystem ?? li.system) : 'nothing'}`);
    }
  }
  // Layout complexity (codex r17 P2): moderate and complex both take
  // TERMITE.perimeterMultiplier.complex (more perimeter → more stations → higher
  // install and a higher monitoring bracket), requested on the service line
  // (services.termite.complexity) OR read from the property feature
  // (features.complexity) the estimator's real inputs carry; a service-line
  // 'standard' overrides a complex property feature.
  const complexityCases = [
    { name: 'services.termite.complexity=moderate', complexity: 'moderate', input: (sqft) => ({ ...BASE, homeSqFt: sqft, services: { termite: { system: 'trelona', complexity: 'moderate' } } }) },
    { name: 'services.termite.complexity=complex', complexity: 'complex', input: (sqft) => ({ ...BASE, homeSqFt: sqft, services: { termite: { system: 'trelona', complexity: 'complex' } } }) },
    { name: 'features.complexity=complex (property fallback)', complexity: 'complex', input: (sqft) => ({ ...BASE, homeSqFt: sqft, features: { complexity: 'complex' }, services: { termite: { system: 'trelona' } } }) },
    { name: 'features.complexity=complex overridden by services.termite.complexity=standard', complexity: 'standard', input: (sqft) => ({ ...BASE, homeSqFt: sqft, features: { complexity: 'complex' }, services: { termite: { system: 'trelona', complexity: 'standard' } } }) },
  ];
  for (const cc of complexityCases) {
    for (const sqft of [1200, 2000, 3200]) {
      const exp = expectTermiteBait({ homeSqFt: sqft, complexity: cc.complexity });
      const r = runEngine(cc.input(sqft));
      const li = line(r.result, 'termite_bait');
      record(section, `install footprint ${sqft} [${cc.name}]`, { homeSqFt: sqft, complexity: cc.complexity }, exp.installPrice, li ? (li.installation?.price ?? li.installPrice ?? null) : null, { extra: { complexityExpected: cc.complexity, complexityActual: li ? li.complexity ?? null : null, perimeterMultiplier: exp.perimMult, perimeterExpected: exp.perimeter, perimeterActual: li ? li.perimeter ?? null : null, stationsExpected: exp.stations, stationsActual: li ? (li.stations ?? li.stationCount) : null } });
      record(section, `monitoring monthly footprint ${sqft} [${cc.name}]`, { homeSqFt: sqft, complexity: cc.complexity }, exp.monitoringMonthly, li ? (li.monitoring?.monthly ?? li.monthly ?? null) : null);
      flagIf(!!li && li.complexity !== cc.complexity, 'P1', section, `complexity resolved ${sqft} [${cc.name}]`, `expected ${cc.complexity}, engine resolved ${li.complexity}`);
    }
  }
  // Property-driven install modifiers (codex r19 P2): the construction
  // multiplier and foundation adjustment come from the top-level property
  // profile (deriveModifiers on constructionMaterial / foundationType), never
  // from the service line — a service-line `modifiers` object must be ignored.
  // Each recognised value, lower-case spellings, an unrecognised pair (neutral)
  // and a lone foundation; monitoring is asserted unchanged from the neutral
  // install for every case.
  const modifierCases = [
    { constructionMaterial: 'WOOD_FRAME', foundationType: 'SLAB' },
    { constructionMaterial: 'wood_frame', foundationType: 'crawlspace' },
    { constructionMaterial: 'STEEL_FRAME', foundationType: 'RAISED' },
    { constructionMaterial: 'ICF', foundationType: 'PIER_AND_BEAM' },
    { constructionMaterial: 'BLOCK', foundationType: 'CRAWLSPACE' },
    { constructionMaterial: 'CMU', foundationType: 'SLAB' },
    { constructionMaterial: 'CONCRETE', foundationType: null },
    { constructionMaterial: 'BRICK', foundationType: 'BASEMENT' },
    { constructionMaterial: null, foundationType: 'PIER_AND_BEAM' },
  ];
  for (const mc of modifierCases) {
    const label = `${mc.constructionMaterial ?? 'none'} / ${mc.foundationType ?? 'none'}`;
    for (const sqft of [1200, 2000, 3200]) {
      const neutral = expectTermiteBait({ homeSqFt: sqft });
      const exp = expectTermiteBait({ homeSqFt: sqft, ...mc });
      const r = runEngine({ ...BASE, homeSqFt: sqft, constructionMaterial: mc.constructionMaterial, foundationType: mc.foundationType, services: { termite: { system: 'trelona' } } });
      const li = line(r.result, 'termite_bait');
      record(section, `install footprint ${sqft} [property ${label}]`, { homeSqFt: sqft, ...mc }, exp.installPrice, li ? (li.installation?.price ?? li.installPrice ?? null) : null, { extra: { constructionMult: exp.constructionMult, foundationAdj: exp.foundationAdj, neutralInstall: neutral.installPrice, stationsExpected: exp.stations, stationsActual: li ? (li.stations ?? li.stationCount) : null, engineError: r.ok ? null : r.error } });
      record(section, `monitoring monthly footprint ${sqft} [property ${label} — unchanged]`, { homeSqFt: sqft, ...mc }, neutral.monitoringMonthly, li ? (li.monitoring?.monthly ?? li.monthly ?? null) : null);
    }
  }
  {
    // A modifiers object on the service line must not reach the pricer: the
    // engine derives modifiers from the property and overrides the option.
    const neutral = expectTermiteBait({ homeSqFt: 2000 });
    const r = runEngine({ ...BASE, homeSqFt: 2000, services: { termite: { system: 'trelona', modifiers: { termiteConstructionMult: 2, termiteFoundationAdj: 999 } } } });
    const li = line(r.result, 'termite_bait');
    record(section, 'install footprint 2000 [service-line modifiers object ignored — property neutral]', { homeSqFt: 2000, serviceLineModifiers: { termiteConstructionMult: 2, termiteFoundationAdj: 999 } }, neutral.installPrice, li ? (li.installation?.price ?? li.installPrice ?? null) : null, { extra: { engineError: r.ok ? null : r.error } });
  }
}

function runOneTimeMatrix() {
  const section = 'one_time_pest';
  for (const sqft of [800, 1200, 1500, 2000, 2500, 3000, 4000, 5500]) {
    for (const rc of [false, true]) {
      const exp = expectOneTimePest({ homeSqFt: sqft, isRecurringCustomer: rc });
      const r = runEngine({ ...BASE, homeSqFt: sqft, recurringCustomer: rc, isRecurringCustomer: rc, services: { oneTimePest: {} } });
      const li = line(r.result, 'one_time_pest');
      record(section, `footprint ${sqft} recurringCustomer=${rc}`, { homeSqFt: sqft, rc }, exp.price, li ? li.price : null, { extra: { visitOne: exp.visitOne, clamped: exp.clamped } });
    }
  }
  for (const [urgency, afterHours] of [['SOON', false], ['SOON', true], ['URGENT', false], ['URGENT', true]]) {
    const exp = expectOneTimePest({ homeSqFt: 2000, urgency, afterHours });
    const r = runEngine({ ...BASE, services: { oneTimePest: { urgency, afterHours } } });
    const li = line(r.result, 'one_time_pest');
    record(section, `urgency ${urgency} afterHours=${afterHours}`, { urgency, afterHours }, exp.price, li ? li.price : null);
  }
  // stand-alone vs paired with recurring pest (hypothesis #1)
  const solo = line(runEngine({ ...BASE, services: { oneTimePest: {} } }).result, 'one_time_pest');
  const paired = line(runEngine({ ...BASE, services: { oneTimePest: {}, pest: { frequency: 'quarterly' } } }).result, 'one_time_pest');
  scenarios.push({ section, name: 'stand-alone vs paired with recurring pest (same visit)', expected: null, actual: null, status: 'engine_only', extra: { standalone: solo.price, paired: paired.price, pairedAfterDiscount: paired.priceAfterDiscount ?? null } });
}

function runTreeShrubMatrix() {
  const section = 'tree_shrub';
  const cases = [
    { bedArea: 500, treeCount: 0, palmCount: 0 }, { bedArea: 1000, treeCount: 3 }, { bedArea: 2000, treeCount: 6 }, { bedArea: 2000, treeCount: 6, palmCount: 4 },
    { bedArea: 2000, treeCount: 6, palmCount: 30 }, { bedArea: 4000, treeCount: 10, access: 'difficult' }, { bedArea: 7999, treeCount: 14 }, { bedArea: 8000, treeCount: 15 }, { bedArea: 8001, treeCount: 16 },
    { bedArea: 14000, treeCount: 20 }, { bedArea: 2000, treeCount: 0, palmCount: 200 }, { bedArea: 2000, treeCount: 0, palmCount: 201 },
  ];
  for (const c of cases) {
    for (const tier of ['light', 'standard', 'enhanced']) {
      const exp = expectTreeShrub({ ...c, tier, palmCount: Math.min(200, c.palmCount || 0) });
      const r = runEngine({ ...BASE, bedArea: c.bedArea, services: { treeShrub: { tier, treeCount: c.treeCount ?? 0, ...(c.palmCount ? { palmCount: c.palmCount } : {}), access: c.access || 'easy' } } });
      const li = line(r.result, 'tree_shrub');
      record(section, `${JSON.stringify(c)} ${tier}`, { ...c, tier }, exp.monthly, li ? li.monthly : null, { extra: { onSiteMinExpected: exp.onSiteMin, onSiteMinActual: li ? li.onSiteMin : null, palmCountUsed: li ? li.palmCount : null, palmCountSource: li ? li.palmCountSource : null, review: li ? li.requiresManualReview : null, reasons: li ? li.manualReviewReasons : null, warnings: li ? (li.warnings || []).slice(0, 3) : null, engineError: r.ok ? null : r.error } });
    }
  }
  // Palm count contribution audit: does adding palms change price in the shipped config?
  const noPalm = line(runEngine({ ...BASE, bedArea: 2000, services: { treeShrub: { tier: 'standard', treeCount: 6 } } }).result, 'tree_shrub');
  const withPalms = line(runEngine({ ...BASE, bedArea: 2000, palmCount: 30, services: { treeShrub: { tier: 'standard', treeCount: 6 } } }).result, 'tree_shrub');
  const withPalmsServiceLine = line(runEngine({ ...BASE, bedArea: 2000, services: { treeShrub: { tier: 'standard', treeCount: 6, palmCount: 30 } } }).result, 'tree_shrub');
  scenarios.push({ section, name: 'palm count contribution (30 palms): property-level vs service-line', expected: null, actual: null, status: 'engine_only', extra: { monthlyNoPalms: noPalm.monthly, monthlyPropertyPalms: withPalms.monthly, monthlyServiceLinePalms: withPalmsServiceLine.monthly, propertyPalmSource: withPalms.palmCountSource, serviceLinePalmSource: withPalmsServiceLine.palmCountSource } });
  // Property-only palms retain historical quote replay. The current admin
  // translator sends an explicit service-line count, verified against the
  // independent modern reserve formula here.
  const expectedServicePalms = expectTreeShrub({ tier: 'standard', bedArea: 2000, treeCount: 6, palmCount: 30 }).monthly;
  flagIf(withPalms.monthly !== noPalm.monthly || withPalmsServiceLine.monthly !== expectedServicePalms, 'P1', section, 'legacy palm replay and explicit service-line palm reserve', `Legacy property-only ${withPalms.monthly}/mo; baseline ${noPalm.monthly}/mo; service-line ${withPalmsServiceLine.monthly}/mo; expected service-line ${expectedServicePalms}/mo`);
  // missing bed area / tree count fallbacks
  const noBed = line(runEngine({ ...BASE, lotSqFt: undefined, services: { treeShrub: { tier: 'standard' } } }).result, 'tree_shrub');
  scenarios.push({ section, name: 'no bed area and no lot: fallback', expected: null, actual: noBed ? noBed.monthly : null, status: 'engine_only', extra: { bedArea: noBed?.bedArea, bedAreaSource: noBed?.bedAreaSource, treeCount: noBed?.treeCount, treeCountSource: noBed?.treeCountSource, review: noBed?.requiresManualReview, reasons: noBed?.manualReviewReasons } });
  const zeroTrees = line(runEngine({ ...BASE, bedArea: 2000, treeDensity: 'heavy', features: { treeCount: 0 }, services: { treeShrub: { tier: 'standard' } } }).result, 'tree_shrub');
  const densityTrees = line(runEngine({ ...BASE, bedArea: 2000, treeDensity: 'heavy', services: { treeShrub: { tier: 'standard' } } }).result, 'tree_shrub');
  scenarios.push({ section, name: 'explicit treeCount 0 vs absent with heavy density', expected: null, actual: null, status: 'engine_only', extra: { explicitZero: { monthly: zeroTrees?.monthly, treeCount: zeroTrees?.treeCount, source: zeroTrees?.treeCountSource, review: zeroTrees?.requiresManualReview }, absent: { monthly: densityTrees?.monthly, treeCount: densityTrees?.treeCount, source: densityTrees?.treeCountSource } } });
  flagIf(zeroTrees && densityTrees && zeroTrees.monthly < densityTrees.monthly && !zeroTrees.requiresManualReview, 'P2', section, 'explicit treeCount=0 suppresses density fallback without review', `0 trees → ${zeroTrees.monthly}/mo vs density-estimated ${densityTrees.treeCount} trees → ${densityTrees.monthly}/mo`);
}

function runSpecialtyMatrix() {
  const section = 'specialty';
  // WDO (codex r19 P2): boundary footprints are DERIVED from the live bracket
  // array — BASE, every finite edge and edge + 1, and a footprint past the last
  // finite edge — so a tiered --db overlay exercises each band and the in-code
  // single-bracket run still prices the flat fee. The resolved footprint
  // (living area / stories) is asserted alongside the price.
  const wdoBrackets = constants.SPECIALTY.wdo.brackets;
  const wdoEdges = wdoBrackets.map((b) => b.maxSqFt).filter((m) => Number.isFinite(m));
  const wdoFootprints = [...new Set([BASE.homeSqFt, ...wdoEdges.flatMap((m) => [m, m + 1]), (wdoEdges.length ? Math.max(...wdoEdges) : 3500) + 1000])].sort((a, b) => a - b);
  for (const sqft of wdoFootprints) {
    const exp = expectWdo(sqft);
    const li = line(runEngine({ ...BASE, homeSqFt: sqft, services: { wdo: {} } }).result, 'wdo_inspection');
    record(section, `WDO footprint ${sqft} (bracket ≤ ${exp.bracketMaxSqFt}; ${exp.bracketsLive} live bracket${exp.bracketsLive === 1 ? '' : 's'})`, { homeSqFt: sqft }, exp.price, li ? li.price : null, { extra: { footprintUsed: li ? li.footprintUsed : null, bracketLabel: li ? li.bracketLabel : null } });
    flagIf(!!li && li.footprintUsed !== exp.footprint, 'P1', section, `WDO footprint resolved ${sqft}`, `expected footprint ${exp.footprint}, engine used ${li && li.footprintUsed}`);
  }
  {
    // living area / stories selects the bracket — not the living area itself
    const exp = expectWdo(4000, 2);
    const li = line(runEngine({ ...BASE, homeSqFt: 4000, stories: 2, services: { wdo: {} } }).result, 'wdo_inspection');
    record(section, 'WDO 4,000 sf living area on 2 stories (footprint 2,000)', { homeSqFt: 4000, stories: 2 }, exp.price, li ? li.price : null, { extra: { footprintUsed: li ? li.footprintUsed : null, bracketLabel: li ? li.bracketLabel : null } });
    flagIf(!!li && li.footprintUsed !== exp.footprint, 'P1', section, 'WDO footprint resolved 4,000 sf / 2 stories', `expected footprint ${exp.footprint}, engine used ${li && li.footprintUsed}`);
  }
  for (const sev of ['light', 'moderate', 'heavy', 'severe', 'bogus', undefined]) {
    const exp = expectGermanRoach(sev);
    const li = line(runEngine({ ...BASE, services: { germanRoach: { severity: sev } } }).result, 'german_roach');
    record(section, `german roach severity=${sev}`, { severity: sev }, exp.price, li ? li.price : null, { extra: { defaulted: li ? li.severityWasDefaulted : null, visits: li ? li.visits : null } });
    flagIf(li && li.severityWasDefaulted && !(li.requiresManualReview || (li.warnings || []).length), 'P2', section, `german roach severity defaulted (${sev}) to cheapest tier silently`, `price ${li.price} (${li.severity})`);
  }
  for (const points of [1, 5, 6, 10, 11, 15, 16, 20, 25]) {
    const exp = expectFoamDrill(points);
    const li = line(runEngine({ ...BASE, services: { foam: { points } } }).result, 'foam_drill');
    record(section, `foam drill points=${points}`, { points }, exp.price, li ? li.price : null, { extra: { cost: exp.cost, targetMargin: exp.targetMargin, realizedMargin: exp.realizedMargin, refusedOverMaxPoints: !!exp.refusedOverMaxPoints } });
    flagIf(exp.refusedOverMaxPoints && li, 'P1', section, `foam drill points=${points} priced above the ${exp.maxPoints}-point ceiling`, `engine price ${li && li.price} — expected a refusal`);
  }
  // Foam drill urgency / after-hours multipliers (codex r26 P2): the same matrix
  // one-time pest runs; the engine forwards services.foam.urgency / afterHours to
  // priceFoamDrill (estimate-engine.js:1613-1616).
  for (const points of [5, 12]) {
    for (const [urgency, afterHours] of [['ROUTINE', false], ['SOON', false], ['SOON', true], ['URGENT', false], ['URGENT', true]]) {
      const exp = expectFoamDrill(points, urgency, afterHours);
      const li = line(runEngine({ ...BASE, services: { foam: { points, urgency, afterHours } } }).result, 'foam_drill');
      record(section, `foam drill points=${points} urgency=${urgency} afterHours=${afterHours}`, { points, urgency, afterHours }, exp.price, li ? li.price : null, { extra: { multiplier: li ? li.urgencyMultiplier ?? li.multiplier ?? null : null } });
    }
  }
  // Top dressing (codex r19 P2): the engine's only explicit area input is
  // services.topDressing.lawnSqFt — priced in full, exactly as entered;
  // otherwise the property lawn area prices in full when a recurring lawn line
  // is in the same estimate and at the 65% treatable assumption when it is
  // not. `area` is not an engine input (one case proves it is inert). The
  // priced area is asserted as well as the price: the floor hides a
  // 0.65-vs-full difference on small lawns.
  const LAWN_LINE = { track: 'st_augustine', tier: 'enhanced' };
  const topDressingCases = [
    ...[1000, 2000, 4500, 8000, 12000].flatMap((sqft) => ['eighth', 'quarter'].map((depth) => ({ name: `top dressing ${sqft}sf ${depth} (no recurring lawn → 65% treatable assumption)`, sqft, depth, area: sqft, full: false, input: { ...BASE, lawnSqFt: sqft, services: { topDressing: { depth } } } }))),
    ...[1000, 4500, 8000].flatMap((sqft) => ['eighth', 'quarter'].map((depth) => ({ name: `top dressing ${sqft}sf ${depth} bundled with recurring lawn (full property area)`, sqft, depth, area: sqft, full: true, input: { ...BASE, lawnSqFt: sqft, services: { lawn: LAWN_LINE, topDressing: { depth } } } }))),
    ...[[1500, 4500], [3000, 4500], [6000, 4500]].flatMap(([explicit, prop]) => ['eighth', 'quarter'].map((depth) => ({ name: `top dressing explicit ${explicit}sf ${depth} on a ${prop}sf lawn (full explicit area)`, sqft: explicit, depth, area: explicit, full: true, input: { ...BASE, lawnSqFt: prop, services: { topDressing: { depth, lawnSqFt: explicit } } } }))),
    { name: 'top dressing explicit 2000sf eighth + recurring lawn (explicit area wins, full)', sqft: 2000, depth: 'eighth', area: 2000, full: true, input: { ...BASE, lawnSqFt: 4500, services: { lawn: LAWN_LINE, topDressing: { depth: 'eighth', lawnSqFt: 2000 } } } },
    { name: 'top dressing explicit 0 sf eighth falls back to the property lawn at 65%', sqft: 4500, depth: 'eighth', area: 4500, full: false, input: { ...BASE, lawnSqFt: 4500, services: { topDressing: { depth: 'eighth', lawnSqFt: 0 } } } },
    { name: 'top dressing legacy area key is not an engine input (property lawn at 65%)', sqft: 4500, depth: 'quarter', area: 4500, full: false, input: { ...BASE, lawnSqFt: 4500, services: { topDressing: { depth: 'quarter', area: 1000 } } } },
  ];
  for (const tc of topDressingCases) {
    const exp = expectTopDressing(tc.area, tc.depth, tc.full);
    const li = line(runEngine(tc.input).result, 'top_dressing');
    record(section, tc.name, { sqft: tc.sqft, depth: tc.depth, fullArea: tc.full }, exp.price, li ? li.price : null, { extra: { lawnEstExpected: exp.lawnEst, lawnEstActual: li ? li.lawnSqFt : null, material: exp.material, labor: exp.labor, detail: li ? li.detail ?? null : null } });
    flagIf(!!li && li.lawnSqFt !== exp.lawnEst, 'P1', section, `top dressing priced area — ${tc.name}`, `expected ${exp.lawnEst} sf, engine priced ${li && li.lawnSqFt} sf`);
  }
  for (const sqft of [1000, 4500, 10000]) for (const spacing of [6, 9, 12]) {
    const exp = expectPlugging(sqft, spacing);
    const li = line(runEngine({ ...BASE, lawnSqFt: sqft, services: { plugging: { area: sqft, spacing } } }).result, 'plugging');
    record(section, `plugging ${sqft}sf ${spacing}in`, { sqft, spacing }, exp.price, li ? li.price : null, { extra: { plugs: exp.plugs, cost: exp.cost } });
  }
  // Plugging urgency / after-hours ladder (codex r30 P2): estimate-engine.js
  // forwards services.plugging.urgency / afterHours and pricePlugging applies
  // 1.25–2× after the floor — a dropped forward or multiplier must surface.
  for (const [urgency, afterHours] of [['SOON', false], ['SOON', true], ['URGENT', false], ['URGENT', true]]) {
    const exp = expectPlugging(4500, 12, urgency, afterHours);
    const li = line(runEngine({ ...BASE, lawnSqFt: 4500, services: { plugging: { area: 4500, spacing: 12, urgency, afterHours } } }).result, 'plugging');
    record(section, `plugging 4500sf 12in urgency=${urgency} afterHours=${afterHours}`, { sqft: 4500, spacing: 12, urgency, afterHours }, exp.price, li ? li.price : null, { extra: { plugs: exp.plugs, cost: exp.cost, urgencyMult: exp.urgencyMult } });
  }
  // Palm injection
  const palmCases = [{ treatmentType: 'nutrition', palmCount: 1 }, { treatmentType: 'nutrition', palmCount: 2 }, { treatmentType: 'nutrition', palmCount: 3 }, { treatmentType: 'insecticide', palmCount: 5, palmSize: 'large' }, { treatmentType: 'combo', palmCount: 10, palmSize: 'small' }, { treatmentType: 'nutrition', palmCount: 0 }, { treatmentType: 'nutrition', palmCount: -2 }, { treatmentType: 'nutrition', palmCount: 2.5 }, { treatmentType: 'combo', palmCount: 3 },
    // fungal: floor, custom above / below the floor, interval-derived apps, refusals (codex r14 P2)
    { treatmentType: 'fungal', palmCount: 2, diagnosisConfirmed: true, selectedProduct: 'PHOSPHO-Jet', appsPerYear: 2 },
    { treatmentType: 'fungal', palmCount: 2, diagnosisConfirmed: true, selectedProduct: 'Propizol', appsPerYear: 2, customPricePerPalm: 80 },
    { treatmentType: 'fungal', palmCount: 3, diagnosisConfirmed: true, selectedProduct: 'Propizol', appsPerYear: 3, customPricePerPalm: 20 },
    { treatmentType: 'fungal', palmCount: 1, diagnosisConfirmed: true, selectedProduct: 'PHOSPHO-Jet', intervalMonths: 4 },
    { treatmentType: 'fungal', palmCount: 2, diagnosisConfirmed: false, selectedProduct: 'PHOSPHO-Jet', appsPerYear: 2 },
    { treatmentType: 'fungal', palmCount: 2, diagnosisConfirmed: true, selectedProduct: 'PHOSPHO-Jet' },
    // fungal cadence validation (codex r29 P2): zero, negative, non-finite and
    // string cadences are refused by assertPositiveNumber — expect NO price.
    { treatmentType: 'fungal', palmCount: 2, diagnosisConfirmed: true, selectedProduct: 'PHOSPHO-Jet', appsPerYear: 0, _refusal: /appsPerYear/ },
    { treatmentType: 'fungal', palmCount: 2, diagnosisConfirmed: true, selectedProduct: 'PHOSPHO-Jet', appsPerYear: -2, _refusal: /appsPerYear/ },
    { treatmentType: 'fungal', palmCount: 2, diagnosisConfirmed: true, selectedProduct: 'PHOSPHO-Jet', appsPerYear: Infinity, _refusal: /appsPerYear/ },
    { treatmentType: 'fungal', palmCount: 2, diagnosisConfirmed: true, selectedProduct: 'PHOSPHO-Jet', appsPerYear: '2', _refusal: /appsPerYear/ },
    { treatmentType: 'fungal', palmCount: 1, diagnosisConfirmed: true, selectedProduct: 'PHOSPHO-Jet', intervalMonths: 0, _refusal: /intervalMonths/ },
    { treatmentType: 'fungal', palmCount: 1, diagnosisConfirmed: true, selectedProduct: 'PHOSPHO-Jet', intervalMonths: '4', _refusal: /intervalMonths/ },
    // lethal bronzing: each eligible status, custom above / below the floor, an ineligible status
    { treatmentType: 'lethalBronzing', palmCount: 1, palmStatus: 'healthy_preventive' },
    { treatmentType: 'lethalBronzing', palmCount: 4, palmStatus: 'near_infected', customPricePerPalm: 150 },
    { treatmentType: 'lethalBronzing', palmCount: 2, palmStatus: 'tested_negative_preventive', customPricePerPalm: 100 },
    { treatmentType: 'lethalBronzing', palmCount: 2, palmStatus: 'symptomatic' },
    // Tree-Age: every DBH tier edge ±1, custom above the last priced tier, quote-only without a custom price
    ...[9, 10, 11, 15, 16, 20].map((dbhInches) => ({ treatmentType: 'treeAge', palmCount: 1, dbhInches })),
    { treatmentType: 'treeAge', palmCount: 3, dbhInches: 12, customPricePerPalm: 40 },
    { treatmentType: 'treeAge', palmCount: 2, dbhInches: 25, customPricePerPalm: 200 },
    { treatmentType: 'treeAge', palmCount: 2, dbhInches: 25 },
    // tiered quote overrides (codex r15 P2): each flag, missing / below-floor / above-floor custom price
    { treatmentType: 'insecticide', palmCount: 2, palmSize: 'large', highDose: true },
    { treatmentType: 'insecticide', palmCount: 2, palmSize: 'large', highDose: true, customPricePerPalm: 50 },
    { treatmentType: 'insecticide', palmCount: 2, palmSize: 'large', highDose: true, customPricePerPalm: 120 },
    { treatmentType: 'combo', palmCount: 3, palmSize: 'small', largeDiameter: true, customPricePerPalm: 40 },
    { treatmentType: 'combo', palmCount: 3, palmSize: 'small', largeDiameter: true, customPricePerPalm: 90 },
    { treatmentType: 'combo', palmCount: 1, palmSize: 'medium', nonstandardProduct: true },
    { treatmentType: 'combo', palmCount: 1, palmSize: 'medium', nonstandardProduct: true, customPricePerPalm: 130 },
    { treatmentType: 'insecticide', palmCount: 4, palmSize: 'medium', nonstandardProduct: true, customPricePerPalm: 30 },
    // Tree-Age restricted-use licence (codex r19 P2): refused without
    // licensedApplicator === true (the engine error must name the licence, so
    // a refusal for another reason cannot pass as this one), priced with it,
    // strict on a truthy non-boolean, unaffected by a non-restricted product name.
    { treatmentType: 'treeAge', palmCount: 1, dbhInches: 12, product: 'Tree-Age R10', _refusal: /licensedApplicator/ },
    { treatmentType: 'treeAge', palmCount: 1, dbhInches: 12, product: 'Tree-Age R10', licensedApplicator: true },
    { treatmentType: 'treeAge', palmCount: 2, dbhInches: 18, restrictedUseProduct: true, _refusal: /licensedApplicator/ },
    { treatmentType: 'treeAge', palmCount: 2, dbhInches: 18, restrictedUseProduct: true, licensedApplicator: true },
    { treatmentType: 'treeAge', palmCount: 2, dbhInches: 18, restrictedUseProduct: true, licensedApplicator: 'yes', _refusal: /licensedApplicator/ },
    { treatmentType: 'treeAge', palmCount: 1, dbhInches: 25, product: 'Tree-Age R10', licensedApplicator: true, customPricePerPalm: 200 },
    { treatmentType: 'treeAge', palmCount: 1, dbhInches: 12, product: 'Tree-Age G4' },
    // Fixed-treatment cadence (codex r25 P2): nutrition accepts only its
    // allowedAppsPerYear (1, 2); zero / negative / non-numeric fail the
    // positive-number assertion, an unsupported cadence names the allowed list.
    { treatmentType: 'nutrition', palmCount: 3, appsPerYear: 1 },
    { treatmentType: 'nutrition', palmCount: 3, appsPerYear: 2 },
    { treatmentType: 'nutrition', palmCount: 3, appsPerYear: 0, _refusal: /positive number/ },
    { treatmentType: 'nutrition', palmCount: 3, appsPerYear: -1, _refusal: /positive number/ },
    { treatmentType: 'nutrition', palmCount: 3, appsPerYear: '2', _refusal: /positive number/ },
    { treatmentType: 'nutrition', palmCount: 3, appsPerYear: 3, _refusal: /must be one of/ },
    { treatmentType: 'nutrition', palmCount: 3, appsPerYear: 1.5, _refusal: /must be one of/ },
  ];
  for (const { _refusal, ...c } of palmCases) {
    const exp = c.palmCount > 0 && Number.isInteger(c.palmCount) ? expectPalm(c) : null;
    const r = runEngine({ ...BASE, services: { palmInjection: c } });
    const li = line(r.result, 'palm_injection');
    // A declared refusal must be a THROW whose message names the reason: an
    // engine that silently omits the palm line (r.ok with no line) is not a
    // refusal, and record() would otherwise file it as engine_only (codex r20 P2).
    flagIf(!!_refusal && (r.ok || !_refusal.test(r.error)), 'P1', section, `palm ${JSON.stringify(c)} not refused as declared`, r.ok ? `engine returned ok (${li ? 'priced ' + li.annual : 'no palm line'}) — expected a thrown error matching ${_refusal}` : `expected an error matching ${_refusal}, engine said: ${r.error}`);
    record(section, `palm ${JSON.stringify(c)}`, c, exp ? exp.annual : null, li ? li.annual : null, { extra: { perVisitExpected: exp ? exp.perVisit : null, perVisitActual: li ? li.perVisit : null, minimumApplied: exp ? exp.minimumApplied : null, engineError: r.ok ? null : r.error, palmSizeUsed: li ? li.palmSize : null } });
    // A tiered treatment with no palm size must be refused by the engine (fail
    // closed); pricing it silently would quote a defaulted size.
    flagIf(exp === null && c.palmCount > 0 && Number.isInteger(c.palmCount) && li, 'P1', section, `palm ${JSON.stringify(c)} priced although a refusal was expected`, `engine annual ${li && li.annual}`);
  }
}

function runBundleAndDiscountMatrix() {
  const section = 'waveguard_discounts';
  const combos = [
    ['pest'], ['pest', 'lawn'], ['pest', 'lawn', 'mosquito'], ['pest', 'lawn', 'mosquito', 'treeShrub'], ['pest', 'lawn', 'mosquito', 'treeShrub', 'rodentBait'],
    ['rodentBait'], ['rodentBait', 'pest'], ['palmInjection', 'pest', 'lawn', 'mosquito'], ['termite', 'pest'],
  ];
  const keyMap = { pest: 'pest_control', lawn: 'lawn_care', mosquito: 'mosquito', treeShrub: 'tree_shrub', rodentBait: 'rodent_bait', palmInjection: 'palm_injection', termite: 'termite_bait' };
  for (const combo of combos) {
    const services = {};
    for (const k of combo) {
      services[k] = k === 'pest' ? { frequency: 'quarterly' } : k === 'lawn' ? { track: 'st_augustine', tier: 'enhanced' } : k === 'mosquito' ? { tier: 'seasonal9' } : k === 'treeShrub' ? { tier: 'standard', treeCount: 6 } : k === 'palmInjection' ? { treatmentType: 'nutrition', palmCount: 3 } : k === 'termite' ? { system: 'trelona' } : {};
    }
    const r = runEngine({ ...BASE, bedArea: 2000, services });
    // A throwing WaveGuard bundle is a counted discrepancy, never a crash before
    // the artifacts are written — same guard as the prepay bundle loop (codex
    // r30 P2).
    if (!r.ok) { record(section, `tier for ${combo.join('+')}: engine threw`, { combo }, 1, null, { extra: { engineError: r.error } }); findings.push({ severity: 'P1', section, name: `tier for ${combo.join('+')}`, detail: `generateEstimate threw: ${r.error}` }); continue; }
    const res = r.result;
    const exp = expectTier(combo.map((k) => keyMap[k]));
    const tierRow = { section, name: `tier for ${combo.join('+')}`, expected: exp.tier, actual: res.waveGuard.tier, status: exp.tier === res.waveGuard.tier ? 'match' : 'MISMATCH', extra: { expectedDiscount: exp.discount, actualDiscount: res.waveGuard.discount } };
    scenarios.push(tierRow);
    if (tierRow.status === 'MISMATCH') findings.push({ severity: 'P1', section, name: tierRow.name, detail: `expected ${exp.tier} got ${res.waveGuard.tier}` });
    for (const li of res.lineItems) {
      if (!Number.isFinite(li.annual) || li.annual <= 0) continue;
      const eligible = constants.WAVEGUARD.qualifyingServices.includes(li.service) && !constants.WAVEGUARD.excludedFromPercentDiscount[li.service];
      const expectedAfter = eligible ? round2(li.annual * (1 - exp.discount)) : (li.service === 'palm_injection' ? null : li.annual);
      if (expectedAfter !== null) record(section, `${combo.join('+')} → ${li.service} annual after tier %`, { combo }, expectedAfter, li.annualAfterDiscount ?? li.finalAnnual ?? null, { extra: { tier: res.waveGuard.tier, finalMargin: li.finalMargin ?? null, belowMarginFloor: li.belowMarginFloor ?? null, listMargin: li.margin ?? null } });
    }
    // summary reconciliation: sum of recurring after-discount annuals = summary.recurringAnnualAfterDiscount (± rounding)
    // Cent-scale (codex r3 P2): every line annual and the summary are cent values,
    // so the only legitimate slack is one half-cent of rounding per summed line.
    const afterLines = res.lineItems.filter((l) => Number.isFinite(l.annualAfterDiscount));
    const sumAfter = round2(afterLines.reduce((s, l) => s + l.annualAfterDiscount, 0));
    record(section, `${combo.join('+')} summary recurringAnnualAfterDiscount vs Σ lines`, {}, sumAfter, res.summary.recurringAnnualAfterDiscount, { tolerance: afterLines.length * 0.005 + 0.001 });
    record(section, `${combo.join('+')} monthly = annual/12`, {}, round2(res.summary.recurringAnnualAfterDiscount / 12), res.summary.recurringMonthlyAfterDiscount, { tolerance: 0.006 });
  }
  // Manual discount on top of Platinum (deepest permitted discount), reproduced
  // independently (codex r12 P2): the recurring slice of a manual discount applies
  // AFTER WaveGuard to the recurring lines in MANUAL_RECURRING_DISCOUNT_SERVICES
  // (frozen mirror of discount-engine.js — rodent_bait is NOT in it), and
  // summary.recurringAnnualAfterDiscount = Σ after-WaveGuard annuals − that slice.
  // The bundle below is Platinum WITHOUT lawn so no lawn-floor cap can bind and
  // the expectation is pure arithmetic; the with-lawn case is bounded separately.
  const MANUAL_RECURRING_DISCOUNT_SERVICES = ['pest_control', 'lawn_care', 'tree_shrub', 'mosquito'];
  const noLawn = { pest: { frequency: 'quarterly' }, mosquito: { tier: 'seasonal9' }, treeShrub: { tier: 'standard', treeCount: 6 }, rodentBait: {} };
  const platNL = runEngine({ ...BASE, bedArea: 2000, services: noLawn }).result;
  const nlTierRow = { section, name: 'manual-discount base bundle (pest+mosquito+treeShrub+rodentBait) tier', expected: 'platinum', actual: platNL.waveGuard.tier, status: platNL.waveGuard.tier === 'platinum' ? 'match' : 'MISMATCH', extra: null };
  scenarios.push(nlTierRow);
  if (nlTierRow.status === 'MISMATCH') findings.push({ severity: 'P1', section, name: nlTierRow.name, detail: `expected platinum got ${platNL.waveGuard.tier}` });
  const nlAfterWG = platNL.summary.recurringAnnualAfterDiscount;
  const nlEligible = round2(platNL.lineItems.filter((l) => MANUAL_RECURRING_DISCOUNT_SERVICES.includes(l.service) && Number.isFinite(l.annualAfterDiscount)).reduce((sum, l) => sum + l.annualAfterDiscount, 0));
  const nlExcluded = round2(nlAfterWG - nlEligible); // the rodent line survives every manual discount
  const manualCases = [
    { name: 'PERCENT 25%', md: { type: 'PERCENT', value: 25 }, slice: round2(nlEligible * 0.25) },
    { name: 'FIXED $500', md: { type: 'FIXED', value: 500 }, slice: 500 },
    { name: 'FIXED $99,999 (capped at the discountable recurring total; rodent line untouched)', md: { type: 'FIXED', value: 99999 }, slice: nlEligible },
  ];
  if (nlEligible <= 500) findings.push({ severity: 'P1', section, name: 'manual FIXED $500 premise', detail: `discountable recurring total ${nlEligible} ≤ 500 — the partial FIXED case no longer exercises a partial discount` });
  for (const c of manualCases) {
    const r = runEngine({ ...BASE, bedArea: 2000, services: noLawn, manualDiscount: { ...c.md, label: 'Audit test', internalReason: 'audit' } }).result;
    record(section, `Platinum (no lawn) + manual ${c.name} → recurringAnnualAfterDiscount`, { manualDiscount: c.md }, round2(nlAfterWG - c.slice), r.summary.recurringAnnualAfterDiscount, { extra: { afterWaveGuard: nlAfterWG, discountableRecurring: nlEligible, excludedRecurring: nlExcluded, capReason: r.summary.manualDiscount?.capReason ?? null } });
    record(section, `Platinum (no lawn) + manual ${c.name} → manualDiscount.recurringAmount`, { manualDiscount: c.md }, c.slice, r.summary.manualDiscount?.recurringAmount ?? null);
    record(section, `Platinum (no lawn) + manual ${c.name} → monthly = annual/12`, {}, round2(r.summary.recurringAnnualAfterDiscount / 12), r.summary.recurringMonthlyAfterDiscount, { tolerance: 0.006 });
  }
  // Armed pest program floor (codex r16 P2): with PEST.enforceFloorPostDiscount=true
  // the post-discount floor lifts ONLY the WaveGuard leg (estimate-engine.js:
  // applyMarginGuard runs on the tier discount); the manual recurring slice is
  // capped at the LAWN floors alone (estimate-engine.js manual-discount block), so
  // the expectation is the same arithmetic on the ARMED engine's own after-WaveGuard
  // lines. 800 sf puts the Platinum-discounted pest line under its floor, so the
  // lift actually binds here (2,000 sf × 0.80 clears the $89 floor by 60¢).
  // Simulated on the live constants object — read at call time, exactly what --db
  // exercises — and restored after.
  const pestConst = constants.PEST;
  const savedPest = { enforceFloorPostDiscount: pestConst.enforceFloorPostDiscount };
  pestConst.enforceFloorPostDiscount = true;
  try {
    const armedInput = { ...BASE, homeSqFt: 800, bedArea: 2000, services: noLawn };
    const armed = runEngine(armedInput).result;
    const armedPest = line(armed, 'pest_control');
    const armedTierRow = { section, name: '[overlay pest floor armed] manual-discount base bundle (800 sf) tier', expected: 'platinum', actual: armed.waveGuard.tier, status: armed.waveGuard.tier === 'platinum' ? 'match' : 'MISMATCH', extra: null };
    scenarios.push(armedTierRow);
    if (armedTierRow.status === 'MISMATCH') findings.push({ severity: 'P1', section, name: armedTierRow.name, detail: `expected platinum got ${armed.waveGuard.tier}` });
    // The floor must actually bind on the armed WaveGuard leg or this block proves nothing.
    const liftRow = { section, name: '[overlay pest floor armed] pest line lifted to its cadence-adjusted program floor on the WaveGuard leg', expected: true, actual: armedPest ? armedPest.programFloorApplied === true : null, status: armedPest && armedPest.programFloorApplied === true ? 'match' : 'MISMATCH', extra: { programFloorAnnual: armedPest?.programFloorAnnual ?? null, annualBeforeDiscount: armedPest?.annualBeforeDiscount ?? null, annualAfterDiscount: armedPest?.annualAfterDiscount ?? null, actualDiscountPct: armedPest?.actualDiscountPct ?? null } };
    scenarios.push(liftRow);
    if (liftRow.status === 'MISMATCH') findings.push({ severity: 'P1', section, name: liftRow.name, detail: `programFloorApplied ${armedPest?.programFloorApplied ?? null} — the armed-floor premise no longer holds at 800 sf` });
    const armedAfterWG = armed.summary.recurringAnnualAfterDiscount;
    const armedEligible = round2(armed.lineItems.filter((l) => MANUAL_RECURRING_DISCOUNT_SERVICES.includes(l.service) && Number.isFinite(l.annualAfterDiscount)).reduce((sum, l) => sum + l.annualAfterDiscount, 0));
    for (const c of [{ name: 'PERCENT 25%', md: { type: 'PERCENT', value: 25 }, slice: round2(armedEligible * 0.25) }, { name: 'FIXED $500', md: { type: 'FIXED', value: 500 }, slice: 500 }]) {
      const r = runEngine({ ...armedInput, manualDiscount: { ...c.md, label: 'Audit test', internalReason: 'audit' } }).result;
      const pestLi = line(r, 'pest_control');
      record(section, `[overlay pest floor armed] Platinum (no lawn, 800 sf) + manual ${c.name} → recurringAnnualAfterDiscount (floor lifts the WaveGuard leg only; no pest cap on the manual slice)`, { manualDiscount: c.md }, round2(armedAfterWG - c.slice), r.summary.recurringAnnualAfterDiscount, { extra: { afterWaveGuard: armedAfterWG, discountableRecurring: armedEligible, pestProgramFloorAnnual: pestLi?.programFloorAnnual ?? null, pestProgramFloorApplied: pestLi?.programFloorApplied ?? null, pestAnnualAfterDiscount: pestLi?.annualAfterDiscount ?? null, capReason: r.summary.manualDiscount?.capReason ?? null } });
      record(section, `[overlay pest floor armed] Platinum (no lawn, 800 sf) + manual ${c.name} → manualDiscount.recurringAmount`, { manualDiscount: c.md }, c.slice, r.summary.manualDiscount?.recurringAmount ?? null);
    }
  } finally { Object.assign(pestConst, savedPest); }
  // With lawn the recurring slice is capped at the lawn program / margin floor
  // (engine-owned lawnLineProtectedAnnual, not reproduced here). The independent
  // bound: a cap can only REDUCE the discount, so the total sits between the
  // uncapped 25% result and the WaveGuard-only total.
  const full = { pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', tier: 'enhanced' }, mosquito: { tier: 'seasonal9' }, treeShrub: { tier: 'standard', treeCount: 6 } };
  const plat = runEngine({ ...BASE, bedArea: 2000, services: full }).result;
  const md = runEngine({ ...BASE, bedArea: 2000, services: full, manualDiscount: { type: 'PERCENT', value: 25, label: 'Audit test', internalReason: 'audit' } }).result;
  const fullEligible = round2(plat.lineItems.filter((l) => MANUAL_RECURRING_DISCOUNT_SERVICES.includes(l.service) && Number.isFinite(l.annualAfterDiscount)).reduce((sum, l) => sum + l.annualAfterDiscount, 0));
  const uncapped = round2(plat.summary.recurringAnnualAfterDiscount - round2(fullEligible * 0.25));
  const withManual = md.summary.recurringAnnualAfterDiscount;
  const capReason = md.summary.manualDiscount?.capReason ?? md.summary.manualDiscount?.lawnCapReason ?? null;
  const inBounds = Number.isFinite(withManual) && withManual >= uncapped - 0.005 && withManual <= plat.summary.recurringAnnualAfterDiscount + 0.005 && (capReason ? withManual > uncapped : Math.abs(withManual - uncapped) <= 0.005);
  const boundRow = { section, name: 'Platinum (with lawn) + 25% manual discount: uncapped 25% ≤ total ≤ WaveGuard-only, equality iff no lawn-floor cap', expected: uncapped, actual: withManual, status: inBounds ? 'match' : 'MISMATCH', extra: { platinumAnnual: plat.summary.recurringAnnualAfterDiscount, capReason, marginWarnings: md.marginWarnings } };
  scenarios.push(boundRow);
  if (boundRow.status === 'MISMATCH') findings.push({ severity: 'P1', section, name: boundRow.name, detail: `uncapped ${uncapped}, engine ${withManual}, capReason ${capReason}` });
}

function runAnnualEconomics() {
  // First-year vs renewal-year economics per recurring service at every tier, with engine-modeled labor AND,
  // for context only, the recorded visit spans (not on-site — MON-004; drive never re-added).
  const section = 'annual_economics';
  const out = [];
  const pestQ = expectPest({ homeSqFt: 2000, frequency: 'quarterly' });
  const lawn9 = expectLawn({ track: 'st_augustine', lawnSqFt: 4500, tier: 'enhanced' });
  const lawnCostModeled = lawnCostStack({ track: 'st_augustine', lawnSqFt: 4500, visits: 9 });
  const mosq = expectMosquito({ homeSqFt: 2000, lotSqFt: 8000, program: 'seasonal9' });
  const rod = expectRodentBait({ homeSqFt: 2000 });
  const ts = expectTreeShrub({ bedArea: 1440, treeCount: 6, tier: 'standard' });
  const term = expectTermiteBait({ homeSqFt: 2000 });
  const pestMaterial = 6.67; // engine's chemCost talak 1.30 + taurus 4.87 + surfactant 0.50 (service-pricing.js pestVisitCostModel)
  const rows = [
    { key: 'pest_control', service: 'pest_control quarterly (2,000 sf)', revenuePerVisit: pestQ.perApp, visits: 4, modeledMinutes: 25, observed: RECORDED_VISIT_SPAN_MINUTES.pest_control_quarterly, materialPerVisit: pestMaterial, callbackRate: OBSERVED_PEST_CALLBACK_RATE, callbackMinutes: RECORDED_VISIT_SPAN_MINUTES.pest_re_service.median, setupFee: constants.PEST.initialFee },
    // Callback reserves come from the live constants the pricers read — the
    // lawn floor's per-visit reserve and TREE_SHRUB.callbackReservePerVisit —
    // so a --db overlay moves the economics with the price (codex r20 P2).
    { key: 'lawn_care', service: 'lawn_care 9x st_augustine (4,500 sf)', revenuePerVisit: lawn9.perApp, visits: 9, modeledMinutes: lawnCostModeled.modeledMinutes, driveMinutes: lawnCostModeled.driveMinutes, observed: RECORDED_VISIT_SPAN_MINUTES.lawn_care_9x, materialPerVisit: lawnCostModeled.materialPerVisit, callbackReservePerVisit: lawnCostModeled.callbackReservePerVisit },
    // Visits come from the (possibly overlaid) cadence expectMosquito priced with —
    // pricing_config.mosquito_visits can change seasonal9 (codex r23 P2).
    { key: 'mosquito', service: 'mosquito seasonal9 (8,000 sf lot)', revenuePerVisit: mosq.perVisit, visits: mosq.visits, modeledMinutes: 30, observed: null, materialPerVisit: mosq.materialPerVisit },
    // Rodent bait setup is waived by any other qualifying service, and a
    // stand-alone rodent program is Bronze — so Silver+ rows (which imply
    // another qualifier) carry no setup fee (codex r2 P2).
    { key: 'rodent_bait', service: 'rodent_bait (2,000 sf)', revenuePerVisit: rod.perVisit, visits: 4, modeledMinutes: rod.stations * 5, observed: null, materialPerVisit: rod.stations * 1.5, extraAnnual: rod.stations * 7.5, setupFee: rod.setupFee, setupStandaloneOnly: true },
    { key: 'tree_shrub', service: 'tree_shrub 6x (1,440 sf beds, 6 trees)', revenuePerVisit: ts.perApp, visits: 6, modeledMinutes: ts.onSiteMin + 10, driveMinutes: 0, observed: null, materialPerVisit: round2(ts.materialCost / 6), callbackReservePerVisit: constants.TREE_SHRUB.callbackReservePerVisit || 0 },
    // Cartridge replacement + follow-up reserve per year, no per-visit bait material (plan §A1; codex r6 P1).
    { key: 'termite_bait', service: 'termite_bait monitoring (2,000 sf)', revenuePerVisit: term.perApp, visits: 4, modeledMinutes: term.stations * 5, observed: null, materialPerVisit: 0, extraAnnual: termiteAnnualCost(term.stations), setupFee: term.installPrice /* billed installation — first-year revenue includes it (codex r2 P2) */ },
  ];
  for (const row of rows) {
    // The tier % reaches a row only if its service is in the LIVE qualifying list
    // and not in the percent-exclusion map (discount-engine.js isTierDiscountEligible /
    // excludedFromPercentDiscount) — a DB overlay that drops rodent_bait's tier
    // qualifier removes its discount here too (codex r15 P2).
    const tierEligible = constants.WAVEGUARD.qualifyingServices.includes(row.key) && constants.WAVEGUARD.excludedFromPercentDiscount[row.key] !== true;
    for (const tier of ['bronze', 'silver', 'gold', 'platinum']) {
      const discount = tierEligible ? constants.WAVEGUARD.tiers[tier].discount : 0;
      const modeled = unitEconomics({ revenuePerVisit: row.revenuePerVisit, visits: row.visits, onSiteMinutes: row.modeledMinutes, driveMinutes: row.driveMinutes ?? constants.GLOBAL.DRIVE_TIME, materialPerVisit: row.materialPerVisit, consumablesPerVisit: row.callbackReservePerVisit || 0, adminAnnual: constants.GLOBAL.ADMIN_ANNUAL + (row.extraAnnual || 0), callbackRate: row.callbackRate || 0, callbackMinutes: row.callbackMinutes || 0, callbackDriveMinutes: 0 /* recorded callback span already contains drive (MON-004) */, discountPct: discount });
      const observed = row.observed ? unitEconomics({ revenuePerVisit: row.revenuePerVisit, visits: row.visits, onSiteMinutes: row.observed.median, driveMinutes: 0 /* recorded span already contains drive — never re-added (MON-004) */, materialPerVisit: row.materialPerVisit, consumablesPerVisit: row.callbackReservePerVisit || 0, adminAnnual: constants.GLOBAL.ADMIN_ANNUAL + (row.extraAnnual || 0), callbackRate: row.callbackRate || 0, callbackMinutes: row.callbackMinutes || 0, callbackDriveMinutes: 0 /* recorded callback span already contains drive (MON-004) */, discountPct: discount }) : null;
      const observedP75 = row.observed ? unitEconomics({ revenuePerVisit: row.revenuePerVisit, visits: row.visits, onSiteMinutes: row.observed.p75, driveMinutes: 0 /* recorded span already contains drive — never re-added (MON-004) */, materialPerVisit: row.materialPerVisit, consumablesPerVisit: row.callbackReservePerVisit || 0, adminAnnual: constants.GLOBAL.ADMIN_ANNUAL + (row.extraAnnual || 0), callbackRate: row.callbackRate || 0, callbackMinutes: row.callbackMinutes || 0, callbackDriveMinutes: 0 /* recorded callback span already contains drive (MON-004) */, discountPct: discount }) : null;
      const setupThisYear = row.setupFee && !(row.setupStandaloneOnly && tier !== 'bronze') ? row.setupFee : 0;
      const firstYearRevenue = round2(modeled.revenueAnnual + setupThisYear);
      out.push({ service: row.service, tier, discount, tierDiscountEligible: tierEligible, perVisitList: row.revenuePerVisit, visits: row.visits, renewalRevenue: modeled.revenueAnnual, firstYearRevenue, setupFee: setupThisYear, modeledMinutes: row.modeledMinutes, observedMinutes: row.observed ? row.observed.median : null, observedN: row.observed ? row.observed.n : null, modeled, observed, observedP75 });
    }
  }
  return { section, rows: out };
}

function runCommercialMatrix() {
  const section = 'commercial';
  const cases = [
    // `expect` = the main service line each case must return, and whether it is
    // auto-priced or a manual quote (codex r18 P1): a dispatcher regression that
    // drops the requested line, or downgrades an auto-priced program to a manual
    // quote (or vice versa), must fail the run rather than record engine_only.
    // `frozen` (codex r26 P2): literal customer amounts captured 2026-09-04 from the
    // in-code constants and compared as normal match/mismatch rows — the commercial
    // cost-plus pricers share their constants with any reconstruction, so only a
    // literal catches a doubled quote. A deliberate commercial price move updates
    // these in the same PR.
    { name: 'commercial pest office 5,000 sf', frozen: { annual: 715.83, perApp: 178.96 }, expect: { service: 'commercial_pest', manual: false }, input: { ...BASE, homeSqFt: 5000, lotSqFt: 20000, isCommercial: true, propertyType: 'commercial', commercialRiskType: 'office_low', services: { pest: { frequency: 'monthly' } } } },
    { name: 'commercial lawn 60,000 sf turf', frozen: { annual: 6231.52, perApp: 778.94 }, expect: { service: 'commercial_lawn', manual: false }, input: { ...BASE, homeSqFt: 5000, lotSqFt: 100000, lawnSqFt: 60000, isCommercial: true, propertyType: 'commercial', services: { lawn: {} } } },
    { name: 'commercial mosquito 40,000 sf lot', frozen: { annual: 1321.09, perApp: 146.79 }, expect: { service: 'commercial_mosquito', manual: false }, input: { ...BASE, homeSqFt: 5000, lotSqFt: 40000, isCommercial: true, propertyType: 'commercial', services: { mosquito: {} } } },
    { name: 'commercial one-time pest (manual quote)', expect: { service: 'commercial_pest', manual: true }, input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { oneTimePest: {} } } },
    { name: 'commercial WDO (manual quote)', expect: { service: 'commercial_pest', manual: true }, input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { wdo: {} } } },
    { name: 'commercial german roach (manual quote)', expect: { service: 'commercial_pest', manual: true }, input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { germanRoach: { severity: 'moderate' } } } },
    { name: 'commercial rodent bait', frozen: { annual: 476, perApp: 119 }, expect: { service: 'commercial_rodent_bait', manual: false }, input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { rodentBait: {} } } },
    { name: 'commercial termite bait', frozen: { annual: 813.27, perApp: 203.32 }, expect: { service: 'commercial_termite_bait', manual: false }, input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { termite: { system: 'trelona' } } } },
    { name: 'commercial tree & shrub', frozen: { annual: 2670.91, perApp: 445.15 }, expect: { service: 'commercial_tree_shrub', manual: false }, input: { ...BASE, homeSqFt: 5000, lotSqFt: 40000, bedArea: 6000, isCommercial: true, propertyType: 'commercial', services: { treeShrub: { tier: 'standard', treeCount: 20 } } } },
  ];
  // Auto-priced commercial lines must carry finite, POSITIVE amounts (codex r17
  // P1): this section bypasses record()/offBy, so a NaN / Infinity / missing
  // annual, perApp or price on a non-manual-quote line is an engine_error (P1,
  // counted as a discrepancy, exit 4) — never a silent engine_only observation.
  // Manual-quote lines (quoteRequired / requiresCustomQuote / manualQuote)
  // legitimately carry null amounts and are the only exemption.
  const invalidAmounts = (l) => {
    if (l.manualQuote) return [];
    const bad = [];
    const present = [['annual', l.annual], ['perApp', l.perApp], ['price', l.price]].filter(([, v]) => v !== null && v !== undefined);
    if (!present.length) bad.push('no annual / perApp / price on an auto-priced line');
    for (const [k, v] of present) if (!(Number.isFinite(v) && v > 0)) bad.push(`${k}=${v}`);
    if (l.visits !== null && l.visits !== undefined && (l.annual === null || l.annual === undefined || l.perApp === null || l.perApp === undefined)) bad.push('recurring line missing annual or perApp');
    return bad;
  };
  for (const c of cases) {
    const r = runEngine(c.input);
    const lines = r.ok ? r.result.lineItems.map((l) => ({ service: l.service, annual: l.annual ?? null, price: l.price ?? null, perApp: l.perApp ?? l.perVisit ?? null, visits: l.visitsPerYear ?? l.visits ?? null, manualQuote: !!(l.quoteRequired || l.requiresCustomQuote || l.manualQuote), taxable: l.taxable ?? null, taxCategory: l.taxCategory ?? null, margin: l.margin ?? null, review: l.requiresManualReview ?? null })) : [];
    const badAmounts = lines.flatMap((l) => invalidAmounts(l).map((b) => `${l.service}: ${b}`));
    if (r.ok) {
      const main = lines.find((l) => l.service === c.expect.service);
      if (!main) badAmounts.unshift(`expected line ${c.expect.service} missing (engine returned: ${lines.map((l) => l.service).join(', ') || 'no lines'})`);
      else if (main.manualQuote !== c.expect.manual) badAmounts.unshift(`${c.expect.service}: expected ${c.expect.manual ? 'a manual quote' : 'an auto-priced line'}, got ${main.manualQuote ? 'a manual quote' : 'an auto-priced line'}`);
    }
    const engineError = !r.ok ? r.error : (badAmounts.length ? `expected-line / amount check failed — ${badAmounts.join('; ')}` : null);
    scenarios.push({ section, name: c.name, expected: null, actual: null, status: engineError ? 'engine_error' : 'engine_only', extra: { engineError, expectedLine: c.expect, tier: r.ok ? r.result.waveGuard.tier : null, autoPricedLines: lines.filter((l) => !l.manualQuote).length, manualQuoteLines: lines.filter((l) => l.manualQuote).length, lines } });
    // A throwing commercial path, or an auto-priced line with an invalid amount,
    // is a P1 finding and a counted status, never a silent observation (codex r3
    // P1, r17 P1).
    if (!r.ok) findings.push({ severity: 'P1', section, name: c.name, detail: `generateEstimate threw: ${r.error}` });
    else if (badAmounts.length) findings.push({ severity: 'P1', section, name: c.name, detail: engineError });
    if (c.frozen) {
      const main = r.ok ? lines.find((l) => l.service === c.expect.service) : null;
      record(section, `${c.name} annual (frozen)`, c.input, c.frozen.annual, main ? main.annual : null, { extra: { engineError } });
      record(section, `${c.name} perApp (frozen)`, c.input, c.frozen.perApp, main ? main.perApp : null, { extra: { engineError } });
    }
  }
}

// Independent annual-prepay total (mirrors resolveAnnualPrepayInvoiceTotal's
// allocation, not its code): the mix's prepay % applies only to the base ABOVE the
// protected floor = Σ non-discountable lines (foam_recurring — its cadence multiplier
// is its only discount, owner directive) + the lawn program minimum × 12 per
// recurring lawn line whenever a positive minimum is live (owner directive
// 2026-07-09: prepay is not exempt from the floor — the --db overlay case, codex
// r16 P2). `rate` is the caller's mix rule (solo fee mix ⇒ 0).
const NON_DISCOUNTABLE = ['foam_recurring'];
function expectPrepayTotal(rows, rate) {
  const base = round2(rows.reduce((s, r) => s + r.annual, 0));
  const nonDisc = round2(rows.filter((r) => NON_DISCOUNTABLE.includes(r.service)).reduce((s, r) => s + r.annual, 0));
  const pmm = Number(constants.LAWN_PRICING_V2.programMinimumMonthly);
  const lawnFloorAnnual = Number.isFinite(pmm) && pmm > 0 ? round2(pmm * 12) : 0;
  const lawnProtected = round2(rows.filter((r) => r.service === 'lawn_care' && r.annual > 0).length * lawnFloorAnnual);
  const protectedFloor = Math.min(base, round2(nonDisc + lawnProtected));
  const discountable = Math.max(0, round2(base - protectedFloor));
  const amount = round2(protectedFloor + discountable * (1 - rate));
  return { base, nonDiscountable: nonDisc, lawnProtected, protectedFloor, discountable, rate, amount };
}

function runPrepayAndCadence() {
  const section = 'cadence_identities';
  const cases = [
    { services: { pest: { frequency: 'quarterly' } }, key: 'pest_control', visits: 4 },
    { services: { pest: { frequency: 'bimonthly' } }, key: 'pest_control', visits: 6 },
    { services: { pest: { frequency: 'monthly' } }, key: 'pest_control', visits: 12 },
    { services: { lawn: { tier: 'standard' } }, key: 'lawn_care', visits: 6 },
    { services: { lawn: { tier: 'enhanced' } }, key: 'lawn_care', visits: 9 },
    { services: { lawn: { tier: 'premium' } }, key: 'lawn_care', visits: 12 },
    { services: { mosquito: { tier: 'seasonal9' } }, key: 'mosquito', visits: 9 },
    { services: { mosquito: { tier: 'monthly12' } }, key: 'mosquito', visits: 12 },
    { services: { treeShrub: { tier: 'light', treeCount: 3 } }, key: 'tree_shrub', visits: 4 },
    { services: { treeShrub: { tier: 'standard', treeCount: 3 } }, key: 'tree_shrub', visits: 6 },
    { services: { treeShrub: { tier: 'enhanced', treeCount: 3 } }, key: 'tree_shrub', visits: 9 },
    { services: { rodentBait: {} }, key: 'rodent_bait', visits: 4 },
    // termite bait (quarterly, 4 visits) and recurring foam on all three cadences —
    // foam is non-discountable (cadence multiplier is its only discount) (codex r14 P2)
    { services: { termite: { system: 'trelona' } }, key: 'termite_bait', visits: 4 },
    { services: { foamRecurring: { points: 5, cadence: 'quarterly' } }, key: 'foam_recurring', visits: 4 },
    { services: { foamRecurring: { points: 5, cadence: 'bimonthly' } }, key: 'foam_recurring', visits: 6 },
    { services: { foamRecurring: { points: 5, cadence: 'monthly' } }, key: 'foam_recurring', visits: 12 },
  ];
  for (const c of cases) {
    const r = runEngine({ ...BASE, bedArea: 2000, services: c.services });
    const li = line(r.result, c.key);
    // A throwing engine or a missing line is a COUNTED discrepancy, not a crash
    // before the artifacts are written (codex r25 P2).
    if (!r.ok || !li) { record(section, `${c.key} ${JSON.stringify(c.services)} line present`, c.services, c.visits, null, { extra: { engineError: r.ok ? null : r.error } }); continue; }
    const visits = li.visitsPerYear ?? li.visits ?? li.frequency;
    const perApp = li.perApp ?? li.perVisit;
    scenarios.push({ section, name: `${c.key} ${JSON.stringify(c.services)} visits`, expected: c.visits, actual: visits, status: visits === c.visits ? 'match' : 'MISMATCH' });
    const identity = round2(perApp * visits);
    record(section, `${c.key} perApp × visits = annual (${c.visits})`, {}, identity, li.annual, { tolerance: visits * 0.005 + 0.01 });
    record(section, `${c.key} monthly × 12 = annual (${c.visits})`, {}, round2(li.monthly * 12), li.annual, { tolerance: 0.06 });
    // Annual prepay through the converter's own resolver (codex r5 P1) against
    // expectPrepayTotal: a SOLO membership-fee mix (pest / mosquito) earns no prepay %
    // — its incentive is the waived setup fee — everything else earns
    // ANNUAL_PREPAY_DISCOUNT_PCT on the base above the protected floor (foam_recurring
    // at full price; lawn's program minimum when one is live). The converter finds
    // both through the saved estimate's line items, so estimateData carries the priced
    // line the way every production caller passes it (codex r14 + r16 P2).
    const feeMix = ['pest_control', 'mosquito'].includes(c.key);
    const svc = { service: c.key, service_key: c.key, serviceKey: c.key, name: li.name || c.key, frequency: li.frequency || null, visits_per_year: visits, visitsPerYear: visits, annual: li.annual, perApp };
    const soloExp = expectPrepayTotal([svc], feeMix ? 0 : PREPAY_PCT);
    let resolved = null; let resolveErr = null;
    try { resolved = converter.resolveAnnualPrepayInvoiceTotal({ baseAnnual: li.annual, recurringServices: [svc], estimateData: { lineItems: [li] } }); } catch (e) { resolveErr = e.message; }
    record(section, `${c.key} (${c.visits}/yr) annual prepay total (converter resolver, ${feeMix ? 'solo fee mix: 0%' : `${PREPAY_PCT * 100}% above the protected floor`})`, { key: c.key }, soloExp.amount, resolved ? resolved.amount : null, { extra: { ...soloExp, resolvedRate: resolved ? resolved.rate : null, resolvedDiscount: resolved ? resolved.discount : null, error: resolveErr } });
    // Operator-waived setup fee (owner ruling 2026-07-23; codex r16 P2): the waiver
    // replaced the fee incentive, so a solo pest / mosquito plan converts to the
    // standard prepay % — a regression that drops the customer's prepay discount
    // after a waiver must not read as the ordinary 0 % solo path.
    if (feeMix) {
      const waivedExp = expectPrepayTotal([svc], PREPAY_PCT);
      let waived = null; let waivedErr = null;
      try { waived = converter.resolveAnnualPrepayInvoiceTotal({ baseAnnual: li.annual, recurringServices: [svc], estimateData: { lineItems: [li], operatorPriceAdjustment: { waiveSetupFee: true } } }); } catch (e) { waivedErr = e.message; }
      record(section, `${c.key} (${c.visits}/yr) annual prepay total with operator-waived setup fee (solo fee mix ⇒ ${PREPAY_PCT * 100}%)`, { key: c.key, waiveSetupFee: true }, waivedExp.amount, waived ? waived.amount : null, { extra: { ...waivedExp, resolvedRate: waived ? waived.rate : null, resolvedDiscount: waived ? waived.discount : null, error: waivedErr } });
    }
    let coverage = null; let coverageErr = null;
    try { coverage = converter.annualPrepayCoverageCadence(svc, li.frequency || null); } catch (e) { coverageErr = e.message; }
    // Independent expectation (codex r6 P1): the cadence whose shared coverage
    // count equals the plan's visits — the mosquito 9x program is seasonal by
    // design. A cadence the term path fails closed on (seasonal_feb_oct) is an
    // expected REJECTION, recorded as such; every other case must resolve to the
    // supported cadence that covers exactly the visits the customer prepaid, or
    // the term under-covers the plan and the uncovered visits complete-bill again.
    const expectedLabel = c.key === 'mosquito' && c.visits === 9 ? 'seasonal_feb_oct' : ['monthly', 'every_6_weeks', 'bimonthly', 'quarterly', 'triannual', 'semiannual', 'annual'].find((l) => visitsPerYearForCadence(l) === c.visits) || null;
    const expectedSupported = prepayCoverageCadenceForPattern(expectedLabel);
    const describe = (label) => (label == null ? 'null' : (prepayCoverageCadenceForPattern(label) ? label : `${label} (unsupported: term creation fails closed, no prepay term)`));
    const expectedText = describe(expectedLabel);
    const actualText = coverageErr ? `error: ${coverageErr}` : describe(coverage);
    const cadenceStatus = expectedText === actualText ? 'match' : 'MISMATCH';
    scenarios.push({ section, name: `${c.key} (${visits}/yr) annual-prepay coverage cadence`, expected: expectedText, actual: actualText, status: cadenceStatus, extra: { coverageCadence: coverage, expectedCadence: expectedLabel, coveredVisits: visitsPerYearForCadence(coverage), expectedSupported, error: coverageErr } });
    flagIf(cadenceStatus === 'MISMATCH', 'P1', section, `${c.key} (${visits}/yr) annual-prepay coverage cadence`, `expected ${expectedText}, resolver returned ${actualText}${coverage && visitsPerYearForCadence(coverage) != null && visitsPerYearForCadence(coverage) < visits ? ` — the term would cover ${visitsPerYearForCadence(coverage)} of ${visits} prepaid visits` : ''}`);
  }
  // Mixed bundles (codex r15 P2): the prepay rule is mix-dependent — a SOLO pest or
  // mosquito plan earns 0 % (fee-waiver incentive), any bundle of two or more
  // distinct services earns the % on its discountable lines, and foam_recurring is
  // added back at full price whatever it is mixed with. Run at the live constants
  // AND under a simulated lawn program minimum (the --db overlay case, codex r16
  // P2): the engine lifts every lawn line to the minimum and the converter protects
  // minimum × 12 per lawn line from the prepay %, so only lawn's headroom above the
  // floor earns it. $150/mo is chosen so the engine's whole-per-application lift
  // (1,800 ÷ 6, 9 and 12 are all integers) lands exactly on the minimum and the
  // converter's saved-row inference equals the live value. Restored after.
  const bundles = [
    { name: 'pest + lawn', services: { pest: { frequency: 'quarterly' }, lawn: { tier: 'standard' } }, keys: ['pest_control', 'lawn_care'] },
    { name: 'pest + mosquito (two fee-mix services ⇒ not solo)', services: { pest: { frequency: 'quarterly' }, mosquito: { tier: 'seasonal9' } }, keys: ['pest_control', 'mosquito'] },
    { name: 'foam + lawn', services: { foamRecurring: { points: 5, cadence: 'quarterly' }, lawn: { tier: 'standard' } }, keys: ['foam_recurring', 'lawn_care'] },
    { name: 'foam + pest', services: { foamRecurring: { points: 5, cadence: 'bimonthly' }, pest: { frequency: 'quarterly' } }, keys: ['foam_recurring', 'pest_control'] },
    { name: 'pest + lawn + mosquito + tree_shrub + foam', services: { pest: { frequency: 'quarterly' }, lawn: { tier: 'enhanced' }, mosquito: { tier: 'monthly12' }, treeShrub: { tier: 'standard', treeCount: 3 }, foamRecurring: { points: 5, cadence: 'monthly' } }, keys: ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'foam_recurring'] },
  ];
  const V = constants.LAWN_PRICING_V2;
  const savedMin = { programMinimumMonthly: V.programMinimumMonthly };
  for (const overlay of [null, { programMinimumMonthly: 150 }]) {
    if (overlay) Object.assign(V, overlay);
    const tag = overlay ? ` [overlay lawn min=${overlay.programMinimumMonthly}/mo]` : '';
    try {
      for (const b of bundles) {
        const r = runEngine({ ...BASE, bedArea: 2000, services: b.services });
        // A throwing bundle is a counted discrepancy with its error attached, never
        // a crash before the artifacts are written (codex r27 P2 — same guard as
        // the standalone cadence loop).
        if (!r.ok) { record(section, `bundle ${b.name}${tag}: engine threw`, { bundle: b.keys, overlay }, 1, null, { extra: { engineError: r.error } }); findings.push({ severity: 'P1', section, name: `bundle ${b.name}${tag}`, detail: `generateEstimate threw: ${r.error}` }); continue; }
        const res = r.result;
        const lis = b.keys.map((k) => line(res, k)).filter(Boolean);
        if (lis.length !== b.keys.length) { findings.push({ severity: 'P1', section, name: `bundle ${b.name}${tag}`, detail: `engine returned ${lis.length} of ${b.keys.length} recurring lines` }); continue; }
        const rows = lis.map((li) => ({ service: li.service, service_key: li.service, serviceKey: li.service, name: li.name || li.service, frequency: li.frequency || null, visits_per_year: li.visitsPerYear ?? li.visits ?? null, visitsPerYear: li.visitsPerYear ?? li.visits ?? null, annual: li.annualAfterDiscount ?? li.annual, perApp: li.perApp ?? li.perVisit }));
        const exp = expectPrepayTotal(rows, PREPAY_PCT);
        let resolved = null; let resolveErr = null;
        try { resolved = converter.resolveAnnualPrepayInvoiceTotal({ baseAnnual: exp.base, recurringServices: rows, estimateData: { lineItems: lis } }); } catch (e) { resolveErr = e.message; }
        const lawnLi = lis.find((li) => li.service === 'lawn_care') || null;
        record(section, `bundle ${b.name}${tag}: annual prepay total (${PREPAY_PCT * 100}% on ${exp.discountable}; ${exp.protectedFloor} protected)`, { bundle: b.keys, overlay }, exp.amount, resolved ? resolved.amount : null, { extra: { ...exp, resolvedRate: resolved ? resolved.rate : null, resolvedDiscount: resolved ? resolved.discount : null, error: resolveErr, tier: res.waveGuard.tier, lawnAnnual: lawnLi ? lawnLi.annualAfterDiscount ?? lawnLi.annual : null, lawnProgramMinimumApplied: lawnLi ? lawnLi.programMinimumGuardApplied ?? lawnLi.programMinimumApplied ?? null : null } });
      }
    } finally { Object.assign(V, savedMin); }
  }
}

// ── DB overlay (optional, READ ONLY) ──
async function maybeSyncFromDb() {
  if (!WANT_DB) return { synced: false, reason: 'not requested (--db)' };
  const url = process.env.AUDIT_DB_URL;
  if (!url) return { synced: false, reason: 'AUDIT_DB_URL not set' };
  let knex;
  try {
    knex = require(path.join(ROOT, 'node_modules', 'knex'));
  } catch (e) {
    return { synced: false, reason: `knex not installed: ${e.message}` };
  }
  const db = knex({ client: 'pg', connection: { connectionString: url, ssl: /railway|proxy|rlwy/.test(url) ? { rejectUnauthorized: false } : undefined }, pool: { min: 0, max: 1, afterCreate: (conn, done) => conn.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY', (err) => done(err, conn)) } });
  // Snapshot EVERY constant family the bridge can overlay (codex r5 P2) and report the changed paths.
  const snap = () => JSON.parse(JSON.stringify(constants, (k, v) => (typeof v === 'function' ? undefined : v)));
  const before = snap();
  try {
    const bridge = require(path.join(ENGINE_DIR, 'db-bridge'));
    const ok = await bridge.syncConstantsFromDB(db);
    const after = snap();
    const changedPaths = [];
    (function walk(x, y, p) { const keys = new Set([...Object.keys(x || {}), ...Object.keys(y || {})]); for (const k of keys) { const a = x ? x[k] : undefined; const b = y ? y[k] : undefined; if (JSON.stringify(a) === JSON.stringify(b)) continue; if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && p.split('.').length < 3) walk(a, b, p ? `${p}.${k}` : k); else changedPaths.push(p ? `${p}.${k}` : k); } })(before, after, '');
    await db.destroy();
    return { synced: !!ok, changed: changedPaths.length > 0, changedPaths };
  } catch (e) {
    await db.destroy().catch(() => {});
    return { synced: false, reason: e.message };
  }
}

function hardCodedRateInventory() {
  // Catalogue of every dollar / rate / minute constant that shapes a price (read from the live constants object).
  // `prices` carries every price-shaping family whole (lawn brackets, the PEST, ONE_TIME, RODENT, TERMITE, TREE_SHRUB and PALM families, property-type
  // adjustments, the commercial families, specialty, bed bug) — a curated subset hid changes (codex r6 P2; the
  // pest members and ONE_TIME.lawn / .mosquito were still cherry-picked until codex r8 P2).
  const G = constants.GLOBAL;
  return {
    labor: { LABOR_RATE: G.LABOR_RATE, DRIVE_TIME_MIN: G.DRIVE_TIME, ADMIN_ANNUAL: G.ADMIN_ANNUAL, MARGIN_FLOOR: G.MARGIN_FLOOR, MARGIN_TARGET_TS: G.MARGIN_TARGET_TS, lawnLaborMinutesBase: constants.LAWN_PRICING_V2.laborMinutesBase, lawnLaborMinutesPer1000: constants.LAWN_PRICING_V2.laborMinutesPer1000Sqft, lawnRouteDrive: constants.LAWN_PRICING_V2.routeDensityMinutes, pestOnSiteMinutes: { quarterly: 25, bimonthly: 25, monthly: 20 }, mosquitoOnSiteMinutes: 30, rodentBaitMinutesPerStation: 5, termiteInstallMinutesPerStation: 5, tsOnSiteFloorMinutes: 25, tsOverheadMinutesPerVisit: 10 },
    materials: { pestChemPerVisit: { talak: 1.3, taurus: 4.87, surfactant: 0.5 }, mosquito: constants.MOSQUITO.productCosts, mosquitoUsage: constants.MOSQUITO.productUsage, tsMaterialModel: constants.TREE_SHRUB.materialModel, termiteSystems: constants.TERMITE.systems, boraCare: { galCost: constants.SPECIALTY.boraCare.galCost, coverage: constants.SPECIALTY.boraCare.coverage }, preSlab: Object.fromEntries(Object.entries(constants.SPECIALTY.preSlabTermiticide.products).map(([k, v]) => [k, { containerCost: v.containerCost, containerOz: v.containerOz, ozPer10SqFt: v.productOzPer10SqFt }])), trenching: Object.fromEntries(Object.entries(constants.SPECIALTY.trenching.products).map(([k, v]) => [k, { containerCost: v.containerCost, containerOz: v.containerOz }])), foamCan: constants.SPECIALTY.foamDrill.canCost, plugCost: constants.SPECIALTY.plugging.costPerPlug, topDressSand: constants.SPECIALTY.topDressing.eighth.sandRate, dethatchPer1K: constants.SPECIALTY.dethatching.materialPer1K, bedBugPerRoom: constants.BED_BUG.chemical.materialPerRoomVisit1, palmInternalCost: constants.PALM.internalCostBasis, termiteCartridgeModel: TERMITE_CARTRIDGE_MODEL },
    prices: { pest: constants.PEST, oneTime: constants.ONE_TIME, // the whole mosquito family: pressure factors/cap, lot buckets, the 500-sf interpolation step and tier visit counts all move the price (codex r7 P2)
      mosquito: { basePrices: constants.MOSQUITO.basePrices, tierVisits: constants.MOSQUITO.tierVisits, priceStepSqFt: constants.MOSQUITO.priceStepSqFt, lotCategories: constants.MOSQUITO.lotCategories.map((c) => ({ ...c, maxSqFt: Number.isFinite(c.maxSqFt) ? c.maxSqFt : 'Infinity' })), grossLotGuardrailMaxDrop: constants.MOSQUITO.grossLotGuardrailMaxDrop, pressureFactors: constants.MOSQUITO.pressureFactors, pressureCap: constants.MOSQUITO.pressureCap, addOns: constants.MOSQUITO.addOns },
      // treatable-area derivation: HARDSCAPE is a per-property-type function family, recorded as source text so a slope change is visible;
      // TURF_FACTORS / BED_DENSITY derive the priced lawn and bed areas in property-calculator.js (codex r12 P2)
      property: { hardscape: Object.fromEntries(Object.entries(constants.HARDSCAPE).map(([k, f]) => [k, typeof f === 'function' ? f.toString() : f])), hardscapeAdditions: constants.HARDSCAPE_ADDITIONS, turfFactors: constants.TURF_FACTORS, bedDensity: constants.BED_DENSITY, bedAreaReviewSqFt: constants.BED_AREA_REVIEW_SQFT }, rodent: constants.RODENT, termite: constants.TERMITE, wdo: constants.SPECIALTY.wdo.brackets, germanRoach: constants.SPECIALTY.germanRoach.tiers, palm: constants.PALM, lawnBrackets: constants.LAWN_BRACKETS, lawnTableMaxSqFt: constants.LAWN_TABLE_MAX_SQFT /* above it: cadence caps off, edge-parity floor (codex r13 P2) */, propertyTypeAdj: constants.PROPERTY_TYPE_ADJ, lawnFreqs: constants.LAWN_FREQS, lawnCadenceDiscount: constants.LAWN_CADENCE_DISCOUNT, lawnPricingV2: constants.LAWN_PRICING_V2, bedBug: constants.BED_BUG, specialty: constants.SPECIALTY, achDiscount: constants.ACH_DISCOUNT, processingAdjustment: constants.PROCESSING_ADJUSTMENT, commercial: { lawn: constants.COMMERCIAL_LAWN, treeShrub: constants.COMMERCIAL_TREE_SHRUB, pest: constants.COMMERCIAL_PEST, mosquito: constants.COMMERCIAL_MOSQUITO, termiteBait: constants.COMMERCIAL_TERMITE_BAIT, rodentBait: constants.COMMERCIAL_RODENT_BAIT }, // the whole WAVEGUARD family: tiers, the qualifying-service list and the percent-exclusion map decide which lines receive the tier % (codex r12 P2)
      waveguard: constants.WAVEGUARD, prepayDiscount: constants.ANNUAL_PREPAY_DISCOUNT_PCT, deposit: constants.DEPOSIT, cardHold: constants.CARD_HOLD, inspectionCredit: constants.INSPECTION_CREDIT, urgency: constants.URGENCY, treeShrub: constants.TREE_SHRUB, lawnTiers: constants.LAWN_TIERS },
    marginDivisors: { plugging: constants.SPECIALTY.plugging.marginDivisor, topDressingEighth: constants.SPECIALTY.topDressing.eighth.marginDivisor, topDressingQuarter: constants.SPECIALTY.topDressing.quarter.marginDivisor, dethatching: constants.SPECIALTY.dethatching.marginDivisor, boraCare: constants.SPECIALTY.boraCare.marginDivisor, foamDrill: constants.SPECIALTY.foamDrill.marginDivisor, preSlabTermidor: constants.SPECIALTY.preSlabTermiticide.products.termidor_sc.marginDivisor, bedBugCostRatio: constants.BED_BUG.chemical.targetCostRatio, tsMarginTarget: constants.TREE_SHRUB.marginTarget, commercialTargetGrossMargin: constants.COMMERCIAL_PEST.targetGrossMargin, termiteInstallMarkup: constants.TERMITE.installMultiplier, trenchingProductPremiumMarkup: constants.SPECIALTY.trenching.productPremiumMultiplier },
  };
}

function markupVsMarginAudit() {
  // Sites that apply a MULTIPLIER (markup) rather than divide by (1 − margin). Reported, not judged: a markup is fine if labelled as one.
  return [
    // Labels interpolate the LIVE value (codex r20 P2): under a --db overlay the
    // multiplier in the label must be the one the equivalent margin was
    // computed from, never the in-code default.
    { site: `TERMITE.installMultiplier ×${constants.TERMITE.installMultiplier} on install MATERIAL only (service-pricing.js priceTermiteBait)`, kind: 'markup on material', equivalentMargin: round2(1 - 1 / constants.TERMITE.installMultiplier), note: `install labor (5 min/station × $${constants.GLOBAL.LABOR_RATE}) is excluded from the marked-up base; reported installMargin only` },
    { site: `SPECIALTY.trenching.productPremiumMultiplier ×${constants.SPECIALTY.trenching.productPremiumMultiplier} on chemical premium`, kind: 'markup on incremental material', equivalentMargin: round2(1 - 1 / constants.SPECIALTY.trenching.productPremiumMultiplier), note: 'base install is $/LF, not cost-plus' },
    { site: `BED_BUG.heat.subcontractMarkup ×${constants.BED_BUG.heat.subcontractMarkup} on vendor cost`, kind: 'markup (correctly named)', equivalentMargin: round2(1 - 1 / constants.BED_BUG.heat.subcontractMarkup) },
    { site: `ONE_TIME.pest.multiplier ×${constants.ONE_TIME.pest.multiplier} on quarterly per-app`, kind: 'price multiple (not cost-based)', equivalentMargin: null },
    { site: 'SPECIALTY.*.marginDivisor and TREE_SHRUB.marginTarget', kind: 'margin (price = cost ÷ (1 − m)) — correct', equivalentMargin: null },
  ];
}

async function main() {
  const dbInfo = await maybeSyncFromDb();
  if (WANT_DB && !dbInfo.synced) {
    // An explicitly requested overlay that did not happen must never look like
    // a passing constants-only run (codex r2 P1): fail nonzero.
    console.error(`--db requested but the pricing_config overlay did not run: ${dbInfo.reason || 'sync returned false'}`);
    process.exit(3);
  }
  runPestMatrix();
  runLawnMatrix();
  runMosquitoMatrix();
  runRodentMatrix();
  runTermiteMatrix();
  runOneTimeMatrix();
  runTreeShrubMatrix();
  runSpecialtyMatrix();
  runBundleAndDiscountMatrix();
  runCommercialMatrix();
  runPrepayAndCadence();
  const economics = runAnnualEconomics();

  // Counted BEFORE the summary is rendered or serialized (codex r19 P2): the
  // Markdown line and the JSON field used to be written from an undefined
  // count while only the exit code saw the real one.
  const discrepancyRows = new Set(scenarios.filter((s) => s.status === 'MISMATCH' || s.status === 'NO_PRICE' || s.status === 'engine_error').map((s) => `${s.section}::${s.name}`));
  const unrowedP1 = findings.filter((f) => (f.severity === 'P0' || f.severity === 'P1') && !discrepancyRows.has(`${f.section}::${f.name}`));
  const summary = {
    generatedAt: new Date().toISOString(),
    engineConstantsSource: dbInfo.synced ? 'pricing_config (DB overlay, read-only)' : 'constants.js (in-code defaults)',
    dbInfo,
    scenarioCount: scenarios.length,
    matches: scenarios.filter((s) => s.status === 'match').length,
    mismatches: scenarios.filter((s) => s.status === 'MISMATCH').length,
    engineErrors: scenarios.filter((s) => s.status === 'engine_error').length,
    noPrice: scenarios.filter((s) => s.status === 'NO_PRICE').length,
    engineOnly: scenarios.filter((s) => s.status === 'engine_only').length,
    unrowedP1Findings: unrowedP1.length,
    findings,
  };

  const md = [];
  md.push('# Independent estimator pricing audit — run output');
  md.push('');
  md.push(`Generated ${summary.generatedAt}. Constants source: **${summary.engineConstantsSource}**.`);
  md.push(`Scenarios: ${summary.scenarioCount} · independent-vs-engine matches: ${summary.matches} · mismatches: ${summary.mismatches} · expected a price but the engine returned none: ${summary.noPrice} · engine-only observations: ${summary.engineOnly} (${summary.matches} + ${summary.mismatches} + ${summary.noPrice} + ${summary.engineOnly} = ${summary.matches + summary.mismatches + summary.noPrice + summary.engineOnly}) · commercial engine errors: ${summary.engineErrors} · P0/P1 findings without a row: ${summary.unrowedP1Findings}`);
  md.push('');
  md.push('## Findings raised by this run');
  md.push('');
  if (!findings.length) md.push('_none_');
  for (const f of findings) md.push(`- **${f.severity}** [${f.section}] ${f.name} — ${f.detail}`);
  md.push('');
  md.push('## Mismatches (independent formula vs engine)');
  md.push('');
  md.push('| section | scenario | independent | engine | diff |');
  md.push('|---|---|---:|---:|---:|');
  for (const s of scenarios.filter((x) => x.status === 'MISMATCH' || x.status === 'NO_PRICE')) md.push(`| ${s.section} | ${s.name} | ${s.expected} | ${s.status === 'NO_PRICE' ? 'no price returned' : s.actual} | ${s.diff ?? '—'} |`);
  md.push('');
  md.push('## Annual economics per recurring service (engine labor model; recorded visit spans shown for context only)');
  md.push('');
  md.push('Recorded span = check-in → check-out, which often includes driving to the next stop — NOT on-site time (owner 2026-09-02, MON-004). Span columns are fed with no extra drive minutes and carry no pricing recommendation; the engine model columns are the ones the audit prices from.');
  md.push('');
  md.push('| service | tier | list/visit | renewal revenue | year-1 revenue | modeled min | gross margin (modeled) | markup (modeled) | recorded span median min (n) | gross margin at recorded median span | gross margin at recorded p75 span | contribution at recorded span (card: debit / credit+surcharge) |');
  md.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const e of economics.rows) {
    md.push(`| ${e.service} | ${e.tier} | ${money(e.perVisitList)} | ${money(e.renewalRevenue)} | ${money(e.firstYearRevenue)} | ${e.modeledMinutes} | ${pct(e.modeled.grossMargin)} | ${pct(e.modeled.markup)} | ${e.observedMinutes ?? '—'}${e.observedN ? ` (${e.observedN})` : ''} | ${e.observed ? pct(e.observed.grossMargin) : '—'} | ${e.observedP75 ? pct(e.observedP75.grossMargin) : '—'} | ${e.observed ? `${pct(e.observed.contributionMargin)} / ${pct(e.observed.contributionMarginCredit)}` : '—'} |`);
  }
  md.push('');
  md.push('## Markup vs margin sites');
  md.push('');
  for (const m of markupVsMarginAudit()) md.push(`- ${m.site} — ${m.kind}${m.equivalentMargin !== null ? ` (equivalent margin ${pct(m.equivalentMargin)})` : ''}${m.note ? ` — ${m.note}` : ''}`);
  md.push('');
  md.push('## Engine-only observations (no independent formula, recorded for the report)');
  md.push('');
  for (const s of scenarios.filter((x) => x.status === 'engine_only' || x.status === 'engine_error')) md.push(`- [${s.section}] ${s.name}: ${JSON.stringify(s.extra || {}).slice(0, 600)}`);
  md.push('');
  const text = md.join('\n');
  if (MD_OUT) fs.writeFileSync(MD_OUT, text);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ summary, scenarios, economics: economics.rows, hardCodedRates: hardCodedRateInventory(), markupSites: markupVsMarginAudit() }, null, 1));
  console.log(text);
  console.log(`\n(${summary.scenarioCount} scenarios, ${summary.mismatches} mismatches, ${summary.noPrice} expected-price-but-none, ${findings.length} findings)`);
  // A discrepancy is a failed verification, not a passing run with a note in
  // the report: exit nonzero so CI / a pre-push caller sees it (codex r6 P1).
  // Belt and braces (codex r18 P1): a P0/P1 finding pushed directly without a
  // discrepancy row (e.g. a bundle whose engine lines are missing) still fails
  // the run — every P0/P1 finding is a discrepancy, rowed or not (counted
  // above, before the artifacts were written).
  const discrepancies = summary.mismatches + summary.noPrice + summary.engineErrors + unrowedP1.length;
  if (discrepancies > 0) {
    console.error(`${discrepancies} discrepancy(ies): ${summary.mismatches} mismatches, ${summary.noPrice} expected-price-but-none, ${summary.engineErrors} commercial engine errors, ${unrowedP1.length} P0/P1 finding(s) without a row`);
    process.exitCode = 4;
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { expectPest, expectLawn, expectMosquito, expectRodentBait, expectTermiteBait, expectOneTimePest, expectTreeShrub, expectWdo, expectGermanRoach, expectFoamDrill, expectTopDressing, expectPlugging, expectPalm, expectTier, unitEconomics, lawnCostStack, RECORDED_VISIT_SPAN_MINUTES, OBSERVED_PEST_CALLBACK_RATE, hardCodedRateInventory, markupVsMarginAudit };
