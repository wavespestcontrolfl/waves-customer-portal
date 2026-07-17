/**
 * ad_budget_log op provenance — two columns the budget-write recovery path
 * needs to reason about concurrent writers:
 *
 *  - op_id: stamps every audit row with its originating operation's UUID.
 *    After a lost COMMIT acknowledgement, the compensating-rollback path
 *    finds the row and can tell "our own write actually committed" (return
 *    success, change durable) from "a genuinely newer writer committed"
 *    (defer to it) — without it, an operation's own committed row reads as
 *    a superseding writer and a durable apply gets reported as failed.
 *  - google_ads_updated: whether the writer's live Google push succeeded.
 *    Supersession must be conditioned on PROOF the newer writer changed
 *    Google — a best-effort manual write that only recorded local intent
 *    (push refused/unconfigured) must not suppress the compensating
 *    rollback that restores the live budget.
 *
 * Both nullable: legacy rows predate the provenance and are treated as
 * "unknown" (never proof of a live change, never matched as own-op).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ad_budget_log'))) return;
  if (!(await knex.schema.hasColumn('ad_budget_log', 'op_id'))) {
    await knex.schema.alterTable('ad_budget_log', (t) => {
      t.uuid('op_id').index();
    });
  }
  if (!(await knex.schema.hasColumn('ad_budget_log', 'google_ads_updated'))) {
    await knex.schema.alterTable('ad_budget_log', (t) => {
      t.boolean('google_ads_updated');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('ad_budget_log'))) return;
  if (await knex.schema.hasColumn('ad_budget_log', 'google_ads_updated')) {
    await knex.schema.alterTable('ad_budget_log', (t) => {
      t.dropColumn('google_ads_updated');
    });
  }
  if (await knex.schema.hasColumn('ad_budget_log', 'op_id')) {
    await knex.schema.alterTable('ad_budget_log', (t) => {
      t.dropColumn('op_id');
    });
  }
};
