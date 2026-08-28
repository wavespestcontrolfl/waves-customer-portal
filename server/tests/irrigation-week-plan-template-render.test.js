/**
 * irrigation.weekly_plan renders end-to-end from the sender's payload with no
 * unresolved placeholders, for each plan outcome. With DUMP_DIR set, writes
 * the rendered HTML for the ui-verify screenshot pass.
 */
jest.mock('../models/db', () => { const m = jest.fn(); m.raw = jest.fn((e) => e); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../services/sendgrid-client', () => ({ send: jest.fn(), serviceGroupId: jest.fn(() => 202) }), { virtual: true });
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260828000004_seed_irrigation_week_plan_email_template');
const { buildWeeklyEmailDecision, TEMPLATE_WEEK_PLAN } = require('../services/irrigation-weekly-email');

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/;
const NOW = new Date('2026-08-28T12:00:00Z');

function seedRows() {
  const t = seed.__private.TEMPLATE;
  const template = { id: 'tmpl-plan', ...seed.__private.templateRow(t) };
  template.allowed_variables = JSON.parse(template.allowed_variables);
  template.required_variables = JSON.parse(template.required_variables);
  return { template, version: { id: 'ver-plan', subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: '' } };
}

const BASE = {
  firstName: 'Dana', grassType: 'st_augustine', weekEnding: '2026-08-23', et0Inches: 1.6,
  irrigationSystem: true, irrigationRunMinutes: 20, wateringDays: ['Mon', 'Wed', 'Fri', 'Sun'], irrigationSystemType: ['spray'],
  weekPlanEnabled: true, county: 'Sarasota', now: NOW,
};

describe('irrigation.weekly_plan template', () => {
  test.each([
    ['plan_run', { irrigationInchesPerWeek: null, rainfallInches7d: 0.6, forecastRainInches: 0.3 }],
    ['plan_conditional', { irrigationInchesPerWeek: null, rainfallInches7d: 0.6, forecastRainInches: 1.4 }],
    ['plan_hold', { irrigationInchesPerWeek: null, rainfallInches7d: 1.5, forecastRainInches: 0.1, weekEnding: '2026-01-18', et0Inches: 0.8 }],
  ])('%s renders with no unresolved placeholders', (reason, water) => {
    const decision = buildWeeklyEmailDecision({ ...BASE, ...water });
    expect(decision.templateKey).toBe(TEMPLATE_WEEK_PLAN);
    expect(decision.reason).toBe(reason);
    const { template, version } = seedRows();
    const rendered = EmailTemplates.renderTemplate({ template, version, payload: decision.payload });
    expect(rendered.missingPayload || []).toEqual([]);
    expect(rendered.subject).toBe(decision.payload.plan_subject);
    expect(rendered.subject).not.toMatch(PLACEHOLDER_RE);
    expect(rendered.bodyHtml || rendered.html).not.toMatch(PLACEHOLDER_RE);
    expect(rendered.bodyHtml || rendered.html).toContain('turf zone');
    if (process.env.DUMP_DIR) {
      fs.writeFileSync(path.join(process.env.DUMP_DIR, `email-${reason}.html`), rendered.html || rendered.bodyHtml);
    }
  });
});
