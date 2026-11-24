// CI's DB-gated pass runs this against PostgreSQL. Fixture data lives in a
// unique schema dropped after the suite.
//
// 20261120090000_referral_step1_settings (owner 2026-11-20, referral Step 1):
//  - the invite text and the three tier bonuses change only while they still
//    hold the expected live values, and each changed column is audited;
//  - a column an admin already edited is left alone and never audited;
//  - down() reverts exactly the tracked columns, and an admin edit made after
//    up() survives it;
//  - each up() run writes one row naming its columns (even none); down() only
//    reverts runs it has not rolled back, so a second up/down cycle never
//    reaches back to the first run's columns.
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
  const meta = (r) => (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata);
  const auditRows = async (action) => (await database('audit_log').where({ action })
    .select('resource_type', 'resource_id', 'metadata')).map((r) => ({ ...r, meta: meta(r) }));
  const sorted = (list) => [...list].sort();

  test('all four columns change in one tracked run; down() reverts exactly those columns', async () => {
    await seed();
    await migration.up(database);
    expect(await row()).toEqual(AFTER);

    const runs = await auditRows(AUDIT_ACTION);
    expect(runs).toHaveLength(1);
    expect(runs[0].resource_type).toBe('referral_program_settings');
    expect(runs[0].resource_id).toBeNull(); // audit_log.resource_id is a UUID; the integer id is in metadata
    expect(runs[0].meta).toMatchObject({ migration: '20261120090000_referral_step1_settings', settings_id: 1 });
    expect(typeof runs[0].meta.run_id).toBe('string');
    expect(sorted(runs[0].meta.columns)).toEqual(sorted(COLUMNS));

    await migration.down(database);
    expect(await row()).toEqual(BEFORE);
    const rollbacks = await auditRows(ROLLBACK_ACTION);
    expect(rollbacks).toHaveLength(1);
    expect(rollbacks[0].meta.run_id).toBe(runs[0].meta.run_id);
    expect(sorted(rollbacks[0].meta.columns)).toEqual(sorted(COLUMNS));
  });

  test('a column an admin edited before up() is skipped and never tracked', async () => {
    await seed({ bonus_gold_cents: 3000, invite_sms_template: 'Office wording: {referral_link}' });
    await migration.up(database);
    const after = await row();
    expect(after.bonus_gold_cents).toBe(3000);
    expect(after.invite_sms_template).toBe('Office wording: {referral_link}');
    expect(after.bonus_silver_cents).toBe(0);
    expect(after.bonus_platinum_cents).toBe(0);
    const [run] = await auditRows(AUDIT_ACTION);
    expect(sorted(run.meta.columns)).toEqual(['bonus_platinum_cents', 'bonus_silver_cents']);
  });

  test('an admin edit made after up() survives down()', async () => {
    await seed();
    await migration.up(database);
    await database('referral_program_settings').where({ id: 1 }).update({ bonus_silver_cents: 1000 });
    await migration.down(database);
    const after = await row();
    expect(after.bonus_silver_cents).toBe(1000);
    expect(after.bonus_gold_cents).toBe(BEFORE.bonus_gold_cents);
    const [rollback] = await auditRows(ROLLBACK_ACTION);
    expect(rollback.meta.columns).toHaveLength(3);
  });

  test('second cycle: down() reverts only the latest run, never the first run\'s columns', async () => {
    await seed();
    await migration.up(database);
    await migration.down(database);
    // The admin sets the silver bonus to 0 by hand; the next up() skips it (no longer 5000).
    await database('referral_program_settings').where({ id: 1 }).update({ bonus_silver_cents: 0 });
    await migration.up(database);
    await migration.down(database);
    const after = await row();
    expect(after.bonus_silver_cents).toBe(0);
    expect(after.bonus_gold_cents).toBe(BEFORE.bonus_gold_cents);
    expect(after.invite_sms_template).toBe(BEFORE.invite_sms_template);
  });

  test('second cycle where up() changed nothing: down() changes nothing', async () => {
    await seed();
    await migration.up(database);
    await migration.down(database);
    // The admin types every new value by hand; the next up() finds nothing to change.
    await database('referral_program_settings').where({ id: 1 }).update(AFTER);
    await migration.up(database);
    const runs = await auditRows(AUDIT_ACTION);
    expect(runs.map((r) => r.meta.columns.length).sort()).toEqual([0, 4]);
    await migration.down(database);
    expect(await row()).toEqual(AFTER);
  });

  test('a second down() in a row reverts nothing', async () => {
    await seed();
    await migration.up(database);
    await migration.down(database);
    await database('referral_program_settings').where({ id: 1 }).update(AFTER);
    await migration.down(database);
    expect(await row()).toEqual(AFTER);
    expect(await auditRows(ROLLBACK_ACTION)).toHaveLength(1);
  });

  test('no settings row: up() changes nothing and records an empty run', async () => {
    await migration.up(database);
    const runs = await auditRows(AUDIT_ACTION);
    expect(runs).toHaveLength(1);
    expect(runs[0].meta.columns).toEqual([]);
  });
});
