/**
 * Seed migration 20261119210000: the two emails of the one-time job to plan offer (owner 2026-11-19).
 *
 * What a regression here would do, and what this suite pins against it:
 *  - A template seeded 'active', or with an active version, could be sent to a customer by a later caller
 *    before the owner approved the words. Both must be drafts, and sendTemplate's own refusal must hold.
 *  - A re-run that rewrites a row would erase the owner's edits from the template editor. Insert-once.
 *  - The rows must be marketing mail with an unsubscribe (marketing_nurture) in service chrome, and every
 *    enum-governed field must be a value the admin API accepts, or the editor cannot save the template.
 *  - The price reads "per application" (AGENTS.md), never "per visit" and never a monthly total.
 *  - The owner reads the words in the template editor, which fills each template from its default fixture:
 *    the fixture must fill every required variable.
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
const migration = require('../models/migrations/20261119210000_seed_onetime_plan_offer_email_templates');

const TABLES = ['email_templates', 'email_template_versions', 'email_template_fixtures', 'email_template_automations', 'audit_log'];
const KEYS = ['nurture.plan_offer', 'nurture.plan_offer_reminder'];
const PLACEHOLDER_RE = /\{\{\s*[a-zA-Z][a-zA-Z0-9_]*\s*\}\}/;

// The same minimal knex fake as email-division-templates-migration.test.js (test scaffolding, kept in sync by hand).
function fakeKnex(tableNames) {
  const store = {};
  const table = (name) => store[name] || (store[name] = []);
  const matches = (row, cond) => Object.entries(cond || {}).every(([k, v]) => row[k] === v);
  const knex = (name) => {
    const rows = table(name);
    const b = { _where: {} };
    b.where = (cond) => { b._where = { ...b._where, ...cond }; return b; };
    b._filtered = () => rows.filter((r) => matches(r, b._where));
    b.first = async () => { const r = b._filtered()[0]; return r ? { ...r } : undefined; };
    b.then = (resolve, reject) => Promise.resolve(b._filtered().map((r) => ({ ...r }))).then(resolve, reject);
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

async function seededKnex(tables = TABLES) {
  const knex = fakeKnex(tables);
  await migration.up(knex);
  return knex;
}

function seededState(knex, key) {
  const row = knex.__store.email_templates.find((t) => t.template_key === key);
  const versions = knex.__store.email_template_versions.filter((v) => v.template_id === row.id);
  const fixtures = (knex.__store.email_template_fixtures || []).filter((f) => f.template_id === row.id);
  return {
    row,
    versions,
    template: { ...row, allowed_variables: JSON.parse(row.allowed_variables), required_variables: JSON.parse(row.required_variables) },
    version: { ...versions[0], blocks: JSON.parse(versions[0].blocks) },
    fixture: JSON.parse(fixtures.find((f) => f.is_default).payload),
  };
}

describe('seed migration 20261119210000 (one-time job to plan offer emails)', () => {
  test('seeds both templates as drafts with a draft version and no active version', async () => {
    const knex = await seededKnex();
    expect(knex.__store.email_templates.map((t) => t.template_key)).toEqual(KEYS);
    for (const key of KEYS) {
      const { row, versions } = seededState(knex, key);
      expect(row.status).toBe('draft');
      expect(row.active_version_id).toBeUndefined();
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ version_number: 1, status: 'draft', text_body: null });
    }
  });

  test("sendTemplate refuses each seeded template for a customer send ('draft' is not sendable)", async () => {
    mockDb = await seededKnex();
    for (const key of KEYS) {
      await expect(EmailTemplates.sendTemplate({
        templateKey: key, to: 'test@example.com', payload: {}, recipientType: 'customer', recipientId: 'r1',
      })).rejects.toMatchObject({ status: 409, code: 'EMAIL_TEMPLATE_DISABLED' });
    }
  });

  test('rows are marketing mail with an unsubscribe, in service chrome, from the office address', async () => {
    for (const t of migration.TEMPLATES) {
      expect(migration.__private.templateRow(t)).toMatchObject({
        mode: 'service',
        purpose: 'nurture',
        legal_classification: 'commercial_marketing',
        send_stream: 'marketing_nurture',
        suppression_group_key: 'marketing_nurture',
        layout_wrapper_id: 'service_pinned_v1',
        from_name: 'Waves Pest Control',
        from_email: 'contact@wavespestcontrol.com',
        reply_to: 'contact@wavespestcontrol.com',
      });
    }
  });

  test('every enum-governed field is a value the admin template API accepts', () => {
    // Read the sets the route validates against; a hand-copied list would pass after the API changed.
    const routeSrc = require('fs').readFileSync(require.resolve('../routes/admin-email-templates.js'), 'utf8');
    const enumSet = (name) => {
      const match = routeSrc.match(new RegExp(`${name} = new Set\\(\\[([^\\]]+)\\]\\)`));
      return new Set(JSON.parse(`[${match[1]}]`.replace(/'/g, '"').replace(/,(\s*])/g, '$1')));
    };
    const fields = {
      mode: enumSet('MODES'),
      legal_classification: enumSet('LEGAL_CLASSIFICATIONS'),
      audience: enumSet('AUDIENCES'),
      message_priority: enumSet('PRIORITIES'),
      content_sensitivity: enumSet('SENSITIVITIES'),
      send_stream: enumSet('STREAMS'),
    };
    for (const t of migration.TEMPLATES) {
      const row = migration.__private.templateRow(t);
      for (const [field, allowed] of Object.entries(fields)) expect([field, allowed.has(row[field])]).toEqual([field, true]);
    }
  });

  test('a re-run, or a template that already exists, changes nothing (the owner edits these rows)', async () => {
    const knex = fakeKnex(TABLES);
    knex('email_templates').insert({ template_key: 'nurture.plan_offer', name: 'Edited by the owner', status: 'active' });
    await migration.up(knex);
    await migration.up(knex);
    const offer = knex.__store.email_templates.filter((t) => t.template_key === 'nurture.plan_offer');
    expect(offer).toHaveLength(1);
    expect(offer[0]).toMatchObject({ name: 'Edited by the owner', status: 'active' });
    // Nothing is seeded under a template this migration did not insert.
    expect(knex.__store.email_template_versions.filter((v) => v.template_id === offer[0].id)).toHaveLength(0);
    expect(knex.__store.email_templates).toHaveLength(2);
    expect(knex.__store.email_template_versions).toHaveLength(1);
    expect(knex.__store.email_template_fixtures).toHaveLength(1);
  });

  test('one critical audit row per inserted template, none on a re-run, and none needed without the table', async () => {
    const knex = await seededKnex();
    await migration.up(knex);
    const events = knex.__store.audit_log;
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({ actor_type: 'system', action: 'email_template.seeded', resource_type: 'email_template' });
      const row = knex.__store.email_templates.find((t) => t.id === event.resource_id);
      expect(event.metadata).toEqual({ templateKey: row.template_key, migration: '20261119210000_seed_onetime_plan_offer_email_templates' });
    }
    const bare = await seededKnex(TABLES.filter((name) => name !== 'audit_log' && name !== 'email_template_fixtures'));
    expect(bare.__store.email_templates).toHaveLength(2);
    expect(bare.__store.audit_log).toBeUndefined();
    expect(bare.__store.email_template_fixtures).toBeUndefined();
  });

  test('writes no automation row (a marketing template never rides the automation executor) and down() deletes nothing', async () => {
    const knex = await seededKnex();
    expect(knex.__store.email_template_automations || []).toHaveLength(0);
    await migration.down(knex);
    expect(knex.__store.email_templates).toHaveLength(2);
    expect(knex.__store.email_template_versions).toHaveLength(2);
  });
});

describe('one-time job to plan offer emails: the seeded rows rendered by the template library', () => {
  let knex;
  beforeAll(async () => { knex = await seededKnex(); });

  for (const key of KEYS) {
    test(`${key}: the default fixture fills every variable, and the version can be published as written`, () => {
      const { template, version, fixture } = seededState(knex, key);
      const rendered = EmailTemplates.renderTemplate({ template, version, payload: fixture });
      expect(rendered.missingPayload).toEqual([]);
      for (const part of [rendered.subject, rendered.previewText, rendered.html, rendered.text]) expect(part).not.toMatch(PLACEHOLDER_RE);
      // publishVersion refuses a version with a variable outside the allowed list, or a required one it never uses.
      expect(rendered.validation).toMatchObject({ ok: true, disallowed_variables: [], missing_required_in_template: [] });
    });

    test(`${key}: the price is per application, with no per-visit or monthly price and no banned claim`, () => {
      const { template, version, fixture } = seededState(knex, key);
      const rendered = EmailTemplates.renderTemplate({ template, version, payload: fixture });
      const text = [rendered.subject, rendered.previewText, rendered.text].join('\n').toLowerCase();
      expect(text).toContain('$100 per application');
      for (const banned of ['per visit', '/mo', 'a month', 'per month', '/yr', 'safe', 'guarantee', 'epa']) expect(text).not.toContain(banned);
      // The plan is named by its exact catalog name (owner 2026-11-01).
      expect(rendered.text).toMatch(/Quarterly Pest Control Service/i);
    });

    test(`${key}: says it is an offer, and the footer unsubscribes from Waves marketing email`, () => {
      const { template, version, fixture } = seededState(knex, key);
      const rendered = EmailTemplates.renderTemplate({
        template, version, payload: fixture, unsubscribeUrl: 'https://example.test/unsub/abc', modeOverride: 'service',
      });
      expect(rendered.text).toContain('This is an offer from Waves.');
      expect(rendered.html).toContain('</a> from Waves marketing emails.');
    });
  }

  test('the offer shows the setup fee at $0 beside the normal fee, $0 due today and the next visit window', () => {
    const { template, version, fixture } = seededState(knex, 'nurture.plan_offer');
    const { text } = EmailTemplates.renderTemplate({ template, version, payload: fixture });
    expect(text).toContain('One-time setup fee: $0 (normally $99)');
    expect(text).toContain('Due today: $0');
    expect(text).toContain('Next visit: You pick, Feb 2 to Feb 16');
    expect(text).toContain('This estimate is good through December 17.');
  });
});
