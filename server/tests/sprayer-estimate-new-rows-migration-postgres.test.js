const SKIP = !process.env.DATABASE_URL;
// CI's DB-gated pass runs this against PostgreSQL in a unique schema dropped after the suite. The first migration writes the
// owner's estimates in place; this one moves tank #2's and the FlowZone's onto new rows, so past visits keep the old rows.
const knex = require('knex');
const { randomUUID } = require('crypto');

const first = require('../models/migrations/20261127260000_sprayer_owner_estimates');
const second = require('../models/migrations/20261127270000_sprayer_estimate_new_rows');

const TANK_1 = '110-Gallon Spray Tank #1';
const TANK_2 = 'Udor KAPPA-18/12V-HP + 110-gal tank #2 - Lawn Gun';
const FLOWZONE = 'FlowZone Typhoon 3.0 #1';
const EXPIRES = '2026-12-07T14:00:00.000Z';

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('sprayer estimate new rows migration on PostgreSQL', () => {
  let database;
  const schema = `sprayer_rows_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw('CREATE TABLE ??.equipment (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)', [schema]);
    await database.raw(`CREATE TABLE ??.equipment_systems (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      gun_asset_id uuid, updated_at timestamptz)`, [schema]);
    await database.raw(`CREATE TABLE ??.equipment_calibrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), equipment_system_id uuid NOT NULL, active boolean NOT NULL DEFAULT true,
      carrier_gal_per_1000 numeric(6,3), calibration_status varchar(40), expires_at timestamptz, verification_notes text,
      estimated_sq_ft_per_4gal_tank integer, estimated_sq_ft_per_full_tank integer, calibrated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz)`, [schema]);
    await database.raw('CREATE UNIQUE INDEX ON ??.equipment_calibrations (equipment_system_id) WHERE active = true', [schema]);
    await database.raw(`CREATE TABLE ??.audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text, actor_id text, action varchar(96) NOT NULL, resource_type text,
      resource_id text, metadata jsonb, ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT clock_timestamp())`, [schema]);
  });
  afterEach(async () => {
    for (const table of ['audit_log', 'equipment_calibrations', 'equipment_systems', 'equipment']) await database(table).del();
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const ids = {};
  async function seedAndEstimate() {
    const rows = {
      [TANK_1]: { carrier_gal_per_1000: 2, calibration_status: 'field_verified', expires_at: EXPIRES, verification_notes: 'Tank counts.' },
      [TANK_2]: { carrier_gal_per_1000: 2, calibration_status: 'estimated', expires_at: EXPIRES, verification_notes: null },
      [FLOWZONE]: { carrier_gal_per_1000: 1.33, calibration_status: 'estimated', expires_at: EXPIRES, verification_notes: 'Old note.', estimated_sq_ft_per_4gal_tank: 3000, estimated_sq_ft_per_full_tank: 3000 },
    };
    for (const [name, values] of Object.entries(rows)) {
      const [system] = await database('equipment_systems').insert({ name }).returning('id');
      const [row] = await database('equipment_calibrations').insert({ equipment_system_id: system.id, calibrated_at: '2026-11-07T14:00:00Z', ...values }).returning('id');
      ids[name] = row.id;
    }
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await first.up(database);
    log.mockRestore();
  }
  const active = (name) => database('equipment_calibrations as ec').join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where({ 'es.name': name, 'ec.active': true }).first('ec.*');
  const byId = (id) => database('equipment_calibrations').where({ id }).first();

  test('tank #2 and the FlowZone: the old row gets its exact values back and retires; a new row holds the estimate', async () => {
    await seedAndEstimate();
    await second.up(database);
    expect(await byId(ids[FLOWZONE])).toMatchObject({ active: false, carrier_gal_per_1000: '1.330', calibration_status: 'estimated', verification_notes: 'Old note.', estimated_sq_ft_per_4gal_tank: 3000 });
    expect((await byId(ids[FLOWZONE])).expires_at.toISOString()).toBe(EXPIRES);
    expect(await byId(ids[TANK_2])).toMatchObject({ active: false, calibration_status: 'estimated', verification_notes: null });
    const flowZone = await active(FLOWZONE);
    expect(flowZone.id).not.toBe(ids[FLOWZONE]);
    expect(flowZone).toMatchObject({ carrier_gal_per_1000: '2.000', calibration_status: 'owner_estimate', expires_at: null, estimated_sq_ft_per_4gal_tank: 2000 });
    expect(flowZone.calibrated_at.toISOString()).toBe('2026-11-07T14:00:00.000Z');
    expect(await active(TANK_2)).toMatchObject({ calibration_status: 'owner_estimate', expires_at: null });
    // Tank #1 only lost its expiry: same row.
    expect((await active(TANK_1)).id).toBe(ids[TANK_1]);
    const events = await database('audit_log').where('action', 'like', '%:split').select('action');
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.action.length).toBeLessThanOrEqual(96);
    await second.up(database);
    expect(await database('equipment_calibrations').count('* as n').first()).toEqual({ n: '5' });
  });

  test('a row an admin changed after the estimate is kept and logged', async () => {
    await seedAndEstimate();
    await database('equipment_calibrations').where({ id: ids[FLOWZONE] }).update({ verification_notes: 'Admin note.' });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await second.up(database);
    expect(log.mock.calls.flat().join(' ')).toMatch(/FlowZone Typhoon 3\.0 #1.*kept/);
    log.mockRestore();
    expect((await active(FLOWZONE)).id).toBe(ids[FLOWZONE]);
    expect((await active(TANK_2)).id).not.toBe(ids[TANK_2]);
  });

  test('down merges each split back, except one an admin changed since; then the first down restores the start; never throws', async () => {
    await seedAndEstimate();
    await second.up(database);
    await database('equipment_calibrations').where({ id: (await active(TANK_2)).id }).update({ verification_notes: 'Admin note.' });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await second.down(database);
    expect((await active(FLOWZONE)).id).toBe(ids[FLOWZONE]);
    expect(await active(FLOWZONE)).toMatchObject({ calibration_status: 'owner_estimate', carrier_gal_per_1000: '2.000' });
    expect((await active(TANK_2)).id).not.toBe(ids[TANK_2]);
    await first.down(database);
    expect(await active(FLOWZONE)).toMatchObject({ carrier_gal_per_1000: '1.330', calibration_status: 'estimated', estimated_sq_ft_per_4gal_tank: 3000 });
    await database.raw('DROP TABLE audit_log');
    await expect(second.down(database)).resolves.toBeUndefined();
    log.mockRestore();
    await database.raw(`CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_type text, actor_id text, action varchar(96) NOT NULL, resource_type text,
      resource_id text, metadata jsonb, ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
  });
});
