/**
 * Email division templates — first-visit follow-up, why-91-days,
 * rain-and-treatment, expired-estimate (migration 20260928080000).
 *
 * Pins three things:
 *  1. The migration seeds all four templates DRAFT (+ three DRAFT
 *     automations; lc.rain_and_treatment gets none — its trigger doesn't
 *     exist yet) and is idempotent on template_key / automation_key.
 *  2. sendTemplate's OWN refusal path (assertTemplateSendable) rejects a
 *     seeded template — nothing here can send, and this is not mocked away.
 *  3. Every "full" fixture renders with no leftover {{placeholders}}; every
 *     "sparse" fixture drops its optional sections WHOLE (heading and all —
 *     the details-block mechanism the library already has), with no blank
 *     number and no banned claim (retailer-sourced numbers the owner had
 *     removed from the 2026-09-28 copy revision must never come back).
 */

let mockDb;
jest.mock('../models/db', () => {
  const fn = (...args) => mockDb(...args);
  fn.schema = { hasTable: (...args) => mockDb.schema.hasTable(...args) };
  return fn;
});
jest.mock('../services/sendgrid-mail', () => ({
  serviceGroupId: () => 202,
  newsletterGroupId: () => 101,
}));
jest.mock('../config/feature-gates', () => ({ gateEnvValue: jest.fn(() => false), isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('crypto');
const EmailTemplates = require('../services/email-template-library');
const migration = require('../models/migrations/20260928080000_seed_email_division_templates');

const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/;
const BANNED_PHRASES = [
  '% off', 'discount', 'bee-safe', 'pet-safe', 'guarantee', 'second swarm',
  // Removed by the 2026-09-28 copy revision — retailer-sourced, not
  // label/manufacturer-verified. Must never come back.
  '90 days', '1–2 weeks', '1-2 weeks', 'about 30 days', 'one hour to dry',
  '7–14 days', '30–90 days', 'sterilis', 'steriliz',
];
const DOLLAR_DIGIT_RE = /\$\d/;

function fakeKnex(tableNames) {
  const store = {};
  const table = (name) => store[name] || (store[name] = []);
  const matches = (row, cond) => Object.entries(cond || {}).every(([k, v]) => row[k] === v);

  const knex = (name) => {
    const rows = table(name);
    const b = { _where: {} };
    b.where = (cond) => { b._where = { ...b._where, ...cond }; return b; };
    b.whereIn = (col, vals) => { b._whereIn = { col, vals }; return b; };
    b.orderBy = (col, dir) => { b._orderBy = { col, dir: dir || 'asc' }; return b; };
    b._filtered = () => {
      let out = rows.filter((r) => matches(r, b._where));
      if (b._whereIn) out = out.filter((r) => b._whereIn.vals.includes(r[b._whereIn.col]));
      if (b._orderBy) {
        out = out.slice().sort((x, y) => (b._orderBy.dir === 'desc'
          ? (y[b._orderBy.col] || 0) - (x[b._orderBy.col] || 0)
          : (x[b._orderBy.col] || 0) - (y[b._orderBy.col] || 0)));
      }
      return out;
    };
    b.first = async () => { const r = b._filtered()[0]; return r ? { ...r } : undefined; };
    b.max = (expr) => { b._maxCol = String(expr).split(' ')[0]; return { first: async () => {
      const filtered = b._filtered();
      if (!filtered.length) return { max: null };
      return { max: filtered.reduce((m, r) => Math.max(m, Number(r[b._maxCol]) || 0), 0) };
    } }; };
    b.update = async (patch) => {
      let n = 0;
      rows.forEach((r) => { if (matches(r, b._where)) { Object.assign(r, patch); n += 1; } });
      return n;
    };
    b.del = async () => {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], b._where) && (!b._whereIn || b._whereIn.vals.includes(rows[i][b._whereIn.col]))) {
          rows.splice(i, 1); n += 1;
        }
      }
      return n;
    };
    b.insert = (payload) => {
      const arr = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: randomUUID(), ...p }));
      arr.forEach((r) => rows.push(r));
      const result = Promise.resolve(arr.map((r) => r.id));
      result.returning = async () => arr;
      return result;
    };
    return b;
  };
  knex.schema = { hasTable: async (name) => tableNames.includes(name) };
  knex.__store = store;
  return knex;
}

