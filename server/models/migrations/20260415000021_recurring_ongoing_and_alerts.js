/**
 * Add Ongoing mode for recurring services + end-of-plan alert queue
 */

exports.up = async function (knex) {
  // 1. Add recurring_ongoing to scheduled_services
  const hasCol = await knex.schema.hasColumn('scheduled_services', 'recurring_ongoing');
  if (!hasCol) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.boolean('recurring_ongoing').defaultTo(false);
    });
  }

  // 2. Create recurring_plan_alerts
  const hasTable = await knex.schema.hasTable('recurring_plan_alerts');
  if (!hasTable) {
    await knex.schema.createTable('recurring_plan_alerts', (t) => {
      t.increments('id').primary();
      t.integer('recurring_parent_id').notNullable();
      t.integer('customer_id').notNullable();
      t.string('alert_type', 40).notNullable(); // 'plan_ending' | 'plan_lapsed' | 'ongoing_review'
      t.date('last_visit_date');
      t.string('recurring_pattern', 30);
      t.integer('remaining_visits');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('resolved_at').nullable();
      t.string('resolved_action', 40).nullable(); // 'extend' | 'convert_ongoing' | 'let_lapse'
      t.integer('resolved_by').nullable();
      t.index(['resolved_at']);
      t.index(['recurring_parent_id']);
      t.index(['customer_id']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('recurring_plan_alerts');
  const hasCol = await knex.schema.hasColumn('scheduled_services', 'recurring_ongoing');
  if (hasCol) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('recurring_ongoing');
    });
  }
};
