/**
 * Codex #5506 r5 P2: with GATE_NOSHOW_DETECTOR on, a missing-tracking technician notice raised for a visit
 * that LATER became a street-level address hold must be dismissed by the detector's own reconciliation
 * (noticeStillCurrent treats a live hold as not current), not left on the technician's screen. Real
 * PostgreSQL, the real sweep: first tick raises the notice, the hold is promoted, the next tick dismisses it
 * with the automatic-dismissal stamp; a non-held visit's notice stays. Synthetic data only.
 */
const { randomUUID } = require('crypto');
const knexFactory = require('knex');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/tech-visit-notifications', () => ({
  ...jest.requireActual('../services/tech-visit-notifications'),
  pushTrackingNotice: jest.fn(async () => {}),   // no push provider in a test
}));

// CI's DB-gated step selects suites by this exact line (.github/workflows/tests.yml).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.setTimeout(30000);

postgres('the no-show detector dismisses a tracking notice for a visit that became an address hold (real sweep)', () => {
  let knex;
  const made = { customers: [], techs: [], visits: [], calls: [] };
  let savedGate;

  beforeAll(() => {
    savedGate = process.env.GATE_NOSHOW_DETECTOR;
    process.env.GATE_NOSHOW_DETECTOR = 'true';
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 6 } });
  });
  afterEach(async () => {
    for (const id of made.visits) {
      await knex('tech_notifications').whereRaw("payload->>'visit_id' = ?", [id]).del();
      await knex('dispatch_alerts').where({ job_id: id }).del();
      await knex('triage_items').whereRaw("payload->>'scheduled_service_id' = ?", [id]).del();
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
    await knex.destroy();
    await require('../models/db').destroy();
  });

  async function seedVisit() {
    const { etDateString } = require('../utils/datetime-et');
    const customerId = randomUUID(); const techId = randomUUID(); const callId = randomUUID(); const visitId = randomUUID();
    await knex('customers').insert({ id: customerId, first_name: 'Fixture', phone: '+19415550100' });
    await knex('technicians').insert({ id: techId, name: 'Fixture Tech', employment_status: 'active', field_dispatchable: true });
    await knex('call_log').insert({ id: callId });
    // The promised window opened an hour ago (stage 1: no departure recorded after 45 minutes).
    const start = new Date(Date.now() - 60 * 60 * 1000);
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
    Object.assign(made, { customers: [...made.customers, customerId], techs: [...made.techs, techId], visits: [...made.visits, visitId], calls: [...made.calls, callId] });
    const hold = () => knex('triage_items').insert({
      call_log_id: callId, category: 'review', reason_code: 'outbound_booking_review', status: 'open',
      payload: JSON.stringify({ street_level_address: true, scheduled_service_id: visitId }),
    });
    return { visitId, hold };
  }
  const notice = (visitId) => knex('tech_notifications').where({ type: 'follow_through_tracking' }).whereRaw("payload->>'visit_id' = ?", [visitId]).first();

  test('a notice for a visit promoted to a hold after it was raised is dismissed (automatic stamp); a non-held visit\'s notice stays', async () => {
    const detector = require('../services/no-show-detector');
    const held = await seedVisit();
    const clear = await seedVisit();
    await detector.sweep(knex);
    expect((await notice(held.visitId))?.dismissed_at).toBeNull();     // the real sweep raised both notices
    expect((await notice(clear.visitId))?.dismissed_at).toBeNull();

    await held.hold();                                                  // promoted to a street-level hold afterwards
    await detector.sweep(knex);

    const heldNotice = await notice(held.visitId);
    expect(heldNotice.dismissed_at).not.toBeNull();
    expect(heldNotice.payload.superseded_at).toBeTruthy();              // automatic dismissal, not a tech's own tap
    expect((await notice(clear.visitId)).dismissed_at).toBeNull();
  });

  test('noticeStillCurrent: a live hold is never current, whatever else matches', () => {
    const { noticeStillCurrent } = require('../services/no-show-detector');
    const live = { stage: 1, promised_window: { start_at: '2026-09-10T13:00:00.000Z' } };
    const args = {
      live, visit: { technician_id: 't' }, notice: { technician_id: 't', payload: { stage: 1, promised_window: { start_at: live.promised_window.start_at } } },
      recipientTech: { id: 't', employment_status: 'active', field_dispatchable: true },
    };
    expect(noticeStillCurrent(args)).toBe(true);
    expect(noticeStillCurrent({ ...args, held: true })).toBe(false);
  });
});
