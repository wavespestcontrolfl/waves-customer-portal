/**
 * series_moves.effects_attempted_at — when the effects reconciler last
 * picked the operation up. The reconciler orders its fixed batch by
 * COALESCE(effects_attempted_at, created_at), so a class of operations that
 * keeps failing retryably (a destination number Twilio keeps 5xx-ing)
 * rotates to the back instead of monopolizing the oldest-25 window and
 * starving every newer operation's reminder sync / conflict card.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('series_moves'))) return;
  if (!(await knex.schema.hasColumn('series_moves', 'effects_attempted_at'))) {
    await knex.schema.alterTable('series_moves', (t) => {
      t.timestamp('effects_attempted_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('series_moves'))) return;
  if (await knex.schema.hasColumn('series_moves', 'effects_attempted_at')) {
    await knex.schema.alterTable('series_moves', (t) => {
      t.dropColumn('effects_attempted_at');
    });
  }
};
