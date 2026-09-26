/**
 * Real PostgreSQL: 20260925030002_termite_annual_v3_countersignature_and_billing_clause
 * revises the still-DRAFT v3 body a second time (scratch schema, same
 * harness/safety as termite-annual-v3-signature-block-migration.test.js).
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npm exec jest -- --runInBand server/tests/termite-annual-v3-countersignature-clause-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const seed = require('../models/migrations/20260924030002_termite_annual_protection_agreement_v3');
const r2 = require('../models/migrations/20260924030003_termite_annual_v3_signature_block');
const revision = require('../models/migrations/20260925030002_termite_annual_v3_countersignature_and_billing_clause');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_v3ctr_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  await db.raw(`
    CREATE TABLE document_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_key varchar(120) NOT NULL UNIQUE,
      name varchar(180) NOT NULL,
      category varchar(80) NOT NULL DEFAULT 'general',
      document_type varchar(80) NOT NULL DEFAULT 'other',
      status varchar(30) NOT NULL DEFAULT 'draft',
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

// Cross-check with the charge path (#4819): termite-annual-signature-charge
// charges the saved method only when the SIGNED text carries
// ANNUAL_INITIAL_CHARGE_AUTHORIZATION (whitespace-normalized). This revision
// is what introduces that clause — the r2 body must not authorize it.
describe('20260925030002 billing clause authorizes the signature-time charge', () => {
  const { agreementAuthorizesInitialCharge } = jest.requireActual('../services/termite-program-agreement');
  const revisionModule = require('../models/migrations/20260925030002_termite_annual_v3_countersignature_and_billing_clause');
  const r2Module = require('../models/migrations/20260924030003_termite_annual_v3_signature_block');

  test('the revised body carries the authorization phrase across its line wraps', () => {
    expect(agreementAuthorizesInitialCharge(revisionModule.TEMPLATE_V3_ANNUAL_R3_BODY)).toBe(true);
  });

  test('the r2 body before this revision does not', () => {
    expect(agreementAuthorizesInitialCharge(r2Module.TEMPLATE_V3_ANNUAL_R2_BODY)).toBe(false);
  });
});

describeOrSkip('20260925030002_termite_annual_v3_countersignature_and_billing_clause — real Postgres', () => {
  let fixture;
  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('adds the countersignature sentence + the signing-charge clause to the unpublished draft (after 030002 + 030003 have run); down() restores the r2 body', async () => {
    const { db } = fixture;
    await seed.up(db);
    await r2.up(db);
    expect(await currentBody(db)).toBe(r2.TEMPLATE_V3_ANNUAL_R2_BODY);

    await revision.up(db);
    const body = await currentBody(db);
    expect(body).toBe(revision.TEMPLATE_V3_ANNUAL_R3_BODY);
    expect(body).toContain('certified operator in charge countersigns this agreement as a');
    expect(body).toContain('does not delay');
    expect(body).toContain('coverage, billing, or scheduling.');
    expect(body).toContain('Waves charges them to the payment');
    expect(body).toContain('sends a payment link');
    expect(body.endsWith(`\n\n${revision.COUNTERSIGNATURE_BLOCK}`)).toBe(true);
    // The e-sign disclosure and pricing sections are untouched.
    expect(body).toContain('ELECTRONIC SIGNATURE');
    expect(body).toContain('Annual protection fee (prepaid; 12 months of coverage; one annual');

    await revision.down(db);
    expect(await currentBody(db)).toBe(r2.TEMPLATE_V3_ANNUAL_R2_BODY);
  });

  test('no-ops if 030003 never ran (body is still the seed, not r2) — an operator-edited or out-of-order draft is left alone', async () => {
    const { db } = fixture;
    await seed.up(db);
    await revision.up(db);
    expect(await currentBody(db)).toBe(seed.TEMPLATE_V3_ANNUAL.body);
  });

  test('leaves an operator-edited draft alone', async () => {
    const { db } = fixture;
    await seed.up(db);
    await r2.up(db);
    await db('document_template_versions').update({ body: 'operator edited after r2' });
    await revision.up(db);
    expect(await currentBody(db)).toBe('operator edited after r2');
    await revision.down(db);
    expect(await currentBody(db)).toBe('operator edited after r2');
  });

  test('leaves a published version alone', async () => {
    const { db } = fixture;
    await seed.up(db);
    await r2.up(db);
    await db('document_template_versions').update({ published_at: db.fn.now() });
    await revision.up(db);
    expect(await currentBody(db)).toBe(r2.TEMPLATE_V3_ANNUAL_R2_BODY);
  });

  test('no-ops when the template was never seeded or the tables are absent', async () => {
    const { db } = fixture;
    await expect(revision.up(db)).resolves.toBeUndefined();
    await db.raw('DROP TABLE document_template_versions; DROP TABLE document_templates;');
    await expect(revision.up(db)).resolves.toBeUndefined();
    await expect(revision.down(db)).resolves.toBeUndefined();
  });
});
