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
  TEMPLATE_CONFIRM_SCHEDULE,
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
  test('all three variants sit on the suppressible service_operational stream', () => {
    expect(seed.__private.TEMPLATES.map((t) => t.key)).toEqual([
      'irrigation.weekly_setup_schedule',
      'irrigation.weekly_setup_system',
      'irrigation.weekly_confirm_schedule',
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
      // The SETUP variants have no schedule, so a balance number must never be
      // required — requiring one would fail the render closed. The CONFIRM
      // variant does have a schedule and legitimately reports the balance,
      // but must never claim the customer supplied it.
      if (templateSeed.key === 'irrigation.weekly_confirm_schedule') {
        expect(required).toEqual(expect.arrayContaining(['schedule_inches', 'total_inches', 'summary_line']));
        expect(required).not.toContain('irrigation_inches');
      } else {
        expect(required).not.toContain('irrigation_inches');
        expect(required).not.toContain('total_inches');
        expect(required).not.toContain('difference_inches');
      }
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
    // r2 P2: a tech-recorded schedule must NOT inherit the advice templates —
    // they credit the customer portal and prescribe sprinkler-zone actions.
    test('a turf-profile reading routes to CONFIRM, not advice and not setup', () => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationInchesPerWeek: null,
        turfIrrigationInchesPerWeek: 1,
        rainfallInches7d: 2.1,
        forecastRainInches: 0.5,
      });
      expect(decision.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
      expect(decision.reason).toBe('confirm_surplus');
      expect(decision.payload.schedule_inches).toBe('1');
      expect(decision.payload.total_inches).toBe('3.1');
    });

    test('an assessment reading routes to CONFIRM when nothing else exists', () => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationInchesPerWeek: null,
        turfIrrigationInchesPerWeek: null,
        assessmentIrrigationInchesPerWeek: 1,
        rainfallInches7d: 2.1,
        forecastRainInches: 0.5,
      });
      expect(decision.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
      expect(decision.payload.schedule_inches).toBe('1');
    });

    test('PORTAL ENTRY WINS over a tech reading — value and template both', () => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationInchesPerWeek: 1,
        turfIrrigationInchesPerWeek: 3,
        assessmentIrrigationInchesPerWeek: 2,
        rainfallInches7d: 2.1,
        forecastRainInches: 0.5,
      });
      expect(decision.templateKey).toBe(TEMPLATE_CUT_BACK);
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
      expect(decision.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
    });

    test('a hand-watering customer never gets sprinkler-zone instructions', () => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationInchesPerWeek: null,
        turfIrrigationInchesPerWeek: 1,
        turfIrrigationType: 'manual',
        rainfallInches7d: 2.1,
        forecastRainInches: 0.5,
      });
      expect(decision.templateKey).toBe(TEMPLATE_CONFIRM_SCHEDULE);
      const { template, version } = seedRows(TEMPLATE_CONFIRM_SCHEDULE);
      const rendered = EmailTemplates.renderTemplate({ template, version, payload: decision.payload });
      expect(rendered.html).not.toMatch(/each zone|per zone/i);
      expect(rendered.html).not.toContain('irrigation schedule you shared');
      expect(rendered.html).not.toMatch(PLACEHOLDER_RE);
      expect(rendered.missingPayload || []).toEqual([]);
      // It still reports the real balance rather than pretending we know nothing.
      expect(rendered.html).toContain('Watering schedule on file');
    });

    test.each([
      ['turf', { turfIrrigationInchesPerWeek: 1 }],
      ['assessment', { assessmentIrrigationInchesPerWeek: 1 }],
    ])('a tech "none" type discards a contradictory %s reading rather than inventing a balance', (_src, reading) => {
      // The tech says this property does not irrigate; adding the reading
      // would tell the customer their lawn got water it never received.
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationInchesPerWeek: null,
        turfIrrigationType: 'none',
        ...reading,
      });
      expect(decision.templateKey).toBe(TEMPLATE_SETUP_SYSTEM);
      expect(decision.payload.total_inches).toBeUndefined();
      expect(decision.payload.schedule_inches).toBeUndefined();
    });

    test('a "none" type does NOT discard the customer\'s own portal entry', () => {
      // If they typed a number, they water — whatever the type column says.
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationSystem: true,
        irrigationInchesPerWeek: 1,
        turfIrrigationType: 'none',
        rainfallInches7d: 2.1,
        forecastRainInches: 0.5,
      });
      expect(decision.templateKey).toBe(TEMPLATE_CUT_BACK);
      expect(decision.payload.irrigation_inches).toBe('1');
    });

    test('every variant offers a route the portal can actually serve', () => {
      // The weekly-inches field only exists under the portal's Irrigation
      // toggle, so no template may ask a question that form cannot answer.
      for (const key of [TEMPLATE_SETUP_SCHEDULE, TEMPLATE_SETUP_SYSTEM, TEMPLATE_CONFIRM_SCHEDULE]) {
        const { template, version } = seedRows(key);
        const html = JSON.stringify(version.blocks);
        expect(html).not.toMatch(/Do you water with a sprinkler system, or by hand\?/);
        // Anything the portal form can't express falls back to a reply.
        if (key !== TEMPLATE_SETUP_SCHEDULE) expect(html).toMatch(/reply to this email/i);
      }
    });

    test('a newer zeroed assessment is NOT overridden by an older positive one', () => {
      // The query selects the LATEST non-null reading and passes zero through;
      // zero reads as a missing profile, so they get a setup email rather than
      // advice built on a schedule they abandoned.
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationInchesPerWeek: null,
        assessmentIrrigationInchesPerWeek: 0,
      });
      expect(decision.templateKey).toBe(TEMPLATE_SETUP_SYSTEM);
      expect(decision.reason).toBe('setup_system');
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

    test.each([
      // A technician standing on the lawn outranks a toggle the customer may
      // have set years ago — asking "how long do you run it?" of someone with
      // no system is the failure being prevented (codex r2 P2).
      ['none', TEMPLATE_SETUP_SYSTEM],
      ['manual', TEMPLATE_SETUP_SYSTEM],
      // …and the reverse: no type recorded falls back to the toggle.
      [null, TEMPLATE_SETUP_SCHEDULE],
    ])('portal toggle TRUE + turf type %s → %s', (type, expected) => {
      const decision = buildWeeklyEmailDecision({
        ...BASE,
        irrigationSystem: true,
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
    [TEMPLATE_SETUP_SYSTEM, { irrigationSystem: null, irrigationInchesPerWeek: null }, 'ADD MY WATERING SCHEDULE'],
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
