'use strict';

/**
 * roof_entry_reads claim and copy columns (GATE_ROOF_ENTRY_READ, owner 2026-11-19). A read CLAIMS its crop with a pending
 * row before the slow image fetch and paid model call, so no database connection or lock is held while they run, and the
 * paid result is written to that row by id (a deleted estimate or customer only nulls its reference, never the row).
 *   status      'pending' (claimed, call in flight) | 'done' (a finished read, the default so every earlier row stays
 *               reusable) | 'failed' (the call was billed but unusable, or the claim went stale). Only 'done' rows
 *               are ever reused.
 *   claimed_at  when the claim was taken. A pending claim older than 5 minutes is stale and is taken over.
 *   source_id   set ONLY on a copy: a reuse for a different estimate or customer inserts a cost-0 copy of the paid read
 *               that names it here. Paid rows and claims never have a source_id. Null-on-delete.
 * Two unique partial indexes carry the guarantees:
 *   idx_roof_entry_reads_pending_key   one pending claim per crop (lookup_key), so two requests, on one server or two,
 *                                      cannot both start a paid call for the same roof;
 *   idx_roof_entry_reads_copy_context  one copy per (source_id, estimate, customer), so two cache hits for the same new
 *                                      context cannot write two copies. The predicate is source_id IS NOT NULL, which no
 *                                      paid row or claim can satisfy; null estimate/customer count as one value.
 * Additive and idempotent (hasColumn and IF NOT EXISTS guard both ways).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('roof_entry_reads', 'status'))) {
    await knex.schema.alterTable('roof_entry_reads', (t) => {
      t.string('status', 16).notNullable().defaultTo('done');
      t.timestamp('claimed_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('roof_entry_reads', 'source_id'))) {
    await knex.schema.alterTable('roof_entry_reads', (t) => {
      t.uuid('source_id').nullable().references('id').inTable('roof_entry_reads').onDelete('SET NULL');
    });
  }
  await knex.raw("CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_pending_key ON roof_entry_reads (lookup_key) WHERE status = 'pending'");
  await knex.raw("CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_copy_context ON roof_entry_reads (source_id, COALESCE(estimate_id::text, ''), COALESCE(customer_id::text, '')) WHERE source_id IS NOT NULL");
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_roof_entry_reads_copy_context');
  await knex.raw('DROP INDEX IF EXISTS idx_roof_entry_reads_pending_key');
  if (await knex.schema.hasColumn('roof_entry_reads', 'source_id')) {
    await knex.schema.alterTable('roof_entry_reads', (t) => { t.dropColumn('source_id'); });
  }
  if (await knex.schema.hasColumn('roof_entry_reads', 'status')) {
    await knex.schema.alterTable('roof_entry_reads', (t) => {
      t.dropColumn('status');
      t.dropColumn('claimed_at');
    });
  }
};
