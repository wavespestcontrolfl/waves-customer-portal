// Opt-in PostgreSQL regression. Every write stays inside a disposable schema.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const seed = require('../models/migrations/20260924010300_billing_notice_email_template');
const correction = require('../models/migrations/20260924010400_billing_notice_remove_duplicate_greeting');
const requiredVariables = require('../models/migrations/20260924010500_billing_notice_required_variables');

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

  test('seeds immutably, publishes the exact correction, and preserves operator history', async () => {
    const probe = await db.transaction();
    try {
      await seed.up(probe);
      await correction.up(probe);
      await requiredVariables.up(probe);
      expect(await probe('email_templates').where({ template_key: 'billing.notice' })).toHaveLength(1);
      expect(await probe('email_template_versions')).toHaveLength(2);
      expect(await probe('audit_log').where({ action: 'email_template.seeded' })).toHaveLength(1);
      expect(await probe('audit_log').where({ action: 'email_template.corrected' })).toHaveLength(1);
    } finally {
      await probe.rollback();
    }
    for (const table of ['email_templates', 'email_template_versions', 'email_template_fixtures', 'audit_log']) {
      expect(await db(table)).toHaveLength(0);
    }

    const editedProbe = await db.transaction();
    try {
      await seed.up(editedProbe);
      const editedTemplate = await editedProbe('email_templates').where({ template_key: 'billing.notice' }).first();
      const customRequired = ['first_name', 'category_label', 'notification_body', 'billing_url', 'operator_note'];
      await editedProbe('email_templates').where({ id: editedTemplate.id })
        .update({ required_variables: JSON.stringify(customRequired) });
      await correction.up(editedProbe);
      await requiredVariables.up(editedProbe);
      const correctedTemplate = await editedProbe('email_templates').where({ id: editedTemplate.id }).first();
      expect(correctedTemplate.required_variables).toEqual(customRequired);
      await editedProbe('email_template_versions').where({ id: correctedTemplate.active_version_id }).update({ status: 'archived' });
      const [edited] = await editedProbe('email_template_versions').insert({
        template_id: editedTemplate.id, version_number: 3, status: 'active',
        subject: 'Operator subject', preview_text: 'Operator preview', blocks: [],
      }).returning('*');
      await editedProbe('email_templates').where({ id: editedTemplate.id }).update({ active_version_id: edited.id });
      await editedProbe('email_template_fixtures').where({ template_id: editedTemplate.id })
        .update({ payload: { notification_body: 'Operator fixture' } });
      await correction.up(editedProbe);
      await requiredVariables.up(editedProbe);
      expect(await editedProbe('email_template_versions').where({ template_id: editedTemplate.id })).toHaveLength(3);
      expect((await editedProbe('email_templates').where({ id: editedTemplate.id }).first()).active_version_id).toBe(edited.id);
      expect((await editedProbe('email_templates').where({ id: editedTemplate.id }).first()).required_variables)
        .toEqual(customRequired);
      expect((await editedProbe('email_template_fixtures').where({ template_id: editedTemplate.id }).first()).payload)
        .toEqual({ notification_body: 'Operator fixture' });
    } finally {
      await editedProbe.rollback();
    }

    await db.transaction(async (trx) => {
      await seed.up(trx); await seed.up(trx);
      await correction.up(trx); await correction.up(trx);
      await requiredVariables.up(trx); await requiredVariables.up(trx);
    });
    const template = await db('email_templates').where({ template_key: 'billing.notice' }).first();
    const versions = await db('email_template_versions').where({ template_id: template.id }).orderBy('version_number');
    const fixtures = await db('email_template_fixtures').where({ template_id: template.id });

    expect(template).toMatchObject({
      name: 'Billing notice', mode: 'service', purpose: 'billing', status: 'active',
      legal_classification: 'transactional_relationship', active_version_id: versions[1].id,
      allowed_variables: ['first_name', 'category_label', 'notification_body', 'billing_url'],
      required_variables: ['category_label', 'notification_body', 'billing_url'],
    });
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      version_number: 1, status: 'archived', subject: '{{category_label}} from Waves',
      blocks: [
        { type: 'heading', content: '{{category_label}}' },
        { type: 'paragraph', content: 'Hi {{first_name}},' },
        { type: 'paragraph', content: '{{notification_body}}' },
        { type: 'cta', label: 'Open billing', url_variable: 'billing_url' },
      ],
    });
    expect(versions[1]).toMatchObject({
      version_number: 2, status: 'active', subject: '{{category_label}} from Waves',
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
    expect(await db('audit_log').where({ action: 'email_template.seeded' })).toHaveLength(1);
    const corrections = await db('audit_log').where({ action: 'email_template.corrected' });
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      actor_type: 'system', resource_type: 'email_template', resource_id: template.id,
      metadata: { templateKey: 'billing.notice', migration: '20260924010400_billing_notice_remove_duplicate_greeting',
        priorVersionId: versions[0].id, publishedVersionId: versions[1].id, fixtureCorrected: true },
    });
    expect(await db('audit_log').where({ action: 'email_template.required_variables_corrected' })).toHaveLength(1);

    await db('email_template_versions').where({ id: versions[1].id }).update({ status: 'archived' });
    const [operatorVersion] = await db('email_template_versions').insert({
      template_id: template.id, version_number: 3, status: 'active',
      subject: 'Operator-authored billing subject', preview_text: 'Operator preview', blocks: [],
    }).returning('*');
    await db('email_templates').where({ id: template.id }).update({
      name: 'Operator billing notice', active_version_id: operatorVersion.id,
    });

    await db('email_template_fixtures').where({ template_id: template.id })
      .update({ payload: { notification_body: 'Operator fixture after correction' } });
    await db.transaction(async (trx) => {
      await seed.up(trx); await correction.up(trx); await requiredVariables.up(trx);
    });
    await requiredVariables.down(db);
    await correction.down(db);
    await seed.down(db);
    expect(await db('email_templates').where({ id: template.id }).first()).toMatchObject({
      name: 'Operator billing notice', active_version_id: operatorVersion.id,
    });
    expect(await db('email_template_versions').where({ id: operatorVersion.id }).first()).toMatchObject({
      status: 'active', subject: 'Operator-authored billing subject', preview_text: 'Operator preview',
    });
    expect(await db('email_template_versions').where({ template_id: template.id })).toHaveLength(3);
    expect(await db('email_template_fixtures').where({ template_id: template.id })).toHaveLength(1);
    expect((await db('email_template_fixtures').where({ template_id: template.id }).first()).payload)
      .toEqual({ notification_body: 'Operator fixture after correction' });
    expect(await db('audit_log').where({ action: 'email_template.seeded' })).toHaveLength(1);
    expect(await db('audit_log').where({ action: 'email_template.corrected' })).toHaveLength(1);
  }, 30000);
});
