/**
 * Adds archived_at to estimates so closed rows (declined / expired /
 * accepted) can be tucked out of the default pipeline view without
 * deleting them. Matches the invoices archive pattern from #130:
 * partial index on archived rows only so the default list query
 * (WHERE archived_at IS NULL) stays off the index and writes on the
 * common path don't pay index cost.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.timestamp('archived_at');
  });
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_estimates_archived_at ON estimates (archived_at) WHERE archived_at IS NOT NULL`
  );
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_estimates_archived_at`);
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('archived_at');
  });
};
