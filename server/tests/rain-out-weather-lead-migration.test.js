const { _test } = require('../models/migrations/20260718400000_rain_out_weather_lead');

const { transformBody, revertBody } = _test;

// Verbatim prod body (read-only prod query, 2026-07-18). The splice must
// hold against exactly this text — not the seed-migration variant ("Hi"
// vs "Hello", the appended STOP line).
const PROD_BODY = 'Hello {first_name} — {weather_phrase} rolled through your area, so we moved your {service_type} to {new_option}.{alt_clause}{forecast_clause}\n\nQuestions or requests? Reply to this message.\n\nReply STOP to opt out.';

describe('rain_out_moved weather-lead migration', () => {
  test('splices the prod body to the new lead + clause slots, preserving surrounding copy', () => {
    const next = transformBody(PROD_BODY);
    expect(next).toBe('Hello {first_name} — {weather_lead}, so we moved your {service_type} to {new_option}.{better_day_clause}{alt_clause}{efficacy_clause}{forecast_clause}\n\nQuestions or requests? Reply to this message.\n\nReply STOP to opt out.');
    expect(transformBody(next)).toBe(next); // idempotent
    expect(revertBody(next)).toBe(PROD_BODY); // down restores
  });

  test('a diverged body passes through untouched', () => {
    const custom = 'Totally rewritten by the admin.';
    expect(transformBody(custom)).toBe(custom);
  });
});
