/**
 * Runtime-derived schedules in the weekly irrigation email.
 *
 * A customer whose portal carries minutes-per-zone × watering days × a single
 * head type (but no inches figure) must get a REAL balance — reported through
 * the confirm_schedule template with a {{schedule_note}} that says the number
 * was derived from their entries and which published rate was used. A
 * customer whose entries cannot convert must get the setup_schedule email
 * with a {{schedule_ask}} that names what IS on file and the ONE input still
 * missing (the 2026-08-17 reply: "my schedule is in the system").
 *
 * Also pins: the explicit inches entry outranks the derived figure; a derived
 * figure outranks a tech reading (it is the customer's own schedule); and the
 * migrated templates render both variables through the real renderer.
 */
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260801200000_seed_irrigation_setup_email_templates');
const copyMigration = require('../models/migrations/20260825000001_irrigation_schedule_copy_variables');
const {
  buildWeeklyEmailDecision,
  TEMPLATE_CONFIRM_SCHEDULE,
  TEMPLATE_SETUP_SCHEDULE,
  TEMPLATE_CUT_BACK,
  _private,
} = require('../services/irrigation-weekly-email');

const BASE = {
  firstName: 'Sam',
  grassType: 'st_augustine',
  weekEnding: '2026-08-23',
  et0Inches: 1.2,
  rainfallInches7d: 0.42,
  forecastRainInches: 3.08,
  irrigationSystem: true,
  irrigationInchesPerWeek: null,
};
const RUNTIME = { irrigationRunMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], irrigationSystemType: ['spray'] };

describe('derived schedule → confirm_schedule with a derived schedule_note', () => {
  test('20 min × 4 days on spray = 2" → confirm_surplus, math adds up as printed', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME });
    expect(d.shouldSend).toBe(true);
    expect(d.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
    expect(d.reason).toBe('confirm_surplus');
    expect(d.payload.schedule_inches).toBe('2');
    expect(d.payload.total_inches).toBe('2.42');
    expect(d.payload.target_inches).toBe('1');
    expect(d.payload.summary_line).toContain('your sprinkler schedule as entered in your portal (about 2" per week)');
    expect(d.payload.summary_line).not.toContain('on file for you');
    expect(d.payload.schedule_note).toBe(
      'We worked that 2" out from what you entered under Irrigation in your portal — 20 minutes per zone, 4 days a week on spray heads — using the typical spray heads rate from University of Florida turf guidance (about 1.5" per hour). If you know your actual weekly inches, enter them there and we\'ll use your number instead.',
    );
  });

  test('a rain-sensor customer\'s derived note discloses that skipped runs are not modeled', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME, rainSensor: true });
    expect(d.payload.schedule_note).toContain('rain sensor');
    expect(d.payload.schedule_note).toContain('assumes the full schedule ran');
    // No sensor → no disclaimer.
    const plain = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME });
    expect(plain.payload.schedule_note).not.toContain('rain sensor');
  });

  test('a tech reading keeps the seeded "came from our records" note verbatim', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, turfIrrigationInchesPerWeek: 1, rainfallInches7d: 2.1 });
    expect(d.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
    expect(d.payload.schedule_note).toBe(_private.TECH_SCHEDULE_NOTE);
    expect(d.payload.summary_line).toContain('watering schedule we have on file for you');
  });

  test('the customer\'s explicit inches entry outranks the derived figure (advice template, not confirm)', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME, irrigationInchesPerWeek: 1.5 });
    expect(d.templateKey).toBe(TEMPLATE_CUT_BACK);
    expect(d.payload.irrigation_inches).toBe('1.5');
    expect(d.payload.schedule_note).toBeUndefined();
  });

  test('a derived figure outranks a tech-recorded reading — it is the customer\'s own schedule', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME, turfIrrigationInchesPerWeek: 0.5 });
    expect(d.payload.schedule_inches).toBe('2');
    expect(d.payload.schedule_note).toContain('what you entered under Irrigation in your portal');
  });

  test('a zero-inch legacy value is "no schedule", not an authoritative entry — derivation still runs', () => {
    // buildIrrigationAdvice treats <= 0 as profileMissing, so honoring a zero
    // as explicit would send setup copy claiming minutes are missing while
    // they sit on file (pre-push audit P1 on eb840ef70).
    const d = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME, irrigationInchesPerWeek: 0 });
    expect(d.payload.schedule_inches).toBe('2');
    expect(d.payload.schedule_note).toContain('what you entered under Irrigation in your portal');
  });

  test('the portal toggle OFF suppresses a derived-only figure the same way it suppresses a typed one', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME, irrigationSystem: false });
    expect(d.reason).toBe('setup_system');
  });

  test('toggle OFF + tech-observed system + complete inputs → conflict copy, never "schedule absent"', () => {
    // hasSystem stays true via the technician's in_ground observation while
    // the toggle suppresses the derivation — the blocker is the switch, and
    // the ask must say so instead of claiming the schedule is missing.
    const d = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME, irrigationSystem: false, turfIrrigationType: 'in_ground' });
    expect(d.reason).toBe('setup_schedule');
    expect(d.payload.schedule_ask).toContain('switched off');
    expect(d.payload.schedule_ask).toContain("the schedule on file isn't being counted");
    expect(d.payload.schedule_ask).not.toContain('but not how');
  });

  test('toggle OFF with a coexisting tech reading falls through to the tech value, never the derived one', () => {
    // Without the toggle gate, the tech reading made onlyPrefsReading false
    // and the disabled derived schedule (2") silently won the balance over
    // the 0.5" tech fallback (GH codex P1 on #3478 r9).
    const d = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME, irrigationSystem: false, turfIrrigationInchesPerWeek: 0.5, rainfallInches7d: 2.1 });
    expect(d.payload.schedule_inches).toBe('0.5');
    expect(d.payload.schedule_note).toContain('came from our records');
  });
});

