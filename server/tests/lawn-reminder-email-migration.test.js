// The lawn pre-visit line in the 24-hour reminder EMAIL (GATE_LAWN_PREVISIT_LINE): the migration that adds {{lawn_prep_line}} to
// every version of appointment.reminder_24h, read-modify-write, and what the real renderer does with it. Synthetic data only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ newsletterGroupId: jest.fn(() => 101), serviceGroupId: jest.fn(() => 202) }));

const migration = require('../models/migrations/20261114130000_lawn_reminder_email_line');
const seed = require('../models/migrations/20260616000002_seed_appointment_email_templates');
const EmailTemplates = require('../services/email-template-library');
const { buildLawnPrevisitLine } = require('../services/lawn-previsit-line');

const { VAR_NAME, BLOCK_CONTENT, TEXT_APPEND } = migration._test;
const KEY_24H = 'appointment.reminder_24h';
const KEY_72H = 'appointment.reminder_72h';
const CALLOUT = { type: 'callout', content: BLOCK_CONTENT };

const seedOf = (key) => seed.__private.TEMPLATES.find((t) => t.key === key);

// An in-memory knex for the two tables the migration reads and writes.
function fakeKnex({ templates, versions, tables = ['email_templates', 'email_template_versions'] }) {
  const have = new Set(tables);
  const store = { email_templates: templates, email_template_versions: versions };
  const knex = (table) => {
    let filter = {};
    const match = () => store[table].filter((row) => Object.entries(filter).every(([k, v]) => row[k] === v));
    const q = {
      where: (f) => { filter = f; return q; },
      first: async () => match()[0],
      update: async (patch) => { match().forEach((row) => Object.assign(row, patch)); },
      then: (resolve, reject) => Promise.resolve(match()).then(resolve, reject),
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => have.has(t) };
  return { knex, store };
}

function seededStore() {
  const rows = [];
  const versions = [];
  for (const key of [KEY_72H, KEY_24H, 'appointment.confirmation']) {
    const t = seedOf(key);
    const row = { id: `tmpl-${key}`, template_key: key, ...seed.__private.templateRow(t) };
    rows.push(row);
    versions.push({ id: `${key}-active`, template_id: row.id, blocks: JSON.stringify(t.blocks), text_body: '' });
  }
  // The 24h template also has an older saved draft and a version with a custom text body.
  versions.push({ id: 'draft-24h', template_id: `tmpl-${KEY_24H}`, blocks: JSON.stringify([{ type: 'paragraph', content: 'Draft {{first_name}}' }]), text_body: '' });
  versions.push({ id: 'text-24h', template_id: `tmpl-${KEY_24H}`, blocks: JSON.stringify([{ type: 'paragraph', content: 'Hello' }, { type: 'signature' }]), text_body: 'Hi {{first_name}}, see you tomorrow.' });
  return fakeKnex({ templates: rows, versions });
}

const versionOf = (store, id) => store.email_template_versions.find((v) => v.id === id);
const blocksOf = (store, id) => JSON.parse(versionOf(store, id).blocks);
const templateOf = (store, key) => store.email_templates.find((t) => t.template_key === key);

describe('the migration', () => {
  test('only the 24-hour reminder is touched: the variable is registered twice, every version gets the block', async () => {
    const { knex, store } = seededStore();
    const before72 = JSON.stringify(store.email_template_versions.filter((v) => v.id.startsWith(KEY_72H)));
    const confirmation = JSON.stringify(templateOf(store, 'appointment.confirmation'));
    await migration.up(knex);

    const t24 = templateOf(store, KEY_24H);
    expect(JSON.parse(t24.allowed_variables)).toContain(VAR_NAME);
    expect(JSON.parse(t24.optional_variables)).toContain(VAR_NAME);
    for (const id of [`${KEY_24H}-active`, 'draft-24h', 'text-24h']) {
      const blocks = blocksOf(store, id);
      expect(blocks.filter((b) => b.type === 'callout' && b.content === BLOCK_CONTENT)).toHaveLength(1);
    }
    // Before the signature when there is one, else last.
    const withSignature = blocksOf(store, 'text-24h');
    expect(withSignature.map((b) => b.type)).toEqual(['paragraph', 'callout', 'signature']);
    expect(blocksOf(store, 'draft-24h').at(-1)).toEqual(CALLOUT);

    expect(JSON.stringify(store.email_template_versions.filter((v) => v.id.startsWith(KEY_72H)))).toBe(before72);
    expect(JSON.stringify(templateOf(store, 'appointment.confirmation'))).toBe(confirmation);
    expect(JSON.parse(templateOf(store, KEY_72H).allowed_variables)).not.toContain(VAR_NAME);
  });

  test('a version with a custom text_body gets the placeholder appended; an empty text_body stays empty', async () => {
    const { knex, store } = seededStore();
    await migration.up(knex);
    expect(versionOf(store, 'text-24h').text_body).toBe(`Hi {{first_name}}, see you tomorrow.${TEXT_APPEND}`);
    expect(versionOf(store, `${KEY_24H}-active`).text_body).toBe('');
  });

  test('idempotent: a second run changes nothing, and a version that already carries the variable is skipped', async () => {
    const { knex, store } = seededStore();
    versionOf(store, 'draft-24h').blocks = JSON.stringify([{ type: 'paragraph', content: 'Mine: {{lawn_prep_line}}' }]);
    await migration.up(knex);
    expect(blocksOf(store, 'draft-24h')).toEqual([{ type: 'paragraph', content: 'Mine: {{lawn_prep_line}}' }]);
    const strip = ({ updated_at, ...rest }) => rest;
    const snapshot = JSON.stringify([store.email_templates.map(strip), store.email_template_versions.map(strip)]);
    await migration.up(knex);
    expect(JSON.stringify([store.email_templates.map(strip), store.email_template_versions.map(strip)])).toBe(snapshot);
    expect(JSON.parse(templateOf(store, KEY_24H).allowed_variables).filter((v) => v === VAR_NAME)).toHaveLength(1);
  });

  test('down removes only what up added, and an admin\'s own text is kept', async () => {
    const { knex, store } = seededStore();
    const original = JSON.stringify(store.email_template_versions.map(({ updated_at, ...rest }) => rest));
    const originalTemplate = templateOf(store, KEY_24H);
    const originalVars = [originalTemplate.allowed_variables, originalTemplate.optional_variables];
    await migration.up(knex);
    await migration.down(knex);
    expect(JSON.stringify(store.email_template_versions.map(({ updated_at, ...rest }) => rest))).toBe(original);
    expect(JSON.parse(templateOf(store, KEY_24H).allowed_variables)).not.toContain(VAR_NAME);
    expect(JSON.parse(templateOf(store, KEY_24H).optional_variables)).not.toContain(VAR_NAME);
    expect(JSON.parse(originalVars[0])).toEqual(expect.arrayContaining(['first_name']));
  });

  test('down leaves an admin-edited version that moved on alone', async () => {
    const { knex, store } = seededStore();
    await migration.up(knex);
    versionOf(store, 'draft-24h').blocks = JSON.stringify([{ type: 'callout', content: 'My own note' }]);
    await migration.down(knex);
    expect(blocksOf(store, 'draft-24h')).toEqual([{ type: 'callout', content: 'My own note' }]);
  });

  test('missing tables or a missing template: skipped without error', async () => {
    const none = fakeKnex({ templates: [], versions: [], tables: [] });
    await expect(migration.up(none.knex)).resolves.toBeUndefined();
    await expect(migration.down(none.knex)).resolves.toBeUndefined();
    const noTemplate = fakeKnex({ templates: [], versions: [] });
    await expect(migration.up(noTemplate.knex)).resolves.toBeUndefined();
  });
});

describe('the rendered 24-hour email', () => {
  const ACTIVE = `${KEY_24H}-active`;
  const render = (store, line) => {
    const row = templateOf(store, KEY_24H);
    const version = versionOf(store, ACTIVE);
    return EmailTemplates.renderTemplate({
      template: row,
      version: { id: version.id, subject: seedOf(KEY_24H).subject, preview_text: seedOf(KEY_24H).preview, blocks: JSON.parse(version.blocks), text_body: version.text_body },
      payload: { ...seed.__private.PREVIEW_PAYLOAD, lawn_prep_line: line, card_hold_policy_note: '' },
    });
  };

  test('with an empty line the email is byte-identical to the one before the migration', async () => {
    const { knex, store } = seededStore();
    const before = render(store, '');
    await migration.up(knex);
    const after = render(store, '');
    expect(after.html).toBe(before.html);
    expect(after.text).toBe(before.text);
    expect(after.subject).toBe(before.subject);
    expect(after.validation.ok).toBe(true);
    expect(after.missingPayload).toEqual([]);
  });

  test('with the line: the sentence is in the html and the text, and the pets link is the full https address', async () => {
    const { knex, store } = seededStore();
    await migration.up(knex);
    const line = buildLawnPrevisitLine({ petsStructured: [], emailLinks: true });
    const rendered = render(store, line);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.html).toContain('Please keep sprinklers off tonight and tomorrow morning, unlock the gate, and keep pets inside while we treat.');
    expect(rendered.text).toContain('Have pets? Add them here: https://portal.wavespestcontrol.com/?tab=property#pets');
    expect(rendered.html).toContain('https://portal.wavespestcontrol.com/?tab=property#pets');
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
  });
});
