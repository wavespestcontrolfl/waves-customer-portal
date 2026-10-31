/**
 * Territories by ZIP, build 3 (GATE_TERRITORY_READOUT) on real PostgreSQL: the read-out query runs
 * against the migrated schema, and the Team-tab route answers 404 while the gate is off.
 *
 * DB-gated: skips without DATABASE_URL, runs in CI against the migrated database. Reads only.
 */
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const db = require('../models/db');
const { territoryReadout } = require('../services/territory');

const router = SKIP ? null : require('../routes/admin-timetracking');

async function getReadout() {
  const layer = router.stack.find((l) => l.route?.path === '/territory-readout' && l.route.methods.get);
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  let error;
  await layer.route.stack[layer.route.stack.length - 1].handle({ query: {} }, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}

describeDb('territory read-out (Postgres)', () => {
  const prior = process.env.GATE_TERRITORY_READOUT;
  afterAll(async () => {
    if (prior === undefined) delete process.env.GATE_TERRITORY_READOUT; else process.env.GATE_TERRITORY_READOUT = prior;
    await db.destroy();
  });

  test('the query runs on the migrated schema (a window with no visits reads no rows)', async () => {
    await expect(territoryReadout(db, { today: '2099-01-05', ahead: '2099-02-02', back: '2098-12-08' })).resolves.toEqual([]);
  });

  test('counts booked and done stops per technician and area: siblings once in one area, never a hold or a reschedule placeholder', async () => {
    const { randomUUID } = require('node:crypto');
    const trx = await db.transaction();
    try {
      const techId = randomUUID();
      const customerId = randomUUID();
      await trx('technicians').insert({
        id: techId, name: `Readout ${techId.slice(0, 8)}`, email: `${techId}@example.invalid`,
        password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true, employment_status: 'active', field_dispatchable: true,
      });
      // The customer's own ZIP is in Bradenton West; the serviced property is in Venice.
      await trx('customers').insert({
        id: customerId, first_name: 'Synthetic', last_name: 'Fixture', email: `${customerId}@example.invalid`,
        phone: '+19415550101', address_line1: '100 Fixture Way', city: 'Bradenton', state: 'FL', zip: '34209',
      });
      const visit = (date, status, extra = {}) => ({
        id: randomUUID(), customer_id: customerId, technician_id: techId, scheduled_date: date, status,
        service_type: 'General Pest Control', service_address_zip: '34293', window_start: '09:00', window_end: '10:00', ...extra,
      });
      await trx('scheduled_services').insert([
        visit('2099-01-06', 'confirmed'),
        // A sibling service at the same slot (pest + mosquito) with no service ZIP stamped: the same
        // stop, in the stamped sibling's area, not the customer's.
        visit('2099-01-06', 'confirmed', { service_type: 'Mosquito Control', service_address_zip: null }),
        visit('2098-12-20', 'completed'),
        // No service ZIP on any row of the stop: the customer's ZIP places it.
        visit('2098-12-21', 'completed', { service_address_zip: null }),
        // An estimate hold: no customer yet, an expiry. Not a stop.
        visit('2099-01-07', 'pending', { customer_id: null, reservation_expires_at: '2099-01-01T12:00:00Z' }),
        // A customer-portal reschedule request's placeholder at the old slot. Not a stop.
        visit('2099-01-08', 'rescheduled'),
      ]);
      const rows = await territoryReadout(trx, { today: '2099-01-05', ahead: '2099-02-02', back: '2098-12-08' });
      const name = `Readout ${techId.slice(0, 8)}`;
      expect(rows.filter((row) => row.technicianId === techId)).toEqual([
        { technicianId: techId, technicianName: name, area: 'bradenton_west', areaLabel: 'Bradenton West', booked: 0, done: 1 },
        { technicianId: techId, technicianName: name, area: 'venice', areaLabel: 'Venice', booked: 1, done: 1 },
      ]);
    } finally {
      await trx.rollback();
    }
  });

  test('gate off: 404; gate on: the weeks and the rows', async () => {
    delete process.env.GATE_TERRITORY_READOUT;
    expect((await getReadout()).statusCode).toBe(404);
    process.env.GATE_TERRITORY_READOUT = 'true';
    const res = await getReadout();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ weeks: 4 });
    expect(Array.isArray(res.body.rows)).toBe(true);
  });
});
