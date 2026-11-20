// estimate_roof_points (tech-confirmed roof points frozen at send, owner ruling 2026-11-20): the table, its one-row-per-estimate
// key, the cascade from the estimate, SET NULL from the read, and a reversible, idempotent migration, proven on a real
// PostgreSQL in a disposable schema (skipped without APP_TEST_DATABASE_URL, run for real in CI).
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20261120210000_estimate_roof_points');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `estimate_roof_points_${randomUUID().replaceAll('-', '')}`;
const TABLE = 'estimate_roof_points';
const SNAPSHOT = { imageUrl: 'https://example.test/aerial.jpg', imageYear: 2025, pins: [{ n: 1, x: 0.25, y: 0.4, type: 'other', label: 'Entry point', action: 'seal' }] };

postgres('estimate_roof_points (PostgreSQL)', () => {
  let admin;
  let app;
  const estimateA = randomUUID();
  const estimateB = randomUUID();
  const readA = randomUUID();

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    await app.schema.createTable('estimates', (t) => { t.uuid('id').primary(); });
    await app.schema.createTable('roof_entry_reads', (t) => { t.uuid('id').primary(); });
    await app('estimates').insert([{ id: estimateA }, { id: estimateB }]);
    await app('roof_entry_reads').insert({ id: readA });
    await migration.up(app);
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  test('a row holds the read id, the address and the snapshot as jsonb, with frozen_at defaulted', async () => {
    await app(TABLE).insert({ estimate_id: estimateA, read_id: readA, address: '12 Synthetic Way', snapshot: JSON.stringify(SNAPSHOT) });
    const row = await app(TABLE).where({ estimate_id: estimateA }).first();
    expect(row.snapshot).toEqual(SNAPSHOT);
    expect(row.read_id).toBe(readA);
    expect(row.address).toBe('12 Synthetic Way');
    expect(row.frozen_at).toBeInstanceOf(Date);
  });

  test('an estimate has one frozen copy: a second insert is refused, and an upsert replaces it', async () => {
    await expect(app(TABLE).insert({ estimate_id: estimateA, snapshot: JSON.stringify(SNAPSHOT) })).rejects.toMatchObject({ code: '23505' });
    const next = { ...SNAPSHOT, pins: [] };
    await app(TABLE).insert({ estimate_id: estimateA, read_id: null, snapshot: JSON.stringify(next) }).onConflict('estimate_id').merge();
    const rows = await app(TABLE).where({ estimate_id: estimateA });
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot).toEqual(next);
    expect(rows[0].read_id).toBeNull();
  });

  test('the snapshot is required, and a copy needs a real estimate and a real read', async () => {
    await expect(app(TABLE).insert({ estimate_id: estimateB })).rejects.toMatchObject({ code: '23502' });
    await expect(app(TABLE).insert({ estimate_id: randomUUID(), snapshot: JSON.stringify(SNAPSHOT) })).rejects.toMatchObject({ code: '23503' });
    await expect(app(TABLE).insert({ estimate_id: estimateB, read_id: randomUUID(), snapshot: JSON.stringify(SNAPSHOT) })).rejects.toMatchObject({ code: '23503' });
  });

  test('deleting the read keeps the copy (read_id goes null); deleting the estimate removes it', async () => {
    await app(TABLE).insert({ estimate_id: estimateB, read_id: readA, snapshot: JSON.stringify(SNAPSHOT) });
    await app('roof_entry_reads').where({ id: readA }).del();
    const kept = await app(TABLE).where({ estimate_id: estimateB }).first();
    expect(kept.read_id).toBeNull();
    await app('estimates').where({ id: estimateB }).del();
    expect(await app(TABLE).where({ estimate_id: estimateB })).toHaveLength(0);
  });

  test('up() twice is a no-op, down() drops the table, down() twice is a no-op, and up() brings it back', async () => {
    await migration.up(app);
    expect(await app.schema.hasTable(TABLE)).toBe(true);
    await migration.down(app);
    expect(await app.schema.hasTable(TABLE)).toBe(false);
    await migration.down(app);
    await migration.up(app);
    expect(await app.schema.hasTable(TABLE)).toBe(true);
  });
});
