'use strict';

// Lead-alert calls to Adam's cell must use the dedicated internal caller ID
// (INTERNAL_ALERT_CALLER_ID) and fall back to the main line when unset, so the
// main line stops accumulating the one-destination/voicemail/redial pattern
// that carrier analytics vendors label "Spam Likely".

const CONFIG_PATH = '../config/twilio-numbers';

function freshConfig(env) {
  jest.resetModules();
  delete process.env.INTERNAL_ALERT_CALLER_ID;
  if (env !== undefined) process.env.INTERNAL_ALERT_CALLER_ID = env;
  return require(CONFIG_PATH);
}

afterAll(() => { delete process.env.INTERNAL_ALERT_CALLER_ID; });

describe('TWILIO_NUMBERS.internalAlertCallerId', () => {
  test('falls back to the main line when the env var is unset', () => {
    const cfg = freshConfig(undefined);
    expect(cfg.internalAlertCallerId()).toBe(cfg.mainLine.number);
  });

  test('returns the configured E.164 number when set', () => {
    const cfg = freshConfig('+19415550123');
    expect(cfg.internalAlertCallerId()).toBe('+19415550123');
    expect(cfg.internalAlertCallerId()).not.toBe(cfg.mainLine.number);
  });

  test.each([['9415550123'], ['(941) 555-0123'], ['+4412345678901'], ['  '], ['garbage']])(
    'falls back to the main line on malformed value %p', (val) => {
      const cfg = freshConfig(val);
      expect(cfg.internalAlertCallerId()).toBe(cfg.mainLine.number);
    });

  test('the internal alert number counts as an owned number', () => {
    const cfg = freshConfig('+19415550123');
    expect(cfg.isOwnedNumber('+19415550123')).toBe(true);
    expect(cfg.isOwnedNumber('9415550123')).toBe(true);
    expect(cfg.isOwnedNumber(cfg.mainLine.number)).toBe(true);
  });
});

describe('lead-webhook uses the internal alert caller ID for the ring to Adam', () => {
  test('source wires the alert leg to internalAlertCallerId(), not mainLine', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'lead-webhook.js'), 'utf8');
    expect(src).toMatch(/const fromNumber = TWILIO_NUMBERS\.internalAlertCallerId\(\);/);
    // The customer-facing bridge leg intentionally stays on the main line.
    expect(src).toMatch(/const bridgeCallerId = TWILIO_NUMBERS\.mainLine\.number;/);
    // Nothing else in the lead alert path dials from the main line directly.
    const alertFromMain = src.match(/const fromNumber = TWILIO_NUMBERS\.mainLine\.number;/g) || [];
    expect(alertFromMain).toHaveLength(0);
  });
});
