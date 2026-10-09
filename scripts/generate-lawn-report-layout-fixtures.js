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

const COMPLETED_AT = '2026-10-09T14:56:39.602Z';
const VISIT_DAY = '2026-10-09';
const NEXT_VISIT = { label: 'Fri, Oct 23', source: 'scheduled' };

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
function attachBanner(data, rules, { amountOnly = false } = {}) {
  const instruction = buildWateringInstruction({ rules, completedAt: COMPLETED_AT, runtime: null, plainWhenNoSetup: amountOnly });
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
  return finish(data, {
    reentry: {
      generatedAt: COMPLETED_AT,
      displayTimezone: 'America/New_York',
      customerSummary: 'Lawn areas ready at 4:30 PM.',
      petAdvisory: 'Keep pets off treated turf until it is fully dry.',
      targets: [{ key: 'lawn', label: 'Lawn areas', readyAt: '2026-10-09T20:30:00.000Z' }],
    },
  });
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
  // The shape the re-entry builder returns once a lawn visit freezes a condition (no clock).
  return finish(data, {
    reentry: {
      generatedAt: COMPLETED_AT,
      displayTimezone: 'America/New_York',
      targets: [],
      condition: {
        rule: 'watered_in_and_dry',
        text: 'Ready to walk on once today’s treatment has dried and, after you water it in, the grass is dry again — your technician confirms timing.',
        pets: 'Keep people and pets off the lawn until then.',
        statusLabel: 'After watering in',
      },
      petAdvisory: 'Keep people and pets off the lawn until then.',
      customerSummary: 'Ready to walk on once today’s treatment has dried and, after you water it in, the grass is dry again — your technician confirms timing.',
    },
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
  return finish(data, {
    reentry: {
      generatedAt: COMPLETED_AT,
      displayTimezone: 'America/New_York',
      customerSummary: 'Treated areas are ready for normal use.',
      targets: [{ key: 'lawn', label: 'Lawn areas', readyAt: '2026-10-09T15:00:00.000Z' }],
    },
  });
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

function main() {
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  write('spot', spot(base));
  write('granular', granular(base));
  write('clean', clean(base));
  process.stdout.write(`Wrote fixtures to ${path.relative(ROOT, OUT_DIR)}\n`);
  process.exit(0);
}

main();
