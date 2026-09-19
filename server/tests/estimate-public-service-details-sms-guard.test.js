/**
 * estimate-public.js's service-details SMS send (~POST /:token/service-details
 * /send, channel 'sms') deliberately bypasses sendCustomerMessage and calls
 * TwilioService.sendSMS directly — so it composes the annual-offer guard
 * into its own preSendCheck (Codex round 1 on #4608, P1) instead of getting
 * it for free at the send-customer-message.js chokepoint. This pins that
 * composition: checkSendWindow runs first (unchanged priority/shape), then
 * annualHandoffGuard on the estimate itself; a blocked verdict returns the
 * same not-ok shape checkSendWindow does, so TwilioService.sendSMS withholds
 * the send exactly like a window hold (no Twilio call), and the route reports
 * the generic "could not send" failure. estimate-annual-guard.js and
 * services/messaging/validators/send-window run FOR REAL here — only db and
 * services/twilio (the actual SDK boundary) are mocked, so the guard's own
 * DB lookup exercises the real loadAnnualOfferRow/annualPlanPublicReplayBlocked
 * chain, not a stand-in.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The concurrent-dedup tests (Codex round 2 on #4608, P0) fire several
// requests against the same ephemeral server across this file's tests —
// bypass the route's real 6/hour serviceDetailsSendLimiter so test volume
// never collides with production rate-limiting, which is not what these
// tests exercise.
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));

const ESTIMATE_ID = 'est-service-details-1';
const TOKEN = 'sd-guard-token-abc123';

function baseEstimateRow(overrides = {}) {
  return {
    id: ESTIMATE_ID, token: TOKEN, status: 'sent', archived_at: null, expires_at: null,
    customer_id: 'cust-sd-1', property_id: 'prop-sd-1', estimate_group_id: null,
    customer_name: 'Sam Customer', customer_phone: '+19415550188', customer_email: 'sam-sd@example.test',
    address: '123 Test Ave, Bradenton, FL',
    notes: null, monthly_total: 0, annual_total: 299, onetime_total: 450,
    show_one_time_option: false, bill_by_invoice: false, waveguard_tier: null,
    service_interest: null, category: null, source: null,
    estimate_data: {
      result: {
        recurring: { services: [{ service: 'pest_control', mo: 60 }] },
        lineItems: [{ service: 'termite_bait', plan: 'annual_protection', stations: 15 }],
      },
    },
    ...overrides,
  };
}

function makeDb(getRow) {
  // Codex round 3 on #4608 (P0 PRRT_kwDOR3YQi86j8Ydq): two test-settable
  // knobs simulate "another process holds this claim" —
  // db.__claimAcquired = false makes the INSERT...ON CONFLICT claim-acquire
  // read as already-held (empty rows), and db.__claimOutcome simulates that
  // other process's durable stamp on the SAME claim row, which the loser's
  // poll (services/estimate-public.js) now reads via sms_send_claims.first().
  // Both default to the prior behavior (always acquired, no stamped outcome)
  // so every existing test is unaffected.
  const raw = jest.fn(() => ({ rows: db.__claimAcquired === false ? [] : [{ id: 'claim-1' }] }));
  const db = jest.fn((table) => {
    if (table === 'estimates') {
      const builder = {};
      builder.where = jest.fn(() => builder);
      builder.forUpdate = jest.fn(() => builder);
      // P1 (round 7): test-settable knob simulating the annual guard's own
      // DB read failing — loadAnnualOfferRow (estimate-annual-guard.js)
      // is the ONLY .first() caller on this table that passes explicit
      // column names, so throwing only when called WITH args targets just
      // the guard's read, leaving the route's own plain .first() estimate
      // loads (token lookup, stillOnCustomerSurface) unaffected. Defaults
      // to false so every existing test is unaffected.
      builder.first = jest.fn(async (...cols) => {
        if (db.__annualLookupThrows && cols.length > 0) {
          throw new Error('estimates lookup unavailable (simulated)');
        }
        return { ...getRow() };
      });
      return builder;
    }
    if (table === 'sms_log') {
      const builder = {};
      builder.where = jest.fn(() => builder);
      builder.whereRaw = jest.fn(() => builder);
      // P0 (round 5): test-settable knob simulating "a packet was already
      // sent" (recentPacketSend finding a durable sms_log row) — defaults
      // to false (no prior send found) so every existing test is unaffected.
      builder.first = jest.fn(async () => (db.__recentPacketFound ? { id: 'log-1' } : null));
      return builder;
    }
    if (table === 'sms_send_claims') {
      const builder = {};
      builder.where = jest.fn(() => builder);
      builder.del = jest.fn(async () => 0);
      builder.update = jest.fn(async (payload) => {
        if (payload && payload.outcome) db.__claimOutcome = payload.outcome;
        return 1;
      });
      builder.first = jest.fn(async () => (db.__claimOutcome ? { outcome: db.__claimOutcome } : null));
      return builder;
    }
    throw new Error(`estimate-public-service-details-sms-guard test: unexpected table ${table}`);
  });
  db.raw = raw;
  db.fn = { now: () => new Date('2026-01-01T12:00:00.000Z') };
  db.__claimAcquired = true;
  db.__claimOutcome = null;
  db.__recentPacketFound = false;
  db.__annualLookupThrows = false;
  return db;
}

const express = require('express');
const { annualPlanOfferFingerprint } = require('../services/estimate-offer-version');

// No supertest in this repo — run the real router on an ephemeral port and
// hit it with the built-in fetch (same pattern as
// estimate-public-accept-atomicity.test.js).
let server;
let base;
let currentRow;
let mockDb;

beforeAll((done) => {
  mockDb = makeDb(() => currentRow);
  jest.doMock('../models/db', () => mockDb);
  const app = express();
  app.use(express.json());
  app.use('/api/estimates', require('../routes/estimate-public'));
  app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({ error: err.message });
  });
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

const GATE_KEYS = ['GATE_TERMITE_ANNUAL_PLAN', 'GATE_CANCEL_FLOW_V2'];
let priorGates;
beforeEach(() => {
  jest.clearAllMocks();
  // Round 9 structural fix: the early verdict gate (before ANY claim/dedup
  // machinery) means a withheld-row test's queued mockImplementationOnce/
  // mockResolvedValueOnce on these two provider mocks is now frequently
  // NEVER CONSUMED (the request is blocked before the mock is ever
  // called) — jest.clearAllMocks() clears call counts but NOT a leftover
  // queued "once" implementation, so it would otherwise leak into a LATER
  // test's own queue and be consumed out of order. mockReset() (safe here:
  // both are bare jest.fn() with no default implementation to lose) clears
  // that queue too.
  require('../services/twilio').sendSMS.mockReset();
  require('../services/email-template-library').sendTemplate.mockReset();
  mockDb.__claimAcquired = true;
  mockDb.__claimOutcome = null;
  mockDb.__recentPacketFound = false;
  mockDb.__annualLookupThrows = false;
  priorGates = GATE_KEYS.map((key) => process.env[key]);
  GATE_KEYS.forEach((key) => delete process.env[key]);
});
afterEach(() => {
  GATE_KEYS.forEach((key, index) => {
    if (priorGates[index] === undefined) delete process.env[key]; else process.env[key] = priorGates[index];
  });
});

describe('service-details SMS: annual-offer guard composed into preSendCheck (Codex round 1 on #4608, P1)', () => {
  test('a withheld annual estimate never reaches Twilio — blocked at the early verdict gate (round 9) with the SAME generic 404 as any other row-level withhold, and never touches the claim machinery at all', async () => {
    // Pre-push audit P0 (AGENTS.md public-route rule): ineligible rows must
    // be indistinguishable from unknown tokens — the withheld outcome is a
    // row-level fact (like the customer-viewable/call-side-hold check this
    // route already applies as its LAST step), so it gets the same generic
    // 404 docs/public-route-contracts.md documents for that check, never a
    // distinct status that would confirm a live-but-ineligible row.
    //
    // Round 9 structural fix: the verdict is now checked ONCE, immediately
    // after the existing eligibility gates and BEFORE any claim/dedup
    // machinery on either channel — so a withheld estimate never reaches
    // TwilioService.sendSMS (or the composed preSendCheck inside it) at
    // all, and no claim is ever acquired to release.
    const TwilioService = require('../services/twilio');
    currentRow = baseEstimateRow({ customer_phone: '+19415550101' });

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'Estimate not found' });

    // A retry for the SAME still-withheld estimate is blocked the identical
    // way — there was never a claim to leak or get stuck behind.
    const retryRes = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const retryBody = await retryRes.json();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(retryRes.status).toBe(404);
    expect(retryBody).toEqual({ error: 'Estimate not found' });
  });

  test('EMAIL channel: a withheld annual estimate gets the SAME generic 404 — never the address-suppression 409', async () => {
    // The 409 branch is address-level (a suppressed/bounced recipient) and
    // safe to reveal; an annual-offer withhold is row-level and must not be
    // distinguishable from an unknown token, exactly like the SMS case.
    // Round 9 structural fix: blocked at the early verdict gate now, so
    // sendTemplate is never even called for a withheld row.
    const EmailTemplateLibrary = require('../services/email-template-library');
    currentRow = baseEstimateRow();

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'email' }),
    });
    const body = await res.json();

    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'Estimate not found' });
  });

  test('EMAIL channel: an address-suppression block still returns 409 (unchanged) — only annual_offer_withheld maps to 404', async () => {
    // ELIGIBLE row: the early verdict gate must pass here so this test
    // actually reaches sendTemplate's OWN (unrelated) suppression mapping.
    const EmailTemplateLibrary = require('../services/email-template-library');
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({
      sent: false, blocked: true, reason: 'suppressed', providerAttempted: false,
    });
    const draft = baseEstimateRow();
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'email' }),
    });
    const body = await res.json();

    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
    expect(body).toEqual({ ok: false, error: 'Email is unavailable for this address — text yourself the link instead.' });
  });

  test('a delivered (not withheld) annual estimate sends normally', async () => {
    const TwilioService = require('../services/twilio');
    let capturedVerdict;
    TwilioService.sendSMS.mockImplementationOnce(async (_to, _body, options) => {
      capturedVerdict = await options.preSendCheck();
      if (!capturedVerdict.ok) return { success: false, sid: null, preSendBlocked: true, code: capturedVerdict.code, error: capturedVerdict.reason };
      return { success: true, sid: 'SM_fake' };
    });

    // Deliver it first so annualPlanPublicReplayBlocked reads the fingerprint
    // as matching (same estimate shape, with a stamped deliveryState).
    const draft = baseEstimateRow({ customer_phone: '+19415550202' });
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();

    expect(capturedVerdict).toEqual({ ok: true });
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, channel: 'sms' });
  });

  test('P0 (Codex round 2 on #4608): two OVERLAPPING SMS requests for a withheld annual estimate both get the generic 404 — blocked at the early verdict gate for EACH, no provider call for either', async () => {
    // Round 9 structural fix: both concurrent requests now resolve their
    // OWN early verdict independently (before either ever reaches the
    // claim/dedup machinery this describe block's OTHER concurrency test
    // still exercises for the eligible/success case below) — neither
    // depends on sharing the other's in-flight outcome to answer 404.
    const TwilioService = require('../services/twilio');
    currentRow = baseEstimateRow({ customer_phone: '+19415550303' });
    const send = () => fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });

    const [res1, res2] = await Promise.all([send(), send()]);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res1.status).toBe(404);
    expect(body1).toEqual({ error: 'Estimate not found' });
    expect(res2.status).toBe(404);
    expect(body2).toEqual({ error: 'Estimate not found' });
  });

  test('P0 (round 9): a loser whose winner is STILL IN FLIGHT (no recorded outcome, no sms_log row yet — the poll would time out) answers 404 immediately, without ever polling, for a withheld estimate', async () => {
    // This is the exact gap no per-site patch could close (round 9 audit,
    // "server/routes/estimate-public.js:25207"): the claim is held by
    // another process (claimAcquired = false), that process has NOT YET
    // recorded an outcome (still working — __claimOutcome stays null) and
    // has NOT YET written a durable sms_log row (__recentPacketFound stays
    // false) — before this fix, the loser's poll loop (3 attempts * 1.5s)
    // would find neither and fall through to the generic claimHeldElsewhere
    // 502 after ~4.5s, a DIFFERENT status than a fresh request for the SAME
    // withheld estimate. The early verdict gate now answers before the
    // claim machinery is ever consulted at all — fast, and without needing
    // the winner to have settled anything yet.
    mockDb.__claimAcquired = false;
    mockDb.__claimOutcome = null;
    mockDb.__recentPacketFound = false;
    currentRow = baseEstimateRow({ customer_phone: '+19415550707' });
    const TwilioService = require('../services/twilio');

    const startedAt = Date.now();
    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();
    const elapsedMs = Date.now() - startedAt;

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'Estimate not found' });
    // The old poll loop alone takes >=4500ms (3 * 1500ms) before falling
    // through to 502 — answering well under that proves this never
    // touched the poll at all, rather than merely also ending in 404.
    expect(elapsedMs).toBeLessThan(1000);
  });

  test('the existing dedup-SUCCESS case is unchanged: the loser of an overlapping successful send reports deduped:true, not 404', async () => {
    const TwilioService = require('../services/twilio');
    TwilioService.sendSMS.mockImplementation(async (_to, _body, options) => {
      const verdict = await options.preSendCheck();
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      if (!verdict.ok) return { success: false, sid: null, preSendBlocked: true, code: verdict.code, error: verdict.reason };
      return { success: true, sid: 'SM_fake' };
    });

    const draft = baseEstimateRow({ customer_phone: '+19415550404' });
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;

    const send = () => fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });

    const [res1, res2] = await Promise.all([send(), send()]);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);
    const bodies = [body1, body2];

    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // One of the two is the real send, the other the deduped echo of it —
    // order between two concurrent requests isn't guaranteed, so assert the
    // SET of outcomes rather than which slot got which.
    expect(bodies).toEqual(expect.arrayContaining([{ ok: true, channel: 'sms' }]));
    expect(bodies).toEqual(expect.arrayContaining([{ ok: true, channel: 'sms', deduped: true }]));
  });

  test('P0 (Codex round 3 on #4608, PRRT_kwDOR3YQi86j8Ydq): a claim held elsewhere whose recorded outcome is withheld returns the SAME generic 404 as the winner, never a distinguishable 502', async () => {
    // Simulates the CROSS-PROCESS race: another process/replica already won
    // the sms_send_claims claim_key (the INSERT...ON CONFLICT reads as
    // already-held) and had already stamped its durable refusal on that
    // row before this request's claim-acquire attempt even ran — exactly
    // what services/twilio.js's own preSendCheck composition never gets a
    // chance to run for THIS request, since it never reaches sendSMS at
    // all. Before the fix, the poll loop only ever checked sms_log (a
    // withheld winner writes no log row) and fell through to the generic
    // claimHeldElsewhere 502 — a DIFFERENT status than the winner's own 404
    // for the exact same row, an existence-oracle leak.
    mockDb.__claimAcquired = false;
    mockDb.__claimOutcome = 'withheld';
    currentRow = baseEstimateRow({ customer_phone: '+19415550505' });

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();

    const TwilioService = require('../services/twilio');
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'Estimate not found' });
  }, 10000);

  test('a claim held elsewhere with NO recorded outcome, for an ELIGIBLE estimate (still working, or a genuinely stuck winner) keeps the existing retryable 502 — not silently reclassified', async () => {
    // ELIGIBLE row: the early verdict gate must pass here so this test
    // actually reaches the claim-poll machinery being exercised — a
    // withheld row would answer 404 at the gate regardless of claim state
    // (see the round 9 test above), which is a DIFFERENT guarantee.
    mockDb.__claimAcquired = false;
    mockDb.__claimOutcome = null;
    const draft = baseEstimateRow({ customer_phone: '+19415550606' });
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();

    const TwilioService = require('../services/twilio');
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res.status).toBe(502);
    expect(body).toEqual({ ok: false, error: 'Text could not be sent right now.' });
  }, 10000);

  test('P1 (round 4): the claim-acquire SQL carries a short reclaim window for a withheld outcome, distinct from the crash-recovery staleness window', async () => {
    // ELIGIBLE row: round 9's early verdict gate runs BEFORE any claim
    // acquisition, so a withheld row would never reach this SQL at all —
    // this test's job is to pin the SQL SHAPE the (still-live) claim-acquire
    // step uses, which applies to every eligible request regardless of
    // whether some earlier, unrelated request left a stale withheld stamp
    // on the row it is about to reclaim.
    const draft = baseEstimateRow({ customer_phone: '+19415550808' });
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;
    const TwilioService = require('../services/twilio');
    TwilioService.sendSMS.mockImplementationOnce(async (_to, _body, options) => {
      const verdict = await options.preSendCheck();
      if (!verdict.ok) return { success: false, sid: null, preSendBlocked: true, code: verdict.code, error: verdict.reason };
      return { success: true, sid: 'SM_fake' };
    });

    await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });

    // Round 9: this is no longer necessarily the LAST db.raw call (a
    // later cross-restart dedup lookup also uses db.raw) — find the
    // claim-acquire call specifically.
    const sql = mockDb.raw.mock.calls.map((call) => call[0]).find((s) => /INSERT INTO sms_send_claims/.test(s));
    expect(sql).toMatch(/INSERT INTO sms_send_claims/);
    // The general crash-recovery window stays 10 minutes...
    expect(sql).toMatch(/created_at < NOW\(\) - interval '10 minutes'/);
    // ...but a claim whose outcome is 'withheld' takes over on a much
    // shorter window — otherwise it would only ever be reclaimable after
    // the full 10 minutes, and a legitimate retap moments later (once a
    // fresh delivery makes the offer eligible again) could never send.
    expect(sql).toMatch(/outcome = 'withheld'/);
    expect(sql).toMatch(/created_at < NOW\(\) - interval '\d+ seconds'/);
  });

  test('P1 (round 4): a claim row a PRIOR run already stamped withheld does not permanently block a later, non-concurrent, ELIGIBLE retap once the claim-acquire SQL reclaims it', async () => {
    // Round 9 structural fix: a request that is ITSELF withheld from the
    // start never reaches claim acquisition any more (see the round 9 test
    // above and round 7's final-site-withhold test for that path). What
    // this test still needs to prove is the OTHER half of the mechanism:
    // a claim row some earlier, unrelated run already stamped
    // outcome='withheld' (e.g. via the final-site recheck) is not a
    // permanent tombstone — the claim-acquire SQL's short reclaim window
    // (pinned above) lets a later, genuinely eligible request take the row
    // back over and send normally, rather than reading the stale marker as
    // still governing a fresh request.
    mockDb.__claimOutcome = 'withheld';
    const draft = baseEstimateRow({ customer_phone: '+19415550909' });
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;
    const TwilioService = require('../services/twilio');
    let capturedVerdict;
    TwilioService.sendSMS.mockImplementationOnce(async (_to, _body, options) => {
      capturedVerdict = await options.preSendCheck();
      if (!capturedVerdict.ok) return { success: false, sid: null, preSendBlocked: true, code: capturedVerdict.code, error: capturedVerdict.reason };
      return { success: true, sid: 'SM_fake_2' };
    });
    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();

    expect(capturedVerdict).toEqual({ ok: true });
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, channel: 'sms' });
  });

  test('P0 (round 5): a since-WITHHELD estimate with a prior packet send answers 404, not a stale dedup 200 (in-process dedup)', async () => {
    // First request: eligible/delivered — sends and starts the in-process
    // dedup window (serviceDetailsSmsClaims.set(dedupKey, { sentAt })).
    const draft = baseEstimateRow({ customer_phone: '+19415551010' });
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;
    const TwilioService = require('../services/twilio');
    TwilioService.sendSMS.mockImplementationOnce(async (_to, _body, options) => {
      const verdict = await options.preSendCheck();
      if (!verdict.ok) return { success: false, sid: null, preSendBlocked: true, code: verdict.code, error: verdict.reason };
      return { success: true, sid: 'SM_fake' };
    });
    const res1 = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    expect(res1.status).toBe(200);

    // The SAME estimate/service/phone becomes withheld before the dedup
    // window (10 minutes) closes — a second request must NOT answer the
    // stale 200 the in-process sentAt dedup would otherwise give it before
    // the fix; it must recheck the verdict fresh and answer the SAME
    // generic 404 a first-time request would.
    currentRow = baseEstimateRow({ customer_phone: '+19415551010' });
    TwilioService.sendSMS.mockClear();
    const res2 = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body2 = await res2.json();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res2.status).toBe(404);
    expect(body2).toEqual({ error: 'Estimate not found' });
  });

  test('P0 (round 5): a since-WITHHELD estimate answers 404 on the SMS cross-restart recentPacketSend dedup path too', async () => {
    // Round 9: blocked at the early verdict gate now, before any claim is
    // ever acquired — so there is no claim row left behind to stamp.
    currentRow = baseEstimateRow({ customer_phone: '+19415551111' });
    mockDb.__recentPacketFound = true;
    const TwilioService = require('../services/twilio');

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'Estimate not found' });
    expect(mockDb.__claimOutcome).toBeNull();
  });

  test('P0 (round 5): an ELIGIBLE estimate still gets the cross-restart recentPacketSend dedup success unchanged', async () => {
    const draft = baseEstimateRow({ customer_phone: '+19415551212' });
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;
    mockDb.__recentPacketFound = true;
    const TwilioService = require('../services/twilio');

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, channel: 'sms', deduped: true });
  });

  test('P0 (round 5): a same-day EMAIL idempotency dedup for a since-WITHHELD estimate answers 404, not a stale 200', async () => {
    // Round 9: blocked at the early verdict gate now, before sendTemplate's
    // own idempotency dedup lookup ever runs — the queued mockResolvedValueOnce
    // below is never consumed (confirmed unreachable via .not.toHaveBeenCalled()).
    const EmailTemplateLibrary = require('../services/email-template-library');
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({
      sent: true, deduped: true, message: { id: 'msg-historical' },
    });
    currentRow = baseEstimateRow();

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'email' }),
    });
    const body = await res.json();

    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'Estimate not found' });
  });

  test('P0 (round 5): a same-day EMAIL idempotency dedup for an ELIGIBLE estimate still succeeds unchanged', async () => {
    const EmailTemplateLibrary = require('../services/email-template-library');
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({
      sent: true, deduped: true, message: { id: 'msg-historical-2' },
    });
    const draft = baseEstimateRow();
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'email' }),
    });
    const body = await res.json();

    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, channel: 'email' });
  });

  test('P0 (round 6, structural fix): the cross-process LOSER finding the winner\'s durable sms_log row for a since-WITHHELD estimate answers 404, not the stale deduped 200', async () => {
    // Another process holds the claim (claimAcquired = false), so this
    // request takes the polling loop below — and finds DURABLE proof (a
    // real sms_log row) that the winner already sent the packet. Before
    // this fix that alone was enough to answer deduped:true/200; the
    // send may have happened before a later withhold, so it must recheck
    // the verdict exactly like every other dedup site on this route.
    mockDb.__claimAcquired = false;
    mockDb.__recentPacketFound = true;
    currentRow = baseEstimateRow({ customer_phone: '+19415551313' });
    const TwilioService = require('../services/twilio');

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'Estimate not found' });
    // Round 9: blocked at the early verdict gate now, before this request
    // ever reaches the claim-acquire/poll machinery below — so there is no
    // claim row for THIS request to stamp (mockDb.__claimAcquired = false
    // here simulates another process already holding it, but that other
    // process's own claim-outcome bookkeeping is untouched by this request).
    expect(mockDb.__claimOutcome).toBeNull();
  }, 10000);

  test('P0 (round 6, structural fix): the cross-process LOSER finding the winner\'s durable sms_log row for an ELIGIBLE estimate still gets the dedup success unchanged', async () => {
    mockDb.__claimAcquired = false;
    mockDb.__recentPacketFound = true;
    const draft = baseEstimateRow({ customer_phone: '+19415551414' });
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;
    const TwilioService = require('../services/twilio');

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body = await res.json();

    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, channel: 'sms', deduped: true });
  }, 10000);

  test('P1 (round 7): a guard lookup failure at a top-level response site reaches the handler\'s normal error path, never a hang', async () => {
    // Codex round 7 P1: `return withheldOr(...)` without awaiting meant a
    // rejected guard lookup could not be caught by the route's own
    // try/catch — Express 4 does not forward a rejected async-handler
    // promise, so the request would simply hang with no response at all.
    // `await` at every call site (this is the email dedup/success site)
    // makes the rejection surface inside the try, reaching next(err) and
    // the app's normal error-handling middleware.
    // Round 9: the guard lookup this simulates now runs at the EARLY
    // verdict gate itself (before sendTemplate is ever reached), so the
    // queued mockResolvedValueOnce below is never consumed — but the same
    // guarantee this test exists for still holds: an await'd rejection at
    // that gate reaches the route's own try/catch, not a hang.
    mockDb.__annualLookupThrows = true;
    currentRow = baseEstimateRow({ customer_phone: '+19415551616' });
    const EmailTemplateLibrary = require('../services/email-template-library');
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: true, message: { id: 'msg-lookup-fail' } });

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'email' }),
    });
    const body = await res.json();

    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    // The test app's error middleware: res.status(err.status || 500).json({ error: err.message }).
    expect(res.status).toBe(500);
    expect(body.error).toMatch(/estimates lookup unavailable/);
  });

  test('P1 (round 7): a final-site withhold (the offer changes between dispatch and the final recheck) clears the claim so a later retap can proceed', async () => {
    const draft = baseEstimateRow({ customer_phone: '+19415551717' });
    const fingerprint = annualPlanOfferFingerprint(draft);
    draft.status = 'sent';
    draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint };
    currentRow = draft;
    const TwilioService = require('../services/twilio');
    TwilioService.sendSMS.mockImplementationOnce(async (_to, _body, options) => {
      const verdict = await options.preSendCheck();
      if (!verdict.ok) return { success: false, sid: null, preSendBlocked: true, code: verdict.code, error: verdict.reason };
      // The offer withdraws AFTER dispatch decided to send (preSendCheck
      // passed) but BEFORE the route's own final response-site recheck.
      currentRow = baseEstimateRow({ customer_phone: '+19415551717' });
      return { success: true, sid: 'SM_fake' };
    });

    const res1 = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body1 = await res1.json();

    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    expect(res1.status).toBe(404);
    expect(body1).toEqual({ error: 'Estimate not found' });
    // Round 7 P1: the claim's durable outcome is stamped (a concurrent
    // poller would read the SAME refusal) exactly like every other
    // withheld branch on this route.
    expect(mockDb.__claimOutcome).toBe('withheld');

    // A later retap for the SAME estimate/service/phone, now genuinely
    // eligible again, must not be stuck behind a claim this response
    // declined to report success for — the in-process Map entry must have
    // been cleared, not left marking a pending/successful send.
    const redraft = baseEstimateRow({ customer_phone: '+19415551717' });
    const fingerprint2 = annualPlanOfferFingerprint(redraft);
    redraft.status = 'sent';
    redraft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: fingerprint2 };
    currentRow = redraft;
    TwilioService.sendSMS.mockImplementationOnce(async (_to, _body, options) => {
      const verdict = await options.preSendCheck();
      if (!verdict.ok) return { success: false, sid: null, preSendBlocked: true, code: verdict.code, error: verdict.reason };
      return { success: true, sid: 'SM_fake_2' };
    });
    const res2 = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    const body2 = await res2.json();

    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(2);
    expect(res2.status).toBe(200);
    expect(body2).toEqual({ ok: true, channel: 'sms' });
  });
});
