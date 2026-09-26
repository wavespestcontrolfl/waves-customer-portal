// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
// Unlike billing.notice (seeded, then corrected twice), billing.receipt_notice
// is seeded directly in the final corrected shape — one migration, so this
// test proves the seed, repeat-up idempotency, the publishable required
// variables (no first_name), and the non-destructive down.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const seed = require('../models/migrations/20260926000100_billing_receipt_notice_email_template');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_receipt_notice_migration_${randomUUID().replaceAll('-', '')}`;
let admin;
let db;

postgres('billing.receipt_notice email-template migration (PostgreSQL)', () => {
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
  }, 30000);

  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.schema.dropSchemaIfExists(schema, true);
      await admin.destroy();
    }
  });

  test('seeds the final corrected shape, is idempotent on repeat-up, and preserves operator edits on down', async () => {
    await db.transaction(async (trx) => {
      await seed.up(trx);
      await seed.up(trx); // repeat-up must not duplicate anything
    });

    const template = await db('email_templates').where({ template_key: 'billing.receipt_notice' }).first();
    expect(template).toMatchObject({
      name: 'Billing receipt notice',
      mode: 'service',
      purpose: 'billing',
      status: 'active',
      legal_classification: 'transactional_relationship',
      send_stream: 'transactional_required',
      suppression_group_key: 'transactional_required',
      allowed_variables: ['first_name', 'category_label', 'notification_body', 'billing_url'],
      required_variables: ['category_label', 'notification_body', 'billing_url'],
    });

    const versions = await db('email_template_versions').where({ template_id: template.id });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version_number: 1,
      status: 'active',
      subject: '{{category_label}} from Waves',
      blocks: [
        { type: 'heading', content: '{{category_label}}' },
        { type: 'paragraph', content: '{{notification_body}}' },
        { type: 'cta', label: 'Open billing', url_variable: 'billing_url' },
      ],
    });
    expect(template.active_version_id).toBe(versions[0].id);

    const fixtures = await db('email_template_fixtures').where({ template_id: template.id });
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({
      name: 'Payment receipt',
      is_default: true,
      payload: {
        first_name: 'Customer',
        category_label: 'Payment receipt',
        notification_body: 'Your payment was received. Thank you.',
        billing_url: 'https://portal.wavespestcontrol.com/?tab=billing',
      },
    });

    expect(await db('audit_log').where({ action: 'email_template.seeded', resource_id: template.id })).toHaveLength(1);

    // Publishable: required variables are all referenced in the version's
    // content, and the version references nothing outside allowed_variables
    // (the same shape billing.notice ended up in after its two corrections).
    const { validationFor } = jest.requireActual('../services/email-template-library');
    expect(validationFor(template, versions[0]).ok).toBe(true);

    // Operator edits an email that has already gone out (mirrors the
    // billing.notice pattern: the down migration is non-destructive).
    await db('email_templates').where({ id: template.id }).update({ name: 'Operator receipt notice' });
    await db('email_template_fixtures').where({ template_id: template.id })
      .update({ payload: { notification_body: 'Operator fixture' } });

    await seed.down(db);

    expect(await db('email_templates').where({ id: template.id }).first()).toMatchObject({
      name: 'Operator receipt notice',
    });
    expect(await db('email_template_fixtures').where({ template_id: template.id }).first()).toMatchObject({
      payload: { notification_body: 'Operator fixture' },
    });
  }, 30000);
});
