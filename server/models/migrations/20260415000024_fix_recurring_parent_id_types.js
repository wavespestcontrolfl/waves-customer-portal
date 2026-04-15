/**
 * Fix recurring_parent_id wiring:
 *  - Add `recurring_parent_id` (uuid) to scheduled_services so child visits can
 *    point at their parent plan. The prior migration referenced this column
 *    from the route but never created it.
 *  - Rebuild recurring_plan_alerts with uuid columns for parent/customer —
 *    scheduled_services.id and customers.id are uuid, and the original
 *    definition used integer which blew up with
 *    `operator does not exist: integer = uuid`.
 */

exports.up = async function (knex) {
  // 1. scheduled_services.recurring_parent_id (uuid)
  const hasParent = await knex.schema.hasColumn('scheduled_services', 'recurring_parent_id');
  if (!hasParent) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.uuid('recurring_parent_id').nullable();
      t.index(['recurring_parent_id']);
    });
  }

  // 2. recurring_plan_alerts — rebuild if columns are the wrong type.
  const hasTable = await knex.schema.hasTable('recurring_plan_alerts');
  if (hasTable) {
    const info = await knex('recurring_plan_alerts').columnInfo();
    const parentType = info.recurring_parent_id && info.recurring_parent_id.type;
    const customerType = info.customer_id && info.customer_id.type;
    const needsRebuild = (parentType && parentType !== 'uuid') || (customerType && customerType !== 'uuid');
    if (needsRebuild) {
      await knex.schema.dropTable('recurring_plan_alerts');
    }
  }

  const stillExists = await knex.schema.hasTable('recurring_plan_alerts');
  if (!stillExists) {
    await knex.schema.createTable('recurring_plan_alerts', (t) => {
      t.increments('id').primary();
      t.uuid('recurring_parent_id').notNullable();
      t.uuid('customer_id').notNullable();
      t.string('alert_type', 40).notNullable();
      t.date('last_visit_date');
      t.string('recurring_pattern', 30);
      t.integer('remaining_visits');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('resolved_at').nullable();
      t.string('resolved_action', 40).nullable();
      t.uuid('resolved_by').nullable();
      t.index(['resolved_at']);
      t.index(['recurring_parent_id']);
      t.index(['customer_id']);
    });
  }
};

exports.down = async function (knex) {
  const hasParent = await knex.schema.hasColumn('scheduled_services', 'recurring_parent_id');
  if (hasParent) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('recurring_parent_id');
    });
  }
  // Leave recurring_plan_alerts in place on down — destructive rebuild only goes up.
};
