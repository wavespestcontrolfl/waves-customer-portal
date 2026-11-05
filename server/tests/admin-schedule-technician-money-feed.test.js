/**
 * Real migrated PostgreSQL, synthetic records, rolled back after every test.
 *
 * Owner ruling D2 A (2026-11-04) and audit A5 / A15: the day feed (GET /) and the week feed
 * (GET /week) give a technician the balance-due facts and the per-visit prices, but no monthly
 * rate (row or billingLane), no lead score, and no coworker roster or out-today list. An admin's
 * feed is unchanged.
 */
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  ...jest.requireActual('../services/weather-forecast'),
  getDailyRainOutlookBounded: jest.fn(async () => null),
}));

let weatherFetch;
beforeEach(() => {
  weatherFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ current: { temperature_2m: 75, wind_speed_10m: 5, precipitation_probability: 0 } }),
  });
});
afterEach(() => { weatherFetch?.mockRestore(); });

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

postgres('schedule day and week feeds strip owner-only money for a technician (PostgreSQL)', () => {
  let database;
  let trx;
  let customerId;
  let techId;
  let coworkerId;
  const DATE = '2040-02-01';

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true,
      pipeline_stage: 'active_customer', monthly_rate: 89, lead_score: 70,
    });
    techId = randomUUID();
    coworkerId = randomUUID();
    await trx('technicians').insert([
      { id: techId, name: 'Fixture Tech', active: true, employment_status: 'active', field_dispatchable: true },
      { id: coworkerId, name: 'Fixture Coworker', active: true, employment_status: 'active', field_dispatchable: true },
    ]);
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function visit() {
    const [row] = await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, technician_id: techId,
      service_type: 'Quarterly Pest Control', service_key_snapshot: 'pest_general_quarterly',
      status: 'confirmed', scheduled_date: DATE, window_start: '08:00', window_end: '10:00',
      estimated_price: 111,
    }).returning('*');
    return row;
  }

  const router = require('../routes/admin-schedule');

  async function invoke(path, { query = {}, techRole, technicianId } = {}) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods.get);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const req = { query, params: {}, headers: {}, techRole, technicianId };
    let payload = null;
    const res = { status() { return this; }, json(p) { payload = p; return this; } };
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    if (nextErr) throw nextErr;
    return payload;
  }

  const asTech = () => ({ techRole: 'technician', technicianId: techId });

  test('technician day feed: no monthlyRate or leadScore, billingLane keeps its balance facts, estimatedPrice stays', async () => {
    const v = await visit();
    const payload = await invoke('/', { query: { date: DATE }, ...asTech() });
    const found = payload.services.find((r) => r.id === v.id);
    expect(found).toBeTruthy();
    expect(found).not.toHaveProperty('monthlyRate');
    expect(found).not.toHaveProperty('leadScore');
    expect(found.billingLane).not.toHaveProperty('monthlyRate');
    expect(found.billingLane).toHaveProperty('openBalance');
    expect(found.billingLane).toHaveProperty('openInvoiceCount');
    expect(found.billingLane).toHaveProperty('hasOverdue');
    expect(found.estimatedPrice).toBe(111);
  });

  test('technician week feed: no monthlyRate on the row or in billingLane', async () => {
    const v = await visit();
    const payload = await invoke('/week', { query: { start: DATE }, ...asTech() });
    const found = payload.days.find((d) => d.date === DATE).services.find((r) => r.id === v.id);
    expect(found).toBeTruthy();
    expect(found).not.toHaveProperty('monthlyRate');
    expect(found.billingLane).not.toHaveProperty('monthlyRate');
    expect(found.billingLane).toHaveProperty('openBalance');
    expect(found.estimatedPrice).toBe(111);
  });

  test('admin day and week feeds still carry monthlyRate and leadScore', async () => {
    const v = await visit();
    const day = await invoke('/', { query: { date: DATE }, techRole: 'admin' });
    const dayRow = day.services.find((r) => r.id === v.id);
    expect(dayRow.monthlyRate).toBe(89);
    expect(dayRow.leadScore).toBe(70);
    expect(dayRow.billingLane.monthlyRate).toBe(89);
    const week = await invoke('/week', { query: { start: DATE }, techRole: 'admin' });
    const weekRow = week.days.find((d) => d.date === DATE).services.find((r) => r.id === v.id);
    expect(weekRow.monthlyRate).toBe(89);
    expect(weekRow.billingLane.monthlyRate).toBe(89);
  });

  test('technician day feed lists only the caller in technicians[]; an admin sees the coworker too', async () => {
    await visit();
    const tech = await invoke('/', { query: { date: DATE }, ...asTech() });
    expect(tech.technicians.map((t) => t.id)).toEqual([techId]);
    const admin = await invoke('/', { query: { date: DATE }, techRole: 'admin' });
    expect(admin.technicians.map((t) => t.id)).toEqual(expect.arrayContaining([techId, coworkerId]));
  });
});
