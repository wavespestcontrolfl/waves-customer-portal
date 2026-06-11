/**
 * Per-source yield tracking for newsletter event ingestion.
 *
 * A source whose pull fetches and parses fine but produces 0 events run
 * after run (selector rot, bot wall, empty feed) is indistinguishable
 * from a healthy one — last_pull_status stays 'success' with zero
 * consecutive_failures. 15 of 25 enabled sources had NEVER produced a
 * single event while showing green, which silently starved the weekly
 * digest. These columns let ingestion count empty-but-successful pulls
 * so event-source-health.js can escalate them.
 *
 *   consecutive_zero_yields — successful pulls in a row that upserted 0
 *     events; reset on any pull that yields, untouched on hard failures
 *     (those are tracked by consecutive_failures).
 *   last_yield_count        — events upserted by the most recent
 *     successful pull.
 *   last_nonzero_yield_at   — when this source last produced anything.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('event_sources');
  if (!hasTable) return;
  if (!(await knex.schema.hasColumn('event_sources', 'consecutive_zero_yields'))) {
    await knex.schema.alterTable('event_sources', (t) => {
      t.integer('consecutive_zero_yields').notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasColumn('event_sources', 'last_yield_count'))) {
    await knex.schema.alterTable('event_sources', (t) => {
      t.integer('last_yield_count').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('event_sources', 'last_nonzero_yield_at'))) {
    await knex.schema.alterTable('event_sources', (t) => {
      t.timestamp('last_nonzero_yield_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('event_sources');
  if (!hasTable) return;
  for (const col of ['last_nonzero_yield_at', 'last_yield_count', 'consecutive_zero_yields']) {
    if (await knex.schema.hasColumn('event_sources', col)) {
      await knex.schema.alterTable('event_sources', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
