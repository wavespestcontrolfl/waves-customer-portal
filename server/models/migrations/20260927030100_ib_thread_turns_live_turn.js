/**
 * ib_thread_turns.live_turn replaces 20260927030000's `seeded` flag, which
 * trusted every row by default: rows written before that migration, and
 * rows an old process wrote during rollout, all read as live. live_turn is
 * the opposite default. Only a turn appendExchange writes as part of a live
 * exchange is marked true; seed rows, older rows and anything written by
 * code that doesn't set it stay false, and the Intelligence Bar's recent
 * operator-turn grounding (recentOperatorTurns) reads live turns only.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ib_thread_turns'))) return;
  if (!(await knex.schema.hasColumn('ib_thread_turns', 'live_turn'))) {
    await knex.schema.alterTable('ib_thread_turns', (t) => {
      t.boolean('live_turn').notNullable().defaultTo(false);
    });
  }
  if (await knex.schema.hasColumn('ib_thread_turns', 'seeded')) {
    await knex.schema.alterTable('ib_thread_turns', (t) => {
      t.dropColumn('seeded');
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('ib_thread_turns'))) return;
  if (!(await knex.schema.hasColumn('ib_thread_turns', 'seeded'))) {
    await knex.schema.alterTable('ib_thread_turns', (t) => {
      t.boolean('seeded').notNullable().defaultTo(false);
    });
  }
  if (await knex.schema.hasColumn('ib_thread_turns', 'live_turn')) {
    await knex.schema.alterTable('ib_thread_turns', (t) => {
      t.dropColumn('live_turn');
    });
  }
};
