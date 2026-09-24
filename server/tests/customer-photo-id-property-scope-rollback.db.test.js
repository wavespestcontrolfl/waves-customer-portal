/**
 * 20260924000140_customer_photo_id_property_scope_rollback.js — codex P1:
 * 20260924000130's down() unconditionally DROPS the property_id column on
 * pest_identifications, lawn_diagnostics, and tree_shrub_assessments — for
 * every row, whatever its value. Unlike 20260924000110/000111's mode<->source
 * trick, there is no side-channel column that survives the drop, so this
 * migration captures an (id -> property_id) map into system_settings before
 * the drop runs, and restores it after a reapply re-adds the column — only
 * onto ids that still exist AND whose captured property still exists.
 */

const { STATE_KEY } = require('../models/migrations/20260924000140_customer_photo_id_property_scope_rollback');
const migration = require('../models/migrations/20260924000140_customer_photo_id_property_scope_rollback');

const TABLES = ['pest_identifications', 'lawn_diagnostics', 'tree_shrub_assessments'];

// ── Always-on: mocked knex ──────────────────────────────────────────────

function makeMockKnex({ tableRows = {}, settingsRows = [], properties = [] } = {}) {
  const state = {
    pest_identifications: (tableRows.pest_identifications || []).map((r) => ({ ...r })),
    lawn_diagnostics: (tableRows.lawn_diagnostics || []).map((r) => ({ ...r })),
    tree_shrub_assessments: (tableRows.tree_shrub_assessments || []).map((r) => ({ ...r })),
    system_settings: settingsRows.map((r) => ({ ...r })),
    customer_properties: properties.map((r) => ({ ...r })),
  };
  const hasColumnFlags = {
    pest_identifications: true, lawn_diagnostics: true, tree_shrub_assessments: true,
  };
  const updateCalls = [];

  function tableApi(table) {
    let filter = null;
    let notNullCol = null;
    let existsPropertyId;
    const api = {
      where(cond) { filter = cond; return api; },
      whereNotNull(col) { notNullCol = col; return api; },
      whereExists(builder) { existsPropertyId = builder.__propertyId; return api; },
      select(...cols) {
        let rows = state[table];
        if (notNullCol) rows = rows.filter((r) => r[notNullCol] != null);
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
        if (existsPropertyId !== undefined) {
          const exists = state.customer_properties.some((p) => p.id === existsPropertyId);
          rows = exists ? rows : [];
        }
        updateCalls.push({ table, filter, existsPropertyId, patch });
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
    hasColumn: async (table, col) => (col === 'property_id' ? !!hasColumnFlags[table] : false),
  };
  knex.select = () => ({
    from: () => ({
      whereRaw: (_sql, params) => ({ __propertyId: params[0] }),
    }),
  });
  knex.__state = state;
  knex.__updateCalls = updateCalls;
  knex.__setHasColumn = (table, val) => { hasColumnFlags[table] = val; };
  return knex;
}

describe('customer photo-id property scope rollback migration (mocked knex)', () => {
  test('down() captures the (id -> property_id) map per table, non-null rows only', async () => {
    const knex = makeMockKnex({
      tableRows: {
        pest_identifications: [
          { id: 'p1', property_id: 'prop-a' },
          { id: 'p2', property_id: null },
        ],
        lawn_diagnostics: [{ id: 'l1', property_id: 'prop-b' }],
        tree_shrub_assessments: [],
      },
    });
    await migration.down(knex);
    const saved = knex.__state.system_settings.find((r) => r.key === STATE_KEY);
    expect(saved).toBeTruthy();
    const parsed = JSON.parse(saved.value);
    expect(parsed.pest_identifications).toEqual([{ id: 'p1', property_id: 'prop-a' }]);
    expect(parsed.lawn_diagnostics).toEqual([{ id: 'l1', property_id: 'prop-b' }]);
    expect(parsed.tree_shrub_assessments).toEqual([]);
  });

  test('down() writes an all-empty snapshot when nothing is scoped (never a stale prior value)', async () => {
    const knex = makeMockKnex({
      tableRows: { pest_identifications: [{ id: 'p1', property_id: null }] },
      settingsRows: [{ key: STATE_KEY, value: JSON.stringify({ pest_identifications: [{ id: 'stale', property_id: 'stale-prop' }] }) }],
    });
    await migration.down(knex);
    const saved = knex.__state.system_settings.find((r) => r.key === STATE_KEY);
    const parsed = JSON.parse(saved.value);
    for (const table of TABLES) expect(parsed[table]).toEqual([]);
  });

  test('up() restores property_id for exactly the captured ids whose property still exists', async () => {
    const knex = makeMockKnex({
      tableRows: {
        pest_identifications: [
          { id: 'p1', property_id: null }, // was prop-a, rolled back, reapplied at NULL
          { id: 'p2', property_id: null }, // never captured — must stay untouched
        ],
      },
      settingsRows: [{
        key: STATE_KEY,
        value: JSON.stringify({
          pest_identifications: [{ id: 'p1', property_id: 'prop-a' }],
          lawn_diagnostics: [],
          tree_shrub_assessments: [],
        }),
      }],
      properties: [{ id: 'prop-a' }],
    });
    await migration.up(knex);
    expect(knex.__state.pest_identifications.find((r) => r.id === 'p1').property_id).toBe('prop-a');
    expect(knex.__state.pest_identifications.find((r) => r.id === 'p2').property_id).toBeNull();
  });

  test('up() skips a captured id whose property was deleted in the meantime (FK-safe, never dangling)', async () => {
    const knex = makeMockKnex({
      tableRows: { lawn_diagnostics: [{ id: 'l1', property_id: null }] },
      settingsRows: [{
        key: STATE_KEY,
        value: JSON.stringify({
          pest_identifications: [], tree_shrub_assessments: [],
          lawn_diagnostics: [{ id: 'l1', property_id: 'prop-removed' }],
        }),
      }],
      properties: [], // prop-removed no longer exists
    });
    await migration.up(knex);
    expect(knex.__state.lawn_diagnostics.find((r) => r.id === 'l1').property_id).toBeNull();
  });

  test('up() is a no-op with no stashed state (fresh install, never rolled back)', async () => {
    const knex = makeMockKnex({ tableRows: { pest_identifications: [{ id: 'p1', property_id: null }] } });
    await expect(migration.up(knex)).resolves.not.toThrow();
    expect(knex.__updateCalls).toHaveLength(0);
  });

  test('up() no-ops when the property_id column is not back yet (000130 has not reapplied)', async () => {
    const knex = makeMockKnex({
      tableRows: { pest_identifications: [{ id: 'p1' }] },
      settingsRows: [{ key: STATE_KEY, value: JSON.stringify({ pest_identifications: [{ id: 'p1', property_id: 'prop-a' }], lawn_diagnostics: [], tree_shrub_assessments: [] }) }],
      properties: [{ id: 'prop-a' }],
    });
    knex.__setHasColumn('pest_identifications', false);
    await expect(migration.up(knex)).resolves.not.toThrow();
    expect(knex.__updateCalls).toHaveLength(0);
  });

  test('round trip: down() then up() restores every scoped row exactly, unscoped rows untouched throughout', async () => {
    const knex = makeMockKnex({
      tableRows: {
        pest_identifications: [{ id: 'p1', property_id: 'prop-a' }, { id: 'p2', property_id: null }],
        lawn_diagnostics: [{ id: 'l1', property_id: 'prop-b' }],
        tree_shrub_assessments: [{ id: 't1', property_id: 'prop-a' }],
      },
      properties: [{ id: 'prop-a' }, { id: 'prop-b' }],
    });
    await migration.down(knex);
    // Simulate 20260924000130's down()+up() dropping then re-adding the
    // column at NULL in between — this migration doesn't touch the column
    // itself, only the captured map matters.
    for (const table of TABLES) knex.__state[table].forEach((r) => { r.property_id = null; });
    await migration.up(knex);
    expect(knex.__state.pest_identifications.find((r) => r.id === 'p1').property_id).toBe('prop-a');
    expect(knex.__state.pest_identifications.find((r) => r.id === 'p2').property_id).toBeNull();
    expect(knex.__state.lawn_diagnostics.find((r) => r.id === 'l1').property_id).toBe('prop-b');
    expect(knex.__state.tree_shrub_assessments.find((r) => r.id === 't1').property_id).toBe('prop-a');
  });
});

// ── Real PostgreSQL proof (skipped without DATABASE_URL) ────────────────

const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

describeDb('customer photo-id property scope rollback — real Postgres round trip', () => {
  const { randomUUID } = require('crypto');
  const knexFactory = require('knex');
  const propertyScopeMigration = require('../models/migrations/20260924000130_customer_photo_id_property_scope');

  let knex;
  let schema;

  beforeAll(async () => {
    schema = `photoid_prop_rollback_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({
      client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 },
    });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    await knex.schema.createTable('customer_properties', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    });
    for (const table of TABLES) {

      await knex.schema.createTable(table, (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      });
    }
    await knex.schema.createTable('system_settings', (t) => {
      t.string('key', 100).primary();
      t.text('value');
      t.string('category', 50);
      t.text('description');
      t.timestamps(true, true);
    });
    // The exact shape 20260924000130's up() leaves these tables in.
    await propertyScopeMigration.up(knex);
  });

  afterAll(async () => {
    if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); }
  });

  test('a scoped row survives a full down/up round trip even though 000130 drops the column entirely', async () => {
    const [prop] = await knex('customer_properties').insert({}).returning(['id']);
    const [scopedRow] = await knex('pest_identifications').insert({ property_id: prop.id }).returning(['id']);
    const [unscopedRow] = await knex('pest_identifications').insert({ property_id: null }).returning(['id']);

    // This migration's down() runs FIRST in a real rollback (newer stamp) —
    // capture before 20260924000130's down() ever runs.
    await migration.down(knex);

    // 20260924000130's down() — its EXACT code — drops property_id outright.
    await expect(propertyScopeMigration.down(knex)).resolves.not.toThrow();
    const midCols = await knex('pest_identifications').columnInfo();
    expect(midCols.property_id).toBeUndefined();

    // Reapply: 20260924000130's up() re-adds the column (nullable, no default)...
    await expect(propertyScopeMigration.up(knex)).resolves.not.toThrow();
    const midRow = await knex('pest_identifications').where({ id: scopedRow.id }).first();
    expect(midRow.property_id).toBeNull(); // not yet restored

    // ...then this migration's up() restores exactly the captured row.
    await migration.up(knex);
    const finalScoped = await knex('pest_identifications').where({ id: scopedRow.id }).first();
    const finalUnscoped = await knex('pest_identifications').where({ id: unscopedRow.id }).first();
    expect(finalScoped.property_id).toBe(prop.id);
    expect(finalUnscoped.property_id).toBeNull();
  });

  test('a captured property deleted during the rollback window is never resurrected as a dangling reference', async () => {
    const [prop] = await knex('customer_properties').insert({}).returning(['id']);
    const [row] = await knex('lawn_diagnostics').insert({ property_id: prop.id }).returning(['id']);

    await migration.down(knex);
    await propertyScopeMigration.down(knex);
    // The property itself is removed while the column is gone.
    await knex('customer_properties').where({ id: prop.id }).del();
    await propertyScopeMigration.up(knex);

    await expect(migration.up(knex)).resolves.not.toThrow();
    const final = await knex('lawn_diagnostics').where({ id: row.id }).first();
    expect(final.property_id).toBeNull();
  });
});
