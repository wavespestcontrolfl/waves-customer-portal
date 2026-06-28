// DNI Phase B2 — paid ad-call lead attribution.
//
// (1) twilio-numbers.js: the paid tracking `type` is per-entry, not hardcoded,
//     so the Google Ads number maps to 'google_ads' and the Facebook Ads number
//     maps to 'facebook' across findByNumber / getLeadSourceFromNumber / allNumbers.
// (2) twilio-voice-webhook.js: maybeAttributePaidInboundCall calls the shared
//     lead-attribution service ONLY for a HUMAN-ACCEPTED call (forwardAccepted &&
//     !shouldRecordVoicemail) to the GOOGLE ADS paid number (Facebook is labeled
//     but NOT attributed in B2), from a real caller #, exactly once per CallSid
//     (atomic claim + lead write in one transaction) — and only when the
//     fail-closed gate is on.

const GOOGLE_ADS_NUMBER = '+19412691697';
const FACEBOOK_ADS_NUMBER = '+19418775491';

describe('DNI paid tracking numbers (twilio-numbers.js)', () => {
  const TWILIO_NUMBERS = require('../config/twilio-numbers');

  test('paidTracking type is per-entry, not hardcoded to google_ads', () => {
    expect(TWILIO_NUMBERS.paidTracking.googleAdsPest.type).toBe('google_ads');
    expect(TWILIO_NUMBERS.paidTracking.facebookAdsPest.type).toBe('facebook');
    expect(TWILIO_NUMBERS.paidTracking.facebookAdsPest.number).toBe(FACEBOOK_ADS_NUMBER);
  });

  test('findByNumber tags the Google Ads number as google_ads', () => {
    const cfg = TWILIO_NUMBERS.findByNumber(GOOGLE_ADS_NUMBER);
    expect(cfg).toBeTruthy();
    expect(cfg.type).toBe('google_ads');
    expect(cfg.trackingId).toBe('googleAdsPest');
    expect(cfg.locationId).toBe('bradenton');
  });

  test('findByNumber tags the Facebook Ads number as facebook', () => {
    const cfg = TWILIO_NUMBERS.findByNumber(FACEBOOK_ADS_NUMBER);
    expect(cfg).toBeTruthy();
    expect(cfg.type).toBe('facebook');
    expect(cfg.trackingId).toBe('facebookAdsPest');
    expect(cfg.locationId).toBe('bradenton');
  });

  test('getLeadSourceFromNumber derives source from the entry type', () => {
    expect(TWILIO_NUMBERS.getLeadSourceFromNumber(GOOGLE_ADS_NUMBER).source).toBe('google_ads');
    expect(TWILIO_NUMBERS.getLeadSourceFromNumber(FACEBOOK_ADS_NUMBER).source).toBe('facebook');
  });

  test('allNumbers carries the per-entry type for both paid numbers', () => {
    const google = TWILIO_NUMBERS.allNumbers.find(n => n.number === GOOGLE_ADS_NUMBER);
    const facebook = TWILIO_NUMBERS.allNumbers.find(n => n.number === FACEBOOK_ADS_NUMBER);
    expect(google && google.type).toBe('google_ads');
    expect(facebook && facebook.type).toBe('facebook');
  });
});

// ---------------------------------------------------------------------------
// Webhook helper — mock the heavy deps the router requires at load.
// ---------------------------------------------------------------------------
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(),
  syncVoiceMessageForCall: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-attribution', () => ({
  attributeInboundContact: jest.fn(() => Promise.resolve({ type: 'new_lead', leadId: 'L1' })),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { attributeInboundContact } = require('../services/lead-attribution');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { maybeAttributePaidInboundCall } = voiceRouter._test;

// A human-accepted paid call — the baseline every "should attribute" case starts
// from. Spread + override per test.
const CONNECTED = {
  from: '+19415550123', to: GOOGLE_ADS_NUMBER, callSid: 'CA1', callDuration: 42,
  forwardAccepted: true, shouldRecordVoicemail: false,
};

// db.transaction(cb) mock: invokes cb with a `trx` whose
// trx('call_log').where(...).whereNull(...).update(...) resolves to the rows
// affected by the atomic claim. Each update() shifts the next value off
// `claimResults`, or defaults to 1 (claim won) when the queue is empty. If cb
// throws/rejects, db.transaction rejects too (real knex rolls back + re-throws),
// so the helper's try/catch can log and a later call re-attempts.
let claimResults;
function setupDbMock() {
  db.mockReset();
  db.fn = { now: jest.fn(() => 'NOW()') };
  claimResults = [];
  const update = jest.fn(() => Promise.resolve(claimResults.length ? claimResults.shift() : 1));
  const whereNull = jest.fn(() => ({ update }));
  const where = jest.fn(() => ({ whereNull }));
  const trx = jest.fn(() => ({ where }));
  db.transaction = jest.fn((cb) => cb(trx));
}

