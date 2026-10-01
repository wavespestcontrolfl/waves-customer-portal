const { _SWAPS: swaps } = require('../models/migrations/20260928210000_sms_brand_just_waves');
const { _SWAPS: copyAudit } = require('../models/migrations/20260926120000_customer_copy_audit_sms');
const { _SWAPS: callWording } = require('../models/migrations/20260928050000_call_text_wording_any_hour');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { countSegments } = require('../services/messaging/segment-counter');

// Short-side personalization: the question here is whether the rewrite
// itself adds a segment, not whether a long name already overflows. Unknown
// placeholders render as a ten-character stand-in; optional clauses render
// empty, which is how most sends carry them.
const sample = {
  first_name: 'Jordan', referee_name: 'Jordan', referrer_name: 'Sam', service_type: 'Pest Control',
  service: 'Lawn Care', service_label: 'pest control', service_name: 'Mosquito', prep_label: 'Flea',
  next_tier: 'Gold', start_date: 'Tue, Oct 7', window_text: ', 9-11 AM', effective_date: 'Oct 1',
  remaining: 'Your pest visits', new_option: 'Thu, Oct 9', weather_lead: 'Heavy rain is on the way',
  weather_phrase: 'Heavy rain', custom_message: 'Storms today.', term_end: 'Oct 31', overall_score: '82',
  date_line: ' on Oct 7',
  report_url: 'portal.wavespestcontrol.com/l/abcdefghjk', portal_url: 'portal.wavespestcontrol.com/l/abcdefghjk',
  pay_url: 'portal.wavespestcontrol.com/l/abcdefghjk', prep_url: 'portal.wavespestcontrol.com/l/abcdefghjk',
  booking_url: 'portal.wavespestcontrol.com/l/abcdefghjk', secure_link: 'portal.wavespestcontrol.com/l/abcdefghjk',
  quote_url: 'portal.wavespestcontrol.com/l/abcdefghjk', referral_link: 'portal.wavespestcontrol.com/l/abcdefghjk',
  review_url: 'portal.wavespestcontrol.com/l/abcdefghjk', google_review_url: 'g.page/r/abcdefghjk/review',
};
const OPTIONAL = /_(clause|line|sentence)$/;
const render = body => normalizeGsmPunctuation(stripSmsUrlScheme(body.replace(/\{(\w+)\}/g, (_, key) => (
  key in sample ? sample[key] : OPTIONAL.test(key) ? '' : 'XXXXXXXXXX'
)))).replace(/\n{3,}/g, '\n\n').trim();
const placeholders = body => [...body.matchAll(/\{\w+\}/g)].map(m => m[0]).sort();

test('covers 26 distinct templates, each an actual change', () => {
  expect(swaps).toHaveLength(26);
  expect(new Set(swaps.map(([key]) => key)).size).toBe(26);
  for (const [, before, after] of swaps) expect(after).not.toBe(before);
});

test.each(swaps)('%s keeps every placeholder and opt-out line', (key, before, after) => {
  expect(placeholders(after)).toEqual(placeholders(before));
  expect(after.includes('Reply STOP to opt out.')).toBe(before.includes('Reply STOP to opt out.'));
});

test.each(swaps)('%s says Waves, never the full name or an owner name, in plain GSM-7', (key, before, after) => {
  expect(after).toMatch(/\bWaves\b/);
  expect(after).not.toMatch(/Waves Pest Control|\bAdam\b/);
  expect(after).not.toMatch(/[^\x20-\x7e\n]/);
});

// At typical lengths every rewrite fits the segments it had; the completion
// texts' "Waves " tips only a long name + long service name (migration header).
test.each(swaps)('%s adds no segment at typical lengths', (key, before, after) => {
  expect(countSegments(render(after)).encoding).toBe('GSM_7');
  expect(countSegments(render(after)).segmentCount).toBeLessThanOrEqual(countSegments(render(before)).segmentCount);
});

test('each "before" is the body the previous copy migration left (a mismatch would skip silently)', () => {
  const byKey = new Map(swaps.map(([key, before]) => [key, before]));
  const chained = [...copyAudit, ...callWording].filter(([key]) => byKey.has(key));
  expect(chained.map(([key]) => key).sort()).toEqual([
    'appointment_recurring_placement_confirmed', 'appointment_series_rescheduled',
    'service_cancellation_scoped_confirmation', 'voicemail_quote_link',
  ]);
  for (const [key, , after] of chained) expect({ key, before: byKey.get(key) }).toEqual({ key, before: after });
});
