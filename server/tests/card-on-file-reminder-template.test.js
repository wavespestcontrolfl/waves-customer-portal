jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const fs = require('fs');
const path = require('path');
const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20261124130000_card_on_file_reminder_email_template');
const { HOLD_GATED_EMAIL_TEMPLATES } = require('../services/collections/collection-hold');
const { staleStoredCopyReason, CARD_ON_FILE_REMINDER_CATEGORY } = require('../constants/email-replay-exclusions');

const KEY = 'payment.card_on_file_reminder';
const [definition] = seed.__private.EMAIL_TEMPLATES;

function render(payload = seed.__private.PREVIEW_PAYLOAD) {
  return EmailTemplates.renderTemplate({
    template: { id: 'tmpl-card', template_key: KEY },
    version: { id: 'ver-card', subject: definition.subject, preview_text: definition.preview, blocks: definition.blocks, text_body: '' },
    payload,
  });
}

describe('card on file reminder email seed (GATE_CARD_ON_FILE_REMINDER)', () => {
  test('carries the owner-approved words exactly', () => {
    expect(definition.key).toBe(KEY);
    expect(definition.subject).toBe('Your Waves account has no card on file');
    expect(definition.preview).toBe('Your next visit is still on. Here is how you want to pay for it.');
    const rendered = render();
    for (const line of [
      'Hi Stan,',
      'Your Waves visits at 123 Example Street, Bradenton, FL 34205 are still on the schedule. Your account has no card on file now.',
      'Next visit: December 2, 2026',
      'After the visit, we send you an invoice to pay by card, bank or check. If you want to keep a card on file, you can add one here.',
      'Adding a card does not turn Auto Pay on. Auto Pay starts only if you choose it on the next screen.',
      '— The Waves Team',
    ]) expect(rendered.text).toContain(line);
    expect(definition.blocks.find((b) => b.type === 'cta')).toEqual({ type: 'cta', label: 'Add a card', url_variable: 'card_url' });
    expect(rendered.text).toContain('https://portal.wavespestcontrol.com/?tab=billing&add_card=1');
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.missingPayload).toEqual([]);
  });

  test('an account with only an open invoice has no next visit: the Next visit row is dropped, nothing else breaks', () => {
    const { next_visit_date: _omit, ...withoutVisit } = seed.__private.PREVIEW_PAYLOAD;
    const rendered = render(withoutVisit);
    expect(rendered.text).not.toContain('Next visit');
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.missingPayload).toEqual([]);
    expect(render({ ...withoutVisit, next_visit_date: '' }).text).not.toContain('Next visit');
  });

  test('carries a billing-tab link, so a collections dispute hold withholds it; its stored copy is never re-sent', () => {
    expect(HOLD_GATED_EMAIL_TEMPLATES.has(KEY)).toBe(true);
    expect(CARD_ON_FILE_REMINDER_CATEGORY).toBe('card_on_file_reminder');
    expect(staleStoredCopyReason([CARD_ON_FILE_REMINDER_CATEGORY])).toMatch(/Not re-sent from stored copy/);
  });

  // The seed against a recording knex stand-in (same harness as ach-failure-email-templates.test.js).
  function fakeKnex({ tables = ['email_templates', 'email_template_versions', 'email_template_fixtures', 'email_preference_groups', 'audit_log'] } = {}) {
    const store = { email_templates: [], email_template_versions: [], email_template_fixtures: [], email_preference_groups: [], audit_log: [] };
    let seq = 0;
    const knex = (table) => {
      let filter = () => true;
      const rows = () => store[table].filter(filter);
      const q = {
        where(cond) { filter = (r) => Object.entries(cond).every(([k, v]) => r[k] === v); return q; },
        first: async () => rows()[0],
        max() { return { first: async () => ({ max: rows().reduce((m, r) => Math.max(m, r.version_number), 0) || null }) }; },
        insert(row) {
          const saved = { id: `${table}-${seq += 1}`, ...row };
          store[table].push(saved);
          const done = Promise.resolve([saved]);
          done.returning = async () => [saved];
          return done;
        },
        update: async (patch) => { rows().forEach((r) => Object.assign(r, patch)); return 1; },
        del: async () => { throw new Error(`${table}: a seed never deletes`); },
      };
      return q;
    };
    knex.schema = { hasTable: async (name) => tables.includes(name) };
    knex.store = store;
    return knex;
  }

  test('seeds one active transactional template with one version, one fixture and one audit event; a re-run changes nothing', async () => {
    const knex = fakeKnex();
    await seed.up(knex);
    const snapshot = JSON.stringify(knex.store);
    await seed.up(knex);
    expect(JSON.stringify(knex.store)).toBe(snapshot);

    const [template] = knex.store.email_templates;
    const [version] = knex.store.email_template_versions;
    expect(template).toMatchObject({
      template_key: KEY, status: 'active', active_version_id: version.id, mode: 'service',
      send_stream: 'transactional_required', suppression_group_key: 'transactional_required',
    });
    expect(JSON.parse(template.required_variables)).toEqual(['first_name', 'property_label', 'card_url']);
    expect(JSON.parse(template.optional_variables)).toContain('next_visit_date');
    expect(JSON.parse(version.blocks)).toEqual(definition.blocks);
    expect(version.subject).toBe('Your Waves account has no card on file');
    expect(knex.store.email_template_fixtures).toHaveLength(1);
    expect(JSON.parse(knex.store.email_template_fixtures[0].payload)).toEqual(seed.__private.PREVIEW_PAYLOAD);
    expect(knex.store.audit_log).toHaveLength(1);
    expect(knex.store.audit_log[0]).toMatchObject({ action: 'email_template.seeded' });
    expect(knex.store.email_preference_groups).toHaveLength(1);
  });

  test('an operator-edited template is left alone, a database without the tables is a no-op, and down() deletes nothing', async () => {
    const edited = fakeKnex();
    edited.store.email_templates.push({ id: 't-edited', template_key: KEY, active_version_id: 'v-edited' });
    await seed.up(edited);
    expect(edited.store.email_templates.find((t) => t.id === 't-edited').active_version_id).toBe('v-edited');
    expect(edited.store.email_template_versions).toHaveLength(0);

    const bare = fakeKnex({ tables: [] });
    await expect(seed.up(bare)).resolves.toBeUndefined();
    expect(bare.store.email_templates).toHaveLength(0);

    const seeded = fakeKnex();
    await seed.up(seeded);
    await expect(seed.down(seeded)).resolves.toBeUndefined();
    expect(seeded.store.email_templates).toHaveLength(1);
  });

  test('the migration file names stay within 57 characters', () => {
    const names = fs.readdirSync(path.join(__dirname, '..', 'models', 'migrations')).filter((n) => /card_on_file_reminder/.test(n));
    expect(names).toHaveLength(2);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(57);
  });
});
