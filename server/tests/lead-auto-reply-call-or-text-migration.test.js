// 20261014230000_lead_auto_reply_call_or_text: the lead text offers CALL or
// TEXT (owner 2026-10-14). It must start from the body 20261006220000 wrote
// (the live body on 10-14) and keep the placeholder, the STOP line, GSM-7,
// one "Waves" and a single SMS segment.
const { _SWAPS: SWAPS } = require('../models/migrations/20261014230000_lead_auto_reply_call_or_text');
const { _SWAPS: TIGHTEN } = require('../models/migrations/20261006220000_sms_template_tighten');

const placeholders = (body) => [...body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('20261014230000_lead_auto_reply_call_or_text', () => {
  const [[key, before, after]] = SWAPS;

  test('swaps only the lead auto-reply, from the 10-06 body', () => {
    expect(SWAPS).toHaveLength(1);
    expect(key).toBe('lead_auto_reply_biz');
    expect(before).toBe(new Map(TIGHTEN.map(([k, , a]) => [k, a])).get(key));
    expect(after).not.toBe(before);
  });

  test('offers CALL or TEXT and keeps placeholder, STOP line, GSM-7 and one "Waves"', () => {
    expect(after).toMatch(/^Hello \{first_name\}, Waves here\./);
    expect(after).toContain('Reply CALL');
    expect(after).toContain('or TEXT');
    expect(placeholders(after)).toEqual(placeholders(before));
    expect(after.endsWith('\n\nReply STOP to opt out.')).toBe(true);
    expect(after).toMatch(/^[\n\x20-\x7E]+$/);
    expect(after.match(/\bWaves\b/g)).toHaveLength(1);
  });

  test('fits one 160-character segment with an eight-letter first name', () => {
    expect(after.replace('{first_name}', 'Jennifer').length).toBeLessThanOrEqual(160);
  });
});
