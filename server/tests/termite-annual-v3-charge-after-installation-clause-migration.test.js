/**
 * Real PostgreSQL: 20261003130000_termite_annual_v3_charge_after_installation_clause
 * revises the still-DRAFT v3 body a third time (scratch schema, same
 * harness/safety as termite-annual-v3-countersignature-clause-migration.test.js),
 * and the page's charge-timing reader that depends on it.
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npm exec jest -- --runInBand server/tests/termite-annual-v3-charge-after-installation-clause-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const seed = require('../models/migrations/20260924030002_termite_annual_protection_agreement_v3');
const r2 = require('../models/migrations/20260924030003_termite_annual_v3_signature_block');
const r3 = require('../models/migrations/20260925030002_termite_annual_v3_countersignature_and_billing_clause');
const revision = require('../models/migrations/20261003130000_termite_annual_v3_charge_after_installation_clause');

jest.setTimeout(60000);

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_v3inst_${randomUUID().replace(/-/g, '')}`;
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

async function seedThroughR3(db) {
  await seed.up(db);
  await r2.up(db);
  await r3.up(db);
}

describeOrSkip('20261003130000_termite_annual_v3_charge_after_installation_clause — real Postgres', () => {
  let fixture;
  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => {
    jest.resetModules();
    delete process.env.GATE_PAY_AFTER_FIRST_VISIT;
    delete process.env.GATE_PAF_TERMITE;
    if (fixture) await fixture.destroy();
  });

  test('rewrites the unpublished draft to the approved clause; down() restores the at-signing body', async () => {
    const { db } = fixture;
    await seedThroughR3(db);
    expect(await currentBody(db)).toBe(r3.TEMPLATE_V3_ANNUAL_R3_BODY);

    await revision.up(db);
    const body = await currentBody(db);
    expect(body).toBe(revision.TEMPLATE_V3_ANNUAL_R4_BODY);
    expect(body).toContain('Waves charges them to the payment method on file after the station');
    expect(body).toContain('not go through, sends a payment link.');
    expect(body).not.toContain('at signing');
    expect(body.endsWith(`\n\n${r3.COUNTERSIGNATURE_BLOCK}`)).toBe(true);

    await revision.up(db); // idempotent
    expect(await currentBody(db)).toBe(revision.TEMPLATE_V3_ANNUAL_R4_BODY);

    await revision.down(db);
    expect(await currentBody(db)).toBe(r3.TEMPLATE_V3_ANNUAL_R3_BODY);
  });

  test('no-ops if 030002 never ran — an out-of-order draft is left alone', async () => {
    const { db } = fixture;
    await seed.up(db);
    await r2.up(db);
    await revision.up(db);
    expect(await currentBody(db)).toBe(r2.TEMPLATE_V3_ANNUAL_R2_BODY);
  });

  test('leaves an operator-edited draft alone', async () => {
    const { db } = fixture;
    await seedThroughR3(db);
    await db('document_template_versions').update({ body: 'operator edited after r3' });
    await revision.up(db);
    expect(await currentBody(db)).toBe('operator edited after r3');
    await revision.down(db);
    expect(await currentBody(db)).toBe('operator edited after r3');
  });

  test('leaves a published version alone', async () => {
    const { db } = fixture;
    await seedThroughR3(db);
    await db('document_template_versions').update({ published_at: db.fn.now() });
    await revision.up(db);
    expect(await currentBody(db)).toBe(r3.TEMPLATE_V3_ANNUAL_R3_BODY);
  });

  describe('annualAgreementChargesAfterInstallation (the estimate page\'s charge-timing sentence)', () => {
    async function publish(db) {
      const version = await db('document_template_versions').first('id', 'template_id');
      await db('document_template_versions').where({ id: version.id }).update({ published_at: db.fn.now() });
      await db('document_templates').where({ id: version.template_id }).update({ status: 'active', active_version_id: version.id });
    }
    function reader(db, { master, termite }) {
      if (master) process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
      if (termite) process.env.GATE_PAF_TERMITE = 'true';
      jest.doMock('../models/db', () => db);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      return require('../services/termite-program-agreement').annualAgreementChargesAfterInstallation;
    }

    test('true only with the gate on AND the after-installation wording active', async () => {
      const { db } = fixture;
      await seedThroughR3(db);
      await revision.up(db);
      await publish(db);
      expect(await reader(db, { master: true, termite: true })(db)).toBe(true);
    });

    test('false while GATE_PAF_TERMITE is off', async () => {
      const { db } = fixture;
      await seedThroughR3(db);
      await revision.up(db);
      await publish(db);
      expect(await reader(db, { master: true, termite: false })(db)).toBe(false);
    });

    test('false while the template is still a draft', async () => {
      const { db } = fixture;
      await seedThroughR3(db);
      await revision.up(db);
      expect(await reader(db, { master: true, termite: true })(db)).toBe(false);
    });

    test('false for the at-signing wording', async () => {
      const { db } = fixture;
      await seedThroughR3(db);
      await publish(db);
      expect(await reader(db, { master: true, termite: true })(db)).toBe(false);
    });
  });
});
