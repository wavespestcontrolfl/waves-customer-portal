/**
 * 20260924000150_customer_photo_id_note_location_rollback.js — codex P2:
 * 20260924000100's down() unconditionally DROPS the note and location
 * columns on pest_identifications, lawn_diagnostics, and
 * tree_shrub_assessments — for every row, whatever its value. There is no
 * side-channel column that survives the drop, so this migration captures an
 * (id -> { note, location }) map into system_settings before the drop runs,
 * and restores it after a reapply re-adds the columns — only onto ids that
 * still exist. Mirrors customer-photo-id-property-scope-rollback.db.test.js.
 */

const { STATE_KEY } = require('../models/migrations/20260924000150_customer_photo_id_note_location_rollback');
const migration = require('../models/migrations/20260924000150_customer_photo_id_note_location_rollback');

const TABLES = ['pest_identifications', 'lawn_diagnostics', 'tree_shrub_assessments'];

// ── Always-on: mocked knex ──────────────────────────────────────────────

function makeMockKnex({ tableRows = {}, settingsRows = [] } = {}) {
  const state = {
    pest_identifications: (tableRows.pest_identifications || []).map((r) => ({ ...r })),
    lawn_diagnostics: (tableRows.lawn_diagnostics || []).map((r) => ({ ...r })),
    tree_shrub_assessments: (tableRows.tree_shrub_assessments || []).map((r) => ({ ...r })),
    system_settings: settingsRows.map((r) => ({ ...r })),
  };
  const hasColumnFlags = {
    pest_identifications: true, lawn_diagnostics: true, tree_shrub_assessments: true,
  };
  const updateCalls = [];

  function tableApi(table) {
    let filter = null;
    const api = {
      where(cond) { filter = cond; return api; },
      select(...cols) {
        let rows = state[table];
        if (filter) rows = rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        return Promise.resolve(rows.map((r) => (cols.length ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r })));
      },
      first(...cols) {
        let rows = state[table];
        if (filter) rows = rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        const row = rows[0];
        return Promise.resolve(row ? (cols.length ? Object.fromEntries(cols.map((c) => [c, row[c]])) : { ...row }) : undefined);
      },
      async update(patch) {
        let rows = state[table];
        if (filter) rows = rows.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
        updateCalls.push({ table, filter, patch });
        rows.forEach((r) => Object.assign(r, patch));
        return rows.length;
      },
      insert(obj) {
        return {
          onConflict: () => ({
            merge: (cols) => {
              const existing = state.system_settings.find((r) => r.key === obj.key);
              if (existing) (cols || Object.keys(obj)).forEach((c) => { existing[c] = obj[c]; });
              else state.system_settings.push({ ...obj });
              return Promise.resolve();
            },
          }),
        };
      },
    };
    return api;
  }

  const knex = (table) => tableApi(table);
  knex.schema = {
    hasTable: async (table) => Object.prototype.hasOwnProperty.call(state, table),
    hasColumn: async (table, col) => (['note', 'location'].includes(col) ? !!hasColumnFlags[table] : false),
  };
  knex.__state = state;
  knex.__updateCalls = updateCalls;
  knex.__setHasColumn = (table, val) => { hasColumnFlags[table] = val; };
  return knex;
}

