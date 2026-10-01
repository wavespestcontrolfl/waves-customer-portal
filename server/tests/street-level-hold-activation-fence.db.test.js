/**
 * Codex #5506 r3 P1: the address witness must fence the hook's irreversible legs (lead conversion, review-card
 * resolve, card-on-file text), not only the final stamp. For an office-approved street-level hold the order is
 * lock + verify + STAMP in one transaction, then the legs (outbound-review-confirm activateHoldFencedByAddress):
 * an address correction either lands before the verify (no leg runs) or serializes behind the lock and lands
 * after the stamp (a post-approval change). A failed leg un-stamps and reopens the card. Runs the REAL hook
 * against the migrated schema; every row it makes is removed afterwards. Synthetic data only.
 */
const { randomUUID } = require('crypto');
const knexFactory = require('knex');

// CI's DB-gated step selects suites by this exact line (.github/workflows/tests.yml).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The leg that texts a customer, and the reminder registration, are observed rather than executed.
jest.mock('../services/appointment-card-request', () => ({ requestCardForAppointment: jest.fn(async () => ({ action: 'skipped' })) }));
// The real registration (so the hook's slot verify reads a real reminder row), observed.
jest.mock('../services/appointment-reminders', () => {
  const actual = jest.requireActual('../services/appointment-reminders');
  return { ...actual, registerAppointment: jest.fn((...args) => actual.registerAppointment(...args)) };
});
jest.mock('../services/inspection-credit', () => ({
  markBookingForInspectionCredit: jest.fn(async () => 0),
  redeemInspectionCreditForBooking: jest.fn(async () => null),
}));

