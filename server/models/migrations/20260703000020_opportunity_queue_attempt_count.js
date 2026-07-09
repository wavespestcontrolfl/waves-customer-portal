/**
 * Lifetime claim budget for opportunity_queue rows (blog-engine audit,
 * queue/state lane).
 *
 * Every claimNext() increments attempt_count; rows at/over the budget
 * (AUTONOMOUS_OPP_MAX_ATTEMPTS, default 5) are refused by claimNext and
 * swept to skipped/attempts_exhausted by the daily janitor. Without this a
 * permanently failing top-scored row bounced back to 'pending' (release /
 * stale-claim recovery) and burned one LLM dispatch every single day with
 * no exit. An operator requeue resets the counter.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('opportunity_queue', 'attempt_count');
  if (has) return;
  await knex.schema.alterTable('opportunity_queue', (t) => {
    t.integer('attempt_count').notNullable().defaultTo(0);
  });
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('opportunity_queue', 'attempt_count');
  if (!has) return;
  await knex.schema.alterTable('opportunity_queue', (t) => {
    t.dropColumn('attempt_count');
  });
};
