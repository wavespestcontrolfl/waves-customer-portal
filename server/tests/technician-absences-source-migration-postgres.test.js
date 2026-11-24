// Migration 20261124160000: technician_absences.source and system_cleared_at (explicit ownership for the days-off
// sync). Round trip on real Postgres inside one transaction that rolls back (PG DDL is transactional): up() is
// idempotent, down() removes both columns and both CHECKs and keeps the rows, a second up() brings them back, and the
// CHECKs allow exactly what the sync writes. DATABASE_URL-gated like the other *-postgres suites.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

postgres('technician_absences source migration', () => {
  let database;
  let trx;
  const migration = () => require('../models/migrations/20261124160000_technician_absences_source');
  const columns = async () => (await trx.raw(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'technician_absences' AND column_name IN ('source', 'system_cleared_at') ORDER BY column_name",
  )).rows.map((r) => r.column_name);
  const checks = async () => (await trx.raw(
    "SELECT conname FROM pg_constraint WHERE conrelid = 'technician_absences'::regclass AND contype = 'c' ORDER BY conname",
  )).rows.map((r) => r.conname);
  const refused = async (work) => {
    await trx.raw('SAVEPOINT attempt');
    let error;
    try { await work(); } catch (err) { error = err; }
    await trx.raw('ROLLBACK TO SAVEPOINT attempt');
    return error;
  };

  beforeAll(() => {
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await database.destroy(); });

  test('the migrated schema has both nullable columns and both CHECKs, and up() twice changes nothing', async () => {
    expect(await columns()).toEqual(['source', 'system_cleared_at']);
    expect(await checks()).toEqual(expect.arrayContaining(['technician_absences_source_check', 'technician_absences_system_cleared_check']));
    await migration().up(trx);
    expect(await columns()).toEqual(['source', 'system_cleared_at']);
  });

  test('down() drops both columns and both CHECKs and keeps the rows; up() brings them back empty', async () => {
    const techId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Synthetic Migration', role: 'technician', employment_status: 'active' });
    await trx('technician_absences').insert({ technician_id: techId, absence_date: '2031-03-05', reason: 'other', source: 'tech_days_off' });
    await migration().down(trx);
    expect(await columns()).toEqual([]);
    expect(await checks()).not.toContain('technician_absences_source_check');
    expect(await checks()).not.toContain('technician_absences_system_cleared_check');
    expect(await trx('technician_absences').where({ technician_id: techId })).toHaveLength(1);
    await migration().down(trx); // idempotent
    await migration().up(trx);
    expect(await columns()).toEqual(['source', 'system_cleared_at']);
    const [row] = await trx('technician_absences').where({ technician_id: techId });
    expect(row).toMatchObject({ source: null, system_cleared_at: null, reason: 'other' });
  });

  test('the CHECKs allow NULL and the sync source only, and a system clear only on a sourced, cleared row', async () => {
    const techId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Synthetic Checks', role: 'technician', employment_status: 'active' });
    const insert = (patch) => trx('technician_absences').insert({ technician_id: techId, reason: 'other', ...patch });
    await insert({ absence_date: '2031-03-01' }); // an office row: source NULL
    await insert({ absence_date: '2031-03-02', source: 'tech_days_off' });
    await insert({ absence_date: '2031-03-03', source: 'tech_days_off', cleared_at: new Date(), system_cleared_at: new Date() });
    expect((await refused(() => insert({ absence_date: '2031-03-04', source: 'office' }))).message).toMatch(/technician_absences_source_check/);
    expect((await refused(() => insert({ absence_date: '2031-03-05', system_cleared_at: new Date() }))).message).toMatch(/technician_absences_system_cleared_check/);
    expect((await refused(() => insert({ absence_date: '2031-03-06', source: 'tech_days_off', system_cleared_at: new Date() }))).message).toMatch(/technician_absences_system_cleared_check/);
  });
});
