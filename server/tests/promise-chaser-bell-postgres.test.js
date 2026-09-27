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
// Defaults to the REAL implementation (every other test relies on genuine
// kept-evidence queries) — only the one test that needs a lookup failure
// overrides it with mockRejectedValueOnce.
jest.mock('../services/followup-sla-watcher', () => {
  const actual = jest.requireActual('../services/followup-sla-watcher');
  return { ...actual, followedUpIds: jest.fn(actual.followedUpIds) };
});
const { triggerNotification } = require('../services/notification-triggers');
const { followedUpIds: followedUpIdsMock } = require('../services/followup-sla-watcher');
const logger = require('../services/logger');
const { gates } = require('../config/feature-gates');
const { ringPromiseChaserIfNeeded, markScreenFailed, sweepPromiseChasers, pendingClaimFragment } = require('../services/promise-chaser-bell');

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

  test('a promise made on a call AFTER the callback is never picked, even on a delayed recovery attempt', async () => {
    // The callback itself, an hour ago — as if the durable sweep is only
    // now getting to retry it (the scenario a delayed recovery attempt
    // creates: SWEEP_LOOKBACK_MS allows up to 24h).
    const back = callRow(60);
    // A DIFFERENT, LATER call from the same number, ten minutes ago — its
    // promise did not exist yet when `back` came in, so it must never be
    // read as "why this caller is chasing us".
    const laterCall = callRow(10);
    const laterCommitment = commitmentRow(laterCall.id);
    await mockConn('call_log').insert([back, laterCall]);
    await mockConn('call_commitments').insert(laterCommitment);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'skipped', reason: 'no_open_promise' });
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

  test('the same open promise rings once across repeat callbacks the same day — the second call is intercepted before it ever reaches notifyAdmin', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const backA = callRow(30);
    const backB = callRow(0);
    await mockConn('call_log').insert([earlier, backA, backB]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(backA.twilio_call_sid)).toBe(true);
    // A genuinely separate call for the SAME promise, same ET day, must not
    // re-buzz — caught by this call's own pre-check (promiseDeliveryState),
    // never by notifyAdmin's dedupe (which would let a retry's push through).
    expect(await ringPromiseChaserIfNeeded(backB.twilio_call_sid)).toBe(false);
    expect(triggerNotification).toHaveBeenCalledTimes(1);

    const rowB = await mockConn('call_log').where({ id: backB.id }).first('metadata');
    expect(rowB.metadata.promise_chaser).toMatchObject({ status: 'skipped', reason: 'already_rung_today' });
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

  test('gate off is a hard no-op — no query, no ring, no claim written', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);
    gates.promiseChaserBell = false;
    try {
      expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
      expect(await sweepPromiseChasers()).toBe(0);
    } finally {
      gates.promiseChaserBell = true;
    }
    expect(triggerNotification).not.toHaveBeenCalled();
    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toBeUndefined();
  });

  test("claiming one call never touches another call's stale claim (the OR must stay grouped)", async () => {
    // A completely unrelated call, already settled long ago, with a stale
    // claimed_at — exactly what an unparenthesized OR in the claim's WHERE
    // clause would match table-wide regardless of id.
    const unrelatedCall = callRow(600);
    await mockConn('call_log').insert(unrelatedCall);
    await mockConn('call_log').where({ id: unrelatedCall.id }).update({
      metadata: JSON.stringify({ promise_chaser: { status: 'rung', claimed_at: new Date(now - 20 * 60000).toISOString() } }),
    });

    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(true);

    const unrelatedAfter = await mockConn('call_log').where({ id: unrelatedCall.id }).first('metadata');
    expect(unrelatedAfter.metadata.promise_chaser.status).toBe('rung');
    expect(unrelatedAfter.metadata.promise_chaser.claimed_at).toBe(new Date(now - 20 * 60000).toISOString());
  });

  test('a retryable delivery result (no bell, no push, no thrown error) leaves the claim pending', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // The real dispatcher's own shape for a swallowed bell-insert failure —
    // no thrown exception, no `.error`, just `retryable: true`.
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, retryable: true, push: null });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);

    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'pending' });
  });

  test('a failed preferences lookup (prefsUnavailable, no error, no retryable) also leaves the claim pending', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // The real dispatcher's own shape when the notification_preferences
    // query itself throws — fails closed, no bell, no push, no `.error` or
    // `.retryable`, just `prefsUnavailable: true`.
    triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: null, prefsUnavailable: true });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);

    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'pending' });
  });

  test('a bell that succeeded but whose push failed retries the push (never re-inserts the bell, never loses the push)', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // Attempt 1: the bell inserted successfully, but the push failed.
    triggerNotification.mockResolvedValueOnce({ bellWritten: true, push: { sent: 0, failed: 1 }, retryable: true });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const pending = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(pending.metadata.promise_chaser.status).toBe('pending');

    // Age the lease so a retry (the sweep) can reclaim it.
    const meta = pending.metadata;
    meta.promise_chaser.claimed_at = new Date(now - 20 * 60000).toISOString();
    await mockConn('call_log').where({ id: back.id }).update({ metadata: JSON.stringify(meta) });

    // Attempt 2: notifyAdmin reuses the existing bell row (deduped) but the
    // push retry succeeds this time — must not be treated as a duplicate
    // and dropped.
    triggerNotification.mockResolvedValueOnce({ bellWritten: true, deduped: true, push: { sent: 1, failed: 0 } });
    expect(await sweepPromiseChasers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(2);
    const settled = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(settled.metadata.promise_chaser).toMatchObject({ status: 'rung', commitmentId: commitment.id });
  });

  test('a failed attempt leaves the claim pending; the durable sweep retries it with past-tense copy', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // A notification insert failure — triggerNotification's own contract
    // (never throws) surfaces this as a resolved error, not a rejection.
    triggerNotification.mockResolvedValueOnce({ error: 'synthetic notification insert failure' });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).toHaveBeenCalledTimes(1);

    const pending = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(pending.metadata.promise_chaser).toMatchObject({ status: 'pending' });

    // A same-second retry is refused (the lease is still fresh, same idiom
    // as missed-call-bell / repeat-caller-bell) — prove that before aging
    // the lease out so the sweep can reclaim it.
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).toHaveBeenCalledTimes(1);

    const meta = pending.metadata;
    meta.promise_chaser.claimed_at = new Date(now - 20 * 60000).toISOString();
    await mockConn('call_log').where({ id: back.id }).update({ metadata: JSON.stringify(meta) });

    expect(await sweepPromiseChasers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(2);
    const [, retryPayload] = triggerNotification.mock.calls[1];
    // A durable retry lands after the call has ended — never "calling in now".
    expect(retryPayload.liveCall).toBe(false);
    expect(retryPayload.calledAtLabel).toBeTruthy();

    const settled = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(settled.metadata.promise_chaser).toMatchObject({ status: 'rung' });
  });

  test('a promise closed between the snapshot and dispatch is caught by the live re-check', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(true);
    const [, , opts] = triggerNotification.mock.calls[0];
    expect(typeof opts.shouldContinue).toBe('function');
    expect(typeof opts.beforePush).toBe('function');
    expect(await opts.shouldContinue()).toBe(true);
    expect(await opts.beforePush()).toBe(true);

    // Staff dismiss the commitment right in the gap the check exists for.
    await mockConn('call_commitments').where({ id: commitment.id }).update({ status: 'dismissed', human_state: 'dismissed' });
    expect(await opts.shouldContinue()).toBe(false);
    expect(await opts.beforePush()).toBe(false);
  });

  test("a promise on another customer's call on the same number is excluded; an unlinked one is kept", async () => {
    const callerCustomerId = randomUUID();
    const otherCustomerId = randomUUID();
    await mockConn('customers').insert([{ id: callerCustomerId, phone: PHONE }, { id: otherCustomerId, phone: PHONE }]);

    // Older promise, but tied to a DIFFERENT customer's call — excluded.
    const otherCall = callRow(300, { customer_id: otherCustomerId });
    const otherCommitment = commitmentRow(otherCall.id);
    // Younger promise, on an UNLINKED call from the same number — kept.
    const unlinkedCall = callRow(240);
    const unlinkedCommitment = commitmentRow(unlinkedCall.id);

    const back = callRow(0, { customer_id: callerCustomerId });
    await mockConn('call_log').insert([otherCall, unlinkedCall, back]);
    await mockConn('call_commitments').insert([otherCommitment, unlinkedCommitment]);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect(triggerNotification.mock.calls[0][1].commitmentId).toBe(unlinkedCommitment.id);
  });

  test('a screen-failed call is marked skipped without ever ringing', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // The caller never pressed a key — markScreenFailed settles the claim
    // without ever attempting a ring.
    expect(await markScreenFailed(back.twilio_call_sid)).toBe(true);
    expect(triggerNotification).not.toHaveBeenCalled();
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();

    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'skipped', reason: 'screen_failed' });
  });

  test('a screened caller who presses a key still rings — the deferred fire once the screen passes', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // Nothing fired while a challenge would have been outstanding (the
    // webhook never calls this until ?screened=1 arrives) — this call
    // stands in for that deferred fire.
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const [, payload] = triggerNotification.mock.calls[0];
    expect(payload.liveCall).toBe(true);
  });

  test('pendingClaimFragment: null when the gate is off or the phone is unusable; the durability marker shape otherwise', () => {
    gates.promiseChaserBell = false;
    try {
      expect(pendingClaimFragment(PHONE)).toBeNull();
    } finally {
      gates.promiseChaserBell = true;
    }
    expect(pendingClaimFragment('anonymous')).toBeNull();
    expect(pendingClaimFragment(PHONE)).toEqual({ promise_chaser: { status: 'pending', claimed_at: null } });
  });

  test('rows created while the gate was dark are never swept, however much later the gate flips on', async () => {
    const earlier = callRow(600); // 10h ago — an unbooked call with an open promise
    const commitment = commitmentRow(earlier.id);
    // Simulates the gate being OFF when this call came in: no promise_chaser
    // key at all — exactly what /voice's own insert leaves, since
    // pendingClaimFragment returns null while the gate is off. Still well
    // within the 24h lookback, and on the SAME number as the open promise —
    // if the sweep still scanned "no key" rows, this would incorrectly ring.
    const staleUnclaimed = callRow(60);
    await mockConn('call_log').insert([earlier, staleUnclaimed]);
    await mockConn('call_commitments').insert(commitment);

    // The gate is ON now (as for the whole suite) — standing in for "gate
    // flipped on later" — and the sweep must still never touch this row.
    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
    const row = await mockConn('call_log').where({ id: staleUnclaimed.id }).first('metadata');
    expect(row.metadata.promise_chaser).toBeUndefined();
  });

  test('a crash right after the atomic insert (the durability marker committed, the live attempt never ran) is recovered by the sweep once', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    // The durability marker /voice's own insert writes atomically — as if
    // the process crashed the instant after that commit, before ever
    // calling ringPromiseChaserIfNeeded live.
    const back = callRow(10, { metadata: { promise_chaser: { status: 'pending', claimed_at: null } } });
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'rung' });
  });

  test('a call still mid an outstanding pre-connect screen is never swept prematurely, even with its durability marker already pending', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    // The marker is present (the insert writes it unconditionally, gate
    // permitting) AND the screen is still 'gated' — the sweep must leave it
    // alone regardless.
    const back = callRow(10, { metadata: { promise_chaser: { status: 'pending', claimed_at: null }, preconnect_screen: 'gated' } });
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    // Untouched — the soft skip inside ringPromiseChaserIfNeeded takes no
    // claim and settles nothing while the screen is still outstanding.
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'pending', claimed_at: null });
  });

  test('a screen that resolved FAILED but never got its own terminal mark written is still never rung — by the sweep, or directly', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    // stampPreconnectScreen('failed') succeeded (and the durability marker
    // from insert time is still 'pending'), but markScreenFailed itself
    // never ran (a crash in between).
    const back = callRow(10, { metadata: { promise_chaser: { status: 'pending', claimed_at: null }, preconnect_screen: 'failed' } });
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();

    // Direct call (the webhook re-entry path, or a second sweep tick) must
    // also refuse it — the check lives in ringPromiseChaserIfNeeded itself,
    // not only in the sweep's own query.
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'skipped', reason: 'screen_failed' });
  });

  test('a promise kept by a booking/call/text landing between the snapshot and dispatch is caught by the SAME kept-evidence predicate, not just stillOpenIds', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(true);
    const [, , opts] = triggerNotification.mock.calls[0];
    expect(await opts.shouldContinue()).toBe(true);

    // Staff reach the caller RIGHT in the race window — the commitment
    // row's own status is untouched (still 'open': stillOpenIds alone
    // would say nothing changed), but followedUpIds' own kept-evidence
    // predicate — re-run here, not a narrower recheck — now says kept.
    await mockConn('call_log').insert(callRow(0, {
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90,
    }));
    expect(await opts.shouldContinue()).toBe(false);
    expect(await opts.beforePush()).toBe(false);
  });

  test('the live re-check fails CLOSED (never throws) when its own evidence lookup fails, blocking both hooks', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(true);
    const [, , opts] = triggerNotification.mock.calls[0];

    followedUpIdsMock.mockRejectedValueOnce(new Error('synthetic evidence lookup failure'));
    await expect(opts.shouldContinue()).resolves.toBe(false);
    followedUpIdsMock.mockRejectedValueOnce(new Error('synthetic evidence lookup failure'));
    await expect(opts.beforePush()).resolves.toBe(false);
  });

  test('a partial push persists accepted subscription IDs; a retry does not re-buzz them', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // Attempt 1: one subscription accepted, one failed — retryable.
    triggerNotification.mockResolvedValueOnce({
      bellWritten: true, retryable: true,
      push: { sent: 1, failed: 1, deliveredSubscriptionIds: ['sub-accepted-1'] },
    });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const [, , opts1] = triggerNotification.mock.calls[0];
    // Nothing accepted before this, the very first attempt.
    expect(opts1.deliveredSubscriptionIds).toEqual([]);

    const pending = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(pending.metadata.promise_chaser).toMatchObject({ status: 'pending', deliveredSubscriptionIds: ['sub-accepted-1'] });

    // Age the lease so a retry (the sweep) can reclaim it.
    pending.metadata.promise_chaser.claimed_at = new Date(now - 20 * 60000).toISOString();
    await mockConn('call_log').where({ id: back.id }).update({ metadata: JSON.stringify(pending.metadata) });

    // Attempt 2 (the sweep): the second subscription finally accepts.
    triggerNotification.mockResolvedValueOnce({
      bellWritten: true, push: { sent: 1, failed: 0, deliveredSubscriptionIds: ['sub-accepted-1', 'sub-accepted-2'] },
    });
    expect(await sweepPromiseChasers()).toBe(1);
    const [, , opts2] = triggerNotification.mock.calls[1];
    // The already-accepted device from attempt 1 is passed forward so
    // payment-failure-notifications.js's own mechanism never re-buzzes it.
    expect(opts2.deliveredSubscriptionIds).toEqual(['sub-accepted-1']);

    const settled = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(settled.metadata.promise_chaser).toMatchObject({ status: 'rung' });
  });

  test("a partial push's delivered subscription IDs survive a later attempt that fails BEFORE it can persist anything itself", async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // Attempt 1: one subscription accepted, one failed.
    triggerNotification.mockResolvedValueOnce({
      bellWritten: true, retryable: true,
      push: { sent: 1, failed: 1, deliveredSubscriptionIds: ['sub-accepted-1'] },
    });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    const pending = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(pending.metadata.promise_chaser.deliveredSubscriptionIds).toEqual(['sub-accepted-1']);

    // Age the lease so attempt 2 can reclaim it.
    pending.metadata.promise_chaser.claimed_at = new Date(now - 20 * 60000).toISOString();
    await mockConn('call_log').where({ id: back.id }).update({ metadata: JSON.stringify(pending.metadata) });

    // Attempt 2: the evidence lookup itself fails inside selectPromiseToRing
    // — this attempt exits via the 'retry' outcome BEFORE ever reaching
    // recordProgress. claimAttempt's own reclaim write (the ONLY write this
    // attempt makes) must not wipe the deliveredSubscriptionIds it never
    // got the chance to recompute — it merges into the existing claim
    // rather than replacing it wholesale.
    followedUpIdsMock.mockRejectedValueOnce(new Error('synthetic evidence lookup failure'));
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid, { viaSweep: true })).toBe(false);
    expect(triggerNotification).toHaveBeenCalledTimes(1); // never reached dispatch this time
    // selectPromiseToRing logs this expected warning on the way to its
    // 'retry' outcome — consumed here so the afterEach's blanket "no
    // unexpected warnings" check stays meaningful for every other test.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('synthetic evidence lookup failure'));
    logger.warn.mockClear();

    const stillPending = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(stillPending.metadata.promise_chaser.status).toBe('pending');
    expect(stillPending.metadata.promise_chaser.deliveredSubscriptionIds).toEqual(['sub-accepted-1']);

    // Attempt 3 (a successful retry): the already-accepted device is still
    // never re-buzzed.
    stillPending.metadata.promise_chaser.claimed_at = new Date(now - 20 * 60000).toISOString();
    await mockConn('call_log').where({ id: back.id }).update({ metadata: JSON.stringify(stillPending.metadata) });
    triggerNotification.mockResolvedValueOnce({
      bellWritten: true, push: { sent: 1, failed: 0, deliveredSubscriptionIds: ['sub-accepted-1', 'sub-accepted-2'] },
    });
    expect(await sweepPromiseChasers()).toBe(1);
    const [, , opts3] = triggerNotification.mock.calls[1];
    expect(opts3.deliveredSubscriptionIds).toEqual(['sub-accepted-1']);
    const settledFinal = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(settledFinal.metadata.promise_chaser.status).toBe('rung');
  });

  test("an earlier call's commitment extraction still in flight leaves the claim pending — a quick callback never settles no_open_promise prematurely", async () => {
    // The earlier call — still mid-pipeline (a live processing_token), so
    // recordCommitmentsStep has not run yet and genuinely has no rows to find.
    const earlier = callRow(2, { processing_token: 'synthetic-in-flight-token', processing_status: 'processing' });
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    // No call_commitments row at all yet — extraction hasn't run.

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
    const pending = await mockConn('call_log').where({ id: back.id }).first('metadata');
    // Left pending for the sweep — never settled as a definitive "no promise".
    expect(pending.metadata.promise_chaser).toMatchObject({ status: 'pending' });

    // Extraction lands: the model pass finishes and records the promise,
    // and the earlier call's own pipeline finalizes.
    await mockConn('call_log').where({ id: earlier.id }).update({ processing_token: null, processing_status: 'processed' });
    const commitment = commitmentRow(earlier.id);
    await mockConn('call_commitments').insert(commitment);

    // Age the lease so the sweep can reclaim it.
    pending.metadata.promise_chaser.claimed_at = new Date(now - 20 * 60000).toISOString();
    await mockConn('call_log').where({ id: back.id }).update({ metadata: JSON.stringify(pending.metadata) });

    expect(await sweepPromiseChasers()).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const settled = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(settled.metadata.promise_chaser).toMatchObject({ status: 'rung', commitmentId: commitment.id });
  });

  test('a pre-connect screen abandoned mid-Gather (neither postback ever arrives) settles skipped instead of blocking every future sweep batch', async () => {
    // Past SCREEN_ABANDON_MS — a real Gather challenge resolves in seconds;
    // this one never got ?screened=1 or ?screenfail=1 at all.
    const back = callRow(45, { metadata: { promise_chaser: { status: 'pending', claimed_at: null }, preconnect_screen: 'gated' } });
    await mockConn('call_log').insert(back);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();
    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'skipped', reason: 'screen_abandoned' });
  });

  test('the sweep itself settles an abandoned screen (rather than a soft skip forever) so it stops recurring in every batch', async () => {
    const back = callRow(45, { metadata: { promise_chaser: { status: 'pending', claimed_at: null }, preconnect_screen: 'gated' } });
    await mockConn('call_log').insert(back);

    expect(await sweepPromiseChasers()).toBe(0); // settled skipped, never "rings"
    expect(triggerNotification).not.toHaveBeenCalled();
    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'skipped', reason: 'screen_abandoned' });
  });

  test('a freshly-leased claim never occupies a sweep batch slot a genuinely recoverable claim could use', async () => {
    // Older than `recoverable` below — without excluding it BEFORE the
    // LIMIT, it alone would fill limit:1 and starve the recoverable claim.
    const activelyOwned = callRow(10, {
      metadata: { promise_chaser: { status: 'pending', claimed_at: new Date(now - 5000).toISOString() } },
    });
    const earlier = callRow(241);
    const commitment = commitmentRow(earlier.id);
    const recoverable = callRow(5, { metadata: { promise_chaser: { status: 'pending', claimed_at: null } } });
    await mockConn('call_log').insert([activelyOwned, earlier, recoverable]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers({ limit: 1 })).toBe(1);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const recoveredRow = await mockConn('call_log').where({ id: recoverable.id }).first('metadata');
    expect(recoveredRow.metadata.promise_chaser).toMatchObject({ status: 'rung' });
    const stillOwnedRow = await mockConn('call_log').where({ id: activelyOwned.id }).first('metadata');
    // Untouched — its lease is still fresh; excluded before LIMIT, never
    // even attempted this tick.
    expect(stillOwnedRow.metadata.promise_chaser).toMatchObject({
      status: 'pending', claimed_at: activelyOwned.metadata.promise_chaser.claimed_at,
    });
  });

  test('a call for a promise another call is actively dispatching right now defers rather than racing it', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    // A genuinely SEPARATE call (the lead hung up and called right back)
    // already owns a fresh lease targeting this exact promise.
    const activelyDispatching = callRow(1, {
      metadata: { promise_chaser: { status: 'pending', claimed_at: new Date(now - 5000).toISOString(), commitmentId: commitment.id } },
    });
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, activelyDispatching, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled();

    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    // Deferred, not settled — its OWN claim stays pending at the normal
    // LEASE_MS retry cadence, by which point the other attempt has settled.
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'pending', commitmentId: commitment.id });

    // The other call's own claim is untouched — this call never wrote to it.
    const otherRow = await mockConn('call_log').where({ id: activelyDispatching.id }).first('metadata');
    expect(otherRow.metadata.promise_chaser.claimed_at).toBe(activelyDispatching.metadata.promise_chaser.claimed_at);
  });

  test("a second call for the same promise inherits the first call's partial-push history and never re-buzzes those devices", async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    // A prior attempt (a genuinely separate call) already buzzed one
    // device and left its own claim pending — its lease is stale (not
    // "active"), but its delivery history is still the live cross-call fact.
    const priorAttempt = callRow(20, {
      metadata: {
        promise_chaser: {
          status: 'pending',
          claimed_at: new Date(now - 20 * 60000).toISOString(),
          commitmentId: commitment.id,
          deliveredSubscriptionIds: ['sub-from-first-call'],
        },
      },
    });
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, priorAttempt, back]);
    await mockConn('call_commitments').insert(commitment);

    triggerNotification.mockResolvedValueOnce({
      bellWritten: true,
      push: { sent: 1, failed: 0, deliveredSubscriptionIds: ['sub-from-first-call', 'sub-new'] },
    });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(true);
    const [, , opts] = triggerNotification.mock.calls[0];
    expect(opts.deliveredSubscriptionIds).toEqual(['sub-from-first-call']);

    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(row.metadata.promise_chaser).toMatchObject({ status: 'rung', commitmentId: commitment.id });
  });

  test("a partial push's own claim keeps its commitmentId, so a SEPARATE call reaching the same promise next finds it through promiseDeliveryState", async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(10);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    // Attempt 1: a partial push — stampTarget stamps commitmentId, then
    // recordProgress persists deliveredSubscriptionIds. Both must survive
    // on the SAME row afterward.
    triggerNotification.mockResolvedValueOnce({
      bellWritten: true, retryable: true,
      push: { sent: 1, failed: 1, deliveredSubscriptionIds: ['sub-accepted-1'] },
    });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    const afterProgress = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(afterProgress.metadata.promise_chaser).toMatchObject({
      status: 'pending', commitmentId: commitment.id, deliveredSubscriptionIds: ['sub-accepted-1'],
    });

    // Age the lease so `back` reads as a STALE claim (not "active") to the
    // second call below — this test is about commitmentId/deliveredSub
    // survival, not the separate activeElsewhere defer path.
    afterProgress.metadata.promise_chaser.claimed_at = new Date(now - 20 * 60000).toISOString();
    await mockConn('call_log').where({ id: back.id }).update({ metadata: JSON.stringify(afterProgress.metadata) });

    // A genuinely SEPARATE call (the same lead calling right back) reaches
    // the SAME promise next — it must see `back`'s own commitmentId (and
    // therefore its deliveredSubscriptionIds) through promiseDeliveryState,
    // never re-buzzing the device `back` already reached.
    const secondCall = callRow(0);
    await mockConn('call_log').insert(secondCall);
    triggerNotification.mockResolvedValueOnce({
      bellWritten: true,
      push: { sent: 1, failed: 0, deliveredSubscriptionIds: ['sub-accepted-1', 'sub-new'] },
    });
    expect(await ringPromiseChaserIfNeeded(secondCall.twilio_call_sid)).toBe(true);
    const [, , opts] = triggerNotification.mock.calls[1];
    expect(opts.deliveredSubscriptionIds).toEqual(['sub-accepted-1']);
  });

  test("a retry that lands on a DIFFERENT promise (the first was kept in the meantime) never inherits the first promise's delivered-device history", async () => {
    const earlierA = callRow(300); // waited longest — selected first
    const commitmentA = commitmentRow(earlierA.id);
    const earlierB = callRow(200);
    const commitmentB = commitmentRow(earlierB.id);
    const back = callRow(0);
    await mockConn('call_log').insert([earlierA, earlierB, back]);
    await mockConn('call_commitments').insert([commitmentA, commitmentB]);

    // Attempt 1: promise A (the longer-waiting one) is selected; a partial
    // push buzzes sub-1 and leaves the claim pending.
    triggerNotification.mockResolvedValueOnce({
      bellWritten: true, retryable: true,
      push: { sent: 1, failed: 1, deliveredSubscriptionIds: ['sub-1'] },
    });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    const afterFirst = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(afterFirst.metadata.promise_chaser).toMatchObject({ commitmentId: commitmentA.id, deliveredSubscriptionIds: ['sub-1'] });

    // Promise A gets kept in the meantime (staff reached the caller,
    // between A's own call and B's) — the SLA pager's own evidence.
    // Strictly after A's call ended but strictly before B's own call, so
    // it keeps A without also keeping B.
    const reached = callRow(250, { direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90 });
    await mockConn('call_log').insert(reached);

    // Age the lease so a retry can reclaim it.
    afterFirst.metadata.promise_chaser.claimed_at = new Date(now - 20 * 60000).toISOString();
    await mockConn('call_log').where({ id: back.id }).update({ metadata: JSON.stringify(afterFirst.metadata) });

    // Attempt 2 (the retry): A is now kept, so selectPromiseToRing moves on
    // to promise B — a promise sub-1 was never actually delivered against.
    triggerNotification.mockResolvedValueOnce({
      bellWritten: true, push: { sent: 1, failed: 0, deliveredSubscriptionIds: ['sub-2'] },
    });
    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid, { viaSweep: true })).toBe(true);
    const [, , opts2] = triggerNotification.mock.calls[1];
    // sub-1's history belonged to A, never to B — it must not be excluded
    // from B's own push.
    expect(opts2.deliveredSubscriptionIds).toEqual([]);

    const settled = await mockConn('call_log').where({ id: back.id }).first('metadata');
    expect(settled.metadata.promise_chaser).toMatchObject({ status: 'rung', commitmentId: commitmentB.id });
  });

  test("switching targets clears the old promise's delivered-device history atomically, even when THIS attempt defers before it can write anything else", async () => {
    const earlierA = callRow(300);
    const commitmentA = commitmentRow(earlierA.id);
    const earlierB = callRow(200);
    const commitmentB = commitmentRow(earlierB.id);
    // `back` already carries a PRIOR completed attempt's history against A.
    const back = callRow(0, {
      metadata: { promise_chaser: { status: 'pending', claimed_at: null, commitmentId: commitmentA.id, deliveredSubscriptionIds: ['sub-1'] } },
    });
    // A is kept in the meantime — strictly after A's own call, strictly
    // before B's, so only A (never B) reads as followed up.
    const reached = callRow(250, { direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90 });
    // Another call is ACTIVELY dispatching B right now — `back`'s own
    // retry (below) will switch to B and then defer on activeElsewhere,
    // never reaching recordProgress or settle at all.
    const activelyDispatchingB = callRow(1, {
      metadata: { promise_chaser: { status: 'pending', claimed_at: new Date(now - 5000).toISOString(), commitmentId: commitmentB.id } },
    });
    await mockConn('call_log').insert([earlierA, earlierB, back, reached, activelyDispatchingB]);
    await mockConn('call_commitments').insert([commitmentA, commitmentB]);

    expect(await ringPromiseChaserIfNeeded(back.twilio_call_sid)).toBe(false);
    expect(triggerNotification).not.toHaveBeenCalled(); // deferred before ever reaching dispatch

    const row = await mockConn('call_log').where({ id: back.id }).first('metadata');
    // stampTarget's own single write already switched to B and cleared
    // A's stale history — nothing else ran afterward to have done it.
    expect(row.metadata.promise_chaser.commitmentId).toBe(commitmentB.id);
    expect(row.metadata.promise_chaser.deliveredSubscriptionIds).toBeUndefined();
  });
});
