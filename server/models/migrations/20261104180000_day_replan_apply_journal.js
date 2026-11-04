/**
 * day_replan_plans: the apply writer's durable journal (owner ruling 2026-11-03, PR 2 of 3).
 *
 * The rebooker commits each visit's move in its own transaction, so a day with a swap or a cycle passes through a
 * temporary hour. If the process stops part way, the journal is what lets the next run put the day back:
 *   apply_started_at  set just before the first write of a day; a plan with this set and apply_status NULL was
 *                     interrupted (the next run finds it first, rolls it back, and raises one notice for Claude)
 *   apply_steps       jsonb: { version, steps: [{ id, fromStart, toStart, widthMin, temp, state: 'intent' | 'done' }],
 *                     routeBefore: { <visit id>: route_order | null }, routePersisted, complete }
 *                     visit ids and minutes only; no names, addresses or phone numbers
 * Additive and nullable; shadow rows leave both null. Earlier day_replan_plans migrations are frozen and untouched.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('day_replan_plans', (t) => {
    t.timestamp('apply_started_at', { useTz: true }).nullable();
    t.jsonb('apply_steps').nullable();
  });
  // The recovery pass reads only interrupted plans.
  await knex.raw('CREATE INDEX day_replan_plans_interrupted_idx ON day_replan_plans (apply_started_at) WHERE apply_started_at IS NOT NULL AND apply_status IS NULL');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS day_replan_plans_interrupted_idx');
  await knex.schema.alterTable('day_replan_plans', (t) => {
    t.dropColumn('apply_steps');
    t.dropColumn('apply_started_at');
  });
};
