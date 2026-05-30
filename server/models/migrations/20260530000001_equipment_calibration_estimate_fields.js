exports.up = async function (knex) {
  const cols = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    if (!cols.calibration_status) t.string('calibration_status', 40);
    if (!cols.estimated_sq_ft_per_tank) t.decimal('estimated_sq_ft_per_tank', 10, 2);
    if (!cols.flow_rate_gpm) t.decimal('flow_rate_gpm', 8, 3);
  });
};

exports.down = async function (knex) {
  const cols = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    if (cols.flow_rate_gpm) t.dropColumn('flow_rate_gpm');
    if (cols.estimated_sq_ft_per_tank) t.dropColumn('estimated_sq_ft_per_tank');
    if (cols.calibration_status) t.dropColumn('calibration_status');
  });
};