describe('customer photo-id note/location rollback migration (mocked knex)', () => {
  test('down() captures the (id -> {note, location}) map per table, only rows carrying either value', async () => {
    const knex = makeMockKnex({
      tableRows: {
        pest_identifications: [
          { id: 'p1', note: 'kitchen counter', location: 'kitchen' },
          { id: 'p2', note: null, location: null },
        ],
        lawn_diagnostics: [{ id: 'l1', note: null, location: 'front_yard' }],
        tree_shrub_assessments: [],
      },
    });
    await migration.down(knex);
    const saved = knex.__state.system_settings.find((r) => r.key === STATE_KEY);
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved.value);
    expect(parsed.pest_identifications).toEqual([{ id: 'p1', note: 'kitchen counter', location: 'kitchen' }]);
    expect(parsed.lawn_diagnostics).toEqual([{ id: 'l1', note: null, location: 'front_yard' }]);
    expect(parsed.tree_shrub_assessments).toEqual([]);
  });

  test('down() writes an all-empty snapshot when nothing is set (never a stale prior value)', async () => {
    const knex = makeMockKnex({
      tableRows: { pest_identifications: [{ id: 'p1', note: null, location: null }] },
      settingsRows: [{ key: STATE_KEY, value: JSON.stringify({ pest_identifications: [{ id: 'stale', note: 'stale note', location: null }] }) }],
    });
    await migration.down(knex);
    const saved = knex.__state.system_settings.find((r) => r.key === STATE_KEY);
    const parsed = JSON.parse(saved.value);
    for (const table of TABLES) expect(parsed[table]).toEqual([]);
  });

  test('up() restores note/location for exactly the captured ids', async () => {
    const knex = makeMockKnex({
      tableRows: {
        pest_identifications: [
          { id: 'p1', note: null, location: null }, // rolled back, reapplied at NULL
          { id: 'p2', note: null, location: null }, // never captured — must stay untouched
        ],
      },
      settingsRows: [{
        key: STATE_KEY,
        value: JSON.stringify({
          pest_identifications: [{ id: 'p1', note: 'kitchen counter', location: 'kitchen' }],
          lawn_diagnostics: [],
          tree_shrub_assessments: [],
        }),
      }],
    });
    await migration.up(knex);
    const restored = knex.__state.pest_identifications.find((r) => r.id === 'p1');
    expect(restored.note).toBe('kitchen counter');
    expect(restored.location).toBe('kitchen');
    const untouched = knex.__state.pest_identifications.find((r) => r.id === 'p2');
    expect(untouched.note).toBeNull();
    expect(untouched.location).toBeNull();
  });

  test('up() restores a one-sided capture (note only) without clobbering the other column', async () => {
    const knex = makeMockKnex({
      tableRows: { lawn_diagnostics: [{ id: 'l1', note: null, location: null }] },
      settingsRows: [{
        key: STATE_KEY,
        value: JSON.stringify({
          pest_identifications: [], tree_shrub_assessments: [],
          lawn_diagnostics: [{ id: 'l1', note: null, location: 'front_yard' }],
        }),
      }],
    });
    await migration.up(knex);
    const restored = knex.__state.lawn_diagnostics.find((r) => r.id === 'l1');
    expect(restored.note).toBeNull();
    expect(restored.location).toBe('front_yard');
  });

  test('up() is a no-op with no stashed state (fresh install, never rolled back)', async () => {
    const knex = makeMockKnex({ tableRows: { pest_identifications: [{ id: 'p1', note: null, location: null }] } });
    await expect(migration.up(knex)).resolves.not.toThrow();
    expect(knex.__updateCalls).toHaveLength(0);
  });

  test('up() no-ops when the note/location columns are not back yet (000100 has not reapplied)', async () => {
    const knex = makeMockKnex({
      tableRows: { pest_identifications: [{ id: 'p1' }] },
      settingsRows: [{ key: STATE_KEY, value: JSON.stringify({ pest_identifications: [{ id: 'p1', note: 'x', location: 'y' }], lawn_diagnostics: [], tree_shrub_assessments: [] }) }],
    });
    knex.__setHasColumn('pest_identifications', false);
    await expect(migration.up(knex)).resolves.not.toThrow();
    expect(knex.__updateCalls).toHaveLength(0);
  });

  test('round trip: down() then up() restores every captured row exactly, untouched rows stay untouched', async () => {
    const knex = makeMockKnex({
      tableRows: {
        pest_identifications: [{ id: 'p1', note: 'kitchen counter', location: 'kitchen' }, { id: 'p2', note: null, location: null }],
        lawn_diagnostics: [{ id: 'l1', note: null, location: 'front_yard' }],
        tree_shrub_assessments: [{ id: 't1', note: 'oak tree', location: 'backyard' }],
      },
    });
    await migration.down(knex);
    // Simulate 20260924000100's down()+up() dropping then re-adding the
    // columns at NULL in between — this migration doesn't touch the columns
    // itself, only the captured map matters.
    for (const table of TABLES) knex.__state[table].forEach((r) => { r.note = null; r.location = null; });
    await migration.up(knex);
    expect(knex.__state.pest_identifications.find((r) => r.id === 'p1')).toMatchObject({ note: 'kitchen counter', location: 'kitchen' });
    expect(knex.__state.pest_identifications.find((r) => r.id === 'p2')).toMatchObject({ note: null, location: null });
    expect(knex.__state.lawn_diagnostics.find((r) => r.id === 'l1')).toMatchObject({ note: null, location: 'front_yard' });
    expect(knex.__state.tree_shrub_assessments.find((r) => r.id === 't1')).toMatchObject({ note: 'oak tree', location: 'backyard' });
  });
});

