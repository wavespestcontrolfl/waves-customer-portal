/** Real PostgreSQL proof in rollback-only schemas on an explicit synthetic QA DB. */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('Audit must use the supplied transaction'); }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20260907000070_shorten_long_sms_templates');
const connection = process.env.SMS_TEMPLATE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let db;
jest.setTimeout(60000);

async function inRollback(work) {
  const rollback = new Error('intentional test rollback');
  try {
    await db.transaction(async trx => {
      const schema = `sms_copy_${randomUUID().replaceAll('-', '')}`;
      await trx.raw('CREATE SCHEMA ??', [schema]);
      for (const table of ['sms_templates', 'sms_template_variants', 'audit_log']) {
        await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
      }
      await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
      await work(trx);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

postgres('SMS copy migration on PostgreSQL', () => {
  beforeAll(() => {
    if (!/^\/waves_qa_[a-f0-9]+$/.test(new URL(connection).pathname)) {
      throw new Error('Select a synthetic Waves QA database in a verified dev/preview environment');
    }
    db = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  });
  afterAll(async () => { if (db) await db.destroy(); });

  test('updates known defaults and variants once, preserves metadata, and audits actual writes', async () => inRollback(async trx => {
    for (const [key, before] of migration._SWAPS) {
      await trx('sms_templates').insert({
        template_key: key, name: 'Synthetic template', category: 'custom', body: before,
        variables: JSON.stringify(['first_name', 'custom_optional']), is_active: false,
      });
      await trx('sms_template_variants').insert({ template_key: key, variant_key: 'control', body: before, status: 'paused', weight: 3 });
      await trx('sms_template_variants').insert({ template_key: key, variant_key: 'custom', body: 'Administrator copy', status: 'active' });
    }
    await migration.up(trx);
    for (const [key, , after] of migration._SWAPS) {
      expect(await trx('sms_templates').where({ template_key: key }).first()).toMatchObject({ body: after, is_active: false });
      expect(await trx('sms_template_variants').where({ template_key: key, variant_key: 'control' }).first()).toMatchObject({ body: after, status: 'paused', weight: 3 });
      expect(await trx('sms_template_variants').where({ template_key: key, variant_key: 'custom' }).first()).toMatchObject({ body: 'Administrator copy', status: 'active' });
    }
    expect((await trx('sms_templates').where({ template_key: 'reminder_24h' }).first()).variables).toEqual(['first_name', 'custom_optional', 'window']);
    expect(await trx('audit_log')).toHaveLength(14);
    await migration.up(trx);
    await migration.down(trx);
    expect(await trx('audit_log')).toHaveLength(14);
    expect((await trx('sms_templates').where({ template_key: 'reminder_24h' }).first()).body).toBe(migration._SWAPS[1][2]);
  }));

  test('preserves edited base copy and handles a null variable list', async () => inRollback(async trx => {
    await trx('sms_templates').insert({ template_key: 'reminder_72h', name: 'Synthetic', category: 'custom', body: 'Administrator copy', is_active: false });
    await trx('sms_templates').insert({ template_key: 'reminder_24h', name: 'Synthetic', category: 'custom', body: migration._SWAPS[1][1], variables: null });
    await migration.up(trx);
    expect((await trx('sms_templates').where({ template_key: 'reminder_72h' }).first()).body).toBe('Administrator copy');
    expect((await trx('sms_templates').where({ template_key: 'reminder_24h' }).first()).variables).toEqual(['window']);
    expect(await trx('audit_log')).toHaveLength(1);
  }));

  test('a control variant keeps its window available under an administrator-written base', async () => inRollback(async trx => {
    await trx('sms_templates').insert({ template_key: 'reminder_24h', name: 'Synthetic', category: 'custom', body: 'Administrator copy', variables: JSON.stringify(['first_name', 'custom_optional']) });
    await trx('sms_template_variants').insert({ template_key: 'reminder_24h', variant_key: 'control', body: migration._SWAPS[1][1] });
    await migration.up(trx);
    expect(await trx('sms_templates').first()).toMatchObject({ body: 'Administrator copy', variables: ['first_name', 'custom_optional', 'window'] });
    expect((await trx('sms_template_variants').first()).body).toBe(migration._SWAPS[1][2]);
    expect(await trx('audit_log')).toHaveLength(2);
  }));
});
