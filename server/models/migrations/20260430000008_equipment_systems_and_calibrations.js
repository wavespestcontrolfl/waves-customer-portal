// PR 1.2 of the WaveGuard treatment-plan rollout.
//
// Two tables that together let the plan engine reason about HOW
// product gets applied — not just what:
//
//   equipment_systems        — composed spray rigs
//                              (tank + pump + reel + hose + gun + nozzle).
//                              Calibration is per system, not per piece,
//                              because changing any one component
//                              changes the carrier rate at the gun.
//
//   equipment_calibrations   — history of recorded calibrations per
//                              system. The active flag picks one row
//                              per system as the "currently in use"
//                              calibration; other rows stay around so
//                              we can audit what was being applied
//                              when a customer reports a burn.
//
// Asset-FK columns (tank/pump/reel/hose/gun) are nullable uuids with
// NO foreign key — there's no equipment_assets table on main yet
// (would need its own migration with seed data). Storing them as
// opaque uuids now lets a later PR add the FK constraint without a
// data migration. Plain strings (system_type, nozzle_name,
// default_application_type) keep allowed values flexible — same
// reasoning as PR 1.1's turf-profile column choices.
//
// Seed: the five spray rigs Waves uses today, per the equipment
// inventory the owner shared. Capacities sized to the actual tanks:
// the 110-gallon rigs are real 110-gallon tanks (don't store 100
// here just because the working fill is usually 100; capacity is a
// physical fact, working fill is the math the calculator does).
// FlowZone Typhoon 2.5 backpacks are 4-gallon units per spec.

exports.up = async function (knex) {
  // ── equipment_systems ────────────────────────────────────────────
  if (!(await knex.schema.hasTable('equipment_systems'))) {
    await knex.schema.createTable('equipment_systems', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      t.string('name', 120).notNullable();
      // 'tank' | 'backpack' | 'topdresser' | 'dethatcher' | 'reel' | 'spreader' | etc.
      t.string('system_type', 30).notNullable();

      // Composed-system asset references. Nullable; no FK yet —
      // equipment_assets table lives in a future PR.
      t.uuid('tank_asset_id').nullable();
      t.uuid('pump_asset_id').nullable();
      t.uuid('reel_asset_id').nullable();
      t.uuid('hose_asset_id').nullable();
      t.uuid('gun_asset_id').nullable();

      // Nozzle as plain string for now — most nozzle changes happen
      // mid-route and we don't want to require a nozzle catalog edit
      // before the tech can re-calibrate.
      t.string('nozzle_name', 80).nullable();

      // 'broadcast' | 'spot' | 'perimeter' | 'foliar' | 'soil' | etc.
      t.string('default_application_type', 30).nullable();

      // Physical tank capacity in gallons. 110 for the 110-gal rigs,
      // 4 for FlowZone Typhoon 2.5 backpacks.
      t.decimal('tank_capacity_gal', 6, 2).nullable();

      t.text('notes').nullable();
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);

      t.index('system_type', 'idx_eqs_type');
      t.index('active', 'idx_eqs_active');
    });
  }

  // Unique system name (within active rows). Lets us deactivate an
  // old "FlowZone #1" and create a new one with the same display name
  // without a UNIQUE collision.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_eqs_name_active
    ON equipment_systems (name) WHERE active = true
  `);

  // ── equipment_calibrations ───────────────────────────────────────
  if (!(await knex.schema.hasTable('equipment_calibrations'))) {
    await knex.schema.createTable('equipment_calibrations', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      t.uuid('equipment_system_id')
        .notNullable()
        .references('id')
        .inTable('equipment_systems')
        .onDelete('CASCADE')
        .onUpdate('CASCADE');

      // Calibration is tech-specific because walking pace + arm motion
      // are real factors. Nullable for rig/automatic calibrations
      // where no tech is involved (rare; future-proofs the column).
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');

      // The headline number the plan engine reads.
      t.decimal('carrier_gal_per_1000', 6, 3).notNullable();

      // The measurement that produced it.
      t.integer('test_area_sqft').nullable();
      t.decimal('captured_gallons', 6, 3).nullable();

      // Operating context.
      t.decimal('pressure_psi', 6, 2).nullable();
      t.string('engine_rpm_setting', 30).nullable();
      t.decimal('swath_width_ft', 6, 2).nullable();
      t.decimal('pass_time_seconds', 6, 2).nullable();

      // Lifecycle. calibrated_at = when the test was run; expires_at
      // = when the plan engine should stop trusting this calibration
      // (default +30 days from calibrated_at, set in the API layer).
      t.timestamp('calibrated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('expires_at', { useTz: true }).nullable();
      t.boolean('active').notNullable().defaultTo(true);

      t.text('notes').nullable();
      t.timestamps(true, true);

      t.index('equipment_system_id', 'idx_eqcal_system');
      t.index(['equipment_system_id', 'active'], 'idx_eqcal_system_active');
      t.index('expires_at', 'idx_eqcal_expires');
    });
  }

  // At most one ACTIVE calibration per system. Prevents the plan
  // engine from having to disambiguate between two "active" rows
  // when a tech forgets to deactivate the old one before saving a
  // new test.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_eqcal_one_active_per_system
    ON equipment_calibrations (equipment_system_id) WHERE active = true
  `);

  // ── Seed: the five spray rigs Waves uses today ───────────────────
  // Idempotent: skip seed if any system already exists (re-run safe).
  const existing = await knex('equipment_systems').count('id as cnt').first();
  if (parseInt(existing.cnt, 10) === 0) {
    await knex('equipment_systems').insert([
      {
        name: '110-Gallon Spray Tank #1',
        system_type: 'tank',
        default_application_type: 'broadcast',
        tank_capacity_gal: 110.00,
        notes: 'Primary turf base tank — fertility, micronutrients, preventive insect, fungicides. Avoid hot herbicides.',
        active: true,
      },
      {
        name: '110-Gallon Spray Tank #2',
        system_type: 'tank',
        default_application_type: 'broadcast',
        tank_capacity_gal: 110.00,
        notes: 'Selective turf herbicide / specialty tank — Celsius, sedge products, broadleaf programs.',
        active: true,
      },
      {
        name: 'FlowZone Typhoon 2.5 #1',
        system_type: 'backpack',
        default_application_type: 'spot',
        tank_capacity_gal: 4.00,
        notes: 'Selective turf herbicide spot work (Celsius, SedgeHammer).',
        active: true,
      },
      {
        name: 'FlowZone Typhoon 2.5 #2',
        system_type: 'backpack',
        default_application_type: 'spot',
        tank_capacity_gal: 4.00,
        notes: 'Insect / fungicide / specialty foliar spot work.',
        active: true,
      },
      {
        name: 'FlowZone Typhoon Backpack',
        system_type: 'backpack',
        default_application_type: 'spot',
        tank_capacity_gal: 4.00,
        notes: 'NON-SELECTIVE ONLY — bed-edge / glyphosate. Never use on turf.',
        active: true,
      },
    ]);
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_eqcal_one_active_per_system');
  await knex.schema.dropTableIfExists('equipment_calibrations');
  await knex.raw('DROP INDEX IF EXISTS idx_eqs_name_active');
  await knex.schema.dropTableIfExists('equipment_systems');
};
