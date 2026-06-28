// DNI Phase B2 — paid ad-call lead attribution.
//
// (1) twilio-numbers.js: the paid tracking `type` is per-entry, not hardcoded,
//     so the Google Ads number maps to 'google_ads' and the Facebook Ads number
//     maps to 'facebook' across findByNumber / getLeadSourceFromNumber / allNumbers.
// (2) twilio-voice-webhook.js: maybeAttributePaidInboundCall calls the shared
//     lead-attribution service ONLY for paid tracking numbers on a connected
//     call (duration > 0), never for unmapped numbers or zero-duration calls.

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

const { attributeInboundContact } = require('../services/lead-attribution');
const voiceRouter = require('../routes/twilio-voice-webhook');
const { maybeAttributePaidInboundCall } = voiceRouter._test;

describe('maybeAttributePaidInboundCall (twilio-voice-webhook.js)', () => {
  // The behavior below assumes the fail-closed gate is ON. Set/restore it per
  // test so it never leaks to the gate suite (or any other test file).
  let savedGate;
  beforeEach(() => {
    jest.clearAllMocks();
    savedGate = process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
    process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = 'true';
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
    else process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = savedGate;
  });

  test('attributes a connected call to the Google Ads number', () => {
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: GOOGLE_ADS_NUMBER, callSid: 'CA1', callDuration: 42,
    });
    expect(attributeInboundContact).toHaveBeenCalledTimes(1);
    expect(attributeInboundContact).toHaveBeenCalledWith({
      from: '+19415550123', to: GOOGLE_ADS_NUMBER, type: 'call', callSid: 'CA1', callDuration: 42,
    });
  });

  test('attributes a connected call to the Facebook Ads number', () => {
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: FACEBOOK_ADS_NUMBER, callSid: 'CA2', callDuration: 30,
    });
    expect(attributeInboundContact).toHaveBeenCalledTimes(1);
    expect(attributeInboundContact.mock.calls[0][0]).toMatchObject({ to: FACEBOOK_ADS_NUMBER, type: 'call' });
  });

  test('does NOT attribute a zero-duration (ring/no-answer/hangup) call', () => {
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: GOOGLE_ADS_NUMBER, callSid: 'CA3', callDuration: 0,
    });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test('does NOT attribute a connected call to a non-paid (location) number', () => {
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: '+19413187612', callSid: 'CA4', callDuration: 60,
    });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test('does NOT attribute an unknown number', () => {
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: '+10000000000', callSid: 'CA5', callDuration: 60,
    });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });
});

describe('GATE_PAID_CALL_LEAD_ATTRIBUTION (fail-closed gate)', () => {
  let savedGate;
  beforeEach(() => {
    jest.clearAllMocks();
    savedGate = process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
  });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
    else process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = savedGate;
  });

  test('gate UNSET: does NOT attribute a paid connected call', () => {
    delete process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION;
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: GOOGLE_ADS_NUMBER, callSid: 'CA6', callDuration: 42,
    });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test("gate ='false': does NOT attribute a paid connected call", () => {
    process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = 'false';
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: FACEBOOK_ADS_NUMBER, callSid: 'CA7', callDuration: 30,
    });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });

  test("gate ='true': DOES attribute a paid connected call", () => {
    process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = 'true';
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: GOOGLE_ADS_NUMBER, callSid: 'CA8', callDuration: 42,
    });
    expect(attributeInboundContact).toHaveBeenCalledTimes(1);
  });

  test("gate ='true' still respects the paid-# and duration guards", () => {
    process.env.GATE_PAID_CALL_LEAD_ATTRIBUTION = 'true';
    // zero-duration paid call → no
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: GOOGLE_ADS_NUMBER, callSid: 'CA9', callDuration: 0,
    });
    // connected non-paid call → no
    maybeAttributePaidInboundCall({
      from: '+19415550123', to: '+19413187612', callSid: 'CA10', callDuration: 60,
    });
    expect(attributeInboundContact).not.toHaveBeenCalled();
  });
});
