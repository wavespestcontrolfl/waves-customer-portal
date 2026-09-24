/**
 * Indexes for server/routes/photo-id.js's GET / and GET /:type/:id history
 * reads (codex GH r1 P2 on PR #4752): `.where({ customer_id, mode:
 * 'customer' }).orderBy('created_at', 'desc').limit(20)` against
 * pest_identifications, lawn_diagnostics, and tree_shrub_assessments.
 *
 * None of the three tables had an index leading with `customer_id` before
 * this migration — pest_identifications and lawn_diagnostics only index
 * (mode, status) / (source, created_at) / lead_id (their prospect-funnel
 * access patterns), and tree_shrub_assessments indexes (customer_id,
 * service_date) — a different column, not created_at, and without mode. As
 * public/customer submissions accumulate, every portal history load would
 * otherwise scan and sort the full table.
 *
 * A NEW migration rather than editing any of the three tables' own
 * (already-pushed and frozen) migration files.
 */

async function addIndexIfMissing(knex, table, columns, indexName) {
  if (!(await knex.schema.hasTable(table))) return;
  const exists = await knex.raw(
    'SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ? AND indexname = ?',
    [table, indexName],
  );
  if (exists.rows.length) return;
  await knex.schema.alterTable(table, (t) => {
    t.index(columns, indexName);
  });
}

async function dropIndexIfExists(knex, table, indexName) {
  if (!(await knex.schema.hasTable(table))) return;
  await knex.raw('DROP INDEX IF EXISTS ??', [indexName]);
}

const INDEXES = [
  ['pest_identifications', ['customer_id', 'mode', 'created_at'], 'pest_identifications_customer_mode_created_idx'],
  ['lawn_diagnostics', ['customer_id', 'mode', 'created_at'], 'lawn_diagnostics_customer_mode_created_idx'],
  ['tree_shrub_assessments', ['customer_id', 'mode', 'created_at'], 'tree_shrub_assessments_customer_mode_created_idx'],
];

exports.up = async function up(knex) {
  for (const [table, columns, indexName] of INDEXES) {
     
    await addIndexIfMissing(knex, table, columns, indexName);
  }
};

exports.down = async function down(knex) {
  for (const [table, , indexName] of INDEXES) {
     
    await dropIndexIfExists(knex, table, indexName);
  }
};
