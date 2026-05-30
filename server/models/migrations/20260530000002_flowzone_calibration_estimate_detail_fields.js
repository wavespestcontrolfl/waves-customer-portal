exports.up = async function (knex) {
  const cols = await knex('equipment_calibrations').columnInfo();

  if (cols.estimated_sq_ft_per_tank && !cols.estimated_sq_ft_per_4gal_tank) {
    await knex.schema.alterTable('equipment_calibrations', (t) => {
      t.renameColumn('estimated_sq_ft_per_tank', 'estimated_sq_ft_per_4gal_tank');
    });
  } else if (!cols.estimated_sq_ft_per_4gal_tank) {
    await knex.schema.alterTable('equipment_calibrations', (t) => {
      t.decimal('estimated_sq_ft_per_4gal_tank', 10, 2);
    });
  }

  const colsAfterFirst = await knex('equipment_calibrations').columnInfo();
  if (colsAfterFirst.flow_rate_gpm && !colsAfterFirst.flow_output_reference_gpm) {
    await knex.schema.alterTable('equipment_calibrations', (t) => {
      t.renameColumn('flow_rate_gpm', 'flow_output_reference_gpm');
    });
  } else if (!colsAfterFirst.flow_output_reference_gpm) {
    await knex.schema.alterTable('equipment_calibrations', (t) => {
      t.decimal('flow_output_reference_gpm', 8, 3);
    });
  }

  const colsFinal = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    if (!colsFinal.likely_sq_ft_per_4gal_tank_min) t.decimal('likely_sq_ft_per_4gal_tank_min', 10, 2);
    if (!colsFinal.likely_sq_ft_per_4gal_tank_max) t.decimal('likely_sq_ft_per_4gal_tank_max', 10, 2);
    if (!colsFinal.carrier_gal_per_1000_range_min) t.decimal('carrier_gal_per_1000_range_min', 6, 3);
    if (!colsFinal.carrier_gal_per_1000_range_max) t.decimal('carrier_gal_per_1000_range_max', 6, 3);
    if (!colsFinal.conservative_carrier_gal_per_1000) t.decimal('conservative_carrier_gal_per_1000', 6, 3);
    if (!colsFinal.conservative_sq_ft_per_4gal_tank) t.decimal('conservative_sq_ft_per_4gal_tank', 10, 2);
  });
};

exports.down = async function (knex) {
  const cols = await knex('equipment_calibrations').columnInfo();
  await knex.schema.alterTable('equipment_calibrations', (t) => {
    if (cols.conservative_sq_ft_per_4gal_tank) t.dropColumn('conservative_sq_ft_per_4gal_tank');
    if (cols.conservative_carrier_gal_per_1000) t.dropColumn('conservative_carrier_gal_per_1000');
    if (cols.carrier_gal_per_1000_range_max) t.dropColumn('carrier_gal_per_1000_range_max');
    if (cols.carrier_gal_per_1000_range_min) t.dropColumn('carrier_gal_per_1000_range_min');
    if (cols.likely_sq_ft_per_4gal_tank_max) t.dropColumn('likely_sq_ft_per_4gal_tank_max');
    if (cols.likely_sq_ft_per_4gal_tank_min) t.dropColumn('likely_sq_ft_per_4gal_tank_min');
  });

  const colsAfterDrop = await knex('equipment_calibrations').columnInfo();
  if (colsAfterDrop.flow_output_reference_gpm && !colsAfterDrop.flow_rate_gpm) {
    await knex.schema.alterTable('equipment_calibrations', (t) => {
      t.renameColumn('flow_output_reference_gpm', 'flow_rate_gpm');
    });
  }
  const colsAfterFlow = await knex('equipment_calibrations').columnInfo();
  if (colsAfterFlow.estimated_sq_ft_per_4gal_tank && !colsAfterFlow.estimated_sq_ft_per_tank) {
    await knex.schema.alterTable('equipment_calibrations', (t) => {
      t.renameColumn('estimated_sq_ft_per_4gal_tank', 'estimated_sq_ft_per_tank');
    });
  }
};
