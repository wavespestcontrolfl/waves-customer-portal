/**
 * 20260924000110_customer_photo_id_mode_rollback.js — rollback-safety
 * companion to the frozen 20260924000100_customer_photo_id_columns.js.
 *
 * Two layers:
 *  - Always-on mocked-knex unit tests: up() is inert, down() remaps every
 *    mode='customer' row to 'internal' (leaving `source='portal'` intact)
 *    on both tables, untouched rows/tables are left alone.
 *  - A real-PostgreSQL proof (skipped without DATABASE_URL, matching this
 *    repo's `.db.test.js` convention — see tests/lawn-assessment-history.db.test.js):
 *    reproduces the exact bug (ADD CONSTRAINT throws while a mode='customer'
 *    row exists) in an isolated schema, then proves this migration's down()
 *    run FIRST (as it does in a real rollback — newer stamp rolls back
 *    before older) makes the narrower CHECK constraint addable again.
 */

const rollbackMigration = require('../models/migrations/20260924000110_customer_photo_id_mode_rollback');

// ── Always-on: mocked knex ──────────────────────────────────────────────

function makeMockKnex(tables) {
  const updateCalls = [];
  const hasTableCalls = [];
  function tableApi(name) {
    let filter = null;
    return {
      where(cond) { filter = cond; return this; },
      async update(patch) {
        updateCalls.push({ table: name, filter, patch });
        const rows = (tables[name] || []).filter((r) => Object.entries(filter)
          .every(([k, v]) => r[k] === v));
        rows.forEach((r) => Object.assign(r, patch));
        return rows.length;
      },
    };
  }
  const knex = (name) => tableApi(name);
  knex.schema = {
    hasTable: async (name) => {
      hasTableCalls.push(name);
      return Object.prototype.hasOwnProperty.call(tables, name);
    },
  };
  knex.__updateCalls = updateCalls;
  knex.__hasTableCalls = hasTableCalls;
  return knex;
}

describe('customer photo-id mode rollback migration (mocked knex)', () => {
  test('up() is an inert no-op — no knex calls at all', async () => {
    const knex = makeMockKnex({});
    await rollbackMigration.up(knex);
    expect(knex.__updateCalls).toHaveLength(0);
    expect(knex.__hasTableCalls).toHaveLength(0);
  });

  test('down() flips every mode=customer row to internal on both tables, leaving source untouched', async () => {
    const tables = {
      pest_identifications: [
        { id: 'p1', mode: 'customer', source: 'portal' },
        { id: 'p2', mode: 'internal', source: 'tech' },
        { id: 'p3', mode: 'prospect', source: 'public_funnel' },
      ],
      lawn_diagnostics: [
        { id: 'l1', mode: 'customer', source: 'portal' },
        { id: 'l2', mode: 'prospect', source: 'public_funnel' },
      ],
    };
    const knex = makeMockKnex(tables);
    await rollbackMigration.down(knex);

    // Every customer-mode row is remapped, and remains identifiable as a
    // photo-id submission by source='portal' — no information is lost.
    expect(tables.pest_identifications[0]).toEqual({ id: 'p1', mode: 'internal', source: 'portal' });
    expect(tables.lawn_diagnostics[0]).toEqual({ id: 'l1', mode: 'internal', source: 'portal' });

    // No row using the OTHER two modes is touched.
    expect(tables.pest_identifications[1].mode).toBe('internal'); // was already internal — untouched value, not re-written by a broader filter
    expect(tables.pest_identifications[2].mode).toBe('prospect');
    expect(tables.lawn_diagnostics[1].mode).toBe('prospect');

    // Exactly one UPDATE per table, filtered on mode='customer' — never a
    // blanket rewrite of every row.
    expect(knex.__updateCalls).toEqual([
      { table: 'pest_identifications', filter: { mode: 'customer' }, patch: { mode: 'internal' } },
      { table: 'lawn_diagnostics', filter: { mode: 'customer' }, patch: { mode: 'internal' } },
    ]);

    // Post-condition that makes the OLDER migration's down() safe: no row on
    // either table still carries a value outside the narrower CHECK it
    // restores.
    const narrow = new Set(['internal', 'prospect']);
    expect(tables.pest_identifications.every((r) => narrow.has(r.mode))).toBe(true);
    expect(tables.lawn_diagnostics.every((r) => narrow.has(r.mode))).toBe(true);
  });

  test('down() is a no-op when a table does not exist (fresh/partial DB)', async () => {
    const knex = makeMockKnex({ pest_identifications: [{ id: 'p1', mode: 'customer', source: 'portal' }] });
    // lawn_diagnostics absent entirely.
    await expect(rollbackMigration.down(knex)).resolves.not.toThrow();
    expect(knex.__updateCalls).toEqual([
      { table: 'pest_identifications', filter: { mode: 'customer' }, patch: { mode: 'internal' } },
    ]);
  });

  test('down() run twice is idempotent (no row left in mode=customer to re-match)', async () => {
    const tables = { pest_identifications: [{ id: 'p1', mode: 'customer', source: 'portal' }] };
    const knex = makeMockKnex(tables);
    await rollbackMigration.down(knex);
    await rollbackMigration.down(knex);
    expect(tables.pest_identifications[0].mode).toBe('internal');
  });
});

