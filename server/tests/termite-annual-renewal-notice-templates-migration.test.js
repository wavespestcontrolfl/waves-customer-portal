/**
 * Real PostgreSQL, real DDL/DML: the two template-seed migrations for the
 * termite annual-plan 45/30-day renewal notice (slice 5, "notice ladder") —
 * 20260926000102 (sms_templates row) and 20260926000103 (email_templates +
 * version + fixture). Each migration's tables are cloned from the CONNECTED
 * database's real public schema (`LIKE public.<table> INCLUDING ALL` — this
 * copies columns/defaults/indexes/CHECK constraints, but per Postgres's own
 * LIKE semantics NOT foreign keys, so no seed data is needed for referenced
 * tables like email_preference_groups) into a disposable schema dropped
 * after the suite, same technique as
 * billing-receipt-notice-migration-postgres.test.js. `audit_log` is
 * deliberately NOT cloned — hasTable('audit_log') then reports false in the
 * scratch schema and the email migration's audit-log side write is skipped,
 * which is exactly what its own hasTable guard is for.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-renewal-notice-templates-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const smsMigration = require('../models/migrations/20260926000102_termite_annual_renewal_notice_sms_template');
const emailMigration = require('../models/migrations/20260926000103_termite_annual_renewal_reminder_email_template');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_notice_tmpl_${randomUUID().replace(/-/g, '')}`;
  const admin = knexLib({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 1 } });
  await admin.raw('CREATE SCHEMA ??', [schema]);
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  for (const table of ['sms_templates', 'email_templates', 'email_template_versions', 'email_template_fixtures']) {
    await db.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
  }
  return {
    db,
    async destroy() {
      await db.destroy();
      await admin.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await admin.destroy();
    },
  };
}

describeOrSkip('termite annual renewal-notice template migrations — real Postgres DDL/DML', () => {
  let fixture;

  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  describe('20260926000102_termite_annual_renewal_notice_sms_template', () => {
    test('seeds the termite SMS template with single-brace placeholders and every variable referenced', async () => {
      const { db } = fixture;
      await smsMigration.up(db);
      await smsMigration.up(db); // idempotent repeat-up

      const rows = await db('sms_templates').where({ template_key: 'termite_annual_renewal_notice' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: 'Termite Annual Renewal Notice',
        category: 'retention',
        is_active: true,
      });
      expect(rows[0].body).toBe(
        'Hi {first_name}, your Waves Subterranean Termite Protection at {address_short} renews on {renewal_date} for another 12 months at {renewal_fee}. It renews automatically unless you cancel first: {cancel_link}. Questions? Reply here.',
      );
      expect(rows[0].variables).toEqual(['first_name', 'address_short', 'renewal_date', 'renewal_fee', 'cancel_link']);
      // Every declared variable is actually referenced in the body — a
      // stray/unused declaration would silently never resolve at render time.
      for (const key of rows[0].variables) {
        expect(rows[0].body).toContain(`{${key}}`);
      }
    });

    test('down() removes an unmodified row but preserves an operator edit', async () => {
      const { db } = fixture;
      await smsMigration.up(db);
      await smsMigration.down(db);
      expect(await db('sms_templates').where({ template_key: 'termite_annual_renewal_notice' }).first()).toBeUndefined();

      await smsMigration.up(db);
      await db('sms_templates').where({ template_key: 'termite_annual_renewal_notice' }).update({ name: 'Operator-edited name' });
      await smsMigration.down(db);
      expect(await db('sms_templates').where({ template_key: 'termite_annual_renewal_notice' }).first()).toMatchObject({
        name: 'Operator-edited name',
      });
    });

    test('tolerates a database without sms_templates', async () => {
      const { db } = fixture;
      await db.schema.dropTableIfExists('sms_templates');
      await expect(smsMigration.up(db)).resolves.not.toThrow();
      await expect(smsMigration.down(db)).resolves.not.toThrow();
    });
  });

  describe('20260926000103_termite_annual_renewal_reminder_email_template', () => {
    test('seeds a publishable template (allowed/required variables match what the version actually references)', async () => {
      const { db } = fixture;
      await emailMigration.up(db);
      await emailMigration.up(db); // idempotent repeat-up (second call is a no-op: row already exists)

      const template = await db('email_templates').where({ template_key: 'membership.termite_renewal_reminder' }).first();
      expect(template).toMatchObject({
        name: 'Termite annual renewal reminder',
        status: 'active',
        send_stream: 'transactional_required',
        suppression_group_key: 'transactional_required',
        default_cta_label: 'Cancel online',
        default_cta_url_variable: 'cancel_link',
      });
      expect(template.allowed_variables.sort()).toEqual([
        'address', 'cancel_link', 'first_name', 'last_inspection_sentence',
        'new_end', 'new_start', 'renewal_date', 'renewal_fee',
      ]);
      expect(template.required_variables.sort()).toEqual([
        'address', 'cancel_link', 'first_name', 'new_end', 'new_start', 'renewal_date', 'renewal_fee',
      ]);

      const versions = await db('email_template_versions').where({ template_id: template.id });
      expect(versions).toHaveLength(1);
      expect(versions[0].status).toBe('active');
      expect(template.active_version_id).toBe(versions[0].id);

      const fixtures = await db('email_template_fixtures').where({ template_id: template.id });
      expect(fixtures).toHaveLength(1);
      expect(fixtures[0].is_default).toBe(true);

      // Publishable: every required var is referenced somewhere in the
      // version's content, and nothing referenced falls outside
      // allowed_variables — same check the admin publish path enforces
      // (validationFor), same shape the billing.receipt_notice test pins.
      const { validationFor } = jest.requireActual('../services/email-template-library');
      const validation = validationFor(template, versions[0]);
      expect(validation.disallowed_variables).toEqual([]);
      expect(validation.missing_required_in_template).toEqual([]);
      expect(validation.ok).toBe(true);

      // The last-inspection sentence is a lone paragraph block whose
      // content is ENTIRELY the optional variable — renderBlocks drops it
      // cleanly when empty rather than rendering a broken half-sentence.
      const lastInspectionBlock = versions[0].blocks.find((b) => b.content === '{{last_inspection_sentence}}');
      expect(lastInspectionBlock).toBeTruthy();
    });

    test('tolerates a database without the email template tables', async () => {
      const { db } = fixture;
      for (const table of ['email_template_fixtures', 'email_template_versions', 'email_templates']) {
        await db.schema.dropTableIfExists(table);
      }
      await expect(emailMigration.up(db)).resolves.not.toThrow();
      await expect(emailMigration.down(db)).resolves.not.toThrow();
    });
  });
});
