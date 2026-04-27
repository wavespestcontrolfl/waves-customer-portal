/**
 * Track per-row normalization state on events_raw. The normalizer
 * service (server/services/event-normalizer.js, P3b leg 3) runs
 * Claude over rows where normalized_at IS NULL, fills any missing
 * venue_name / venue_address, and geocodes lat/lng. Setting
 * normalized_at on completion is what stops it re-running over the
 * same row every cron — operator can clear it to force re-extraction.
 *
 * Index supports the daily cron's "WHERE normalized_at IS NULL" pull.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('events_raw', (table) => {
    table.timestamp('normalized_at').nullable();
    table.index(['normalized_at'], 'idx_events_raw_normalized_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('events_raw', (table) => {
    table.dropIndex(['normalized_at'], 'idx_events_raw_normalized_at');
    table.dropColumn('normalized_at');
  });
};
