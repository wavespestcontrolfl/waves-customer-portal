/**
 * Real PostgreSQL: 20260924030003 revises the v3 DRAFT body's signature block
 * (scratch schema, same harness/safety as termite-annual-agreement-v3-migration.test.js).
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npm exec jest -- --runInBand server/tests/termite-annual-v3-signature-block-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const seed = require('../models/migrations/20260924030002_termite_annual_protection_agreement_v3');
const revision = require('../models/migrations/20260924030003_termite_annual_v3_signature_block');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_v3sig_${randomUUID().replace(/-/g, '')}`;
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
      variables jsonb NOT NULL DEFAULT '[]'::jsonb,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      active_version_id uuid
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
      UNIQUE (template_id, version_number)
    );
  `);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

async function currentBody(db) {
  const row = await db('document_template_versions').first('body');
  return row.body;
}

describeOrSkip('20260924030003_termite_annual_v3_signature_block — real Postgres', () => {
  let fixture;
  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('replaces the seeded ink-line signature block on the unpublished draft; down() restores it', async () => {
    const { db } = fixture;
    await seed.up(db);
    expect(await currentBody(db)).toContain(revision.ORIGINAL_SIGNATURE_BLOCK);
    await revision.up(db);
    const body = await currentBody(db);
    expect(body).toBe(revision.TEMPLATE_V3_ANNUAL_R2_BODY);
    expect(body).not.toContain('License: ________');
    expect(body).toContain('ELECTRONIC SIGNATURE');
    await revision.down(db);
    expect(await currentBody(db)).toBe(seed.TEMPLATE_V3_ANNUAL.body);
  });

  test('leaves an operator-edited draft alone', async () => {
    const { db } = fixture;
    await seed.up(db);
    await db('document_template_versions').update({ body: 'operator edited' });
    await revision.up(db);
    expect(await currentBody(db)).toBe('operator edited');
    await revision.down(db);
    expect(await currentBody(db)).toBe('operator edited');
  });

  test('leaves a published version alone', async () => {
    const { db } = fixture;
    await seed.up(db);
    await db('document_template_versions').update({ published_at: db.fn.now() });
    await revision.up(db);
    expect(await currentBody(db)).toBe(seed.TEMPLATE_V3_ANNUAL.body);
  });

  test('no-ops when the template was never seeded or the tables are absent', async () => {
    const { db } = fixture;
    await expect(revision.up(db)).resolves.toBeUndefined();
    await db.raw('DROP TABLE document_template_versions; DROP TABLE document_templates;');
    await expect(revision.up(db)).resolves.toBeUndefined();
    await expect(revision.down(db)).resolves.toBeUndefined();
  });
});
