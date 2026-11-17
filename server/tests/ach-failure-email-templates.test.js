jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const fs = require('fs');
const path = require('path');
const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20261116120000_seed_ach_failure_email_templates');
const { HOLD_GATED_EMAIL_TEMPLATES } = require('../services/collections/collection-hold');

const byKey = Object.fromEntries(seed.__private.EMAIL_TEMPLATES.map((t) => [t.key, t]));

function render(key, payload = seed.__private.PREVIEW_PAYLOAD) {
  const t = byKey[key];
  return EmailTemplates.renderTemplate({
    template: { id: `tmpl-${key}`, template_key: key },
    version: { id: `ver-${key}`, subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: '' },
    payload,
  });
}

describe('bank payment failure email seeds (GATE_ACH_FAILURE_EMAIL)', () => {
  test('one template per email stage, keyed as the sender expects, saying only what the code does at that stage', () => {
    expect(Object.keys(byKey).sort()).toEqual(['payment.ach_card_fallback', 'payment.ach_retry_notice', 'payment.ach_suspended', 'payment.ach_suspended_no_card']);
    const first = render('payment.ach_retry_notice').text;
    expect(first).toContain('Your bank payment did not go through. You can pay now or update your payment method on your billing page.');
    const second = render('payment.ach_card_fallback').text;
    expect(second).toContain('Your bank payment failed a second time, so bank payments are paused for now. To use your bank, add your bank account again on your billing page. You can also pay by card there. Credit card payments include a surcharge.');
    const onCard = render('payment.ach_suspended').text;
    expect(onCard).toContain('Your bank payment failed again, so bank payments are now off on your account. Your Auto Pay now uses your card on file. Credit card payments include a surcharge.');
    const noCard = render('payment.ach_suspended_no_card').text;
    expect(noCard).toContain('Your bank payment failed again, so bank payments are now off on your account. Please pay by card on your billing page. If you used Auto Pay, it is off for now. You can turn it back on with a card. Credit card payments include a surcharge.');
    // The texts' lines that the code does not do never reach an email: a promised retry, a switch to the card at the
    // second failure, a bank update link at the third (the pay page offers card only once bank payments are off).
    const all = Object.keys(byKey).map((key) => `${byKey[key].subject} ${byKey[key].preview} ${render(key).text}`).join('\n');
    expect(all).not.toMatch(/retry|business days|switched this payment|update your bank account|no added fee|processing fee/i);
    for (const key of Object.keys(byKey)) expect(render(key).text).toContain('https://portal.wavespestcontrol.com/?tab=billing');
  });

  test.each(Object.keys(byKey))('%s renders cleanly and never names "Waves Pest Control" in the body', (key) => {
    const rendered = render(key);
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.text).toContain('Stan');
    expect(JSON.stringify(byKey[key].blocks)).not.toContain('Waves Pest Control');
  });

  test('every stage carries the billing link, so a collections dispute hold withholds each one', () => {
    for (const key of Object.keys(byKey)) {
      expect(HOLD_GATED_EMAIL_TEMPLATES.has(key)).toBe(true);
      expect(byKey[key].required).toContain('billing_url');
    }
  });

  // The seed against a recording knex stand-in (same harness as membership-tier-upgraded-email.test.js): what it
  // writes, that a re-run writes nothing, that an operator's edit is never overwritten, and that down() deletes nothing.
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

  test('seeds four active templates with one version, one fixture and one audit event each; a re-run changes nothing', async () => {
    const knex = fakeKnex();
    await seed.up(knex);
    const snapshot = JSON.stringify(knex.store);
    await seed.up(knex);
    expect(JSON.stringify(knex.store)).toBe(snapshot);

    expect(knex.store.email_templates.map((t) => t.template_key).sort()).toEqual(Object.keys(byKey).sort());
    expect(knex.store.email_template_versions).toHaveLength(4);
    expect(knex.store.email_template_fixtures).toHaveLength(4);
    for (const template of knex.store.email_templates) {
      const version = knex.store.email_template_versions.find((v) => v.template_id === template.id);
      expect(template).toMatchObject({ status: 'active', active_version_id: version.id, send_stream: 'transactional_required' });
      expect(JSON.parse(version.blocks)).toEqual(byKey[template.template_key].blocks);
      for (const value of [template.allowed_variables, template.required_variables, version.blocks]) expect(() => JSON.parse(value)).not.toThrow();
    }
    expect(knex.store.audit_log).toHaveLength(4);
    expect(knex.store.audit_log.every((row) => row.action === 'email_template.seeded' && row.action.length <= 96)).toBe(true);
    // The group is inserted once when missing.
    expect(knex.store.email_preference_groups).toHaveLength(1);
  });

  test('an existing preference group and an operator-edited template are left alone', async () => {
    const knex = fakeKnex();
    knex.store.email_preference_groups.push({ id: 'g-1', key: 'transactional_required', name: 'Operator name' });
    knex.store.email_templates.push({ id: 't-edited', template_key: 'payment.ach_retry_notice', active_version_id: 'v-edited' });
    await seed.up(knex);
    expect(knex.store.email_preference_groups).toEqual([{ id: 'g-1', key: 'transactional_required', name: 'Operator name' }]);
    expect(knex.store.email_templates.find((t) => t.id === 't-edited').active_version_id).toBe('v-edited');
    expect(knex.store.email_template_versions).toHaveLength(3);
    expect(knex.store.audit_log).toHaveLength(3);
  });

  test('a database without the template tables is a no-op, and down() never deletes', async () => {
    const knex = fakeKnex({ tables: [] });
    await expect(seed.up(knex)).resolves.toBeUndefined();
    expect(knex.store.email_templates).toHaveLength(0);
    const seeded = fakeKnex();
    await seed.up(seeded);
    await expect(seed.down(seeded)).resolves.toBeUndefined();
    expect(seeded.store.email_templates).toHaveLength(4);
  });

  test('the migration file name stays within 57 characters', () => {
    const names = fs.readdirSync(path.join(__dirname, '..', 'models', 'migrations')).filter((n) => n.includes('ach_failure_email'));
    expect(names).toHaveLength(1);
    expect(names[0].length).toBeLessThanOrEqual(57);
  });
});
