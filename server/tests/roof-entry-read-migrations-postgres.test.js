const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL. The four roof_entry_reads migrations run for real, in order, in a unique
// schema (with minimal estimates and customers tables for the foreign keys) dropped after each test. It proves the index
// SQL, the null-on-delete behaviour that broke the old copy index, and the rollback guard's down.
const knex = require('knex');
const { randomUUID } = require('crypto');

const m1 = require('../models/migrations/20261119140000_roof_entry_reads');
const m2 = require('../models/migrations/20261119150000_roof_entry_read_claims');
const m3 = require('../models/migrations/20261119160000_roof_entry_read_ctx_key');
const m4 = require('../models/migrations/20261119170000_roof_entry_read_rollback_guard');

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('roof_entry_reads migrations on PostgreSQL', () => {
  let database;
  let schema;

  beforeEach(async () => {
    schema = `roof_mig_${randomUUID().replaceAll('-', '')}`;
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 1, max: 1 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.estimates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid)', [schema]);
    await database.raw('CREATE TABLE ??.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid())', [schema]);
    for (const m of [m1, m2, m3, m4]) await m.up(database);
  });
  afterEach(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const id = (table) => database(table).insert({}).returning('id').then(([r]) => r.id);
  const ctxKey = (estimateId, customerId) => `${estimateId || ''}|${customerId || ''}`;
  const read = (extra = {}) => database('roof_entry_reads').insert({
    lookup_key: 'k'.repeat(64), county: 'manatee', image_source: 'manatee_2025_rgb', image_year: 2025, model: 'm',
    ai_flags: '{}', ai_tier: 'med', status: 'done', cost_estimate_cents: 2, context_key: '|', ...extra,
  }).returning('*').then(([r]) => r);
  const copy = (source, estimateId, customerId, extra = {}) => read({
    source_id: source.id, estimate_id: estimateId, customer_id: customerId, context_key: ctxKey(estimateId, customerId), cost_estimate_cents: 0, ...extra,
  });

  test('the up migrations build the columns, with defaults that keep older rows reusable', async () => {
    const row = await database('roof_entry_reads').insert({
      lookup_key: 'a'.repeat(64), county: 'manatee', image_source: 's', image_year: 2025, model: 'm', ai_tier: 'med',
    }).returning('*').then(([r]) => r);
    expect(row.status).toBe('done');
    expect(row.claimed_at).toBeNull();
    expect(row.source_id).toBeNull();
    expect(row.context_key).toBeNull();
    expect(row.ai_flags).toEqual({});
  });

  test('one pending claim per crop: a second pending insert conflicts, ON CONFLICT DO NOTHING returns no row, a done row is not blocked', async () => {
    const pending = (extra = {}) => read({ status: 'pending', ai_tier: 'pending', cost_estimate_cents: 0, ...extra });
    await pending();
    await expect(pending()).rejects.toMatchObject({ code: '23505' });
    const ignored = await database('roof_entry_reads').insert({
      lookup_key: 'k'.repeat(64), county: 'manatee', image_source: 's', image_year: 2025, model: 'm', ai_tier: 'pending', status: 'pending',
    }).onConflict().ignore().returning('*');
    expect(ignored).toEqual([]);
    await expect(read()).resolves.toBeTruthy();
    await expect(pending({ lookup_key: 'z'.repeat(64) })).resolves.toBeTruthy();
  });

  test('one copy per source and context key; a different context, or a paid row without a source, is not a repeat', async () => {
    const paid = await read();
    await copy(paid, null, null, { context_key: ctxKey(null, 'c1') });
    await expect(copy(paid, null, null, { context_key: ctxKey(null, 'c1') })).rejects.toMatchObject({ code: '23505' });
    await expect(copy(paid, null, null, { context_key: ctxKey(null, 'c2') })).resolves.toBeTruthy();
    await expect(read()).resolves.toBeTruthy();
    const ignored = await database('roof_entry_reads').insert({
      lookup_key: 'k'.repeat(64), county: 'manatee', image_source: 's', image_year: 2025, model: 'm', ai_tier: 'med', source_id: paid.id, context_key: ctxKey(null, 'c1'),
    }).onConflict().ignore().returning('*');
    expect(ignored).toEqual([]);
  });

  test('deleting an estimate nulls its copies foreign key and no longer collides with another copy', async () => {
    const [est, cust] = [await id('estimates'), await id('customers')];
    const paid = await read();
    const withEstimate = await copy(paid, est, cust);
    const customerOnly = await copy(paid, null, cust);
    await expect(database('estimates').where({ id: est }).del()).resolves.toBe(1);
    const rows = await database('roof_entry_reads').where({ source_id: paid.id }).orderBy('context_key');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === withEstimate.id).estimate_id).toBeNull();
    expect(rows.find((r) => r.id === withEstimate.id).context_key).toBe(ctxKey(est, cust));
    expect(rows.find((r) => r.id === customerOnly.id).context_key).toBe(ctxKey(null, cust));
  });

  test('the rollback guard lets 160000 roll back after an estimate with copies was deleted: no row lost, tech feedback kept', async () => {
    const [est, cust] = [await id('estimates'), await id('customers')];
    const paid = await read();
    const a = await copy(paid, est, cust, { tech_final_count: 3, tech_final_flags: JSON.stringify({ gable_vents: 'yes' }) });
    const b = await copy(paid, null, cust, { tech_final_count: 5 });
    await database('estimates').where({ id: est }).del();
    const before = await database('roof_entry_reads').count('* as n').first();

    await m4.down(database);
    await m3.down(database);

    const after = await database('roof_entry_reads').orderBy('id');
    expect(after).toHaveLength(Number(before.n));
    expect(after.find((r) => r.id === a.id).tech_final_count).toBe(3);
    expect(after.find((r) => r.id === a.id).tech_final_flags).toEqual({ gable_vents: 'yes' });
    expect(after.find((r) => r.id === b.id).tech_final_count).toBe(5);
    // Of the two colliding copies, the lower id keeps its link to the paid read; the other only loses that link.
    const [low, high] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(after.find((r) => r.id === low.id).source_id).toBe(paid.id);
    expect(after.find((r) => r.id === high.id).source_id).toBeNull();
    expect(after.find((r) => r.id === paid.id).source_id).toBeNull();
    // The old index is back and enforces what it did before.
    const idx = await database.raw("SELECT indexname FROM pg_indexes WHERE schemaname = ? AND tablename = 'roof_entry_reads' ORDER BY indexname", [schema]);
    expect(idx.rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(['idx_roof_entry_reads_copy_context', 'idx_roof_entry_reads_pending_key']));
    expect(idx.rows.map((r) => r.indexname)).not.toContain('idx_roof_entry_reads_copy_ctx_key');
    // And the rest of the chain rolls back.
    await m2.down(database);
    await m1.down(database);
    const gone = await database.raw("SELECT to_regclass(?) AS t", [`${schema}.roof_entry_reads`]);
    expect(gone.rows[0].t).toBeNull();
  });

  test('control: without the guard, rolling back 160000 fails on that same data (the problem the guard solves)', async () => {
    const [est, cust] = [await id('estimates'), await id('customers')];
    const paid = await read();
    await copy(paid, est, cust);
    await copy(paid, null, cust);
    await database('estimates').where({ id: est }).del();
    await expect(m3.down(database)).rejects.toMatchObject({ code: '23505' });
  });

  test('the guard changes nothing when there is no collision, and rolling everything back and up again works', async () => {
    const cust = await id('customers');
    const paid = await read();
    const c = await copy(paid, null, cust);
    await m4.down(database);
    const row = await database('roof_entry_reads').where({ id: c.id }).first();
    expect(row.source_id).toBe(paid.id);
    await m3.down(database);
    await m3.up(database);
    await m4.up(database);
    // The column is dropped by the down and rebuilt by the up from the keys as they stand (the back-fill).
    expect((await database('roof_entry_reads').where({ id: c.id }).first()).context_key).toBe(ctxKey(null, cust));
  });
});
