/**
 * SMS scheduling decide step on PostgreSQL (GATE_SMS_SCHEDULING_DECIDE): a
 * reply from a phone holding an open book_new offer records exactly one shadow
 * decision row, a second run for the same text records nothing, and the
 * model is a stub (never a network call). Rolled back after every test.
 */
const path = require('path');
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('sms_offer_decisions on PostgreSQL', () => {
  let knex;
  let decide;
  const GATE = 'GATE_SMS_SCHEDULING_DECIDE';
  const ROLLBACK = new Error('rollback');
  const NOW = new Date('2040-03-01T15:00:00Z');
  const PHONE = '+19415550177';

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    decide = require('../services/sms-scheduling-decide');
    process.env[GATE] = 'true';
  }, 60000);
  afterAll(async () => {
    delete process.env[GATE];
    if (knex) await knex.destroy();
    await require('../models/db').destroy();
  });

  const inTrx = (fn) => expect(knex.transaction(async (trx) => { await fn(trx); throw ROLLBACK; })).rejects.toBe(ROLLBACK);

  async function seed(trx) {
    const customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${customerId}@example.invalid`, phone: PHONE,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    const [decision] = await trx('agent_decisions').insert({
      workflow: 'sms_reply', agent_name: 'decide-test', decision_version: 'test', suggested_message: 'offer',
    }).returning('id');
    const [offer] = await trx('sms_offers').insert({
      agent_decision_id: decision.id || decision, phone_last10: PHONE.slice(-10), customer_id: customerId,
      kind: 'book_new', service_key: 'pest_control',
      slots: JSON.stringify([{ date_label: 'Tuesday, March 6', window_label: '10:00 AM - 12:00 PM', date: '2040-03-06', start: '10:00', end: '12:00' }]),
      sent_at: new Date('2040-03-01T13:00:00Z'), expires_at: new Date('2040-03-03T13:00:00Z'), status: 'open',
      // Recorded after the 14:59 reply: the case the reply sweep exists for.
      created_at: new Date('2040-03-01T15:05:00Z'),
    }).returning('id');
    const [inbound] = await trx('sms_log').insert({
      customer_id: customerId, direction: 'inbound', from_phone: PHONE, to_phone: '+19415550199',
      message_body: 'Tuesday works', status: 'received', created_at: new Date('2040-03-01T14:59:00Z'),
      message_type: 'inbound', metadata: JSON.stringify({ source: 'location' }),
    }).returning('id');
    return { customerId, offerId: offer.id || offer, inboundId: inbound.id || inbound };
  }

  test('one shadow row per offer and text; a rerun records nothing', () => inTrx(async (trx) => {
    const { customerId, offerId, inboundId } = await seed(trx);
    const llm = { dispatch: jest.fn(async () => ({ ok: true, json: { action: 'accept_slot', slot_number: 1, customer_quote: 'Tuesday works', confidence: 'high' }, servedModel: 'claude-sonnet-5-5' })) };
    const customer = await trx('customers').where({ id: customerId }).first();
    const slotRecheck = jest.fn(async () => ({ ok: true }));
    const args = { customer, inboundBody: 'Tuesday works', inboundSmsLogId: inboundId, fromPhone: PHONE, now: NOW, dbh: trx, llm, slotRecheck };

    const first = await decide.runShadowDecision(args);
    expect(first).toMatchObject({ recorded: true, outcome: 'would_book' });
    const row = await trx('sms_offer_decisions').where({ id: first.id }).first();
    expect(row).toMatchObject({ sms_offer_id: offerId, inbound_sms_log_id: inboundId, mode: 'shadow', action: 'accept_slot', slot_number: 1, outcome: 'would_book', model: 'claude-sonnet-5-5' });
    expect(row.would_have).toMatchObject({ kind: 'book_new', service_key: 'pest_control', date: '2040-03-06', start: '10:00', arrival_end: '12:00' });
    expect(slotRecheck).toHaveBeenCalledTimes(1);
    expect(row.refusals).toEqual([]);

    const second = await decide.runShadowDecision(args);
    expect(second).toMatchObject({ recorded: false, reason: 'already_decided' });
    expect(llm.dispatch).toHaveBeenCalledTimes(1);
    // Shadow: the offer itself is untouched.
    expect(await trx('sms_offers').where({ id: offerId }).first('status')).toEqual({ status: 'open' });
  }));

  test('a reply from another number on the customer\'s file is decided through the offer\'s customer', () => inTrx(async (trx) => {
    const { customerId, inboundId } = await seed(trx);
    const second = '+19415550178';
    await trx('customers').where({ id: customerId }).update({ service_contact_phone: second });
    await trx('sms_offers').where({ customer_id: customerId }).update({ phone_last10: second.slice(-10) });
    await trx('sms_log').where({ id: inboundId }).update({ from_phone: second });
    const llm = { dispatch: jest.fn(async () => ({ ok: true, json: { action: 'accept_slot', slot_number: 1, customer_quote: 'Tuesday works', confidence: 'high' } })) };
    const result = await decide.runShadowDecision({ customer: null, inboundBody: 'Tuesday works', inboundSmsLogId: inboundId, fromPhone: second, now: NOW, dbh: trx, llm, slotRecheck: async () => ({ ok: true }) });
    expect(result).toMatchObject({ recorded: true, outcome: 'would_book' });
    expect(await trx('sms_offer_decisions').where({ id: result.id }).first('customer_id')).toEqual({ customer_id: customerId });
  }));

  test('a replacement offer sent after the text arrived is not the one it answered', () => inTrx(async (trx) => {
    const { customerId, offerId, inboundId } = await seed(trx);
    // Staff send a new offer at 14:59:30, after the 14:59 reply: the old one is superseded as of then.
    const [later] = await trx('agent_decisions').insert({ workflow: 'sms_reply', agent_name: 'decide-test', decision_version: 'test', suggested_message: 'offer 2' }).returning('id');
    const closedAt = new Date('2040-03-01T14:59:30Z');
    await trx('sms_offers').where({ id: offerId }).update({ status: 'superseded', closed_at: closedAt });
    await trx('sms_offers').insert({
      agent_decision_id: later.id || later, phone_last10: PHONE.slice(-10), customer_id: customerId, kind: 'book_new', service_key: 'pest_control',
      slots: JSON.stringify([{ date_label: 'Friday, March 9', window_label: '1:00 PM - 3:00 PM', date: '2040-03-09', start: '13:00', end: '15:00' }]),
      sent_at: closedAt, expires_at: new Date('2040-03-03T14:59:30Z'), status: 'open',
    });
    const customer = await trx('customers').where({ id: customerId }).first();
    const llm = { dispatch: jest.fn(async () => ({ ok: true, json: { action: 'accept_slot', slot_number: 1, customer_quote: 'Tuesday works', confidence: 'high' } })) };
    const result = await decide.runShadowDecision({ customer, inboundBody: 'Tuesday works', inboundSmsLogId: inboundId, fromPhone: PHONE, now: NOW, dbh: trx, llm, slotRecheck: async () => ({ ok: true }) });
    expect(result).toMatchObject({ recorded: true });
    // Only the offer standing at 14:59 was shown, and the decision is filed against it.
    expect(llm.dispatch.mock.calls[0][1].text).toContain('Tuesday, March 6');
    expect(llm.dispatch.mock.calls[0][1].text).not.toContain('Friday, March 9');
    expect(await trx('sms_offer_decisions').where({ id: result.id }).first('sms_offer_id')).toEqual({ sms_offer_id: offerId });
  }));

  test('a reply that arrived before its offer was recorded is decided by the sweep, once', () => inTrx(async (trx) => {
    const { inboundId } = await seed(trx);
    const llm = { dispatch: jest.fn(async () => ({ ok: true, json: { action: 'accept_slot', slot_number: 1, customer_quote: 'Tuesday works', confidence: 'high' } })) };
    const run = (args) => decide.runShadowDecision({ ...args, llm, slotRecheck: async () => ({ ok: true }) });
    const later = new Date('2040-03-01T15:10:00Z');
    const first = await decide.sweepUndecidedReplies({ now: later, dbh: trx, run });
    expect(first).toMatchObject({ recorded: 1, errors: 0 });
    expect(await trx('sms_offer_decisions').where({ inbound_sms_log_id: inboundId }).count('* as n').first()).toMatchObject({ n: '1' });
    expect(await decide.sweepUndecidedReplies({ now: later, dbh: trx, run })).toMatchObject({ scanned: 0 });
  }));

  test('the sweep skips a reply another handler consumed, and pages past tapbacks to the real reply', () => inTrx(async (trx) => {
    const { customerId, inboundId } = await seed(trx);
    // A reminder "1" the reply-1/2 handler took, and two loud tapbacks, all before the real reply.
    const at = (m) => new Date(Date.parse('2040-03-01T14:50:00Z') + m * 60000);
    const extra = (body, type, m) => ({ customer_id: customerId, direction: 'inbound', from_phone: PHONE, to_phone: '+19415550199',
      message_body: body, status: 'received', message_type: type, created_at: at(m), metadata: JSON.stringify({ source: 'location' }) });
    await trx('sms_log').insert([extra('1', 'reschedule_reply', 0), extra('Liked \u201cWe can do Tuesday\u201d', 'inbound', 1), extra('Loved \u201cok\u201d', 'inbound', 2)]);
    const run = jest.fn(async () => ({ recorded: true }));
    await decide.sweepUndecidedReplies({ now: new Date('2040-03-01T15:10:00Z'), dbh: trx, run, batchSize: 1 });
    expect(run.mock.calls.map((c) => c[0].inboundSmsLogId)).toEqual([inboundId]);
  }));

  test('the sweep recovers a reply whose webhook decision was lost (its offer was recorded before it)', () => inTrx(async (trx) => {
    const { offerId, inboundId } = await seed(trx);
    await trx('sms_offers').where({ id: offerId }).update({ created_at: new Date('2040-03-01T13:00:01Z') });
    const run = jest.fn(async () => ({ recorded: true }));
    await decide.sweepUndecidedReplies({ now: new Date('2040-03-01T15:10:00Z'), dbh: trx, run });
    expect(run.mock.calls.map((c) => c[0].inboundSmsLogId)).toEqual([inboundId]);
  }));

  test('one decision per text, even across two offers', () => inTrx(async (trx) => {
    const { customerId, offerId, inboundId } = await seed(trx);
    const [d2] = await trx('agent_decisions').insert({ workflow: 'sms_reply', agent_name: 'decide-test', decision_version: 'test', suggested_message: 'offer 2' }).returning('id');
    const [o2] = await trx('sms_offers').insert({
      agent_decision_id: d2.id || d2, phone_last10: PHONE.slice(-10), customer_id: customerId, kind: 'book_estimate',
      slots: '[]', sent_at: new Date('2040-03-01T13:00:00Z'), expires_at: new Date('2040-03-03T13:00:00Z'), status: 'open',
    }).returning('id');
    await trx('sms_offer_decisions').insert({ sms_offer_id: offerId, inbound_sms_log_id: inboundId, outcome: 'no_action' });
    await expect(trx.transaction((sp) => sp('sms_offer_decisions').insert({ sms_offer_id: o2.id || o2, inbound_sms_log_id: inboundId, outcome: 'staff' })))
      .rejects.toThrow(/sms_offer_decisions_one_per_inbound/);
  }));

  test('the sweep leaves a reply the reminder reply handler answered, even when its retype failed', () => inTrx(async (trx) => {
    const { customerId } = await seed(trx);
    await trx('reschedule_log').insert({ customer_id: customerId, customer_response: 'option_1', customer_response_text: 'Tuesday works', sms_responded_at: new Date('2040-03-01T14:59:02Z'), created_at: new Date('2040-03-01T12:00:00Z') });
    const run = jest.fn(async () => ({ recorded: true }));
    await decide.sweepUndecidedReplies({ now: new Date('2040-03-01T15:10:00Z'), dbh: trx, run });
    expect(run).not.toHaveBeenCalled();
  }));

  test('a failed model call records an error row and moves nothing', () => inTrx(async (trx) => {
    const { customerId, inboundId } = await seed(trx);
    const customer = await trx('customers').where({ id: customerId }).first();
    const llm = { dispatch: jest.fn(async () => ({ ok: false, reason: 'anthropic_529' })) };
    const result = await decide.runShadowDecision({ customer, inboundBody: 'Tuesday works', inboundSmsLogId: inboundId, fromPhone: PHONE, now: NOW, dbh: trx, llm });
    expect(result).toMatchObject({ recorded: true, outcome: 'error' });
    expect(await trx('sms_offer_decisions').where({ id: result.id }).first('error')).toEqual({ error: 'anthropic_529' });
  }));
});
