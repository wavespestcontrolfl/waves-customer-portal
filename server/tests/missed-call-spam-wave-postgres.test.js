// CI's DB-gated pass runs this against PostgreSQL. Fixtures live in a unique
// schema removed after the suite; the bell delivery (triggerNotification) is
// mocked. Pins the robodialer-wave rule of the missed-call bell (owner
// 2026-10-20 "yes"): a GBP line, under 30 s, no voicemail, 3+ unknown numbers
// from one 6-digit block in 14 days. Gate on = settled with no bell; gate off
// = the bell rings as before and the call is stamped for the shadow read.
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
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const GBP_LINE = '+19413840224';
const OFFICE_LINE = '+19412975749';
jest.mock('../config/twilio-numbers', () => ({
  findByNumber: jest.fn((n) => (n === '+19413840224' ? { type: 'gbp_tracking', label: 'GBP — Parrish' } : { type: 'location', label: 'Office' })),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => ({ bellWritten: true })),
}));
jest.mock('../services/notification-service', () => ({ supersedeMissedCallAdmin: jest.fn(async () => {}) }));

const { isEnabled } = require('../config/feature-gates');
const { triggerNotification } = require('../services/notification-triggers');
const { ringMissedCallIfUnanswered, isRobodialerWave } = require('../services/missed-call-bell');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('missed-call bell: robodialer wave on PostgreSQL', () => {
  let database;
  const schema = `missed_call_wave_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'customers', 'notifications', 'blocked_numbers', 'blocked_call_attempts'];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => true);
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  // An unanswered inbound call `minutesAgo` minutes ago, past the voicemail grace.
  function call(fromPhone, minutesAgo, extra = {}) {
    const at = new Date(Date.now() - minutesAgo * 60 * 1000);
    return {
      id: randomUUID(),
      twilio_call_sid: `CA${randomUUID().replaceAll('-', '')}`,
      direction: 'inbound',
      from_phone: fromPhone,
      to_phone: GBP_LINE,
      customer_id: null,
      status: 'completed',
      answered_by: 'voicemail',
      duration_seconds: 24,
      metadata: {},
      created_at: at,
      updated_at: at,
      ...extra,
    };
  }
  // Two earlier unknown numbers from the same 941-555 block: the third makes a wave.
  async function earlierWave(block = '+1941555') {
    await database('call_log').insert([call(`${block}0101`, 60 * 24 * 3), call(`${block}0202`, 60 * 24)]);
  }
  const stored = (row) => database('call_log').where({ id: row.id }).first();

  test('gate on: the third number of a block on a GBP line settles with no bell', async () => {
    await earlierWave();
    const row = call('+19415550303', 10);
    await database('call_log').insert(row);
    expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
    const { metadata } = await stored(row);
    expect(metadata.missed_call_spam_wave).toBe(true);
    expect(metadata.missed_call_settled_at).toEqual(expect.any(String));
  });

  test('gate off: the wave call still rings, stamped for the shadow read', async () => {
    isEnabled.mockImplementation((name) => name !== 'missedCallSpamWave');
    await earlierWave();
    const row = call('+19415550303', 10);
    await database('call_log').insert(row);
    expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const { metadata } = await stored(row);
    expect(metadata.missed_call_spam_wave_shadow).toBe(true);
    expect(metadata.missed_call_spam_wave).toBeUndefined();
  });

  test('not a wave: two numbers in the block, an office line, 30 s or more, an older block call, or a customer phone slot', async () => {
    // The call being judged is stored first, as it always is in production.
    const row = call('+19415550303', 10);
    await database('call_log').insert(row);
    const third = (extra) => ({ ...row, ...extra });
    // Only one earlier number.
    await database('call_log').insert(call('+19415550101', 60));
    expect(await isRobodialerWave(third())).toBe(false);
    await database('call_log').insert(call('+19415550202', 60));
    expect(await isRobodialerWave(third())).toBe(true);
    // A non-GBP line, or a call of 30 s or more.
    expect(await isRobodialerWave(third({ to_phone: OFFICE_LINE }))).toBe(false);
    expect(await isRobodialerWave(third({ duration_seconds: 30 }))).toBe(false);
    // The number is on a customer's spouse slot: never a wave.
    await database('customers').insert({ id: randomUUID(), first_name: 'Sample', last_name: 'Person', phone: '+19415559999', service_contact_phone: '(941) 555-0303' });
    expect(await isRobodialerWave(third())).toBe(false);
  });

  test('an earlier block number that is on a customer record does not count toward the wave (pre-push audit)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 60), call('+19415550202', 60)]);
    expect(await isRobodialerWave(row)).toBe(true);
    await database('customers').insert({ id: randomUUID(), first_name: 'Sample', last_name: 'Person', phone: '+19415550202' });
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('the call counts itself even when its stored time carries microseconds (pre-push audit)', async () => {
    const row = call('+19415550303', 0);
    await database('call_log').insert([call('+19415550101', 60), call('+19415550202', 60)]);
    await database.raw("INSERT INTO call_log (id, twilio_call_sid, direction, from_phone, to_phone, status, answered_by, duration_seconds, metadata, created_at, updated_at) VALUES (?, ?, 'inbound', ?, ?, 'completed', 'voicemail', 24, '{}', now(), now())", [row.id, row.twilio_call_sid, row.from_phone, row.to_phone]);
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(await isRobodialerWave(stored)).toBe(true);
  });

  test('a number on a customer secondary_phone, and a non-North-American caller, are never a wave (Codex #6379 r1)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 60), call('+19415550202', 60)]);
    expect(await isRobodialerWave(row)).toBe(true);
    const intl = call('+449415550303', 10);
    await database('call_log').insert([intl, call('+449415550404', 60)]);
    expect(await isRobodialerWave(intl)).toBe(false);
    await database('customers').insert({ id: randomUUID(), first_name: 'Sample', last_name: 'Person', phone: '+19415559999', secondary_phone: '941-555-0303' });
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('a soft-deleted customer record does not make a number known (Codex #6379 r2)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 60), call('+19415550202', 60)]);
    await database('customers').insert([
      { id: randomUUID(), first_name: 'Sample', last_name: 'Gone', phone: '+19415550303', deleted_at: new Date() },
      { id: randomUUID(), first_name: 'Sample', last_name: 'Gone', phone: '+19415550202', deleted_at: new Date() },
    ]);
    expect(await isRobodialerWave(row)).toBe(true);
  });

  test('block calls older than 14 days do not count', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 60 * 24 * 15), call('+19415550202', 60 * 24 * 16)]);
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('a customer on file always rings, even inside a wave', async () => {
    await earlierWave();
    const customerId = randomUUID();
    await database('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Person', phone: '+19415550303' });
    const row = call('+19415550303', 10, { customer_id: customerId });
    await database('call_log').insert(row);
    expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect((await stored(row)).metadata.missed_call_spam_wave_shadow).toBeUndefined();
  });
});
