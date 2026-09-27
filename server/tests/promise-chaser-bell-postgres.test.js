// CI's existing DB-gated pass runs this against PostgreSQL. Fixture data
// lives in a unique schema (falling back to `public` for every table this
// suite does not seed itself — call-commitments' fulfillment lookups touch
// several) that is removed after the suite; delivery is mocked.
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
const { ringPromiseChaserIfNeeded } = require('../services/promise-chaser-bell');

jest.setTimeout(30000);
// Synthetic caller — never a real customer's number.
const PHONE = '+19415550199';
const OUR_NUMBER = '+19415550100';

(SKIP ? describe.skip : describe)('promise-chaser bell on PostgreSQL', () => {
  let database;
  const schema = `promise_chaser_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'call_commitments', 'scheduled_services', 'customers', 'notifications', 'blocked_numbers', 'blocked_call_attempts', 'audit_log'];
  let now;
  const gateNames = ['promiseChaserBell', 'callCommitments'];
  const savedGates = Object.fromEntries(gateNames.map((key) => [key, gates[key]]));

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
    gateNames.forEach((key) => { gates[key] = true; });
  });
  beforeEach(() => {
    now = Date.now();
    jest.clearAllMocks();
    triggerNotification.mockResolvedValue({ bellWritten: true });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
    expect(logger.warn.mock.calls).toEqual([]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
    Object.assign(gates, savedGates);
  });

  function callRow(minsAgo, extra = {}) {
    return {
      id: randomUUID(), twilio_call_sid: `CA${randomUUID().replaceAll('-', '')}`,
      direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, customer_id: null,
      status: 'completed', answered_by: 'human', duration_seconds: 90, metadata: {},
      created_at: new Date(now - minsAgo * 60000), updated_at: new Date(now - minsAgo * 60000),
      ...extra,
    };
  }

  // An open Waves callback promise made on `call` 4 hours before `now`.
  function commitmentRow(callLogId, extra = {}) {
    return {
      id: randomUUID(), call_log_id: callLogId, commitment_key: `fixture:${randomUUID()}`,
      party: 'waves', kind: 'callback', status: 'open', source: 'ai',
      description: "Call the lead back with pricing",
      evidence: JSON.stringify([]),
      created_at: new Date(now - 4 * 3600000), updated_at: new Date(now - 4 * 3600000),
      ...extra,
    };
  }

  test('an open promise + a callback rings, naming what is still owed', async () => {
    const earlier = callRow(240); // 4h ago — an unbooked call
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0); // calling back now
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const [key, payload, opts] = triggerNotification.mock.calls[0];
    expect(key).toBe('promise_chaser');
    expect(payload).toMatchObject({ phone: PHONE, callLogId: back.id, commitmentId: commitment.id, what: 'callback' });
    expect(opts.dedupeKey).toContain(commitment.id);
  });

  test('a promise already kept (staff reached the caller since) does not ring', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    // Staff called back and reached the lead an hour ago — the SLA pager's
    // own "kept" evidence (an ordinary outbound call, 60s+, unlinked).
    const reached = callRow(60, {
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90,
    });
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, reached, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a callback REOPENED after that same call still rings — the old call is not proof it was kept again', async () => {
    const earlier = callRow(240);
    // Staff confirmed/edited the callback, then reopened it — human_state
    // must be 'confirmed' or 'edited' for the renewal boundary to apply.
    const commitment = commitmentRow(earlier.id, { human_state: 'confirmed' });
    // Reached the caller 3h ago — normally enough to count as kept.
    const reached = callRow(180, {
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90,
    });
    // Reopened 2h ago (AFTER that call) — the customer said it wasn't
    // actually resolved. The old call before the reopen no longer counts.
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, reached, back]);
    await mockConn('call_commitments').insert(commitment);
    await mockConn('audit_log').insert({
      id: randomUUID(), actor_type: 'admin', action: 'callback_reopen',
      resource_type: 'call_commitment', resource_id: commitment.id,
      metadata: JSON.stringify({}), created_at: new Date(now - 120 * 60000),
    });

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a call that itself ended booked never rings, even with a separate open promise on it', async () => {
    const customerId = randomUUID();
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);
    await mockConn('customers').insert({ id: customerId, phone: PHONE });
    // Booked FROM the earlier call itself (source_call_log_id) — the rule's
    // own "ended unbooked" scope, distinct from "booked SINCE" below.
    await mockConn('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, source_call_log_id: earlier.id,
      scheduled_date: new Date(now + 86400000), service_type: 'pest_control', status: 'confirmed',
      created_at: earlier.created_at, updated_at: earlier.created_at,
    });

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a lead who has since booked does not ring', async () => {
    const customerId = randomUUID();
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);
    await mockConn('customers').insert({ id: customerId, phone: PHONE });
    await mockConn('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: new Date(now + 86400000),
      service_type: 'pest_control', status: 'confirmed',
      created_at: new Date(now - 60 * 60000), updated_at: new Date(now - 60 * 60000),
    });

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('the same open promise dedupes to one key across repeat callbacks the same day', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const backA = callRow(30);
    const backB = callRow(0);
    await mockConn('call_log').insert([earlier, backA, backB]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(backA.twilio_call_sid)).toBe(true);
    expect(await ringPromiseChaserIfNeeded(backB.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(2);
    const keyA = triggerNotification.mock.calls[0][2].dedupeKey;
    const keyB = triggerNotification.mock.calls[1][2].dedupeKey;
    expect(keyA).toBe(keyB);
  });

  test('a blocked number never rings even with an open promise', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);
    await mockConn('blocked_numbers').insert({ id: randomUUID(), number: PHONE, block_type: 'hard_block' });

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a voice-relay sandbox call never rings', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0, { source: 'voice_relay_sandbox' });
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('gate off is a hard no-op — no query, no ring', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);
    gates.promiseChaserBell = false;
    try {
      expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    } finally {
      gates.promiseChaserBell = true;
    }
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});
