'use strict';

/**
 * roof_entry_reads.context_key (GATE_ROOF_ENTRY_READ, owner 2026-11-19). The copy index of the previous migration keyed
 * on the estimate_id / customer_id foreign keys, but ON DELETE SET NULL rewrites those after the fact: deleting estimate A
 * turned the copy (A, C) into (null, C) and collided with an existing (null, C) copy, so Postgres refused the delete.
 *   context_key  lower(estimate_id or '') + '|' + lower(customer_id or ''), at most 73 characters. Written ONCE, at insert,
 *                on every row (paid, claim and copy) by services/roof-entry-read.js and never updated, so deleting an
 *                estimate or customer cannot change it. Cache matching and copy dedupe use it, never the nullable keys.
 * The one-copy-per-context index moves to (source_id, context_key) WHERE source_id IS NOT NULL. Rows that already exist are
 * back-filled from their keys as they stand. Additive and idempotent. The down restores the previous index exactly as the
 * previous migration created it (it can fail if foreign keys were since nulled into a collision; the up never can).
 */
const OLD_COPY_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_copy_context ON roof_entry_reads (source_id, COALESCE(estimate_id::text, ''), COALESCE(customer_id::text, '')) WHERE source_id IS NOT NULL";

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('roof_entry_reads', 'context_key'))) {
    await knex.schema.alterTable('roof_entry_reads', (t) => {
      t.string('context_key', 80).nullable();
    });
  }
  await knex.raw("UPDATE roof_entry_reads SET context_key = lower(COALESCE(estimate_id::text, '')) || '|' || lower(COALESCE(customer_id::text, '')) WHERE context_key IS NULL");
  await knex.raw('DROP INDEX IF EXISTS idx_roof_entry_reads_copy_context');
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_copy_ctx_key ON roof_entry_reads (source_id, context_key) WHERE source_id IS NOT NULL');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_roof_entry_reads_copy_ctx_key');
  await knex.raw(OLD_COPY_INDEX);
  if (await knex.schema.hasColumn('roof_entry_reads', 'context_key')) {
    await knex.schema.alterTable('roof_entry_reads', (t) => { t.dropColumn('context_key'); });
  }
};
