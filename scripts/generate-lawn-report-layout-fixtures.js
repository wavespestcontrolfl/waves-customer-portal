#!/usr/bin/env node
'use strict';

/**
 * Synthetic lawn report payloads for the layout preview (GATE_LAWN_REPORT_LAYOUT).
 *
 * No database, no network, no model call. Starts from the saved lawn payload
 * client/src/pages/__fixtures__/lawn-report-v2.json and runs it through the REAL server
 * builders (the watering instruction and banner, the v6 copy, the reconciliation pass that derives
 * reportV2.lead), so the preview renders payloads shaped like production ones. Three visits:
 *
 *   spot      a spot fungicide visit with a finding: spray hold, a label mow hold, timed re-entry
 *   granular  a granular visit: water-in amount with no sprinkler setup on file, a re-entry CONDITION
 *   clean     a clean visit: nothing for the customer to do
 *
 * Two more for GATE_LAWN_REPORT_POLISH (the Water card's third state and one label line per product card), each
 * written as `<name>-base.json` (the gate off: what prints today) and `<name>-polish.json` (the gate on):
 *
 *   mixed     rotor + spray + drip heads, 45 min, Mondays, no weekly inches: the third state ("45 min, Mondays")
 *   single    one rotor head type (plus drip), 45 min, Mondays: a derived figure with its basis line
 *   fourday   spray heads only, 15 min on four days, one spray product, no banner: a derived figure and the longer-cycles line
 *   rainwet   6 inches of rain on two days + a 0.75 inch schedule (GATE_LAWN_WATER_RAIN): "rain covered" with the sensor line
 *   raindry   a 0.2 inch week + a 0.5 inch schedule: the new deficit sentence
 *   rainnone  6 inches of rain, nothing on file: "rain covered", the schedule call to action stays
 *   nothing   no irrigation entries at all: today's card ("Not on file"), the button moved to the Irrigation section
 *   (both visits carry a granule watered in, a spray and a surfactant, so the product cards show the label lines)
 *
 * Each is written twice: `<name>-off.json` (the payload with the layout gate off) and
 * `<name>-on.json` (the same payload plus the key the server adds while the gate is live).
 *
 *   node scripts/generate-lawn-report-layout-fixtures.js
 *
 * Synthetic names and addresses only (this repository is public).
 */

const fs = require('fs');
const path = require('path');

// Gates that are live in production for lawn reports. The layout gate is set per output file.
process.env.GATE_LAWN_REPORT_LEAD = 'true';
process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
process.env.GATE_LAWN_PROGRAM_DETAIL = 'true';
process.env.GATE_LAWN_REPORT_CLARITY = 'true';

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'client/src/pages/__fixtures__/lawn-report-v2.json');
const OUT_DIR = path.join(ROOT, 'client/src/pages/__fixtures__/lawn-layout');

const { buildWateringInstruction, SETUP_INVITE_LINE } = require('../server/services/service-report/lawn-watering-instruction');
const { buildWateringBanner } = require('../server/services/service-report/report-data');
const { applyLawnReportReconciliation } = require('../server/services/service-report/report-consistency');
const { buildLawnCopyV6 } = require('../server/services/service-report/lawn-copy-v6');
const { buildAftercare } = require('../server/services/service-report/lawn-report-v2');
const { lawnLayoutPayload } = require('../server/services/service-report/lawn-report-layout');
const { buildReentryContextFromRecord } = require('../server/services/service-report/reentry');
const facts = require('../server/services/service-report/lawn-report-facts');
const { buildLawnWaterContext } = require('../server/services/service-report/report-data');
const { mapWater, buildLawnReportV2 } = require('../server/services/service-report/lawn-report-v2');
const { lawnPolishPayload } = require('../server/services/service-report/lawn-report-polish');
const { waterAdviceBlock, attachLongerCycles } = require('../server/services/service-report/lawn-longer-cycles');

const COMPLETED_AT = '2026-10-09T14:56:39.602Z';
const VISIT_DAY = '2026-10-09';
// "Now" for the preview (the harness freezes the page clock to the same instant).
const NOW = new Date('2026-10-09T15:10:00.000Z');
const NEXT_VISIT = { label: 'Friday, October 23', source: 'scheduled' };

const clone = (value) => JSON.parse(JSON.stringify(value));

