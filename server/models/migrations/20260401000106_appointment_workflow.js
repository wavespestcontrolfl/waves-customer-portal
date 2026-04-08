/**
 * Appointment Workflow — enhanced scheduling columns + service addons
 */
exports.up = async function (knex) {
  const cols = await knex('scheduled_services').columnInfo();

  await knex.schema.alterTable('scheduled_services', (t) => {
    if (!cols.service_id) t.uuid('service_id').nullable().references('id').inTable('services').onDelete('SET NULL');
    if (!cols.estimated_price) t.decimal('estimated_price', 10, 2).nullable();
    if (!cols.urgency) t.string('urgency', 20).defaultTo('routine');
    if (!cols.internal_notes) t.text('internal_notes').nullable();
    if (!cols.is_callback) t.boolean('is_callback').defaultTo(false);
    if (!cols.parent_service_id) t.uuid('parent_service_id').nullable().references('id').inTable('scheduled_services').onDelete('SET NULL');
    if (!cols.customer_location_override) t.jsonb('customer_location_override').nullable();
  });

  const hasAddons = await knex.schema.hasTable('scheduled_service_addons');
  if (!hasAddons) {
    await knex.schema.createTable('scheduled_service_addons', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('scheduled_service_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.uuid('service_id').nullable().references('id').inTable('services').onDelete('SET NULL');
      t.string('service_name', 200).notNullable();
      t.decimal('estimated_price', 10, 2).nullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('scheduled_service_addons');

  const cols = await knex('scheduled_services').columnInfo();
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (cols.service_id) t.dropColumn('service_id');
    if (cols.estimated_price) t.dropColumn('estimated_price');
    if (cols.urgency) t.dropColumn('urgency');
    if (cols.internal_notes) t.dropColumn('internal_notes');
    if (cols.is_callback) t.dropColumn('is_callback');
    if (cols.parent_service_id) t.dropColumn('parent_service_id');
    if (cols.customer_location_override) t.dropColumn('customer_location_override');
  });
};
