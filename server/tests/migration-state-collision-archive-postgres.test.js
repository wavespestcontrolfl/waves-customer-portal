const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20260924000098_archive_shared_000020_state');
jest.setTimeout(30000);

postgres('migration state collision archive on PostgreSQL', () => {
  let database;
  let trx;
  let schema;

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('Use only a local development PostgreSQL database for this rollback proof');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => {
    trx = await database.transaction();
    schema = `migration_state_archive_${randomUUID().replaceAll('-', '')}`;
    await trx.raw('CREATE SCHEMA ??', [schema]);
    await trx.raw('CREATE TABLE ??.system_settings (LIKE public.system_settings INCLUDING ALL)', [schema]);
    await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
  });

  afterEach(async () => { await trx?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  test.each([
    ['present malformed state', true, '{opaque malformed state'],
    ['missing state', false, null],
  ])('archives %s without changing legacy state and remains after down', async (_label, present, rawLegacy) => {
    if (present) {
      await trx('system_settings').insert({ key: migration.LEGACY_STATE_KEY, value: rawLegacy });
    }

    await migration.up(trx);
    await migration.up(trx);
    await migration.down(trx);

    const archivedRows = await trx('system_settings').where({ key: migration.STATE_KEY });
    expect(archivedRows).toHaveLength(1);
    expect(JSON.parse(archivedRows[0].value)).toMatchObject({
      legacy_present: present,
      legacy_value: rawLegacy,
      frozen_owners: migration.FROZEN_OWNERS,
    });
    const legacyRows = await trx('system_settings').where({ key: migration.LEGACY_STATE_KEY });
    expect(legacyRows).toEqual(present ? [expect.objectContaining({ value: rawLegacy })] : []);
  });

  test('does not overwrite a pre-existing archive', async () => {
    await trx('system_settings').insert([
      { key: migration.LEGACY_STATE_KEY, value: 'legacy' },
      { key: migration.STATE_KEY, value: 'operator-preserved archive' },
    ]);

    await migration.up(trx);

    expect(await trx('system_settings').where({ key: migration.STATE_KEY }).first('value'))
      .toMatchObject({ value: 'operator-preserved archive' });
  });
});
