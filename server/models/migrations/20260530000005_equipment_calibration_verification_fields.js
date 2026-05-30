exports.up = async function up(knex) {
  const cols = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    if (!cols.verified_at) t.timestamp('verified_at', { useTz: true }).nullable();
    if (!cols.verified_by_technician_id) {
      t.uuid('verified_by_technician_id')
        .nullable()
        .references('id')
        .inTable('technicians')
        .onDelete('SET NULL');
    }
    if (!cols.verified_test_area_sqft) t.integer('verified_test_area_sqft').nullable();
    if (!cols.verified_captured_gallons) t.decimal('verified_captured_gallons', 6, 3).nullable();
    if (!cols.verification_notes) t.text('verification_notes').nullable();
    if (!cols.previous_calibration_status) t.string('previous_calibration_status', 40).nullable();
  });
};

exports.down = async function down(knex) {
  const cols = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    if (cols.previous_calibration_status) t.dropColumn('previous_calibration_status');
    if (cols.verification_notes) t.dropColumn('verification_notes');
    if (cols.verified_captured_gallons) t.dropColumn('verified_captured_gallons');
    if (cols.verified_test_area_sqft) t.dropColumn('verified_test_area_sqft');
    if (cols.verified_by_technician_id) t.dropColumn('verified_by_technician_id');
    if (cols.verified_at) t.dropColumn('verified_at');
  });
};
