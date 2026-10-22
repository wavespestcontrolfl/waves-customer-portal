// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
//
// 20261019230000 replaces the old seeded estimate_pdf_note samples in the
// preview fixtures with the current mode-neutral text: estimate.delivery and the
// 12 follow-up templates; never extension_notice; only an exact old value.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');

jest.setTimeout(90000);

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `estimate_note_copy_${randomUUID().replaceAll('-', '')}`;
const MARKER = 'migration:20261019230000';
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

postgres('estimate email PDF note fixture copy migration (PostgreSQL)', () => {
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
    migration = require('../models/migrations/20261019230000_estimate_email_pdf_note_fixture_copy');
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

  test('the delivery template and all 12 follow-up templates get the current text, other keys kept', async () => {
    const ids = {};
    ids['estimate.delivery'] = await cloneTemplate('estimate.delivery');
    await addFixture(ids['estimate.delivery'], 'Happy path', { first_name: 'Sam', estimate_pdf_note: P.OLD_DELIVERY });
    for (const key of P.FOLLOW_UP_KEYS) {
      ids[key] = await cloneTemplate(key);
      await addFixture(ids[key], 'Happy path', { first_name: 'Sam', estimate_pdf_note: P.OLD_FOLLOW_UP });
    }
    await migration.up(db);
    expect(await payloadOf(ids['estimate.delivery'])).toEqual({ first_name: 'Sam', estimate_pdf_note: P.NEW_DELIVERY });
    for (const key of P.FOLLOW_UP_KEYS) {
      expect(await payloadOf(ids[key])).toEqual({ first_name: 'Sam', estimate_pdf_note: P.NEW_FOLLOW_UP });
    }
    expect(await db('audit_log').where({ action: `${MARKER}:fixtures` })).toHaveLength(1);
  });

  test('an admin-edited, already-current, blank or keyless fixture is left alone', async () => {
    const id = await cloneTemplate('estimate.delivery');
    await addFixture(id, 'Edited', { estimate_pdf_note: 'Admin-edited note' });
    await addFixture(id, 'Current', { estimate_pdf_note: P.NEW_DELIVERY });
    await addFixture(id, 'Blank', { estimate_pdf_note: '' });
    await addFixture(id, 'No key', { first_name: 'Sam' });
    await migration.up(db);
    expect(await payloadOf(id, 'Edited')).toEqual({ estimate_pdf_note: 'Admin-edited note' });
    expect(await payloadOf(id, 'Current')).toEqual({ estimate_pdf_note: P.NEW_DELIVERY });
    expect(await payloadOf(id, 'Blank')).toEqual({ estimate_pdf_note: '' });
    expect(await payloadOf(id, 'No key')).toEqual({ first_name: 'Sam' });
  });

  test('the delivery template never takes the follow-up sample, and a follow-up template never takes the delivery one', async () => {
    const delivery = await cloneTemplate('estimate.delivery');
    const followUp = await cloneTemplate('estimate.viewed_followup');
    await addFixture(delivery, 'Happy path', { estimate_pdf_note: P.OLD_FOLLOW_UP });
    await addFixture(followUp, 'Happy path', { estimate_pdf_note: P.OLD_DELIVERY });
    await migration.up(db);
    expect(await payloadOf(delivery)).toEqual({ estimate_pdf_note: P.OLD_FOLLOW_UP });
    expect(await payloadOf(followUp)).toEqual({ estimate_pdf_note: P.OLD_DELIVERY });
  });

  test('estimate.extension_notice (blanked by 20261019220000) and other templates are never touched', async () => {
    const ext = await cloneTemplate('estimate.extension_notice');
    const other = await cloneTemplate('estimate.deposit_abandoned');
    await addFixture(ext, 'Happy path', { estimate_pdf_note: P.OLD_FOLLOW_UP });
    await addFixture(other, 'Happy path', { estimate_pdf_note: P.OLD_FOLLOW_UP });
    await migration.up(db);
    expect(await payloadOf(ext)).toEqual({ estimate_pdf_note: P.OLD_FOLLOW_UP });
    expect(await payloadOf(other)).toEqual({ estimate_pdf_note: P.OLD_FOLLOW_UP });
  });

  test('is idempotent and publishes nothing', async () => {
    const id = await cloneTemplate('estimate.delivery');
    await addFixture(id, 'Happy path', { estimate_pdf_note: P.OLD_DELIVERY });
    const before = await db('email_templates').where({ id }).first();
    await migration.up(db);
    const after = await db('email_template_fixtures').where({ template_id: id }).first();
    await migration.up(db);
    expect(await db('email_template_fixtures').where({ template_id: id }).first()).toEqual(after);
    expect(await db('email_templates').where({ id }).first()).toEqual(before);
  });

  test('an empty database, or templates with no fixtures, is tolerated', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
    await cloneTemplate('estimate.delivery');
    await expect(migration.up(db)).resolves.toBeUndefined();
  });

  test('the real migrated database no longer carries an old seeded sample anywhere', async () => {
    const rows = await admin('email_template_fixtures').select('payload');
    for (const { payload } of rows) {
      expect([P.OLD_DELIVERY, P.OLD_FOLLOW_UP]).not.toContain(payload?.estimate_pdf_note);
    }
  });

  test('down is a documented no-op', async () => {
    const id = await cloneTemplate('estimate.delivery');
    await addFixture(id, 'Happy path', { estimate_pdf_note: P.OLD_DELIVERY });
    await migration.up(db);
    await migration.down(db);
    expect(await payloadOf(id)).toEqual({ estimate_pdf_note: P.NEW_DELIVERY });
  });
});
