const { _STEP_SWAPS: steps, _SMS_SWAPS: sms } = require('../models/migrations/20260926120200_customer_copy_audit_automations');
const { countSegments } = require('../services/messaging/segment-counter');

const vars = (s) => [...String(s).matchAll(/\{\{?\s*\w+\s*\}?\}/g)].map((m) => m[0]).sort();
const tags = (s) => [...String(s).matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[0].toLowerCase());

test.each(steps.map((s) => [`${s.key}.${s.field}`, s]))('%s keeps placeholders and HTML structure', (_, s) => {
  expect(s.after).not.toBe(s.before);
  expect(vars(s.after)).toEqual(vars(s.before));
  if (s.field === 'html_body') {
    // payment_failed drops a paragraph (its unverifiable promises);
    // referral_nudge re-bolds its reward. Everything else keeps its tags.
    const block = (t) => t.filter((x) => !/strong/.test(x));
    if (s.key === 'payment_failed') expect(tags(s.after).length).toBe(tags(s.before).length - 2);
    else expect(block(tags(s.after))).toEqual(block(tags(s.before)));
  }
});

test.each(sms.map((s) => [s.key, s]))('%s SMS keeps placeholders, is GSM-7 and not longer', (_, s) => {
  expect(vars(s.after)).toEqual(vars(s.before));
  expect(countSegments(s.after).encoding).toBe('GSM_7');
  expect(s.after.length).toBeLessThan(s.before.length);
});

test('no unsupported claims survive', () => {
  const all = steps.map((s) => s.after).join('\n');
  expect(all).not.toMatch(/in Bradenton|this morning|still good|flat-rate|within a few days|3 business days|no late fee|national chains|Same tech|No cap|mention your name|1–2x per week|Nothing changes automatically/);
  expect(all).not.toMatch(/\bsafe(ly)?\b/i);
  for (const s of steps.filter((x) => /free re-?service/i.test(x.after) && ['new_lead', 'estimate_sent'].includes(x.key))) {
    expect(s.after).toMatch(/recurring plans/);
  }
});
