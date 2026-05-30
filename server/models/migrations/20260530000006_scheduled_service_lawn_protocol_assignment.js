exports.up = async function up(knex) {
  const cols = await knex('scheduled_services').columnInfo();
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (!cols.lawn_protocol_key) t.string('lawn_protocol_key', 100).nullable();
    if (!cols.lawn_protocol_version) t.string('lawn_protocol_version', 40).nullable();
    if (!cols.lawn_protocol_window_key) t.string('lawn_protocol_window_key', 80).nullable();
    if (!cols.lawn_protocol_window_title) t.string('lawn_protocol_window_title', 160).nullable();
    if (!cols.assigned_equipment_system_id) {
      t.uuid('assigned_equipment_system_id')
        .nullable()
        .references('id')
        .inTable('equipment_systems')
        .onDelete('SET NULL');
    }
    if (!cols.assigned_calibration_id) {
      t.uuid('assigned_calibration_id')
        .nullable()
        .references('id')
        .inTable('equipment_calibrations')
        .onDelete('SET NULL');
    }
    if (!cols.lawn_protocol_assignment_source) t.string('lawn_protocol_assignment_source', 40).nullable();
    if (!cols.lawn_protocol_assigned_by) {
      t.uuid('lawn_protocol_assigned_by')
        .nullable()
        .references('id')
        .inTable('technicians')
        .onDelete('SET NULL');
    }
    if (!cols.lawn_protocol_assigned_at) t.timestamp('lawn_protocol_assigned_at', { useTz: true }).nullable();
    if (!cols.lawn_protocol_assignment_snapshot) t.jsonb('lawn_protocol_assignment_snapshot').notNullable().defaultTo('{}');
  });
};

exports.down = async function down(knex) {
  const cols = await knex('scheduled_services').columnInfo();
  await knex.schema.alterTable('scheduled_services', (t) => {
    if (cols.lawn_protocol_assignment_snapshot) t.dropColumn('lawn_protocol_assignment_snapshot');
    if (cols.lawn_protocol_assigned_at) t.dropColumn('lawn_protocol_assigned_at');
    if (cols.lawn_protocol_assigned_by) t.dropColumn('lawn_protocol_assigned_by');
    if (cols.lawn_protocol_assignment_source) t.dropColumn('lawn_protocol_assignment_source');
    if (cols.assigned_calibration_id) t.dropColumn('assigned_calibration_id');
    if (cols.assigned_equipment_system_id) t.dropColumn('assigned_equipment_system_id');
    if (cols.lawn_protocol_window_title) t.dropColumn('lawn_protocol_window_title');
    if (cols.lawn_protocol_window_key) t.dropColumn('lawn_protocol_window_key');
    if (cols.lawn_protocol_version) t.dropColumn('lawn_protocol_version');
    if (cols.lawn_protocol_key) t.dropColumn('lawn_protocol_key');
  });
};