describe('non-convertible entries → setup_schedule with a specific schedule_ask', () => {
  const ask = (profile) => {
    const d = buildWeeklyEmailDecision({ ...BASE, ...profile });
    expect(d.templateKey).toBe(TEMPLATE_SETUP_SCHEDULE);
    expect(d.reason).toBe('setup_schedule');
    expect(d.payload.total_inches).toBeUndefined();
    return d.payload.schedule_ask;
  };

  test('days + heads on file, minutes missing → asks ONLY for minutes and names what we have', () => {
    const text = ask({ wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], irrigationSystemType: ['spray'] });
    expect(text).toBe("We have your sprinkler system on file — 4 watering days and spray heads — but not how many minutes each zone runs. Add that under Irrigation in your portal (or your weekly inches, if you know them) and these check-ins become real recommendations — ease back this week, add a few minutes, or you're right on track.");
  });

  test('minutes + days on file, head type missing → asks for the system type', () => {
    const text = ask({ irrigationRunMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'] });
    expect(text).toContain('4 watering days and 20 minutes per zone');
    expect(text).toContain('but not what kind of heads it uses');
    expect(text).toContain('pick your system type under Irrigation in your portal');
  });

  test('minutes + heads on file, days missing → asks for watering days', () => {
    const text = ask({ irrigationRunMinutes: 45, irrigationSystemType: ['rotor'] });
    expect(text).toContain('45 minutes per zone and rotor heads');
    expect(text).toContain('but not which days it runs');
  });

  test('two inputs missing → BOTH are asked for, never just the first blocker', () => {
    // Heads only on file: the derivation fails on minutes first, but asking
    // only for minutes sends the customer through a second setup email once
    // they comply (GH codex P1 on #3478 r2).
    const text = ask({ irrigationSystemType: ['spray'] });
    expect(text).toContain('spray heads');
    expect(text).toContain('which days it runs');
    expect(text).toContain('how many minutes each zone runs');
    expect(text).toContain('Add your watering days and minutes per zone under Irrigation in your portal');
  });

  test('minutes only on file → asks for days AND head type together', () => {
    const text = ask({ irrigationRunMinutes: 20 });
    expect(text).toContain('20 minutes per zone');
    expect(text).toContain('which days it runs');
    expect(text).toContain('what kind of heads it uses');
  });

  test('mixed head types → explains why we cannot convert and asks for inches', () => {
    const text = ask({ irrigationRunMinutes: 45, wateringDays: ['Mon'], irrigationSystemType: ['rotor', 'spray', 'drip'] });
    expect(text).toContain('on file as rotor heads, spray heads and drip');
    expect(text).toContain("we can't turn run time into inches on our own");
    expect(text).toContain('enter that under Irrigation in your portal');
  });

  test('legacy unknown head type with complete inputs → names the type, never claims run time is missing', () => {
    const text = ask({ irrigationRunMinutes: 20, wateringDays: ['Mon', 'Wed'], irrigationSystemType: ['bubbler'] });
    expect(text).toContain('"bubbler" isn\'t a head type we have a watering rate for');
    expect(text).toContain('20 minutes per zone');
    expect(text).not.toContain('how long or how often it runs');
  });

  test('implausible derived total (typo minutes) → asks to double-check, never claims a field is missing', () => {
    // 200 min × 7 days on spray = 35"/week — over the 5" ceiling shared
    // with the explicit Weekly Inches field (GH codex P1 on #3478 r12).
    const text = ask({ irrigationRunMinutes: 200, wateringDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], irrigationSystemType: ['spray'] });
    expect(text).toContain('more water each week than any lawn could use');
    expect(text).not.toContain('but not');
  });

  test('drip only → beds, not turf', () => {
    expect(ask({ irrigationRunMinutes: 30, wateringDays: ['Mon'], irrigationSystemType: ['drip'] })).toContain('waters beds rather than turf');
  });

  test('nothing beyond the toggle → the general ask (days, minutes, head type)', () => {
    const text = ask({});
    expect(text).toBe("We have a sprinkler system on file for you, but not how long or how often it runs. Add your watering days, minutes per zone and head type (or your weekly inches, if you know them) under Irrigation in your portal and these check-ins become real recommendations — ease back this week, add a few minutes, or you're right on track.");
  });

  test('setup_system carries an empty ask (no callout in that template)', () => {
    const d = buildWeeklyEmailDecision({ ...BASE, irrigationSystem: null });
    expect(d.reason).toBe('setup_system');
    expect(d.payload.schedule_ask).toBe('');
  });
});