// ── Real PostgreSQL proof (skipped without DATABASE_URL) ────────────────

const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

describeDb('customer photo-id mode rollback — real Postgres constraint proof', () => {
  const { randomUUID } = require('crypto');
  const knexFactory = require('knex');
  const columnsMigration = require('../models/migrations/20260924000100_customer_photo_id_columns');

  // Each table gets its OWN schema/connection/lifecycle — 20260924000100's
  // down() unconditionally processes ALL THREE tables every time it's
  // called (that's the frozen file; see its header), so sharing one schema
  // across both tables would let calling it for 'pest_identifications' also
  // narrow lawn_diagnostics's CHECK as a side effect, corrupting a later
  // assertion about lawn_diagnostics specifically. One schema per table
  // keeps each proof fully independent.
  async function withIsolatedTable(table, run) {
    const schema = `photoid_rollback_${randomUUID().replace(/-/g, '')}`;
    const knex = knexFactory({
      client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 },
    });
    try {
      await knex.raw('CREATE SCHEMA ??', [schema]);
      // Minimal, isolated table carrying only what these two migrations'
      // down() paths touch (mode/source) — the exact post-000100-up() shape,
      // built fresh rather than cloned from `public` so the test is
      // deterministic regardless of whether 000100 has run against the
      // shared dev DB yet.
      await knex.schema.createTable(table, (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.string('mode', 20).notNullable().defaultTo('internal');
        t.string('source', 30).notNullable().defaultTo('tech');
      });
      const constraintName = `${table}_mode_check`;
      await knex.raw(
        "ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (mode IN ('internal', 'prospect', 'customer'))",
        [table, constraintName],
      );
      await run(knex, constraintName);
    } finally {
      await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await knex.destroy();
    }
  }

  test('pest_identifications: this migration\'s down() run first makes the OLD migration\'s down() constraint addable', async () => {
    const table = 'pest_identifications';
    await withIsolatedTable(table, async (knex, constraintName) => {
      const [row] = await knex(table).insert({ mode: 'customer', source: 'portal' }).returning(['id']);

      // Reproduce the exact bug: narrowing the CHECK while a customer-mode
      // row exists throws — this IS what 20260924000100's down() does.
      await expect(knex.raw('ALTER TABLE ?? DROP CONSTRAINT ??', [table, constraintName])).resolves.not.toThrow();
      await expect(knex.raw(
        "ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (mode IN ('internal', 'prospect'))",
        [table, constraintName],
      )).rejects.toThrow();

      // Put the 3-value CHECK back so the table is in the same state
      // 20260924000100's up() would have left it in.
      await knex.raw(
        "ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (mode IN ('internal', 'prospect', 'customer'))",
        [table, constraintName],
      );

      // This migration's down() runs BEFORE 20260924000100's down() in a
      // real rollback (newer stamp rolls back first) — remap first.
      await rollbackMigration.down(knex);
      const after = await knex(table).where({ id: row.id }).first();
      expect(after.mode).toBe('internal');
      expect(after.source).toBe('portal'); // still identifiable as a photo-id submission

      // NOW the older migration's own down() succeeds — its EXACT code,
      // unconditionally processing lawn_diagnostics / tree_shrub_assessments
      // too (both absent from this isolated schema, so those branches no-op
      // via their own hasTable guards).
      await expect(columnsMigration.down(knex)).resolves.not.toThrow();
      const finalRow = await knex(table).where({ id: row.id }).first();
      expect(finalRow.mode).toBe('internal');
    });
  });

  test('lawn_diagnostics: this migration\'s down() run first makes the OLD migration\'s down() constraint addable', async () => {
    const table = 'lawn_diagnostics';
    await withIsolatedTable(table, async (knex, constraintName) => {
      const [row] = await knex(table).insert({ mode: 'customer', source: 'portal' }).returning(['id']);

      await expect(knex.raw('ALTER TABLE ?? DROP CONSTRAINT ??', [table, constraintName])).resolves.not.toThrow();
      await expect(knex.raw(
        "ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (mode IN ('internal', 'prospect'))",
        [table, constraintName],
      )).rejects.toThrow();

      await knex.raw(
        "ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (mode IN ('internal', 'prospect', 'customer'))",
        [table, constraintName],
      );

      await rollbackMigration.down(knex);
      const after = await knex(table).where({ id: row.id }).first();
      expect(after.mode).toBe('internal');
      expect(after.source).toBe('portal');

      await expect(columnsMigration.down(knex)).resolves.not.toThrow();
      const finalRow = await knex(table).where({ id: row.id }).first();
      expect(finalRow.mode).toBe('internal');
    });
  });
});
