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

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
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
    i += KNOWN_FLAGS.get(args[i]);
  }
}

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

// Hardscape estimate documented in constants.HARDSCAPE (single-family curve).
function hardscapeOf(lotSqFt, propertyType = 'single_family', features = {}) {
  const { HARDSCAPE, HARDSCAPE_ADDITIONS } = constants;
  let fn = HARDSCAPE.single_family;
  if (propertyType === 'commercial') fn = HARDSCAPE.commercial;
  else if (String(propertyType).includes('townhome') || propertyType === 'duplex') fn = HARDSCAPE.townhome;
  else if (String(propertyType).includes('condo')) fn = HARDSCAPE.condo;
  let hs = fn(lotSqFt);
  if (features.poolCage) hs += HARDSCAPE_ADDITIONS.poolCage;
  else if (features.pool) hs += HARDSCAPE_ADDITIONS.poolNoCage;
  return Math.round(hs);
}

// PEST — documented formula: max(floor, base + round(footprintAdj) + featureAdj + propAdj) × freqMult
function expectPest({ homeSqFt, stories = 1, features = {}, propertyType = 'single_family', frequency = 'quarterly' }) {
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
  const basePrice = Math.max(PEST.floor, PEST.base + footprintAdj + featureAdj + propAdj);
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
function expectLawn({ track = 'st_augustine', lawnSqFt, tier = 'enhanced' }) {
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
  const annual = Math.round(monthly * 12);
  const perApp = round2(annual / tc.freq);
  return { monthly: round2(annual / 12), annual, perApp, visits: tc.freq, marketMonthly: monthly };
}
// Lawn cost stack (shared package arithmetic, re-implemented here)
function lawnCostStack({ track, lawnSqFt, visits, onSiteMinutesOverride = null, routeDensity = 'DENSE' }) {
  const V = constants.LAWN_PRICING_V2;
  const budgets = { st_augustine: { 4: 75, 6: 103, 9: 182, 12: 225 }, bermuda: { 4: 61, 6: 93, 9: 172, 12: 226 }, zoysia: { 4: 83, 6: 124, 9: 205, 12: 219 }, bahia: { 4: 52, 6: 78, 9: 107, 12: 131 } };
  const annualBudget = (budgets[track] || budgets.st_augustine)[visits] || 100;
  const materialPerVisit = (annualBudget * (lawnSqFt / 4500)) / visits;
  const modeledMinutes = V.laborMinutesBase + (lawnSqFt / 1000) * V.laborMinutesPer1000Sqft;
  const onSite = onSiteMinutesOverride ?? modeledMinutes;
  const drive = V.routeDensityMinutes[routeDensity] ?? 5;
  const laborPerVisit = (V.laborRateLoaded * (onSite + drive)) / 60;
  const callback = V.callbackReservePerVisitDefault;
  const annualCost = (materialPerVisit + laborPerVisit + callback + V.equipmentReservePerVisit) * visits + V.adminAnnualDefault;
  return { annualBudget, materialPerVisit: round2(materialPerVisit), modeledMinutes, onSiteMinutes: onSite, driveMinutes: drive, laborPerVisit: round2(laborPerVisit), annualCost: round2(annualCost) };
}

// MOSQUITO — treatable = lot − footprint − hardscape; anchors at category top edges; 500-sf steps
function expectMosquito({ homeSqFt, stories = 1, lotSqFt, features = {}, program = 'seasonal9' }) {
  const M = constants.MOSQUITO;
  const footprint = footprintOf(homeSqFt, stories);
  const hardscape = hardscapeOf(lotSqFt, 'single_family', features);
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
  if (features.nearWater && waterMult <= 1) pressure += f.nearWater;
  if (features.irrigation) pressure += f.irrigation;
  const halfStart = 18000; const acreStart = 35000; const rampStart = 12000;
  if (pricingSqFt >= acreStart) pressure += f.lot_acre;
  else if (pricingSqFt >= halfStart) pressure += f.lot_half + ((pricingSqFt - halfStart) / (acreStart - halfStart)) * (f.lot_acre - f.lot_half);
  else if (pricingSqFt >= rampStart) pressure += ((pricingSqFt - rampStart) / (halfStart - rampStart)) * f.lot_half;
  if (waterMult > 1) pressure *= waterMult;
  pressure = Math.min(pressure, M.pressureCap);
  const perVisit = Math.round(base * pressure);
  const visits = M.tierVisits[program];
  const annual = perVisit * visits;
  const monthly = round2(annual / 12);
  // material per visit from the engine's own product assumptions
  const k = Math.max(1, treatable / 1000);
  const materialPerVisit = round2(Math.max(M.productUsage.bifenthrinBaseOz, M.productUsage.bifenthrinOzPer1000 * k) * M.productCosts.bifenthrinOz + M.productUsage.tekkoProOz * M.productCosts.tekkoProOz);
  return { footprint, hardscape, treatable, category: cat.key, pricingSqFt, base, pressure: round2(pressure), perVisit, visits, annual, monthly, materialPerVisit };
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

// TERMITE BAIT — perimeter from footprint, Trelona 15-ft spacing, 1.45× material markup, station-bracket monitoring
function expectTermiteBait({ homeSqFt, stories = 1, complexity = 'standard' }) {
  const T = constants.TERMITE;
  const fp = footprintOf(homeSqFt, stories);
  const perimMult = complexity === 'standard' ? T.perimeterMultiplier.standard : T.perimeterMultiplier.complex;
  const perimeter = Math.round(4 * Math.sqrt(fp) * perimMult);
  const sys = T.systems[T.defaultSystem];
  const stations = Math.max(T.minStations, Math.ceil(perimeter / sys.spacingFt));
  const installMaterial = stations * (sys.stationCost + sys.laborMaterial + sys.misc);
  const installLabor = stations * 0.083 * constants.GLOBAL.LABOR_RATE;
  const installPrice = Math.round(installMaterial * T.installMultiplier);
  const steps = Math.max(0, Math.ceil(stations / T.monitoring.bracketStations) - 2);
  const monitoringMonthly = round2(T.monitoring.baseMonthly + steps * T.monitoring.stepMonthly);
  const monitoringAnnual = round2(monitoringMonthly * 12);
  const perApp = round2(monitoringAnnual / T.monitoringVisitsPerYear);
  return { footprint: fp, perimeter, stations, installMaterial: round2(installMaterial), installLabor: round2(installLabor), installPrice, installMarkupOnMaterial: T.installMultiplier - 1, monitoringMonthly, monitoringAnnual, perApp, visits: T.monitoringVisitsPerYear };
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
  const materialTreeCount = treeCount + (palmMaterialArmed ? 0 : palmCount);
  const laborTreeCount = treeCount + (palmLaborArmed ? 0 : palmCount);
  const onSiteMin = Math.max(25, 20 + Math.round((bedArea / 500) * density) + Math.round(laborTreeCount * 1.5) + (TS.accessMinutes[access] || 0));
  const factor = tier === 'light' ? TS.materialModel.lightFactor : tier === 'enhanced' ? TS.materialModel.enhancedFactor : 1;
  const modeledMaterial = (TS.materialModel.fixedAnnual + TS.materialModel.perTreeAnnual * materialTreeCount + TS.materialModel.perSqFtAnnual * bedArea * density) * factor;
  const materialCost = Math.max(tc.frequency * 10, modeledMaterial);
  const laborPerVisit = (G.LABOR_RATE * (onSiteMin + 10)) / 60;
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
function expectWdo() { return { price: constants.SPECIALTY.wdo.brackets[0].price }; }
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
function expectPlugging(lawnSqFt, spacing = 12) {
  const cfg = constants.SPECIALTY.plugging;
  const ppsf = cfg.spacingRates[`${spacing}inch`] || cfg.spacingRates['12inch'];
  const plugs = Math.ceil(lawnSqFt * ppsf);
  const cost = plugs * cfg.costPerPlug + (plugs / cfg.laborPerPlugs) * constants.GLOBAL.LABOR_RATE;
  const price = Math.max(250, Math.round(cost / 0.55));
  return { plugs, cost: round2(cost), price, targetMargin: 0.45 };
}
function expectPalm({ treatmentType = 'nutrition', palmCount = 1, palmSize, appsPerYear = null }) {
  const P = constants.PALM;
  const t = P.treatments[treatmentType];
  let perPalm;
  if (t.pricingType === 'fixed') perPalm = t.pricePerPalm;
  else if (t.pricingType === 'tiered') {
    // The engine fails closed on a tiered treatment without a palm size
    // (getTierByPalmSize) — expect NO price, never a defaulted medium tier.
    if (!palmSize) return null;
    const tier = t.tiers.find((x) => x.size === palmSize);
    if (!tier) return null;
    perPalm = tier.pricePerPalm;
  } else return null;
  const apps = appsPerYear || t.defaultAppsPerYear;
  const rawPerVisit = round2(perPalm * palmCount);
  const perVisit = Math.max(rawPerVisit, P.minPerVisit);
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
function unitEconomics({ revenuePerVisit, visits, onSiteMinutes, driveMinutes = constants.GLOBAL.DRIVE_TIME, technicians = 1, materialPerVisit = 0, consumablesPerVisit = 0, adminAnnual = constants.GLOBAL.ADMIN_ANNUAL, callbackRate = 0, callbackMinutes = 0, callbackMaterial = 0, discountPct = 0, cardFeeRate = 0.029, laborRate = constants.GLOBAL.LABOR_RATE }) {
  const labor = ((onSiteMinutes + driveMinutes) / 60) * laborRate * technicians;
  const expectedCallback = callbackRate * (((callbackMinutes + driveMinutes) / 60) * laborRate + callbackMaterial);
  const directPerVisit = labor + materialPerVisit + consumablesPerVisit + expectedCallback;
  const directAnnual = directPerVisit * visits + adminAnnual;
  const revenueAnnual = revenuePerVisit * visits * (1 - discountPct);
  const grossProfit = revenueAnnual - directAnnual;
  const grossMargin = revenueAnnual > 0 ? grossProfit / revenueAnnual : null;
  const markup = directAnnual > 0 ? grossProfit / directAnnual : null;
  const cardFee = revenueAnnual * cardFeeRate;
  const contributionMargin = revenueAnnual > 0 ? (revenueAnnual - cardFee - directAnnual) / revenueAnnual : null;
  const targetPriceAnnual35 = directAnnual / (1 - 0.35);
  return {
    laborPerVisit: round2(labor), materialPerVisit: round2(materialPerVisit), expectedCallbackPerVisit: round2(expectedCallback),
    directPerVisit: round2(directPerVisit), directAnnual: round2(directAnnual), revenueAnnual: round2(revenueAnnual),
    grossProfit: round2(grossProfit), grossMargin: grossMargin === null ? null : Math.round(grossMargin * 1000) / 1000,
    markup: markup === null ? null : Math.round(markup * 1000) / 1000, contributionMargin: contributionMargin === null ? null : Math.round(contributionMargin * 1000) / 1000,
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
function record(section, name, input, expected, actual, opts = {}) {
  const tol = opts.tolerance ?? 0.005;
  const diff = Number.isFinite(expected) && Number.isFinite(actual) ? round2(actual - expected) : null;
  // NO_PRICE = the independent formula expected a price and the engine
  // returned none. It is a discrepancy like any other (a refused or errored
  // line where a price was expected) and is counted, listed and raised as a
  // finding — never silently dropped from the totals (codex P1 on PR #3792).
  const status = expected === null || expected === undefined ? 'engine_only' : (actual === null || actual === undefined ? 'NO_PRICE' : (Math.abs(diff) <= tol ? 'match' : 'MISMATCH'));
  const row = { section, name, input, expected, actual, diff, status, ...opts.extra };
  scenarios.push(row);
  if (status === 'MISMATCH') findings.push({ severity: 'P1', section, name, detail: `independent ${expected} vs engine ${actual} (diff ${diff})` });
  if (status === 'NO_PRICE') findings.push({ severity: 'P1', section, name, detail: `independent ${expected} but the engine returned no price for this line` });
  return row;
}
function flagIf(cond, severity, section, name, detail) { if (cond) findings.push({ severity, section, name, detail }); }

function runPestMatrix() {
  const section = 'pest_control';
  const boundaries = [800, 1200, 1500, 1750, 2000, 2500, 3000, 4000, 5500];
  const sizes = new Set([500, 799, ...boundaries, ...boundaries.map((b) => b - 1), ...boundaries.map((b) => b + 1), 6500, 10000, 20000]);
  for (const sqft of [...sizes].sort((a, b) => a - b)) {
    for (const frequency of ['quarterly', 'bimonthly', 'monthly']) {
      const exp = expectPest({ homeSqFt: sqft, frequency });
      const r = runEngine({ ...BASE, homeSqFt: sqft, services: { pest: { frequency } } });
      const li = line(r.result, 'pest_control');
      record(section, `footprint ${sqft} ${frequency}`, { homeSqFt: sqft, frequency }, exp.perApp, li ? li.perApp : null, { extra: { annualExpected: exp.annual, annualActual: li ? li.annual : null, review: li ? li.requiresManualReview : null } });
      if (li) flagIf(Math.abs(li.annual - exp.annual) > 0.005, 'P1', section, `annual ${sqft} ${frequency}`, `annual ${li.annual} vs ${exp.annual}`);
    }
  }
  // feature modifiers
  const featureCases = [
    { features: { poolCage: true, poolCageSize: 'small' } }, { features: { poolCage: true, poolCageSize: 'large' } }, { features: { poolCage: true, poolCageSize: 'oversized' } },
    { features: { pool: true } }, { features: { shrubs: 'heavy' } }, { features: { shrubs: 'light' } }, { features: { complexity: 'complex' } }, { features: { complexity: 'simple' } },
    { features: { nearWater: 'YES' } }, { features: { indoor: true } },
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
  const rowEdges = constants.LAWN_BRACKETS.st_augustine.map((r) => r[0]);
  const sizes = new Set([500, 1499, ...rowEdges, ...rowEdges.map((x) => x - 1), ...rowEdges.map((x) => x + 1), 4250, 12500, 20000, 20001, 25000, 30000]);
  for (const track of Object.keys(constants.LAWN_BRACKETS)) {
    for (const sqft of [...sizes].sort((a, b) => a - b)) {
      for (const tier of ['standard', 'enhanced', 'premium']) {
        const exp = expectLawn({ track, lawnSqFt: sqft, tier });
        const r = runEngine({ ...BASE, lawnSqFt: sqft, services: { lawn: { track, tier } } });
        const li = line(r.result, 'lawn_care');
        record(section, `${track} ${sqft}sf ${tier}`, { track, lawnSqFt: sqft, tier }, exp.perApp, li ? li.perApp : null, { extra: { annualExpected: exp.annual, annualActual: li ? li.annual : null, customQuote: li ? li.customQuoteFlag : null, basis: li ? li.pricingBasis : null } });
        if (li) flagIf(Math.abs(li.annual - exp.annual) > 0.005, 'P1', section, `annual ${track} ${sqft} ${tier}`, `annual ${li.annual} vs ${exp.annual}`);
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
  const edges = [7999, 8000, 11999, 12000, 17999, 18000, 34999, 35000, 43560, 60000];
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
  void edges;
  for (const features of [{ trees: 'heavy' }, { nearWater: true }, { pool: true }, { irrigation: true }, { trees: 'heavy', complexity: 'complex', nearWater: true, pool: true, irrigation: true }]) {
    const exp = expectMosquito({ homeSqFt: 2000, lotSqFt: 8000, features, program: 'seasonal9' });
    const r = runEngine({ ...BASE, lawnSqFt: undefined, features, services: { mosquito: { tier: 'seasonal9' } } });
    const li = line(r.result, 'mosquito');
    record(section, `features ${JSON.stringify(features)}`, features, exp.perVisit, li ? li.perVisit : null, { extra: { pressureExpected: exp.pressure, pressureActual: li ? li.pressureMultiplier ?? li.pressure : null } });
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
  const edges = [1750, 2750, 3750, 4750, 5750, 6750];
  const sizes = new Set([600, ...edges, ...edges.map((e) => e - 1), ...edges.map((e) => e + 1), 7750, 8750, 12000]);
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
  for (const sqft of [800, 1200, 1600, 2000, 2500, 3200, 4000, 6000]) {
    const exp = expectTermiteBait({ homeSqFt: sqft });
    const r = runEngine({ ...BASE, homeSqFt: sqft, services: { termite: { system: 'trelona' } } });
    const li = line(r.result, 'termite_bait');
    const install = li ? (li.installation?.price ?? li.installPrice ?? null) : null;
    const monthly = li ? (li.monitoring?.monthly ?? li.monthly ?? null) : null;
    record(section, `install footprint ${sqft}`, { homeSqFt: sqft }, exp.installPrice, install, { extra: { stationsExpected: exp.stations, stationsActual: li ? (li.stations ?? li.stationCount) : null, perimeterExpected: exp.perimeter, installMarkupOnMaterialOnly: exp.installMarkupOnMaterial, installLaborNotBilled: exp.installLabor } });
    record(section, `monitoring monthly footprint ${sqft}`, { homeSqFt: sqft }, exp.monitoringMonthly, monthly);
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
  flagIf(withPalms.monthly === noPalm.monthly && withPalmsServiceLine.monthly !== noPalm.monthly, 'P1', section, 'palm count ignored when supplied at property level', `30 palms at property level: ${withPalms.monthly}/mo (source ${withPalms.palmCountSource}); as service-line: ${withPalmsServiceLine.monthly}/mo; no palms: ${noPalm.monthly}/mo`);
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
  const wdo = line(runEngine({ ...BASE, services: { wdo: {} } }).result, 'wdo_inspection');
  record(section, 'WDO flat', {}, expectWdo().price, wdo ? wdo.price : null);
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
  for (const sqft of [1000, 2000, 4500, 8000, 12000]) {
    for (const depth of ['eighth', 'quarter']) {
      const exp = expectTopDressing(sqft, depth, false);
      const li = line(runEngine({ ...BASE, lawnSqFt: sqft, services: { topDressing: { depth, area: sqft } } }).result, 'top_dressing');
      record(section, `top dressing ${sqft}sf ${depth} (no recurring lawn → 65% treatable assumption)`, { sqft, depth }, exp.price, li ? li.price : null, { extra: { lawnEstExpected: exp.lawnEst, lawnEstActual: li ? li.lawnSqFt : null, material: exp.material, labor: exp.labor } });
    }
  }
  for (const sqft of [1000, 4500, 10000]) for (const spacing of [6, 9, 12]) {
    const exp = expectPlugging(sqft, spacing);
    const li = line(runEngine({ ...BASE, lawnSqFt: sqft, services: { plugging: { area: sqft, spacing } } }).result, 'plugging');
    record(section, `plugging ${sqft}sf ${spacing}in`, { sqft, spacing }, exp.price, li ? li.price : null, { extra: { plugs: exp.plugs, cost: exp.cost } });
  }
  // Palm injection
  for (const c of [{ treatmentType: 'nutrition', palmCount: 1 }, { treatmentType: 'nutrition', palmCount: 2 }, { treatmentType: 'nutrition', palmCount: 3 }, { treatmentType: 'insecticide', palmCount: 5, palmSize: 'large' }, { treatmentType: 'combo', palmCount: 10, palmSize: 'small' }, { treatmentType: 'nutrition', palmCount: 0 }, { treatmentType: 'nutrition', palmCount: -2 }, { treatmentType: 'nutrition', palmCount: 2.5 }, { treatmentType: 'combo', palmCount: 3 }]) {
    const exp = c.palmCount > 0 && Number.isInteger(c.palmCount) ? expectPalm(c) : null;
    const r = runEngine({ ...BASE, services: { palmInjection: c } });
    const li = line(r.result, 'palm_injection');
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
    const sumAfter = round2(res.lineItems.filter((l) => Number.isFinite(l.annualAfterDiscount)).reduce((s, l) => s + l.annualAfterDiscount, 0));
    record(section, `${combo.join('+')} summary recurringAnnualAfterDiscount vs Σ lines`, {}, sumAfter, res.summary.recurringAnnualAfterDiscount, { tolerance: 1.0 });
    record(section, `${combo.join('+')} monthly = annual/12`, {}, round2(res.summary.recurringAnnualAfterDiscount / 12), res.summary.recurringMonthlyAfterDiscount, { tolerance: 1.0 });
  }
  // Manual discount on top of Platinum (deepest permitted discount)
  const full = { pest: { frequency: 'quarterly' }, lawn: { track: 'st_augustine', tier: 'enhanced' }, mosquito: { tier: 'seasonal9' }, treeShrub: { tier: 'standard', treeCount: 6 } };
  const plat = runEngine({ ...BASE, bedArea: 2000, services: full }).result;
  const md = runEngine({ ...BASE, bedArea: 2000, services: full, manualDiscount: { type: 'PERCENT', value: 25, label: 'Audit test', internalReason: 'audit' } }).result;
  scenarios.push({ section, name: 'Platinum + 25% manual discount (stacked, uncapped by design)', expected: null, actual: null, status: 'engine_only', extra: { platinumAnnual: plat.summary.recurringAnnualAfterDiscount, withManual: md.summary.recurringAnnualAfterDiscount, manualDiscount: md.summary.manualDiscount ? { amount: md.summary.manualDiscount.amount, capReason: md.summary.manualDiscount.capReason ?? md.summary.manualDiscount.lawnCapReason ?? null } : null, marginWarnings: md.marginWarnings } });
  const fixedBig = runEngine({ ...BASE, bedArea: 2000, services: full, manualDiscount: { type: 'FIXED', value: 99999, label: 'Audit test', internalReason: 'audit' } }).result;
  scenarios.push({ section, name: 'Platinum + FIXED $99,999 manual discount (zeroes the estimate?)', expected: null, actual: fixedBig.summary.recurringAnnualAfterDiscount, status: 'engine_only', extra: { year1Total: fixedBig.summary.year1Total, manualDiscount: fixedBig.summary.manualDiscount && { amount: fixedBig.summary.manualDiscount.amount, value: fixedBig.summary.manualDiscount.value } } });
  flagIf(fixedBig.summary.recurringAnnualAfterDiscount <= 0.01, 'P2', section, 'FIXED manual discount can zero a Platinum estimate with no cap', `year1Total ${fixedBig.summary.year1Total}, recurringAnnualAfterDiscount ${fixedBig.summary.recurringAnnualAfterDiscount}`);
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
    { service: 'pest_control quarterly (2,000 sf)', revenuePerVisit: pestQ.perApp, visits: 4, modeledMinutes: 25, observed: RECORDED_VISIT_SPAN_MINUTES.pest_control_quarterly, materialPerVisit: pestMaterial, callbackRate: OBSERVED_PEST_CALLBACK_RATE, callbackMinutes: RECORDED_VISIT_SPAN_MINUTES.pest_re_service.median, setupFee: constants.PEST.initialFee },
    { service: 'lawn_care 9x st_augustine (4,500 sf)', revenuePerVisit: lawn9.perApp, visits: 9, modeledMinutes: lawnCostModeled.modeledMinutes, driveMinutes: lawnCostModeled.driveMinutes, observed: RECORDED_VISIT_SPAN_MINUTES.lawn_care_9x, materialPerVisit: lawnCostModeled.materialPerVisit, callbackReservePerVisit: 2 },
    { service: 'mosquito seasonal9 (8,000 sf lot)', revenuePerVisit: mosq.perVisit, visits: 9, modeledMinutes: 30, observed: null, materialPerVisit: mosq.materialPerVisit },
    { service: 'rodent_bait (2,000 sf)', revenuePerVisit: rod.perVisit, visits: 4, modeledMinutes: rod.stations * 5, observed: null, materialPerVisit: rod.stations * 1.5, extraAnnual: rod.stations * 7.5, setupFee: rod.setupFee },
    { service: 'tree_shrub 6x (1,440 sf beds, 6 trees)', revenuePerVisit: ts.perApp, visits: 6, modeledMinutes: ts.onSiteMin + 10, driveMinutes: 0, observed: null, materialPerVisit: round2(ts.materialCost / 6) },
    { service: 'termite_bait monitoring (2,000 sf)', revenuePerVisit: term.perApp, visits: 4, modeledMinutes: term.stations * 5, observed: null, materialPerVisit: term.stations * 1.5, extraAnnual: term.stations * 7.5, setupFee: term.installPrice, setupIsInstall: true },
  ];
  for (const row of rows) {
    for (const tier of ['bronze', 'silver', 'gold', 'platinum']) {
      const discount = constants.WAVEGUARD.tiers[tier].discount;
      const modeled = unitEconomics({ revenuePerVisit: row.revenuePerVisit, visits: row.visits, onSiteMinutes: row.modeledMinutes, driveMinutes: row.driveMinutes ?? constants.GLOBAL.DRIVE_TIME, materialPerVisit: row.materialPerVisit, consumablesPerVisit: row.callbackReservePerVisit || 0, adminAnnual: constants.GLOBAL.ADMIN_ANNUAL + (row.extraAnnual || 0), callbackRate: row.callbackRate || 0, callbackMinutes: row.callbackMinutes || 0, discountPct: discount });
      const observed = row.observed ? unitEconomics({ revenuePerVisit: row.revenuePerVisit, visits: row.visits, onSiteMinutes: row.observed.median, driveMinutes: 0 /* recorded span already contains drive — never re-added (MON-004) */, materialPerVisit: row.materialPerVisit, consumablesPerVisit: row.callbackReservePerVisit || 0, adminAnnual: constants.GLOBAL.ADMIN_ANNUAL + (row.extraAnnual || 0), callbackRate: row.callbackRate || 0, callbackMinutes: row.callbackMinutes || 0, discountPct: discount }) : null;
      const observedP75 = row.observed ? unitEconomics({ revenuePerVisit: row.revenuePerVisit, visits: row.visits, onSiteMinutes: row.observed.p75, driveMinutes: 0 /* recorded span already contains drive — never re-added (MON-004) */, materialPerVisit: row.materialPerVisit, consumablesPerVisit: row.callbackReservePerVisit || 0, adminAnnual: constants.GLOBAL.ADMIN_ANNUAL + (row.extraAnnual || 0), callbackRate: row.callbackRate || 0, callbackMinutes: row.callbackMinutes || 0, discountPct: discount }) : null;
      const firstYearRevenue = round2(modeled.revenueAnnual + (row.setupFee && !row.setupIsInstall ? row.setupFee : 0));
      out.push({ service: row.service, tier, discount, perVisitList: row.revenuePerVisit, visits: row.visits, renewalRevenue: modeled.revenueAnnual, firstYearRevenue, setupFee: row.setupFee || 0, modeledMinutes: row.modeledMinutes, observedMinutes: row.observed ? row.observed.median : null, observedN: row.observed ? row.observed.n : null, modeled, observed, observedP75 });
    }
  }
  return { section, rows: out };
}

function runCommercialMatrix() {
  const section = 'commercial';
  const cases = [
    { name: 'commercial pest office 5,000 sf', input: { ...BASE, homeSqFt: 5000, lotSqFt: 20000, isCommercial: true, propertyType: 'commercial', commercialRiskType: 'office_low', services: { pest: { frequency: 'monthly' } } } },
    { name: 'commercial lawn 60,000 sf turf', input: { ...BASE, homeSqFt: 5000, lotSqFt: 100000, lawnSqFt: 60000, isCommercial: true, propertyType: 'commercial', services: { lawn: {} } } },
    { name: 'commercial mosquito 40,000 sf lot', input: { ...BASE, homeSqFt: 5000, lotSqFt: 40000, isCommercial: true, propertyType: 'commercial', services: { mosquito: {} } } },
    { name: 'commercial one-time pest (manual quote?)', input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { oneTimePest: {} } } },
    { name: 'commercial WDO', input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { wdo: {} } } },
    { name: 'commercial german roach', input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { germanRoach: { severity: 'moderate' } } } },
    { name: 'commercial rodent bait', input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { rodentBait: {} } } },
    { name: 'commercial termite bait', input: { ...BASE, homeSqFt: 5000, isCommercial: true, propertyType: 'commercial', services: { termite: { system: 'trelona' } } } },
    { name: 'commercial tree & shrub', input: { ...BASE, homeSqFt: 5000, lotSqFt: 40000, bedArea: 6000, isCommercial: true, propertyType: 'commercial', services: { treeShrub: { tier: 'standard', treeCount: 20 } } } },
  ];
  for (const c of cases) {
    const r = runEngine(c.input);
    const lines = r.ok ? r.result.lineItems.map((l) => ({ service: l.service, annual: l.annual ?? null, price: l.price ?? null, perApp: l.perApp ?? l.perVisit ?? null, visits: l.visitsPerYear ?? l.visits ?? null, manualQuote: !!(l.quoteRequired || l.requiresCustomQuote || l.manualQuote), taxable: l.taxable ?? null, taxCategory: l.taxCategory ?? null, margin: l.margin ?? null, review: l.requiresManualReview ?? null })) : [];
    scenarios.push({ section, name: c.name, expected: null, actual: null, status: r.ok ? 'engine_only' : 'engine_error', extra: { engineError: r.ok ? null : r.error, tier: r.ok ? r.result.waveGuard.tier : null, lines } });
  }
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
  ];
  for (const c of cases) {
    const li = line(runEngine({ ...BASE, bedArea: 2000, services: c.services }).result, c.key);
    const visits = li.visitsPerYear ?? li.visits ?? li.frequency;
    const perApp = li.perApp ?? li.perVisit;
    scenarios.push({ section, name: `${c.key} ${JSON.stringify(c.services)} visits`, expected: c.visits, actual: visits, status: visits === c.visits ? 'match' : 'MISMATCH' });
    const identity = round2(perApp * visits);
    record(section, `${c.key} perApp × visits = annual (${c.visits})`, {}, identity, li.annual, { tolerance: visits * 0.005 + 0.01 });
    record(section, `${c.key} monthly × 12 = annual (${c.visits})`, {}, round2(li.monthly * 12), li.annual, { tolerance: 0.06 });
    const prepay = round2(li.monthly * 12); // converter: monthly_total × 12 rounded to cents (README §3)
    scenarios.push({ section, name: `${c.key} annual prepay base (monthly×12) vs annual`, expected: li.annual, actual: prepay, status: Math.abs(prepay - li.annual) <= 0.06 ? 'match' : 'MISMATCH', extra: { note: 'prepay discount 5% only on no-setup-fee mixes; pest/mosquito keep the $99 setup waiver' } });
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
  const before = JSON.parse(JSON.stringify({ PEST: { base: constants.PEST.base, floor: constants.PEST.floor }, GLOBAL: constants.GLOBAL, WAVEGUARD: { qualifyingServices: constants.WAVEGUARD.qualifyingServices, excluded: Object.keys(constants.WAVEGUARD.excludedFromPercentDiscount) }, TS: { marginTarget: constants.TREE_SHRUB.marginTarget, tiers: constants.TREE_SHRUB.tiers }, MOSQ: constants.MOSQUITO.basePrices, RODENT: constants.RODENT.baitBrackets }));
  try {
    const bridge = require(path.join(ENGINE_DIR, 'db-bridge'));
    const ok = await bridge.syncConstantsFromDB(db);
    const after = JSON.parse(JSON.stringify({ PEST: { base: constants.PEST.base, floor: constants.PEST.floor }, GLOBAL: constants.GLOBAL, WAVEGUARD: { qualifyingServices: constants.WAVEGUARD.qualifyingServices, excluded: Object.keys(constants.WAVEGUARD.excludedFromPercentDiscount) }, TS: { marginTarget: constants.TREE_SHRUB.marginTarget, tiers: constants.TREE_SHRUB.tiers }, MOSQ: constants.MOSQUITO.basePrices, RODENT: constants.RODENT.baitBrackets }));
    await db.destroy();
    return { synced: !!ok, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
  } catch (e) {
    await db.destroy().catch(() => {});
    return { synced: false, reason: e.message };
  }
}

function hardCodedRateInventory() {
  // Catalogue of every dollar / rate / minute constant that shapes a price (read from the live constants object).
  const G = constants.GLOBAL;
  return {
    labor: { LABOR_RATE: G.LABOR_RATE, DRIVE_TIME_MIN: G.DRIVE_TIME, ADMIN_ANNUAL: G.ADMIN_ANNUAL, MARGIN_FLOOR: G.MARGIN_FLOOR, MARGIN_TARGET_TS: G.MARGIN_TARGET_TS, lawnLaborMinutesBase: constants.LAWN_PRICING_V2.laborMinutesBase, lawnLaborMinutesPer1000: constants.LAWN_PRICING_V2.laborMinutesPer1000Sqft, lawnRouteDrive: constants.LAWN_PRICING_V2.routeDensityMinutes, pestOnSiteMinutes: { quarterly: 25, bimonthly: 25, monthly: 20 }, mosquitoOnSiteMinutes: 30, rodentBaitMinutesPerStation: 5, termiteInstallMinutesPerStation: 5, tsOnSiteFloorMinutes: 25, tsOverheadMinutesPerVisit: 10 },
    materials: { pestChemPerVisit: { talak: 1.3, taurus: 4.87, surfactant: 0.5 }, mosquito: constants.MOSQUITO.productCosts, mosquitoUsage: constants.MOSQUITO.productUsage, tsMaterialModel: constants.TREE_SHRUB.materialModel, termiteSystems: constants.TERMITE.systems, boraCare: { galCost: constants.SPECIALTY.boraCare.galCost, coverage: constants.SPECIALTY.boraCare.coverage }, preSlab: Object.fromEntries(Object.entries(constants.SPECIALTY.preSlabTermiticide.products).map(([k, v]) => [k, { containerCost: v.containerCost, containerOz: v.containerOz, ozPer10SqFt: v.productOzPer10SqFt }])), trenching: Object.fromEntries(Object.entries(constants.SPECIALTY.trenching.products).map(([k, v]) => [k, { containerCost: v.containerCost, containerOz: v.containerOz }])), foamCan: constants.SPECIALTY.foamDrill.canCost, plugCost: constants.SPECIALTY.plugging.costPerPlug, topDressSand: constants.SPECIALTY.topDressing.eighth.sandRate, dethatchPer1K: constants.SPECIALTY.dethatching.materialPer1K, bedBugPerRoom: constants.BED_BUG.chemical.materialPerRoomVisit1, palmInternalCost: constants.PALM.internalCostBasis },
    prices: { pestBase: constants.PEST.base, pestFloor: constants.PEST.floor, pestSetupFee: constants.PEST.initialFee, pestFreqMult: constants.PEST.frequencyDiscounts.v2, oneTimePest: constants.ONE_TIME.pest, mosquitoBase: constants.MOSQUITO.basePrices, rodentBrackets: constants.RODENT.baitBrackets, rodentSetup: constants.RODENT.baitSetupFee, rodentTrapping: constants.RODENT.trapping.standardPrice, termiteInstallMultiplier: constants.TERMITE.installMultiplier, termiteMonitoring: constants.TERMITE.monitoring, termiteBond: constants.TERMITE.bond, wdo: constants.SPECIALTY.wdo.brackets, germanRoach: constants.SPECIALTY.germanRoach.tiers, palm: { nutrition: constants.PALM.treatments.nutrition.pricePerPalm, insecticide: constants.PALM.treatments.insecticide.tiers, combo: constants.PALM.treatments.combo.tiers, minPerVisit: constants.PALM.minPerVisit }, waveguard: constants.WAVEGUARD.tiers, oneTimePerk: constants.WAVEGUARD.recurringCustomerOneTimePerk, prepayDiscount: constants.ANNUAL_PREPAY_DISCOUNT_PCT, deposit: constants.DEPOSIT, cardHold: constants.CARD_HOLD, inspectionCredit: constants.INSPECTION_CREDIT, urgency: constants.URGENCY, tsTiers: constants.TREE_SHRUB.tiers, lawnTiers: constants.LAWN_TIERS },
    marginDivisors: { plugging: constants.SPECIALTY.plugging.marginDivisor, topDressingEighth: constants.SPECIALTY.topDressing.eighth.marginDivisor, topDressingQuarter: constants.SPECIALTY.topDressing.quarter.marginDivisor, dethatching: constants.SPECIALTY.dethatching.marginDivisor, boraCare: constants.SPECIALTY.boraCare.marginDivisor, foamDrill: constants.SPECIALTY.foamDrill.marginDivisor, preSlabTermidor: constants.SPECIALTY.preSlabTermiticide.products.termidor_sc.marginDivisor, bedBugCostRatio: constants.BED_BUG.chemical.targetCostRatio, tsMarginTarget: constants.TREE_SHRUB.marginTarget, commercialTargetGrossMargin: constants.COMMERCIAL_PEST.targetGrossMargin, termiteInstallMarkup: constants.TERMITE.installMultiplier, trenchingProductPremiumMarkup: constants.SPECIALTY.trenching.productPremiumMultiplier },
  };
}

function markupVsMarginAudit() {
  // Sites that apply a MULTIPLIER (markup) rather than divide by (1 − margin). Reported, not judged: a markup is fine if labelled as one.
  return [
    { site: 'TERMITE.installMultiplier ×1.45 on install MATERIAL only (service-pricing.js priceTermiteBait)', kind: 'markup on material', equivalentMargin: round2(1 - 1 / constants.TERMITE.installMultiplier), note: 'install labor (5 min/station × $35) is excluded from the marked-up base; reported installMargin only' },
    { site: 'SPECIALTY.trenching.productPremiumMultiplier ×1.45 on chemical premium', kind: 'markup on incremental material', equivalentMargin: round2(1 - 1 / constants.SPECIALTY.trenching.productPremiumMultiplier), note: 'base install is $/LF, not cost-plus' },
    { site: 'BED_BUG.heat.subcontractMarkup ×1.25 on vendor cost', kind: 'markup (correctly named)', equivalentMargin: round2(1 - 1 / constants.BED_BUG.heat.subcontractMarkup) },
    { site: 'ONE_TIME.pest.multiplier ×2.2 on quarterly per-app', kind: 'price multiple (not cost-based)', equivalentMargin: null },
    { site: 'SPECIALTY.*.marginDivisor and TREE_SHRUB.marginTarget', kind: 'margin (price = cost ÷ (1 − m)) — correct', equivalentMargin: null },
  ];
}

async function main() {
  const dbInfo = await maybeSyncFromDb();
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

  const summary = {
    generatedAt: new Date().toISOString(),
    engineConstantsSource: dbInfo.synced ? 'pricing_config (DB overlay, read-only)' : 'constants.js (in-code defaults)',
    dbInfo,
    scenarioCount: scenarios.length,
    matches: scenarios.filter((s) => s.status === 'match').length,
    mismatches: scenarios.filter((s) => s.status === 'MISMATCH').length,
    noPrice: scenarios.filter((s) => s.status === 'NO_PRICE').length,
    engineOnly: scenarios.filter((s) => s.status === 'engine_only').length,
    findings,
  };

  const md = [];
  md.push('# Independent estimator pricing audit — run output');
  md.push('');
  md.push(`Generated ${summary.generatedAt}. Constants source: **${summary.engineConstantsSource}**.`);
  md.push(`Scenarios: ${summary.scenarioCount} · independent-vs-engine matches: ${summary.matches} · mismatches: ${summary.mismatches} · expected a price but the engine returned none: ${summary.noPrice} · engine-only observations: ${summary.engineOnly} (${summary.matches} + ${summary.mismatches} + ${summary.noPrice} + ${summary.engineOnly} = ${summary.matches + summary.mismatches + summary.noPrice + summary.engineOnly}).`);
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
  md.push('| service | tier | list/visit | renewal revenue | year-1 revenue | modeled min | gross margin (modeled) | markup (modeled) | recorded span median min (n) | gross margin at recorded median span | gross margin at recorded p75 span | contribution at recorded span (all-card) |');
  md.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const e of economics.rows) {
    md.push(`| ${e.service} | ${e.tier} | ${money(e.perVisitList)} | ${money(e.renewalRevenue)} | ${money(e.firstYearRevenue)} | ${e.modeledMinutes} | ${pct(e.modeled.grossMargin)} | ${pct(e.modeled.markup)} | ${e.observedMinutes ?? '—'}${e.observedN ? ` (${e.observedN})` : ''} | ${e.observed ? pct(e.observed.grossMargin) : '—'} | ${e.observedP75 ? pct(e.observedP75.grossMargin) : '—'} | ${e.observed ? pct(e.observed.contributionMargin) : '—'} |`);
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
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { expectPest, expectLawn, expectMosquito, expectRodentBait, expectTermiteBait, expectOneTimePest, expectTreeShrub, expectWdo, expectGermanRoach, expectFoamDrill, expectTopDressing, expectPlugging, expectPalm, expectTier, unitEconomics, lawnCostStack, RECORDED_VISIT_SPAN_MINUTES, OBSERVED_PEST_CALLBACK_RATE, hardCodedRateInventory, markupVsMarginAudit };
