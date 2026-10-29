// GATE_TECH_TRAINING_DATES through PostgreSQL: the migration (columns, checks, unique key, cascade, up/down/up), the training-day
// routes against the real table (add, duplicate, delete, record, the licenses read and the date save), and the daily sweep's
// dedupe and close on real notifications rows. Every write runs in a transaction that is rolled back. Synthetic data only.
// The sweep writes admin bell rows and nothing else: no text, email or push. Skips without DATABASE_URL (CI runs it against the
// migrated database).
const SKIP = !process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/compliance', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; req.technicianId = mockAdminId; next(); },
  requireAdmin: (req, res, next) => next(),
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20261029120000_technician_training_dates');
const reminders = require('../services/technician-training-reminders');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
let mockAdminId = randomUUID();
let server;
let baseUrl;
const GATE = 'GATE_TECH_TRAINING_DATES';

describeDb('Technician training dates (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
    const app = express();
    app.use(express.json());
    app.use('/api/admin/compliance-v2', require('../routes/admin-compliance-v2'));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/compliance-v2`;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    process.env[GATE] = 'true';
    mockAdminId = randomUUID();
    await mockPg('technicians').insert({ id: mockAdminId, name: 'Fixture admin', role: 'admin' });
  });
  afterEach(async () => { delete process.env[GATE]; const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => {
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (database) await database.destroy();
  });

  const call = async (method, url, body) => {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const employee = async (over = {}) => {
    const id = randomUUID();
    await mockPg('technicians').insert({ id, name: 'Fixture employee', hire_date: '2026-10-01', role: 'technician', ...over });
    return id;
  };
  const day = (over = {}) => ({ training_date: '2026-10-02', hours: 8, category: 'GHP', topics: 'Label reading, PPE', trainer_name: 'Fixture operator', materials: 'SDS', ...over });
  const bells = (techId) => mockPg('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' LIKE ?", [`tech-training:%:${techId}:%`]).orderBy('created_at');

  describe('migration', () => {
    test('adds four date columns and the training-days table with its checks, unique key and cascade', async () => {
      const columns = await mockPg('information_schema.columns').where({ table_name: 'technicians' })
        .whereIn('column_name', ['id_card_applied_on', 'id_card_issued_on', 'classroom_hours_done_on', 'renewal_training_done_on']).select('column_name', 'data_type', 'is_nullable');
      expect(columns).toHaveLength(4);
      expect(columns.every((c) => c.data_type === 'date' && c.is_nullable === 'YES')).toBe(true);

      const id = await employee();
      const insert = (over) => mockPg('technician_training_days').insert({ technician_id: id, training_date: '2026-10-02', hours: 8, category: 'GHP', topics: 't', trainer_name: 'x', ...over });
      await insert({});
      const attempt = async (over) => { await mockPg.raw('SAVEPOINT s'); try { await insert(over); } catch (err) { await mockPg.raw('ROLLBACK TO SAVEPOINT s'); return err.constraint || err.code; } await mockPg.raw('RELEASE SAVEPOINT s'); return null; };
      expect(await attempt({})).toBe('technician_training_days_day_category_uniq');
      expect(await attempt({ training_date: '2026-10-03', hours: 0 })).toBe('technician_training_days_hours_check');
      expect(await attempt({ training_date: '2026-10-03', hours: 16.01 })).toBe('technician_training_days_hours_check');
      expect(await attempt({ training_date: '2026-10-03', category: 'Rodent' })).toBe('technician_training_days_category_check');
      expect(await attempt({ training_date: '2026-10-03', topics: null })).toBe('23502');
      expect(await attempt({ training_date: '2026-10-03', category: 'L&O' })).toBeNull();
      expect(await attempt({ training_date: '2026-10-03', category: 'Termite/WDO', hours: 16 })).toBeNull();

      await mockPg('technicians').where({ id }).del();
      expect(Number((await mockPg('technician_training_days').where({ technician_id: id }).count('* as n').first()).n)).toBe(0);
    });

    test('down removes only what this migration added, and up restores it (idempotent)', async () => {
      await migration.down(mockPg);
      expect(await mockPg.schema.hasTable('technician_training_days')).toBe(false);
      expect(await mockPg.schema.hasColumn('technicians', 'id_card_issued_on')).toBe(false);
      expect(await mockPg.schema.hasColumn('technicians', 'hire_date')).toBe(true);
      await migration.up(mockPg);
      await migration.up(mockPg);
      expect(await mockPg.schema.hasTable('technician_training_days')).toBe(true);
      expect(await mockPg.schema.hasColumn('technicians', 'renewal_training_done_on')).toBe(true);
    });
  });

  describe('routes', () => {
    test('add, list in date order, duplicate, delete, and the printable record', async () => {
      const id = await employee();
      expect((await call('POST', `/licenses/${id}/training-days`, day({ training_date: '2026-10-05', topics: 'Termite biology', category: 'Termite/WDO', hours: 7.5 }))).status).toBe(201);
      const first = await call('POST', `/licenses/${id}/training-days`, day());
      expect(first.status).toBe(201);
      expect(first.body.day).toMatchObject({ trainingDate: '2026-10-02', hours: 8, category: 'GHP', trainerName: 'Fixture operator', createdBy: mockAdminId });
      expect((await call('POST', `/licenses/${id}/training-days`, day())).status).toBe(409);
      expect((await call('POST', `/licenses/${randomUUID()}/training-days`, day())).status).toBe(404);

      const list = await call('GET', `/licenses/${id}/training-days`);
      expect(list.body.days.map((d) => d.trainingDate)).toEqual(['2026-10-02', '2026-10-05']);
      expect(list.body.summary).toMatchObject({ days: 2, hours: 15.5, categories: ['GHP', 'Termite/WDO'], fiveDaysDone: false });

      const record = await call('GET', `/licenses/${id}/training-record`);
      expect(record.body.technician).toMatchObject({ id, name: 'Fixture employee', hireDate: '2026-10-01' });
      expect(record.body.totals).toMatchObject({ days: 2, hours: 15.5 });
      expect(record.body.signatures[0].role).toBe('Certified operator in charge');

      expect((await call('DELETE', `/licenses/${randomUUID()}/training-days/${first.body.day.id}`)).status).toBe(404);
      expect((await call('DELETE', `/licenses/${id}/training-days/${first.body.day.id}`)).status).toBe(200);
      expect((await call('GET', `/licenses/${id}/training-days`)).body.days).toHaveLength(1);
    });

    test('GET /licenses carries the blocks for an employee and nothing new for a row with no hire date; the dates save and read back', async () => {
      const id = await employee({ license_expiry: '2027-06-30' });
      const owner = await employee({ name: 'Fixture owner', hire_date: null });
      for (const d of ['02', '03', '04', '05', '06']) await call('POST', `/licenses/${id}/training-days`, day({ training_date: `2026-10-${d}` }));

      const saved = await call('PUT', `/licenses/${id}`, { id_card_applied_on: '2026-10-20', id_card_issued_on: '2026-10-27', classroom_hours_done_on: null, renewal_training_done_on: '2026-10-28' });
      expect(saved.status).toBe(200);
      expect(saved.body.technician).toMatchObject({ idCardAppliedOn: '2026-10-20', idCardIssuedOn: '2026-10-27', classroomHoursDoneOn: null, renewalTrainingDoneOn: '2026-10-28' });

      const { body } = await call('GET', '/licenses');
      const row = body.technicians.find((t) => t.id === id);
      expect(row.training).toEqual({ days: 5, hours: 40, categories: ['GHP'], fiveDaysDone: true, fortyHoursDone: true });
      expect(row.idCard).toMatchObject({ appliedOn: '2026-10-20', applicationDueOn: '2026-10-31', issuedOn: '2026-10-27', status: 'done' });
      expect(row.classroom).toMatchObject({ dueOn: '2027-04-27', doneOn: null });
      expect(row.renewalTraining).toMatchObject({ dueBy: '2027-06-30', doneOn: '2026-10-28' });
      const ownerRow = body.technicians.find((t) => t.id === owner);
      expect(ownerRow).not.toHaveProperty('idCard');
      expect(ownerRow).not.toHaveProperty('training');
    });

    test('with the gate off the same read carries none of it and the dates are refused', async () => {
      const id = await employee();
      delete process.env[GATE];
      const { body } = await call('GET', '/licenses');
      expect(body.technicians.find((t) => t.id === id)).not.toHaveProperty('idCard');
      expect((await call('PUT', `/licenses/${id}`, { id_card_applied_on: '2026-10-20' })).status).toBe(400);
      expect((await call('POST', `/licenses/${id}/training-days`, day())).status).toBe(404);
    });
  });

  describe('daily sweep', () => {
    test('rings once per technician and deadline, dedupes a second run, escalates a stage, and closes when the date is entered', async () => {
      const id = await employee({ hire_date: '2026-10-01' });
      const run = (today, extra = {}) => reminders.runTechnicianTrainingReminders({ today, ...extra });

      // Oct 20: 11 days left, the 14-day stage.
      expect(await run('2026-10-20')).toMatchObject({ raised: 1, closed: 0 });
      expect((await bells(id)).length).toBe(1);
      expect(await run('2026-10-20')).toMatchObject({ raised: 0, closed: 0 });
      expect((await bells(id)).length).toBe(1);
      const [first] = await bells(id);
      expect(first).toMatchObject({ category: 'system', done_at: null });
      expect(first.title).toMatch(/^System — .*Fixture employee/);
      expect(first.link).toBe('/admin/compliance?tab=licenses');

      // Oct 29: the 3-day stage rings its own bell and the 14-day bell closes.
      expect(await run('2026-10-29')).toMatchObject({ raised: 1, closed: 1 });
      const afterEscalation = await bells(id);
      expect(afterEscalation.length).toBe(2);
      expect(afterEscalation.filter((b) => !b.done_at).map((b) => b.metadata.stage)).toEqual(['d3']);

      // The card application is entered: the standing bell closes right away, with nothing new raised.
      await mockPg('technicians').where({ id }).update({ id_card_applied_on: '2026-10-28' });
      expect(await run('2026-10-29', { technicianId: id, closeOnly: true })).toMatchObject({ raised: 0, closed: 1 });
      expect((await bells(id)).every((b) => b.done_at)).toBe(true);
      expect(await run('2026-11-05')).toMatchObject({ raised: 0 });
    });

    test('a date cleared after its reminder closed rings that reminder again on the next sweep', async () => {
      const id = await employee({ hire_date: '2026-10-01' });
      const run = (today, extra = {}) => reminders.runTechnicianTrainingReminders({ today, ...extra });
      expect(await run('2026-10-29')).toMatchObject({ raised: 1 });
      await mockPg('technicians').where({ id }).update({ id_card_applied_on: '2026-10-28' });
      expect(await run('2026-10-29', { technicianId: id, closeOnly: true })).toMatchObject({ raised: 0, closed: 1 });
      expect((await bells(id)).every((b) => b.done_at)).toBe(true);
      // The date was a mistake and is cleared: the same reminder (same day, same stage) comes back.
      await mockPg('technicians').where({ id }).update({ id_card_applied_on: null });
      expect(await run('2026-10-29')).toMatchObject({ raised: 1 });
      expect((await bells(id)).filter((b) => !b.done_at).map((b) => b.metadata.stage)).toEqual(['d3']);
    });

    test('gate off writes nothing, and an inactive employee, a row with no hire date and a far-off deadline raise nothing', async () => {
      const inactive = await employee({ active: false, employment_status: 'inactive' });
      const owner = await employee({ hire_date: null });
      const far = await employee({ hire_date: '2026-10-19' });
      expect(await reminders.runTechnicianTrainingReminders({ today: '2026-10-20' })).toMatchObject({ raised: 0 });
      for (const id of [inactive, owner, far]) expect((await bells(id)).length).toBe(0);
      delete process.env[GATE];
      expect(await reminders.runTechnicianTrainingReminders({ today: '2026-10-29' })).toEqual({ skipped: 'gate_off' });
    });
  });
});
