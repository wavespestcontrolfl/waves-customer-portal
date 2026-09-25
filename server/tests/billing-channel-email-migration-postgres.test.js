// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20260924010300_billing_notice_email_template');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `billing_email_migration_${randomUUID().replaceAll('-', '')}`;
let admin;
let db;

postgres('billing.notice email-template migration (PostgreSQL)', () => {
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

  test('is atomic, repeatable, and preserves later operator history', async () => {
    const probe = await db.transaction();
    try {
      await migration.up(probe);
      expect(await probe('email_templates').where({ template_key: 'billing.notice' })).toHaveLength(1);
      expect(await probe('audit_log').where({ action: 'email_template.seeded' })).toHaveLength(1);
    } finally {
      await probe.rollback();
    }
    for (const table of ['email_templates', 'email_template_versions', 'email_template_fixtures', 'audit_log']) {
      expect(await db(table)).toHaveLength(0);
    }

    await db.transaction((trx) => migration.up(trx));
    await db.transaction((trx) => migration.up(trx));
    const template = await db('email_templates').where({ template_key: 'billing.notice' }).first();
    const versions = await db('email_template_versions').where({ template_id: template.id });
    const fixtures = await db('email_template_fixtures').where({ template_id: template.id });
    const audits = await db('audit_log').where({ action: 'email_template.seeded' });

    expect(template).toMatchObject({
      name: 'Billing notice', mode: 'service', purpose: 'billing', status: 'active',
      legal_classification: 'transactional_relationship', active_version_id: versions[0].id,
      allowed_variables: ['first_name', 'category_label', 'notification_body', 'billing_url'],
      required_variables: ['first_name', 'category_label', 'notification_body', 'billing_url'],
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version_number: 1, status: 'active', subject: '{{category_label}} from Waves',
      blocks: [
        { type: 'heading', content: '{{category_label}}' },
        { type: 'paragraph', content: '{{notification_body}}' },
        { type: 'cta', label: 'Open billing', url_variable: 'billing_url' },
      ],
    });
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({
      name: 'Billing reminder', is_default: true,
      payload: { first_name: 'Customer', category_label: 'Billing reminder',
        notification_body: 'Hi Customer, please review the billing update in your customer portal.',
        billing_url: 'https://portal.wavespestcontrol.com/?tab=billing' },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: 'system', resource_type: 'email_template', resource_id: template.id,
      metadata: { templateKey: 'billing.notice', migration: '20260924010300_billing_notice_email_template' },
    });

    await db('email_template_versions').where({ id: versions[0].id }).update({ status: 'archived' });
    const [operatorVersion] = await db('email_template_versions').insert({
      template_id: template.id, version_number: 2, status: 'active',
      subject: 'Operator-authored billing subject', preview_text: 'Operator preview', blocks: [],
    }).returning('*');
    await db('email_templates').where({ id: template.id }).update({
      name: 'Operator billing notice', active_version_id: operatorVersion.id,
    });

    await db.transaction((trx) => migration.up(trx));
    await migration.down(db);
    expect(await db('email_templates').where({ id: template.id }).first()).toMatchObject({
      name: 'Operator billing notice', active_version_id: operatorVersion.id,
    });
    expect(await db('email_template_versions').where({ id: operatorVersion.id }).first()).toMatchObject({
      status: 'active', subject: 'Operator-authored billing subject', preview_text: 'Operator preview',
    });
    expect(await db('email_template_versions').where({ template_id: template.id })).toHaveLength(2);
    expect(await db('email_template_fixtures').where({ template_id: template.id })).toHaveLength(1);
    expect(await db('audit_log').where({ action: 'email_template.seeded' })).toHaveLength(1);
  }, 30000);
});
