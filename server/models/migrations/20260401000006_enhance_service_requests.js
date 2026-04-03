/**
 * Enhance service_requests — add urgency, location, photos, assignment, resolution
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('service_requests', (t) => {
    t.enu('urgency', ['routine', 'urgent']).defaultTo('routine');
    t.string('location_on_property', 50);
    t.jsonb('photos').defaultTo('[]');
    t.text('admin_notes');
    t.uuid('assigned_technician_id').references('id').inTable('technicians');
    t.timestamp('resolved_at');
  });

  // Migrate existing status values to match new enum-style
  await knex('service_requests')
    .where('status', 'open')
    .update({ status: 'new' });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('service_requests', (t) => {
    t.dropColumn('urgency');
    t.dropColumn('location_on_property');
    t.dropColumn('photos');
    t.dropColumn('admin_notes');
    t.dropColumn('assigned_technician_id');
    t.dropColumn('resolved_at');
  });
};
