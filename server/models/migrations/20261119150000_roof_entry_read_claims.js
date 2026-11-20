'use strict';

/**
 * roof_entry_reads claim columns (GATE_ROOF_ENTRY_READ, owner 2026-11-19). A read now CLAIMS its crop with a pending row
 * before the slow image fetch and paid model call, so no database connection or lock is held while they run, and the
 * paid result is written to that row by id (a deleted estimate or customer only nulls its reference, never the row).
 *   status      'pending' (claimed, call in flight) | 'done' (a finished read, the default so every earlier row stays
 *               reusable) | 'failed' (the call was billed but unusable, or the claim went stale). Only 'done' rows
 *               are ever reused.
 *   claimed_at  when the claim was taken. A pending claim older than 5 minutes is stale and is taken over.
 * The partial unique index allows ONE pending claim per crop (lookup_key), which is what makes two requests, on one
 * server or two, unable to both start a paid call for the same roof. Additive and idempotent (hasColumn guards both ways).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('roof_entry_reads', 'status'))) {
    await knex.schema.alterTable('roof_entry_reads', (t) => {
      t.string('status', 16).notNullable().defaultTo('done');
      t.timestamp('claimed_at', { useTz: true }).nullable();
    });
  }
  await knex.raw("CREATE UNIQUE INDEX IF NOT EXISTS idx_roof_entry_reads_pending_key ON roof_entry_reads (lookup_key) WHERE status = 'pending'");
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_roof_entry_reads_pending_key');
  if (await knex.schema.hasColumn('roof_entry_reads', 'status')) {
    await knex.schema.alterTable('roof_entry_reads', (t) => {
      t.dropColumn('status');
      t.dropColumn('claimed_at');
    });
  }
};