function setVisitDate(data) {
  data.serviceDate = `${VISIT_DAY}T00:00:00.000Z`;
  data.lawnAssessment.scores.assessmentDate = `${VISIT_DAY}T14:56:39.602Z`;
  Object.assign(data, {
    actual_start_time: '2026-10-09T14:08:12.087Z',
    actual_end_time: COMPLETED_AT,
    arrived_at: '2026-10-09T14:08:12.087Z',
    completed_at: COMPLETED_AT,
    check_in_time: '2026-10-09T14:08:12.087Z',
    check_out_time: COMPLETED_AT,
  });
  data.visitTiming = { ...data.visitTiming, arrivedAt: '2026-10-09T14:08:12.087Z', exitedAt: COMPLETED_AT };
  (data.applications || []).forEach((app) => { app.appliedAt = COMPLETED_AT; });
  data.reportV2.snapshot.nextVisit = NEXT_VISIT;
}

// "Your plan" with the next lawn visit and a Reschedule link (GATE_REPORT_PLAN_RESCHEDULE).
function setPlan(data) {
  data.planSummary = { visitsThisYear: 8, reservicesThisYear: 0, tier: 'Gold' };
  data.upcomingVisitsCard = {
    merged: true,
    visits: [{ scheduledDate: '2026-10-23', serviceType: 'Lawn Care', rescheduleUrl: '/reschedule/sample-visit' }],
  };
  data.reserviceEligible = true;
}

// The banner and the aftercare note, built the way report-data builds them from the visit's frozen
// watering instruction (no rules = no instruction = no banner).
function attachBanner(data, rules, { amountOnly = false, runtime = null } = {}) {
  const instruction = buildWateringInstruction({ rules, completedAt: COMPLETED_AT, runtime, plainWhenNoSetup: amountOnly });
  const banner = buildWateringBanner(instruction, null);
  if (banner && amountOnly) banner.setupLine = SETUP_INVITE_LINE;
  if (banner) data.reportV2.banner = banner; else delete data.reportV2.banner;
  data.reportV2.aftercare = buildAftercare(data.applications, { instruction, weekPlan: data.reportV2.water && data.reportV2.water.weekPlan });
}

// The v6 copy as report-data hands it to the reconciliation pass (a non-enumerable carrier).
function attachCopyV6(data) {
  const { fields } = buildLawnCopyV6(data.reportV2, { visitDate: VISIT_DAY, nextVisitGapDays: 14 });
  Object.defineProperty(data.reportV2, 'copyV6', {
    value: { ...fields, whatToExpectStatic: fields.whatToExpect }, enumerable: false, writable: true, configurable: true,
  });
}

function setTreatment(data, products) {
  data.reportV2.treatment = { ...data.reportV2.treatment, products, focus: products.map((p) => p.focus), kinds: products.map((p) => p.kind) };
  data.reportV2.snapshot.todaysFocus = products.map((p) => p.focus);
  data.reportV2.snapshot.treatmentSummary = `Today we applied ${products.map((p) => p.name).join(' and ')}.`;
}

// The re-entry context exactly as the server builds it from a record (reentry.js): timed targets from the
// stored advisory minutes, or, when the record froze a re-entry rule (GATE_LAWN_REPORT_FACTS), a CONDITION.
function reentryFromRecord({ exteriorMinutes = null, petAdvisory = null, frozenRows = null } = {}) {
  const record = {
    applications: [{ appliedAt: COMPLETED_AT, application_method: 'broadcast_spray' }],
    // an explicit exterior treatment zone (the traced map), which is what makes the exterior timer apply
    tracedExteriorZone: true,
    advisory: exteriorMinutes ? JSON.stringify({ exterior_reentry_min: exteriorMinutes, ...(petAdvisory ? { pet_advisory: petAdvisory } : {}) }) : null,
    structured_notes: frozenRows
      ? JSON.stringify({ [facts.FREEZE_KEY]: facts.buildReportFacts({ rows: frozenRows, run: null, assessment: null, techFindings: [], withTies: false, now: NOW }) })
      : '{}',
    timezone: 'America/New_York',
  };
  return buildReentryContextFromRecord(record, NOW);
}

// A spot row's frozen card text ("Spot treatment, about 250 sq ft"), from the facts module's own freeze.
function spotAreaUse(data, row) {
  const block = facts.buildReportFacts({ rows: [row], run: null, assessment: null, techFindings: [], withTies: false, recordedSpotAreas: new Set([row.product_id]), now: NOW });
  const texts = facts.frozenProductUseTexts({ [facts.FREEZE_KEY]: block });
  Object.assign(data.applications[0], facts.areaUseFields(texts, { id: row.id }));
}

