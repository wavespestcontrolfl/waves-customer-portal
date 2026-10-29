/**
 * GATE_NOSHOW_DETECTOR, office cards only (owner approved 2026-10-27): with the gate on and
 * NOSHOW_TECH_PING_ENABLED unset, the 45-minute stage-1 ping to an ASSIGNED tech is not sent. The
 * 150-minute card (tech notice + office alert) and the no-tech office card are unchanged. Setting
 * NOSHOW_TECH_PING_ENABLED=true brings the stage-1 ping back. Real PostgreSQL, the real sweep.
 * Synthetic data only.
 */
const { randomUUID } = require('crypto');
const knexFactory = require('knex');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/tech-visit-notifications', () => ({
  ...jest.requireActual('../services/tech-visit-notifications'),
  pushTrackingNotice: jest.fn(async () => {}),   // no push provider in a test
}));

// CI's DB-gated step selects suites by this exact line (.github/workflows/tests.yml).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.setTimeout(30000);

postgres('the no-show detector sends no stage-1 tech ping unless NOSHOW_TECH_PING_ENABLED=true (real sweep)', () => {
  let knex;
  const made = { customers: [], techs: [], visits: [], calls: [] };
  let savedGate;
  let savedPing;

  beforeAll(() => {
    savedGate = process.env.GATE_NOSHOW_DETECTOR;
    savedPing = process.env.NOSHOW_TECH_PING_ENABLED;
    process.env.GATE_NOSHOW_DETECTOR = 'true';
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 6 } });
  });
  beforeEach(() => { delete process.env.NOSHOW_TECH_PING_ENABLED; });
  afterEach(async () => {
    for (const id of made.visits) {
      await knex('tech_notifications').whereRaw("payload->>'visit_id' = ?", [id]).del();
      await knex('dispatch_alerts').where({ job_id: id }).del();
      await knex('messaging_audit_log').where({ appointment_id: id }).del();
      await knex('scheduled_services').where({ id }).del();
    }
    for (const id of made.calls) await knex('call_log').where({ id }).del();
    for (const id of made.customers) await knex('customers').where({ id }).del();
    for (const id of made.techs) await knex('technicians').where({ id }).del();
    Object.assign(made, { customers: [], techs: [], visits: [], calls: [] });
  });
  afterAll(async () => {
    if (savedGate === undefined) delete process.env.GATE_NOSHOW_DETECTOR; else process.env.GATE_NOSHOW_DETECTOR = savedGate;
    if (savedPing === undefined) delete process.env.NOSHOW_TECH_PING_ENABLED; else process.env.NOSHOW_TECH_PING_ENABLED = savedPing;
    await knex.destroy();
    await require('../models/db').destroy();
  });

  // The promised window opened `minutesAgo` minutes ago: 60 = stage 1, 180 = stage 2.
  async function seedVisit({ minutesAgo, assigned }) {
    const { etDateString } = require('../utils/datetime-et');
    const customerId = randomUUID(); const callId = randomUUID(); const visitId = randomUUID();
    const techId = assigned ? randomUUID() : null;
    await knex('customers').insert({ id: customerId, first_name: 'Fixture', phone: '+19415550100' });
    if (techId) await knex('technicians').insert({ id: techId, name: 'Fixture Tech', employment_status: 'active', field_dispatchable: true });
    await knex('call_log').insert({ id: callId });
    const start = new Date(Date.now() - minutesAgo * 60 * 1000);
    const hhmm = start.toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false });
    await knex('scheduled_services').insert({
      id: visitId, customer_id: customerId, technician_id: techId, scheduled_date: etDateString(start), window_start: hhmm,
      service_type: 'pest_control', status: 'confirmed', customer_confirmed: false, source_action: 'voice_agent', source_call_log_id: callId,
    });
    await knex('messaging_audit_log').insert({
      appointment_id: visitId, to_hash: 'h', to_last4: '0100', audience: 'customer', purpose: 'appointment_confirmation', channel: 'sms',
      body_hash: 'b', provider: 'twilio', provider_message_id: `SM${'a'.repeat(32)}`, sent_at: new Date(Date.now() - 24 * 3600 * 1000),
      metadata: JSON.stringify({ rendered_slot_ms: start.getTime() }),
    });
    Object.assign(made, { customers: [...made.customers, customerId], techs: techId ? [...made.techs, techId] : made.techs,
      visits: [...made.visits, visitId], calls: [...made.calls, callId] });
    return visitId;
  }
  const notices = (id) => knex('tech_notifications').where({ type: 'follow_through_tracking' }).whereRaw("payload->>'visit_id' = ?", [id]);
  const alerts = (id) => knex('dispatch_alerts').where({ job_id: id }).whereRaw("payload->>'source' = 'no_show_detector'");

  test('stage 1, assigned tech, ping setting unset: no tech notice and no office card', async () => {
    const id = await seedVisit({ minutesAgo: 60, assigned: true });
    await require('../services/no-show-detector').sweep(knex);
    expect(await notices(id)).toHaveLength(0);
    expect(await alerts(id)).toHaveLength(0);
  });

  test('stage 1, assigned tech, NOSHOW_TECH_PING_ENABLED=true: the tech notice returns, still no office card', async () => {
    process.env.NOSHOW_TECH_PING_ENABLED = 'true';
    const id = await seedVisit({ minutesAgo: 60, assigned: true });
    await require('../services/no-show-detector').sweep(knex);
    expect(await notices(id)).toHaveLength(1);
    expect(await alerts(id)).toHaveLength(0);
  });

  test('stage 2, assigned tech, ping setting unset: the tech notice AND the critical office card, as before', async () => {
    const id = await seedVisit({ minutesAgo: 180, assigned: true });
    await require('../services/no-show-detector').sweep(knex);
    expect(await notices(id)).toHaveLength(1);
    const rows = await alerts(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'tech_late', severity: 'critical' });
  });

  test('stage 1, no tech assigned, ping setting unset: the office card is raised at once, as before', async () => {
    const id = await seedVisit({ minutesAgo: 60, assigned: false });
    await require('../services/no-show-detector').sweep(knex);
    expect(await notices(id)).toHaveLength(0);
    const rows = await alerts(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('unassigned_overdue');
  });
});
