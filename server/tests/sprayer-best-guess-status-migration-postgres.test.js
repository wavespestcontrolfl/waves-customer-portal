const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL in a unique schema dropped after the suite, with the three sprayers as read
// live on 2026-11-27 (owner: "We will use the best guess").
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261128120000_sprayer_best_guess_status');

const TANK_1 = '110-Gallon Spray Tank #1';
const TANK_2 = 'Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun';
const FLOWZONE = 'FlowZone Typhoon 3.0 #1';
const EXPIRES = '2026-12-07T14:00:00.000Z';
const AUDIT_TABLE = `CREATE TABLE ??.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text, actor_id text, action varchar(96) NOT NULL, resource_type text,
  resource_id uuid, metadata jsonb, ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT clock_timestamp())`;

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('sprayer best guess migration on PostgreSQL', () => {
  let database;
  const schema = `sprayer_guess_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.equipment (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, model text)', [schema]);
    await database.raw(`CREATE TABLE ??.equipment_systems (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      tank_capacity_gal numeric(8,2), gun_asset_id uuid, active boolean NOT NULL DEFAULT true, updated_at timestamptz)`, [schema]);
    await database.raw(`CREATE TABLE ??.equipment_calibrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), equipment_system_id uuid NOT NULL, active boolean NOT NULL DEFAULT true,
      carrier_gal_per_1000 numeric(6,3), calibration_status varchar(40), expires_at timestamptz, verification_notes text,
      estimated_sq_ft_per_4gal_tank numeric(10,2), estimated_sq_ft_per_full_tank numeric(12,2), estimated_acres_per_full_tank numeric(8,3),
      tank_size_gallons numeric(8,2), pressure_psi numeric, calibrated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz)`, [schema]);
    await database.raw('CREATE UNIQUE INDEX ON ??.equipment_calibrations (equipment_system_id) WHERE active = true', [schema]);
    await database.raw(`CREATE TABLE ??.lawn_protocol_service_completions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), calibration_id uuid)`, [schema]);
    await database.raw(`CREATE TABLE ??.scheduled_services (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text, assigned_calibration_id uuid)`, [schema]);
    await database.raw(AUDIT_TABLE, [schema]);
  });
  afterEach(async () => {
    for (const table of ['audit_log', 'scheduled_services', 'lawn_protocol_service_completions', 'equipment_calibrations', 'equipment_systems', 'equipment']) await database(table).del();
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const ids = {};
  async function seed(overrides = {}) {
    const rows = {
      [TANK_1]: [110, { carrier_gal_per_1000: 2, calibration_status: 'field_verified', expires_at: EXPIRES, verification_notes: 'Tank counts.' }],
      [TANK_2]: [110, { carrier_gal_per_1000: 2, calibration_status: 'estimated_not_field_verified', expires_at: EXPIRES, estimated_sq_ft_per_full_tank: 55000, estimated_acres_per_full_tank: 1.263, tank_size_gallons: 110, pressure_psi: 200 }],
      [FLOWZONE]: [4, { carrier_gal_per_1000: 1.33, calibration_status: 'estimated_not_field_verified', expires_at: EXPIRES, verification_notes: 'Old note.', estimated_sq_ft_per_4gal_tank: 3000, estimated_sq_ft_per_full_tank: 3000 }],
    };
    for (const [name, [tank, values]] of Object.entries(rows)) {
      const [system] = await database('equipment_systems').insert({ name, tank_capacity_gal: tank }).returning('id');
      const [row] = await database('equipment_calibrations').insert({ equipment_system_id: system.id, calibrated_at: '2026-11-07T14:00:00Z', ...values, ...overrides[name] }).returning('id');
      ids[name] = row.id;
    }
    await database('equipment').insert([{ name: 'LESCO Lawn Spray Gun', model: 'Chemlawn Spray Gun (007433)' }, { name: 'LESCO MAG1 Original Spray Gun', model: 'MAG1 (052979)' }]);
  }
  const active = (name) => database('equipment_calibrations as ec').join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where({ 'es.name': name, 'es.active': true, 'ec.active': true }).first('ec.*');
  const byId = (id) => database('equipment_calibrations').where({ id }).first();
  const gunOf = (name) => database('equipment_systems as es').leftJoin('equipment as e', 'es.gun_asset_id', 'e.id').where({ 'es.name': name, 'es.active': true }).first('e.name as gun');
  const quiet = () => jest.spyOn(console, 'log').mockImplementation(() => {});
  const count = async (table) => Number((await database(table).count('* as n').first()).n);

  test('fresh up: tank #1 loses only its expiry; tank #2 and the FlowZone get new rows, the old rows retired as they were; guns linked', async () => {
    await seed();
    await migration.up(database);
    expect(await active(TANK_1)).toMatchObject({ id: ids[TANK_1], carrier_gal_per_1000: '2.000', calibration_status: 'field_verified', expires_at: null, verification_notes: 'Tank counts.' });
    const tank2 = await active(TANK_2);
    expect(tank2.id).not.toBe(ids[TANK_2]);
    expect(tank2).toMatchObject({
      carrier_gal_per_1000: '4.000', calibration_status: 'owner_estimate', expires_at: null, pressure_psi: '200',
      estimated_sq_ft_per_full_tank: '27500.00', estimated_acres_per_full_tank: '0.631', estimated_sq_ft_per_4gal_tank: null,
      verification_notes: expect.stringMatching(/^Owner estimate 2026-11-27: 4\.0 gal per 1,000 sq ft\. LESCO MAG1 .*Not a sprayer test\.$/),
    });
    expect(await active(FLOWZONE)).toMatchObject({ carrier_gal_per_1000: '2.000', calibration_status: 'owner_estimate', expires_at: null, estimated_sq_ft_per_4gal_tank: '2000.00', estimated_sq_ft_per_full_tank: '2000.00' });
    expect(await byId(ids[TANK_2])).toMatchObject({ active: false, carrier_gal_per_1000: '2.000', calibration_status: 'estimated_not_field_verified', estimated_sq_ft_per_full_tank: '55000.00' });
    expect((await byId(ids[FLOWZONE])).expires_at.toISOString()).toBe(EXPIRES);
    expect(await byId(ids[FLOWZONE])).toMatchObject({ active: false, carrier_gal_per_1000: '1.330', verification_notes: 'Old note.' });
    expect(await gunOf(TANK_1)).toEqual({ gun: 'LESCO Lawn Spray Gun' });
    expect(await gunOf(TANK_2)).toEqual({ gun: 'LESCO MAG1 Original Spray Gun' });
    const events = await database('audit_log').select('action', 'metadata');
    expect(events).toHaveLength(5);
    for (const event of events) expect(event.action.length).toBeLessThanOrEqual(96);
    const tank2Event = events.find((event) => event.metadata.system_name === TANK_2 && event.metadata.new_id);
    expect(tank2Event.metadata).toMatchObject({ new_id: tank2.id, old_id: ids[TANK_2], old_row: { carrier_gal_per_1000: '2.000', calibration_status: 'estimated_not_field_verified' } });
  });

  test('a second up changes nothing', async () => {
    await seed();
    await migration.up(database);
    const log = quiet();
    await migration.up(database);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    expect(await count('audit_log')).toBe(5);
    expect(await count('equipment_calibrations')).toBe(5);
  });

  test('a field test (or any other state) is kept and logged; tank #1 not field verified keeps its expiry', async () => {
    await seed({ [TANK_2]: { calibration_status: 'field_verified' }, [FLOWZONE]: { carrier_gal_per_1000: 1.5 }, [TANK_1]: { calibration_status: 'estimated_not_field_verified' } });
    const log = quiet();
    await migration.up(database);
    expect(log.mock.calls.flat().join('\n')).toMatch(/tank #2 - Lawn Gun" is field_verified at 2\.000, not estimated_not_field_verified at 2: kept/);
    log.mockRestore();
    for (const name of [TANK_1, TANK_2, FLOWZONE]) expect((await active(name)).id).toBe(ids[name]);
    expect((await active(TANK_2)).calibration_status).toBe('field_verified');
    expect((await active(TANK_1)).expires_at.toISOString()).toBe(EXPIRES);
    expect(await count('equipment_calibrations')).toBe(3);
  });

  test('down undoes every change; an admin edit, or a visit on the new row, keeps that change; it never throws', async () => {
    await seed();
    await migration.up(database);
    const log = quiet();
    // An admin edits the FlowZone's new number; a visit is completed on tank #2's new row.
    await database('equipment_calibrations').where({ id: (await active(FLOWZONE)).id }).update({ verification_notes: 'Admin note.' });
    const tank2New = (await active(TANK_2)).id;
    await database('lawn_protocol_service_completions').insert({ calibration_id: tank2New });
    await migration.down(database);
    expect(await active(TANK_1)).toMatchObject({ id: ids[TANK_1] });
    expect((await active(TANK_1)).expires_at.toISOString()).toBe(EXPIRES);
    expect((await active(FLOWZONE)).verification_notes).toBe('Admin note.');
    expect((await active(TANK_2)).id).toBe(tank2New);
    expect(await gunOf(TANK_1)).toEqual({ gun: null });
    await database.raw('DROP TABLE audit_log');
    await expect(migration.down(database)).resolves.toBeUndefined();
    log.mockRestore();
    await database.raw(AUDIT_TABLE, [schema]);
  });

  test('down keeps a new row an admin edited in a copied field (pressure), not only the fields up() wrote', async () => {
    await seed();
    await migration.up(database);
    const tank2New = (await active(TANK_2)).id;
    await database('equipment_calibrations').where({ id: tank2New }).update({ pressure_psi: 180, updated_at: database.fn.now() });
    const log = quiet();
    await migration.down(database);
    log.mockRestore();
    expect((await active(TANK_2)).id).toBe(tank2New);
    expect((await active(FLOWZONE)).id).toBe(ids[FLOWZONE]);
  });

  test('a retired system of the same name (with an active row) is left alone; only the live rig changes', async () => {
    await seed();
    const [retired] = await database('equipment_systems').insert({ name: TANK_2, tank_capacity_gal: 110, active: false }).returning('id');
    const [oldRow] = await database('equipment_calibrations').insert({ equipment_system_id: retired.id, carrier_gal_per_1000: 2, calibration_status: 'estimated_not_field_verified', expires_at: EXPIRES }).returning('id');
    await migration.up(database);
    expect(await byId(oldRow.id)).toMatchObject({ active: true, carrier_gal_per_1000: '2.000', calibration_status: 'estimated_not_field_verified' });
    expect(await active(TANK_2)).toMatchObject({ carrier_gal_per_1000: '4.000', calibration_status: 'owner_estimate' });
    expect(await gunOf(TANK_2)).toEqual({ gun: 'LESCO MAG1 Original Spray Gun' });
    expect((await database('equipment_systems').where({ id: retired.id }).first()).gun_asset_id).toBeNull();
  });

  test('a pending visit on the retired row moves to the new row and back on down; a completed visit keeps its row', async () => {
    await seed();
    const [pending] = await database('scheduled_services').insert({ status: 'confirmed', assigned_calibration_id: ids[TANK_2] }).returning('id');
    const [unset] = await database('scheduled_services').insert({ status: null, assigned_calibration_id: ids[TANK_2] }).returning('id');
    const [completed] = await database('scheduled_services').insert({ status: 'completed', assigned_calibration_id: ids[TANK_2] }).returning('id');
    const [skipped] = await database('scheduled_services').insert({ status: 'skipped', assigned_calibration_id: ids[TANK_2] }).returning('id');
    await migration.up(database);
    const tank2New = (await active(TANK_2)).id;
    const rig = async (visit) => (await database('scheduled_services').where({ id: visit.id }).first()).assigned_calibration_id;
    expect([await rig(pending), await rig(unset), await rig(completed), await rig(skipped)]).toEqual([tank2New, tank2New, ids[TANK_2], ids[TANK_2]]);
    await migration.down(database);
    expect((await active(TANK_2)).id).toBe(ids[TANK_2]);
    expect([await rig(pending), await rig(unset), await rig(completed)]).toEqual([ids[TANK_2], ids[TANK_2], ids[TANK_2]]);
  });

  test('a moved visit completed before down keeps the new row (and so does the change)', async () => {
    await seed();
    const [pending] = await database('scheduled_services').insert({ status: 'confirmed', assigned_calibration_id: ids[TANK_2] }).returning('id');
    await migration.up(database);
    const tank2New = (await active(TANK_2)).id;
    await database('scheduled_services').where({ id: pending.id }).update({ status: 'completed' });
    const log = quiet();
    await migration.down(database);
    log.mockRestore();
    expect((await active(TANK_2)).id).toBe(tank2New);
    expect((await database('scheduled_services').where({ id: pending.id }).first()).assigned_calibration_id).toBe(tank2New);
    expect((await active(FLOWZONE)).id).toBe(ids[FLOWZONE]);
    expect(await database('audit_log').where('action', 'like', '%:down').first('resource_type')).toEqual({ resource_type: 'migration_run' });
  });

  test('a step that fails (not one kept on purpose) leaves the run open: the next down tries it again', async () => {
    await seed();
    await migration.up(database);
    await database.raw('ALTER TABLE equipment_systems RENAME COLUMN gun_asset_id TO gun_held');
    const log = quiet();
    await migration.down(database);
    expect(log.mock.calls.flat().join('\n')).toMatch(/down: gun:.* failed/);
    expect(await database('audit_log').where('action', 'like', '%:down').first()).toBeUndefined();
    await database.raw('ALTER TABLE equipment_systems RENAME COLUMN gun_held TO gun_asset_id');
    expect(await gunOf(TANK_2)).toEqual({ gun: 'LESCO MAG1 Original Spray Gun' });
    await migration.down(database);
    log.mockRestore();
    expect(await gunOf(TANK_2)).toEqual({ gun: null });
    expect((await active(TANK_2)).id).toBe(ids[TANK_2]);
    expect(await database('audit_log').where('action', 'like', '%:down').first('resource_type')).toEqual({ resource_type: 'migration_run' });
  });

  test('down undoes only the newest run, once: an owner change after an earlier down stays', async () => {
    await seed();
    await migration.up(database);
    await migration.down(database);
    // The owner links the gun himself and clears tank #1's expiry on purpose.
    const gun = await database('equipment').where({ name: 'LESCO MAG1 Original Spray Gun' }).first('id');
    await database('equipment_systems').where({ name: TANK_2 }).update({ gun_asset_id: gun.id });
    await database('equipment_calibrations').where({ id: ids[TANK_1] }).update({ expires_at: null });
    const log = quiet();
    await migration.down(database);
    expect(await gunOf(TANK_2)).toEqual({ gun: 'LESCO MAG1 Original Spray Gun' });
    expect((await active(TANK_1)).expires_at).toBeNull();
    // A new run that skips the gun (already set) and the expiry (already none): its down leaves both.
    await migration.up(database);
    await migration.down(database);
    log.mockRestore();
    expect(await gunOf(TANK_2)).toEqual({ gun: 'LESCO MAG1 Original Spray Gun' });
    expect((await active(TANK_1)).expires_at).toBeNull();
    expect((await active(TANK_2)).id).toBe(ids[TANK_2]);
  });

  test('up, down, up: the first down restores the start exactly, and the second up writes it again', async () => {
    await seed();
    await migration.up(database);
    await migration.down(database);
    expect(await count('equipment_calibrations')).toBe(3);
    for (const name of [TANK_1, TANK_2, FLOWZONE]) expect((await active(name)).id).toBe(ids[name]);
    expect(await active(FLOWZONE)).toMatchObject({ carrier_gal_per_1000: '1.330', calibration_status: 'estimated_not_field_verified', estimated_sq_ft_per_4gal_tank: '3000.00' });
    expect((await active(TANK_1)).expires_at.toISOString()).toBe(EXPIRES);
    expect(await gunOf(TANK_2)).toEqual({ gun: null });
    await migration.up(database);
    expect(await active(TANK_2)).toMatchObject({ carrier_gal_per_1000: '4.000', calibration_status: 'owner_estimate' });
    expect(await active(TANK_1)).toMatchObject({ expires_at: null });
    expect(await gunOf(TANK_2)).toEqual({ gun: 'LESCO MAG1 Original Spray Gun' });
    // A second down after the reapply undoes the newest run, not the first one's events.
    await migration.down(database);
    for (const name of [TANK_1, TANK_2, FLOWZONE]) expect((await active(name)).id).toBe(ids[name]);
    expect(await count('equipment_calibrations')).toBe(3);
  });
});
