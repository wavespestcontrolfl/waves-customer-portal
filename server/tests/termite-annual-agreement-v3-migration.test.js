/**
 * Real PostgreSQL: 20260924030002_termite_annual_protection_agreement_v3
 * runs its up()/down() against a scratch schema (random name, dropped after
 * each test) inside a local throwaway database — same safety-checked
 * convention as termite-annual-plan-stamps-migration.test.js: localhost
 * only, and only the invoice_repair_test / waves_test database names.
 *
 * The fixture tables are the minimal document_templates /
 * document_template_versions shape the migration's inserts touch (mirroring
 * 20260601000009_document_template_library), not a claim that every
 * production migration ran.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL set to such a database, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npm exec jest -- --runInBand server/tests/termite-annual-agreement-v3-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20260924030002_termite_annual_protection_agreement_v3');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_v3_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`
    CREATE TABLE document_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_key varchar(120) NOT NULL UNIQUE,
      name varchar(180) NOT NULL,
      category varchar(80) NOT NULL DEFAULT 'general',
      document_type varchar(80) NOT NULL DEFAULT 'other',
      status varchar(30) NOT NULL DEFAULT 'active',
      description text,
      requires_signature boolean NOT NULL DEFAULT true,
      audience varchar(60) NOT NULL DEFAULT 'customer',
      variables jsonb NOT NULL DEFAULT '[]'::jsonb,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      active_version_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE document_template_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id uuid NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
      version_number integer NOT NULL,
      title varchar(220) NOT NULL,
      body text NOT NULL,
      signer_disclosure text,
      variables jsonb NOT NULL DEFAULT '[]'::jsonb,
      required_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (template_id, version_number)
    );
  `);
  return { db, schema, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

// A live quarterly template the way prod has it (v2 active) — the seed must
// leave it untouched.
async function seedActiveQuarterly(db) {
  const [template] = await db('document_templates').insert({
    template_key: 'service_agreement.termite_bait_program_purchase',
    name: 'Termite Bait Program Agreement (Purchase)',
    status: 'active',
  }).returning('*');
  const [version] = await db('document_template_versions').insert({
    template_id: template.id, version_number: 2, title: 'Purchase v2', body: 'quarterly body', published_at: db.fn.now(),
  }).returning('*');
  await db('document_templates').where({ id: template.id }).update({ active_version_id: version.id });
  return template.id;
}

describeOrSkip('20260924030002_termite_annual_protection_agreement_v3 — real Postgres', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('up() seeds exactly one DRAFT template with one unpublished version and no active_version_id', async () => {
    const { db } = fixture;
    const quarterlyId = await seedActiveQuarterly(db);
    await migration.up(db);

    const row = await db('document_templates').where({ template_key: migration.TEMPLATE_KEY }).first();
    expect(row).toBeTruthy();
    expect(row.status).toBe('draft');
    expect(row.active_version_id).toBeNull();
    expect(row.requires_signature).toBe(true);
    expect(row.variables).toEqual(migration.TEMPLATE_V3_ANNUAL.variables);
    expect(row.tags).toEqual(expect.arrayContaining(['termite', 'annual', 'draft']));

    const versions = await db('document_template_versions').where({ template_id: row.id });
    expect(versions).toHaveLength(1);
    expect(versions[0].version_number).toBe(1);
    expect(versions[0].published_at).toBeNull();
    expect(versions[0].body).toBe(migration.TEMPLATE_V3_ANNUAL.body);

    // Nothing selectable by the service's status:'active' lookup.
    const active = await db('document_templates').where({ template_key: migration.TEMPLATE_KEY, status: 'active' }).first();
    expect(active).toBeUndefined();

    // The live quarterly template is untouched.
    const quarterly = await db('document_templates').where({ id: quarterlyId }).first();
    expect(quarterly.status).toBe('active');
    expect(quarterly.active_version_id).not.toBeNull();
  });

  test('up() is idempotent and never overwrites an operator-edited draft', async () => {
    const { db } = fixture;
    await migration.up(db);
    const row = await db('document_templates').where({ template_key: migration.TEMPLATE_KEY }).first('id');
    await db('document_template_versions').where({ template_id: row.id }).update({ body: 'operator edited' });
    await migration.up(db);

    const versions = await db('document_template_versions').where({ template_id: row.id });
    expect(versions).toHaveLength(1);
    expect(versions[0].body).toBe('operator edited');
    expect(await db('document_templates').where({ template_key: migration.TEMPLATE_KEY }).count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('down() removes the inert draft and its version', async () => {
    const { db } = fixture;
    await migration.up(db);
    await migration.down(db);
    expect(await db('document_templates').where({ template_key: migration.TEMPLATE_KEY }).first()).toBeUndefined();
    expect(await db('document_template_versions').count('* as n').first()).toMatchObject({ n: '0' });
  });

  test('down() refuses to delete the template once a later migration has activated it', async () => {
    const { db } = fixture;
    await migration.up(db);
    const row = await db('document_templates').where({ template_key: migration.TEMPLATE_KEY }).first('id');
    const version = await db('document_template_versions').where({ template_id: row.id }).first('id');
    await db('document_templates').where({ id: row.id }).update({ status: 'active', active_version_id: version.id });
    await db('document_template_versions').where({ id: version.id }).update({ published_at: db.fn.now() });

    await migration.down(db);

    const still = await db('document_templates').where({ id: row.id }).first();
    expect(still).toBeTruthy();
    expect(still.active_version_id).toBe(version.id);
    expect(await db('document_template_versions').where({ template_id: row.id })).toHaveLength(1);
  });

  test('up() is a no-op when the document template tables do not exist', async () => {
    const { db } = fixture;
    await db.raw('DROP TABLE document_template_versions; DROP TABLE document_templates;');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
