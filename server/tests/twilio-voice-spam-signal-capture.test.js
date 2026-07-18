// Spam-signal ground-truth capture (2026-07-09): the inbound webhook now
// persists STIR/SHAKEN attestation (StirVerstat) and the Marketplace AddOns
// verdicts into call_log.metadata. This suite covers the AddOns audit parser;
// the metadata wiring itself is two literal fields on the existing insert.
// Context: Marchex Clean Call ran silently for months (zero verdicts reached
// the DB) and returned PASS on confirmed spam when invoked directly — these
// captured signals are how the replacement screen gets judged before any
// caller is challenged or blocked.
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
const { parseAddOnsForAudit } = voiceRouter._test;

describe('parseAddOnsForAudit', () => {
  test('returns null when the AddOns param is absent (absence is signal)', () => {
    expect(parseAddOnsForAudit(undefined)).toBeNull();
    expect(parseAddOnsForAudit(null)).toBeNull();
    expect(parseAddOnsForAudit('')).toBeNull();
  });

  test('parses the Twilio AddOns envelope into an object', () => {
    const envelope = JSON.stringify({
      status: 'successful',
      results: {
        marchex_cleancall: {
          status: 'successful',
          result: { result: { recommendation: 'PASS', reason: 'CleanCall' } },
        },
      },
    });
    const parsed = parseAddOnsForAudit(envelope);
    expect(parsed.status).toBe('successful');
    expect(parsed.results.marchex_cleancall.result.result.recommendation).toBe('PASS');
  });

  test('passes through an already-parsed object untouched', () => {
    const obj = { status: 'successful', results: {} };
    expect(parseAddOnsForAudit(obj)).toBe(obj);
  });

  test('keeps malformed payloads as truncated string evidence instead of throwing', () => {
    const junk = '{not json' + 'x'.repeat(2000);
    const out = parseAddOnsForAudit(junk);
    expect(typeof out).toBe('string');
    expect(out.length).toBe(1000);
    expect(out.startsWith('{not json')).toBe(true);
  });
});