// ── Real PostgreSQL proof (skipped without DATABASE_URL) ────────────────

const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

describeDb('customer photo-id note/location rollback — real Postgres round trip', () => {
  const { randomUUID } = require('crypto');
  const knexFactory = require('knex');
  const columnsMigration = require('../models/migrations/20260924000100_customer_photo_id_columns');

  let knex;
  let schema;

  beforeAll(async () => {
    schema = `photoid_note_loc_rollback_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({
      client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 },
    });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    // pest_identifications / lawn_diagnostics already carry a 'mode' column
    // (from 20260707000030, pre-existing prod schema) by the time
    // 20260924000100 runs — its up() re-adds that column's CHECK constraint,
    // which requires the column to already exist. tree_shrub_assessments has
    // neither column yet (000100's up() adds both via addIfMissing).
    await knex.schema.createTable('pest_identifications', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('mode', 20).notNullable().defaultTo('prospect');
    });
    await knex.schema.createTable('lawn_diagnostics', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('mode', 20).notNullable().defaultTo('prospect');
    });
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
    // The exact shape 20260924000100's up() leaves these tables in (note +
    // location added; the mode CHECK constraint touches pest/lawn only and
    // is irrelevant to this test).
    await columnsMigration.up(knex);
  });

  afterAll(async () => {
    if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); }
  });

  test('a captured note/location survives a full down/up round trip even though 000100 drops the columns entirely', async () => {
    const [row] = await knex('pest_identifications').insert({ note: 'kitchen counter', location: 'kitchen' }).returning(['id']);
    const [unscoped] = await knex('pest_identifications').insert({ note: null, location: null }).returning(['id']);

    // This migration's down() runs FIRST in a real rollback (newer stamp) —
    // capture before 20260924000100's down() ever runs.
    await migration.down(knex);

    // 20260924000100's down() — its EXACT code — drops note/location outright.
    await expect(columnsMigration.down(knex)).resolves.not.toThrow();
    const midCols = await knex('pest_identifications').columnInfo();
    expect(midCols.note).toBeUndefined();
    expect(midCols.location).toBeUndefined();

    // Reapply: 20260924000100's up() re-adds the columns (nullable)...
    await expect(columnsMigration.up(knex)).resolves.not.toThrow();
    const midRow = await knex('pest_identifications').where({ id: row.id }).first();
    expect(midRow.note).toBeNull(); // not yet restored
    expect(midRow.location).toBeNull();

    // ...then this migration's up() restores exactly the captured row.
    await migration.up(knex);
    const finalRow = await knex('pest_identifications').where({ id: row.id }).first();
    const finalUnscoped = await knex('pest_identifications').where({ id: unscoped.id }).first();
    expect(finalRow.note).toBe('kitchen counter');
    expect(finalRow.location).toBe('kitchen');
    expect(finalUnscoped.note).toBeNull();
    expect(finalUnscoped.location).toBeNull();
  });

  test('a row with only location set round-trips without inventing a note', async () => {
    const [row] = await knex('lawn_diagnostics').insert({ note: null, location: 'front_yard' }).returning(['id']);

    await migration.down(knex);
    await columnsMigration.down(knex);
    await columnsMigration.up(knex);
    await migration.up(knex);

    const final = await knex('lawn_diagnostics').where({ id: row.id }).first();
    expect(final.note).toBeNull();
    expect(final.location).toBe('front_yard');
  });
});
