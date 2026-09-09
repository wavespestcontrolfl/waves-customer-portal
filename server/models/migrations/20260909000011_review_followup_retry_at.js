// Held follow-ups must leave the limited due batch until retry eligibility.
exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('review_requests')) return;
  if (!await knex.schema.hasColumn('review_requests', 'followup_next_attempt_at')) {
    await knex.schema.alterTable('review_requests', table => {
      table.timestamp('followup_next_attempt_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!await knex.schema.hasTable('review_requests')) return;
  if (await knex.schema.hasColumn('review_requests', 'followup_next_attempt_at')) {
    await knex.schema.alterTable('review_requests', table => {
      table.dropColumn('followup_next_attempt_at');
    });
  }
};
