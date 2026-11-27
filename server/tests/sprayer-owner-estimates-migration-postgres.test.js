const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL. The tables live in a unique schema dropped after the suite: a minimal
// equipment_systems, equipment_calibrations and audit_log, with the three rows as read on 2026-11-27 (owner "we will use the best guess").
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261127260000_sprayer_owner_estimates');

const TANK_1 = '110-Gallon Spray Tank #1';
const TANK_2 = 'Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun';
const FLOWZONE = 'FlowZone Typhoon 3.0 #1';
const EXPIRES = '2026-12-07T14:00:00.000Z';

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('sprayer owner estimates migration on PostgreSQL', () => {
  let database;
  const schema = `sprayer_est_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.equipment (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, model text)', [schema]);
    await database.raw(`CREATE TABLE ??.equipment_systems (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      gun_asset_id uuid REFERENCES ??.equipment(id) ON DELETE SET NULL, updated_at timestamptz)`, [schema, schema]);
    await database.raw(`CREATE TABLE ??.equipment_calibrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), equipment_system_id uuid NOT NULL, active boolean NOT NULL DEFAULT true,
      carrier_gal_per_1000 numeric(6,3), calibration_status varchar(40), expires_at timestamptz, verification_notes text,
      estimated_sq_ft_per_4gal_tank integer, estimated_sq_ft_per_full_tank integer, calibrated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz)`, [schema]);
    await database.raw('CREATE UNIQUE INDEX ON ??.equipment_calibrations (equipment_system_id) WHERE active = true', [schema]);
    await database.raw(`CREATE TABLE ??.audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text, actor_id text, action varchar(96) NOT NULL, resource_type text,
      resource_id text, metadata jsonb, ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT now())`, [schema]);
  });
  afterEach(async () => {
    for (const table of ['audit_log', 'equipment_calibrations', 'equipment_systems', 'equipment']) await database(table).del();
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  async function seed(overrides = {}) {
    const rows = {
      [TANK_1]: { carrier_gal_per_1000: 2, calibration_status: 'field_verified', expires_at: EXPIRES, verification_notes: 'Tank counts.' },
      [TANK_2]: { carrier_gal_per_1000: 2, calibration_status: 'estimated', expires_at: EXPIRES, verification_notes: null },
      [FLOWZONE]: { carrier_gal_per_1000: 1.33, calibration_status: 'estimated', expires_at: EXPIRES, verification_notes: 'Old note.', estimated_sq_ft_per_4gal_tank: 3000, estimated_sq_ft_per_full_tank: 3000 },
    };
    for (const [name, values] of Object.entries(rows)) {
      const [system] = await database('equipment_systems').insert({ name }).returning('id');
      await database('equipment_calibrations').insert({ equipment_system_id: system.id, ...values, ...overrides[name] });
      // An inactive older row of the same system is never touched.
      await database('equipment_calibrations').insert({ equipment_system_id: system.id, active: false, carrier_gal_per_1000: 1.5 });
    }
  }
  const active = async (name) => database('equipment_calibrations as ec').join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where({ 'es.name': name, 'ec.active': true }).first('ec.*');

  test('up writes the three rows the owner settled, one critical audit event each; a second run changes nothing', async () => {
    await seed();
    await migration.up(database);
    expect(await active(TANK_1)).toMatchObject({ carrier_gal_per_1000: '2.000', calibration_status: 'field_verified', expires_at: null, verification_notes: 'Tank counts.' });
    expect(await active(TANK_2)).toMatchObject({
      carrier_gal_per_1000: '2.000', calibration_status: 'owner_estimate', expires_at: null,
      verification_notes: 'Owner estimate 2026-11-27: 2.0 gal per 1,000 sq ft. LESCO MAG1 metal gun (not the Chemlawn gun on tank #1); its nozzle is not recorded and sets the output. Not a sprayer test.',
    });
    expect(await active(FLOWZONE)).toMatchObject({
      carrier_gal_per_1000: '2.000', calibration_status: 'owner_estimate', expires_at: null, estimated_sq_ft_per_4gal_tank: 2000, estimated_sq_ft_per_full_tank: 2000,
      verification_notes: 'Owner estimate 2026-11-27: 2.0 gal per 1,000 sq ft, for area-rated products and area estimates. Spot products mix per gallon from the label. Not a sprayer test.',
    });
    const events = await database('audit_log').where('action', 'like', '%:calibration').select('action', 'metadata');
    expect(events).toHaveLength(3);
    for (const event of events) expect(event.action.length).toBeLessThanOrEqual(96);
    // Tank #1 changes in place; tank #2 and the FlowZone get a replacement row, and the old row (which past visits point at) keeps
    // the number and status it had.
    expect(events.find((event) => event.metadata.system_name === TANK_1).metadata.before).toEqual({ calibration_status: 'field_verified', expires_at: EXPIRES });
    const replaced = events.find((event) => event.metadata.system_name === FLOWZONE).metadata.replaced_id;
    expect(await database('equipment_calibrations').where({ id: replaced }).first()).toMatchObject({ active: false, carrier_gal_per_1000: '1.330', calibration_status: 'estimated', estimated_sq_ft_per_4gal_tank: 3000 });
    expect(await database('equipment_calibrations').where({ active: false }).count('* as n').first()).toEqual({ n: '5' });
    await migration.up(database);
    expect(await database('audit_log').where('action', 'like', '%:calibration').count('* as n').first()).toEqual({ n: '3' });
  });

  const gunOf = async (name) => database('equipment_systems as es').leftJoin('equipment as e', 'es.gun_asset_id', 'e.id').where('es.name', name).first('e.name as gun');
  const seedGuns = async () => database('equipment').insert([
    { name: 'LESCO Lawn Spray Gun', model: 'Chemlawn Spray Gun (007433)' },
    { name: 'LESCO MAG1 Original Spray Gun', model: 'MAG1 (052979)' },
    { name: 'Other gun', model: 'Other' },
  ]);

  test('each big-tank sprayer is linked to its gun by exact name, only while it has none; down clears only those links', async () => {
    await seedGuns();
    await seed();
    const other = await database('equipment').where({ name: 'Other gun' }).first('id');
    await migration.up(database);
    expect(await gunOf(TANK_1)).toEqual({ gun: 'LESCO Lawn Spray Gun' });
    expect(await gunOf(TANK_2)).toEqual({ gun: 'LESCO MAG1 Original Spray Gun' });
    expect(await gunOf(FLOWZONE)).toEqual({ gun: null });
    const gunEvents = await database('audit_log').where('action', 'like', '%:gun').select('action');
    expect(gunEvents).toHaveLength(2);
    for (const event of gunEvents) expect(event.action.length).toBeLessThanOrEqual(96);
    await migration.up(database);
    expect(await database('audit_log').where('action', 'like', '%:gun').count('* as n').first()).toEqual({ n: '2' });
    // An admin re-links tank #2 after up(): down keeps that link and clears tank #1's.
    await database('equipment_systems').where({ name: TANK_2 }).update({ gun_asset_id: other.id });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await migration.down(database);
    log.mockRestore();
    expect(await gunOf(TANK_1)).toEqual({ gun: null });
    expect(await gunOf(TANK_2)).toEqual({ gun: 'Other gun' });
  });

  test('a sprayer that already has a gun keeps it', async () => {
    await seedGuns();
    await seed();
    const other = await database('equipment').where({ name: 'Other gun' }).first('id');
    await database('equipment_systems').where({ name: TANK_1 }).update({ gun_asset_id: other.id });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await migration.up(database);
    log.mockRestore();
    expect(await gunOf(TANK_1)).toEqual({ gun: 'Other gun' });
    expect(await database('audit_log').where('action', 'like', '%:gun').count('* as n').first()).toEqual({ n: '1' });
  });

  test('a row an admin field tested at the same number is kept', async () => {
    await seed({ [TANK_2]: { calibration_status: 'field_verified', verification_notes: 'Admin field test.' } });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await migration.up(database);
    log.mockRestore();
    expect(await active(TANK_2)).toMatchObject({ carrier_gal_per_1000: '2.000', calibration_status: 'field_verified', verification_notes: 'Admin field test.' });
    expect((await active(TANK_2)).expires_at.toISOString()).toBe(EXPIRES);
  });

  test('a row an admin changed from the values read is kept and logged', async () => {
    await seed({ [FLOWZONE]: { carrier_gal_per_1000: 1.5 }, [TANK_2]: { carrier_gal_per_1000: 2.2 } });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await migration.up(database);
    expect(await active(FLOWZONE)).toMatchObject({ carrier_gal_per_1000: '1.500', calibration_status: 'estimated', estimated_sq_ft_per_4gal_tank: 3000 });
    expect(await active(TANK_2)).toMatchObject({ carrier_gal_per_1000: '2.200', calibration_status: 'estimated' });
    expect(log.mock.calls.flat().join(' ')).toMatch(/FlowZone Typhoon 3\.0 #1.*kept/);
    log.mockRestore();
    expect(await database('audit_log').where('action', 'like', '%:calibration').count('* as n').first()).toEqual({ n: '1' });
  });

  test('down restores the exact values read, except on a row an admin changed since; it never throws', async () => {
    await seed();
    await migration.up(database);
    await database('equipment_calibrations').where({ id: (await active(TANK_2)).id }).update({ verification_notes: 'Admin note.' });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await migration.down(database);
    expect(await active(TANK_1)).toMatchObject({ calibration_status: 'field_verified', verification_notes: 'Tank counts.' });
    expect((await active(TANK_1)).expires_at.toISOString()).toBe(EXPIRES);
    expect(await active(FLOWZONE)).toMatchObject({ carrier_gal_per_1000: '1.330', calibration_status: 'estimated', verification_notes: 'Old note.', estimated_sq_ft_per_full_tank: 3000 });
    expect((await active(FLOWZONE)).expires_at.toISOString()).toBe(EXPIRES);
    expect(await active(TANK_2)).toMatchObject({ calibration_status: 'owner_estimate', verification_notes: 'Admin note.' });
    await database.raw('DROP TABLE audit_log');
    await expect(migration.down(database)).resolves.toBeUndefined();
    log.mockRestore();
    await database.raw(`CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text, actor_id text, action varchar(96) NOT NULL, resource_type text,
      resource_id text, metadata jsonb, ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT now())`);
  });
});
