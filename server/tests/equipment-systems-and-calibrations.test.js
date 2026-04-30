/**
 * DB-backed integration tests for PR 1.2 — equipment_systems +
 * equipment_calibrations + the 5-system seed.
 *
 * Self-skips without DATABASE_URL.
 */

const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('equipment_systems + equipment_calibrations', () => {
  let knex;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  // ── Schema presence ───────────────────────────────────────────────────
  test('equipment_systems has every column the API + plan engine reads', async () => {
    const cols = await knex('equipment_systems').columnInfo();
    const required = [
      'id', 'name', 'system_type',
      'tank_asset_id', 'pump_asset_id', 'reel_asset_id', 'hose_asset_id', 'gun_asset_id',
      'nozzle_name', 'default_application_type', 'tank_capacity_gal',
      'notes', 'active', 'created_at', 'updated_at',
    ];
    for (const c of required) {
      expect(cols).toHaveProperty(c);
    }
    expect(cols.name.nullable).toBe(false);
    expect(cols.system_type.nullable).toBe(false);
  });

  test('equipment_calibrations has every column the API + plan engine reads', async () => {
    const cols = await knex('equipment_calibrations').columnInfo();
    const required = [
      'id', 'equipment_system_id', 'technician_id',
      'carrier_gal_per_1000',
      'test_area_sqft', 'captured_gallons',
      'pressure_psi', 'engine_rpm_setting',
      'swath_width_ft', 'pass_time_seconds',
      'calibrated_at', 'expires_at', 'active',
      'notes', 'created_at', 'updated_at',
    ];
    for (const c of required) {
      expect(cols).toHaveProperty(c);
    }
    expect(cols.equipment_system_id.nullable).toBe(false);
    expect(cols.carrier_gal_per_1000.nullable).toBe(false);
  });

  // ── Seed data ─────────────────────────────────────────────────────────
  test('5 spray rigs are seeded and active', async () => {
    const systems = await knex('equipment_systems').where({ active: true }).orderBy('name');
    const names = systems.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        '110-Gallon Spray Tank #1',
        '110-Gallon Spray Tank #2',
        'FlowZone Typhoon 2.5 #1',
        'FlowZone Typhoon 2.5 #2',
        'FlowZone Typhoon Backpack',
      ])
    );

    // Capacity checks: tanks at 110, backpacks at 4.
    const tank1 = systems.find((s) => s.name === '110-Gallon Spray Tank #1');
    expect(parseFloat(tank1.tank_capacity_gal)).toBe(110);
    expect(tank1.system_type).toBe('tank');

    const fz1 = systems.find((s) => s.name === 'FlowZone Typhoon 2.5 #1');
    expect(parseFloat(fz1.tank_capacity_gal)).toBe(4);
    expect(fz1.system_type).toBe('backpack');
  });

  // ── FK + cascade ──────────────────────────────────────────────────────
  test('CASCADE on equipment_systems delete drops calibrations', async () => {
    const [system] = await knex('equipment_systems')
      .insert({ name: `Test Rig ${Date.now()}`, system_type: 'tank', active: true })
      .returning(['id']);

    await knex('equipment_calibrations').insert({
      equipment_system_id: system.id,
      carrier_gal_per_1000: 2.0,
      active: true,
    });

    let calBefore = await knex('equipment_calibrations')
      .where({ equipment_system_id: system.id })
      .first();
    expect(calBefore).toBeTruthy();

    await knex('equipment_systems').where({ id: system.id }).del();

    const calAfter = await knex('equipment_calibrations')
      .where({ equipment_system_id: system.id })
      .first();
    expect(calAfter).toBeUndefined();
  });

  // ── Unique-active partial index ───────────────────────────────────────
  test('only one active calibration per system at a time', async () => {
    const tank1 = await knex('equipment_systems')
      .where({ name: '110-Gallon Spray Tank #1' })
      .first();

    const [first] = await knex('equipment_calibrations')
      .insert({ equipment_system_id: tank1.id, carrier_gal_per_1000: 2.0, active: true })
      .returning(['id']);

    try {
      await expect(
        knex('equipment_calibrations').insert({
          equipment_system_id: tank1.id,
          carrier_gal_per_1000: 2.5,
          active: true,
        })
      ).rejects.toThrow(/duplicate key|unique/i);

      // But inactive history rows ARE allowed.
      await knex('equipment_calibrations').insert({
        equipment_system_id: tank1.id,
        carrier_gal_per_1000: 1.8,
        active: false,
      });
      const inactive = await knex('equipment_calibrations')
        .where({ equipment_system_id: tank1.id, active: false });
      expect(inactive.length).toBeGreaterThanOrEqual(1);
    } finally {
      // Clean up everything we created on tank1 in this test.
      await knex('equipment_calibrations').where({ equipment_system_id: tank1.id }).del();
    }
  });

  // ── Multiple historical calibrations per system ───────────────────────
  test('can store calibration history (multiple rows, one active)', async () => {
    const fz1 = await knex('equipment_systems')
      .where({ name: 'FlowZone Typhoon 2.5 #1' })
      .first();

    const created = [];
    try {
      // Insert 3 historical (inactive) and 1 current (active).
      for (let i = 0; i < 3; i++) {
        const [r] = await knex('equipment_calibrations').insert({
          equipment_system_id: fz1.id,
          carrier_gal_per_1000: 0.9 + i * 0.05,
          active: false,
          calibrated_at: new Date(Date.now() - (i + 1) * 30 * 24 * 60 * 60 * 1000),
        }).returning(['id']);
        created.push(r.id);
      }
      const [active] = await knex('equipment_calibrations').insert({
        equipment_system_id: fz1.id,
        carrier_gal_per_1000: 1.0,
        active: true,
      }).returning(['id']);
      created.push(active.id);

      const all = await knex('equipment_calibrations')
        .where({ equipment_system_id: fz1.id })
        .orderBy('calibrated_at', 'desc');
      expect(all.length).toBe(4);

      const activeRow = all.find((r) => r.active);
      expect(activeRow).toBeTruthy();
      expect(parseFloat(activeRow.carrier_gal_per_1000)).toBe(1.0);

      const inactives = all.filter((r) => !r.active);
      expect(inactives.length).toBe(3);
    } finally {
      await knex('equipment_calibrations').whereIn('id', created).del();
    }
  });
});