describe('email division templates migration (20260928080000)', () => {
  test('seeds four draft templates; lc.rain_and_treatment has no automation row', () => {
    expect(migration.TEMPLATES.map((t) => t.key)).toEqual([
      'lc.first_visit_pest', 'lc.why_91_days', 'lc.rain_and_treatment', 'nurture.expired_1',
    ]);
    expect(migration.AUTOMATIONS.map((a) => a.key)).toEqual([
      'lc.first_visit_pest', 'lc.why_91_days', 'nurture.expired_1',
    ]);
    for (const t of migration.TEMPLATES) {
      const row = migration.__private.templateRow(t);
      expect(row.status).toBe('draft');
      expect(row.from_name).toBe('Waves Pest Control');
      expect(row.from_email).toBe('contact@wavespestcontrol.com');
      expect(row.reply_to).toBe('contact@wavespestcontrol.com');
      expect(JSON.parse(row.allowed_variables)).toEqual([...t.required, ...t.optional]);
    }
    const suppressionByKey = Object.fromEntries(migration.TEMPLATES.map((t) => [t.key, t.suppressionGroup]));
    expect(suppressionByKey['lc.first_visit_pest']).toBe('service_operational');
    expect(suppressionByKey['lc.why_91_days']).toBe('service_operational');
    expect(suppressionByKey['lc.rain_and_treatment']).toBe('service_operational');
    expect(suppressionByKey['nurture.expired_1']).toBe('marketing_nurture');
  });

  test('every referenced variable is allowed and every required variable is referenced', () => {
    for (const t of migration.TEMPLATES) {
      const row = migration.__private.templateRow(t);
      const template = { ...row, allowed_variables: JSON.parse(row.allowed_variables), required_variables: JSON.parse(row.required_variables) };
      const version = { subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: null };
      const validation = EmailTemplates.validationFor(template, version);
      expect(validation.disallowed_variables).toEqual([]);
      expect(validation.missing_required_in_template).toEqual([]);
      expect(validation.ok).toBe(true);
    }
  });

  test('running the migration twice inserts four templates, four versions, eight fixtures, three automations exactly once', async () => {
    const knex = fakeKnex(['email_templates', 'email_template_versions', 'email_template_fixtures', 'email_template_automations']);
    await migration.up(knex);
    await migration.up(knex);

    expect(knex.__store.email_templates).toHaveLength(4);
    expect(knex.__store.email_template_versions).toHaveLength(4);
    expect(knex.__store.email_template_fixtures).toHaveLength(8);
    expect(knex.__store.email_template_automations).toHaveLength(3);

    for (const row of knex.__store.email_templates) expect(row.status).toBe('draft');
    for (const row of knex.__store.email_template_versions) expect(row.status).toBe('draft');
    for (const row of knex.__store.email_template_automations) expect(row.status).toBe('draft');

    const byKey = Object.fromEntries(knex.__store.email_template_automations.map((a) => [a.automation_key, a]));
    expect(byKey['lc.first_visit_pest']).toMatchObject({
      trigger_event_key: 'visit.completed_first', delay_minutes: 2880,
      suppression_group_key: 'service_operational', idempotency_key_template: 'lc.first_visit_pest:{customer_id}',
    });
    expect(byKey['lc.why_91_days']).toMatchObject({
      trigger_event_key: 'visit.completed_first', delay_minutes: 20160,
      idempotency_key_template: 'lc.why_91_days:{customer_id}',
    });
    expect(byKey['nurture.expired_1']).toMatchObject({
      trigger_event_key: 'estimate.expired', delay_minutes: 4320,
      suppression_group_key: 'marketing_nurture', idempotency_key_template: 'nurture.expired_1:{customer_email}',
    });
    expect(JSON.parse(byKey['lc.first_visit_pest'].exit_conditions)).toEqual({ stop_if: ['customer.cancelled'] });
    expect(JSON.parse(byKey['nurture.expired_1'].exit_conditions)).toEqual({ stop_if: ['estimate.accepted', 'estimate.archived'] });
  });

  test('down() removes only the four seeded template_keys and their automations', async () => {
    const knex = fakeKnex(['email_templates', 'email_template_versions', 'email_template_fixtures', 'email_template_automations']);
    await migration.up(knex);
    knex.__store.email_templates.push({ id: 'other', template_key: 'unrelated.template', status: 'active' });
    await migration.down(knex);
    expect(knex.__store.email_templates.map((r) => r.template_key)).toEqual(['unrelated.template']);
    expect(knex.__store.email_template_automations).toHaveLength(0);
  });

  test("sendTemplate refuses each seeded template in its seeded ('draft') status, undisguised", async () => {
    mockDb = fakeKnex(['email_templates', 'email_template_versions', 'email_template_fixtures', 'email_template_automations']);
    await migration.up(mockDb);
    for (const t of migration.TEMPLATES) {
      await expect(EmailTemplates.sendTemplate({
        templateKey: t.key, to: 'test@example.com', payload: {}, recipientType: 'customer', recipientId: 'r1',
      })).rejects.toMatchObject({ status: 409, code: 'EMAIL_TEMPLATE_DISABLED' });
    }
  });
});

