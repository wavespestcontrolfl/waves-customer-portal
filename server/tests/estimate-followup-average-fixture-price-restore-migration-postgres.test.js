// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20261021030000 puts the old fixture price sample ("$89/mo") back on the follow-up
// templates whose ACTIVE version cannot show the monthly average (20261021010000
// skipped them), only where the fixture still holds the 20261021020000 value.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

jest.setTimeout(90000);

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `estimate_followup_fixture_restore_${randomUUID().replaceAll('-', '')}`;
const MARKER = 'migration:20261021030000';
let admin;
let db;
let migration;
let P; // migration._private

const SUPPORTED_BLOCKS = [
  { type: 'details', rows: [{ label: 'Estimate', value: '{{price_summary}}' }] },
  { type: 'paragraph', content: '{{estimate_average_note}}' },
];

// A clone of a real template with its own active version, so the migration reads real rows.
async function cloneTemplate(key, { blocks = SUPPORTED_BLOCKS, text_body = null, noVersion = false } = {}) {
  const source = await admin('email_templates').where({ template_key: key }).first();
  if (!source) throw new Error(`Template ${key} is not in the migrated public schema`);
  const { id: _i, active_version_id: _a, ...cols } = source;
  for (const col of ['allowed_variables', 'optional_variables', 'required_variables']) cols[col] = JSON.stringify(cols[col] ?? []);
  const id = randomUUID();
  await db('email_templates').insert({ ...cols, id, active_version_id: null });
  if (!noVersion) {
    const versionId = randomUUID();
    await db('email_template_versions').insert({
      id: versionId, template_id: id, version_number: 1, status: 'active', subject: 'S', preview_text: 'P',
      blocks: JSON.stringify(blocks), text_body, published_at: new Date(),
    });
    await db('email_templates').where({ id }).update({ active_version_id: versionId });
  }
  return id;
}

const addFixture = (templateId, name, payload) => db('email_template_fixtures').insert({
  template_id: templateId, name, is_default: name === 'Happy path', payload: JSON.stringify(payload), updated_at: new Date(),
});
const payloadOf = async (templateId, name = 'Happy path') => (await db('email_template_fixtures').where({ template_id: templateId, name }).first()).payload;

async function clearSchema() {
  await db('email_template_fixtures').del();
  await db('email_template_versions').del();
  await db('email_templates').del();
  await db('audit_log').del();
}

