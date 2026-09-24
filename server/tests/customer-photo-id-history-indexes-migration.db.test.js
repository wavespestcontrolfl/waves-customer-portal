/**
 * 20260924000120_customer_photo_id_history_indexes.js — (customer_id, mode,
 * created_at) indexes for photo-id.js's history reads. Real-Postgres check
 * (DATABASE_URL-gated, same convention as tests/lawn-assessment-history.db.test.js):
 * up() creates the index on an isolated table shaped like the real ones,
 * is idempotent on a second run, and down() removes it cleanly.
 */

const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

describeDb('customer photo-id history indexes migration (real Postgres)', () => {
  const { randomUUID } = require('crypto');
  const knexFactory = require('knex');
  const migration = require('../models/migrations/20260924000120_customer_photo_id_history_indexes');

  let knex;
  let schema;

  beforeAll(async () => {
    schema = `photoid_idx_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({
      client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 },
    });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['pest_identifications', 'lawn_diagnostics', 'tree_shrub_assessments']) {
       
      await knex.schema.createTable(table, (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.uuid('customer_id').nullable();
        t.string('mode', 20).notNullable().defaultTo('internal');
        t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      });
    }
  });

  afterAll(async () => {
    if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); }
  });

  test('up() creates all three indexes, idempotently, and down() removes them', async () => {
    await migration.up(knex);
    for (const indexName of [
      'pest_identifications_customer_mode_created_idx',
      'lawn_diagnostics_customer_mode_created_idx',
      'tree_shrub_assessments_customer_mode_created_idx',
    ]) {
       
      const found = await knex.raw(
        'SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?',
        [indexName],
      );
      expect(found.rows).toHaveLength(1);
    }

    // Re-running up() must not throw (idempotent — hasIndex-style guard).
    await expect(migration.up(knex)).resolves.not.toThrow();

    await migration.down(knex);
    const afterDown = await knex.raw(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE '%_customer_mode_created_idx'",
    );
    expect(afterDown.rows).toHaveLength(0);

    // down() twice must not throw either (DROP INDEX IF EXISTS).
    await expect(migration.down(knex)).resolves.not.toThrow();
  });

  test('the index is structurally usable for the history query (customer_id + mode, ordered by created_at)', async () => {
    // A handful of test rows never outweighs a seq scan on real cost
    // estimates — enable_seqscan=off (scoped to this transaction only)
    // forces the planner to reach for an index if one FITS the query,
    // proving the index shape is correct without needing production-scale
    // data to make the planner choose it naturally.
    await migration.up(knex);
    const customerId = randomUUID();
    await knex('pest_identifications').insert([
      { customer_id: customerId, mode: 'customer' },
      { customer_id: customerId, mode: 'internal' },
      { customer_id: randomUUID(), mode: 'customer' },
    ]);
    await knex.transaction(async (trx) => {
      await trx.raw('SET LOCAL enable_seqscan = off');
      const plan = await trx.raw(
        "EXPLAIN SELECT * FROM pest_identifications WHERE customer_id = ? AND mode = 'customer' ORDER BY created_at DESC LIMIT 20",
        [customerId],
      );
      const planText = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(planText).toContain('pest_identifications_customer_mode_created_idx');
    });
  });
});
