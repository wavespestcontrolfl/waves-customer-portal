/**
 * Per-call outcome log for the cross-provider LLM dispatcher
 * (services/llm/call.js dispatchWithFallback). One row per completed
 * chain: which policy ran, which provider answered, whether the fallback
 * leg was used, and the failure reasons when no provider answered.
 * Consumed by the daily exception digest (services/llm-dispatch-metrics.js);
 * rows are pruned after its retention window, so the table stays small.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('llm_dispatch_log');
  if (hasTable) return;
  await knex.schema.createTable('llm_dispatch_log', (table) => {
    table.increments('id').primary();
    table.string('policy', 120).notNullable();
    table.boolean('ok').notNullable();
    table.string('provider', 40);
    table.string('model', 120);
    table.boolean('fallback_used').notNullable().defaultTo(false);
    table.jsonb('failure_reasons');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['created_at'], 'llm_dispatch_log_created_at_idx');
    table.index(['policy', 'created_at'], 'llm_dispatch_log_policy_created_at_idx');
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('llm_dispatch_log');
  if (!hasTable) return;
  await knex.schema.dropTable('llm_dispatch_log');
};
