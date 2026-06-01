exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('equipment_systems'))) return;

  const now = new Date();
  const legacyFlowZone = await knex('equipment_systems')
    .where({ name: 'FlowZone Typhoon 2.5 #1' })
    .first();

  await knex('equipment_systems')
    .where({ name: '110-Gallon Spray Tank #2' })
    .update({
      name: 'Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun',
      system_type: 'tank',
      default_application_type: 'broadcast',
      tank_capacity_gal: 110,
      notes: 'Tank #2 electric 12V HP lawn-gun rig. Udor KAPPA-18/12V-HP pump/motor assembly; blackout / 0-N / 0-P / sensitive turf route. Pump capacity is not carrier rate; use calibrated gun output.',
      active: true,
      updated_at: now,
    });

  if (legacyFlowZone) {
    await knex('equipment_systems')
      .where({ name: 'FlowZone Typhoon Backpack' })
      .whereNot({ id: legacyFlowZone.id })
      .update({
        active: false,
        notes: knex.raw("coalesce(notes, '') || ?", [' Retired by WaveGuard equipment backfill: duplicate FlowZone Backpack row.']),
        updated_at: now,
      });

    await knex('equipment_systems')
      .where({ id: legacyFlowZone.id })
      .update({
        name: 'FlowZone Typhoon Backpack',
        system_type: 'backpack',
        default_application_type: 'spot',
        tank_capacity_gal: 4,
        notes: 'Spot work backpack. Dedicate tank/labeling by use before herbicide vs non-herbicide work.',
        active: true,
        updated_at: now,
      });
  }

  await knex('equipment_systems')
    .where({ name: 'FlowZone Typhoon 2.5 #2' })
    .update({
      active: false,
      notes: knex.raw("coalesce(notes, '') || ?", [' Retired by WaveGuard equipment backfill: Waves currently has one FlowZone Typhoon backpack.']),
      updated_at: now,
    });
};

exports.down = async function down() {
  // Do not recreate retired duplicate equipment on rollback.
};
