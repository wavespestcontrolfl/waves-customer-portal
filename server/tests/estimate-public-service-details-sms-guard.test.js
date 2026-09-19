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
  const raw = jest.fn(() => ({ rows: [{ id: 'claim-1' }] }));
  const db = jest.fn((table) => {
    if (table === 'estimates') {
      const builder = {};
      builder.where = jest.fn(() => builder);
      builder.forUpdate = jest.fn(() => builder);
      builder.first = jest.fn(async () => ({ ...getRow() }));
      return builder;
    }
    if (table === 'sms_log') {
      const builder = {};
      builder.where = jest.fn(() => builder);
      builder.whereRaw = jest.fn(() => builder);
      builder.first = jest.fn(async () => null);
      return builder;
    }
    if (table === 'sms_send_claims') {
      const builder = {};
      builder.where = jest.fn(() => builder);
      builder.del = jest.fn(async () => 0);
      return builder;
    }
    throw new Error(`estimate-public-service-details-sms-guard test: unexpected table ${table}`);
  });
  db.raw = raw;
  db.fn = { now: () => new Date('2026-01-01T12:00:00.000Z') };
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

beforeAll((done) => {
  jest.doMock('../models/db', () => makeDb(() => currentRow));
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
  priorGates = GATE_KEYS.map((key) => process.env[key]);
  GATE_KEYS.forEach((key) => delete process.env[key]);
});
afterEach(() => {
  GATE_KEYS.forEach((key, index) => {
    if (priorGates[index] === undefined) delete process.env[key]; else process.env[key] = priorGates[index];
  });
});

function sendServiceDetails(phoneSuffix) {
  currentRow = baseEstimateRow({ customer_phone: `+1941555${phoneSuffix}` });
  return fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
  });
}

describe('service-details SMS: annual-offer guard composed into preSendCheck (Codex round 1 on #4608, P1)', () => {
  test('a withheld annual estimate never reaches Twilio — the composed preSendCheck blocks it with the SAME generic 404 as any other row-level withhold, and releases the dedup claim', async () => {
    // Pre-push audit P0 (AGENTS.md public-route rule): ineligible rows must
    // be indistinguishable from unknown tokens — the withheld outcome is a
    // row-level fact (like the customer-viewable/call-side-hold check this
    // route already applies as its LAST step), so it gets the same generic
    // 404 docs/public-route-contracts.md documents for that check, never a
    // distinct status that would confirm a live-but-ineligible row.
    const TwilioService = require('../services/twilio');
    let capturedVerdict;
    TwilioService.sendSMS.mockImplementation(async (_to, _body, options) => {
      capturedVerdict = await options.preSendCheck();
      if (!capturedVerdict.ok) return { success: false, sid: null, preSendBlocked: true, code: capturedVerdict.code, error: capturedVerdict.reason };
      return { success: true, sid: 'SM_fake' };
    });

    const res = await sendServiceDetails('0101');
    const body = await res.json();

    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    expect(capturedVerdict).toMatchObject({ ok: false, code: 'ANNUAL_OFFER_WITHHELD', reason: 'annual_offer_withheld' });
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'Estimate not found' });

    // Claim released: an immediate retry (same estimate+phone) reaches
    // Twilio again — a leftover claim would instead short-circuit it before
    // ever calling sendSMS a second time.
    const retryRes = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'sms' }),
    });
    await retryRes.json();
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(2);
  });

  test('EMAIL channel: a withheld annual estimate gets the SAME generic 404 — never the address-suppression 409', async () => {
    // The 409 branch is address-level (a suppressed/bounced recipient) and
    // safe to reveal; an annual-offer withhold is row-level and must not be
    // distinguishable from an unknown token, exactly like the SMS case.
    const EmailTemplateLibrary = require('../services/email-template-library');
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({
      sent: false, blocked: true, reason: 'annual_offer_withheld', providerAttempted: false,
    });
    currentRow = baseEstimateRow();

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'email' }),
    });
    const body = await res.json();

    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: 'Estimate not found' });
  });

  test('EMAIL channel: an address-suppression block still returns 409 (unchanged) — only annual_offer_withheld maps to 404', async () => {
    const EmailTemplateLibrary = require('../services/email-template-library');
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({
      sent: false, blocked: true, reason: 'suppressed', providerAttempted: false,
    });
    currentRow = baseEstimateRow();

    const res = await fetch(`${base}/api/estimates/${TOKEN}/service-details/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'pest_control', channel: 'email' }),
    });
    const body = await res.json();

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
});
