/**
 * ib_thread_turns.seeded: true for the turns a new thread is seeded with
 * from the client's existing history (IbThreads.appendExchange). Those rows
 * get the current time as created_at, not their real age, so the
 * Intelligence Bar's recent-operator-turn grounding (recentOperatorTurns)
 * skips them rather than treating hours-old context as recent.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ib_thread_turns'))) return;
  if (await knex.schema.hasColumn('ib_thread_turns', 'seeded')) return;
  await knex.schema.alterTable('ib_thread_turns', (t) => {
    t.boolean('seeded').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('ib_thread_turns'))) return;
  if (!(await knex.schema.hasColumn('ib_thread_turns', 'seeded'))) return;
  await knex.schema.alterTable('ib_thread_turns', (t) => {
    t.dropColumn('seeded');
  });
};