describe('maybeAttributePaidInboundCall (twilio-voice-webhook.js)', () => {
  // Behavior below assumes the fail-closed gate is ON. Set/restore it per test
  // so it never leaks to the gate suite (or any other test file).
  let savedGate;
  beforeEach(() => {
    jest.clearAllMocks();
    setupDbMock();
    savedGate = process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
    process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = 'true';
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
    else process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = savedGate;
  });

  test('attributes a human-accepted call to the Google Ads number (on the txn)', async () => {
    await maybeAttributePaidInboundCall({ ...CONNECTED });
    expect(attributeInboundContact).toHaveBeenCalledTimes(1);
    // The lead write runs on the claim transaction (second arg { trx }).
    expect(attributeInboundContact).toHaveBeenCalledWith(
      { from: '+19415550123', to: GOOGLE_ADS_NUMBER, type: 'call', callSid: 'CA1', callDuration: 42 },
      { trx: expect.any(Function) },
    );
  });

  test('does NOT attribute the Facebook Ads number (out of scope for B2 — google_ads only)', async () => {
    await maybeAttributePaidInboundCall({ ...CONNECTED, to: FACEBOOK_ADS_NUMBER, callSid: 'CA2', callDuration: 30 });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test('forwards the connected duration as a value (not a guard)', async () => {
    await maybeAttributePaidInboundCall({ ...CONNECTED, callDuration: 75 });
    expect(attributeInboundContact.mock.calls[0][0].callDuration).toBe(75);
  });

  test('does NOT attribute when the forwarded leg was not human-accepted', async () => {
    await maybeAttributePaidInboundCall({
      ...CONNECTED, callSid: 'CA3', forwardAccepted: false, shouldRecordVoicemail: true, callDuration: 0,
    });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test('does NOT attribute a carrier/staff voicemail pickup (duration>0 but not accepted)', async () => {
    await maybeAttributePaidInboundCall({
      ...CONNECTED, callSid: 'CA3b', forwardAccepted: false, shouldRecordVoicemail: true, callDuration: 14,
    });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test('does NOT attribute when an accepted call still dropped to voicemail', async () => {
    await maybeAttributePaidInboundCall({
      ...CONNECTED, callSid: 'CA3c', forwardAccepted: true, shouldRecordVoicemail: true,
    });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test('does NOT attribute a human-accepted call to a non-paid (location) number', async () => {
    await maybeAttributePaidInboundCall({ ...CONNECTED, to: '+19413187612', callSid: 'CA4' });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test('does NOT attribute an unknown number', async () => {
    await maybeAttributePaidInboundCall({ ...CONNECTED, to: '+10000000000', callSid: 'CA5' });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test('does NOT attribute an anonymous / blocked caller', async () => {
    await maybeAttributePaidInboundCall({ ...CONNECTED, from: 'anonymous', callSid: 'CA5b' });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test('is idempotent per CallSid — a retry whose claim returns 0 does not re-attribute', async () => {
    claimResults = [1, 0]; // first delivery wins the claim, the Twilio retry loses
    await maybeAttributePaidInboundCall({ ...CONNECTED, callSid: 'CA-dup' });
    await maybeAttributePaidInboundCall({ ...CONNECTED, callSid: 'CA-dup' });
    expect(attributeInboundContact).toHaveBeenCalledTimes(1);
  });

  test('rolls back on attribution failure so a later retry re-attempts', async () => {
    // Real knex: a throw inside the txn rolls back the claim marker (so the next
    // delivery re-claims) and re-throws. We model that with claim 1 then 1.
    claimResults = [1, 1];
    attributeInboundContact
      .mockRejectedValueOnce(new Error('boom'))                       // first attempt fails
      .mockResolvedValueOnce({ type: 'new_lead', leadId: 'L1' });     // retry succeeds
    // First delivery: txn throws → helper try/catch logs (does not propagate).
    await maybeAttributePaidInboundCall({ ...CONNECTED, callSid: 'CA-retry' });
    expect(logger.error).toHaveBeenCalledTimes(1);
    // Retry: marker was rolled back → claim wins again → attribution succeeds.
    await maybeAttributePaidInboundCall({ ...CONNECTED, callSid: 'CA-retry' });
    expect(attributeInboundContact).toHaveBeenCalledTimes(2);
  });
});

describe('GATE_PAID_CALL_LEAD_ATTRIBUTION (fail-closed gate)', () => {
  let savedGate;
  beforeEach(() => {
    jest.clearAllMocks();
    setupDbMock();
    savedGate = process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
    else process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = savedGate;
  });

  test('gate UNSET: does NOT attribute a human-accepted paid call', async () => {
    delete process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
    await maybeAttributePaidInboundCall({ ...CONNECTED, callSid: 'CA6' });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test("gate ='false': does NOT attribute a human-accepted paid call", async () => {
    process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = 'false';
    await maybeAttributePaidInboundCall({ ...CONNECTED, callSid: 'CA7' });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test("gate ='true': DOES attribute a human-accepted paid call", async () => {
    process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = 'true';
    await maybeAttributePaidInboundCall({ ...CONNECTED, callSid: 'CA8' });
    expect(attributeInboundContact).toHaveBeenCalledTimes(1);
  });

  test("gate ='true' still respects the paid-# and connected guards", async () => {
    process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = 'true';
    // not human-accepted → no
    await maybeAttributePaidInboundCall({
      ...CONNECTED, callSid: 'CA9', forwardAccepted: false, shouldRecordVoicemail: true,
    });
    // connected non-paid call → no
    await maybeAttributePaidInboundCall({ ...CONNECTED, to: '+19413187612', callSid: 'CA10' });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });
});
