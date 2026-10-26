// misting_layouts (misting layout designer step 3, GATE_MISTING_LAYOUT_DESIGNER): the table, its one-row-per-estimate
// key and its cascade, and a reversible down(), proven on a real PostgreSQL in a disposable schema
// (skipped without APP_TEST_DATABASE_URL, run for real in CI).
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20261026130000_misting_layouts');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `misting_layouts_${randomUUID().replaceAll('-', '')}`;
const TABLE = 'misting_layouts';

const base = (estimateId, extra = {}) => ({
  estimate_id: estimateId, center_lat: 26.95, center_lng: -82.4, zoom: 20, map_width: 1280, map_height: 960, ...extra,
});

postgres('misting_layouts (PostgreSQL)', () => {
  let admin;
  let app;
  const estimateA = randomUUID();
  const estimateB = randomUUID();

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 1 } });
    await app.schema.createTable('estimates', (t) => { t.uuid('id').primary(); });
    await app('estimates').insert([{ id: estimateA }, { id: estimateB }]);
    await migration.up(app);
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  test('defaults: uuid id, empty geometry, zero counts, no picture, timestamps', async () => {
    const [row] = await app(TABLE).insert(base(estimateA)).returning('*');
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row).toMatchObject({ lines: [], nozzles: [], risers: [], zones: [], pump: null, nozzle_count: 0, eave_count: 0, fence_count: 0, riser_count: 0, linear_ft: 0, snapshot_s3_key: null });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
    await app(TABLE).where({ estimate_id: estimateA }).del();
  });

  test('an estimate has one current layout: a second row for it is refused, and an upsert replaces it', async () => {
    await app(TABLE).insert(base(estimateA, { zoom: 19 }));
    await expect(app(TABLE).insert(base(estimateA))).rejects.toMatchObject({ code: '23505' });
    await app(TABLE).insert(base(estimateA, { zoom: 21 })).onConflict('estimate_id').merge({ zoom: 21 });
    const rows = await app(TABLE).where({ estimate_id: estimateA });
    expect(rows).toHaveLength(1);
    expect(rows[0].zoom).toBe(21);
  });

  test('a layout needs a real estimate, and goes with it when the estimate is deleted', async () => {
    await expect(app(TABLE).insert(base(randomUUID()))).rejects.toMatchObject({ code: '23503' });
    await app(TABLE).insert(base(estimateB));
    await app('estimates').where({ id: estimateB }).del();
    expect(await app(TABLE).where({ estimate_id: estimateB })).toHaveLength(0);
  });

  test('geometry round-trips as jsonb, arrays included', async () => {
    await app(TABLE).where({ estimate_id: estimateA }).update({
      lines: JSON.stringify([{ id: 'L1', kind: 'eave', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }]),
      pump: JSON.stringify({ x: 5, y: 6 }),
    });
    const row = await app(TABLE).where({ estimate_id: estimateA }).first();
    expect(row.lines[0].points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(row.pump).toEqual({ x: 5, y: 6 });
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
