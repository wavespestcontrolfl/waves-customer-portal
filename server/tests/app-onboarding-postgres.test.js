// Runs with the existing CI PostgreSQL pass; never a production connection.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn() }));
const { isFirstServiceVisit } = require('../services/customer-visit-history');
const { validationFor } = require('../services/email-template-library');
const migration = require('../models/migrations/20260907000090_app_onboarding_email_versions');
const preflight = require('../models/migrations/20260907000089_app_onboarding_tour_preflight');
const { TEMPLATE: APP_V4 } = require('../models/migrations/20260708000011_app_intro_email_v4_track_reminders');

(SKIP ? describe.skip : describe)('app onboarding PostgreSQL contracts', () => {
  let db;
  const schema = `app_onboarding_${randomUUID().replaceAll('-', '')}`;
  const customerId = randomUUID();
  const day = '2030-01-02';

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    // Relevant column types from 20260401000001 and 20260518000001. A private
    // schema avoids changing CI's migrated tables or any other fixture run.
    for (const [table, dateColumn] of [['service_records', 'service_date'], ['scheduled_services', 'scheduled_date']]) {
      await db.schema.createTable(table, t => {
        t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
        t.uuid('customer_id').notNullable();
        t.date(dateColumn).notNullable();
        t.string('status');
      });
    }
    await db.schema.createTable('audit_log', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('actor_type'); t.uuid('actor_id'); t.string('action');
      t.string('resource_type'); t.uuid('resource_id'); t.jsonb('metadata');
      t.string('ip_address'); t.string('user_agent');
    });
    await db.schema.createTable('email_templates', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('template_key').notNullable().unique();
      t.uuid('active_version_id');
      t.jsonb('allowed_variables'); t.jsonb('optional_variables'); t.jsonb('required_variables');
      t.string('status'); t.string('from_email'); t.string('send_stream');
      t.timestamp('last_published_at'); t.timestamp('updated_at');
    });
    await db.schema.createTable('email_template_versions', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('template_id').notNullable().references('id').inTable('email_templates');
      t.integer('version_number').notNullable(); t.unique(['template_id', 'version_number']);
      t.string('status'); t.string('subject').notNullable(); t.string('preview_text');
      t.jsonb('blocks'); t.text('text_body'); t.jsonb('validation_snapshot');
      t.timestamp('published_at');
    });
    await db.schema.createTable('email_template_fixtures', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('template_id').notNullable().references('id').inTable('email_templates');
      t.string('name'); t.boolean('is_default'); t.jsonb('payload'); t.timestamp('updated_at');
    });
  });

  afterAll(async () => {
    if (db) {
      await db.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await db.destroy();
    }
  });

  beforeEach(async () => {
    await db('service_records').del();
    await db('scheduled_services').del();
  });

  test('first report and separately finalized sibling reports are all first', async () => {
    await db('scheduled_services').insert({ customer_id: customerId, scheduled_date: day, status: 'completed' });
    await db('service_records').insert({ customer_id: customerId, service_date: day, status: 'completed' });
    expect(await isFirstServiceVisit(customerId, day, db)).toBe(true);
    await db('service_records').insert({ customer_id: customerId, service_date: day, status: 'completed' });
    expect(await isFirstServiceVisit(customerId, day, db)).toBe(true);
  });

  test('later visits exclude earlier reports, including late-finalized reports', async () => {
    await db('service_records').insert({ customer_id: customerId, service_date: day, status: 'completed' });
    expect(await isFirstServiceVisit(customerId, '2030-01-03', db)).toBe(false);
    expect(await isFirstServiceVisit(customerId, '2030-01-01', db)).toBe(true);
  });

  test.each(['completed', 'on_site'])('legacy %s appointments count without any report', async status => {
    await db('scheduled_services').insert({ customer_id: customerId, scheduled_date: '2030-01-01', status });
    expect(await isFirstServiceVisit(customerId, day, db)).toBe(false);
  });

  test('cancelled history and another customer do not disqualify a first visit', async () => {
    await db('service_records').insert([
      { customer_id: customerId, service_date: '2030-01-01', status: 'cancelled' },
      { customer_id: randomUUID(), service_date: '2030-01-01', status: 'completed' },
    ]);
    await db('scheduled_services').insert({ customer_id: customerId, scheduled_date: '2030-01-01', status: 'cancelled' });
    expect(await isFirstServiceVisit(customerId, day, db)).toBe(true);
    expect(await isFirstServiceVisit(customerId, null, db)).toBe(false);
  });

  test('query failure fails closed for optional guidance', async () => {
    await db.schema.renameTable('service_records', 'hidden_records');
    try { expect(await isFirstServiceVisit(customerId, day, db)).toBe(false); }
    finally { await db.schema.renameTable('hidden_records', 'service_records'); }
  });

  test('migration publishes new versions, preserves old/admin data, and is repeatable', async () => {
    const seedBlocks = {
      'welcome.new_recurring': [
        { type: 'paragraph', content: 'Hi {{first_name}}, welcome.' },
        { type: 'details', rows: [{ label: 'Plan', value: '{{plan_name}}' }] },
        { type: 'paragraph', content: 'On the first recurring visit, your technician will inspect the property.' },
        { type: 'paragraph', content: 'After service, you can review reports, upcoming visits, invoices, and account details in the customer portal.' },
        { type: 'cta', label: 'Open portal', url_variable: 'customer_portal_url' },
      ],
      app_intro: APP_V4.blocks,
      'estimate.accepted_onboarding': [
        { type: 'paragraph', content: '{{acceptance_note}}' },
        { type: 'cta', label: 'View my account', url_variable: 'customer_portal_url' },
      ],
      'service.report_ready': [
        { type: 'paragraph', content: '{{inspection_credit_note}}' },
        { type: 'cta', label: 'View full report', url_variable: 'report_url' },
      ],
    };
    const before = [];
    for (const [key, blocks] of Object.entries(seedBlocks)) {
      const [template] = await db('email_templates').insert({
        template_key: key, status: 'paused', from_email: 'staff@example.com', send_stream: 'service_operational',
        allowed_variables: JSON.stringify([...new Set(['first_name', 'staff_note', 'company_phone', 'customer_portal_url', ...validationFor({ allowed_variables: [] }, { blocks }).referenced_variables])]), optional_variables: JSON.stringify(['staff_note']), required_variables: JSON.stringify(['first_name']),
      }).returning('*');
      const [version] = await db('email_template_versions').insert({
        template_id: template.id, version_number: 7, status: 'active', subject: 'Staff subject',
        preview_text: 'Staff preview', blocks: JSON.stringify([{ type: 'paragraph', content: 'Hi {{first_name}}' }, ...blocks, { type: 'paragraph', content: '{{staff_note}}' }]),
        text_body: key === 'estimate.accepted_onboarding' ? 'Staff text {{acceptance_note}}' : null,
        validation_snapshot: JSON.stringify({ staff_reviewed: true }),
      }).returning('*');
      await db('email_templates').where({ id: template.id }).update({ active_version_id: version.id });
      await db('email_template_fixtures').insert({ template_id: template.id, name: 'Staff example', is_default: true, payload: JSON.stringify({ first_name: 'Sample', staff_note: 'Keep this' }) });
      before.push({ template, version });
    }
    // Equivalent to BEGIN / up / readback / ROLLBACK. No released data changes.
    await db.transaction(async trx => {
      const appSource = before.find(row => row.template.template_key === 'app_intro').version;
      const edited = structuredClone(appSource.blocks);
      edited.find(block => block.type === 'paragraph' && APP_V4.blocks.some(seed => seed.content === block.content)).content += ' Staff edit.';
      await trx('email_template_versions').where({ id: appSource.id }).update({ blocks: JSON.stringify(edited) });
      await expect(preflight.up(trx)).rejects.toThrow('edited app tour block');
      await trx('email_template_versions').where({ id: appSource.id }).update({ blocks: JSON.stringify(appSource.blocks) });
      await preflight.up(trx);
      await migration.up(trx);
      await preflight.up(trx);
      await migration.up(trx);
      await migration.down(trx);
      for (const { template, version } of before) {
        expect(await trx('email_template_versions').where({ id: version.id }).first()).toEqual(version);
        const updated = await trx('email_templates').where({ id: template.id }).first();
        expect(updated).toMatchObject({ status: 'paused', from_email: 'staff@example.com', send_stream: 'service_operational', required_variables: ['first_name'] });
        const latest = await trx('email_template_versions').where({ id: updated.active_version_id }).first();
        expect(latest.version_number).toBe(8);
        expect(latest.blocks).toContainEqual({ type: 'paragraph', content: '{{staff_note}}' });
        expect(latest.validation_snapshot).toMatchObject({ ok: true, migration: '20260907000090' });
        expect(await trx('email_template_versions').where({ template_id: template.id }).count('* as n').first()).toEqual({ n: '2' });
        const fixture = await trx('email_template_fixtures').where({ template_id: template.id, is_default: true }).first();
        expect(fixture.payload.staff_note).toBe('Keep this');
      }
      expect(await trx('audit_log').count('* as n').first()).toEqual({ n: '4' });
      await trx.rollback();
    });
  });
});
