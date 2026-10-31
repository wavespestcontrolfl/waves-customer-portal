/**
 * GATE_BI_TECH_SCORECARD against REAL Postgres: the review ask count in
 * services/bi-tech-scorecard.js (the technician and visit-date filter, delivery evidence by text or
 * email, the no-link check-in exclusion from ASK_TOUCH_SQL, the grouping).
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or a local scratch
 * Postgres migrated with `knex migrate:latest`; it skips without one. Fixtures are fictitious. Every
 * row it makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

postgres('technician review asks (real Postgres)', () => {
  let db;
  let reviewAsksByTechnician;
  let noLinkKey;
  let ada;
  let ben;
  let customerId;
  const made = { techIds: [], requestIds: [] };

  async function makeTech(name) {
    const [row] = await db('technicians')
      .insert({ name: `${name} ${randomUUID().slice(0, 8)}`, role: 'technician', employment_status: 'active', field_dispatchable: true, active: true })
      .returning(['id']);
    made.techIds.push(row.id);
    return String(row.id);
  }

  async function ask(technicianId, serviceDate, fields = {}) {
    const id = randomUUID();
    await db('review_requests').insert({
      id, token: randomUUID(), customer_id: customerId, technician_id: technicianId, service_date: serviceDate, ...fields,
    });
    made.requestIds.push(id);
  }

  beforeAll(async () => {
    db = require('../models/db');
    ({ reviewAsksByTechnician } = require('../services/bi-tech-scorecard'));
    noLinkKey = require('../services/review-outreach-templates').NO_LINK_TEMPLATE_KEYS[0];
    ada = await makeTech('Synthetic Ada');
    ben = await makeTech('Synthetic Ben');
    customerId = randomUUID();
    await db('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fixture', phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000',
    });
  });

  afterAll(async () => {
    if (made.requestIds.length) await db('review_requests').whereIn('id', made.requestIds).del();
    await db('customers').where({ id: customerId }).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  // Far-future dates keep the window clear of any other fixture's rows.
  test('counts delivered asks for the technician\'s visits in the week, and nothing else', async () => {
    const sent = new Date('2040-03-05T15:00:00Z');
    await ask(ada, '2040-03-03', { sms_sent_at: sent });                       // text ask
    await ask(ada, '2040-03-04', { sent_at: sent });                           // email ask
    await ask(ada, '2040-03-05', { sms_sent_at: sent, template_key: null });   // canonical ask
    await ask(ada, '2040-03-06', {});                                          // never delivered
    await ask(ada, '2040-03-06', { sms_sent_at: sent, template_key: noLinkKey }); // check-in, no review link
    await ask(ada, '2040-03-02', { sms_sent_at: sent });                       // visit the week before
    await ask(ada, '2040-03-10', { sms_sent_at: sent });                       // visit the week after
    await ask(ben, '2040-03-07', { sms_sent_at: sent });
    await ask(null, '2040-03-07', { sms_sent_at: sent });                      // no technician

    const asks = await reviewAsksByTechnician(db, '2040-03-03', '2040-03-09');
    expect(asks.get(ada)).toBe(3);
    expect(asks.get(ben)).toBe(1);
    expect(asks.has('null')).toBe(false);
  });
});
