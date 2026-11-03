// The move pause reminder text (moving PR 2b, owner Q4): the house SMS layout (20261006220000),
// GSM-7, and at most two segments with a long name and the unshortened moving link.
const fs = require('fs');
const path = require('path');
const { _copy: { KEY, BODY } } = require('../models/migrations/20261103140000_customer_moves_pause');
const { countSegments } = require('../services/messaging/segment-counter');

test('the reminder text keeps the house layout, is GSM-7 and fits two segments at long-side lengths', () => {
  expect(KEY).toBe('moving_address_reminder');
  expect(BODY.startsWith('Hi {first_name}, ')).toBe(true);
  expect(BODY.match(/Waves/g)).toHaveLength(1);
  expect(BODY).toContain('\n\nAdd it here: {moving_link}');
  // Transactional to a customer: no STOP line (docs/sms-stop-line-policy.md).
  expect(BODY).not.toMatch(/STOP/);
  const rendered = BODY.replace('{first_name}', 'Longtestname').replace('{move_out_date}', 'Sep 30, 2026')
    .replace('{moving_link}', `https://portal.wavespestcontrol.com/moving/${'a'.repeat(48)}`);
  expect(countSegments(rendered).encoding).toBe('GSM_7');
  expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(2);
});

test('the sender supplies every variable the text names', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/customer-moves.js'), 'utf8');
  const sender = src.slice(src.indexOf('async function sendMoveReminder'), src.indexOf('// Claim, then send'));
  const named = [...BODY.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
  expect(named).toEqual(['first_name', 'move_out_date', 'moving_link']);
  for (const name of named) expect(sender).toContain(`${name}:`);
  expect(sender).toContain(`renderRequiredSmsTemplate(REMINDER_TEMPLATE`);
});
