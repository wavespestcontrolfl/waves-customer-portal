/**
 * Expand property_preferences with HOA details, irrigation extras,
 * blackout dates, side gate access, and structured pets.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('property_preferences', (t) => {
    // HOA expanded
    t.string('hoa_company', 200);
    t.string('hoa_phone', 30);
    t.string('hoa_email', 100);
    t.string('hoa_lawn_height', 100);
    t.text('hoa_signage_rules');
    t.text('hoa_timing_restrictions');
    t.string('hoa_inspection_period', 100);

    // Irrigation expanded
    t.jsonb('watering_days'); // array of day names
    t.string('irrigation_system_type', 30);
    t.boolean('rain_sensor').defaultTo(false);
    t.text('irrigation_issues');

    // Scheduling — blackout dates
    t.date('blackout_start');
    t.date('blackout_end');

    // Access — side gate
    t.string('side_gate_access', 200);

    // Structured pets array
    t.jsonb('pets_structured'); // array of pet objects
  });
};

exports.down = async function (knex) {
  const cols = [
    'hoa_company', 'hoa_phone', 'hoa_email', 'hoa_lawn_height',
    'hoa_signage_rules', 'hoa_timing_restrictions', 'hoa_inspection_period',
    'watering_days', 'irrigation_system_type', 'rain_sensor', 'irrigation_issues',
    'blackout_start', 'blackout_end', 'side_gate_access', 'pets_structured',
  ];

  for (const col of cols) {
    const has = await knex.schema.hasColumn('property_preferences', col);
    if (has) {
      await knex.schema.alterTable('property_preferences', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
