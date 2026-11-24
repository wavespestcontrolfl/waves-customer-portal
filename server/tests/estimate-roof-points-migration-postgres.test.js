const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL. estimate_roof_points (tech-confirmed roof points frozen at send, owner
// ruling 2026-11-20): the table, its one-row-per-estimate key, the cascade from the estimate, SET NULL from the read, the
// required handoff time, and a reversible, idempotent migration. Everything runs in a unique schema (with minimal
// estimates and roof_entry_reads tables for the foreign keys) that is dropped afterwards.
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20261120210000_estimate_roof_points');
const customerMigration = require('../models/migrations/20261121010000_estimate_roof_points_customer');

const schema = `estimate_roof_points_${randomUUID().replaceAll('-', '')}`;
const TABLE = 'estimate_roof_points';
const SENT = '2026-11-20T16:00:00.000Z';
const SNAPSHOT = { imageUrl: 'https://example.test/aerial.jpg', imageYear: 2025, pins: [{ n: 1, x: 0.25, y: 0.4, type: 'other', label: 'Entry point', action: 'seal' }] };

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('estimate_roof_points (PostgreSQL)', () => {
  let app;
  const estimateA = randomUUID();
  const estimateB = randomUUID();
  const readA = randomUUID();

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId)
      && target.pathname === `/waves_qa_${worktreeId}`;
    if (!ci && !ownedQA) throw new Error('Use the isolated CI database or this worktree\'s private QA database');
    // The driver copies every query parameter of a connection string into its settings, so the pool gets the parts
    // checked above, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    app = knex({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      searchPath: [schema],
      pool: { min: 0, max: 1 },
    });
    await app.raw('CREATE SCHEMA ??', [schema]);
    await app.schema.createTable('estimates', (t) => { t.uuid('id').primary(); });
    await app.schema.createTable('roof_entry_reads', (t) => { t.uuid('id').primary(); });
    await app.schema.createTable('customers', (t) => { t.uuid('id').primary(); });
    await app('estimates').insert([{ id: estimateA }, { id: estimateB }]);
    await app('roof_entry_reads').insert({ id: readA });
    await migration.up(app);
    await customerMigration.up(app);
  });

  afterAll(async () => {
    if (!app) return;
    await app.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema]);
    await app.destroy();
  });

  test('a row holds the read id, the address, the handoff time and the snapshot as jsonb, with frozen_at defaulted', async () => {
    await app(TABLE).insert({ estimate_id: estimateA, read_id: readA, address: '12 Synthetic Way', snapshot: JSON.stringify(SNAPSHOT), delivered_at: SENT });
    const row = await app(TABLE).where({ estimate_id: estimateA }).first();
    expect(row.snapshot).toEqual(SNAPSHOT);
    expect(row.read_id).toBe(readA);
    expect(row.address).toBe('12 Synthetic Way');
    expect(row.delivered_at.toISOString()).toBe(SENT);
    expect(row.frozen_at).toBeInstanceOf(Date);
  });

  test('an estimate has one frozen copy: a second insert is refused, and an upsert replaces it', async () => {
    await expect(app(TABLE).insert({ estimate_id: estimateA, snapshot: JSON.stringify(SNAPSHOT), delivered_at: SENT })).rejects.toMatchObject({ code: '23505' });
    const next = { ...SNAPSHOT, pins: [] };
    await app(TABLE).insert({ estimate_id: estimateA, read_id: null, snapshot: JSON.stringify(next), delivered_at: SENT }).onConflict('estimate_id').merge();
    const rows = await app(TABLE).where({ estimate_id: estimateA });
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot).toEqual(next);
    expect(rows[0].read_id).toBeNull();
  });

  test('the snapshot and the handoff time are required, and a copy needs a real estimate and a real read', async () => {
    await expect(app(TABLE).insert({ estimate_id: estimateB, delivered_at: SENT })).rejects.toMatchObject({ code: '23502' });
    await expect(app(TABLE).insert({ estimate_id: estimateB, snapshot: JSON.stringify(SNAPSHOT) })).rejects.toMatchObject({ code: '23502' });
    await expect(app(TABLE).insert({ estimate_id: randomUUID(), snapshot: JSON.stringify(SNAPSHOT), delivered_at: SENT })).rejects.toMatchObject({ code: '23503' });
    await expect(app(TABLE).insert({ estimate_id: estimateB, read_id: randomUUID(), snapshot: JSON.stringify(SNAPSHOT), delivered_at: SENT })).rejects.toMatchObject({ code: '23503' });
  });

  test('deleting the read keeps the copy (read_id goes null); deleting the estimate removes it', async () => {
    await app(TABLE).insert({ estimate_id: estimateB, read_id: readA, snapshot: JSON.stringify(SNAPSHOT), delivered_at: SENT });
    await app('roof_entry_reads').where({ id: readA }).del();
    const kept = await app(TABLE).where({ estimate_id: estimateB }).first();
    expect(kept.read_id).toBeNull();
    await app('estimates').where({ id: estimateB }).del();
    expect(await app(TABLE).where({ estimate_id: estimateB })).toHaveLength(0);
  });

  test('the copy names the customer it was frozen for: null for none, a real customer otherwise, and it goes with a deleted customer', async () => {
    const [estimateC, estimateD, customer] = [randomUUID(), randomUUID(), randomUUID()];
    await app('estimates').insert([{ id: estimateC }, { id: estimateD }]);
    await app('customers').insert({ id: customer });
    const copy = (over) => ({ snapshot: JSON.stringify(SNAPSHOT), delivered_at: SENT, ...over });
    // Frozen for an estimate with no customer: the column is null.
    await app(TABLE).insert(copy({ estimate_id: estimateC }));
    expect((await app(TABLE).where({ estimate_id: estimateC }).first()).customer_id).toBeNull();
    // Frozen for a customer: it must be a real one, and a re-send replaces it.
    await expect(app(TABLE).insert(copy({ estimate_id: estimateD, customer_id: randomUUID() }))).rejects.toMatchObject({ code: '23503' });
    await app(TABLE).insert(copy({ estimate_id: estimateC, customer_id: customer })).onConflict('estimate_id').merge();
    expect((await app(TABLE).where({ estimate_id: estimateC }).first()).customer_id).toBe(customer);
    // A deleted customer's copy goes with the customer, so null never comes to mean "the customer is gone".
    await app('customers').where({ id: customer }).del();
    expect(await app(TABLE).where({ estimate_id: estimateC })).toHaveLength(0);
  });

  test('the customer column: up() twice is a no-op, down() drops only the column and keeps the rows, up() brings it back empty', async () => {
    const estimateE = randomUUID();
    await app('estimates').insert({ id: estimateE });
    await app(TABLE).insert({ estimate_id: estimateE, snapshot: JSON.stringify(SNAPSHOT), delivered_at: SENT });
    await customerMigration.up(app);
    expect(await app.schema.hasColumn(TABLE, 'customer_id')).toBe(true);
    await customerMigration.down(app);
    expect(await app.schema.hasColumn(TABLE, 'customer_id')).toBe(false);
    expect(await app(TABLE).where({ estimate_id: estimateE })).toHaveLength(1);
    await customerMigration.down(app);
    await customerMigration.up(app);
    expect((await app(TABLE).where({ estimate_id: estimateE }).first()).customer_id).toBeNull();
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