jest.setTimeout(30000);   // the first test pays the cold module load of the real hook
postgres('an office-approved street-level hold is activated behind its address witness (real hook, real PostgreSQL)', () => {
  let knex;
  const created = { customers: [], calls: [], visits: [], techs: [] };
  const ADDRESS = { service_address_line1: '1234 Sample Newbuild Trl', service_address_line2: '', service_address_city: 'Parrish', service_address_state: 'FL', service_address_zip: '34219' };
  const NORM = '1234 sample newbuild trl parrish fl 34219';
  const cardRequest = require('../services/appointment-card-request');
  const reminders = require('../services/appointment-reminders');

  beforeAll(() => {
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 6 } });
  });
  afterEach(async () => {
    jest.clearAllMocks();
    for (const id of created.visits) {
      await knex('appointment_reminders').where({ scheduled_service_id: id }).del();
      await knex('job_status_history').where({ job_id: id }).del();
      await knex('triage_items').whereRaw("payload->>'scheduled_service_id' = ?", [id]).del();
      await knex('scheduled_services').where({ id }).del();
    }
    for (const id of created.calls) await knex('call_log').where({ id }).del();
    for (const id of created.customers) await knex('customers').where({ id }).del();
    for (const id of created.techs) await knex('technicians').where({ id }).del();
    created.visits = []; created.calls = []; created.customers = []; created.techs = [];
  });
  afterAll(async () => {
    await knex.destroy();
    await require('../models/db').destroy();   // the hook's own (global) pool
  });

  async function seedApprovedHold({ witness = NORM, cardStatus = 'open' } = {}) {
    const customerId = randomUUID(); const callId = randomUUID(); const visitId = randomUUID();
    await knex('customers').insert({ id: customerId, first_name: 'Fixture', phone: '+19415550100' });
    await knex('call_log').insert({ id: callId });
    await knex('scheduled_services').insert({
      id: visitId, customer_id: customerId, scheduled_date: '2099-01-05', window_start: '09:00:00', service_type: 'pest_control',
      status: 'confirmed', customer_confirmed: false, source_action: 'voice_agent', source_call_log_id: callId, ...ADDRESS,
    });
    await knex('triage_items').insert({
      call_log_id: callId, category: 'review', reason_code: 'outbound_booking_review', status: cardStatus,
      payload: JSON.stringify({ street_level_address: true, scheduled_service_id: visitId, address_on_file: '1234 Sample Newbuild Trl', approved_address: witness }),
    });
    created.customers.push(customerId); created.calls.push(callId); created.visits.push(visitId);
    return { customerId, callId, visitId, svc: { id: visitId, customer_id: customerId, source_action: 'voice_agent', source_call_log_id: callId, scheduled_date: '2099-01-05', window_start: '09:00:00', service_type: 'pest_control' } };
  }
  const { runOfficeConfirmActivation, resumePendingHoldActivations, _test } = require('../services/outbound-review-confirm');
  // The sweep only recovers a marker that has been quiet past its lease: backdate it (the crash was a while ago).
  const age = (callId) => knex('triage_items').where({ call_log_id: callId })
    .update({ payload: knex.raw("payload || jsonb_build_object('activation_pending_at', to_char(NOW() AT TIME ZONE 'UTC' - interval '1 hour', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))") });
  const marker = async (callId) => (await knex('triage_items').where({ call_log_id: callId }).first('payload')).payload.activation_pending;
  const state = async (visitId, callId) => ({
    confirmed: (await knex('scheduled_services').where({ id: visitId }).first('customer_confirmed')).customer_confirmed,
    card: (await knex('triage_items').where({ call_log_id: callId }).first('status')).status,
  });

  test('the approved address is unchanged: stamped first, then every leg runs (card resolved, reminders armed, card request sent)', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    expect(await runOfficeConfirmActivation(knex, svc, 'admin-dispatch')).toBe(true);
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'resolved' });
    expect(reminders.registerAppointment).toHaveBeenCalledTimes(1);
    expect(cardRequest.requestCardForAppointment).toHaveBeenCalledTimes(1);
    expect(await marker(callId)).toBeUndefined();   // the owed-legs marker is cleared once they ran
  });

  test('a process exit between the stamp and the legs leaves a durable marker, and the sweep resumes the legs', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    // The stamp and its marker commit together; the legs never ran (the crash).
    expect(await _test.stampCustomerConfirmed(knex, svc, { bindAddress: true, markActivationPending: true })).toBe(1);
    expect(await marker(callId)).toBe(true);
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'open' });
    expect(reminders.registerAppointment).not.toHaveBeenCalled();

    await age(callId);
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 1 });
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'resolved' });
    expect(reminders.registerAppointment).toHaveBeenCalledTimes(1);
    expect(await marker(callId)).toBeUndefined();
    // The resume runs the one set of legs: the call-level clearance stamp the card-on-file ask needs, and the ask.
    expect((await knex('scheduled_services').where({ id: visitId }).first('call_sms_cleared_at')).call_sms_cleared_at).not.toBeNull();
    expect(cardRequest.requestCardForAppointment).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: visitId, trigger: 'outbound_review_confirm' }));
    // Nothing left to resume.
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 0, resumed: 0 });
  });

  test('a failing leg after a technician advanced the visit keeps the approval and the pending marker (never un-stamps an advanced visit); the sweep finishes it', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    const actual = jest.requireActual('../services/appointment-reminders').registerAppointment;
    reminders.registerAppointment.mockImplementationOnce(async () => {
      await knex('scheduled_services').where({ id: visitId }).update({ status: 'en_route' });   // the tech moved on mid-legs
      return null;                                                                              // ...and a core leg failed
    });
    expect(await runOfficeConfirmActivation(knex, svc, 'admin-dispatch')).toBe(false);
    expect(await state(visitId, callId)).toMatchObject({ confirmed: true });
    expect(await marker(callId)).toBe(true);
    // The sweep finishes the legs; the visit is never stuck behind a restored hold.
    reminders.registerAppointment.mockImplementationOnce((...args) => actual(...args));
    await age(callId);
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 1 });
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'resolved' });
    expect(await marker(callId)).toBeUndefined();
  });

  test('office + lazy activations racing concurrently: ONE stamped visit, the legs run exactly once, no marker left', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    // The lazy / sweep rail needs the office approval on record (a user-attributed confirmed transition).
    const techId = randomUUID();
    await knex('technicians').insert({ id: techId, name: 'Fixture Office' });
    created.techs.push(techId);
    await knex('job_status_history').insert({ job_id: visitId, from_status: 'pending', to_status: 'confirmed', transitioned_by: techId });
    const { activateLegacyOutboundReviewRowIfNeeded } = require('../services/outbound-review-confirm');
    const [office, lazy] = await Promise.all([
      runOfficeConfirmActivation(knex, svc, 'admin-dispatch'),
      activateLegacyOutboundReviewRowIfNeeded(knex, visitId, 'legacy-activation-sweep'),
    ]);
    expect(office || lazy).toBe(true);
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'resolved' });
    expect(await marker(callId)).toBeUndefined();
    // The single winner ran the one set of legs, with the office clearance and card ask; the loser ran none.
    expect(reminders.registerAppointment).toHaveBeenCalledTimes(1);
    expect(cardRequest.requestCardForAppointment).toHaveBeenCalledTimes(1);
    expect((await knex('scheduled_services').where({ id: visitId }).first('call_sms_cleared_at')).call_sms_cleared_at).not.toBeNull();
  });

  test('an office confirm overlapping an activation that already stamped the visit stays on the fenced path: it runs NO legs (not hook-first, no address check skipped)', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    await _test.stampCustomerConfirmed(knex, svc, { bindAddress: true, markActivationPending: true });   // the other activation, mid-legs
    await knex('scheduled_services').where({ id: visitId }).update({ service_address_line1: '1240 Sample Newbuild Trl' });   // and the address changed
    expect(await runOfficeConfirmActivation(knex, svc, 'admin-dispatch')).toBe(true);   // activated by the other one
    expect(reminders.registerAppointment).not.toHaveBeenCalled();
    expect(cardRequest.requestCardForAppointment).not.toHaveBeenCalled();
    expect(await state(visitId, callId)).toMatchObject({ confirmed: true });
  });

  test('a rollback by one attempt cannot un-stamp another activation: a re-stamped visit, or one recovery already finished, stays activated', async () => {
    // (a) another activation re-stamped the visit (a different confirmed_at) while this one's leg failed
    const a = await seedApprovedHold();
    reminders.registerAppointment.mockImplementationOnce(async () => {
      await knex('scheduled_services').where({ id: a.visitId }).update({ confirmed_at: new Date(Date.now() + 5000) });
      return null;
    });
    expect(await runOfficeConfirmActivation(knex, a.svc, 'admin-dispatch')).toBe(false);
    expect((await state(a.visitId, a.callId)).confirmed).toBe(true);
    // (b) recovery finished and cleared the marker while this attempt's leg failed
    const b = await seedApprovedHold();
    reminders.registerAppointment.mockImplementationOnce(async () => {
      await knex('triage_items').where({ call_log_id: b.callId }).update({ payload: knex.raw("payload - 'activation_pending' - 'activation_pending_at'") });
      return null;
    });
    expect(await runOfficeConfirmActivation(knex, b.svc, 'admin-dispatch')).toBe(false);
    expect((await state(b.visitId, b.callId)).confirmed).toBe(true);
  });

  test('a FRESH marker is leased: the sweep leaves a running activation (and its failure rollback) alone', async () => {
    const { callId, svc } = await seedApprovedHold();
    await _test.stampCustomerConfirmed(knex, svc, { bindAddress: true, markActivationPending: true });
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 0, resumed: 0 });
    expect(reminders.registerAppointment).not.toHaveBeenCalled();
    await age(callId);
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 1 });
  });

  test('a refused stamp writes no marker; a visit a rejection took just drops it', async () => {
    const refused = await seedApprovedHold();
    await knex('scheduled_services').where({ id: refused.visitId }).update({ service_address_line1: '1240 Sample Newbuild Trl' });
    expect(await _test.stampCustomerConfirmed(knex, refused.svc, { bindAddress: true, markActivationPending: true })).toBe(0);
    expect(await marker(refused.callId)).toBeUndefined();

    const cancelled = await seedApprovedHold();
    await _test.stampCustomerConfirmed(knex, cancelled.svc, { bindAddress: true, markActivationPending: true });
    await knex('scheduled_services').where({ id: cancelled.visitId }).update({ status: 'cancelled' });
    await age(cancelled.callId);
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 0 });
    expect(await marker(cancelled.callId)).toBeUndefined();
    expect(reminders.registerAppointment).not.toHaveBeenCalled();
  });

  test('a correction committed BEFORE the verify: no leg runs at all (no card resolve, no card text), the hold stays pending', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    await knex('scheduled_services').where({ id: visitId }).update({ service_address_line1: '1240 Sample Newbuild Trl' });
    expect(await runOfficeConfirmActivation(knex, svc, 'admin-dispatch')).toBe(false);
    expect(await state(visitId, callId)).toEqual({ confirmed: false, card: 'open' });
    expect(reminders.registerAppointment).not.toHaveBeenCalled();
    expect(cardRequest.requestCardForAppointment).not.toHaveBeenCalled();
  });

  test('a correction in flight when the verify runs serializes behind the lock: the activation sees it, and no leg runs', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    const writer = await knex.transaction();
    await writer('scheduled_services').where({ id: visitId }).forUpdate().first('id');
    const activation = runOfficeConfirmActivation(knex, svc, 'admin-dispatch');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writer('scheduled_services').where({ id: visitId }).update({ service_address_zip: '34203' });
    await writer.commit();
    expect(await activation).toBe(false);
    expect(await state(visitId, callId)).toEqual({ confirmed: false, card: 'open' });
    expect(cardRequest.requestCardForAppointment).not.toHaveBeenCalled();
  });

  test('a correction that arrives after the stamp is an ordinary post-approval change: the approved activation stands', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    const actualRegister = jest.requireActual('../services/appointment-reminders').registerAppointment;
    reminders.registerAppointment.mockImplementationOnce(async (...args) => {
      // A leg runs after the stamp committed: the correction now succeeds immediately (no lock held).
      await knex('scheduled_services').where({ id: visitId }).update({ service_address_line1: '1240 Sample Newbuild Trl' });
      return actualRegister(...args);
    });
    expect(await runOfficeConfirmActivation(knex, svc, 'admin-dispatch')).toBe(true);
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'resolved' });
  });

  test('a core leg that fails un-stamps the visit and reopens the card, restoring the unstamped retry state', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    reminders.registerAppointment.mockResolvedValueOnce(null);   // the swallowed-failure signal of a core leg
    expect(await runOfficeConfirmActivation(knex, svc, 'admin-dispatch')).toBe(false);
    expect(await state(visitId, callId)).toEqual({ confirmed: false, card: 'open' });
    expect(await marker(callId)).toBeUndefined();
    // The retry (the lazy / sweep activation) re-verifies the witness and completes it.
    const { activateLegacyOutboundReviewRowIfNeeded } = require('../services/outbound-review-confirm');
    const techId = randomUUID();
    await knex('technicians').insert({ id: techId, name: 'Fixture Tech' });
    created.techs.push(techId);
    await knex('job_status_history').insert({ job_id: visitId, from_status: 'pending', to_status: 'confirmed', transitioned_by: techId });
    expect(await activateLegacyOutboundReviewRowIfNeeded(knex, visitId, 'legacy-activation-sweep')).toBe(true);
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'resolved' });
  });

  test('a non-hold voice booking and a field-confirmed one keep the hook-first order (the legs ran before any stamp)', async () => {
    const plain = await seedApprovedHold();
    await knex('triage_items').where({ call_log_id: plain.callId }).update({ payload: JSON.stringify({ origin: 'voice_agent', scheduled_service_id: plain.visitId }) });
    let confirmedDuringLeg = null;
    const actualRegister2 = jest.requireActual('../services/appointment-reminders').registerAppointment;
    reminders.registerAppointment.mockImplementationOnce(async (...args) => {
      confirmedDuringLeg = (await knex('scheduled_services').where({ id: plain.visitId }).first('customer_confirmed')).customer_confirmed;
      return actualRegister2(...args);
    });
    expect(await runOfficeConfirmActivation(knex, plain.svc, 'admin-dispatch')).toBe(true);
    expect(confirmedDuringLeg).toBe(false);
  });
});
