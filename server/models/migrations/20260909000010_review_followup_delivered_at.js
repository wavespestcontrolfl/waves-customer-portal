// followup_sent_at also records suppression/internal handling. Keep actual
// customer delivery separate so suppression never starts the 72-hour floor.
exports.up = async function up(knex) {
  await knex.schema.alterTable('review_requests', table => {
    table.timestamp('followup_delivered_at', { useTz: true }).nullable();
    table.timestamp('followup_next_attempt_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('review_requests', table => {
    table.dropColumn('followup_delivered_at');
    table.dropColumn('followup_next_attempt_at');
  });
};
