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
const { etDateString } = require('../utils/datetime-et');
const { sweepPromiseChasers, sweepSince, MODULE_LOAD_AT } = require('../services/promise-chaser-bell');

jest.setTimeout(30000);
// Synthetic caller — never a real customer's number.
const PHONE = '+19415550199';
const OUR_NUMBER = '+19415550100';

(SKIP ? describe.skip : describe)('promise-chaser bell — stateless sweep, on PostgreSQL', () => {
  let database;
  const schema = `promise_chaser_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'call_commitments', 'scheduled_services', 'customers', 'notifications', 'blocked_numbers', 'blocked_call_attempts'];
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
    // triggerNotification is mocked wholesale (this suite never exercises
    // the real notification-triggers.js pipeline — that lives in its own
    // test file), so a bell it "writes" leaves no real row unless this
    // mock puts one there itself. Every idempotency assertion in this
    // suite depends on that row existing, exactly as the real notifyAdmin
    // would have left it — a bare mockResolvedValue({bellWritten:true})
    // would silently defeat every "does not ring twice" test.
    triggerNotification.mockImplementation(async (triggerKey, payload, opts) => {
      if (opts?.dedupeKey) {
        await mockConn('notifications').insert({
          id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'fixture',
          metadata: { triggerKey, dedupeKey: opts.dedupeKey, payload: { commitmentId: payload?.commitmentId } },
        });
      }
      return { bellWritten: true, push: { sent: 1 } };
    });
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
      description: 'Call the lead back with pricing',
      evidence: JSON.stringify([]),
      created_at: new Date(now - 4 * 3600000), updated_at: new Date(now - 4 * 3600000),
      ...extra,
    };
  }

  test('rings once per promise per ET day, across repeated sweep ticks and multiple callbacks', async () => {
    const earlier = callRow(240); // 4h ago — an unbooked call
    const commitment = commitmentRow(earlier.id);
    const backA = callRow(0);
    await mockConn('call_log').insert([earlier, backA]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const [, , opts] = triggerNotification.mock.calls[0];
    expect(opts.dedupeKey).toBe(`promise_chaser:${commitment.id}:${etDateString(new Date(now))}`);

    // A second tick, with the SAME call still inside the sweep window,
    // must not re-ring — the notifications row this tick just wrote is
    // the durable "already delivered" marker.
    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).toHaveBeenCalledTimes(1);

    // A genuinely SEPARATE callback (a second call) for the SAME promise,
    // same ET day, must not re-buzz either.
    const backB = callRow(0);
    await mockConn('call_log').insert(backB);
    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test('a second, genuinely separate open promise still rings once the first is closed out', async () => {
    const earlierA = callRow(240); // waited longest — selected first
    const commitmentA = commitmentRow(earlierA.id);
    const earlierB = callRow(180);
    const commitmentB = commitmentRow(earlierB.id, { kind: 'send_estimate', description: 'Send the quote' });
    const backA = callRow(0);
    await mockConn('call_log').insert([earlierA, earlierB, backA]);
    await mockConn('call_commitments').insert([commitmentA, commitmentB]);

    expect(await sweepPromiseChasers()).toBe(1);
    const [, firstPayload] = triggerNotification.mock.calls[0];
    expect(firstPayload.commitmentId).toBe(commitmentA.id);

    // Promise A is closed out (staff fulfilled it) — B is now the only
    // open promise, and a later callback rings for it too.
    await mockConn('call_commitments').where({ id: commitmentA.id }).update({ status: 'fulfilled' });
    const backB = callRow(0);
    await mockConn('call_log').insert(backB);
    expect(await sweepPromiseChasers()).toBe(1);
    const [, secondPayload] = triggerNotification.mock.calls[1];
    expect(secondPayload.commitmentId).toBe(commitmentB.id);
  });

  test('a promise already kept (staff reached the caller since) does not ring', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    // Staff called back and reached the lead an hour ago — the SLA pager's
    // own "kept" evidence (an ordinary outbound call, 60s+, unlinked).
    const reached = callRow(60, { direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90 });
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, reached, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a call whose own originating call already booked never rings, even with a separate open promise on it', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);
    // Booked FROM the earlier call itself (source_call_log_id) — the
    // rule's own "ended unbooked" scope.
    await mockConn('scheduled_services').insert({
      id: randomUUID(), customer_id: null, source_call_log_id: earlier.id,
      scheduled_date: new Date(now + 86400000), service_type: 'pest_control', status: 'confirmed',
      created_at: earlier.created_at, updated_at: earlier.created_at,
    });

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a call whose booking was later RESCHEDULED still ended booked: no ring', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);
    await mockConn('scheduled_services').insert({
      id: randomUUID(), customer_id: null, source_call_log_id: earlier.id,
      scheduled_date: new Date(now + 2 * 86400000), service_type: 'pest_control', status: 'rescheduled',
      created_at: earlier.created_at, updated_at: earlier.created_at,
    });

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a promise made on an OUTBOUND call (Waves called the lead) rings just the same', async () => {
    // scopeCommitmentRows' own phone scope is direction-agnostic: the
    // CONTACT number of an outbound call is its to_phone.
    const earlierOutbound = callRow(240, { direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE });
    const commitment = commitmentRow(earlierOutbound.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlierOutbound, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  test("an earlier call's commitment extraction lands after the first tick — the SAME callback rings once it does, next tick", async () => {
    const earlier = callRow(240);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    // No call_commitments row yet — extraction hasn't run. Nothing is
    // written for "not found yet" — it is never a terminal fact.
    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();

    // Extraction lands.
    const commitment = commitmentRow(earlier.id);
    await mockConn('call_commitments').insert(commitment);
    expect(await sweepPromiseChasers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  });

  describe('sweep window boundary', () => {
    test('sweepSince never looks earlier than 30 minutes ago, or earlier than MODULE_LOAD_AT, whichever is later', () => {
      const longAfterBoot = new Date(MODULE_LOAD_AT.getTime() + 60 * 60 * 1000);
      expect(sweepSince(longAfterBoot)).toEqual(new Date(longAfterBoot.getTime() - 30 * 60 * 1000));
      const justAfterBoot = new Date(MODULE_LOAD_AT.getTime() + 5000);
      expect(sweepSince(justAfterBoot)).toEqual(MODULE_LOAD_AT);
    });

    test('a call created before the sweep window (30 minutes, or MODULE_LOAD_AT if more recent) is ignored; one just inside it rings', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const cutoff = sweepSince(new Date(now));
      const tooOld = callRow(0, { created_at: new Date(cutoff.getTime() - 60000), updated_at: new Date(cutoff.getTime() - 60000) });
      await mockConn('call_log').insert([earlier, tooOld]);
      await mockConn('call_commitments').insert(commitment);
      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();

      const justInside = callRow(0, { created_at: new Date(cutoff.getTime() + 60000), updated_at: new Date(cutoff.getTime() + 60000) });
      await mockConn('call_log').insert(justInside);
      expect(await sweepPromiseChasers()).toBe(1);
    });
  });

  test('a blocked number is excluded from the sweep entirely', async () => {
    const blockedPhone = '+19415550188';
    const earlier = callRow(240, { from_phone: blockedPhone });
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0, { from_phone: blockedPhone });
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);
    await mockConn('blocked_numbers').insert({ id: randomUUID(), number: blockedPhone, block_type: 'hard_block' });

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a voice-relay sandbox call is excluded from the sweep', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0, { source: 'voice_relay_sandbox' });
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a call still mid an outstanding pre-connect screen, or one that failed it, is excluded — a passed screen rings on a later tick', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0, { metadata: { preconnect_screen: 'gated' } });
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();

    // The screen resolves FAILED — still never rings.
    await mockConn('call_log').where({ id: back.id }).update({ metadata: { preconnect_screen: 'failed' } });
    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();

    // The screen resolves PASSED — now eligible, rings on this later tick.
    await mockConn('call_log').where({ id: back.id }).update({ metadata: { preconnect_screen: 'passed' } });
    expect(await sweepPromiseChasers()).toBe(1);
  });

  test("a promise on another customer's call on the same number is excluded; an unlinked one is kept", async () => {
    const customerA = randomUUID();
    const customerB = randomUUID();
    const earlierUnlinked = callRow(240);
    const commitmentUnlinked = commitmentRow(earlierUnlinked.id);
    const earlierOtherCustomer = callRow(180, { customer_id: customerB });
    const commitmentOther = commitmentRow(earlierOtherCustomer.id, { kind: 'send_estimate', description: "another customer's own quote" });
    const back = callRow(0, { customer_id: customerA });
    await mockConn('customers').insert([{ id: customerA, phone: PHONE }, { id: customerB, phone: '+19415550177' }]);
    await mockConn('call_log').insert([earlierUnlinked, earlierOtherCustomer, back]);
    await mockConn('call_commitments').insert([commitmentUnlinked, commitmentOther]);

    expect(await sweepPromiseChasers()).toBe(1);
    const [, payload] = triggerNotification.mock.calls[0];
    expect(payload.commitmentId).toBe(commitmentUnlinked.id); // never commitmentOther
  });

  test("an UNLINKED caller never surfaces a customer-linked promise until the call is linked to that same customer", async () => {
    const customerB = randomUUID();
    const earlierLinked = callRow(180, { customer_id: customerB });
    const commitment = commitmentRow(earlierLinked.id);
    const back = callRow(0); // not linked yet: processing hasn't run
    await mockConn('customers').insert([{ id: customerB, phone: PHONE }]);
    await mockConn('call_log').insert([earlierLinked, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();

    // The pipeline links the callback to the same customer; the next tick rings.
    await mockConn('call_log').where({ id: back.id }).update({ customer_id: customerB });
    expect(await sweepPromiseChasers()).toBe(1);
    expect(triggerNotification.mock.calls[0][1].commitmentId).toBe(commitment.id);
  });

  test("a push-only admin isn't double-pushed on the second tick — the SAME dedupeKey (push tag) carries across dispatches even with no bell to check against", async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // Every admin is push-only: no bell is ever written, so this file's
    // own pre-check has nothing durable to find on the second tick —
    // notification-triggers.js's own dedupeKey push tag (kept, unchanged)
    // is what keeps the device from showing two notifications, by
    // coalescing on the SAME tag both times.
    triggerNotification.mockResolvedValue({ bellWritten: false, push: { sent: 1 } });
    expect(await sweepPromiseChasers()).toBe(1);
    expect(await sweepPromiseChasers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(2);
    const [[, , opts1], [, , opts2]] = triggerNotification.mock.calls;
    expect(opts1.dedupeKey).toBe(opts2.dedupeKey);
    expect(opts1.dedupeKey).toBe(`promise_chaser:${commitment.id}:${etDateString(new Date(now))}`);
  });

  test('gate off is a hard no-op — no dispatch', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);
    gates.promiseChaserBell = false;
    try {
      expect(await sweepPromiseChasers()).toBe(0);
    } finally {
      gates.promiseChaserBell = true;
    }
    expect(triggerNotification).not.toHaveBeenCalled();
  });
});
