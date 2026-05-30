exports.up = async function (knex) {
  const cols = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    if (!cols.estimated_sq_ft_per_full_tank) t.decimal('estimated_sq_ft_per_full_tank', 12, 2);
    if (!cols.estimated_acres_per_full_tank) t.decimal('estimated_acres_per_full_tank', 8, 3);
    if (!cols.tank_size_gallons) t.decimal('tank_size_gallons', 8, 2);
    if (!cols.gun_output_reference_gpm) t.decimal('gun_output_reference_gpm', 8, 3);
    if (!cols.pump_output_reference_gpm) t.decimal('pump_output_reference_gpm', 8, 3);
    if (!cols.pass_time_reference) t.string('pass_time_reference', 160);
    if (!cols.low_volume_carrier_gal_per_1000) t.decimal('low_volume_carrier_gal_per_1000', 6, 3);
    if (!cols.low_volume_sq_ft_per_full_tank) t.decimal('low_volume_sq_ft_per_full_tank', 12, 2);
    if (!cols.heavy_carrier_gal_per_1000) t.decimal('heavy_carrier_gal_per_1000', 6, 3);
    if (!cols.heavy_sq_ft_per_full_tank) t.decimal('heavy_sq_ft_per_full_tank', 12, 2);
    if (!cols.very_heavy_carrier_gal_per_1000) t.decimal('very_heavy_carrier_gal_per_1000', 6, 3);
    if (!cols.very_heavy_sq_ft_per_full_tank) t.decimal('very_heavy_sq_ft_per_full_tank', 12, 2);
    if (!cols.recommended_test_area_sqft) t.integer('recommended_test_area_sqft');
    if (!cols.expected_refill_gallons) t.decimal('expected_refill_gallons', 8, 3);
    if (!cols.acceptable_first_pass_refill_min_gallons) t.decimal('acceptable_first_pass_refill_min_gallons', 8, 3);
    if (!cols.acceptable_first_pass_refill_max_gallons) t.decimal('acceptable_first_pass_refill_max_gallons', 8, 3);
    if (!cols.final_formula) t.string('final_formula', 180);
  });
};

exports.down = async function (knex) {
  const cols = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    for (const col of [
      'final_formula',
      'acceptable_first_pass_refill_max_gallons',
      'acceptable_first_pass_refill_min_gallons',
      'expected_refill_gallons',
      'recommended_test_area_sqft',
      'very_heavy_sq_ft_per_full_tank',
      'very_heavy_carrier_gal_per_1000',
      'heavy_sq_ft_per_full_tank',
      'heavy_carrier_gal_per_1000',
      'low_volume_sq_ft_per_full_tank',
      'low_volume_carrier_gal_per_1000',
      'pass_time_reference',
      'pump_output_reference_gpm',
      'gun_output_reference_gpm',
      'tank_size_gallons',
      'estimated_acres_per_full_tank',
      'estimated_sq_ft_per_full_tank',
    ]) {
      if (cols[col]) t.dropColumn(col);
    }
  });
};
