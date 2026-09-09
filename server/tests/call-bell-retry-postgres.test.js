// CI's existing DB-gated pass runs this against PostgreSQL. All fixture data
// lives in temporary tables inside rolled-back transactions; delivery is mocked.
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
const { sweepMissedCalls } = require('../services/missed-call-bell');
const { ringRepeatCallerIfNeeded, sweepRepeatCallers } = require('../services/repeat-caller-bell');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('call bell retries on PostgreSQL', () => {
  let database;
  let now;
  const gateNames = ['missedCallUnknownCallers', 'repeatCallerBell'];
  const savedGates = Object.fromEntries(gateNames.map(key => [key, gates[key]]));
  beforeAll(() => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    gateNames.forEach(key => { gates[key] = true; });
  });
  beforeEach(async () => {
    now = Date.now();
    jest.clearAllMocks();
    triggerNotification.mockResolvedValue({ bellWritten: true });
    mockConn = await database.transaction();
    for (const table of ['call_log', 'scheduled_services', 'customers', 'notifications']) {
      await mockConn.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
    }
  });
  afterEach(async () => {
    await mockConn.rollback();
    expect(logger.warn.mock.calls).toEqual([]);
  });
  afterAll(async () => {
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

  test('a booking made during the newest call keeps the repeat window quiet after termination', async () => {
    const rows = [call(60), call(30), call(10, { status: 'in-progress', answered_by: 'human' })];
    await mockConn('call_log').insert(rows);
    expect(await sweepRepeatCallers()).toBe(0);
    await mockConn('scheduled_services').insert({ id: randomUUID(), source_call_log_id: rows[2].id, status: 'confirmed' });
    await mockConn('call_log').where({ id: rows[2].id }).update({ status: 'completed', updated_at: new Date(now - 6 * 60000) });
    expect(await sweepRepeatCallers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});
