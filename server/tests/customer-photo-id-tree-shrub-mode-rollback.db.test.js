/**
 * 20260924000112_customer_photo_id_tree_shrub_mode_rollback.js — codex GH r2
 * P1: 20260924000100's down() DROPS tree_shrub_assessments' mode/source
 * columns outright (unlike pest/lawn, where only the mode VALUE changes),
 * so a customer submission's identity is destroyed at drop time, not just
 * hidden. This migration captures the customer-mode row ids into
 * system_settings (durable — survives the column drop) before that drop
 * runs, and restores them after a reapply re-adds the columns.
 */

const { STATE_KEY } = require('../models/migrations/20260924000112_customer_photo_id_tree_shrub_mode_rollback');
const migration = require('../models/migrations/20260924000112_customer_photo_id_tree_shrub_mode_rollback');

// ── Always-on: mocked knex ──────────────────────────────────────────────

function makeMockKnex({ treeRows = [], settingsRows = [] } = {}) {
  const state = {
    tree_shrub_assessments: treeRows.map((r) => ({ ...r })),
    system_settings: settingsRows.map((r) => ({ ...r })),
  };
  const hasColumnFlags = { mode: true, source: true };
  const updateCalls = [];
  const upsertCalls = [];

  function treeApi() {
    let filter = null;
    let ids = null;
    const api = {
      where(cond) { filter = cond; return api; },
      whereIn(col, vals) { ids = vals; return api; },
      select(...cols) {
        const rows = state.tree_shrub_assessments.filter((r) => (!filter || Object.entries(filter).every(([k, v]) => r[k] === v)));
        return Promise.resolve(rows.map((r) => (cols.length ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r })));
      },
      async update(patch) {
        const rows = state.tree_shrub_assessments.filter((r) => (ids ? ids.includes(r.id) : (!filter || Object.entries(filter).every(([k, v]) => r[k] === v))));
        updateCalls.push({ filter, ids, patch });
        rows.forEach((r) => Object.assign(r, patch));
        return rows.length;
      },
    };
    return api;
  }

  function settingsApi() {
    let filter = null;
    const api = {
      where(cond) { filter = cond; return api; },
      first(...cols) {
        const row = state.system_settings.find((r) => (!filter || Object.entries(filter).every(([k, v]) => r[k] === v)));
        return Promise.resolve(row ? (cols.length ? Object.fromEntries(cols.map((c) => [c, row[c]])) : { ...row }) : undefined);
      },
      insert(obj) {
        return {
          onConflict: () => ({
            merge: (cols) => {
              upsertCalls.push(obj);
              const existing = state.system_settings.find((r) => r.key === obj.key);
              if (existing) {
                (cols || Object.keys(obj)).forEach((c) => { existing[c] = obj[c]; });
              } else {
                state.system_settings.push({ ...obj });
              }
              return Promise.resolve();
            },
          }),
        };
      },
    };
    return api;
  }

  const knex = (table) => {
    if (table === 'tree_shrub_assessments') return treeApi();
    if (table === 'system_settings') return settingsApi();
    throw new Error(`unexpected table ${table}`);
  };
  knex.schema = {
    hasTable: async (table) => table === 'tree_shrub_assessments' || table === 'system_settings',
    hasColumn: async (table, col) => (table === 'tree_shrub_assessments' ? !!hasColumnFlags[col] : false),
  };
  knex.__state = state;
  knex.__updateCalls = updateCalls;
  knex.__upsertCalls = upsertCalls;
  knex.__setHasColumn = (col, val) => { hasColumnFlags[col] = val; };
  return knex;
}

