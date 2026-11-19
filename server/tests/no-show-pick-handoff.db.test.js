/**
 * GATE_NOSHOW_DETECTOR and Quick Move's "let the customer pick a day" text (rain-out.js handOffToCustomer,
 * rain_out_customer_pick_v1): the hand-off tells the customer the visit is moved and parks it windowless until they
 * pick. The detector must read that text as the newest promise (an unknown window), so it raises no "promised
 * arrival" card for the old window, and it resolves a card it raised before the text went out. A time the customer
 * picks afterwards is a new promise again. Real PostgreSQL, the real sweep. Synthetic data only.
 */
const { randomUUID } = require('crypto');
const knexFactory = require('knex');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/notification-service', () => ({
  ...jest.requireActual('../services/notification-service'),
  notifyAdmin: jest.fn(async () => ({})),
}));
jest.mock('../services/tech-visit-notifications', () => ({
  ...jest.requireActual('../services/tech-visit-notifications'),
  pushTrackingNotice: jest.fn(async () => {}),   // no push provider in a test
}));

// CI's DB-gated step selects suites by this exact line (.github/workflows/tests.yml).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.setTimeout(30000);

postgres('the no-show detector reads the pick-a-day hand-off text as the newest promise (real sweep)', () => {
  let knex;
  const made = { customers: [], techs: [], visits: [] };
  let savedGate;
  let sid = 0;

  beforeAll(() => {
    savedGate = process.env.GATE_NOSHOW_DETECTOR;
    process.env.GATE_NOSHOW_DETECTOR = 'true';
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 6 } });
  });
  afterEach(async () => {
    for (const id of made.visits) {
      await knex('tech_notifications').whereRaw("payload->>'visit_id' = ?", [id]).del();
      await knex('dispatch_alerts').where({ job_id: id }).del();
      await knex('messaging_audit_log').where({ appointment_id: id }).del();
      await knex('scheduled_services').where({ id }).del();
    }
    for (const id of made.customers) await knex('customers').where({ id }).del();
    for (const id of made.techs) await knex('technicians').where({ id }).del();
    Object.assign(made, { customers: [], techs: [], visits: [] });
  });
  afterAll(async () => {
    if (savedGate === undefined) delete process.env.GATE_NOSHOW_DETECTOR; else process.env.GATE_NOSHOW_DETECTOR = savedGate;
    await knex.destroy();
    await require('../models/db').destroy();
  });

  // A delivered text on the visit. `minutesAgo` = when it went out; `metadata` = the sender's audit metadata.
  async function sendText(visitId, { purpose, minutesAgo, metadata }) {
    sid += 1;
    await knex('messaging_audit_log').insert({
      appointment_id: visitId, to_hash: 'h', to_last4: '0100', audience: 'customer', purpose, channel: 'sms',
      body_hash: 'b', provider: 'twilio', provider_message_id: `SM${String(sid).padStart(32, '0')}`,
      sent_at: new Date(Date.now() - minutesAgo * 60 * 1000), metadata: JSON.stringify(metadata),
    });
  }
  const handOffText = (visitId, minutesAgo) => sendText(visitId, { purpose: 'appointment', minutesAgo,
    metadata: { original_message_type: 'rain_out_customer_pick_v1', scheduled_service_id: visitId } });

  // A confirmed visit, assigned, whose confirmed window opened 180 minutes ago (stage 2), confirmed a day earlier.
  async function seedVisit() {
    const { etDateString } = require('../utils/datetime-et');
    const customerId = randomUUID(); const visitId = randomUUID(); const techId = randomUUID();
    await knex('customers').insert({ id: customerId, first_name: 'Fixture', phone: '+19415550100' });
    await knex('technicians').insert({ id: techId, name: 'Fixture Tech', employment_status: 'active', field_dispatchable: true });
    const start = new Date(Date.now() - 180 * 60 * 1000);
    const hhmm = start.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false });
    await knex('scheduled_services').insert({
      id: visitId, customer_id: customerId, technician_id: techId, scheduled_date: etDateString(start), window_start: hhmm,
      service_type: 'pest_control', status: 'confirmed', customer_confirmed: false,
    });
    await sendText(visitId, { purpose: 'appointment_confirmation', minutesAgo: 24 * 60, metadata: { rendered_slot_ms: start.getTime() } });
    Object.assign(made, { customers: [...made.customers, customerId], techs: [...made.techs, techId], visits: [...made.visits, visitId] });
    return { visitId, start };
  }
  const openAlerts = (id) => knex('dispatch_alerts').where({ job_id: id }).whereNull('resolved_at')
    .whereRaw("payload->>'source' = 'no_show_detector'");

  test('a hand-off text sent after the confirmation: no office card for the old window', async () => {
    const { visitId } = await seedVisit();
    await handOffText(visitId, 30);
    await require('../services/no-show-detector').sweep(knex);
    expect(await openAlerts(visitId)).toHaveLength(0);
  });

  test('a card raised before the hand-off text is resolved by the next sweep', async () => {
    const { visitId } = await seedVisit();
    const detector = require('../services/no-show-detector');
    await detector.sweep(knex);
    expect(await openAlerts(visitId)).toHaveLength(1);
    await handOffText(visitId, 1);
    await detector.sweep(knex);
    expect(await openAlerts(visitId)).toHaveLength(0);
  });

  test('a time the customer picked after the hand-off is a promise again: a missed arrival still raises the card', async () => {
    const { visitId, start } = await seedVisit();
    await handOffText(visitId, 6 * 60);
    await sendText(visitId, { purpose: 'appointment_confirmation', minutesAgo: 5 * 60, metadata: { rendered_slot_ms: start.getTime() } });
    await require('../services/no-show-detector').sweep(knex);
    const rows = await openAlerts(visitId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'tech_late', severity: 'critical' });
  });
});