function renderedText(rendered) {
  return [rendered.subject, rendered.previewText, rendered.text, rendered.html].join('\n');
}

function buildTemplateAndVersion(t) {
  const row = migration.__private.templateRow(t);
  const template = { ...row, allowed_variables: JSON.parse(row.allowed_variables), required_variables: JSON.parse(row.required_variables) };
  const version = { subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: null };
  return { template, version };
}

describe('email division templates — full fixtures render clean', () => {
  for (const t of migration.TEMPLATES) {
    test(`${t.key}: full fixture renders subject/headings with no unresolved placeholders`, () => {
      const { template, version } = buildTemplateAndVersion(t);
      const rendered = EmailTemplates.renderTemplate({ template, version, payload: t.fixtures.full });
      expect(rendered.missingPayload).toEqual([]);
      expect(rendered.subject).not.toMatch(PLACEHOLDER_RE);
      expect(rendered.html).not.toMatch(PLACEHOLDER_RE);
      expect(rendered.text).not.toMatch(PLACEHOLDER_RE);
      for (const block of t.blocks) {
        if (block.type === 'heading' && !PLACEHOLDER_RE.test(block.content)) {
          // The renderer HTML-escapes prose (an authored apostrophe becomes
          // &#39;) — compare against the uppercased plain-text rendition
          // instead, which is what the heading branch of renderBlocks emits.
          expect(rendered.text.toUpperCase()).toContain(block.content.toUpperCase());
        }
      }
    });
  }
});

describe('email division templates — sparse fixtures drop optional sections whole', () => {
  const DROPPED_HEADINGS = {
    'lc.first_visit_pest': ['Your number', 'Rain since the visit', 'Pets and re-entry'],
    'lc.why_91_days': ['This month near you'],
    'lc.rain_and_treatment': ['At your address this week', 'Looking ahead'],
    'nurture.expired_1': ['What we are seeing near you'],
  };

  for (const t of migration.TEMPLATES) {
    test(`${t.key}: sparse fixture drops every optional section, no placeholders, no blank number`, () => {
      const { template, version } = buildTemplateAndVersion(t);
      const rendered = EmailTemplates.renderTemplate({ template, version, payload: t.fixtures.sparse });
      expect(rendered.missingPayload).toEqual([]);
      expect(rendered.html).not.toMatch(PLACEHOLDER_RE);
      expect(rendered.text).not.toMatch(PLACEHOLDER_RE);
      for (const heading of DROPPED_HEADINGS[t.key]) {
        expect(rendered.html).not.toContain(heading);
      }
      // No doubled spaces or empty parens left by a dropped inline variable,
      // and no digit-shaped hole ("of  visits", "held for  hours").
      expect(rendered.text).not.toMatch(/ {2,}/);
      expect(rendered.text).not.toMatch(/\(\s*\)/);
      expect(rendered.text).not.toMatch(/\bfor\s+hours\b/i);
    });
  }

  test('nurture.expired_1 sparse fixture drops the consultation offer block entirely', () => {
    const t = migration.TEMPLATES.find((x) => x.key === 'nurture.expired_1');
    const { template, version } = buildTemplateAndVersion(t);
    const rendered = EmailTemplates.renderTemplate({ template, version, payload: t.fixtures.sparse });
    expect(rendered.html).not.toContain('Not sure yet');
    expect(rendered.html).not.toContain('inspection');
  });
});

describe('email division templates — banned claims never render', () => {
  for (const t of migration.TEMPLATES) {
    for (const fixtureName of ['full', 'sparse']) {
      test(`${t.key} (${fixtureName}): no forbidden phrase, no $-digit price`, () => {
        const { template, version } = buildTemplateAndVersion(t);
        const rendered = EmailTemplates.renderTemplate({ template, version, payload: t.fixtures[fixtureName] });
        const combined = renderedText(rendered).toLowerCase();
        expect(combined).not.toMatch(DOLLAR_DIGIT_RE);
        for (const phrase of BANNED_PHRASES) {
          expect(combined).not.toContain(phrase.toLowerCase());
        }
      });
    }
  }
});