describe('customer photo-id tree_shrub mode rollback migration (mocked knex)', () => {
  test('down() captures every mode=customer row id into system_settings', async () => {
    const knex = makeMockKnex({
      treeRows: [
        { id: 't1', mode: 'customer', source: 'portal' },
        { id: 't2', mode: 'internal', source: 'tech' },
        { id: 't3', mode: 'customer', source: 'portal' },
      ],
    });
    await migration.down(knex);
    const saved = knex.__state.system_settings.find((r) => r.key === STATE_KEY);
    expect(saved).toBeTruthy();
    expect(JSON.parse(saved.value).sort()).toEqual(['t1', 't3']);
  });

  test('down() writes an empty array when nothing is mode=customer (never a stale prior value)', async () => {
    const knex = makeMockKnex({
      treeRows: [{ id: 't1', mode: 'internal', source: 'tech' }],
      settingsRows: [{ key: STATE_KEY, value: JSON.stringify(['stale-id']) }],
    });
    await migration.down(knex);
    const saved = knex.__state.system_settings.find((r) => r.key === STATE_KEY);
    expect(JSON.parse(saved.value)).toEqual([]);
  });

  test('up() restores mode=customer/source=portal for exactly the captured ids', async () => {
    const knex = makeMockKnex({
      treeRows: [
        { id: 't1', mode: 'internal', source: 'tech' }, // was customer, rolled back, reapplied at defaults
        { id: 't2', mode: 'internal', source: 'tech' }, // a REAL tech row — never captured, must stay untouched
      ],
      settingsRows: [{ key: STATE_KEY, value: JSON.stringify(['t1']) }],
    });
    await migration.up(knex);
    expect(knex.__state.tree_shrub_assessments.find((r) => r.id === 't1')).toEqual({ id: 't1', mode: 'customer', source: 'portal' });
    expect(knex.__state.tree_shrub_assessments.find((r) => r.id === 't2')).toEqual({ id: 't2', mode: 'internal', source: 'tech' });
  });

  test('up() is a no-op with no stashed state (fresh install, never rolled back)', async () => {
    const knex = makeMockKnex({ treeRows: [{ id: 't1', mode: 'internal', source: 'tech' }] });
    await expect(migration.up(knex)).resolves.not.toThrow();
    expect(knex.__updateCalls).toHaveLength(0);
  });

  test('up() no-ops when the mode/source columns are not back yet (000100 has not reapplied)', async () => {
    const knex = makeMockKnex({
      treeRows: [{ id: 't1' }],
      settingsRows: [{ key: STATE_KEY, value: JSON.stringify(['t1']) }],
    });
    knex.__setHasColumn('mode', false);
    await expect(migration.up(knex)).resolves.not.toThrow();
    expect(knex.__updateCalls).toHaveLength(0);
  });

  test('round trip: down() then up() restores the row exactly, tech rows untouched throughout', async () => {
    const knex = makeMockKnex({
      treeRows: [
        { id: 't1', mode: 'customer', source: 'portal' },
        { id: 't2', mode: 'internal', source: 'tech' },
      ],
    });
    await migration.down(knex);
    // Simulate 20260924000100's down() dropping (then reapply re-adding at
    // defaults) the columns in between — this migration doesn't touch the
    // columns itself, only the captured ids matter.
    knex.__state.tree_shrub_assessments.forEach((r) => { r.mode = 'internal'; r.source = 'tech'; });
    await migration.up(knex);
    expect(knex.__state.tree_shrub_assessments.find((r) => r.id === 't1')).toEqual({ id: 't1', mode: 'customer', source: 'portal' });
    expect(knex.__state.tree_shrub_assessments.find((r) => r.id === 't2')).toEqual({ id: 't2', mode: 'internal', source: 'tech' });
  });
});

// ── Real PostgreSQL proof (skipped without DATABASE_URL) ────────────────

const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

describeDb('customer photo-id tree_shrub mode rollback — real Postgres round trip', () => {
  const { randomUUID } = require('crypto');
  const knexFactory = require('knex');
  const columnsMigration = require('../models/migrations/20260924000100_customer_photo_id_columns');

  let knex;
  let schema;

  beforeAll(async () => {
    schema = `photoid_ts_rollback_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({
      client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 },
    });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.schema.createTable('tree_shrub_assessments', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    });
    await knex.schema.createTable('system_settings', (t) => {
      t.string('key', 100).primary();
      t.text('value');
      t.string('category', 50);
      t.text('description');
      t.timestamps(true, true);
    });
    // The exact shape 20260924000100's up() would have already left this
    // table in — mode/source columns present, a real tech row and a real
    // customer row both existing before any rollback.
    await knex.schema.alterTable('tree_shrub_assessments', (t) => {
      t.string('mode', 20).notNullable().defaultTo('internal');
      t.string('source', 30).notNullable().defaultTo('tech');
    });
  });

  afterAll(async () => {
    if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); }
  });

  test('a customer row survives a full down/up round trip even though 000100 drops its columns entirely', async () => {
    const [techRow] = await knex('tree_shrub_assessments').insert({ mode: 'internal', source: 'tech' }).returning(['id']);
    const [customerRow] = await knex('tree_shrub_assessments').insert({ mode: 'customer', source: 'portal' }).returning(['id']);

    // This migration's down() runs FIRST in a real rollback (newest stamp) —
    // capture before 20260924000100's down() ever runs.
    await migration.down(knex);

    // 20260924000100's down() — its EXACT code — drops mode/source outright.
    await expect(columnsMigration.down(knex)).resolves.not.toThrow();
    const midCols = await knex('tree_shrub_assessments').columnInfo();
    expect(midCols.mode).toBeUndefined();
    expect(midCols.source).toBeUndefined();

    // Reapply: 20260924000100's up() re-adds the columns at their defaults...
    await expect(columnsMigration.up(knex)).resolves.not.toThrow();
    const midRow = await knex('tree_shrub_assessments').where({ id: customerRow.id }).first();
    expect(midRow.mode).toBe('internal'); // the default — not yet restored

    // ...then this migration's up() restores exactly the captured row.
    await migration.up(knex);
    const finalCustomer = await knex('tree_shrub_assessments').where({ id: customerRow.id }).first();
    const finalTech = await knex('tree_shrub_assessments').where({ id: techRow.id }).first();
    expect(finalCustomer.mode).toBe('customer');
    expect(finalCustomer.source).toBe('portal');
    expect(finalTech.mode).toBe('internal'); // the real tech row was never captured, stays at the default — correct either way
  });
});
