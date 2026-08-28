/**
 * Owner feedback after the first sandbox call (2026-08-28): Sandy read as
 * too cheery, and a pricing question she could not answer ended without the
 * lead. The prompt now (a) sets a calm front-desk register and (b) turns any
 * unanswerable price question into the capture — first + last name, email,
 * full service address — with the written-estimate-in-~15-minutes promise.
 * Both gate states carry the fallback.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { SYSTEM_PROMPT, PRICE_LINE_NO_CONTEXT, PRICE_LINE_CONTEXT, buildBasePrompt } = require('../services/voice-agent/relay-conversation');

test('tone: calm front-desk register, no cheerleading', () => {
  expect(SYSTEM_PROMPT).toMatch(/steady front-desk voice, not a cheerleader/);
  expect(SYSTEM_PROMPT).toMatch(/No\s+exclamation-point energy/);
  expect(SYSTEM_PROMPT).not.toMatch(/Be warm, plain-spoken/);
});

test('pricing fallback (gate off): written estimate, no clock promise, + the four capture fields before anything else', () => {
  expect(SYSTEM_PROMPT).toContain(PRICE_LINE_NO_CONTEXT);
  expect(PRICE_LINE_NO_CONTEXT).toMatch(/cannot give a number over the phone/i);
  // Gate OFF has no clock: the turnaround is stated as a fact of the office, never as a
  // promise for THIS call, and the 15-minute figure lives only in the gate-on prompt.
  expect(PRICE_LINE_NO_CONTEXT).toMatch(/turns these\s+around quickly during business hours/);
  expect(PRICE_LINE_NO_CONTEXT).toMatch(/never say\s+whether the office is open now or promise a delivery time/);
  expect(PRICE_LINE_NO_CONTEXT).not.toMatch(/15 minutes/);
  expect(PRICE_LINE_NO_CONTEXT).toMatch(/first and last name, email address, and full service street address/);
  expect(PRICE_LINE_NO_CONTEXT).not.toMatch(/\$\s?\d/); // still never a figure
  expect(buildBasePrompt(false)).toBe(SYSTEM_PROMPT);
});

test('pricing fallback (gate on): the same capture when get_pricing cannot return a number', () => {
  const ctx = String(PRICE_LINE_CONTEXT);
  expect(ctx).toMatch(/usually about 15 minutes/);
  expect(ctx).toMatch(/CLOCK DATA says the office is closed/);
  expect(ctx).toMatch(/first and last name, email address,\s+and full service street address/);
  expect(ctx).toMatch(/quote ONLY numbers the get_pricing tool returned/);
  expect(ctx).toMatch(/capture_lead with estimate_requested: true/);
  expect(ctx).toMatch(/if it says it could not be, do not promise/);
  expect(PRICE_LINE_NO_CONTEXT).toMatch(/capture_lead with estimate_requested: true/);
});

test('the four capture fields are the job even on a price-only call', () => {
  expect(SYSTEM_PROMPT).toMatch(/They are the job even when\s+the caller only wanted a price/);
});
