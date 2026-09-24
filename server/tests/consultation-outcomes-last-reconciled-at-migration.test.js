/**
 * 20260924000005_consultation_outcomes_last_reconciled_at — round 12 (P1
 * :755) fairness fix: adds a nullable last_reconciled_at timestamp column +
 * index to consultation_outcomes, mirroring
 * 20260911000020_outbox_messages_last_scanned_at.js's exact shape (see that
 * migration's own comment for the starvation bug class this fixes, codex
 * #4293, one sweep table over).
 *
 * A fresh, minimal fake-knex — not the shared one in
 * consultation-outcomes-migration.test.js, which never models
 * schema.alterTable (this migration's only schema call, unlike 0010's
 * createTable) — with just enough of knex's schema-builder/raw-SQL surface
 * to prove: the column is added once (nullable), the index is created,
 * both directions are idempotent, and down() removes both cleanly. No live
 * Postgres was available in this sandbox, the same constraint every other
 * migration test in this repo notes.
 */

const migration = require('../models/migrations/20260924000005_consultation_outcomes_last_reconciled_at');

const INDEX_NAME = 'consultation_outcomes_last_reconciled_at_index';

function makeFakeKnex() {
  const columns = {}; // table -> { colName -> { calls: [{ method, args }] } }
  const indexes = new Set();
  const rawCalls = [];

  const knex = {};
  knex.raw = (sql) => {
    const trimmed = String(sql).replace(/\s+/g, ' ').trim();
    rawCalls.push(trimmed);
    const createMatch = trimmed.match(/^CREATE INDEX IF NOT EXISTS (\w+) ON (\w+) \((\w+)\)$/i);
    if (createMatch) {
      indexes.add(createMatch[1]);
      return trimmed;
    }
    const dropMatch = trimmed.match(/^DROP INDEX IF EXISTS (\w+)$/i);
    if (dropMatch) {
      indexes.delete(dropMatch[1]);
      return trimmed;
    }
    return trimmed;
  };
  knex.schema = {
    hasColumn: async (table, col) => !!(columns[table] && columns[table][col]),
    alterTable: async (table, cb) => {
      columns[table] = columns[table] || {};
      const t = {
        timestamp: (name) => {
          const rec = { name, calls: [] };
          columns[table][name] = rec;
          const builder = {};
          ['nullable', 'notNullable', 'defaultTo'].forEach((m) => {
            builder[m] = (...args) => { rec.calls.push({ method: m, args }); return builder; };
          });
          return builder;
        },
        dropColumn: (name) => { delete columns[table][name]; },
      };
      cb(t);
    },
  };
  return {
    knex, columns, indexes, rawCalls,
  };
}

describe('20260924000005_consultation_outcomes_last_reconciled_at', () => {
  test('up() adds a nullable last_reconciled_at column and creates the fairness-ordering index', async () => {
    const { knex, columns, indexes } = makeFakeKnex();
    await migration.up(knex);

    const col = columns.consultation_outcomes.last_reconciled_at;
    expect(col).toBeDefined();
    expect(col.calls.some((c) => c.method === 'nullable')).toBe(true);
    expect(indexes.has(INDEX_NAME)).toBe(true);
  });

  test('up() is idempotent — does not re-add the column when it already exists, but still ensures the index (CREATE INDEX IF NOT EXISTS)', async () => {
    const {
      knex, columns, indexes, rawCalls,
    } = makeFakeKnex();
    // Simulate an already-applied column (a prior run of this migration).
    columns.consultation_outcomes = { last_reconciled_at: { name: 'last_reconciled_at', calls: [] } };

    await migration.up(knex);

    expect(rawCalls).toEqual([`CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON consultation_outcomes (last_reconciled_at)`]);
    expect(indexes.has(INDEX_NAME)).toBe(true);
  });

  test('down() drops the index then the column', async () => {
    const { knex, columns, indexes } = makeFakeKnex();
    await migration.up(knex);

    await migration.down(knex);

    expect(indexes.has(INDEX_NAME)).toBe(false);
    expect(columns.consultation_outcomes.last_reconciled_at).toBeUndefined();
  });

  test('down() is idempotent — a re-run (or a column/index that never existed) does not throw', async () => {
    const { knex } = makeFakeKnex();
    await expect(migration.down(knex)).resolves.not.toThrow();
    await migration.up(knex);
    await migration.down(knex);
    await expect(migration.down(knex)).resolves.not.toThrow();
  });
});
