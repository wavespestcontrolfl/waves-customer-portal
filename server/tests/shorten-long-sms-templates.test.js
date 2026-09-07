const { _SWAPS: swaps } = require('../models/migrations/20260907000070_shorten_long_sms_templates');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { countSegments } = require('../services/messaging/segment-counter');
const { formatSmsTemplateVars } = require('../utils/sms-time-format');

const sample = formatSmsTemplateVars({
  first_name: 'Longtestname', service_type: 'Quarterly Pest Control & Lawn Care',
  day: 'Tuesday', time: '09:00', window: 'between 9:00 AM and 11:00 AM', date_line: ' on September 15',
  secure_link: `https://portal.wavespestcontrol.com/secure/${'A'.repeat(22)}`,
  report_url: 'https://portal.wavespestcontrol.com/l/abcdefghjk',
  portal_url: 'https://portal.wavespestcontrol.com/l/abcdefghjk',
  pay_url: 'https://portal.wavespestcontrol.com/l/xxxxxxxxxxxxx-0915-abcdefghjk',
  reschedule_line: 'Reschedule here: https://portal.wavespestcontrol.com/l/abcdefghjk\n\n',
  appointment_line: 'Everything about your visit: https://portal.wavespestcontrol.com/l/abcdefghjk\n\n',
  cancel_fee_line: '$50 fee only for last-minute cancels or no-shows. ',
  card_hold_policy_line: '\n\nYour card on file holds this visit - cancel free until September 14 at 9:00 AM. After that, a $50 fee applies only if you cancel or no one is home. Rescheduling is always free.',
  past_due_line: 'Your account also has a previous balance of $100.00. Please take care of it before your next service.',
});
const render = body => normalizeGsmPunctuation(stripSmsUrlScheme(body.replace(/\{(\w+)\}/g, (_, key) => {
  if (!(key in sample)) throw new Error(`Missing fixture: ${key}`);
  return sample[key];
}))).replace(/\n{3,}/g, '\n\n').trim();

test.each(swaps)('%s gets shorter without deleting required links or conditional disclosures', (key, before, after) => {
  expect(render(after).length).toBeLessThan(render(before).length);
  for (const match of before.matchAll(/\{(\w+(?:url|link|line))\}/g)) {
    expect(after).toContain(match[0]);
  }
  expect(after.includes('Reply STOP to opt out.')).toBe(before.includes('Reply STOP to opt out.'));
  expect(countSegments(render(after)).segmentCount).toBeLessThanOrEqual(3);
});

test.each(['service_complete_with_invoice', 'service_report_v1_with_invoice', 'auto_sprinkler_timer'])('%s fits two segments with expanded personalization', key => {
  expect(countSegments(render(swaps.find(([k]) => k === key)[2])).segmentCount).toBe(2);
});

test('plan choices preserve payment timing, fee, and phone-security disclosures', () => {
  const body = swaps.find(([key]) => key === 'secure_appointment_card_plans')[2];
  expect(body).toContain('prepay the year and save');
  expect(body).toContain('pay per application by card');
  expect(body).toContain('Nothing is charged today unless you prepay.');
  expect(body).toContain('{cancel_fee_line}We never take card numbers by phone.');
});

test('legacy 24h reminder uses the arrival window already supplied by its sender', () => {
  const body = swaps.find(([key]) => key === 'reminder_24h')[2];
  expect(render(body)).toContain('tomorrow, between 9:00 AM and 11:00 AM');
  expect(body).not.toContain('{time}');
});
