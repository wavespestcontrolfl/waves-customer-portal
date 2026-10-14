// 20261006220000_sms_template_tighten rewrites customer copy only. These
// checks pin what the rewrite must not change: the placeholders each sender
// fills, the STOP line the stop-line policy keeps, GSM-7 encoding, and the
// one house opener.
const { _SWAPS: SWAPS } = require('../models/migrations/20261006220000_sms_template_tighten');

const placeholders = (body) => [...body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('20261006220000_sms_template_tighten', () => {
  test('each template appears once and really changes', () => {
    const keys = SWAPS.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [key, before, after] of SWAPS) expect({ key, same: before === after }).toEqual({ key, same: false });
  });

  test.each(SWAPS)('%s keeps its placeholders, STOP line and GSM-7 encoding', (key, before, after) => {
    expect(placeholders(after)).toEqual(placeholders(before));
    expect(after.includes('Reply STOP to opt out.')).toBe(before.includes('Reply STOP to opt out.'));
    expect(after).toMatch(/^[\n\x20-\x7E]+$/);
    expect(after).not.toMatch(/^Hello \{/);
    expect(after.match(/\bWaves\b/g)?.length || 0).toBeLessThanOrEqual(Math.max(1, before.match(/\bWaves\b/g)?.length || 0));
  });
});

// 20261006230000 corrects eight of those bodies after review. It must start
// from exactly the text 20261006220000 wrote and hold the same invariants.
describe('20261006230000_sms_template_tighten_accuracy', () => {
  const { _SWAPS: FIXES } = require('../models/migrations/20261006230000_sms_template_tighten_accuracy');
  const tightened = new Map(SWAPS.map(([key, , after]) => [key, after]));

  test.each(FIXES)('%s starts from the tightened text and keeps placeholders, STOP line, GSM-7 and one "Waves"', (key, before, after) => {
    expect(before).toBe(tightened.get(key));
    expect(after).not.toBe(before);
    expect(placeholders(after)).toEqual(placeholders(before));
    expect(after.includes('Reply STOP to opt out.')).toBe(before.includes('Reply STOP to opt out.'));
    expect(after).toMatch(/^[\n\x20-\x7E]+$/);
    expect(after.match(/\bWaves\b/g)?.length).toBe(1);
  });
});
