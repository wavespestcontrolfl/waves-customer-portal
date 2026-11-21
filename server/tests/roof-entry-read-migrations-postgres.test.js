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
const m5 = require('../models/migrations/20261120200000_roof_entry_read_tech_pins');
const m6 = require('../models/migrations/20261120220000_roof_entry_read_points_address');
const m7 = require('../models/migrations/20261120230000_roof_entry_read_hide_per_estimate');

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
    for (const m of [m1, m2, m3, m4, m5, m6]) await m.up(database);
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

  test('the tech pins migration adds the columns with safe defaults, is idempotent, and its down drops them without losing the rest', async () => {
    const row = await read({ tech_final_count: 4 });
    expect(row.tech_pins).toBeNull();
    expect(row.hide_on_estimate).toBe(false);
    expect(row.crop_lat).toBeNull();
    expect(row.crop_lng).toBeNull();
    const saved = await database('roof_entry_reads').where({ id: row.id }).update({
      tech_pins: JSON.stringify([{ x: 0.5, y: 0.5, type: 'other', note: null }]), hide_on_estimate: true, crop_lat: 27.46, crop_lng: -82.57,
    }).returning('*').then(([r]) => r);
    expect(saved.tech_pins).toEqual([{ x: 0.5, y: 0.5, type: 'other', note: null }]);
    expect(Number(saved.crop_lat)).toBe(27.46);
    expect(Number(saved.crop_lng)).toBe(-82.57);
    await m5.up(database);
    await m5.down(database);
    for (const c of ['tech_pins', 'hide_on_estimate', 'crop_lat', 'crop_lng']) expect(await database.schema.hasColumn('roof_entry_reads', c)).toBe(false);
    expect((await database('roof_entry_reads').where({ id: row.id }).first()).tech_final_count).toBe(4);
    await m5.down(database);
    await m5.up(database);
    const again = await database('roof_entry_reads').where({ id: row.id }).first();
    expect(again.tech_pins).toBeNull();
    expect(again.hide_on_estimate).toBe(false);
  });

  test('the points address migration adds a nullable column, is idempotent, and its down drops only that column', async () => {
    const row = await read({ tech_final_count: 4 });
    expect(row.points_address).toBeNull();
    await database('roof_entry_reads').where({ id: row.id }).update({ points_address: '12 Synthetic Way, Bradenton, FL 34203' });
    await m6.up(database);
    expect((await database('roof_entry_reads').where({ id: row.id }).first()).points_address).toBe('12 Synthetic Way, Bradenton, FL 34203');
    await m6.down(database);
    expect(await database.schema.hasColumn('roof_entry_reads', 'points_address')).toBe(false);
    expect((await database('roof_entry_reads').where({ id: row.id }).first()).tech_final_count).toBe(4);
    await m6.down(database);
    await m6.up(database);
    expect((await database('roof_entry_reads').where({ id: row.id }).first()).points_address).toBeNull();
  });

  test('the per-estimate hide migration hides every read of an estimate that has a hidden read, and changes no other read', async () => {
    const [estA, estB] = [await id('estimates'), await id('estimates')];
    const row = (name, extra) => read({ model: name, ...extra });
    // Estimate A: one read hidden under part 1's per-read switch, two not. Estimate B: nothing hidden. Two reads with no estimate.
    await row('a1', { estimate_id: estA, hide_on_estimate: true, tech_final_count: 4 });
    await row('a2', { estimate_id: estA });
    await row('a3', { estimate_id: estA, status: 'failed' });
    await row('b1', { estimate_id: estB });
    await row('b2', { estimate_id: estB });
    await row('n1', { hide_on_estimate: true });
    await row('n2', {});
    const flags = async () => Object.fromEntries((await database('roof_entry_reads').select('model', 'hide_on_estimate')).map((r) => [r.model, r.hide_on_estimate]));
    const want = { a1: true, a2: true, a3: true, b1: false, b2: false, n1: true, n2: false };
    await m7.up(database);
    expect(await flags()).toEqual(want);
    // A second run and the down change nothing, and nothing else on a row moved.
    await m7.up(database);
    await m7.down(database);
    expect(await flags()).toEqual(want);
    expect((await database('roof_entry_reads').where({ model: 'a1' }).first()).tech_final_count).toBe(4);
    expect(await database('roof_entry_reads').count('* as n').first()).toEqual({ n: '7' });
  });
});
