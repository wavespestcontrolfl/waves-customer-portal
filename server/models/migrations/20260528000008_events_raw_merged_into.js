/**
 * Add merged_into to events_raw for cross-source duplicate handling.
 *
 * Ingest only dedupes on (source_id, external_id), so the same real-world
 * event scraped from two different sources lands as two rows and clutters
 * the approval queue. The admin "merge duplicates" action marks the losing
 * rows admin_status='rejected' (which already excludes them from the queue
 * and the digest) and records merged_into = the surviving event's id, so the
 * merge is auditable and reversible.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('events_raw', (table) => {
    // Self-reference (no hard FK — a merged row should survive even if the
    // primary is later deleted; the pointer is provenance, not a constraint).
    table.uuid('merged_into').nullable();
    table.index(['merged_into'], 'idx_events_raw_merged_into');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('events_raw', (table) => {
    table.dropIndex(['merged_into'], 'idx_events_raw_merged_into');
    table.dropColumn('merged_into');
  });
};
