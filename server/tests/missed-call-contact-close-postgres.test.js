// GATE_ALERT_CONTACT_CLOSE (owner 2026-10-24, approved 2026-10-26) on PostgreSQL: the
// missed-call bell's ONE owner, missed-call-bell.js retireCalledBackMissedCalls, also closes
// a bell once a person's text reached the caller, a visit was booked, or a quote was handed
// off, each AFTER the call began (the call's real start, even for a row inserted after the
// call was over). Off = nothing runs; shadow = audit_log rows only; true = retired through
// supersedeMissedCallAdmin. Admin bell only; nothing is sent. CI's DATABASE_URL pass runs
// this; fixture rows live in a unique schema removed after the suite. Synthetic data only.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const missedCallBell = require('../services/missed-call-bell');

jest.setTimeout(60000);
(SKIP ? describe.skip : describe)('missed-call bell, contact close, on PostgreSQL', () => {
  let database;
  const schema = `call_contact_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'sms_log', 'scheduled_services', 'estimates', 'leads', 'message_drafts', 'customers', 'notifications', 'audit_log'];
  const CALL_AT = new Date('2026-10-20T17:05:00Z');
  const mins = (m) => new Date(CALL_AT.getTime() + m * 60 * 1000);
  const BIZ = '+19412975749';
  const CALLER = '+19415550100';
  let customerId;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
  });
  beforeEach(async () => {
    customerId = randomUUID();
    await database('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Synthetic', phone: CALLER });
  });
  afterEach(async () => {
    delete process.env.GATE_ALERT_CONTACT_CLOSE;
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const sid = (p) => `${p}${randomUUID().replaceAll('-', '')}`;
  const gate = (mode) => { process.env.GATE_ALERT_CONTACT_CLOSE = mode; };
  async function missedCall(extra = {}) {
    const row = {
      id: randomUUID(), twilio_call_sid: sid('CA'), direction: 'inbound', from_phone: CALLER, to_phone: BIZ, customer_id: customerId,
      status: 'no-answer', answered_by: 'missed', duration_seconds: 0, metadata: JSON.stringify({}), created_at: CALL_AT, updated_at: CALL_AT, ...extra,
    };
    await database('call_log').insert(row);
    return row;
  }
  async function bell(call) {
    const row = {
      id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'Missed call - Pat Synthetic', body: 'Called and left no voicemail.',
      link: `/admin/communications#tab=calls&call=${call.id}`, created_at: new Date(),
      metadata: JSON.stringify({ triggerKey: 'customer_missed_call', payload: { callLogId: call.id, phone: CALLER } }),
    };
    await database('notifications').insert(row);
    return row;
  }
  const staffText = (at, over = {}) => database('sms_log').insert({
    id: randomUUID(), direction: 'outbound', from_phone: BIZ, to_phone: CALLER, customer_id: customerId, message_body: 'Sorry we missed you.',
    message_type: 'manual', status: 'delivered', twilio_sid: sid('SM'), metadata: JSON.stringify({ human_authored: true }), created_at: at, ...over,
  });
  const state = async (row) => {
    const r = await database('notifications').where({ id: row.id }).first();
    return r.done_at ? [r.done_by, r.resolution] : null;
  };
  const wouldClose = (row) => database('audit_log').where({ action: 'notification.alert_relevance.would_close', resource_id: row.id });
  const run = () => missedCallBell.retireCalledBackMissedCalls();

  test('gate off: nothing new runs, however answered the call is', async () => {
    const call = await missedCall();
    const row = await bell(call);
    await staffText(mins(10));
    expect(await run()).toBe(0);
    expect(await state(row)).toBeNull();
    expect(await wouldClose(row)).toHaveLength(0);
  });

  test('shadow records what would close once per day and retires nothing; true closes it with the plain resolution', async () => {
    const call = await missedCall();
    const row = await bell(call);
    await staffText(mins(10));
    gate('shadow');
    expect(await run()).toBe(0);
    expect(await run()).toBe(0);
    expect(await state(row)).toBeNull();
    const logged = await wouldClose(row);
    expect(logged).toHaveLength(1);
    expect(logged[0].metadata).toMatchObject({ class: 'missed_call', reason: 'A person texted the caller after the call' });
    gate('true');
    expect(await run()).toBe(1);
    expect(await state(row)).toEqual(['supersede', 'A person texted the caller after the call']);
  });

  test('a person\'s text counts only when it is after the call, a person\'s, delivered, and to this caller (by customer or by phone)', async () => {
    gate('true');
    const before = await bell(await missedCall());
    await staffText(mins(-5));
    expect(await run()).toBe(0);
    expect(await state(before)).toBeNull();
    // An automated text, an undelivered one and another number's text do not count.
    await staffText(mins(5), { message_type: 'review_request', metadata: JSON.stringify({}) });
    await staffText(mins(5), { status: 'failed' });
    await staffText(mins(5), { customer_id: randomUUID(), to_phone: '+19415550199' });
    expect(await run()).toBe(0);
    // A person's text to the caller's number counts when it carries no customer (an unknown caller).
    await database('call_log').update({ customer_id: null });
    await staffText(mins(6), { customer_id: null });
    expect(await run()).toBe(1);
    expect(await state(before)).toEqual(['supersede', 'A person texted the caller after the call']);
  });

  test('a call row inserted after the call was over is anchored on the call\'s real start: a text between the call and the delayed insert counts, one before the call does not', async () => {
    gate('true');
    // The status callback inserted this row 10 minutes after the call began (it lasted 10 minutes).
    const delayed = await missedCall({ created_at: mins(10), duration_seconds: 600, metadata: JSON.stringify({ source: 'status_callback', inserted_on_status: 'completed' }) });
    const row = await bell(delayed);
    await staffText(mins(-3));
    expect(await run()).toBe(0);
    await staffText(mins(5));
    expect(await run()).toBe(1);
    expect(await state(row)).toEqual(['supersede', 'A person texted the caller after the call']);
  });

  test('a visit booked for the call\'s customer after the call closes it; one before it, a cancelled one and a generated child do not', async () => {
    gate('true');
    const row = await bell(await missedCall());
    const visit = (over) => database('scheduled_services').insert({ id: randomUUID(), customer_id: customerId, scheduled_date: '2026-10-30',
      service_type: 'General Pest Control', status: 'confirmed', created_at: mins(30), ...over });
    await visit({ created_at: mins(-30) });
    await visit({ status: 'cancelled' });
    await visit({ recurring_parent_id: randomUUID() });
    expect(await run()).toBe(0);
    await visit({});
    expect(await run()).toBe(1);
    expect(await state(row)).toEqual(['supersede', 'A visit was booked after the call']);
  });

  test('a quote handed off to the call\'s customer after the call closes it; sent_at alone, an earlier delivery and another customer\'s quote do not', async () => {
    gate('true');
    const row = await bell(await missedCall());
    const delivered = (at) => JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } });
    await database('estimates').insert({ id: randomUUID(), customer_id: customerId, status: 'sent', sent_at: mins(40) });
    await database('estimates').insert({ id: randomUUID(), customer_id: customerId, status: 'sent', sent_at: mins(-60), estimate_data: delivered(mins(-60)) });
    await database('estimates').insert({ id: randomUUID(), customer_id: randomUUID(), status: 'sent', sent_at: mins(40), estimate_data: delivered(mins(40)) });
    expect(await run()).toBe(0);
    await database('estimates').insert({ id: randomUUID(), customer_id: customerId, status: 'sent', sent_at: mins(40), estimate_data: delivered(mins(40)) });
    expect(await run()).toBe(1);
    expect(await state(row)).toEqual(['supersede', 'An estimate was sent after the call']);
  });

  // n open bells (each with its own call) for one customer, ids ascending from `from` so the order is known.
  async function manyBells(n, { customer = customerId, from = 0 } = {}) {
    const calls = [];
    const bells = [];
    for (let i = from; i < from + n; i += 1) {
      const id = randomUUID();
      calls.push({ id, twilio_call_sid: sid('CA'), direction: 'inbound', from_phone: CALLER, to_phone: BIZ, customer_id: customer, status: 'no-answer',
        answered_by: 'missed', duration_seconds: 0, metadata: JSON.stringify({}), created_at: CALL_AT, updated_at: CALL_AT });
      bells.push({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, recipient_type: 'admin', category: 'missed_call', title: 'Missed call', body: 'Called.',
        link: `/admin/communications#tab=calls&call=${id}`, created_at: new Date(),
        metadata: JSON.stringify({ triggerKey: 'customer_missed_call', payload: { callLogId: id, phone: CALLER } }) });
    }
    for (let i = 0; i < n; i += 100) {
      await database('call_log').insert(calls.slice(i, i + 100));
      await database('notifications').insert(bells.slice(i, i + 100));
    }
    return bells;
  }

  // The closer on its own: the called-back proof in front of it scans every open bell's calls
  // (no indexes in this fixture schema), which is not what these tests are about.
  const closeOnly = () => missedCallBell.closeContactedMissedCalls();

  test('the whole candidate set is walked every run: an eligible quote bell after many non-matching candidates closes in one run', async () => {
    gate('true');
    // 520 open bells for a customer with no quote (past the old 500-row candidate cap, over two pages), then ONE for a customer whose quote was handed off after the call.
    const fillers = await manyBells(520);
    const quoted = randomUUID();
    await database('customers').insert({ id: quoted, first_name: 'Quoted', last_name: 'Synthetic', phone: '+19415550177' });
    const call = await missedCall({ customer_id: quoted, from_phone: '+19415550177' });
    const late = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', recipient_type: 'admin', category: 'missed_call', title: 'Missed call', body: 'Called.',
      link: `/admin/communications#tab=calls&call=${call.id}`, created_at: new Date(),
      metadata: JSON.stringify({ triggerKey: 'customer_missed_call', payload: { callLogId: call.id, phone: '+19415550177' } }) };
    await database('notifications').insert(late);
    const at = mins(40);
    await database('estimates').insert({ id: randomUUID(), customer_id: quoted, status: 'sent', sent_at: at,
      estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: at.toISOString(), lastDeliveredAt: at.toISOString() } }) });
    expect(await closeOnly()).toBe(1);
    expect(await state(late)).toEqual(['supersede', 'An estimate was sent after the call']);
    expect(await state(fillers[0])).toBeNull();
    // Run again: nothing left to close, nothing starves, nothing throws.
    expect(await closeOnly()).toBe(0);
  });

  test('shadow audits every matching bell across pages, and true then closes all of them in one run (no fixed cap)', async () => {
    await staffText(mins(10));
    const bells = await manyBells(450);
    gate('shadow');
    expect(await closeOnly()).toBe(0);
    const logged = await database('audit_log').where({ action: 'notification.alert_relevance.would_close' });
    expect(logged).toHaveLength(450);
    expect(new Set(logged.map((r) => r.resource_id))).toEqual(new Set(bells.map((b) => b.id)));
    // A second shadow run the same day adds nothing.
    await closeOnly();
    expect(await database('audit_log').where({ action: 'notification.alert_relevance.would_close' })).toHaveLength(450);
    gate('true');
    expect(await closeOnly()).toBe(450);
    expect(await database('notifications').whereNull('done_at')).toHaveLength(0);
  });

  test('the promise chaser and other missed-call-category bells are never touched', async () => {
    gate('true');
    const call = await missedCall();
    await staffText(mins(10));
    const chaser = { id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'Called back', created_at: new Date(),
      metadata: JSON.stringify({ triggerKey: 'promise_chaser', payload: { callLogId: call.id } }) };
    await database('notifications').insert(chaser);
    expect(await run()).toBe(0);
    expect(await state(chaser)).toBeNull();
  });
});
