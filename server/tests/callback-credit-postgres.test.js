/**
 * GATE_CALLBACK_SOURCE_TECH (census M9) against REAL Postgres: the callback
 * source read in services/callback-credit.js (the self-join, the 60-day date
 * arithmetic on DATE columns, the window bounds and the newest-first order).
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test
 * database) or a local scratch Postgres migrated with `knex migrate:latest`;
 * it skips without one. Fixtures are fictitious. Every row it makes is removed
 * in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

postgres('callback credit (real Postgres)', () => {
  let db;
  let credit;
  let owner;
  let hire;
  const made = { techIds: [], customerIds: [], recordIds: [] };

  async function makeTech(name) {
    const [row] = await db('technicians')
      .insert({ name: `${name} ${randomUUID().slice(0, 8)}`, role: 'technician', employment_status: 'active', field_dispatchable: true, active: true })
      .returning(['id']);
    made.techIds.push(row.id);
    return String(row.id);
  }

  async function makeCustomer() {
    const id = randomUUID();
    await db('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Fixture', phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
    });
    made.customerIds.push(id);
    return id;
  }

  // created_at defaults to the order of the calls, one minute apart, so a test
  // reads as the day happened.
  let clock = Date.parse('2030-01-01T12:00:00Z');
  async function record(customerId, technicianId, serviceDate, serviceType, isCallback = false) {
    const id = randomUUID();
    clock += 60 * 1000;
    await db('service_records').insert({
      id, customer_id: customerId, technician_id: technicianId, service_date: serviceDate, service_type: serviceType, is_callback: isCallback,
      created_at: new Date(clock),
    });
    made.recordIds.push(id);
    return id;
  }

  beforeAll(async () => {
    db = require('../models/db');
    credit = require('../services/callback-credit');
    owner = await makeTech('Synthetic Owner');
    hire = await makeTech('Synthetic Hire');
  });

  afterAll(async () => {
    if (made.recordIds.length) await db('service_records').whereIn('id', made.recordIds).del();
    if (made.customerIds.length) await db('customers').whereIn('id', made.customerIds).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  // Far-future dates keep the window clear of any other fixture's records.
  test('the callback counts against the technician of the newest earlier visit in its category, within 60 days', async () => {
    const pestAndLawn = await makeCustomer();
    await record(pestAndLawn, owner, '2040-02-01', 'Quarterly Pest Control');     // older pest visit
    await record(pestAndLawn, hire, '2040-03-01', 'Quarterly Pest Control');      // the pest visit the callback corrects
    await record(pestAndLawn, owner, '2040-03-05', 'Lawn Fertilization');         // later, but lawn
    await record(pestAndLawn, owner, '2040-03-10', 'Pest Control Re-Service', true);

    const tooOld = await makeCustomer();
    await record(tooOld, hire, '2040-01-01', 'Quarterly Pest Control');            // 69 days before
    await record(tooOld, owner, '2040-03-10', 'Pest Control Re-Service', true);

    const sameDay = await makeCustomer();
    await record(sameDay, hire, '2040-03-12', 'Quarterly Pest Control');
    await record(sameDay, owner, '2040-03-12', 'Pest Control Re-Service', true);

    const outside = await makeCustomer();
    await record(outside, hire, '2040-03-20', 'Quarterly Pest Control');
    await record(outside, owner, '2040-04-02', 'Pest Control Re-Service', true); // after the window

    const counts = await credit.callbackCreditByTechnician(db, { start: '2040-03-01', endDate: '2040-03-31' });

    expect(counts.get(hire)).toBe(2);   // the corrected pest visit, and the same-day one
    expect(counts.get(owner)).toBe(1);  // no source within 60 days: its own technician
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(3);
  });

  test('a regular visit recorded AFTER the callback on the same day is not its source (pre-push audit P1)', async () => {
    const customer = await makeCustomer();
    await record(customer, owner, '2042-06-01', 'Quarterly Pest Control');            // the visit it corrects
    await record(customer, owner, '2042-06-20', 'Pest Control Re-Service', true);     // the callback
    await record(customer, hire, '2042-06-20', 'Quarterly Pest Control');            // later that day

    const counts = await credit.callbackCreditByTechnician(db, { start: '2042-06-01', endDate: '2042-06-30' });

    expect(counts.get(owner)).toBe(1);
    expect(counts.get(hire)).toBeUndefined();
  });

  test('a callback never sources from another callback', async () => {
    const customer = await makeCustomer();
    await record(customer, hire, '2041-05-01', 'Pest Control Re-Service', true);
    await record(customer, owner, '2041-05-10', 'Pest Control Re-Service', true);

    const counts = await credit.callbackCreditByTechnician(db, { start: '2041-05-01', endDate: '2041-05-31' });

    expect(counts.get(hire)).toBe(1);
    expect(counts.get(owner)).toBe(1);
  });
});
