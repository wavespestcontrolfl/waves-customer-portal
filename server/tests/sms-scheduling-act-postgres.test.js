/**
 * SMS scheduling move executor on PostgreSQL (GATE_SMS_SCHEDULING_ACT_MOVE):
 * the guard the mover runs under its locks. It passes only while the offer is
 * open, no move was logged since the offer, no staff schedule-change request
 * is open and no reminder reply-1/2 offer is unanswered; passing writes
 * "moved" on the decision and "accepted" on the offer in that transaction.
 * Rolled back after every test. Synthetic people and numbers only.
 */
const path = require('path');
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('sms scheduling move guard on PostgreSQL', () => {
  let knex;
  let act;
  const ROLLBACK = new Error('rollback');
  const NOW = new Date('2040-03-01T15:00:00Z');
  const SENT = new Date('2040-03-01T13:00:00Z');
  const REPLIED = new Date('2040-03-01T14:59:00Z');
  const PHONE = '+19415550178';
  const TARGET = { date: '2040-03-06', start: '10:00', end: '12:00' };

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    act = require('../services/sms-scheduling-act');
  }, 60000);
  afterAll(async () => {
    if (knex) await knex.destroy();
    await require('../models/db').destroy();
  });

  const inTrx = (fn) => expect(knex.transaction(async (trx) => { await fn(trx); throw ROLLBACK; })).rejects.toBe(ROLLBACK);

  async function seed(trx, { executionStatus = 'claimed' } = {}) {
    const customerId = randomUUID();
    const visitId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: PHONE,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    await trx('scheduled_services').insert({ id: visitId, customer_id: customerId, service_type: 'Pest Control Service',
      status: 'confirmed', scheduled_date: '2040-03-05', window_start: '08:00', window_end: '10:00' });
    const [decision] = await trx('agent_decisions').insert({
      workflow: 'sms_reply', agent_name: 'act-test', decision_version: 'test', suggested_message: 'offer',
    }).returning('id');
    const [offer] = await trx('sms_offers').insert({
      agent_decision_id: decision.id || decision, phone_last10: PHONE.slice(-10), waves_line: '9415550199', customer_id: customerId,
      kind: 'move_visit', scheduled_service_id: visitId,
      slots: JSON.stringify([{ date_label: 'Tuesday, March 6', window_label: '10:00 AM - 12:00 PM', date: '2040-03-06', start: '10:00', end: '12:00' }]),
      sent_at: SENT, expires_at: new Date('2040-03-03T13:00:00Z'), status: 'open',
    }).returning('id');
    const [inbound] = await trx('sms_log').insert({
      customer_id: customerId, direction: 'inbound', from_phone: PHONE, to_phone: '+19415550199',
      message_body: 'Tuesday works', status: 'received', created_at: REPLIED,
      message_type: 'inbound', metadata: JSON.stringify({ source: 'location' }),
    }).returning('id');
    const offerId = offer.id || offer;
    const inboundId = inbound.id || inbound;
    const [row] = await trx('sms_offer_decisions').insert({
      sms_offer_id: offerId, inbound_sms_log_id: inboundId, customer_id: customerId, mode: 'shadow',
      action: 'accept_slot', slot_number: 1, outcome: 'would_move', refusals: '[]', execution_status: executionStatus,
    }).returning('id');
    const decisionId = row.id || row;
    const guard = act.buildMoveGuard({ decisionId, offer: { id: offerId, sent_at: SENT, phone_last10: PHONE.slice(-10), waves_line: '9415550199' },
      visitId, customerId, now: NOW, target: TARGET, inboundSmsLogId: inboundId, repliedAt: REPLIED,
      expected: { date: '2040-03-05', start: '08:00', end: '10:00', status: 'confirmed' } });
    return { customerId, visitId, offerId, decisionId, guard };
  }

  const refusalOf = (promise) => promise.then(() => null, (err) => err.refusal || err.message);

  test('every fence clear: the decision is marked moved and the offer accepted', () => inTrx(async (trx) => {
    const { customerId, offerId, decisionId, guard } = await seed(trx);
    // Older messages, and a newer one on another Waves line, are not this conversation's.
    await trx('sms_log').insert([
      { customer_id: customerId, direction: 'outbound', from_phone: '+19415550199', to_phone: PHONE, message_body: 'offer', status: 'sent', created_at: SENT, message_type: 'manual' },
      { customer_id: customerId, direction: 'inbound', from_phone: PHONE, to_phone: '+19415550111', message_body: 'other line', status: 'received', created_at: new Date('2040-03-01T14:59:30Z'), message_type: 'inbound' },
    ]);
    await guard({ trx });
    const decision = await trx('sms_offer_decisions').where({ id: decisionId }).first();
    expect(decision).toMatchObject({ execution_status: 'moved', mode: 'live', execution: TARGET });
    expect(decision.executed_at).not.toBeNull();
    const offer = await trx('sms_offers').where({ id: offerId }).first();
    expect(offer.status).toBe('accepted');
    expect(offer.closed_at).not.toBeNull();
  }));

  test('each fence refuses and writes nothing', async () => {
    const cases = {
      // An Edit appointment save: no move is logged, only the row differs.
      visit_changed: (trx, s) => trx('scheduled_services').where({ id: s.visitId }).update({ window_end: '11:00' }),
      offer_closed: (trx, s) => trx('sms_offers').where({ id: s.offerId }).update({ status: 'superseded', closed_at: NOW }),
      moved_since_offer: (trx, s) => trx('reschedule_log').insert({ scheduled_service_id: s.visitId, customer_id: s.customerId,
        original_date: '2040-03-05', reason_code: 'customer_request', initiated_by: 'admin', created_at: new Date('2040-03-01T14:00:00Z') }),
      portal_request_open: (trx, s) => trx('service_requests').insert({ customer_id: s.customerId, category: 'schedule_change',
        subject: 'Move my visit', status: 'new', description: `Appointment ${s.visitId}: prefers Friday` }),
      // A reminder offer from before this offer went out, still unanswered.
      reminder_offer_pending: (trx, s) => trx('reschedule_log').insert({ scheduled_service_id: s.visitId, customer_id: s.customerId,
        original_date: '2040-03-05', reason_code: 'weather_rain', initiated_by: 'weather_auto', created_at: new Date('2040-03-01T12:00:00Z'),
        notes: JSON.stringify({ option1: { date: '2040-03-07' }, option2: { date: '2040-03-08' } }) }),
    };
    // The customer wrote again before the move committed.
    cases.newer_message = (trx, s) => trx('sms_log').insert({ customer_id: s.customerId, direction: 'inbound', from_phone: PHONE, to_phone: '+19415550199',
      message_body: 'Actually leave it where it is', status: 'received', created_at: new Date('2040-03-01T14:59:40Z'), message_type: 'inbound' });
    // Someone at Waves already answered on that line.
    cases['newer_message (outbound)'] = (trx, s) => trx('sms_log').insert({ customer_id: s.customerId, direction: 'outbound', from_phone: '+19415550199', to_phone: PHONE,
      message_body: 'Let me check Wednesday for you', status: 'sent', created_at: new Date('2040-03-01T14:59:50Z'), message_type: 'manual' });
    cases['visit_changed (status)'] = (trx, s) => trx('scheduled_services').where({ id: s.visitId }).update({ status: 'pending' });
    for (const [name, arrange] of Object.entries(cases)) {
      const reason = name.split(' ')[0];
      await inTrx(async (trx) => {
        const s = await seed(trx);
        await arrange(trx, s);
        expect(await refusalOf(s.guard({ trx }))).toBe(reason);
        expect((await trx('sms_offer_decisions').where({ id: s.decisionId }).first()).execution_status).toBe('claimed');
        expect((await trx('sms_offers').where({ id: s.offerId }).first()).status).not.toBe('accepted');
      });
    }
  });

  test('a moved decision whose notice never started is finished once, pinned to its slot; a series move is left to the reconciler', () => inTrx(async (trx) => {
    const s = await seed(trx);
    const reminders = { handleReschedule: jest.fn(async () => null) };
    const moved = (execution) => trx('sms_offer_decisions').where({ id: s.decisionId })
      .update({ execution_status: 'moved', execution: JSON.stringify(execution), executed_at: new Date('2040-03-01T15:00:00Z') });
    const sweep = (now) => act.finishMoveEffects({ now: new Date(now), dbh: trx, deps: { reminders } });

    await moved({ ...TARGET, series: true });
    expect(await sweep('2040-03-01T15:10:00Z')).toEqual({ finished: 0 });

    await moved({ ...TARGET, series: false });
    // Too fresh: the executor itself may still be about to send.
    expect(await sweep('2040-03-01T15:01:00Z')).toEqual({ finished: 0 });
    expect(await sweep('2040-03-01T15:10:00Z')).toEqual({ finished: 1 });
    expect(reminders.handleReschedule).toHaveBeenCalledTimes(1);
    expect(reminders.handleReschedule).toHaveBeenCalledWith(s.visitId, '2040-03-06T10:00', { expectSchedule: { date: '2040-03-06', windowStart: '10:00' } });
    const row = await trx('sms_offer_decisions').where({ id: s.decisionId }).first('execution');
    expect(row.execution).toMatchObject({ date: '2040-03-06', start: '10:00' });
    expect(row.execution.effects_started_at).toBeTruthy();
    expect(row.execution.effects_done_at).toBeTruthy();
    // Claimed once: a second sweep sends nothing.
    expect(await sweep('2040-03-01T15:25:00Z')).toEqual({ finished: 0 });
    expect(reminders.handleReschedule).toHaveBeenCalledTimes(1);
  }));

  test('a decision whose claim is not held is refused', () => inTrx(async (trx) => {
    const s = await seed(trx, { executionStatus: 'refused' });
    expect(await refusalOf(s.guard({ trx }))).toBe('claim_lost');
    expect((await trx('sms_offers').where({ id: s.offerId }).first()).status).toBe('open');
  }));
});
