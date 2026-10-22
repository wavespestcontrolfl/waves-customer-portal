// GATE_LEAD_ALERT_CALL (owner 2026-10-14): a new web lead rings Adam's cell
// only in business hours AND with the gate exactly 'true'. Off, the lead
// takes the after-hours path (new_lead bell, SMS fallback) and no call goes out.

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ORIGINAL = process.env.GATE_LEAD_ALERT_CALL;

function loadWithGate(value) {
  if (value === undefined) delete process.env.GATE_LEAD_ALERT_CALL;
  else process.env.GATE_LEAD_ALERT_CALL = value;
  let helper;
  jest.isolateModules(() => {
    helper = require('../routes/lead-webhook')._test.shouldPlaceLeadAlertCall;
  });
  return helper;
}

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.GATE_LEAD_ALERT_CALL;
  else process.env.GATE_LEAD_ALERT_CALL = ORIGINAL;
});

describe('shouldPlaceLeadAlertCall', () => {
  test('gate unset: no call, even in business hours', () => {
    const should = loadWithGate(undefined);
    expect(should({ isDuringHours: true })).toBe(false);
    expect(should({ isDuringHours: false })).toBe(false);
  });

  test('gate set to anything but exactly "true": no call', () => {
    for (const v of ['false', '1', 'TRUE', 'yes', '']) {
      expect(loadWithGate(v)({ isDuringHours: true })).toBe(false);
    }
  });

  test('gate "true": calls in business hours only', () => {
    const should = loadWithGate('true');
    expect(should({ isDuringHours: true })).toBe(true);
    expect(should({ isDuringHours: false })).toBe(false);
  });
});
