// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20261019220000 blanks the sample estimate_pdf_note that 20261019200000 seeded
// into the estimate.extension_notice preview fixtures (the auto-renew notice no
// longer carries a PDF). Only that template's fixtures, and only a value that is
// still exactly the seeded text.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

jest.setTimeout(90000);

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `estimate_ext_fixture_${randomUUID().replaceAll('-', '')}`;
const MARKER = 'migration:20261019220000';
let admin;
let db;
let migration;
let SEEDED;

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
const noteOf = async (templateId, name) => (await db('email_template_fixtures').where({ template_id: templateId, name }).first()).payload;

async function clearSchema() {
  await db('email_template_fixtures').del();
  await db('email_templates').del();
  await db('audit_log').del();
}

postgres('estimate extension notice fixture migration (PostgreSQL)', () => {
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
    migration = require('../models/migrations/20261019220000_estimate_extension_notice_pdf_note_fixture');
    SEEDED = migration._private.SEEDED_NOTE;
  }, 60000);

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  beforeEach(async () => { await clearSchema(); jest.clearAllMocks(); });

  test('blanks the seeded sample in the extension notice fixtures and keeps every other key', async () => {
    const id = await cloneTemplate('estimate.extension_notice');
    await addFixture(id, 'Happy path', { first_name: 'Sam', new_expiry: 'October 30', estimate_pdf_note: SEEDED });
    await migration.up(db);
    expect(await noteOf(id, 'Happy path')).toEqual({ first_name: 'Sam', new_expiry: 'October 30', estimate_pdf_note: '' });
    const audit = await db('audit_log').where({ action: `${MARKER}:fixtures` });
    expect(audit).toHaveLength(1);
  });

  test('an admin-edited note, a blank one and a fixture without the key are left alone', async () => {
    const id = await cloneTemplate('estimate.extension_notice');
    await addFixture(id, 'Edited', { estimate_pdf_note: 'Admin-edited note' });
    await addFixture(id, 'Blank', { estimate_pdf_note: '' });
    await addFixture(id, 'No key', { first_name: 'Sam' });
    await migration.up(db);
    expect(await noteOf(id, 'Edited')).toEqual({ estimate_pdf_note: 'Admin-edited note' });
    expect(await noteOf(id, 'Blank')).toEqual({ estimate_pdf_note: '' });
    expect(await noteOf(id, 'No key')).toEqual({ first_name: 'Sam' });
  });

  test('only the extension notice: another template carrying the same seeded text is untouched', async () => {
    const ext = await cloneTemplate('estimate.extension_notice');
    const other = await cloneTemplate('estimate.extended');
    await addFixture(ext, 'Happy path', { estimate_pdf_note: SEEDED });
    await addFixture(other, 'Happy path', { estimate_pdf_note: SEEDED });
    await migration.up(db);
    expect(await noteOf(ext, 'Happy path')).toEqual({ estimate_pdf_note: '' });
    expect(await noteOf(other, 'Happy path')).toEqual({ estimate_pdf_note: SEEDED });
  });

  test('publishes no template version and touches no template row', async () => {
    const id = await cloneTemplate('estimate.extension_notice');
    await addFixture(id, 'Happy path', { estimate_pdf_note: SEEDED });
    const before = await db('email_templates').where({ id }).first();
    await migration.up(db);
    expect(await db('email_templates').where({ id }).first()).toEqual(before);
  });

  test('is idempotent', async () => {
    const id = await cloneTemplate('estimate.extension_notice');
    await addFixture(id, 'Happy path', { estimate_pdf_note: SEEDED });
    await migration.up(db);
    const after = await db('email_template_fixtures').where({ template_id: id }).first();
    await migration.up(db);
    expect(await db('email_template_fixtures').where({ template_id: id }).first()).toEqual(after);
  });

  test('a missing template, or no fixtures, is tolerated', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
    await cloneTemplate('estimate.extension_notice');
    await expect(migration.up(db)).resolves.toBeUndefined();
  });

  test('the real migrated database carries the blanked fixture and, with it, an untouched sibling', async () => {
    const rows = await admin('email_template_fixtures as f').join('email_templates as t', 't.id', 'f.template_id')
      .whereIn('t.template_key', ['estimate.extension_notice', 'estimate.extended'])
      .select('t.template_key', 'f.payload');
    const ext = rows.filter((r) => r.template_key === 'estimate.extension_notice');
    expect(ext.length).toBeGreaterThan(0);
    for (const r of ext) expect(r.payload.estimate_pdf_note ?? '').not.toBe(SEEDED);
  });

  test('down is a documented no-op', async () => {
    const id = await cloneTemplate('estimate.extension_notice');
    await addFixture(id, 'Happy path', { estimate_pdf_note: SEEDED });
    await migration.up(db);
    await migration.down(db);
    expect(await noteOf(id, 'Happy path')).toEqual({ estimate_pdf_note: '' });
  });
});
