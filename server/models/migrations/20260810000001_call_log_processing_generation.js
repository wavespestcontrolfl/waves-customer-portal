/**
 * call_log.processing_generation — a per-call MONOTONIC pass counter.
 *
 * The processor's claim write bumps it by 1 every time a pass acquires the
 * call (normal, retry, or force-reprocess). Artifacts a pass produces
 * (draft blobs, call-side verdict markers) record the generation that wrote
 * them, and ownership fences compare generations instead of interpreting a
 * cleared processing_token: a NULL token cannot distinguish "my own pass
 * finalized normally" (safe to keep writing — the estimator composes
 * detached after finalization) from "a NEWER pass claimed and finalized
 * since" (my writes are stale and must be refused). The token keeps its
 * claim-mutex role; the generation answers WHICH pass is current
 * (PR #3304 — replaces the oscillating token-NULL predicates, same
 * monotonic-integer doctrine as leads.lead_stamp_seq from #3293).
 *
 * ADD COLUMN with a non-null default is metadata-only on PostgreSQL 11+ —
 * no table rewrite on the large call_log table.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (!(await knex.schema.hasColumn('call_log', 'processing_generation'))) {
    await knex.schema.alterTable('call_log', (table) => {
      table.integer('processing_generation').notNullable().defaultTo(0);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  if (await knex.schema.hasColumn('call_log', 'processing_generation')) {
    await knex.schema.alterTable('call_log', (table) => {
      table.dropColumn('processing_generation');
    });
  }
};
