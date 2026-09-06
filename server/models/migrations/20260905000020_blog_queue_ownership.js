// Durable queue ownership survives stale-claim recovery; legacy rows stay unknown.
exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('opportunity_queue')) return;
  if (!await knex.schema.hasColumn('opportunity_queue', 'claim_id')) {
    await knex.schema.alterTable('opportunity_queue', (t) => t.uuid('claim_id').nullable());
  }
  if (!await knex.schema.hasTable('autonomous_runs')) return;
  if (!await knex.schema.hasColumn('autonomous_runs', 'queue_claim_id')) {
    await knex.schema.alterTable('autonomous_runs', (t) => t.uuid('queue_claim_id').nullable());
  }
  if (!await knex.schema.hasColumn('autonomous_runs', 'astro_pr_retired_at')) {
    await knex.schema.alterTable('autonomous_runs', (t) => t.timestamp('astro_pr_retired_at', { useTz: true }).nullable());
  }
};

exports.down = async function down(knex) {
  if (!await knex.schema.hasTable('opportunity_queue')) return;
  if (await knex.schema.hasColumn('opportunity_queue', 'claim_id')) {
    await knex.schema.alterTable('opportunity_queue', (t) => t.dropColumn('claim_id'));
  }
  if (!await knex.schema.hasTable('autonomous_runs')) return;
  for (const column of ['queue_claim_id', 'astro_pr_retired_at']) {
    if (await knex.schema.hasColumn('autonomous_runs', column)) {
      await knex.schema.alterTable('autonomous_runs', (t) => t.dropColumn(column));
    }
  }
};
