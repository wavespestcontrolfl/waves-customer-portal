/**
 * Irrigation weekly email template seeds.
 *
 * Pins the contract between the seed migration
 * (20260702000001_seed_irrigation_weekly_email_templates.js) and the sender
 * (irrigation-weekly-email.js): the suppressible send stream, the variable
 * sets, and — via the REAL render path with REAL sender payloads — that both
 * templates render with zero unresolved placeholders.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260702000001_seed_irrigation_weekly_email_templates');
const {
  buildWeeklyEmailDecision,
  TEMPLATE_CUT_BACK,
  TEMPLATE_ADD_WATER,
  TEMPLATE_ON_TRACK,
} = require('../services/irrigation-weekly-email');

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/;

function seedRows(key) {
  const templateSeed = seed.__private.TEMPLATES.find((t) => t.key === key);
  const template = { id: `tmpl-${key}`, ...seed.__private.templateRow(templateSeed) };
  // templateRow JSON-stringifies the variable lists for the DB row; the
  // library's asArray handles both, but parse here to mirror a loaded row.
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

describe('irrigation weekly email template seeds', () => {
  test('defines all three outcomes on the suppressible service_operational stream', () => {
    expect(seed.__private.TEMPLATES.map((t) => t.key)).toEqual([
      'irrigation.weekly_on_track',
      'irrigation.weekly_cut_back',
      'irrigation.weekly_add_water',
    ]);

    for (const templateSeed of seed.__private.TEMPLATES) {
      const row = seed.__private.templateRow(templateSeed);
      expect(row).toMatchObject({
        mode: 'service',
        audience: 'customer',
        purpose: 'lawn',
        // A watering tip is NOT a required notice — unsubscribes must be honored.
        send_stream: 'service_operational',
        suppression_group_key: 'service_operational',
        status: 'active',
      });
      expect(JSON.parse(row.required_variables)).toEqual(
        expect.arrayContaining(['first_name', 'rain_last_week', 'irrigation_inches', 'total_inches', 'target_inches']),
      );
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
    // forecast 0.5" stays below the 1.25" target so the deficit is not rerouted.
    ['surplus', TEMPLATE_CUT_BACK, { irrigationInchesPerWeek: 1, rainfallInches7d: 2.1, forecastRainInches: 0.5 }],
    ['deficit', TEMPLATE_ADD_WATER, { irrigationInchesPerWeek: 0.25, rainfallInches7d: 0.1, forecastRainInches: 0.5 }],
    ['balanced', TEMPLATE_ON_TRACK, { irrigationInchesPerWeek: 1.25, rainfallInches7d: 0, forecastRainInches: 0.5 }],
    // Light week + forecast that covers the projection → on-track variant.
    ['deficit_rain_forecast', TEMPLATE_ON_TRACK, { irrigationInchesPerWeek: 0.5, rainfallInches7d: 0, forecastRainInches: 0.8 }],
    // Rain-fed balanced week + dry forecast → add-water variant.
    ['balanced_dry_forecast', TEMPLATE_ADD_WATER, { irrigationInchesPerWeek: 0.25, rainfallInches7d: 1, forecastRainInches: 0 }],
  ])('%s payload from the sender renders %s with no unresolved placeholders', (status, key, water) => {
    const decision = buildWeeklyEmailDecision({
      firstName: 'Dana',
      grassType: 'st_augustine',
      weekEnding: '2026-07-05',
      et0Inches: 1.6,
      ...water,
    });
    expect(decision.shouldSend).toBe(true);
    expect(decision.templateKey).toBe(key);

    const { template, version } = seedRows(key);
    const rendered = EmailTemplates.renderTemplate({ template, version, payload: decision.payload });
    expect(rendered.missingPayload || []).toEqual([]);
    expect(rendered.subject).not.toMatch(PLACEHOLDER_RE);
    expect(rendered.html).not.toMatch(PLACEHOLDER_RE);
    expect(rendered.text).not.toMatch(PLACEHOLDER_RE);
    // The water-balance table carries the real numbers.
    expect(rendered.html).toContain('Rain at your home last week');
    expect(rendered.html).toContain('UPDATE MY IRRIGATION INFO');
    expect(rendered.html).toContain('tab=property');
  });

  test('an empty forecast_line renders no leftover forecast paragraph', () => {
    const decision = buildWeeklyEmailDecision({
      firstName: 'Dana',
      grassType: 'st_augustine',
      weekEnding: '2026-07-05',
      et0Inches: 1.6,
      forecastRainInches: null, // forecast fetch failed soft
      irrigationInchesPerWeek: 1,
      rainfallInches7d: 2.1,
    });
    const { template, version } = seedRows(TEMPLATE_CUT_BACK);
    const rendered = EmailTemplates.renderTemplate({ template, version, payload: decision.payload });
    expect(rendered.html).not.toContain('Looking ahead');
    expect(rendered.html).not.toMatch(PLACEHOLDER_RE);
  });
});
