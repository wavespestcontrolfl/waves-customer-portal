const { _SWAPS: swaps } = require('../models/migrations/20260928230000_sms_intro_its_waves');
const { _SWAPS: brandJustWaves } = require('../models/migrations/20260928210000_sms_brand_just_waves');
const { _SWAPS: copyAudit } = require('../models/migrations/20260926120000_customer_copy_audit_sms');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { countSegments } = require('../services/messaging/segment-counter');

// Short-side personalization: the question here is whether the rewrite
// itself adds a segment, not whether a long name already overflows. Unknown
// placeholders render as a ten-character stand-in; optional clauses render
// empty, which is how most sends carry them.
const sample = {
  first_name: 'Jordan', first: 'Jordan', summary: 'Ant treatment applied', reference: 'REF-1029',
  effective_date: 'Oct 1', price_change_url: 'portal.wavespestcontrol.com/l/abcdefghjk',
  link: 'portal.wavespestcontrol.com/l/abcdefghjk',
};
const render = body => normalizeGsmPunctuation(stripSmsUrlScheme(body.replace(/\{(\w+)\}/g, (_, key) => (
  key in sample ? sample[key] : 'XXXXXXXXXX'
)))).replace(/\n{3,}/g, '\n\n').trim();
const placeholders = body => [...body.matchAll(/\{\w+\}/g)].map(m => m[0]).sort();

test('covers 6 distinct templates, each an actual change', () => {
  expect(swaps).toHaveLength(6);
  expect(new Set(swaps.map(([key]) => key)).size).toBe(6);
  for (const [, before, after] of swaps) expect(after).not.toBe(before);
});

test.each(swaps)('%s keeps every placeholder and opt-out line', (key, before, after) => {
  expect(placeholders(after)).toEqual(placeholders(before));
  expect(after.includes('Reply STOP to opt out.')).toBe(before.includes('Reply STOP to opt out.'));
});

test.each(swaps)('%s says "it\'s Waves", never "Waves here" or the full company name, in plain GSM-7', (key, before, after) => {
  expect(after).toMatch(/\bit's Waves\b/);
  expect(after).not.toMatch(/Waves here|this is Waves|Waves Pest Control|\bAdam\b/);
  expect(after).not.toMatch(/[^\x20-\x7e\n]/);
});

test.each(swaps)('%s adds no segment at typical lengths', (key, before, after) => {
  expect(countSegments(render(after)).encoding).toBe('GSM_7');
  expect(countSegments(render(after)).segmentCount).toBeLessThanOrEqual(countSegments(render(before)).segmentCount);
});

test('each "before" is the body the previous copy migration left (a mismatch would skip silently)', () => {
  const byKey = new Map(swaps.map(([key, before]) => [key, before]));
  const chained = [...brandJustWaves, ...copyAudit].filter(([key]) => byKey.has(key));
  expect(chained.map(([key]) => key).sort()).toEqual([
    'lead_auto_reply_biz', 'price_change_notice',
    'service_cancellation_received', 'service_resolution_confirmation',
  ]);
  for (const [key, , after] of chained) expect({ key, before: byKey.get(key) }).toEqual({ key, before: after });
});
