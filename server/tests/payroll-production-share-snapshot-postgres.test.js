// Real PostgreSQL, TWO REAL CONNECTIONS (no rollback harness): the production share credit inputs of a whole pay run are read in
// one REPEATABLE READ, read-only transaction (payroll-production-share.js readInputs), so a stop that another connection moves
// from one technician to another between two technicians' reads is credited to exactly one of them. A control run with plain
// READ COMMITTED reads shows the same move being missed by both. Creates its own synthetic rows and deletes them at the end.
// DATABASE_URL-gated like the other *-postgres suites.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { randomUUID } = require('node:crypto');
const productionShare = require('../services/production-share');
const productionSharePay = require('../services/payroll-production-share');

jest.setTimeout(60000);

const W = '2026-09-14'; // Monday
const noon = (date) => `${date}T16:00:00Z`;

postgres('production share credit snapshot (two real connections)', () => {
  let database;
  const OLD = process.env.GATE_PAYROLL_PRODUCTION_SHARE;
  const made = { technicians: [], customers: [], visits: [] };

  const tech = async (name) => {
    const id = randomUUID();
    await database('technicians').insert({ id, name, employment_type: 'w2', employment_status: 'active', pay_rate: '20.00' });
    await database('production_share_settings').insert({
      technician_id: id, from_week: '2026-01-05', rate_bps: 1500, bar_type: 'per_shift', bar_cents: 90000, callback_stop_value_cents: 9500,
    });
    made.technicians.push(id);
    return id;
  };
  const stop = async (technicianId, date, price) => {
    const customerId = randomUUID();
    await database('customers').insert({ id: customerId, first_name: 'Sample', phone: `+1941${Math.floor(1e6 + Math.random() * 8e6)}` });
    made.customers.push(customerId);
    const id = randomUUID();
    await database('scheduled_services').insert({
      id, customer_id: customerId, technician_id: technicianId, scheduled_date: date, service_type: 'General Pest Control',
      status: 'completed', completed_at: noon(date), estimated_price: price,
    });
    await database('service_records').insert({
      customer_id: customerId, technician_id: technicianId, service_date: date, service_type: 'General Pest Control',
      scheduled_service_id: id, status: 'completed', structured_notes: JSON.stringify({ visitOutcome: 'completed' }),
    });
    made.visits.push(id);
    return id;
  };
  const idsIn = (inputs) => [...inputs.values()].flatMap((input) => (input.stops || []).map((row) => row.visitId));

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    process.env.GATE_PAYROLL_PRODUCTION_SHARE = 'true';
  });
  afterAll(async () => {
    if (OLD === undefined) delete process.env.GATE_PAYROLL_PRODUCTION_SHARE; else process.env.GATE_PAYROLL_PRODUCTION_SHARE = OLD;
    if (database) {
      await database('service_records').whereIn('scheduled_service_id', made.visits).del();
      await database('scheduled_services').whereIn('id', made.visits).del();
      await database('customers').whereIn('id', made.customers).del();
      await database('production_share_settings').whereIn('technician_id', made.technicians).del();
      await database('technicians').whereIn('id', made.technicians).del();
      await database.destroy();
    }
  });
  afterEach(() => jest.restoreAllMocks());

  // Two technicians, read in id order. After the FIRST technician's credits are read, another connection commits the move of one
  // stop from the second technician to the first.
  async function setup() {
    const a = await tech('Sample Alpha');
    const b = await tech('Sample Bravo');
    const [first, second] = [a, b].sort();
    await stop(first, W, '1000.00');
    const moving = await stop(second, W, '1200.00');
    await stop(second, W, '800.00');
    return { first, second, moving };
  }
  const moveAfterFirstRead = ({ first, moving }) => {
    const real = productionShare.weekCredits;
    let reads = 0;
    return jest.spyOn(productionShare, 'weekCredits').mockImplementation(async (conn, id, week, options) => {
      const rows = await real(conn, id, week, options);
      reads += 1;
      if (reads === 1) await database('scheduled_services').where({ id: moving }).update({ technician_id: first });
      return rows;
    });
  };

  it('a stop moved between two technicians mid-run is credited to exactly one of them (one REPEATABLE READ snapshot)', async () => {
    const world = await setup();
    moveAfterFirstRead(world);
    const mine = new Set([world.first, world.second]);
    const inputs = await productionSharePay.readInputs(database, W);
    const credited = [...inputs.entries()].filter(([id]) => mine.has(id)).flatMap(([, input]) => input.stops.map((row) => row.visitId));
    expect(credited.filter((id) => id === world.moving)).toHaveLength(1);
    // the snapshot is of the start: the stop is still its original technician's
    expect(inputs.get(world.second).stops.map((row) => row.visitId)).toContain(world.moving);
    expect(inputs.get(world.first).stops).toHaveLength(1);
    // the move did commit, and a read made now sees it
    expect((await productionShare.weekCredits(database, world.first, W)).map((row) => row.visitId)).toContain(world.moving);
    expect(idsIn(inputs)).toContain(world.moving);
  });

  it('under the payroll lock (READ COMMITTED, one connection): one statement lists every technician\'s stops, so a stop moved right after it is credited once', async () => {
    const world = await setup();
    const real = productionShare.weekCreditsFor;
    const trx = await database.transaction(); // READ COMMITTED, as the pay run's transaction
    try {
      jest.spyOn(productionShare, 'weekCreditsFor').mockImplementation((conn, settingsById, week) => {
        // the move is committed (another connection) right after the list statement, before each technician's credits are worked out
        let moved = false;
        const wrapped = new Proxy(conn, {
          get(target, key) {
            if (key !== 'transaction') return Reflect.get(target, key);
            return async (handler) => {
              if (!moved) { moved = true; await database('scheduled_services').where({ id: world.moving }).update({ technician_id: world.first }); }
              return target.transaction(handler);
            };
          },
        });
        return real(wrapped, settingsById, week);
      });
      const inputs = await productionSharePay.readInputsUnderLock(trx, W);
      const mine = [world.first, world.second];
      const owners = mine.filter((id) => inputs.get(id).stops.some((row) => row.visitId === world.moving));
      expect(owners).toEqual([world.second]);
      expect(inputs.get(world.first).stops).toHaveLength(1);
    } finally {
      await trx.rollback();
    }
  });

  it('CONTROL: the same move seen by plain READ COMMITTED reads is missed by both technicians', async () => {
    const world = await setup();
    moveAfterFirstRead(world);
    const first = await productionShare.weekCredits(database, world.first, W);
    const second = await productionShare.weekCredits(database, world.second, W);
    expect(first.map((row) => row.visitId)).not.toContain(world.moving);
    expect(second.map((row) => row.visitId)).not.toContain(world.moving);
  });
});
