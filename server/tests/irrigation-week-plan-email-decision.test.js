/**
 * buildWeeklyEmailDecision under GATE_IRRIGATION_WEEK_PLAN: the subject /
 * heading / action line come from THIS week's plan, the summary from LAST
 * week's balance (two separate outputs), on the one weekly_plan template; an
 * unavailable plan falls back to the pre-plan template; gate off = untouched.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.raw = jest.fn((e) => e); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  buildWeeklyEmailDecision, TEMPLATE_WEEK_PLAN, TEMPLATE_CUT_BACK, TEMPLATE_ON_TRACK, TEMPLATE_CONFIRM_SCHEDULE,
} = require('../services/irrigation-weekly-email');

const NOW = new Date('2026-08-28T12:00:00Z');
const BASE = {
  firstName: 'Sam', grassType: 'st_augustine', weekEnding: '2026-08-23', et0Inches: 1.6,
  rainfallInches7d: 0.6, forecastRainInches: 0.3, irrigationSystem: true, irrigationInchesPerWeek: 2,
  irrigationRunMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], irrigationSystemType: ['spray'],
  weekPlanEnabled: true, county: 'Manatee', forecastEt0Inches: 1.6, now: NOW,
};

describe('weekly email decision — plan mode', () => {
  test('surplus last week + 1-day cap → weekly_plan template, plan_run reason, last-week summary kept separate', () => {
    const d = buildWeeklyEmailDecision(BASE);
    expect(d.shouldSend).toBe(true);
    expect(d.templateKey).toBe(TEMPLATE_WEEK_PLAN);
    expect(d.reason).toBe('plan_run');
    expect(d.advice.status).toBe('surplus');
    expect(d.weekPlan.action).toBe('run');
    expect(d.restriction.maxDaysPerWeek).toBe(1);
    // The snapshot carries the inputs the decision saw (report comparisons use these).
    expect(d.decisionInputs).toMatchObject({ runMinutes: 20, headTypes: ['spray'], forecastRainInches: 0.3, scheduleSource: 'portal', rainfallInches7d: 0.6 });
    expect(d.decisionInputs.home).toBeNull(); // the sweep supplies the home; a bare decision records none
    // Last week's story stays in summary_line; the plan owns subject/heading/callout.
    expect(d.payload.summary_line).toMatch(/more than the .* your St\. Augustine needs/);
    // Typed 2" ÷ (20 min × 4 days) = a MEASURED 1.5 in/hr; need = 1.25 − ½"
    // carryover = ¾" in one permitted run → exactly 30 minutes (no "about").
    expect(d.payload.plan_subject).toBe('This week: 30 minutes per turf zone, Sam');
    expect(d.weekPlan.rateSource).toBe('measured');
    expect(d.payload.week_plan).toContain('turf zone');
    expect(d.payload.restriction_note).toContain('one day a week');
    // Numbers block still fed; "needs right now" is THIS week's target (the plan's).
    expect(d.payload.total_inches).toBe('2.6');
    expect(d.payload.target_inches).toBe(String(d.weekPlan.targetInches));
    expect(d.payload.target_inches).toBe('1.25');
  });

  test('≥ ½" forecast → plan_conditional and the forecast_line is folded into the action line', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, forecastRainInches: 1.4 });
    expect(d.reason).toBe('plan_conditional');
    expect(d.payload.forecast_line).toBe('');
    expect(d.payload.week_plan).toContain('leave the turf irrigation off for now');
  });

  test('hold: a big surplus against a small cool-season target (season from NOW, January)', () => {
    // The checked-in order is not in force in January — a year-round policy
    // is configured for this case (the fail-closed path is pinned separately).
    process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ maxDaysPerWeek: 1, expiresOn: '2027-12-31', label: 'test year-round rule', coverage: 'all' });
    let d;
    try {
      d = buildWeeklyEmailDecision({ ...BASE, weekEnding: '2026-01-18', et0Inches: 0.8, forecastEt0Inches: 0.8, rainfallInches7d: 1.5, now: new Date('2026-01-19T12:00:00Z') });
    } finally {
      delete process.env.IRRIGATION_RESTRICTION_POLICY;
    }
    expect(d.weekPlan.season).toBe('cool');
    expect(d.reason).toBe('plan_hold');
    expect(d.payload.plan_subject).toBe('Skip your turf watering this week, Sam');
  });

  test('no policy in force → pre-plan template with weekPlanUnavailable, still a send', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, now: new Date('2026-10-05T12:00:00Z') });
    expect(d.templateKey).toBe(TEMPLATE_CUT_BACK);
    expect(d.weekPlanUnavailable).toBe('restriction_policy_missing');
    expect(d.weekPlan).toBeUndefined();
  });

  test('jurisdiction not established (no county) → pre-plan template, never a global legal instruction', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, county: null });
    expect(d.templateKey).toBe(TEMPLATE_CUT_BACK);
    expect(d.weekPlanUnavailable).toBe('restriction_policy_missing');
  });

  test('gate off → exactly the pre-plan decision', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, weekPlanEnabled: false });
    expect(d.templateKey).toBe(TEMPLATE_CUT_BACK);
    expect(d.payload.plan_subject).toBeUndefined();
    expect(d.weekPlan).toBeUndefined();
  });

  test('a DERIVED schedule gets the plan in plan mode, with its provenance in the note', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, irrigationInchesPerWeek: null });
    expect(d.templateKey).toBe(TEMPLATE_WEEK_PLAN);
    expect(d.payload.summary_line).toContain('your sprinkler schedule as entered in your portal (about 2" per week)');
    expect(d.payload.plan_note).toContain('We worked that 2" out from what you entered under Irrigation in your portal');
    expect(d.payload.plan_note).not.toContain('Minutes assume'); // provenance already states the assumed rate
    // Sensor + derived: the provenance keeps the PAST-week upper-bound
    // disclosure, and the generic future-skip line is dropped (not both).
    const sensor = buildWeeklyEmailDecision({ ...BASE, irrigationInchesPerWeek: null, rainSensor: true });
    expect(sensor.payload.plan_note).toContain('some of those runs may have been skipped after rain');
    expect(sensor.payload.plan_note).toContain('read it as the most your system would have applied');
    expect(sensor.payload.plan_note).not.toContain('will skip a run on its own');
    // Gate off → the derived schedule still confirms, exactly as before.
    expect(buildWeeklyEmailDecision({ ...BASE, irrigationInchesPerWeek: null, weekPlanEnabled: false }).templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
  });

  test('tech-sourced schedule keeps confirm_schedule even in plan mode', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, irrigationInchesPerWeek: null, irrigationRunMinutes: null, turfIrrigationInchesPerWeek: 1 });
    expect(d.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
  });

  test('balanced week, dry forecast → still a plan (never the on-track template) in plan mode', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, irrigationInchesPerWeek: 0.75, irrigationRunMinutes: null, rainfallInches7d: 0.5, forecastRainInches: 0 });
    expect(d.templateKey).toBe(TEMPLATE_WEEK_PLAN);
    expect(d.templateKey).not.toBe(TEMPLATE_ON_TRACK);
    expect(d.payload.summary_line).toContain('right in line with');
  });
});

describe('sweep — plan mode only on Monday', () => {
  test('a Tue–Sun retry falls back to the pre-plan templates (late_retry counted)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../services/irrigation-weekly-email.js'), 'utf8');
    expect(src).toMatch(/const isMondayET = dayOfWeek === 1 && hour < PLAN_WINDOW_END_HOUR_ET;/);
    expect(require('../services/irrigation-weekly-email').PLAN_WINDOW_END_HOUR_ET).toBe(12);
    // A late (legacy-path) retry still dedupes on the customer-week before sending.
    expect(src).toMatch(/if \(weekPlanGate && !decision\.weekPlan\) \{[\s\S]{0,600}summary\.deduped \+= 1;\s*continue;/);
    // …and a pending (in-flight / ambiguous) delivery stops the legacy path too.
    expect(src).toMatch(/if \(priorLegacyPath\.state === 'pending'\) \{[\s\S]{0,400}continue;/);
    expect(src).toMatch(/const weekPlanEnabled = weekPlanGate && isMondayET;/);
    expect(src).toMatch(/summary\.plan\.late_retry \+= 1;/);
    // An UNKNOWN sent-check (unreadable table) falls back to the pre-plan email too.
    expect(src).toMatch(/if \(alreadySent === null\) \{[\s\S]{0,400}weekPlanEnabled: false/);
    // The sweep binds the home (address + coords) it decided for into the snapshot.
    expect(src).toMatch(/home: \{ addressLine1: customer\.address_line1, addressLine2: customer\.address_line2, city: customer\.city, zip: customer\.zip, latitude: customer\.latitude, longitude: customer\.longitude \}/);
    // A snapshot-claim DB error falls back to the pre-plan email (never silence) — and the hash is assigned only on a successful claim.
    expect(src).toMatch(/if \(claim\.error\) \{[\s\S]{0,400}weekPlanEnabled: false/);
    expect(src).toMatch(/\} else \{\s*snapshotArgs\.decisionHash = claim\.hash;\s*\}/);
    // The sweep passes the plan week's Sunday so the restriction must cover the whole week.
    expect(src).toMatch(/planWeekEnd,\s*now: planAsOf,/);
    // Delivery reconciliation is customer/week scoped (trigger_event_id)…
    expect(src).toMatch(/weekPlanDeliveryState\(\{ triggerEventId, idempotencyKey \}\)/);
    // …and a prior delivery ends the customer's turn: never a second email on a new recipient key.
    expect(src).toMatch(/if \(prior\.state === 'sent'\) \{[\s\S]{0,600}summary\.deduped \+= 1;\s*continue;/);
  });
});
