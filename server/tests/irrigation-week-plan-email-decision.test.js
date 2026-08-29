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
    expect(d.payload.total_inches).toBe('2.6"'); // the plan template renders the unit from the payload (gh-r23)
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
    process.env.IRRIGATION_RESTRICTION_POLICY = JSON.stringify({ maxDaysPerWeek: 1, expiresOn: '2027-12-31', label: 'test year-round rule', coverage: 'all', hoursNote: 'before 10 a.m. or after 4 p.m.' });
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
    expect(src).toMatch(/const planWindowOpen = \(at\) => \{\s*const \{ dayOfWeek, hour \} = etParts\(at\);\s*return dayOfWeek === 1 && hour < PLAN_WINDOW_END_HOUR_ET;\s*\};/);
    expect(require('../services/irrigation-weekly-email').PLAN_WINDOW_END_HOUR_ET).toBe(12);
    // A late (legacy-path) retry still dedupes on the customer-week before sending.
    expect(src).toMatch(/if \(!decision\.weekPlan\) \{[\s\S]{0,700}summary\.deduped \+= 1;\s*continue;/); // gate-independent (hook P1 on 41705b745)
    // …and a pending (in-flight / ambiguous) delivery stops the legacy path too.
    expect(src).toMatch(/if \(priorLegacyPath\.state === 'pending'\) \{[\s\S]{0,400}continue;/);
    expect(src).toMatch(/const weekPlanEnabled = weekPlanGate && isMondayET;/);
    expect(src).toMatch(/summary\.plan\.late_retry \+= 1;/);
    // An UNKNOWN sent-check (unreadable table) still consults the durable customer-week record — sent/pending stop — before falling back to the pre-plan email.
    expect(src).toMatch(/if \(alreadySent === null\) \{[\s\S]{0,700}priorUnreadable\.state === 'sent'[\s\S]{0,200}priorUnreadable\.state === 'pending'[\s\S]{0,400}weekPlanEnabled: false/);
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

describe('sweep — settings follow the home; claim renewed on the queue transition (codex gh-r19)', () => {
  const fs = require('fs');
  const path = require('path');
  const sweep = fs.readFileSync(path.join(__dirname, '../services/irrigation-weekly-email.js'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, '../services/email-template-library.js'), 'utf8');
  test('settings saved before the home moved are withheld from the decision (all schedule inputs), and the plan email is told why', () => {
    // gh-r20/r21: confirmation is PER sizing field since the move — never the row-wide updated_at.
    // gh-r25: ONE shared resolver (irrigation-schedule-confirmation) for the sweep and the report,
    // over the prefs row PLUS the tech fallback figures the sweep selects.
    expect(sweep).toMatch(/const scheduleUnconfirmed = scheduleUnconfirmedAfterMove\(customer\);/);
    expect(sweep).toMatch(/require\('\.\/irrigation-schedule-confirmation'\)/);
    expect(sweep).not.toMatch(/prefs_updated_at|irrigation_settings_saved_at/);
    // gh-r22: the raw inputs still ride (the decision must route to the PLAN
    // renderer, never the "missing schedule" setup copy); the plan itself
    // drops the sizing fields + the former home's programmed total.
    expect(sweep).toMatch(/irrigationRunMinutes: customer\.irrigation_run_minutes,\s*wateringDays: customer\.watering_days,\s*irrigationSystemType: customer\.irrigation_system_type,/);
    expect(sweep).toMatch(/advice: scheduleUnconfirmed \? \{ \.\.\.advice, appliedInchesPerWeek: null \} : advice,/);
    for (const k of ['runMinutes: scheduleUnconfirmed \\? null : irrigationRunMinutes', 'wateringDays: scheduleUnconfirmed \\? null : wateringDays', 'systemType: scheduleUnconfirmed \\? null : irrigationSystemType', 'explicitInchesPerWeek: scheduleUnconfirmed \\? null : prefsInches', 'runMinutes: scheduleUnconfirmed \\? null : runtimeInputs\\.runMinutes']) {
      expect(sweep).toMatch(new RegExp(k));
    }
    expect(sweep).toMatch(/const lastWeekLine = scheduleUnconfirmed\s*\? `Rain near your home last week came to/);
    expect(sweep).toMatch(/'pp\.irrigation_confirmed_fields',\s*'pp\.irrigation_home_changed_at',/);
    expect(sweep).toMatch(/scheduleUnconfirmed,\s*\}\);/); // renderWeekPlanEmail ctx
  });
  test('the prior week\'s sent plan feeds the cool-season cadence', () => {
    expect(sweep).toMatch(/const priorWeek = weekPlanEnabled \? await loadPriorWeekPlan\(\{ customerId: customer\.id, weekEnding, home: \{ addressLine1: customer\.address_line1, addressLine2: customer\.address_line2, city: customer\.city, zip: customer\.zip \} \}\) : null;/);
    expect(sweep).toMatch(/const priorWeekPrescribedInches = priorWeek \? priorWeek\.prescribedInches : null;/);
    // A known move rides into the jurisdiction resolver (stale profile county rejected).
    expect(sweep).toMatch(/resolveRestrictionCounty\(\{ county: customer\.turf_county, profileCity: customer\.turf_city, city: customer\.city, zip: customer\.zip, homeMoved: !!customer\.irrigation_home_changed_at, movedAt: customer\.irrigation_home_changed_at \|\| null, countyConfirmed: countyConfirmedAfterMove\(customer\) \}\)/);
    expect(sweep).not.toMatch(/turf_updated_at|profileUpdatedAt/); // gh-r32: the row-wide timestamp is not a premise confirmation
    expect(sweep).toMatch(/planWeekEnd,\s*priorWeekEvents,\s*priorWeekPrescribedInches,\s*rainOnlyCarryover: scheduleUnconfirmed,\s*now,/);
  });
  test('the snapshot claim is renewed by the library\'s onQueued hook, fired right after the queued row lands', () => {
    // Fail closed: only an explicit true renewal dispatches (null = unverifiable ⇒ abort).
    // gh-r42: the HOME check runs first — the window-closed fallback rebuilds from loaded inputs, so a committed move must win over the cutoff.
    expect(sweep).toMatch(/onQueued: snapshotArgs\?\.claimToken\s*\? async \(\) => \{[\s\S]*?homeMovedAtQueue = true; return false; \}[\s\S]*?if \(!planWindowOpen\(tick\(\)\)\) \{ windowClosedAtQueue = true; return false; \}\s*claimRenewal = await renewWeekPlanClaimWithRetry\(\{ customerId: customer\.id, weekEnding, claimToken: snapshotArgs\.claimToken \}\);\s*return claimRenewal === true;\s*\}/);
    // gh-r40/r41: grass type and the rain-sensor flag are home-bound, each gated by its OWN ledger entry —
    // re-saving the sizing fields (which clears scheduleUnconfirmed) re-enables neither.
    expect(sweep).toMatch(/grassType: grassConfirmedAfterMove\(customer\) \? resolveGrassType\(customer\) : null,/);
    expect(sweep).toMatch(/rainSensor: rainSensorConfirmedAfterMove\(customer\) && \(customer\.rain_sensor === true \|\| customer\.rain_sensor === 't'\),/);
    // gh-r40: an unreadable stamp read at the queue transition fails CLOSED (plan withheld, counted claim_error, snapshot claimable).
    expect(sweep).toMatch(/stampCheckFailedAtQueue = true;\s*return false;/);
    expect(sweep).toMatch(/if \(stampCheckFailedAtQueue\) \{[\s\S]*?summary\.plan\.claim_error \+= 1;\s*continue;\s*\}/);
    // gh-r38: the move stamp is re-read at the queue transition; a changed stamp withholds the plan and sends nothing.
    expect(sweep).toMatch(/if \(homeMovedAtQueue\) \{[\s\S]*?summary\.plan\.home_moved \+= 1;[\s\S]*?await discardUnsentWeekPlan\(\{ customerId: customer\.id, weekEnding, claimToken: snapshotArgs\.claimToken \}\);\s*continue;\s*\}/);
    // gh-r38: each candidate is re-read through the SAME audience query at their turn.
    expect(sweep).toMatch(/const fresh = await findEligibleCustomers\(\{ now: startedAt, customerId: customer\.id \}\);\s*if \(!fresh\.length\) \{ summary\.skipped\.no_longer_eligible \+= 1; continue; \}/);
    // gh-r45: a move stamp that changed since the audience load = mid-transition row (coords may still be the
    // former home's — the address paths clear/re-geocode asynchronously) — the customer is skipped this run.
    expect(sweep).toMatch(/if \(stampMsAt\(fresh\[0\]\.irrigation_home_changed_at\) !== stampMsAt\(customer\.irrigation_home_changed_at\)\) \{\s*summary\.skipped\.home_moved_mid_sweep \+= 1;[\s\S]*?continue;\s*\}\s*customer = fresh\[0\];/);
    // gh-r33: the plan window is judged PER CUSTOMER from the live clock, never once at sweep start.
    expect(sweep).toMatch(/for \(let customer of candidates\) \{[\s\S]*?const planAsOf = tick\(\);\s*const isMondayET = planWindowOpen\(planAsOf\);\s*const weekPlanEnabled = weekPlanGate && isMondayET;/);
    expect(sweep).not.toMatch(/const planAsOf = now;/);
    expect(sweep).toMatch(/const tick = clock \|\| \(now \? \(\) => now : \(\) => new Date\(\)\);/);
    // gh-r35: a plan that misses the cutoff at the queue transition is withheld AND the pre-plan
    // check-in still goes out in THIS run (the Monday cron is the only scheduled run).
    expect(sweep).toMatch(/let result = await dispatch\(\);\s*if \(result\.aborted && windowClosedAtQueue\) \{[\s\S]*?summary\.plan\.window_closed \+= 1;[\s\S]*?await discardUnsentWeekPlan\(\{ customerId: customer\.id, weekEnding, claimToken: snapshotArgs\.claimToken \}\);\s*decision = buildWeeklyEmailDecision\(\{ \.\.\.decisionInputs, forecastRainInches, forecastEt0Inches, weekPlanEnabled: false \}\);\s*snapshotArgs = null;\s*windowClosedAtQueue = false;[\s\S]*?result = await dispatch\(\);\s*\}/);
    expect(lib).toMatch(/\.where\(\{ id: message\.id, status: 'queued', send_attempt_token: sendAttemptToken \}\)\s*\.update\(\{ status: 'failed', error_message: reason/);
    // A LOST claim aborts inside the library; the sweep counts it claimed_elsewhere and stamps nothing (gh-r20).
    // …an UNREADABLE renewal (null after retries) is counted claim_error and logged, never claimed_elsewhere (hook P1 on 45beb0731).
    expect(sweep).toMatch(/if \(result\.aborted\) \{[\s\S]*?if \(claimRenewal === null\) \{[^}]*summary\.plan\.claim_error \+= 1;\s*logger\.error\([^)]*claim renewal unreadable[^)]*\);\s*continue;\s*\}\s*summary\.plan\.claimed_elsewhere \+= 1;\s*continue;\s*\}/);
    expect(lib).toMatch(/keep = \(await onQueued\(message\)\) !== false;/);
    // gh-r21: the new owner retries a momentary EMAIL_SEND_IN_PROGRESS collision instead of losing the week's email.
    expect(sweep).toMatch(/if \(err\?\.code !== 'EMAIL_SEND_IN_PROGRESS' \|\| attempt >= IN_PROGRESS_RETRIES\) throw err;/);
    expect(sweep).toMatch(/const IN_PROGRESS_RETRIES = 3;/);
    expect(lib).toMatch(/return \{ sent: false, aborted: true, reason, message: aborted \|\| \{ \.\.\.message, status: 'failed', error_message: reason \}, rendered \};/);
    const queued = lib.indexOf("[message] = await db('email_messages').insert(queuedPayload).returning('*');");
    const hook = lib.indexOf("if (typeof onQueued === 'function') {", queued);
    const send = lib.indexOf('sendOne(', hook);
    expect(queued).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(queued);
    expect(send === -1 || send > hook).toBe(true);
  });
});

describe('buildWeeklyEmailDecision — a moved home routes to the PLAN (events-only) with the reconfirm note (codex gh-r22)', () => {
  const { buildWeeklyEmailDecision, TEMPLATE_WEEK_PLAN } = require('../services/irrigation-weekly-email');
  const base = {
    // Monday 2026-08-31 (inside the checked-in policy, effective 08-27).
    firstName: 'Dana', grassType: 'st_augustine', weekEnding: '2026-08-30',
    irrigationInchesPerWeek: null, irrigationSystem: true,
    irrigationRunMinutes: 20, wateringDays: ['Mon'], irrigationSystemType: ['spray'],
    rainfallInches7d: 0.2, et0Inches: 1.5, forecastRainInches: 0.1, forecastEt0Inches: 1.4,
    weekPlanEnabled: true, county: 'Manatee', planWeekEnd: '2026-09-06', now: new Date('2026-08-31T11:00:00Z'),
    home: { addressLine1: '1 Main St', city: 'Bradenton', zip: '34205' },
  };
  test('confirmed: minutes-based plan; unconfirmed: same template, events-only, note explains, no schedule quoted', () => {
    const ok = buildWeeklyEmailDecision(base);
    expect(ok.templateKey).toBe(TEMPLATE_WEEK_PLAN);
    expect(ok.weekPlan.minutesPerEvent).not.toBe(null);
    const moved = buildWeeklyEmailDecision({ ...base, scheduleUnconfirmed: true });
    expect(moved.templateKey).toBe(TEMPLATE_WEEK_PLAN); // never the setup copy
    expect(moved.weekPlan.minutesPerEvent).toBe(null);
    // Generic UF fallback cycle, never the former home's own minutes phrasing.
    expect(moved.payload.week_plan).toMatch(/one full cycle on each turf zone/);
    expect(moved.payload.week_plan).not.toMatch(/run each turf zone/);
    expect(ok.payload.week_plan).toMatch(/run each turf zone/);
    expect(moved.payload.plan_note).toContain('Your address changed after your sprinkler settings were saved');
    expect(moved.payload.summary_line).toMatch(/^Rain near your home last week came to/);
    expect(moved.decisionInputs.scheduleUnconfirmed).toBe(true);
    expect(moved.decisionInputs.runMinutes ?? null).toBe(null);
    // gh-r23: the details block never quotes the former home's setting / a mixed total.
    expect(moved.payload.irrigation_inches).toBe('Not on file — re-enter after your move');
    expect(moved.payload.total_inches).toMatch(/^0\.2" \(rain only\)$/);
    expect(ok.payload.irrigation_inches).toMatch(/^[\d.]+"$/);
    expect(ok.payload.total_inches).toMatch(/^[\d.]+"$/);
    expect(moved.decisionInputs.rainOnlyCarryover).toBe(true);
    expect(ok.decisionInputs.rainOnlyCarryover).toBe(false);
  });
  test('a tech-recorded schedule after a move reaches the PLAN in plan mode, never the confirm-schedule copy (codex gh-r26)', () => {
    const { TEMPLATE_CONFIRM_SCHEDULE } = require('../services/irrigation-weekly-email');
    const tech = { ...base, irrigationRunMinutes: null, wateringDays: null, irrigationSystemType: null, turfIrrigationInchesPerWeek: 1.1 };
    expect(buildWeeklyEmailDecision(tech).templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE); // confirmed tech reading keeps the ask
    const moved = buildWeeklyEmailDecision({ ...tech, scheduleUnconfirmed: true });
    expect(moved.templateKey).toBe(TEMPLATE_WEEK_PLAN);
    expect(moved.payload.irrigation_inches).toBe('Not on file — re-enter after your move');
    expect(moved.payload.plan_note).toContain('Your address changed after your sprinkler settings were saved');
  });

  test('from the second plan week on, last week\'s irrigation is what the delivered plan prescribed, not the programmed schedule (codex gh-r31)', () => {
    const held = buildWeeklyEmailDecision({ ...base, irrigationInchesPerWeek: 2, priorWeekPrescribedInches: 0 });
    expect(held.templateKey).toBe(TEMPLATE_WEEK_PLAN);
    expect(held.decisionInputs.appliedInches).toBe(0.2); // prior plan depth 0 + the 0.2" of observed rain (gh-r32)
    expect(held.decisionInputs.priorWeekPrescribedInches).toBe(0);
    expect(held.weekPlan.carryoverInches).toBe(0); // no manufactured surplus from the superseded 2"/wk schedule
    expect(held.payload.summary_line).toMatch(/last week's watering plan \(0" of irrigation\)/);
    expect(held.payload.irrigation_inches).toBe('0" (last week\'s plan)');
    expect(held.payload.total_inches).toBe('0.2"');
    const first = buildWeeklyEmailDecision({ ...base, irrigationInchesPerWeek: 2 });
    expect(first.decisionInputs.appliedInches).toBeGreaterThan(0);
    expect(first.payload.summary_line).not.toMatch(/last week's watering plan/);
  });

  test('a prior plan\'s depth is added to the OBSERVED rain — a held week after heavy rain still carries the surplus (codex gh-r32)', () => {
    // No rain sensor: last week's applied water = prior plan irrigation + rain.
    const wet = buildWeeklyEmailDecision({ ...base, irrigationInchesPerWeek: 2, priorWeekPrescribedInches: 0, rainfallInches7d: 2.5 });
    expect(wet.templateKey).toBe(TEMPLATE_WEEK_PLAN);
    expect(wet.decisionInputs.appliedInches).toBe(2.5);
    expect(wet.decisionInputs.priorWeekPrescribedInches).toBe(0);
    expect(wet.weekPlan.carryoverInches).toBe(0.5); // root-zone cap, from the rain alone
    expect(wet.weekPlan.reasons).toContain('prior_week_overwatered');
    expect(wet.decisionInputs.priorWeekRainOverride).toBe(false); // a HOLD prescribed no run to skip (gh-r34)
    expect(wet.payload.summary_line).toMatch(/last week's watering plan \(0" of irrigation\), your lawn got about 2\.5"/);
    const ran = buildWeeklyEmailDecision({ ...base, irrigationInchesPerWeek: 2, priorWeekPrescribedInches: 0.75, rainfallInches7d: 0.2 });
    expect(ran.decisionInputs.appliedInches).toBe(0.95);
    expect(ran.decisionInputs.priorWeekCreditedInches).toBe(0.75);
    expect(ran.decisionInputs.priorWeekRainOverride).toBe(false);
    expect(ran.payload.total_inches).toBe('0.95"');
    // gh-r34: ≥ ½" of observed rain means the prior plan's own rule said SKIP the run — its depth is not credited (unknown = 0), rain still counts.
    const skipped = buildWeeklyEmailDecision({ ...base, irrigationInchesPerWeek: 2, priorWeekPrescribedInches: 0.75, rainfallInches7d: 0.6 });
    expect(skipped.decisionInputs.priorWeekRainOverride).toBe(true);
    expect(skipped.decisionInputs.priorWeekCreditedInches).toBe(0);
    expect(skipped.decisionInputs.appliedInches).toBe(0.6);
    expect(skipped.weekPlan.carryoverInches).toBe(0); // 0.6" against a peak target: no manufactured surplus
    // The copy states the rule + accounting, never that the run was skipped (unknowable from a weekly total).
    expect(skipped.payload.summary_line).toMatch(/enough to trigger last week's plan's skip-the-run rule, so only the rain is counted \(if the run went ahead anyway, your lawn is a little ahead, not behind\)/);
    expect(skipped.payload.summary_line).not.toMatch(/said to skip|was skipped/);
    expect(skipped.payload.irrigation_inches).toBe('0" (last week\'s plan — rain-skip rule)');
    expect(skipped.payload.total_inches).toBe('0.6"');
    expect(skipped.decisionInputs.priorWeekSkippedRunInches).toBe(0.75); // unknown event count ⇒ nothing credited
    // gh-r35: the rule skips ONE run — a two-run plan (2 × 0.5") after 0.6" of rain keeps the other run's 0.5".
    const twoRun = buildWeeklyEmailDecision({ ...base, irrigationInchesPerWeek: 2, priorWeekEvents: 2, priorWeekPrescribedInches: 1, rainfallInches7d: 0.6 });
    expect(twoRun.decisionInputs.priorWeekRainOverride).toBe(true);
    expect(twoRun.decisionInputs.priorWeekSkippedRunInches).toBe(0.5);
    expect(twoRun.decisionInputs.priorWeekCreditedInches).toBe(0.5);
    expect(twoRun.decisionInputs.appliedInches).toBe(1.1);
    expect(twoRun.payload.summary_line).toMatch(/skip-one-run rule, so the rain plus one run \(0\.5" of irrigation\) is counted, about 1\.1" of water in all \(if both runs went ahead/);
    expect(twoRun.payload.irrigation_inches).toBe('0.5" (last week\'s plan — one run under the rain-skip rule)');
    expect(twoRun.payload.total_inches).toBe('1.1"');
    const oneRun = buildWeeklyEmailDecision({ ...base, irrigationInchesPerWeek: 2, priorWeekEvents: 1, priorWeekPrescribedInches: 0.75, rainfallInches7d: 0.6 });
    expect(oneRun.decisionInputs.priorWeekCreditedInches).toBe(0);
    expect(oneRun.payload.irrigation_inches).toBe('0" (last week\'s plan — rain-skip rule)');
    const under = buildWeeklyEmailDecision({ ...base, irrigationInchesPerWeek: 2, priorWeekPrescribedInches: 0.75, rainfallInches7d: 0.4 });
    expect(under.decisionInputs.priorWeekRainOverride).toBe(false);
    expect(under.decisionInputs.appliedInches).toBe(1.15);
    // Untrusted rain never joins the total (same rule as the advice engine).
    const { decideWeekPlan } = require('../services/irrigation-week-plan');
    const { plan, decisionInputs } = decideWeekPlan({ advice: { rainKnown: false, appliedInchesPerWeek: null, recommendedInchesPerWeek: 0.75 }, grassType: 'st_augustine', forecastEt0Inches: 1.4, lastWeekRainInches: 2.5, priorWeekPrescribedInches: 0, county: 'Manatee', planWeekEnd: '2026-09-06', now: new Date('2026-08-31T11:00:00Z') });
    expect(decisionInputs.appliedInches).toBe(0);
    expect(plan.carryoverInches).toBe(0);
  });

  test('a PARTIAL former-home schedule in plan mode reaches the setup ask without quoting the stale minutes/days (codex gh-r32)', () => {
    const { TEMPLATE_SETUP_SCHEDULE } = require('../services/irrigation-weekly-email');
    const partial = { ...base, irrigationRunMinutes: 20, wateringDays: ['Mon', 'Thu'], irrigationSystemType: null };
    const stale = buildWeeklyEmailDecision(partial);
    expect(stale.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(stale.payload.schedule_ask).toMatch(/2 watering days/);
    expect(stale.payload.schedule_ask).toMatch(/20 minutes per zone/);
    const moved = buildWeeklyEmailDecision({ ...partial, scheduleUnconfirmed: true });
    expect(moved.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(moved.payload.schedule_ask).toMatch(/^Your address changed after your sprinkler settings were saved/);
    expect(moved.payload.schedule_ask).not.toMatch(/2 watering days|20 minutes|Mon|Thu/);
    expect(moved.payload.schedule_ask).toMatch(/Add your watering days, minutes per zone and head type/);
    // Gate off: the wrapper withholds the same inputs before the decision.
    const legacy = buildWeeklyEmailDecision({ ...partial, scheduleUnconfirmed: true, weekPlanEnabled: false });
    expect(legacy.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(legacy.payload.schedule_ask).not.toMatch(/2 watering days|20 minutes/);
  });

  test('every LEGACY path withholds the former home\'s schedule (gate off / late retry / plan unavailable) → the setup ask, never stale totals (codex gh-r24)', () => {
    const { TEMPLATE_SETUP_SCHEDULE } = require('../services/irrigation-weekly-email');
    // Gate off (or a Tue–Sun late retry: the sweep passes weekPlanEnabled:false).
    const legacy = buildWeeklyEmailDecision({ ...base, weekPlanEnabled: false, scheduleUnconfirmed: true });
    expect(legacy.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(legacy.payload.irrigation_inches).toBeUndefined();
    expect(JSON.stringify(legacy.payload)).not.toMatch(/20 min/);
    // Confirmed legacy still balances the schedule.
    expect(buildWeeklyEmailDecision({ ...base, weekPlanEnabled: false }).templateKey).not.toBe(TEMPLATE_SETUP_SCHEDULE);
    // Plan mode but no policy in force (Charlotte = partial coverage) → same withholding, not a fall-through.
    const noPolicy = buildWeeklyEmailDecision({ ...base, county: 'Charlotte', scheduleUnconfirmed: true });
    expect(noPolicy.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(buildWeeklyEmailDecision({ ...base, county: 'Charlotte' }).templateKey).not.toBe(TEMPLATE_SETUP_SCHEDULE);
  });
});
