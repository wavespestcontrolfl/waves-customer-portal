// CI's DB-gated pass runs this against PostgreSQL. Fixture data lives in a
// unique schema dropped after the suite.
//
// 20261120090000_referral_step1_settings (owner 2026-11-20, referral Step 1):
//  - the invite text and the three tier bonuses change only while they still
//    hold the expected live values, and each changed column is audited;
//  - a column an admin already edited is left alone and never audited;
//  - down() reverts exactly the tracked columns, and an admin edit made after
//    up() survives it.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261120090000_referral_step1_settings');

const { _CHANGES: CHANGES, _AUDIT_ACTION: AUDIT_ACTION, _AUDIT_ROLLBACK_ACTION: ROLLBACK_ACTION } = migration;
const BEFORE = Object.fromEntries(CHANGES.map(([column, before]) => [column, before]));
const AFTER = Object.fromEntries(CHANGES.map(([column, , after]) => [column, after]));
const COLUMNS = CHANGES.map(([column]) => column);

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('referral step 1 settings migration on PostgreSQL', () => {
  let database;
  const schema = `referral_step1_${randomUUID().replaceAll('-', '')}`;
  const tables = ['referral_program_settings', 'audit_log'];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const seed = (overrides = {}) => database('referral_program_settings').insert({
    id: 1, program_active: true, referrer_reward_cents: 2500, referee_discount_cents: 2500, ...BEFORE, ...overrides,
  });
  const row = () => database('referral_program_settings').where({ id: 1 }).first(COLUMNS);
  const auditRows = (action) => database('audit_log').where({ action }).select('resource_type', 'resource_id', 'metadata');
  const meta = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata);

  test('all four columns change and are each audited; down() reverts exactly those columns', async () => {
    await seed();
    await migration.up(database);
    expect(await row()).toEqual(AFTER);

    const tracked = await auditRows(AUDIT_ACTION);
    expect(tracked.map((r) => meta(r).column).sort()).toEqual([...COLUMNS].sort());
    for (const r of tracked) {
      expect(r.resource_type).toBe('referral_program_settings');
      expect(r.resource_id).toBe('1');
      expect(meta(r).migration).toBe('20261120090000_referral_step1_settings');
    }

    await migration.down(database);
    expect(await row()).toEqual(BEFORE);
    expect(await auditRows(ROLLBACK_ACTION)).toHaveLength(4);
  });

  test('a column an admin edited before up() is skipped and never tracked', async () => {
    await seed({ bonus_gold_cents: 3000, invite_sms_template: 'Office wording: {referral_link}' });
    await migration.up(database);
    const after = await row();
    expect(after.bonus_gold_cents).toBe(3000);
    expect(after.invite_sms_template).toBe('Office wording: {referral_link}');
    expect(after.bonus_silver_cents).toBe(0);
    expect(after.bonus_platinum_cents).toBe(0);
    expect((await auditRows(AUDIT_ACTION)).map((r) => meta(r).column).sort()).toEqual(['bonus_platinum_cents', 'bonus_silver_cents']);
  });

  test('an admin edit made after up() survives down()', async () => {
    await seed();
    await migration.up(database);
    await database('referral_program_settings').where({ id: 1 }).update({ bonus_silver_cents: 1000 });
    await migration.down(database);
    const after = await row();
    expect(after.bonus_silver_cents).toBe(1000);
    expect(after.bonus_gold_cents).toBe(BEFORE.bonus_gold_cents);
    expect(await auditRows(ROLLBACK_ACTION)).toHaveLength(3);
  });

  test('no settings row: up() changes nothing and audits nothing', async () => {
    await migration.up(database);
    expect(await auditRows(AUDIT_ACTION)).toHaveLength(0);
  });
});
