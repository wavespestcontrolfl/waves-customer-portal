/**
 * Email division wiring contract (no database): the builders' required lists,
 * the trigger mappings and the seeded automation rows all stay consistent
 * with the templates 20260928235000 seeded — a builder that drifted from its
 * template would hand the library a payload it refuses at send time, and an
 * automation row pointing at an unmapped trigger would never fire.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const Executor = require('../services/email-template-automation-executor');
const Builders = require('../services/email-division/payload-builders');
const { TEMPLATES } = require('../models/migrations/20260928235000_seed_email_division_templates');
const automationSeed = require('../models/migrations/20260930200000_seed_email_division_automations');

const templateByKey = (key) => TEMPLATES.find((t) => t.key === key);

describe('payload builders track their templates', () => {
  test.each(Builders.BUILDER_TEMPLATE_KEYS)('%s: the builder\'s required list is the template\'s required list', (key) => {
    expect(Builders.REQUIRED[key]).toEqual(templateByKey(key).required);
  });

  test('exactly the three wired templates have a builder; B6 has none', () => {
    expect([...Builders.BUILDER_TEMPLATE_KEYS].sort()).toEqual(['lc.first_visit_pest', 'lc.why_91_days', 'nurture.expired_1']);
    expect(Builders.hasPayloadBuilder('lc.rain_and_treatment')).toBe(false);
    expect(Builders.hasPayloadBuilder('estimate.extension_notice')).toBe(false);
  });

  test('a template with no builder is untouched (handled:false, no database read)', async () => {
    await expect(Builders.buildEmailDivisionPayload({ run: { template_key: 'estimate.extension_notice' } })).resolves.toEqual({ handled: false });
  });
});

describe('trigger mappings', () => {
  test('visit.completed_first maps a service record for a customer recipient', () => {
    expect(Executor.TRIGGER_MAPPINGS['visit.completed_first']).toEqual(expect.objectContaining({
      entityType: 'service_record', recipientType: 'customer', recipientIdKeys: ['customer_id'],
    }));
    const input = { payload: { service_record_id: 'rec-1', customer_id: 'cust-1', customer_email: 'jordan@example.invalid' } };
    expect(Executor.entityFor('visit.completed_first', input)).toEqual({ entityType: 'service_record', entityId: 'rec-1' });
    expect(Executor.recipientFor('visit.completed_first', input)).toEqual(expect.objectContaining({ email: 'jordan@example.invalid', id: 'cust-1', type: 'customer' }));
  });

  test('estimate.expired and service_report.ready were already mapped', () => {
    expect(Executor.TRIGGER_MAPPINGS['estimate.expired'].entityType).toBe('estimate');
    expect(Executor.TRIGGER_MAPPINGS['service_report.ready'].entityType).toBe('service_record');
  });
});

describe('seeded automation rows', () => {
  const rows = automationSeed.AUTOMATIONS;

  test('three rows: B1, B5, C1 — never B6', () => {
    expect(rows.map((r) => r.automation_key).sort()).toEqual(['lc.first_visit_pest', 'lc.why_91_days', 'nurture.expired_1']);
  });

  test.each(rows.map((r) => [r.automation_key, r]))('%s: real template, mapped trigger, paused, renderable idempotency key', (key, automation) => {
    const template = templateByKey(automation.template_key);
    expect(template).toBeTruthy();
    expect(Object.keys(Executor.TRIGGER_MAPPINGS)).toContain(automation.trigger_event_key);
    const row = automationSeed.__private.rowFor(automation, { suppression_group_key: template.suppressionGroup });
    expect(row.status).toBe('paused');
    expect(row.suppression_group_key).toBe(template.suppressionGroup);
    expect(row.legal_classification).toBe(template.suppressionGroup === 'marketing_nurture' ? 'commercial_marketing' : 'transactional_relationship');
    // The context an emitted trigger builds carries these ids.
    const rendered = Executor.renderIdempotencyKey(automation.idempotency_key_template, {
      service_record_id: 'rec-1234', recipient_id: 'cust-1234', estimate_id: 'est-1234', expires_on: '2026-09-20',
    });
    expect(rendered).toMatch(/^[a-zA-Z0-9._:-]{8,260}$/);
    expect(rendered.startsWith(`${key}:`)).toBe(true);
  });

  test('nothing in a seeded row can carry PII into its idempotency key (ids only)', () => {
    for (const automation of rows) {
      expect(automation.idempotency_key_template).not.toMatch(/email|phone|name|address/i);
    }
  });
});
