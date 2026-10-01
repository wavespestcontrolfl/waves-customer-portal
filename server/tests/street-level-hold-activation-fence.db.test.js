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
    expect(await _test.stampCustomerConfirmed(knex, svc, { bindAddress: true, markActivationPending: 'office' })).toBe(1);
    expect(await marker(callId)).toBe('office');
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'open' });
    expect(reminders.registerAppointment).not.toHaveBeenCalled();

    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 1 });
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'resolved' });
    expect(reminders.registerAppointment).toHaveBeenCalledTimes(1);
    expect(await marker(callId)).toBeUndefined();
    // An OFFICE-mode resume carries the call-level clearance stamp the card-on-file ask needs (a lazy one would not).
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
    expect(await marker(callId)).toBe('office');
    // The sweep finishes the legs; the visit is never stuck behind a restored hold.
    reminders.registerAppointment.mockImplementationOnce((...args) => actual(...args));
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 1 });
    expect(await state(visitId, callId)).toEqual({ confirmed: true, card: 'resolved' });
    expect(await marker(callId)).toBeUndefined();
  });

  test('when a lazy activation wins the stamp, the office path still runs the office-only legs (clearance stamp, card invitation)', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    // The stranded-activation sweep got there first, in lazy mode, and is still mid-legs (hold card open).
    await _test.stampCustomerConfirmed(knex, svc, { bindAddress: true, markActivationPending: 'lazy' });
    expect((await knex('scheduled_services').where({ id: visitId }).first('call_sms_cleared_at')).call_sms_cleared_at).toBeNull();

    // The office path passed its hold check just before the lazy stamp landed: it reaches the fenced
    // activation, loses the stamp, and must still run the office-only legs itself.
    expect(await _test.activateHoldFencedByAddress(knex, svc, 'admin-dispatch', {})).toBe(true);
    expect((await knex('scheduled_services').where({ id: visitId }).first('call_sms_cleared_at')).call_sms_cleared_at).not.toBeNull();
    expect(cardRequest.requestCardForAppointment).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: visitId, trigger: 'outbound_review_confirm' }));
    expect(await marker(callId)).toBeUndefined();
  });

  test('a lazy activation finishing never clears an office upgrade of the marker (the office legs stay owed)', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    const actual = jest.requireActual('../services/appointment-reminders').registerAppointment;
    // The lazy activation stamps and is mid-legs when the office path (which lost the stamp) upgrades the marker.
    reminders.registerAppointment.mockImplementationOnce(async (...args) => {
      await knex('triage_items').where({ call_log_id: callId }).update({ payload: knex.raw("payload || '{\"activation_pending\": \"office\"}'::jsonb") });
      return actual(...args);
    });
    expect(await _test.activateHoldFencedByAddress(knex, svc, 'legacy-activation-sweep', { suppressCardAskWithoutClearance: true })).toBe(true);
    // The lazy one finished and cleared only ITS mode: the office upgrade is still owed.
    expect(await marker(callId)).toBe('office');
    reminders.registerAppointment.mockImplementationOnce((...args) => actual(...args));
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 1 });
    expect(await marker(callId)).toBeUndefined();
    expect((await knex('scheduled_services').where({ id: visitId }).first('call_sms_cleared_at')).call_sms_cleared_at).not.toBeNull();
  });

  test('a LAZY resume finishing never clears an office upgrade written while it ran', async () => {
    const { callId, svc } = await seedApprovedHold();
    await _test.stampCustomerConfirmed(knex, svc, { bindAddress: true, markActivationPending: 'lazy' });
    const actual = jest.requireActual('../services/appointment-reminders').registerAppointment;
    reminders.registerAppointment.mockImplementationOnce(async (...args) => {
      await knex('triage_items').where({ call_log_id: callId }).update({ payload: knex.raw("payload || '{\"activation_pending\": \"office\"}'::jsonb") });
      return actual(...args);
    });
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 1 });
    expect(await marker(callId)).toBe('office');
    reminders.registerAppointment.mockImplementationOnce((...args) => actual(...args));
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 1 });
    expect(await marker(callId)).toBeUndefined();
  });

  test('a LAZY-mode marker resumes without the office clearance: no clearance stamp, the card ask runs delivery-less', async () => {
    const { visitId, callId, svc } = await seedApprovedHold();
    await _test.stampCustomerConfirmed(knex, svc, { bindAddress: true, markActivationPending: 'lazy' });
    expect(await resumePendingHoldActivations(knex)).toEqual({ candidates: 1, resumed: 1 });
    expect((await knex('scheduled_services').where({ id: visitId }).first('call_sms_cleared_at')).call_sms_cleared_at).toBeNull();
    expect(cardRequest.requestCardForAppointment).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: visitId, delivery: 'none' }));
    expect(await marker(callId)).toBeUndefined();
  });

  test('a refused stamp writes no marker; a visit a rejection took just drops it', async () => {
    const refused = await seedApprovedHold();
    await knex('scheduled_services').where({ id: refused.visitId }).update({ service_address_line1: '1240 Sample Newbuild Trl' });
    expect(await _test.stampCustomerConfirmed(knex, refused.svc, { bindAddress: true, markActivationPending: 'office' })).toBe(0);
    expect(await marker(refused.callId)).toBeUndefined();

    const cancelled = await seedApprovedHold();
    await _test.stampCustomerConfirmed(knex, cancelled.svc, { bindAddress: true, markActivationPending: 'office' });
    await knex('scheduled_services').where({ id: cancelled.visitId }).update({ status: 'cancelled' });
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
