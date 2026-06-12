/**
 * opportunity_queue.available_at — claim-availability gate for seeded rows.
 *
 * Operator-seeded opportunities (intercept-brief-seeder) can carry a future
 * publish window ("don't draft this before 2026-07-01"). NULL = available
 * immediately (every existing miner row keeps its current behavior).
 * claimNext()/peek() in opportunity-queue.js filter on
 * (available_at IS NULL OR available_at <= now()) so a future-dated row is
 * invisible to the runner until its window opens — no cron hook needed, the
 * row simply becomes claimable when the date passes.
 *
 * expires_at for seeded rows is set relative to available_at so the
 * expireStale janitor can't expire a row before it ever became claimable.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('opportunity_queue');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('opportunity_queue', 'available_at');
  if (!hasColumn) {
    await knex.schema.alterTable('opportunity_queue', (t) => {
      t.timestamp('available_at').nullable();
    });
  }
  // Partial index: only future-gated rows are indexed — the common case
  // (available_at IS NULL) costs nothing.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_opportunity_queue_available_at
    ON opportunity_queue (available_at)
    WHERE available_at IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('opportunity_queue');
  if (!hasTable) return;
  if (await knex.schema.hasColumn('opportunity_queue', 'available_at')) {
    await knex.raw('DROP INDEX IF EXISTS idx_opportunity_queue_available_at');
    await knex.schema.alterTable('opportunity_queue', (t) => {
      t.dropColumn('available_at');
    });
  }
};
