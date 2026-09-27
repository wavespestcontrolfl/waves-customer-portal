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
const {
  sweepPromiseChasers, ringForCall,
} = require('../services/promise-chaser-bell');

jest.setTimeout(30000);
// Synthetic caller — never a real customer's number.
const PHONE = '+19415550199';
const OUR_NUMBER = '+19415550100';

(SKIP ? describe.skip : describe)('promise-chaser bell — stateless sweep, on PostgreSQL', () => {
  let database;
  const schema = `promise_chaser_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'call_commitments', 'scheduled_services', 'customers', 'notifications', 'blocked_numbers', 'blocked_call_attempts', 'audit_log'];
  // promise_chaser_deliveries is cloned separately, WITH its real primary
  // key (LIKE ... INCLUDING ALL, unlike every other table's plain WITH NO
  // DATA copy above): the delivery-fact insert needs an actual unique
  // constraint for its own onConflict to target, and this keeps it fully
  // isolated to this suite's own schema — no writing to (or cleaning up)
  // the real shared public table.
  const likeAllTables = ['promise_chaser_deliveries'];
  let now;
  const gateNames = ['promiseChaserBell', 'callCommitments'];
  const savedGates = Object.fromEntries(gateNames.map((key) => [key, gates[key]]));

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    for (const table of likeAllTables) await database.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
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
    for (const table of [...tables, ...likeAllTables]) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
    expect(logger.warn.mock.calls).toEqual([]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
    Object.assign(gates, savedGates);
  });

  // Stamped eligible by default (Codex #5019 r20/r21: the /voice webhook
  // stamps promise_chaser_eligible: true at arrival whenever the gate was
  // on that instant — every fixture call here is presumed to have arrived
  // that way unless a test explicitly clears metadata to simulate a
  // dark-period call). A caller-supplied `metadata` MERGES onto the stamp
  // rather than replacing it, so passing e.g. `{ preconnect_screen: 'gated' }`
  // never has to also repeat the stamp.
  function callRow(minsAgo, extra = {}) {
    const { metadata, ...rest } = extra;
    return {
      id: randomUUID(), twilio_call_sid: `CA${randomUUID().replaceAll('-', '')}`,
      direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, customer_id: null,
      status: 'completed', answered_by: 'human', duration_seconds: 90,
      metadata: { promise_chaser_eligible: true, ...(metadata || {}) },
      created_at: new Date(now - minsAgo * 60000), updated_at: new Date(now - minsAgo * 60000),
      ...rest,
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
    expect(opts.dedupeKey).toBe(`promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`);

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

  describe('per-call eligibility stamp, not a time boundary (Codex #5019 r20/r21 P1)', () => {
    test('a call created before the 30-minute sweep window is ignored regardless of its stamp; one just inside it rings', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const tooOld = callRow(31);
      await mockConn('call_log').insert([earlier, tooOld]);
      await mockConn('call_commitments').insert(commitment);
      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();

      const justInside = callRow(29);
      await mockConn('call_log').insert(justInside);
      expect(await sweepPromiseChasers()).toBe(1);
    });

    test('a dark-period call (the gate was off at arrival, so /voice never stamped it) inside the window never rings after re-enable', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      // Arrived 5 minutes ago, comfortably inside the 30-minute window —
      // but the gate was off at that instant, so /voice's own insert never
      // added promise_chaser_eligible at all (not `false` — absent, exactly
      // like a call from before this stamp existed).
      const darkPeriodCall = callRow(5);
      darkPeriodCall.metadata = {};
      await mockConn('call_log').insert([earlier, darkPeriodCall]);
      await mockConn('call_commitments').insert(commitment);

      // The gate is back on for this very sweep tick (this suite's own
      // gates.promiseChaserBell is true throughout) — a time-boundary
      // design would have swept this call in; the stamp design does not,
      // because eligibility is a fact about arrival, not about now.
      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('a stamped call from before a simulated restart still rings — an ordinary restart never drops a callback', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      // Taken 20 minutes ago, comfortably inside the 30-minute window, and
      // already stamped (by callRow's own default) exactly as /voice would
      // have stamped it before whatever restart happened since — nothing
      // about a restart itself ever touches this row.
      const preRestartCallback = callRow(20);
      await mockConn('call_log').insert([earlier, preRestartCallback]);
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('a redelivered /voice call keeps its stamp — the sweep still finds and rings it', async () => {
      // tryClaimInboundWebhook's own firstDelivery claim (twilio-voice-webhook.js)
      // is what actually stops a genuine Twilio redelivery from ever
      // re-running the insert/fold that could touch this key; this test
      // proves the OUTCOME that guarantee protects: a row stamped once, on
      // first delivery, is exactly what a later redelivery still finds —
      // never a second write that could have dropped it.
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const redelivered = callRow(0);
      await mockConn('call_log').insert([earlier, redelivered]);
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
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

    // The screen resolves FAILED — still never rings. (A wholesale metadata
    // replace, same as the real screen-resolution write path — the stamp
    // must be repeated here or this assertion would prove nothing new.)
    await mockConn('call_log').where({ id: back.id }).update({ metadata: { promise_chaser_eligible: true, preconnect_screen: 'failed' } });
    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();

    // The screen resolves PASSED — now eligible, rings on this later tick.
    await mockConn('call_log').where({ id: back.id }).update({ metadata: { promise_chaser_eligible: true, preconnect_screen: 'passed' } });
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

  describe('promise_chaser_deliveries — durable fact for push-only recipients (Codex #5019 r19/r20 P1)', () => {
    test('a push-only admin (no bell ever written) is buzzed exactly ONCE across repeated ticks', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // Every admin is push-only: no bell is ever written, so the
      // notifications-table check alone has nothing to find on a later
      // tick — the promise_chaser_deliveries row this dispatch writes is
      // what stops the redispatch, not the push tag (which only replaces a
      // notification still showing — dismissed or clicked, the next push
      // shows again).
      triggerNotification.mockResolvedValue({ bellWritten: false, push: { sent: 1 } });
      expect(await sweepPromiseChasers()).toBe(1); // this tick delivers it
      expect(await sweepPromiseChasers()).toBe(0); // later ticks find the durable fact and skip
      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      const [, , opts] = triggerNotification.mock.calls[0];
      const dedupeKey = `promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`;
      expect(opts.dedupeKey).toBe(dedupeKey);
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
      expect(row).toBeTruthy();
    });

    test('a bell+push admin is unchanged — the notifications-row check alone still stops the redispatch', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // The default mock (see beforeEach) writes a real notifications row
      // whenever bellWritten is true — the FIRST, unconditional check.
      expect(await sweepPromiseChasers()).toBe(1);
      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('housekeeping deletes delivery-fact rows older than the retention window; recent ones survive', async () => {
      const staleKey = 'promise_chaser:fixture-stale:0:2020-01-01';
      const freshKey = 'promise_chaser:fixture-fresh:0:2020-01-01';
      await mockConn('promise_chaser_deliveries').insert([
        { dedupe_key: staleKey, delivered_at: new Date(now - 10 * 24 * 60 * 60 * 1000) },
        { dedupe_key: freshKey, delivered_at: new Date(now - 6 * 60 * 60 * 1000) },
      ]);
      expect(await sweepPromiseChasers()).toBe(0); // nothing else to ring this tick
      const remaining = await mockConn('promise_chaser_deliveries').pluck('dedupe_key');
      expect(remaining).toEqual([freshKey]);
    });

    test('gate off never queries promise_chaser_deliveries either — no housekeeping, no dispatch', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);
      const staleKey = 'promise_chaser:fixture-stale:0:2020-01-01';
      await mockConn('promise_chaser_deliveries').insert({ dedupe_key: staleKey, delivered_at: new Date(now - 10 * 24 * 60 * 60 * 1000) });

      gates.promiseChaserBell = false;
      try {
        expect(await sweepPromiseChasers()).toBe(0);
      } finally {
        gates.promiseChaserBell = true;
      }
      expect(triggerNotification).not.toHaveBeenCalled();
      // Untouched — the gate check is the very first thing sweepPromiseChasers does.
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: staleKey }).first('dedupe_key');
      expect(row).toBeTruthy();
    });
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

  describe('the live recheck re-runs direct fulfillment, not just kept-evidence', () => {
    const commitments = require('../services/call-commitments');

    test('a fulfillment refresh that closes the commitment as a side effect (an estimate genuinely sent in the race window) blocks the ring', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote' });
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      triggerNotification.mockImplementationOnce(async (triggerKey, payload, opts) => {
        // Real refreshFulfillment would notice the estimate sent in the
        // race window and stamp the row closed AS A SIDE EFFECT of running
        // — simulated directly here (resolveFulfillment's own per-kind
        // detection is refreshFulfillment's own tested territory); this
        // proves the ORDER: stillEligible's re-run must happen, and its
        // effect must be visible to stillOpenIds called right after it,
        // for THIS bell to ever see it.
        const spy = jest.spyOn(commitments, 'refreshFulfillment').mockImplementationOnce(async (conn, callLogId) => {
          await conn('call_commitments').where({ call_log_id: callLogId, status: 'open' }).update({ status: 'fulfilled' });
          return { checked: 1, fulfilled: 1, hinted: 0, cleared: 0, failed: 0 };
        });
        const stillWanted = await opts.shouldContinue();
        spy.mockRestore();
        expect(stillWanted).toBe(false);
        return { bellWritten: false, push: { sent: 0, skipped: 'superseded_before_push' } };
      });
      expect(await sweepPromiseChasers()).toBe(0);
    });

    test('a failed fulfillment refresh inside the live recheck blocks the ring — never rings on unverifiable state', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      triggerNotification.mockImplementationOnce(async (triggerKey, payload, opts) => {
        const spy = jest.spyOn(commitments, 'refreshFulfillment').mockRejectedValueOnce(new Error('synthetic fulfillment outage'));
        const stillWanted = await opts.shouldContinue();
        spy.mockRestore();
        expect(stillWanted).toBe(false);
        return { bellWritten: false, push: { sent: 0, skipped: 'superseded_before_push' } };
      });
      expect(await sweepPromiseChasers()).toBe(0);
    });
  });

  test('paging with a forced-small page size still reaches a genuinely actionable call several pages deep in the sweep window', async () => {
    // Every call below is well inside the 30-minute window — the point of
    // this test is pagination continuing across multiple small pages, not
    // the window floor.
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    // Older, on a DIFFERENT number with no open promise of its own — each
    // one occupies a full page slot (with pageSize:1) but rings nothing; a
    // single-LIMIT sweep would never reach anything past its own batch size.
    const irrelevantCalls = Array.from({ length: 4 }, (_, i) => callRow(20 - i, { from_phone: '+19415550166' }));
    // Newest, genuinely actionable, several pages deeper in the window.
    const actionable = callRow(1);
    await mockConn('call_log').insert([earlier, ...irrelevantCalls, actionable]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers({ pageSize: 1 })).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const [, payload] = triggerNotification.mock.calls[0];
    expect(payload.callLogId).toBe(actionable.id);
  });

  describe('dedupeKey renewal versioning', () => {
    test('a promise reopened after it already rang today can ring again for the new obligation', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { human_state: 'confirmed' });
      const backA = callRow(0);
      await mockConn('call_log').insert([earlier, backA]);
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(1);
      const [, , opts1] = triggerNotification.mock.calls[0];
      expect(opts1.dedupeKey).toBe(`promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`);

      // Staff reopen it — obligationRenewedAt now returns a real instant.
      const renewedAt = new Date(now - 5 * 60000);
      await mockConn('audit_log').insert({
        id: randomUUID(), actor_type: 'admin', action: 'callback_reopen',
        resource_type: 'call_commitment', resource_id: commitment.id,
        metadata: JSON.stringify({ renewed_at: renewedAt.toISOString() }), created_at: renewedAt,
      });
      const backB = callRow(0);
      await mockConn('call_log').insert(backB);
      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(2);
      const [, , opts2] = triggerNotification.mock.calls[1];
      expect(opts2.dedupeKey).toBe(`promise_chaser:${commitment.id}:${renewedAt.getTime()}:${etDateString(new Date(now))}`);
      expect(opts2.dedupeKey).not.toBe(opts1.dedupeKey);
    });

    test('repeated calls for the SAME unrenewed obligation still collapse onto one dedupeKey', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const backA = callRow(0);
      const backB = callRow(0);
      await mockConn('call_log').insert([earlier, backA, backB]);
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      const [, , opts] = triggerNotification.mock.calls[0];
      expect(opts.dedupeKey).toBe(`promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`);
    });

    test('a callback that arrived BEFORE a promise renewal is never re-attributed to the renewed obligation (Codex #5019 r17 P1)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { human_state: 'confirmed' });
      // This call happened BEFORE the renewal below — it cannot possibly
      // be "about" an obligation that did not exist yet when it came in.
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // Staff reopen the promise strictly AFTER this callback — still
      // inside the SAME 30-minute sweep window (`back` is still there).
      const renewedAt = new Date(now + 1000);
      await mockConn('audit_log').insert({
        id: randomUUID(), actor_type: 'admin', action: 'callback_reopen',
        resource_type: 'call_commitment', resource_id: commitment.id,
        metadata: JSON.stringify({ renewed_at: renewedAt.toISOString() }), created_at: renewedAt,
      });

      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test("the ET day in dedupeKey comes from the callback's OWN created_at, never the sweep tick's current time (Codex #5019 r18 P1)", async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // A tick landing well after this callback — e.g. one that crossed an
      // ET midnight while `back` was still inside the sweep's own window —
      // must compute the IDENTICAL dedupeKey `back` always had, not one
      // stamped with whatever day "now" itself happens to fall on.
      const muchLaterTick = new Date(now + 3 * 24 * 60 * 60 * 1000);
      expect(await ringForCall(back, muchLaterTick)).toBe(true);
      const [, , opts] = triggerNotification.mock.calls[0];
      expect(opts.dedupeKey).toBe(`promise_chaser:${commitment.id}:0:${etDateString(new Date(back.created_at))}`);
      expect(opts.dedupeKey).not.toContain(etDateString(muchLaterTick));
    });
  });
});
