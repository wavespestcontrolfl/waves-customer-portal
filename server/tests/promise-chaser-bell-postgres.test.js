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
const { etDateString, formatETDate, formatETTime, etParts } = require('../utils/datetime-et');
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
  const tables = ['call_log', 'call_commitments', 'scheduled_services', 'customers', 'notifications', 'blocked_numbers', 'blocked_call_attempts', 'audit_log', 'estimates'];
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
  // processing_status defaults to 'processed' (Codex #5019 r11 P2: the
  // sweep now also requires the call's own recording pipeline to have
  // SETTLED, not just the call itself to have ended) — every fixture call
  // here is presumed to have already finished processing by the time the
  // sweep considers it, matching ordinary real-world timing; the settle
  // tests below explicitly override this to exercise the gate itself.
  function callRow(minsAgo, extra = {}) {
    const { metadata, ...rest } = extra;
    return {
      id: randomUUID(), twilio_call_sid: `CA${randomUUID().replaceAll('-', '')}`,
      direction: 'inbound', from_phone: PHONE, to_phone: OUR_NUMBER, customer_id: null,
      status: 'completed', answered_by: 'human', duration_seconds: 90, processing_status: 'processed',
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
      // The column default in production; CREATE TABLE AS copies no defaults.
      renewal_trail: true,
      created_at: new Date(now - 4 * 3600000), updated_at: new Date(now - 4 * 3600000),
      ...extra,
    };
  }

  test('a callback the pipeline classified as spam never rings, even from a number with an open promise (Codex #5019 r18 P2)', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0, { processing_status: 'spam' });
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

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
    // own "kept" evidence (an ordinary outbound call, 60s+, unlinked, placed
    // through the staff bridge, a live conversation: staff-contact.js
    // personCallBack).
    const reached = callRow(60, {
      direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90, source: 'admin-click',
      v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ meta: { is_voicemail: 'false' } }),
    });
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
      // 33 minutes ago, not 31: with the window now on call COMPLETION
      // (Codex #5019 r9 P2), callRow's own default 90s duration nudges the
      // effective end time forward — 31 minutes ago would actually still
      // END inside the 30-minute window. 33 minutes stays safely outside.
      const tooOld = callRow(33);
      await mockConn('call_log').insert([earlier, tooOld]);
      await mockConn('call_commitments').insert(commitment);
      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();

      const justInside = callRow(29);
      await mockConn('call_log').insert(justInside);
      expect(await sweepPromiseChasers()).toBe(1);
    });

    test('the window is on when the call ENDED, not when it started — a long call that just ended rings; one that ended 31 minutes ago does not (Codex #5019 r9 P2)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      // Started 35 minutes ago — already outside a start-only window — but
      // a 35-minute call, so it just NOW ended. The terminal-status filter
      // (r8) means /voice's own eligibility stamp alone can no longer
      // exclude a call still in progress, so it's the completion-based
      // window's own job to admit this one.
      const justEnded = callRow(35, { duration_seconds: 35 * 60 });
      await mockConn('call_log').insert([earlier, justEnded]);
      await mockConn('call_commitments').insert(commitment);
      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('a call that ended 31 minutes ago (however long it ran) is excluded', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      // Started 41 minutes ago, ran 10 minutes — ended 31 minutes ago.
      const endedTooLongAgo = callRow(41, { duration_seconds: 10 * 60 });
      await mockConn('call_log').insert([earlier, endedTooLongAgo]);
      await mockConn('call_commitments').insert(commitment);
      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('candidate promises are ordered by their EFFECTIVE obligation time, not call_started_at alone (Codex #5019 r9 P2)', async () => {
      // The human commitment's own LINKED CALL started 5 hours ago — by
      // call_started_at alone this looks like the longest-waiting promise
      // — but a human-typed commitment's real obligation only begins when
      // it was actually LOGGED (r5/r8's own boundary), just 5 minutes ago.
      const humanCall = callRow(300);
      const loggedRecently = new Date(now - 5 * 60000);
      const humanCommitment = commitmentRow(humanCall.id, {
        source: 'human', kind: 'send_estimate', description: 'Send the quote',
        created_at: loggedRecently, updated_at: loggedRecently,
      });
      // The AI commitment's own linked call started only 4 hours ago —
      // LESS old by call_started_at — but its (unrenewed) obligation IS
      // that call time, genuinely the longer real wait once the human
      // promise's own recent logging is accounted for.
      const aiCall = callRow(240);
      const aiCommitment = commitmentRow(aiCall.id); // default source 'ai'
      const back = callRow(0);
      await mockConn('call_log').insert([humanCall, aiCall, back]);
      await mockConn('call_commitments').insert([humanCommitment, aiCommitment]);

      expect(await sweepPromiseChasers()).toBe(1);
      const [, payload] = triggerNotification.mock.calls[0];
      // The AI promise's own obligation (4h ago) is the genuinely LONGER
      // real wait, even though the human commitment's own linked call
      // started earlier — call_started_at-only sorting would have picked
      // the human one instead.
      expect(payload.commitmentId).toBe(aiCommitment.id);
      expect(payload.when).toBe(`${formatETDate(aiCall.created_at)} ${formatETTime(aiCall.created_at)}`);
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

  test('a Twilio withheld-caller-ID sentinel never rings, even when a sentinel-number promise is open (Codex #5019 r5 P2)', async () => {
    const sentinelPhone = '7378742833'; // one of PHONE_SENTINELS (external-phone.js)
    const earlier = callRow(240, { from_phone: sentinelPhone });
    const commitment = commitmentRow(earlier.id);
    const back = callRow(0, { from_phone: sentinelPhone });
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(commitment);

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

  test('a callback still RINGING or IN-PROGRESS never rings — the conversation itself may still keep the promise; the same call rings on the next tick once it ends (Codex #5019 r8 P2)', async () => {
    const earlier = callRow(240);
    const commitment = commitmentRow(earlier.id);
    // /voice stamps promise_chaser_eligible the INSTANT the call arrives —
    // well before Twilio ever reports a terminal status — so a call still
    // mid-conversation must not be swept in and alerted on before the
    // conversation itself has a chance to fulfill the promise.
    const ringing = callRow(0, { status: 'ringing' });
    await mockConn('call_log').insert([earlier, ringing]);
    await mockConn('call_commitments').insert(commitment);

    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();

    // Still in progress — still excluded.
    await mockConn('call_log').where({ id: ringing.id }).update({ status: 'in-progress' });
    expect(await sweepPromiseChasers()).toBe(0);
    expect(triggerNotification).not.toHaveBeenCalled();

    // The call ends (terminal status) — now eligible, rings on this later tick.
    await mockConn('call_log').where({ id: ringing.id }).update({ status: 'completed' });
    expect(await sweepPromiseChasers()).toBe(1);
  });

  describe('processing must SETTLE before an alert (Codex #5019 r11 P2)', () => {
    test('a terminal call still mid-processing never rings — the pipeline may still create the booking or send the estimate that keeps the promise', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0, { processing_status: 'processing' }); // ended just now, pipeline still running
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('once processed, the SAME call rings on the next tick', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0, { processing_status: 'processing' });
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);
      expect(await sweepPromiseChasers()).toBe(0);

      await mockConn('call_log').where({ id: back.id }).update({ processing_status: 'processed' });
      expect(await sweepPromiseChasers()).toBe(1);
    });

    test.each([
      ['processing', 0], ['extraction_failed', 0], ['no_transcription', 0],
    ])('a call still retryable (%s) never rings, however long ago it ended — a later retry may keep the promise (Codex #5019 r20 P2)', async (status, attempts) => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const stuck = callRow(12, { processing_status: status, extraction_attempts: attempts });
      await mockConn('call_log').insert([earlier, stuck]);
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(0);
    });

    test('a call whose extraction retries are exhausted is settled and rings (Codex #5019 r20 P2)', async () => {
      const { CALL_EXTRACTION_MAX_ATTEMPTS } = require('../config/call-extraction-retry');
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const exhausted = callRow(12, { processing_status: 'extraction_failed', extraction_attempts: CALL_EXTRACTION_MAX_ATTEMPTS });
      await mockConn('call_log').insert([earlier, exhausted]);
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(1);
    });
  });

  test("a human-typed commitment's alert reports its OWN created_at as when the promise was made, never the linked call's time; an AI-extracted one still uses the call time (Codex #5019 r8 P2)", async () => {
    const earlier = callRow(240); // call_started_at — an hour+ before the human note
    const loggedAt = new Date(now - 30 * 60000); // staff logged the promise 30 minutes ago
    const humanCommitment = commitmentRow(earlier.id, {
      source: 'human', kind: 'send_estimate', description: 'Send the quote',
      created_at: loggedAt, updated_at: loggedAt,
    });
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    await mockConn('call_commitments').insert(humanCommitment);

    expect(await sweepPromiseChasers()).toBe(1);
    const [, payload] = triggerNotification.mock.calls[0];
    expect(payload.when).toBe(`${formatETDate(loggedAt)} ${formatETTime(loggedAt)}`);
    expect(payload.when).not.toBe(`${formatETDate(earlier.created_at)} ${formatETTime(earlier.created_at)}`);
  });

  test("an AI-extracted commitment's alert reports the ORIGINATING call's time, not its own (later) extraction insert time (Codex #5019 r8 P2)", async () => {
    const earlier = callRow(240);
    const back = callRow(0);
    await mockConn('call_log').insert([earlier, back]);
    // source: 'ai' (the default) — its own row lands well after the call,
    // exactly like a slow extraction pass; the promise was still made AT
    // the call, so that (call_started_at), not this row's own created_at,
    // is what the alert must report.
    const aiCommitment = commitmentRow(earlier.id, { created_at: new Date(now + 1000), updated_at: new Date(now + 1000) });
    await mockConn('call_commitments').insert(aiCommitment);

    expect(await sweepPromiseChasers()).toBe(1);
    const [, payload] = triggerNotification.mock.calls[0];
    expect(payload.when).toBe(`${formatETDate(earlier.created_at)} ${formatETTime(earlier.created_at)}`);
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

    test('a deliberately SUPPRESSED result (every admin opted out of both channels) settles the fact — no redispatch on the next tick (Codex #5019 r5 P2)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // Mirrors triggerNotification's own "every admin has both channels
      // off" result shape — deliberate preference suppression, not a
      // delivery failure (missed-call-bell.js / repeat-caller-bell.js both
      // settle on this exact flag).
      triggerNotification.mockResolvedValue({ bellWritten: false, push: null, suppressed: true });
      expect(await sweepPromiseChasers()).toBe(1); // settles this tick
      expect(await sweepPromiseChasers()).toBe(0); // the fact stops a redispatch
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      const [, , opts] = triggerNotification.mock.calls[0];
      const dedupeKey = `promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`;
      expect(opts.dedupeKey).toBe(dedupeKey);
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
      expect(row).toBeTruthy();
    });

    test('a POLICY-SILENCED result settles the fact the same way as suppressed', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      triggerNotification.mockResolvedValue({ bellWritten: false, push: { sent: 0, skipped: 'bell_policy' }, policySilenced: true });
      expect(await sweepPromiseChasers()).toBe(1);
      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      const dedupeKey = `promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`;
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
      expect(row).toBeTruthy();
    });

    test('an ACTUAL delivery failure (retryable, not suppressed) writes no fact — the next tick retries', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // A genuine transient failure: neither bell nor push happened, and
      // neither suppression flag is set — e.g. the technicians query or the
      // preferences lookup blipped (notification-triggers.js's own
      // `retryable` result).
      triggerNotification.mockResolvedValue({ bellWritten: false, push: null, retryable: true });
      expect(await sweepPromiseChasers()).toBe(0); // not counted as rung
      const dedupeKey = `promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`;
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
      expect(row).toBeFalsy(); // no terminal fact — the next tick must retry

      // Next tick, delivery genuinely succeeds — still rings.
      triggerNotification.mockResolvedValue({ bellWritten: true, push: { sent: 1 } });
      expect(await sweepPromiseChasers()).toBe(1);
    });

    test("a TRANSIENT failure inside the live recheck itself never settles the fact, even though notification-triggers.js's own shouldContinue rejection reports it as `suppressed` (Codex #5019 r7 P1)", async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // Mirrors notification-triggers.js's REAL behavior when shouldContinue
      // (stillEligible, wired into the bell write, unlike missed-call-bell.js
      // / repeat-caller-bell.js which only wire it into beforePush) rejects:
      // NotificationService.create returns `suppressed: true, reason:
      // 'pre_send_check_blocked'` regardless of WHY stillEligible said no —
      // a genuine supersession and a transient DB blip inside it look
      // identical from here.
      const commitments = require('../services/call-commitments');
      triggerNotification.mockImplementationOnce(async (triggerKey, payload, opts) => {
        const spy = jest.spyOn(commitments, 'refreshFulfillment').mockRejectedValueOnce(new Error('synthetic fulfillment outage'));
        const stillWanted = await opts.shouldContinue();
        spy.mockRestore();
        expect(stillWanted).toBe(false);
        return { bellWritten: false, push: { sent: 0, skipped: 'superseded_before_push' }, suppressed: true };
      });
      expect(await sweepPromiseChasers()).toBe(0); // never counted as rung
      const dedupeKey = `promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`;
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
      expect(row).toBeFalsy(); // no terminal fact written — this is retryable, not a real opt-out

      // Next tick, the transient outage has cleared — the SAME promise
      // still genuinely rings.
      expect(await sweepPromiseChasers()).toBe(1);
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

  describe('the live recheck reuses the cron-held connection under a small pool (Codex #5019 r14 P1)', () => {
    test('DB_POOL_MAX=2: with the cron connection AND notifyAdmin\'s own OPEN dedupe transaction both already held, shouldContinue must still complete — it reuses the held connection instead of asking the pool for a third', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // A DEDICATED small pool against the SAME schema — the production
      // floor this bug is specific to (cron-lock.js's own docstring, and
      // every other site in this repo that guards against this exact
      // shape: DB_POOL_MAX=2 is a supported config, not a hypothetical).
      const smallDb = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'], pool: { min: 0, max: 2 } });
      const originalConn = mockConn; // the real, schema-scoped `database` — restored before/after the exhausted window
      const cronLock = require('../utils/cron-lock');
      let cronConn;
      let notifyConn;
      try {
        // Connection #1: simulates runExclusive's own held connection —
        // ACQUIRED BEFORE findPromiseToRing's own reads run (real timing:
        // the whole sweep is already inside runExclusive by the time any
        // call is even read).
        cronConn = await smallDb.client.acquireConnection();
        // Connection #2 is acquired, and `db` itself is only pointed at
        // this exhausted pool, from WITHIN the triggerNotification mock —
        // exactly the real window: notifyAdmin's own transaction opens
        // ONLY once triggerNotification actually runs, well after
        // findPromiseToRing's own (unaffected) reads already completed
        // against the real pool.
        triggerNotification.mockImplementationOnce(async (triggerKey, payload, opts) => {
          notifyConn = await smallDb.client.acquireConnection(); // both of the 2-max pool's slots now held
          mockConn = smallDb;
          const spy = jest.spyOn(cronLock, 'getHeldConnection').mockReturnValue(cronConn);
          let stillWanted;
          try {
            stillWanted = await Promise.race([
              opts.shouldContinue(),
              new Promise((_, reject) => setTimeout(
                () => reject(new Error('timed out — stillEligible likely blocked waiting on a third pool connection')), 8000,
              )),
            ]);
          } finally {
            spy.mockRestore();
            mockConn = originalConn; // notifyAdmin's own transaction has "committed" — its connection is free again
          }
          return stillWanted
            ? { bellWritten: true, push: { sent: 1 } }
            : { bellWritten: false, push: { sent: 0, skipped: 'superseded_before_push' } };
        });

        expect(await sweepPromiseChasers()).toBe(1);
      } finally {
        mockConn = originalConn;
        if (cronConn) smallDb.client.releaseConnection(cronConn);
        if (notifyConn) smallDb.client.releaseConnection(notifyConn);
        await smallDb.destroy();
      }
    }, 15000);
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

    test('a bell whose post-dispatch retirement failed is retired on a later tick once nothing is owed (Codex #5019 r20 P2)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);
      // The state a failed retirement leaves: an unread bell, no delivery
      // fact, and a promise staff have since closed.
      await mockConn('notifications').insert({
        id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'fixture',
        metadata: { triggerKey: 'promise_chaser', dedupeKey: `promise_chaser:${commitment.id}:0:x`, payload: { callLogId: back.id, commitmentId: commitment.id } },
      });
      await mockConn('call_commitments').where({ id: commitment.id }).update({ status: 'fulfilled' });

      expect(await sweepPromiseChasers()).toBe(0);
      const bell = await mockConn('notifications').whereRaw("metadata->'payload'->>'callLogId' = ?", [back.id]).first();
      expect(bell.read_at).not.toBeNull();
    });

    test('a bell for a promise since kept is retired when the same callback now rings for a second open promise (Codex #5019 r21 P2)', async () => {
      const earlierA = callRow(300);
      const earlierB = callRow(240);
      const kept = commitmentRow(earlierA.id);
      const stillOwed = commitmentRow(earlierB.id, { kind: 'send_estimate', description: 'Send the quote' });
      const back = callRow(0);
      await mockConn('call_log').insert([earlierA, earlierB, back]);
      await mockConn('call_commitments').insert([kept, stillOwed]);
      const staleId = randomUUID();
      await mockConn('notifications').insert({
        id: staleId, recipient_type: 'admin', category: 'missed_call', title: 'fixture',
        metadata: { triggerKey: 'promise_chaser', dedupeKey: `promise_chaser:${kept.id}:0:x`, payload: { callLogId: back.id, commitmentId: kept.id } },
      });
      await mockConn('call_commitments').where({ id: kept.id }).update({ status: 'fulfilled' });

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification.mock.calls[0][1].commitmentId).toBe(stillOwed.id);
      expect((await mockConn('notifications').where({ id: staleId }).first()).read_at).not.toBeNull();
    });

    test('an unverifiable lookup never retires a bell', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);
      await mockConn('notifications').insert({
        id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'fixture',
        metadata: { triggerKey: 'promise_chaser', dedupeKey: `promise_chaser:${commitment.id}:0:x`, payload: { callLogId: back.id, commitmentId: commitment.id } },
      });
      jest.spyOn(commitments, 'refreshFulfillment').mockRejectedValue(new Error('synthetic outage'));

      expect(await sweepPromiseChasers()).toBe(0);
      const bell = await mockConn('notifications').whereRaw("metadata->'payload'->>'callLogId' = ?", [back.id]).first();
      expect(bell.read_at).toBeNull();
      logger.warn.mockClear();
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

    test('a promise reopened between selection and dispatch is blocked at the live recheck too — no ring, no delivery fact (Codex #5019 r9 P2)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { human_state: 'confirmed' });
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      triggerNotification.mockImplementationOnce(async (triggerKey, payload, opts) => {
        // Staff reopen the SAME promise in the gap between findPromiseToRing's
        // own snapshot (already run, with no renewal present) and this
        // dispatch-time recheck — the same precedence rule findPromiseToRing
        // itself enforces (a callback cannot be "about" a renewal that
        // postdates it) must hold here too, on a FRESH read, or a renewal
        // landing in exactly this gap would ring on a now-stale obligation.
        const renewedAt = new Date(now + 1000);
        await mockConn('audit_log').insert({
          id: randomUUID(), actor_type: 'admin', action: 'callback_reopen',
          resource_type: 'call_commitment', resource_id: commitment.id,
          metadata: JSON.stringify({ renewed_at: renewedAt.toISOString() }), created_at: renewedAt,
        });
        const stillWanted = await opts.shouldContinue();
        expect(stillWanted).toBe(false);
        return { bellWritten: false, push: { sent: 0, skipped: 'superseded_before_push' } };
      });

      expect(await sweepPromiseChasers()).toBe(0);
      const dedupeKey = `promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`;
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
      expect(row).toBeFalsy(); // retryable, not settled — the next tick re-evaluates from scratch
    });

    test('an UNREVIEWED AI callback reopened between selection and dispatch is blocked at the live recheck too — the FRESH row, not the stale selection snapshot, is what sees the renewal (Codex #5019 r10 P2)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id); // default source 'ai', human_state null — never reviewed
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      triggerNotification.mockImplementationOnce(async (triggerKey, payload, opts) => {
        // Staff REVIEW and reopen the commitment in the gap between
        // findPromiseToRing's own snapshot (still human_state: null there)
        // and this dispatch-time recheck. obligationRenewedAt short-circuits
        // on human_state NOT IN ('confirmed','edited') before it ever looks
        // at renewal events — passing the STALE snapshot (still null) would
        // silently skip the whole check, exactly the bug this fixes.
        const renewedAt = new Date(now + 1000);
        await mockConn('call_commitments').where({ id: commitment.id }).update({ human_state: 'confirmed' });
        await mockConn('audit_log').insert({
          id: randomUUID(), actor_type: 'admin', action: 'callback_reopen',
          resource_type: 'call_commitment', resource_id: commitment.id,
          metadata: JSON.stringify({ renewed_at: renewedAt.toISOString() }), created_at: renewedAt,
        });
        const stillWanted = await opts.shouldContinue();
        expect(stillWanted).toBe(false);
        return { bellWritten: false, push: { sent: 0, skipped: 'superseded_before_push' } };
      });

      expect(await sweepPromiseChasers()).toBe(0);
      const dedupeKey = `promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`;
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
      expect(row).toBeFalsy();
    });

    test('fulfilled in the exact gap between the bell insert and the push — the now-stale bell is retired and the delivery fact is never written (Codex #5019 r11 P2)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote' });
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);
      const dedupeKey = `promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`;

      triggerNotification.mockImplementationOnce(async (triggerKey, payload, opts) => {
        // The bell write's own recheck (shouldContinue) passes — the
        // promise is still genuinely open at this instant.
        expect(await opts.shouldContinue()).toBe(true);
        await mockConn('notifications').insert({
          id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'fixture',
          metadata: { triggerKey: 'promise_chaser', dedupeKey: opts.dedupeKey, payload: { commitmentId: payload?.commitmentId, callLogId: payload?.callLogId } },
        });
        // The estimate is genuinely sent in the exact gap between the bell
        // write and the push.
        await mockConn('call_commitments').where({ id: commitment.id }).update({
          status: 'fulfilled', fulfilled_at: new Date(),
          fulfillment: JSON.stringify({ kind: 'manual', basis: 'sent_in_race_window' }),
        });
        expect(await opts.beforePush()).toBe(false);
        return { bellWritten: true, push: { sent: 0, skipped: 'superseded_before_push' } };
      });

      await sweepPromiseChasers();
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
      expect(row).toBeFalsy(); // never written for a bell we just took back down
      const notif = await mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first('read_at');
      expect(notif.read_at).toBeTruthy(); // retired (marked read) — mirrors repeat-caller-bell's own supersedeMissedCallAdmin cleanup
    });

    test('a TRANSIENT failure in the FINAL post-dispatch recheck never retires an already-written bell — only a POSITIVELY confirmed supersession does (Codex #5019 r15 P1)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);
      const dedupeKey = `promise_chaser:${commitment.id}:0:${etDateString(new Date(now))}`;

      // FOUR calls happen in order: findPromiseToRing's own eager
      // pre-check refresh, then shouldContinue (the bell write) and
      // beforePush (the push) each run stillEligible once — all three
      // succeed genuinely, the promise really is still open. Only the
      // FOURTH (the post-dispatch retire check, run after all three)
      // hits a synthetic transient outage.
      const spy = jest.spyOn(commitments, 'refreshFulfillment')
        .mockResolvedValueOnce({ checked: 1, fulfilled: 0, hinted: 0, cleared: 0, failed: 0 })
        .mockResolvedValueOnce({ checked: 1, fulfilled: 0, hinted: 0, cleared: 0, failed: 0 })
        .mockResolvedValueOnce({ checked: 1, fulfilled: 0, hinted: 0, cleared: 0, failed: 0 })
        .mockRejectedValueOnce(new Error('synthetic transient outage'));

      triggerNotification.mockImplementationOnce(async (triggerKey, payload, opts) => {
        expect(await opts.shouldContinue()).toBe(true);
        await mockConn('notifications').insert({
          id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'fixture',
          metadata: { triggerKey: 'promise_chaser', dedupeKey: opts.dedupeKey, payload: { commitmentId: payload?.commitmentId, callLogId: payload?.callLogId } },
        });
        expect(await opts.beforePush()).toBe(true);
        return { bellWritten: true, push: { sent: 1 } };
      });

      expect(await sweepPromiseChasers()).toBe(1);
      spy.mockRestore();

      // The valid, genuinely-delivered bell is left exactly as it is — an
      // unverifiable recheck is never treated as "confirmed superseded".
      const notif = await mockConn('notifications').whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey]).first('read_at');
      expect(notif.read_at).toBeNull();
      // And the delivery fact still settles normally — bellWritten is
      // true and the bell was never retired.
      const row = await mockConn('promise_chaser_deliveries').where({ dedupe_key: dedupeKey }).first('dedupe_key');
      expect(row).toBeTruthy();
    });
  });

  test('205 non-SLA commitments on the number never crowd out the one SLA promise — the kind filter is now in the QUERY, not a client-side filter after the page (Codex #5019 r10 P2)', async () => {
    // All 205 are explicitly OVERDUE (due_at in the past) — the query's
    // own ORDER BY sorts every overdue row (tier 0) before every
    // not-yet-due one (tier 1) REGARDLESS of any other tiebreak, so this
    // forces the noise rows ahead of the SLA promise (tier 1: its own
    // implicit 'callback' due date, tomorrow ET, is comfortably in the
    // future) no matter how effectiveDueSql or the id tiebreak would
    // otherwise land. Without the query-side kinds filter, 205 tier-0 rows
    // alone fill the whole LIMIT 200 candidate page and the SLA promise —
    // sorting last, in tier 1 — is never even READ, let alone discarded.
    const overdueAt = new Date(now - 60 * 60000); // 1h ago — already due
    const noiseCall = callRow(240);
    const noiseRows = Array.from({ length: 205 }, () => commitmentRow(noiseCall.id, {
      kind: 'send_report', description: 'noise — not an SLA kind', due_at: overdueAt,
    }));
    const slaCall = callRow(100);
    const slaCommitment = commitmentRow(slaCall.id); // default kind 'callback' — an SLA kind, not (yet) due
    const back = callRow(0);
    await mockConn('call_log').insert([noiseCall, slaCall, back]);
    await mockConn('call_commitments').insert([...noiseRows, slaCommitment]);

    expect(await sweepPromiseChasers()).toBe(1);
    const [, payload] = triggerNotification.mock.calls[0];
    expect(payload.commitmentId).toBe(slaCommitment.id);
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
      // The renewed obligation's alert says when it was RENEWED (codex r9 P2).
      const [, payload2] = triggerNotification.mock.calls[1];
      expect(payload2.when).toBe(`${formatETDate(renewedAt)} ${formatETTime(renewedAt)}`);
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

    test('a human-added commitment created AFTER the callback never rings for it, even though it is not a renewal (Codex #5019 r5 P2)', async () => {
      const earlier = callRow(240);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      // Staff typed this promise onto the OLDER call a moment AFTER `back`
      // already came in — obligationRenewedAt returns null for a non-callback
      // kind, so only the commitment's OWN created_at can catch this: it
      // cannot possibly be "about" a callback that happened before it
      // existed.
      const commitment = commitmentRow(earlier.id, {
        kind: 'send_estimate', description: 'Send the quote', source: 'human',
        created_at: new Date(now + 1000), updated_at: new Date(now + 1000),
      });
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('an AI-extracted commitment whose row lands AFTER the callback (slow extraction) still rings — its boundary is the ORIGINATING call, never its own insert time (Codex #5019 r6 P1)', async () => {
      const earlier = callRow(240);
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      // source: 'ai' (the default) — its row's own created_at is stamped
      // at the REAL moment the extraction pipeline inserted it, which here
      // is deliberately AFTER `back` already arrived, exactly like a slow
      // extraction pass finishing late in production. The promise itself
      // was made on `earlier` (240 minutes ago), well before the callback —
      // that origin, not this row's insert time, is what must gate it.
      const commitment = commitmentRow(earlier.id, {
        created_at: new Date(now + 1000), updated_at: new Date(now + 1000),
      });
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('a send_estimate EDITED (not merely confirmed) AFTER the callback is never re-attributed to it — the durable commitment_edit event renews it, not human_state (Codex #5019 r11 P2, then r16→r17 P1)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote' }); // AI, unreviewed
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // Staff EDIT the send_estimate commitment (re-word it, change its
      // due date, etc.) through the generic Call intelligence panel
      // STRICTLY AFTER this callback. applyHumanUpdate's real 'edit' action
      // does two things: sets human_state to 'edited' on the row AND writes
      // a durable commitment_edit audit_log event (Codex r17 structural
      // fix, mirroring callback's own callback_edit/callback_reopen) — the
      // event, not human_state, is what obligationRenewedAt now reads for
      // this kind, since a LATER ordinary confirm always resets human_state
      // to 'confirmed' for it regardless of this edit (see the
      // merely-confirmed and edit-then-confirm tests below).
      const editedAt = new Date(now + 1000);
      await mockConn('call_commitments').where({ id: commitment.id })
        .update({ human_state: 'edited', reviewed_at: editedAt, updated_at: editedAt });
      await mockConn('audit_log').insert({
        id: randomUUID(), actor_type: 'admin', action: 'commitment_edit',
        resource_type: 'call_commitment', resource_id: commitment.id,
        metadata: JSON.stringify({ renewed_at: editedAt.toISOString() }), created_at: editedAt,
      });

      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('a send_estimate merely CONFIRMED (never edited) AFTER the callback is NOT treated as renewed — the callback still rings (Codex #5019 r16 P1)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote' }); // AI, unreviewed
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      // Staff merely acknowledge ("Confirm") the AI's own extraction after
      // this callback already arrived — nothing about the obligation
      // itself changed, and a plain confirm writes NO commitment_edit /
      // commitment_reopen event (applyHumanUpdate's own confirm branch
      // never reaches that write — `before` is populated only for
      // reopen/edit). reviewed_at ALSO advances here (the same shared patch
      // every applyHumanUpdate action stamps), but with no durable event on
      // record, obligationRenewedAt finds nothing to renew on — treating a
      // bare confirm as a renewal would wrongly suppress a genuinely
      // still-relevant callback on nothing more than a routine
      // acknowledgment.
      const confirmedAt = new Date(now + 1000);
      await mockConn('call_commitments').where({ id: commitment.id })
        .update({ human_state: 'confirmed', reviewed_at: confirmedAt, updated_at: confirmedAt });

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('a CONFIRMED quote promise is kept by an estimate delivered after the review — a human verdict blocks refreshFulfillment, so followedUpIds looks the delivery up live (pre-push audit P1)', async () => {
      const earlier = callRow(240);
      const reviewedAt = new Date(now - 3 * 3600000);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote', human_state: 'confirmed', reviewed_at: reviewedAt });
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);
      // The unlinked caller's quote went out by text two hours ago — after
      // both the call and the confirm.
      const deliveredAt = new Date(now - 2 * 3600000).toISOString();
      await mockConn('estimates').insert({
        id: randomUUID(), customer_id: null, customer_phone: PHONE, status: 'sent',
        estimate_data: JSON.stringify({ deliveryState: { firstDeliveredAt: deliveredAt, lastDeliveredAt: deliveredAt } }),
        created_at: new Date(now - 3.5 * 3600000), updated_at: new Date(now - 2 * 3600000),
      });

      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('an EDIT followed by an ordinary CONFIRM keeps its renewal boundary — stale pre-edit evidence is not kept, and the callback still rings (Codex #5019 r16→r17 P1, the finding\'s own scenario)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote' }); // AI, unreviewed
      // Fulfillment-shaped evidence for the ORIGINAL obligation, reached
      // BEFORE the edit below — stale once the promise is genuinely
      // restated, whatever human_state reads by the time anyone checks it.
      const reached = callRow(200, { direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90 });
      await mockConn('call_log').insert([earlier, reached]);
      await mockConn('call_commitments').insert(commitment);

      // Staff EDIT the promise — writes the durable commitment_edit event
      // AND sets human_state 'edited'.
      const editedAt = new Date(now - 150 * 60000);
      await mockConn('call_commitments').where({ id: commitment.id })
        .update({ human_state: 'edited', reviewed_at: editedAt, updated_at: editedAt });
      await mockConn('audit_log').insert({
        id: randomUUID(), actor_type: 'admin', action: 'commitment_edit',
        resource_type: 'call_commitment', resource_id: commitment.id,
        metadata: JSON.stringify({ renewed_at: editedAt.toISOString() }), created_at: editedAt,
      });

      // Staff later just CONFIRM the row (an ordinary "yes, this reads
      // right") — applyHumanUpdate's own CASE resets human_state to
      // 'confirmed' for this kind regardless of the prior edit (exactly the
      // bug Codex flagged: r16's fix read the boundary off human_state, so
      // this ordinary confirm would have erased it), but writes NO new
      // audit event — the commitment_edit event above is untouched.
      const confirmedAt = new Date(now - 100 * 60000);
      await mockConn('call_commitments').where({ id: commitment.id })
        .update({ human_state: 'confirmed', reviewed_at: confirmedAt, updated_at: confirmedAt });

      const back = callRow(0);
      await mockConn('call_log').insert(back);

      // The stale evidence (before the edit) must not count as kept, and
      // the now-'confirmed' human_state must not have erased the edit
      // boundary — the callback still rings.
      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('a send_estimate REOPENED renews it just like an edit — stale pre-reopen evidence is not kept, and the callback still rings (Codex #5019 r17 P1)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote' }); // AI, unreviewed
      // Stale evidence for the pre-reopen obligation.
      const reached = callRow(200, { direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90 });
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, reached, back]);
      await mockConn('call_commitments').insert(commitment);

      // Staff REOPEN the promise — applyHumanUpdate's 'reopen' action
      // writes a durable commitment_reopen event, exactly like an edit,
      // even though a reopen never touches description/due_at.
      const reopenedAt = new Date(now - 100 * 60000);
      await mockConn('call_commitments').where({ id: commitment.id })
        .update({ human_state: 'confirmed', status: 'open', fulfilled_at: null, fulfillment: null, reviewed_at: reopenedAt, updated_at: reopenedAt });
      await mockConn('audit_log').insert({
        id: randomUUID(), actor_type: 'admin', action: 'commitment_reopen',
        resource_type: 'call_commitment', resource_id: commitment.id,
        metadata: JSON.stringify({ renewed_at: reopenedAt.toISOString() }), created_at: reopenedAt,
      });

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('a legacy CONFIRMED send_estimate with no renewal event never rings — a pre-trail reopen is indistinguishable from a bare confirm (Codex #5019 r19 P0)', async () => {
      const earlier = callRow(240);
      const reviewedAt = new Date(now - 100 * 60000);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote', renewal_trail: null, human_state: 'confirmed', reviewed_at: reviewedAt });
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);

      expect(await sweepPromiseChasers()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('a legacy CONFIRMED send_estimate reopened after the trail existed rings on its commitment_reopen boundary (Codex #5019 r19 P0)', async () => {
      const earlier = callRow(240);
      const reopenedAt = new Date(now - 100 * 60000);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote', renewal_trail: null, human_state: 'confirmed', reviewed_at: reopenedAt });
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, back]);
      await mockConn('call_commitments').insert(commitment);
      await mockConn('audit_log').insert({
        id: randomUUID(), actor_type: 'admin', action: 'commitment_reopen',
        resource_type: 'call_commitment', resource_id: commitment.id,
        metadata: JSON.stringify({ renewed_at: reopenedAt.toISOString() }), created_at: reopenedAt,
      });

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('a send_estimate EDITED before commitment_edit events existed keeps reviewed_at as its boundary — stale pre-edit evidence is not kept (Codex #5019 r18 P0)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote', renewal_trail: null });
      const reached = callRow(200, { direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90 });
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, reached, back]);
      await mockConn('call_commitments').insert(commitment);
      // A legacy edit: the row says edited, but no commitment_edit event was
      // ever written (the writer did not exist yet).
      const editedAt = new Date(now - 100 * 60000);
      await mockConn('call_commitments').where({ id: commitment.id })
        .update({ human_state: 'edited', reviewed_at: editedAt, updated_at: editedAt });

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('a send_estimate promise is not read as kept by evidence from BEFORE its own EDIT — followedUpIds must apply the SAME renewal floor to every SLA kind, not just callback (Codex #5019 r12 P1, then r16→r17 P1)', async () => {
      const earlier = callRow(240);
      const commitment = commitmentRow(earlier.id, { kind: 'send_estimate', description: 'Send the quote' }); // AI, unreviewed initially
      // Staff reached the lead by an ordinary outbound call — BEFORE the
      // edit below. Stale evidence for the ORIGINAL wording; not proof the
      // EDITED obligation was ever followed up. Without the r12 fix,
      // followup-sla-watcher's own renewedFloors skipped the renewal check
      // entirely for any kind but callback, so followedUpIds read this
      // stale call as still-valid "kept" evidence and findPromiseToRing
      // excluded the row before it ever reached its own renewal/precedence
      // check — never alerting at all. Uses a genuine EDIT (durable
      // commitment_edit event), not a bare confirm (Codex r16→r17 P1) —
      // human_state alone must never be trusted for this (see the
      // merely-confirmed test above).
      const reached = callRow(200, { direction: 'outbound', from_phone: OUR_NUMBER, to_phone: PHONE, duration_seconds: 90 });
      const back = callRow(0);
      await mockConn('call_log').insert([earlier, reached, back]);
      await mockConn('call_commitments').insert(commitment);

      // Staff EDIT (re-word) the promise AFTER that outbound call.
      const editedAt = new Date(now - 100 * 60000);
      await mockConn('call_commitments').where({ id: commitment.id })
        .update({ human_state: 'edited', reviewed_at: editedAt, updated_at: editedAt });
      await mockConn('audit_log').insert({
        id: randomUUID(), actor_type: 'admin', action: 'commitment_edit',
        resource_type: 'call_commitment', resource_id: commitment.id,
        metadata: JSON.stringify({ renewed_at: editedAt.toISOString() }), created_at: editedAt,
      });

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('a schedule_visit EDITED AFTER a matching-slot booking is not read as kept by that stale booking — the renewal floor must carry into the exact-slot match too, not just `since` (Codex #5019 r13 P1, then r16→r17 P1)', async () => {
      const customerId = randomUUID();
      await mockConn('customers').insert({ id: customerId, phone: PHONE });
      const earlier = callRow(240, { customer_id: customerId });
      // The stated slot: 24h from now — far enough ahead that evidenceFrom
      // (the stated due_at) is later than promisedAt (the call's own end),
      // which is what makes appointmentSlot return non-null at all.
      const slotAt = new Date(now + 24 * 60 * 60000);
      const commitment = commitmentRow(earlier.id, {
        kind: 'schedule_visit', description: 'Come out tomorrow afternoon',
        due_at: slotAt, due_basis: 'stated', due_type: 'floor',
      });
      await mockConn('call_log').insert(earlier);
      await mockConn('call_commitments').insert(commitment);

      // A booking for the EXACT promised slot — made BEFORE the reopen
      // below. Stale evidence for the ORIGINAL obligation.
      const { hour, minute } = etParts(slotAt);
      await mockConn('scheduled_services').insert({
        id: randomUUID(), customer_id: customerId, source_call_log_id: null,
        scheduled_date: etDateString(slotAt), window_start: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        service_type: 'pest_control', status: 'confirmed',
        created_at: new Date(now - 200 * 60000), updated_at: new Date(now - 200 * 60000),
      });

      // Staff EDIT the promise AFTER that booking (a bare confirm/reopen
      // would not count — Codex r16→r17 P1: only a durable commitment_edit
      // / commitment_reopen event renews it, never human_state alone).
      const editedAt = new Date(now - 100 * 60000);
      await mockConn('call_commitments').where({ id: commitment.id })
        .update({ human_state: 'edited', reviewed_at: editedAt, updated_at: editedAt });
      await mockConn('audit_log').insert({
        id: randomUUID(), actor_type: 'admin', action: 'commitment_edit',
        resource_type: 'call_commitment', resource_id: commitment.id,
        metadata: JSON.stringify({ renewed_at: editedAt.toISOString() }), created_at: editedAt,
      });

      const back = callRow(0, { customer_id: customerId });
      await mockConn('call_log').insert(back);

      expect(await sweepPromiseChasers()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
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
