/**
 * misting_calibrations + misting_refills (misting system records, GATE_MOSQUITO_MISTING): the tables,
 * every CHECK, the cascades and a reversible down(), proven on a real PostgreSQL in a disposable schema
 * with stub parent tables. Skipped without DATABASE_URL; run for real in CI (DB-gated suites step).
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');
const knex = require('knex');
const migration = require('../models/migrations/20261030120000_misting_records');

jest.setTimeout(60000); // schema setup and the first migration are slow on a busy machine

const schema = `misting_mig_${randomUUID().replaceAll('-', '')}`;
const CAL = 'misting_calibrations';
const REF = 'misting_refills';

const calibration = (customerId, extra = {}) => ({
  customer_id: customerId,
  installed_on: '2026-03-01',
  vendor: 'Pynamite',
  model: 'Test 55',
  tank_gallons: 55,
  nozzle_count: 20,
  riser_count: 0,
  nozzle_flow_fl_oz_per_min: 1,
  cycle_seconds: 45,
  mist_times: ['06:30', '19:30'],
  product_name: 'Sector Misting Concentrate',
  epa_reg_no: '1021-1834',
  concentrate_fl_oz_per_tank: 64,
  label_max_fl_oz_per_1000_cu_ft_day: 9.5,
  treated_area_sq_ft: 5000,
  treated_height_ft: 8,
  treated_volume_cu_ft: 40000,
  output_fl_oz_per_cycle: 15,
  daily_output_fl_oz: 30,
  label_daily_cap_fl_oz: 380,
  cabinet_locked: true,
  label_posted: true,
  schedule_avoids_people: true,
  ...extra,
});

const refill = (customerId, calibrationId, extra = {}) => ({
  customer_id: customerId,
  calibration_id: calibrationId,
  refilled_on: '2026-04-01',
  product_name: 'Sector Misting Concentrate',
  epa_reg_no: '1021-1834',
  concentrate_fl_oz_added: 64,
  water_gallons_added: 55,
  ...extra,
});

postgres('misting records tables (PostgreSQL)', () => {
  let admin;
  let app;
  let customerId;
  let tech;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(target.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && target.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    admin = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 1 } });
    await app.schema.createTable('customers', (t) => { t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); });
    await app.schema.createTable('customer_properties', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    });
    await app.schema.createTable('technicians', (t) => { t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.string('name'); });
    await migration.up(app);
  });

  beforeEach(async () => {
    customerId = (await app('customers').insert({}).returning('id'))[0].id;
    tech = (await app('technicians').insert({ name: 'Test Tech' }).returning('id'))[0].id;
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  test('defaults: uuid id, staff source, one zone, no void, timestamps; mist_times round-trips as an array', async () => {
    const [row] = await app(CAL).insert(calibration(customerId)).returning('*');
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row).toMatchObject({ source: 'staff', zone_count: 1, riser_count: 0, voided_at: null, voided_by: null, void_reason: null, property_id: null, serial_number: null });
    expect(row.mist_times).toEqual(['06:30', '19:30']);
    expect(row.created_at).toBeInstanceOf(Date);
    const [r] = await app(REF).insert(refill(customerId, row.id)).returning('*');
    expect(r).toMatchObject({ source: 'staff', counter_reset: false, level_before_pct: null, voided_at: null });
  });

  test('the database refuses a calibration that puts out more than the label allows, and exactly the cap is fine', async () => {
    await expect(app(CAL).insert(calibration(customerId, { daily_output_fl_oz: 380.001 })))
      .rejects.toMatchObject({ code: '23514', constraint: 'misting_calibrations_within_label' });
    await expect(app(CAL).insert(calibration(customerId, { daily_output_fl_oz: 380 }))).resolves.toBeDefined();
  });

  test.each([
    ['tank_gallons', 0, 'misting_calibrations_tank_gallons_positive'],
    ['zone_count', 0, 'misting_calibrations_zone_count_positive'],
    ['nozzle_count', -1, 'misting_calibrations_nozzle_count_nonneg'],
    ['riser_count', -1, 'misting_calibrations_riser_count_nonneg'],
    ['nozzle_flow_fl_oz_per_min', 0, 'misting_calibrations_nozzle_flow_positive'],
    ['cycle_seconds', 0, 'misting_calibrations_cycle_seconds_positive'],
    ['concentrate_fl_oz_per_tank', 0, 'misting_calibrations_concentrate_positive'],
    ['label_max_fl_oz_per_1000_cu_ft_day', 0, 'misting_calibrations_label_max_positive'],
    ['treated_area_sq_ft', 0, 'misting_calibrations_area_positive'],
    ['treated_height_ft', 0, 'misting_calibrations_height_positive'],
    ['mist_times', [], 'misting_calibrations_mist_times_present'],
    ['cabinet_locked', false, 'misting_calibrations_checks_all_true'],
    ['label_posted', false, 'misting_calibrations_checks_all_true'],
    ['schedule_avoids_people', false, 'misting_calibrations_checks_all_true'],
    ['source', 'sensor', 'misting_calibrations_source_known'],
  ])('calibration CHECK: %s = %j is refused (%s)', async (column, value, constraint) => {
    const extra = { riser_count: 5, [column]: value }; // riser keeps the nozzle row off the has-emitter check
    await expect(app(CAL).insert(calibration(customerId, extra))).rejects.toMatchObject({ code: '23514', constraint });
  });

  test('a calibration needs at least one emitter (nozzle or riser)', async () => {
    await expect(app(CAL).insert(calibration(customerId, { nozzle_count: 0, riser_count: 0 })))
      .rejects.toMatchObject({ constraint: 'misting_calibrations_has_emitter' });
    await expect(app(CAL).insert(calibration(customerId, { nozzle_count: 0, riser_count: 3 }))).resolves.toBeDefined();
  });

  test('void columns are consistent on both tables: a reason is required, and nothing half-voided', async () => {
    const [cal] = await app(CAL).insert(calibration(customerId)).returning('id');
    await expect(app(CAL).insert(calibration(customerId, { voided_at: new Date() })))
      .rejects.toMatchObject({ constraint: 'misting_calibrations_void_consistent' });
    await expect(app(CAL).insert(calibration(customerId, { void_reason: 'typo' })))
      .rejects.toMatchObject({ constraint: 'misting_calibrations_void_consistent' });
    await expect(app(CAL).insert(calibration(customerId, { voided_by: tech })))
      .rejects.toMatchObject({ constraint: 'misting_calibrations_void_consistent' });
    await expect(app(CAL).insert(calibration(customerId, { voided_at: new Date(), voided_by: tech, void_reason: 'typo' }))).resolves.toBeDefined();
    await expect(app(REF).insert(refill(customerId, cal.id, { voided_at: new Date() })))
      .rejects.toMatchObject({ constraint: 'misting_refills_void_consistent' });
    await expect(app(REF).insert(refill(customerId, cal.id, { voided_at: new Date(), void_reason: 'wrong date' }))).resolves.toBeDefined();
  });

  test.each([
    ['concentrate_fl_oz_added', 0, 'misting_refills_concentrate_positive'],
    ['water_gallons_added', 0, 'misting_refills_water_positive'],
    ['level_before_pct', -1, 'misting_refills_level_pct_range'],
    ['level_before_pct', 101, 'misting_refills_level_pct_range'],
    ['source', 'sensor', 'misting_refills_source_known'],
  ])('refill CHECK: %s = %j is refused (%s)', async (column, value, constraint) => {
    const [cal] = await app(CAL).insert(calibration(customerId)).returning('id');
    await expect(app(REF).insert(refill(customerId, cal.id, { [column]: value }))).rejects.toMatchObject({ code: '23514', constraint });
  });

  test('level before accepts 0 and 100', async () => {
    const [cal] = await app(CAL).insert(calibration(customerId)).returning('id');
    await expect(app(REF).insert(refill(customerId, cal.id, { level_before_pct: 0 }))).resolves.toBeDefined();
    await expect(app(REF).insert(refill(customerId, cal.id, { level_before_pct: 100 }))).resolves.toBeDefined();
  });

  test('foreign keys: a customer and a calibration are required; the property and technician links clear instead of blocking', async () => {
    await expect(app(CAL).insert(calibration(randomUUID()))).rejects.toMatchObject({ code: '23503' });
    await expect(app(REF).insert(refill(customerId, randomUUID()))).rejects.toMatchObject({ code: '23503' });
    const [prop] = await app('customer_properties').insert({ customer_id: customerId }).returning('id');
    const [cal] = await app(CAL).insert(calibration(customerId, { property_id: prop.id, recorded_by: tech })).returning('id');
    await app('customer_properties').where({ id: prop.id }).del();
    await app('technicians').where({ id: tech }).del();
    expect(await app(CAL).where({ id: cal.id }).first()).toMatchObject({ property_id: null, recorded_by: null });
  });

  test('deleting a customer removes its calibrations and refills; deleting a calibration removes its refills', async () => {
    const [cal] = await app(CAL).insert(calibration(customerId)).returning('id');
    await app(REF).insert(refill(customerId, cal.id));
    await app('customers').where({ id: customerId }).del();
    expect(await app(CAL).where({ customer_id: customerId })).toHaveLength(0);
    expect(await app(REF).where({ customer_id: customerId })).toHaveLength(0);

    const other = (await app('customers').insert({}).returning('id'))[0].id;
    const [cal2] = await app(CAL).insert(calibration(other)).returning('id');
    await app(REF).insert(refill(other, cal2.id));
    await app(CAL).where({ id: cal2.id }).del();
    expect(await app(REF).where({ customer_id: other })).toHaveLength(0);
  });

  test('the partial indexes exist', async () => {
    const { rows } = await app.raw("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ? AND tablename IN (?, ?)", [schema, CAL, REF]);
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.misting_calibrations_customer_recent).toMatch(/customer_id, created_at DESC\) WHERE \(voided_at IS NULL\)/);
    expect(defs.misting_refills_customer_recent).toMatch(/customer_id, refilled_on DESC\) WHERE \(voided_at IS NULL\)/);
    expect(defs.misting_refills_calibration).toMatch(/calibration_id/);
  });

  test('up() twice is a no-op, down() drops both tables (refills first), down() twice is a no-op, and up() brings them back', async () => {
    await migration.up(app);
    expect(await app.schema.hasTable(CAL)).toBe(true);
    expect(await app.schema.hasTable(REF)).toBe(true);
    await migration.down(app);
    expect(await app.schema.hasTable(REF)).toBe(false);
    expect(await app.schema.hasTable(CAL)).toBe(false);
    await migration.down(app);
    await migration.up(app);
    expect(await app.schema.hasTable(CAL)).toBe(true);
    expect(await app.schema.hasTable(REF)).toBe(true);
  });
});
