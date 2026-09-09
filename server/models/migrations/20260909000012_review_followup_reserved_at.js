// Keep an unresolved provider attempt visible to spacing without claiming delivery.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('review_requests', 'followup_reserved_at'))) {
    await knex.schema.alterTable('review_requests', table => {
      table.timestamp('followup_reserved_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('review_requests', 'followup_reserved_at')) {
    await knex.schema.alterTable('review_requests', table => { table.dropColumn('followup_reserved_at'); });
  }
};
