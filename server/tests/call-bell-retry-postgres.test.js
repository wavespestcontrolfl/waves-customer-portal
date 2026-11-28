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
const { ringMissedCallIfUnanswered, sweepMissedCalls, retireCalledBackMissedCalls } = require('../services/missed-call-bell');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('call bell retries on PostgreSQL', () => {
  let database;
  const schema = `call_retry_${randomUUID().replaceAll('-', '')}`;
  // sms_log, estimates, message_drafts and leads: the contact-close clauses retireCalledBackMissedCalls also runs read them.
  // invoices: the visit-underway clause reads it.
  const tables = ['call_log', 'scheduled_services', 'invoices', 'customers', 'notifications', 'blocked_numbers', 'blocked_call_attempts', 'sms_log', 'estimates', 'message_drafts', 'leads'];
  let now;
  const gateNames = ['missedCallUnknownCallers'];
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
      status: 'no-answer', answered_by: 'missed', duration_seconds: 40, metadata: {},
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

  test('the sweep rings an unknown voicemail-path caller at 15 s and above, never below (owner ruling 2026-10-05)', async () => {
    const short = call(10, { answered_by: 'voicemail', status: 'completed', duration_seconds: 14, from_phone: '+19415550111' });
    const floor = call(10, { answered_by: 'voicemail', status: 'completed', duration_seconds: 15, from_phone: '+19415550112' });
    const mid = call(10, { answered_by: 'voicemail', status: 'completed', duration_seconds: 22, from_phone: '+19415550113' });
    await mockConn('call_log').insert([short, floor, mid]);
    expect(await sweepMissedCalls()).toBe(2);
    expect(triggerNotification.mock.calls.map(c => c[1].callLogId).sort()).toEqual([floor.id, mid.id].sort());
  });

  test('a redial that someone answered keeps the missed call out of the bell', async () => {
    const customer = randomUUID();
    const missed = call(10, { customer_id: customer, status: 'completed', answered_by: 'voicemail', duration_seconds: 10 });
    const redial = call(10, { customer_id: customer, status: 'completed', answered_by: 'human', duration_seconds: 199, from_phone: '9415550100' });
    redial.created_at = new Date(missed.created_at.getTime() + 20000);
    await database('call_log').insert([missed, redial]);
    expect(await sweepMissedCalls()).toBe(0);
    expect(await ringMissedCallIfUnanswered(missed.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
    expect((await database('call_log').where({ id: missed.id }).first()).metadata.missed_call_notified_at).toBeUndefined();
  });

  test('a callback whose customer leg was answered keeps the missed call quiet; an undialed one does not', async () => {
    const missed = call(10, { customer_id: randomUUID() });
    const undialed = call(9, { direction: 'outbound', from_phone: '+19415559999', to_phone: '+19415550100', status: 'no-answer', answered_by: null });
    await database('call_log').insert([missed, undialed]);
    expect(await ringMissedCallIfUnanswered(missed.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);

    const missed2 = call(8, { customer_id: randomUUID(), from_phone: '+19415550101' });
    const bridged = call(7, { direction: 'outbound', from_phone: '+19415559999', to_phone: '9415550101', status: 'completed', answered_by: null, bridged_at: new Date(now - 7 * 60000), metadata: { customer_leg: { status: 'completed', duration_seconds: 42 } } });
    await database('call_log').insert([missed2, bridged]);
    expect(await sweepMissedCalls()).toBe(0);
    expect(await ringMissedCallIfUnanswered(missed2.twilio_call_sid)).toBe(false);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a redial answered during delivery stops the bell write and the push', async () => {
    const customer = randomUUID();
    const missed = call(10, { customer_id: customer });
    await database('call_log').insert(missed);
    const verdicts = {};
    triggerNotification.mockImplementationOnce(async (_key, _payload, opts) => {
      verdicts.before = await opts.shouldContinue({ database });
      await database('call_log').insert(call(1, { customer_id: customer, status: 'completed', answered_by: 'human' }));
      verdicts.bell = await opts.shouldContinue({ database });
      verdicts.push = await opts.beforePush({ dispatching: true });
      return { bellWritten: false, suppressed: true };
    });
    await ringMissedCallIfUnanswered(missed.twilio_call_sid);
    expect(verdicts).toEqual({ before: true, bell: false, push: false });
  });

  test('a later recording the voicemail lane did not alert on still lets the missed call ring', async () => {
    const customer = randomUUID();
    const missed = call(10, { customer_id: customer });
    const deadAir = call(9, { customer_id: customer, status: 'completed', answered_by: 'voicemail', recording_sid: `RE${randomUUID().replaceAll('-', '')}` });
    await database('call_log').insert([missed, deadAir]);
    expect(await sweepMissedCalls()).toBe(1);
    expect(triggerNotification.mock.calls[0][1].callLogId).toBe(missed.id);

    const missed2 = call(8, { customer_id: customer, from_phone: '+19415550102' });
    const alerted = call(7, { customer_id: customer, from_phone: '+19415550102', status: 'completed', answered_by: 'voicemail', recording_sid: `RE${randomUUID().replaceAll('-', '')}`, voicemail_callback_alerted_at: new Date(now - 6 * 60000) });
    await database('call_log').insert([missed2, alerted]);
    expect(await sweepMissedCalls()).toBe(0);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('an answered call from an international number that shares the last ten digits does not count', async () => {
    const missed = call(10, { customer_id: randomUUID(), from_phone: '+449415550100' });
    const other = call(9, { status: 'completed', answered_by: 'human', from_phone: '+19415550100' });
    await database('call_log').insert([missed, other]);
    expect(await ringMissedCallIfUnanswered(missed.twilio_call_sid)).toBe(true);
    expect(triggerNotification.mock.calls[0][1].callLogId).toBe(missed.id);
  });

  test('an earlier answered call or a later unanswered redial still rings', async () => {
    const customer = randomUUID();
    const earlier = call(30, { customer_id: customer, status: 'completed', answered_by: 'human' });
    const missed = call(10, { customer_id: customer });
    const hangup = call(9, { customer_id: customer });
    await database('call_log').insert([earlier, missed, hangup]);
    expect(await ringMissedCallIfUnanswered(missed.twilio_call_sid)).toBe(true);
    expect(triggerNotification.mock.calls[0][1].callLogId).toBe(missed.id);
  });

  function bell(callRow, extra = {}) {
    return {
      id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'Missed call',
      metadata: { triggerKey: 'customer_missed_call', payload: { callLogId: callRow.id } },
      created_at: new Date(now - 5 * 60000), ...extra,
    };
  }

  test('a missed-call bell retires once the caller gets through on a later call', async () => {
    const customer = randomUUID();
    const missed = call(30, { customer_id: customer });
    await database('call_log').insert(missed);
    const open = bell(missed);
    const repeat = bell(missed, { metadata: { triggerKey: 'repeat_caller', payload: { callLogId: missed.id } } });
    await database('notifications').insert([open, repeat]);
    expect(await retireCalledBackMissedCalls()).toBe(0);
    await database('call_log').insert(call(2, { customer_id: customer, status: 'completed', answered_by: 'human' }));
    expect(await retireCalledBackMissedCalls()).toBe(1);
    const row = await database('notifications').where({ id: open.id }).first();
    expect(row.done_at).toBeTruthy();
    expect(row.done_by).toBe('supersede');
    expect(row.resolution).toBe('The caller got through on a later call');
    expect((await database('notifications').where({ id: repeat.id }).first()).done_at).toBeNull();
    expect(await retireCalledBackMissedCalls()).toBe(0);
  });

  test('a bell stays open after an un-alerted recording, an undialed callback, or past the 7-day window', async () => {
    const customer = randomUUID();
    const missed = call(30, { customer_id: customer });
    const old = call(30, { customer_id: customer, from_phone: '+19415550109' });
    await database('call_log').insert([missed, old,
      call(20, { customer_id: customer, status: 'completed', answered_by: 'voicemail', recording_sid: `RE${randomUUID().replaceAll('-', '')}` }),
      call(19, { direction: 'outbound', from_phone: '+19415559999', to_phone: '+19415550100', status: 'no-answer', answered_by: null }),
      call(18, { customer_id: customer, from_phone: '+19415550109', status: 'completed', answered_by: 'human' }),
    ]);
    const stale = bell(old, { created_at: new Date(now - 8 * 24 * 60 * 60000) });
    await database('notifications').insert([bell(missed), stale]);
    expect(await retireCalledBackMissedCalls()).toBe(0);
    expect((await database('notifications').where({ id: stale.id }).first()).done_at).toBeNull();
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

  test.each(['+7378742833', '+17378742833'])('numeric withheld callers stay silent through the missed-call sweep: %s', async phone => {
    const rows = [call(60, { from_phone: phone }), call(30, { from_phone: phone }), call(10, { from_phone: phone })];
    await mockConn('call_log').insert(rows);
    expect(await sweepMissedCalls()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test.each(['hard_block', 'marchex_auto'])('centrally blocked %s callers stay silent and cannot fill the missed-call sweep limit', async blockType => {
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
    expect(await ringMissedCallIfUnanswered(rows[2].twilio_call_sid)).toBe(false);
    expect(await sweepMissedCalls({ limit: 1 })).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
    // An international caller with the same domestic suffix is independent.
    await database('call_log').insert(call(10, { from_phone: '+449415550100' }));
    expect(await sweepMissedCalls({ limit: 1 })).toBe(1);
    expect(triggerNotification.mock.calls[0][1].phone).toBe('+449415550100');
  });

  test('Marchex shadow-only attempts remain eligible for missed-call alerts', async () => {
    const rows = [call(60), call(30), call(10)];
    await database('call_log').insert(rows);
    await database('blocked_call_attempts').insert(rows.map(row => ({ number: row.from_phone, channel: 'voice', block_type: 'marchex_shadow', twilio_sid: row.twilio_call_sid })));
    expect(await ringMissedCallIfUnanswered(rows[2].twilio_call_sid)).toBe(true);
  });

  test('a historical repeat bell cannot settle a stale missed-call lease', async () => {
    const row = call(30, { metadata: { missed_call_notified_at: new Date(now - 20 * 60000).toISOString() } });
    await database('call_log').insert(row);
    await database('notifications').insert({ recipient_type: 'admin', category: 'missed_call', metadata: { triggerKey: 'repeat_caller', payload: { callLogId: row.id } } });
    expect(await sweepMissedCalls()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledWith('customer_missed_call', expect.objectContaining({ callLogId: row.id }), expect.any(Object));
  });
});