function finish(data, { reentry }) {
  data.dynamicContext = { reentry };
  attachCopyV6(data);
  applyLawnReportReconciliation(data, data.dynamicContext);
  return data;
}

function spot(base) {
  const data = clone(base);
  setVisitDate(data);
  setPlan(data);
  setTreatment(data, [
    { name: 'Headway G', activeIngredient: 'Azoxystrobin and propiconazole', kind: 'fungicide', focus: 'Disease protection', whatItDoes: 'protects the turf from disease', targets: ['gray leaf spot'], area: '300 sq ft' },
  ]);
  attachBanner(data, [{ name: 'Headway G', rule: { mode: 'hold', hold_until: 'dry', source: 'label' }, mowHoldDays: 1 }]);
  spotAreaUse(data, { id: 'spot-row-1', product_id: '3f2c1a10-0000-4000-8000-00000000a001', application_method: 'spot_treatment', area_value: 250, area_unit: 'sqft' });
  // Timed re-entry from the stored advisory (45 minutes after the application), built by reentry.js.
  return finish(data, { reentry: reentryFromRecord({ exteriorMinutes: 45, petAdvisory: 'Keep pets off treated turf until it is fully dry.' }) });
}

function granular(base) {
  const data = clone(base);
  setVisitDate(data);
  setPlan(data);
  setTreatment(data, [
    { name: 'Arena 50 WDG', activeIngredient: 'Clothianidin', kind: 'insecticide', focus: 'Insect control', whatItDoes: 'controls lawn insects', targets: ['chinch bugs'], area: '4,800 sq ft' },
  ]);
  // No height-of-cut reading this visit: the mowing line comes from the per-grass table.
  data.reportV2.mowing = null;
  attachBanner(data, [{ name: 'Arena 50 WDG', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_hours: 24, source: 'label' } }], { amountOnly: true });
  // A frozen re-entry rule (a granule the program waters in) read back by reentry.js: a CONDITION, no clock.
  return finish(data, {
    reentry: reentryFromRecord({
      frozenRows: [{
        id: 'gran-row-1',
        application_method: 'granular_broadcast',
        approved_report_product_facts: {
          wateringRule: { mode: 'water_in' },
          reentrySummary: 'Stay off treated areas until the product has been watered in and the turf is dry.',
        },
      }],
    }),
  });
}

function clean(base) {
  const data = clone(base);
  setVisitDate(data);
  setPlan(data);
  setTreatment(data, [
    { name: 'LESCO K-Flow 0-0-25', activeIngredient: 'Potassium chelate', kind: 'fertilizer', focus: 'Feeding', whatItDoes: 'feeds the turf', targets: [], area: '4,800 sq ft' },
  ]);
  attachBanner(data, []);
  data.reportV2.insights = [{
    priority: 1, status: 'healthy', category: 'overall', headline: 'Your lawn is holding steady',
    whatWeSaw: 'Even color and a full canopy across the lawn.', whyItMatters: 'A thick lawn crowds out weeds on its own.',
    wavesAction: 'Applied the scheduled insect preventative.', customerAction: null, nextVisitPlan: null, confidence: 'tech_confirmed',
  }];
  data.reportV2.snapshot.watching = [];
  data.reportV2.snapshot.statusHeadline = 'Healthy and steady';
  data.reportV2.snapshot.customerAction = null;
  data.reportV2.snapshot.rootCause = null;
  data.reportV2.snapshot.wavesNext = null;
  data.reportV2.mowing = { ...data.reportV2.mowing, status: 'ideal', measuredHeightInches: 3.8, recommendation: 'Mowing height looks good — right in the ideal range for your St. Augustine lawn.' };
  data.reportV2.followUp = { scheduled: false };
  data.reportV2.water = { ...data.reportV2.water, coverageWatch: false, weekPlan: null };
  // A 10-minute timed re-entry that has finished by the preview's clock.
  return finish(data, { reentry: reentryFromRecord({ exteriorMinutes: 10 }) });
}

function write(name, data) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const off = clone(data);
  fs.writeFileSync(path.join(OUT_DIR, `${name}-off.json`), `${JSON.stringify(off, null, 2)}\n`);
  process.env.GATE_LAWN_REPORT_LAYOUT = 'true';
  const on = { ...clone(data), ...lawnLayoutPayload({ serviceLine: 'lawn', reportV2: data.reportV2, lawnAssessment: data.lawnAssessment, mowingHeight: null }) };
  delete process.env.GATE_LAWN_REPORT_LAYOUT;
  fs.writeFileSync(path.join(OUT_DIR, `${name}-on.json`), `${JSON.stringify(on, null, 2)}\n`);
}


