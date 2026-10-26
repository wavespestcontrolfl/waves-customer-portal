/**
 * GATE_CUSTOMER_TEXT_TO_VISIT_TECH (census M3) against REAL Postgres: which
 * technician a customer's text reaches (services/visit-tech-relay.js) — en
 * route or on site, else the technician's next open stop in the dispatch
 * day-plan order — and the tech-home card it writes.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test
 * database) or a local scratch Postgres migrated with `knex migrate:latest`;
 * it skips without one. Fixtures are fictitious. Every row it makes is removed
 * in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUser: jest.fn(async () => ({ sent: 1 })) }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

postgres('visit tech relay (real Postgres)', () => {
  let db;
  let relay;
  let today;
  const made = { techIds: [], customerIds: [], visitIds: [] };

  async function makeTech(name, { role = 'technician', status = 'active' } = {}) {
    const [row] = await db('technicians')
      .insert({ name: `${name} ${randomUUID().slice(0, 8)}`, role, employment_status: status, field_dispatchable: true, active: true })
      .returning(['id', 'name']);
    made.techIds.push(row.id);
    return row;
  }

  async function makeCustomer(firstName) {
    const id = randomUUID();
    await db('customers').insert({
      id, first_name: firstName, last_name: 'Fixture', phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
    });
    made.customerIds.push(id);
    return { id, first_name: firstName, last_name: 'Fixture' };
  }

  async function visit(customer, tech, status, windowStart) {
    const id = randomUUID();
    await db('scheduled_services').insert({
      id, customer_id: customer.id, technician_id: tech.id, scheduled_date: today, status,
      service_type: 'Fixture General Pest Control', window_start: windowStart,
    });
    made.visitIds.push(id);
    return id;
  }

  const idsOf = (techs) => techs.map((t) => String(t.id)).sort();

  beforeAll(async () => {
    db = require('../models/db');
    relay = require('../services/visit-tech-relay');
    today = require('../utils/datetime-et').etDateString();
  });

  afterAll(async () => {
    if (made.techIds.length) await db('tech_notifications').whereIn('technician_id', made.techIds).del();
    if (made.visitIds.length) await db('scheduled_services').whereIn('id', made.visitIds).del();
    if (made.customerIds.length) await db('customers').whereIn('id', made.customerIds).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  test('en route or on site: the visit\'s technician; the next open stop too; a later stop and a done visit do not count', async () => {
    const hire = await makeTech('Synthetic Hire');
    const onTheWay = await makeCustomer('Enroute');
    const nextUp = await makeCustomer('Nextup');
    const later = await makeCustomer('Later');
    const done = await makeCustomer('Done');
    await visit(done, hire, 'completed', '07:00');
    await visit(onTheWay, hire, 'en_route', '08:00');
    await visit(nextUp, hire, 'confirmed', '10:00');
    await visit(later, hire, 'confirmed', '13:00');

    expect(idsOf(await relay.visitTechniciansFor(onTheWay.id))).toEqual([String(hire.id)]);
    expect(idsOf(await relay.visitTechniciansFor(nextUp.id))).toEqual([String(hire.id)]);
    expect(await relay.visitTechniciansFor(later.id)).toEqual([]);
    expect(await relay.visitTechniciansFor(done.id)).toEqual([]);
  });

  test('route_order outranks the window in the day plan', async () => {
    const hire = await makeTech('Synthetic Hire');
    const routedFirst = await makeCustomer('Routed');
    const earlyWindow = await makeCustomer('Early');
    await visit(earlyWindow, hire, 'confirmed', '08:00');
    const routedId = await visit(routedFirst, hire, 'confirmed', '11:00');
    await db('scheduled_services').where({ id: routedId }).update({ route_order: 1 });

    expect(idsOf(await relay.visitTechniciansFor(routedFirst.id))).toEqual([String(hire.id)]);
    expect(await relay.visitTechniciansFor(earlyWindow.id)).toEqual([]);
  });

  test('live stops only (pre-push audit P1): an expired hold or a tracker-complete row never blocks the real next stop; a tracker-active row counts as underway', async () => {
    const hire = await makeTech('Synthetic Hire');
    const deadHold = await makeCustomer('Deadhold');
    const trackerDone = await makeCustomer('Trackerdone');
    const realNext = await makeCustomer('Realnext');
    const trackerActive = await makeCustomer('Trackeractive');
    const holdId = await visit(deadHold, hire, 'confirmed', '07:00');
    await db('scheduled_services').where({ id: holdId }).update({ reservation_expires_at: new Date(Date.now() - 60 * 60 * 1000) });
    const doneId = await visit(trackerDone, hire, 'confirmed', '08:00');
    await db('scheduled_services').where({ id: doneId }).update({ track_state: 'complete' });
    await visit(realNext, hire, 'confirmed', '10:00');

    expect(await relay.visitTechniciansFor(deadHold.id)).toEqual([]);
    expect(await relay.visitTechniciansFor(trackerDone.id)).toEqual([]);
    expect(idsOf(await relay.visitTechniciansFor(realNext.id))).toEqual([String(hire.id)]);

    // status can trail the tracker: 'confirmed' + track_state 'en_route' is underway.
    const other = await makeTech('Synthetic Other');
    const activeId = await visit(trackerActive, other, 'confirmed', '15:00');
    await db('scheduled_services').where({ id: activeId }).update({ track_state: 'en_route' });
    await visit(await makeCustomer('Earlier'), other, 'confirmed', '09:00');
    expect(idsOf(await relay.visitTechniciansFor(trackerActive.id))).toEqual([String(other.id)]);
  });

  test('one appointment is one stop (pre-push audit P1): a confirmed row beside an on-site sibling is the current stop, so the next customer is next', async () => {
    const hire = await makeTech('Synthetic Hire');
    const twoServices = await makeCustomer('Twoservices');
    const nextCustomer = await makeCustomer('Nextcustomer');
    await visit(twoServices, hire, 'on_site', '08:00');
    await visit(twoServices, hire, 'confirmed', '08:00');
    await visit(nextCustomer, hire, 'confirmed', '10:00');

    expect(idsOf(await relay.visitTechniciansFor(twoServices.id))).toEqual([String(hire.id)]);
    expect(idsOf(await relay.visitTechniciansFor(nextCustomer.id))).toEqual([String(hire.id)]);
  });

  test('an admin technician (the owner) and an inactive technician get no copy', async () => {
    const owner = await makeTech('Synthetic Owner', { role: 'admin' });
    const former = await makeTech('Synthetic Former', { status: 'inactive' });
    const ownersCustomer = await makeCustomer('Owners');
    const formersCustomer = await makeCustomer('Formers');
    await visit(ownersCustomer, owner, 'on_site', '09:00');
    await visit(formersCustomer, former, 'on_site', '09:00');

    expect(await relay.visitTechniciansFor(ownersCustomer.id)).toEqual([]);
    expect(await relay.visitTechniciansFor(formersCustomer.id)).toEqual([]);
  });

  test('the relay writes one tech-home text card and one push for the visit\'s technician', async () => {
    const hire = await makeTech('Synthetic Hire');
    const customer = await makeCustomer('Gate');
    await visit(customer, hire, 'en_route', '09:00');
    const { sendToAdminUser } = require('../services/push-notifications');
    sendToAdminUser.mockClear();

    const sent = await relay.relayCustomerTextToVisitTech({ customer, from: '+12025550101', body: 'The gate is open', mediaCount: 0 });

    expect(sent).toBe(1);
    const cards = await db('tech_notifications').where({ technician_id: hire.id });
    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('tech_line_sms');
    const payload = typeof cards[0].payload === 'string' ? JSON.parse(cards[0].payload) : cards[0].payload;
    expect(payload).toMatchObject({ headline: 'Text from your customer', customer_id: customer.id, customer_name: 'Gate Fixture', body: 'The gate is open' });
    expect(sendToAdminUser).toHaveBeenCalledTimes(1);
    expect(sendToAdminUser).toHaveBeenCalledWith(hire.id, expect.objectContaining({ title: 'Text from Gate Fixture', url: '/tech' }));
  });
});
