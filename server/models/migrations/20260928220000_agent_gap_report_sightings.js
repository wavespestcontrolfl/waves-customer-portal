'use strict';

/**
 * One row per time the Intelligence Bar hit a gap report
 * (20260928160000_agent_gap_reports.js), so "how often in the last N days"
 * is a count over a window, not the gap's lifetime `occurrences` total. The
 * recorder (server/services/agent-gap-reports.js) writes the gap upsert and
 * its sighting in one transaction.
 *
 * Existing gaps get one sighting at their last_seen_at, so a gap recorded
 * before this table existed still appears in a window that covers it. The
 * gaps table only ever held rows on PR preview databases before this ran.
 */
const TABLE = 'agent_gap_report_sightings';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.bigIncrements('id').primary();
    t.bigInteger('gap_id').notNullable().references('id').inTable('agent_gap_reports').onDelete('CASCADE');
    t.timestamp('seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['seen_at', 'gap_id'], 'agent_gap_report_sightings_seen_at_gap_idx');
  });
  await knex.raw(`INSERT INTO ${TABLE} (gap_id, seen_at) SELECT id, last_seen_at FROM agent_gap_reports`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
