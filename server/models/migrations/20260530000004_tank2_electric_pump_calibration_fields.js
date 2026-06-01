exports.up = async function (knex) {
  const cols = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    if (!cols.pump_pressure_reference_psi) t.decimal('pump_pressure_reference_psi', 8, 2);
    if (!cols.pump_amp_reference) t.decimal('pump_amp_reference', 8, 2);
    if (!cols.pump_weight_reference_lb) t.decimal('pump_weight_reference_lb', 8, 2);
    if (!cols.electric_pump_setting) t.string('electric_pump_setting', 160);
    if (!cols.target_bucket_30_sec_oz) t.decimal('target_bucket_30_sec_oz', 8, 2);
    if (!cols.low_volume_bucket_30_sec_oz) t.decimal('low_volume_bucket_30_sec_oz', 8, 2);
    if (!cols.heavy_bucket_30_sec_oz) t.decimal('heavy_bucket_30_sec_oz', 8, 2);
    if (!cols.very_heavy_bucket_30_sec_oz) t.decimal('very_heavy_bucket_30_sec_oz', 8, 2);
    if (!cols.pump_max_bucket_30_sec_oz) t.decimal('pump_max_bucket_30_sec_oz', 8, 2);
    if (!cols.incorrect_pump_max_carrier_gal_per_1000) t.decimal('incorrect_pump_max_carrier_gal_per_1000', 6, 3);
    if (!cols.incorrect_pump_max_sq_ft_per_full_tank) t.decimal('incorrect_pump_max_sq_ft_per_full_tank', 12, 2);
    if (!cols.incorrect_pump_max_acres_per_full_tank) t.decimal('incorrect_pump_max_acres_per_full_tank', 8, 3);
    if (!cols.example_result) t.string('example_result', 180);
  });
};

exports.down = async function (knex) {
  const cols = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    for (const col of [
      'example_result',
      'incorrect_pump_max_acres_per_full_tank',
      'incorrect_pump_max_sq_ft_per_full_tank',
      'incorrect_pump_max_carrier_gal_per_1000',
      'pump_max_bucket_30_sec_oz',
      'very_heavy_bucket_30_sec_oz',
      'heavy_bucket_30_sec_oz',
      'low_volume_bucket_30_sec_oz',
      'target_bucket_30_sec_oz',
      'electric_pump_setting',
      'pump_weight_reference_lb',
      'pump_amp_reference',
      'pump_pressure_reference_psi',
    ]) {
      if (cols[col]) t.dropColumn(col);
    }
  });
};
