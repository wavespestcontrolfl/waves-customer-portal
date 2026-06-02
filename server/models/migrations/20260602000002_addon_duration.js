// Adds a per-line duration to scheduled service add-ons so an appointment can
// carry multiple service lines, each with its own duration. The parent
// scheduled_services.estimated_duration_minutes stays the whole-visit total
// (primary line + add-on lines); these per-line values let the Edit appointment
// "Services and items" section round-trip each line's duration.
//
// Note: add-on lines intentionally do NOT carry their own technician — all
// lines on a visit share the appointment's single staff assignment / route
// stop (dispatch groups and routes by scheduled_services.technician_id).
exports.up = async function (knex) {
  const hasAddons = await knex.schema.hasTable('scheduled_service_addons');
  if (!hasAddons) return;

  const cols = await knex('scheduled_service_addons').columnInfo();
  await knex.schema.alterTable('scheduled_service_addons', (t) => {
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
  });
};
