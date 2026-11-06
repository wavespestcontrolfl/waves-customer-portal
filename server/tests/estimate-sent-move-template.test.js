// The app-sent new-home estimate text (owner 2026-11-04, option A; GATE_MOVING_AUTO_SEND): the house
// SMS layout (20261006220000), "Waves" once, no STOP line and no price, GSM-7 within two segments
// at long-side lengths (purpose estimate_followup allows two).
const { _copy: { KEY, BODY } } = require('../models/migrations/20261105190000_estimate_sent_move_template');
const { countSegments } = require('../services/messaging/segment-counter');

test('the text keeps the house layout, is GSM-7 and fits two segments at long-side lengths', () => {
  expect(KEY).toBe('estimate_sent_move');
  expect(BODY.startsWith("Hi {first_name}, it's Waves. ")).toBe(true);
  expect(BODY.match(/Waves/g)).toHaveLength(1);
  expect(BODY).toContain('\n\nSee it and pick your first visit: {estimate_url}');
  // Transactional to an existing customer: no STOP line (docs/sms-stop-line-policy.md).
  expect(BODY).not.toMatch(/STOP/);
  expect(BODY).not.toMatch(/\$/);
  // The variables the send supplies (routes/admin-estimates.js estimateSmsTemplate and the SMS leg).
  expect([...BODY.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1])).toEqual(['first_name', 'plan_name', 'estimate_url']);
  // The longest pest plan name in use, and the long link a failed shortener leaves.
  const rendered = BODY.replace('{first_name}', 'Longtestname')
    .replace('{plan_name}', 'General Pest Control Service (Bi-Monthly)')
    .replace('{estimate_url}', `https://portal.wavespestcontrol.com/estimate/${'a'.repeat(64)}`);
  expect(countSegments(rendered).encoding).toBe('GSM_7');
  expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(2);
});
