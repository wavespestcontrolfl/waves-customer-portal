/**
 * Irrigation weekly email — SETUP variants (owner directive 2026-08-01).
 *
 * Pins the contract between the seed migration
 * (20260801200000_seed_irrigation_setup_email_templates.js) and the sender:
 * which variant each irrigation profile selects, that the copy never claims a
 * water balance we cannot compute, and — through the REAL render path with
 * REAL sender payloads — that both templates render with zero unresolved
 * placeholders.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260801200000_seed_irrigation_setup_email_templates');
const {
  buildWeeklyEmailDecision,
  TEMPLATE_SETUP_SCHEDULE,
  TEMPLATE_SETUP_SYSTEM,
  TEMPLATE_CUT_BACK,
} = require('../services/irrigation-weekly-email');

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/;

function seedRows(key) {
  const templateSeed = seed.__private.TEMPLATES.find((t) => t.key === key);
  const template = { id: `tmpl-${key}`, ...seed.__private.templateRow(templateSeed) };
  template.allowed_variables = JSON.parse(template.allowed_variables);
  template.required_variables = JSON.parse(template.required_variables);
  const version = {
    id: `ver-${key}`,
    subject: templateSeed.subject,
    preview_text: templateSeed.preview,
    blocks: templateSeed.blocks,
    text_body: '',
  };
  return { template, version };
}

const BASE = {
  firstName: 'Dana',
  grassType: 'st_augustine',
  weekEnding: '2026-08-02',
  et0Inches: 1.6,
  rainfallInches7d: 0.6,
  forecastRainInches: 0.4,
};

describe('irrigation setup email template seeds', () => {
  test('both variants sit on the suppressible service_operational stream', () => {
    expect(seed.__private.TEMPLATES.map((t) => t.key)).toEqual([
      'irrigation.weekly_setup_schedule',
      'irrigation.weekly_setup_system',
    ]);

    for (const templateSeed of seed.__private.TEMPLATES) {
      const row = seed.__private.templateRow(templateSeed);
      expect(row).toMatchObject({
        mode: 'service',
        audience: 'customer',
        purpose: 'lawn',
        // A watering check-in is NOT a required notice — unsubscribes and the
        // Seasonal Lawn Tips opt-out must both be honored.
        send_stream: 'service_operational',
        suppression_group_key: 'service_operational',
        status: 'active',
      });
      const required = JSON.parse(row.required_variables);
      expect(required).toEqual(
        expect.arrayContaining(['first_name', 'grass_label', 'rain_last_week', 'target_inches']),
      );
      // The numbers we do NOT have for these customers must never be required
      // — requiring one would make the send fail closed at render time.
      expect(required).not.toContain('irrigation_inches');
      expect(required).not.toContain('total_inches');
      expect(required).not.toContain('difference_inches');
    }
  });

  test('every referenced variable is allowed and every required variable is referenced', () => {
    for (const templateSeed of seed.__private.TEMPLATES) {
      const { template, version } = seedRows(templateSeed.key);
      const validation = EmailTemplates.validationFor(template, version);
      expect(validation.disallowed_variables).toEqual([]);
      expect(validation.missing_required_in_template).toEqual([]);
      expect(validation.ok).toBe(true);
    }
  });

  test.each([
    ['system on file but no inches', { irrigationSystem: true, irrigationInchesPerWeek: null }, TEMPLATE_SETUP_SCHEDULE, 'setup_schedule'],
    ['system on file, inches zeroed', { irrigationSystem: true, irrigationInchesPerWeek: 0 }, TEMPLATE_SETUP_SCHEDULE, 'setup_schedule'],
    ['nothing on file at all', { irrigationSystem: null, irrigationInchesPerWeek: null }, TEMPLATE_SETUP_SYSTEM, 'setup_system'],
    ['no prefs row (left join nulls)', {}, TEMPLATE_SETUP_SYSTEM, 'setup_system'],
    // An explicit false must not be read as "has a system", even with a stale
    // inches value still sitting in the column.
    ['system explicitly off, stale inches', { irrigationSystem: false, irrigationInchesPerWeek: 1.25 }, TEMPLATE_SETUP_SYSTEM, 'setup_system'],
  ])('%s → %s', (_label, profile, expectedKey, expectedReason) => {
    const decision = buildWeeklyEmailDecision({ ...BASE, ...profile });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(expectedKey);
    expect(decision.reason).toBe(expectedReason);
    // No balance is claimed: these payload keys must be absent entirely.
    expect(decision.payload.total_inches).toBeUndefined();
    expect(decision.payload.irrigation_inches).toBeUndefined();
    expect(decision.payload.difference_inches).toBeUndefined();
    expect(decision.payload.summary_line).toBeUndefined();
    // What we DO know is measured and present.
    expect(decision.payload.rain_last_week).toBe('0.6');
    expect(decision.payload.target_inches).toEqual(expect.any(String));
  });

  // codex #3138 r1 P2 — the sweep must agree with the lawn report, which
  // treats portal → turf profile → assessment as one fallback chain
  // (report-data.js buildLawnWaterContext). Emailing "we have no schedule for
  // you" to someone whose own report displays that number is the bug.
  describe('tech-recorded schedules count as a schedule', () => {
    test('a turf-profile reading routes to ADVICE, not a setup variant', () => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationInchesPerWeek: null,
        turfIrrigationInchesPerWeek: 1,
        rainfallInches7d: 2.1,
        forecastRainInches: 0.5,
      });
      expect(decision.templateKey).toBe(TEMPLATE_CUT_BACK);
      expect(decision.payload.irrigation_inches).toBe('1');
    });

    test('an assessment reading routes to ADVICE when nothing else exists', () => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationInchesPerWeek: null,
        turfIrrigationInchesPerWeek: null,
        assessmentIrrigationInchesPerWeek: 1,
        rainfallInches7d: 2.1,
        forecastRainInches: 0.5,
      });
      expect(decision.templateKey).toBe(TEMPLATE_CUT_BACK);
      expect(decision.payload.irrigation_inches).toBe('1');
    });

    test('PORTAL ENTRY WINS over a tech reading, matching the report', () => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationInchesPerWeek: 1,
        turfIrrigationInchesPerWeek: 3,
        assessmentIrrigationInchesPerWeek: 2,
        rainfallInches7d: 2.1,
        forecastRainInches: 0.5,
      });
      expect(decision.payload.irrigation_inches).toBe('1');
    });

    test('the portal toggle does NOT suppress a tech-recorded reading', () => {
      // The customer's own toggle only zeroes a value the customer entered.
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationSystem: false,
        irrigationInchesPerWeek: null,
        turfIrrigationInchesPerWeek: 1,
        rainfallInches7d: 2.1,
        forecastRainInches: 0.5,
      });
      expect(decision.shouldSend).toBe(true);
      expect(decision.templateKey).toBe(TEMPLATE_CUT_BACK);
    });

    test('…but it still suppresses a stale prefs-only reading', () => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationSystem: false,
        irrigationInchesPerWeek: 1.25,
      });
      expect(decision.reason).toBe('setup_system');
    });

    test.each([
      ['in_ground', TEMPLATE_SETUP_SCHEDULE],
      ['mixed', TEMPLATE_SETUP_SCHEDULE],
      // 'none' is knowledge that there is no system — do not ask for a run time.
      ['none', TEMPLATE_SETUP_SYSTEM],
      ['manual', TEMPLATE_SETUP_SYSTEM],
    ])('a turf irrigation_type of %s with no inches picks %s', (type, expected) => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationSystem: null,
        irrigationInchesPerWeek: null,
        turfIrrigationType: type,
      });
      expect(decision.templateKey).toBe(expected);
    });
  });

  test('a real schedule still routes to the advice templates, not a setup variant', () => {
    const decision = buildWeeklyEmailDecision({
      ...BASE,
      irrigationSystem: true,
      irrigationInchesPerWeek: 1,
      rainfallInches7d: 2.1,
      forecastRainInches: 0.5,
    });
    expect(decision.templateKey).toBe(TEMPLATE_CUT_BACK);
    expect(decision.payload.total_inches).toBeDefined();
  });

  test('an untrusted rainfall window sends nothing, exactly like the advice path', () => {
    // The setup copy quotes the week's rain, so an unknown window must stay
    // silent rather than print a number we do not have.
    const decision = buildWeeklyEmailDecision({
      ...BASE,
      irrigationSystem: true,
      irrigationInchesPerWeek: null,
      rainfallInches7d: null,
    });
    expect(decision.shouldSend).toBe(false);
    expect(decision.reason).toBe('rain_unknown');
  });

  test.each([
    [TEMPLATE_SETUP_SCHEDULE, { irrigationSystem: true, irrigationInchesPerWeek: null }, 'ADD MY WATERING SCHEDULE'],
    [TEMPLATE_SETUP_SYSTEM, { irrigationSystem: null, irrigationInchesPerWeek: null }, 'TELL US HOW YOU WATER'],
  ])('%s renders from the sender payload with no unresolved placeholders', (key, profile, cta) => {
    const decision = buildWeeklyEmailDecision({ ...BASE, ...profile });
    const { template, version } = seedRows(key);
    const rendered = EmailTemplates.renderTemplate({ template, version, payload: decision.payload });

    expect(rendered.missingPayload || []).toEqual([]);
    expect(rendered.subject).not.toMatch(PLACEHOLDER_RE);
    expect(rendered.html).not.toMatch(PLACEHOLDER_RE);
    expect(rendered.text).not.toMatch(PLACEHOLDER_RE);
    expect(rendered.html).toContain('Rain at your home last week');
    expect(rendered.html).toContain(cta);
    expect(rendered.html).toContain('tab=property');
    // The advice footer credits "the irrigation schedule you shared" — these
    // customers have not shared one, so that claim must not appear.
    expect(rendered.html).not.toContain('irrigation schedule you shared');
  });

  test('a failed forecast fetch leaves no leftover forecast paragraph', () => {
    const decision = buildWeeklyEmailDecision({
      ...BASE,
      irrigationSystem: true,
      irrigationInchesPerWeek: null,
      forecastRainInches: null,
    });
    const { template, version } = seedRows(TEMPLATE_SETUP_SCHEDULE);
    const rendered = EmailTemplates.renderTemplate({ template, version, payload: decision.payload });
    expect(rendered.html).not.toContain('Looking ahead');
    expect(rendered.html).not.toMatch(PLACEHOLDER_RE);
  });
});