describe('renders through the migrated templates', () => {
  // Seed rows for setup_schedule / confirm_schedule with the 20260825000001
  // migration's callout swap applied — the exact block shape prod carries
  // after the migration runs.
  function migratedRows(key) {
    const templateSeed = seed.__private.TEMPLATES.find((t) => t.key === key);
    const target = copyMigration.__private.TARGETS.find((t) => t.key === key);
    const template = { id: `tmpl-${key}`, ...seed.__private.templateRow(templateSeed) };
    template.allowed_variables = [...JSON.parse(template.allowed_variables), target.variable];
    template.required_variables = JSON.parse(template.required_variables);
    template.optional_variables = [...JSON.parse(template.optional_variables || '[]'), target.variable];
    const blocks = templateSeed.blocks.map((b) => (
      b.type === 'callout' && b.content === target.seededCallout ? copyMigration.__private.calloutFor(target.variable) : b
    ));
    expect(blocks.some((b) => b.content === `{{${target.variable}}}`)).toBe(true);
    const version = { id: `v-${key}`, template_id: template.id, subject: templateSeed.subject, preview_text: templateSeed.preview_text, blocks, text_body: null };
    return { template, version };
  }

  test('setup_schedule renders the per-customer ask in the callout, and validates', () => {
    const { template, version } = migratedRows(TEMPLATE_SETUP_SCHEDULE);
    expect(EmailTemplates.validationFor(template, version).ok).toBe(true);
    const d = buildWeeklyEmailDecision({ ...BASE, wateringDays: ['Mon', 'Wed'], irrigationSystemType: ['spray'] });
    const r = EmailTemplates.renderTemplate({ template, version, payload: d.payload });
    expect(r.missingPayload).toEqual([]);
    expect(r.text).toContain('2 watering days and spray heads');
    expect(r.html).toContain('but not how many minutes each zone runs');
    expect(r.html).not.toContain('{{');
  });

  test('confirm_schedule renders the derived note, and validates', () => {
    const { template, version } = migratedRows(TEMPLATE_CONFIRM_SCHEDULE);
    expect(EmailTemplates.validationFor(template, version).ok).toBe(true);
    const d = buildWeeklyEmailDecision({ ...BASE, ...RUNTIME });
    const r = EmailTemplates.renderTemplate({ template, version, payload: d.payload });
    expect(r.missingPayload).toEqual([]);
    expect(r.text).toContain('20 minutes per zone, 4 days a week on spray heads');
    expect(r.text).toContain('Watering schedule on file: 2" per week');
    expect(r.html).not.toContain('{{');
  });

  test('deploy window: the OLD sender (no variable in payload) still renders — callout dropped, send not rejected', () => {
    const { template, version } = migratedRows(TEMPLATE_SETUP_SCHEDULE);
    const d = buildWeeklyEmailDecision({ ...BASE });
    const { schedule_ask, ...oldPayload } = d.payload;
    const r = EmailTemplates.renderTemplate({ template, version, payload: oldPayload });
    expect(r.missingPayload).toEqual([]);
    expect(r.html).not.toContain('{{');
    // The variable callout renders NOTHING (renderBlocks drops an empty
    // block) — no stale seeded copy and no empty callout box.
    expect(r.text).not.toContain('sprinkler system on file');
  });
});
