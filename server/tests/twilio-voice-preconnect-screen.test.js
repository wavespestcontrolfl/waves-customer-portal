// Pre-connect caller screen (2026-07-24): unknown callers arriving with
// STIR/SHAKEN attestation B must press a key before staff phones ring
// (GATE_CALL_PRECONNECT_SCREEN; off = shadow 'would_gate' stamping only).
// These tests pin the two safety-critical invariants:
//   1. The decision NEVER gates a known customer, and NEVER gates on
//      attestation A/C/missing — absence of attestation is where most real
//      leads arrive and is NOT suspicion.
//   2. The challenge TwiML never rings staff (<Dial>) and never hangs up —
//      the no-input path redirects back into /voice as a screen failure,
//      which routes to the Waves voicemail recorder.
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

const voiceRouter = require('../routes/twilio-voice-webhook');
const { preconnectScreenDecision, buildPreconnectChallengeTwiML, knownCallerPhoneExists } = voiceRouter._test;

function makeDbLike(rows) {
  const calls = { whereRaw: [] };
  const builder = {
    whereNull: jest.fn(() => builder),
    whereRaw: jest.fn((sql, bindings) => {
      calls.whereRaw.push({ sql, bindings });
      return builder;
    }),
    limit: jest.fn(() => Promise.resolve(rows)),
  };
  const dbLike = jest.fn(() => builder);
  dbLike._calls = calls;
  return dbLike;
}

describe('preconnectScreenDecision', () => {
  const B = 'TN-Validation-Passed-B';

  test('gates an unknown B-attestation caller when the gate is on', () => {
    expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: B, gateOn: true })).toBe('gate');
  });

  test('shadow-stamps (never challenges) when the gate is off', () => {
    expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: B, gateOn: false })).toBe('would_gate');
  });

  test('NEVER gates a known caller, even on attestation B — including a number shared by 2+ customer records (knownCaller true even when not auto-linkable)', () => {
    expect(preconnectScreenDecision({ knownCaller: true, stirVerstat: B, gateOn: true })).toBe('none');
  });

  test('attestation A, C, and missing all bypass — absence is not suspicion', () => {
    for (const stir of ['TN-Validation-Passed-A', 'TN-Validation-Passed-C', null, undefined, '']) {
      expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: stir, gateOn: true })).toBe('none');
    }
  });

  test('a bare "B" without the attestation prefix does not match', () => {
    expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: 'B', gateOn: true })).toBe('none');
  });
});

describe('buildPreconnectChallengeTwiML', () => {
  const xml = buildPreconnectChallengeTwiML();

  test('challenges with two DTMF Gathers posting back into /voice as screened', () => {
    const gathers = xml.match(/<Gather[^>]*>/g) || [];
    expect(gathers).toHaveLength(2);
    for (const g of gathers) {
      expect(g).toContain('action="/api/webhooks/twilio/voice?screened=1"');
      expect(g).toContain('numDigits="1"');
    }
  });

  test('no-input path redirects back into /voice as a screen failure — never a Hangup, never a staff Dial', () => {
    expect(xml).toContain('<Redirect method="POST">/api/webhooks/twilio/voice?screenfail=1</Redirect>');
    expect(xml).not.toContain('<Hangup');
    expect(xml).not.toContain('<Dial');
  });

  test('prompt says the company name and the key to press', () => {
    expect(xml).toContain('Waves Pest Control');
    expect(xml).toContain('press one');
  });
});

describe('knownCallerPhoneExists (screen-bypass identity set)', () => {
  test('matches across the customer phone AND all three service-contact slot phones', async () => {
    const dbLike = makeDbLike([{ id: 'c1' }]);
    await expect(knownCallerPhoneExists(dbLike, '+19415551234')).resolves.toBe(true);
    const { sql } = dbLike._calls.whereRaw[0];
    for (const col of ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone']) {
      expect(sql).toContain(col);
    }
  });

  test('no matching record → false (caller stays gate-eligible)', async () => {
    await expect(knownCallerPhoneExists(makeDbLike([]), '+19415551234')).resolves.toBe(false);
  });

  test('unparseable caller number → false without querying', async () => {
    const dbLike = makeDbLike([{ id: 'c1' }]);
    await expect(knownCallerPhoneExists(dbLike, '')).resolves.toBe(false);
    expect(dbLike).not.toHaveBeenCalled();
  });
});