// ── GATE_LAWN_REPORT_POLISH scenarios ───────────────────────────────────────
// The catalog strings the cards really carry (migrations, approve-5.sql, reentry-9.sql).
const DRY_LINE = 'Stay off treated areas until the application has dried.';
const WATERED_IN_LINE = 'Stay off treated areas until the product has been watered in and the turf is dry.';
const CATALOG = [
  {
    id: 'polish-row-granule', name: 'LESCO Dimension 0.21% 18-0-10', method: 'granular_broadcast', category: 'Fertilizer',
    precaution: 'Granules on sidewalks or driveways are swept back into the turf. Water in with about ½ inch within 24 hours. People and pets can use the lawn once it has been watered in and the turf is dry.',
    reentry: WATERED_IN_LINE, rule: { mode: 'water_in', water_in_inches: 0.5, water_in_hours: 24, source: 'label' },
  },
  {
    id: 'polish-row-spray', name: 'Gravex 20 EW', method: 'broadcast_spray', category: 'Fungicide',
    precaution: 'Per the product label: keep people and pets off treated areas until sprays have dried.',
    reentry: DRY_LINE, rule: { mode: 'none', source: 'label' },
  },
  {
    id: 'polish-row-surfactant', name: 'LESCO 90/10 Nonionic Surfactant', method: 'broadcast_spray', category: 'Surfactant',
    precaution: 'Used only as part of a spray mix — the precautions of the products it is mixed with apply.',
    reentry: DRY_LINE, rule: { mode: 'none', source: 'label' },
  },
];

const factRow = (item) => ({
  id: item.id,
  application_method: item.method,
  approved_report_product_facts: { wateringRule: item.rule, reentrySummary: item.reentry, precautionSummary: item.precaution },
});

// The water section exactly as the report builders make it from the customer's portal entries.
function realWater(prefs, polish) {
  if (polish) process.env.GATE_LAWN_REPORT_POLISH = 'true'; else delete process.env.GATE_LAWN_REPORT_POLISH;
  const context = buildLawnWaterContext({ turfProfile: { grass_type: 'st_augustine' }, propertyPrefs: prefs, serviceDate: VISIT_DAY, completionRainfall7dInches: 1.2 });
  const water = mapWater(context, null);
  delete process.env.GATE_LAWN_REPORT_POLISH;
  return water;
}

// The scenarios: the customer's portal entries and the products on the visit.
const SPRAY_ONLY = [CATALOG[1]];
const entries = (extra) => ({ irrigation_run_minutes: 45, watering_days: ['Mon'], irrigation_system: true, ...extra });
const POLISH_SPECS = {
  mixed: { catalog: CATALOG, prefs: entries({ irrigation_system_type: ['rotor', 'spray', 'drip'] }) },
  single: { catalog: CATALOG, prefs: entries({ irrigation_system_type: ['rotor', 'drip'] }) },
  fourday: { catalog: SPRAY_ONLY, prefs: entries({ irrigation_run_minutes: 15, watering_days: ['Mon', 'Tue', 'Thu', 'Fri'], irrigation_system_type: ['spray'] }) },
  nothing: { catalog: CATALOG, prefs: null },
  // GATE_LAWN_WATER_RAIN: "base" = no frozen permission (today's card), "polish" = the permission frozen at completion.
  rainwet: { catalog: SPRAY_ONLY, prefs: { irrigation_inches_per_week: 0.75, irrigation_system: true }, rain: [0, 0, 3, 3, 0, 0, 0] },
  raindry: { catalog: SPRAY_ONLY, prefs: { irrigation_inches_per_week: 0.5, irrigation_system: true }, rain: [0, 0, 0, 0.2, 0, 0, 0] },
  rainnone: { catalog: SPRAY_ONLY, prefs: null, rain: [0, 0, 3, 3, 0, 0, 0] },
};

