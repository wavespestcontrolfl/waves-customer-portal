/**
 * B01: POST /:token/service-details/send (channel 'sms') — the "text me the
 * packet" button on the estimate page — used to call TwilioService.sendSMS
 * directly, which never reads messaging_suppression or notification_prefs. A
 * number that had texted STOP / been flagged wrong_number / put on the manual
 * DNC list, or a customer with sms_enabled=false, still got the packet text.
 *
 * The send now goes through the REAL sendCustomerMessage policy chain. Only the
 * data layer (models/db) and the provider boundary (services/twilio.sendSMS)
 * are faked: the suppression / consent loaders and validators, the send window,
 * the annual-offer guard and the provider adapter all run for real, so this
 * pins that a suppressed recipient never reaches the provider, and that the
 * normal case still does.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
// Gates are read at call time through isEnabled; the send-window test flips one.
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn((key) => actual.isEnabled(key)) };
});
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
// The audit row is a DB write of its own; record the attempt instead.
jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(async () => ({ id: 'audit-1' })),
  markAuditDelivery: jest.fn(async () => {}),
}));
// Twilio Lookup is dark and network-bound; not what this suite exercises.
jest.mock('../services/messaging/validators/line-type', () => ({
  ...jest.requireActual('../services/messaging/validators/line-type'),
  checkLineType: jest.fn(async () => ({ ok: true })),
}));

const ESTIMATE_ID = 'est-b01-1';
const TOKEN = 'b01-suppression-token-abc123';
const PHONE = '+19415550177';

function baseEstimateRow(overrides = {}) {
  return {
    id: ESTIMATE_ID, token: TOKEN, status: 'sent', archived_at: null, expires_at: null,
    customer_id: 'cust-b01-1', property_id: 'prop-b01-1', estimate_group_id: null,
    customer_name: 'Sam Customer', customer_phone: PHONE, customer_email: 'sam-b01@example.test',
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

// Fixtures the fake db serves to the REAL loaders.
const fixtures = {};
function resetFixtures() {
  fixtures.estimate = baseEstimateRow();
  fixtures.prefs = { customer_id: 'cust-b01-1', sms_enabled: true };
  fixtures.customer = { id: 'cust-b01-1', first_name: 'Sam', last_name: 'Customer', phone: PHONE, email: 'sam-b01@example.test' };
  fixtures.suppression = null;
  // Per-read override: fixtures.suppressionReads[n] is what the n-th
  // messaging_suppression read returns (the last entry repeats); an Error
  // entry makes that read throw. Lets a test commit a suppression row BETWEEN
  // the chain's first read and the locked handoff re-read.
  fixtures.suppressionSequence = null;
  fixtures.suppressionReadCount = 0;
  fixtures.claimAcquired = true;
  fixtures.claimOutcome = null;
  fixtures.claimUpdates = [];
  fixtures.claimDeletes = 0;
  fixtures.tablesTouched = new Set();
}

function chain(resolveFirst, resolveAll = []) {
  const b = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhere', 'orWhereRaw',
    'andWhere', 'select', 'orderBy', 'limit', 'join', 'leftJoin', 'forUpdate']) b[m] = jest.fn(() => b);
  b.first = jest.fn(async () => resolveFirst());
  b.then = (resolve, reject) => Promise.resolve(resolveAll).then(resolve, reject);
  return b;
}

function makeDb() {
  const raw = jest.fn(() => ({ rows: fixtures.claimAcquired ? [{ id: 'claim-1' }] : [] }));
  const db = jest.fn((table) => {
    fixtures.tablesTouched.add(table);
    if (table === 'estimates') return chain(() => ({ ...fixtures.estimate }));
    if (table === 'notification_prefs') return chain(() => (typeof fixtures.prefs === 'function' ? fixtures.prefs() : fixtures.prefs));
    if (table === 'customers') return chain(() => fixtures.customer);
    if (table === 'messaging_suppression') {
      return chain(() => {
        const seq = fixtures.suppressionSequence;
        if (!seq) return fixtures.suppression;
        const entry = seq[Math.min(fixtures.suppressionReadCount, seq.length - 1)];
        fixtures.suppressionReadCount += 1;
        if (entry instanceof Error) throw entry;
        return entry;
      });
    }
    if (table === 'sms_send_claims') {
      const b = chain(() => (fixtures.claimOutcome ? { outcome: fixtures.claimOutcome } : null));
      b.del = jest.fn(async () => { fixtures.claimDeletes += 1; return 0; });
      b.update = jest.fn(async (payload) => { fixtures.claimUpdates.push(payload); return 1; });
      return b;
    }
    // sms_log (dedupe lookups) and anything else: empty.
    return chain(() => undefined);
  });
  db.raw = raw;
  db.fn = { now: () => new Date('2026-01-01T12:00:00.000Z') };
  db.transaction = jest.fn(async (fn) => fn(db));
  return db;
}

const express = require('express');
const { annualPlanOfferFingerprint } = require('../services/estimate-offer-version');

let server;
let base;
let mockDb;

beforeAll((done) => {
  mockDb = makeDb();
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

afterAll((done) => { server.close(done); });

const GATE_KEYS = ['GATE_TERMITE_ANNUAL_PLAN', 'GATE_CANCEL_FLOW_V2', 'GATE_SMS_LINK_WRAP'];
let priorGates;
let phoneCounter = 0;
beforeEach(() => {
  jest.clearAllMocks();
  require('../services/twilio').sendSMS.mockReset();
  resetFixtures();
  // A fresh recipient per test: the route's in-process dedupe window is keyed on
  // estimate+service+phone, and a real (mocked-provider) send starts it.
  phoneCounter += 1;
  fixtures.phone = `+1941555${String(2000 + phoneCounter)}`;
  fixtures.estimate = deliveredRow(fixtures.phone);
  fixtures.customer.phone = fixtures.phone;
  priorGates = GATE_KEYS.map((key) => process.env[key]);
  GATE_KEYS.forEach((key) => delete process.env[key]);
});
afterEach(() => {
  GATE_KEYS.forEach((key, index) => {
    if (priorGates[index] === undefined) delete process.env[key]; else process.env[key] = priorGates[index];
  });
});

function deliveredRow(phone, overrides = {}) {
  const draft = baseEstimateRow({ customer_phone: phone, ...overrides });
  draft.estimate_data.deliveryState = { firstDeliveredAt: '2026-01-01T12:00:00Z', annualPlanOfferFingerprint: annualPlanOfferFingerprint(draft) };
  return draft;
}

const post = () => fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
});

const SID = `SM${'b1'.repeat(16)}`;

// What the real TwilioService.sendSMS does with a caller's withSmsHandoff: run
// it, let it refuse before dispatch (-> preSendBlocked, nothing sent), or let it
// call dispatch(trx) (-> the provider accepts).
function realisticSend(acceptedResult) {
  return async (_to, _body, options) => {
    let accepted = null;
    const dispatch = async () => { accepted = acceptedResult; return acceptedResult; };
    if (typeof options.withSmsHandoff !== 'function') return dispatch();
    let verdict;
    try {
      verdict = await options.withSmsHandoff(dispatch);
    } catch (err) {
      if (accepted) throw err;
      verdict = { ok: false, code: 'SMS_HANDOFF_CHECK_FAILED', reason: 'SMS handoff authority check failed', retryable: true };
    }
    if (!accepted) {
      return { success: false, preSendBlocked: true, code: verdict?.code, error: verdict?.reason,
        retryable: verdict?.retryable === true, validator: verdict?.validator || 'check_sms_handoff_authority', deliveryOutcome: 'not_sent' };
    }
    return accepted;
  };
}
const ACCEPTED = { success: true, sid: SID, deliveryOutcome: 'accepted' };
const UNAVAILABLE = { ok: false, error: 'Text is unavailable for this number — use the PDF button to view the details instead.' };

describe('B01: service-details SMS honors the suppression store and sms_enabled', () => {
  test.each([
    ['opt_out_keyword (texted STOP)', 'opt_out_keyword'],
    ['wrong_number', 'wrong_number'],
    ['manual_dnc', 'manual_dnc'],
    ['non_mobile (landline learned from a carrier failure)', 'non_mobile'],
  ])('an active %s suppression row: no text is sent, one generic 409', async (_label, reason) => {
    const TwilioService = require('../services/twilio');
    fixtures.suppression = { phone: fixtures.phone, reason, active: true, created_at: '2026-01-01T00:00:00Z' };
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(UNAVAILABLE);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(fixtures.tablesTouched.has('messaging_suppression')).toBe(true);
    const { persistAudit } = require('../services/messaging/audit');
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
      blockedBy: expect.objectContaining({ code: expect.stringMatching(/^SUPPRESSED_/) }),
    }));
  });

  test('every suppression reason answers the SAME body — the page cannot tell which rule fired', async () => {
    const bodies = [];
    for (const reason of ['opt_out_keyword', 'wrong_number', 'manual_dnc']) {
      // fresh phone each loop so the in-process claim from a prior iteration cannot interfere
      phoneCounter += 1;
      const phone = `+1941555${String(3000 + phoneCounter)}`;
      fixtures.estimate = deliveredRow(phone);
      fixtures.suppression = { phone, reason, active: true, created_at: '2026-01-01T00:00:00Z' };
      const res = await post();
      expect(res.status).toBe(409);
      bodies.push(await res.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });

  test('a customer with sms_enabled=false is not texted', async () => {
    const TwilioService = require('../services/twilio');
    fixtures.prefs = { customer_id: 'cust-b01-1', sms_enabled: false };
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(UNAVAILABLE);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    const { persistAudit } = require('../services/messaging/audit');
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
      blockedBy: expect.objectContaining({ code: 'SMS_OPTED_OUT' }),
    }));
  });

  test('a lead-only estimate (no customer) whose number is on the wrong-number list is not texted either', async () => {
    const TwilioService = require('../services/twilio');
    fixtures.estimate = deliveredRow(fixtures.phone, { customer_id: null });
    fixtures.prefs = null;
    fixtures.customer = null;
    fixtures.suppression = { phone: fixtures.phone, reason: 'wrong_number', active: true, created_at: '2026-01-01T00:00:00Z' };
    const res = await post();
    expect(res.status).toBe(409);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('normal case: a clean recipient is texted through the chokepoint with the same message type, no signature, and 200', async () => {
    const TwilioService = require('../services/twilio');
    TwilioService.sendSMS.mockImplementationOnce(realisticSend(ACCEPTED));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, channel: 'sms' });
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [to, body, options] = TwilioService.sendSMS.mock.calls[0];
    expect(to).toBe(fixtures.phone);
    expect(body).toMatch(/details packet you requested/);
    // https:// is stripped from SMS links by the chokepoint; the packet URL is intact.
    expect(body).toContain(`portal.wavespestcontrol.com/api/estimates/${TOKEN}/service-details/pest_control/pdf`);
    expect(body).not.toMatch(/^.*https:\/\//);
    // sms_log.message_type stays 'estimate_service_details' (the dedupe query keys on it).
    expect(options.messageType).toBe('estimate_service_details');
    expect(options.customerId).toBe('cust-b01-1');
    // The estimate-scoped annual guard still rides the provider handoff.
    expect(options.estimateId).toBe(ESTIMATE_ID);
  });

  test('normal case for a lead-only estimate (no notification_prefs row) still sends, on the transactional consent basis', async () => {
    const TwilioService = require('../services/twilio');
    TwilioService.sendSMS.mockImplementationOnce(realisticSend(ACCEPTED));
    fixtures.estimate = deliveredRow(fixtures.phone, { customer_id: null });
    fixtures.prefs = null;
    fixtures.customer = null;
    const res = await post();
    expect(res.status).toBe(200);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  });

  test('the customer-tap send is not held by the night send window (customer-action entry point)', async () => {
    const TwilioService = require('../services/twilio');
    const gates = require('../config/feature-gates');
    const actualIsEnabled = jest.requireActual('../config/feature-gates').isEnabled;
    gates.isEnabled.mockImplementation((key) => (key === 'smsSendWindow' ? true : actualIsEnabled(key)));
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setTimeout', 'nextTick', 'queueMicrotask'], now: new Date('2026-01-01T06:00:00Z') }); // 1 AM ET
    try {
      TwilioService.sendSMS.mockImplementationOnce(realisticSend(ACCEPTED));
      const res = await post();
      expect(res.status).toBe(200);
      expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      gates.isEnabled.mockImplementation((key) => actualIsEnabled(key));
    }
  });

  test('a consent lookup failure is transient: retryable 502, never the permanent 409', async () => {
    const TwilioService = require('../services/twilio');
    fixtures.prefs = () => { throw new Error('connection terminated'); };
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'Text could not be sent right now.' });
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    const { persistAudit } = require('../services/messaging/audit');
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({
      blockedBy: expect.objectContaining({ code: 'CONSENT_LOOKUP_FAILED' }),
    }));
  });

  test('a provider failure after the policy chain passes stays the retryable 502, not the 409', async () => {
    const TwilioService = require('../services/twilio');
    TwilioService.sendSMS.mockResolvedValueOnce({ success: false, sid: null, error: 'twilio rejected' });
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'Text could not be sent right now.' });
  });

  describe('Codex round 1 on #5384 (P0s)', () => {
    const lockCalls = () => mockDb.raw.mock.calls.filter((c) => /twilio_21610/.test(c[0]));

    test('P0-2: the send takes the phone lock (lockSmsPhone) and re-reads suppression under it, before the provider', async () => {
      const TwilioService = require('../services/twilio');
      TwilioService.sendSMS.mockImplementationOnce(realisticSend(ACCEPTED));
      const res = await post();
      expect(res.status).toBe(200);
      expect(TwilioService.sendSMS.mock.calls[0][2].withSmsHandoff).toEqual(expect.any(Function));
      expect(lockCalls().length).toBeGreaterThanOrEqual(1);
      expect(lockCalls()[0][1]).toEqual([fixtures.phone]);
    });

    test('P0-2: an opt-out committed AFTER the chain\'s first suppression read but BEFORE the handoff is caught under the lock — nothing is sent', async () => {
      const TwilioService = require('../services/twilio');
      const row = { phone: fixtures.phone, reason: 'opt_out_keyword', active: true, created_at: '2026-01-01T00:00:00Z' };
      fixtures.suppressionSequence = [null, row]; // clean at the first read, suppressed by the locked re-read
      let providerDispatched = false;
      TwilioService.sendSMS.mockImplementationOnce(realisticSend({ ...ACCEPTED, get sid() { providerDispatched = true; return SID; } }));
      const res = await post();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(UNAVAILABLE);
      expect(fixtures.suppressionReadCount).toBeGreaterThanOrEqual(2);
      // sendSMS was entered (the chain passed) but the handoff refused before dispatch.
      expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
      expect(providerDispatched).toBe(false);
    });

    test.each([
      ['a customer with a prefs row', {}],
      ['a lead-only estimate (explicit transactional consent basis)', { lead: true }],
    ])('P0-3: %s — suppression cannot be read: retryable 502 and NO send (fails closed, never open)', async (_label, opts) => {
      const TwilioService = require('../services/twilio');
      if (opts.lead) {
        fixtures.estimate = deliveredRow(fixtures.phone, { customer_id: null });
        fixtures.prefs = null;
        fixtures.customer = null;
      }
      // An active wrong_number row may exist, but every read of the table errors.
      fixtures.suppressionSequence = [new Error('messaging_suppression unavailable (simulated)')];
      let providerDispatched = false;
      TwilioService.sendSMS.mockImplementation(realisticSend({ ...ACCEPTED, get sid() { providerDispatched = true; return SID; } }));
      const res = await post();
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'Text could not be sent right now.' });
      expect(providerDispatched).toBe(false);
    });

    test('P0-3: only the FIRST read fails (chain fails open) but the locked re-read finds an active wrong_number — still no send', async () => {
      const TwilioService = require('../services/twilio');
      const row = { phone: fixtures.phone, reason: 'wrong_number', active: true, created_at: '2026-01-01T00:00:00Z' };
      fixtures.suppressionSequence = [new Error('blip (simulated)'), row];
      let providerDispatched = false;
      TwilioService.sendSMS.mockImplementationOnce(realisticSend({ ...ACCEPTED, get sid() { providerDispatched = true; return SID; } }));
      const res = await post();
      expect(res.status).toBe(409);
      expect(providerDispatched).toBe(false);
    });

    test('P0-1: the winner stamps outcome=policy_blocked and KEEPS the claim row (no delete) when the policy chain refuses', async () => {
      fixtures.suppression = { phone: fixtures.phone, reason: 'wrong_number', active: true, created_at: '2026-01-01T00:00:00Z' };
      const res = await post();
      expect(res.status).toBe(409);
      expect(fixtures.claimUpdates).toContainEqual({ outcome: 'policy_blocked' });
      expect(fixtures.claimDeletes).toBe(0);
    });

    test('P0-1: a cross-process LOSER polling a claim the winner stamped policy_blocked answers the SAME 409 (not a 502 after ~4.5 s), and never calls the provider', async () => {
      const TwilioService = require('../services/twilio');
      fixtures.claimAcquired = false; // another replica holds the claim
      fixtures.claimOutcome = 'policy_blocked';
      const started = Date.now();
      const res = await post();
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(UNAVAILABLE);
      expect(Date.now() - started).toBeLessThan(4000); // first poll, not the full 3-attempt timeout
      expect(TwilioService.sendSMS).not.toHaveBeenCalled();
      // The loser must not delete the winner's claim row.
      expect(fixtures.claimDeletes).toBe(0);
    });

    test('P0-1: a stale policy_blocked marker cannot pin 409 forever — the claim-acquire takeover reclaims it on the short window, and a retap after the number is cleared sends', async () => {
      const TwilioService = require('../services/twilio');
      fixtures.suppression = { phone: fixtures.phone, reason: 'manual_dnc', active: true, created_at: '2026-01-01T00:00:00Z' };
      expect((await post()).status).toBe(409);
      // Operator clears the DNC entry; the retap re-runs the whole chain.
      fixtures.suppression = null;
      TwilioService.sendSMS.mockImplementationOnce(realisticSend(ACCEPTED));
      const retap = await post();
      expect(retap.status).toBe(200);
      const sql = mockDb.raw.mock.calls.map((c) => c[0]).find((q) => /INSERT INTO sms_send_claims/.test(q));
      expect(sql).toMatch(/outcome IN \('withheld', 'policy_blocked'\)\s+AND sms_send_claims\.created_at < NOW\(\) - interval '6 seconds'/);
    });
  });
});
