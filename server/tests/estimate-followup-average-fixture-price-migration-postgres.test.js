// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20261021020000 replaces the old seeded price_summary sample ("$89/mo") in the
// preview fixtures of the four follow-up templates with the live single-service
// price row; only an exact old value, never another template.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

jest.setTimeout(90000);

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `estimate_followup_fixture_price_${randomUUID().replaceAll('-', '')}`;
const MARKER = 'migration:20261021020000';
let admin;
let db;
let migration;
let P; // migration._private

async function cloneTemplate(key) {
  const source = await admin('email_templates').where({ template_key: key }).first();
  if (!source) throw new Error(`Template ${key} is not in the migrated public schema`);
  const { id: _i, active_version_id: _a, ...cols } = source;
  for (const col of ['allowed_variables', 'optional_variables', 'required_variables']) cols[col] = JSON.stringify(cols[col] ?? []);
  const id = randomUUID();
  await db('email_templates').insert({ ...cols, id, active_version_id: null });
  return id;
}

const addFixture = (templateId, name, payload) => db('email_template_fixtures').insert({
  template_id: templateId, name, is_default: name === 'Happy path', payload: JSON.stringify(payload), updated_at: new Date(),
});
const payloadOf = async (templateId, name = 'Happy path') => (await db('email_template_fixtures').where({ template_id: templateId, name }).first()).payload;

async function clearSchema() {
  await db('email_template_fixtures').del();
  await db('email_templates').del();
  await db('audit_log').del();
}

postgres('estimate follow-up average fixture price migration (PostgreSQL)', () => {
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
    for (const table of ['email_templates', 'email_template_fixtures', 'audit_log']) {
      await db.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
    }
    await db.raw('ALTER TABLE email_template_fixtures ADD CONSTRAINT f_tpl_fk FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE CASCADE');
    migration = require('../models/migrations/20261021020000_estimate_followup_average_fixture_price');
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

  test('all four follow-up templates get the live price row, other keys kept, one audit row', async () => {
    const ids = {};
    for (const key of P.KEYS) {
      ids[key] = await cloneTemplate(key);
      await addFixture(ids[key], 'Happy path', { first_name: 'Sam', price_summary: P.OLD_PRICE });
    }
    await migration.up(db);
    for (const key of P.KEYS) {
      expect(await payloadOf(ids[key])).toEqual({ first_name: 'Sam', price_summary: P.NEW_PRICE });
    }
    expect(await db('audit_log').where({ action: `${MARKER}:fixtures` })).toHaveLength(1);
  });

  test('an admin-edited, already-current, blank or keyless fixture is left alone', async () => {
    const id = await cloneTemplate('estimate.viewed_followup');
    await addFixture(id, 'Edited', { price_summary: '$99/mo' });
    await addFixture(id, 'Current', { price_summary: P.NEW_PRICE });
    await addFixture(id, 'Blank', { price_summary: '' });
    await addFixture(id, 'No key', { first_name: 'Sam' });
    await migration.up(db);
    expect(await payloadOf(id, 'Edited')).toEqual({ price_summary: '$99/mo' });
    expect(await payloadOf(id, 'Current')).toEqual({ price_summary: P.NEW_PRICE });
    expect(await payloadOf(id, 'Blank')).toEqual({ price_summary: '' });
    expect(await payloadOf(id, 'No key')).toEqual({ first_name: 'Sam' });
  });

  test('other templates carrying the same sample (delivery, extension notice, deposit) are never touched', async () => {
    for (const key of ['estimate.delivery', 'estimate.extension_notice', 'estimate.deposit_abandoned']) {
      const id = await cloneTemplate(key);
      await addFixture(id, 'Happy path', { price_summary: P.OLD_PRICE });
      await migration.up(db);
      expect(await payloadOf(id)).toEqual({ price_summary: P.OLD_PRICE });
    }
  });

  test('is idempotent and publishes no template version', async () => {
    const id = await cloneTemplate('estimate.followup_final');
    await addFixture(id, 'Happy path', { price_summary: P.OLD_PRICE });
    const before = await db('email_templates').where({ id }).first();
    await migration.up(db);
    const after = await db('email_template_fixtures').where({ template_id: id }).first();
    await migration.up(db);
    expect(await db('email_template_fixtures').where({ template_id: id }).first()).toEqual(after);
    expect(await db('email_templates').where({ id }).first()).toEqual(before);
  });

  test('an empty database, or templates with no fixtures, is tolerated', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
    await cloneTemplate('estimate.expiring_notice');
    await expect(migration.up(db)).resolves.toBeUndefined();
  });

  test('the real migrated database no longer shows the old sample beside the average note', async () => {
    const rows = await admin('email_template_fixtures as f')
      .join('email_templates as t', 't.id', 'f.template_id')
      .whereIn('t.template_key', P.KEYS)
      .select('t.template_key', 'f.payload');
    expect(rows.length).toBeGreaterThanOrEqual(P.KEYS.length);
    for (const { payload } of rows) expect(payload.price_summary).not.toBe(P.OLD_PRICE);
  });

  test('down is a documented no-op', async () => {
    const id = await cloneTemplate('estimate.unviewed_followup');
    await addFixture(id, 'Happy path', { price_summary: P.OLD_PRICE });
    await migration.up(db);
    await migration.down(db);
    expect(await payloadOf(id)).toEqual({ price_summary: P.NEW_PRICE });
  });
});