// The water section of a rain scenario, from the real builders: the context with the week's daily rain, then the report
// builder with (on) or without (off) the permission the completion froze.
function rainWater(spec, on) {
  const daily = spec.rain.map((inches, i) => ({ date: `2026-10-${String(3 + i).padStart(2, '0')}`, inches }));
  const waterContext = buildLawnWaterContext({
    turfProfile: { grass_type: 'st_augustine' }, propertyPrefs: spec.prefs, serviceDate: VISIT_DAY,
    completionRainfall7dInches: spec.rain.reduce((a, b) => a + b, 0), completionDailyRain: daily,
  });
  const report = buildLawnReportV2({ lawnAssessment: { scores: {}, waterContext }, applications: [], rainAdvice: on ? { rainCard: true, sensorLine: true } : null });
  return { water: report.water, rain7d: daily.map((day) => ({ d: new Date(`${day.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }), in: day.inches })) };
}

function polishVisit(base, { catalog, prefs, polish, rain = null }) {
  const data = clone(base);
  setVisitDate(data);
  setPlan(data);
  setTreatment(data, catalog.map((item) => ({ name: item.name, activeIngredient: '', kind: 'fertilizer', focus: item.category, whatItDoes: '', targets: [], area: '4,800 sq ft' })));
  data.applications = catalog.map((item) => {
    const app = clone(base.applications[0]);
    return {
      ...app,
      id: item.id,
      method: item.method,
      product: { ...app.product, name: item.name, category: item.category, facts_approved: true, precaution_summary: item.precaution, reentry_summary: item.reentry },
      appliedAt: COMPLETED_AT,
    };
  });
  data.reportV2.mowing = null;
  if (rain) {
    const scenario = rainWater({ prefs, rain }, polish);
    data.reportV2.water = scenario.water;
    data.reportV2.rain7d = scenario.rain7d;
  } else {
    data.reportV2.water = realWater(prefs, polish);
  }
  attachBanner(data, catalog.map((item) => ({ name: item.name, rule: item.rule })), {
    runtime: prefs ? { runMinutes: prefs.irrigation_run_minutes, wateringDays: prefs.watering_days, headTypes: prefs.irrigation_system_type, explicitInchesPerWeek: null } : null,
  });
  // The facts block the lawn write gate freezes at completion (the label-lines and longer-cycles parts only while the
  // gate is live), then the same read-back the report build does: the re-entry condition, the one-line precaution of
  // each card, and the longer-cycles line (render-time conditions included).
  const prefsRow = prefs ? { ...prefs, sod_laid_on: null, sod_covers: null, sod_area: null, sod_rooted_on: null } : null;
  const block = facts.buildReportFacts({
    rows: catalog.map(factRow), run: null, assessment: null, techFindings: [], withTies: false, withLabelLines: polish && !rain,
    waterAdvice: polish && !rain ? waterAdviceBlock(prefsRow, VISIT_DAY) : null, now: NOW,
  });
  const notes = { [facts.FREEZE_KEY]: block };
  const drops = facts.frozenLabelDropsFor('lawn', JSON.stringify(notes));
  data.applications.forEach((app) => { app.product.precaution_summary = facts.precautionForCard(drops, { id: app.id }, app.product.precaution_summary); });
  attachLongerCycles(data.reportV2, facts.frozenLongerCycles('lawn', JSON.stringify(notes)));
  const reentry = buildReentryContextFromRecord({
    applications: [{ appliedAt: COMPLETED_AT, application_method: catalog[0].method }],
    structured_notes: JSON.stringify(notes),
    timezone: 'America/New_York',
  }, NOW);
  return finish(data, { reentry });
}

function writePolish(name, base) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const polish of [false, true]) {
    const data = polishVisit(base, { ...POLISH_SPECS[name], polish });
    process.env.GATE_LAWN_REPORT_LAYOUT = 'true';
    if (polish && !POLISH_SPECS[name].rain) process.env.GATE_LAWN_REPORT_POLISH = 'true';
    const out = {
      ...clone(data),
      ...lawnLayoutPayload({ serviceLine: 'lawn', reportV2: data.reportV2, lawnAssessment: data.lawnAssessment, mowingHeight: null }),
      ...(POLISH_SPECS[name].rain ? {} : lawnPolishPayload({ serviceLine: 'lawn', reportV2: data.reportV2 })),
    };
    delete process.env.GATE_LAWN_REPORT_LAYOUT;
    delete process.env.GATE_LAWN_REPORT_POLISH;
    fs.writeFileSync(path.join(OUT_DIR, `${name}-${polish ? 'polish' : 'base'}.json`), `${JSON.stringify(out, null, 2)}\n`);
  }
}

function main() {
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  write('spot', spot(base));
  write('granular', granular(base));
  write('clean', clean(base));
  Object.keys(POLISH_SPECS).forEach((name) => writePolish(name, base));
  process.stdout.write(`Wrote fixtures to ${path.relative(ROOT, OUT_DIR)}\n`);
  process.exit(0);
}

main();
