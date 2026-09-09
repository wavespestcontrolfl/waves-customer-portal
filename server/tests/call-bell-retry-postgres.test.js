// CI's existing DB-gated pass runs this against PostgreSQL. All fixture data
// lives in a unique schema that is removed after the suite; delivery is mocked.
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
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
const { triggerNotification } = require('../services/notification-triggers');
const logger = require('../services/logger');
const { gates } = require('../config/feature-gates');
const { ringMissedCallIfUnanswered, sweepMissedCalls } = require('../services/missed-call-bell');
const { ringRepeatCallerIfNeeded, sweepRepeatCallers } = require('../services/repeat-caller-bell');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('call bell retries on PostgreSQL', () => {
  let database;
  const schema = `call_retry_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'scheduled_services', 'customers', 'notifications', 'blocked_numbers', 'blocked_call_attempts'];
  let now;
  const gateNames = ['missedCallUnknownCallers', 'repeatCallerBell'];
  const savedGates = Object.fromEntries(gateNames.map(key => [key, gates[key]]));
  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
    gateNames.forEach(key => { gates[key] = true; });
  });
  beforeEach(async () => {
    now = Date.now();
    jest.clearAllMocks();
    triggerNotification.mockResolvedValue({ bellWritten: true });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]);
    expect(logger.warn.mock.calls).toEqual([]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
    Object.assign(gates, savedGates);
  });

  function call(minsAgo, extra = {}) {
    return {
      id: randomUUID(), twilio_call_sid: `CA${randomUUID().replaceAll('-', '')}`,
      direction: 'inbound', from_phone: '+19415550100', customer_id: null,
      status: 'no-answer', answered_by: 'missed', metadata: {},
      created_at: new Date(now - minsAgo * 60000), updated_at: new Date(now - minsAgo * 60000),
      ...extra,
    };
  }

  test('ineligible rows cannot fill the oldest 50 slots and starve the next missed call', async () => {
    const rejected = Array.from({ length: 100 }, (_, i) => call(120, i % 2
      ? { from_phone: 'anonymous' }
      : { metadata: { addons: { results: { nomorobo_spamscore: { status: 'successful', result: { score: 1 } } } } } }));
    const eligible = call(10);
    await mockConn('call_log').insert([...rejected, eligible]);
    // Preserve sub-millisecond timestamps when paging tied dates.
    await mockConn('call_log').whereIn('id', rejected.map(row => row.id))
      .update({ created_at: mockConn.raw("created_at + interval '123 microseconds'") });
    expect(await sweepMissedCalls()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification.mock.calls[0][1].callLogId).toBe(eligible.id);
    expect((await mockConn('call_log').where({ id: eligible.id }).first()).metadata.missed_call_settled_at).toBeTruthy();
    expect(await sweepMissedCalls()).toBe(0);
  });

  test('permanently ineligible calls are excluded before the missed-call page is loaded', async () => {
    const rejected = [
      { from_phone: 'anonymous' },
      { from_phone: '+17378742833' },
      { recording_url: 'https://example.invalid/recording' },
      { voicemail_callback_alerted_at: new Date(now) },
      { call_outcome: 'ai_handled' },
      { call_outcome: 'ai_transferred' },
      ...[1, '1', true].map(score => ({ metadata: { addons: { results: { nomorobo_spamscore: { status: 'successful', result: { score } } } } } })),
    ].map(extra => call(120, extra));
    const eligible = call(10);
    await database('call_log').insert([...rejected, eligible]);
    const queries = [];
    const listener = query => { if (query.sql.includes('AS sweep_created_at')) queries.push(query); };
    database.on('query', listener);
    try {
      expect(await sweepMissedCalls({ limit: 1 })).toBe(1);
      expect(queries).toHaveLength(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      expect(triggerNotification.mock.calls[0][1].callLogId).toBe(eligible.id);
    } finally { database.removeListener('query', listener); }
  });

  test.each(['+7378742833', '+17378742833'])('numeric withheld callers stay silent through both sweeps: %s', async phone => {
    const rows = [call(60, { from_phone: phone }), call(30, { from_phone: phone }), call(10, { from_phone: phone })];
    await mockConn('call_log').insert(rows);
    expect(await sweepMissedCalls()).toBe(0);
    expect(await sweepRepeatCallers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test.each(['timer', 'sweep'])('international E.164 identity is preserved by the %s query', async entry => {
    const rows = [call(60), call(30), call(10)].map(row => ({ ...row, from_phone: '+6791234567' }));
    // Same digits without '+' are a domestic identity and cannot join this window.
    const domestic = call(20, { from_phone: '6791234567' });
    await mockConn('call_log').insert([...rows, domestic]);
    if (entry === 'timer') expect(await ringRepeatCallerIfNeeded(rows[2].twilio_call_sid)).toBe(true);
    else expect(await sweepRepeatCallers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification.mock.calls[0][1]).toMatchObject({ count: 3, phone: '+6791234567' });
  });

  test('bare domestic and formatted E.164 calls share one repeat window', async () => {
    const rows = [call(60, { from_phone: '9415550100' }), call(30, { from_phone: '+1 (941) 555-0100' }), call(10)];
    await mockConn('call_log').insert(rows);
    expect(await sweepRepeatCallers()).toBe(1);
    expect(triggerNotification.mock.calls[0][1].count).toBe(3);
    expect(await ringRepeatCallerIfNeeded(rows[2].twilio_call_sid)).toBe(false);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test.each(['timer', 'sweep'])('%s waits for the newest call to terminate and finish its grace', async entry => {
    const rows = [call(60), call(30), call(10, { status: 'in-progress', answered_by: 'human' })];
    await mockConn('call_log').insert(rows);
    const run = () => entry === 'timer' ? ringRepeatCallerIfNeeded(rows[0].twilio_call_sid) : sweepRepeatCallers();
    expect(Boolean(await run())).toBe(false);
    await mockConn('call_log').where({ id: rows[2].id }).update({ status: 'completed', updated_at: new Date(now - 60000) });
    expect(Boolean(await run())).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
    await mockConn('call_log').where({ id: rows[2].id }).update({ updated_at: new Date(now - 6 * 60000) });
    expect(Boolean(await run())).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test.each(['timer', 'sweep'])('%s waits for an earlier overlapping call to terminate', async entry => {
    const rows = [call(60, { status: 'in-progress', answered_by: 'human' }), call(30), call(10)];
    await database('call_log').insert(rows);
    const run = () => entry === 'timer' ? ringRepeatCallerIfNeeded(rows[2].twilio_call_sid) : sweepRepeatCallers();
    expect(Boolean(await run())).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
    await database('call_log').where({ id: rows[0].id }).update({ status: 'completed' });
    expect(Boolean(await run())).toBe(true);
    expect(triggerNotification.mock.calls[0][1]).toMatchObject({ count: 3, unanswered: 2 });
  });

  test('a booking committed after the claim suppresses delivery and releases the lease', async () => {
    const customerId = randomUUID();
    const rows = [call(60), call(30), call(10, { customer_id: customerId })];
    await database('call_log').insert(rows);
    await database('customers').insert({ id: customerId });
    const query = database.client.query;
    jest.spyOn(database.client, 'query').mockImplementation(async function (connection, request) {
      const result = await query.call(this, connection, request);
      if (request.sql.startsWith('select') && request.sql.includes('from "customers"')) {
        await database('scheduled_services').insert({ id: randomUUID(), source_call_log_id: rows[2].id, status: 'confirmed' });
      }
      return result;
    });
    expect(await ringRepeatCallerIfNeeded(rows[2].twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
    expect((await database('call_log').where({ id: rows[2].id }).first()).metadata.repeat_caller_claim).toBeUndefined();
    expect(await sweepRepeatCallers()).toBe(0);
  });

  test.each(['push', 'bell-only'])('a booking committed during %s notification delivery retires only its repeat bell', async delivery => {
    const rows = [call(60), call(30), call(10)];
    await database('call_log').insert(rows);
    const repeatId = randomUUID();
    const missedId = randomUUID();
    const otherId = randomUUID();
    triggerNotification.mockImplementationOnce(async (_trigger, _payload, { beforePush }) => {
      expect(await beforePush()).toBe(true);
      await database('notifications').insert([
        { id: repeatId, recipient_type: 'admin', category: 'missed_call', metadata: { triggerKey: 'repeat_caller', payload: { callLogId: rows[2].id } } },
        { id: missedId, recipient_type: 'admin', category: 'missed_call', metadata: { triggerKey: 'customer_missed_call', payload: { callLogId: rows[2].id } } },
        { id: otherId, recipient_type: 'admin', category: 'missed_call', metadata: { triggerKey: 'repeat_caller', payload: { callLogId: rows[1].id } } },
      ]);
      await database('scheduled_services').insert({ id: randomUUID(), source_call_log_id: rows[0].id, status: 'confirmed' });
      if (delivery === 'push') expect(await beforePush()).toBe(false);
      return { bellWritten: true, push: delivery === 'push' ? { sent: 0, skipped: 'superseded_before_push' } : null };
    });
    expect(await ringRepeatCallerIfNeeded(rows[2].twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect((await database('notifications').where({ id: repeatId }).first()).read_at).not.toBeNull();
    expect((await database('notifications').where({ id: missedId }).first()).read_at).toBeNull();
    expect((await database('notifications').where({ id: otherId }).first()).read_at).toBeNull();
  });

  test.each(['hard_block', 'marchex_auto'])('centrally blocked %s callers stay silent and cannot fill the repeat sweep limit', async blockType => {
    const rows = [call(60), call(30), call(10)];
    if (blockType === 'hard_block') {
      rows[1].from_phone = '9415550100';
      rows[2].from_phone = '(941) 555-0100';
    }
    await database('call_log').insert(rows);
    if (blockType === 'hard_block') {
      await database('blocked_numbers').insert({ number: rows[0].from_phone, block_type: blockType });
    } else {
      await database('blocked_call_attempts').insert(rows.map(row => ({ number: row.from_phone, channel: 'voice', block_type: blockType, twilio_sid: row.twilio_call_sid })));
    }
    expect(await ringRepeatCallerIfNeeded(rows[2].twilio_call_sid)).toBe(false);
    expect(await sweepRepeatCallers({ limit: 1 })).toBe(0);
    expect(await ringMissedCallIfUnanswered(rows[2].twilio_call_sid)).toBe(false);
    expect(await sweepMissedCalls({ limit: 1 })).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
    // An international caller with the same domestic suffix is independent.
    await database('call_log').insert([call(60), call(30), call(10)].map(row => ({ ...row, from_phone: '+449415550100' })));
    expect(await sweepRepeatCallers({ limit: 1 })).toBe(1);
    expect(triggerNotification.mock.calls[0][1].phone).toBe('+449415550100');
  });

  test('Marchex shadow-only attempts remain eligible for repeat alerts', async () => {
    const rows = [call(60), call(30), call(10)];
    await database('call_log').insert(rows);
    await database('blocked_call_attempts').insert(rows.map(row => ({ number: row.from_phone, channel: 'voice', block_type: 'marchex_shadow', twilio_sid: row.twilio_call_sid })));
    expect(await sweepRepeatCallers()).toBe(1);
    expect(await ringMissedCallIfUnanswered(rows[2].twilio_call_sid)).toBe(true);
  });

  test('a blocked attempt cannot claim an eligible sibling window', async () => {
    const rows = [call(60), call(45), call(30), call(10)];
    await database('call_log').insert(rows);
    await database('blocked_call_attempts').insert({ number: rows[3].from_phone, channel: 'voice', block_type: 'marchex_auto', twilio_sid: rows[3].twilio_call_sid });
    expect(await ringRepeatCallerIfNeeded(rows[3].twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(await sweepRepeatCallers()).toBe(1);
    expect(triggerNotification.mock.calls[0][1]).toMatchObject({ count: 3, callLogId: rows[2].id });
  });

  test('a booking made during the newest call keeps the repeat window quiet after termination', async () => {
    const rows = [call(60), call(30), call(10, { status: 'in-progress', answered_by: 'human' })];
    await mockConn('call_log').insert(rows);
    expect(await sweepRepeatCallers()).toBe(0);
    await mockConn('scheduled_services').insert({ id: randomUUID(), source_call_log_id: rows[2].id, status: 'confirmed' });
    await mockConn('call_log').where({ id: rows[2].id }).update({ status: 'completed', updated_at: new Date(now - 6 * 60000) });
    expect(await sweepRepeatCallers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });
  test('a repeat bell cannot settle a stale missed-call lease', async () => {
    const row = call(30, { metadata: { missed_call_notified_at: new Date(now - 20 * 60000).toISOString() } });
    await database('call_log').insert(row);
    await database('notifications').insert({ recipient_type: 'admin', category: 'missed_call', metadata: { triggerKey: 'repeat_caller', payload: { callLogId: row.id } } });
    expect(await sweepMissedCalls()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledWith('customer_missed_call', expect.objectContaining({ callLogId: row.id }), expect.any(Object));
  });
  test('booked windows cannot occupy the sweep limit ahead of an eligible caller', async () => {
    const booked = [call(60), call(30), call(10)];
    const eligible = [call(60), call(30), call(10)].map(row => ({ ...row, from_phone: '+19415550101' }));
    await database('call_log').insert([...booked, ...eligible]);
    await database('scheduled_services').insert({ id: randomUUID(), source_call_log_id: booked[2].id, status: 'confirmed' });
    expect(await sweepRepeatCallers({ limit: 1 })).toBe(1);
    expect(triggerNotification.mock.calls[0][1].phone).toBe('+19415550101');
  });
  test('push-only recovery keeps one delivery identity through two newer calls', async () => {
    const rows = [call(90), call(60), call(30)];
    await database('call_log').insert(rows);
    triggerNotification.mockResolvedValue({ push: { sent: 1 } });
    const query = database.client.query;
    let failedSettles = 2;
    jest.spyOn(database.client, 'query').mockImplementation(function (connection, request) {
      if (failedSettles && request.sql.startsWith('update') && request.sql.includes("jsonb_build_object('repeat_caller_alerted_at'")) {
        failedSettles -= 1;
        return Promise.reject(new Error('simulated crash before settlement'));
      }
      return query.call(this, connection, request);
    });
    let newest = rows[2];
    for (const minutes of [20, 10, null]) {
      expect(await ringRepeatCallerIfNeeded(newest.twilio_call_sid)).toBe(true);
      if (minutes) {
        await database('call_log').where({ id: newest.id }).update({ metadata: database.raw("metadata || jsonb_build_object('repeat_caller_claim', ?::text)", [new Date(now - 15 * 60000).toISOString()]) });
        newest = call(minutes);
        await database('call_log').insert(newest);
      }
    }
    const payloads = triggerNotification.mock.calls.map(args => args[1]);
    expect(new Set(payloads.map(p => p.callLogId)).size).toBe(3);
    expect(payloads.map(p => p.repeatCallerDeliveryId)).toEqual([rows[2].id, rows[2].id, rows[2].id]);
    expect(await sweepRepeatCallers()).toBe(0);
  });
  test('a failed delivery releases the claim for a later attempt', async () => {
    const rows = [call(60), call(30), call(10)];
    await database('call_log').insert(rows);
    triggerNotification.mockRejectedValueOnce(new Error('synthetic delivery failure'));
    expect(await ringRepeatCallerIfNeeded(rows[2].twilio_call_sid)).toBe(false);
    expect((await database('call_log').where({ id: rows[2].id }).first()).metadata.repeat_caller_claim).toBeUndefined();
    expect(await sweepRepeatCallers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
    logger.warn.mockClear();
  });
  test('two connections racing sibling calls acquire only one delivery claim', async () => {
    const rows = [call(60), call(30), call(10)];
    await database('call_log').insert(rows);
    const results = await Promise.all(rows.slice(1).map(row => ringRepeatCallerIfNeeded(row.twilio_call_sid)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });
});