postgres('estimate follow-up average fixture price restore migration (PostgreSQL)', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a verified private QA database or the isolated CI database');

    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    db = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    for (const table of ['email_templates', 'email_template_versions', 'email_template_fixtures', 'audit_log']) {
      await db.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    await db.raw('ALTER TABLE email_template_versions ADD CONSTRAINT v_tpl_fk FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE CASCADE');
    await db.raw('ALTER TABLE email_template_fixtures ADD CONSTRAINT f_tpl_fk FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE CASCADE');
    migration = require('../models/migrations/20261021030000_estimate_followup_average_fixture_price_restore');
    P = migration._private;
  }, 60000);

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  beforeEach(async () => { await clearSchema(); jest.clearAllMocks(); });

  test('a template forced to the skip path gets "$89/mo" back; supported templates keep the new value', async () => {
    const skippedBlocks = [{ type: 'details', rows: [{ label: 'Estimate', value: '{{price_summary}}' }] }];
    const ids = {
      'estimate.unviewed_followup': await cloneTemplate('estimate.unviewed_followup', { blocks: skippedBlocks }),
      'estimate.viewed_followup': await cloneTemplate('estimate.viewed_followup', { text_body: 'Custom text body.' }),
      'estimate.followup_final': await cloneTemplate('estimate.followup_final'),
      'estimate.expiring_notice': await cloneTemplate('estimate.expiring_notice', { text_body: 'x {{price_summary}} {{estimate_average_note}}' }),
    };
    for (const id of Object.values(ids)) await addFixture(id, 'Happy path', { first_name: 'Sam', price_summary: P.AVERAGE_PRICE });
    await migration.up(db);
    expect(await payloadOf(ids['estimate.unviewed_followup'])).toEqual({ first_name: 'Sam', price_summary: P.SEEDED_PRICE });
    expect(await payloadOf(ids['estimate.viewed_followup'])).toEqual({ first_name: 'Sam', price_summary: P.SEEDED_PRICE });
    expect(await payloadOf(ids['estimate.followup_final'])).toEqual({ first_name: 'Sam', price_summary: P.AVERAGE_PRICE });
    expect(await payloadOf(ids['estimate.expiring_notice'])).toEqual({ first_name: 'Sam', price_summary: P.AVERAGE_PRICE });
    expect(await db('audit_log').where({ action: `${MARKER}:fixtures` })).toHaveLength(1);
  });

  test('a template with no active version counts as unsupported', async () => {
    const id = await cloneTemplate('estimate.followup_final', { noVersion: true });
    await addFixture(id, 'Happy path', { price_summary: P.AVERAGE_PRICE });
    await migration.up(db);
    expect(await payloadOf(id)).toEqual({ price_summary: P.SEEDED_PRICE });
  });

  test('an admin-edited, already-seeded, blank or keyless fixture on a skipped template is left alone', async () => {
    const id = await cloneTemplate('estimate.viewed_followup', { blocks: [] });
    await addFixture(id, 'Edited', { price_summary: '$99/mo' });
    await addFixture(id, 'Seeded', { price_summary: P.SEEDED_PRICE });
    await addFixture(id, 'Blank', { price_summary: '' });
    await addFixture(id, 'No key', { first_name: 'Sam' });
    await migration.up(db);
    expect(await payloadOf(id, 'Edited')).toEqual({ price_summary: '$99/mo' });
    expect(await payloadOf(id, 'Seeded')).toEqual({ price_summary: P.SEEDED_PRICE });
    expect(await payloadOf(id, 'Blank')).toEqual({ price_summary: '' });
    expect(await payloadOf(id, 'No key')).toEqual({ first_name: 'Sam' });
  });

  test('other templates (delivery, extension notice) are never touched, even when unsupported', async () => {
    for (const key of ['estimate.delivery', 'estimate.extension_notice']) {
      const id = await cloneTemplate(key, { blocks: [] });
      await addFixture(id, 'Happy path', { price_summary: P.AVERAGE_PRICE });
      await migration.up(db);
      expect(await payloadOf(id)).toEqual({ price_summary: P.AVERAGE_PRICE });
    }
  });

  test('is idempotent and publishes no template version', async () => {
    const id = await cloneTemplate('estimate.followup_final', { blocks: [] });
    await addFixture(id, 'Happy path', { price_summary: P.AVERAGE_PRICE });
    const versionsBefore = await db('email_template_versions').select('id', 'status').orderBy('id');
    await migration.up(db);
    const after = await db('email_template_fixtures').where({ template_id: id }).first();
    await migration.up(db);
    expect(await db('email_template_fixtures').where({ template_id: id }).first()).toEqual(after);
    expect(await db('email_template_versions').select('id', 'status').orderBy('id')).toEqual(versionsBefore);
  });

  test('an empty database is tolerated', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
  });

  test('the real migrated database keeps the new value on every template that shows the average', async () => {
    const rows = await admin('email_template_fixtures as f')
      .join('email_templates as t', 't.id', 'f.template_id')
      .join('email_template_versions as v', 'v.id', 't.active_version_id')
      .whereIn('t.template_key', P.KEYS)
      .select('t.template_key', 'f.payload', 'v.blocks', 'v.text_body');
    expect(rows.length).toBeGreaterThanOrEqual(P.KEYS.length);
    for (const row of rows) {
      expect(P.versionShowsAverage(row)).toBe(true);
      expect(row.payload.price_summary).toBe(P.AVERAGE_PRICE);
    }
  });

  test('down is a documented no-op', async () => {
    const id = await cloneTemplate('estimate.followup_final', { blocks: [] });
    await addFixture(id, 'Happy path', { price_summary: P.AVERAGE_PRICE });
    await migration.up(db);
    await migration.down(db);
    expect(await payloadOf(id)).toEqual({ price_summary: P.SEEDED_PRICE });
  });
});
