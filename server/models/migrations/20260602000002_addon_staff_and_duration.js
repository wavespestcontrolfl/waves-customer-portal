// Adds per-line staff + duration to scheduled service add-ons so an
// appointment can carry multiple service lines, each optionally assigned to a
// different technician with its own duration. The primary service line keeps
// using scheduled_services.technician_id / estimated_duration_minutes; these
// columns cover the additional add-on lines edited from the Edit appointment
// "Services and items" section.
exports.up = async function (knex) {
  const hasAddons = await knex.schema.hasTable('scheduled_service_addons');
  if (!hasAddons) return;

  const cols = await knex('scheduled_service_addons').columnInfo();
  await knex.schema.alterTable('scheduled_service_addons', (t) => {
    if (!cols.technician_id) {
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    }
    if (!cols.estimated_duration_minutes) {
      t.integer('estimated_duration_minutes').nullable();
    }
  });
};

exports.down = async function (knex) {
  const hasAddons = await knex.schema.hasTable('scheduled_service_addons');
  if (!hasAddons) return;

  const cols = await knex('scheduled_service_addons').columnInfo();
  await knex.schema.alterTable('scheduled_service_addons', (t) => {
    if (cols.estimated_duration_minutes) t.dropColumn('estimated_duration_minutes');
    if (cols.technician_id) t.dropColumn('technician_id');
  });
};
