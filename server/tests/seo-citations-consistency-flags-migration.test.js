/**
 * 20260930100500 — nap_consistent must agree with status. Fake-knex cases always run; the
 * DB-backed case replays the ORIGINAL create-table migration and the frozen status-remap
 * migration first (needs DATABASE_URL; skipped locally without one, runs in CI).
 */
const migration = require('../models/migrations/20260930100500_seo_citations_consistency_flags');
const createTable = require('../models/migrations/20260401000045_seo_citations');
const remap = require('../models/migrations/20260929230000_seo_citations_audit_states');

describe('migration shape', () => {
  test('up() is one UPDATE that only nulls contradicting flags; down() is a no-op', async () => {
    const raws = [];
    await migration.up({ raw: async (sql) => { raws.push(String(sql)); } });
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatch(/UPDATE seo_citations\s+SET nap_consistent = NULL/);
    expect(raws[0]).toMatch(/nap_consistent IS NOT NULL/);
    expect(raws[0]).not.toMatch(/DELETE|DROP|status =\s*'(?!verified|mismatched)/);
    await expect(migration.down({ raw: async () => { throw new Error('down must not touch the table'); } })).resolves.toBeUndefined();
  });
});

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb('flag reconciliation on a real table', () => {
  const knexLib = require('knex');
  const schema = `cit_flag_${process.pid}`;
  let knex;
  beforeAll(async () => {
    const root = knexLib({ client: 'pg', connection: process.env.DATABASE_URL });
    await root.raw(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await root.destroy();
    knex = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 1, max: 1 } });
    await createTable.up(knex);
  });
  afterAll(async () => {
    if (!knex) return;
    await knex.raw(`DROP SCHEMA ${schema} CASCADE`);
    await knex.destroy();
  });

  test('legacy active rows keep no consistent flag after the remap; real verdicts keep theirs; re-running is a no-op', async () => {
    await knex('seo_citations').insert([
      { directory_name: 'legacy-active', status: 'active', nap_consistent: true },
      { directory_name: 'legacy-inconsistent', status: 'inconsistent', nap_consistent: false },
      { directory_name: 'legacy-unchecked', status: 'unchecked' },
    ]);
    await remap.up(knex); // frozen migration: active -> unverified, flag left behind
    expect((await knex('seo_citations').where({ directory_name: 'legacy-active' }).first())).toMatchObject({ status: 'unverified', nap_consistent: true });

    await knex('seo_citations').insert([
      { directory_name: 'ok-verified', status: 'verified', nap_consistent: true },
      { directory_name: 'ok-mismatched', status: 'mismatched', nap_consistent: false },
      { directory_name: 'bad-verified', status: 'verified', nap_consistent: false },
      { directory_name: 'bad-mismatched', status: 'mismatched', nap_consistent: true },
      { directory_name: 'blocked', status: 'fetch-blocked', nap_consistent: true },
      { directory_name: 'gone', status: 'missing', nap_consistent: false },
    ]);
    await migration.up(knex);
    const flag = async (name) => (await knex('seo_citations').where({ directory_name: name }).first()).nap_consistent;
    expect(await flag('legacy-active')).toBeNull();
    expect(await flag('legacy-unchecked')).toBeNull();
    expect(await flag('legacy-inconsistent')).toBe(false); // mismatched + false agree
    expect(await flag('ok-verified')).toBe(true);
    expect(await flag('ok-mismatched')).toBe(false);
    expect(await flag('bad-verified')).toBeNull();
    expect(await flag('bad-mismatched')).toBeNull();
    expect(await flag('blocked')).toBeNull();
    expect(await flag('gone')).toBeNull();

    const before = await knex('seo_citations').orderBy('directory_name');
    await migration.up(knex);
    expect(await knex('seo_citations').orderBy('directory_name')).toEqual(before);
    await migration.down(knex);
    expect(await knex('seo_citations').orderBy('directory_name')).toEqual(before);
  });
});
