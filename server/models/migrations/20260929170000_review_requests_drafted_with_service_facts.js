// GATE_REVIEW_ASK_SERVICE_FACTS: marks a review ask whose drafted body used
// the service report's facts, so a retry after the gate is turned off never
// reuses that draft (review-request.js sendOutreachTouch). Null = not.
exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('review_requests')) return;
  if (!await knex.schema.hasColumn('review_requests', 'drafted_with_service_facts')) {
    await knex.schema.alterTable('review_requests', table => {
      table.boolean('drafted_with_service_facts').nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!await knex.schema.hasTable('review_requests')) return;
  if (await knex.schema.hasColumn('review_requests', 'drafted_with_service_facts')) {
    await knex.schema.alterTable('review_requests', table => {
      table.dropColumn('drafted_with_service_facts');
    });
  }
};
