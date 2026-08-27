/**
 * autonomous_runs.topic_targeting_result — persisted verdict of the pre-draft
 * topic-targeting gate (geo scope + entity ownership, owner rulings
 * 2026-08-27). Same jsonb-per-gate pattern as facts_sufficiency /
 * protected_check so the review UI and audits can see WHY a run skipped
 * before any writer spend.
 */
exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('autonomous_runs', 'topic_targeting_result');
  if (!has) {
    await knex.schema.alterTable('autonomous_runs', (t) => {
      t.jsonb('topic_targeting_result').nullable();
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('autonomous_runs', 'topic_targeting_result');
  if (has) {
    await knex.schema.alterTable('autonomous_runs', (t) => {
      t.dropColumn('topic_targeting_result');
    });
  }
};
